import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  highlightColors,
  underlineColors,
  type HighlightColor,
  type PdfAnnotation,
  type UnderlineColor,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type { GlossaryEntry } from '../types/glossary';
import type { DocumentIdentity } from '../types/persistence';
import {
  sanitizeOfficeDocumentAnnotations,
  type OfficeDocumentAnnotation,
} from '../documents/annotations.ts';
import type { DocumentReadingPosition } from '../documents/types.ts';
import {
  isDocumentType,
  type DocumentType,
  type StoredDocumentSource,
} from '../types/document.ts';
import type {
  CollectionRecord,
  DocumentLibraryMetadata,
  ReadingPosition,
  TagRecord,
} from '../types/library';
import { isValidDocumentId } from '../utils/documentId';
import { sanitizePersistedGlossaryEntries } from '../utils/glossaryPersistence';
import {
  notifyPersistentChange,
  type PersistentChangeCategory,
} from './persistentChange.ts';
import {
  PERSONAL_ANNOTATION_DATABASE_NAME,
  scopedDatabaseName,
} from './temporaryWorkspace.ts';
import {
  createStoredDocumentSource,
  inspectStoredDocumentSourceMetadata,
  validateStoredDocumentSource,
} from './documentSourceValidation.ts';

const DATABASE_NAME = PERSONAL_ANNOTATION_DATABASE_NAME;
const DATABASE_VERSION = 3;
const DOCUMENT_STATE_STORE = 'document-states';
const PDF_FILE_STORE = 'pdf-files';
const COLLECTION_STORE = 'collections';
const TAG_STORE = 'tags';
export const PERSISTENCE_SCHEMA_VERSION = 8;
const LEGACY_SCHEMA_VERSION = 1;
const PREVIOUS_SCHEMA_VERSION = 2;
const HIGHLIGHT_NOTE_SCHEMA_VERSION = 3;
const DOCUMENT_METADATA_SCHEMA_VERSION = 4;
const PREVIOUS_PERSISTENCE_SCHEMA_VERSION = 5;
const NOTE_ANCHOR_PREVIOUS_SCHEMA_VERSION = 6;
const PDF_DOCUMENT_SCHEMA_VERSION = 7;

export interface PersistedDocumentState
  extends DocumentIdentity, DocumentLibraryMetadata {
  schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  documentType: DocumentType;
  originalFileName: string;
  displayTitle: string;
  annotations: PdfAnnotation[];
  /** Format-native semantic marks. Existing PDF geometry remains in annotations. */
  officeAnnotations: OfficeDocumentAnnotation[];
  noteAnchors: NoteAnchor[];
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  nextNoteNumber: number;
  updatedAt: number;
  documentReadingPosition?: DocumentReadingPosition;
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
  documentType: DocumentType;
  sourceMimeType: StoredDocumentSource['mimeType'] | null;
  hasStoredSource: boolean;
  sourceSize: number | null;
  /** @deprecated PDF compatibility alias. */
  hasStoredPdf: boolean;
  /** @deprecated PDF compatibility alias. */
  pdfSize: number | null;
  collectionIds: string[];
  tagIds: string[];
  isPinned: boolean;
  pinnedAt?: number;
  lastReadAt?: number;
  readingPosition?: ReadingPosition;
  documentReadingPosition?: DocumentReadingPosition;
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
  /** Present on schema-8 records; omitted by historical PDF records. */
  documentType?: DocumentType;
  /** Present on schema-8 records; computed when historical PDF records are read. */
  sha256?: string;
}

export interface BackupDocumentData {
  state: PersistedDocumentState;
  source: StoredDocumentSource | null;
  /** @deprecated PDF compatibility alias. */
  pdf: StoredPdfFile | null;
}

export interface LibraryStorageSummary {
  documentCount: number;
  storedPdfCount: number;
  storedPdfBytes: number;
  storedSourceCount: number;
  storedSourceBytes: number;
  annotationCount: number;
  noteCount: number;
  estimatedUsageBytes: number | null;
  estimatedQuotaBytes: number | null;
}

export interface AnnotationStorageFootprint {
  documentIds: string[];
  pdfDocumentIds: string[];
  sourceDocumentIds: string[];
  collectionIds: string[];
  tagIds: string[];
}

interface AnnotationDatabase extends DBSchema {
  [DOCUMENT_STATE_STORE]: {
    key: string;
    value: PersistedDocumentState;
  };
  [PDF_FILE_STORE]: {
    key: string;
    /** The physical name is retained so existing blobs need no IndexedDB copy. */
    value: StoredPdfFile | StoredDocumentSource;
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
let openedDatabaseName: string | null = null;
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

    return sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, documentId),
      documentId,
    );
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

    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE],
      'readonly',
    );
    const [documentStates, storedSourceFiles] = await Promise.all([
      transaction.objectStore(DOCUMENT_STATE_STORE).getAll(),
      transaction.objectStore(PDF_FILE_STORE).getAll(),
    ]);
    await transaction.done;
    const storedSourcesByDocumentId = new Map(
      storedSourceFiles.flatMap((file) => {
        if (!isRecord(file) || typeof file.documentId !== 'string') {
          return [];
        }
        const sourceMetadata = inspectStoredDocumentSourceMetadata(
          file,
          file.documentId,
        );
        return sourceMetadata
          ? [[sourceMetadata.documentId, sourceMetadata] as const]
          : [];
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

        const source = storedSourcesByDocumentId.get(sanitizedState.documentId);
        const matchingSource =
          source?.documentType === sanitizedState.documentType ? source : undefined;
        return [
          {
            documentId: sanitizedState.documentId,
            originalFileName: sanitizedState.originalFileName,
            displayTitle: sanitizedState.displayTitle,
            highlightCount:
              sanitizedState.annotations.filter(
                (annotation) => annotation.type === 'highlight',
              ).length +
              sanitizedState.officeAnnotations.filter(
                (annotation) => annotation.markType === 'highlight',
              ).length,
            underlineCount:
              sanitizedState.annotations.filter(
                (annotation) => annotation.type === 'underline',
              ).length +
              sanitizedState.officeAnnotations.filter(
                (annotation) => annotation.markType === 'underline',
              ).length,
            noteCount:
              sanitizedState.notes.length +
              sanitizedState.officeAnnotations.filter(
                (annotation) => annotation.note !== undefined,
              ).length,
            notes: sanitizedState.notes.map((note) => ({
              id: note.id,
              annotationId: note.annotationId,
              displayNumber: note.displayNumber,
              content: note.content,
              pageNumber: note.pageNumber,
              selectedText: note.selectedText,
            })),
            updatedAt: sanitizedState.updatedAt,
            documentType: sanitizedState.documentType,
            sourceMimeType: matchingSource?.mimeType ?? null,
            hasStoredSource: Boolean(matchingSource),
            sourceSize: matchingSource?.size ?? null,
            hasStoredPdf: matchingSource?.documentType === 'pdf',
            pdfSize:
              matchingSource?.documentType === 'pdf' ? matchingSource.size : null,
            collectionIds: sanitizedState.collectionIds,
            tagIds: sanitizedState.tagIds,
            isPinned: sanitizedState.isPinned,
            pinnedAt: sanitizedState.pinnedAt,
            lastReadAt: sanitizedState.lastReadAt,
            readingPosition: sanitizedState.readingPosition,
            documentReadingPosition: sanitizedState.documentReadingPosition,
          },
        ];
      })
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch (error) {
    reportPersistenceError('library read', error);
    return [];
  }
}

