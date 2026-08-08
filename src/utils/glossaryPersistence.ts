import type { GlossaryEntry } from '../types/glossary';

export function sanitizePersistedGlossaryEntries(
  value: unknown,
  documentId: string,
): GlossaryEntry[] {
  if (!Array.isArray(value)) return [];
  const entryIds = new Set<string>();
  const markerIds = new Set<string>();
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.glossaryEntryId) ||
      entryIds.has(candidate.glossaryEntryId) ||
      candidate.documentId !== documentId ||
      !isNonEmptyString(candidate.displayedWord) ||
      !isNonEmptyString(candidate.normalizedLookupWord) ||
      !isNonEmptyString(candidate.definition) ||
      !isPositiveInteger(candidate.pageNumber) ||
      !isPositiveIntegerOrZero(candidate.startOffset) ||
      !isPositiveIntegerOrZero(candidate.endOffset) ||
      candidate.endOffset < candidate.startOffset ||
      !isTimestamp(candidate.createdAt) ||
      !isNonEmptyString(candidate.markerAnnotationId) ||
      markerIds.has(candidate.markerAnnotationId) ||
      !isRecord(candidate.source) ||
      candidate.source.dataset !== 'Princeton WordNet' ||
      candidate.source.version !== '3.1' ||
      candidate.source.license !== 'Princeton WordNet License' ||
      candidate.source.sourceUrl !== 'https://wordnet.princeton.edu/' ||
      !['noun', 'verb', 'adjective', 'adverb'].includes(
        String(candidate.source.partOfSpeech),
      )
    )
      return [];

    const sourceRects = sanitizeRectangles(candidate.sourceRects);
    if (sourceRects.length === 0) return [];
    entryIds.add(candidate.glossaryEntryId);
    markerIds.add(candidate.markerAnnotationId);
    return [
      {
        glossaryEntryId: candidate.glossaryEntryId,
        documentId,
        displayedWord: candidate.displayedWord,
        normalizedLookupWord: candidate.normalizedLookupWord,
        definition: candidate.definition,
        pageNumber: candidate.pageNumber,
        sourceRects,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        createdAt: candidate.createdAt,
        source: {
          dataset: 'Princeton WordNet',
          version: '3.1',
          license: 'Princeton WordNet License',
          sourceUrl: 'https://wordnet.princeton.edu/',
          partOfSpeech: candidate.source.partOfSpeech,
        },
        markerAnnotationId: candidate.markerAnnotationId,
      } as GlossaryEntry,
    ];
  });
}

function sanitizeRectangles(value: unknown): GlossaryEntry['sourceRects'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rectangle) =>
    isRecord(rectangle) &&
    [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(
      isFiniteNumber,
    ) &&
    Number(rectangle.width) > 0 &&
    Number(rectangle.height) > 0
      ? [
          {
            x: Number(rectangle.x),
            y: Number(rectangle.y),
            width: Number(rectangle.width),
            height: Number(rectangle.height),
          },
        ]
      : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
function isPositiveIntegerOrZero(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && Number(value) >= 0;
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
