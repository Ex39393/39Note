import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  highlightColors,
  underlineColors,
  type HighlightColor,
  type PdfAnnotation,
  type UnderlineColor,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { DocumentIdentity } from '../types/persistence';
import type {
  CollectionRecord,
  DocumentLibraryMetadata,
  ReadingPosition,
  TagRecord,
} from '../types/library';
import { isValidDocumentId } from '../utils/documentId';

const DATABASE_NAME = '39note-db';
const DATABASE_VERSION = 3;
const DOCUMENT_STATE_STORE = 'document-states';
const PDF_FILE_STORE = 'pdf-files';
const COLLECTION_STORE = 'collections';
const TAG_STORE = 'tags';
export const PERSISTENCE_SCHEMA_VERSION = 5;
const LEGACY_SCHEMA_VERSION = 1;
const PREVIOUS_SCHEMA_VERSION = 2;
const HIGHLIGHT_NOTE_SCHEMA_VERSION = 3;
const DOCUMENT_METADATA_SCHEMA_VERSION = 4;

export interface PersistedDocumentState extends DocumentIdentity, DocumentLibraryMetadata {
  schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  originalFileName: string;
  displayTitle: string;
  annotations: PdfAnnotation[];
  notes: Note[];
  nextNoteNumber: number;
  updatedAt: number;
}

export interface LibraryDocument {
  documentId: string;
  originalFileName: string;
  displayTitle: string;
  highlightCount: number;
  underlineCount: number;
  noteCount: number;
  notes: LibraryDocumentNote[];
  updatedAt: number;
  hasStoredPdf: boolean;
  pdfSize: number | null;
  collectionIds: string[];
  tagIds: string[];
  isPinned: boolean;
  pinnedAt?: number;
  lastReadAt?: number;
  readingPosition?: ReadingPosition;
}

export interface LibraryDocumentNote {
  id: string;
  annotationId: string;
  displayNumber: string;
  content: string;
  pageNumber: number;
  selectedText: string;
}

export interface StoredPdfFile {
  documentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  blob: Blob;
  storedAt: number;
}

export interface BackupDocumentData {
  state: PersistedDocumentState;
  pdf: StoredPdfFile | null;
}

export interface LibraryStorageSummary {
  documentCount: number;
  storedPdfCount: number;
  storedPdfBytes: number;
  annotationCount: number;
  noteCount: number;
  estimatedUsageBytes: number | null;
  estimatedQuotaBytes: number | null;
}

interface AnnotationDatabase extends DBSchema {
  [DOCUMENT_STATE_STORE]: {
    key: string;
    value: PersistedDocumentState;
  };
  [PDF_FILE_STORE]: {
    key: string;
    value: StoredPdfFile;
  };
  [COLLECTION_STORE]: {
    key: string;
    value: CollectionRecord;
  };
  [TAG_STORE]: {
    key: string;
    value: TagRecord;
  };
}

let databasePromise: Promise<IDBPDatabase<AnnotationDatabase>> | null = null;
let hasReportedPersistenceError = false;

export async function loadDocumentState(
  documentId: string,
): Promise<PersistedDocumentState | null> {
  if (!isValidDocumentId(documentId)) {
    return null;
  }

  try {
    const database = await getDatabase();
    if (!database) {
      return null;
    }

    return sanitizeDocumentState(await database.get(DOCUMENT_STATE_STORE, documentId), documentId);
  } catch (error) {
    reportPersistenceError('read', error);
    return null;
  }
}

