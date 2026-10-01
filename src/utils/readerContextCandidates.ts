import type { PdfGlossaryEntry } from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';

export type ReaderContextCandidateReference =
  | { kind: 'annotation'; annotationId: string }
  | { kind: 'glossary'; glossaryEntryId: string };

export interface ReaderContextCandidateSelection {
  candidates: ReaderContextCandidateReference[];
  activeCandidateKey: string;
}

export function createReaderContextCandidates(
  annotations: readonly PdfAnnotation[],
  glossaryEntries: readonly PdfGlossaryEntry[],
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

  return candidates;
}

export function getReaderContextCandidateKey(
  candidate: ReaderContextCandidateReference,
): string {
  return candidate.kind === 'annotation'
    ? `annotation:${candidate.annotationId}`
    : `glossary:${candidate.glossaryEntryId}`;
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
