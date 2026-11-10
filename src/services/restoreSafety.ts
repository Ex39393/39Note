export const RESTORE_OPERATION_STORE = 'restore-operations';
export const RESTORE_SNAPSHOT_STORE = 'restore-snapshots';
export const RESTORE_ACTION_STORE = 'restore-actions';

export type RestoreLifecyclePhase =
  | 'preparing'
  | 'prepared'
  | 'applying'
  | 'verifying'
  | 'committed'
  | 'rolling-back'
  | 'recovery-required'
  | 'publication-hold';

export type RestoreEngineDatabase = 'annotation' | 'productivity';
export type RestoreEngineActionKind =
  'annotation-document' | 'annotation-collection' | 'productivity-document';
export type RestoreCollisionResolution = 'create' | 'replace' | 'skip';
export type RestoreJournalActionStatus = 'planned' | 'applied' | 'rolled-back';

export interface RestoreEngineActionDescriptor {
  actionId: string;
  snapshotId: string;
  database: RestoreEngineDatabase;
  kind: RestoreEngineActionKind;
  targetKey: string;
  beforeFingerprint: string;
  targetFingerprint: string;
}

export interface RestoreEngineDocumentDecision {
  documentId: string;
  resolution: RestoreCollisionResolution;
  annotationActionId?: string;
  productivityActionId?: string;
}

/**
 * Immutable, content-addressed Phase C plan. It intentionally contains no
 * incoming payload bytes: an interrupted operation may restore preimages, but
 * it may never resume unpublished forward writes from an incomplete journal.
 */
export interface RestoreEnginePlanSummaryV1 {
  version: 1;
  backupFormatVersion: number;
  manifestFingerprint: string;
  planFingerprint: string;
  beforeFingerprint: string;
  targetFingerprint: string;
  actionCount: number;
  documentDecisions: RestoreEngineDocumentDecision[];
  collectionActionIds: string[];
  actions: RestoreEngineActionDescriptor[];
}

export interface RestoreCommitEvidenceV1 {
  version: 1;
  operationId: string;
  planFingerprint: string;
  targetFingerprint: string;
  verifiedAt: number;
}

export interface DurableRestoreOperation {
  operationId: string;
  workspaceId: string;
  phase: RestoreLifecyclePhase;
  generation: number;
  createdAt: number;
  recoveryRequired: boolean;
  publicationHold: boolean;
  /** Remote state must be reread before this hold may be cleared. */
  remoteRevalidationRequired: boolean;
  /** Optional immutable account fence captured for publication review. */
  publicationAccountId?: string;
  /** Present only for the inactive Phase C crash-safe restore engine. */
  enginePlan?: RestoreEnginePlanSummaryV1;
  /** Immutable proof that exact target bytes were verified before commit. */
  commitEvidence?: RestoreCommitEvidenceV1;
}

export interface RestoreSnapshotEnvelope {
  id: string;
  operationId: string;
  recordKind: string;
  capturedAt: number;
  applied: boolean;
  rolledBack: boolean;
  payload: unknown;
}

export interface RestoreAppliedAction {
  id: string;
  operationId: string;
  actionId: string;
  appliedAt: number;
}

export interface RestoreJournalSnapshotV1 {
  version: 1;
  id: string;
  operationId: string;
  workspaceId: string;
  database: RestoreEngineDatabase;
  kind: RestoreEngineActionKind;
  targetKey: string;
  recordPresence: 'absent' | 'present' | 'mixed';
  beforeFingerprint: string;
  capturedAt: number;
  payload: unknown;
}

export interface RestoreJournalActionV1 {
  version: 1;
  id: string;
  operationId: string;
  workspaceId: string;
  actionId: string;
  snapshotId: string;
  database: RestoreEngineDatabase;
  kind: RestoreEngineActionKind;
  targetKey: string;
  beforeFingerprint: string;
  targetFingerprint: string;
  status: RestoreJournalActionStatus;
  createdAt: number;
  appliedAt?: number;
  rolledBackAt?: number;
}

export class WorkspaceRestoreBarrierError extends Error {
  readonly operation?: DurableRestoreOperation;

  constructor(
    message = 'A restore or recovery operation currently blocks workspace changes.',
    operation?: DurableRestoreOperation,
  ) {
    super(message);
    this.name = 'WorkspaceRestoreBarrierError';
    this.operation = operation;
  }
}

export class RestoreStartupBlockedError extends Error {
  readonly reason: 'recovery-required' | 'publication-hold' | 'restore-active';

  constructor(operation: DurableRestoreOperation) {
    const reason = operation.publicationHold
      ? 'publication-hold'
      : operation.recoveryRequired || operation.phase === 'recovery-required'
        ? 'recovery-required'
        : 'restore-active';
    super(
      reason === 'publication-hold'
        ? 'Restored data is waiting for publication review.'
        : 'An incomplete restore operation requires recovery before 39Note can open.',
    );
    this.name = 'RestoreStartupBlockedError';
    this.reason = reason;
  }
}