export async function listLibraryDocuments(): Promise<LibraryDocument[]> {
  try {
    const database = await getDatabase();
    if (!database) {
      return [];
    }

    const transaction = database.transaction([DOCUMENT_STATE_STORE, PDF_FILE_STORE], 'readonly');
    const [documentStates, storedPdfFiles] = await Promise.all([
      transaction.objectStore(DOCUMENT_STATE_STORE).getAll(),
      transaction.objectStore(PDF_FILE_STORE).getAll(),
    ]);
    await transaction.done;
    const storedPdfsByDocumentId = new Map(
      storedPdfFiles.flatMap((file) => {
        if (!isRecord(file) || typeof file.documentId !== 'string') {
          return [];
        }
        const sanitizedFile = sanitizeStoredPdfFile(file, file.documentId);
        return sanitizedFile ? [[sanitizedFile.documentId, sanitizedFile] as const] : [];
      }),
    );

    return documentStates
      .flatMap((state) => {
        if (!isRecord(state) || typeof state.documentId !== 'string') {
          return [];
        }

        const sanitizedState = sanitizeDocumentState(state, state.documentId);
        if (!sanitizedState) {
          return [];
        }

        return [{
          documentId: sanitizedState.documentId,
          originalFileName: sanitizedState.originalFileName,
          displayTitle: sanitizedState.displayTitle,
          highlightCount: sanitizedState.annotations.filter((annotation) => annotation.type === 'highlight').length,
          underlineCount: sanitizedState.annotations.filter((annotation) => annotation.type === 'underline').length,
          noteCount: sanitizedState.notes.length,
          notes: sanitizedState.notes.map((note) => ({
            id: note.id,
            annotationId: note.annotationId,
            displayNumber: note.displayNumber,
            content: note.content,
            pageNumber: note.pageNumber,
            selectedText: note.selectedText,
          })),
          updatedAt: sanitizedState.updatedAt,
          hasStoredPdf: storedPdfsByDocumentId.has(sanitizedState.documentId),
          pdfSize: storedPdfsByDocumentId.get(sanitizedState.documentId)?.size ?? null,
          collectionIds: sanitizedState.collectionIds,
          tagIds: sanitizedState.tagIds,
          isPinned: sanitizedState.isPinned,
          pinnedAt: sanitizedState.pinnedAt,
          lastReadAt: sanitizedState.lastReadAt,
          readingPosition: sanitizedState.readingPosition,
        }];
      })
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch (error) {
    reportPersistenceError('library read', error);
    return [];
  }
}

export async function getLibraryStorageSummary(): Promise<LibraryStorageSummary> {
  const documents = await getBackupDocumentData();
  const summary = documents.reduce<LibraryStorageSummary>((currentSummary, { state, pdf }) => ({
    documentCount: currentSummary.documentCount + 1,
    storedPdfCount: currentSummary.storedPdfCount + (pdf ? 1 : 0),
    storedPdfBytes: currentSummary.storedPdfBytes + (pdf?.size ?? 0),
    annotationCount: currentSummary.annotationCount + state.annotations.length,
    noteCount: currentSummary.noteCount + state.notes.length,
    estimatedUsageBytes: currentSummary.estimatedUsageBytes,
    estimatedQuotaBytes: currentSummary.estimatedQuotaBytes,
  }), {
    documentCount: 0,
    storedPdfCount: 0,
    storedPdfBytes: 0,
    annotationCount: 0,
    noteCount: 0,
    estimatedUsageBytes: null,
    estimatedQuotaBytes: null,
  });

  try {
    const estimate = typeof navigator !== 'undefined' && navigator.storage?.estimate
      ? await navigator.storage.estimate()
      : null;
    return {
      ...summary,
      estimatedUsageBytes: estimate?.usage ?? null,
      estimatedQuotaBytes: estimate?.quota ?? null,
    };
  } catch {
    return summary;
  }
}

export async function getBackupDocumentData(documentIds?: readonly string[]): Promise<BackupDocumentData[]> {
  try {
    const database = await getDatabase();
    if (!database) {
      return [];
    }

    const requestedIds = documentIds ? new Set(documentIds) : null;
    const states = (await database.getAll(DOCUMENT_STATE_STORE)).filter(
      (state) => !requestedIds || requestedIds.has(state.documentId),
    );
    return (await Promise.all(states.map(async (state) => {
      const sanitizedState = sanitizeDocumentState(state, state.documentId);
      if (!sanitizedState) {
        return null;
      }
      const pdf = sanitizeStoredPdfFile(
        await database.get(PDF_FILE_STORE, sanitizedState.documentId),
        sanitizedState.documentId,
      );
      return { state: sanitizedState, pdf };
    }))).flatMap((entry) => entry ? [entry] : []);
  } catch (error) {
    reportPersistenceError('backup read', error);
    return [];
  }
}

export async function removeStoredPdfCopy(documentId: string): Promise<boolean> {
  try {
    const database = await getDatabase();
    if (!database || !await database.get(DOCUMENT_STATE_STORE, documentId)) {
      return false;
    }
    await database.delete(PDF_FILE_STORE, documentId);
    return true;
  } catch (error) {
    reportPersistenceError('PDF copy removal', error);
    return false;
  }
}

export async function restoreBackupDocument(
  rawState: unknown,
  rawPdf: StoredPdfFile | null,
  replaceExisting: boolean,
): Promise<boolean> {
  if (!isRecord(rawState) || typeof rawState.documentId !== 'string') {
    return false;
  }
  const state = sanitizeDocumentState(rawState, rawState.documentId);
  if (!state || (rawPdf && !sanitizeStoredPdfFile(rawPdf, state.documentId))) {
    return false;
  }
  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }
    const transaction = database.transaction([DOCUMENT_STATE_STORE, PDF_FILE_STORE], 'readwrite');
    const states = transaction.objectStore(DOCUMENT_STATE_STORE);
    const pdfs = transaction.objectStore(PDF_FILE_STORE);
    const existing = await states.get(state.documentId);
    if (existing && !replaceExisting) {
      await transaction.done;
      return true;
    }
    await states.put(state);
    if (rawPdf) {
      await pdfs.put(rawPdf);
    } else if (replaceExisting) {
      await pdfs.delete(state.documentId);
    }
    await transaction.done;
    return true;
  } catch (error) {
    reportPersistenceError('backup restore', error);
    return false;
  }
}