export async function getLibraryStorageSummary(): Promise<LibraryStorageSummary> {
  const documents = await getBackupDocumentData();
  const summary = documents.reduce<LibraryStorageSummary>(
    (currentSummary, { state, source, pdf }) => ({
      documentCount: currentSummary.documentCount + 1,
      storedPdfCount: currentSummary.storedPdfCount + (pdf ? 1 : 0),
      storedPdfBytes: currentSummary.storedPdfBytes + (pdf?.size ?? 0),
      storedSourceCount: currentSummary.storedSourceCount + (source ? 1 : 0),
      storedSourceBytes: currentSummary.storedSourceBytes + (source?.size ?? 0),
      annotationCount:
        currentSummary.annotationCount +
        state.annotations.length +
        state.officeAnnotations.length,
      noteCount:
        currentSummary.noteCount +
        state.notes.length +
        state.officeAnnotations.filter((annotation) => annotation.note !== undefined)
          .length,
      estimatedUsageBytes: currentSummary.estimatedUsageBytes,
      estimatedQuotaBytes: currentSummary.estimatedQuotaBytes,
    }),
    {
      documentCount: 0,
      storedPdfCount: 0,
      storedPdfBytes: 0,
      storedSourceCount: 0,
      storedSourceBytes: 0,
      annotationCount: 0,
      noteCount: 0,
      estimatedUsageBytes: null,
      estimatedQuotaBytes: null,
    },
  );

  try {
    const estimate =
      typeof navigator !== 'undefined' && navigator.storage?.estimate
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

/** Fail-closed raw-store inspection used before entering constrained public mode. */
export async function inspectAnnotationStorageFootprintStrict(): Promise<AnnotationStorageFootprint> {
  const database = await getDatabase();
  if (!database) throw new Error('Local Library storage is unavailable.');
  const transaction = database.transaction(
    [DOCUMENT_STATE_STORE, PDF_FILE_STORE, COLLECTION_STORE, TAG_STORE],
    'readonly',
  );
  const [states, pdfs, collections, tags] = await Promise.all([
    transaction.objectStore(DOCUMENT_STATE_STORE).getAll(),
    transaction.objectStore(PDF_FILE_STORE).getAll(),
    transaction.objectStore(COLLECTION_STORE).getAll(),
    transaction.objectStore(TAG_STORE).getAll(),
  ]);
  await transaction.done;
  for (const state of states) {
    if (!sanitizeDocumentState(state, state.documentId)) {
      throw new Error('Local paper storage could not be inspected safely.');
    }
  }
  const sourceMetadata: Array<
    Pick<StoredDocumentSource, 'documentId' | 'documentType' | 'mimeType' | 'size'>
  > = [];
  for (const source of pdfs) {
    const metadata = inspectStoredDocumentSourceMetadata(source, source.documentId);
    if (!metadata) {
      throw new Error('Local source storage could not be inspected safely.');
    }
    sourceMetadata.push(metadata);
  }
  if (!collections.every(isValidNamedRecord) || !tags.every(isValidNamedRecord)) {
    throw new Error('Local collection or tag storage could not be inspected safely.');
  }
  return {
    documentIds: states.map((state) => state.documentId),
    pdfDocumentIds: sourceMetadata
      .filter((source) => source.documentType === 'pdf')
      .map((source) => source.documentId),
    sourceDocumentIds: sourceMetadata.map((source) => source.documentId),
    collectionIds: collections.map((collection) => collection.id),
    tagIds: tags.map((tag) => tag.id),
  };
}

export async function getBackupDocumentData(
  documentIds?: readonly string[],
): Promise<BackupDocumentData[]> {
  try {
    return await readBackupDocumentData(documentIds, false);
  } catch (error) {
    reportPersistenceError('backup read', error);
    return [];
  }
}

export async function getBackupDocumentDataStrict(
  documentIds?: readonly string[],
): Promise<BackupDocumentData[]> {
  return readBackupDocumentData(documentIds, true);
}

async function readBackupDocumentData(
  documentIds: readonly string[] | undefined,
  strict: boolean,
): Promise<BackupDocumentData[]> {
  const database = await getDatabase();
  if (!database) {
    if (strict) {
      throw new Error('Local Library storage is unavailable.');
    }
    return [];
  }

  const requestedIds = documentIds ? [...new Set(documentIds)] : undefined;
  const states = requestedIds
    ? (
        await Promise.all(
          requestedIds.map((documentId) =>
            database.get(DOCUMENT_STATE_STORE, documentId),
          ),
        )
      ).flatMap((state) => (state ? [state] : []))
    : await database.getAll(DOCUMENT_STATE_STORE);
  return (
    await Promise.all(
      states.map(async (state) => {
        const sanitizedState = sanitizeDocumentState(state, state.documentId);
        if (!sanitizedState) {
          if (strict) {
            throw new Error('A Library document could not be read safely for backup.');
          }
          return null;
        }
        const storedSource = await database.get(
          PDF_FILE_STORE,
          sanitizedState.documentId,
        );
        const source = storedSource
          ? await validateStoredDocumentSource(
              storedSource,
              sanitizedState.documentId,
              {
                allowLegacyPdf: true,
              },
            )
          : null;
        if (
          strict &&
          storedSource !== undefined &&
          (!source || source.documentType !== sanitizedState.documentType)
        ) {
          throw new Error(
            'A stored source document could not be read safely for backup.',
          );
        }
        return {
          state: sanitizedState,
          source: source?.documentType === sanitizedState.documentType ? source : null,
          pdf:
            source?.documentType === 'pdf' ? storedDocumentSourceAsPdf(source) : null,
        };
      }),
    )
  ).flatMap((entry) => (entry ? [entry] : []));
}

export async function removeStoredPdfCopy(documentId: string): Promise<boolean> {
  const source = await loadStoredDocumentSource(documentId);
  if (source && source.documentType !== 'pdf') return false;
  return removeStoredDocumentSource(documentId, 'pdf');
}

export async function removeStoredDocumentSource(
  documentId: string,
  expectedDocumentType?: DocumentType,
): Promise<boolean> {
  try {
    const database = await getDatabase();
    if (!database || !(await database.get(DOCUMENT_STATE_STORE, documentId))) {
      return false;
    }
    const rawSource = await database.get(PDF_FILE_STORE, documentId);
    if (rawSource && expectedDocumentType) {
      const metadata = inspectStoredDocumentSourceMetadata(rawSource, documentId);
      if (metadata?.documentType !== expectedDocumentType) return false;
    }
    await database.delete(PDF_FILE_STORE, documentId);
    notifyPersistentChange({
      kind: expectedDocumentType === 'pdf' ? 'pdf' : 'document-source',
      documentId,
      categories: [expectedDocumentType === 'pdf' ? 'source-pdf' : 'source-document'],
    });
    return true;
  } catch (error) {
    reportPersistenceError('source copy removal', error);
    return false;
  }
}

export async function restoreBackupDocument(
  rawState: unknown,
  rawSource: StoredPdfFile | StoredDocumentSource | null,
  replaceExisting: boolean,
  notifyChange = true,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!isRecord(rawState) || typeof rawState.documentId !== 'string') {
    return false;
  }
  const state = sanitizeDocumentState(rawState, rawState.documentId);
  const source = rawSource
    ? await validateStoredDocumentSource(rawSource, rawState.documentId, {
        allowLegacyPdf: true,
      })
    : null;
  if (
    !state ||
    (rawSource && !source) ||
    (source && source.documentType !== state.documentType)
  ) {
    return false;
  }
  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }
    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE],
      'readwrite',
    );
    let previous: PersistedDocumentState | null = null;
    const releaseAbort = abortTransactionOnSignal(transaction, signal);
    try {
      const states = transaction.objectStore(DOCUMENT_STATE_STORE);
      const pdfs = transaction.objectStore(PDF_FILE_STORE);
      const existing = await states.get(state.documentId);
      previous = sanitizeDocumentState(existing, state.documentId);
      signal?.throwIfAborted();
      if (existing && !replaceExisting) {
        await transaction.done;
        return true;
      }
      await states.put(state);
      if (source) {
        await pdfs.put(source);
      } else if (replaceExisting) {
        await pdfs.delete(state.documentId);
      }
      await transaction.done;
    } finally {
      releaseAbort();
    }
    if (notifyChange) {
      notifyPersistentChange({
        kind: 'document',
        documentId: state.documentId,
        categories: documentChangeCategories(previous, state, source?.documentType),
      });
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    reportPersistenceError('backup restore', error);
    return false;
  }
}

