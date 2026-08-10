import type { DictionaryDefinition } from '../../../types/glossary';
import { fetchJsonWithTimeout } from './request';
import { parseWiktionaryDefinitions } from './wiktionaryParser';

export { WIKTIONARY_PROVIDER_VERSION } from './wiktionaryParser';
export const WIKIMEDIA_API_USER_AGENT =
  '39Note/0.1.0 (https://github.com/Ex39393/39Note)';

export async function lookupWiktionary(
  normalizedWord: string,
  signal: AbortSignal,
): Promise<DictionaryDefinition[]> {
  const url = new URL(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(normalizedWord)}`,
  );
  return parseWiktionaryDefinitions(
    await fetchJsonWithTimeout(url, signal, 6_000, {
      'Api-User-Agent': WIKIMEDIA_API_USER_AGENT,
    }),
    normalizedWord,
  );
}
