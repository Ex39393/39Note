export type PersistentChangeKind =
  'document' | 'document-source' | 'pdf' | 'library' | 'productivity' | 'ai-settings';

/** User-facing, paper-scoped reasons that a durable local record changed. */
export type PersistentChangeCategory =
  | 'metadata'
  | 'notes'
  | 'annotations'
  | 'glossary'
  | 'reading-state'
  | 'source-pdf'
  | 'source-document'
  | 'print-draft'
  | 'rendered-print-pdf'
  | 'deleted'
  | 'ai-conversation';

export interface PersistentChangeDetail {
  kind: PersistentChangeKind;
  documentId?: string;
  /** Used when one library operation changes more than one paper. */
  documentIds?: string[];
  categories?: PersistentChangeCategory[];
  /** Explicit lifecycle for a user-requested local-only paper removal. */
  localRemoval?: 'started' | 'committed' | 'aborted';
}

type PersistentChangeListener = (
  detail: PersistentChangeDetail,
  workspaceLease?: WorkspaceRestoreLease,
) => Promise<void> | void;
type PersistenceFlusher = () => Promise<boolean> | boolean;

const listeners = new Set<PersistentChangeListener>();
const flushers = new Map<string, PersistenceFlusher>();
let persistenceFlushQueue: Promise<void> = Promise.resolve();

export class PersistenceFlushError extends Error {
  constructor() {
    super('One or more pending local changes could not be saved.');
    this.name = 'PersistenceFlushError';
  }
}

export function notifyPersistentChange(detail: PersistentChangeDetail): void {
  for (const listener of listeners) void listener(detail);
}

/**
 * Settles every persistence side effect while the originating logical writer
 * still owns its workspace lease. This closes the document/productivity → sync
 * metadata gap without reacquiring a nested shared Web Lock.
 */
export async function dispatchPersistentChange(
  detail: PersistentChangeDetail,
  workspaceLease: WorkspaceRestoreLease,
): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(detail, workspaceLease)));
}

export function notifyLocalRemovalLifecycle(
  documentId: string,
  localRemoval: NonNullable<PersistentChangeDetail['localRemoval']>,
): void {
  notifyPersistentChange({ kind: 'document', documentId, localRemoval });
}

export function dispatchLocalRemovalLifecycle(
  documentId: string,
  localRemoval: NonNullable<PersistentChangeDetail['localRemoval']>,
  workspaceLease: WorkspaceRestoreLease,
): Promise<void> {
  return dispatchPersistentChange(
    { kind: 'document', documentId, localRemoval },
    workspaceLease,
  );
}

export function subscribeToPersistentChanges(
  listener: PersistentChangeListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerPersistenceFlusher(
  id: string,
  flusher: PersistenceFlusher,
): () => void {
  flushers.set(id, flusher);
  return () => {
    if (flushers.get(id) === flusher) flushers.delete(id);
  };
}

export function flushLocalPersistence(): Promise<void> {
  const registeredFlushers = [...flushers.values()];
  const flush = async () => {
    const results = await Promise.allSettled(
      registeredFlushers.map(async (flusher) => {
        if ((await flusher()) !== true) throw new PersistenceFlushError();
      }),
    );
    if (results.some((result) => result.status === 'rejected')) {
      throw new PersistenceFlushError();
    }
  };
  const operation = persistenceFlushQueue.then(flush);
  persistenceFlushQueue = operation.catch(() => undefined);
  return operation;
}
import type { WorkspaceRestoreLease } from './workspaceRestoreLock.ts';