export function validateBackupDocumentState(value: unknown): PersistedDocumentState | null {
  if (!isRecord(value) || !isValidDocumentId(value.documentId)) {
    return null;
  }

  if (
    !Array.isArray(value.annotations) ||
    !Array.isArray(value.notes) ||
    value.annotations.some((annotation) => (
      !isRecord(annotation) ||
      (annotation.type !== 'highlight' && annotation.type !== 'underline')
    ))
  ) {
    return null;
  }

  const state = sanitizeDocumentState(value, value.documentId);
  if (
    !state ||
    state.annotations.length !== value.annotations.length ||
    state.notes.length !== value.notes.length ||
    !isSafeBackupFilename(state.originalFileName)
  ) {
    return null;
  }

  return state;
}

export async function deleteDocumentState(documentId: string): Promise<boolean> {
  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const transaction = database.transaction([DOCUMENT_STATE_STORE, PDF_FILE_STORE], 'readwrite');
    await Promise.all([
      transaction.objectStore(DOCUMENT_STATE_STORE).delete(documentId),
      transaction.objectStore(PDF_FILE_STORE).delete(documentId),
    ]);
    await transaction.done;
    return true;
  } catch (error) {
    reportPersistenceError('delete', error);
    return false;
  }
}

export async function deleteDocumentStates(documentIds: string[]): Promise<{ deleted: string[]; failed: string[] }> {
  const uniqueIds = [...new Set(documentIds.filter(isValidDocumentId))];
  if (uniqueIds.length === 0) return { deleted: [], failed: [] };
  try {
    const database = await getDatabase();
    if (!database) return { deleted: [], failed: uniqueIds };
    const transaction = database.transaction([DOCUMENT_STATE_STORE, PDF_FILE_STORE], 'readwrite');
    const states = transaction.objectStore(DOCUMENT_STATE_STORE);
    const pdfs = transaction.objectStore(PDF_FILE_STORE);
    for (const documentId of uniqueIds) {
      await states.delete(documentId);
      await pdfs.delete(documentId);
    }
    await transaction.done;
    return { deleted: uniqueIds, failed: [] };
  } catch (error) {
    reportPersistenceError('batch delete', error);
    return { deleted: [], failed: uniqueIds };
  }
}

