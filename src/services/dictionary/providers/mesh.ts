import type { DictionaryDefinition } from '../../../types/glossary';
import { fetchNcbiJson } from './ncbiRequestQueue';
import { parseMeshDefinitions, parseMeshSearchIdentifier } from './meshParser';

export { MESH_PROVIDER_VERSION } from './meshParser';
const meshTermsField = 'MeSH Terms';

export async function lookupMesh(
  normalizedWord: string,
  signal: AbortSignal,
): Promise<DictionaryDefinition[]> {
  const searchUrl = new URL(
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',
  );
  searchUrl.searchParams.set('db', 'mesh');
  searchUrl.searchParams.set('term', `"${normalizedWord}"[${meshTermsField}]`);
  searchUrl.searchParams.set('retmode', 'json');
  searchUrl.searchParams.set('retmax', '3');
  searchUrl.searchParams.set('tool', '39Note');
  const identifier = parseMeshSearchIdentifier(
    await fetchNcbiJson(searchUrl, signal),
  );
  if (!identifier) return [];

  const summaryUrl = new URL(
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi',
  );
  summaryUrl.searchParams.set('db', 'mesh');
  summaryUrl.searchParams.set('id', identifier);
  summaryUrl.searchParams.set('retmode', 'json');
  summaryUrl.searchParams.set('tool', '39Note');
  return parseMeshDefinitions(
    await fetchNcbiJson(summaryUrl, signal),
    normalizedWord,
    identifier,
  );
}
