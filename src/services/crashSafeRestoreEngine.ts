import type { DBSchema, IDBPDatabase } from 'idb';
import type { StoredRenderedPrintPdf } from '../types/productivity.ts';
import type { StoredDocumentSource } from '../types/document.ts';
import type { CollectionRecord } from '../types/library.ts';
import { validateStoredRenderedPrintPdf } from '../print/renderedPrintPdf.ts';
import { compareCanonicalStrings } from '../sync/hash.ts';
import {
  ANNOTATION_DATABASE_VERSION,
  createDurableRestoreOperation,
  loadDurableRestoreOperation,
  transitionDurableRestoreOperation,
  upgradeAnnotationDatabaseSchema,
  validateBackupDocumentState,
  validateLibraryEntities,
  type PersistedDocumentState,
} from './annotationPersistence.ts';
import { validateStoredDocumentSource } from './documentSourceValidation.ts';
import { openDatabaseWithLifecycleSafety } from './indexedDbLifecycle.ts';
import {
  BACKUP_FORMAT_VERSION,
  parseBackupManifest,
  type BackupManifest,
  type RestorePreview,
} from './libraryBackup.ts';
import {
  PRODUCTIVITY_DATABASE_VERSION,
  sanitizeProductivityBackupData,
  upgradeProductivityDatabaseSchema,
  type ProductivityBackupDocument,
} from './productivityPersistence.ts';
import { fingerprintRestoreValue } from './restoreFingerprint.ts';
import {
  RESTORE_ACTION_STORE,
  RESTORE_OPERATION_STORE,
  RESTORE_SNAPSHOT_STORE,
  WorkspaceRestoreBarrierError,
  canTransitionRestorePhase,
  isDurableRestoreOperation,
  isRestoreEnginePlanSummary,
  isRestoreJournalAction,
  isRestoreJournalSnapshot,
  type DurableRestoreOperation,
  type RestoreCollisionResolution,
  type RestoreCommitEvidenceV1,
  type RestoreEngineActionDescriptor,
  type RestoreEngineActionKind,
  type RestoreEngineDatabase,
  type RestoreEngineDocumentDecision,
  type RestoreEnginePlanSummaryV1,
  type RestoreJournalActionV1,
  type RestoreJournalSnapshotV1,
} from './restoreSafety.ts';
import {
  PERSONAL_ANNOTATION_DATABASE_NAME,
  PERSONAL_PRODUCTIVITY_DATABASE_NAME,
  scopedDatabaseName,
} from './temporaryWorkspace.ts';
import {
  assertWorkspaceRestoreLease,
  currentWorkspaceRestoreIdentity,
  withExclusiveWorkspaceRestoreLease,
  type WorkspaceRestoreLease,
} from './workspaceRestoreLock.ts';

const DOCUMENT_STATE_STORE = 'document-states';
const SOURCE_STORE = 'pdf-files';
const COLLECTION_STORE = 'collections';
const PRINT_DRAFT_STORE = 'print-drafts';
const RENDERED_PRINT_PDF_STORE = 'rendered-print-pdfs';
const AI_CONVERSATION_STORE = 'ai-conversations';

type RecordSlot =
  { readonly present: false } | { readonly present: true; readonly value: unknown };

interface AnnotationDocumentPayload {
  state: RecordSlot;
  source: RecordSlot;
}

interface AnnotationCollectionPayload {
  collection: RecordSlot;
}

interface ProductivityDocumentPayload {
  printDraft: RecordSlot;
  renderedPrintPdf: RecordSlot;
  aiConversations: unknown[];
}

type RestoreActionPayload =
  AnnotationDocumentPayload | AnnotationCollectionPayload | ProductivityDocumentPayload;

interface RuntimeRestoreAction {
  descriptor: RestoreEngineActionDescriptor;
  before: RestoreActionPayload;
  target: RestoreActionPayload;
}

interface FrozenRestoreDocument {
  state: PersistedDocumentState;
  source: StoredDocumentSource | null;
  renderedPrintPdf: StoredRenderedPrintPdf | null;
  productivity: ProductivityBackupDocument | null;
}

interface FrozenRestoreInput {
  manifest: BackupManifest;
  documents: FrozenRestoreDocument[];
  collections: CollectionRecord[];
  manifestFingerprint: string;
}

interface PreparedRestorePlan {
  operation: DurableRestoreOperation;
  summary: RestoreEnginePlanSummaryV1;
  actions: RuntimeRestoreAction[];
  imported: number;
  created: number;
  replaced: number;
  skipped: number;
}

interface RestoreEngineAnnotationDatabase extends DBSchema {
  [DOCUMENT_STATE_STORE]: { key: string; value: unknown };
  [SOURCE_STORE]: { key: string; value: unknown };
  [COLLECTION_STORE]: { key: string; value: unknown };
  [RESTORE_OPERATION_STORE]: { key: string; value: DurableRestoreOperation };
  [RESTORE_SNAPSHOT_STORE]: { key: string; value: unknown };
  [RESTORE_ACTION_STORE]: { key: string; value: unknown };
}

interface RestoreEngineProductivityDatabase extends DBSchema {
  [PRINT_DRAFT_STORE]: { key: string; value: unknown };
  [RENDERED_PRINT_PDF_STORE]: { key: string; value: unknown };
  [AI_CONVERSATION_STORE]: {
    key: string;
    value: unknown;
    indexes: { 'by-document': string };
  };
  [RESTORE_SNAPSHOT_STORE]: { key: string; value: unknown };
  [RESTORE_ACTION_STORE]: { key: string; value: unknown };
}

interface RestoreEngineDatabases {
  annotation: IDBPDatabase<RestoreEngineAnnotationDatabase>;
  productivity: IDBPDatabase<RestoreEngineProductivityDatabase>;
}

interface RestoreObjectStoreLike {
  get(key: string): Promise<unknown>;
  put(value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  index?(name: string): { getAllKeys(query: string): Promise<IDBValidKey[]> };
}

interface RestoreTransactionLike {
  objectStore(name: string): RestoreObjectStoreLike;
  readonly done: Promise<void>;
  abort(): void;
}

export type RestoreFailurePoint =
  | 'after-plan-validation'
  | 'after-operation-created'
  | 'before-snapshot-transaction'
  | 'after-snapshot-before-action-marker'
  | 'after-snapshot-transaction'
  | 'after-prepared'
  | 'before-action-transaction'
  | 'after-live-write-before-action-marker'
  | 'after-action-transaction'
  | 'before-commit-verification'
  | 'after-commit-verification'
  | 'after-commit-marker'
  | 'before-rollback-action'
  | 'after-rollback-write-before-marker'
  | 'after-rollback-action'
  | 'after-productivity-cleanup'
  | 'before-final-cleanup-transaction'
  | 'after-evidence-delete-before-final-barrier';

export interface RestoreFailureContext {
  operationId: string;
  phase: string;
  actionId?: string;
  actionKind?: RestoreEngineActionKind;
  targetKey?: string;
}

export type RestoreFailureInjector = (
  point: RestoreFailurePoint,
  context: Readonly<RestoreFailureContext>,
) => void;

export type CrashSafeRestoreProgressPhase =
  | 'validation'
  | 'preparation'
  | 'restoration'
  | 'verification'
  | 'rollback'
  | 'completion';

export interface CrashSafeRestoreProgress {
  phase: CrashSafeRestoreProgressPhase;
  completed?: number;
  total?: number;
}

export interface CrashSafeRestoreRequest {
  preview: RestorePreview;
  /** Required for every incoming document already present in this workspace. */
  collisionResolutions?: Readonly<Record<string, 'replace' | 'skip'>>;
  /**
   * Production Keep/Replace policy. It is resolved against the records read
   * under the exclusive restore lease, not the earlier UI preview.
   */
  collisionPolicy?: 'keep-existing' | 'replace-existing';
  signal?: AbortSignal;
  onProgress?(progress: Readonly<CrashSafeRestoreProgress>): void;
  /** Test-only deterministic failure boundary; never wired to the application. */
  failureInjector?: RestoreFailureInjector;
  /** Test-only stable operation identity. */
  operationId?: string;
}

export interface CrashSafeRestoreResult {
  operationId: string | null;
  imported: number;
  created: number;
  replaced: number;
  skipped: number;
  beforeFingerprint: string;
  targetFingerprint: string;
  phase: 'no-op' | 'publication-hold';
}

export interface CrashSafeRecoveryResult {
  operationId: string | null;
  outcome: 'none' | 'rolled-back' | 'publication-hold';
}

/** A test can throw this error to model abrupt process death without catch cleanup. */
export class SimulatedRestoreCrashError extends Error {
  constructor(message = 'Synthetic restore interruption.') {
    super(message);
    this.name = 'SimulatedRestoreCrashError';
  }
}

export class RestoreRecoveryProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRecoveryProofError';
  }
}