/**
 * Installs one downloaded paper's visible Library data in a single transaction.
 * Productivity and sync metadata live in separate databases and are coordinated
 * by the paper download rollback boundary before this commit is announced.
 */
export async function restoreDownloadedPaperBundle(
  rawState: unknown,
  rawSource: StoredPdfFile | StoredDocumentSource | null,
  collections: readonly CollectionRecord[],
  tags: readonly TagRecord[],
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!isRecord(rawState) || typeof rawState.documentId !== 'string') return false;
  const state = sanitizeDocumentState(rawState, rawState.documentId);
  const source = rawSource
    ? await validateStoredDocumentSource(rawSource, rawState.documentId, {
        allowLegacyPdf: true,
      })
    : null;
  if (
    !state ||
    (rawSource && !source) ||
    (source && source.documentType !== state.documentType) ||
    !validateLibraryEntities(collections, tags)
  ) {
    return false;
  }
  try {
    const database = await getDatabase();
    if (!database) return false;
    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE, COLLECTION_STORE, TAG_STORE],
      'readwrite',
    );
    const releaseAbort = abortTransactionOnSignal(transaction, signal);
    try {
      const states = transaction.objectStore(DOCUMENT_STATE_STORE);
      const pdfs = transaction.objectStore(PDF_FILE_STORE);
      const collectionStore = transaction.objectStore(COLLECTION_STORE);
      const tagStore = transaction.objectStore(TAG_STORE);
      await states.put(state);
      if (source) await pdfs.put(source);
      else await pdfs.delete(state.documentId);
      signal?.throwIfAborted();
      const [existingCollections, existingTags] = await Promise.all([
        Promise.all(collections.map(({ id }) => collectionStore.get(id))),
        Promise.all(tags.map(({ id }) => tagStore.get(id))),
      ]);
      await Promise.all([
        ...collections.flatMap((collection, index) =>
          existingCollections[index] ? [] : [collectionStore.put(collection)],
        ),
        ...tags.flatMap((tag, index) =>
          existingTags[index] ? [] : [tagStore.put(tag)],
        ),
      ]);
      await transaction.done;
    } finally {
      releaseAbort();
    }
    return true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    reportPersistenceError('paper download bundle', error);
    return false;
  }
}

export function validateBackupDocumentState(
  value: unknown,
): PersistedDocumentState | null {
  if (!isRecord(value) || !isValidDocumentId(value.documentId)) {
    return null;
  }

  if (
    !Array.isArray(value.annotations) ||
    (value.officeAnnotations !== undefined &&
      !Array.isArray(value.officeAnnotations)) ||
    (value.noteAnchors !== undefined && !Array.isArray(value.noteAnchors)) ||
    !Array.isArray(value.notes) ||
    (value.glossaryEntries !== undefined && !Array.isArray(value.glossaryEntries)) ||
    value.annotations.some(
      (annotation) =>
        !isRecord(annotation) ||
        (annotation.type !== 'highlight' && annotation.type !== 'underline'),
    )
  ) {
    return null;
  }

  const state = sanitizeDocumentState(value, value.documentId);
  if (
    !state ||
    state.annotations.length !== value.annotations.length ||
    state.officeAnnotations.length !==
      (Array.isArray(value.officeAnnotations) ? value.officeAnnotations.length : 0) ||
    state.noteAnchors.length !==
      (Array.isArray(value.noteAnchors) ? value.noteAnchors.length : 0) ||
    state.notes.length !== value.notes.length ||
    state.glossaryEntries.length !==
      (Array.isArray(value.glossaryEntries) ? value.glossaryEntries.length : 0) ||
    (value.documentReadingPosition !== undefined &&
      state.documentReadingPosition === undefined) ||
    !isSafeBackupFilename(state.originalFileName)
  ) {
    return null;
  }

  return state;
}

