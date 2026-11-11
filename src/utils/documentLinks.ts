import {
  sanitizeDocumentSemanticAnchor,
  type PdfSemanticAnchor,
} from '../documents/anchors.ts';
import type {
  DocumentLink,
  DocumentLinkNumberHighWater,
  PairedDocumentLink,
  PdfLinkEndpoint,
} from '../types/documentLink.ts';
import type { PdfTextSelection } from '../types/textSelection.ts';
import type { PdfAnnotation } from '../types/highlight.ts';
import { normalizeSelectionRectangles } from './highlights.ts';

const MAX_LINK_ID_LENGTH = 256;
const MAX_NESTED_ID_LENGTH = 512;
const MAX_LINKS_PER_DOCUMENT = 100_000;
const MAX_QUOTE_LENGTH = 8_192;
export const MAX_DOCUMENT_LINK_RECTS = 64;
export const MAX_DOCUMENT_LINK_NAME_LENGTH = 80;
export const DOCUMENT_LINK_HIGH_WATER_ENTITY_ID = 'link-numbers';
/** First local document schema that requires Link entities and high-water state. */
export const DOCUMENT_LINK_PERSISTENCE_SCHEMA_VERSION = 9;

interface EndpointOptions {
  endpointId?: string;
  timestamp?: number;
}

export interface CreateUnpairedDocumentLinkOptions extends EndpointOptions {
  documentId: string;
  selection: PdfTextSelection;
  nextLinkNumber: number;
  linkId?: string;
}

export interface ConnectDocumentLinkOptions extends EndpointOptions {
  selection: PdfTextSelection;
}

export interface CreateUnpairedDocumentLinkFromAnnotationOptions extends EndpointOptions {
  documentId: string;
  annotation: PdfAnnotation;
  nextLinkNumber: number;
  linkId?: string;
}

export interface RenameDocumentLinkOptions {
  timestamp?: number;
}

export interface LinkNumberRepairResult {
  links: DocumentLink[];
  nextLinkNumber: number;
  renumberedLinkIds: string[];
}

export function createPdfLinkEndpoint(
  documentId: string,
  selection: PdfTextSelection,
  options: EndpointOptions = {},
): PdfLinkEndpoint | null {
  if (!isSafeNestedId(documentId) || !selection.text.trim()) return null;
  if (!isPositiveInteger(selection.pageNumber)) return null;
  if (selection.pageWidth <= 0 || selection.pageHeight <= 0) return null;
  if (!isNonNegativeInteger(selection.startOffset)) return null;
  if (!isNonNegativeInteger(selection.endOffset)) return null;
  // Reject over-fragmented selections before geometry normalization. Merging
  // coincident DOM rectangles must not turn an unsupported source selection
  // into an apparently valid persisted endpoint.
  if (selection.boundingRectangles.length > MAX_DOCUMENT_LINK_RECTS) return null;
  const rects = normalizeSelectionRectangles(
    selection.boundingRectangles,
    selection.pageWidth,
    selection.pageHeight,
  );
  if (rects.length === 0 || rects.length > MAX_DOCUMENT_LINK_RECTS) return null;
  const endpointId = options.endpointId ?? crypto.randomUUID();
  const timestamp = options.timestamp ?? Date.now();
  if (!isSafeNestedId(endpointId) || !isTimestamp(timestamp)) return null;
  // PDF.js may reconstruct whitespace differently from DOM Range.toString().
  // Bind the semantic offsets to the bounded authoritative source quote rather
  // than rejecting an otherwise valid rendered selection.
  const quote = selection.text.slice(0, MAX_QUOTE_LENGTH);
  const endOffset = selection.startOffset + quote.length;
  if (!Number.isSafeInteger(endOffset)) return null;
  const anchor: PdfSemanticAnchor = {
    version: 1,
    kind: 'pdf-text',
    documentId,
    pageNumber: selection.pageNumber,
    quote,
    prefix: '',
    suffix: '',
    startOffset: selection.startOffset,
    endOffset,
    rects,
  };
  return { id: endpointId, anchor, createdAt: timestamp };
}

