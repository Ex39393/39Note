import type { DocumentLink } from '../types/documentLink.ts';
import type { GlossaryEntry } from '../types/glossary.ts';
import type { PdfAnnotation } from '../types/highlight.ts';
import type { Note } from '../types/note.ts';
import type { NoteAnchor } from '../types/noteAnchor.ts';

export const MAX_READER_HISTORY_DOCUMENTS = 8;
export const MAX_READER_HISTORY_ENTRIES = 100;
export const MAX_READER_HISTORY_BYTES = 1_000_000;
export const READER_TEXT_HISTORY_COALESCE_MS = 1_200;

export interface ReaderEditableState {
  annotations: PdfAnnotation[];
  links: DocumentLink[];
  noteAnchors: NoteAnchor[];
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  nextNoteNumber: number;
  nextLinkNumber: number;
}

type ReaderRecordKind =
  'annotations' | 'links' | 'noteAnchors' | 'notes' | 'glossaryEntries';

interface ReaderRecordByKind {
  annotations: PdfAnnotation;
  links: DocumentLink;
  noteAnchors: NoteAnchor;
  notes: Note;
  glossaryEntries: GlossaryEntry;
}

export interface ReaderRecordDelta<K extends ReaderRecordKind = ReaderRecordKind> {
  kind: K;
  id: string;
  before: ReaderRecordByKind[K] | null;
  after: ReaderRecordByKind[K] | null;
  beforeIndex: number;
  afterIndex: number;
}

export interface ReaderHistoryEntry {
  id: string;
  documentId: string;
  label: string;
  createdAt: number;
  coalesceKey?: string;
  deltas: ReaderRecordDelta[];
  beforeNextNoteNumber: number;
  afterNextNoteNumber: number;
  beforeNextLinkNumber: number;
  afterNextLinkNumber: number;
}

export interface ReaderHistoryApplication {
  entry: ReaderHistoryEntry;
  state: ReaderEditableState;
}

export type ReaderHistoryApplyResult =
  | { ok: true; application: ReaderHistoryApplication }
  | { ok: false; reason: 'stale-state' | 'empty' };

interface DocumentHistory {
  undo: ReaderHistoryEntry[];
  redo: ReaderHistoryEntry[];
  lastUsedAt: number;
}

export function createReaderHistoryEntry(
  documentId: string,
  label: string,
  before: ReaderEditableState,
  after: ReaderEditableState,
  options: { coalesceKey?: string; timestamp?: number; id?: string } = {},
): ReaderHistoryEntry | null {
  const deltas = READER_RECORD_KINDS.flatMap((kind) =>
    diffRecordList(kind, before[kind], after[kind]),
  );
  if (
    deltas.length === 0 &&
    before.nextNoteNumber === after.nextNoteNumber &&
    before.nextLinkNumber === after.nextLinkNumber
  ) {
    return null;
  }
  return {
    id: options.id ?? crypto.randomUUID(),
    documentId,
    label,
    createdAt: options.timestamp ?? Date.now(),
    ...(options.coalesceKey ? { coalesceKey: options.coalesceKey } : {}),
    deltas,
    beforeNextNoteNumber: before.nextNoteNumber,
    afterNextNoteNumber: after.nextNoteNumber,
    beforeNextLinkNumber: before.nextLinkNumber,
    afterNextLinkNumber: after.nextLinkNumber,
  };
}