export async function deleteDocumentState(
  documentId: string,
  notifyChange = true,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE],
      'readwrite',
    );
    const releaseAbort = abortTransactionOnSignal(transaction, signal);
    try {
      await Promise.all([
        transaction.objectStore(DOCUMENT_STATE_STORE).delete(documentId),
        transaction.objectStore(PDF_FILE_STORE).delete(documentId),
      ]);
      signal?.throwIfAborted();
      await transaction.done;
    } finally {
      releaseAbort();
    }
    if (notifyChange)
      notifyPersistentChange({
        kind: 'document',
        documentId,
        categories: [
          'deleted',
          'metadata',
          'notes',
          'annotations',
          'glossary',
          'reading-state',
        ],
      });
    return true;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    reportPersistenceError('delete', error);
    return false;
  }
}

export async function deleteDocumentStateStrict(
  documentId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isValidDocumentId(documentId))
    throw new Error('A temporary paper identifier is invalid.');
  if (!(await deleteDocumentState(documentId, false, signal))) {
    throw new Error('39Note could not clear a temporary paper.');
  }
  const database = await getDatabase();
  if (!database) throw new Error('Local Library storage is unavailable.');
  const [state, pdf] = await Promise.all([
    database.get(DOCUMENT_STATE_STORE, documentId),
    database.get(PDF_FILE_STORE, documentId),
  ]);
  if (state !== undefined || pdf !== undefined) {
    throw new Error('39Note could not verify temporary paper cleanup.');
  }
}

export async function deleteLibraryEntitiesStrict(
  collectionIds: readonly string[],
  tagIds: readonly string[],
): Promise<void> {
  const database = await getDatabase();
  if (!database) throw new Error('Local Library storage is unavailable.');
  const transaction = database.transaction([COLLECTION_STORE, TAG_STORE], 'readwrite');
  for (const id of new Set(collectionIds))
    await transaction.objectStore(COLLECTION_STORE).delete(id);
  for (const id of new Set(tagIds)) await transaction.objectStore(TAG_STORE).delete(id);
  await transaction.done;
  const [collections, tags] = await Promise.all([
    database.getAll(COLLECTION_STORE),
    database.getAll(TAG_STORE),
  ]);
  if (
    collections.some((item) => collectionIds.includes(item.id)) ||
    tags.some((item) => tagIds.includes(item.id))
  ) {
    throw new Error('39Note could not verify temporary collection cleanup.');
  }
}

export async function deleteDocumentStates(
  documentIds: string[],
  notifyChange = true,
): Promise<{ deleted: string[]; failed: string[] }> {
  const uniqueIds = [...new Set(documentIds.filter(isValidDocumentId))];
  if (uniqueIds.length === 0) return { deleted: [], failed: [] };
  try {
    const database = await getDatabase();
    if (!database) return { deleted: [], failed: uniqueIds };
    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE],
      'readwrite',
    );
    const states = transaction.objectStore(DOCUMENT_STATE_STORE);
    const pdfs = transaction.objectStore(PDF_FILE_STORE);
    for (const documentId of uniqueIds) {
      await states.delete(documentId);
      await pdfs.delete(documentId);
    }
    await transaction.done;
    if (notifyChange) {
      for (const documentId of uniqueIds) {
        notifyPersistentChange({
          kind: 'document',
          documentId,
          categories: [
            'deleted',
            'metadata',
            'notes',
            'annotations',
            'glossary',
            'reading-state',
          ],
        });
      }
    }
    return { deleted: uniqueIds, failed: [] };
  } catch (error) {
    reportPersistenceError('batch delete', error);
    return { deleted: [], failed: uniqueIds };
  }
}

export async function storePdfFile(
  identity: DocumentIdentity,
  file: File,
): Promise<boolean> {
  return storeDocumentSource(identity, file, 'pdf');
}

export async function storeDocumentSource(
  identity: DocumentIdentity,
  file: File,
  expectedDocumentType?: DocumentType,
): Promise<boolean> {
  if (!isValidDocumentId(identity.documentId)) {
    return false;
  }

  try {
    const source = await createStoredDocumentSource(
      identity.documentId,
      file,
      expectedDocumentType,
    );
    if (!source) return false;
    const database = await getDatabase();
    if (!database) {
      return false;
    }

    const transaction = database.transaction(
      [DOCUMENT_STATE_STORE, PDF_FILE_STORE],
      'readwrite',
    );
    const sourceFiles = transaction.objectStore(PDF_FILE_STORE);
    const documentStates = transaction.objectStore(DOCUMENT_STATE_STORE);
    const [existingFile, existingDocumentState] = await Promise.all([
      sourceFiles.get(identity.documentId),
      documentStates.get(identity.documentId),
    ]);
    if (existingFile) {
      const existingMetadata = inspectStoredDocumentSourceMetadata(
        existingFile,
        identity.documentId,
      );
      if (!existingMetadata || existingMetadata.documentType !== source.documentType) {
        await transaction.done;
        return false;
      }
    }
    if (existingDocumentState) {
      const state = sanitizeDocumentState(existingDocumentState, identity.documentId);
      if (!state || state.documentType !== source.documentType) {
        await transaction.done;
        return false;
      }
    }

    if (!existingFile) await sourceFiles.put(source);
    if (!existingDocumentState) {
      await documentStates.put(createEmptyDocumentState(identity, source.documentType));
    }

    await transaction.done;
    notifyPersistentChange({
      kind: source.documentType === 'pdf' ? 'pdf' : 'document-source',
      documentId: identity.documentId,
      categories: [source.documentType === 'pdf' ? 'source-pdf' : 'source-document'],
    });
    return true;
  } catch (error) {
    reportPersistenceError('source document write', error);
    return false;
  }
}

export async function loadStoredPdfFile(
  documentId: string,
): Promise<StoredPdfFile | null> {
  const source = await loadStoredDocumentSource(documentId);
  return source?.documentType === 'pdf' ? storedDocumentSourceAsPdf(source) : null;
}

export async function loadStoredDocumentSource(
  documentId: string,
): Promise<StoredDocumentSource | null> {
  try {
    const database = await getDatabase();
    if (!database) {
      return null;
    }

    const storedFile = await database.get(PDF_FILE_STORE, documentId);
    if (!storedFile) return null;
    const source = await validateStoredDocumentSource(storedFile, documentId, {
      allowLegacyPdf: true,
    });
    if (!source) return null;
    const state = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, documentId),
      documentId,
    );
    return state?.documentType === source.documentType ? source : null;
  } catch (error) {
    reportPersistenceError('source document read', error);
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
    notifyPersistentChange({
      kind: 'document',
      documentId,
      categories: ['metadata'],
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
    const existing = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, documentId),
      documentId,
    );
    if (!existing) return false;
    await database.put(DOCUMENT_STATE_STORE, {
      ...existing,
      readingPosition,
      lastReadAt: Date.now(),
    });
    notifyPersistentChange({
      kind: 'document',
      documentId,
      categories: ['reading-state'],
    });
    return true;
  } catch (error) {
    reportPersistenceError('reading position write', error);
    return false;
  }
}

