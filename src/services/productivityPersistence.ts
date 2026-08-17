import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  AiChatMessage,
  AiConversationRecord,
  PrintDraftAddition,
  PrintDraftRecord,
} from '../types/productivity';
import { notesPrintLayouts } from '../types/glossary';
import { isValidDocumentId } from '../utils/documentId';

const DATABASE_NAME = '39note-productivity-db';
const DATABASE_VERSION = 1;
const PRINT_DRAFT_STORE = 'print-drafts';
const AI_CONVERSATION_STORE = 'ai-conversations';

interface ProductivityDatabase extends DBSchema {
  [PRINT_DRAFT_STORE]: {
    key: string;
    value: PrintDraftRecord;
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
    return true;
  } catch {
    return false;
  }
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
    return true;
  } catch {
    return false;
  }
}

export async function deleteAiConversation(conversationId: string): Promise<boolean> {
  if (!isSafeId(conversationId)) return false;
  try {
    const database = await getDatabase();
    await database.delete(AI_CONVERSATION_STORE, conversationId);
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
): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(
    [PRINT_DRAFT_STORE, AI_CONVERSATION_STORE],
    'readwrite',
  );
  for (const record of records) {
    const sanitized = sanitizeProductivityBackupData(record, record.documentId);
    if (!sanitized) continue;
    if (sanitized.printDraft) {
      await transaction.objectStore(PRINT_DRAFT_STORE).put(sanitized.printDraft);
    }
    for (const conversation of sanitized.aiConversations) {
      await transaction.objectStore(AI_CONVERSATION_STORE).put(conversation);
    }
  }
  await transaction.done;
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
}

export async function deleteProductivityDocumentData(
  documentId: string,
): Promise<void> {
  if (!isValidDocumentId(documentId)) return;
  try {
    const database = await getDatabase();
    const transaction = database.transaction(
      [PRINT_DRAFT_STORE, AI_CONVERSATION_STORE],
      'readwrite',
    );
    await transaction.objectStore(PRINT_DRAFT_STORE).delete(documentId);
    const conversationIds = await transaction
      .objectStore(AI_CONVERSATION_STORE)
      .index('by-document')
      .getAllKeys(documentId);
    await Promise.all(
      conversationIds.map((id) =>
        transaction.objectStore(AI_CONVERSATION_STORE).delete(id),
      ),
    );
    await transaction.done;
  } catch {
    // Document deletion remains successful even if optional productivity data is unavailable.
  }
}

async function getDatabase(): Promise<IDBPDatabase<ProductivityDatabase>> {
  if (!databasePromise) {
    databasePromise = openDB<ProductivityDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(PRINT_DRAFT_STORE)) {
          database.createObjectStore(PRINT_DRAFT_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(AI_CONVERSATION_STORE)) {
          const store = database.createObjectStore(AI_CONVERSATION_STORE, {
            keyPath: 'id',
          });
          store.createIndex('by-document', 'documentId');
        }
      },
    });
  }
  return databasePromise;
}

function sanitizePrintDraft(
  value: unknown,
  expectedDocumentId: string,
): PrintDraftRecord | null {
  if (!isRecord(value) || !isValidDocumentId(expectedDocumentId)) return null;
  if (
    value.documentId !== expectedDocumentId ||
    typeof value.sourceFingerprint !== 'string' ||
    typeof value.editorStateJson !== 'string' ||
    value.editorStateJson.length > 5_000_000 ||
    !notesPrintLayouts.includes(value.layout as (typeof notesPrintLayouts)[number]) ||
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
    documentId: expectedDocumentId,
    sourceFingerprint: value.sourceFingerprint.slice(0, 256),
    sourceModelVersion:
      typeof value.sourceModelVersion === 'number' &&
      Number.isInteger(value.sourceModelVersion) &&
      value.sourceModelVersion > 0
        ? value.sourceModelVersion
        : 1,
    editorStateJson: value.editorStateJson,
    layout: value.layout as PrintDraftRecord['layout'],
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