export function applyReaderHistoryEntry(
  current: ReaderEditableState,
  entry: ReaderHistoryEntry,
  direction: 'undo' | 'redo',
): ReaderHistoryApplyResult {
  for (const delta of entry.deltas) {
    const expected = direction === 'undo' ? delta.after : delta.before;
    const currentRecord = findRecord(current[delta.kind], delta.id);
    if (!sameRecord(currentRecord, expected)) {
      return { ok: false, reason: 'stale-state' };
    }
  }

  const next = cloneEditableState(current);
  for (const kind of READER_RECORD_KINDS) {
    const deltas = entry.deltas.filter((delta) => delta.kind === kind);
    if (!deltas.length) continue;
    const affectedIds = new Set(deltas.map((delta) => delta.id));
    const retained = next[kind].filter(
      (record) => !affectedIds.has(recordId(kind, record)),
    );
    const insertions = deltas
      .flatMap((delta) => {
        const record = direction === 'undo' ? delta.before : delta.after;
        const index = direction === 'undo' ? delta.beforeIndex : delta.afterIndex;
        return record ? [{ index, record: cloneJson(record) }] : [];
      })
      .sort((left, right) => left.index - right.index);
    for (const insertion of insertions) {
      retained.splice(
        Math.min(Math.max(insertion.index, 0), retained.length),
        0,
        insertion.record,
      );
    }
    assignRecordList(next, kind, retained);
  }

  const targetNextNoteNumber =
    direction === 'undo' ? entry.beforeNextNoteNumber : entry.afterNextNoteNumber;
  const targetNextLinkNumber =
    direction === 'undo' ? entry.beforeNextLinkNumber : entry.afterNextLinkNumber;
  next.nextNoteNumber = Math.max(current.nextNoteNumber, targetNextNoteNumber);
  next.nextLinkNumber = Math.max(
    current.nextLinkNumber,
    targetNextLinkNumber,
    ...next.links.map((link) => link.visibleNumber + 1),
  );
  return { ok: true, application: { entry, state: next } };
}

export class ReaderHistoryStore {
  readonly #documents = new Map<string, DocumentHistory>();

  record(entry: ReaderHistoryEntry): void {
    const history = this.#getOrCreate(entry.documentId);
    const previous = history.undo.at(-1);
    if (
      entry.coalesceKey &&
      previous?.coalesceKey === entry.coalesceKey &&
      entry.createdAt >= previous.createdAt &&
      entry.createdAt - previous.createdAt <= READER_TEXT_HISTORY_COALESCE_MS
    ) {
      const merged = mergeHistoryEntries(previous, entry);
      if (historyEntryHasChanges(merged)) {
        history.undo[history.undo.length - 1] = merged;
      } else {
        history.undo.pop();
      }
    } else {
      history.undo.push(cloneJson(entry));
    }
    history.redo = [];
    history.lastUsedAt = entry.createdAt;
    this.#trimDocument(history);
    this.#trimDocuments();
  }

  prepareUndo(
    documentId: string,
    current: ReaderEditableState,
  ): ReaderHistoryApplyResult {
    const history = this.#documents.get(documentId);
    const entry = history?.undo.at(-1);
    if (!history || !entry) return { ok: false, reason: 'empty' };
    history.lastUsedAt = Date.now();
    return applyReaderHistoryEntry(current, entry, 'undo');
  }

  prepareRedo(
    documentId: string,
    current: ReaderEditableState,
  ): ReaderHistoryApplyResult {
    const history = this.#documents.get(documentId);
    const entry = history?.redo.at(-1);
    if (!history || !entry) return { ok: false, reason: 'empty' };
    history.lastUsedAt = Date.now();
    return applyReaderHistoryEntry(current, entry, 'redo');
  }

  commitUndo(documentId: string, entryId: string): boolean {
    const history = this.#documents.get(documentId);
    const entry = history?.undo.at(-1);
    if (!history || entry?.id !== entryId) return false;
    history.undo.pop();
    history.redo.push(entry);
    history.lastUsedAt = Date.now();
    return true;
  }

  commitRedo(documentId: string, entryId: string): boolean {
    const history = this.#documents.get(documentId);
    const entry = history?.redo.at(-1);
    if (!history || entry?.id !== entryId) return false;
    history.redo.pop();
    history.undo.push(entry);
    history.lastUsedAt = Date.now();
    return true;
  }

  breakCoalescing(documentId: string, coalesceKey?: string): void {
    const entry = this.#documents.get(documentId)?.undo.at(-1);
    if (entry && (!coalesceKey || entry.coalesceKey === coalesceKey)) {
      delete entry.coalesceKey;
    }
  }

  clear(documentId: string): void {
    this.#documents.delete(documentId);
  }

  counts(documentId: string): { undo: number; redo: number; bytes: number } {
    const history = this.#documents.get(documentId);
    return history
      ? {
          undo: history.undo.length,
          redo: history.redo.length,
          bytes: historyBytes(history),
        }
      : { undo: 0, redo: 0, bytes: 0 };
  }