export async function storePdfFile(identity: DocumentIdentity, file: File): Promise<boolean> {
  if (!isValidDocumentId(identity.documentId)) {
    return false;
  }

  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const transaction = database.transaction([DOCUMENT_STATE_STORE, PDF_FILE_STORE], 'readwrite');
    const pdfFiles = transaction.objectStore(PDF_FILE_STORE);
    const existingFile = await pdfFiles.get(identity.documentId);

    if (!existingFile) {
      await pdfFiles.put({
        documentId: identity.documentId,
        fileName: file.name,
        mimeType: file.type || 'application/pdf',
        size: file.size,
        lastModified: file.lastModified,
        blob: file,
        storedAt: Date.now(),
      });
    }

    const documentStates = transaction.objectStore(DOCUMENT_STATE_STORE);
    const existingDocumentState = await documentStates.get(identity.documentId);
    if (!existingDocumentState) {
      await documentStates.put(createEmptyDocumentState(identity));
    }

    await transaction.done;
    return true;
  } catch (error) {
    reportPersistenceError('PDF file write', error);
    return false;
  }
}

export async function loadStoredPdfFile(documentId: string): Promise<StoredPdfFile | null> {
  try {
    const database = await getDatabase();
    if (!database) {
      return null;
    }

    const storedFile = await database.get(PDF_FILE_STORE, documentId);
    return sanitizeStoredPdfFile(storedFile, documentId);
  } catch (error) {
    reportPersistenceError('PDF file read', error);
    return null;
  }
}

export async function updateDocumentDisplayTitle(
  documentId: string,
  displayTitle: string,
): Promise<boolean> {
  const normalizedTitle = displayTitle.trim();
  if (!isValidDocumentId(documentId) || normalizedTitle.length === 0) {
    return false;
  }

  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const existingState = await database.get(DOCUMENT_STATE_STORE, documentId);
    const sanitizedState = sanitizeDocumentState(existingState, documentId);
    if (!sanitizedState) {
      return false;
    }

    await database.put(DOCUMENT_STATE_STORE, {
      ...sanitizedState,
      displayTitle: normalizedTitle,
      updatedAt: Date.now(),
    });
    return true;
  } catch (error) {
    reportPersistenceError('title update', error);
    return false;
  }
}

export async function saveReadingPosition(
  documentId: string,
  readingPosition: ReadingPosition,
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  try {
    const database = await getDatabase();
    if (!database) return false;
    const existing = sanitizeDocumentState(await database.get(DOCUMENT_STATE_STORE, documentId), documentId);
    if (!existing) return false;
    await database.put(DOCUMENT_STATE_STORE, {
      ...existing,
      readingPosition,
      lastReadAt: Date.now(),
    });
    return true;
  } catch (error) {
    reportPersistenceError('reading position write', error);
    return false;
  }
}

export async function listCollections(): Promise<CollectionRecord[]> {
  const database = await getDatabase();
  return database ? (await database.getAll(COLLECTION_STORE)).sort((a, b) => a.name.localeCompare(b.name)) : [];
}

export async function listTags(): Promise<TagRecord[]> {
  const database = await getDatabase();
  return database ? (await database.getAll(TAG_STORE)).sort((a, b) => a.name.localeCompare(b.name)) : [];
}

export async function restoreLibraryEntities(collections: CollectionRecord[], tags: TagRecord[]): Promise<boolean> {
  const database = await getDatabase();
  if (!database) return false;
  const transaction = database.transaction([COLLECTION_STORE, TAG_STORE], 'readwrite');
  for (const collection of collections) {
    const existing = await transaction.objectStore(COLLECTION_STORE).get(collection.id);
    if (!existing) await transaction.objectStore(COLLECTION_STORE).put(collection);
  }
  for (const tag of tags) {
    const existing = await transaction.objectStore(TAG_STORE).get(tag.id);
    if (!existing) await transaction.objectStore(TAG_STORE).put(tag);
  }
  await transaction.done;
  return true;
}

export async function createCollection(name: string): Promise<CollectionRecord | null> {
  return createNamedRecord(COLLECTION_STORE, name);
}

