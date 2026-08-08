import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DictionaryDefinition, DictionaryProvider } from '../../types/glossary';

const DATABASE_NAME = '39note-dictionary-cache';
const DATABASE_VERSION = 1;
const RESULT_STORE = 'remote-results';
const WIKTIONARY_TTL = 30 * 24 * 60 * 60 * 1_000;
const MESH_TTL = 365 * 24 * 60 * 60 * 1_000;

interface CachedDictionaryResult {
  key: string;
  provider: Exclude<DictionaryProvider, 'wordnet'>;
  providerVersion: string;
  normalizedWord: string;
  definitions: DictionaryDefinition[];
  cachedAt: number;
  expiresAt: number;
}

interface DictionaryCacheDatabase extends DBSchema {
  [RESULT_STORE]: {
    key: string;
    value: CachedDictionaryResult;
  };
}

let databasePromise: Promise<IDBPDatabase<DictionaryCacheDatabase>> | null = null;

export async function getCachedDictionaryDefinitions(
  provider: Exclude<DictionaryProvider, 'wordnet'>,
  normalizedWord: string,
  providerVersion: string,
): Promise<DictionaryDefinition[] | null> {
  const database = await getDatabase();
  if (!database) return null;
  const key = createDictionaryCacheKey(provider, normalizedWord, providerVersion);
  const cached = await database.get(RESULT_STORE, key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) await database.delete(RESULT_STORE, key);
    return null;
  }
  return sanitizeCachedDefinitions(cached.definitions, provider);
}

export async function cacheDictionaryDefinitions(
  provider: Exclude<DictionaryProvider, 'wordnet'>,
  normalizedWord: string,
  providerVersion: string,
  definitions: readonly DictionaryDefinition[],
): Promise<void> {
  const sanitized = sanitizeCachedDefinitions(definitions, provider);
  if (!sanitized?.length) return;
  const database = await getDatabase();
  if (!database) return;
  const cachedAt = Date.now();
  await database.put(RESULT_STORE, {
    key: createDictionaryCacheKey(provider, normalizedWord, providerVersion),
    provider,
    providerVersion,
    normalizedWord,
    definitions: sanitized,
    cachedAt,
    expiresAt: cachedAt + (provider === 'wiktionary' ? WIKTIONARY_TTL : MESH_TTL),
  });
}

export async function clearDictionaryCache(): Promise<void> {
  const database = await getDatabase();
  if (database) await database.clear(RESULT_STORE);
}

export function createDictionaryCacheKey(
  provider: Exclude<DictionaryProvider, 'wordnet'>,
  normalizedWord: string,
  providerVersion: string,
): string {
  return `${provider}:${providerVersion}:${normalizedWord}`;
}

async function getDatabase(): Promise<IDBPDatabase<DictionaryCacheDatabase> | null> {
  if (typeof indexedDB === 'undefined') return null;
  if (!databasePromise) {
    databasePromise = openDB<DictionaryCacheDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(RESULT_STORE)) {
          database.createObjectStore(RESULT_STORE, { keyPath: 'key' });
        }
      },
    });
    void databasePromise.catch(() => {
      databasePromise = null;
    });
  }
  return databasePromise;
}

function sanitizeCachedDefinitions(
  value: readonly DictionaryDefinition[] | unknown,
  expectedProvider: Exclude<DictionaryProvider, 'wordnet'>,
): DictionaryDefinition[] | null {
  if (!Array.isArray(value)) return null;
  const definitions = value.flatMap((candidate) => {
    const sanitized = sanitizeCachedDefinition(candidate, expectedProvider);
    return sanitized ? [sanitized] : [];
  });
  return definitions.length === value.length ? definitions : null;
}

function sanitizeCachedDefinition(
  candidate: unknown,
  expectedProvider: Exclude<DictionaryProvider, 'wordnet'>,
): DictionaryDefinition | null {
  if (!isRecord(candidate) || !isRecord(candidate.source)) return null;
  const id = cleanText(candidate.id, 300);
  const text = cleanText(candidate.text, 1_500);
  const partOfSpeech = cleanOptionalText(candidate.partOfSpeech, 80);
  if (!id || !text || partOfSpeech === undefined) return null;

  if (expectedProvider === 'wiktionary') {
    const source = candidate.source;
    const sourcePartOfSpeech = cleanOptionalText(source.partOfSpeech, 80);
    const domain = cleanOptionalText(source.domain, 120);
    const sourceId = cleanOptionalText(source.sourceId, 300);
    if (
      source.provider !== 'wiktionary' ||
      source.dataset !== 'English Wiktionary' ||
      source.version !== 'structured-definitions-v1' ||
      source.license !== 'CC BY-SA 4.0 / GFDL' ||
      source.sourceUrl !== 'https://en.wiktionary.org/' ||
      sourcePartOfSpeech === undefined ||
      domain === undefined ||
      sourceId === undefined
    ) {
      return null;
    }
    return {
      id,
      text,
      ...(partOfSpeech ? { partOfSpeech } : {}),
      source: {
        provider: 'wiktionary',
        dataset: 'English Wiktionary',
        version: 'structured-definitions-v1',
        license: 'CC BY-SA 4.0 / GFDL',
        sourceUrl: 'https://en.wiktionary.org/',
        ...(sourcePartOfSpeech ? { partOfSpeech: sourcePartOfSpeech } : {}),
        ...(domain ? { domain } : {}),
        ...(sourceId ? { sourceId } : {}),
      },
    };
  }

  const source = candidate.source;
  const version = cleanText(source.version, 40);
  const sourceId = cleanText(source.sourceId, 100);
  const preferredHeading = cleanText(source.preferredHeading, 300);
  if (
    source.provider !== 'mesh' ||
    source.dataset !== 'NLM MeSH' ||
    source.license !== 'NLM MeSH Terms and Conditions' ||
    source.sourceUrl !== 'https://www.nlm.nih.gov/mesh/' ||
    source.domain !== 'Biomedical terminology' ||
    !version ||
    !sourceId ||
    !preferredHeading
  ) {
    return null;
  }
  return {
    id,
    text,
    ...(partOfSpeech ? { partOfSpeech } : {}),
    source: {
      provider: 'mesh',
      dataset: 'NLM MeSH',
      version,
      license: 'NLM MeSH Terms and Conditions',
      sourceUrl: 'https://www.nlm.nih.gov/mesh/',
      domain: 'Biomedical terminology',
      sourceId,
      preferredHeading,
    },
  };
}

function cleanOptionalText(
  value: unknown,
  maximumLength: number,
): string | null | undefined {
  return value === undefined ? null : (cleanText(value, maximumLength) ?? undefined);
}

function cleanText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replaceAll(/\s+/g, ' ').trim();
  return cleaned.length > 0 && cleaned.length <= maximumLength ? cleaned : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
