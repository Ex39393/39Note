import type { DictionaryDefinition } from '../../../types/glossary';
import { fetchJsonWithTimeout } from './request';
import { parseWiktionaryDefinitions } from './wiktionaryParser';

export { WIKTIONARY_PROVIDER_VERSION } from './wiktionaryParser';

export async function lookupWiktionary(
  normalizedWord: string,
  signal: AbortSignal,
): Promise<DictionaryDefinition[]> {
  const url = new URL(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(normalizedWord)}`,
  );
  return parseWiktionaryDefinitions(
    await fetchJsonWithTimeout(url, signal),
    normalizedWord,
  );
}