export async function createTag(name: string): Promise<TagRecord | null> {
  return createNamedRecord(TAG_STORE, name);
}

export async function renameCollection(id: string, name: string): Promise<boolean> { return renameNamedRecord(COLLECTION_STORE, id, name); }
export async function renameTag(id: string, name: string): Promise<boolean> { return renameNamedRecord(TAG_STORE, id, name); }

export async function deleteCollection(id: string): Promise<boolean> { return deleteNamedRecord(COLLECTION_STORE, id, 'collectionIds'); }
export async function deleteTag(id: string): Promise<boolean> { return deleteNamedRecord(TAG_STORE, id, 'tagIds'); }

export async function updateDocumentOrganization(
  documentIds: string[],
  update: Partial<Pick<DocumentLibraryMetadata, 'collectionIds' | 'tagIds' | 'isPinned' | 'pinnedAt'>>,
): Promise<boolean> {
  const database = await getDatabase();
  if (!database) return false;
  const transaction = database.transaction(DOCUMENT_STATE_STORE, 'readwrite');
  const store = transaction.objectStore(DOCUMENT_STATE_STORE);
  for (const documentId of documentIds) {
    const state = sanitizeDocumentState(await store.get(documentId), documentId);
    if (!state) continue;
    await store.put({ ...state, ...update, updatedAt: Date.now() });
  }
  await transaction.done;
  return true;
}

async function createNamedRecord<T extends CollectionRecord | TagRecord>(
  storeName: typeof COLLECTION_STORE | typeof TAG_STORE,
  name: string,
): Promise<T | null> {
  const normalizedName = normalizeLibraryEntityName(name);
  if (!normalizedName) return null;
  const database = await getDatabase();
  if (!database) return null;
  const existing = await database.getAll(storeName);
  const match = existing.find((item) => item.normalizedName === normalizedName);
  if (match) return match as T;
  const timestamp = Date.now();
  const record = { id: crypto.randomUUID(), name: name.trim(), normalizedName, createdAt: timestamp, updatedAt: timestamp } as T;
  await database.put(storeName, record);
  return record;
}

async function renameNamedRecord(storeName: typeof COLLECTION_STORE | typeof TAG_STORE, id: string, name: string): Promise<boolean> {
  const normalizedName = normalizeLibraryEntityName(name);
  const database = await getDatabase();
  if (!database || !normalizedName) return false;
  const records = await database.getAll(storeName);
  if (records.some((record) => record.id !== id && record.normalizedName === normalizedName)) return false;
  const existing = await database.get(storeName, id);
  if (!existing) return false;
  await database.put(storeName, { ...existing, name: name.trim(), normalizedName, updatedAt: Date.now() });
  return true;
}

async function deleteNamedRecord(
  storeName: typeof COLLECTION_STORE | typeof TAG_STORE,
  id: string,
  field: 'collectionIds' | 'tagIds',
): Promise<boolean> {
  const database = await getDatabase();
  if (!database) return false;
  const transaction = database.transaction([storeName, DOCUMENT_STATE_STORE], 'readwrite');
  await transaction.objectStore(storeName).delete(id);
  const states = await transaction.objectStore(DOCUMENT_STATE_STORE).getAll();
  for (const rawState of states) {
    const state = sanitizeDocumentState(rawState, rawState.documentId);
    if (!state || !state[field].includes(id)) continue;
    await transaction.objectStore(DOCUMENT_STATE_STORE).put({ ...state, [field]: state[field].filter((value) => value !== id), updatedAt: Date.now() });
  }
  await transaction.done;
  return true;
}

