export class DictionaryProviderHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super(`Dictionary provider request failed (${status}).`);
    this.name = 'DictionaryProviderHttpError';
  }
}

export async function fetchJsonWithTimeout(
  url: URL,
  signal: AbortSignal,
  timeoutMs = 6_000,
  headers: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = globalThis.setTimeout(
    () =>
      controller.abort(
        new DOMException('Dictionary request timed out.', 'TimeoutError'),
      ),
    timeoutMs,
  );

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new DictionaryProviderHttpError(
        response.status,
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }
    return (await response.json()) as unknown;
  } finally {
    globalThis.clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromCaller);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
