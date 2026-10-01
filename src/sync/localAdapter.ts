import {
  PERSISTENCE_SCHEMA_VERSION,
  deleteDocumentState,
  getBackupDocumentData,
  listCollections,
  listLibraryDocuments,
  listTags,
  loadStoredPdfFile,
  replaceLibraryEntities,
  restoreBackupDocument,
  validateBackupDocumentState,
  validateLibraryEntities,
  type PersistedDocumentState,
  type StoredPdfFile,
} from '../services/annotationPersistence.ts';
import {
  deleteProductivityDocumentData,
  getProductivityBackupData,
  restoreProductivityBackupData,
  sanitizeProductivityBackupData,
  type ProductivityBackupDocument,
} from '../services/productivityPersistence.ts';
import {
  clearAiConfigurationWithoutCredentials,
  loadAiConfiguration,
  loadDefaultPromptProfileId,
  loadPromptProfiles,
  saveAiConfigurationWithoutCredentials,
  saveCustomPromptProfiles,
  saveDefaultPromptProfileId,
} from '../ai/configuration.ts';
import type { AiPromptProfile } from '../ai/types.ts';
import type { CollectionRecord, TagRecord } from '../types/library.ts';
import { isDocumentType, type DocumentType } from '../types/document.ts';
import type { AiConversationRecord, PrintDraftRecord } from '../types/productivity.ts';
import { compareCanonicalStrings, sha256Hex, stableStringify } from './hash.ts';
import {
  deserializeSafeAiConfiguration,
  sanitizeSafeAiSettingsPayload,
  serializeSafeAiConfiguration,
} from './safeAiSettings.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type LocalSyncSnapshot,
  type SyncApplyResult,
  type SyncDeviceState,
  type SyncEntityKind,
  type SyncEntityRecord,
  type SyncEntityVersion,
  type SyncLocalAdapter,
  type SyncSnapshot,
} from './types.ts';

interface DocumentMetadataValue {
  schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  documentType: DocumentType;
  documentId: string;
  documentName: string;
  originalFileName: string;
  displayTitle: string;
  nextNoteNumber: number;
  collectionIds: string[];
  tagIds: string[];
  isPinned: boolean;
  pinnedAt?: number;
  lastReadAt?: number;
}

