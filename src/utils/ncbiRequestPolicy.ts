export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  isTransient: (error: unknown) => boolean;
  getRetryAfterMs?: (error: unknown) => number | null;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface QueueEntry<T> {
  operation: () => Promise<T>;
  signal: AbortSignal;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class NcbiRequestQueue {
  private entries: QueueEntry<unknown>[] = [];
  private isDraining = false;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly minimumIntervalMs: number;
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(
    minimumIntervalMs = 350,
    now: () => number = Date.now,
    delay: (milliseconds: number, signal: AbortSignal) => Promise<void> = abortableDelay,
  ) {
    this.minimumIntervalMs = minimumIntervalMs;
    this.now = now;
    this.delay = delay;
  }

  schedule<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(createAbortError(signal.reason));
    return new Promise<T>((resolve, reject) => {
      this.entries.push({ operation, signal, resolve, reject } as QueueEntry<unknown>);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;
    try {
      while (this.entries.length > 0) {
        const entry = this.entries.shift();
        if (!entry) continue;
        if (entry.signal.aborted) {
          entry.reject(createAbortError(entry.signal.reason));
          continue;
        }
        const waitMs = Math.max(
          0,
          this.lastStartedAt + this.minimumIntervalMs - this.now(),
        );
        try {
          if (waitMs > 0) await this.delay(waitMs, entry.signal);
          if (entry.signal.aborted) throw createAbortError(entry.signal.reason);
          this.lastStartedAt = this.now();
          entry.resolve(await entry.operation());
        } catch (error) {
          entry.reject(error);
        }
      }
    } finally {
      this.isDraining = false;
      if (this.entries.length > 0) void this.drain();
    }
  }
}

export async function runBoundedRetry<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  options: RetryPolicyOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const maxBackoffMs = options.maxBackoffMs ?? 2_000;
  const delay = options.delay ?? abortableDelay;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const retryAfter = options.getRetryAfterMs?.(lastError) ?? 0;
      await delay(
        Math.min(
          maxBackoffMs,
          Math.max(retryAfter, baseBackoffMs * 2 ** (attempt - 1)),
        ),
        signal,
      );
    }
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      lastError = error;
      if (!options.isTransient(error) || attempt === maxAttempts - 1) throw error;
    }
  }
  throw lastError;
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError(signal.reason));
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(createAbortError(signal.reason));
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createAbortError(reason?: unknown): DOMException {
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException('Dictionary request was cancelled.', 'AbortError');
}
