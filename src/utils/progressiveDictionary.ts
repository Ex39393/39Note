import type { DictionaryDefinition, DictionaryLookupResult } from '../types/glossary';

export interface ProgressiveDictionaryCallbacks {
  onLocalResult: (result: DictionaryLookupResult) => void;
  onRemoteResult: (definitions: DictionaryDefinition[]) => void;
  onComplete: () => void;
}

export interface ProgressiveDictionaryOptions {
  fallbackNormalizedWord: string;
  localLookup: () => Promise<DictionaryLookupResult>;
  generalLookups: Array<() => Promise<DictionaryDefinition[]>>;
  specialistLookup?: () => Promise<DictionaryDefinition[]>;
  callbacks: ProgressiveDictionaryCallbacks;
  signal: AbortSignal;
}

export async function runProgressiveDictionaryLookup({
  fallbackNormalizedWord,
  localLookup,
  generalLookups,
  specialistLookup,
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

  let combinedDefinitions = [...localResult.definitions];
  for (const lookup of generalLookups) {
    const definitions = await runProviderLookup(lookup, signal);
    if (signal.aborted) return;
    if (definitions.length > 0) {
      callbacks.onRemoteResult(definitions);
      combinedDefinitions = [...combinedDefinitions, ...definitions];
    }
  }

  if (
    specialistLookup &&
    shouldQuerySpecialistDictionary(combinedDefinitions)
  ) {
    const definitions = await runProviderLookup(specialistLookup, signal);
    if (signal.aborted) return;
    if (definitions.length > 0) callbacks.onRemoteResult(definitions);
  }

  if (!signal.aborted) callbacks.onComplete();
}

/** Conservative fallback: specialist traffic is allowed only after no usable general sense remains. */
export function shouldQuerySpecialistDictionary(
  definitions: readonly DictionaryDefinition[],
): boolean {
  return definitions.filter((definition) => definition.text.trim().length > 0).length === 0;
}

async function runProviderLookup(
  lookup: () => Promise<DictionaryDefinition[]>,
  signal: AbortSignal,
): Promise<DictionaryDefinition[]> {
  try {
    return await lookup();
  } catch (error) {
    if (isAbortError(error) || signal.aborted) return [];
    return [];
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