export class BrowserSyncLocalAdapter implements SyncLocalAdapter {
  async createSnapshot(state: SyncDeviceState): Promise<LocalSyncSnapshot> {
    const now = Date.now();
    const documents = await getBackupDocumentData();
    const productivity = await getProductivityBackupData(
      documents.map(({ state: document }) => document.documentId),
    );
    const entities: SyncEntityRecord[] = [];

    for (const { state: document } of documents) {
      await addEntity(
        entities,
        state,
        'document',
        document.documentId,
        documentValue(document),
        Math.max(document.updatedAt, document.lastReadAt ?? 0, document.pinnedAt ?? 0),
      );
      for (const annotation of document.annotations) {
        await addEntity(
          entities,
          state,
          'annotation',
          annotation.id,
          annotation,
          annotation.updatedAt,
          document.documentId,
        );
      }
      for (const annotation of document.officeAnnotations) {
        await addEntity(
          entities,
          state,
          'annotation',
          annotation.id,
          annotation,
          annotation.updatedAt,
          document.documentId,
        );
      }
      for (const anchor of document.noteAnchors) {
        await addEntity(
          entities,
          state,
          'note-anchor',
          anchor.id,
          anchor,
          anchor.updatedAt,
          document.documentId,
        );
      }
      for (const note of document.notes) {
        await addEntity(
          entities,
          state,
          'note',
          note.id,
          note,
          note.updatedAt,
          document.documentId,
        );
      }
      for (const entry of document.glossaryEntries) {
        await addEntity(
          entities,
          state,
          'glossary',
          entry.glossaryEntryId,
          entry,
          entry.createdAt,
          document.documentId,
        );
      }
      if (document.readingPosition) {
        await addEntity(
          entities,
          state,
          'reading-position',
          document.documentId,
          document.readingPosition,
          document.readingPosition.updatedAt,
          document.documentId,
        );
      }
      if (document.documentReadingPosition && document.documentType !== 'pdf') {
        await addEntity(
          entities,
          state,
          'reading-position',
          document.documentId,
          document.documentReadingPosition,
          document.updatedAt,
          document.documentId,
        );
      }
    }

    for (const collection of await listCollections()) {
      await addEntity(
        entities,
        state,
        'collection',
        collection.id,
        collection,
        collection.updatedAt,
      );
    }
    for (const tag of await listTags()) {
      await addEntity(entities, state, 'tag', tag.id, tag, tag.updatedAt);
    }
    for (const record of productivity) {
      if (record.printDraft) {
        await addEntity(
          entities,
          state,
          'print-draft',
          record.documentId,
          record.printDraft,
          record.printDraft.updatedAt,
          record.documentId,
        );
      }
      for (const conversation of record.aiConversations) {
        await addEntity(
          entities,
          state,
          'ai-conversation',
          conversation.id,
          conversation,
          conversation.updatedAt,
          record.documentId,
        );
      }
    }

    const configuration = loadAiConfiguration();
    if (configuration) {
      await addEntity(
        entities,
        state,
        'ai-configuration',
        'configuration',
        serializeSafeAiConfiguration(configuration),
        now,
      );
    }
    for (const profile of loadPromptProfiles().filter((item) => !item.builtIn)) {
      await addEntity(entities, state, 'prompt-profile', profile.id, profile, now);
    }
    await addEntity(
      entities,
      state,
      'default-prompt',
      'default',
      loadDefaultPromptProfileId(),
      now,
    );

    const currentKeys = new Set(entities.map((entity) => entity.key));
    const tombstonesByKey = new Map(
      state.tombstones
        .filter((item) => !currentKeys.has(item.key))
        .map((item) => [item.key, item]),
    );
    for (const [key, version] of Object.entries(state.entityVersions)) {
      if (currentKeys.has(key) || tombstonesByKey.has(key)) continue;
      const [kind, encodedDocumentId, encodedId] = key.split(':');
      tombstonesByKey.set(key, {
        key,
        kind: kind as SyncEntityKind,
        id: decodeURIComponent(encodedId ?? ''),
        ...(encodedDocumentId
          ? { documentId: decodeURIComponent(encodedDocumentId) }
          : {}),
        deletedAt: Math.max(now, version.updatedAt + 1),
        deviceId: state.deviceId,
      });
    }

    const priorPdfs = new Map(
      state.remoteSnapshot?.pdfs.map((pdf) => [pdf.documentId, pdf]) ?? [],
    );
    const pdfs = await Promise.all(
      documents
        .flatMap(({ pdf }) => (pdf ? [pdf] : []))
        .map(async (pdf) => {
          const cache = state.pdfFingerprints[pdf.documentId];
          const sha256 =
            cache &&
            cache.size === pdf.size &&
            cache.lastModified === pdf.lastModified &&
            cache.storedAt === pdf.storedAt
              ? cache.sha256
              : await sha256Hex(pdf.blob);
          state.pdfFingerprints[pdf.documentId] = {
            size: pdf.size,
            lastModified: pdf.lastModified,
            storedAt: pdf.storedAt,
            sha256,
          };
          const previous = priorPdfs.get(pdf.documentId);
          return {
            ...pdf,
            sha256,
            ...(previous?.sha256 === sha256 && previous.fileId
              ? { fileId: previous.fileId }
              : {}),
          };
        }),
    );

    const snapshot: LocalSyncSnapshot = {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: now,
      generatedBy: state.deviceId,
      entities: entities.sort((first, second) =>
        compareCanonicalStrings(first.key, second.key),
      ),
      tombstones: [...tombstonesByKey.values()].sort((first, second) =>
        compareCanonicalStrings(first.key, second.key),
      ),
      pdfs,
    };
    assertNoSecretsInSyncPayload(withoutPdfBlobs(snapshot));
    return snapshot;
  }

