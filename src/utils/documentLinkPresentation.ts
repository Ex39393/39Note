import type { PdfSemanticAnchor } from '../documents/anchors.ts';
import type { DocumentLink, PdfLinkEndpoint } from '../types/documentLink.ts';

export interface DocumentLinkEndpointReference {
  link: DocumentLink;
  endpoint: PdfLinkEndpoint;
  endpointLabel: 'A' | 'B';
}

export interface DocumentLinkBadgeGroup {
  key: string;
  anchor: PdfSemanticAnchor;
  targets: DocumentLinkEndpointReference[];
  visibleNumbers: number[];
  label: string;
}

export interface DocumentLinkBadgeGeometry {
  badgeHitTargetCenterX: number;
  badgeVisualCenterX: number;
  badgeVisualOffsetX: number;
  isReversed: boolean;
  underlineStartX: number;
  underlineEndX: number;
}

export interface DocumentLinkBadgeVerticalGeometry {
  badgeHitTargetCenterY: number;
  badgeVisualCenterY: number;
  badgeVisualOffsetY: number;
}

export const DOCUMENT_LINK_UNDERLINE_STROKE_WIDTH = 2.1;
export const DOCUMENT_LINK_BADGE_VISUAL_DIAMETER = 17;
export const DOCUMENT_LINK_BADGE_HIT_TARGET_DIAMETER = 32;
export const DOCUMENT_LINK_BADGE_VISIBLE_GAP = 3;
const DOCUMENT_LINK_BADGE_REVERSE_THRESHOLD = 28;

export function getDocumentLinkDisplayName(link: DocumentLink): string {
  return link.name ?? `Link ${link.visibleNumber}`;
}

export function getDocumentLinkEndpointReferences(
  links: readonly DocumentLink[],
): DocumentLinkEndpointReference[] {
  return [...links]
    .sort(compareLinks)
    .flatMap((link) => [
      { link, endpoint: link.endpointA, endpointLabel: 'A' as const },
      ...(link.endpointB
        ? [{ link, endpoint: link.endpointB, endpointLabel: 'B' as const }]
        : []),
    ]);
}

export function getDocumentLinkEndpointsForPage(
  links: readonly DocumentLink[],
  pageNumber: number,
): DocumentLinkEndpointReference[] {
  return getDocumentLinkEndpointReferences(links).filter(
    ({ endpoint }) => endpoint.anchor.pageNumber === pageNumber,
  );
}

export function getDocumentLinkBadgeGroups(
  endpoints: readonly DocumentLinkEndpointReference[],
): DocumentLinkBadgeGroup[] {
  const groups = new Map<string, DocumentLinkEndpointReference[]>();
  for (const target of endpoints) {
    const key = linkAnchorDisplayKey(target.endpoint.anchor);
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }

  return [...groups.entries()].map(([key, targets]) => {
    const uniqueByLink = new Map<string, DocumentLinkEndpointReference>();
    for (const target of targets) {
      if (!uniqueByLink.has(target.link.id)) uniqueByLink.set(target.link.id, target);
    }
    const uniqueTargets = [...uniqueByLink.values()].sort((left, right) =>
      compareLinks(left.link, right.link),
    );
    const visibleNumbers = uniqueTargets.map(({ link }) => link.visibleNumber);
    return {
      key,
      anchor: uniqueTargets[0].endpoint.anchor,
      targets: uniqueTargets,
      visibleNumbers,
      label: visibleNumbers.length > 1 ? 'M' : String(visibleNumbers[0]),
    };
  });
}

