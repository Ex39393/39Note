import {
  deleteDocumentStateStrict,
  deleteLibraryEntitiesStrict,
  getBackupDocumentDataStrict,
  getCollectionsByIds,
  getTagsByIds,
  listLibraryDocuments,
  loadStoredDocumentSource,
  restoreBackupDocument,
  restoreDownloadedPaperBundle,
  type LibraryDocument,
} from '../services/annotationPersistence.ts';
import {
  captureRenderedPrintPdfStorageIdentity,
  deleteProductivityDocumentDataStrict,
  getProductivityBackupDataStrict,
  loadRenderedPrintPdf,
  restoreRenderedPrintPdf,
  restoreRenderedPrintPdfIfUnchanged,
  restoreProductivityBackupData,
  type RenderedPrintPdfStorageIdentity,
} from '../services/productivityPersistence.ts';
import type { CollectionRecord, TagRecord } from '../types/library.ts';
import type { DocumentType, StoredDocumentSource } from '../types/document.ts';
import { compareCanonicalStrings, sha256Hex, stableStringify } from './hash.ts';
import {
  documentValue,
  validatedDocumentState,
  validatedProductivityRecord,
} from './localAdapter.ts';
import type {
  LocalPaperPackage,
  PaperDownloadResult,
  PaperSyncState,
  PaperWriterMetadata,
} from './paperTypes.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type LocalSyncSourceArtifact,
  type SyncPdfDescriptor,
  type SyncSourceArtifactDescriptor,
  type SyncEntityKind,
  type SyncEntityRecord,
  type SyncEntityVersion,
  type SyncSnapshot,
  type SyncTombstone,
} from './types.ts';

export interface LocalPaperMetadata {
  documentId: string;
  displayName: string;
  documentType: DocumentType;
  hasStoredSource: boolean;
  hasStoredPdf: boolean;
  updatedAt: number;
}

export interface AppliedPaperDownload {
  changedDocumentIds: string[];
  deletedDocumentIds: string[];
  /** Restores the exact pre-apply local records if sync-baseline settlement fails. */
  rollback(): Promise<void>;
  /** Makes the already-committed result observable after its sync baseline commits. */
  publish(): void;
}

export interface PaperDownloadApplyOptions {
  /** Local artifact identity captured before choosing the Download merge. */
  expectedRenderedPrintPdf: RenderedPrintPdfStorageIdentity;
}

export async function finalizeAppliedPaperDownload(
  application: AppliedPaperDownload,
  settleSyncBaseline: () => Promise<void>,
): Promise<void> {
  try {
    await settleSyncBaseline();
  } catch (error) {
    await rollbackAfterFailure(application.rollback, error);
  }
  application.publish();
}

export class BrowserPaperLocalAdapter {
  async listLocalPapers(): Promise<LocalPaperMetadata[]> {
    return (await listLibraryDocuments()).map((document) => ({
      documentId: document.documentId,
      displayName: paperDisplayName(document),
      documentType: document.documentType,
      hasStoredSource: document.hasStoredSource,
      hasStoredPdf: document.hasStoredPdf,
      updatedAt: document.updatedAt,
    }));
  }

  /**
   * Idempotent cleanup used when a Download local commit is superseded by an
   * intentional Remove-from-this-device transition. It emits no sync dirt.
   */
  async ensurePaperAbsent(documentId: string, signal?: AbortSignal): Promise<void> {
    await deleteProductivityDocumentDataStrict(documentId, signal);
    await deleteDocumentStateStrict(documentId, signal);
  }

  captureRenderedPrintPdfStorageIdentity(
    documentId: string,
  ): Promise<RenderedPrintPdfStorageIdentity> {
    return captureRenderedPrintPdfStorageIdentity(documentId);
  }

  async hasReusableStoredSourcePdf(
    documentId: string,
    state: PaperSyncState,
    expected?: SyncPdfDescriptor & { fileId: string },
  ): Promise<boolean> {
    return this.hasReusableStoredSource(
      documentId,
      state,
      expected
        ? {
            ...expected,
            documentType: 'pdf',
            mimeType: 'application/pdf',
            driveRole: 'paper-source-pdf',
          }
        : undefined,
    );
  }

