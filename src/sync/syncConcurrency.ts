export const PAPER_METADATA_CONCURRENCY = 4;
export const PAPER_TRANSFER_CONCURRENCY = 2;
/** Shared cap for manifest, payload, and source-PDF media reads in one repository. */
export const PAPER_MEDIA_CONCURRENCY = 4;

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer.');
  }
  if (values.length === 0) return [];

  const output = new Array<R>(values.length);
  let nextIndex = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  if (failure !== undefined) throw failure;
  return output;
}

export type IndependentOperationSettlement<T, R> =
  | { input: T; status: 'fulfilled'; value: R }
  | { input: T; status: 'rejected'; error: unknown };

/** Runs every bounded operation and captures failures instead of short-circuiting. */
export async function settleIndependentOperations<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<IndependentOperationSettlement<T, R>[]> {
  let completed = 0;
  return mapWithConcurrency(
    values,
    limit,
    async (input): Promise<IndependentOperationSettlement<T, R>> => {
      try {
        return { input, status: 'fulfilled', value: await operation(input) };
      } catch (error) {
        return { input, status: 'rejected', error };
      } finally {
        completed += 1;
        onProgress?.(completed, values.length);
      }
    },
  );
}

export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Concurrency limit must be a positive integer.');
    }
    this.limit = limit;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

export class KeyedSingleFlight<V, K = string> {
  private readonly active = new Map<K, Promise<V>>();

  run(key: K, operation: () => Promise<V>): Promise<V> {
    const existing = this.active.get(key);
    if (existing) return existing;
    const run = operation();
    const tracked = run.finally(() => {
      if (this.active.get(key) === tracked) this.active.delete(key);
    });
    this.active.set(key, tracked);
    return tracked;
  }

  has(key: K): boolean {
    return this.active.has(key);
  }

  get size(): number {
    return this.active.size;
  }
}