/** Production restore entrypoint. Validation and collision resolution finish
 * under exclusive workspace ownership before the first durable mutation. */
export async function runCrashSafeRestore(
  request: CrashSafeRestoreRequest,
): Promise<CrashSafeRestoreResult> {
  // Capture every caller-controlled input before any callback or asynchronous
  // boundary. The UI preview and collision policy cannot change underneath a
  // queued exclusive restore.
  const executionRequest = Object.freeze({
    preview: structuredClone(request.preview),
    collisionResolutions: request.collisionResolutions
      ? structuredClone(request.collisionResolutions)
      : undefined,
    collisionPolicy: request.collisionPolicy,
    signal: request.signal,
    onProgress: request.onProgress,
    failureInjector: request.failureInjector,
    operationId: request.operationId ?? crypto.randomUUID(),
  } satisfies CrashSafeRestoreRequest);
  if (executionRequest.collisionPolicy && executionRequest.collisionResolutions) {
    throw new Error('Choose either a restore collision policy or exact decisions.');
  }
  reportProgress(executionRequest, 'validation');
  executionRequest.signal?.throwIfAborted();
  return withExclusiveWorkspaceRestoreLease(
    async (lease) =>
      withRestoreEngineDatabases(lease, async (databases) => {
        executionRequest.signal?.throwIfAborted();
        const existing = await loadDurableRestoreOperation(lease.workspaceId);
        if (existing) {
          throw new WorkspaceRestoreBarrierError(
            'An existing restore operation requires recovery or review.',
            existing,
          );
        }

        const operationId = executionRequest.operationId!;
        const frozen = await validateAndFreezeRestoreInput(executionRequest.preview);
        executionRequest.signal?.throwIfAborted();
        const plan = await prepareRestorePlan(
          operationId,
          frozen,
          executionRequest.collisionResolutions ?? {},
          executionRequest.collisionPolicy,
          lease,
          databases,
        );
        executionRequest.signal?.throwIfAborted();
        invokeFailure(executionRequest.failureInjector, 'after-plan-validation', {
          operationId,
          phase: 'preparing',
        });

        if (plan.actions.length === 0) {
          reportProgress(executionRequest, 'completion', 0, 0);
          return {
            operationId: null,
            imported: plan.imported,
            created: plan.created,
            replaced: plan.replaced,
            skipped: plan.skipped,
            beforeFingerprint: plan.summary.beforeFingerprint,
            targetFingerprint: plan.summary.targetFingerprint,
            phase: 'no-op',
          };
        }

        reportProgress(executionRequest, 'preparation', 0, plan.actions.length);
        executionRequest.signal?.throwIfAborted();
        await createDurableRestoreOperation(plan.operation, lease);
        try {
          invokeFailure(executionRequest.failureInjector, 'after-operation-created', {
            operationId,
            phase: 'preparing',
          });
          for (const [index, action] of plan.actions.entries()) {
            executionRequest.signal?.throwIfAborted();
            await captureRestoreAction(
              plan.operation,
              action,
              databases,
              executionRequest.failureInjector,
            );
            reportProgress(
              executionRequest,
              'preparation',
              index + 1,
              plan.actions.length,
            );
          }
          let operation = await transitionOperation(plan.operation, 'prepared', lease);
          invokeFailure(executionRequest.failureInjector, 'after-prepared', {
            operationId,
            phase: operation.phase,
          });

          operation = await transitionOperation(operation, 'applying', lease);
          reportProgress(executionRequest, 'restoration', 0, plan.actions.length);
          for (const [index, action] of plan.actions.entries()) {
            executionRequest.signal?.throwIfAborted();
            await applyRestoreAction(
              operation,
              action,
              databases,
              executionRequest.failureInjector,
            );
            reportProgress(
              executionRequest,
              'restoration',
              index + 1,
              plan.actions.length,
            );
          }
          operation = await transitionOperation(operation, 'verifying', lease);
          reportProgress(executionRequest, 'verification');
          executionRequest.signal?.throwIfAborted();
          invokeFailure(
            executionRequest.failureInjector,
            'before-commit-verification',
            {
              operationId,
              phase: operation.phase,
            },
          );
          await verifyAppliedTarget(operation, databases);
          invokeFailure(executionRequest.failureInjector, 'after-commit-verification', {
            operationId,
            phase: operation.phase,
          });
          executionRequest.signal?.throwIfAborted();

          const commitEvidence: RestoreCommitEvidenceV1 = {
            version: 1,
            operationId,
            planFingerprint: operation.enginePlan!.planFingerprint,
            targetFingerprint: operation.enginePlan!.targetFingerprint,
            verifiedAt: Date.now(),
          };
          operation = await transitionOperation(
            operation,
            'committed',
            lease,
            commitEvidence,
          );
          invokeFailure(executionRequest.failureInjector, 'after-commit-marker', {
            operationId,
            phase: operation.phase,
          });
          operation = await finishCommittedRestore(
            operation,
            lease,
            databases,
            executionRequest.failureInjector,
          );
          reportProgress(executionRequest, 'completion');
          return {
            operationId,
            imported: plan.imported,
            created: plan.created,
            replaced: plan.replaced,
            skipped: plan.skipped,
            beforeFingerprint: plan.summary.beforeFingerprint,
            targetFingerprint: plan.summary.targetFingerprint,
            phase: operation.phase as 'publication-hold',
          };
        } catch (error) {
          if (error instanceof SimulatedRestoreCrashError) throw error;
          try {
            reportProgress(executionRequest, 'rollback');
            await recoverOperationUnderLease(
              lease,
              databases,
              executionRequest.failureInjector,
            );
          } catch (recoveryError) {
            await retainFailedRecoveryBarrier(lease).catch(() => undefined);
            throw new AggregateError(
              [error, recoveryError],
              'Restore failed and exact recovery could not be proven. Durable recovery evidence was retained.',
            );
          }
          throw error;
        }
      }),
    executionRequest.signal,
  );
}

/** Idempotent recovery hook used by startup before React or sync services mount. */
export async function recoverCrashSafeRestore(
  failureInjector?: RestoreFailureInjector,
): Promise<CrashSafeRecoveryResult> {
  return withExclusiveWorkspaceRestoreLease(async (lease) =>
    withRestoreEngineDatabases(lease, (databases) =>
      recoverOperationUnderLease(lease, databases, failureInjector),
    ),
  );
}