  async hasReusableStoredSource(
    documentId: string,
    state: PaperSyncState,
    expected?: SyncSourceArtifactDescriptor & { fileId: string },
  ): Promise<boolean> {
    const fingerprint =
      state.sourceFingerprints?.source ??
      (expected?.documentType === 'pdf' ? state.pdfFingerprints.source : undefined);
    if (
      !expected ||
      !fingerprint ||
      fingerprint.sha256 !== expected.sha256 ||
      fingerprint.size !== expected.size
    ) {
      return false;
    }
    const existing = await loadStoredDocumentSource(documentId);
    return Boolean(
      existing &&
      existing.documentType === expected.documentType &&
      existing.mimeType === expected.mimeType &&
      existing.sha256 === expected.sha256 &&
      existing.size === expected.size &&
      existing.size === fingerprint.size &&
      existing.lastModified === fingerprint.lastModified &&
      existing.storedAt === fingerprint.storedAt,
    );
  }

  async createPaperPackage(
    documentId: string,
    state: PaperSyncState,
    writer: PaperWriterMetadata,
  ): Promise<LocalPaperPackage> {
    const documents = await getBackupDocumentDataStrict([documentId]);
    if (documents.length !== 1) {
      throw new Error('The selected local paper is unavailable.');
    }
    const document = documents[0];
    const [productivity, renderedPrintPdf] = await Promise.all([
      getProductivityBackupDataStrict([documentId]).then((records) => records[0]),
      loadRenderedPrintPdf(documentId),
    ]);
    if (!productivity)
      throw new Error('The selected paper productivity data is unavailable.');
    const [relevantCollections, relevantTags] = await Promise.all([
      getCollectionsByIds(document.state.collectionIds),
      getTagsByIds(document.state.tagIds),
    ]);
    const entities: SyncEntityRecord[] = [];
    await addEntity(
      entities,
      state,
      'document',
      documentId,
      documentValue(document.state),
      Math.max(
        document.state.updatedAt,
        document.state.lastReadAt ?? 0,
        document.state.pinnedAt ?? 0,
      ),
    );
    for (const annotation of document.state.annotations) {
      await addEntity(
        entities,
        state,
        'annotation',
        annotation.id,
        annotation,
        annotation.updatedAt,
        documentId,
      );
    }
    for (const annotation of document.state.officeAnnotations) {
      await addEntity(
        entities,
        state,
        'annotation',
        annotation.id,
        annotation,
        annotation.updatedAt,
        documentId,
      );
    }
    for (const anchor of document.state.noteAnchors) {
      await addEntity(
        entities,
        state,
        'note-anchor',
        anchor.id,
        anchor,
        anchor.updatedAt,
        documentId,
      );
    }
    for (const note of document.state.notes) {
      await addEntity(
        entities,
        state,
        'note',
        note.id,
        note,
        note.updatedAt,
        documentId,
      );
    }
    for (const entry of document.state.glossaryEntries) {
      await addEntity(
        entities,
        state,
        'glossary',
        entry.glossaryEntryId,
        entry,
        entry.createdAt,
        documentId,
      );
    }
    if (document.state.readingPosition) {
      await addEntity(
        entities,
        state,
        'reading-position',
        documentId,
        document.state.readingPosition,
        document.state.readingPosition.updatedAt,
        documentId,
      );
    }
    if (
      document.state.documentReadingPosition &&
      document.state.documentType !== 'pdf'
    ) {
      await addEntity(
        entities,
        state,
        'reading-position',
        documentId,
        document.state.documentReadingPosition,
        document.state.updatedAt,
        documentId,
      );
    }
    for (const collection of relevantCollections) {
      await addEntity(
        entities,
        state,
        'collection',
        collection.id,
        collection,
        collection.updatedAt,
        documentId,
      );
    }
    for (const tag of relevantTags) {
      await addEntity(entities, state, 'tag', tag.id, tag, tag.updatedAt, documentId);
    }
    if (productivity.printDraft) {
      await addEntity(
        entities,
        state,
        'print-draft',
        documentId,
        productivity.printDraft,
        productivity.printDraft.updatedAt,
        documentId,
      );
    }
    for (const conversation of productivity.aiConversations) {
      await addEntity(
        entities,
        state,
        'ai-conversation',
        conversation.id,
        conversation,
        conversation.updatedAt,
        documentId,
      );
    }

    const currentKeys = new Set(entities.map((entity) => entity.key));
    const tombstones = tombstonesForMissingEntities(state, currentKeys);
    let sourceArtifact: LocalSyncSourceArtifact | undefined;
    if (document.source) {
      const fingerprint = {
        size: document.source.size,
        lastModified: document.source.lastModified,
        storedAt: document.source.storedAt,
        sha256: document.source.sha256,
      };
      state.sourceFingerprints ??= {};
      state.sourceFingerprints.source = fingerprint;
      if (document.source.documentType === 'pdf') {
        state.pdfFingerprints.source = fingerprint;
      }
      const fileId =
        state.driveFiles.sourceArtifactFileId ??
        (document.source.documentType === 'pdf'
          ? state.driveFiles.sourcePdfFileId
          : undefined);
      sourceArtifact = {
        ...document.source,
        ...(fileId ? { fileId } : {}),
      };
    }
    const sourcePdf =
      sourceArtifact?.documentType === 'pdf' ? sourceArtifact : undefined;
    const snapshot: SyncSnapshot = {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: Date.now(),
      generatedBy: writer.deviceId,
      entities: entities.sort((a, b) => compareCanonicalStrings(a.key, b.key)),
      tombstones,
      pdfs: sourcePdf ? [withoutSourceBlob(sourcePdf)] : [],
    };
    assertNoSecretsInSyncPayload(snapshot);
    return {
      documentId,
      displayName:
        document.state.displayTitle ||
        stripDocumentExtension(document.state.originalFileName),
      snapshot,
      ...(sourceArtifact ? { sourceArtifact } : {}),
      ...(sourceArtifact ? { sourceArtifactHashVerified: true } : {}),
      ...(sourcePdf ? { sourcePdf } : {}),
      ...(sourcePdf ? { sourcePdfHashVerified: true } : {}),
      ...(renderedPrintPdf ? { renderedPrintPdf } : {}),
      ...(renderedPrintPdf ? { renderedPrintPdfHashVerified: true } : {}),
      writer,
      deleted: false,
    };
  }

