import { NcbiRequestQueue, runBoundedRetry } from '../../../utils/ncbiRequestPolicy';
import {
  DictionaryProviderHttpError,
  fetchJsonWithTimeout,
} from './request';

const ncbiQueue = new NcbiRequestQueue(350);

export async function fetchNcbiJson(
  url: URL,
  signal: AbortSignal,
): Promise<unknown> {
  return runNcbiRequestWithRetry(
    () =>
      ncbiQueue.schedule(
        () => fetchJsonWithTimeout(url, signal),
        signal,
      ),
    signal,
  );
}

export function runNcbiRequestWithRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return runBoundedRetry(operation, signal, {
    maxAttempts: 3,
    baseBackoffMs: 500,
    maxBackoffMs: 2_000,
    isTransient: isTransientProviderFailure,
    getRetryAfterMs: (error) =>
      error instanceof DictionaryProviderHttpError ? error.retryAfterMs : null,
  });
}

export function isTransientProviderFailure(error: unknown): boolean {
  if (error instanceof DictionaryProviderHttpError) {
    return error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504;
  }
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
}