export function getDocumentLinkBadgeGeometry(
  rectangle: { x: number; width: number },
  pageWidth: number,
  devicePixelRatio = 1,
): DocumentLinkBadgeGeometry {
  const safePageWidth = Math.max(0, pageWidth);
  const safePixelRatio = Math.max(1, devicePixelRatio);
  const snapToDevicePixel = (value: number) =>
    Math.round(value * safePixelRatio) / safePixelRatio;
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum);
  const underlineStartX = snapToDevicePixel(rectangle.x * safePageWidth);
  const underlineEndX = snapToDevicePixel(
    (rectangle.x + rectangle.width) * safePageWidth,
  );
  const visualRadius = DOCUMENT_LINK_BADGE_VISUAL_DIAMETER / 2;
  const hitTargetRadius = DOCUMENT_LINK_BADGE_HIT_TARGET_DIAMETER / 2;
  const strokeRadius = DOCUMENT_LINK_UNDERLINE_STROKE_WIDTH / 2;
  const isReversed =
    underlineEndX > safePageWidth - DOCUMENT_LINK_BADGE_REVERSE_THRESHOLD;
  const lineAnchorX = isReversed ? underlineStartX : underlineEndX;
  const direction = isReversed ? -1 : 1;
  const desiredVisualCenterX =
    lineAnchorX +
    direction * (strokeRadius + DOCUMENT_LINK_BADGE_VISIBLE_GAP + visualRadius);
  const badgeVisualCenterX = clamp(
    desiredVisualCenterX,
    visualRadius,
    Math.max(visualRadius, safePageWidth - visualRadius),
  );
  const badgeHitTargetCenterX = clamp(
    badgeVisualCenterX,
    hitTargetRadius,
    Math.max(hitTargetRadius, safePageWidth - hitTargetRadius),
  );
  const protectedLineEdgeX =
    badgeVisualCenterX -
    direction * (visualRadius + DOCUMENT_LINK_BADGE_VISIBLE_GAP + strokeRadius);

  return {
    badgeHitTargetCenterX,
    badgeVisualCenterX,
    badgeVisualOffsetX: badgeVisualCenterX - badgeHitTargetCenterX,
    isReversed,
    underlineStartX: isReversed
      ? Math.min(underlineEndX, Math.max(underlineStartX, protectedLineEdgeX))
      : underlineStartX,
    underlineEndX: isReversed
      ? underlineEndX
      : Math.max(underlineStartX, Math.min(underlineEndX, protectedLineEdgeX)),
  };
}

export function getDocumentLinkBadgeVerticalGeometry(
  underlineY: number,
  pageHeight: number,
): DocumentLinkBadgeVerticalGeometry {
  const safePageHeight = Math.max(0, pageHeight);
  const visualRadius = DOCUMENT_LINK_BADGE_VISUAL_DIAMETER / 2;
  const hitTargetRadius = DOCUMENT_LINK_BADGE_HIT_TARGET_DIAMETER / 2;
  const clamp = (value: number, minimum: number, maximum: number) =>
    Math.min(Math.max(value, minimum), maximum);
  const badgeVisualCenterY = clamp(
    underlineY,
    visualRadius,
    Math.max(visualRadius, safePageHeight - visualRadius),
  );
  const badgeHitTargetCenterY = clamp(
    badgeVisualCenterY,
    hitTargetRadius,
    Math.max(hitTargetRadius, safePageHeight - hitTargetRadius),
  );

  return {
    badgeHitTargetCenterY,
    badgeVisualCenterY,
    badgeVisualOffsetY: badgeVisualCenterY - badgeHitTargetCenterY,
  };
}

export function findDocumentLinkEndpointsAtNormalizedPoint(
  pageNumber: number,
  point: { x: number; y: number },
  links: readonly DocumentLink[],
): DocumentLinkEndpointReference[] {
  return getDocumentLinkEndpointsForPage(links, pageNumber).filter(({ endpoint }) =>
    endpoint.anchor.rects.some(
      (rectangle) =>
        point.x >= rectangle.x &&
        point.x <= rectangle.x + rectangle.width &&
        point.y >= rectangle.y &&
        point.y <= rectangle.y + rectangle.height,
    ),
  );
}

export function findDocumentLinkEndpointsAtClientPoint(
  pageNumber: number,
  pageBounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  point: { clientX: number; clientY: number },
  links: readonly DocumentLink[],
): DocumentLinkEndpointReference[] {
  if (pageBounds.width <= 0 || pageBounds.height <= 0) return [];
  return findDocumentLinkEndpointsAtNormalizedPoint(
    pageNumber,
    {
      x: (point.clientX - pageBounds.left) / pageBounds.width,
      y: (point.clientY - pageBounds.top) / pageBounds.height,
    },
    links,
  );
}

export function parseDocumentLinkSearchQuery(query: string): number | null {
  const match = /^\s*link\s*(\d+)\s*$/iu.exec(query);
  if (!match) return null;
  const visibleNumber = Number(match[1]);
  return Number.isSafeInteger(visibleNumber) && visibleNumber > 0
    ? visibleNumber
    : null;
}