export async function saveDocumentReadingPosition(
  documentId: string,
  readingPosition: DocumentReadingPosition,
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  try {
    const database = await getDatabase();
    if (!database) return false;
    const existing = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, documentId),
      documentId,
    );
    const sanitized = existing
      ? sanitizeDocumentReadingPosition(readingPosition, existing.documentType)
      : undefined;
    if (!existing || !sanitized) return false;
    await database.put(DOCUMENT_STATE_STORE, {
      ...existing,
      documentReadingPosition: sanitized,
      lastReadAt: Date.now(),
    });
    notifyPersistentChange({
      kind: 'document',
      documentId,
      categories: ['reading-state'],
    });
    return true;
  } catch (error) {
    reportPersistenceError('document reading position write', error);
    return false;
  }
}

export async function saveOfficeDocumentAnnotations(
  documentId: string,
  annotations: readonly OfficeDocumentAnnotation[],
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  const sanitized = sanitizeOfficeDocumentAnnotations(annotations);
  if (sanitized.length !== annotations.length) return false;
  try {
    const database = await getDatabase();
    if (!database) return false;
    const existing = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, documentId),
      documentId,
    );
    if (!existing || existing.documentType === 'pdf') return false;
    if (
      sanitized.some(
        (annotation) =>
          annotation.documentId !== documentId ||
          (existing.documentType === 'pptx'
            ? annotation.anchor.kind !== 'pptx-text'
            : annotation.anchor.kind !== 'docx-text'),
      )
    ) {
      return false;
    }
    const nextState = {
      ...existing,
      officeAnnotations: sanitized,
      updatedAt: Date.now(),
    };
    await database.put(DOCUMENT_STATE_STORE, nextState);
    notifyPersistentChange({
      kind: 'document',
      documentId,
      categories: documentChangeCategories(existing, nextState, undefined),
    });
    return true;
  } catch (error) {
    reportPersistenceError('Office annotation write', error);
    return false;
  }
}

export async function listCollections(): Promise<CollectionRecord[]> {
  const database = await getDatabase();
  return database
    ? (await database.getAll(COLLECTION_STORE)).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    : [];
}

export async function listTags(): Promise<TagRecord[]> {
  const database = await getDatabase();
  return database
    ? (await database.getAll(TAG_STORE)).sort((a, b) => a.name.localeCompare(b.name))
    : [];
}

/** Exact-key reads for document-scoped sync; never enumerate unrelated Library data. */
export async function getCollectionsByIds(
  ids: readonly string[],
): Promise<CollectionRecord[]> {
  const database = await getDatabase();
  if (!database) return [];
  const uniqueIds = [...new Set(ids)];
  const values = await Promise.all(
    uniqueIds.map((id) => database.get(COLLECTION_STORE, id)),
  );
  return values.filter((value): value is CollectionRecord => value !== undefined);
}

/** Exact-key reads for document-scoped sync; never enumerate unrelated Library data. */
export async function getTagsByIds(ids: readonly string[]): Promise<TagRecord[]> {
  const database = await getDatabase();
  if (!database) return [];
  const uniqueIds = [...new Set(ids)];
  const values = await Promise.all(uniqueIds.map((id) => database.get(TAG_STORE, id)));
  return values.filter((value): value is TagRecord => value !== undefined);
}

export async function restoreLibraryEntities(
  collections: CollectionRecord[],
  tags: TagRecord[],
  notifyChange = true,
): Promise<boolean> {
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
  if (notifyChange) notifyPersistentChange({ kind: 'library' });
  return true;
}

export async function replaceLibraryEntities(
  collections: readonly CollectionRecord[],
  tags: readonly TagRecord[],
  notifyChange = true,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (!validateLibraryEntities(collections, tags)) return false;
  const database = await getDatabase();
  if (!database) return false;
  const transaction = database.transaction([COLLECTION_STORE, TAG_STORE], 'readwrite');
  const releaseAbort = abortTransactionOnSignal(transaction, signal);
  try {
    await transaction.objectStore(COLLECTION_STORE).clear();
    await transaction.objectStore(TAG_STORE).clear();
    for (const collection of collections) {
      signal?.throwIfAborted();
      await transaction.objectStore(COLLECTION_STORE).put(collection);
    }
    for (const tag of tags) {
      signal?.throwIfAborted();
      await transaction.objectStore(TAG_STORE).put(tag);
    }
    await transaction.done;
  } finally {
    releaseAbort();
  }
  if (notifyChange) notifyPersistentChange({ kind: 'library' });
  return true;
}

export function validateLibraryEntities(
  collections: readonly CollectionRecord[],
  tags: readonly TagRecord[],
): boolean {
  return collections.every(isValidNamedRecord) && tags.every(isValidNamedRecord);
}

export async function createCollection(name: string): Promise<CollectionRecord | null> {
  return createNamedRecord(COLLECTION_STORE, name);
}

export interface CollectionDraftInput {
  collectionId?: string;
  name: string;
  documentIds: readonly string[];
}

/**
 * Commits a Collection name and its complete paper membership in one IndexedDB
 * transaction.  The editor can therefore stage freely without exposing a
 * half-renamed or half-populated Collection to the rest of the application.
 */
