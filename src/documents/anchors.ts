import type {
  DocumentNavigationTarget,
  DocumentTextSelection,
  NormalizedDocumentRect,
} from './types';

const MAX_ID_LENGTH = 512;
const MAX_QUOTE_LENGTH = 8_192;
const MAX_CONTEXT_LENGTH = 512;
const MAX_RECTS = 64;
const MAX_STRUCTURAL_PATH = 64;

interface TextAnchorBase {
  readonly version: 1;
  readonly documentId: string;
  readonly quote: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PdfSemanticAnchor extends TextAnchorBase {
  readonly kind: 'pdf-text';
  readonly pageNumber: number;
  readonly rects: readonly NormalizedDocumentRect[];
}

export interface PptxSemanticAnchor extends TextAnchorBase {
  readonly kind: 'pptx-text';
  readonly slideId: string;
  readonly slideIndex: number;
  readonly shapeId: string;
  readonly paragraphIndex: number;
  readonly runIndex?: number;
  readonly rects: readonly NormalizedDocumentRect[];
}

export interface DocxSemanticAnchor extends TextAnchorBase {
  readonly kind: 'docx-text';
  readonly blockId: string;
  readonly blockIndex: number;
  readonly structuralPath: readonly number[];
}

export type DocumentSemanticAnchor =
  PdfSemanticAnchor | PptxSemanticAnchor | DocxSemanticAnchor;

export type AnchorResolution =
  | {
      readonly status: 'exact' | 'relocated';
      readonly selection: DocumentTextSelection;
    }
  | { readonly status: 'ambiguous' | 'missing'; readonly selection?: undefined };

export interface PptxTextAnchorInput {
  readonly documentId: string;
  readonly slideId: string;
  readonly slideIndex: number;
  readonly shapeId: string;
  readonly paragraphIndex: number;
  readonly runIndex?: number;
  readonly containerText: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly rects?: readonly NormalizedDocumentRect[];
}

export interface DocxTextAnchorInput {
  readonly documentId: string;
  readonly blockId: string;
  readonly blockIndex: number;
  readonly structuralPath: readonly number[];
  readonly containerText: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface PptxAnchorTextContainer {
  readonly slideId: string;
  readonly slideIndex: number;
  readonly shapeId: string;
  readonly paragraphIndex: number;
  readonly text: string;
  readonly rects?: readonly NormalizedDocumentRect[];
}

export interface DocxAnchorTextContainer {
  readonly blockId: string;
  readonly blockIndex: number;
  readonly structuralPath: readonly number[];
  readonly text: string;
}

export function createPptxTextAnchor(
  input: PptxTextAnchorInput,
): PptxSemanticAnchor | null {
  const selection = getSelectionContext(
    input.containerText,
    input.startOffset,
    input.endOffset,
  );
  if (!selection || !isSafeId(input.documentId) || !isSafeId(input.slideId)) {
    return null;
  }
  if (!isSafeId(input.shapeId) || !isIndex(input.slideIndex)) return null;
  if (!isIndex(input.paragraphIndex) || !isOptionalIndex(input.runIndex)) return null;
  const rects = sanitizeRects(input.rects ?? []);
  if (!rects) return null;

  return {
    version: 1,
    kind: 'pptx-text',
    documentId: input.documentId,
    slideId: input.slideId,
    slideIndex: input.slideIndex,
    shapeId: input.shapeId,
    paragraphIndex: input.paragraphIndex,
    ...(input.runIndex === undefined ? {} : { runIndex: input.runIndex }),
    ...selection,
    rects,
  };
}

export function createDocxTextAnchor(
  input: DocxTextAnchorInput,
): DocxSemanticAnchor | null {
  const selection = getSelectionContext(
    input.containerText,
    input.startOffset,
    input.endOffset,
  );
  const structuralPath = sanitizeStructuralPath(input.structuralPath);
  if (!selection || !structuralPath || !isSafeId(input.documentId)) return null;
  if (!isSafeId(input.blockId) || !isIndex(input.blockIndex)) return null;

  return {
    version: 1,
    kind: 'docx-text',
    documentId: input.documentId,
    blockId: input.blockId,
    blockIndex: input.blockIndex,
    structuralPath,
    ...selection,
  };
}

export function resolvePptxTextAnchor(
  anchor: PptxSemanticAnchor,
  containers: readonly PptxAnchorTextContainer[],
): AnchorResolution {
  const eligible = containers.filter(
    (container) => container.slideId === anchor.slideId,
  );
  const identity = eligible.filter(
    (container) =>
      container.shapeId === anchor.shapeId &&
      container.paragraphIndex === anchor.paragraphIndex,
  );
  const match = resolveAgainstContainers(
    anchor,
    identity.length > 0 ? identity : eligible,
    identity.length > 0,
  );
  if (match.status !== 'found') return { status: match.status };
  const container = match.container as PptxAnchorTextContainer;
  return {
    status: match.exactIdentity ? 'exact' : 'relocated',
    selection: {
      text: anchor.quote,
      target: {
        kind: 'pptx-slide',
        slideId: container.slideId,
        slideIndex: container.slideIndex,
      },
      fragments: [
        {
          containerId: pptxContainerId(container),
          text: anchor.quote,
          startOffset: match.startOffset,
          endOffset: match.startOffset + anchor.quote.length,
          ...(container.rects?.[0] ? { rect: container.rects[0] } : {}),
        },
      ],
    },
  };
}

export function resolveDocxTextAnchor(
  anchor: DocxSemanticAnchor,
  containers: readonly DocxAnchorTextContainer[],
): AnchorResolution {
  const identity = containers.filter(
    (container) => container.blockId === anchor.blockId,
  );
  const pathMatches = containers.filter((container) =>
    arraysEqual(container.structuralPath, anchor.structuralPath),
  );
  const candidates =
    identity.length > 0 ? identity : pathMatches.length > 0 ? pathMatches : containers;
  const match = resolveAgainstContainers(anchor, candidates, identity.length > 0);
  if (match.status !== 'found') return { status: match.status };
  const container = match.container as DocxAnchorTextContainer;
  return {
    status: match.exactIdentity ? 'exact' : 'relocated',
    selection: {
      text: anchor.quote,
      target: {
        kind: 'docx-block',
        blockId: container.blockId,
        blockIndex: container.blockIndex,
      },
      fragments: [
        {
          containerId: container.blockId,
          text: anchor.quote,
          startOffset: match.startOffset,
          endOffset: match.startOffset + anchor.quote.length,
        },
      ],
    },
  };
}

export function sanitizeDocumentSemanticAnchor(
  value: unknown,
): DocumentSemanticAnchor | null {
  if (!isRecord(value) || value.version !== 1 || !isSafeId(value.documentId)) {
    return null;
  }
  const base = sanitizeTextAnchorBase(value);
  if (!base) return null;

  if (value.kind === 'pdf-text') {
    const rects = sanitizeRects(value.rects);
    if (!isPositiveIndex(value.pageNumber) || !rects) return null;
    return { kind: 'pdf-text', ...base, pageNumber: value.pageNumber, rects };
  }
  if (value.kind === 'pptx-text') {
    const rects = sanitizeRects(value.rects);
    if (!isSafeId(value.slideId) || !isSafeId(value.shapeId) || !rects) return null;
    if (!isIndex(value.slideIndex) || !isIndex(value.paragraphIndex)) return null;
    if (!isOptionalIndex(value.runIndex)) return null;
    return {
      kind: 'pptx-text',
      ...base,
      slideId: value.slideId,
      slideIndex: value.slideIndex,
      shapeId: value.shapeId,
      paragraphIndex: value.paragraphIndex,
      ...(value.runIndex === undefined ? {} : { runIndex: value.runIndex }),
      rects,
    };
  }
  if (value.kind === 'docx-text') {
    const structuralPath = sanitizeStructuralPath(value.structuralPath);
    if (!isSafeId(value.blockId) || !isIndex(value.blockIndex) || !structuralPath) {
      return null;
    }
    return {
      kind: 'docx-text',
      ...base,
      blockId: value.blockId,
      blockIndex: value.blockIndex,
      structuralPath,
    };
  }
  return null;
}

export function sanitizeDocumentSemanticAnchors(
  value: unknown,
): DocumentSemanticAnchor[] {
  if (!Array.isArray(value) || value.length > 100_000) return [];
  const sanitized: DocumentSemanticAnchor[] = [];
  for (const candidate of value) {
    const anchor = sanitizeDocumentSemanticAnchor(candidate);
    if (anchor) sanitized.push(anchor);
  }
  return sanitized;
}

interface ResolvedCandidate<T> {
  readonly container: T;
  readonly startOffset: number;
  readonly score: number;
  readonly exactIdentity: boolean;
}

function resolveAgainstContainers<
  T extends PptxAnchorTextContainer | DocxAnchorTextContainer,
>(
  anchor: TextAnchorBase,
  containers: readonly T[],
  identityIsStable = true,
):
  | ({ readonly status: 'found' } & ResolvedCandidate<T>)
  | { readonly status: 'ambiguous' | 'missing' } {
  const matches: ResolvedCandidate<T>[] = [];
  for (const container of containers) {
    for (const startOffset of findOccurrences(container.text, anchor.quote)) {
      const prefixMatches = container.text
        .slice(Math.max(0, startOffset - anchor.prefix.length), startOffset)
        .endsWith(anchor.prefix);
      const suffixStart = startOffset + anchor.quote.length;
      const suffixMatches = container.text
        .slice(suffixStart, suffixStart + anchor.suffix.length)
        .startsWith(anchor.suffix);
      const offsetMatches = startOffset === anchor.startOffset;
      const score =
        (prefixMatches ? 4 : 0) + (suffixMatches ? 4 : 0) + (offsetMatches ? 2 : 0);
      matches.push({
        container,
        startOffset,
        score,
        exactIdentity:
          identityIsStable && offsetMatches && prefixMatches && suffixMatches,
      });
    }
  }
  if (matches.length === 0) return { status: 'missing' };
  matches.sort((left, right) => right.score - left.score);
  if (matches.length > 1 && matches[0].score === matches[1].score) {
    return { status: 'ambiguous' };
  }
  return { status: 'found', ...matches[0] };
}

function getSelectionContext(
  text: string,
  startOffset: number,
  endOffset: number,
): Pick<
  TextAnchorBase,
  'quote' | 'prefix' | 'suffix' | 'startOffset' | 'endOffset'
> | null {
  if (text.length > 10_000_000 || !isIndex(startOffset) || !isIndex(endOffset))
    return null;
  if (endOffset <= startOffset || endOffset > text.length) return null;
  const quote = text.slice(startOffset, endOffset);
  if (!quote || quote.length > MAX_QUOTE_LENGTH) return null;
  return {
    quote,
    prefix: text.slice(Math.max(0, startOffset - MAX_CONTEXT_LENGTH), startOffset),
    suffix: text.slice(endOffset, endOffset + MAX_CONTEXT_LENGTH),
    startOffset,
    endOffset,
  };
}

function sanitizeTextAnchorBase(value: Record<string, unknown>): TextAnchorBase | null {
  if (!isSafeId(value.documentId)) return null;
  if (!isBoundedString(value.quote, 1, MAX_QUOTE_LENGTH)) return null;
  if (!isBoundedString(value.prefix, 0, MAX_CONTEXT_LENGTH)) return null;
  if (!isBoundedString(value.suffix, 0, MAX_CONTEXT_LENGTH)) return null;
  if (!isIndex(value.startOffset) || !isIndex(value.endOffset)) return null;
  if (value.endOffset <= value.startOffset) return null;
  if (value.endOffset - value.startOffset !== value.quote.length) return null;
  return {
    version: 1,
    documentId: value.documentId,
    quote: value.quote,
    prefix: value.prefix,
    suffix: value.suffix,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
  };
}

function sanitizeRects(value: unknown): NormalizedDocumentRect[] | null {
  if (!Array.isArray(value) || value.length > MAX_RECTS) return null;
  const rects: NormalizedDocumentRect[] = [];
  for (const rect of value) {
    if (!isRecord(rect)) return null;
    if (![rect.x, rect.y, rect.width, rect.height].every(isNormalizedNumber))
      return null;
    if ((rect.width as number) <= 0 || (rect.height as number) <= 0) return null;
    rects.push({
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    });
  }
  return rects;
}

function sanitizeStructuralPath(value: unknown): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STRUCTURAL_PATH
  ) {
    return null;
  }
  if (!value.every((part) => isIndex(part) && part <= 1_000_000)) return null;
  return [...value] as number[];
}

