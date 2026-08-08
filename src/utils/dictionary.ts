import type {
  DictionaryDefinition,
  DictionaryProvider,
  DictionarySourceAttribution,
} from '../types/glossary';
import type { PdfTextSelection } from '../types/textSelection';

const lexicalWordPattern = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

export function extractEnglishLookupWord(selectionText: string): string | null {
  const trimmed = selectionText
    .trim()
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z]+$/, '')
    .replaceAll('\u2019', "'");

  return lexicalWordPattern.test(trimmed) ? trimmed : null;
}

export function getDictionaryLookupSelection(
  selections: readonly PdfTextSelection[],
): PdfTextSelection | null {
  if (selections.length !== 1) return null;
  const selectedWord = extractEnglishLookupWord(selections[0].text);
  return selectedWord ? { ...selections[0], text: selectedWord } : null;
}

export function normalizeLookupWord(word: string): string {
  return word.toLocaleLowerCase('en-US');
}

export function getSafeLookupCandidates(word: string): string[] {
  const exact = normalizeLookupWord(word);
  const candidates = [exact];
  const add = (candidate: string) => {
    if (
      candidate.length >= 2 &&
      lexicalWordPattern.test(candidate) &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  };

  if (exact.endsWith("'s") && exact.length > 3) add(exact.slice(0, -2));

  if (exact.endsWith('ies') && exact.length > 4) add(`${exact.slice(0, -3)}y`);
  if (exact.endsWith('ied') && exact.length > 4) add(`${exact.slice(0, -3)}y`);
  if (exact.endsWith('es') && exact.length > 3) add(exact.slice(0, -2));
  if (
    exact.endsWith('s') &&
    exact.length > 3 &&
    !exact.endsWith('ss') &&
    !exact.endsWith('us') &&
    !exact.endsWith('is')
  ) {
    add(exact.slice(0, -1));
  }

  for (const suffix of ['ed', 'ing'] as const) {
    if (!exact.endsWith(suffix) || exact.length <= suffix.length + 2) continue;
    const stem = exact.slice(0, -suffix.length);
    add(stem);
    add(`${stem}e`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
  }

  return candidates;
}

export function getDictionaryShardKey(word: string): string {
  const normalized = normalizeLookupWord(word).replace(/[^a-z]/g, '');
  if (normalized.length === 0) return '';
  return normalized.length === 1 ? `${normalized}_` : normalized.slice(0, 2);
}

export function deduplicateDefinitions(
  definitions: readonly DictionaryDefinition[],
): DictionaryDefinition[] {
  const accepted: DictionaryDefinition[] = [];
  return definitions.filter((definition) => {
    const fingerprint = getDefinitionFingerprint(definition.text);
    if (!fingerprint) return false;
    const duplicate = accepted.some((existing) =>
      areDefinitionsNearIdentical(existing.text, definition.text),
    );
    if (!duplicate) accepted.push(definition);
    return !duplicate;
  });
}

export function mergeDictionaryDefinitions(
  currentDefinitions: readonly DictionaryDefinition[],
  incomingDefinitions: readonly DictionaryDefinition[],
): DictionaryDefinition[] {
  const merged = [...currentDefinitions];
  for (const incoming of incomingDefinitions) {
    const duplicateIndex = merged.findIndex((existing) =>
      areDefinitionsNearIdentical(existing.text, incoming.text),
    );
    if (duplicateIndex === -1) {
      merged.push(incoming);
      continue;
    }

    if (
      getProviderPriority(incoming.source) <
      getProviderPriority(merged[duplicateIndex].source)
    ) {
      merged[duplicateIndex] = incoming;
    }
  }
  return merged;
}

export function areDefinitionsNearIdentical(first: string, second: string): boolean {
  const firstFingerprint = getDefinitionFingerprint(first);
  const secondFingerprint = getDefinitionFingerprint(second);
  if (!firstFingerprint || !secondFingerprint) return false;
  if (firstFingerprint === secondFingerprint) return true;
  const similarity =
    Math.min(firstFingerprint.length, secondFingerprint.length) /
    Math.max(firstFingerprint.length, secondFingerprint.length);
  return (
    similarity >= 0.94 &&
    (firstFingerprint.includes(secondFingerprint) ||
      secondFingerprint.includes(firstFingerprint))
  );
}

export function getDictionaryProvider(
  source: DictionarySourceAttribution,
): DictionaryProvider {
  return source.provider ?? 'wordnet';
}

export function getDictionarySourceLabel(
  source: DictionarySourceAttribution,
): string {
  const provider = getDictionaryProvider(source);
  if (provider === 'wiktionary') return 'English Wiktionary';
  if (provider === 'mesh') return `NLM MeSH ${source.version}`;
  return 'Princeton WordNet 3.1';
}

export function getDictionaryAttributionText(
  sources: readonly DictionarySourceAttribution[],
): string {
  const providers = new Set(sources.map(getDictionaryProvider));
  const statements: string[] = [];
  if (providers.has('wordnet')) {
    statements.push(
      'Definitions from Princeton WordNet 3.1, used under the Princeton WordNet License.',
    );
  }
  if (providers.has('wiktionary')) {
    statements.push(
      'Definitions from English Wiktionary contributors, available under CC BY-SA 4.0 and GFDL.',
    );
  }
  if (providers.has('mesh')) {
    statements.push(
      'MeSH definitions courtesy of the U.S. National Library of Medicine; no endorsement is implied.',
    );
  }
  return statements.join(' ');
}

export function moveDefinitionUp(
  definitions: readonly DictionaryDefinition[],
  definitionId: string,
): DictionaryDefinition[] {
  const index = definitions.findIndex((definition) => definition.id === definitionId);
  if (index <= 0) return [...definitions];
  const reordered = [...definitions];
  [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
  return reordered;
}

export function getVisibleDefinitions<T>(
  definitions: readonly T[],
  expanded: boolean,
): T[] {
  return expanded ? [...definitions] : definitions.slice(0, 3);
}

function getDefinitionFingerprint(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProviderPriority(source: DictionarySourceAttribution): number {
  const provider = getDictionaryProvider(source);
  if (provider === 'mesh') return 0;
  if (provider === 'wordnet') return 1;
  return 2;
}