  /** Builds a document tombstone package after the local paper has been removed. */
  createDeletedPaperPackage(
    documentId: string,
    state: PaperSyncState,
    writer: PaperWriterMetadata,
  ): LocalPaperPackage {
    const tombstones = tombstonesForMissingEntities(state, new Set());
    const snapshot: SyncSnapshot = {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: Date.now(),
      generatedBy: writer.deviceId,
      entities: [],
      tombstones,
      pdfs: [],
    };
    assertNoSecretsInSyncPayload(snapshot);
    return {
      documentId,
      displayName: state.displayName ?? 'Deleted paper',
      snapshot,
      writer,
      deleted: true,
    };
  }

  /** Applies exactly one selected package and never deletes unrelated local papers. */
  async applyDownloadedPaper(
    result: PaperDownloadResult,
    signal?: AbortSignal,
    options?: PaperDownloadApplyOptions,
  ): Promise<AppliedPaperDownload> {
    signal?.throwIfAborted();
    const records = result.snapshot.entities.filter((entity) => {
      const id = entity.kind === 'document' ? entity.id : entity.documentId;
      return id === result.documentId;
    });
    const [previousDocuments, previousProductivityRecords, previousRenderedPrintPdf] =
      await Promise.all([
        getBackupDocumentDataStrict([result.documentId]),
        getProductivityBackupDataStrict([result.documentId]),
        loadRenderedPrintPdf(result.documentId),
      ]);
    const previousDocument = previousDocuments[0];
    const previousProductivity = previousProductivityRecords[0];
    if (!previousProductivity) {
      throw new Error('The prior local productivity state could not be staged.');
    }
    const documentEntity = records.find((entity) => entity.kind === 'document');
    if (!documentEntity) {
      const rollback = createPaperDownloadRollback({
        documentId: result.documentId,
        previousDocument,
        previousProductivity,
        previousRenderedPrintPdf,
        createdCollectionIds: [],
        createdTagIds: [],
      });
      try {
        await deleteProductivityDocumentDataStrict(result.documentId, signal);
        await deleteDocumentStateStrict(result.documentId, signal);
      } catch (error) {
        await rollbackAfterFailure(rollback, error);
      }
      return createAppliedPaperDownload({
        changedDocumentIds: [],
        deletedDocumentIds: previousDocument ? [result.documentId] : [],
        rollback,
      });
    }
    const state = validatedDocumentState(result.documentId, records);
    const productivity = validatedProductivityRecord(result.documentId, records);
    const expectedSource = result.cloud.sourceArtifact;
    let source: StoredDocumentSource | null = result.sourceArtifact ?? null;
    if (expectedSource && !source) {
      const existing = await loadStoredDocumentSource(result.documentId);
      const fingerprint =
        result.reusedSourceArtifactFingerprint ?? result.reusedSourcePdfFingerprint;
      if (
        existing &&
        existing.documentType === expectedSource.documentType &&
        existing.mimeType === expectedSource.mimeType &&
        existing.size === expectedSource.size &&
        ((fingerprint &&
          fingerprint.sha256 === expectedSource.sha256 &&
          fingerprint.size === existing.size &&
          fingerprint.lastModified === existing.lastModified &&
          fingerprint.storedAt === existing.storedAt) ||
          existing.sha256 === expectedSource.sha256)
      ) {
        source = existing;
      }
    }
    if (expectedSource && !source)
      throw new Error('The selected paper source document is unavailable.');
    const collections = records
      .filter((entity) => entity.kind === 'collection')
      .map((entity) => entity.value as CollectionRecord);
    const tags = records
      .filter((entity) => entity.kind === 'tag')
      .map((entity) => entity.value as TagRecord);
    const [existingCollections, existingTags] = await Promise.all([
      getCollectionsByIds(collections.map(({ id }) => id)),
      getTagsByIds(tags.map(({ id }) => id)),
    ]);
    const existingCollectionIds = new Set(existingCollections.map(({ id }) => id));
    const existingTagIds = new Set(existingTags.map(({ id }) => id));
    const renderedPrintPdfMutation: RenderedPrintPdfMutation = {
      applied: false,
      value: null,
    };
    const rollback = createPaperDownloadRollback({
      documentId: result.documentId,
      previousDocument,
      previousProductivity,
      previousRenderedPrintPdf,
      renderedPrintPdfMutation,
      createdCollectionIds: collections
        .map(({ id }) => id)
        .filter((id) => !existingCollectionIds.has(id)),
      createdTagIds: tags.map(({ id }) => id).filter((id) => !existingTagIds.has(id)),
    });
    try {
      await restoreProductivityBackupData([productivity], false, signal);
      renderedPrintPdfMutation.value = result.renderedPrintPdf ?? null;
      renderedPrintPdfMutation.applied = await restoreRenderedPrintPdfIfUnchanged(
        result.documentId,
        options?.expectedRenderedPrintPdf ?? previousRenderedPrintPdf,
        result.renderedPrintPdf ?? null,
        false,
        signal,
      );
      if (
        !(await restoreDownloadedPaperBundle(state, source, collections, tags, signal))
      ) {
        throw new Error('The selected paper could not be stored locally.');
      }
      signal?.throwIfAborted();
    } catch (error) {
      await rollbackAfterFailure(rollback, error);
    }
    return createAppliedPaperDownload({
      changedDocumentIds: [result.documentId],
      deletedDocumentIds: [],
      rollback,
    });
  }
}

