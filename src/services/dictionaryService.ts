import type {
  DictionaryDefinition,
  DictionaryPartOfSpeech,
  DictionarySourceAttribution,
} from '../types/glossary';
import {
  deduplicateDefinitions,
  getDictionaryShardKey,
  getSafeLookupCandidates,
} from '../utils/dictionary';

interface DictionaryManifest {
  formatVersion: number;
  shards: Array<{ key: string }>;
}

interface DictionaryShard {
  entries: Record<string, Array<[DictionaryPartOfSpeech, string]>>;
}

export interface DictionaryLookupResult {
  normalizedWord: string;
  definitions: DictionaryDefinition[];
}

let manifestPromise: Promise<DictionaryManifest> | null = null;
const shardCache = new Map<string, Promise<DictionaryShard>>();
const sourceBase: Omit<DictionarySourceAttribution, 'partOfSpeech'> = {
  dataset: 'Princeton WordNet',
  version: '3.1',
  license: 'Princeton WordNet License',
  sourceUrl: 'https://wordnet.princeton.edu/',
};

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