  async applySnapshot(
    snapshot: SyncSnapshot,
    availablePdfs: ReadonlyMap<string, StoredPdfFile>,
    signal?: AbortSignal,
  ): Promise<SyncApplyResult> {
    signal?.throwIfAborted();
    this.validateSnapshot(snapshot);
    const byDocument = groupEntitiesByDocument(snapshot.entities);
    const currentIds = new Set(
      (await listLibraryDocuments()).map((item) => item.documentId),
    );
    const nextIds = new Set(
      snapshot.entities
        .filter((entity) => entity.kind === 'document')
        .map((entity) => entity.id),
    );
    const changedDocumentIds: string[] = [];
    const deletedDocumentIds: string[] = [];

    const preparedDocuments: Array<{
      documentId: string;
      state: PersistedDocumentState;
      pdf: StoredPdfFile | null;
      productivity: ProductivityBackupDocument;
    }> = [];

    for (const [documentId, records] of byDocument) {
      signal?.throwIfAborted();
      const validated = validatedDocumentState(documentId, records);
      const expectedPdf = snapshot.pdfs.find((pdf) => pdf.documentId === documentId);
      const pdf = expectedPdf
        ? (availablePdfs.get(documentId) ?? (await loadStoredPdfFile(documentId)))
        : null;
      signal?.throwIfAborted();
      if (expectedPdf && !pdf) {
        throw new Error(`Original PDF for ${documentId} is unavailable.`);
      }
      const productivity = validatedProductivityRecord(documentId, records);
      preparedDocuments.push({ documentId, state: validated, pdf, productivity });
    }

    for (const documentId of currentIds) {
      signal?.throwIfAborted();
      if (nextIds.has(documentId)) continue;
      if (await deleteDocumentState(documentId, false, signal)) {
        deletedDocumentIds.push(documentId);
      }
      await deleteProductivityDocumentData(documentId, false, signal);
    }

    for (const prepared of preparedDocuments) {
      signal?.throwIfAborted();
      if (
        !(await restoreBackupDocument(
          prepared.state,
          prepared.pdf,
          true,
          false,
          signal,
        ))
      ) {
        throw new Error(`Could not restore cloud document ${prepared.documentId}.`);
      }
      changedDocumentIds.push(prepared.documentId);
    }

    for (const documentId of nextIds) {
      signal?.throwIfAborted();
      await deleteProductivityDocumentData(documentId, false, signal);
    }
    await restoreProductivityBackupData(
      preparedDocuments.map((document) => document.productivity),
      false,
      signal,
    );
    const collections = snapshot.entities
      .filter((entity) => entity.kind === 'collection')
      .map((entity) => entity.value as CollectionRecord);
    const tags = snapshot.entities
      .filter((entity) => entity.kind === 'tag')
      .map((entity) => entity.value as TagRecord);
    if (!(await replaceLibraryEntities(collections, tags, false, signal))) {
      throw new Error('Cloud collections or tags failed validation.');
    }
    signal?.throwIfAborted();
    applyAiSettings(snapshot.entities);
    return { changedDocumentIds, deletedDocumentIds };
  }

  validateSnapshot(snapshot: SyncSnapshot): void {
    const byDocument = groupEntitiesByDocument(snapshot.entities);
    for (const [documentId, records] of byDocument) {
      validatedDocumentState(documentId, records);
      validatedProductivityRecord(documentId, records);
    }
    const collections = snapshot.entities
      .filter((entity) => entity.kind === 'collection')
      .map((entity) => entity.value as CollectionRecord);
    const tags = snapshot.entities
      .filter((entity) => entity.kind === 'tag')
      .map((entity) => entity.value as TagRecord);
    if (!validateLibraryEntities(collections, tags)) {
      throw new Error('Cloud collections or tags failed validation.');
    }
    validatedAiSettings(snapshot.entities);
  }
}

async function addEntity(
  output: SyncEntityRecord[],
  state: SyncDeviceState,
  kind: SyncEntityKind,
  id: string,
  value: unknown,
  sourceUpdatedAt: number,
  documentId?: string,
): Promise<void> {
  const key = createSyncEntityKey(kind, id, documentId);
  const hash = await sha256Hex(stableStringify(value));
  const previous = state.entityVersions[key];
  const version: SyncEntityVersion =
    previous?.hash === hash
      ? previous
      : {
          updatedAt: Math.max(sourceUpdatedAt, previous ? previous.updatedAt + 1 : 0),
          deviceId: state.deviceId,
          hash,
        };
  output.push({ key, kind, id, ...(documentId ? { documentId } : {}), value, version });
}

export function documentValue(state: PersistedDocumentState): DocumentMetadataValue {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentType: state.documentType,
    documentId: state.documentId,
    documentName: state.documentName,
    originalFileName: state.originalFileName,
    displayTitle: state.displayTitle,
    nextNoteNumber: state.nextNoteNumber,
    collectionIds: state.collectionIds,
    tagIds: state.tagIds,
    isPinned: state.isPinned,
    ...(state.pinnedAt ? { pinnedAt: state.pinnedAt } : {}),
    ...(state.lastReadAt ? { lastReadAt: state.lastReadAt } : {}),
  };
}

function groupEntitiesByDocument(
  entities: readonly SyncEntityRecord[],
): Map<string, SyncEntityRecord[]> {
  const grouped = new Map<string, SyncEntityRecord[]>();
  for (const entity of entities) {
    const documentId = entity.kind === 'document' ? entity.id : entity.documentId;
    if (!documentId) continue;
    grouped.set(documentId, [...(grouped.get(documentId) ?? []), entity]);
  }
  return grouped;
}

function valuesFor(
  records: readonly SyncEntityRecord[],
  kind: SyncEntityKind,
): unknown[] {
  return records.filter((record) => record.kind === kind).map((record) => record.value);
}