function findOccurrences(text: string, quote: string): number[] {
  const offsets: number[] = [];
  let fromIndex = 0;
  while (fromIndex <= text.length && offsets.length <= 1_000) {
    const offset = text.indexOf(quote, fromIndex);
    if (offset < 0) break;
    offsets.push(offset);
    fromIndex = offset + Math.max(1, quote.length);
  }
  return offsets;
}

function pptxContainerId(container: PptxAnchorTextContainer): string {
  return `${container.slideId}/${container.shapeId}/${container.paragraphIndex}`;
}

function arraysEqual(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

function isSafeId(value: unknown): value is string {
  return (
    isBoundedString(value, 1, MAX_ID_LENGTH) && !containsAsciiControlCharacter(value)
  );
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f);
}

function isBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumLength &&
    value.length <= maximumLength
  );
}

function isIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isOptionalIndex(value: unknown): value is number | undefined {
  return value === undefined || isIndex(value);
}

function isNormalizedNumber(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function targetForAnchor(
  anchor: DocumentSemanticAnchor,
): DocumentNavigationTarget {
  if (anchor.kind === 'pdf-text') {
    return { kind: 'pdf-page', pageNumber: anchor.pageNumber };
  }
  if (anchor.kind === 'pptx-text') {
    return {
      kind: 'pptx-slide',
      slideId: anchor.slideId,
      slideIndex: anchor.slideIndex,
    };
  }
  return {
    kind: 'docx-block',
    blockId: anchor.blockId,
    blockIndex: anchor.blockIndex,
  };
}
