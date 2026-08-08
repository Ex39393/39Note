import type { DictionaryDefinition, DictionaryLookupResult } from '../types/glossary';

export interface ProgressiveDictionaryCallbacks {
  onLocalResult: (result: DictionaryLookupResult) => void;
  onRemoteResult: (definitions: DictionaryDefinition[]) => void;
  onComplete: () => void;
}

export interface ProgressiveDictionaryOptions {
  fallbackNormalizedWord: string;
  localLookup: () => Promise<DictionaryLookupResult>;
  remoteLookups: Array<() => Promise<DictionaryDefinition[]>>;
  callbacks: ProgressiveDictionaryCallbacks;
  signal: AbortSignal;
}

export async function runProgressiveDictionaryLookup({
  fallbackNormalizedWord,
  localLookup,
  remoteLookups,
  callbacks,
  signal,
}: ProgressiveDictionaryOptions): Promise<void> {
  let localResult: DictionaryLookupResult;
  try {
    localResult = await localLookup();
  } catch {
    localResult = { normalizedWord: fallbackNormalizedWord, definitions: [] };
  }
  if (signal.aborted) return;
  callbacks.onLocalResult(localResult);

  const requests = remoteLookups.map(async (lookup) => {
    try {
      const definitions = await lookup();
      if (!signal.aborted && definitions.length > 0) {
        callbacks.onRemoteResult(definitions);
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  });
  await Promise.allSettled(requests);
  if (!signal.aborted) callbacks.onComplete();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
