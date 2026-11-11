import type { PdfGlossaryEntry } from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';
import type { DocumentLinkEndpointReference } from './documentLinkPresentation.ts';

export type ReaderContextCandidateReference =
  | { kind: 'annotation'; annotationId: string }
  | { kind: 'glossary'; glossaryEntryId: string }
  | { kind: 'link'; linkId: string; endpointId: string };

export interface ReaderContextCandidateSelection {
  candidates: ReaderContextCandidateReference[];
  activeCandidateKey: string;
}

export function createReaderContextCandidates(
  annotations: readonly PdfAnnotation[],
  glossaryEntries: readonly PdfGlossaryEntry[],
  linkEndpoints: readonly DocumentLinkEndpointReference[] = [],
): ReaderContextCandidateReference[] {
  const candidates: ReaderContextCandidateReference[] = [];
  const seen = new Set<string>();

  for (const annotation of annotations) {
    const candidate: ReaderContextCandidateReference = {
      kind: 'annotation',
      annotationId: annotation.id,
    };
    const key = getReaderContextCandidateKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }

  for (const entry of [...glossaryEntries].sort(compareGlossaryCandidates)) {
    const candidate: ReaderContextCandidateReference = {
      kind: 'glossary',
      glossaryEntryId: entry.glossaryEntryId,
    };
    const key = getReaderContextCandidateKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }

  for (const target of [...linkEndpoints].sort(compareLinkCandidates)) {
    const candidate: ReaderContextCandidateReference = {
      kind: 'link',
      linkId: target.link.id,
      endpointId: target.endpoint.id,
    };
    const key = getReaderContextCandidateKey(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function getReaderContextCandidateKey(
  candidate: ReaderContextCandidateReference,
): string {
  if (candidate.kind === 'annotation') return `annotation:${candidate.annotationId}`;
  if (candidate.kind === 'glossary') return `glossary:${candidate.glossaryEntryId}`;
  return `link:${candidate.linkId}:${candidate.endpointId}`;
}

export function getAdjacentReaderContextCandidateKey(
  candidates: readonly ReaderContextCandidateReference[],
  activeCandidateKey: string,
  direction: -1 | 1,
): string | null {
  if (candidates.length === 0) return null;
  const activeIndex = candidates.findIndex(
    (candidate) => getReaderContextCandidateKey(candidate) === activeCandidateKey,
  );
  const resolvedIndex = activeIndex === -1 ? 0 : activeIndex;
  const nextIndex = (resolvedIndex + direction + candidates.length) % candidates.length;
  return getReaderContextCandidateKey(candidates[nextIndex]);
}

export function removeReaderContextCandidate(
  candidates: readonly ReaderContextCandidateReference[],
  activeCandidateKey: string,
  removedCandidateKey: string,
): ReaderContextCandidateSelection | null {
  const removedIndex = candidates.findIndex(
    (candidate) => getReaderContextCandidateKey(candidate) === removedCandidateKey,
  );
  if (removedIndex === -1) {
    return candidates.length === 0
      ? null
      : { candidates: [...candidates], activeCandidateKey };
  }

  const remaining = candidates.filter(
    (candidate) => getReaderContextCandidateKey(candidate) !== removedCandidateKey,
  );
  if (remaining.length === 0) return null;
  if (
    activeCandidateKey !== removedCandidateKey &&
    remaining.some(
      (candidate) => getReaderContextCandidateKey(candidate) === activeCandidateKey,
    )
  ) {
    return { candidates: remaining, activeCandidateKey };
  }

  const nextCandidate = remaining[Math.min(removedIndex, remaining.length - 1)];
  return {
    candidates: remaining,
    activeCandidateKey: getReaderContextCandidateKey(nextCandidate),
  };
}

function compareGlossaryCandidates(
  first: PdfGlossaryEntry,
  second: PdfGlossaryEntry,
): number {
  const firstRectangle = first.sourceRects[0] ?? { x: 0, y: 0 };
  const secondRectangle = second.sourceRects[0] ?? { x: 0, y: 0 };
  return (
    first.pageNumber - second.pageNumber ||
    firstRectangle.y - secondRectangle.y ||
    firstRectangle.x - secondRectangle.x ||
    first.createdAt - second.createdAt ||
    first.glossaryEntryId.localeCompare(second.glossaryEntryId)
  );
}

function compareLinkCandidates(
  first: DocumentLinkEndpointReference,
  second: DocumentLinkEndpointReference,
): number {
  return (
    first.link.visibleNumber - second.link.visibleNumber ||
    compareStableText(first.link.id, second.link.id) ||
    compareStableText(first.endpointLabel, second.endpointLabel) ||
    compareStableText(first.endpoint.id, second.endpoint.id)
  );
}

function compareStableText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}
