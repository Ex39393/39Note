import {
  PaperRemoteChangedError,
  PaperSnapshotUnstableError,
} from './paperDriveRepository.ts';

export const MAX_SCOPED_DOWNLOAD_ATTEMPTS = 2;

export interface ScopedPaperDownloadRetry {
  attempt: number;
  reason: PaperRemoteChangedError['reason'];
}

/**
 * Downloads one exact document snapshot and refreshes only that document after
 * a genuine snapshot race. Callers apply local state only after this returns.
 */
export async function runScopedPaperDownload<TSnapshot, TResult>(options: {
  documentId: string;
  initialSnapshot: TSnapshot;
  download(snapshot: TSnapshot, attempt: number): Promise<TResult>;
  refresh(error: PaperRemoteChangedError): Promise<TSnapshot | undefined>;
  onRetry?(retry: ScopedPaperDownloadRetry): void;
  maximumAttempts?: number;
}): Promise<TResult> {
  const maximumAttempts = options.maximumAttempts ?? MAX_SCOPED_DOWNLOAD_ATTEMPTS;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
    throw new Error('A scoped paper download needs at least one attempt.');
  }
  let snapshot = options.initialSnapshot;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      return await options.download(snapshot, attempt);
    } catch (error) {
      if (!(error instanceof PaperRemoteChangedError)) throw error;
      if (attempt + 1 >= maximumAttempts) {
        throw new PaperSnapshotUnstableError(options.documentId, { cause: error });
      }
      options.onRetry?.({ attempt: attempt + 1, reason: error.reason });
      let refreshed: TSnapshot | undefined;
      try {
        refreshed = await options.refresh(error);
      } catch (refreshError) {
        if (refreshError instanceof PaperRemoteChangedError) {
          throw new PaperSnapshotUnstableError(options.documentId, {
            cause: refreshError,
          });
        }
        throw refreshError;
      }
      if (refreshed === undefined) {
        throw new PaperSnapshotUnstableError(options.documentId, { cause: error });
      }
      snapshot = refreshed;
    }
  }
  throw new PaperSnapshotUnstableError(options.documentId);
}
