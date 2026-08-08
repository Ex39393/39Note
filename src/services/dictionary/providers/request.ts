export async function fetchJsonWithTimeout(
  url: URL,
  signal: AbortSignal,
  timeoutMs = 6_000,
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () =>
      controller.abort(
        new DOMException('Dictionary request timed out.', 'TimeoutError'),
      ),
    timeoutMs,
  );

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Dictionary provider request failed (${response.status}).`);
    }
    return (await response.json()) as unknown;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromCaller);
  }
}