function createAppliedPaperDownload(options: {
  changedDocumentIds: string[];
  deletedDocumentIds: string[];
  rollback(): Promise<void>;
}): AppliedPaperDownload {
  let published = false;
  let rolledBack = false;
  return {
    changedDocumentIds: options.changedDocumentIds,
    deletedDocumentIds: options.deletedDocumentIds,
    async rollback() {
      if (rolledBack) return;
      await options.rollback();
      rolledBack = true;
    },
    publish() {
      if (published || rolledBack) return;
      published = true;
      window.dispatchEvent(
        new CustomEvent('39note:sync-applied', {
          detail: {
            changedDocumentIds: options.changedDocumentIds,
            deletedDocumentIds: options.deletedDocumentIds,
          },
        }),
      );
    },
  };
}

function createPaperDownloadRollback(options: {
  documentId: string;
  previousDocument: Awaited<ReturnType<typeof getBackupDocumentDataStrict>>[number];
  previousProductivity: Awaited<
    ReturnType<typeof getProductivityBackupDataStrict>
  >[number];
  previousRenderedPrintPdf: Awaited<ReturnType<typeof loadRenderedPrintPdf>>;
  renderedPrintPdfMutation?: RenderedPrintPdfMutation;
  createdCollectionIds: readonly string[];
  createdTagIds: readonly string[];
}): () => Promise<void> {
  return async () => {
    const operations: Promise<unknown>[] = [
      restoreProductivityBackupData([options.previousProductivity], false),
      options.previousDocument
        ? restoreBackupDocument(
            options.previousDocument.state,
            options.previousDocument.source,
            true,
            false,
          ).then((restored) => {
            if (!restored)
              throw new Error('The prior local paper could not be restored.');
          })
        : deleteDocumentStateStrict(options.documentId),
    ];
    if (options.renderedPrintPdfMutation?.applied) {
      operations.push(
        restoreRenderedPrintPdfIfUnchanged(
          options.documentId,
          options.renderedPrintPdfMutation.value,
          options.previousRenderedPrintPdf,
          false,
        ),
      );
    } else if (!options.renderedPrintPdfMutation) {
      operations.push(
        restoreRenderedPrintPdf(
          options.documentId,
          options.previousRenderedPrintPdf,
          false,
        ),
      );
    }
    if (options.createdCollectionIds.length || options.createdTagIds.length) {
      operations.push(
        deleteLibraryEntitiesStrict(
          options.createdCollectionIds,
          options.createdTagIds,
        ),
      );
    }
    const settlements = await Promise.allSettled(operations);
    const failures = settlements.flatMap((settlement) =>
      settlement.status === 'rejected' ? [settlement.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(
        failures,
        'The prior local paper could not be restored after a failed download apply.',
      );
    }
  };
}

interface RenderedPrintPdfMutation {
  applied: boolean;
  value: NonNullable<PaperDownloadResult['renderedPrintPdf']> | null;
}

async function rollbackAfterFailure(
  rollback: () => Promise<void>,
  originalError: unknown,
): Promise<never> {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      'The downloaded paper could not be applied or rolled back safely.',
    );
  }
  throw originalError;
}