export function isDurableRestoreOperation(
  value: unknown,
): value is DurableRestoreOperation {
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === 'string' &&
    isUuidV4(value.operationId) &&
    typeof value.workspaceId === 'string' &&
    (value.workspaceId === 'personal' ||
      /^temporary:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.workspaceId,
      )) &&
    isRestoreLifecyclePhase(value.phase) &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.recoveryRequired === 'boolean' &&
    typeof value.publicationHold === 'boolean' &&
    typeof value.remoteRevalidationRequired === 'boolean' &&
    (value.publicationAccountId === undefined ||
      isSafeAccountId(value.publicationAccountId)) &&
    value.recoveryRequired === (value.phase === 'recovery-required') &&
    value.publicationHold === (value.phase === 'publication-hold') &&
    (value.phase === 'publication-hold' ||
      (!value.remoteRevalidationRequired &&
        value.publicationAccountId === undefined)) &&
    (value.enginePlan === undefined || isRestoreEnginePlanSummary(value.enginePlan)) &&
    (value.commitEvidence === undefined ||
      isRestoreCommitEvidence(value.commitEvidence)) &&
    (value.enginePlan !== undefined || value.commitEvidence === undefined) &&
    (value.commitEvidence === undefined ||
      (value.commitEvidence.operationId === value.operationId &&
        value.commitEvidence.planFingerprint === value.enginePlan?.planFingerprint &&
        value.commitEvidence.targetFingerprint ===
          value.enginePlan?.targetFingerprint)) &&
    (value.enginePlan === undefined ||
      (value.phase !== 'committed' && value.phase !== 'publication-hold') ||
      value.commitEvidence !== undefined) &&
    (value.enginePlan === undefined ||
      value.commitEvidence === undefined ||
      value.phase === 'committed' ||
      value.phase === 'recovery-required' ||
      value.phase === 'publication-hold')
  );
}

export function isRestoreEnginePlanSummary(
  value: unknown,
): value is RestoreEnginePlanSummaryV1 {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    !Number.isInteger(value.backupFormatVersion) ||
    (value.backupFormatVersion as number) < 1 ||
    (value.backupFormatVersion as number) > 5 ||
    !isSha256(value.manifestFingerprint) ||
    !isSha256(value.planFingerprint) ||
    !isSha256(value.beforeFingerprint) ||
    !isSha256(value.targetFingerprint) ||
    !Number.isSafeInteger(value.actionCount) ||
    (value.actionCount as number) < 0 ||
    !Array.isArray(value.documentDecisions) ||
    !Array.isArray(value.collectionActionIds) ||
    !Array.isArray(value.actions) ||
    value.actionCount !== value.actions.length
  ) {
    return false;
  }
  const decisions = value.documentDecisions;
  const actions = value.actions;
  if (
    !decisions.every(isRestoreEngineDocumentDecision) ||
    !actions.every(isRestoreEngineActionDescriptor) ||
    !value.collectionActionIds.every(isSafeJournalId) ||
    new Set(decisions.map(({ documentId }) => documentId)).size !== decisions.length ||
    new Set(actions.map(({ actionId }) => actionId)).size !== actions.length ||
    new Set(actions.map(({ snapshotId }) => snapshotId)).size !== actions.length ||
    new Set(value.collectionActionIds).size !== value.collectionActionIds.length
  ) {
    return false;
  }
  const actionsById = new Map(actions.map((action) => [action.actionId, action]));
  for (const decision of decisions) {
    if (decision.resolution === 'skip') {
      if (decision.annotationActionId || decision.productivityActionId) return false;
      continue;
    }
    if (
      decision.annotationActionId &&
      (actionsById.get(decision.annotationActionId)?.kind !== 'annotation-document' ||
        actionsById.get(decision.annotationActionId)?.targetKey !== decision.documentId)
    ) {
      return false;
    }
    if (
      decision.productivityActionId &&
      (actionsById.get(decision.productivityActionId)?.kind !==
        'productivity-document' ||
        actionsById.get(decision.productivityActionId)?.targetKey !==
          decision.documentId)
    ) {
      return false;
    }
  }
  if (
    !value.collectionActionIds.every(
      (actionId) => actionsById.get(actionId)?.kind === 'annotation-collection',
    )
  ) {
    return false;
  }
  const references = [
    ...decisions.flatMap((decision) => [
      ...(decision.annotationActionId ? [decision.annotationActionId] : []),
      ...(decision.productivityActionId ? [decision.productivityActionId] : []),
    ]),
    ...value.collectionActionIds,
  ];
  return (
    references.length === actions.length &&
    new Set(references).size === references.length &&
    references.every((actionId) => actionsById.has(actionId))
  );
}

export function isRestoreJournalSnapshot(
  value: unknown,
): value is RestoreJournalSnapshotV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isSafeJournalId(value.id) &&
    isUuidV4Value(value.operationId) &&
    isWorkspaceId(value.workspaceId) &&
    isRestoreEngineDatabase(value.database) &&
    isRestoreEngineActionKind(value.kind) &&
    actionKindBelongsToDatabase(value.kind, value.database) &&
    isSafeTargetKey(value.targetKey) &&
    (value.recordPresence === 'absent' ||
      value.recordPresence === 'present' ||
      value.recordPresence === 'mixed') &&
    isSha256(value.beforeFingerprint) &&
    isTimestamp(value.capturedAt) &&
    Object.prototype.hasOwnProperty.call(value, 'payload')
  );
}

