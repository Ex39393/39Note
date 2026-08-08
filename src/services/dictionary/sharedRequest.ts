interface SharedRequest<T> {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
}

export interface SharedRequestRegistry<T> {
  request: (
    key: string,
    factory: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ) => Promise<T>;
  size: () => number;
}

export function createSharedRequestRegistry<T>(): SharedRequestRegistry<T> {
  const entries = new Map<string, SharedRequest<T>>();

  return {
    request(key, factory, signal) {
      if (signal.aborted) return Promise.reject(createAbortError(signal.reason));
      let entry = entries.get(key);
      if (!entry) {
        const controller = new AbortController();
        const promise = factory(controller.signal);
        entry = { controller, promise, subscribers: 0 };
        entries.set(key, entry);
        void promise.then(
          () => removeSettledEntry(entries, key, promise),
          () => removeSettledEntry(entries, key, promise),
        );
      }

      entry.subscribers += 1;
      const activeEntry = entry;
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true;
          signal.removeEventListener('abort', handleAbort);
          activeEntry.subscribers = Math.max(0, activeEntry.subscribers - 1);
          return true;
        };
        const handleAbort = () => {
          if (!finish()) return;
          if (activeEntry.subscribers === 0)
            activeEntry.controller.abort(signal.reason);
          reject(createAbortError(signal.reason));
        };
        signal.addEventListener('abort', handleAbort, { once: true });
        void activeEntry.promise.then(
          (value) => {
            if (finish()) resolve(value);
          },
          (error: unknown) => {
            if (finish()) reject(error);
          },
        );
      });
    },
    size: () => entries.size,
  };
}

function removeSettledEntry<T>(
  entries: Map<string, SharedRequest<T>>,
  key: string,
  promise: Promise<T>,
): void {
  if (entries.get(key)?.promise === promise) entries.delete(key);
}

function createAbortError(reason: unknown): DOMException {
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException('Dictionary lookup cancelled.', 'AbortError');
}
