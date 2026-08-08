import type {
  DictionaryDefinition,
  DictionaryLookupResult,
  DictionaryPartOfSpeech,
  WordNetSourceAttribution,
} from '../types/glossary';
import {
  deduplicateDefinitions,
  getDictionaryShardKey,
  getSafeLookupCandidates,
  normalizeLookupWord,
} from '../utils/dictionary';
import {
  runProgressiveDictionaryLookup,
  type ProgressiveDictionaryCallbacks,
} from '../utils/progressiveDictionary';
import {
  cacheDictionaryDefinitions,
  createDictionaryCacheKey,
  getCachedDictionaryDefinitions,
} from './dictionary/dictionaryCache';
import { lookupMesh, MESH_PROVIDER_VERSION } from './dictionary/providers/mesh';
import {
  lookupWiktionary,
  WIKTIONARY_PROVIDER_VERSION,
} from './dictionary/providers/wiktionary';
import { createSharedRequestRegistry } from './dictionary/sharedRequest';

interface DictionaryManifest {
  formatVersion: number;
  shards: Array<{ key: string }>;
}

interface DictionaryShard {
  entries: Record<string, Array<[DictionaryPartOfSpeech, string]>>;
}

let manifestPromise: Promise<DictionaryManifest> | null = null;
const shardCache = new Map<string, Promise<DictionaryShard>>();
const sourceBase: Omit<WordNetSourceAttribution, 'partOfSpeech'> = {
  provider: 'wordnet',
  dataset: 'Princeton WordNet',
  version: '3.1',
  license: 'Princeton WordNet License',
  sourceUrl: 'https://wordnet.princeton.edu/',
};
const sharedRemoteRequests = createSharedRequestRegistry<DictionaryDefinition[]>();

export type { ProgressiveDictionaryCallbacks } from '../utils/progressiveDictionary';

export async function lookupDictionary(
  word: string,
  callbacks: ProgressiveDictionaryCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const normalizedWord = normalizeLookupWord(word);
  const canUseRemoteProviders =
    typeof navigator === 'undefined' || navigator.onLine !== false;
  await runProgressiveDictionaryLookup({
    fallbackNormalizedWord: normalizedWord,
    localLookup: () => lookupLocalDictionary(word),
    remoteLookups: canUseRemoteProviders
      ? [
          () =>
            lookupCachedRemoteProvider(
              'wiktionary',
              normalizedWord,
              WIKTIONARY_PROVIDER_VERSION,
              lookupWiktionary,
              signal,
            ),
          () =>
            lookupCachedRemoteProvider(
              'mesh',
              normalizedWord,
              MESH_PROVIDER_VERSION,
              lookupMesh,
              signal,
            ),
        ]
      : [],
    callbacks,
    signal,
  });
}

export async function lookupLocalDictionary(
  word: string,
): Promise<DictionaryLookupResult> {
  const manifest = await loadManifest();
  const availableShards = new Set(manifest.shards.map((shard) => shard.key));

  for (const candidate of getSafeLookupCandidates(word)) {
    const shardKey = getDictionaryShardKey(candidate);
    if (!shardKey || !availableShards.has(shardKey)) continue;
    const shard = await loadShard(shardKey);
    const senses = shard.entries[candidate];
    if (!senses?.length) continue;

    return {
      normalizedWord: candidate,
      definitions: deduplicateDefinitions(
        senses.map(([partOfSpeech, text], index) => ({
          id: `wordnet-3.1:${candidate}:${partOfSpeech}:${index}`,
          text: text.replaceAll(/\s+/g, ' ').trim(),
          partOfSpeech,
          source: { ...sourceBase, partOfSpeech },
        })),
      ),
    };
  }

  return { normalizedWord: word.toLocaleLowerCase('en-US'), definitions: [] };
}

function loadManifest(): Promise<DictionaryManifest> {
  if (manifestPromise) return manifestPromise;
  manifestPromise = loadJson<DictionaryManifest>('dictionary/manifest.json');
  void manifestPromise.catch(() => {
    manifestPromise = null;
  });
  return manifestPromise;
}

async function lookupCachedRemoteProvider(
  provider: 'wiktionary' | 'mesh',
  normalizedWord: string,
  providerVersion: string,
  lookup: (
    normalizedWord: string,
    signal: AbortSignal,
  ) => Promise<DictionaryDefinition[]>,
  signal: AbortSignal,
): Promise<DictionaryDefinition[]> {
  const cached = await getCachedDictionaryDefinitions(
    provider,
    normalizedWord,
    providerVersion,
  ).catch(() => null);
  if (cached) return cached;

  const key = createDictionaryCacheKey(provider, normalizedWord, providerVersion);
  return sharedRemoteRequests.request(
    key,
    async (sharedSignal) => {
      const definitions = await lookup(normalizedWord, sharedSignal);
      if (definitions.length > 0) {
        await cacheDictionaryDefinitions(
          provider,
          normalizedWord,
          providerVersion,
          definitions,
        ).catch(() => undefined);
      }
      return definitions;
    },
    signal,
  );
}


function loadShard(shardKey: string): Promise<DictionaryShard> {
  const cached = shardCache.get(shardKey);
  if (cached) return cached;
  const request = loadJson<DictionaryShard>(`dictionary/${shardKey}.json`);
  shardCache.set(shardKey, request);
  void request.catch(() => shardCache.delete(shardKey));
  return request;
}

async function loadJson<T>(relativePath: string): Promise<T> {
  const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
  const response = await fetch(new URL(relativePath, baseUrl));
  if (!response.ok)
    throw new Error(`Dictionary asset request failed (${response.status}).`);
  return (await response.json()) as T;
}