export function isRestoreJournalAction(
  value: unknown,
): value is RestoreJournalActionV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isSafeJournalId(value.id) ||
    !isUuidV4Value(value.operationId) ||
    !isWorkspaceId(value.workspaceId) ||
    !isSafeJournalId(value.actionId) ||
    !isSafeJournalId(value.snapshotId) ||
    !isRestoreEngineDatabase(value.database) ||
    !isRestoreEngineActionKind(value.kind) ||
    !actionKindBelongsToDatabase(value.kind, value.database) ||
    !isSafeTargetKey(value.targetKey) ||
    !isSha256(value.beforeFingerprint) ||
    !isSha256(value.targetFingerprint) ||
    (value.status !== 'planned' &&
      value.status !== 'applied' &&
      value.status !== 'rolled-back') ||
    !isTimestamp(value.createdAt) ||
    (value.appliedAt !== undefined && !isTimestamp(value.appliedAt)) ||
    (value.rolledBackAt !== undefined && !isTimestamp(value.rolledBackAt))
  ) {
    return false;
  }
  return (
    (value.status === 'planned' &&
      value.appliedAt === undefined &&
      value.rolledBackAt === undefined) ||
    (value.status === 'applied' &&
      value.appliedAt !== undefined &&
      value.rolledBackAt === undefined) ||
    (value.status === 'rolled-back' && value.rolledBackAt !== undefined)
  );
}

export function canTransitionRestorePhase(
  from: RestoreLifecyclePhase,
  to: RestoreLifecyclePhase,
): boolean {
  return RESTORE_TRANSITIONS[from].includes(to);
}

function isRestoreLifecyclePhase(value: unknown): value is RestoreLifecyclePhase {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RESTORE_TRANSITIONS, value)
  );
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isUuidV4Value(value: unknown): value is string {
  return typeof value === 'string' && isUuidV4(value);
}

function isWorkspaceId(value: unknown): value is string {
  return (
    value === 'personal' ||
    (typeof value === 'string' &&
      /^temporary:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value,
      ))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeJournalId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f)
  );
}

function isSafeTargetKey(value: unknown): value is string {
  return isSafeJournalId(value) && value.length <= 512;
}

function isRestoreEngineDatabase(value: unknown): value is RestoreEngineDatabase {
  return value === 'annotation' || value === 'productivity';
}

function isRestoreEngineActionKind(value: unknown): value is RestoreEngineActionKind {
  return (
    value === 'annotation-document' ||
    value === 'annotation-collection' ||
    value === 'productivity-document'
  );
}

function actionKindBelongsToDatabase(
  kind: RestoreEngineActionKind,
  database: RestoreEngineDatabase,
): boolean {
  return kind === 'productivity-document'
    ? database === 'productivity'
    : database === 'annotation';
}

function isRestoreEngineActionDescriptor(
  value: unknown,
): value is RestoreEngineActionDescriptor {
  return (
    isRecord(value) &&
    isSafeJournalId(value.actionId) &&
    isSafeJournalId(value.snapshotId) &&
    isRestoreEngineDatabase(value.database) &&
    isRestoreEngineActionKind(value.kind) &&
    actionKindBelongsToDatabase(value.kind, value.database) &&
    isSafeTargetKey(value.targetKey) &&
    isSha256(value.beforeFingerprint) &&
    isSha256(value.targetFingerprint) &&
    value.beforeFingerprint !== value.targetFingerprint
  );
}

function isRestoreEngineDocumentDecision(
  value: unknown,
): value is RestoreEngineDocumentDecision {
  return (
    isRecord(value) &&
    isSafeTargetKey(value.documentId) &&
    (value.resolution === 'create' ||
      value.resolution === 'replace' ||
      value.resolution === 'skip') &&
    (value.annotationActionId === undefined ||
      isSafeJournalId(value.annotationActionId)) &&
    (value.productivityActionId === undefined ||
      isSafeJournalId(value.productivityActionId))
  );
}

function isRestoreCommitEvidence(value: unknown): value is RestoreCommitEvidenceV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isUuidV4Value(value.operationId) &&
    isSha256(value.planFingerprint) &&
    isSha256(value.targetFingerprint) &&
    isTimestamp(value.verifiedAt)
  );
}

function isSafeAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => character.charCodeAt(0) <= 0x1f)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RESTORE_TRANSITIONS: Record<
  RestoreLifecyclePhase,
  readonly RestoreLifecyclePhase[]
> = {
  preparing: ['prepared', 'rolling-back', 'recovery-required'],
  prepared: ['applying', 'rolling-back', 'recovery-required'],
  applying: ['verifying', 'rolling-back', 'recovery-required'],
  verifying: ['committed', 'rolling-back', 'recovery-required'],
  committed: ['publication-hold', 'recovery-required'],
  'rolling-back': ['recovery-required'],
  'recovery-required': ['rolling-back', 'publication-hold'],
  'publication-hold': [],
};