async function addEntity(
  output: SyncEntityRecord[],
  state: PaperSyncState,
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

function tombstonesForMissingEntities(
  state: PaperSyncState,
  currentKeys: ReadonlySet<string>,
): SyncTombstone[] {
  const now = Date.now();
  const byKey = new Map(
    state.tombstones
      .filter((item) => !currentKeys.has(item.key))
      .map((item) => [item.key, item]),
  );
  for (const [key, version] of Object.entries(state.entityVersions)) {
    if (currentKeys.has(key) || byKey.has(key)) continue;
    const [kind, encodedDocumentId, encodedId] = key.split(':');
    byKey.set(key, {
      key,
      kind: kind as SyncEntityKind,
      id: decodeURIComponent(encodedId ?? ''),
      ...(encodedDocumentId
        ? { documentId: decodeURIComponent(encodedDocumentId) }
        : {}),
      deletedAt: Math.max(now, version.updatedAt + 1),
      deviceId: version.deviceId,
    });
  }
  return [...byKey.values()].sort((a, b) => compareCanonicalStrings(a.key, b.key));
}

function withoutSourceBlob(source: LocalSyncSourceArtifact) {
  return {
    documentId: source.documentId,
    fileName: source.fileName,
    mimeType: source.mimeType,
    size: source.size,
    lastModified: source.lastModified,
    storedAt: source.storedAt,
    sha256: source.sha256,
    ...(source.fileId ? { fileId: source.fileId } : {}),
  };
}

function paperDisplayName(document: LibraryDocument): string {
  return document.displayTitle || stripDocumentExtension(document.originalFileName);
}

function stripDocumentExtension(value: string): string {
  return value.replace(/\.(?:pdf|pptx|docx)$/iu, '').trim() || 'Paper';
}
