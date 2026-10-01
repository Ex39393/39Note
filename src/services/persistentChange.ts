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

type PersistentChangeListener = (detail: PersistentChangeDetail) => void;
type PersistenceFlusher = () => Promise<unknown> | unknown;

const listeners = new Set<PersistentChangeListener>();
const flushers = new Map<string, PersistenceFlusher>();

export function notifyPersistentChange(detail: PersistentChangeDetail): void {
  for (const listener of listeners) listener(detail);
}

export function notifyLocalRemovalLifecycle(
  documentId: string,
  localRemoval: NonNullable<PersistentChangeDetail['localRemoval']>,
): void {
  notifyPersistentChange({ kind: 'document', documentId, localRemoval });
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

export async function flushLocalPersistence(): Promise<void> {
  await Promise.all([...flushers.values()].map((flusher) => flusher()));
}