export function validatedDocumentState(
  documentId: string,
  records: readonly SyncEntityRecord[],
): PersistedDocumentState {
  const documentEntity = records.find((entity) => entity.kind === 'document');
  if (!documentEntity || !isRecord(documentEntity.value)) {
    throw new Error(`Cloud document ${documentId} failed validation.`);
  }
  const documentType = cloudDocumentType(documentEntity.value);
  if (!documentType) {
    throw new Error(`Cloud document ${documentId} failed validation.`);
  }
  const annotations = valuesFor(records, 'annotation');
  const readingPosition = valuesFor(records, 'reading-position')[0];
  const rawState = {
    ...documentEntity.value,
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    documentType,
    documentId,
    annotations: documentType === 'pdf' ? annotations : [],
    officeAnnotations: documentType === 'pdf' ? [] : annotations,
    noteAnchors: valuesFor(records, 'note-anchor'),
    notes: valuesFor(records, 'note'),
    glossaryEntries: valuesFor(records, 'glossary'),
    ...(documentType === 'pdf'
      ? { readingPosition }
      : { documentReadingPosition: readingPosition }),
    updatedAt: Math.max(...records.map((entity) => entity.version.updatedAt)),
  };
  const validated = validateBackupDocumentState(rawState);
  if (!validated) throw new Error(`Cloud document ${documentId} failed validation.`);
  return validated;
}

/**
 * Split sync entities predate format-generic document metadata. Missing or
 * pre-schema-8 type metadata can therefore describe only a PDF. Current
 * schema metadata must carry an explicit, valid type so Office sources cannot
 * be smuggled through the legacy PDF default.
 */
function cloudDocumentType(value: Record<string, unknown>): DocumentType | null {
  if (value.schemaVersion === PERSISTENCE_SCHEMA_VERSION) {
    return isDocumentType(value.documentType) ? value.documentType : null;
  }
  const isLegacySchema =
    value.schemaVersion === undefined ||
    (typeof value.schemaVersion === 'number' &&
      Number.isInteger(value.schemaVersion) &&
      value.schemaVersion >= 1 &&
      value.schemaVersion < PERSISTENCE_SCHEMA_VERSION);
  if (!isLegacySchema) return null;
  return value.documentType === undefined || value.documentType === 'pdf'
    ? 'pdf'
    : null;
}

export function validatedProductivityRecord(
  documentId: string,
  records: readonly SyncEntityRecord[],
): ProductivityBackupDocument {
  const candidate = {
    documentId,
    printDraft:
      (valuesFor(records, 'print-draft')[0] as PrintDraftRecord | undefined) ?? null,
    aiConversations: valuesFor(records, 'ai-conversation') as AiConversationRecord[],
  };
  const validated = sanitizeProductivityBackupData(candidate, documentId);
  if (!validated) throw new Error('Cloud productivity data failed validation.');
  return validated;
}

function validatedAiSettings(entities: readonly SyncEntityRecord[]) {
  const configuration =
    entities.find((entity) => entity.kind === 'ai-configuration')?.value ?? null;
  const customPromptProfiles = entities
    .filter((entity) => entity.kind === 'prompt-profile')
    .map((entity) => entity.value);
  const defaultPromptProfileId = entities.find(
    (entity) => entity.kind === 'default-prompt',
  )?.value;
  const safe = sanitizeSafeAiSettingsPayload({
    configuration,
    customPromptProfiles,
    defaultPromptProfileId,
  });
  if (!safe) throw new Error('Cloud AI settings failed validation.');
  return safe;
}

function applyAiSettings(entities: readonly SyncEntityRecord[]): void {
  const safe = validatedAiSettings(entities);
  const config = deserializeSafeAiConfiguration(safe.configuration);
  if (config) saveAiConfigurationWithoutCredentials(config, false);
  else clearAiConfigurationWithoutCredentials(false);
  saveCustomPromptProfiles(safe.customPromptProfiles as AiPromptProfile[], false);
  saveDefaultPromptProfileId(safe.defaultPromptProfileId, false);
}

function withoutPdfBlobs(snapshot: LocalSyncSnapshot): SyncSnapshot {
  return {
    ...snapshot,
    pdfs: snapshot.pdfs.map((pdf) => ({
      documentId: pdf.documentId,
      fileName: pdf.fileName,
      mimeType: pdf.mimeType,
      size: pdf.size,
      lastModified: pdf.lastModified,
      storedAt: pdf.storedAt,
      sha256: pdf.sha256,
      ...(pdf.fileId ? { fileId: pdf.fileId } : {}),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