  #getOrCreate(documentId: string): DocumentHistory {
    const existing = this.#documents.get(documentId);
    if (existing) return existing;
    const history = { undo: [], redo: [], lastUsedAt: Date.now() };
    this.#documents.set(documentId, history);
    return history;
  }

  #trimDocument(history: DocumentHistory): void {
    while (
      history.undo.length + history.redo.length > MAX_READER_HISTORY_ENTRIES ||
      historyBytes(history) > MAX_READER_HISTORY_BYTES
    ) {
      if (history.undo.length) history.undo.shift();
      else history.redo.shift();
    }
  }

  #trimDocuments(): void {
    if (this.#documents.size <= MAX_READER_HISTORY_DOCUMENTS) return;
    const oldest = [...this.#documents.entries()].sort(
      ([, left], [, right]) => left.lastUsedAt - right.lastUsedAt,
    )[0]?.[0];
    if (oldest) this.#documents.delete(oldest);
  }
}

const READER_RECORD_KINDS: readonly ReaderRecordKind[] = [
  'annotations',
  'links',
  'noteAnchors',
  'notes',
  'glossaryEntries',
];

function diffRecordList<K extends ReaderRecordKind>(
  kind: K,
  before: ReaderRecordByKind[K][],
  after: ReaderRecordByKind[K][],
): ReaderRecordDelta<K>[] {
  const beforeById = new Map(
    before.map((record, index) => [recordId(kind, record), { record, index }]),
  );
  const afterById = new Map(
    after.map((record, index) => [recordId(kind, record), { record, index }]),
  );
  return [...new Set([...beforeById.keys(), ...afterById.keys()])].flatMap((id) => {
    const previous = beforeById.get(id);
    const next = afterById.get(id);
    if (sameRecord(previous?.record ?? null, next?.record ?? null)) return [];
    return [
      {
        kind,
        id,
        before: previous ? cloneJson(previous.record) : null,
        after: next ? cloneJson(next.record) : null,
        beforeIndex: previous?.index ?? -1,
        afterIndex: next?.index ?? -1,
      },
    ];
  });
}

function mergeHistoryEntries(
  first: ReaderHistoryEntry,
  second: ReaderHistoryEntry,
): ReaderHistoryEntry {
  const deltas = new Map<string, ReaderRecordDelta>();
  for (const delta of first.deltas)
    deltas.set(`${delta.kind}:${delta.id}`, cloneJson(delta));
  for (const delta of second.deltas) {
    const key = `${delta.kind}:${delta.id}`;
    const existing = deltas.get(key);
    deltas.set(
      key,
      existing
        ? {
            ...existing,
            after: cloneJson(delta.after),
            afterIndex: delta.afterIndex,
          }
        : cloneJson(delta),
    );
  }
  return {
    ...first,
    createdAt: second.createdAt,
    deltas: [...deltas.values()].filter(
      (delta) => !sameRecord(delta.before, delta.after),
    ),
    afterNextNoteNumber: second.afterNextNoteNumber,
    afterNextLinkNumber: second.afterNextLinkNumber,
  };
}

function cloneEditableState(state: ReaderEditableState): ReaderEditableState {
  return cloneJson(state);
}

function findRecord<K extends ReaderRecordKind>(
  records: ReaderRecordByKind[K][],
  id: string,
): ReaderRecordByKind[K] | null {
  return records.find((record) => recordIdFromUnknown(record) === id) ?? null;
}

function recordId<K extends ReaderRecordKind>(
  kind: K,
  record: ReaderRecordByKind[K],
): string {
  return kind === 'glossaryEntries'
    ? (record as GlossaryEntry).glossaryEntryId
    : recordIdFromUnknown(record);
}

function recordIdFromUnknown(record: unknown): string {
  if (!record || typeof record !== 'object') return '';
  const id =
    (record as { id?: unknown; glossaryEntryId?: unknown }).id ??
    (record as { glossaryEntryId?: unknown }).glossaryEntryId;
  return typeof id === 'string' ? id : '';
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assignRecordList<K extends ReaderRecordKind>(
  state: ReaderEditableState,
  kind: K,
  records: ReaderRecordByKind[K][],
): void {
  (state[kind] as ReaderRecordByKind[K][]) = records;
}

function historyBytes(history: DocumentHistory): number {
  return JSON.stringify([history.undo, history.redo]).length * 2;
}

function historyEntryHasChanges(entry: ReaderHistoryEntry): boolean {
  return (
    entry.deltas.length > 0 ||
    entry.beforeNextNoteNumber !== entry.afterNextNoteNumber ||
    entry.beforeNextLinkNumber !== entry.afterNextLinkNumber
  );
}
