import type {
  DictionarySourceAttribution,
  GlossaryEntry,
} from '../types/glossary';

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
      !sanitizeDictionarySource(candidate.source)
    )
      return [];

    const sourceRects = sanitizeRectangles(candidate.sourceRects);
    const source = sanitizeDictionarySource(candidate.source);
    if (sourceRects.length === 0 || !source) return [];
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
        source,
        markerAnnotationId: candidate.markerAnnotationId,
      } as GlossaryEntry,
    ];
  });
}

export function sanitizeDictionarySource(
  value: unknown,
): DictionarySourceAttribution | null {
  if (!isRecord(value)) return null;
  if (
    (value.provider === undefined || value.provider === 'wordnet') &&
    value.dataset === 'Princeton WordNet' &&
    value.version === '3.1' &&
    value.license === 'Princeton WordNet License' &&
    value.sourceUrl === 'https://wordnet.princeton.edu/' &&
    ['noun', 'verb', 'adjective', 'adverb'].includes(String(value.partOfSpeech))
  ) {
    return {
      provider: 'wordnet',
      dataset: 'Princeton WordNet',
      version: '3.1',
      license: 'Princeton WordNet License',
      sourceUrl: 'https://wordnet.princeton.edu/',
      partOfSpeech: value.partOfSpeech as 'noun' | 'verb' | 'adjective' | 'adverb',
    };
  }
  if (
    value.provider === 'wiktionary' &&
    value.dataset === 'English Wiktionary' &&
    value.version === 'structured-definitions-v1' &&
    value.license === 'CC BY-SA 4.0 / GFDL' &&
    value.sourceUrl === 'https://en.wiktionary.org/'
  ) {
    return {
      provider: 'wiktionary',
      dataset: 'English Wiktionary',
      version: 'structured-definitions-v1',
      license: 'CC BY-SA 4.0 / GFDL',
      sourceUrl: 'https://en.wiktionary.org/',
      ...(isNonEmptyString(value.partOfSpeech)
        ? { partOfSpeech: value.partOfSpeech }
        : {}),
      ...(isNonEmptyString(value.domain) ? { domain: value.domain } : {}),
      ...(isNonEmptyString(value.sourceId) ? { sourceId: value.sourceId } : {}),
    };
  }
  if (
    value.provider === 'mesh' &&
    value.dataset === 'NLM MeSH' &&
    isNonEmptyString(value.version) &&
    value.license === 'NLM MeSH Terms and Conditions' &&
    value.sourceUrl === 'https://www.nlm.nih.gov/mesh/' &&
    value.domain === 'Biomedical terminology' &&
    isNonEmptyString(value.sourceId) &&
    isNonEmptyString(value.preferredHeading)
  ) {
    return {
      provider: 'mesh',
      dataset: 'NLM MeSH',
      version: value.version,
      license: 'NLM MeSH Terms and Conditions',
      sourceUrl: 'https://www.nlm.nih.gov/mesh/',
      domain: 'Biomedical terminology',
      sourceId: value.sourceId,
      preferredHeading: value.preferredHeading,
    };
  }
  return null;
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