export function isDocumentLinkSearchQuery(query: string): boolean {
  return parseDocumentLinkSearchQuery(query) !== null;
}

export function matchesDocumentLinkName(link: DocumentLink, query: string): boolean {
  const normalizedQuery = normalizeDocumentLinkSearchText(query);
  return (
    normalizedQuery.length > 0 &&
    normalizeDocumentLinkSearchText(getDocumentLinkDisplayName(link)).includes(
      normalizedQuery,
    )
  );
}

export function documentLinkMatchesSearch(link: DocumentLink, query: string): boolean {
  return getDocumentLinkSearchRank(link, query) !== null;
}

function getDocumentLinkSearchRank(link: DocumentLink, query: string): number | null {
  const normalizedQuery = normalizeDocumentLinkSearchText(query);
  if (normalizedQuery.length === 0) return null;

  const normalizedCustomName = link.name
    ? normalizeDocumentLinkSearchText(link.name)
    : null;
  let bestRank: number | null = normalizedCustomName === normalizedQuery ? 0 : null;
  const considerRank = (rank: number) => {
    bestRank = bestRank === null ? rank : Math.min(bestRank, rank);
  };

  const canonicalVisibleNumber = parseDocumentLinkSearchQuery(query);
  if (canonicalVisibleNumber === link.visibleNumber) {
    considerRank(1);
  }

  if (/^\d+$/u.test(normalizedQuery)) {
    const numericQuery = Number(normalizedQuery);
    if (
      Number.isSafeInteger(numericQuery) &&
      numericQuery > 0 &&
      numericQuery === link.visibleNumber
    ) {
      considerRank(1);
    }
  }

  if (normalizedCustomName?.startsWith(normalizedQuery)) considerRank(2);
  else if (normalizedCustomName?.includes(normalizedQuery)) considerRank(3);
  if (normalizedQuery === 'link') considerRank(4);

  if (
    canonicalVisibleNumber === null &&
    !/^\d+$/u.test(normalizedQuery) &&
    getDocumentLinkCanonicalSearchFields(link).some((field) =>
      field.includes(normalizedQuery),
    )
  ) {
    considerRank(4);
  }

  return bestRank;
}

export function matchesDocumentLinkSearchQuery(
  link: DocumentLink,
  query: string,
): boolean {
  return documentLinkMatchesSearch(link, query);
}

export function findDocumentLinksBySearchQuery(
  links: readonly DocumentLink[],
  query: string,
): DocumentLink[] {
  if (query.trim().length === 0) return [...links].sort(compareLinks);

  return links
    .map((link) => ({ link, rank: getDocumentLinkSearchRank(link, query) }))
    .filter(
      (entry): entry is { link: DocumentLink; rank: number } => entry.rank !== null,
    )
    .sort(
      (left, right) => left.rank - right.rank || compareLinks(left.link, right.link),
    )
    .map(({ link }) => link);
}

export function findDocumentLinkByVisibleNumber(
  links: readonly DocumentLink[],
  visibleNumber: number,
): DocumentLink | null {
  return (
    [...links]
      .filter((link) => link.visibleNumber === visibleNumber)
      .sort(compareLinks)[0] ?? null
  );
}

export function formatDocumentLinkSnippet(text: string, maximumLength = 72): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maximumLength - 1)).trimEnd()}…`;
}

export function getDocumentLinkFinalRectangle(anchor: PdfSemanticAnchor) {
  return (
    [...anchor.rects]
      .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
      .at(-1) ?? null
  );
}

function linkAnchorDisplayKey(anchor: PdfSemanticAnchor): string {
  const geometry = anchor.rects
    .map((rectangle) =>
      [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
        .map((value) => value.toFixed(6))
        .join(','),
    )
    .join(';');
  return `${anchor.pageNumber}|${anchor.startOffset}|${anchor.endOffset}|${geometry}`;
}

function normalizeDocumentLinkSearchText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim().toLowerCase();
}

function getDocumentLinkCanonicalSearchFields(link: DocumentLink): string[] {
  return [
    'link',
    `Link ${link.visibleNumber}`,
    `link${link.visibleNumber}`,
    String(link.visibleNumber),
  ].map(normalizeDocumentLinkSearchText);
}

function compareLinks(left: DocumentLink, right: DocumentLink): number {
  return (
    left.visibleNumber - right.visibleNumber ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}