export async function saveDocumentState(
  identity: DocumentIdentity,
  annotations: PdfAnnotation[],
  notes: Note[],
  nextNoteNumber: number,
  displayTitle: string,
): Promise<boolean> {
  if (!isValidDocumentId(identity.documentId)) {
    return false;
  }

  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const sanitizedAnnotations = sanitizeAnnotations(annotations);
    const sanitizedNotes = sanitizeNotes(notes, sanitizedAnnotations);
    const existingState = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, identity.documentId),
      identity.documentId,
    );

    await database.put(DOCUMENT_STATE_STORE, {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      documentId: identity.documentId,
      documentName: identity.documentName,
      originalFileName: identity.documentName,
      displayTitle: normalizeDisplayTitle(displayTitle, identity.documentName),
      annotations: sanitizedAnnotations,
      notes: sanitizedNotes,
      nextNoteNumber: normalizeNextNoteNumber(nextNoteNumber, sanitizedNotes),
      updatedAt: Date.now(),
      ...(existingState ? getDocumentLibraryMetadata(existingState) : createEmptyLibraryMetadata()),
    });
    return true;
  } catch (error) {
    reportPersistenceError('write', error);
    return false;
  }
}

async function getDatabase(): Promise<IDBPDatabase<AnnotationDatabase> | null> {
  if (typeof indexedDB === 'undefined') {
    reportPersistenceError('initialization', new Error('IndexedDB is unavailable.'));
    return null;
  }

  if (!databasePromise) {
    databasePromise = openDB<AnnotationDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(DOCUMENT_STATE_STORE)) {
          database.createObjectStore(DOCUMENT_STATE_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(PDF_FILE_STORE)) {
          database.createObjectStore(PDF_FILE_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(COLLECTION_STORE)) {
          database.createObjectStore(COLLECTION_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(TAG_STORE)) {
          database.createObjectStore(TAG_STORE, { keyPath: 'id' });
        }
      },
    });
  }

  return databasePromise;
}

function createEmptyDocumentState(identity: DocumentIdentity): PersistedDocumentState {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentId: identity.documentId,
    documentName: identity.documentName,
    originalFileName: identity.documentName,
    displayTitle: identity.documentName,
    annotations: [],
    notes: [],
    nextNoteNumber: 1,
    updatedAt: Date.now(),
    collectionIds: [],
    tagIds: [],
    isPinned: false,
  };
}

function sanitizeStoredPdfFile(value: unknown, expectedDocumentId: string): StoredPdfFile | null {
  if (
    !isRecord(value) ||
    !isValidDocumentId(expectedDocumentId) ||
    value.documentId !== expectedDocumentId ||
    typeof value.fileName !== 'string' ||
    typeof value.mimeType !== 'string' ||
    !isPositiveIntegerOrZero(value.size) ||
    !isTimestamp(value.lastModified) ||
    !isTimestamp(value.storedAt) ||
    !(value.blob instanceof Blob)
  ) {
    return null;
  }

  return {
    documentId: value.documentId,
    fileName: value.fileName,
    mimeType: value.mimeType,
    size: value.size,
    lastModified: value.lastModified,
    blob: value.blob,
    storedAt: value.storedAt,
  };
}

function sanitizeDocumentState(
  value: unknown,
  expectedDocumentId: string,
): PersistedDocumentState | null {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION &&
      value.schemaVersion !== HIGHLIGHT_NOTE_SCHEMA_VERSION &&
      value.schemaVersion !== DOCUMENT_METADATA_SCHEMA_VERSION &&
      value.schemaVersion !== PREVIOUS_SCHEMA_VERSION &&
      value.schemaVersion !== LEGACY_SCHEMA_VERSION)
  ) {
    return null;
  }

  if (
    !isValidDocumentId(expectedDocumentId) ||
    value.documentId !== expectedDocumentId ||
    typeof value.documentName !== 'string'
  ) {
    return null;
  }

  const annotations = sanitizeAnnotations(value.annotations ?? value.highlights);
  const notes = sanitizeNotes(value.notes, annotations);
  const originalFileName = isNonEmptyString(value.originalFileName)
    ? value.originalFileName
    : value.documentName;

  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentId: value.documentId,
    documentName: value.documentName,
    originalFileName,
    displayTitle: normalizeDisplayTitle(value.displayTitle, originalFileName),
    annotations,
    notes,
    nextNoteNumber: normalizeNextNoteNumber(value.nextNoteNumber, notes),
    updatedAt: isTimestamp(value.updatedAt) ? value.updatedAt : 0,
    ...sanitizeDocumentLibraryMetadata(value),
  };
}

