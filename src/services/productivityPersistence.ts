import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AiChatMessage,
  AiConversationRecord,
  PrintDraftAddition,
  PrintDraftRecord,
  StoredRenderedPrintPdf,
} from '../types/productivity';
import { PRINT_DRAFT_SCHEMA_VERSION } from '../types/productivity';
import {
  normalizePrintPresentation,
  PRINT_TEMPLATE_VERSION,
} from '../print/printTemplates.ts';
import { isValidDocumentId } from '../utils/documentId';
import { notifyPersistentChange } from './persistentChange.ts';
import {
  PERSONAL_PRODUCTIVITY_DATABASE_NAME,
  scopedDatabaseName,
} from './temporaryWorkspace.ts';
import {
  replaceAndVerifyStoredRenderedPrintPdf,
  validateStoredRenderedPrintPdf,
} from '../print/renderedPrintPdf.ts';

const DATABASE_NAME = PERSONAL_PRODUCTIVITY_DATABASE_NAME;
const DATABASE_VERSION = 2;
const PRINT_DRAFT_STORE = 'print-drafts';
const RENDERED_PRINT_PDF_STORE = 'rendered-print-pdfs';
const AI_CONVERSATION_STORE = 'ai-conversations';

interface ProductivityDatabase extends DBSchema {
  [PRINT_DRAFT_STORE]: {
    key: string;
    value: PrintDraftRecord;
  };
  [RENDERED_PRINT_PDF_STORE]: {
    key: string;
    value: StoredRenderedPrintPdf;
  };
  [AI_CONVERSATION_STORE]: {
    key: string;
    value: AiConversationRecord;
    indexes: { 'by-document': string };
  };
}

export interface ProductivityBackupDocument {
  documentId: string;
  printDraft: PrintDraftRecord | null;
  aiConversations: AiConversationRecord[];
}

let databasePromise: Promise<IDBPDatabase<ProductivityDatabase>> | null = null;
let openedDatabaseName: string | null = null;

export async function loadPrintDraft(
  documentId: string,
): Promise<PrintDraftRecord | null> {
  if (!isValidDocumentId(documentId)) return null;
  try {
    const database = await getDatabase();
    return sanitizePrintDraft(
      await database.get(PRINT_DRAFT_STORE, documentId),
      documentId,
    );
  } catch {
    return null;
  }
}

