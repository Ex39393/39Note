import type { DictionaryDefinition } from '../types/glossary';

const lexicalWordPattern = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

export function extractEnglishLookupWord(selectionText: string): string | null {
  const trimmed = selectionText
    .trim()
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z]+$/, '')
    .replaceAll('\u2019', "'");

  return lexicalWordPattern.test(trimmed) ? trimmed : null;
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
  const fingerprints: string[] = [];
  return definitions.filter((definition) => {
    const fingerprint = definition.text
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!fingerprint) return false;
    const duplicate = fingerprints.some(
      (existing) =>
        existing === fingerprint ||
        (Math.min(existing.length, fingerprint.length) /
          Math.max(existing.length, fingerprint.length) >=
          0.94 &&
          (existing.includes(fingerprint) || fingerprint.includes(existing))),
    );
    if (!duplicate) fingerprints.push(fingerprint);
    return !duplicate;
  });
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