export function createUnpairedDocumentLink(
  options: CreateUnpairedDocumentLinkOptions,
): { link: DocumentLink; nextLinkNumber: number } | null {
  if (!isAllocatableLinkNumber(options.nextLinkNumber)) return null;
  const timestamp = options.timestamp ?? Date.now();
  const endpointA = createPdfLinkEndpoint(options.documentId, options.selection, {
    endpointId: options.endpointId,
    timestamp,
  });
  const linkId = options.linkId ?? crypto.randomUUID();
  if (!endpointA || !isSafeLinkId(linkId) || !isTimestamp(timestamp)) return null;
  return {
    link: {
      version: 1,
      type: 'link',
      id: linkId,
      documentId: options.documentId,
      visibleNumber: options.nextLinkNumber,
      endpointA,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    nextLinkNumber: options.nextLinkNumber + 1,
  };
}

export function createUnpairedDocumentLinkFromAnnotation(
  options: CreateUnpairedDocumentLinkFromAnnotationOptions,
): { link: DocumentLink; nextLinkNumber: number } | null {
  if (!isAllocatableLinkNumber(options.nextLinkNumber)) return null;
  const timestamp = options.timestamp ?? Date.now();
  const endpointA = createPdfLinkEndpointFromAnnotation(
    options.documentId,
    options.annotation,
    { endpointId: options.endpointId, timestamp },
  );
  const linkId = options.linkId ?? crypto.randomUUID();
  if (!endpointA || !isSafeLinkId(linkId) || !isTimestamp(timestamp)) return null;
  return {
    link: {
      version: 1,
      type: 'link',
      id: linkId,
      documentId: options.documentId,
      visibleNumber: options.nextLinkNumber,
      endpointA,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    nextLinkNumber: options.nextLinkNumber + 1,
  };
}

export function connectDocumentLink(
  link: DocumentLink,
  options: ConnectDocumentLinkOptions,
): DocumentLink | null {
  if (link.endpointB) return null;
  const requestedTimestamp = options.timestamp ?? Date.now();
  if (!isTimestamp(requestedTimestamp)) return null;
  // Wall clocks are not causal ordering. A clock-behind device may complete a
  // valid remote Link, so advance one logical tick from persisted state.
  const timestamp = nextDocumentLinkMutationTimestamp(link, requestedTimestamp);
  if (timestamp === null) return null;
  const endpointB = createPdfLinkEndpoint(link.documentId, options.selection, {
    endpointId: options.endpointId,
    timestamp,
  });
  if (!endpointB || endpointB.id === link.endpointA.id) return null;
  return { ...link, endpointB, updatedAt: Math.max(link.updatedAt, timestamp) };
}

export function connectDocumentLinkFromAnnotation(
  link: DocumentLink,
  annotation: PdfAnnotation,
  options: EndpointOptions = {},
): DocumentLink | null {
  if (link.endpointB) return null;
  const requestedTimestamp = options.timestamp ?? Date.now();
  if (!isTimestamp(requestedTimestamp)) return null;
  const timestamp = nextDocumentLinkMutationTimestamp(link, requestedTimestamp);
  if (timestamp === null) return null;
  const endpointB = createPdfLinkEndpointFromAnnotation(link.documentId, annotation, {
    endpointId: options.endpointId,
    timestamp,
  });
  if (!endpointB || endpointB.id === link.endpointA.id) return null;
  return { ...link, endpointB, updatedAt: Math.max(link.updatedAt, timestamp) };
}

/**
 * Reuses the clicked mark's persisted geometry and quote exactly. Highlights and
 * Underlines predate semantic text offsets, so their bounded quote is anchored
 * at offset zero rather than reconstructed from a transient DOM selection.
 */
export function createPdfLinkEndpointFromAnnotation(
  documentId: string,
  annotation: PdfAnnotation,
  options: EndpointOptions = {},
): PdfLinkEndpoint | null {
  if (!isSafeNestedId(documentId) || !annotation.text.trim()) return null;
  if (!isPositiveInteger(annotation.pageNumber)) return null;
  if (
    annotation.rects.length === 0 ||
    annotation.rects.length > MAX_DOCUMENT_LINK_RECTS ||
    annotation.rects.some(
      (rect) =>
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.x + rect.width > 1.000001 ||
        rect.y + rect.height > 1.000001,
    )
  ) {
    return null;
  }
  const endpointId = options.endpointId ?? crypto.randomUUID();
  const timestamp = options.timestamp ?? Date.now();
  if (!isSafeNestedId(endpointId) || !isTimestamp(timestamp)) return null;
  const quote = annotation.text.slice(0, MAX_QUOTE_LENGTH);
  return {
    id: endpointId,
    anchor: {
      version: 1,
      kind: 'pdf-text',
      documentId,
      pageNumber: annotation.pageNumber,
      quote,
      prefix: '',
      suffix: '',
      startOffset: 0,
      endOffset: quote.length,
      rects: annotation.rects.map((rect) => ({ ...rect })),
    },
    createdAt: timestamp,
  };
}

/**
 * Stores only a custom name. An empty value intentionally clears it so the
 * presentation layer can return to the number-derived `Link N` label.
 */
export function renameDocumentLink(
  link: DocumentLink,
  requestedName: string,
  options: RenameDocumentLinkOptions = {},
): DocumentLink | null {
  const requestedTimestamp = options.timestamp ?? Date.now();
  if (!isTimestamp(requestedTimestamp)) return null;
  const trimmedName = requestedName.trim();
  const name =
    trimmedName.length === 0 ? undefined : sanitizeDocumentLinkName(requestedName);
  if (trimmedName.length > 0 && !name) return null;
  if (
    name === link.name ||
    (link.name === undefined && name === `Link ${link.visibleNumber}`)
  ) {
    return link;
  }
  const timestamp = nextDocumentLinkMutationTimestamp(link, requestedTimestamp);
  if (timestamp === null) return null;

  const renamed: DocumentLink = {
    ...link,
    updatedAt: timestamp,
  };
  if (name) renamed.name = name;
  else delete renamed.name;
  return renamed;
}

export function connectableDocumentLinks(
  links: readonly DocumentLink[],
  documentId: string,
): DocumentLink[] {
  return links
    .filter((link) => link.documentId === documentId && !link.endpointB)
    .sort(compareDocumentLinks);
}

export function deleteDocumentLink(
  links: readonly DocumentLink[],
  linkId: string,
): DocumentLink[] {
  return links.filter((link) => link.id !== linkId);
}

export function otherDocumentLinkEndpoint(
  link: DocumentLink,
  endpointId: string,
): PdfLinkEndpoint | null {
  if (!link.endpointB) return null;
  if (link.endpointA.id === endpointId) return link.endpointB;
  if (link.endpointB.id === endpointId) return link.endpointA;
  return null;
}

export function sanitizeDocumentLink(
  value: unknown,
  expectedDocumentId: string,
): DocumentLink | null {
  if (!isRecord(value) || value.version !== 1 || value.type !== 'link') return null;
  if (hasUnsupportedEndpointSlot(value)) return null;
  if (!isSafeLinkId(value.id) || value.documentId !== expectedDocumentId) return null;
  if (
    !isSafeNestedId(value.documentId) ||
    !isAllocatableLinkNumber(value.visibleNumber)
  ) {
    return null;
  }
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  if (value.updatedAt < value.createdAt) return null;
  const name =
    value.name === undefined ? undefined : sanitizeDocumentLinkName(value.name);
  if (value.name !== undefined && !name) return null;
  const endpointA = sanitizePdfLinkEndpoint(value.endpointA, expectedDocumentId);
  const endpointB =
    value.endpointB === undefined
      ? undefined
      : sanitizePdfLinkEndpoint(value.endpointB, expectedDocumentId);
  if (!endpointA || (value.endpointB !== undefined && !endpointB)) return null;
  if (endpointB && endpointB.id === endpointA.id) return null;
  if (endpointA.createdAt < value.createdAt || endpointA.createdAt > value.updatedAt) {
    return null;
  }
  if (
    endpointB &&
    (endpointB.createdAt < value.createdAt || endpointB.createdAt > value.updatedAt)
  ) {
    return null;
  }
  return {
    version: 1,
    type: 'link',
    id: value.id,
    documentId: value.documentId,
    visibleNumber: value.visibleNumber,
    ...(name ? { name } : {}),
    endpointA,
    ...(endpointB ? { endpointB } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function sanitizeDocumentLinkName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MAX_DOCUMENT_LINK_NAME_LENGTH ||
    Array.from(name).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    return null;
  }
  return name;
}

export function sanitizeDocumentLinks(
  value: unknown,
  expectedDocumentId: string,
): DocumentLink[] {
  if (!Array.isArray(value) || value.length > MAX_LINKS_PER_DOCUMENT) return [];
  const links: DocumentLink[] = [];
  const linkIds = new Set<string>();
  const endpointIds = new Set<string>();
  for (const candidate of value) {
    const link = sanitizeDocumentLink(candidate, expectedDocumentId);
    if (!link || linkIds.has(link.id) || endpointIds.has(link.endpointA.id)) continue;
    if (link.endpointB && endpointIds.has(link.endpointB.id)) continue;
    linkIds.add(link.id);
    endpointIds.add(link.endpointA.id);
    if (link.endpointB) endpointIds.add(link.endpointB.id);
    links.push(link);
  }
  return links;
}

/**
 * Keeps one deterministic owner of every colliding display number and moves
 * other distinct IDs above the allocation high-water mark. Internal IDs are
 * never merged, and deleted numbers below the high-water mark remain unused.
 */
export function repairDocumentLinkNumberCollisions(
  links: readonly DocumentLink[],
  requestedNextLinkNumber: unknown,
): LinkNumberRepairResult {
  const byNumber = new Map<number, DocumentLink[]>();
  let maximumVisibleNumber = 0;
  for (const link of links) {
    maximumVisibleNumber = Math.max(maximumVisibleNumber, link.visibleNumber);
    byNumber.set(link.visibleNumber, [
      ...(byNumber.get(link.visibleNumber) ?? []),
      link,
    ]);
  }
  let nextLinkNumber = normalizeNextLinkNumber(
    requestedNextLinkNumber,
    maximumVisibleNumber,
  );
  const replacements = new Map<string, number>();
  const renumberedLinkIds: string[] = [];
  for (const number of [...byNumber.keys()].sort((a, b) => a - b)) {
    const colliding = byNumber
      .get(number)!
      .sort((left, right) => compareStableIds(left.id, right.id));
    for (const link of colliding.slice(1)) {
      if (!isAllocatableLinkNumber(nextLinkNumber)) {
        throw new Error('This paper has exhausted its Link number range.');
      }
      replacements.set(link.id, nextLinkNumber);
      renumberedLinkIds.push(link.id);
      nextLinkNumber += 1;
    }
  }
  return {
    links: links.map((link) => {
      const visibleNumber = replacements.get(link.id);
      return visibleNumber === undefined ? link : { ...link, visibleNumber };
    }),
    nextLinkNumber,
    renumberedLinkIds,
  };
}

export function normalizeNextLinkNumber(
  value: unknown,
  maximumVisibleNumber: number,
): number {
  const minimum = maximumVisibleNumber + 1;
  if (!isLinkNumberHighWater(minimum)) {
    throw new Error('This paper has exhausted its Link number range.');
  }
  return isLinkNumberHighWater(value) && value >= minimum ? value : minimum;
}

export function isValidNextDocumentLinkNumber(
  value: unknown,
  links: readonly DocumentLink[],
): value is number {
  if (!isLinkNumberHighWater(value)) return false;
  return links.every((link) => link.visibleNumber < value);
}

export function createDocumentLinkNumberHighWater(
  documentId: string,
  nextLinkNumber: unknown,
): DocumentLinkNumberHighWater | null {
  if (!isSafeNestedId(documentId) || !isLinkNumberHighWater(nextLinkNumber)) {
    return null;
  }
  return {
    version: 1,
    type: 'link-number-high-water',
    documentId,
    nextLinkNumber,
  };
}

export function sanitizeDocumentLinkNumberHighWater(
  value: unknown,
  expectedDocumentId: string,
): DocumentLinkNumberHighWater | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.type !== 'link-number-high-water' ||
    value.documentId !== expectedDocumentId
  ) {
    return null;
  }
  return createDocumentLinkNumberHighWater(expectedDocumentId, value.nextLinkNumber);
}

export function isPairedLink(link: DocumentLink): link is PairedDocumentLink {
  return link.endpointB !== undefined;
}

function sanitizePdfLinkEndpoint(
  value: unknown,
  expectedDocumentId: string,
): PdfLinkEndpoint | null {
  if (!isRecord(value) || !isSafeNestedId(value.id) || !isTimestamp(value.createdAt)) {
    return null;
  }
  const anchor = sanitizeDocumentSemanticAnchor(value.anchor);
  if (
    !anchor ||
    anchor.kind !== 'pdf-text' ||
    anchor.documentId !== expectedDocumentId
  ) {
    return null;
  }
  return { id: value.id, anchor, createdAt: value.createdAt };
}

function compareDocumentLinks(left: DocumentLink, right: DocumentLink): number {
  return (
    left.visibleNumber - right.visibleNumber || compareStableIds(left.id, right.id)
  );
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Endpoint slots are deliberately not an extensible bag. Silently discarding
 * an `endpointC`, numeric endpoint slot, or endpoint array would turn a
 * malformed multi-endpoint relationship into a different two-ended Link.
 */
function hasUnsupportedEndpointSlot(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(
    (key) => key.startsWith('endpoint') && key !== 'endpointA' && key !== 'endpointB',
  );
}

function isAllocatableLinkNumber(value: unknown): value is number {
  return isPositiveInteger(value) && value < Number.MAX_SAFE_INTEGER;
}

/** Number.MAX_SAFE_INTEGER is a valid exhausted high-water sentinel. */
function isLinkNumberHighWater(value: unknown): value is number {
  return isPositiveInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value);
}

function nextDocumentLinkMutationTimestamp(
  link: Pick<DocumentLink, 'createdAt' | 'updatedAt'>,
  requestedTimestamp: number,
): number | null {
  const persistedTimestamp = Math.max(link.createdAt, link.updatedAt);
  if (
    !isTimestamp(persistedTimestamp) ||
    persistedTimestamp >= Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return Math.max(requestedTimestamp, persistedTimestamp + 1);
}

function isSafeLinkId(value: unknown): value is string {
  return isSafeId(value, MAX_LINK_ID_LENGTH);
}

function isSafeNestedId(value: unknown): value is string {
  return isSafeId(value, MAX_NESTED_ID_LENGTH);
}

function isSafeId(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