function sanitizeDocumentLibraryMetadata(value: Record<string, unknown>): DocumentLibraryMetadata {
  const collectionIds = sanitizeIdList(value.collectionIds);
  const tagIds = sanitizeIdList(value.tagIds);
  const isPinned = value.isPinned === true;
  const pinnedAt = isPinned && isTimestamp(value.pinnedAt) ? value.pinnedAt : undefined;
  const lastReadAt = isTimestamp(value.lastReadAt) ? value.lastReadAt : undefined;
  const readingPosition = sanitizeReadingPosition(value.readingPosition);

  return {
    collectionIds,
    tagIds,
    isPinned,
    ...(pinnedAt ? { pinnedAt } : {}),
    ...(lastReadAt ? { lastReadAt } : {}),
    ...(readingPosition ? { readingPosition } : {}),
  };
}

function getDocumentLibraryMetadata(state: PersistedDocumentState): DocumentLibraryMetadata {
  return {
    collectionIds: state.collectionIds,
    tagIds: state.tagIds,
    isPinned: state.isPinned,
    ...(state.pinnedAt ? { pinnedAt: state.pinnedAt } : {}),
    ...(state.lastReadAt ? { lastReadAt: state.lastReadAt } : {}),
    ...(state.readingPosition ? { readingPosition: state.readingPosition } : {}),
  };
}

function createEmptyLibraryMetadata(): DocumentLibraryMetadata {
  return { collectionIds: [], tagIds: [], isPinned: false };
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((candidate): candidate is string => (
    typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 128
  )))];
}

function sanitizeReadingPosition(value: unknown): ReadingPosition | undefined {
  if (!isRecord(value) || !isPositiveInteger(value.pageNumber) || !isTimestamp(value.updatedAt)) {
    return undefined;
  }
  if (
    !isFiniteNumber(value.pageOffsetRatio) ||
    value.pageOffsetRatio < 0 ||
    value.pageOffsetRatio > 1 ||
    (value.zoomMode !== 'custom' && value.zoomMode !== 'fit-width' && value.zoomMode !== 'fit-page') ||
    !isFiniteNumber(value.zoomPercent) ||
    value.zoomPercent < 0.25 ||
    value.zoomPercent > 5
  ) {
    return undefined;
  }
  return {
    pageNumber: value.pageNumber,
    pageOffsetRatio: value.pageOffsetRatio,
    zoomMode: value.zoomMode,
    zoomPercent: value.zoomPercent,
    updatedAt: value.updatedAt,
  };
}

function sanitizeAnnotations(value: unknown): PdfAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || !isNonEmptyString(candidate.id) || seenIds.has(candidate.id)) {
      return [];
    }

    const type = candidate.type === 'underline' ? 'underline' : 'highlight';
    if (
      !isPositiveInteger(candidate.pageNumber) ||
      typeof candidate.text !== 'string' ||
      !isTimestamp(candidate.createdAt) ||
      !isTimestamp(candidate.updatedAt)
    ) {
      return [];
    }

    const rects = sanitizeRectangles(candidate.rects);
    if (rects.length === 0) {
      return [];
    }

    if (type === 'highlight' && !isHighlightColor(candidate.color)) {
      return [];
    }
    const underlineColor = candidate.color === 'purple' ? 'blue' : candidate.color;
    if (type === 'underline' && !isUnderlineColor(underlineColor)) {
      return [];
    }

    seenIds.add(candidate.id);

    return [{
      id: candidate.id,
      type,
      pageNumber: candidate.pageNumber,
      text: candidate.text,
      rects,
      color: (type === 'underline' ? underlineColor : candidate.color) as HighlightColor | UnderlineColor,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    } as PdfAnnotation];
  });
}

