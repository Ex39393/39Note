import type { DictionaryDefinition } from '../../../types/glossary';

export const MESH_PROVIDER_VERSION = '2026';

export function parseMeshSearchIdentifier(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.esearchresult)) return null;
  const identifiers = value.esearchresult.idlist;
  return Array.isArray(identifiers) && identifiers.length === 1
    ? cleanIdentifier(identifiers[0])
    : null;
}

export function parseMeshDefinitions(
  value: unknown,
  normalizedWord: string,
  expectedIdentifier: string,
): DictionaryDefinition[] {
  if (!isRecord(value) || !isRecord(value.result)) return [];
  const record = value.result[expectedIdentifier];
  if (!isRecord(record)) return [];
  const terms = Array.isArray(record.ds_meshterms)
    ? record.ds_meshterms.flatMap((term) => {
        const cleaned = cleanText(term, 300);
        return cleaned ? [cleaned] : [];
      })
    : [];
  const exactTerm = terms.find(
    (term) => term.toLocaleLowerCase('en-US') === normalizedWord,
  );
  const scopeNote = cleanText(record.ds_scopenote, 1_500);
  const sourceId = cleanIdentifier(record.ds_meshui) ?? cleanIdentifier(record.uid);
  const preferredHeading = terms[0];
  if (!exactTerm || !scopeNote || !sourceId || !preferredHeading) return [];

  return [
    {
      id: `mesh:${sourceId}`,
      text: scopeNote,
      source: {
        provider: 'mesh',
        dataset: 'NLM MeSH',
        version: MESH_PROVIDER_VERSION,
        license: 'NLM MeSH Terms and Conditions',
        sourceUrl: 'https://www.nlm.nih.gov/mesh/',
        domain: 'Biomedical terminology',
        sourceId,
        preferredHeading,
      },
    },
  ];
}

function cleanIdentifier(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]?\d+$/.test(value) ? value : null;
}

function cleanText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > 0 && cleaned.length <= maximumLength ? cleaned : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