export async function saveCollectionDraft(
  input: CollectionDraftInput,
): Promise<CollectionRecord | null> {
  const normalizedName = normalizeLibraryEntityName(input.name);
  if (!normalizedName) return null;
  const requestedDocumentIds = [...new Set(input.documentIds)];
  if (requestedDocumentIds.some((documentId) => !isValidDocumentId(documentId))) {
    return null;
  }

  try {
    const database = await getDatabase();
    if (!database) return null;
    const transaction = database.transaction(
      [COLLECTION_STORE, DOCUMENT_STATE_STORE],
      'readwrite',
    );
    const collectionStore = transaction.objectStore(COLLECTION_STORE);
    const documentStore = transaction.objectStore(DOCUMENT_STATE_STORE);
    const [collections, storedDocuments] = await Promise.all([
      collectionStore.getAll(),
      documentStore.getAll(),
    ]);
    const existing = input.collectionId
      ? collections.find((collection) => collection.id === input.collectionId)
      : undefined;
    if (input.collectionId && !existing) {
      await transaction.done;
      return null;
    }
    if (
      collections.some(
        (collection) =>
          collection.normalizedName === normalizedName &&
          collection.id !== input.collectionId,
      )
    ) {
      await transaction.done;
      return null;
    }

    const documents = storedDocuments
      .map((state) => sanitizeDocumentState(state, state.documentId))
      .filter((state): state is PersistedDocumentState => Boolean(state));
    const documentsById = new Map(documents.map((state) => [state.documentId, state]));
    if (requestedDocumentIds.some((documentId) => !documentsById.has(documentId))) {
      await transaction.done;
      return null;
    }

    const selected = new Set(requestedDocumentIds);
    const collectionNameChanged = Boolean(
      existing &&
      (existing.name !== input.name.trim() ||
        existing.normalizedName !== normalizedName),
    );
    const collectionMembershipChanged = existing
      ? documents.some(
          (document) =>
            document.collectionIds.includes(existing.id) !==
            selected.has(document.documentId),
        )
      : requestedDocumentIds.length > 0;
    if (existing && !collectionNameChanged && !collectionMembershipChanged) {
      await transaction.done;
      return existing;
    }

    const timestamp = Date.now();
    const record: CollectionRecord = existing
      ? {
          ...existing,
          name: input.name.trim(),
          normalizedName,
          updatedAt: timestamp,
        }
      : {
          id: crypto.randomUUID(),
          name: input.name.trim(),
          normalizedName,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const affectedDocumentIds: string[] = [];
    for (const document of documents) {
      const currentlyIncluded = document.collectionIds.includes(record.id);
      const shouldBeIncluded = selected.has(document.documentId);
      const membershipChanged = currentlyIncluded !== shouldBeIncluded;
      if (
        !membershipChanged &&
        !(collectionNameChanged && (currentlyIncluded || shouldBeIncluded))
      ) {
        continue;
      }
      const collectionIds = shouldBeIncluded
        ? [...new Set([...document.collectionIds, record.id])]
        : document.collectionIds.filter((id) => id !== record.id);
      await documentStore.put({ ...document, collectionIds, updatedAt: timestamp });
      affectedDocumentIds.push(document.documentId);
    }
    await collectionStore.put(record);
    await transaction.done;
    notifyPersistentChange({
      kind: 'library',
      ...(affectedDocumentIds.length ? { documentIds: affectedDocumentIds } : {}),
      categories: ['metadata'],
    });
    return record;
  } catch (error) {
    reportPersistenceError('Collection draft write', error);
    return null;
  }
}

export async function createTag(name: string): Promise<TagRecord | null> {
  return createNamedRecord(TAG_STORE, name);
}

export async function renameCollection(id: string, name: string): Promise<boolean> {
  return renameNamedRecord(COLLECTION_STORE, id, name, 'collectionIds');
}
export async function renameTag(id: string, name: string): Promise<boolean> {
  return renameNamedRecord(TAG_STORE, id, name, 'tagIds');
}

export async function deleteCollection(id: string): Promise<boolean> {
  return deleteNamedRecord(COLLECTION_STORE, id, 'collectionIds');
}
export async function deleteTag(id: string): Promise<boolean> {
  return deleteNamedRecord(TAG_STORE, id, 'tagIds');
}

export async function updateDocumentOrganization(
  documentIds: string[],
  update: Partial<
    Pick<DocumentLibraryMetadata, 'collectionIds' | 'tagIds' | 'isPinned' | 'pinnedAt'>
  >,
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
  notifyPersistentChange({
    kind: 'library',
    documentIds,
    categories: ['metadata'],
  });
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
  const record = {
    id: crypto.randomUUID(),
    name: name.trim(),
    normalizedName,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as T;
  await database.put(storeName, record);
  notifyPersistentChange({ kind: 'library' });
  return record;
}

async function renameNamedRecord(
  storeName: typeof COLLECTION_STORE | typeof TAG_STORE,
  id: string,
  name: string,
  field: 'collectionIds' | 'tagIds',
): Promise<boolean> {
  const normalizedName = normalizeLibraryEntityName(name);
  const database = await getDatabase();
  if (!database || !normalizedName) return false;
  const records = await database.getAll(storeName);
  if (
    records.some(
      (record) => record.id !== id && record.normalizedName === normalizedName,
    )
  )
    return false;
  const existing = await database.get(storeName, id);
  if (!existing) return false;
  await database.put(storeName, {
    ...existing,
    name: name.trim(),
    normalizedName,
    updatedAt: Date.now(),
  });
  const documentIds = (await database.getAll(DOCUMENT_STATE_STORE)).flatMap(
    (rawState) => {
      const state = sanitizeDocumentState(rawState, rawState.documentId);
      return state?.[field].includes(id) ? [state.documentId] : [];
    },
  );
  notifyPersistentChange({
    kind: 'library',
    documentIds,
    categories: ['metadata'],
  });
  return true;
}

async function deleteNamedRecord(
  storeName: typeof COLLECTION_STORE | typeof TAG_STORE,
  id: string,
  field: 'collectionIds' | 'tagIds',
): Promise<boolean> {
  const database = await getDatabase();
  if (!database) return false;
  const transaction = database.transaction(
    [storeName, DOCUMENT_STATE_STORE],
    'readwrite',
  );
  await transaction.objectStore(storeName).delete(id);
  const states = await transaction.objectStore(DOCUMENT_STATE_STORE).getAll();
  const documentIds: string[] = [];
  for (const rawState of states) {
    const state = sanitizeDocumentState(rawState, rawState.documentId);
    if (!state || !state[field].includes(id)) continue;
    documentIds.push(state.documentId);
    await transaction.objectStore(DOCUMENT_STATE_STORE).put({
      ...state,
      [field]: state[field].filter((value) => value !== id),
      updatedAt: Date.now(),
    });
  }
  await transaction.done;
  notifyPersistentChange({
    kind: 'library',
    documentIds,
    categories: ['metadata'],
  });
  return true;
}

export async function saveDocumentState(
  identity: DocumentIdentity,
  annotations: PdfAnnotation[],
  noteAnchors: NoteAnchor[],
  notes: Note[],
  glossaryEntries: GlossaryEntry[],
  nextNoteNumber: number,
  displayTitle: string,
  requestedDocumentType?: DocumentType,
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
    const sanitizedNoteAnchors = sanitizeNoteAnchors(noteAnchors);
    const sanitizedNotes = sanitizeNotes(
      notes,
      sanitizedAnnotations,
      sanitizedNoteAnchors,
    );
    const existingState = sanitizeDocumentState(
      await database.get(DOCUMENT_STATE_STORE, identity.documentId),
      identity.documentId,
    );
    const documentType = requestedDocumentType ?? existingState?.documentType ?? 'pdf';
    if (existingState && existingState.documentType !== documentType) return false;
    const sanitizedGlossaryEntries = sanitizePersistedGlossaryEntries(
      glossaryEntries,
      identity.documentId,
      documentType,
    );

    const nextState: PersistedDocumentState = {
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      documentType,
      documentId: identity.documentId,
      documentName: identity.documentName,
      originalFileName: identity.documentName,
      displayTitle: normalizeDisplayTitle(displayTitle, identity.documentName),
      annotations: sanitizedAnnotations,
      officeAnnotations: existingState?.officeAnnotations ?? [],
      noteAnchors: sanitizedNoteAnchors,
      notes: sanitizedNotes,
      glossaryEntries: sanitizedGlossaryEntries,
      nextNoteNumber: normalizeNextNoteNumber(nextNoteNumber, sanitizedNotes),
      updatedAt: Date.now(),
      ...(existingState
        ? getDocumentLibraryMetadata(existingState)
        : createEmptyLibraryMetadata()),
      ...(existingState?.documentReadingPosition
        ? { documentReadingPosition: existingState.documentReadingPosition }
        : {}),
    };
    await database.put(DOCUMENT_STATE_STORE, nextState);
    notifyPersistentChange({
      kind: 'document',
      documentId: identity.documentId,
      categories: documentChangeCategories(existingState, nextState, undefined),
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

  const databaseName = scopedDatabaseName(DATABASE_NAME);
  if (databasePromise && openedDatabaseName !== databaseName) {
    (await databasePromise).close();
    databasePromise = null;
    openedDatabaseName = null;
  }

  if (!databasePromise) {
    openedDatabaseName = databaseName;
    databasePromise = openDB<AnnotationDatabase>(databaseName, DATABASE_VERSION, {
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
    }).catch((error) => {
      databasePromise = null;
      openedDatabaseName = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function closeAnnotationPersistenceWorkspace(): Promise<void> {
  const database = databasePromise ? await databasePromise : null;
  database?.close();
  databasePromise = null;
  openedDatabaseName = null;
}

function createEmptyDocumentState(
  identity: DocumentIdentity,
  documentType: DocumentType = 'pdf',
): PersistedDocumentState {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentType,
    documentId: identity.documentId,
    documentName: identity.documentName,
    originalFileName: identity.documentName,
    displayTitle: identity.documentName,
    annotations: [],
    officeAnnotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    updatedAt: Date.now(),
    collectionIds: [],
    tagIds: [],
    isPinned: false,
  };
}

function documentChangeCategories(
  previous: PersistedDocumentState | null,
  next: PersistedDocumentState,
  sourceChanged: DocumentType | undefined,
): PersistentChangeCategory[] {
  const categories: PersistentChangeCategory[] = [];
  if (
    !previous ||
    JSON.stringify([
      previous.documentName,
      previous.documentType,
      previous.originalFileName,
      previous.displayTitle,
      previous.nextNoteNumber,
      previous.collectionIds,
      previous.tagIds,
      previous.isPinned,
      previous.pinnedAt,
      previous.lastReadAt,
    ]) !==
      JSON.stringify([
        next.documentName,
        next.documentType,
        next.originalFileName,
        next.displayTitle,
        next.nextNoteNumber,
        next.collectionIds,
        next.tagIds,
        next.isPinned,
        next.pinnedAt,
        next.lastReadAt,
      ])
  ) {
    categories.push('metadata');
  }
  if (!previous || JSON.stringify(previous.notes) !== JSON.stringify(next.notes)) {
    categories.push('notes');
  }
  if (
    !previous ||
    JSON.stringify([
      previous.annotations,
      previous.officeAnnotations,
      previous.noteAnchors,
    ]) !== JSON.stringify([next.annotations, next.officeAnnotations, next.noteAnchors])
  ) {
    categories.push('annotations');
  }
  if (
    !previous ||
    JSON.stringify(previous.glossaryEntries) !== JSON.stringify(next.glossaryEntries)
  ) {
    categories.push('glossary');
  }
  if (
    !previous ||
    JSON.stringify([previous.readingPosition, previous.documentReadingPosition]) !==
      JSON.stringify([next.readingPosition, next.documentReadingPosition])
  ) {
    categories.push('reading-state');
  }
  if (sourceChanged) {
    categories.push(sourceChanged === 'pdf' ? 'source-pdf' : 'source-document');
  }
  return categories;
}

function storedDocumentSourceAsPdf(source: StoredDocumentSource): StoredPdfFile {
  if (source.documentType !== 'pdf') {
    throw new Error('A non-PDF source cannot be exposed through the PDF API.');
  }
  return { ...source, documentType: 'pdf' };
}

function sanitizeDocumentState(
  value: unknown,
  expectedDocumentId: string,
): PersistedDocumentState | null {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== PERSISTENCE_SCHEMA_VERSION &&
      value.schemaVersion !== PDF_DOCUMENT_SCHEMA_VERSION &&
      value.schemaVersion !== NOTE_ANCHOR_PREVIOUS_SCHEMA_VERSION &&
      value.schemaVersion !== HIGHLIGHT_NOTE_SCHEMA_VERSION &&
      value.schemaVersion !== DOCUMENT_METADATA_SCHEMA_VERSION &&
      value.schemaVersion !== PREVIOUS_PERSISTENCE_SCHEMA_VERSION &&
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

  const documentType =
    value.schemaVersion === PERSISTENCE_SCHEMA_VERSION
      ? isDocumentType(value.documentType)
        ? value.documentType
        : null
      : value.documentType === undefined || value.documentType === 'pdf'
        ? 'pdf'
        : null;
  if (!documentType) return null;

  const annotations = sanitizeAnnotations(value.annotations ?? value.highlights);
  const officeAnnotations = sanitizeOfficeDocumentAnnotations(
    value.officeAnnotations,
  ).filter(
    (annotation) =>
      annotation.documentId === expectedDocumentId &&
      ((documentType === 'pptx' && annotation.anchor.kind === 'pptx-text') ||
        (documentType === 'docx' && annotation.anchor.kind === 'docx-text')),
  );
  const noteAnchors = sanitizeNoteAnchors(value.noteAnchors);
  const notes = sanitizeNotes(value.notes, annotations, noteAnchors);
  const glossaryEntries = sanitizePersistedGlossaryEntries(
    value.glossaryEntries,
    expectedDocumentId,
    documentType,
  );
  const originalFileName = isNonEmptyString(value.originalFileName)
    ? value.originalFileName
    : value.documentName;
  const documentReadingPosition = sanitizeDocumentReadingPosition(
    value.documentReadingPosition,
    documentType,
  );

  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentType,
    documentId: value.documentId,
    documentName: value.documentName,
    originalFileName,
    displayTitle: normalizeDisplayTitle(value.displayTitle, originalFileName),
    annotations,
    officeAnnotations,
    noteAnchors,
    notes,
    glossaryEntries,
    nextNoteNumber: normalizeNextNoteNumber(value.nextNoteNumber, notes),
    updatedAt: isTimestamp(value.updatedAt) ? value.updatedAt : 0,
    ...(documentReadingPosition ? { documentReadingPosition } : {}),
    ...sanitizeDocumentLibraryMetadata(value),
  };
}

function sanitizeDocumentLibraryMetadata(
  value: Record<string, unknown>,
): DocumentLibraryMetadata {
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

function getDocumentLibraryMetadata(
  state: PersistedDocumentState,
): DocumentLibraryMetadata {
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
  return [
    ...new Set(
      value.filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' &&
          candidate.length > 0 &&
          candidate.length <= 128,
      ),
    ),
  ];
}

function sanitizeReadingPosition(value: unknown): ReadingPosition | undefined {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.pageNumber) ||
    !isTimestamp(value.updatedAt)
  ) {
    return undefined;
  }
  if (
    !isFiniteNumber(value.pageOffsetRatio) ||
    value.pageOffsetRatio < 0 ||
    value.pageOffsetRatio > 1 ||
    (value.zoomMode !== 'custom' &&
      value.zoomMode !== 'fit-width' &&
      value.zoomMode !== 'fit-page') ||
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

function sanitizeDocumentReadingPosition(
  value: unknown,
  documentType: DocumentType,
): DocumentReadingPosition | undefined {
  if (!isRecord(value)) return undefined;
  if (
    documentType === 'pdf' &&
    value.kind === 'pdf-position' &&
    isPositiveInteger(value.pageNumber) &&
    isRatio(value.pageOffsetRatio)
  ) {
    return {
      kind: 'pdf-position',
      pageNumber: value.pageNumber,
      pageOffsetRatio: value.pageOffsetRatio,
    };
  }
  if (
    documentType === 'pptx' &&
    value.kind === 'pptx-position' &&
    isPositiveIntegerOrZero(value.slideIndex) &&
    isNonEmptyString(value.slideId) &&
    value.slideId.length <= 512
  ) {
    return {
      kind: 'pptx-position',
      slideIndex: value.slideIndex,
      slideId: value.slideId,
    };
  }
  if (
    documentType === 'docx' &&
    value.kind === 'docx-position' &&
    isPositiveIntegerOrZero(value.blockIndex) &&
    isNonEmptyString(value.blockId) &&
    value.blockId.length <= 512 &&
    isRatio(value.blockOffsetRatio)
  ) {
    return {
      kind: 'docx-position',
      blockIndex: value.blockIndex,
      blockId: value.blockId,
      blockOffsetRatio: value.blockOffsetRatio,
    };
  }
  return undefined;
}

function isRatio(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

function sanitizeAnnotations(value: unknown): PdfAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      seenIds.has(candidate.id)
    ) {
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

    return [
      {
        id: candidate.id,
        type,
        pageNumber: candidate.pageNumber,
        text: candidate.text,
        rects,
        color: (type === 'underline' ? underlineColor : candidate.color) as
          HighlightColor | UnderlineColor,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      } as PdfAnnotation,
    ];
  });
}

function sanitizeNoteAnchors(value: unknown): NoteAnchor[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  return value.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      candidate.type !== 'note-anchor' ||
      !isNonEmptyString(candidate.id) ||
      seenIds.has(candidate.id) ||
      !isPositiveInteger(candidate.pageNumber) ||
      typeof candidate.text !== 'string' ||
      !isPositiveIntegerOrZero(candidate.startOffset) ||
      !isPositiveIntegerOrZero(candidate.endOffset) ||
      candidate.endOffset < candidate.startOffset ||
      !isTimestamp(candidate.createdAt) ||
      !isTimestamp(candidate.updatedAt)
    ) {
      return [];
    }
    const rects = sanitizeRectangles(candidate.rects);
    if (rects.length === 0) return [];
    seenIds.add(candidate.id);
    return [
      {
        id: candidate.id,
        type: 'note-anchor' as const,
        pageNumber: candidate.pageNumber,
        text: candidate.text,
        rects,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      },
    ];
  });
}

function sanitizeNotes(
  value: unknown,
  annotations: PdfAnnotation[],
  noteAnchors: NoteAnchor[],
): Note[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sourceIds = new Set(
    [...annotations, ...noteAnchors].map((source) => source.id),
  );
  const notedAnnotationIds = new Set<string>();
  const noteIds = new Set<string>();
  const validNotes: Array<Omit<Note, 'displayNumber'> & { displayNumber?: string }> =
    [];

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
      !sourceIds.has(annotationId) ||
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

  const notesWithDisplayNumbers = validNotes.flatMap((note) =>
    note.displayNumber ? [{ ...note, displayNumber: note.displayNumber }] : [],
  );
  let nextDisplayNumber = deriveNextNoteNumber(notesWithDisplayNumbers);
  const assignedDisplayNumbers = new Map<string, string>();
  for (const note of validNotes
    .filter((note) => !note.displayNumber)
    .sort(compareNotesByCreation)) {
    assignedDisplayNumbers.set(note.id, String(nextDisplayNumber));
    nextDisplayNumber += 1;
  }

  return validNotes.map((note) => ({
    ...note,
    displayNumber:
      note.displayNumber ??
      assignedDisplayNumbers.get(note.id) ??
      String(nextDisplayNumber),
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

function compareNotesByCreation(
  first: Pick<Note, 'createdAt' | 'id'>,
  second: Pick<Note, 'createdAt' | 'id'>,
): number {
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
  return (
    value.trim().length > 0 &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) > 31 && !'<>:"|?*'.includes(character),
    )
  );
}

function normalizeLibraryEntityName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return null;
  return trimmed.toLocaleLowerCase();
}

function isValidNamedRecord(value: CollectionRecord | TagRecord): boolean {
  return (
    isNonEmptyString(value.id) &&
    value.id.length <= 128 &&
    isNonEmptyString(value.name) &&
    value.name.length <= 80 &&
    value.normalizedName === normalizeLibraryEntityName(value.name) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
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

function abortTransactionOnSignal(
  transaction: { abort(): void },
  signal?: AbortSignal,
): () => void {
  if (!signal) return () => undefined;
  signal.throwIfAborted();
  const abort = () => {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have committed between the signal and this callback.
    }
  };
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function reportPersistenceError(operation: string, error: unknown) {
  if (hasReportedPersistenceError) {
    return;
  }

  hasReportedPersistenceError = true;
  console.error(`[39Note persistence] ${operation} failed.`, error);
}