export async function savePrintDraft(draft: PrintDraftRecord): Promise<boolean> {
  const sanitized = sanitizePrintDraft(draft, draft.documentId);
  if (!sanitized) return false;
  try {
    const database = await getDatabase();
    await database.put(PRINT_DRAFT_STORE, sanitized);
    notifyPersistentChange({
      kind: 'productivity',
      documentId: sanitized.documentId,
      categories: ['print-draft'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function clearPrintDraft(documentId: string): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  try {
    const database = await getDatabase();
    await database.delete(PRINT_DRAFT_STORE, documentId);
    notifyPersistentChange({
      kind: 'productivity',
      documentId,
      categories: ['print-draft'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadRenderedPrintPdf(
  documentId: string,
): Promise<StoredRenderedPrintPdf | null> {
  if (!isValidDocumentId(documentId)) return null;
  try {
    const database = await getDatabase();
    return validateStoredRenderedPrintPdf(
      await database.get(RENDERED_PRINT_PDF_STORE, documentId),
      documentId,
    );
  } catch {
    return null;
  }
}

export async function saveRenderedPrintPdf(
  artifact: StoredRenderedPrintPdf,
  notifyChange = true,
): Promise<boolean> {
  const validated = await validateStoredRenderedPrintPdf(artifact, artifact.documentId);
  if (!validated) return false;
  try {
    const database = await getDatabase();
    await database.put(RENDERED_PRINT_PDF_STORE, validated);
    if (notifyChange) {
      notifyPersistentChange({
        kind: 'productivity',
        documentId: validated.documentId,
        categories: ['rendered-print-pdf'],
      });
    }
    return true;
  } catch {
    return false;
  }
}

export async function replaceRenderedPrintPdf(
  artifact: StoredRenderedPrintPdf,
): Promise<StoredRenderedPrintPdf> {
  const documentId = artifact.documentId;
  const persisted = await replaceAndVerifyStoredRenderedPrintPdf(artifact, {
    load: () => loadRenderedPrintPdfStrict(documentId),
    save: (next) => saveRenderedPrintPdfStrict(next),
    remove: () => removeRenderedPrintPdfStrict(documentId),
  });
  notifyPersistentChange({
    kind: 'productivity',
    documentId,
    categories: ['rendered-print-pdf'],
  });
  return persisted;
}

export async function removeRenderedPrintPdf(
  documentId: string,
  notifyChange = true,
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  try {
    const database = await getDatabase();
    await database.delete(RENDERED_PRINT_PDF_STORE, documentId);
    if (notifyChange) {
      notifyPersistentChange({
        kind: 'productivity',
        documentId,
        categories: ['rendered-print-pdf'],
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function loadRenderedPrintPdfStrict(
  documentId: string,
): Promise<StoredRenderedPrintPdf | null> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Print PDF has an invalid document identifier.');
  }
  const database = await getDatabase();
  const value = await database.get(RENDERED_PRINT_PDF_STORE, documentId);
  if (value === undefined) return null;
  const validated = await validateStoredRenderedPrintPdf(value, documentId);
  if (!validated) {
    throw new Error('The saved Print PDF failed local integrity validation.');
  }
  return validated;
}

async function saveRenderedPrintPdfStrict(
  artifact: StoredRenderedPrintPdf,
): Promise<void> {
  const database = await getDatabase();
  await database.put(RENDERED_PRINT_PDF_STORE, artifact);
}

async function removeRenderedPrintPdfStrict(documentId: string): Promise<void> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Print PDF has an invalid document identifier.');
  }
  const database = await getDatabase();
  await database.delete(RENDERED_PRINT_PDF_STORE, documentId);
}

function sameStoredRenderedPrintPdfMetadata(
  value: unknown,
  expected: StoredRenderedPrintPdf | null,
): boolean {
  if (!expected) return value === undefined;
  if (!isRecord(value) || !(value.blob instanceof Blob)) return false;
  return (
    value.kind === expected.kind &&
    value.documentId === expected.documentId &&
    value.fileName === expected.fileName &&
    value.mimeType === expected.mimeType &&
    value.size === expected.size &&
    value.blob.size === expected.blob.size &&
    value.sha256 === expected.sha256 &&
    value.renderedFromDraftHash === expected.renderedFromDraftHash &&
    value.createdAt === expected.createdAt &&
    value.storedAt === expected.storedAt &&
    value.fileId === expected.fileId
  );
}

interface RenderedPrintPdfStoredMetadataIdentity {
  state: 'stored';
  kind: unknown;
  documentId: unknown;
  fileName: unknown;
  mimeType: unknown;
  size: unknown;
  blobSize: number;
  sha256: unknown;
  renderedFromDraftHash: unknown;
  createdAt: unknown;
  storedAt: unknown;
  fileId: unknown;
}

type RenderedPrintPdfStoredValueIdentity =
  { state: 'absent' } | { state: 'invalid' } | RenderedPrintPdfStoredMetadataIdentity;

/**
 * A cheap IndexedDB version token used only for compare-and-swap. It records
 * the persisted descriptor and Blob length without rehashing potentially large
 * PDF bytes. Integrity validation still occurs whenever an artifact is used.
 */
export interface RenderedPrintPdfStorageIdentity {
  kind: 'rendered-print-pdf-storage-identity';
  value: RenderedPrintPdfStoredValueIdentity;
}

function storedRenderedPrintPdfIdentity(
  value: unknown,
): RenderedPrintPdfStoredValueIdentity {
  if (value === undefined) return { state: 'absent' };
  if (!isRecord(value) || !(value.blob instanceof Blob)) {
    return { state: 'invalid' };
  }
  return {
    state: 'stored',
    kind: value.kind,
    documentId: value.documentId,
    fileName: value.fileName,
    mimeType: value.mimeType,
    size: value.size,
    blobSize: value.blob.size,
    sha256: value.sha256,
    renderedFromDraftHash: value.renderedFromDraftHash,
    createdAt: value.createdAt,
    storedAt: value.storedAt,
    fileId: value.fileId,
  };
}

function sameStoredRenderedPrintPdfIdentity(
  first: RenderedPrintPdfStoredValueIdentity,
  second: RenderedPrintPdfStoredValueIdentity,
): boolean {
  if (first.state !== second.state) return false;
  if (first.state !== 'stored' || second.state !== 'stored') return true;
  return (
    first.kind === second.kind &&
    first.documentId === second.documentId &&
    first.fileName === second.fileName &&
    first.mimeType === second.mimeType &&
    first.size === second.size &&
    first.blobSize === second.blobSize &&
    first.sha256 === second.sha256 &&
    first.renderedFromDraftHash === second.renderedFromDraftHash &&
    first.createdAt === second.createdAt &&
    first.storedAt === second.storedAt &&
    first.fileId === second.fileId
  );
}

export async function captureRenderedPrintPdfStorageIdentity(
  documentId: string,
): Promise<RenderedPrintPdfStorageIdentity> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Print PDF has an invalid document identifier.');
  }
  const database = await getDatabase();
  return {
    kind: 'rendered-print-pdf-storage-identity',
    value: storedRenderedPrintPdfIdentity(
      await database.get(RENDERED_PRINT_PDF_STORE, documentId),
    ),
  };
}

/** Exact restore used by atomic paper Download/rollback paths. */
export async function restoreRenderedPrintPdf(
  documentId: string,
  artifact: StoredRenderedPrintPdf | null,
  notifyChange = false,
  signal?: AbortSignal,
): Promise<void> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Print PDF has an invalid document identifier.');
  }
  signal?.throwIfAborted();
  const validated = artifact
    ? await validateStoredRenderedPrintPdf(artifact, documentId)
    : null;
  if (artifact && !validated) {
    throw new Error('A Print PDF failed local integrity validation.');
  }
  const database = await getDatabase();
  signal?.throwIfAborted();
  if (validated) await database.put(RENDERED_PRINT_PDF_STORE, validated);
  else await database.delete(RENDERED_PRINT_PDF_STORE, documentId);
  signal?.throwIfAborted();
  if (notifyChange) {
    notifyPersistentChange({
      kind: 'productivity',
      documentId,
      categories: ['rendered-print-pdf'],
    });
  }
}

/**
 * Drive Download uses this compare-and-swap boundary so a remote artifact
 * staged earlier cannot overwrite a newer local Print PDF replacement.
 */
export async function restoreRenderedPrintPdfIfUnchanged(
  documentId: string,
  expectedCurrent: StoredRenderedPrintPdf | null | RenderedPrintPdfStorageIdentity,
  artifact: StoredRenderedPrintPdf | null,
  notifyChange = false,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A Print PDF has an invalid document identifier.');
  }
  signal?.throwIfAborted();
  const validated = artifact
    ? await validateStoredRenderedPrintPdf(artifact, documentId)
    : null;
  if (artifact && !validated) {
    throw new Error('A Print PDF failed local integrity validation.');
  }
  const database = await getDatabase();
  const transaction = database.transaction(RENDERED_PRINT_PDF_STORE, 'readwrite');
  const releaseAbort = abortTransactionOnSignal(transaction, signal);
  try {
    const currentValue = await transaction.store.get(documentId);
    const currentMatches =
      expectedCurrent?.kind === 'rendered-print-pdf-storage-identity'
        ? sameStoredRenderedPrintPdfIdentity(
            storedRenderedPrintPdfIdentity(currentValue),
            expectedCurrent.value,
          )
        : sameStoredRenderedPrintPdfMetadata(currentValue, expectedCurrent);
    if (!currentMatches) {
      await transaction.done;
      return false;
    }
    signal?.throwIfAborted();
    if (validated) await transaction.store.put(validated);
    else await transaction.store.delete(documentId);
    await transaction.done;
  } finally {
    releaseAbort();
  }
  if (notifyChange) {
    notifyPersistentChange({
      kind: 'productivity',
      documentId,
      categories: ['rendered-print-pdf'],
    });
  }
  return true;
}

export async function appendPrintDraftAddition(
  documentId: string,
  addition: PrintDraftAddition,
): Promise<boolean> {
  if (!isValidDocumentId(documentId)) return false;
  const existing = await loadPrintDraft(documentId);
  if (!existing) return false;
  return savePrintDraft({
    ...existing,
    pendingAdditions: [...existing.pendingAdditions, sanitizeAddition(addition)].slice(
      -50,
    ),
    updatedAt: Date.now(),
  });
}

export async function listAiConversations(
  documentId: string,
): Promise<AiConversationRecord[]> {
  if (!isValidDocumentId(documentId)) return [];
  try {
    const database = await getDatabase();
    const records = await database.getAllFromIndex(
      AI_CONVERSATION_STORE,
      'by-document',
      documentId,
    );
    return records
      .flatMap((record) => {
        const sanitized = sanitizeConversation(record, documentId);
        return sanitized ? [sanitized] : [];
      })
      .sort((first, second) => second.updatedAt - first.updatedAt);
  } catch {
    return [];
  }
}

export async function saveAiConversation(
  conversation: AiConversationRecord,
): Promise<boolean> {
  const sanitized = sanitizeConversation(conversation, conversation.documentId);
  if (!sanitized) return false;
  try {
    const database = await getDatabase();
    await database.put(AI_CONVERSATION_STORE, sanitized);
    notifyPersistentChange({
      kind: 'productivity',
      documentId: sanitized.documentId,
      categories: ['ai-conversation'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function deleteAiConversation(conversationId: string): Promise<boolean> {
  if (!isSafeId(conversationId)) return false;
  try {
    const database = await getDatabase();
    const existing = await database.get(AI_CONVERSATION_STORE, conversationId);
    await database.delete(AI_CONVERSATION_STORE, conversationId);
    notifyPersistentChange({
      kind: 'productivity',
      documentId: existing?.documentId,
      categories: ['ai-conversation'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function getAiConversationsForBackup(
  documentIds?: readonly string[],
): Promise<AiConversationRecord[]> {
  try {
    const database = await getDatabase();
    const allowed = documentIds ? new Set(documentIds) : null;
    const records = await database.getAll(AI_CONVERSATION_STORE);
    return records.flatMap((record) => {
      if (allowed && !allowed.has(record.documentId)) return [];
      const sanitized = sanitizeConversation(record, record.documentId);
      return sanitized ? [sanitized] : [];
    });
  } catch {
    return [];
  }
}

export async function getProductivityBackupData(
  documentIds: readonly string[],
): Promise<ProductivityBackupDocument[]> {
  const conversations = await getAiConversationsForBackup(documentIds);
  const byDocument = new Map<string, AiConversationRecord[]>();
  for (const conversation of conversations) {
    byDocument.set(conversation.documentId, [
      ...(byDocument.get(conversation.documentId) ?? []),
      conversation,
    ]);
  }
  return Promise.all(
    documentIds.map(async (documentId) => ({
      documentId,
      printDraft: await loadPrintDraft(documentId),
      aiConversations: byDocument.get(documentId) ?? [],
    })),
  );
}

/** Strict publication/backup read: storage errors or invalid records fail closed. */
export async function getProductivityBackupDataStrict(
  documentIds: readonly string[],
): Promise<ProductivityBackupDocument[]> {
  const uniqueIds = [...new Set(documentIds)];
  if (uniqueIds.some((documentId) => !isValidDocumentId(documentId))) {
    throw new Error('A paper has an invalid productivity document identifier.');
  }
  const database = await getDatabase();
  const allConversations = (
    await Promise.all(
      uniqueIds.map((documentId) =>
        database.getAllFromIndex(AI_CONVERSATION_STORE, 'by-document', documentId),
      ),
    )
  ).flat();
  const byDocument = new Map<string, AiConversationRecord[]>();
  for (const raw of allConversations) {
    const conversation = sanitizeConversation(raw, raw.documentId);
    if (!conversation) {
      throw new Error('A local AI conversation could not be read safely.');
    }
    if (!uniqueIds.includes(conversation.documentId)) continue;
    byDocument.set(conversation.documentId, [
      ...(byDocument.get(conversation.documentId) ?? []),
      conversation,
    ]);
  }
  return Promise.all(
    uniqueIds.map(async (documentId) => {
      const rawDraft = await database.get(PRINT_DRAFT_STORE, documentId);
      const printDraft =
        rawDraft === undefined ? null : sanitizePrintDraft(rawDraft, documentId);
      if (rawDraft !== undefined && !printDraft) {
        throw new Error('A local Print Draft could not be read safely.');
      }
      return {
        documentId,
        printDraft,
        aiConversations: byDocument.get(documentId) ?? [],
      };
    }),
  );
}

export interface ProductivityStorageFootprint {
  printDraftIds: string[];
  renderedPrintPdfIds: string[];
  conversationIds: string[];
}

export async function inspectProductivityStorageFootprintStrict(): Promise<ProductivityStorageFootprint> {
  const database = await getDatabase();
  const [drafts, renderedPrintPdfs, conversations] = await Promise.all([
    database.getAll(PRINT_DRAFT_STORE),
    database.getAll(RENDERED_PRINT_PDF_STORE),
    database.getAll(AI_CONVERSATION_STORE),
  ]);
  for (const draft of drafts) {
    if (!sanitizePrintDraft(draft, draft.documentId)) {
      throw new Error('Local Print Draft storage could not be inspected safely.');
    }
  }
  for (const conversation of conversations) {
    if (!sanitizeConversation(conversation, conversation.documentId)) {
      throw new Error('Local conversation storage could not be inspected safely.');
    }
  }
  for (const artifact of renderedPrintPdfs) {
    if (!(await validateStoredRenderedPrintPdf(artifact, artifact.documentId))) {
      throw new Error('Local Print PDF storage could not be inspected safely.');
    }
  }
  return {
    printDraftIds: drafts.map((draft) => draft.documentId),
    renderedPrintPdfIds: renderedPrintPdfs.map((artifact) => artifact.documentId),
    conversationIds: conversations.map((conversation) => conversation.id),
  };
}

export function sanitizeProductivityBackupData(
  value: unknown,
  expectedDocumentId: string,
): ProductivityBackupDocument | null {
  if (!isRecord(value) || value.documentId !== expectedDocumentId) return null;
  const printDraft =
    value.printDraft === null
      ? null
      : sanitizePrintDraft(value.printDraft, expectedDocumentId);
  if (value.printDraft !== null && !printDraft) return null;
  if (!Array.isArray(value.aiConversations)) return null;
  const aiConversations = value.aiConversations.flatMap((conversation) => {
    const sanitized = sanitizeConversation(conversation, expectedDocumentId);
    return sanitized ? [sanitized] : [];
  });
  if (aiConversations.length !== value.aiConversations.length) return null;
  return { documentId: expectedDocumentId, printDraft, aiConversations };
}

export async function restoreProductivityBackupData(
  records: readonly ProductivityBackupDocument[],
  notifyChange = true,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const sanitizedRecords = records.map((record) =>
    sanitizeProductivityBackupData(record, record.documentId),
  );
  if (sanitizedRecords.some((record) => !record)) {
    throw new Error('Cloud productivity data failed validation.');
  }
  const database = await getDatabase();
  const transaction = database.transaction(
    [PRINT_DRAFT_STORE, AI_CONVERSATION_STORE],
    'readwrite',
  );
  const releaseAbort = abortTransactionOnSignal(transaction, signal);
  try {
    for (const record of sanitizedRecords) {
      signal?.throwIfAborted();
      if (!record) throw new Error('Cloud productivity data failed validation.');
      const draftStore = transaction.objectStore(PRINT_DRAFT_STORE);
      const conversationStore = transaction.objectStore(AI_CONVERSATION_STORE);
      await draftStore.delete(record.documentId);
      const oldConversationIds = await conversationStore
        .index('by-document')
        .getAllKeys(record.documentId);
      await Promise.all(oldConversationIds.map((id) => conversationStore.delete(id)));
      if (record.printDraft) await draftStore.put(record.printDraft);
      for (const conversation of record.aiConversations) {
        signal?.throwIfAborted();
        await conversationStore.put(conversation);
      }
    }
    await transaction.done;
  } finally {
    releaseAbort();
  }
  if (notifyChange) {
    for (const record of records) {
      notifyPersistentChange({ kind: 'productivity', documentId: record.documentId });
    }
  }
}

export async function restoreAiConversations(
  conversations: readonly AiConversationRecord[],
): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(AI_CONVERSATION_STORE, 'readwrite');
  for (const conversation of conversations) {
    const sanitized = sanitizeConversation(conversation, conversation.documentId);
    if (sanitized) await transaction.store.put(sanitized);
  }
  await transaction.done;
  for (const conversation of conversations) {
    notifyPersistentChange({
      kind: 'productivity',
      documentId: conversation.documentId,
    });
  }
}

export async function deleteProductivityDocumentData(
  documentId: string,
  notifyChange = true,
  signal?: AbortSignal,
): Promise<void> {
  if (!isValidDocumentId(documentId)) return;
  signal?.throwIfAborted();
  try {
    const database = await getDatabase();
    const transaction = database.transaction(
      [PRINT_DRAFT_STORE, RENDERED_PRINT_PDF_STORE, AI_CONVERSATION_STORE],
      'readwrite',
    );
    const releaseAbort = abortTransactionOnSignal(transaction, signal);
    try {
      await transaction.objectStore(PRINT_DRAFT_STORE).delete(documentId);
      await transaction.objectStore(RENDERED_PRINT_PDF_STORE).delete(documentId);
      const conversationIds = await transaction
        .objectStore(AI_CONVERSATION_STORE)
        .index('by-document')
        .getAllKeys(documentId);
      signal?.throwIfAborted();
      await Promise.all(
        conversationIds.map((id) =>
          transaction.objectStore(AI_CONVERSATION_STORE).delete(id),
        ),
      );
      await transaction.done;
    } finally {
      releaseAbort();
    }
    if (notifyChange) notifyPersistentChange({ kind: 'productivity', documentId });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // Document deletion remains successful even if optional productivity data is unavailable.
  }
}

export async function deleteProductivityDocumentDataStrict(
  documentId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!isValidDocumentId(documentId)) {
    throw new Error('A temporary paper has an invalid identifier.');
  }
  signal?.throwIfAborted();
  const database = await getDatabase();
  const transaction = database.transaction(
    [PRINT_DRAFT_STORE, RENDERED_PRINT_PDF_STORE, AI_CONVERSATION_STORE],
    'readwrite',
  );
  const releaseAbort = abortTransactionOnSignal(transaction, signal);
  try {
    await transaction.objectStore(PRINT_DRAFT_STORE).delete(documentId);
    await transaction.objectStore(RENDERED_PRINT_PDF_STORE).delete(documentId);
    const conversationStore = transaction.objectStore(AI_CONVERSATION_STORE);
    const ids = await conversationStore.index('by-document').getAllKeys(documentId);
    for (const id of ids) await conversationStore.delete(id);
    await transaction.done;
  } finally {
    releaseAbort();
  }
  const [draft, renderedPrintPdf, remaining] = await Promise.all([
    database.get(PRINT_DRAFT_STORE, documentId),
    database.get(RENDERED_PRINT_PDF_STORE, documentId),
    database.getAllFromIndex(AI_CONVERSATION_STORE, 'by-document', documentId),
  ]);
  if (draft !== undefined || renderedPrintPdf !== undefined || remaining.length > 0) {
    throw new Error('39Note could not clear temporary productivity data.');
  }
}

async function getDatabase(): Promise<IDBPDatabase<ProductivityDatabase>> {
  const databaseName = scopedDatabaseName(DATABASE_NAME);
  if (databasePromise && openedDatabaseName !== databaseName) {
    (await databasePromise).close();
    databasePromise = null;
    openedDatabaseName = null;
  }
  if (!databasePromise) {
    openedDatabaseName = databaseName;
    databasePromise = openDB<ProductivityDatabase>(databaseName, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(PRINT_DRAFT_STORE)) {
          database.createObjectStore(PRINT_DRAFT_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(RENDERED_PRINT_PDF_STORE)) {
          database.createObjectStore(RENDERED_PRINT_PDF_STORE, {
            keyPath: 'documentId',
          });
        }
        if (!database.objectStoreNames.contains(AI_CONVERSATION_STORE)) {
          const store = database.createObjectStore(AI_CONVERSATION_STORE, {
            keyPath: 'id',
          });
          store.createIndex('by-document', 'documentId');
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

export async function closeProductivityPersistenceWorkspace(): Promise<void> {
  const database = databasePromise ? await databasePromise : null;
  database?.close();
  databasePromise = null;
  openedDatabaseName = null;
}

function sanitizePrintDraft(
  value: unknown,
  expectedDocumentId: string,
): PrintDraftRecord | null {
  if (!isRecord(value) || !isValidDocumentId(expectedDocumentId)) return null;
  const presentation = normalizePrintPresentation(value);
  if (
    value.documentId !== expectedDocumentId ||
    typeof value.sourceFingerprint !== 'string' ||
    typeof value.editorStateJson !== 'string' ||
    value.editorStateJson.length > 5_000_000 ||
    !presentation ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.lastSavedAt)
  ) {
    return null;
  }
  const additions = Array.isArray(value.pendingAdditions)
    ? value.pendingAdditions.flatMap((item) => {
        const sanitized = sanitizeAddition(item);
        return sanitized.content ? [sanitized] : [];
      })
    : [];
  return {
    draftSchemaVersion: PRINT_DRAFT_SCHEMA_VERSION,
    documentId: expectedDocumentId,
    sourceFingerprint: value.sourceFingerprint.slice(0, 256),
    sourceModelVersion:
      typeof value.sourceModelVersion === 'number' &&
      Number.isInteger(value.sourceModelVersion) &&
      value.sourceModelVersion > 0
        ? value.sourceModelVersion
        : 1,
    editorStateJson: value.editorStateJson,
    contentMode: presentation.contentMode,
    baseTemplateId: presentation.baseTemplateId,
    templateVersion: PRINT_TEMPLATE_VERSION,
    overrides: presentation.overrides,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastSavedAt: value.lastSavedAt,
    pendingAdditions: additions.slice(-50),
  };
}

function sanitizeConversation(
  value: unknown,
  expectedDocumentId: string,
): AiConversationRecord | null {
  if (!isRecord(value) || !isValidDocumentId(expectedDocumentId)) return null;
  if (
    !isSafeId(value.id) ||
    value.documentId !== expectedDocumentId ||
    typeof value.title !== 'string' ||
    typeof value.promptProfileId !== 'string' ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.messages)
  ) {
    return null;
  }
  const messages = value.messages.flatMap((message) => {
    const sanitized = sanitizeMessage(message);
    return sanitized ? [sanitized] : [];
  });
  if (messages.length !== value.messages.length) return null;
  return {
    id: value.id,
    documentId: expectedDocumentId,
    title: value.title.slice(0, 160),
    promptProfileId: value.promptProfileId.slice(0, 128),
    messages: messages.slice(-200),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function sanitizeMessage(value: unknown): AiChatMessage | null {
  if (
    !isRecord(value) ||
    !isSafeId(value.id) ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.content !== 'string' ||
    value.content.length > 500_000 ||
    !isTimestamp(value.createdAt)
  ) {
    return null;
  }
  const status =
    value.status === 'streaming' ||
    value.status === 'complete' ||
    value.status === 'error' ||
    value.status === 'stopped'
      ? value.status
      : undefined;
  const pages = Array.isArray(value.pages)
    ? [...new Set(value.pages.filter(isPositiveInteger))].slice(0, 500)
    : undefined;
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    ...(status ? { status } : {}),
    ...(pages?.length ? { pages } : {}),
    ...(isPositiveInteger(value.contextCharacters)
      ? { contextCharacters: value.contextCharacters }
      : {}),
  };
}

function sanitizeAddition(value: unknown): PrintDraftAddition {
  const candidate = isRecord(value) ? value : {};
  return {
    id: isSafeId(candidate.id) ? candidate.id : crypto.randomUUID(),
    kind: candidate.kind === 'ai-result' ? 'ai-result' : 'custom',
    label: typeof candidate.label === 'string' ? candidate.label.slice(0, 160) : '',
    content:
      typeof candidate.content === 'string' ? candidate.content.slice(0, 500_000) : '',
    createdAt: isTimestamp(candidate.createdAt) ? candidate.createdAt : Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
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