function sanitizeNotes(value: unknown, annotations: PdfAnnotation[]): Note[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const annotationIds = new Set(annotations.map((annotation) => annotation.id));
  const notedAnnotationIds = new Set<string>();
  const noteIds = new Set<string>();
  const validNotes: Array<Omit<Note, 'displayNumber'> & { displayNumber?: string }> = [];

  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      noteIds.has(candidate.id)
    ) {
      continue;
    }

    const annotationId = isNonEmptyString(candidate.annotationId)
      ? candidate.annotationId
      : isNonEmptyString(candidate.highlightId)
        ? candidate.highlightId
        : null;

    if (
      !annotationId ||
      !annotationIds.has(annotationId) ||
      notedAnnotationIds.has(annotationId) ||
      !isPositiveInteger(candidate.pageNumber) ||
      typeof candidate.selectedText !== 'string' ||
      typeof candidate.content !== 'string' ||
      !isTimestamp(candidate.createdAt) ||
      !isTimestamp(candidate.updatedAt)
    ) {
      continue;
    }

    notedAnnotationIds.add(annotationId);
    noteIds.add(candidate.id);
    validNotes.push({
      id: candidate.id,
      annotationId,
      pageNumber: candidate.pageNumber,
      selectedText: candidate.selectedText,
      content: candidate.content,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
      displayNumber: getDisplayNumber(candidate.displayNumber) ?? undefined,
    });
  }

  const notesWithDisplayNumbers = validNotes.flatMap((note) => (
    note.displayNumber ? [{ ...note, displayNumber: note.displayNumber }] : []
  ));
  let nextDisplayNumber = deriveNextNoteNumber(notesWithDisplayNumbers);
  const assignedDisplayNumbers = new Map<string, string>();
  for (const note of validNotes.filter((note) => !note.displayNumber).sort(compareNotesByCreation)) {
    assignedDisplayNumbers.set(note.id, String(nextDisplayNumber));
    nextDisplayNumber += 1;
  }

  return validNotes.map((note) => ({
    ...note,
    displayNumber: note.displayNumber ?? assignedDisplayNumbers.get(note.id) ?? String(nextDisplayNumber),
  }));
}

function getDisplayNumber(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const displayNumber = value.trim();
  return displayNumber.length > 0 ? displayNumber : null;
}

function normalizeDisplayTitle(value: unknown, fallbackTitle: string): string {
  if (typeof value !== 'string') {
    return fallbackTitle;
  }

  const displayTitle = value.trim();
  return displayTitle.length > 0 ? displayTitle : fallbackTitle;
}

function normalizeNextNoteNumber(value: unknown, notes: Note[]): number {
  return isPositiveInteger(value)
    ? Math.max(value, deriveNextNoteNumber(notes))
    : deriveNextNoteNumber(notes);
}

function deriveNextNoteNumber(notes: Note[]): number {
  const highestDisplayNumber = notes.reduce((highest, note) => {
    if (!/^\d+$/.test(note.displayNumber)) {
      return highest;
    }

    return Math.max(highest, Number(note.displayNumber));
  }, 0);

  return highestDisplayNumber + 1;
}

function compareNotesByCreation(first: Pick<Note, 'createdAt' | 'id'>, second: Pick<Note, 'createdAt' | 'id'>): number {
  return first.createdAt - second.createdAt || first.id.localeCompare(second.id);
}

function sanitizeRectangles(value: unknown): PdfAnnotation['rects'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const { x, y, width, height } = candidate;
    if (
      !isFiniteNumber(x) ||
      !isFiniteNumber(y) ||
      !isFiniteNumber(width) ||
      !isFiniteNumber(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return [];
    }

    return [{ x, y, width, height }];
  });
}

function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === 'string' && Object.hasOwn(highlightColors, value);
}

function isUnderlineColor(value: unknown): value is UnderlineColor {
  return typeof value === 'string' && Object.hasOwn(underlineColors, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSafeBackupFilename(value: string): boolean {
  return value.trim().length > 0 && Array.from(value).every((character) => (
    character.charCodeAt(0) > 31 && !'<>:"|?*'.includes(character)
  ));
}

function normalizeLibraryEntityName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed.toLocaleLowerCase();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPositiveIntegerOrZero(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function reportPersistenceError(operation: string, error: unknown) {
  if (hasReportedPersistenceError) {
    return;
  }

  hasReportedPersistenceError = true;
  console.error(`[39Note persistence] ${operation} failed.`, error);
}