async function recoverOperationUnderLease(
  lease: WorkspaceRestoreLease,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<CrashSafeRecoveryResult> {
  const operation = await loadDurableRestoreOperation(lease.workspaceId);
  if (!operation) return { operationId: null, outcome: 'none' };
  try {
    if (!operation.enginePlan || !isRestoreEnginePlanSummary(operation.enginePlan)) {
      throw new RestoreRecoveryProofError(
        'The durable operation is not a Phase C restore journal.',
      );
    }
    await assertFrozenPlanFingerprint(operation.enginePlan);
    if (operation.phase === 'publication-hold') {
      if (!operation.commitEvidence) {
        throw new RestoreRecoveryProofError(
          'A publication hold is missing immutable commit evidence.',
        );
      }
      return { operationId: operation.operationId, outcome: 'publication-hold' };
    }
    if (operation.commitEvidence) {
      await finishCommittedRestore(operation, lease, databases, failureInjector);
      return { operationId: operation.operationId, outcome: 'publication-hold' };
    }
    await rollbackUncommittedRestore(operation, lease, databases, failureInjector);
    return { operationId: operation.operationId, outcome: 'rolled-back' };
  } catch (error) {
    if (error instanceof SimulatedRestoreCrashError) throw error;
    await retainFailedRecoveryBarrier(lease).catch(() => undefined);
    throw error;
  }
}

async function validateAndFreezeRestoreInput(
  preview: RestorePreview,
): Promise<FrozenRestoreInput> {
  const manifest = parseBackupManifest(preview.manifest);
  if (!validateLibraryEntities(preview.collections)) {
    throw new Error('Backup Collection data contains invalid records.');
  }
  if (preview.documents.length !== manifest.documents.length) {
    throw new Error('The restore preview does not contain the complete manifest.');
  }
  const collections = structuredClone(preview.collections);
  const collectionIds = new Set(collections.map(({ id }) => id));
  const previewDocuments = new Map(
    preview.documents.map((document) => [document.state.documentId, document]),
  );
  if (previewDocuments.size !== preview.documents.length) {
    throw new Error('The restore preview contains duplicate documents.');
  }
  const productivityByDocument = new Map<string, ProductivityBackupDocument>();
  const incomingConversationOwners = new Map<string, string>();
  for (const rawRecord of preview.productivity) {
    if (productivityByDocument.has(rawRecord.documentId)) {
      throw new Error('The restore preview contains duplicate productivity records.');
    }
    const record = sanitizeProductivityBackupData(rawRecord, rawRecord.documentId);
    if (!record) throw new Error('Backup productivity data failed validation.');
    for (const conversation of record.aiConversations) {
      const prior = incomingConversationOwners.get(conversation.id);
      if (prior !== undefined) {
        throw new Error('Backup AI conversation identifiers are not unique.');
      }
      incomingConversationOwners.set(conversation.id, record.documentId);
    }
    productivityByDocument.set(record.documentId, structuredClone(record));
  }

  const documents: FrozenRestoreDocument[] = [];
  let annotationCount = 0;
  let noteCount = 0;
  let highlightCount = 0;
  let underlineCount = 0;
  let sourceCount = 0;
  let pdfCount = 0;
  let renderedPrintPdfCount = 0;
  let printDraftCount = 0;
  let aiConversationCount = 0;

  for (const manifestDocument of manifest.documents) {
    const rawDocument = previewDocuments.get(manifestDocument.documentId);
    if (!rawDocument) throw new Error('A manifest document is missing from restore.');
    const state = validateBackupDocumentState(rawDocument.state);
    if (!state || state.documentId !== manifestDocument.documentId) {
      throw new Error('A backup document record failed complete validation.');
    }
    if (state.collectionIds.some((id) => !collectionIds.has(id))) {
      throw new Error('A backup document references an unknown Collection.');
    }

    const source = rawDocument.source
      ? await validateStoredDocumentSource(
          rawDocument.source,
          manifestDocument.documentId,
          { allowLegacyPdf: true },
        )
      : null;
    if (
      Boolean(rawDocument.source) !== Boolean(source) ||
      (source && source.documentType !== state.documentType)
    ) {
      throw new Error('A backup source artifact failed content validation.');
    }
    if (manifest.backupFormatVersion >= BACKUP_FORMAT_VERSION) {
      const descriptor = manifestDocument.sourceArtifact;
      if (manifestDocument.hasStoredSource !== Boolean(source)) {
        throw new Error('Backup source presence does not match its manifest.');
      }
      if (
        source &&
        (!descriptor ||
          descriptor.documentId !== source.documentId ||
          descriptor.documentType !== source.documentType ||
          descriptor.mimeType !== source.mimeType ||
          descriptor.originalFileName !== source.fileName ||
          descriptor.sha256 !== source.sha256 ||
          descriptor.size !== source.size)
      ) {
        throw new Error('Backup source metadata does not match its verified bytes.');
      }
    } else if (
      manifestDocument.hasStoredPdf !== Boolean(source) ||
      (source && source.documentType !== 'pdf')
    ) {
      throw new Error('Legacy backup PDF metadata is inconsistent.');
    }

    const expectedPdf = source?.documentType === 'pdf' ? source : null;
    const previewPdf = rawDocument.pdf
      ? await validateStoredDocumentSource(
          rawDocument.pdf,
          manifestDocument.documentId,
          { allowLegacyPdf: true },
        )
      : null;
    if (
      Boolean(rawDocument.pdf) !== Boolean(previewPdf) ||
      Boolean(previewPdf) !== Boolean(expectedPdf) ||
      (previewPdf &&
        expectedPdf &&
        (await fingerprintRestoreValue(previewPdf)) !==
          (await fingerprintRestoreValue(expectedPdf)))
    ) {
      throw new Error('The deprecated PDF alias does not match the source artifact.');
    }

    const renderedPrintPdf = rawDocument.renderedPrintPdf
      ? await validateStoredRenderedPrintPdf(
          rawDocument.renderedPrintPdf,
          manifestDocument.documentId,
        )
      : null;
    if (Boolean(rawDocument.renderedPrintPdf) !== Boolean(renderedPrintPdf)) {
      throw new Error('A backup Print PDF failed content validation.');
    }
    const renderedDescriptor = manifestDocument.renderedPrintPdf;
    if (
      Boolean(renderedDescriptor) !== Boolean(renderedPrintPdf) ||
      (renderedDescriptor &&
        renderedPrintPdf &&
        (renderedDescriptor.documentId !== renderedPrintPdf.documentId ||
          renderedDescriptor.fileName !== renderedPrintPdf.fileName ||
          renderedDescriptor.mimeType !== renderedPrintPdf.mimeType ||
          renderedDescriptor.size !== renderedPrintPdf.size ||
          renderedDescriptor.sha256 !== renderedPrintPdf.sha256 ||
          renderedDescriptor.renderedFromDraftHash !==
            renderedPrintPdf.renderedFromDraftHash ||
          renderedDescriptor.createdAt !== renderedPrintPdf.createdAt ||
          renderedDescriptor.storedAt !== renderedPrintPdf.storedAt))
    ) {
      throw new Error('Backup Print PDF metadata does not match its verified bytes.');
    }

    const productivity = productivityByDocument.get(state.documentId) ?? null;
    if (Boolean(manifestDocument.productivityEntry) !== Boolean(productivity)) {
      throw new Error('Backup productivity presence does not match its manifest.');
    }

    annotationCount +=
      state.annotations.length + state.links.length + state.officeAnnotations.length;
    noteCount += state.notes.length;
    highlightCount +=
      state.annotations.filter(({ type }) => type === 'highlight').length +
      state.officeAnnotations.filter(({ markType }) => markType === 'highlight').length;
    underlineCount +=
      state.annotations.filter(({ type }) => type === 'underline').length +
      state.officeAnnotations.filter(({ markType }) => markType === 'underline').length;
    sourceCount += source ? 1 : 0;
    pdfCount += expectedPdf ? 1 : 0;
    renderedPrintPdfCount += renderedPrintPdf ? 1 : 0;
    printDraftCount += productivity?.printDraft ? 1 : 0;
    aiConversationCount += productivity?.aiConversations.length ?? 0;
    documents.push({
      state: structuredClone(state),
      source: source ? structuredClone(source) : null,
      renderedPrintPdf: renderedPrintPdf ? structuredClone(renderedPrintPdf) : null,
      productivity: productivity ? structuredClone(productivity) : null,
    });
  }

  if (productivityByDocument.size !== documents.filter((d) => d.productivity).length) {
    throw new Error('Backup productivity data references an unknown document.');
  }
  if (
    manifest.annotationCount !== annotationCount ||
    manifest.noteCount !== noteCount ||
    (manifest.printDraftCount ?? 0) !== printDraftCount ||
    (manifest.aiConversationCount ?? 0) !== aiConversationCount ||
    (manifest.backupFormatVersion === BACKUP_FORMAT_VERSION &&
      (manifest.renderedPrintPdfCount ?? 0) !== renderedPrintPdfCount) ||
    preview.sourceCount !== sourceCount ||
    preview.pdfCount !== pdfCount ||
    preview.highlightCount !== highlightCount ||
    preview.underlineCount !== underlineCount ||
    preview.noteCount !== noteCount ||
    preview.renderedPrintPdfCount !== renderedPrintPdfCount
  ) {
    throw new Error('Backup summary counts do not match the verified records.');
  }

  const frozen: FrozenRestoreInput = {
    manifest,
    documents: documents.sort((a, b) =>
      compareCanonicalStrings(a.state.documentId, b.state.documentId),
    ),
    collections: collections.sort((a, b) => compareCanonicalStrings(a.id, b.id)),
    manifestFingerprint: await fingerprintRestoreValue(manifest),
  };
  deepFreezeRestoreValue(frozen);
  return frozen;
}

async function prepareRestorePlan(
  operationId: string,
  input: FrozenRestoreInput,
  requestedResolutions: Readonly<Record<string, 'replace' | 'skip'>>,
  collisionPolicy: CrashSafeRestoreRequest['collisionPolicy'],
  lease: WorkspaceRestoreLease,
  databases: RestoreEngineDatabases,
): Promise<PreparedRestorePlan> {
  assertWorkspaceRestoreLease(lease, { requireExclusive: true });
  if (!isUuidV4(operationId)) {
    throw new Error('The restore operation identity is invalid.');
  }
  const resolutionEntries = Object.entries(requestedResolutions);
  if (
    resolutionEntries.some(
      ([documentId, resolution]) =>
        !input.documents.some((document) => document.state.documentId === documentId) ||
        (resolution !== 'replace' && resolution !== 'skip'),
    )
  ) {
    throw new Error('Restore collision decisions contain an unknown document.');
  }
  const resolutions = new Map(resolutionEntries);

  const actions: RuntimeRestoreAction[] = [];
  const decisions: RestoreEngineDocumentDecision[] = [];
  const activeCollectionIds = new Set<string>();
  let actionSequence = 0;
  let created = 0;
  let replaced = 0;
  let skipped = 0;

  const addAction = async (
    database: RestoreEngineDatabase,
    kind: RestoreEngineActionKind,
    targetKey: string,
    before: RestoreActionPayload,
    target: RestoreActionPayload,
  ): Promise<string | undefined> => {
    const [beforeFingerprint, targetFingerprint] = await Promise.all([
      fingerprintRestoreValue(before),
      fingerprintRestoreValue(target),
    ]);
    if (beforeFingerprint === targetFingerprint) return undefined;
    actionSequence += 1;
    const actionId = `${operationId}:action:${String(actionSequence).padStart(6, '0')}`;
    const descriptor: RestoreEngineActionDescriptor = {
      actionId,
      snapshotId: `${actionId}:snapshot`,
      database,
      kind,
      targetKey,
      beforeFingerprint,
      targetFingerprint,
    };
    actions.push({ descriptor, before, target });
    return actionId;
  };

  for (const document of input.documents) {
    const documentId = document.state.documentId;
    const beforeAnnotation = await readAnnotationDocumentPayload(
      databases.annotation,
      documentId,
    );
    const exists = beforeAnnotation.state.present;
    const requested =
      resolutions.get(documentId) ??
      (collisionPolicy === 'keep-existing'
        ? 'skip'
        : collisionPolicy === 'replace-existing'
          ? 'replace'
          : undefined);
    if (exists && !requested) {
      throw new Error(
        `Restore collision for ${documentId} requires an explicit replace or skip decision.`,
      );
    }
    if (!exists && resolutions.has(documentId)) {
      throw new Error(
        `Restore collision decision for ${documentId} is stale because the document is absent.`,
      );
    }
    const resolution: RestoreCollisionResolution = exists ? requested! : 'create';
    if (resolution === 'skip') {
      skipped += 1;
      decisions.push({ documentId, resolution });
      continue;
    }

    const beforeProductivity = await readProductivityDocumentPayload(
      databases.productivity,
      documentId,
    );
    if (
      resolution === 'create' &&
      (beforeAnnotation.source.present || hasProductivityRecords(beforeProductivity))
    ) {
      throw new Error(
        `Orphaned local records for ${documentId} prevent a safe create restore.`,
      );
    }
    await assertIncomingConversationIdsDoNotCollide(
      databases.productivity,
      document.productivity?.aiConversations ?? [],
      documentId,
    );

    const targetAnnotation: AnnotationDocumentPayload = {
      state: presentSlot(document.state),
      source: document.source ? presentSlot(document.source) : absentSlot(),
    };
    const incomingProductivity = document.productivity;
    const targetProductivity: ProductivityDocumentPayload = {
      printDraft: incomingProductivity
        ? incomingProductivity.printDraft
          ? presentSlot(incomingProductivity.printDraft)
          : absentSlot()
        : cloneSlot(beforeProductivity.printDraft),
      renderedPrintPdf: document.renderedPrintPdf
        ? presentSlot(document.renderedPrintPdf)
        : absentSlot(),
      aiConversations: incomingProductivity
        ? sortConversations(incomingProductivity.aiConversations)
        : structuredClone(beforeProductivity.aiConversations),
    };

    const annotationActionId = await addAction(
      'annotation',
      'annotation-document',
      documentId,
      beforeAnnotation,
      targetAnnotation,
    );
    const productivityActionId = await addAction(
      'productivity',
      'productivity-document',
      documentId,
      beforeProductivity,
      targetProductivity,
    );
    decisions.push({
      documentId,
      resolution,
      ...(annotationActionId ? { annotationActionId } : {}),
      ...(productivityActionId ? { productivityActionId } : {}),
    });
    for (const collectionId of document.state.collectionIds) {
      activeCollectionIds.add(collectionId);
    }
    if (resolution === 'create') created += 1;
    else replaced += 1;
  }

  const collectionById = new Map(
    input.collections.map((collection) => [collection.id, collection] as const),
  );
  const collectionActionIds: string[] = [];
  for (const collectionId of [...activeCollectionIds].sort(compareCanonicalStrings)) {
    const targetCollection = collectionById.get(collectionId);
    if (!targetCollection) {
      throw new Error('The frozen plan references an unknown Collection.');
    }
    const before = await readAnnotationCollectionPayload(
      databases.annotation,
      collectionId,
    );
    // Released restore semantics preserve an existing Collection with the same ID.
    if (before.collection.present) continue;
    const actionId = await addAction(
      'annotation',
      'annotation-collection',
      collectionId,
      before,
      { collection: presentSlot(targetCollection) },
    );
    if (actionId) collectionActionIds.push(actionId);
  }

  actions.sort((first, second) =>
    compareCanonicalStrings(
      `${first.descriptor.database}:${first.descriptor.kind}:${first.descriptor.targetKey}`,
      `${second.descriptor.database}:${second.descriptor.kind}:${second.descriptor.targetKey}`,
    ),
  );
  const descriptors = actions.map(({ descriptor }) => descriptor);
  const beforeFingerprint = await aggregateDescriptorFingerprints(
    descriptors,
    'beforeFingerprint',
  );
  const targetFingerprint = await aggregateDescriptorFingerprints(
    descriptors,
    'targetFingerprint',
  );
  const planFingerprint = await fingerprintRestoreValue({
    version: 1,
    backupFormatVersion: input.manifest.backupFormatVersion,
    manifestFingerprint: input.manifestFingerprint,
    beforeFingerprint,
    targetFingerprint,
    documentDecisions: decisions,
    collectionActionIds,
    actions: descriptors,
  });
  const summary: RestoreEnginePlanSummaryV1 = {
    version: 1,
    backupFormatVersion: input.manifest.backupFormatVersion,
    manifestFingerprint: input.manifestFingerprint,
    planFingerprint,
    beforeFingerprint,
    targetFingerprint,
    actionCount: descriptors.length,
    documentDecisions: decisions,
    collectionActionIds,
    actions: descriptors,
  };
  if (!isRestoreEnginePlanSummary(summary)) {
    throw new Error('The frozen restore plan failed journal validation.');
  }
  const operation: DurableRestoreOperation = {
    operationId,
    workspaceId: lease.workspaceId,
    phase: 'preparing',
    generation: 1,
    createdAt: Date.now(),
    recoveryRequired: false,
    publicationHold: false,
    remoteRevalidationRequired: false,
    enginePlan: summary,
  };
  if (!isDurableRestoreOperation(operation)) {
    throw new Error('The durable restore operation failed validation.');
  }
  return {
    operation,
    summary,
    actions,
    imported: created + replaced,
    created,
    replaced,
    skipped,
  };
}

function reportProgress(
  request: CrashSafeRestoreRequest,
  phase: CrashSafeRestoreProgressPhase,
  completed?: number,
  total?: number,
): void {
  try {
    request.onProgress?.({
      phase,
      ...(completed !== undefined ? { completed } : {}),
      ...(total !== undefined ? { total } : {}),
    });
  } catch {
    // Progress is observational. UI teardown or a faulty observer must never
    // affect commit, rollback, or durable evidence retention.
  }
}

async function captureRestoreAction(
  operation: DurableRestoreOperation,
  action: RuntimeRestoreAction,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<void> {
  const { descriptor } = action;
  invokeFailure(
    failureInjector,
    'before-snapshot-transaction',
    actionContext(operation, descriptor),
  );
  const transaction = startJournalTransaction(descriptor.database, databases);
  try {
    const snapshotStore = transaction.objectStore(RESTORE_SNAPSHOT_STORE);
    const actionStore = transaction.objectStore(RESTORE_ACTION_STORE);
    if (
      (await snapshotStore.get(descriptor.snapshotId)) !== undefined ||
      (await actionStore.get(descriptor.actionId)) !== undefined
    ) {
      throw new RestoreRecoveryProofError('Restore journal evidence already exists.');
    }
    const snapshot: RestoreJournalSnapshotV1 = {
      version: 1,
      id: descriptor.snapshotId,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      database: descriptor.database,
      kind: descriptor.kind,
      targetKey: descriptor.targetKey,
      recordPresence: payloadPresence(action.before),
      beforeFingerprint: descriptor.beforeFingerprint,
      capturedAt: Date.now(),
      payload: structuredClone(action.before),
    };
    const marker: RestoreJournalActionV1 = {
      version: 1,
      id: descriptor.actionId,
      operationId: operation.operationId,
      workspaceId: operation.workspaceId,
      actionId: descriptor.actionId,
      snapshotId: descriptor.snapshotId,
      database: descriptor.database,
      kind: descriptor.kind,
      targetKey: descriptor.targetKey,
      beforeFingerprint: descriptor.beforeFingerprint,
      targetFingerprint: descriptor.targetFingerprint,
      status: 'planned',
      createdAt: Date.now(),
    };
    if (!isRestoreJournalSnapshot(snapshot) || !isRestoreJournalAction(marker)) {
      throw new RestoreRecoveryProofError('Restore evidence failed validation.');
    }
    await snapshotStore.put(snapshot);
    invokeFailure(
      failureInjector,
      'after-snapshot-before-action-marker',
      actionContext(operation, descriptor),
    );
    await actionStore.put(marker);
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
  invokeFailure(
    failureInjector,
    'after-snapshot-transaction',
    actionContext(operation, descriptor),
  );
}

async function applyRestoreAction(
  operation: DurableRestoreOperation,
  action: RuntimeRestoreAction,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<void> {
  const { descriptor } = action;
  invokeFailure(
    failureInjector,
    'before-action-transaction',
    actionContext(operation, descriptor),
  );
  const transaction = startActionTransaction(descriptor, databases);
  try {
    const actionStore = transaction.objectStore(RESTORE_ACTION_STORE);
    const rawMarker = await actionStore.get(descriptor.actionId);
    const marker = requireMatchingAction(rawMarker, operation, descriptor);
    if (marker.status !== 'planned') {
      throw new RestoreRecoveryProofError('A restore action was not in planned state.');
    }
    await writeActionPayload(transaction, descriptor, action.target);
    invokeFailure(
      failureInjector,
      'after-live-write-before-action-marker',
      actionContext(operation, descriptor),
    );
    await actionStore.put({
      ...marker,
      status: 'applied',
      appliedAt: Date.now(),
    } satisfies RestoreJournalActionV1);
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
  invokeFailure(
    failureInjector,
    'after-action-transaction',
    actionContext(operation, descriptor),
  );
}

async function verifyAppliedTarget(
  operation: DurableRestoreOperation,
  databases: RestoreEngineDatabases,
): Promise<void> {
  const plan = requireEnginePlan(operation);
  await assertFrozenPlanFingerprint(plan);
  for (const descriptor of plan.actions) {
    const marker = await getJournalRecord(
      descriptor.database,
      databases,
      RESTORE_ACTION_STORE,
      descriptor.actionId,
    );
    const validated = requireMatchingAction(marker, operation, descriptor);
    if (validated.status !== 'applied') {
      throw new RestoreRecoveryProofError(
        'Commit verification found an unapplied restore action.',
      );
    }
  }
  const actual = await fingerprintLiveActionScope(plan, databases);
  if (actual !== plan.targetFingerprint) {
    throw new RestoreRecoveryProofError(
      'The restored records do not match the frozen target fingerprint.',
    );
  }
}

async function rollbackUncommittedRestore(
  initialOperation: DurableRestoreOperation,
  lease: WorkspaceRestoreLease,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<void> {
  if (initialOperation.commitEvidence) {
    throw new RestoreRecoveryProofError(
      'Committed restore data cannot be rolled back.',
    );
  }
  let operation = initialOperation;
  if (operation.phase !== 'rolling-back') {
    if (!canTransitionRestorePhase(operation.phase, 'rolling-back')) {
      throw new RestoreRecoveryProofError(
        'The restore journal cannot enter rollback from its current phase.',
      );
    }
    operation = await transitionOperation(operation, 'rolling-back', lease);
  }
  const plan = requireEnginePlan(operation);
  let actualFingerprint = await fingerprintLiveActionScope(plan, databases);
  if (actualFingerprint !== plan.beforeFingerprint) {
    for (const descriptor of [...plan.actions].reverse()) {
      await rollbackRestoreAction(operation, descriptor, databases, failureInjector);
    }
    actualFingerprint = await fingerprintLiveActionScope(plan, databases);
  }
  if (actualFingerprint !== plan.beforeFingerprint) {
    throw new RestoreRecoveryProofError(
      'Rollback did not restore the exact pre-restore fingerprint.',
    );
  }
  await cleanupProductivityEvidence(operation, databases.productivity);
  invokeFailure(failureInjector, 'after-productivity-cleanup', {
    operationId: operation.operationId,
    phase: operation.phase,
  });
  await finalizeRollbackCleanup(
    operation,
    lease,
    databases.annotation,
    failureInjector,
  );
}

async function rollbackRestoreAction(
  operation: DurableRestoreOperation,
  descriptor: RestoreEngineActionDescriptor,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<void> {
  invokeFailure(
    failureInjector,
    'before-rollback-action',
    actionContext(operation, descriptor),
  );
  const [rawSnapshot, rawMarker] = await Promise.all([
    getJournalRecord(
      descriptor.database,
      databases,
      RESTORE_SNAPSHOT_STORE,
      descriptor.snapshotId,
    ),
    getJournalRecord(
      descriptor.database,
      databases,
      RESTORE_ACTION_STORE,
      descriptor.actionId,
    ),
  ]);
  if (rawSnapshot === undefined || rawMarker === undefined) {
    const current = await fingerprintCurrentAction(descriptor, databases);
    if (current === descriptor.beforeFingerprint) return;
    throw new RestoreRecoveryProofError(
      'Required rollback evidence is missing; snapshots were retained.',
    );
  }
  const snapshot = requireMatchingSnapshot(rawSnapshot, operation, descriptor);
  const marker = requireMatchingAction(rawMarker, operation, descriptor);
  if (
    (await fingerprintRestoreValue(snapshot.payload)) !== descriptor.beforeFingerprint
  ) {
    throw new RestoreRecoveryProofError(
      'A rollback preimage does not match its durable fingerprint.',
    );
  }
  if (marker.status === 'planned') {
    const current = await fingerprintCurrentAction(descriptor, databases);
    if (current !== descriptor.beforeFingerprint) {
      throw new RestoreRecoveryProofError(
        'A planned-only action changed live data without an applied marker.',
      );
    }
    await markPlannedActionRolledBack(descriptor.database, databases, marker);
    return;
  }
  if (marker.status === 'rolled-back') {
    const current = await fingerprintCurrentAction(descriptor, databases);
    if (current === descriptor.beforeFingerprint) return;
  }

  const transaction = startActionTransaction(descriptor, databases);
  try {
    const actionStore = transaction.objectStore(RESTORE_ACTION_STORE);
    const transactionMarker = requireMatchingAction(
      await actionStore.get(descriptor.actionId),
      operation,
      descriptor,
    );
    if (transactionMarker.status === 'planned') {
      throw new RestoreRecoveryProofError(
        'Rollback action state changed before preimage restoration.',
      );
    }
    await writeActionPayload(
      transaction,
      descriptor,
      snapshot.payload as RestoreActionPayload,
    );
    invokeFailure(
      failureInjector,
      'after-rollback-write-before-marker',
      actionContext(operation, descriptor),
    );
    await actionStore.put({
      ...transactionMarker,
      status: 'rolled-back',
      rolledBackAt: Date.now(),
    } satisfies RestoreJournalActionV1);
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
  invokeFailure(
    failureInjector,
    'after-rollback-action',
    actionContext(operation, descriptor),
  );
}

async function finishCommittedRestore(
  initialOperation: DurableRestoreOperation,
  lease: WorkspaceRestoreLease,
  databases: RestoreEngineDatabases,
  failureInjector?: RestoreFailureInjector,
): Promise<DurableRestoreOperation> {
  if (!initialOperation.commitEvidence) {
    throw new RestoreRecoveryProofError(
      'Forward recovery requires immutable commit evidence.',
    );
  }
  const plan = requireEnginePlan(initialOperation);
  if (
    initialOperation.commitEvidence.planFingerprint !== plan.planFingerprint ||
    initialOperation.commitEvidence.targetFingerprint !== plan.targetFingerprint
  ) {
    throw new RestoreRecoveryProofError('Commit evidence does not match the plan.');
  }
  const actual = await fingerprintLiveActionScope(plan, databases);
  if (actual !== plan.targetFingerprint) {
    throw new RestoreRecoveryProofError(
      'Post-commit recovery found data that differs from the committed fingerprint.',
    );
  }
  await cleanupProductivityEvidence(initialOperation, databases.productivity);
  invokeFailure(failureInjector, 'after-productivity-cleanup', {
    operationId: initialOperation.operationId,
    phase: initialOperation.phase,
  });
  return finalizeCommittedCleanup(
    initialOperation,
    lease,
    databases.annotation,
    failureInjector,
  );
}

async function cleanupProductivityEvidence(
  operation: DurableRestoreOperation,
  database: IDBPDatabase<RestoreEngineProductivityDatabase>,
): Promise<void> {
  const descriptors = requireEnginePlan(operation).actions.filter(
    ({ database: owner }) => owner === 'productivity',
  );
  if (descriptors.length === 0) return;
  const transaction = database.transaction(
    [RESTORE_SNAPSHOT_STORE, RESTORE_ACTION_STORE],
    'readwrite',
  );
  try {
    const snapshots = transaction.objectStore(RESTORE_SNAPSHOT_STORE);
    const actions = transaction.objectStore(RESTORE_ACTION_STORE);
    for (const descriptor of descriptors) {
      const [snapshot, action] = await Promise.all([
        snapshots.get(descriptor.snapshotId),
        actions.get(descriptor.actionId),
      ]);
      if (snapshot !== undefined) {
        requireMatchingSnapshot(snapshot, operation, descriptor);
        await snapshots.delete(descriptor.snapshotId);
      }
      if (action !== undefined) {
        requireMatchingAction(action, operation, descriptor);
        await actions.delete(descriptor.actionId);
      }
    }
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
}

async function finalizeRollbackCleanup(
  operation: DurableRestoreOperation,
  lease: WorkspaceRestoreLease,
  database: IDBPDatabase<RestoreEngineAnnotationDatabase>,
  failureInjector?: RestoreFailureInjector,
): Promise<void> {
  assertWorkspaceRestoreLease(lease, { requireExclusive: true });
  invokeFailure(failureInjector, 'before-final-cleanup-transaction', {
    operationId: operation.operationId,
    phase: operation.phase,
  });
  const transaction = database.transaction(
    [RESTORE_OPERATION_STORE, RESTORE_SNAPSHOT_STORE, RESTORE_ACTION_STORE],
    'readwrite',
  );
  try {
    const operationStore = transaction.objectStore(RESTORE_OPERATION_STORE);
    const current = await operationStore.get(operation.workspaceId);
    if (
      !isDurableRestoreOperation(current) ||
      current.operationId !== operation.operationId ||
      current.commitEvidence !== undefined ||
      (current.phase !== 'rolling-back' && current.phase !== 'recovery-required')
    ) {
      throw new RestoreRecoveryProofError(
        'Rollback cleanup found a stale or committed durable barrier.',
      );
    }
    await deleteAnnotationEvidenceInTransaction(
      transaction as unknown as RestoreTransactionLike,
      current,
    );
    invokeFailure(failureInjector, 'after-evidence-delete-before-final-barrier', {
      operationId: operation.operationId,
      phase: current.phase,
    });
    await operationStore.delete(operation.workspaceId);
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
}

async function finalizeCommittedCleanup(
  operation: DurableRestoreOperation,
  lease: WorkspaceRestoreLease,
  database: IDBPDatabase<RestoreEngineAnnotationDatabase>,
  failureInjector?: RestoreFailureInjector,
): Promise<DurableRestoreOperation> {
  assertWorkspaceRestoreLease(lease, { requireExclusive: true });
  invokeFailure(failureInjector, 'before-final-cleanup-transaction', {
    operationId: operation.operationId,
    phase: operation.phase,
  });
  const transaction = database.transaction(
    [RESTORE_OPERATION_STORE, RESTORE_SNAPSHOT_STORE, RESTORE_ACTION_STORE],
    'readwrite',
  );
  try {
    const operationStore = transaction.objectStore(RESTORE_OPERATION_STORE);
    const current = await operationStore.get(operation.workspaceId);
    if (
      !isDurableRestoreOperation(current) ||
      current.operationId !== operation.operationId ||
      !current.commitEvidence ||
      (current.phase !== 'committed' && current.phase !== 'recovery-required') ||
      !canTransitionRestorePhase(current.phase, 'publication-hold')
    ) {
      throw new RestoreRecoveryProofError(
        'Commit cleanup found a stale or unverified durable barrier.',
      );
    }
    await deleteAnnotationEvidenceInTransaction(
      transaction as unknown as RestoreTransactionLike,
      current,
    );
    invokeFailure(failureInjector, 'after-evidence-delete-before-final-barrier', {
      operationId: operation.operationId,
      phase: current.phase,
    });
    const next: DurableRestoreOperation = {
      ...current,
      phase: 'publication-hold',
      generation: current.generation + 1,
      recoveryRequired: false,
      publicationHold: true,
      remoteRevalidationRequired: true,
    };
    if (!isDurableRestoreOperation(next)) {
      throw new RestoreRecoveryProofError(
        'The publication hold failed durable validation.',
      );
    }
    await operationStore.put(next);
    await transaction.done;
    return next;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
}

async function deleteAnnotationEvidenceInTransaction(
  transaction: RestoreTransactionLike,
  operation: DurableRestoreOperation,
): Promise<void> {
  const snapshots = transaction.objectStore(RESTORE_SNAPSHOT_STORE);
  const actions = transaction.objectStore(RESTORE_ACTION_STORE);
  for (const descriptor of requireEnginePlan(operation).actions.filter(
    ({ database }) => database === 'annotation',
  )) {
    const [snapshot, action] = await Promise.all([
      snapshots.get(descriptor.snapshotId),
      actions.get(descriptor.actionId),
    ]);
    if (snapshot !== undefined) {
      requireMatchingSnapshot(snapshot, operation, descriptor);
      await snapshots.delete(descriptor.snapshotId);
    }
    if (action !== undefined) {
      requireMatchingAction(action, operation, descriptor);
      await actions.delete(descriptor.actionId);
    }
  }
}

async function retainFailedRecoveryBarrier(
  lease: WorkspaceRestoreLease,
): Promise<void> {
  const current = await loadDurableRestoreOperation(lease.workspaceId);
  if (!current || current.phase === 'recovery-required') return;
  if (!canTransitionRestorePhase(current.phase, 'recovery-required')) return;
  await transitionDurableRestoreOperation(
    {
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedPhase: current.phase,
      nextPhase: 'recovery-required',
    },
    lease,
  );
}

async function transitionOperation(
  operation: DurableRestoreOperation,
  nextPhase: DurableRestoreOperation['phase'],
  lease: WorkspaceRestoreLease,
  commitEvidence?: RestoreCommitEvidenceV1,
): Promise<DurableRestoreOperation> {
  return transitionDurableRestoreOperation(
    {
      operationId: operation.operationId,
      expectedGeneration: operation.generation,
      expectedPhase: operation.phase,
      nextPhase,
      ...(commitEvidence ? { commitEvidence } : {}),
    },
    lease,
  );
}

async function fingerprintLiveActionScope(
  plan: RestoreEnginePlanSummaryV1,
  databases: RestoreEngineDatabases,
): Promise<string> {
  const values: Array<{ actionId: string; fingerprint: string }> = [];
  for (const descriptor of plan.actions) {
    values.push({
      actionId: descriptor.actionId,
      fingerprint: await fingerprintCurrentAction(descriptor, databases),
    });
  }
  return fingerprintRestoreValue(values);
}

async function fingerprintCurrentAction(
  descriptor: RestoreEngineActionDescriptor,
  databases: RestoreEngineDatabases,
): Promise<string> {
  const payload =
    descriptor.kind === 'annotation-document'
      ? await readAnnotationDocumentPayload(databases.annotation, descriptor.targetKey)
      : descriptor.kind === 'annotation-collection'
        ? await readAnnotationCollectionPayload(
            databases.annotation,
            descriptor.targetKey,
          )
        : await readProductivityDocumentPayload(
            databases.productivity,
            descriptor.targetKey,
          );
  return fingerprintRestoreValue(payload);
}

async function readAnnotationDocumentPayload(
  database: IDBPDatabase<RestoreEngineAnnotationDatabase>,
  documentId: string,
): Promise<AnnotationDocumentPayload> {
  const transaction = database.transaction(
    [DOCUMENT_STATE_STORE, SOURCE_STORE],
    'readonly',
  );
  const [rawState, rawSource] = await Promise.all([
    transaction.objectStore(DOCUMENT_STATE_STORE).get(documentId),
    transaction.objectStore(SOURCE_STORE).get(documentId),
  ]);
  await transaction.done;
  const state = rawState === undefined ? null : validateBackupDocumentState(rawState);
  if (rawState !== undefined && (!state || state.documentId !== documentId)) {
    throw new RestoreRecoveryProofError(
      'A local document preimage failed strict validation.',
    );
  }
  const source =
    rawSource === undefined
      ? null
      : await validateStoredDocumentSource(rawSource, documentId, {
          allowLegacyPdf: true,
        });
  if (
    rawSource !== undefined &&
    (!source || !state || source.documentType !== state.documentType)
  ) {
    throw new RestoreRecoveryProofError(
      'A local source preimage failed strict validation.',
    );
  }
  return {
    state: rawState === undefined ? absentSlot() : presentSlot(rawState),
    source: rawSource === undefined ? absentSlot() : presentSlot(rawSource),
  };
}

async function readAnnotationCollectionPayload(
  database: IDBPDatabase<RestoreEngineAnnotationDatabase>,
  collectionId: string,
): Promise<AnnotationCollectionPayload> {
  const raw = await database.get(COLLECTION_STORE, collectionId);
  if (raw !== undefined && !validateLibraryEntities([raw])) {
    throw new RestoreRecoveryProofError(
      'A local Collection preimage failed strict validation.',
    );
  }
  return {
    collection: raw === undefined ? absentSlot() : presentSlot(raw),
  };
}

async function readProductivityDocumentPayload(
  database: IDBPDatabase<RestoreEngineProductivityDatabase>,
  documentId: string,
): Promise<ProductivityDocumentPayload> {
  const transaction = database.transaction(
    [PRINT_DRAFT_STORE, RENDERED_PRINT_PDF_STORE, AI_CONVERSATION_STORE],
    'readonly',
  );
  const [rawDraft, rawRendered, rawConversations] = await Promise.all([
    transaction.objectStore(PRINT_DRAFT_STORE).get(documentId),
    transaction.objectStore(RENDERED_PRINT_PDF_STORE).get(documentId),
    transaction
      .objectStore(AI_CONVERSATION_STORE)
      .index('by-document')
      .getAll(documentId),
  ]);
  await transaction.done;
  const productivity = sanitizeProductivityBackupData(
    {
      documentId,
      printDraft: rawDraft ?? null,
      aiConversations: rawConversations,
    },
    documentId,
  );
  if (!productivity) {
    throw new RestoreRecoveryProofError(
      'Local productivity preimages failed strict validation.',
    );
  }
  const rendered =
    rawRendered === undefined
      ? null
      : await validateStoredRenderedPrintPdf(rawRendered, documentId);
  if (rawRendered !== undefined && !rendered) {
    throw new RestoreRecoveryProofError(
      'A local Print PDF preimage failed strict validation.',
    );
  }
  return {
    printDraft: rawDraft === undefined ? absentSlot() : presentSlot(rawDraft),
    renderedPrintPdf:
      rawRendered === undefined ? absentSlot() : presentSlot(rawRendered),
    aiConversations: sortConversations(rawConversations as Array<{ id?: unknown }>),
  };
}

async function assertIncomingConversationIdsDoNotCollide(
  database: IDBPDatabase<RestoreEngineProductivityDatabase>,
  incoming: readonly { id: string }[],
  documentId: string,
): Promise<void> {
  for (const conversation of incoming) {
    const existing = await database.get(AI_CONVERSATION_STORE, conversation.id);
    if (
      existing !== undefined &&
      (!isRecord(existing) || existing.documentId !== documentId)
    ) {
      throw new Error(
        'An AI conversation identifier belongs to a different local document.',
      );
    }
  }
}

async function writeActionPayload(
  transaction: {
    objectStore(name: string): {
      put(value: unknown): Promise<unknown>;
      delete(key: string): Promise<unknown>;
      index?(name: string): { getAllKeys(query: string): Promise<IDBValidKey[]> };
    };
  },
  descriptor: RestoreEngineActionDescriptor,
  payload: RestoreActionPayload,
): Promise<void> {
  if (descriptor.kind === 'annotation-document') {
    const value = payload as AnnotationDocumentPayload;
    await writeSlot(
      transaction.objectStore(DOCUMENT_STATE_STORE),
      descriptor.targetKey,
      value.state,
    );
    await writeSlot(
      transaction.objectStore(SOURCE_STORE),
      descriptor.targetKey,
      value.source,
    );
    return;
  }
  if (descriptor.kind === 'annotation-collection') {
    const value = payload as AnnotationCollectionPayload;
    await writeSlot(
      transaction.objectStore(COLLECTION_STORE),
      descriptor.targetKey,
      value.collection,
    );
    return;
  }
  const value = payload as ProductivityDocumentPayload;
  await writeSlot(
    transaction.objectStore(PRINT_DRAFT_STORE),
    descriptor.targetKey,
    value.printDraft,
  );
  await writeSlot(
    transaction.objectStore(RENDERED_PRINT_PDF_STORE),
    descriptor.targetKey,
    value.renderedPrintPdf,
  );
  const conversationStore = transaction.objectStore(AI_CONVERSATION_STORE);
  if (!conversationStore.index) {
    throw new RestoreRecoveryProofError('The conversation index is unavailable.');
  }
  const oldIds = await conversationStore
    .index('by-document')
    .getAllKeys(descriptor.targetKey);
  for (const id of oldIds) await conversationStore.delete(String(id));
  for (const conversation of value.aiConversations) {
    await conversationStore.put(conversation);
  }
}

async function writeSlot(
  store: {
    put(value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
  },
  key: string,
  slot: RecordSlot,
): Promise<void> {
  if (slot.present) await store.put(structuredClone(slot.value));
  else await store.delete(key);
}

async function markPlannedActionRolledBack(
  database: RestoreEngineDatabase,
  databases: RestoreEngineDatabases,
  marker: RestoreJournalActionV1,
): Promise<void> {
  const transaction = startJournalTransaction(database, databases, true);
  const store = transaction.objectStore(RESTORE_ACTION_STORE);
  const current = await store.get(marker.actionId);
  if (!isRestoreJournalAction(current) || current.status !== 'planned') {
    abortTransaction(transaction);
    throw new RestoreRecoveryProofError('The planned rollback marker changed.');
  }
  await store.put({
    ...current,
    status: 'rolled-back',
    rolledBackAt: Date.now(),
  } satisfies RestoreJournalActionV1);
  await transaction.done;
}

function requireMatchingSnapshot(
  value: unknown,
  operation: DurableRestoreOperation,
  descriptor: RestoreEngineActionDescriptor,
): RestoreJournalSnapshotV1 {
  if (
    !isRestoreJournalSnapshot(value) ||
    value.id !== descriptor.snapshotId ||
    value.operationId !== operation.operationId ||
    value.workspaceId !== operation.workspaceId ||
    value.database !== descriptor.database ||
    value.kind !== descriptor.kind ||
    value.targetKey !== descriptor.targetKey ||
    value.beforeFingerprint !== descriptor.beforeFingerprint
  ) {
    throw new RestoreRecoveryProofError(
      'A restore snapshot does not match the frozen plan.',
    );
  }
  return value;
}

function requireMatchingAction(
  value: unknown,
  operation: DurableRestoreOperation,
  descriptor: RestoreEngineActionDescriptor,
): RestoreJournalActionV1 {
  if (
    !isRestoreJournalAction(value) ||
    value.id !== descriptor.actionId ||
    value.operationId !== operation.operationId ||
    value.workspaceId !== operation.workspaceId ||
    value.actionId !== descriptor.actionId ||
    value.snapshotId !== descriptor.snapshotId ||
    value.database !== descriptor.database ||
    value.kind !== descriptor.kind ||
    value.targetKey !== descriptor.targetKey ||
    value.beforeFingerprint !== descriptor.beforeFingerprint ||
    value.targetFingerprint !== descriptor.targetFingerprint
  ) {
    throw new RestoreRecoveryProofError(
      'A restore action marker does not match the frozen plan.',
    );
  }
  return value;
}

function requireEnginePlan(
  operation: DurableRestoreOperation,
): RestoreEnginePlanSummaryV1 {
  if (!operation.enginePlan || !isRestoreEnginePlanSummary(operation.enginePlan)) {
    throw new RestoreRecoveryProofError('The Phase C restore plan is missing.');
  }
  return operation.enginePlan;
}

async function aggregateDescriptorFingerprints(
  descriptors: readonly RestoreEngineActionDescriptor[],
  property: 'beforeFingerprint' | 'targetFingerprint',
): Promise<string> {
  return fingerprintRestoreValue(
    descriptors.map((descriptor) => ({
      actionId: descriptor.actionId,
      fingerprint: descriptor[property],
    })),
  );
}

async function assertFrozenPlanFingerprint(
  plan: RestoreEnginePlanSummaryV1,
): Promise<void> {
  const [beforeFingerprint, targetFingerprint] = await Promise.all([
    aggregateDescriptorFingerprints(plan.actions, 'beforeFingerprint'),
    aggregateDescriptorFingerprints(plan.actions, 'targetFingerprint'),
  ]);
  if (
    beforeFingerprint !== plan.beforeFingerprint ||
    targetFingerprint !== plan.targetFingerprint
  ) {
    throw new RestoreRecoveryProofError(
      'The persisted restore action inventory does not match its aggregate hashes.',
    );
  }
  const planFingerprint = await fingerprintRestoreValue({
    version: plan.version,
    backupFormatVersion: plan.backupFormatVersion,
    manifestFingerprint: plan.manifestFingerprint,
    beforeFingerprint: plan.beforeFingerprint,
    targetFingerprint: plan.targetFingerprint,
    documentDecisions: plan.documentDecisions,
    collectionActionIds: plan.collectionActionIds,
    actions: plan.actions,
  });
  if (planFingerprint !== plan.planFingerprint) {
    throw new RestoreRecoveryProofError(
      'The persisted frozen restore plan failed content verification.',
    );
  }
}

function payloadPresence(
  payload: RestoreActionPayload,
): RestoreJournalSnapshotV1['recordPresence'] {
  const presences =
    'state' in payload
      ? [payload.state.present, payload.source.present]
      : 'collection' in payload
        ? [payload.collection.present]
        : [
            payload.printDraft.present,
            payload.renderedPrintPdf.present,
            payload.aiConversations.length > 0,
          ];
  return presences.every(Boolean)
    ? 'present'
    : presences.some(Boolean)
      ? 'mixed'
      : 'absent';
}

function startJournalTransaction(
  database: RestoreEngineDatabase,
  databases: RestoreEngineDatabases,
  actionOnly = false,
): RestoreTransactionLike {
  const transaction =
    database === 'annotation'
      ? actionOnly
        ? databases.annotation.transaction(RESTORE_ACTION_STORE, 'readwrite')
        : databases.annotation.transaction(
            [RESTORE_SNAPSHOT_STORE, RESTORE_ACTION_STORE],
            'readwrite',
          )
      : actionOnly
        ? databases.productivity.transaction(RESTORE_ACTION_STORE, 'readwrite')
        : databases.productivity.transaction(
            [RESTORE_SNAPSHOT_STORE, RESTORE_ACTION_STORE],
            'readwrite',
          );
  return transaction as unknown as RestoreTransactionLike;
}

function startActionTransaction(
  descriptor: RestoreEngineActionDescriptor,
  databases: RestoreEngineDatabases,
): RestoreTransactionLike {
  if (descriptor.kind === 'annotation-document') {
    return databases.annotation.transaction(
      [DOCUMENT_STATE_STORE, SOURCE_STORE, RESTORE_ACTION_STORE],
      'readwrite',
    ) as unknown as RestoreTransactionLike;
  }
  if (descriptor.kind === 'annotation-collection') {
    return databases.annotation.transaction(
      [COLLECTION_STORE, RESTORE_ACTION_STORE],
      'readwrite',
    ) as unknown as RestoreTransactionLike;
  }
  return databases.productivity.transaction(
    [
      PRINT_DRAFT_STORE,
      RENDERED_PRINT_PDF_STORE,
      AI_CONVERSATION_STORE,
      RESTORE_ACTION_STORE,
    ],
    'readwrite',
  ) as unknown as RestoreTransactionLike;
}

function getJournalRecord(
  database: RestoreEngineDatabase,
  databases: RestoreEngineDatabases,
  store: typeof RESTORE_ACTION_STORE | typeof RESTORE_SNAPSHOT_STORE,
  key: string,
): Promise<unknown> {
  return database === 'annotation'
    ? databases.annotation.get(store, key)
    : databases.productivity.get(store, key);
}

function hasProductivityRecords(payload: ProductivityDocumentPayload): boolean {
  return (
    payload.printDraft.present ||
    payload.renderedPrintPdf.present ||
    payload.aiConversations.length > 0
  );
}

function presentSlot(value: unknown): RecordSlot {
  return { present: true, value: structuredClone(value) };
}

function absentSlot(): RecordSlot {
  return { present: false };
}

function cloneSlot(slot: RecordSlot): RecordSlot {
  return slot.present ? presentSlot(slot.value) : absentSlot();
}

function sortConversations<T extends { id?: unknown }>(
  conversations: readonly T[],
): T[] {
  const cloned = structuredClone([...conversations]) as T[];
  return cloned.sort((first, second) =>
    compareCanonicalStrings(String(first.id), String(second.id)),
  );
}

function actionContext(
  operation: DurableRestoreOperation,
  descriptor: RestoreEngineActionDescriptor,
): RestoreFailureContext {
  return {
    operationId: operation.operationId,
    phase: operation.phase,
    actionId: descriptor.actionId,
    actionKind: descriptor.kind,
    targetKey: descriptor.targetKey,
  };
}

function invokeFailure(
  injector: RestoreFailureInjector | undefined,
  point: RestoreFailurePoint,
  context: RestoreFailureContext,
): void {
  injector?.(point, Object.freeze({ ...context }));
}

function abortTransaction(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have aborted or committed. Its durable state
    // is always verified by the caller before cleanup.
  }
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreezeRestoreValue(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || value instanceof Blob || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeRestoreValue(child, seen);
  Object.freeze(value);
}

async function withRestoreEngineDatabases<T>(
  lease: WorkspaceRestoreLease,
  task: (databases: RestoreEngineDatabases) => Promise<T>,
): Promise<T> {
  assertWorkspaceRestoreLease(lease, { requireExclusive: true });
  const annotationName = scopedDatabaseName(PERSONAL_ANNOTATION_DATABASE_NAME);
  const productivityName = scopedDatabaseName(PERSONAL_PRODUCTIVITY_DATABASE_NAME);
  let annotation: IDBPDatabase<RestoreEngineAnnotationDatabase> | undefined;
  let productivity: IDBPDatabase<RestoreEngineProductivityDatabase> | undefined;
  try {
    annotation = await openDatabaseWithLifecycleSafety<RestoreEngineAnnotationDatabase>(
      annotationName,
      ANNOTATION_DATABASE_VERSION,
      {
        upgrade(database) {
          upgradeAnnotationDatabaseSchema(database as never);
        },
      },
    );
    productivity =
      await openDatabaseWithLifecycleSafety<RestoreEngineProductivityDatabase>(
        productivityName,
        PRODUCTIVITY_DATABASE_VERSION,
        {
          upgrade(database) {
            upgradeProductivityDatabaseSchema(database as never);
          },
        },
      );
    assertWorkspaceRestoreLease(lease, { requireExclusive: true });
    if (lease.workspaceId !== currentWorkspaceRestoreIdentity()) {
      throw new WorkspaceRestoreBarrierError(
        'The workspace changed while restore databases were opened.',
      );
    }
    return await task({ annotation, productivity });
  } finally {
    productivity?.close();
    annotation?.close();
  }
}
