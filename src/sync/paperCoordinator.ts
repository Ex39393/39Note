import {
  flushLocalPersistence,
  subscribeToPersistentChanges,
  type PersistentChangeDetail,
} from '../services/persistentChange.ts';
import {
  DriveClient,
  DriveRequestError,
  type DriveFileMetadata,
  type DriveRequestActivity,
} from './driveClient.ts';
import {
  formatDriveOperationDiagnostic,
  summarizeDriveOperationTelemetry,
  type DriveOperationDiagnosticSummary,
  type DriveSyncOperationType,
} from './driveOperationTelemetry.ts';
import {
  classifySyncError,
  createLayoutMigrationIssue,
  type SyncOperationalIssue,
} from './errorModel.ts';
import {
  getBuildTimeSyncAuthUrl,
  GoogleReauthorizationRequiredError,
  PersistentGoogleAuthSession,
  type GoogleDeviceSessionSummary,
} from './googleIdentity.ts';
import { mergeSyncSnapshots } from './merge.ts';
import {
  createLayoutMigrationFailure,
  LayoutMigrationFailedError,
  type LayoutMigrationFailurePhase,
} from './layoutMigration.ts';
import {
  BrowserPaperLocalAdapter,
  finalizeAppliedPaperDownload,
} from './paperLocalAdapter.ts';
import {
  isOwnedManagedPaperRootMetadata,
  isRecognizedPaperRootMetadata,
} from './paperRootValidation.ts';
import {
  AmbiguousPaperFolderError,
  createPaperDownloadOperationCache,
  LegacyDriveCleanupRefusedError,
  PaperDriveRepository,
  PaperFolderNameNormalizationRefusedError,
  PaperManifestIntegrityError,
  PaperPayloadPartitionError,
  PaperRepositoryError,
  PaperSnapshotUnstableError,
  type PaperLayoutMigrationProof,
  type PaperFolderNameNormalizationPreview,
  type PaperScopedDiscoveryResult,
  type TargetedPaperPurgeProof,
  type PaperV3MigrationSeed,
} from './paperDriveRepository.ts';
import type { TargetedPurgePresenceAncestryDiagnostic } from './paperPresenceDriveRepository.ts';
import { runScopedPaperDownload } from './paperDownloadRetry.ts';
import type { LegacyDriveInventory } from './legacyDriveHousekeeping.ts';
import {
  type LocalPaperPackage,
  type PaperCloudSummary,
  type PaperDirtyReason,
  type PaperSyncState,
  type PaperTransferProgress,
} from './paperTypes.ts';
import { planPaperChangeDiscovery } from './paperIncrementalDiscovery.ts';
import type { PaperVerificationCacheEntry } from './paperVerificationCache.ts';
import {
  clearLayoutMigrationRecord,
  clearPaperV3MigrationRecord,
  bindPersonalWorkspaceAccount,
  createDefaultPaperSyncState,
  deletePaperSyncRecords,
  loadLayoutMigrationRecord,
  loadPaperV3MigrationRecord,
  loadCloudPaperCatalog,
  loadPaperSyncDeviceProfile,
  loadPaperDriveVerificationCache,
  loadPaperSyncStates,
  loadTemporarySessionProvenance,
  hasExplicitOrEstablishedDeviceMode,
  saveCloudPaperCatalog,
  saveLayoutMigrationRecord,
  savePaperV3MigrationRecord,
  savePaperSyncDeviceProfile,
  savePaperDriveVerificationCache,
  savePaperSyncState,
  savePaperSyncStates,
  type LayoutMigrationRecord,
  type PaperV3MigrationRecord,
  type PaperCloudIssueQuarantineEntry,
  type PaperDriveAuditCheckpoint,
  type PaperSyncDeviceProfile,
  type SyncDeviceMode,
  type TemporarySessionProvenance,
  WorkspaceAccountBindingConflictError,
} from './storage.ts';
import {
  KeyedSingleFlight,
  mapWithConcurrency,
  PAPER_TRANSFER_CONCURRENCY,
  settleIndependentOperations,
} from './syncConcurrency.ts';
import { getSyncSoundFeedback, type SyncSoundFeedback } from './syncSounds.ts';
import {
  armTemporaryWorkspaceOAuthReturn,
  beginTemporaryWorkspace,
  clearTemporaryWorkspaceOAuthReturn,
  getActiveTemporaryWorkspaceId,
  getTemporaryWorkspaceStartupCleanupReport,
  reloadForWorkspaceChange,
} from '../services/temporaryWorkspace.ts';
import {
  beginTemporaryProvenance,
  cleanupTemporaryOrigin,
  inspectTemporaryModePreflight,
  leaveEmptyTemporaryWorkspace,
  PUBLIC_DEVICE_LIMITATION,
  recordTemporaryPaperIds,
  setTemporaryFinishPhase,
} from './temporaryDeviceSession.ts';
import type { SyncProgress } from './types.ts';
import {
  acquireSharedWorkspaceRestoreLease,
  assertWorkspaceRestoreLease,
  withExclusiveWorkspaceRestoreLease,
  withWorkspaceIdentityTransition,
  type HeldWorkspaceRestoreLease,
  type WorkspaceRestoreLease,
} from '../services/workspaceRestoreLock.ts';
import {
  assertWorkspaceCloudOperationAllowed,
  clearDurablePublicationHold,
  loadDurableRestoreOperation,
  withWorkspaceMutation,
} from '../services/annotationPersistence.ts';
import {
  WorkspaceRestoreBarrierError,
  type DurableRestoreOperation,
} from '../services/restoreSafety.ts';
import {
  incorporateVerifiedMigrationHead,
  nextRemoteUpdateReminder,
  pendingSyncPaperIds,
  settleCapturedDirtyGeneration,
  type PaperRemoteReminder,
} from './paperStateMachine.ts';

const ROOT_NAME = '39Note';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const AUTO_UPLOAD_DELAY = 5_000;
const MAX_TRANSIENT_RETRY_DELAY = 60_000;
const FULL_DISCOVERY_AUDIT_INTERVAL = 7 * 24 * 60 * 60 * 1_000;
const MAX_BASELINE_REPLAY_ATTEMPTS = 2;
const MAX_LOCAL_REMOVAL_RECONCILE_ATTEMPTS = 2;
const RECENT_DRIVE_DIAGNOSTIC_LIMIT = 12;
const TARGETED_PURGE_PREVIEW_TTL = 5 * 60 * 1_000;
const DRIVE_READ_OPERATION_TIMEOUT = 90_000;
const DRIVE_READ_OPERATION_HARD_TIMEOUT = 5 * 60 * 1_000;
const DRIVE_MUTATION_OPERATION_TIMEOUT = 5 * 60 * 1_000;
const RESTORED_LIBRARY_DIRTY_REASONS: readonly PaperDirtyReason[] = [
  'metadata',
  'notes',
  'annotations',
  'glossary',
  'reading-state',
  'source-pdf',
  'source-document',
  'print-draft',
  'rendered-print-pdf',
  'ai-conversation',
];
const PAPER_ROOT_QUERY =
  `mimeType='${FOLDER_MIME}' and trashed=false and ` +
  "appProperties has { key='application' and value='39Note' } and " +
  "appProperties has { key='role' and value='root' }";

export async function discoverPaperRootsBeforeCreation(
  drive: Pick<DriveClient, 'listFiles'>,
  signal: AbortSignal,
): Promise<DriveFileMetadata[]> {
  const first = recognizedPaperRoots(await drive.listFiles(PAPER_ROOT_QUERY, signal));
  if (first.length > 0) return first;
  return recognizedPaperRoots(await drive.listFiles(PAPER_ROOT_QUERY, signal));
}

export async function confirmCreatedPaperRoot(
  drive: Pick<DriveClient, 'listFiles'>,
  created: DriveFileMetadata,
  signal: AbortSignal,
): Promise<DriveFileMetadata[]> {
  return recognizedPaperRoots([
    created,
    ...(await drive.listFiles(PAPER_ROOT_QUERY, signal)),
  ]);
}

function recognizedPaperRoots(files: readonly DriveFileMetadata[]) {
  return [
    ...new Map(
      files
        .filter(isOwnedManagedPaperRootMetadata)
        .map((file) => [file.id, file] as const),
    ).values(),
  ].sort((first, second) => first.id.localeCompare(second.id));
}

export function transientAutoRetryDelay(attempt: number): number {
  return Math.min(
    AUTO_UPLOAD_DELAY * 2 ** Math.max(0, Math.floor(attempt)),
    MAX_TRANSIENT_RETRY_DELAY,
  );
}

export type PaperConnectionStatus =
  | 'loading'
  | 'not-configured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'syncing'
  | 'offline'
  | 'reconnect-required'
  | 'root-selection-required'
  | 'root-unavailable'
  | 'layout-upgrade-required'
  | 'migration-incomplete'
  | 'attention';

export type RemoteUpdateReminder = PaperRemoteReminder;

export interface ActiveDriveOperationDiagnostic {
  operationType: DriveSyncOperationType;
  stage: 'admission' | 'running' | 'timed-out';
  startedAt: number;
  deadlineAt: number;
  pendingRequestCount: number;
  completedRequestCount: number;
}

export type DriveOperationTimeoutFailureCode =
  | 'admission-deadline-exceeded'
  | 'drive-request-in-flight-deadline-exceeded'
  | 'running-without-request-in-flight-deadline-exceeded'
  | 'read-operation-hard-deadline-exceeded';

export interface DriveOperationTimeoutDiagnostic {
  operationType: DriveSyncOperationType;
  timedOutFromStage: 'admission' | 'running';
  failureCode: DriveOperationTimeoutFailureCode;
  timedOutAt: number;
  pendingRequestCount: number;
  completedRequestCount: number;
  observedPhases: readonly {
    phase: string;
    elapsedMs: number;
    requestCount: number;
    retryCount: number;
  }[];
}

type DriveOperationTimeoutVisibility = 'global' | 'diagnostic-only';

class ReadTimeoutUploadDeferredError extends Error {
  constructor() {
    super('Upload deferred until the read-timeout recovery check settles.');
    this.name = 'ReadTimeoutUploadDeferredError';
  }
}

export interface PaperSyncViewState {
  connection: PaperConnectionStatus;
  backendConfigured: boolean;
  deviceMode: SyncDeviceMode;
  deviceModeChoiceConfirmed: boolean;
  autoSync: boolean;
  papers: PaperCloudSummary[];
  paperStates: PaperSyncState[];
  dirtyPaperIds: string[];
  /** Active local-only exceptions for the currently verified account and root. */
  ignoredCloudIssues?: IgnoredPaperCloudIssue[];
  /** A reviewed exception is awaiting a complete read-only Drive check. */
  reviewedCloudIssueRevalidationPending?: boolean;
  sessions: GoogleDeviceSessionSummary[];
  rootChoices: DriveFileMetadata[];
  rootUrl?: string;
  lastSuccessfulAt?: number;
  /** A completed Drive check with an account/root/mode-bound committed cursor. */
  lastVerifiedDriveAt?: number;
  progress: SyncProgress;
  /**
   * View-independent Drive tasks currently owned by this workspace coordinator.
   * React surfaces observe this list; subscribing or unsubscribing never owns or
   * cancels the underlying task.
   */
  activePaperOperations: PaperActiveOperation[];
  /** Redacted liveness diagnostic for the one serialized Drive owner. */
  activeDriveOperation?: ActiveDriveOperationDiagnostic;
  /**
   * Development-facing, identity-free evidence from the most recent Drive
   * watchdog expiry. It remains after the owning task settles so a timeout is
   * not reduced to the generic user-facing error code.
   */
  lastDriveOperationTimeout?: DriveOperationTimeoutDiagnostic;
  issue?: SyncOperationalIssue;
  error?: string;
  reminder?: RemoteUpdateReminder;
  publicDeviceNotice?: string;
  securityState?: PaperSyncSecurityState;
  temporaryCleanupNotice?: string;
  legacyHousekeeping: LegacyDriveHousekeepingViewState;
  folderNameMaintenance: PaperFolderNameMaintenanceViewState;
  restorePublicationHold?: {
    status: 'waiting' | 'revalidating' | 'failed';
    restoredDocumentCount: number;
    error?: string;
  };
  restorePublicationNotice?: string;
  /** Selects the only safe explicit upgrade flow for the detected root. */
  layoutUpgradeKind?: 'legacy-to-v2' | 'v2-to-v3' | 'protocol-2-to-3';
}

export interface IgnoredPaperCloudIssue {
  documentId: string;
  displayName: string;
  confirmedAt: number;
}

export interface ForgetInaccessiblePaperCandidate {
  documentId: string;
  displayName: string;
}

export interface ForgetInaccessiblePaperDiagnostic {
  eligible: boolean;
  reason:
    | 'eligible'
    | 'workspace-profile-missing'
    | 'personal-device-required'
    | 'account-identity-unavailable'
    | 'account-scope-mismatch'
    | 'root-scope-missing'
    | 'already-ignored'
    | 'catalog-paper-missing'
    | 'paper-not-needs-attention'
    | 'paper-removed'
    | 'paper-folder-unavailable'
    | 'local-state-missing'
    | 'local-cloud-presence-not-present'
    | 'paper-folder-mismatch'
    | 'identity-proof-unavailable';
  evidenceSource:
    | 'catalog-failure'
    | 'reviewed-quarantine'
    | 'blocking-map'
    | 'failed-inspection'
    | 'none';
  candidate?: ForgetInaccessiblePaperCandidate;
  /** Redacted gates only; no account, folder, or document identity is returned. */
  predicates: {
    profilePresent: boolean;
    personalDevice: boolean;
    accountIdentityPresent: boolean;
    accountScopeMatches: boolean;
    workspaceScopeMatches: boolean;
    rootScopePresent: boolean;
    catalogPaperPresent: boolean;
    catalogNeedsAttention: boolean;
    paperNotDeleted: boolean;
    paperNotRemoved: boolean;
    paperFolderAvailable: boolean;
    localStatePresent: boolean;
    localStateNeedsAttention: boolean;
    localPresencePresent: boolean;
    paperFolderMatches: boolean;
    catalogFailureExact: boolean;
    reviewedProofPresent: boolean;
    sessionProofPresent: boolean;
    identityProofAvailable: boolean;
  };
}

export interface ForgetInaccessiblePaperResult {
  documentId: string;
  alreadyIgnored: boolean;
}

export class DriveOperationTimeoutError extends Error {
  readonly mayHaveMutated: boolean;

  constructor(
    readonly operationType: DriveSyncOperationType,
    readonly timeoutMs: number,
    mayHaveMutated = driveOperationMayHaveMutated(operationType),
    readonly resumableReadProgress = false,
  ) {
    super(
      mayHaveMutated
        ? 'Google Drive stopped responding after a remote change may have started.'
        : 'Google Drive took too long to respond.',
    );
    this.name = 'DriveOperationTimeoutError';
    this.mayHaveMutated = mayHaveMutated;
  }
}

export function driveOperationTimeoutMs(
  operationType: DriveSyncOperationType,
  mayHaveMutated = driveOperationMayHaveMutated(operationType),
): number {
  return mayHaveMutated
    ? DRIVE_MUTATION_OPERATION_TIMEOUT
    : DRIVE_READ_OPERATION_TIMEOUT;
}

function driveOperationMayHaveMutated(operationType: DriveSyncOperationType): boolean {
  return !['scan', 'download', 'restore-revalidation'].includes(operationType);
}

/**
 * Lets the safety deadline escape a non-abortable read (for example an
 * IndexedDB admission check) without turning ordinary disconnect cancellation
 * into detached background work. The original Promise remains observed.
 */
function awaitDriveOperationDeadline<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted && signal.reason instanceof DriveOperationTimeoutError) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    let deadlineExpired = false;
    const onAbort = () => {
      if (!(signal.reason instanceof DriveOperationTimeoutError)) return;
      deadlineExpired = true;
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (!deadlineExpired) resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        if (!deadlineExpired) reject(error);
      },
    );
  });
}

export type PaperSyncSecurityState =
  | { kind: 'device-mode-required' }
  | { kind: 'public-root-missing' }
  | { kind: 'account-association-required' }
  | { kind: 'account-mismatch' }
  | { kind: 'account-identity-unavailable' };

export type PaperActiveOperationType =
  'download' | 'upload' | 'remove' | 'restore' | 'keep-local';

export interface PaperActiveOperation {
  id: string;
  type: PaperActiveOperationType;
  documentIds: string[];
  startedAt: number;
}

export interface PaperBulkRemovalProgress {
  completed: number;
  total: number;
}

export interface PaperBulkRemovalResult {
  /** Papers newly transitioned to the authoritative removed state. */
  removed: string[];
  /** Idempotent retries that were already authoritatively removed. */
  alreadyRemoved: string[];
  cleanupPending: Array<{ documentId: string; message?: string }>;
  /** Failures that did not produce a verified removed result. */
  failed: Array<{ documentId: string; message: string }>;
}

export interface TargetedPaperPurgePreview {
  eligible: boolean;
  previewToken?: string;
  documentId: string;
  displayName: string;
  local: {
    documentRecord: boolean;
    sourceRecord: boolean;
    syncStateRecord: boolean;
    cloudCatalogRecord: boolean;
    printDraftRecord: boolean;
    renderedPrintPdfRecord: boolean;
    aiConversationCount: number;
  };
  cloud: {
    paperFolderCount: number;
    paperFileCount: number;
    validPresenceCount: number;
    corruptPresenceCount: number;
    presenceState?: 'present' | 'removed';
    presenceHeadCount: number;
    preservedPresenceCount: number;
    ancestryDiagnostic?: TargetedPurgePresenceAncestryDiagnostic;
  };
  preserved: {
    collectionRecords: true;
    sharedRootAndControl: true;
    unrelatedPapers: true;
    removedPresenceTombstone: true;
  };
  blocker?: { code: string; message: string };
}

export interface TargetedPaperPurgeResult {
  documentId: string;
  status: 'complete' | 'cleanup-pending';
  corruptPresenceFilesTrashed: number;
  message?: string;
}

export type LegacyDriveHousekeepingStatus =
  'idle' | 'checking' | 'ready' | 'cleaning' | 'complete' | 'failed';

export interface LegacyDriveHousekeepingViewState {
  status: LegacyDriveHousekeepingStatus;
  inventory?: LegacyDriveInventory;
  error?: string;
  lastTrashedCount?: number;
}

export type PaperFolderNameMaintenanceStatus =
  'idle' | 'checking' | 'ready' | 'normalizing' | 'complete' | 'failed';

export interface PaperFolderNameMaintenanceViewState {
  status: PaperFolderNameMaintenanceStatus;
  preview?: PaperFolderNameNormalizationPreview;
  error?: string;
  lastRenamedCount?: number;
}

export const LEGACY_CLEANUP_CONFIRMATION = 'move-recognized-legacy-to-trash' as const;
export const PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION =
  'normalize-paper-folder-names' as const;

export type PaperSyncUiStatus =
  | 'loading'
  | 'not-configured'
  | 'disconnected'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'attention';

export function getBlockingPaperIssueCount(state: PaperSyncViewState): number {
  const ignored = new Set(
    (state.ignoredCloudIssues ?? []).map(({ documentId }) => documentId),
  );
  return new Set([
    ...state.papers
      .filter(
        (paper) => paper.status === 'needs-attention' && !ignored.has(paper.documentId),
      )
      .map(({ documentId }) => documentId),
    ...state.paperStates
      .filter(
        (paper) => paper.status === 'needs-attention' && !ignored.has(paper.documentId),
      )
      .map(({ documentId }) => documentId),
  ]).size;
}

/**
 * A read-only check is complete only when its cursor was durably committed for
 * this exact workspace. An audit checkpoint is progress, never a success.
 */
export function verifiedDriveCheckAt(
  profile: PaperSyncDeviceProfile,
): number | undefined {
  const cursor = profile.driveChangeCursor;
  const checkedAt = profile.lastDiscoveryAt;
  if (
    !cursor ||
    profile.driveAuditCheckpoint ||
    cursor.version !== 1 ||
    !cursor.pageToken ||
    !profile.accountId ||
    !profile.rootFolderId ||
    cursor.accountId !== profile.accountId ||
    cursor.rootFolderId !== profile.rootFolderId ||
    cursor.deviceMode !== profile.deviceMode ||
    typeof checkedAt !== 'number' ||
    !Number.isFinite(checkedAt) ||
    checkedAt < 0 ||
    checkedAt > Date.now() ||
    !Number.isFinite(cursor.lastFullAuditAt) ||
    cursor.lastFullAuditAt < 0 ||
    cursor.lastFullAuditAt > checkedAt
  ) {
    return undefined;
  }
  return checkedAt;
}

export function getPaperSyncUiStatus(state: PaperSyncViewState): PaperSyncUiStatus {
  const ignored = new Set(
    (state.ignoredCloudIssues ?? []).map(({ documentId }) => documentId),
  );
  if (state.connection === 'loading') return 'loading';
  if (state.connection === 'not-configured') return 'not-configured';
  if (state.connection === 'disconnected') return 'disconnected';
  if (state.connection === 'connecting') return 'connecting';
  if (state.connection === 'syncing') return 'syncing';
  if (state.connection === 'offline') return 'offline';
  if (
    state.connection === 'attention' ||
    state.connection === 'reconnect-required' ||
    state.connection === 'root-selection-required' ||
    state.connection === 'root-unavailable' ||
    state.connection === 'layout-upgrade-required' ||
    state.connection === 'migration-incomplete' ||
    getBlockingPaperIssueCount(state) > 0
  )
    return 'attention';
  if (state.restorePublicationHold) return 'pending';
  if (state.reviewedCloudIssueRevalidationPending) return 'attention';
  if (
    state.issue?.code === 'drive-operation-timeout' &&
    state.issue.state === 'pending'
  ) {
    return 'pending';
  }
  if (state.dirtyPaperIds.length > 0) return 'pending';
  if (
    state.paperStates.some(
      (paper) =>
        !ignored.has(paper.documentId) &&
        (paper.status === 'remote-update-available' || paper.status === 'both-changed'),
    )
  )
    return 'connected';
  return state.lastSuccessfulAt || state.lastVerifiedDriveAt ? 'synced' : 'connected';
}

type Listener = (state: PaperSyncViewState) => void;

/** FIFO ownership for Drive work. Contention queues; it is not an exceptional state. */
export class SerializedDriveOperationOwner {
  private tail: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private readonly releases = new WeakMap<AbortSignal, () => void>();
  private outstandingOperations = 0;
  private suspensionCount = 0;
  private admissionEpoch = 0;
  private suspensionReason?: DOMException;
  private destroyed = false;

  get active(): boolean {
    return this.outstandingOperations > 0;
  }

  async begin(): Promise<AbortSignal> {
    if (this.destroyed || this.suspensionCount > 0) {
      throw (
        this.suspensionReason ??
        new DOMException('Sync coordinator closed.', 'AbortError')
      );
    }
    const admissionEpoch = this.admissionEpoch;
    this.outstandingOperations += 1;
    const previous = this.tail.catch(() => undefined);
    let release!: () => void;
    const owned = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => owned);
    await previous;
    if (
      this.destroyed ||
      this.suspensionCount > 0 ||
      admissionEpoch !== this.admissionEpoch
    ) {
      this.outstandingOperations -= 1;
      release();
      throw (
        this.suspensionReason ??
        new DOMException('Sync coordinator closed.', 'AbortError')
      );
    }
    const controller = new AbortController();
    this.controller = controller;
    this.releases.set(controller.signal, release);
    return controller.signal;
  }

  end(signal: AbortSignal): void {
    const release = this.releases.get(signal);
    if (!release) return;
    this.releases.delete(signal);
    this.outstandingOperations -= 1;
    if (this.controller?.signal === signal) this.controller = null;
    release();
  }

  cancel(reason: unknown = new DOMException('Canceled', 'AbortError')): void {
    this.controller?.abort(reason);
  }

  /**
   * Rejects queued ownership, aborts the current owner, and waits until every
   * command admitted before the suspension has left FIFO ownership. New work
   * is rejected until the matching `resume` call.
   */
  async suspendAndDrain(
    reason = new DOMException('Google Drive session is closing.', 'AbortError'),
  ): Promise<void> {
    this.suspensionCount += 1;
    this.admissionEpoch += 1;
    this.suspensionReason = reason;
    this.cancel(reason);
    await this.tail.catch(() => undefined);
  }

  resume(): void {
    if (this.suspensionCount === 0) return;
    this.suspensionCount -= 1;
    if (this.suspensionCount === 0) this.suspensionReason = undefined;
  }

  destroy(): void {
    this.destroyed = true;
    this.admissionEpoch += 1;
    this.suspensionReason = new DOMException('Sync coordinator closed.', 'AbortError');
    this.cancel(this.suspensionReason);
  }
}

interface BlockingPaperIssue {
  headSetId?: string;
  issue: SyncOperationalIssue;
}

interface RootWideBlockingIssue {
  accountId: string;
  rootFolderId: string;
  issue: SyncOperationalIssue;
}

interface PendingTargetedPaperPurge {
  documentId: string;
  proof: TargetedPaperPurgeProof;
  blockingIssueFingerprint?: string;
  diagnosticEvidenceFingerprint?: string;
  checkpointFingerprint?: string;
  localFingerprint: string;
  accountId: string;
  rootFolderId: string;
  createdAt: number;
}

export type PaperRetryOperation =
  'upload' | 'download' | 'remove-cleanup' | 'revalidate';

export type PaperRetryAction = PaperRetryOperation | 'none';

export interface PaperRetryDiagnosticIssue {
  code: string;
  operation?: string;
  phase?: string;
  causeCode?: string;
  retrySafe: boolean;
  blocksOrdinarySync: boolean;
}

export interface PaperRetryDiagnosticTarget {
  /** Session-local ordinal only. No document or Drive identity is exposed. */
  target: string;
  admission: {
    status?: PaperSyncState['status'];
    cloudPresence?: PaperSyncState['cloudPresence'];
    dirtyReasonCount: number;
    packageHeadCount: number;
    incorporatedHeadCount: number;
    presenceHeadCount: number;
    retryIntent?: PaperRetryOperation;
    catalogIssueCode?: string;
    catalogIssuePhase?: string;
    catalogCauseCode?: string;
    activeBlockingIssue?: PaperRetryDiagnosticIssue;
  };
  repository?: {
    result: 'missing' | 'verified' | 'needs-attention';
    status?: PaperCloudSummary['status'];
    presenceState: 'missing' | 'present' | 'removed';
    packageHeadCount: number;
    presenceHeadCount: number;
    issueCode?: string;
    phase?: string;
    causeCode?: string;
  };
  settlement?: {
    blockDisposition: 'none' | 'cleared' | 'introduced' | 'retained' | 'replaced';
    selectedAction?: PaperRetryAction;
    finalStatus?: PaperSyncState['status'];
    activeBlockingIssue?: PaperRetryDiagnosticIssue;
  };
}

export interface PaperRetryDiagnosticSnapshot {
  operation: 'paper-retry';
  phase: 'admission' | 'revalidation' | 'execution' | 'settled' | 'failed';
  targetCount: number;
  targets: PaperRetryDiagnosticTarget[];
  failure?: PaperRetryDiagnosticIssue;
}

export type PaperSyncStatusInspectionPhase =
  'admission' | 'inspection' | 'complete' | 'stale' | 'failed';

export type PaperUploadPermissionReason =
  | 'permitted'
  | 'no-local-state'
  | 'no-pending-local-changes'
  | 'paper-removed'
  | 'current-blocking-issue'
  | 'authoritative-needs-attention'
  | 'remote-update-requires-reconciliation'
  | 'authoritative-result-missing'
  | 'local-state-changed-during-inspection'
  | 'inspection-failed-closed';

export interface PaperSyncStatusDiagnosticTarget {
  /** Session-local ordinal only. No document or Drive identity is exposed. */
  target: string;
  current: {
    status?: PaperSyncState['status'];
    cloudPresence?: PaperSyncState['cloudPresence'];
    dirtyReasonCount: number;
    packageHeadCount: number;
    presenceHeadCount: number;
    blockingIssue?: PaperRetryDiagnosticIssue;
  };
  authoritative?: {
    result: 'missing' | 'verified' | 'needs-attention';
    status?: PaperCloudSummary['status'];
    presenceState: 'missing' | 'present' | 'removed';
    packageHeadCount: number;
    presenceHeadCount: number;
    issue?: PaperRetryDiagnosticIssue;
  };
  upload: {
    permitted: boolean;
    reason: PaperUploadPermissionReason;
  };
}

export interface PaperSyncStatusDiagnosticSnapshot {
  operation: 'paper-sync-status-check';
  phase: PaperSyncStatusInspectionPhase;
  targetCount: number;
  targets: PaperSyncStatusDiagnosticTarget[];
  failure?: PaperRetryDiagnosticIssue;
}

/** Development runtime contract only. It is not a Drive or paper protocol version. */
export const PAPER_SYNC_COORDINATOR_RUNTIME_REVISION = 3 as const;

/**
 * Production permits only the exact Browse-row verification path. Broader
 * diagnostic scans remain development-only so production cannot enumerate
 * unrelated paper state through this API.
 */
export function canRunPaperSyncStatusReadOnlyInspection(
  development: boolean,
  exactForgetScopeAvailable: boolean,
): boolean {
  return development || exactForgetScopeAvailable;
}
/** Redacted targeted-purge predicate contract only. */
export const TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION = 2 as const;

export interface TargetedPaperPurgeVisibilityDiagnostic {
  /** Incremented only when the redacted predicate contract changes. */
  implementationRevision: typeof TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION;
  /** True only when one exact document identity is safely correlated. */
  visible: boolean;
  /** May be true without `visible` so the UI can explain a fail-closed block. */
  showRecoveryCard: boolean;
  candidateSource:
    'checkpoint' | 'blocking-map' | 'failed-inspection' | 'view' | 'none';
  hiddenReason:
    | 'not-hidden'
    | 'multiple-exact-blocking-candidates'
    | 'diagnostic-context-missing'
    | 'diagnostic-context-stale'
    | 'diagnostic-target-count-not-one'
    | 'diagnostic-context-target-count-not-one'
    | 'diagnostic-target-missing'
    | 'diagnostic-snapshot-not-needs-attention'
    | 'diagnostic-snapshot-presence-not-present'
    | 'diagnostic-upload-not-blocked'
    | 'diagnostic-upload-not-failed-closed'
    | 'current-state-missing'
    | 'current-state-not-needs-attention'
    | 'current-presence-not-present'
    | 'correlated-target-not-retry-eligible'
    | 'diagnostic-phase-not-failed'
    | 'diagnostic-failure-missing'
    | 'diagnostic-failure-code-mismatch'
    | 'diagnostic-failure-not-blocking'
    | 'diagnostic-operation-mismatch'
    | 'diagnostic-failure-phase-mismatch'
    | 'diagnostic-cause-mismatch'
    | 'diagnostic-not-current-exact-failure'
    | 'local-quarantine-active'
    | 'no-exact-candidate';
  /** Aggregate counts only; no document, account, or Drive identity is exposed. */
  exactBlockingCandidateCount: number;
  retryCandidateCount: number;
  predicates: {
    implementationCurrent: true;
    checkpointCandidateAvailable: boolean;
    exactBlockingCandidateUnique: boolean;
    exactBlockingCandidatesUnambiguous: boolean;
    diagnosticPresent: boolean;
    diagnosticContextPresent: boolean;
    diagnosticSequenceCurrent: boolean;
    diagnosticPhaseFailed: boolean;
    diagnosticTargetCountOne: boolean;
    diagnosticContextTargetCountOne: boolean;
    diagnosticContextIdentityPresent: boolean;
    diagnosticFailurePresent: boolean;
    diagnosticFailureCodeMatches: boolean;
    diagnosticFailureBlocksOrdinarySync: boolean;
    diagnosticOperationMatches: boolean;
    diagnosticFailurePhaseMatches: boolean;
    diagnosticCauseMatches: boolean;
    exactDiagnosticFailure: boolean;
    exactFailedDiagnosticVisible: boolean;
    diagnosticTargetPresent: boolean;
    diagnosticSnapshotNeedsAttention: boolean;
    diagnosticSnapshotPresencePresent: boolean;
    diagnosticUploadBlocked: boolean;
    diagnosticUploadFailedClosed: boolean;
    currentStatePresent: boolean;
    currentStateNeedsAttention: boolean;
    currentPresencePresent: boolean;
    retryCandidateContainsCorrelatedTarget: boolean;
    failedInspectionEvidenceComplete: boolean;
    diagnosticTargetQuarantined: boolean;
    viewCandidateAvailable: boolean;
    candidateResolved: boolean;
  };
}

interface TargetedPaperPurgeDiagnosticEvidence {
  documentId: string;
  fingerprint: string;
}

interface TargetedPaperPurgeVisibilityEvaluation {
  candidateDocumentId?: string;
  diagnosticEvidence?: TargetedPaperPurgeDiagnosticEvidence;
  diagnostic: TargetedPaperPurgeVisibilityDiagnostic;
}

function isTargetedPaperPurgeDiagnosticFailure(
  issue: PaperRetryDiagnosticIssue | undefined,
): boolean {
  return Boolean(
    issue?.code === 'drive-integrity-mismatch' &&
    issue.blocksOrdinarySync &&
    issue.operation === 'paper-presence-invalid' &&
    issue.phase === 'paper-presence-resolution' &&
    issue.causeCode === 'presence-control-resolution-failed',
  );
}

function retryDiagnosticIssue(
  issue: SyncOperationalIssue | undefined,
): PaperRetryDiagnosticIssue | undefined {
  if (!issue) return undefined;
  return {
    code: issue.code,
    ...(issue.diagnostic.operation ? { operation: issue.diagnostic.operation } : {}),
    ...(issue.diagnostic.phase ? { phase: issue.diagnostic.phase } : {}),
    ...(issue.diagnostic.causeCode ? { causeCode: issue.diagnostic.causeCode } : {}),
    retrySafe: issue.retrySafe,
    blocksOrdinarySync: issue.blocksOrdinarySync,
  };
}

function paperBlockingIssueFingerprint(issue: BlockingPaperIssue | undefined): string {
  if (!issue) return 'none';
  return JSON.stringify({
    headSetId: issue.headSetId,
    code: issue.issue.code,
    operation: issue.issue.diagnostic.operation,
    phase: issue.issue.diagnostic.phase,
    causeCode: issue.issue.diagnostic.causeCode,
    retrySafe: issue.issue.retrySafe,
    blocksOrdinarySync: issue.issue.blocksOrdinarySync,
  });
}

function sameAuthoritativeIssue(
  current: SyncOperationalIssue | undefined,
  authoritative: SyncOperationalIssue,
): boolean {
  return Boolean(
    current &&
    current.code === authoritative.code &&
    current.diagnostic.operation === authoritative.diagnostic.operation &&
    current.diagnostic.phase === authoritative.diagnostic.phase &&
    current.diagnostic.causeCode === authoritative.diagnostic.causeCode &&
    current.retrySafe === authoritative.retrySafe &&
    current.blocksOrdinarySync === authoritative.blocksOrdinarySync &&
    current.actions.length === authoritative.actions.length &&
    current.actions.every((action, index) => action === authoritative.actions[index]),
  );
}

function paperSyncStatusGuardFingerprint(
  state: PaperSyncState | undefined,
  paper: PaperCloudSummary | undefined,
): string {
  return JSON.stringify({
    status: state?.status,
    cloudPresence: state?.cloudPresence,
    dirtyGeneration: state?.dirtyGeneration,
    dirtyReasons: state?.dirtyReasons,
    remoteHeadIds: state?.remoteHeadIds,
    incorporatedHeadIds: state?.incorporatedHeadIds,
    presenceHeadIds: state?.presenceHeadIds,
    statePaperFolderId: state?.driveFiles.paperFolderId,
    catalogStatus: paper?.status,
    catalogDeleted: paper?.deleted,
    catalogPaperFolderId: paper?.paperFolderId,
    catalogHeadSetId: paper?.headSetId,
    catalogPresenceState: paper?.presenceState,
    catalogIssueCode: paper?.issue?.code,
    catalogIssuePhase: paper?.issue?.phase,
    catalogCauseCode: paper?.issue?.causeCode,
  });
}

function readOnlyUploadPermission(
  state: PaperSyncState | undefined,
  currentIssue: SyncOperationalIssue | undefined,
  paper: PaperCloudSummary | undefined,
  unavailableReason?: Extract<
    PaperUploadPermissionReason,
    | 'authoritative-result-missing'
    | 'local-state-changed-during-inspection'
    | 'inspection-failed-closed'
  >,
): PaperSyncStatusDiagnosticTarget['upload'] {
  if (unavailableReason) return { permitted: false, reason: unavailableReason };
  if (!state) return { permitted: false, reason: 'no-local-state' };
  if (state.cloudPresence === 'removed' || paper?.presenceState === 'removed') {
    return { permitted: false, reason: 'paper-removed' };
  }
  if (!state.dirtyReasons.length) {
    return { permitted: false, reason: 'no-pending-local-changes' };
  }
  if (currentIssue?.blocksOrdinarySync) {
    return { permitted: false, reason: 'current-blocking-issue' };
  }
  if (
    !paper ||
    paper.status === 'needs-attention' ||
    paper.issue ||
    paper.presenceState !== 'present' ||
    !paper.presenceHeadIds?.length
  ) {
    return { permitted: false, reason: 'authoritative-needs-attention' };
  }
  if (paper.headIds.some((headId) => !state.incorporatedHeadIds.includes(headId))) {
    return { permitted: false, reason: 'remote-update-requires-reconciliation' };
  }
  return { permitted: true, reason: 'permitted' };
}

export class DeviceModeSelectionRequiredError extends Error {
  constructor() {
    super('Choose how you are using this device before connecting Google Drive.');
    this.name = 'DeviceModeSelectionRequiredError';
  }
}

export class PublicDeviceRootMissingError extends Error {
  constructor() {
    super(
      'No 39Note Drive library was found for this account. Set up Drive sync on a personal device before using it on a public device.',
    );
    this.name = 'PublicDeviceRootMissingError';
  }
}

export class WorkspaceAccountAssociationRequiredError extends Error {
  constructor() {
    super(
      'This local Library has not yet been associated with a Google account. Confirm the account before any Drive data is read or published.',
    );
    this.name = 'WorkspaceAccountAssociationRequiredError';
  }
}

export class WorkspaceAccountMismatchError extends Error {
  constructor() {
    super(
      'This local 39Note library is associated with a different Google account. Sync has been paused to prevent your study data from being uploaded to the wrong account.',
    );
    this.name = 'WorkspaceAccountMismatchError';
  }
}

export class WorkspaceAccountIdentityUnavailableError extends Error {
  constructor() {
    super(
      '39Note could not verify which Google account owns this session. Sync is paused; disconnect and reconnect before trying again.',
    );
    this.name = 'WorkspaceAccountIdentityUnavailableError';
  }
}

/**
 * Merge an exact-paper discovery result without accepting incidental changes to
 * papers outside the requested scope. Scoped repository reads normally return
 * an already merged catalog; doing the boundary merge again here makes the
 * Retry contract explicit and keeps unrelated catalog entries referentially
 * unchanged even if a future repository implementation returns only targets.
 */
export function mergeScopedPaperDiscoveryCatalog(
  baseline: readonly PaperCloudSummary[],
  discovered: readonly PaperCloudSummary[],
  scopedDocumentIds: readonly string[],
): PaperCloudSummary[] {
  const scope = new Set(scopedDocumentIds);
  const byDocumentId = new Map(
    baseline
      .filter((paper) => !scope.has(paper.documentId))
      .map((paper) => [paper.documentId, paper] as const),
  );
  for (const paper of discovered) {
    if (scope.has(paper.documentId)) byDocumentId.set(paper.documentId, paper);
  }
  return [...byDocumentId.values()].sort((first, second) =>
    first.documentId.localeCompare(second.documentId),
  );
}

/**
 * Presence is an independent immutable history from the paper package heads.
 * An exact scoped reread can therefore prove that an earlier presence failure
 * has gone away even when the package head set is unchanged. Only retire the
 * old block when the repository returned a complete, healthy present-presence
 * snapshot; structural ambiguity or missing verification remains fail-closed.
 */
export function hasVerifiedPresenceRecovery(
  paper: Pick<
    PaperCloudSummary,
    'issue' | 'presenceHeadIds' | 'presenceState' | 'status'
  >,
  previousIssue: SyncOperationalIssue | undefined,
  previousCatalogIssueCode: string | undefined,
): boolean {
  const wasPresenceFailure = previousIssue
    ? previousIssue.diagnostic.operation === 'paper-presence-invalid'
    : previousCatalogIssueCode === 'paper-presence-invalid';
  return Boolean(
    wasPresenceFailure &&
    paper.status !== 'needs-attention' &&
    paper.issue === undefined &&
    paper.presenceState === 'present' &&
    paper.presenceHeadIds?.length,
  );
}

/**
 * The destructive recovery affordance is intentionally limited to the one
 * failure class that ordinary Remove cannot enter: a document-scoped presence
 * control read failed before an authoritative paper could be resolved.
 */
export function isTargetedPaperPurgeCandidate(
  issue: SyncOperationalIssue | undefined,
): boolean {
  return Boolean(
    issue?.code === 'drive-integrity-mismatch' &&
    issue.blocksOrdinarySync &&
    issue.diagnostic.operation === 'paper-presence-invalid' &&
    issue.diagnostic.phase === 'paper-presence-resolution' &&
    issue.diagnostic.causeCode === 'presence-control-resolution-failed',
  );
}

function isQuarantinablePresenceCatalogIssue(
  issue: PaperCloudSummary['issue'] | undefined,
): boolean {
  return Boolean(
    issue?.code === 'paper-presence-invalid' &&
    issue.phase === 'paper-presence-resolution' &&
    issue.causeCode === 'presence-control-resolution-failed',
  );
}

/**
 * State-only fallback for presentation/tests. The coordinator additionally
 * consults its authoritative document-keyed blocking map so a paper-scoped
 * error cannot become unreachable merely because redacted presentation state
 * omitted the already-known document identity.
 */
export function targetedPaperPurgeCandidateFromView(
  state: PaperSyncViewState,
): string | undefined {
  const confirmedCandidates = state.paperStates.filter(
    (paper) => paper.targetedPurge !== undefined,
  );
  if (confirmedCandidates.length > 0) {
    return [...confirmedCandidates].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    )[0]?.documentId;
  }
  const globalDocumentId = isTargetedPaperPurgeCandidate(state.issue)
    ? state.issue?.diagnostic.documentId
    : undefined;
  if (globalDocumentId) return globalDocumentId;
  const catalogCandidates = state.papers.filter(
    (paper) =>
      paper.issue?.code === 'paper-presence-invalid' &&
      paper.issue.phase === 'paper-presence-resolution' &&
      paper.issue.causeCode === 'presence-control-resolution-failed',
  );
  return catalogCandidates.length === 1 ? catalogCandidates[0]?.documentId : undefined;
}

export function classifyPaperCoordinatorError(
  error: unknown,
  online = typeof navigator === 'undefined' || navigator.onLine !== false,
): SyncOperationalIssue {
  if (error instanceof DriveOperationTimeoutError) {
    if (error.mayHaveMutated) {
      return {
        code: 'drive-mutation-uncertain',
        message:
          'Google Drive stopped responding after a change may have started. 39Note did not mark it successful. Retry rechecks Drive before any further upload.',
        severity: 'error',
        state: 'attention',
        actions: ['retry-now', 'details'],
        retrySafe: false,
        blocksOrdinarySync: true,
        backupRecommended: error.operationType === 'upload',
        diagnostic: {
          source: 'google-drive',
          operation: error.operationType,
          phase: 'operation-watchdog',
          causeCode: 'deadline-exceeded-remote-outcome-unknown',
        },
      };
    }
    const resumableAudit = error.resumableReadProgress && online;
    return {
      code: 'drive-operation-timeout',
      message: resumableAudit
        ? 'Drive verification reached this run’s safety limit. Its local audit starting point was retained; previously verified records may be reused. Continue the read-only check. No remote result was reported as successful.'
        : 'Google Drive did not respond before the safety deadline. The operation stopped without reporting success; local work remains saved.',
      severity: 'warning',
      state: resumableAudit ? 'pending' : 'offline',
      actions: ['automatic-retry', 'retry-now', 'details'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: {
        source: 'google-drive',
        operation: error.operationType,
        phase: 'operation-watchdog',
        causeCode: resumableAudit
          ? 'read-verification-paused-progress-retained'
          : 'deadline-exceeded',
      },
    };
  }
  if (error instanceof DeviceModeSelectionRequiredError) {
    return securityIssue(
      'device-mode-required',
      error.message,
      ['select-device-mode', 'details'],
      'device-mode',
    );
  }
  if (error instanceof PublicDeviceRootMissingError) {
    return securityIssue(
      'public-root-missing',
      error.message,
      ['disconnect', 'details'],
      'root-discovery',
    );
  }
  if (error instanceof WorkspaceAccountAssociationRequiredError) {
    return securityIssue(
      'account-association-required',
      error.message,
      ['associate-account', 'disconnect', 'details'],
      'account-binding',
    );
  }
  if (
    error instanceof WorkspaceAccountMismatchError ||
    error instanceof WorkspaceAccountBindingConflictError
  ) {
    return securityIssue(
      'account-mismatch',
      error.message,
      ['reconnect', 'disconnect', 'details'],
      'account-binding',
    );
  }
  if (error instanceof WorkspaceAccountIdentityUnavailableError) {
    return securityIssue(
      'account-identity-unavailable',
      error.message,
      ['disconnect', 'details'],
      'account-verification',
    );
  }
  if (error instanceof OfficeNativePaperProductDisabledError) {
    return {
      code: 'drive-integrity-mismatch',
      message: error.message,
      severity: 'warning',
      state: 'attention',
      actions: ['details'],
      retrySafe: false,
      blocksOrdinarySync: true,
      backupRecommended: true,
      diagnostic: {
        source: 'sync',
        operation: 'office-native-product-policy',
        documentId: error.documentId,
      },
    };
  }
  if (!(error instanceof PaperRepositoryError)) {
    return classifySyncError(error, { online, area: 'sync' });
  }
  if (error.code === 'paper-remote-changed') {
    return {
      code: 'drive-changed',
      message: 'Drive changed during sync. 39Note will safely retry.',
      severity: 'info',
      state: 'pending',
      actions: ['automatic-retry', 'retry-now'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'reconciliation' },
    };
  }
  if (error.code === 'paper-removed-from-drive') {
    return {
      code: 'paper-removed-from-drive',
      message:
        'This paper was removed from Drive. Restore it explicitly to sync again.',
      severity: 'info',
      state: 'pending',
      actions: ['details'],
      retrySafe: false,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'paper-presence' },
    };
  }
  if (error instanceof PaperPayloadPartitionError) {
    return {
      code: 'paper-logical-partition-invalid',
      message: 'Drive paper data needs verification.',
      severity: 'error',
      state: 'attention',
      actions: ['details'],
      retrySafe: false,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: {
        source: 'google-drive',
        operation: 'paper-semantic-validation',
        documentId: error.documentId,
        expectedSemanticPartition: error.expectedSemanticPartition,
        actualSemanticPartitions: error.actualSemanticPartitions,
        ...(error.sourceProtocolVersion !== undefined
          ? { sourceProtocolVersion: error.sourceProtocolVersion }
          : {}),
        compatibilityNormalizationAttempted: error.compatibilityNormalizationAttempted,
      },
    };
  }
  const messages: Partial<Record<PaperRepositoryError['code'], string>> = {
    'ambiguous-paper-folder': 'Multiple Drive folders claim the same paper.',
    'paper-integrity-failed': 'Drive paper data needs verification.',
    'paper-source-pdf-conflict': 'The paper source PDF conflicts with Drive.',
    'drive-root-invalid': 'The connected 39Note folder is not valid.',
    'drive-root-missing': 'The connected 39Note folder is no longer available.',
    'layout-upgrade-required': 'Drive layout upgrade is required.',
    'layout-migration-incomplete': 'Drive layout upgrade did not finish.',
    'layout-migration-proof-invalid': 'Drive layout upgrade evidence is invalid.',
    'unsupported-layout': 'This Drive library was created by a newer 39Note version.',
    'unsupported-protocol':
      'This 39Note version is too old to access this Drive library. Open the latest 39Note version. Do not attempt another Drive upgrade.',
    'paper-presence-invalid': 'Drive paper presence data needs verification.',
    'paper-snapshot-unstable':
      'This Drive paper kept changing during download. Try again when edits settle.',
  };
  const snapshotUnstable = error.code === 'paper-snapshot-unstable';
  return {
    code: 'drive-integrity-mismatch',
    message: messages[error.code] ?? 'Drive paper data needs verification.',
    severity: 'error',
    state: 'attention',
    actions: snapshotUnstable ? ['retry-now', 'details'] : ['details'],
    retrySafe: snapshotUnstable,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: {
      source: 'google-drive',
      operation: error.code,
      ...(error.diagnosticPhase ? { phase: error.diagnosticPhase } : {}),
      ...(error.diagnosticCauseCode ? { causeCode: error.diagnosticCauseCode } : {}),
      ...(error.diagnosticPresenceFailureCode
        ? { presenceFailureCode: error.diagnosticPresenceFailureCode }
        : {}),
      ...(error.diagnosticPresenceAncestry
        ? {
            presenceTopology: {
              validationStage: error.diagnosticPresenceAncestry.validationStage,
              status: error.diagnosticPresenceAncestry.topology.status,
              recordCount: error.diagnosticPresenceAncestry.topology.recordCount,
              uniqueGenerationCount:
                error.diagnosticPresenceAncestry.topology.uniqueGenerationCount,
              rootCount: error.diagnosticPresenceAncestry.topology.rootCount,
              structuralHeadCount:
                error.diagnosticPresenceAncestry.topology.structuralHeadCount,
              // Any failed global resolution may expose observable graph
              // leaves, but it has no protocol-authoritative resolved head
              // set, including when the structure is valid but a protocol
              // cutover boundary rejects it.
              resolvedAuthoritativeHeadCount: null,
              weakComponentCount:
                error.diagnosticPresenceAncestry.topology.weakComponentCount,
              missingParentReferenceCount:
                error.diagnosticPresenceAncestry.topology.missingParentReferenceCount,
              records: error.diagnosticPresenceAncestry.topology.records.map(
                (record) => ({
                  ordinal: record.ordinal,
                  state: record.state,
                  intent: record.intent,
                  parentOrdinals: [...record.parentOrdinals],
                  missingParentCount: record.missingParentCount,
                  childCount: record.childCount,
                  root: record.root,
                  structuralHead: record.structuralHead,
                }),
              ),
            },
          }
        : {}),
      ...(Reflect.get(error, 'documentId')
        ? { documentId: String(Reflect.get(error, 'documentId')) }
        : {}),
    },
  };
}

function securityIssue(
  code:
    | 'device-mode-required'
    | 'public-root-missing'
    | 'account-association-required'
    | 'account-mismatch'
    | 'account-identity-unavailable',
  message: string,
  actions: SyncOperationalIssue['actions'],
  operation: string,
): SyncOperationalIssue {
  return {
    code,
    message,
    severity: code === 'device-mode-required' ? 'warning' : 'error',
    state: code === 'device-mode-required' ? 'disconnected' : 'attention',
    actions,
    retrySafe: false,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: { source: 'sync', operation },
  };
}

export function paperStatusAfterFailure(
  state: Pick<
    PaperSyncState,
    'availability' | 'dirtyReasons' | 'incorporatedHeadIds' | 'remoteHeadIds'
  >,
  blocksOrdinarySync: boolean,
): PaperSyncState['status'] {
  if (blocksOrdinarySync) return 'needs-attention';
  const remoteUpdate = state.remoteHeadIds.some(
    (head) => !state.incorporatedHeadIds.includes(head),
  );
  if (state.dirtyReasons.length && remoteUpdate) return 'both-changed';
  if (state.dirtyReasons.length) return 'local-changes';
  if (remoteUpdate) return 'remote-update-available';
  return state.availability === 'cloud-only' ? 'cloud-only' : 'synced';
}

/**
 * Select the failed work that Retry may safely replay after an exact-paper
 * revalidation. This is intentionally state-based: issue text is presentation,
 * while dirty generations, authoritative heads, presence, and the recorded
 * failed operation determine the safe command.
 */
export function selectPaperRetryAction(
  state: Pick<
    PaperSyncState,
    | 'availability'
    | 'cloudCleanupPending'
    | 'cloudPresence'
    | 'dirtyReasons'
    | 'incorporatedHeadIds'
    | 'remoteHeadIds'
  >,
  issue?: SyncOperationalIssue,
  failedOperation?: PaperRetryOperation,
): PaperRetryAction {
  if (state.cloudPresence === 'removed') {
    return state.cloudCleanupPending ? 'remove-cleanup' : 'none';
  }

  if (issue && (!issue.retrySafe || !issue.actions.includes('retry-now'))) {
    return 'revalidate';
  }

  const remoteUpdate = state.remoteHeadIds.some(
    (head) => !state.incorporatedHeadIds.includes(head),
  );
  if (failedOperation === 'download') return 'download';
  if (failedOperation === 'upload') {
    return state.dirtyReasons.length > 0 && !remoteUpdate ? 'upload' : 'revalidate';
  }
  if (failedOperation === 'remove-cleanup') return 'remove-cleanup';
  if (state.dirtyReasons.length > 0 && remoteUpdate) return 'revalidate';
  if (state.dirtyReasons.length > 0) return 'upload';
  if (remoteUpdate || state.availability === 'cloud-only') return 'download';
  return 'revalidate';
}

export type AutoSyncFollowUpPolicy = 'none' | 'debounce' | 'backoff';

export function autoSyncFollowUpPolicy(
  issues: readonly SyncOperationalIssue[],
): AutoSyncFollowUpPolicy {
  if (issues.some((issue) => issue.code === 'sync-cancelled')) return 'none';
  if (
    issues.some(
      (issue) =>
        issue.retrySafe &&
        !issue.blocksOrdinarySync &&
        issue.actions.includes('automatic-retry'),
    )
  ) {
    return 'backoff';
  }
  // With no failure, eligible dirt means an edit landed after the batch's
  // captured generation. If every reported failure is blocking, any eligible
  // dirt necessarily belongs to a different paper and may proceed normally.
  if (!issues.length || issues.every((issue) => issue.blocksOrdinarySync)) {
    return 'debounce';
  }
  return 'none';
}

export class PaperGoogleDriveSyncCoordinator {
  private readonly identity = new PersistentGoogleAuthSession();
  private readonly local = new BrowserPaperLocalAdapter();
  private profile: PaperSyncDeviceProfile | null = null;
  private paperStates = new Map<string, PaperSyncState>();
  private repository: PaperDriveRepository | null = null;
  private drive: DriveClient | null = null;
  private initializationPromise: Promise<void> | null = null;
  private authorizationPromise: Promise<void> | null = null;
  private accountRecoveryPromise: Promise<void> | null = null;
  /**
   * Account identity bound by temporary-session provenance. This remains in
   * memory across an OAuth disconnect so a later callback cannot replace the
   * profile account before the durable provenance check runs.
   */
  private temporaryWorkspaceAccountId?: string;
  /** Exact UUID-scoped workspace whose local data this coordinator loaded. */
  private temporaryWorkspaceId?: string;
  private listeners = new Set<Listener>();
  private removePersistentListener: (() => void) | null = null;
  private readonly operationOwner = new SerializedDriveOperationOwner();
  private readonly operationTelemetryIds = new WeakMap<AbortSignal, string>();
  private readonly operationWatchdogs = new WeakMap<
    AbortSignal,
    {
      timer?: ReturnType<typeof setTimeout>;
      diagnostic: ActiveDriveOperationDiagnostic;
      timeoutDiagnostic?: DriveOperationTimeoutDiagnostic;
      idleTimeoutMs: number;
      hardDeadlineAt: number;
      mayHaveMutated: boolean;
      timeoutVisibility: DriveOperationTimeoutVisibility;
    }
  >();
  /**
   * Exact verified identity admitted with the currently owned Drive operation.
   * SerializedDriveOperationOwner guarantees that at most one fence is active.
   */
  private activeDriveOperationIdentityFence?: {
    signal: AbortSignal;
    accountId: string;
    operationType: DriveSyncOperationType;
    workspaceLease: WorkspaceRestoreLease;
    workspaceLeaseHandle: HeldWorkspaceRestoreLease;
  };
  private lastDriveOperationDiagnostic?: DriveOperationDiagnosticSummary;
  private readonly recentDriveOperationDiagnostics: DriveOperationDiagnosticSummary[] =
    [];
  private scanPromise: Promise<void> | null = null;
  private layoutMigrationPromise: Promise<void> | null = null;
  private v3MigrationPromise: Promise<void> | null = null;
  private protocolMigrationPromise: Promise<void> | null = null;
  private legacyInventoryPromise: Promise<void> | null = null;
  private legacyCleanupPromise: Promise<void> | null = null;
  private folderNamePreviewPromise: Promise<void> | null = null;
  private folderNameNormalizationPromise: Promise<void> | null = null;
  private finishPromise: Promise<void> | null = null;
  private readonly pendingPersistentChanges = new Set<Promise<void>>();
  private readonly activeLocalRemovalIds = new Set<string>();
  private readonly localRemovalEpochs = new Map<string, number>();
  private readonly committedLocalRemovalEpochs = new Map<string, number>();
  private readonly localRemovalWaiters = new Set<() => void>();
  private readonly pendingLocalRemovalReconcileIds = new Set<string>();
  private localRemovalReconcilePromise: Promise<void> | null = null;
  private readonly seenRemoteReminderStateIds = new Set<string>();
  private readonly blockingPaperIssues = new Map<string, BlockingPaperIssue>();
  /**
   * A failed root-wide presence resolution is not paper-scoped settlement state.
   * Keep it separate so a later successful download of one cached paper cannot
   * clear the unresolved global integrity boundary or report a false Synced.
   */
  private rootWideBlockingIssue?: RootWideBlockingIssue;
  private readonly paperRetryIntents = new Map<string, PaperRetryOperation>();
  private readonly activePaperRetryTasks = new Map<string, Promise<void>>();
  private lastPaperRetryDiagnostic?: PaperRetryDiagnosticSnapshot;
  private lastPaperSyncStatusDiagnostic?: PaperSyncStatusDiagnosticSnapshot;
  private lastPaperSyncStatusDiagnosticContext?: {
    inspectionSequence: number;
    documentIds: readonly string[];
    /** True only after the GET-only root guard passes and exact discovery starts. */
    exactDiscoveryStarted?: boolean;
    stateFingerprints?: ReadonlyMap<string, string>;
    requestedForgetDocumentId?: string;
    admissionAccountId?: string;
    admissionRootFolderId?: string;
  };
  private paperSyncStatusInspectionSequence = 0;
  private readonly targetedPaperPurgePreviews = new Map<
    string,
    PendingTargetedPaperPurge
  >();
  private autoUploadTimer: number | null = null;
  /**
   * A read timeout is recovered by one exact-root, GET-only scan before any
   * queued publication may resume. This flag closes the small interval where
   * that scan has cleared the old issue but has not settled yet.
   */
  private readTimeoutRecoveryInProgress = false;
  private transientRetryAttempt = 0;
  private soundSequence = 0;
  private readonly paperFlights = new KeyedSingleFlight<void>();
  private restorePublicationOperation: DurableRestoreOperation | null = null;
  private restorePublicationResumePromise: Promise<void> | null = null;
  private readonly activePaperOperationTasks = new Map<
    string,
    { operation: PaperActiveOperation; promise: Promise<unknown> }
  >();
  private driveOperationSuspensionCount = 0;
  private paperOperationSequence = 0;
  private view: PaperSyncViewState = {
    connection: 'loading',
    backendConfigured: Boolean(getBuildTimeSyncAuthUrl()),
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: false,
    autoSync: false,
    papers: [],
    paperStates: [],
    dirtyPaperIds: [],
    sessions: [],
    rootChoices: [],
    progress: { phase: 'idle' },
    activePaperOperations: [],
    legacyHousekeeping: { status: 'idle' },
    folderNameMaintenance: { status: 'idle' },
  };

  constructor(
    private readonly soundFeedback: Pick<
      SyncSoundFeedback,
      'notify'
    > = getSyncSoundFeedback(),
  ) {}

  initialize(): Promise<void> {
    this.initializationPromise ??= this.initializeOnce();
    return this.initializationPromise;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): PaperSyncViewState {
    return this.view;
  }

  /** Identifies the mounted development runtime without exposing workspace identity. */
  getRuntimeRevision(): number {
    return PAPER_SYNC_COORDINATOR_RUNTIME_REVISION;
  }

  /**
   * Returns one exact purge candidate only. Multiple matching blockers remain
   * hidden until a repository operation scopes the recovery to one document.
   */
  getTargetedPaperPurgeCandidateDocumentId(): string | undefined {
    return this.evaluateTargetedPaperPurgeVisibility().candidateDocumentId;
  }

  /**
   * Redacted development diagnostics for the recovery-card visibility gates.
   * Counts and booleans are intentionally the only correlation data exposed.
   */
  getTargetedPaperPurgeVisibilityDiagnostic(): TargetedPaperPurgeVisibilityDiagnostic {
    return this.evaluateTargetedPaperPurgeVisibility().diagnostic;
  }

  /** Returns the exact candidate while keeping all identity gates fail closed. */
  getForgetInaccessiblePaperCandidate(
    requestedDocumentId?: string,
  ): ForgetInaccessiblePaperCandidate | undefined {
    if (requestedDocumentId) {
      return this.getForgetInaccessiblePaperDiagnostic(requestedDocumentId).candidate;
    }
    const profile = this.profile;
    const accountId = this.identity.accountId;
    if (
      !profile ||
      profile.deviceMode !== 'personal' ||
      !accountId ||
      profile.accountId !== accountId ||
      profile.workspaceAccountId !== accountId ||
      !profile.rootFolderId
    ) {
      return undefined;
    }

    const evaluation = this.evaluateTargetedPaperPurgeVisibility();
    if (
      !evaluation.candidateDocumentId ||
      (evaluation.diagnostic.candidateSource !== 'blocking-map' &&
        evaluation.diagnostic.candidateSource !== 'failed-inspection')
    ) {
      return undefined;
    }
    const documentId = evaluation.candidateDocumentId;
    if (this.isPaperQuarantined(documentId)) return undefined;
    const state = this.paperStates.get(documentId);
    if (state?.status !== 'needs-attention' || state.cloudPresence !== 'present') {
      return undefined;
    }
    return {
      documentId,
      displayName:
        this.view.papers.find((paper) => paper.documentId === documentId)
          ?.displayName ??
        state.displayName ??
        'Inaccessible paper',
    };
  }

  /**
   * Admits one explicitly selected Browse row to the read-only inspection. This
   * is deliberately narrower than Retry selection: the cloud catalog itself
   * must be in attention, and both local/catalog copies must already agree on
   * the managed paper folder within the verified account/root.
   */
  private forgetReadOnlyVerificationScope(
    requestedDocumentId: string,
  ): { accountId: string; rootFolderId: string } | undefined {
    const profile = this.profile;
    const accountId = this.identity.accountId;
    const rootFolderId = profile?.rootFolderId;
    const paper = this.view.papers.find(
      (candidate) => candidate.documentId === requestedDocumentId,
    );
    const state = this.paperStates.get(requestedDocumentId);
    const catalogNeedsAttention = Boolean(
      paper?.status === 'needs-attention' || paper?.issue,
    );
    if (
      !profile ||
      profile.deviceMode !== 'personal' ||
      !accountId ||
      !rootFolderId ||
      profile.accountId !== accountId ||
      profile.workspaceAccountId !== accountId ||
      this.isPaperQuarantined(requestedDocumentId) ||
      !paper ||
      !catalogNeedsAttention ||
      paper.deleted !== false ||
      paper.presenceState === 'removed' ||
      !paper.paperFolderId ||
      paper.paperFolderId === 'unavailable' ||
      !state ||
      state.cloudPresence !== 'present' ||
      !state.driveFiles.paperFolderId ||
      state.driveFiles.paperFolderId !== paper.paperFolderId
    ) {
      return undefined;
    }
    return { accountId, rootFolderId };
  }

  /**
   * Session-only evidence for local quarantine. It is intentionally separate
   * from targeted-purge evidence: a clean local lifecycle status may be stale
   * after the resolver throws, but destructive purge remains fail-closed on its
   * existing stricter predicate set.
   */
  private hasExactForgetReadOnlyInspectionEvidence(
    requestedDocumentId: string,
    paper: PaperCloudSummary | undefined,
    state: PaperSyncState | undefined,
  ): boolean {
    const diagnostic = this.lastPaperSyncStatusDiagnostic;
    const context = this.lastPaperSyncStatusDiagnosticContext;
    const target = diagnostic?.targets[0];
    const profile = this.profile;
    const accountId = this.identity.accountId;
    return Boolean(
      diagnostic &&
      context &&
      target &&
      profile &&
      accountId &&
      context.inspectionSequence === this.paperSyncStatusInspectionSequence &&
      context.requestedForgetDocumentId === requestedDocumentId &&
      context.documentIds.length === 1 &&
      context.documentIds[0] === requestedDocumentId &&
      context.admissionAccountId === accountId &&
      context.admissionRootFolderId === profile.rootFolderId &&
      context.exactDiscoveryStarted === true &&
      context.stateFingerprints?.get(requestedDocumentId) ===
        paperSyncStatusGuardFingerprint(state, paper) &&
      diagnostic.phase === 'failed' &&
      diagnostic.targetCount === 1 &&
      isTargetedPaperPurgeDiagnosticFailure(diagnostic.failure) &&
      target.current.cloudPresence === 'present' &&
      target.upload.permitted === false &&
      target.upload.reason === 'inspection-failed-closed',
    );
  }

  /**
   * Redacted Browse-row eligibility. A reviewed quarantine is durable identity
   * proof, not an active exception; it is accepted only in the same verified
   * account/root and with the same exact catalog/state managed-folder identity.
   */
  getForgetInaccessiblePaperDiagnostic(
    requestedDocumentId: string,
  ): ForgetInaccessiblePaperDiagnostic {
    const profile = this.profile;
    const accountId = this.identity.accountId;
    const paper = this.view.papers.find(
      (candidate) => candidate.documentId === requestedDocumentId,
    );
    const state = this.paperStates.get(requestedDocumentId);
    const profilePresent = profile !== undefined;
    const personalDevice = profile?.deviceMode === 'personal';
    const accountIdentityPresent = Boolean(accountId);
    const accountScopeMatches = Boolean(
      profile && accountId && profile.accountId === accountId,
    );
    const workspaceScopeMatches = Boolean(
      profile && accountId && profile.workspaceAccountId === accountId,
    );
    const rootScopePresent = Boolean(profile?.rootFolderId);
    const catalogPaperPresent = paper !== undefined;
    const catalogNeedsAttention = Boolean(
      paper?.status === 'needs-attention' || paper?.issue,
    );
    const paperNotDeleted = paper?.deleted === false;
    const paperNotRemoved = paper?.presenceState !== 'removed';
    const paperFolderAvailable = Boolean(
      paper?.paperFolderId && paper.paperFolderId !== 'unavailable',
    );
    const localStatePresent = state !== undefined;
    const localStateNeedsAttention = state?.status === 'needs-attention';
    const localPresencePresent = state?.cloudPresence === 'present';
    const paperFolderMatches = Boolean(
      paper &&
      state?.driveFiles.paperFolderId &&
      state.driveFiles.paperFolderId === paper.paperFolderId,
    );
    const catalogFailureExact = isQuarantinablePresenceCatalogIssue(paper?.issue);
    const catalogIssueCompatibleWithReviewedProof = Boolean(
      !paper?.issue ||
      catalogFailureExact ||
      paper.issue.code === 'drive-integrity-mismatch' ||
      (paper.issue.code === 'paper-presence-invalid' &&
        !paper.issue.phase &&
        !paper.issue.causeCode),
    );
    const reviewedProof = (profile?.cloudIssueQuarantines ?? []).find(
      (entry) =>
        entry.reviewedAt !== undefined &&
        entry.accountId === accountId &&
        entry.rootFolderId === profile?.rootFolderId &&
        entry.documentId === requestedDocumentId &&
        (!entry.paperFolderId || entry.paperFolderId === paper?.paperFolderId),
    );
    const reviewedProofPresent = Boolean(
      reviewedProof && catalogIssueCompatibleWithReviewedProof,
    );
    const evaluation = this.evaluateTargetedPaperPurgeVisibility();
    const targetedSessionProofPresent = Boolean(
      evaluation.candidateDocumentId === requestedDocumentId &&
      (evaluation.diagnostic.candidateSource === 'blocking-map' ||
        evaluation.diagnostic.candidateSource === 'failed-inspection'),
    );
    const forgetInspectionProofPresent = this.hasExactForgetReadOnlyInspectionEvidence(
      requestedDocumentId,
      paper,
      state,
    );
    const sessionProofPresent =
      targetedSessionProofPresent || forgetInspectionProofPresent;
    const identityProofAvailable =
      catalogFailureExact || reviewedProofPresent || sessionProofPresent;
    const predicates: ForgetInaccessiblePaperDiagnostic['predicates'] = {
      profilePresent,
      personalDevice,
      accountIdentityPresent,
      accountScopeMatches,
      workspaceScopeMatches,
      rootScopePresent,
      catalogPaperPresent,
      catalogNeedsAttention,
      paperNotDeleted,
      paperNotRemoved,
      paperFolderAvailable,
      localStatePresent,
      localStateNeedsAttention,
      localPresencePresent,
      paperFolderMatches,
      catalogFailureExact,
      reviewedProofPresent,
      sessionProofPresent,
      identityProofAvailable,
    };
    const result = (
      reason: ForgetInaccessiblePaperDiagnostic['reason'],
    ): ForgetInaccessiblePaperDiagnostic => ({
      eligible: false,
      reason,
      evidenceSource: 'none',
      predicates,
    });

    if (!profilePresent) return result('workspace-profile-missing');
    if (!personalDevice) return result('personal-device-required');
    if (!accountIdentityPresent) return result('account-identity-unavailable');
    if (!accountScopeMatches || !workspaceScopeMatches) {
      return result('account-scope-mismatch');
    }
    if (!rootScopePresent) return result('root-scope-missing');
    if (this.isPaperQuarantined(requestedDocumentId)) {
      return result('already-ignored');
    }
    if (!catalogPaperPresent) return result('catalog-paper-missing');
    if (!catalogNeedsAttention) return result('paper-not-needs-attention');
    if (!paperNotDeleted || !paperNotRemoved) return result('paper-removed');
    if (!paperFolderAvailable) return result('paper-folder-unavailable');
    if (!localStatePresent) return result('local-state-missing');
    // Browse deliberately merges the catalog and persisted local state. A
    // resolver failure can mark the catalog row as needing attention while the
    // last successfully settled local status remains healthy. That local status
    // is lifecycle/presentation state, not identity evidence, so requiring both
    // copies to agree makes a verified row unreachable after reload. Keep it in
    // the redacted predicate matrix, but gate recovery on the scoped account,
    // root, document/folder correlation, present cloud state, and exact proof.
    if (!localPresencePresent) return result('local-cloud-presence-not-present');
    if (!paperFolderMatches) return result('paper-folder-mismatch');
    if (!identityProofAvailable) return result('identity-proof-unavailable');

    const candidate = {
      documentId: requestedDocumentId,
      displayName: paper!.displayName || state!.displayName || 'Inaccessible paper',
    };
    return {
      eligible: true,
      reason: 'eligible',
      evidenceSource: catalogFailureExact
        ? 'catalog-failure'
        : reviewedProofPresent
          ? 'reviewed-quarantine'
          : evaluation.diagnostic.candidateSource === 'blocking-map'
            ? 'blocking-map'
            : 'failed-inspection',
      candidate,
      predicates,
    };
  }

  /** Persists one user-confirmed, local-only account/root/document exception. */
  async forgetInaccessiblePaper(
    documentId: string,
  ): Promise<ForgetInaccessiblePaperResult> {
    await this.initialize();
    const signal = await this.beginOperation('other', false);
    try {
      const profile = this.requireProfile();
      const accountId = this.assertAuthorizedWorkspaceAccount();
      const rootFolderId = profile.rootFolderId;
      if (
        profile.deviceMode !== 'personal' ||
        !rootFolderId ||
        profile.accountId !== accountId ||
        profile.workspaceAccountId !== accountId
      ) {
        throw new Error(
          'The inaccessible paper cannot be correlated to this Google account and 39Note folder.',
        );
      }
      const existing = (profile.cloudIssueQuarantines ?? []).find(
        (entry) =>
          entry.accountId === accountId &&
          entry.rootFolderId === rootFolderId &&
          entry.documentId === documentId,
      );
      if (existing && existing.reviewedAt === undefined) {
        this.refreshStateView();
        return { documentId, alreadyIgnored: true };
      }
      const candidate = this.getForgetInaccessiblePaperCandidate(documentId);
      if (!candidate || candidate.documentId !== documentId) {
        throw new Error(
          'Exactly one verified inaccessible paper is required before it can be ignored.',
        );
      }
      const entry: PaperCloudIssueQuarantineEntry = {
        version: 1,
        documentId,
        accountId,
        rootFolderId,
        reason: 'presence-control-resolution-failed',
        confirmedAt: Date.now(),
        ...(this.paperStates.get(documentId)?.driveFiles.paperFolderId
          ? {
              paperFolderId: this.paperStates.get(documentId)!.driveFiles.paperFolderId,
            }
          : {}),
      };
      profile.cloudIssueQuarantines = existing
        ? (profile.cloudIssueQuarantines ?? []).map((candidateEntry) =>
            candidateEntry === existing ? entry : candidateEntry,
          )
        : [...(profile.cloudIssueQuarantines ?? []), entry];
      // This local filter changes no Drive object. Retain a still-valid,
      // account/root/device-bound change cursor so unrelated papers can remain
      // on the incremental path. The ignored document is filtered separately.
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.targetedPaperPurgePreviews.clear();
      this.refreshStateView();
      const blockingIssue = this.firstBlockingPaperIssue();
      this.updateView({
        connection: this.connectionAfterPaperSettlement(blockingIssue),
        issue: blockingIssue,
        error: blockingIssue?.message,
        progress: { phase: 'idle' },
      });
      return { documentId, alreadyIgnored: false };
    } finally {
      this.endOperation(signal);
      if (this.isAutoSyncEffectivelyEnabled()) this.scheduleAutoUpload();
    }
  }

  /**
   * Reverses only the active local exception. The verified scoped identity is
   * retained as inactive evidence so a later reload cannot make the same exact
   * issue impossible to quarantine again.
   */
  async reviewIgnoredCloudIssue(documentId: string): Promise<void> {
    await this.initialize();
    const signal = await this.beginOperation('other', false);
    try {
      const profile = this.requireProfile();
      const accountId = this.assertAuthorizedWorkspaceAccount();
      const rootFolderId = profile.rootFolderId;
      if (!rootFolderId) throw new Error('The 39Note Drive folder is unavailable.');
      const previous = profile.cloudIssueQuarantines ?? [];
      const matching = previous.find(
        (entry) =>
          entry.reviewedAt === undefined &&
          entry.accountId === accountId &&
          entry.rootFolderId === rootFolderId &&
          entry.documentId === documentId,
      );
      if (!matching) return;
      const paperFolderId =
        this.paperStates.get(documentId)?.driveFiles.paperFolderId ??
        this.view.papers.find((paper) => paper.documentId === documentId)
          ?.paperFolderId;
      const reviewedAt = Math.max(Date.now(), matching.confirmedAt);
      profile.cloudIssueQuarantines = previous.map((entry) =>
        entry === matching
          ? {
              ...entry,
              reviewedAt,
              revalidationPending: true as const,
              ...(paperFolderId && paperFolderId !== 'unavailable'
                ? { paperFolderId }
                : {}),
            }
          : entry,
      );
      // The prior cursor was committed while this paper was ignored. Its change
      // feed cannot prove that the excluded ancestry is now sound. A reviewed
      // paper therefore requires a new exhaustive read before any publication.
      delete profile.driveChangeCursor;
      delete profile.driveAuditCheckpoint;
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.updateView({ lastVerifiedDriveAt: undefined }, { notify: false });
      this.refreshStateView();
      const blockingIssue = this.firstBlockingPaperIssue();
      this.updateView({
        connection: this.connectionAfterPaperSettlement(blockingIssue),
        issue: blockingIssue,
        error: blockingIssue?.message,
        progress: { phase: 'idle' },
      });
    } finally {
      this.endOperation(signal);
    }
  }

  /**
   * Converts one exact failed read-only inspection into session-local UI
   * evidence without changing the blocking map, persisted sync state, or the
   * redacted diagnostic presented to the user. Repository preview and commit
   * verification remain independently mandatory before any mutation.
   */
  private targetedPaperPurgeDiagnosticEvidence():
    TargetedPaperPurgeDiagnosticEvidence | undefined {
    return this.evaluateTargetedPaperPurgeVisibility().diagnosticEvidence;
  }

  /**
   * Evaluates candidate selection, destructive-evidence correlation, and the
   * redacted UI explanation together so the three paths cannot drift apart.
   */
  private evaluateTargetedPaperPurgeVisibility(): TargetedPaperPurgeVisibilityEvaluation {
    const quarantinedDocumentIds = new Set(this.activeQuarantinedDocumentIds());
    const checkpointCandidateFromState = targetedPaperPurgeCandidateFromView({
      ...this.view,
      issue: undefined,
      papers: [],
    });
    const checkpointCandidate =
      checkpointCandidateFromState &&
      !quarantinedDocumentIds.has(checkpointCandidateFromState)
        ? checkpointCandidateFromState
        : undefined;
    const blockingCandidates = [...this.blockingPaperIssues.entries()]
      .filter(
        ([documentId, block]) =>
          !quarantinedDocumentIds.has(documentId) &&
          isTargetedPaperPurgeCandidate(block.issue),
      )
      .map(([documentId]) => documentId)
      .sort();
    const retryCandidateIds = this.retryCandidatePaperIds();
    const diagnostic = this.lastPaperSyncStatusDiagnostic;
    const context = this.lastPaperSyncStatusDiagnosticContext;
    const failure = diagnostic?.failure;
    const target = diagnostic?.targets[0];
    const diagnosticPresent = diagnostic !== undefined;
    const diagnosticContextPresent = context !== undefined;
    const diagnosticSequenceCurrent = Boolean(
      context && context.inspectionSequence === this.paperSyncStatusInspectionSequence,
    );
    const diagnosticPhaseFailed = diagnostic?.phase === 'failed';
    const diagnosticTargetCountOne = diagnostic?.targetCount === 1;
    const diagnosticContextTargetCountOne = context?.documentIds.length === 1;
    const diagnosticFailurePresent = failure !== undefined;
    const diagnosticFailureCodeMatches = failure?.code === 'drive-integrity-mismatch';
    const diagnosticFailureBlocksOrdinarySync = failure?.blocksOrdinarySync === true;
    const diagnosticOperationMatches = failure?.operation === 'paper-presence-invalid';
    const diagnosticFailurePhaseMatches =
      failure?.phase === 'paper-presence-resolution';
    const diagnosticCauseMatches =
      failure?.causeCode === 'presence-control-resolution-failed';
    const exactDiagnosticFailure = isTargetedPaperPurgeDiagnosticFailure(failure);
    const diagnosticTargetPresent = target !== undefined;
    const diagnosticSnapshotNeedsAttention =
      target?.current.status === 'needs-attention';
    const diagnosticSnapshotPresencePresent =
      target?.current.cloudPresence === 'present';
    const diagnosticUploadBlocked = target?.upload.permitted === false;
    const diagnosticUploadFailedClosed =
      target?.upload.reason === 'inspection-failed-closed';
    const diagnosticContextIdentityPresent = Boolean(
      diagnosticContextTargetCountOne && context?.documentIds[0],
    );
    const documentId = diagnosticContextIdentityPresent
      ? context?.documentIds[0]
      : undefined;
    const diagnosticTargetQuarantined = Boolean(
      documentId && quarantinedDocumentIds.has(documentId),
    );
    const state = documentId ? this.paperStates.get(documentId) : undefined;
    const currentStatePresent = state !== undefined;
    const currentStateNeedsAttention = state?.status === 'needs-attention';
    const currentPresencePresent = state?.cloudPresence === 'present';
    const retryCandidateContainsCorrelatedTarget = Boolean(
      documentId && retryCandidateIds.includes(documentId),
    );
    const failedInspectionEvidenceComplete = Boolean(
      diagnosticPresent &&
      !diagnosticTargetQuarantined &&
      diagnosticContextPresent &&
      diagnosticSequenceCurrent &&
      diagnosticPhaseFailed &&
      diagnosticTargetCountOne &&
      diagnosticContextTargetCountOne &&
      diagnosticContextIdentityPresent &&
      exactDiagnosticFailure &&
      diagnosticTargetPresent &&
      diagnosticSnapshotNeedsAttention &&
      diagnosticSnapshotPresencePresent &&
      diagnosticUploadBlocked &&
      diagnosticUploadFailedClosed &&
      currentStatePresent &&
      currentStateNeedsAttention &&
      currentPresencePresent &&
      retryCandidateContainsCorrelatedTarget,
    );
    const viewCandidateFromState = targetedPaperPurgeCandidateFromView(this.view);
    const viewCandidate =
      viewCandidateFromState && !quarantinedDocumentIds.has(viewCandidateFromState)
        ? viewCandidateFromState
        : undefined;

    let diagnosticEvidence: TargetedPaperPurgeDiagnosticEvidence | undefined;
    if (
      failedInspectionEvidenceComplete &&
      diagnostic &&
      context &&
      documentId &&
      target &&
      state
    ) {
      const catalogPaper = this.view.papers.find(
        (paper) => paper.documentId === documentId,
      );
      diagnosticEvidence = {
        documentId,
        fingerprint: JSON.stringify({
          inspectionSequence: context.inspectionSequence,
          documentId,
          failure: diagnostic.failure,
          target: {
            current: target.current,
            upload: target.upload,
          },
          state: paperSyncStatusGuardFingerprint(state, catalogPaper),
        }),
      };
    }

    let candidateDocumentId: string | undefined;
    let candidateSource: TargetedPaperPurgeVisibilityDiagnostic['candidateSource'] =
      'none';
    if (checkpointCandidate) {
      candidateDocumentId = checkpointCandidate;
      candidateSource = 'checkpoint';
    } else if (blockingCandidates.length > 0) {
      if (blockingCandidates.length === 1) {
        candidateDocumentId = blockingCandidates[0];
        candidateSource = 'blocking-map';
      }
    } else if (diagnosticEvidence) {
      candidateDocumentId = diagnosticEvidence.documentId;
      candidateSource = 'failed-inspection';
    } else if (viewCandidate) {
      candidateDocumentId = viewCandidate;
      candidateSource = 'view';
    }

    const candidateResolved = candidateDocumentId !== undefined;
    const exactFailedDiagnosticVisible = Boolean(
      diagnosticPresent &&
      diagnosticPhaseFailed &&
      exactDiagnosticFailure &&
      !diagnosticTargetQuarantined,
    );
    let hiddenReason: TargetedPaperPurgeVisibilityDiagnostic['hiddenReason'] =
      'no-exact-candidate';
    if (candidateResolved) {
      hiddenReason = 'not-hidden';
    } else if (blockingCandidates.length > 1) {
      hiddenReason = 'multiple-exact-blocking-candidates';
    } else if (diagnosticTargetQuarantined) {
      hiddenReason = 'local-quarantine-active';
    } else if (exactFailedDiagnosticVisible) {
      if (!diagnosticContextPresent) hiddenReason = 'diagnostic-context-missing';
      else if (!diagnosticSequenceCurrent) hiddenReason = 'diagnostic-context-stale';
      else if (!diagnosticTargetCountOne) {
        hiddenReason = 'diagnostic-target-count-not-one';
      } else if (
        !diagnosticContextTargetCountOne ||
        !diagnosticContextIdentityPresent
      ) {
        hiddenReason = 'diagnostic-context-target-count-not-one';
      } else if (!diagnosticTargetPresent) hiddenReason = 'diagnostic-target-missing';
      else if (!diagnosticSnapshotNeedsAttention) {
        hiddenReason = 'diagnostic-snapshot-not-needs-attention';
      } else if (!diagnosticSnapshotPresencePresent) {
        hiddenReason = 'diagnostic-snapshot-presence-not-present';
      } else if (!diagnosticUploadBlocked) {
        hiddenReason = 'diagnostic-upload-not-blocked';
      } else if (!diagnosticUploadFailedClosed) {
        hiddenReason = 'diagnostic-upload-not-failed-closed';
      } else if (!currentStatePresent) hiddenReason = 'current-state-missing';
      else if (!currentStateNeedsAttention) {
        hiddenReason = 'current-state-not-needs-attention';
      } else if (!currentPresencePresent) {
        hiddenReason = 'current-presence-not-present';
      } else if (!retryCandidateContainsCorrelatedTarget) {
        hiddenReason = 'correlated-target-not-retry-eligible';
      }
    } else if (diagnosticPresent) {
      if (!diagnosticPhaseFailed) hiddenReason = 'diagnostic-phase-not-failed';
      else if (!diagnosticFailurePresent) hiddenReason = 'diagnostic-failure-missing';
      else if (!diagnosticFailureCodeMatches) {
        hiddenReason = 'diagnostic-failure-code-mismatch';
      } else if (!diagnosticFailureBlocksOrdinarySync) {
        hiddenReason = 'diagnostic-failure-not-blocking';
      } else if (!diagnosticOperationMatches) {
        hiddenReason = 'diagnostic-operation-mismatch';
      } else if (!diagnosticFailurePhaseMatches) {
        hiddenReason = 'diagnostic-failure-phase-mismatch';
      } else if (!diagnosticCauseMatches) {
        hiddenReason = 'diagnostic-cause-mismatch';
      } else hiddenReason = 'diagnostic-not-current-exact-failure';
    }

    return {
      ...(candidateDocumentId ? { candidateDocumentId } : {}),
      ...(diagnosticEvidence ? { diagnosticEvidence } : {}),
      diagnostic: {
        implementationRevision: TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION,
        visible: candidateResolved,
        showRecoveryCard: candidateResolved || exactFailedDiagnosticVisible,
        candidateSource,
        hiddenReason,
        exactBlockingCandidateCount: blockingCandidates.length,
        retryCandidateCount: retryCandidateIds.length,
        predicates: {
          implementationCurrent: true,
          checkpointCandidateAvailable: checkpointCandidate !== undefined,
          exactBlockingCandidateUnique: blockingCandidates.length === 1,
          exactBlockingCandidatesUnambiguous: blockingCandidates.length <= 1,
          diagnosticPresent,
          diagnosticContextPresent,
          diagnosticSequenceCurrent,
          diagnosticPhaseFailed,
          diagnosticTargetCountOne,
          diagnosticContextTargetCountOne,
          diagnosticContextIdentityPresent,
          diagnosticFailurePresent,
          diagnosticFailureCodeMatches,
          diagnosticFailureBlocksOrdinarySync,
          diagnosticOperationMatches,
          diagnosticFailurePhaseMatches,
          diagnosticCauseMatches,
          exactDiagnosticFailure,
          exactFailedDiagnosticVisible,
          diagnosticTargetPresent,
          diagnosticSnapshotNeedsAttention,
          diagnosticSnapshotPresencePresent,
          diagnosticUploadBlocked,
          diagnosticUploadFailedClosed,
          currentStatePresent,
          currentStateNeedsAttention,
          currentPresencePresent,
          retryCandidateContainsCorrelatedTarget,
          failedInspectionEvidenceComplete,
          diagnosticTargetQuarantined,
          viewCandidateAvailable: viewCandidate !== undefined,
          candidateResolved,
        },
      },
    };
  }

  /** Redacted diagnostics for the most recently completed serialized Drive operation. */
  getLastDriveOperationDiagnostic(): DriveOperationDiagnosticSummary | undefined {
    return this.lastDriveOperationDiagnostic;
  }

  /**
   * Bounded, redacted history used to join a paper mutation to a later
   * Changes/discovery pass through its session-scoped opaque paper correlation.
   */
  getRecentDriveOperationDiagnostics(): readonly DriveOperationDiagnosticSummary[] {
    return [...this.recentDriveOperationDiagnostics];
  }

  /**
   * Read-only, identity-free trace of the most recent paper Retry decision.
   * It intentionally contains counts and classifiers only: no document IDs,
   * Drive IDs, account identifiers, contents, tokens, URLs, or local paths.
   */
  getLastPaperRetryDiagnostic(): PaperRetryDiagnosticSnapshot | undefined {
    const diagnostic = this.lastPaperRetryDiagnostic;
    if (!diagnostic) return undefined;
    return {
      ...diagnostic,
      ...(diagnostic.failure ? { failure: { ...diagnostic.failure } } : {}),
      targets: diagnostic.targets.map((target) => ({
        ...target,
        admission: {
          ...target.admission,
          ...(target.admission.activeBlockingIssue
            ? { activeBlockingIssue: { ...target.admission.activeBlockingIssue } }
            : {}),
        },
        ...(target.repository ? { repository: { ...target.repository } } : {}),
        ...(target.settlement
          ? {
              settlement: {
                ...target.settlement,
                ...(target.settlement.activeBlockingIssue
                  ? {
                      activeBlockingIssue: {
                        ...target.settlement.activeBlockingIssue,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      })),
    };
  }

  /**
   * Returns the last explicit development inspection. The snapshot is redacted
   * and cloned so UI code cannot mutate coordinator state.
   */
  getLastPaperSyncStatusDiagnostic(): PaperSyncStatusDiagnosticSnapshot | undefined {
    const diagnostic = this.lastPaperSyncStatusDiagnostic;
    if (!diagnostic) return undefined;
    return {
      ...diagnostic,
      ...(diagnostic.failure ? { failure: { ...diagnostic.failure } } : {}),
      targets: diagnostic.targets.map((target) => ({
        ...target,
        current: {
          ...target.current,
          ...(target.current.blockingIssue
            ? { blockingIssue: { ...target.current.blockingIssue } }
            : {}),
        },
        ...(target.authoritative
          ? {
              authoritative: {
                ...target.authoritative,
                ...(target.authoritative.issue
                  ? { issue: { ...target.authoritative.issue } }
                  : {}),
              },
            }
          : {}),
        upload: { ...target.upload },
      })),
    };
  }

  /**
   * Performs an exact, scoped repository read without applying discovery,
   * persisting catalog/state, clearing issues, selecting Retry work, or
   * admitting an upload. The normal serialized account and restore fences are
   * still required so the read cannot race a Drive mutation or cross identity.
   */
  async checkSyncStatusReadOnly(
    requestedForgetDocumentId?: string,
  ): Promise<PaperSyncStatusDiagnosticSnapshot> {
    const inspectionSequence = ++this.paperSyncStatusInspectionSequence;
    const requestedForgetScope = requestedForgetDocumentId
      ? this.forgetReadOnlyVerificationScope(requestedForgetDocumentId)
      : undefined;
    const documentIds = requestedForgetDocumentId
      ? requestedForgetScope
        ? [requestedForgetDocumentId]
        : []
      : this.retryCandidatePaperIds();
    const catalogAtAdmission = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper] as const),
    );
    const guards = new Map(
      documentIds.map((documentId) => {
        const block = this.blockingPaperIssues.get(documentId);
        return [
          documentId,
          {
            block,
            blockFingerprint: paperBlockingIssueFingerprint(block),
            stateFingerprint: paperSyncStatusGuardFingerprint(
              this.paperStates.get(documentId),
              catalogAtAdmission.get(documentId),
            ),
          },
        ] as const;
      }),
    );
    const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
      operation: 'paper-sync-status-check',
      phase: 'admission',
      targetCount: documentIds.length,
      targets: documentIds.map((documentId, index) => {
        const state = this.paperStates.get(documentId);
        const block = this.blockingPaperIssues.get(documentId)?.issue;
        return {
          target: `Paper ${index + 1}`,
          current: {
            ...(state?.status ? { status: state.status } : {}),
            ...(state?.cloudPresence ? { cloudPresence: state.cloudPresence } : {}),
            dirtyReasonCount: state?.dirtyReasons.length ?? 0,
            packageHeadCount: state?.remoteHeadIds.length ?? 0,
            presenceHeadCount: state?.presenceHeadIds?.length ?? 0,
            ...(block ? { blockingIssue: retryDiagnosticIssue(block) } : {}),
          },
          upload: readOnlyUploadPermission(
            state,
            block,
            undefined,
            'authoritative-result-missing',
          ),
        };
      }),
    };
    this.lastPaperSyncStatusDiagnostic = diagnostic;
    this.lastPaperSyncStatusDiagnosticContext = {
      inspectionSequence,
      documentIds: [...documentIds],
      stateFingerprints: new Map(
        [...guards].map(([documentId, guard]) => [documentId, guard.stateFingerprint]),
      ),
      ...(requestedForgetDocumentId && requestedForgetScope
        ? {
            requestedForgetDocumentId,
            admissionAccountId: requestedForgetScope.accountId,
            admissionRootFolderId: requestedForgetScope.rootFolderId,
          }
        : {}),
    };

    if (
      !canRunPaperSyncStatusReadOnlyInspection(
        import.meta.env.DEV,
        requestedForgetScope !== undefined,
      )
    ) {
      diagnostic.phase = 'failed';
      diagnostic.failure = {
        code: 'sync-diagnostic-unavailable',
        operation: 'paper-sync-status-check',
        phase: 'admission',
        causeCode: 'development-only',
        retrySafe: false,
        blocksOrdinarySync: false,
      };
      return this.getLastPaperSyncStatusDiagnostic()!;
    }

    if (!documentIds.length) {
      diagnostic.phase = 'failed';
      diagnostic.failure = {
        code: 'sync-diagnostic-unavailable',
        operation: 'paper-sync-status-check',
        phase: 'admission',
        causeCode: 'no-scoped-paper-target',
        retrySafe: true,
        blocksOrdinarySync: false,
      };
      return this.getLastPaperSyncStatusDiagnostic()!;
    }

    let signal: AbortSignal | undefined;
    try {
      // Never initialize or construct a repository from this action: either can
      // persist profile/root state or create a root. An already active, verified
      // sync session is a hard prerequisite for this read-only inspection.
      if (
        !this.initializationPromise ||
        !this.profile ||
        !this.repository ||
        !this.drive
      ) {
        throw new Error('The read-only sync repository is not ready.');
      }
      signal = await this.beginOperation('scan', false, 'diagnostic-only');
      const repository = this.repository;
      if (!repository) throw new Error('The read-only sync repository is not ready.');
      diagnostic.phase = 'inspection';
      // Prove the already-selected protocol-3 root with GET-only checks before
      // discovery. Passing layoutValidated then prevents discoverPapers from
      // falling through to empty-layout initialization, which is a write path.
      await repository.assertActiveRoot(signal);
      // A resolver failure can prove one paper only after the account/root guard
      // succeeds and the exact document-scoped discovery call is reached. Keep
      // this provenance separate from an identically coded root-guard failure.
      if (
        requestedForgetDocumentId &&
        this.lastPaperSyncStatusDiagnosticContext?.inspectionSequence ===
          inspectionSequence
      ) {
        this.lastPaperSyncStatusDiagnosticContext.exactDiscoveryStarted = true;
      }
      const scoped = await repository.discoverPapers(
        documentIds,
        [...this.paperStates.values()],
        signal,
        { layoutValidated: true, reuseVerifiedManifests: true },
      );
      const authoritativeByDocument = new Map(
        scoped.papers.map((paper) => [paper.documentId, paper] as const),
      );
      const missing = new Set(scoped.missingDocumentIds);
      let stale = inspectionSequence !== this.paperSyncStatusInspectionSequence;

      for (const [index, documentId] of documentIds.entries()) {
        const target = diagnostic.targets[index];
        if (!target) continue;
        const paper = authoritativeByDocument.get(documentId);
        const currentCatalogPaper = this.view.papers.find(
          (candidate) => candidate.documentId === documentId,
        );
        const guard = guards.get(documentId)!;
        const targetIsStale =
          inspectionSequence !== this.paperSyncStatusInspectionSequence ||
          this.blockingPaperIssues.get(documentId) !== guard.block ||
          paperBlockingIssueFingerprint(this.blockingPaperIssues.get(documentId)) !==
            guard.blockFingerprint ||
          paperSyncStatusGuardFingerprint(
            this.paperStates.get(documentId),
            currentCatalogPaper,
          ) !== guard.stateFingerprint;
        stale ||= targetIsStale;
        const authoritativeIssue =
          paper?.status === 'needs-attention' || paper?.issue
            ? retryDiagnosticIssue(authoritativePaperAttentionIssue(paper))
            : undefined;
        target.authoritative =
          !paper || missing.has(documentId)
            ? {
                result: 'missing',
                presenceState: 'missing',
                packageHeadCount: 0,
                presenceHeadCount: 0,
              }
            : {
                result:
                  paper.status === 'needs-attention' ? 'needs-attention' : 'verified',
                status: paper.status,
                presenceState: paper.presenceState ?? 'missing',
                packageHeadCount: paper.headIds.length,
                presenceHeadCount: paper.presenceHeadIds?.length ?? 0,
                ...(authoritativeIssue ? { issue: authoritativeIssue } : {}),
              };
        const state = this.paperStates.get(documentId);
        const currentIssue = this.blockingPaperIssues.get(documentId)?.issue;
        target.upload = targetIsStale
          ? readOnlyUploadPermission(
              state,
              currentIssue,
              paper,
              'local-state-changed-during-inspection',
            )
          : !paper || missing.has(documentId)
            ? readOnlyUploadPermission(
                state,
                currentIssue,
                undefined,
                'authoritative-result-missing',
              )
            : readOnlyUploadPermission(state, currentIssue, paper);
      }
      diagnostic.phase = stale ? 'stale' : 'complete';
    } catch (error) {
      diagnostic.phase = 'failed';
      diagnostic.failure =
        retryDiagnosticIssue(classifyPaperCoordinatorError(error)) ??
        ({
          code: 'sync-diagnostic-unavailable',
          operation: 'paper-sync-status-check',
          phase: 'inspection',
          causeCode: 'inspection-failed-closed',
          retrySafe: true,
          blocksOrdinarySync: false,
        } satisfies PaperRetryDiagnosticIssue);
      for (const [index, documentId] of documentIds.entries()) {
        const target = diagnostic.targets[index];
        if (!target) continue;
        target.upload = readOnlyUploadPermission(
          this.paperStates.get(documentId),
          this.blockingPaperIssues.get(documentId)?.issue,
          undefined,
          'inspection-failed-closed',
        );
      }
      const scopeChanged = Boolean(
        requestedForgetScope &&
        (this.identity.accountId !== requestedForgetScope.accountId ||
          this.profile?.rootFolderId !== requestedForgetScope.rootFolderId),
      );
      const guardedStateChanged = [...guards].some(([documentId, guard]) => {
        const currentCatalogPaper = this.view.papers.find(
          (candidate) => candidate.documentId === documentId,
        );
        return (
          this.blockingPaperIssues.get(documentId) !== guard.block ||
          paperBlockingIssueFingerprint(this.blockingPaperIssues.get(documentId)) !==
            guard.blockFingerprint ||
          paperSyncStatusGuardFingerprint(
            this.paperStates.get(documentId),
            currentCatalogPaper,
          ) !== guard.stateFingerprint
        );
      });
      if (
        inspectionSequence !== this.paperSyncStatusInspectionSequence ||
        scopeChanged ||
        guardedStateChanged
      ) {
        diagnostic.phase = 'stale';
      }
    } finally {
      if (signal) this.endOperation(signal);
    }

    if (inspectionSequence === this.paperSyncStatusInspectionSequence) {
      this.lastPaperSyncStatusDiagnostic = diagnostic;
      return this.getLastPaperSyncStatusDiagnostic()!;
    }
    return {
      ...diagnostic,
      phase: 'stale',
      targets: diagnostic.targets.map((target) => ({
        ...target,
        current: { ...target.current },
        ...(target.authoritative ? { authoritative: { ...target.authoritative } } : {}),
        upload: {
          permitted: false,
          reason: 'local-state-changed-during-inspection',
        },
      })),
    };
  }

  destroy(): void {
    this.removePersistentListener?.();
    // The active operation's finally block owns release of its workspace lease.
    // Clearing the fence here would make endOperation unable to release it.
    this.operationOwner.destroy();
    if (this.autoUploadTimer !== null) window.clearTimeout(this.autoUploadTimer);
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  async setDeviceMode(mode: SyncDeviceMode): Promise<void> {
    await this.initialize();
    const profile = this.requireProfile();
    if (this.restorePublicationOperation && mode !== profile.deviceMode) {
      throw new WorkspaceRestoreBarrierError(
        'Finish reviewing the restored Library before changing device mode.',
        this.restorePublicationOperation,
      );
    }
    if (this.identity.hasDeviceSession) {
      throw new Error('Disconnect Google Drive before changing the device mode.');
    }
    if (mode === profile.deviceMode && this.view.deviceModeChoiceConfirmed) return;
    try {
      if (mode === 'temporary') {
        const preflight = await inspectTemporaryModePreflight();
        if (!preflight.safe) throw new Error(preflight.reason);
        await this.flushPersistenceChanges();
        await withWorkspaceIdentityTransition((lease) =>
          withWorkspaceMutation(() => beginTemporaryWorkspace(), lease),
        );
      } else {
        if (profile.deviceMode === 'temporary') {
          await leaveEmptyTemporaryWorkspace();
          this.temporaryWorkspaceAccountId = undefined;
          this.temporaryWorkspaceId = undefined;
          await this.runWorkspaceMutation(async (workspaceLease) => {
            const personalProfile = await loadPaperSyncDeviceProfile();
            personalProfile.deviceModeChoiceConfirmed = true;
            await savePaperSyncDeviceProfile(personalProfile, {}, workspaceLease);
          });
        } else {
          await this.runWorkspaceMutation(async (workspaceLease) => {
            const current = this.requireProfile();
            const updated: PaperSyncDeviceProfile = {
              ...current,
              deviceModeChoiceConfirmed: true,
            };
            await savePaperSyncDeviceProfile(updated, {}, workspaceLease);
            this.profile = updated;
            this.updateView({
              deviceModeChoiceConfirmed: true,
              securityState: undefined,
              autoSync: updated.autoSync,
              issue: undefined,
              error: undefined,
            });
          });
          return;
        }
      }
      reloadForWorkspaceChange();
    } catch (error) {
      this.updateView({ error: userMessage(error), issue: undefined });
      throw error;
    }
  }

  async connect(): Promise<void> {
    await this.beginAuthorization(false, false);
  }

  async reconnect(): Promise<void> {
    await this.beginAuthorization(true, false);
  }

  /**
   * Detach the mismatched session while preserving the immutable workspace
   * binding and every local/queued change, then start an explicit same-tab
   * account chooser. Repeated activation rejoins the same recovery attempt.
   */
  reconnectOriginalAccount(): Promise<void> {
    this.accountRecoveryPromise ??= this.reconnectOriginalAccountOnce().finally(() => {
      this.accountRecoveryPromise = null;
    });
    return this.accountRecoveryPromise;
  }

  private async reconnectOriginalAccountOnce(): Promise<void> {
    await this.initialize();
    if (this.view.securityState?.kind !== 'account-mismatch') {
      throw new WorkspaceAccountMismatchError();
    }
    await this.withDriveOperationsQuiesced(
      new DOMException('Google account reconnect started.', 'AbortError'),
      async () => {
        await this.runWorkspaceMutation(async (workspaceLease) => {
          if (this.identity.hasDeviceSession) await this.identity.disconnectCurrent();
          const profile = this.requireProfile();
          delete profile.googleDeviceSessionToken;
          delete profile.accountId;
          await savePaperSyncDeviceProfile(
            profile,
            { authentication: 'replace' },
            workspaceLease,
          );
          this.repository = null;
          this.clearDriveOperationDiagnostics();
          this.drive = null;
          this.updateView({
            connection: 'disconnected',
            lastVerifiedDriveAt: undefined,
            autoSync: profile.deviceMode === 'temporary' ? false : profile.autoSync,
            securityState: undefined,
            issue: undefined,
            error: undefined,
            sessions: [],
            progress: { phase: 'idle' },
          });
        });
      },
    );
    await this.beginAuthorization(true, true);
  }

  private beginAuthorization(
    forceConsent: boolean,
    switchAccount: boolean,
  ): Promise<void> {
    this.authorizationPromise ??= this.beginAuthorizationOnce(
      forceConsent,
      switchAccount,
    ).finally(() => {
      this.authorizationPromise = null;
    });
    return this.authorizationPromise;
  }

  private async beginAuthorizationOnce(
    forceConsent: boolean,
    switchAccount: boolean,
  ): Promise<void> {
    await this.initialize();
    if (!this.view.deviceModeChoiceConfirmed) {
      const error = new DeviceModeSelectionRequiredError();
      this.applySecurityError(error, 'device-mode-required', 'disconnected');
      throw error;
    }
    if (!this.view.backendConfigured)
      throw new Error('Persistent sync backend not configured.');
    this.updateView({ connection: 'connecting', error: undefined, issue: undefined });
    try {
      await this.runWorkspaceMutation(async () => {
        await this.identity.beginAuthorization({
          forceConsent,
          switchAccount,
          ...(this.requireProfile().deviceMode === 'temporary'
            ? {
                beforeNavigation: armTemporaryWorkspaceOAuthReturn,
                onNavigationFailure: clearTemporaryWorkspaceOAuthReturn,
              }
            : {}),
        });
      });
    } catch (error) {
      const issue = classifySyncError(error, {
        online: typeof navigator === 'undefined' || navigator.onLine !== false,
        area: 'authentication',
        hasDeviceSession: this.identity.hasDeviceSession,
      });
      this.updateView({
        connection: connectionForIssue(issue),
        issue,
        error: issue.message,
        progress: { phase: 'idle' },
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.initialize();
    await this.withDriveOperationsQuiesced(
      new DOMException('Google Drive disconnected.', 'AbortError'),
      async () => {
        await this.runWorkspaceMutation(async (workspaceLease) => {
          if (this.identity.hasDeviceSession) await this.identity.disconnectCurrent();
          const profile = this.requireProfile();
          delete profile.googleDeviceSessionToken;
          delete profile.accountId;
          await savePaperSyncDeviceProfile(
            profile,
            { authentication: 'replace' },
            workspaceLease,
          );
          this.repository = null;
          this.clearDriveOperationDiagnostics();
          this.drive = null;
          this.updateView({
            connection: 'disconnected',
            lastVerifiedDriveAt: undefined,
            autoSync: profile.deviceMode === 'temporary' ? false : profile.autoSync,
            securityState: undefined,
            issue: undefined,
            error: undefined,
            sessions: [],
            progress: { phase: 'idle' },
            legacyHousekeeping: { status: 'idle' },
            folderNameMaintenance: { status: 'idle' },
          });
        });
      },
    );
  }

  async disconnectAll(): Promise<void> {
    await this.initialize();
    if (this.restorePublicationOperation) {
      throw new WorkspaceRestoreBarrierError(
        'Disconnect-all is unavailable while restored work is waiting for Drive review.',
        this.restorePublicationOperation,
      );
    }
    await this.withDriveOperationsQuiesced(
      new DOMException('Google Drive sessions disconnected.', 'AbortError'),
      async () => {
        await this.runWorkspaceMutation(async (workspaceLease) => {
          await this.identity.disconnectAll();
          const profile = this.requireProfile();
          delete profile.googleDeviceSessionToken;
          delete profile.accountId;
          delete profile.rootFolderId;
          delete profile.driveChangeCursor;
          delete profile.driveAuditCheckpoint;
          await savePaperSyncDeviceProfile(
            profile,
            { authentication: 'replace' },
            workspaceLease,
          );
          this.repository = null;
          this.clearDriveOperationDiagnostics();
          this.drive = null;
          this.seenRemoteReminderStateIds.clear();
          this.updateView({
            connection: 'disconnected',
            lastVerifiedDriveAt: undefined,
            autoSync: profile.deviceMode === 'temporary' ? false : profile.autoSync,
            securityState: undefined,
            issue: undefined,
            error: undefined,
            sessions: [],
            papers: [],
            progress: { phase: 'idle' },
            legacyHousekeeping: { status: 'idle' },
            folderNameMaintenance: { status: 'idle' },
          });
        });
      },
    );
  }

  async refreshSessions(): Promise<void> {
    if (!this.identity.hasDeviceSession) {
      this.updateView({ sessions: [] });
      return;
    }
    this.updateView({ sessions: await this.identity.listSessions() });
  }

  async chooseRoot(rootId: string): Promise<void> {
    this.assertAuthorizedWorkspaceAccount();
    const root = this.view.rootChoices.find((candidate) => candidate.id === rootId);
    if (!root) throw new Error('The selected Drive folder is no longer available.');
    const signal = await this.beginOperation('other', false);
    try {
      const refreshedRoot = await this.requireDrive().getMetadata(root.id, signal);
      if (!isRecognizedPaperRootMetadata(refreshedRoot)) {
        throw new PaperRepositoryError(
          'drive-root-invalid',
          'The selected Drive folder is not a verified 39Note sync root.',
        );
      }
      const profile = this.requireProfile();
      profile.rootFolderId = refreshedRoot.id;
      delete profile.driveChangeCursor;
      delete profile.driveAuditCheckpoint;
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.repository = await this.createPaperDriveRepository(
        this.requireDrive(),
        refreshedRoot.id,
      );
      this.updateView({
        rootChoices: [],
        rootUrl: rootUrl(refreshedRoot.id),
        lastVerifiedDriveAt: undefined,
        legacyHousekeeping: { status: 'idle' },
        folderNameMaintenance: { status: 'idle' },
      });
    } finally {
      if (signal) this.endOperation(signal);
    }
    await this.inspectAndScan();
  }

  async createReplacementRoot(): Promise<void> {
    await this.initialize();
    this.assertAuthorizedWorkspaceAccount();
    if (this.requireProfile().deviceMode === 'temporary') {
      const error = new PublicDeviceRootMissingError();
      this.applySecurityError(error, 'public-root-missing');
      throw error;
    }
    if (!this.identity.hasDeviceSession) throw new GoogleReauthorizationRequiredError();
    const signal = await this.beginOperation('other');
    try {
      const drive = this.requireDrive();
      const roots = await discoverPaperRootsBeforeCreation(drive, signal);
      if (roots.length > 0) {
        this.updateView({
          connection: 'root-selection-required',
          rootChoices: roots,
          error:
            'An existing 39Note folder was found. Choose it instead of creating a duplicate.',
        });
        return;
      }
      const root = await drive.createFolder(
        ROOT_NAME,
        null,
        {
          application: '39Note',
          role: 'root',
        },
        signal,
      );
      if (!isOwnedManagedPaperRootMetadata(root)) {
        throw new PaperRepositoryError(
          'drive-root-invalid',
          'Google Drive returned an invalid 39Note folder.',
        );
      }
      const confirmedRoots = await confirmCreatedPaperRoot(drive, root, signal);
      if (confirmedRoots.length !== 1) {
        this.updateView({
          connection: 'root-selection-required',
          rootChoices: confirmedRoots,
          error: 'Multiple 39Note folders were created. Choose the folder to use.',
        });
        throw new AmbiguousPaperFolderError('root');
      }
      const profile = this.requireProfile();
      profile.rootFolderId = root.id;
      delete profile.driveChangeCursor;
      delete profile.driveAuditCheckpoint;
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.repository = await this.createPaperDriveRepository(drive, root.id);
      await this.repository.initializeEmptyLayout(signal);
      this.updateView(
        {
          rootUrl: rootUrl(root.id),
          lastVerifiedDriveAt: undefined,
          legacyHousekeeping: { status: 'idle' },
          folderNameMaintenance: { status: 'idle' },
        },
        { notify: false },
      );
    } finally {
      this.endOperation(signal);
    }
    await this.scanCloudPapers();
  }

  async setAutoSync(enabled: boolean): Promise<void> {
    await this.initialize();
    if (this.restorePublicationOperation) {
      throw new WorkspaceRestoreBarrierError(
        'Auto sync cannot change while restored work is waiting for Drive review.',
        this.restorePublicationOperation,
      );
    }
    if (this.view.securityState) {
      throw this.securityStateError(this.view.securityState);
    }
    const autoSync = await this.runWorkspaceMutation(async (workspaceLease) => {
      const profile = this.requireProfile();
      const updated = {
        ...profile,
        autoSync: profile.deviceMode === 'temporary' ? false : enabled,
      };
      await savePaperSyncDeviceProfile(updated, {}, workspaceLease);
      this.profile = updated;
      this.updateView({ autoSync: updated.autoSync });
      return updated.autoSync;
    });
    if (!autoSync && this.autoUploadTimer !== null) {
      window.clearTimeout(this.autoUploadTimer);
      this.autoUploadTimer = null;
    }
    if (autoSync && this.getAutoSyncEligibleDirtyPaperIds().length) {
      this.scheduleAutoUpload();
    }
  }

  async observeCommittedRestorePublicationHold(): Promise<void> {
    await this.initialize();
    const operation = await loadDurableRestoreOperation();
    if (
      !operation ||
      operation.phase !== 'publication-hold' ||
      !operation.publicationHold ||
      !operation.enginePlan ||
      !operation.commitEvidence
    ) {
      throw new WorkspaceRestoreBarrierError(
        'The committed restore publication hold could not be verified.',
        operation ?? undefined,
      );
    }
    this.restorePublicationOperation = operation;
    if (this.autoUploadTimer !== null) {
      window.clearTimeout(this.autoUploadTimer);
      this.autoUploadTimer = null;
    }
    await this.runWorkspaceMutation((workspaceLease) =>
      this.markRestoredPlanDirty(operation, workspaceLease),
    );
    this.refreshStateView();
    this.updateView(
      {
        restorePublicationHold: {
          status: 'waiting',
          restoredDocumentCount: operation.enginePlan.documentDecisions.filter(
            ({ resolution }) => resolution !== 'skip',
          ).length,
        },
        error: undefined,
        issue: undefined,
        restorePublicationNotice: undefined,
        progress: { phase: 'idle' },
      },
      { notify: false },
    );
  }

  resumeAfterRestorePublication(
    authorization: 'resume-restored-library',
  ): Promise<void> {
    if (authorization !== 'resume-restored-library') {
      return Promise.reject(
        new WorkspaceRestoreBarrierError(
          'Publication resume requires explicit user authorization.',
        ),
      );
    }
    this.restorePublicationResumePromise ??=
      this.resumeAfterRestorePublicationOnce().finally(() => {
        this.restorePublicationResumePromise = null;
      });
    return this.restorePublicationResumePromise;
  }

  private async resumeAfterRestorePublicationOnce(): Promise<void> {
    await this.initialize();
    const held = this.restorePublicationOperation;
    if (!held || !this.view.restorePublicationHold) {
      throw new WorkspaceRestoreBarrierError(
        'No verified restored publication hold is available to resume.',
      );
    }
    if (this.view.securityState) throw this.securityStateError(this.view.securityState);
    this.updateView(
      {
        restorePublicationHold: {
          ...this.view.restorePublicationHold,
          status: 'revalidating',
        },
        progress: { phase: 'discovering', detail: 'Revalidating Google Drive' },
        error: undefined,
        issue: undefined,
      },
      { notify: false },
    );

    const queued = this.operationOwner.active;
    let ownedSignal: AbortSignal | null = null;
    let operationEnded = false;
    try {
      ownedSignal = await this.operationOwner.begin();
      const signal = ownedSignal;
      this.startDriveOperationWatchdog(signal, 'restore-revalidation');
      const accountId = this.assertAuthorizedWorkspaceAccount();
      await awaitDriveOperationDeadline(
        this.revalidateOperationWorkspaceAccount(accountId, 'restore-revalidation'),
        signal,
      );
      signal.throwIfAborted();
      await withExclusiveWorkspaceRestoreLease(async (workspaceLease) => {
        const current = await awaitDriveOperationDeadline(
          assertWorkspaceCloudOperationAllowed(workspaceLease, {
            operationId: held.operationId,
            expectedGeneration: held.generation,
          }),
          signal,
        );
        if (!current) throw new WorkspaceRestoreBarrierError();
        signal.throwIfAborted();
        await awaitDriveOperationDeadline(
          this.revalidateOperationWorkspaceAccount(accountId, 'restore-revalidation'),
          signal,
        );
        signal.throwIfAborted();

        const inertExclusiveHandle: HeldWorkspaceRestoreLease = {
          lease: workspaceLease,
          release: () => undefined,
          settled: Promise.resolve(),
        };
        this.activeDriveOperationIdentityFence = {
          signal,
          accountId,
          operationType: 'restore-revalidation',
          workspaceLease,
          workspaceLeaseHandle: inertExclusiveHandle,
        };
        const drive = this.requireDrive();
        const telemetryId = drive.beginOperationTelemetry('restore-revalidation');
        this.operationTelemetryIds.set(signal, telemetryId);
        drive.recordOperationStateTransition({
          phase: 'operation-owner',
          transition: 'operation-owner-acquired',
          outcome: 'succeeded',
          classification: queued ? 'queued' : 'immediate',
        });
        this.markDriveOperationRunning(signal);
        try {
          const profile = this.requireProfile();
          if (!profile.rootFolderId) {
            throw new PaperRepositoryError(
              'drive-root-missing',
              'A verified existing 39Note Drive folder is required before restored work can resume sync.',
            );
          }
          const root = await drive.getMetadata(profile.rootFolderId, signal, {
            phase: 'restore-publication-revalidation',
            dependencyPhase: 'root-layout-guard',
            resource: 'root',
          });
          if (
            root.id !== profile.rootFolderId ||
            !isOwnedManagedPaperRootMetadata(root)
          ) {
            throw new PaperRepositoryError(
              'drive-root-invalid',
              'The selected Google Drive folder is not a verified 39Note sync root.',
            );
          }
          const repository = await this.createPaperDriveRepository(drive, root.id);
          await repository.assertActiveRoot(signal);
          this.repository = repository;
          await this.reconcileLocalPaperStates(workspaceLease);
          await this.runAuthoritativeBaseline(repository, signal, workspaceLease);
          signal.throwIfAborted();
          await awaitDriveOperationDeadline(
            this.revalidateOperationWorkspaceAccount(accountId, 'restore-revalidation'),
            signal,
          );
          signal.throwIfAborted();
          await clearDurablePublicationHold(
            {
              operationId: current.operationId,
              expectedGeneration: current.generation,
              publicationResumeAuthorized: true,
              remoteReconciled: true,
              verifiedAccountId: accountId,
            },
            workspaceLease,
          );
          this.restorePublicationOperation = null;
        } finally {
          this.endOperation(signal);
          operationEnded = true;
        }
      }, signal);
      this.updateView(
        {
          restorePublicationHold: undefined,
          connection: 'connected',
          progress: { phase: 'idle' },
          error: undefined,
          restorePublicationNotice:
            'Google Drive was revalidated. Restored changes remain local until an authorized upload runs.',
          issue: undefined,
        },
        { notify: false },
      );
    } catch (error) {
      const settledError =
        ownedSignal?.aborted && ownedSignal.reason ? ownedSignal.reason : error;
      if (ownedSignal && !operationEnded) this.endOperation(ownedSignal);
      const securityKind = securityStateKindForError(settledError);
      if (securityKind) this.applySecurityError(settledError as Error, securityKind);
      const classified = classifyPaperCoordinatorError(settledError);
      this.rememberRootWidePresenceIssue(settledError, classified);
      const holdError =
        settledError instanceof WorkspaceRestoreBarrierError
          ? 'Restore safety changed in another tab. Reload 39Note before trying to resume sync again.'
          : classified.code === 'drive-changed'
            ? 'Google Drive kept changing during revalidation. Try again when remote changes settle.'
            : classified.message;
      this.updateView(
        {
          restorePublicationHold: {
            ...this.view.restorePublicationHold!,
            status: 'failed',
            error: `${holdError} Restored work remains local and publication stays blocked.`,
          },
          progress: { phase: 'idle' },
          restorePublicationNotice: undefined,
          ...(securityKind
            ? {}
            : {
                error: `${holdError} Restored work remains local and publication stays blocked.`,
              }),
        },
        { notify: false },
      );
      throw settledError;
    }
  }

  checkLegacyDriveData(): Promise<void> {
    this.legacyInventoryPromise ??= this.checkLegacyDriveDataOwned().finally(() => {
      this.legacyInventoryPromise = null;
    });
    return this.legacyInventoryPromise;
  }

  private async checkLegacyDriveDataOwned(): Promise<void> {
    await this.requireInitializedHousekeepingContext();
    const signal = await this.beginOperation('housekeeping', false, 'diagnostic-only');
    this.updateView({ legacyHousekeeping: { status: 'checking' } }, { notify: false });
    try {
      const repository = await this.requireSelectedHousekeepingRepository(signal);
      const options = await this.legacyDriveHousekeepingOptions();
      const inventory = await repository.inspectLegacyDriveData(options, signal);
      signal.throwIfAborted();
      this.updateView(
        { legacyHousekeeping: { status: 'ready', inventory } },
        { notify: false },
      );
    } catch (error) {
      this.updateView(
        {
          legacyHousekeeping: {
            status: 'failed',
            error: legacyHousekeepingMessage(error, 'check'),
          },
        },
        { notify: false },
      );
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  removeRecognizedLegacyData(
    confirmation: typeof LEGACY_CLEANUP_CONFIRMATION,
  ): Promise<void> {
    if (confirmation !== LEGACY_CLEANUP_CONFIRMATION) {
      return Promise.reject(
        new LegacyDriveCleanupRefusedError(
          'Explicit confirmation is required before legacy Drive cleanup.',
        ),
      );
    }
    this.legacyCleanupPromise ??= this.removeRecognizedLegacyDataOwned().finally(() => {
      this.legacyCleanupPromise = null;
    });
    return this.legacyCleanupPromise;
  }

  private async removeRecognizedLegacyDataOwned(): Promise<void> {
    await this.requireInitializedHousekeepingContext();
    const expected = this.view.legacyHousekeeping.inventory;
    if (!expected || this.view.legacyHousekeeping.status !== 'ready') {
      throw new LegacyDriveCleanupRefusedError(
        'Check legacy Drive data again before cleanup.',
      );
    }
    const signal = await this.beginOperation('housekeeping');
    this.updateView(
      {
        legacyHousekeeping: {
          status: 'cleaning',
          inventory: expected,
        },
      },
      { notify: false },
    );
    let repository: PaperDriveRepository | undefined;
    try {
      repository = await this.requireSelectedHousekeepingRepository(signal);
      const options = await this.legacyDriveHousekeepingOptions();
      const result = await repository.cleanupLegacyDriveData(
        expected,
        options,
        signal,
        () => this.legacyDriveHousekeepingOptions(),
      );
      this.updateView(
        {
          legacyHousekeeping: {
            status: 'complete',
            inventory: result.inventory,
            lastTrashedCount: result.trashedIds.length,
          },
        },
        { notify: false },
      );
    } catch (error) {
      let refreshed: LegacyDriveInventory | undefined;
      if (repository && !signal.aborted) {
        try {
          refreshed = await repository.inspectLegacyDriveData(
            await this.legacyDriveHousekeepingOptions(),
            signal,
          );
        } catch {
          // Cleanup failure stays visible even if the read-only refresh also fails.
        }
      }
      this.updateView(
        {
          legacyHousekeeping: {
            status: 'failed',
            ...(refreshed ? { inventory: refreshed } : { inventory: expected }),
            error: legacyHousekeepingMessage(error, 'cleanup'),
          },
        },
        { notify: false },
      );
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  previewPaperFolderNameNormalization(): Promise<void> {
    this.folderNamePreviewPromise ??=
      this.previewPaperFolderNameNormalizationOwned().finally(() => {
        this.folderNamePreviewPromise = null;
      });
    return this.folderNamePreviewPromise;
  }

  private async previewPaperFolderNameNormalizationOwned(): Promise<void> {
    await this.requireInitializedHousekeepingContext();
    const signal = await this.beginOperation('housekeeping', false, 'diagnostic-only');
    this.updateView(
      { folderNameMaintenance: { status: 'checking' } },
      { notify: false },
    );
    try {
      const repository = await this.requireSelectedHousekeepingRepository(signal);
      const preview = await repository.inspectPaperFolderNames(signal);
      signal.throwIfAborted();
      this.updateView(
        { folderNameMaintenance: { status: 'ready', preview } },
        { notify: false },
      );
    } catch (error) {
      this.updateView(
        {
          folderNameMaintenance: {
            status: 'failed',
            error: paperFolderNameMaintenanceMessage(error, 'preview'),
          },
        },
        { notify: false },
      );
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  normalizePaperFolderNames(
    confirmation: typeof PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION,
  ): Promise<void> {
    if (confirmation !== PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION) {
      return Promise.reject(
        new PaperFolderNameNormalizationRefusedError(
          'Explicit confirmation is required before paper folder names are changed.',
        ),
      );
    }
    this.folderNameNormalizationPromise ??=
      this.normalizePaperFolderNamesOwned().finally(() => {
        this.folderNameNormalizationPromise = null;
      });
    return this.folderNameNormalizationPromise;
  }

  private async normalizePaperFolderNamesOwned(): Promise<void> {
    await this.requireInitializedHousekeepingContext();
    const expected = this.view.folderNameMaintenance.preview;
    if (!expected || this.view.folderNameMaintenance.status !== 'ready') {
      throw new PaperFolderNameNormalizationRefusedError(
        'Preview paper folder names again before normalization.',
      );
    }
    const signal = await this.beginOperation('housekeeping');
    this.updateView(
      {
        folderNameMaintenance: {
          status: 'normalizing',
          preview: expected,
        },
      },
      { notify: false },
    );
    let repository: PaperDriveRepository | undefined;
    try {
      repository = await this.requireSelectedHousekeepingRepository(signal);
      const result = await repository.normalizePaperFolderNames(expected, signal);
      this.updateView(
        {
          folderNameMaintenance: {
            status: 'complete',
            preview: result.preview,
            lastRenamedCount: result.renamedFolderIds.length,
          },
        },
        { notify: false },
      );
    } catch (error) {
      let refreshed: PaperFolderNameNormalizationPreview | undefined;
      if (repository && !signal.aborted) {
        try {
          refreshed = await repository.inspectPaperFolderNames(signal);
        } catch {
          // The maintenance failure stays visible even if preview refresh fails.
        }
      }
      this.updateView(
        {
          folderNameMaintenance: {
            status: 'failed',
            ...(refreshed ? { preview: refreshed } : { preview: expected }),
            error: paperFolderNameMaintenanceMessage(error, 'normalize'),
          },
        },
        { notify: false },
      );
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  async scanCloudPapers(): Promise<void> {
    this.scanPromise ??= this.scanCloudPapersOwned(true).finally(() => {
      this.scanPromise = null;
    });
    return this.scanPromise;
  }

  /** Rechecks only an already selected and verified Drive root, without writes. */
  checkDriveAgainReadOnly(): Promise<void> {
    return this.scanCloudPapersUsingVerifiedRepository();
  }

  /**
   * Retries a timed-out read without root discovery, root creation, layout
   * initialization, or any upload. A previously verified live repository is a
   * hard prerequisite; otherwise recovery remains fail closed.
   */
  private scanCloudPapersUsingVerifiedRepository(): Promise<void> {
    if (!this.scanPromise) {
      this.readTimeoutRecoveryInProgress = true;
      this.clearScheduledAutoUpload();
      this.scanPromise = this.scanCloudPapersOwned(true, true).finally(() => {
        this.readTimeoutRecoveryInProgress = false;
        this.scanPromise = null;
      });
    }
    return this.scanPromise;
  }

  private async scanCloudPapersOwned(
    waitForBatch: boolean,
    requireVerifiedRepository = false,
  ): Promise<void> {
    if (requireVerifiedRepository && !this.profile) {
      throw new PaperRepositoryError(
        'drive-root-missing',
        'A verified existing 39Note Drive folder is required for this read-only check.',
      );
    }
    // initializeOnce performs the first lightweight scan after it has loaded the
    // profile.  Awaiting the same initialization promise from that scan would
    // deadlock, so only enter initialization when the profile is not available.
    if (!this.profile) await this.initialize();
    // A local-only removal does not take Drive ownership, but discovery must not
    // snapshot IndexedDB between its explicit started/committed boundaries. The
    // committed handler queues its exact-paper refresh before releasing this wait.
    await this.waitForLocalRemovalSettlement();
    const activeTransfers = this.activePaperTransferPromises();
    if (waitForBatch && activeTransfers.length) {
      await Promise.all(activeTransfers);
      // An ordinary refresh can reuse the transfer's exact settlement. Timeout
      // recovery still owes the user one strict GET-only boundary check.
      if (!requireVerifiedRepository) return;
    }
    const signal = await this.beginOperation('scan');
    try {
      const repository = requireVerifiedRepository
        ? await this.ensureVerifiedRepositoryReadOnly(signal)
        : await this.ensureRepository(signal, false);
      signal.throwIfAborted();
      this.updateView({
        connection: 'syncing',
        progress: { phase: 'discovering', detail: 'Checking Drive papers' },
        error: undefined,
        issue: undefined,
      });
      const workspaceLease = this.requireWorkspaceLease(signal);
      await this.reconcileLocalPaperStates(workspaceLease);
      signal.throwIfAborted();
      await this.discoverWithFastPath(
        repository,
        signal,
        workspaceLease,
        requireVerifiedRepository,
      );
      signal.throwIfAborted();
      const blockingIssue = this.firstBlockingPaperIssue();
      this.updateView(
        {
          connection: this.connectionAfterPaperSettlement(blockingIssue),
          papers: this.view.papers,
          progress: { phase: 'idle' },
          issue: blockingIssue,
          error: blockingIssue?.message,
        },
        { actualWork: false },
      );
    } catch (error) {
      if (signal.aborted) {
        const settledError = signal.reason ?? error;
        this.applyError(settledError);
        throw settledError;
      }
      if (error instanceof PaperManifestIntegrityError && error.documentId) {
        signal.throwIfAborted();
        const issue = await this.markPaperFailure(
          error.documentId,
          error,
          this.requireWorkspaceLease(signal),
        );
        this.updateView({
          connection: this.connectionAfterPaperSettlement(issue),
          issue,
          error: issue.message,
          progress: { phase: 'idle' },
        });
      } else {
        this.applyError(error);
      }
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  private async discoverWithFastPath(
    repository: PaperDriveRepository,
    signal: AbortSignal,
    workspaceLease: WorkspaceRestoreLease,
    strictReadOnly = false,
  ): Promise<void> {
    const profile = this.requireProfile();
    const cursor = profile.driveChangeCursor;
    const now = Date.now();
    const cursorIsCurrent = Boolean(
      cursor &&
      cursor.accountId === profile.accountId &&
      cursor.rootFolderId === profile.rootFolderId &&
      cursor.deviceMode === profile.deviceMode &&
      cursor.lastFullAuditAt <= now &&
      now - cursor.lastFullAuditAt < FULL_DISCOVERY_AUDIT_INTERVAL,
    );
    if (!cursorIsCurrent || !cursor) {
      await this.runAuthoritativeBaseline(
        repository,
        signal,
        workspaceLease,
        strictReadOnly,
      );
      return;
    }

    await repository.assertActiveRoot(signal);
    signal.throwIfAborted();
    let batch;
    try {
      batch = await this.requireDrive().listChanges(cursor.pageToken, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DriveRequestError && error.code === 'change-token-invalid') {
        this.requireDrive().recordOperationStateTransition?.({
          phase: 'changes-invalidation',
          transition: 'changes-invalidation-classified',
          outcome: 'deferred',
          classification: 'cursor-invalid-full-audit',
        });
        await this.runAuthoritativeBaseline(
          repository,
          signal,
          workspaceLease,
          strictReadOnly,
        );
        return;
      }
      throw error;
    }
    signal.throwIfAborted();
    const plan = planPaperChangeDiscovery(
      batch.changes,
      repository.rootFolderId,
      this.view.papers,
    );
    const affectedDocumentIds = plan.affectedDocumentIds.filter(
      (documentId) => !this.isPaperQuarantined(documentId),
    );
    if (plan.requiresFullAudit) {
      this.requireDrive().recordOperationStateTransition?.({
        phase: 'changes-invalidation',
        transition: 'changes-invalidation-classified',
        outcome: 'deferred',
        classification: 'unscoped-change-full-audit',
      });
      await this.runAuthoritativeBaseline(
        repository,
        signal,
        workspaceLease,
        strictReadOnly,
      );
      return;
    }
    if (affectedDocumentIds.length === 0) {
      this.requireDrive().recordOperationStateTransition?.({
        phase: 'changes-invalidation',
        transition: 'changes-invalidation-classified',
        outcome: 'succeeded',
        classification: 'no-relevant-paper-change',
      });
    }
    for (const documentId of affectedDocumentIds) {
      this.requireDrive().recordOperationStateTransition?.({
        phase: 'changes-invalidation',
        transition: 'changes-invalidation-classified',
        documentId,
        outcome: 'succeeded',
        classification: plan.removedManagedFiles.some(
          (removed) => removed.documentId === documentId,
        )
          ? 'scoped-managed-file-removal'
          : 'scoped-paper-change',
      });
    }
    if (affectedDocumentIds.length > 0) {
      let papers = await this.applyScopedDiscovery(
        repository,
        affectedDocumentIds,
        signal,
      );
      signal.throwIfAborted();
      papers = this.retainRemovedManagedFileFailures(papers, plan.removedManagedFiles);
      signal.throwIfAborted();
      await this.applyDiscovery(papers, undefined, workspaceLease);
      signal.throwIfAborted();
      this.assertDiscoverySucceeded(papers, affectedDocumentIds);
    }
    signal.throwIfAborted();
    await this.commitDriveChangeCursor(
      batch.newStartPageToken,
      cursor.lastFullAuditAt,
      signal,
      workspaceLease,
    );
  }

  private async runAuthoritativeBaseline(
    repository: PaperDriveRepository,
    signal: AbortSignal,
    workspaceLease: WorkspaceRestoreLease,
    strictReadOnly = false,
  ): Promise<void> {
    // The checkpoint is not a successful cursor. It only preserves the exact
    // change-feed boundary across a timeout while the independently persisted
    // immutable-record cache avoids downloading the same verified bodies again.
    let checkpoint =
      this.currentDriveAuditCheckpoint() ??
      (await this.createDriveAuditCheckpoint(signal, workspaceLease));
    for (let attempt = 0; attempt < MAX_BASELINE_REPLAY_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      const startPageToken = checkpoint.startPageToken;
      signal.throwIfAborted();
      if (strictReadOnly) {
        // A second exact active-root check closes the TOCTOU gap after recovery
        // admission. Never let this path fall through to empty-layout setup.
        await repository.assertActiveRoot(signal);
      } else {
        await this.assertActiveLayout(repository, signal);
      }
      signal.throwIfAborted();
      const discovered = await repository.discover(
        [...this.paperStates.values()],
        signal,
        {
          layoutValidated: true,
          // files.list supplies fresh immutable Drive evidence on every full
          // audit. Reusing only byte-identical, already verified parses avoids
          // replaying an entire immutable history without weakening ancestry.
          reuseVerifiedManifests: true,
          ignoredDocumentIds: this.activeQuarantinedDocumentIds(),
        },
      );
      signal.throwIfAborted();
      let papers: readonly PaperCloudSummary[] =
        this.retainMissingKnownCloudPapers(discovered);
      let replay;
      try {
        replay = await this.requireDrive().listChanges(startPageToken, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof DriveRequestError &&
          error.code === 'change-token-invalid' &&
          attempt + 1 < MAX_BASELINE_REPLAY_ATTEMPTS
        ) {
          checkpoint = await this.createDriveAuditCheckpoint(signal, workspaceLease);
          continue;
        }
        throw error;
      }
      signal.throwIfAborted();
      const plan = planPaperChangeDiscovery(replay.changes, repository.rootFolderId, [
        ...papers,
        ...this.view.papers,
      ]);
      if (plan.requiresFullAudit) {
        this.requireDrive().recordOperationStateTransition?.({
          phase: 'changes-baseline-replay',
          transition: 'changes-invalidation-classified',
          outcome: 'deferred',
          classification: 'baseline-replay-restarted',
        });
        if (attempt + 1 < MAX_BASELINE_REPLAY_ATTEMPTS) {
          checkpoint = await this.createDriveAuditCheckpoint(signal, workspaceLease);
          continue;
        }
        break;
      }
      for (const documentId of plan.affectedDocumentIds) {
        this.requireDrive().recordOperationStateTransition?.({
          phase: 'changes-baseline-replay',
          transition: 'changes-invalidation-classified',
          documentId,
          outcome: 'succeeded',
          classification: 'baseline-scoped-paper-change',
        });
      }
      const affectedDocumentIds = plan.affectedDocumentIds.filter(
        (documentId) => !this.isPaperQuarantined(documentId),
      );
      if (affectedDocumentIds.length > 0) {
        papers = await this.applyScopedDiscovery(
          repository,
          affectedDocumentIds,
          signal,
          papers,
        );
        signal.throwIfAborted();
      }
      papers = this.retainRemovedManagedFileFailures(papers, plan.removedManagedFiles);
      signal.throwIfAborted();
      await this.applyDiscovery(papers, undefined, workspaceLease);
      signal.throwIfAborted();
      this.assertDiscoverySucceeded(papers);
      signal.throwIfAborted();
      await this.commitDriveChangeCursor(
        replay.newStartPageToken,
        Date.now(),
        signal,
        workspaceLease,
      );
      this.clearRootWidePresenceIssueAfterAuthoritativeBaseline(
        repository.rootFolderId,
      );
      return;
    }
    throw new PaperRepositoryError(
      'paper-remote-changed',
      'Google Drive changed repeatedly during the discovery baseline.',
    );
  }

  private currentDriveAuditCheckpoint(): PaperDriveAuditCheckpoint | undefined {
    const profile = this.requireProfile();
    const checkpoint = profile.driveAuditCheckpoint;
    return checkpoint &&
      checkpoint.accountId === profile.accountId &&
      checkpoint.rootFolderId === profile.rootFolderId &&
      checkpoint.deviceMode === profile.deviceMode
      ? checkpoint
      : undefined;
  }

  private async createDriveAuditCheckpoint(
    signal: AbortSignal,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<PaperDriveAuditCheckpoint> {
    const startPageToken = await this.requireDrive().getStartPageToken(signal);
    signal.throwIfAborted();
    const profile = this.requireProfile();
    if (!profile.accountId || !profile.rootFolderId) {
      throw new Error('Google Drive discovery identity is incomplete.');
    }
    const checkpoint: PaperDriveAuditCheckpoint = {
      version: 1,
      accountId: profile.accountId,
      rootFolderId: profile.rootFolderId,
      deviceMode: profile.deviceMode,
      startPageToken,
      startedAt: Date.now(),
    };
    const next: PaperSyncDeviceProfile = {
      ...profile,
      driveAuditCheckpoint: checkpoint,
    };
    delete next.driveChangeCursor;
    await savePaperSyncDeviceProfile(next, {}, workspaceLease);
    signal.throwIfAborted();
    this.profile = next;
    this.updateView({ lastVerifiedDriveAt: undefined }, { notify: false });
    return checkpoint;
  }

  private async applyScopedDiscovery(
    repository: PaperDriveRepository,
    documentIds: readonly string[],
    signal: AbortSignal,
    baseline: readonly PaperCloudSummary[] = this.view.papers,
  ): Promise<PaperCloudSummary[]> {
    return (await this.readScopedDiscovery(repository, documentIds, signal, baseline))
      .catalog;
  }

  private async readScopedDiscovery(
    repository: PaperDriveRepository,
    documentIds: readonly string[],
    signal: AbortSignal,
    baseline: readonly PaperCloudSummary[] = this.view.papers,
  ): Promise<{ catalog: PaperCloudSummary[]; scoped: PaperScopedDiscoveryResult }> {
    const eligibleDocumentIds = documentIds.filter(
      (documentId) => !this.isPaperQuarantined(documentId),
    );
    const scoped = await repository.discoverPapers(
      eligibleDocumentIds,
      [...this.paperStates.values()],
      signal,
      {
        layoutValidated: true,
        reuseVerifiedManifests: true,
        ignoredDocumentIds: this.activeQuarantinedDocumentIds(),
      },
    );
    const replacements = new Map(
      scoped.papers.map((paper) => [paper.documentId, paper]),
    );
    const missing = new Set(scoped.missingDocumentIds);
    const merged = baseline
      .filter((paper) => !replacements.has(paper.documentId))
      .map((paper) =>
        missing.has(paper.documentId)
          ? {
              ...paper,
              status: 'needs-attention' as const,
              issue: {
                code: 'paper-integrity-failed',
                message: 'Part of this Drive paper is no longer available.',
              },
            }
          : paper,
      );
    for (const documentId of missing) {
      if (!merged.some((paper) => paper.documentId === documentId)) {
        const state = this.paperStates.get(documentId);
        if (state?.driveFiles.paperFolderId) {
          merged.push({
            documentId,
            displayName: state.displayName ?? 'Unavailable paper',
            deleted: false,
            paperFolderId: state.driveFiles.paperFolderId,
            ...(state.driveFiles.dataFolderId
              ? { dataFolderId: state.driveFiles.dataFolderId }
              : {}),
            headIds: [...state.remoteHeadIds],
            headSetId: state.remoteHeadIds.slice().sort().join('|') || 'unavailable',
            localAvailability: state.availability,
            status: 'needs-attention',
            issue: {
              code: 'paper-integrity-failed',
              message: 'Part of this Drive paper is no longer available.',
            },
          });
        }
      }
    }
    return {
      catalog: [...merged, ...replacements.values()].sort((first, second) =>
        first.documentId.localeCompare(second.documentId),
      ),
      scoped,
    };
  }

  private async commitDriveChangeCursor(
    pageToken: string,
    lastFullAuditAt: number,
    signal: AbortSignal,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    signal.throwIfAborted();
    const profile = this.requireProfile();
    if (!profile.accountId || !profile.rootFolderId) {
      throw new Error('Google Drive discovery identity is incomplete.');
    }
    const next: PaperSyncDeviceProfile = {
      ...profile,
      lastDiscoveryAt: Date.now(),
      cloudIssueQuarantines: profile.cloudIssueQuarantines?.map((entry) => {
        if (
          entry.accountId !== profile.accountId ||
          entry.rootFolderId !== profile.rootFolderId ||
          entry.reviewedAt === undefined ||
          !entry.revalidationPending
        ) {
          return entry;
        }
        const { revalidationPending: _completed, ...verified } = entry;
        void _completed;
        return verified;
      }),
      driveChangeCursor: {
        version: 1,
        accountId: profile.accountId,
        rootFolderId: profile.rootFolderId,
        deviceMode: profile.deviceMode,
        pageToken,
        lastFullAuditAt,
      },
    };
    delete next.driveAuditCheckpoint;
    signal.throwIfAborted();
    await savePaperSyncDeviceProfile(next, {}, workspaceLease);
    signal.throwIfAborted();
    this.profile = next;
    this.updateView(
      {
        lastVerifiedDriveAt: verifiedDriveCheckAt(next),
        reviewedCloudIssueRevalidationPending: Boolean(
          this.activeReviewedCloudIssueRevalidation(),
        ),
      },
      { notify: false },
    );
  }

  private assertDiscoverySucceeded(
    papers: readonly PaperCloudSummary[],
    documentIds?: readonly string[],
  ): void {
    const affected = documentIds ? new Set(documentIds) : null;
    const failed = papers.find(
      (paper) =>
        (!affected || affected.has(paper.documentId)) &&
        !this.isPaperQuarantined(paper.documentId) &&
        paper.status === 'needs-attention',
    );
    if (!failed) return;
    throw new PaperManifestIntegrityError(
      failed.issue?.message ?? 'Drive paper data needs verification.',
      failed.documentId,
    );
  }

  private retainRemovedManagedFileFailures(
    papers: readonly PaperCloudSummary[],
    removedFiles: readonly { documentId: string; fileId: string }[],
  ): PaperCloudSummary[] {
    if (removedFiles.length === 0) return [...papers];
    const previous = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper]),
    );
    const byDocumentId = new Map(papers.map((paper) => [paper.documentId, paper]));
    const removedByDocument = new Map<string, string[]>();
    for (const { documentId, fileId } of removedFiles) {
      const ids = removedByDocument.get(documentId) ?? [];
      ids.push(fileId);
      removedByDocument.set(documentId, ids);
    }
    for (const [documentId, removedIds] of removedByDocument) {
      if (this.isPaperQuarantined(documentId)) continue;
      const current = byDocumentId.get(documentId) ?? previous.get(documentId);
      if (!current) continue;
      // A verified v3 removed presence intentionally makes its former managed
      // files disappear. The change feed is only an invalidation hint and must
      // not turn that normal state back into a generic integrity failure.
      if (current.presenceState === 'removed') continue;
      byDocumentId.set(documentId, {
        ...current,
        status: 'needs-attention',
        managedFileIds: [
          ...new Set([
            ...(current.managedFileIds ?? []),
            ...(previous.get(documentId)?.managedFileIds ?? []),
            ...removedIds,
          ]),
        ].sort(),
        issue: {
          code: 'paper-integrity-failed',
          message: 'Part of this Drive paper was removed and needs verification.',
        },
      });
    }
    return [...byDocumentId.values()].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
  }

  private retainMissingKnownCloudPapers(
    papers: readonly PaperCloudSummary[],
  ): readonly PaperCloudSummary[] {
    const discoveredIds = new Set(papers.map((paper) => paper.documentId));
    const retained = new Map<string, PaperCloudSummary>();
    const attentionSummary = (paper: PaperCloudSummary): PaperCloudSummary => ({
      ...paper,
      status: 'needs-attention',
      issue: {
        code: 'paper-integrity-failed',
        message: 'Part of this Drive paper is no longer available.',
      },
    });

    for (const previous of this.view.papers) {
      if (this.isPaperQuarantined(previous.documentId)) {
        if (!discoveredIds.has(previous.documentId)) {
          // Preserve the cached integrity evidence without reclassifying it.
          retained.set(previous.documentId, previous);
        }
        continue;
      }
      if (
        previous.presenceState !== 'removed' &&
        !discoveredIds.has(previous.documentId) &&
        previous.headIds.length > 0
      ) {
        retained.set(previous.documentId, attentionSummary(previous));
      }
    }
    for (const state of this.paperStates.values()) {
      if (
        this.isPaperQuarantined(state.documentId) ||
        discoveredIds.has(state.documentId) ||
        retained.has(state.documentId) ||
        state.remoteHeadIds.length === 0 ||
        state.cloudPresence === 'removed' ||
        !state.driveFiles.paperFolderId
      ) {
        continue;
      }
      const headIds = [...state.remoteHeadIds].sort();
      retained.set(
        state.documentId,
        attentionSummary({
          documentId: state.documentId,
          displayName: state.displayName ?? 'Unavailable paper',
          deleted: false,
          paperFolderId: state.driveFiles.paperFolderId,
          ...(state.driveFiles.dataFolderId
            ? { dataFolderId: state.driveFiles.dataFolderId }
            : {}),
          headIds,
          headSetId: headIds.join('|'),
          managedFileIds: [
            ...new Set([
              ...Object.values(state.driveFiles.fileIds),
              ...(state.driveFiles.sourceArtifactFileId
                ? [state.driveFiles.sourceArtifactFileId]
                : []),
              ...(state.driveFiles.sourcePdfFileId
                ? [state.driveFiles.sourcePdfFileId]
                : []),
              ...(state.driveFiles.renderedPrintPdfFileId
                ? [state.driveFiles.renderedPrintPdfFileId]
                : []),
            ]),
          ].sort(),
          localAvailability: state.availability,
          status: 'needs-attention',
        }),
      );
    }
    if (retained.size === 0) return papers;
    return [...papers, ...retained.values()].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
  }

  downloadSelected(documentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(documentIds)].sort();
    return this.retainPaperOperation('download', ids, async () => {
      await this.initialize();
      for (const documentId of ids) {
        if (!this.isPaperQuarantined(documentId)) {
          this.blockingPaperIssues.delete(documentId);
        }
      }
      try {
        await this.downloadSelectedOwned(ids);
      } catch (error) {
        const issue = classifyPaperCoordinatorError(error);
        if (this.view.progress.phase !== 'idle' || this.view.error !== issue.message) {
          this.applyError(error);
        }
        throw error;
      }
    });
  }

  private async downloadSelectedOwned(documentIds: readonly string[]): Promise<void> {
    await this.initialize();
    const uniqueIds = [...new Set(documentIds)].filter(
      (documentId) =>
        this.paperStates.get(documentId)?.targetedPurge === undefined &&
        !this.isPaperQuarantined(documentId),
    );
    if (!uniqueIds.length) return;
    let completed = 0;
    let actualWork = false;
    const settledCloud: PaperCloudSummary[] = [];
    const failures: Array<{
      documentId: string;
      error: unknown;
      issue: SyncOperationalIssue;
    }> = [];
    const signal = await this.beginOperation('download');
    try {
      const repository = await this.ensureRepository(signal, false);
      this.updateView({
        connection: 'syncing',
        progress: { phase: 'downloading', completed: 0, total: uniqueIds.length },
      });
      await mapWithConcurrency(
        uniqueIds,
        PAPER_TRANSFER_CONCURRENCY,
        async (documentId) => {
          const capturedLocalRemovalEpoch = this.localRemovalEpoch(documentId);
          try {
            await this.paperFlights.run(`download:${documentId}`, async () => {
              if (
                await this.staleBecauseLocalRemoval(
                  documentId,
                  capturedLocalRemovalEpoch,
                )
              ) {
                return;
              }
              const summary = this.view.papers.find(
                (paper) => paper.documentId === documentId,
              );
              if (!summary)
                throw new Error('The selected cloud paper is no longer listed.');
              if (summary.presenceState === 'removed') {
                throw new Error('A paper removed from Drive cannot be downloaded.');
              }
              assertPdfOnlyCloudPaper(summary);
              const state =
                this.paperStates.get(documentId) ??
                createDefaultPaperSyncState(
                  documentId,
                  this.requireProfile().deviceId,
                  'cloud-only',
                );
              const preDownloadStatus = state.status;
              state.status = 'downloading';
              this.drive?.recordOperationStateTransition?.({
                phase: 'download-local-state',
                transition: 'paper-state-updated',
                documentId,
                previousPaperState: preDownloadStatus,
                nextPaperState: state.status,
                outcome: 'started',
              });
              // Cloud-only papers do not have an entry in paperStates yet. Make the
              // transient state authoritative before the first await so Library rows
              // immediately reflect the click and cannot offer a duplicate download.
              this.paperStates.set(documentId, state);
              this.refreshStateView();
              await savePaperSyncState(state, this.requireWorkspaceLease(signal));
              const canReuseStoredSource = await this.local.hasReusableStoredSource(
                documentId,
                state,
                summary.sourceArtifact,
              );
              const downloadOperationCache = createPaperDownloadOperationCache();
              const result = await runScopedPaperDownload({
                documentId,
                initialSnapshot: summary,
                download: (selectedSummary) =>
                  repository.downloadPaper(
                    selectedSummary,
                    signal,
                    (progress) =>
                      this.applyPaperProgress(progress, completed, uniqueIds.length),
                    state,
                    canReuseStoredSource,
                    downloadOperationCache,
                  ),
                onRetry: () => {
                  this.requireDrive().recordOperationRetry();
                  this.requireDrive().recordOperationStateTransition?.({
                    phase: 'download-snapshot-retry',
                    transition: 'operation-retry-classified',
                    documentId,
                    outcome: 'deferred',
                    classification: 'remote-snapshot-changed-scoped-retry',
                  });
                  this.applyPaperProgress(
                    {
                      documentId,
                      phase: 'resolving',
                      detail: 'Refreshing latest Drive version',
                    },
                    completed,
                    uniqueIds.length,
                  );
                },
                refresh: async (error) => {
                  const scoped = await repository.discoverPapers(
                    [documentId],
                    [state],
                    signal,
                    {
                      // The failed attempt already completed the full layout guard,
                      // and the retry performs it again before applying anything.
                      // Refresh only this document's authoritative snapshot here;
                      // avoid a root-wide layout inventory between those guards.
                      layoutValidated: true,
                    },
                  );
                  this.assertDiscoverySucceeded(scoped.papers, [documentId]);
                  const refreshed = scoped.papers.find(
                    (paper) => paper.documentId === documentId,
                  );
                  if (!refreshed || refreshed.presenceState === 'removed') {
                    throw new PaperSnapshotUnstableError(documentId, { cause: error });
                  }
                  return refreshed;
                },
              });
              if (
                await this.staleBecauseLocalRemoval(
                  documentId,
                  capturedLocalRemovalEpoch,
                )
              ) {
                await this.local.ensurePaperAbsent(
                  documentId,
                  signal,
                  this.requireWorkspaceLease(signal),
                );
                this.drive?.recordOperationStateTransition?.({
                  phase: 'download-local-state',
                  transition: 'stale-local-snapshot-discarded',
                  documentId,
                  outcome: 'deferred',
                  classification: 'intentional-local-removal',
                });
                return;
              }
              const expectedRenderedPrintPdf =
                await this.local.captureRenderedPrintPdfStorageIdentity(documentId);
              const capturedDirtyGeneration = state.dirtyGeneration;
              const hadLocalChanges =
                state.dirtyReasons.length > 0 && state.availability !== 'cloud-only';
              const stateBeforeLocalApplication = structuredClone(state);
              let applied = result;
              if (hadLocalChanges) {
                const local = state.locallyDeleted
                  ? this.local.createDeletedPaperPackage(
                      documentId,
                      state,
                      this.writer(),
                    )
                  : await this.local.createPaperPackage(
                      documentId,
                      state,
                      this.writer(),
                    );
                const merged = mergeSyncSnapshots(
                  local.snapshot,
                  result.snapshot,
                  state.baselineHashes,
                );
                applied = {
                  ...result,
                  snapshot: merged.snapshot,
                  sourceArtifact: result.sourceArtifact ?? local.sourceArtifact,
                  sourcePdf: result.sourcePdf ?? local.sourcePdf,
                  renderedPrintPdf: state.dirtyReasons.includes('rendered-print-pdf')
                    ? local.renderedPrintPdf
                    : result.renderedPrintPdf,
                  conflicts: [...result.conflicts, ...merged.conflicts],
                };
              }
              const localApplication = await this.requireDrive().measureOperationPhase(
                'indexeddb-commit',
                () =>
                  this.local.applyDownloadedPaper(applied, signal, {
                    expectedRenderedPrintPdf,
                    workspaceLease: this.requireWorkspaceLease(signal),
                  }),
                { documentId },
              );
              if (
                await this.staleBecauseLocalRemoval(
                  documentId,
                  capturedLocalRemovalEpoch,
                )
              ) {
                await this.local.ensurePaperAbsent(
                  documentId,
                  signal,
                  this.requireWorkspaceLease(signal),
                );
                this.drive?.recordOperationStateTransition?.({
                  phase: 'download-local-state',
                  transition: 'stale-local-application-discarded',
                  documentId,
                  outcome: 'deferred',
                  classification: 'intentional-local-removal',
                });
                return;
              }
              try {
                const downloadedDeletion = !applied.snapshot.entities.some(
                  (entity) => entity.kind === 'document' && entity.id === documentId,
                );
                state.availability = downloadedDeletion
                  ? 'cloud-only'
                  : 'local-and-cloud';
                state.locallyDeleted = false;
                state.incorporatedHeadIds = [...result.headIds];
                state.remoteHeadIds = [...result.headIds];
                state.cloudPresence = 'present';
                state.presenceHeadIds = [...(result.cloud.presenceHeadIds ?? [])];
                state.cloudCleanupPending = false;
                delete state.dismissedRemoteHeadIds;
                state.entityVersions = Object.fromEntries(
                  applied.snapshot.entities.map((entity) => [
                    entity.key,
                    entity.version,
                  ]),
                );
                state.baselineHashes = Object.fromEntries(
                  result.snapshot.entities.map((entity) => [
                    entity.key,
                    entity.version.hash,
                  ]),
                );
                state.tombstones = applied.snapshot.tombstones;
                state.conflicts = applied.conflicts;
                state.driveFiles.paperFolderId = result.cloud.paperFolderId;
                state.driveFiles.dataFolderId = result.cloud.dataFolderId;
                state.driveFiles.sourceArtifactFileId =
                  result.cloud.sourceArtifact?.fileId;
                state.driveFiles.sourcePdfFileId =
                  result.cloud.sourceArtifact?.documentType === 'pdf'
                    ? result.cloud.sourceArtifact.fileId
                    : undefined;
                if (result.sourceArtifactDriveEvidence) {
                  state.driveFiles.sourceArtifactEvidence =
                    result.sourceArtifactDriveEvidence;
                } else {
                  delete state.driveFiles.sourceArtifactEvidence;
                }
                if (
                  result.sourcePdfDriveEvidence &&
                  result.cloud.sourceArtifact?.documentType === 'pdf'
                ) {
                  state.driveFiles.sourcePdfEvidence = result.sourcePdfDriveEvidence;
                } else {
                  delete state.driveFiles.sourcePdfEvidence;
                }
                const downloadedSourceFingerprint = result.sourceArtifact
                  ? {
                      size: result.sourceArtifact.size,
                      lastModified: result.sourceArtifact.lastModified,
                      storedAt: result.sourceArtifact.storedAt,
                      sha256: result.sourceArtifact.sha256,
                    }
                  : result.reusedSourceArtifactFingerprint;
                if (downloadedSourceFingerprint) {
                  state.sourceFingerprints ??= {};
                  state.sourceFingerprints.source = downloadedSourceFingerprint;
                  if (result.cloud.sourceArtifact?.documentType === 'pdf') {
                    state.pdfFingerprints.source = downloadedSourceFingerprint;
                  }
                }
                state.lastSuccessfulAt = Date.now();
                if (!hadLocalChanges) {
                  settleCapturedDirtyGeneration(state, capturedDirtyGeneration);
                }
                state.status = state.dirtyReasons.length ? 'local-changes' : 'synced';
                this.drive?.recordOperationStateTransition?.({
                  phase: 'download-local-state',
                  transition: 'paper-state-updated',
                  documentId,
                  previousPaperState: 'downloading',
                  nextPaperState: state.status,
                  presenceState: 'present',
                  outcome: 'succeeded',
                });
                await finalizeAppliedPaperDownload(localApplication, async () => {
                  await this.requireDrive().measureOperationPhase(
                    'state-ui-settlement',
                    async () => {
                      await savePaperSyncState(
                        state,
                        this.requireWorkspaceLease(signal),
                      );
                      this.paperStates.set(documentId, state);
                      this.blockingPaperIssues.delete(documentId);
                      this.paperRetryIntents.delete(documentId);
                    },
                    { documentId },
                  );
                  if (this.requireProfile().deviceMode === 'temporary') {
                    const collectionIds = applied.snapshot.entities
                      .filter((entity) => entity.kind === 'collection')
                      .map((entity) => entity.id);
                    await recordTemporaryPaperIds(
                      [documentId],
                      collectionIds,
                      this.requireWorkspaceLease(signal),
                    );
                  }
                });
              } catch (settlementError) {
                this.paperStates.set(documentId, stateBeforeLocalApplication);
                throw settlementError;
              }
              settledCloud.push(result.cloud);
              actualWork = true;
            });
          } catch (error) {
            if (
              await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
            ) {
              this.drive?.recordOperationStateTransition?.({
                phase: 'download-local-state',
                transition: 'operation-retry-classified',
                documentId,
                outcome: 'deferred',
                classification: 'intentional-local-removal-superseded-download',
              });
              return;
            }
            failures.push({
              documentId,
              error,
              issue: await this.markPaperFailure(
                documentId,
                error,
                this.requireWorkspaceLease(signal),
              ),
            });
          } finally {
            completed += 1;
            this.updateView({
              progress: { phase: 'downloading', completed, total: uniqueIds.length },
            });
          }
        },
      );
      // Exact immutable heads were already revalidated by downloadPaper. Persist the
      // affected catalog entries without an unrelated whole-library rediscovery.
      if (settledCloud.length > 0) {
        this.updateView(
          {
            progress: {
              phase: 'verifying',
              detail: 'Finishing downloaded papers',
            },
          },
          { notify: false },
        );
        await this.applyTransferCatalog(
          settledCloud,
          this.requireWorkspaceLease(signal),
        );
      }
      const profile = this.requireProfile();
      if (!failures.length) {
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(
          profile,
          {},
          this.requireWorkspaceLease(signal),
        );
      }
      const primaryIssue =
        failures.find((failure) => failure.issue.blocksOrdinarySync)?.issue ??
        failures[0]?.issue ??
        this.firstBlockingPaperIssue();
      this.updateView(
        {
          connection: this.connectionAfterPaperSettlement(primaryIssue),
          lastSuccessfulAt: profile.lastSuccessfulAt,
          progress: { phase: 'idle' },
          issue: primaryIssue,
          error: primaryIssue?.message,
        },
        { actualWork },
      );
      if (failures.length) throw failures[0].error;
    } catch (error) {
      if (!failures.some((failure) => failure.error === error)) {
        for (const documentId of uniqueIds) {
          if (this.paperStates.get(documentId)?.status === 'downloading') {
            await this.markPaperFailure(
              documentId,
              error,
              this.requireWorkspaceLease(signal),
            );
          }
        }
        this.applyError(error);
      }
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  downloadAll(): Promise<void> {
    const states = new Map(
      this.view.paperStates.map((state) => [state.documentId, state]),
    );
    return this.downloadSelected(
      this.view.papers
        .filter(
          (paper) =>
            !this.isPaperQuarantined(paper.documentId) &&
            paper.presenceState !== 'removed' &&
            paper.status !== 'needs-attention' &&
            (!paper.deleted ||
              states.get(paper.documentId)?.availability !== 'cloud-only'),
        )
        .map((paper) => paper.documentId),
    );
  }

  uploadSelected(documentIds: readonly string[]): Promise<void> {
    this.transientRetryAttempt = 0;
    return this.startUpload(documentIds);
  }

  private startUpload(documentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(documentIds)].sort();
    return this.retainPaperOperation('upload', ids, async () => {
      await this.initialize();
      for (const documentId of ids) {
        if (!this.isPaperQuarantined(documentId)) {
          this.blockingPaperIssues.delete(documentId);
        }
      }
      try {
        await this.uploadSelectedOwned(ids);
      } catch (error) {
        const issue = classifyPaperCoordinatorError(error);
        if (this.view.progress.phase !== 'idle' || this.view.error !== issue.message) {
          this.applyError(error);
        }
        if (
          this.autoUploadTimer === null &&
          issue.retrySafe &&
          !issue.blocksOrdinarySync
        ) {
          this.scheduleDirtyFollowUp([issue]);
        }
        throw error;
      }
    });
  }

  async retryNow(): Promise<void> {
    await this.waitForLocalRemovalSettlement();
    this.transientRetryAttempt = 0;
    if (this.activeReviewedCloudIssueRevalidation()) {
      await this.scanCloudPapersUsingVerifiedRepository();
      return;
    }
    if (this.view.issue?.code === 'drive-operation-timeout') {
      // Recover the connection boundary first. This remains read-only even when
      // unrelated papers are dirty or need attention; those commands require a
      // later, separately visible user action after Drive responds again.
      await this.scanCloudPapersUsingVerifiedRepository();
      return;
    }
    const documentIds = this.retryCandidatePaperIds();
    if (!documentIds.length) {
      const uncertainMutation = this.view.issue?.code === 'drive-mutation-uncertain';
      await this.scanCloudPapers();
      // An uncertain mutation must never be replayed. Its first Retry only
      // re-establishes authoritative Drive state.
      if (uncertainMutation) return;
      const dirty = this.getAutoSyncEligibleDirtyPaperIds();
      if (dirty.length) await this.uploadSelected(dirty);
      return;
    }

    const key = documentIds.join('\u0000');
    const existing = this.activePaperRetryTasks.get(key);
    if (existing) return existing;
    const retry = this.retryFailedPaperWork(documentIds).finally(() => {
      if (this.activePaperRetryTasks.get(key) === retry) {
        this.activePaperRetryTasks.delete(key);
      }
    });
    this.activePaperRetryTasks.set(key, retry);
    return retry;
  }

  private retryCandidatePaperIds(): string[] {
    const ids = new Set<string>([
      ...this.paperRetryIntents.keys(),
      ...this.blockingPaperIssues.keys(),
      ...[...this.paperStates.values()]
        .filter((state) => state.status === 'needs-attention')
        .map((state) => state.documentId),
    ]);
    const diagnosticDocumentId = this.view.issue?.diagnostic.documentId;
    if (diagnosticDocumentId) ids.add(diagnosticDocumentId);
    return [...ids]
      .filter(
        (documentId) =>
          this.paperStates.get(documentId)?.targetedPurge === undefined &&
          !this.isPaperQuarantined(documentId),
      )
      .sort();
  }

  private beginPaperRetryDiagnostic(
    documentIds: readonly string[],
  ): PaperRetryDiagnosticSnapshot {
    const catalog = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper] as const),
    );
    const diagnostic: PaperRetryDiagnosticSnapshot = {
      operation: 'paper-retry',
      phase: 'admission',
      targetCount: documentIds.length,
      targets: documentIds.map((documentId, index) => {
        const state = this.paperStates.get(documentId);
        const paper = catalog.get(documentId);
        const activeBlockingIssue = retryDiagnosticIssue(
          this.blockingPaperIssues.get(documentId)?.issue,
        );
        return {
          target: `Paper ${index + 1}`,
          admission: {
            ...(state?.status ? { status: state.status } : {}),
            ...(state?.cloudPresence ? { cloudPresence: state.cloudPresence } : {}),
            dirtyReasonCount: state?.dirtyReasons.length ?? 0,
            packageHeadCount: state?.remoteHeadIds.length ?? 0,
            incorporatedHeadCount: state?.incorporatedHeadIds.length ?? 0,
            presenceHeadCount: state?.presenceHeadIds?.length ?? 0,
            ...(this.paperRetryIntents.get(documentId)
              ? { retryIntent: this.paperRetryIntents.get(documentId)! }
              : {}),
            ...(paper?.issue?.code ? { catalogIssueCode: paper.issue.code } : {}),
            ...(paper?.issue?.phase ? { catalogIssuePhase: paper.issue.phase } : {}),
            ...(paper?.issue?.causeCode
              ? { catalogCauseCode: paper.issue.causeCode }
              : {}),
            ...(activeBlockingIssue ? { activeBlockingIssue } : {}),
          },
        };
      }),
    };
    this.lastPaperRetryDiagnostic = diagnostic;
    return diagnostic;
  }

  private paperRetryDiagnosticTarget(
    diagnostic: PaperRetryDiagnosticSnapshot,
    documentIds: readonly string[],
    documentId: string,
  ): PaperRetryDiagnosticTarget | undefined {
    const index = documentIds.indexOf(documentId);
    return index < 0 ? undefined : diagnostic.targets[index];
  }

  private updatePaperRetryDiagnosticSettlement(
    diagnostic: PaperRetryDiagnosticSnapshot,
    documentIds: readonly string[],
    documentId: string,
    selectedAction?: PaperRetryAction,
  ): void {
    const target = this.paperRetryDiagnosticTarget(diagnostic, documentIds, documentId);
    if (!target) return;
    const priorIssue = target.admission.activeBlockingIssue;
    const active = retryDiagnosticIssue(
      this.blockingPaperIssues.get(documentId)?.issue,
    );
    const settledAction = selectedAction ?? target.settlement?.selectedAction;
    const finalStatus = this.paperStates.get(documentId)?.status;
    const sameIssue = Boolean(
      priorIssue &&
      active &&
      priorIssue.code === active.code &&
      priorIssue.operation === active.operation &&
      priorIssue.phase === active.phase &&
      priorIssue.causeCode === active.causeCode,
    );
    target.settlement = {
      blockDisposition: !active
        ? priorIssue
          ? 'cleared'
          : 'none'
        : !priorIssue
          ? 'introduced'
          : sameIssue
            ? 'retained'
            : 'replaced',
      ...(settledAction ? { selectedAction: settledAction } : {}),
      ...(finalStatus ? { finalStatus } : {}),
      ...(active ? { activeBlockingIssue: active } : {}),
    };
  }

  private async retryFailedPaperWork(documentIds: readonly string[]): Promise<void> {
    const diagnostic = this.beginPaperRetryDiagnostic(documentIds);
    const uncertainMutationIds = new Set(
      documentIds.filter(
        (documentId) =>
          this.blockingPaperIssues.get(documentId)?.issue.code ===
          'drive-mutation-uncertain',
      ),
    );
    this.emit();
    try {
      const active = [...this.activePaperOperationTasks.values()].filter(
        ({ operation }) =>
          operation.documentIds.some((documentId) => documentIds.includes(documentId)),
      );
      const activelyCovered = new Set(
        active.flatMap(({ operation }) => operation.documentIds),
      );
      if (documentIds.every((documentId) => activelyCovered.has(documentId))) {
        diagnostic.phase = 'execution';
        this.emit();
        await Promise.all(active.map(({ promise }) => promise));
        diagnostic.phase = 'settled';
        return;
      }
      if (active.length) {
        // Never race a Retry against work that already owns any requested paper.
        // Once those operations settle, the exact-paper refresh below classifies
        // only the still-relevant work for the full Retry selection.
        await Promise.allSettled(active.map(({ promise }) => promise));
      }

      await this.revalidatePaperRetryTargets(documentIds, diagnostic);
      diagnostic.phase = 'execution';
      this.emit();

      const upload: string[] = [];
      const download: string[] = [];
      const cleanup: string[] = [];
      for (const documentId of documentIds) {
        const state = this.paperStates.get(documentId);
        if (!state) continue;
        if (
          uncertainMutationIds.has(documentId) &&
          !this.blockingPaperIssues.has(documentId)
        ) {
          this.paperRetryIntents.delete(documentId);
          this.updatePaperRetryDiagnosticSettlement(
            diagnostic,
            documentIds,
            documentId,
            'revalidate',
          );
          continue;
        }
        const action = selectPaperRetryAction(
          state,
          this.blockingPaperIssues.get(documentId)?.issue,
          this.paperRetryIntents.get(documentId),
        );
        this.updatePaperRetryDiagnosticSettlement(
          diagnostic,
          documentIds,
          documentId,
          action,
        );
        if (action === 'upload') upload.push(documentId);
        if (action === 'download') download.push(documentId);
        if (action === 'remove-cleanup') cleanup.push(documentId);
      }

      if (cleanup.length) {
        const result = await this.removeFromGoogleDriveSelected(cleanup);
        const stillPending = new Set(
          result.cleanupPending.map(({ documentId }) => documentId),
        );
        for (const documentId of cleanup) {
          if (!stillPending.has(documentId)) this.paperRetryIntents.delete(documentId);
        }
        if (result.failed.length) throw new Error(result.failed[0].message);
      }
      if (download.length) await this.downloadSelected(download);
      if (upload.length) await this.uploadSelected(upload);

      const remainingIssue = this.firstBlockingPaperIssue();
      if (!cleanup.length && !download.length && !upload.length) {
        this.updateView({
          connection: this.connectionAfterPaperSettlement(remainingIssue),
          progress: { phase: 'idle' },
          issue: remainingIssue,
          error: remainingIssue?.message,
        });
      }
      diagnostic.phase = 'settled';
    } catch (error) {
      const failure = retryDiagnosticIssue(classifyPaperCoordinatorError(error));
      if (failure) diagnostic.failure = failure;
      diagnostic.phase = 'failed';
      throw error;
    } finally {
      for (const documentId of documentIds) {
        this.updatePaperRetryDiagnosticSettlement(diagnostic, documentIds, documentId);
      }
      this.emit();
    }
  }

  private async revalidatePaperRetryTargets(
    documentIds: readonly string[],
    diagnostic = this.lastPaperRetryDiagnostic,
  ): Promise<void> {
    if (diagnostic) diagnostic.phase = 'revalidation';
    await this.initialize();
    const originalBlocks = new Map<string, BlockingPaperIssue>();
    for (const documentId of documentIds) {
      const block = this.blockingPaperIssues.get(documentId);
      if (block) originalBlocks.set(documentId, block);
    }
    const originalBlockFingerprints = new Map(
      documentIds.map((documentId) => [
        documentId,
        paperBlockingIssueFingerprint(this.blockingPaperIssues.get(documentId)),
      ]),
    );
    const previousCatalogIssueCodes = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper.issue?.code]),
    );
    const signal = await this.beginOperation('scan');
    try {
      const repository = await this.ensureRepository(signal, false);
      this.updateView({
        connection: 'syncing',
        progress: {
          phase: 'discovering',
          detail:
            documentIds.length === 1
              ? 'Rechecking failed paper'
              : `Rechecking ${documentIds.length} failed papers`,
        },
        error: undefined,
        issue: this.firstBlockingPaperIssue(),
      });
      const { scoped } = await this.readScopedDiscovery(
        repository,
        documentIds,
        signal,
      );
      const authoritativeByDocument = new Map(
        scoped.papers.map((paper) => [paper.documentId, paper] as const),
      );
      const missing = new Set(scoped.missingDocumentIds);
      const applicableDocumentIds: string[] = [];
      const blockChanges = new Map<
        string,
        {
          previous: BlockingPaperIssue | undefined;
          applied: BlockingPaperIssue | undefined;
        }
      >();
      const statusChanges = new Map<
        string,
        {
          state: PaperSyncState;
          previous: PaperSyncState['status'];
          applied: PaperSyncState['status'];
        }
      >();

      // A successful exact-paper read is the evidence needed to retire a
      // retryable operational error. Structural/user-choice issues remain until
      // their authoritative evidence changes or the user takes the explicit
      // action they require. A block replaced while this read was in flight is
      // newer evidence and must never be overwritten by the stale result.
      for (const documentId of documentIds) {
        const block = originalBlocks.get(documentId);
        const paper = authoritativeByDocument.get(documentId);
        const diagnosticTarget = diagnostic
          ? this.paperRetryDiagnosticTarget(diagnostic, documentIds, documentId)
          : undefined;
        if (diagnosticTarget) {
          diagnosticTarget.repository = paper
            ? {
                result:
                  paper.status === 'needs-attention' ? 'needs-attention' : 'verified',
                status: paper.status,
                presenceState: paper.presenceState ?? 'missing',
                packageHeadCount: paper.headIds.length,
                presenceHeadCount: paper.presenceHeadIds?.length ?? 0,
                ...(paper.issue?.code ? { issueCode: paper.issue.code } : {}),
                ...(paper.issue?.phase ? { phase: paper.issue.phase } : {}),
                ...(paper.issue?.causeCode ? { causeCode: paper.issue.causeCode } : {}),
              }
            : {
                result: 'missing',
                presenceState: 'missing',
                packageHeadCount: 0,
                presenceHeadCount: 0,
              };
        }
        const currentBlock = this.blockingPaperIssues.get(documentId);
        const staleBlock =
          currentBlock !== block ||
          paperBlockingIssueFingerprint(currentBlock) !==
            originalBlockFingerprints.get(documentId);
        if (staleBlock || !paper || missing.has(documentId)) continue;
        applicableDocumentIds.push(documentId);

        if (paper.status === 'needs-attention') {
          const authoritativeIssue = authoritativePaperAttentionIssue(paper);
          if (
            !sameAuthoritativeIssue(block?.issue, authoritativeIssue) ||
            block?.headSetId !== paper.headSetId
          ) {
            const applied: BlockingPaperIssue = {
              headSetId: paper.headSetId,
              issue: authoritativeIssue,
            };
            blockChanges.set(documentId, { previous: block, applied });
            this.blockingPaperIssues.set(documentId, applied);
          }
          const state = this.paperStates.get(documentId);
          if (state && state.status !== 'needs-attention') {
            statusChanges.set(documentId, {
              state,
              previous: state.status,
              applied: 'needs-attention',
            });
            state.status = 'needs-attention';
          }
          continue;
        }
        const verifiedPresenceRecovery = Boolean(
          hasVerifiedPresenceRecovery(
            paper,
            block?.issue,
            previousCatalogIssueCodes.get(documentId),
          ),
        );
        const retryableOperationalFailure = Boolean(
          block?.issue.retrySafe && block.issue.actions.includes('retry-now'),
        );
        const verifiedUncertainMutation =
          block?.issue.code === 'drive-mutation-uncertain';
        if (
          !verifiedPresenceRecovery &&
          !retryableOperationalFailure &&
          !verifiedUncertainMutation
        ) {
          continue;
        }
        blockChanges.set(documentId, { previous: block, applied: undefined });
        this.blockingPaperIssues.delete(documentId);
        const state = this.paperStates.get(documentId);
        if (state) {
          const nextStatus = paperStatusAfterFailure(state, false);
          if (state.status !== nextStatus) {
            statusChanges.set(documentId, {
              state,
              previous: state.status,
              applied: nextStatus,
            });
            state.status = nextStatus;
          }
        }
        if (verifiedPresenceRecovery) {
          this.drive?.recordOperationStateTransition?.({
            phase: 'paper-retry-revalidation',
            transition: 'paper-issue-cleared',
            documentId,
            issueCode: 'paper-presence-invalid',
            presenceState: 'present',
            outcome: 'succeeded',
            classification: 'exact-presence-revalidated',
          });
        }
      }

      const refreshed = mergeScopedPaperDiscoveryCatalog(
        this.view.papers,
        scoped.papers.filter((paper) =>
          applicableDocumentIds.includes(paper.documentId),
        ),
        applicableDocumentIds,
      );
      try {
        if (applicableDocumentIds.length) {
          await this.applyDiscovery(
            refreshed,
            applicableDocumentIds,
            this.requireWorkspaceLease(signal),
          );
        }
      } catch (error) {
        // Applying the verified result is a separate local commit boundary. If
        // it fails, restore the exact pre-read blockers unless newer work has
        // already replaced them.
        for (const [documentId, change] of blockChanges) {
          if (this.blockingPaperIssues.get(documentId) !== change.applied) continue;
          if (change.previous)
            this.blockingPaperIssues.set(documentId, change.previous);
          else this.blockingPaperIssues.delete(documentId);
        }
        for (const change of statusChanges.values()) {
          if (change.state.status === change.applied)
            change.state.status = change.previous;
        }
        throw error;
      }
      for (const documentId of documentIds) {
        if (diagnostic) {
          this.updatePaperRetryDiagnosticSettlement(
            diagnostic,
            documentIds,
            documentId,
          );
        }
      }
      const issue = this.firstBlockingPaperIssue();
      this.updateView({
        connection: this.connectionAfterPaperSettlement(issue),
        progress: { phase: 'idle' },
        issue,
        error: issue?.message,
      });
    } catch (error) {
      const retainedIssue = this.firstBlockingPaperIssue();
      if (retainedIssue) {
        this.updateView({
          connection: this.connectionAfterPaperSettlement(retainedIssue),
          progress: { phase: 'idle' },
          issue: retainedIssue,
          error: retainedIssue.message,
        });
      } else this.applyError(error);
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  async removeFromGoogleDrive(documentId: string): Promise<void> {
    const result = await this.removeFromGoogleDriveSelected([documentId]);
    const failure = result.failed.find((entry) => entry.documentId === documentId);
    if (failure) throw new Error(failure.message);
  }

  /**
   * Produces a one-use, in-memory confirmation capability after read-only local
   * and exact-document Drive inspection. The opaque repository proof never
   * enters React state or persistent storage.
   */
  async previewTargetedPaperPurge(
    documentId: string,
  ): Promise<TargetedPaperPurgePreview> {
    await this.initialize();
    if (this.requireProfile().deviceMode !== 'personal') {
      throw new Error('Targeted purge is disabled on Public / temporary devices.');
    }
    const blocking = this.blockingPaperIssues.get(documentId);
    const checkpoint = this.paperStates.get(documentId)?.targetedPurge;
    const diagnosticEvidence = this.targetedPaperPurgeDiagnosticEvidence();
    const diagnosticEvidenceMatches = diagnosticEvidence?.documentId === documentId;
    if (
      !isTargetedPaperPurgeCandidate(blocking?.issue) &&
      !checkpoint &&
      !diagnosticEvidenceMatches
    ) {
      throw new Error(
        'Targeted purge is available only for the exact blocked paper-presence failure.',
      );
    }

    let signal: AbortSignal | undefined;
    try {
      signal = await this.beginOperation('scan');
      const repository = await this.ensureRepository(signal, false);
      const profile = this.requireProfile();
      const accountId = this.activeDriveOperationIdentityFence?.accountId;
      if (!accountId || !profile.rootFolderId) {
        throw new WorkspaceAccountIdentityUnavailableError();
      }
      const [inspection, local] = await Promise.all([
        repository.inspectTargetedPaperPurge(documentId, signal),
        this.local.inspectPaperPurgeRecords(documentId, {
          syncStateRecord: this.paperStates.has(documentId),
          cloudCatalogRecord: this.view.papers.some(
            (paper) => paper.documentId === documentId,
          ),
        }),
      ]);
      const displayName =
        inspection.displayName ??
        this.view.papers.find((paper) => paper.documentId === documentId)
          ?.displayName ??
        this.paperStates.get(documentId)?.displayName ??
        'Unavailable paper';
      const preview: TargetedPaperPurgePreview = {
        eligible: inspection.eligible && Boolean(inspection.proof),
        documentId,
        displayName,
        local,
        cloud: {
          paperFolderCount: inspection.paperFolderCount,
          paperFileCount: inspection.paperFileCount,
          validPresenceCount: inspection.validPresenceCount,
          corruptPresenceCount: inspection.corruptPresenceCount,
          ...(inspection.presenceState
            ? { presenceState: inspection.presenceState }
            : {}),
          presenceHeadCount: inspection.presenceHeadCount,
          preservedPresenceCount: inspection.preservedPresenceCount,
          ...(inspection.ancestryDiagnostic
            ? { ancestryDiagnostic: inspection.ancestryDiagnostic }
            : {}),
        },
        preserved: {
          collectionRecords: true,
          sharedRootAndControl: true,
          unrelatedPapers: true,
          removedPresenceTombstone: true,
        },
        ...(inspection.blocker ? { blocker: { ...inspection.blocker } } : {}),
      };
      this.expireTargetedPaperPurgePreviews();
      if (preview.eligible && inspection.proof) {
        const previewToken = crypto.randomUUID();
        preview.previewToken = previewToken;
        this.targetedPaperPurgePreviews.set(previewToken, {
          documentId,
          proof: inspection.proof,
          ...(isTargetedPaperPurgeCandidate(blocking?.issue)
            ? {
                blockingIssueFingerprint: paperBlockingIssueFingerprint(blocking),
              }
            : {}),
          ...(diagnosticEvidenceMatches
            ? {
                diagnosticEvidenceFingerprint: diagnosticEvidence.fingerprint,
              }
            : {}),
          ...(checkpoint ? { checkpointFingerprint: JSON.stringify(checkpoint) } : {}),
          localFingerprint: JSON.stringify(local),
          accountId,
          rootFolderId: repository.rootFolderId,
          createdAt: Date.now(),
        });
      }
      return preview;
    } finally {
      if (signal) this.endOperation(signal);
    }
  }

  /**
   * Consumes a frozen preview exactly once. Cloud commit is anti-resurrection
   * first; local cleanup follows only after the tombstone and Drive Trash state
   * are verified. Every partial state is therefore safe to preview and retry.
   */
  executeTargetedPaperPurge(previewToken: string): Promise<TargetedPaperPurgeResult> {
    this.expireTargetedPaperPurgePreviews();
    const pending = this.targetedPaperPurgePreviews.get(previewToken);
    this.targetedPaperPurgePreviews.delete(previewToken);
    if (!pending) {
      return Promise.reject(
        new Error('The targeted purge preview expired. Preview the paper again.'),
      );
    }
    return this.retainPaperOperation('remove', [pending.documentId], async () => {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error('Targeted purge is disabled on Public / temporary devices.');
      }
      let signal: AbortSignal | undefined;
      try {
        signal = await this.beginOperation('remove');
        const repository = await this.ensureRepository(signal, false);
        const accountId = this.activeDriveOperationIdentityFence?.accountId;
        const blocking = this.blockingPaperIssues.get(pending.documentId);
        const stateCheckpoint = this.paperStates.get(pending.documentId)?.targetedPurge;
        const diagnosticEvidence = this.targetedPaperPurgeDiagnosticEvidence();
        const blockingMatches = Boolean(
          pending.blockingIssueFingerprint &&
          isTargetedPaperPurgeCandidate(blocking?.issue) &&
          paperBlockingIssueFingerprint(blocking) === pending.blockingIssueFingerprint,
        );
        const checkpointMatches = Boolean(
          pending.checkpointFingerprint &&
          stateCheckpoint &&
          JSON.stringify(stateCheckpoint) === pending.checkpointFingerprint,
        );
        const diagnosticEvidenceMatches = Boolean(
          pending.diagnosticEvidenceFingerprint &&
          diagnosticEvidence?.documentId === pending.documentId &&
          diagnosticEvidence.fingerprint === pending.diagnosticEvidenceFingerprint,
        );
        if (
          !accountId ||
          accountId !== pending.accountId ||
          repository.rootFolderId !== pending.rootFolderId ||
          (!blockingMatches && !checkpointMatches && !diagnosticEvidenceMatches)
        ) {
          throw new Error(
            'The paper, account, root, or blocking issue changed after preview. Nothing was removed.',
          );
        }
        const currentLocal = await this.local.inspectPaperPurgeRecords(
          pending.documentId,
          {
            syncStateRecord: this.paperStates.has(pending.documentId),
            cloudCatalogRecord: this.view.papers.some(
              (paper) => paper.documentId === pending.documentId,
            ),
          },
        );
        if (JSON.stringify(currentLocal) !== pending.localFingerprint) {
          throw new Error(
            'The local paper records changed after preview. Nothing was removed.',
          );
        }

        const workspaceLease = this.requireWorkspaceLease(signal);
        const state =
          this.paperStates.get(pending.documentId) ??
          createDefaultPaperSyncState(
            pending.documentId,
            this.requireProfile().deviceId,
            'cloud-only',
          );
        const existingCheckpoint = state.targetedPurge;
        if (
          existingCheckpoint &&
          (existingCheckpoint.accountId !== accountId ||
            existingCheckpoint.rootFolderId !== pending.rootFolderId ||
            existingCheckpoint.paperFolderId !== pending.proof.paperFolderId)
        ) {
          throw new Error(
            'The durable targeted purge identity no longer matches the verified paper. Nothing was removed.',
          );
        }
        state.targetedPurge = existingCheckpoint ?? {
          version: 1,
          operationId: crypto.randomUUID(),
          phase: 'cloud-cleanup-pending',
          confirmedAt: Date.now(),
          accountId,
          rootFolderId: pending.rootFolderId,
          paperFolderId: pending.proof.paperFolderId,
        };
        state.status = 'needs-attention';
        await savePaperSyncState(state, workspaceLease);
        this.paperStates.set(pending.documentId, state);
        this.refreshStateView();

        this.updateView({
          connection: 'syncing',
          progress: {
            phase: 'publishing',
            completed: 0,
            total: 1,
            detail: 'Purging one verified paper',
          },
          error: undefined,
          issue: undefined,
        });
        const result = await repository.executeTargetedPaperPurge(
          pending.proof,
          this.writer(),
          signal,
        );
        if (result.cleanupPending) {
          const retainedIssue = this.blockingPaperIssues.get(pending.documentId)?.issue;
          this.updateView({
            connection: this.connectionAfterPaperSettlement(retainedIssue),
            progress: { phase: 'idle' },
            issue: retainedIssue,
            error:
              result.cleanupError ??
              'The removal tombstone is safe, but Drive cleanup needs another verified attempt.',
          });
          return {
            documentId: pending.documentId,
            status: 'cleanup-pending',
            corruptPresenceFilesTrashed: result.corruptPresenceFilesTrashed,
            ...(result.cleanupError ? { message: result.cleanupError } : {}),
          };
        }

        state.targetedPurge = {
          ...state.targetedPurge,
          phase: 'local-cleanup-pending',
        };
        await savePaperSyncState(state, workspaceLease);
        await this.local.ensurePaperAbsent(pending.documentId, signal, workspaceLease);
        await deletePaperSyncRecords([pending.documentId], workspaceLease);
        this.paperStates.delete(pending.documentId);
        this.blockingPaperIssues.delete(pending.documentId);
        this.paperRetryIntents.delete(pending.documentId);
        const catalog = this.view.papers.filter(
          (paper) => paper.documentId !== pending.documentId,
        );
        this.refreshStateView(catalog);
        const nextIssue = this.firstBlockingPaperIssue();
        this.updateView(
          {
            connection: this.connectionAfterPaperSettlement(nextIssue),
            progress: { phase: 'idle' },
            issue: nextIssue,
            error: nextIssue?.message,
          },
          { actualWork: true },
        );
        return {
          documentId: pending.documentId,
          status: 'complete',
          corruptPresenceFilesTrashed: result.corruptPresenceFilesTrashed,
        };
      } catch (error) {
        const retainedIssue = this.firstBlockingPaperIssue();
        this.updateView({
          connection: this.connectionAfterPaperSettlement(retainedIssue),
          progress: { phase: 'idle' },
          issue: retainedIssue,
          error:
            retainedIssue?.message ??
            (error instanceof Error ? error.message : 'Targeted purge stopped safely.'),
        });
        throw error;
      } finally {
        if (signal) this.endOperation(signal);
      }
    });
  }

  removeFromGoogleDriveSelected(
    documentIds: readonly string[],
    onProgress?: (progress: PaperBulkRemovalProgress) => void,
  ): Promise<PaperBulkRemovalResult> {
    const ids = [...new Set(documentIds)].sort();
    return this.retainPaperOperation('remove', ids, async () => {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error('Drive removal is disabled on Public / temporary devices.');
      }
      const outcome: PaperBulkRemovalResult = {
        removed: [],
        alreadyRemoved: [],
        cleanupPending: [],
        failed: [],
      };
      if (!ids.length) return outcome;

      const signal = await this.beginOperation('remove');
      let actualWork = false;
      const settledCloud: PaperCloudSummary[] = [];
      const failureIssues: SyncOperationalIssue[] = [];
      try {
        const repository = await this.ensureRepository(signal, false);
        this.updateView({
          connection: 'syncing',
          progress: {
            phase: 'publishing',
            completed: 0,
            total: ids.length,
            detail: 'Removing papers from Drive',
          },
          error: undefined,
          issue: undefined,
        });
        onProgress?.({ completed: 0, total: ids.length });

        const settlements = await settleIndependentOperations(
          ids,
          PAPER_TRANSFER_CONCURRENCY,
          (documentId) =>
            this.paperFlights.run(`remove:${documentId}`, async () => {
              const summary = this.view.papers.find(
                (candidate) => candidate.documentId === documentId,
              );
              if (
                this.isPaperQuarantined(documentId) ||
                this.paperStates.get(documentId)?.targetedPurge ||
                !summary ||
                summary.issue ||
                summary.status === 'needs-attention'
              ) {
                throw new PaperRepositoryError(
                  'paper-presence-invalid',
                  'The exact Drive paper could not be verified for removal.',
                );
              }
              const wasAlreadyRemoved = summary.presenceState === 'removed';
              const result = await repository.removePaperFromDrive(
                summary,
                this.writer(),
                signal,
              );
              const existingState = this.paperStates.get(documentId);
              const previousPaperState = existingState?.status;
              const clearedIssue = this.blockingPaperIssues.get(documentId)?.issue;
              const hasLocalCopy = Boolean(
                existingState &&
                existingState.availability !== 'cloud-only' &&
                !existingState.locallyDeleted,
              );
              if (hasLocalCopy) {
                const state =
                  existingState ??
                  createDefaultPaperSyncState(
                    documentId,
                    this.requireProfile().deviceId,
                    'local-only',
                  );
                state.displayName = summary.displayName;
                state.availability = 'local-only';
                state.status = 'local-only';
                state.cloudPresence = 'removed';
                state.presenceHeadIds = [...(result.cloud.presenceHeadIds ?? [])];
                state.cloudCleanupPending = result.cleanupPending;
                state.remoteHeadIds = [];
                delete state.dismissedRemoteHeadIds;
                state.driveFiles.paperFolderId = result.cloud.paperFolderId;
                await savePaperSyncState(state, this.requireWorkspaceLease(signal));
                this.paperStates.set(documentId, state);
                this.drive?.recordOperationStateTransition?.({
                  phase: 'paper-removal-local-settlement',
                  transition: 'paper-state-updated',
                  documentId,
                  ...(previousPaperState ? { previousPaperState } : {}),
                  nextPaperState: state.status,
                  presenceState: 'removed',
                  outcome: 'succeeded',
                });
              } else {
                this.paperStates.delete(documentId);
                await deletePaperSyncRecords(
                  [documentId],
                  this.requireWorkspaceLease(signal),
                );
                this.drive?.recordOperationStateTransition?.({
                  phase: 'paper-removal-local-settlement',
                  transition: 'paper-state-updated',
                  documentId,
                  ...(previousPaperState ? { previousPaperState } : {}),
                  presenceState: 'removed',
                  outcome: 'succeeded',
                  classification: 'cloud-only-local-record-removed',
                });
              }
              this.blockingPaperIssues.delete(documentId);
              if (result.cleanupPending) {
                this.paperRetryIntents.set(documentId, 'remove-cleanup');
              } else {
                this.paperRetryIntents.delete(documentId);
              }
              if (clearedIssue) {
                this.drive?.recordOperationStateTransition?.({
                  phase: 'paper-removal-local-settlement',
                  transition: 'paper-issue-cleared',
                  documentId,
                  issueCode: clearedIssue.code,
                  presenceState: 'removed',
                  outcome: 'succeeded',
                });
              }
              settledCloud.push(result.cloud);
              if (wasAlreadyRemoved) outcome.alreadyRemoved.push(documentId);
              else outcome.removed.push(documentId);
              if (result.cleanupPending) {
                outcome.cleanupPending.push({
                  documentId,
                  ...(result.cleanupError ? { message: result.cleanupError } : {}),
                });
              }
              actualWork ||= !wasAlreadyRemoved || summary.cleanupPending === true;
            }),
          (completed, total) => {
            const progress = { completed, total };
            onProgress?.(progress);
            this.updateView({
              progress: {
                phase: 'publishing',
                ...progress,
                detail: 'Removing papers from Drive',
              },
            });
          },
        );
        for (const settlement of settlements) {
          if (settlement.status === 'fulfilled') continue;
          const issue = await this.markPaperFailure(
            settlement.input,
            settlement.error,
            this.requireWorkspaceLease(signal),
          );
          failureIssues.push(issue);
          outcome.failed.push({
            documentId: settlement.input,
            message: issue.message,
          });
        }

        if (settledCloud.length) {
          await this.applyTransferCatalog(
            settledCloud,
            this.requireWorkspaceLease(signal),
          );
        }
        const profile = this.requireProfile();
        if (outcome.removed.length || outcome.alreadyRemoved.length) {
          profile.lastSuccessfulAt = Date.now();
          await savePaperSyncDeviceProfile(
            profile,
            {},
            this.requireWorkspaceLease(signal),
          );
        }
        const primaryIssue =
          failureIssues.find((issue) => issue.blocksOrdinarySync) ??
          failureIssues[0] ??
          this.firstBlockingPaperIssue();
        this.updateView(
          {
            connection: this.connectionAfterPaperSettlement(primaryIssue),
            lastSuccessfulAt: profile.lastSuccessfulAt,
            progress: { phase: 'idle' },
            issue: primaryIssue,
            error: primaryIssue?.message,
          },
          { actualWork },
        );
        outcome.removed.sort();
        outcome.alreadyRemoved.sort();
        outcome.cleanupPending.sort((first, second) =>
          first.documentId.localeCompare(second.documentId),
        );
        outcome.failed.sort((first, second) =>
          first.documentId.localeCompare(second.documentId),
        );
        return outcome;
      } catch (error) {
        this.applyError(error);
        throw error;
      } finally {
        this.endOperation(signal);
      }
    });
  }

  restoreToGoogleDrive(
    documentId: string,
  ): Promise<'fast-untrash' | 'fallback-rebuild'> {
    const capturedLocalRemovalEpoch = this.localRemovalEpoch(documentId);
    return this.retainPaperOperation('restore', [documentId], async () => {
      await this.initialize();
      const profile = this.requireProfile();
      if (profile.deviceMode !== 'personal') {
        throw new Error('Drive restore is disabled on Public / temporary devices.');
      }
      await this.flushPersistenceChanges();
      const state = this.paperStates.get(documentId);
      if (
        !state ||
        this.isPaperQuarantined(documentId) ||
        state.targetedPurge ||
        state.cloudPresence !== 'removed' ||
        state.locallyDeleted
      ) {
        throw new Error(
          'Only a locally retained paper removed from Drive can be restored.',
        );
      }
      const signal = await this.beginOperation('restore');
      try {
        const repository = await this.ensureRepository(signal, false);
        this.updateView({
          connection: 'syncing',
          progress: { phase: 'uploading', completed: 0, total: 1 },
          error: undefined,
          issue: undefined,
        });
        const capturedGeneration = state.dirtyGeneration;
        const preRestoreStatus = state.status;
        state.status = 'uploading';
        this.drive?.recordOperationStateTransition?.({
          phase: 'paper-restore-local-settlement',
          transition: 'paper-state-updated',
          documentId,
          previousPaperState: preRestoreStatus,
          nextPaperState: state.status,
          presenceState: 'removed',
          outcome: 'started',
        });
        await savePaperSyncState(state, this.requireWorkspaceLease(signal));
        this.refreshStateView();
        const local = await this.local.createPaperPackage(
          documentId,
          state,
          this.writer(),
        );
        if (
          await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
        ) {
          throw new DOMException(
            'Restore was superseded by local paper removal.',
            'AbortError',
          );
        }
        const result = await repository.restorePaper(local, state, signal, (progress) =>
          this.applyPaperProgress(progress, 0, 1),
        );
        if (
          await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
        ) {
          this.drive?.recordOperationStateTransition?.({
            phase: 'paper-restore-local-settlement',
            transition: 'stale-local-snapshot-discarded',
            documentId,
            outcome: 'deferred',
            classification: 'intentional-local-removal',
          });
          return result.restoreMode;
        }
        this.applyPublishResult(state, result, capturedGeneration);
        this.drive?.recordOperationStateTransition?.({
          phase: 'paper-restore-local-settlement',
          transition: 'paper-state-updated',
          documentId,
          previousPaperState: 'uploading',
          nextPaperState: state.status,
          presenceState: 'present',
          outcome: 'succeeded',
        });
        delete state.dismissedRemoteHeadIds;
        const clearedIssue = this.blockingPaperIssues.get(documentId)?.issue;
        this.blockingPaperIssues.delete(documentId);
        this.paperRetryIntents.delete(documentId);
        if (clearedIssue) {
          this.drive?.recordOperationStateTransition?.({
            phase: 'paper-restore-local-settlement',
            transition: 'paper-issue-cleared',
            documentId,
            issueCode: clearedIssue.code,
            presenceState: 'present',
            outcome: 'succeeded',
          });
        }
        await savePaperSyncState(state, this.requireWorkspaceLease(signal));
        this.paperStates.set(documentId, state);
        await this.applyTransferCatalog(
          [result.cloud],
          this.requireWorkspaceLease(signal),
        );
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(
          profile,
          {},
          this.requireWorkspaceLease(signal),
        );
        this.updateView(
          {
            connection: 'connected',
            lastSuccessfulAt: profile.lastSuccessfulAt,
            progress: { phase: 'idle' },
            error: undefined,
            issue: this.firstBlockingPaperIssue(),
          },
          { actualWork: true },
        );
        return result.restoreMode;
      } catch (error) {
        if (
          await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
        ) {
          this.drive?.recordOperationStateTransition?.({
            phase: 'paper-restore-local-settlement',
            transition: 'operation-retry-classified',
            documentId,
            outcome: 'deferred',
            classification: 'intentional-local-removal-superseded-restore',
          });
          throw error;
        }
        const failedStatus = state.status;
        const issue = classifyPaperCoordinatorError(error);
        state.status = 'local-only';
        state.cloudPresence = 'removed';
        this.drive?.recordOperationStateTransition?.({
          phase: 'paper-restore-local-settlement',
          transition: 'paper-state-updated',
          documentId,
          previousPaperState: failedStatus,
          nextPaperState: state.status,
          issueCode: issue.code,
          presenceState: 'removed',
          outcome: 'failed',
        });
        this.drive?.recordOperationStateTransition?.({
          phase: 'paper-restore-local-settlement',
          transition: 'operation-issue-observed',
          documentId,
          issueCode: issue.code,
          presenceState: 'removed',
          outcome: 'failed',
          classification: issue.blocksOrdinarySync
            ? 'blocking-operation-issue'
            : 'transient-operation-issue',
        });
        await savePaperSyncState(state, this.requireWorkspaceLease(signal)).catch(
          () => undefined,
        );
        this.refreshStateView();
        this.applyError(error);
        throw error;
      } finally {
        this.endOperation(signal);
      }
    });
  }

  keepLocalSelected(documentIds: readonly string[]): Promise<void> {
    const requestedIds = [...new Set(documentIds)].sort();
    const capturedLocalRemovalEpochs = new Map(
      requestedIds.map((documentId) => [
        documentId,
        this.localRemovalEpoch(documentId),
      ]),
    );
    return this.retainPaperOperation('keep-local', requestedIds, async () => {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error(
          'Replacing a Drive paper is disabled on Public / temporary devices.',
        );
      }
      await this.flushPersistenceChanges();
      const ids = requestedIds.filter((documentId) => {
        const state = this.paperStates.get(documentId);
        return Boolean(
          state &&
          !this.isPaperQuarantined(documentId) &&
          state.targetedPurge === undefined &&
          state.availability !== 'cloud-only' &&
          state.cloudPresence === 'present' &&
          (state.status === 'remote-update-available' ||
            state.status === 'both-changed'),
        );
      });
      if (!ids.length) {
        const supersededByLocalRemoval = await Promise.all(
          requestedIds.map((documentId) =>
            this.staleBecauseLocalRemoval(
              documentId,
              capturedLocalRemovalEpochs.get(documentId) ??
                this.localRemovalEpoch(documentId),
            ),
          ),
        );
        if (supersededByLocalRemoval.some(Boolean)) return;
        throw new Error('Select a local paper with a verified Drive update.');
      }

      const signal = await this.beginOperation('keep-local');
      const settledCloud: PaperCloudSummary[] = [];
      const failures: Array<{
        documentId: string;
        error: unknown;
        issue: SyncOperationalIssue;
      }> = [];
      let completed = 0;
      try {
        const repository = await this.ensureRepository(signal, false);
        this.updateView({
          connection: 'syncing',
          progress: { phase: 'uploading', completed: 0, total: ids.length },
          error: undefined,
          issue: undefined,
        });
        await mapWithConcurrency(
          ids,
          PAPER_TRANSFER_CONCURRENCY,
          async (documentId) => {
            const capturedLocalRemovalEpoch =
              capturedLocalRemovalEpochs.get(documentId) ??
              this.localRemovalEpoch(documentId);
            try {
              await this.paperFlights.run(`keep-local:${documentId}`, async () => {
                if (
                  await this.staleBecauseLocalRemoval(
                    documentId,
                    capturedLocalRemovalEpoch,
                  )
                ) {
                  return;
                }
                const state = this.paperStates.get(documentId);
                if (!state || state.availability === 'cloud-only') {
                  throw new Error('The selected paper has no local editable copy.');
                }
                const capturedGeneration = state.dirtyGeneration;
                const preKeepLocalStatus = state.status;
                state.status = 'uploading';
                this.drive?.recordOperationStateTransition?.({
                  phase: 'keep-local-local-state',
                  transition: 'paper-state-updated',
                  documentId,
                  previousPaperState: preKeepLocalStatus,
                  nextPaperState: state.status,
                  presenceState: 'present',
                  outcome: 'started',
                });
                await savePaperSyncState(state, this.requireWorkspaceLease(signal));
                this.refreshStateView();
                const local = await this.local.createPaperPackage(
                  documentId,
                  state,
                  this.writer(),
                );
                assertPdfOnlyLocalPublication(local);
                if (
                  await this.staleBecauseLocalRemoval(
                    documentId,
                    capturedLocalRemovalEpoch,
                  )
                ) {
                  return;
                }
                const result = await repository.reconcileKeepLocalPaper(
                  local,
                  state,
                  signal,
                  (progress) =>
                    this.applyPaperProgress(progress, completed, ids.length),
                );
                if (
                  await this.staleBecauseLocalRemoval(
                    documentId,
                    capturedLocalRemovalEpoch,
                  )
                ) {
                  this.drive?.recordOperationStateTransition?.({
                    phase: 'keep-local-local-state',
                    transition: 'stale-local-snapshot-discarded',
                    documentId,
                    outcome: 'deferred',
                    classification: 'intentional-local-removal',
                  });
                  return;
                }
                this.applyPublishResult(state, result, capturedGeneration);
                this.drive?.recordOperationStateTransition?.({
                  phase: 'keep-local-local-state',
                  transition: 'paper-state-updated',
                  documentId,
                  previousPaperState: 'uploading',
                  nextPaperState: state.status,
                  presenceState: 'present',
                  outcome: 'succeeded',
                });
                delete state.dismissedRemoteHeadIds;
                await savePaperSyncState(state, this.requireWorkspaceLease(signal));
                this.paperStates.set(documentId, state);
                this.blockingPaperIssues.delete(documentId);
                this.paperRetryIntents.delete(documentId);
                settledCloud.push(result.cloud);
              });
            } catch (error) {
              if (
                await this.staleBecauseLocalRemoval(
                  documentId,
                  capturedLocalRemovalEpoch,
                )
              ) {
                this.drive?.recordOperationStateTransition?.({
                  phase: 'keep-local-local-state',
                  transition: 'operation-retry-classified',
                  documentId,
                  outcome: 'deferred',
                  classification: 'intentional-local-removal-superseded-keep-local',
                });
                return;
              }
              failures.push({
                documentId,
                error,
                issue: await this.markPaperFailure(
                  documentId,
                  error,
                  this.requireWorkspaceLease(signal),
                ),
              });
            } finally {
              completed += 1;
              this.updateView({
                progress: { phase: 'uploading', completed, total: ids.length },
              });
            }
          },
        );
        if (settledCloud.length) {
          await this.applyTransferCatalog(
            settledCloud,
            this.requireWorkspaceLease(signal),
          );
        }
        const profile = this.requireProfile();
        if (settledCloud.length) {
          profile.lastSuccessfulAt = Date.now();
          await savePaperSyncDeviceProfile(
            profile,
            {},
            this.requireWorkspaceLease(signal),
          );
        }
        const primaryIssue =
          failures.find((failure) => failure.issue.blocksOrdinarySync)?.issue ??
          failures[0]?.issue ??
          this.firstBlockingPaperIssue();
        this.updateView(
          {
            connection: this.connectionAfterPaperSettlement(primaryIssue),
            lastSuccessfulAt: profile.lastSuccessfulAt,
            progress: { phase: 'idle' },
            issue: primaryIssue,
            error: primaryIssue?.message,
          },
          { actualWork: settledCloud.length > 0 },
        );
        if (failures.length) throw failures[0].error;
      } catch (error) {
        if (!failures.some((failure) => failure.error === error)) {
          this.applyError(error);
        }
        throw error;
      } finally {
        this.endOperation(signal);
      }
    });
  }

  async dismissRemoteUpdates(): Promise<void> {
    try {
      await this.runWorkspaceMutation(async (workspaceLease) => {
        const reminder = this.view.reminder;
        if (!reminder) return;
        const changed: Array<{
          state: PaperSyncState;
          previous: string[] | undefined;
        }> = [];
        for (const documentId of reminder.paperIds) {
          const paper = this.view.papers.find(
            (candidate) => candidate.documentId === documentId,
          );
          const state = this.paperStates.get(documentId);
          if (
            !paper ||
            !state ||
            (state.status !== 'remote-update-available' &&
              state.status !== 'both-changed')
          ) {
            continue;
          }
          changed.push({
            state,
            previous: state.dismissedRemoteHeadIds
              ? [...state.dismissedRemoteHeadIds]
              : undefined,
          });
          state.dismissedRemoteHeadIds = [...paper.headIds].sort();
        }
        if (!changed.length) return;
        try {
          await savePaperSyncStates(
            changed.map(({ state }) => state),
            workspaceLease,
          );
          this.updateReminder(this.view.papers);
        } catch (error) {
          for (const { state, previous } of changed) {
            if (previous) state.dismissedRemoteHeadIds = previous;
            else delete state.dismissedRemoteHeadIds;
          }
          throw error;
        }
      });
    } catch (error) {
      this.updateView({ error: userMessage(error) });
      throw error;
    }
  }

  upgradePaperSyncProtocolToV3(): Promise<void> {
    this.protocolMigrationPromise ??= this.upgradePaperSyncProtocolToV3Owned().finally(
      () => {
        this.protocolMigrationPromise = null;
      },
    );
    return this.protocolMigrationPromise;
  }

  private async upgradePaperSyncProtocolToV3Owned(): Promise<void> {
    let signal: AbortSignal | undefined;
    let phase: LayoutMigrationFailurePhase = 'detect-layout';
    try {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error(
          'Drive protocol upgrade is available only on a Personal device.',
        );
      }
      signal = await this.beginOperation('migration');
      const repository = await this.ensureRepository(signal, false);
      const inspection = await repository.detectLayout(signal);
      if (inspection.state === 'paper-v3') {
        await this.runPostMigrationFullAudit(
          signal,
          this.requireWorkspaceLease(signal),
        );
        this.updateView({
          connection: 'connected',
          layoutUpgradeKind: undefined,
          progress: { phase: 'idle' },
          error: undefined,
          issue: undefined,
        });
        return;
      }
      if (inspection.state !== 'protocol-upgrade-required') {
        throw new PaperRepositoryError(
          inspection.state === 'unsupported-layout' ||
            inspection.state === 'unsupported-protocol'
            ? inspection.state
            : 'layout-migration-proof-invalid',
          'The selected Drive root cannot be upgraded from sync protocol 2.',
        );
      }
      this.updateView({
        connection: 'syncing',
        layoutUpgradeKind: 'protocol-2-to-3',
        progress: {
          phase: 'resetting',
          detail: 'Verifying protocol-2 Drive history',
        },
        error: undefined,
        issue: undefined,
      });
      phase = 'verify-publications';
      await repository.upgradePaperSyncProtocol(this.writer(), signal);
      phase = 'post-migration-scan';
      await this.runPostMigrationFullAudit(signal, this.requireWorkspaceLease(signal));
      const profile = this.requireProfile();
      profile.lastSuccessfulAt = Date.now();
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.updateView(
        {
          connection: 'connected',
          layoutUpgradeKind: undefined,
          lastSuccessfulAt: profile.lastSuccessfulAt,
          progress: { phase: 'idle' },
          error: undefined,
          issue: undefined,
        },
        { actualWork: true },
      );
    } catch (error) {
      const classified = classifyPaperCoordinatorError(error);
      const failure = createLayoutMigrationFailure(
        phase,
        error instanceof PaperRepositoryError ? error.code : classified.code,
        undefined,
        {
          recommendedAction:
            classified.code === 'google-authorization-required'
              ? 'reconnect'
              : 'retry-layout-upgrade',
          retrySafe: classified.code !== 'local-persistence-failed',
        },
      );
      const issue = createLayoutMigrationIssue(failure);
      this.updateView({
        connection: 'migration-incomplete',
        layoutUpgradeKind: 'protocol-2-to-3',
        progress: { phase: 'idle' },
        error: issue.message,
        issue,
      });
      throw new LayoutMigrationFailedError(failure);
    } finally {
      if (signal) this.endOperation(signal);
    }
  }

  upgradeDriveSyncToV3(): Promise<void> {
    this.v3MigrationPromise ??= this.upgradeDriveSyncToV3Owned().finally(() => {
      this.v3MigrationPromise = null;
    });
    return this.v3MigrationPromise;
  }

  private async upgradeDriveSyncToV3Owned(): Promise<void> {
    let signal: AbortSignal | undefined;
    let record: PaperV3MigrationRecord | null = null;
    let phase: LayoutMigrationFailurePhase = 'detect-layout';
    try {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error('Drive layout upgrade is available only on a Personal device.');
      }
      signal = await this.beginOperation('migration');
      const repository = await this.ensureRepository(signal, false);
      record = await loadPaperV3MigrationRecord();
      const inspection = await repository.detectLayout(signal);
      if (record && record.rootFolderId !== repository.rootFolderId) {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The Paper-v3 migration checkpoint belongs to another Drive root.',
        );
      }

      if (inspection.state === 'paper-v3' && !record) {
        await this.runPostMigrationFullAudit(
          signal,
          this.requireWorkspaceLease(signal),
        );
        this.updateView({
          connection: 'connected',
          layoutUpgradeKind: undefined,
          progress: { phase: 'idle' },
          error: undefined,
          issue: undefined,
        });
        return;
      }
      if (
        inspection.state !== 'paper-v2-upgrade-required' &&
        inspection.state !== 'migration-incomplete' &&
        !(
          (inspection.state === 'paper-v3' ||
            inspection.state === 'protocol-upgrade-required') &&
          record?.phase === 'activating-layout'
        )
      ) {
        throw new PaperRepositoryError(
          inspection.state === 'unsupported-layout' ||
            inspection.state === 'unsupported-protocol'
            ? inspection.state
            : 'layout-migration-proof-invalid',
          'The selected Drive root cannot be upgraded from Paper-v2.',
        );
      }

      this.updateView({
        connection: 'syncing',
        layoutUpgradeKind: 'v2-to-v3',
        progress: { phase: 'resetting', detail: 'Preparing Drive sync upgrade' },
        error: undefined,
        issue: undefined,
      });

      if (
        inspection.state !== 'paper-v3' &&
        inspection.state !== 'protocol-upgrade-required'
      ) {
        phase = 'verify-publications';
        const preparation = await repository.prepareV3Migration(
          [...this.paperStates.values()],
          signal,
        );
        const targetDocumentIds = preparation.papers
          .map((paper) => paper.documentId)
          .sort();
        if (record) {
          if (
            record.controlFolderId !== preparation.controlFolderId ||
            !sameIdentitySet(record.targetDocumentIds, targetDocumentIds)
          ) {
            throw new PaperRepositoryError(
              'layout-migration-proof-invalid',
              'Drive papers changed after the Paper-v3 upgrade was checkpointed.',
            );
          }
        } else {
          record = {
            id: 'paper-v3',
            formatVersion: 1,
            rootFolderId: repository.rootFolderId,
            phase: 'seeding-presence',
            startedAt: Date.now(),
            controlFolderId: preparation.controlFolderId,
            targetDocumentIds,
            seeds: {},
          };
          phase = 'save-migration-record';
          await savePaperV3MigrationRecord(record, this.requireWorkspaceLease(signal));
        }

        if (!record.controlFolderId) {
          throw new PaperRepositoryError(
            'layout-migration-proof-invalid',
            'The Paper-v3 control-area checkpoint is incomplete.',
          );
        }
        const controlFolderId = record.controlFolderId;
        record = { ...record, phase: 'seeding-presence' };
        const paperById = new Map(
          preparation.papers.map((paper) => [paper.documentId, paper] as const),
        );
        let completed = 0;
        for (const documentId of record.targetDocumentIds) {
          const paper = paperById.get(documentId);
          if (!paper) {
            throw new PaperRepositoryError(
              'layout-migration-proof-invalid',
              'A migration paper disappeared during the controlled cutover.',
            );
          }
          phase = 'publish-paper';
          const seed = await repository.seedV3MigrationPresence(
            controlFolderId,
            paper,
            this.writer(),
            signal,
          );
          const checkpoint = record.seeds[documentId];
          if (
            checkpoint &&
            (checkpoint.generationId !== seed.generationId ||
              checkpoint.paperFolderId !== seed.paperFolderId ||
              checkpoint.state !== seed.state ||
              !sameIdentitySet(checkpoint.packageHeadIds, seed.packageHeadIds))
          ) {
            throw new PaperRepositoryError(
              'layout-migration-proof-invalid',
              'A persisted Paper-v3 presence checkpoint no longer matches Drive.',
            );
          }
          record = {
            ...record,
            seeds: {
              ...record.seeds,
              [documentId]: {
                generationId: seed.generationId,
                paperFolderId: seed.paperFolderId,
                state: seed.state,
                packageHeadIds: [...seed.packageHeadIds],
              },
            },
          };
          phase = 'save-migration-record';
          await savePaperV3MigrationRecord(record, this.requireWorkspaceLease(signal));
          completed += 1;
          this.updateView({
            progress: {
              phase: 'resetting',
              completed,
              total: record.targetDocumentIds.length,
              detail: 'Recording paper presence',
            },
          });
        }
        record = { ...record, phase: 'activating-layout' };
        phase = 'save-migration-record';
        await savePaperV3MigrationRecord(record, this.requireWorkspaceLease(signal));
      }

      if (!record?.controlFolderId || record.phase !== 'activating-layout') {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The Paper-v3 activation checkpoint is incomplete.',
        );
      }
      const seeds: PaperV3MigrationSeed[] = record.targetDocumentIds.map(
        (documentId) => {
          const seed = record!.seeds[documentId];
          if (!seed) {
            throw new PaperRepositoryError(
              'layout-migration-proof-invalid',
              'A Paper-v3 presence checkpoint is missing.',
            );
          }
          return { documentId, ...seed };
        },
      );
      phase = 'activate-layout';
      await repository.activateV3Migration(
        record.controlFolderId,
        seeds,
        this.writer(),
        signal,
      );
      phase = 'post-migration-scan';
      await this.runPostMigrationFullAudit(signal, this.requireWorkspaceLease(signal));
      phase = 'clear-migration-record';
      await clearPaperV3MigrationRecord(this.requireWorkspaceLease(signal));
      record = null;
      const profile = this.requireProfile();
      profile.lastSuccessfulAt = Date.now();
      await savePaperSyncDeviceProfile(profile, {}, this.requireWorkspaceLease(signal));
      this.updateView(
        {
          connection: 'connected',
          layoutUpgradeKind: undefined,
          lastSuccessfulAt: profile.lastSuccessfulAt,
          progress: { phase: 'idle' },
          error: undefined,
          issue: undefined,
        },
        { actualWork: true },
      );
    } catch (error) {
      const classified = classifyPaperCoordinatorError(error);
      const failure = createLayoutMigrationFailure(
        phase,
        error instanceof PaperRepositoryError ? error.code : classified.code,
        undefined,
        {
          recommendedAction:
            classified.code === 'google-authorization-required'
              ? 'reconnect'
              : 'retry-layout-upgrade',
          retrySafe: classified.code !== 'local-persistence-failed',
        },
      );
      const issue = createLayoutMigrationIssue(failure);
      this.updateView({
        connection: record ? 'migration-incomplete' : 'attention',
        layoutUpgradeKind: 'v2-to-v3',
        progress: { phase: 'idle' },
        error: issue.message,
        issue,
      });
      throw new LayoutMigrationFailedError(failure);
    } finally {
      if (signal) this.endOperation(signal);
    }
  }

  upgradeDriveLayoutFromThisDevice(): Promise<void> {
    this.layoutMigrationPromise ??=
      this.upgradeDriveLayoutFromThisDeviceOwned().finally(() => {
        this.layoutMigrationPromise = null;
      });
    return this.layoutMigrationPromise;
  }

  private async upgradeDriveLayoutFromThisDeviceOwned(): Promise<void> {
    let phase: LayoutMigrationFailurePhase = 'initialize';
    let activePaper: { documentId: string; paperName: string } | undefined;
    let signal: AbortSignal | undefined;
    let record: LayoutMigrationRecord | null = null;
    try {
      await this.initialize();
      if (this.requireProfile().deviceMode !== 'personal') {
        throw new Error('Drive layout upgrade is available only on a Personal device.');
      }
      phase = 'begin-operation';
      signal = await this.beginOperation('migration');
      phase = 'ensure-repository';
      const repository = await this.ensureRepository(signal, false);
      phase = 'load-migration-record';
      record = await loadLayoutMigrationRecord();
      phase = 'detect-layout';
      const inspection = await repository.detectLayout(signal);
      const recoveringActivatedLayout =
        inspection.state === 'paper-v2-upgrade-required' &&
        record?.phase === 'activating-layout';
      if (
        inspection.state !== 'legacy-upgrade-required' &&
        inspection.state !== 'migration-incomplete' &&
        !recoveringActivatedLayout
      ) {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The selected Drive layout does not match the persisted migration.',
        );
      }
      phase = 'reconcile-local-state';
      await this.reconcileLocalPaperStates(this.requireWorkspaceLease(signal));
      phase = 'list-local-papers';
      const localPapers = (await this.local.listLocalPapers()).sort((first, second) =>
        first.documentId.localeCompare(second.documentId),
      );
      if (!localPapers.length) {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'This device has no authoritative local papers to rebuild from.',
        );
      }
      const localById = new Map(localPapers.map((paper) => [paper.documentId, paper]));
      if (record) {
        if (
          record.rootFolderId !== repository.rootFolderId ||
          !sameIdentitySet(
            record.verifiedLegacyFileIds,
            inspection.legacyManagedFileIds,
          ) ||
          (record.phase !== 'publishing-papers' && record.phase !== 'activating-layout')
        ) {
          throw new PaperRepositoryError(
            'layout-migration-proof-invalid',
            'The persisted Drive layout migration proof no longer matches.',
          );
        }
        if (record.formatVersion !== 2) {
          if (record.publishedDocumentIds.length > 0) {
            throw new PaperRepositoryError(
              'layout-migration-proof-invalid',
              'The legacy migration checkpoint cannot be safely resumed.',
            );
          }
          record = {
            ...record,
            formatVersion: 2,
            targetDocumentIds: localPapers.map(({ documentId }) => documentId),
            publishedGenerationIds: {},
          };
          phase = 'save-migration-record';
          await saveLayoutMigrationRecord(record, this.requireWorkspaceLease(signal));
        }
      } else {
        if (inspection.state !== 'legacy-upgrade-required') {
          throw new PaperRepositoryError(
            'layout-migration-proof-invalid',
            'An incomplete Drive migration has no trusted local checkpoint.',
          );
        }
        record = {
          id: 'layout',
          formatVersion: 2,
          rootFolderId: repository.rootFolderId,
          phase: 'publishing-papers',
          startedAt: Date.now(),
          targetDocumentIds: localPapers.map(({ documentId }) => documentId),
          publishedDocumentIds: [],
          publishedGenerationIds: {},
          verifiedLegacyFileIds: inspection.legacyManagedFileIds,
        };
        phase = 'save-migration-record';
        await saveLayoutMigrationRecord(
          {
            ...record,
          },
          this.requireWorkspaceLease(signal),
        );
      }

      if (
        record.targetDocumentIds.length === 0 ||
        record.targetDocumentIds.some((documentId) => !localById.has(documentId)) ||
        record.publishedDocumentIds.some(
          (documentId) => !record!.targetDocumentIds.includes(documentId),
        )
      ) {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The authoritative local papers no longer match the migration checkpoint.',
        );
      }

      this.updateView({
        connection: 'syncing',
        progress: {
          phase: 'resetting',
          completed: record.publishedDocumentIds.length,
          total: record.targetDocumentIds.length,
          detail: 'Rebuilding paper packages',
        },
        error: undefined,
        issue: undefined,
      });

      if (record.phase === 'publishing-papers') {
        phase = 'publish-paper';
        const migration = await repository.openLayoutMigration(
          migrationProof(record),
          signal,
        );
        for (const documentId of record.targetDocumentIds) {
          const paper = localById.get(documentId)!;
          activePaper = { documentId, paperName: paper.displayName };
          const state =
            this.paperStates.get(documentId) ??
            createDefaultPaperSyncState(documentId, this.requireProfile().deviceId);
          const capturedGeneration = state.dirtyGeneration;
          phase = 'create-paper-package';
          const local = await this.local.createPaperPackage(
            documentId,
            state,
            this.writer(),
          );
          phase = 'publish-paper';
          const result = await migration.publishPaper(local, state, signal);
          this.applyPublishResult(state, result, capturedGeneration);
          phase = 'save-paper-state';
          await savePaperSyncState(state, this.requireWorkspaceLease(signal));
          this.paperStates.set(state.documentId, state);
          record = {
            ...record,
            publishedDocumentIds: [
              ...new Set([...record.publishedDocumentIds, documentId]),
            ].sort(),
            publishedGenerationIds: {
              ...record.publishedGenerationIds,
              [documentId]: result.manifest.generation.id,
            },
            lastFailure: undefined,
          };
          phase = 'save-migration-record';
          await saveLayoutMigrationRecord(record, this.requireWorkspaceLease(signal));
          this.updateView({
            progress: {
              phase: 'resetting',
              completed: record.publishedDocumentIds.length,
              total: record.targetDocumentIds.length,
              detail: paper.displayName,
            },
          });
        }
        activePaper = undefined;
        record = { ...record, phase: 'activating-layout', lastFailure: undefined };
        phase = 'save-migration-record';
        await saveLayoutMigrationRecord(record, this.requireWorkspaceLease(signal));
      }

      if (record.phase !== 'activating-layout') {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The Drive layout migration checkpoint has an unsupported phase.',
        );
      }
      phase = 'verify-publications';
      const activation = await repository.openLayoutMigration(
        migrationProof(record),
        signal,
      );
      await activation.verifyPublishedPapers(signal);
      phase = 'activate-layout';
      await activation.activate(signal);
      phase = 'save-paper-state';
      await this.markMigrationPublicationsIncorporated(
        record,
        this.requireWorkspaceLease(signal),
      );
      phase = 'clear-migration-record';
      await clearLayoutMigrationRecord(this.requireWorkspaceLease(signal));
      record = null;
      this.updateView(
        {
          connection: 'layout-upgrade-required',
          layoutUpgradeKind: 'v2-to-v3',
          progress: { phase: 'idle' },
          error: 'Upgrade this Drive library to the current sync layout.',
          issue: undefined,
        },
        { actualWork: true },
      );
    } catch (error) {
      const classified = classifySyncError(error, {
        online: typeof navigator === 'undefined' || navigator.onLine !== false,
        area: 'sync',
        pendingLocalChanges: this.view.dirtyPaperIds.length > 0,
        hasDeviceSession: this.identity.hasDeviceSession,
      });
      const failure = createLayoutMigrationFailure(
        phase,
        error instanceof PaperRepositoryError ? error.code : classified.code,
        activePaper,
        classified.code === 'local-persistence-failed'
          ? { recommendedAction: 'details', retrySafe: false }
          : classified.code === 'google-authorization-required'
            ? { recommendedAction: 'reconnect', retrySafe: false }
            : { recommendedAction: 'retry-layout-upgrade', retrySafe: true },
      );
      const issue = createLayoutMigrationIssue(failure);
      this.updateView({
        connection: record ? 'migration-incomplete' : 'attention',
        progress: { phase: 'idle' },
        error: issue.message,
        issue: {
          ...issue,
          severity:
            classified.code === 'local-persistence-failed'
              ? 'critical'
              : issue.severity,
        },
      });
      if (record) {
        try {
          if (!signal) throw new Error('Migration operation ownership is unavailable.');
          await saveLayoutMigrationRecord(
            { ...record, lastFailure: failure },
            this.requireWorkspaceLease(signal),
          );
        } catch {
          // The in-memory coordinator state remains authoritative if this write fails.
        }
      }
      throw new LayoutMigrationFailedError(failure);
    } finally {
      if (signal) this.endOperation(signal);
    }
  }

  async finishTemporaryDevice(
    uploadDocumentIds: readonly string[],
    abandonRemaining: boolean,
  ): Promise<void> {
    this.finishPromise ??= this.finishTemporaryDeviceOwned(
      uploadDocumentIds,
      abandonRemaining,
    ).finally(() => {
      this.finishPromise = null;
    });
    return this.finishPromise;
  }

  private async finishTemporaryDeviceOwned(
    uploadDocumentIds: readonly string[],
    abandonRemaining: boolean,
  ): Promise<void> {
    await this.initialize();
    if (this.requireProfile().deviceMode !== 'temporary') {
      throw new Error('Finish on this device is available only in temporary mode.');
    }
    await this.flushPersistenceChanges();
    const selected = uploadDocumentIds.filter((id) =>
      this.getDirtyPaperIds().includes(id),
    );
    if (selected.length) {
      await setTemporaryFinishPhase('uploading');
      await this.uploadSelected(selected);
    }
    try {
      await this.withDriveOperationsQuiesced(
        new DOMException('Temporary workspace is finishing.', 'AbortError'),
        async () => {
          await withWorkspaceIdentityTransition(async (workspaceLease) => {
            await withWorkspaceMutation(async () => {
              // Re-evaluate only after exclusive workspace/identity ownership.
              // No restore or normal writer can introduce data between this
              // decision and the destructive temporary-origin cleanup.
              const remaining = this.getDirtyPaperIds();
              if (remaining.length && !abandonRemaining) {
                throw new TemporaryDirtyWorkError(remaining);
              }
              await setTemporaryFinishPhase('revoking', workspaceLease);
              if (this.identity.hasDeviceSession) {
                await this.identity.disconnectCurrent();
              }
              await cleanupTemporaryOrigin(workspaceLease);
            }, workspaceLease);
          });
          this.temporaryWorkspaceAccountId = undefined;
          this.temporaryWorkspaceId = undefined;
          this.paperStates.clear();
          this.repository = null;
          this.clearDriveOperationDiagnostics();
          this.drive = null;
          this.updateView({
            connection: 'disconnected',
            lastVerifiedDriveAt: undefined,
            deviceMode: 'personal',
            autoSync: true,
            papers: [],
            paperStates: [],
            dirtyPaperIds: [],
            sessions: [],
            reminder: undefined,
            publicDeviceNotice: undefined,
            progress: { phase: 'idle' },
          });
          reloadForWorkspaceChange();
        },
      );
    } catch (error) {
      this.applyError(error);
      throw error;
    }
  }

  cancel(): void {
    this.operationOwner.cancel();
    this.updateView({ progress: { phase: 'idle' } });
  }

  private async initializeOnce(): Promise<void> {
    try {
      const temporaryWorkspaceIdBeforeLoad = getActiveTemporaryWorkspaceId();
      const [profile, states, cachedPapers, temporaryProvenance, restoreOperation] =
        await Promise.all([
          loadPaperSyncDeviceProfile(),
          loadPaperSyncStates(),
          loadCloudPaperCatalog(),
          loadTemporarySessionProvenance(),
          loadDurableRestoreOperation(),
        ]);
      const temporaryWorkspaceIdAfterLoad = getActiveTemporaryWorkspaceId();
      this.profile = profile;
      this.restorePublicationOperation =
        restoreOperation?.phase === 'publication-hold' &&
        restoreOperation.publicationHold &&
        restoreOperation.enginePlan !== undefined &&
        restoreOperation.commitEvidence !== undefined
          ? restoreOperation
          : null;
      if (profile.deviceMode === 'temporary') {
        if (
          !temporaryWorkspaceIdBeforeLoad ||
          temporaryWorkspaceIdAfterLoad !== temporaryWorkspaceIdBeforeLoad ||
          (temporaryProvenance !== null &&
            temporaryProvenance.temporarySessionId !==
              temporaryWorkspaceIdBeforeLoad) ||
          (temporaryProvenance === null && profile.accountId !== undefined)
        ) {
          throw new WorkspaceAccountMismatchError();
        }
        this.temporaryWorkspaceId = temporaryWorkspaceIdBeforeLoad;
        this.temporaryWorkspaceAccountId = temporaryProvenance?.accountId;
      } else {
        this.temporaryWorkspaceId = undefined;
        this.temporaryWorkspaceAccountId = undefined;
      }
      this.paperStates = new Map(states.map((state) => [state.documentId, state]));
      await this.runWorkspaceMutation(async (workspaceLease) => {
        if (profile.deviceMode === 'personal' && !profile.workspaceAccountId) {
          const trustedLegacyAccountId = trustedLegacyWorkspaceAccountId(profile);
          if (trustedLegacyAccountId) {
            await bindPersonalWorkspaceAccount(trustedLegacyAccountId, workspaceLease);
            profile.workspaceAccountId = trustedLegacyAccountId;
          }
        }
        const deviceModeChoiceConfirmed = hasExplicitOrEstablishedDeviceMode(profile);
        if (deviceModeChoiceConfirmed && !profile.deviceModeChoiceConfirmed) {
          const updated: PaperSyncDeviceProfile = {
            ...profile,
            deviceModeChoiceConfirmed: true,
          };
          await savePaperSyncDeviceProfile(updated, {}, workspaceLease);
          Object.assign(profile, updated);
        }
        if (this.restorePublicationOperation) {
          await this.markRestoredPlanDirty(
            this.restorePublicationOperation,
            workspaceLease,
          );
        }
      });
      const deviceModeChoiceConfirmed = hasExplicitOrEstablishedDeviceMode(profile);
      const cleanup = getTemporaryWorkspaceStartupCleanupReport();
      const cleanupFailed =
        cleanup.failedWorkspaceIds.length + cleanup.ambiguousWorkspaceIds.length;
      const cleanupNotice = cleanupFailed
        ? 'An earlier temporary workspace could not be safely cleared. Use a new Private or Incognito window for Public / temporary mode.'
        : cleanup.cleanedWorkspaceIds.length
          ? 'An abandoned temporary workspace was cleared before 39Note opened. Unsynced temporary work may have been lost.'
          : undefined;
      const cachedPaperByDocumentId = new Map(
        cachedPapers.map((paper) => [paper.documentId, paper] as const),
      );
      const stateByDocumentId = new Map(
        states.map((state) => [state.documentId, state] as const),
      );
      const initialIgnoredCloudIssues: IgnoredPaperCloudIssue[] =
        profile.deviceMode === 'personal' &&
        profile.accountId &&
        profile.workspaceAccountId === profile.accountId &&
        profile.rootFolderId
          ? (profile.cloudIssueQuarantines ?? [])
              .filter(
                (entry) =>
                  entry.reviewedAt === undefined &&
                  entry.accountId === profile.accountId &&
                  entry.rootFolderId === profile.rootFolderId,
              )
              .map((entry) => ({
                documentId: entry.documentId,
                displayName:
                  cachedPaperByDocumentId.get(entry.documentId)?.displayName ??
                  stateByDocumentId.get(entry.documentId)?.displayName ??
                  'Inaccessible paper',
                confirmedAt: entry.confirmedAt,
              }))
              .sort((first, second) =>
                first.documentId.localeCompare(second.documentId),
              )
          : [];
      const reviewedCloudIssueRevalidationPending = Boolean(
        this.activeReviewedCloudIssueRevalidation(),
      );
      const reviewedCloudIssueIssue = this.reviewedCloudIssueRevalidationIssue();
      this.view = {
        ...this.view,
        connection: getBuildTimeSyncAuthUrl() ? 'disconnected' : 'not-configured',
        deviceMode: profile.deviceMode,
        deviceModeChoiceConfirmed,
        autoSync:
          deviceModeChoiceConfirmed && profile.deviceMode === 'personal'
            ? profile.autoSync
            : false,
        papers: cachedPapers,
        paperStates: [...this.paperStates.values()],
        dirtyPaperIds: this.getPendingSyncPaperIds(),
        ignoredCloudIssues: initialIgnoredCloudIssues,
        reviewedCloudIssueRevalidationPending,
        lastSuccessfulAt: profile.lastSuccessfulAt,
        lastVerifiedDriveAt: verifiedDriveCheckAt(profile),
        ...(reviewedCloudIssueIssue
          ? {
              issue: reviewedCloudIssueIssue,
              error: reviewedCloudIssueIssue.message,
            }
          : {}),
        publicDeviceNotice:
          profile.deviceMode === 'temporary' ? PUBLIC_DEVICE_LIMITATION : undefined,
        ...(cleanupNotice ? { temporaryCleanupNotice: cleanupNotice } : {}),
        ...(!deviceModeChoiceConfirmed
          ? { securityState: { kind: 'device-mode-required' } as const }
          : {}),
        ...(this.restorePublicationOperation
          ? {
              restorePublicationHold: {
                status: 'waiting' as const,
                restoredDocumentCount:
                  this.restorePublicationOperation.enginePlan!.documentDecisions.filter(
                    ({ resolution }) => resolution !== 'skip',
                  ).length,
              },
            }
          : {}),
      };
      this.emit();
      this.removePersistentListener = subscribeToPersistentChanges(
        (detail, workspaceLease) => {
          const task = this.markDirty(detail, workspaceLease);
          this.pendingPersistentChanges.add(task);
          return task
            .catch((error) => this.applyError(error))
            .finally(() => this.pendingPersistentChanges.delete(task));
        },
      );
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      const backendUrl = getBuildTimeSyncAuthUrl();
      if (!backendUrl) return;
      this.identity.configure(
        backendUrl,
        profile.deviceId,
        profile.googleDeviceSessionToken,
        profile.deviceMode,
        profile.accountId,
      );
      await this.runWorkspaceMutation(async (workspaceLease) => {
        const exchange = await this.identity.completeAuthorizationIfPresent();
        if (!exchange) return;
        if (exchange.sessionMode !== profile.deviceMode) {
          this.identity.clearLocalSession();
          throw new GoogleReauthorizationRequiredError(
            'Google authorization returned for a different device mode. Nothing was connected; start again from this device-mode choice.',
            true,
          );
        }
        if (profile.deviceMode === 'personal') {
          profile.googleDeviceSessionToken = exchange.sessionToken;
        } else {
          try {
            const activeWorkspaceId = this.requireMatchingTemporaryWorkspaceId();
            const provenance = await loadTemporarySessionProvenance();
            if (provenance) {
              this.assertUsableTemporaryProvenance(provenance, 'other');
              if (
                provenance.temporarySessionId !== activeWorkspaceId ||
                provenance.accountId !== exchange.accountId
              ) {
                throw new WorkspaceAccountMismatchError();
              }
              this.temporaryWorkspaceAccountId = provenance.accountId;
            } else {
              // A missing record is valid only for the first authorization of a
              // completely unbound temporary workspace. Never heal an established
              // profile/cache because that could relabel account-A data as account B.
              if (profile.accountId || this.temporaryWorkspaceAccountId) {
                throw new WorkspaceAccountMismatchError();
              }
              const bound = await beginTemporaryProvenance(
                exchange.accountId,
                undefined,
                workspaceLease,
              );
              if (bound.temporarySessionId !== activeWorkspaceId) {
                throw new WorkspaceAccountMismatchError();
              }
              this.temporaryWorkspaceAccountId = bound.accountId;
            }
            this.assertTemporaryWorkspaceAccountClaim(exchange.accountId);
          } catch (error) {
            this.identity.clearLocalSession();
            throw error;
          }
        }
        profile.accountId = exchange.accountId;
        await savePaperSyncDeviceProfile(
          profile,
          { authentication: 'replace' },
          workspaceLease,
        );
        this.updateView(
          { lastVerifiedDriveAt: verifiedDriveCheckAt(profile) },
          { notify: false },
        );
      });
      if (!this.identity.hasDeviceSession) {
        this.updateView(
          {
            connection: 'disconnected',
            lastVerifiedDriveAt: undefined,
            autoSync: profile.deviceMode === 'temporary' ? false : profile.autoSync,
          },
          { notify: false },
        );
        return;
      }
      if (!(await this.resolveAuthorizedAccount())) return;
      if (this.restorePublicationOperation) {
        this.updateView(
          {
            connection: 'connected',
            progress: { phase: 'idle' },
            error: undefined,
            issue: undefined,
          },
          { notify: false },
        );
        return;
      }
      this.updateView({ connection: 'connecting' }, { notify: false });
      await this.refreshSessions();
      if (this.view.connection === 'connecting') {
        await this.scanCloudPapersOwned(false);
      }
      if (this.isAutoSyncEffectivelyEnabled() && this.getPendingSyncPaperIds().length)
        this.scheduleAutoUpload();
    } catch (error) {
      this.applyError(error, false);
    }
  }

  private async ensureRepository(
    signal: AbortSignal,
    requireActiveLayout = true,
  ): Promise<PaperDriveRepository> {
    this.assertAuthorizedWorkspaceAccount();
    if (this.repository) {
      if (requireActiveLayout) await this.repository.assertActiveRoot(signal);
      return this.repository;
    }
    if (!this.identity.hasDeviceSession) throw new GoogleReauthorizationRequiredError();
    const drive = this.requireDrive();
    const profile = this.requireProfile();
    let root: DriveFileMetadata | undefined;
    let cachedRootMissing = false;
    let cachedRootInvalid = false;
    if (profile.rootFolderId) {
      try {
        const cached = await drive.getMetadata(profile.rootFolderId, signal);
        if (isOwnedManagedPaperRootMetadata(cached)) root = cached;
        else cachedRootInvalid = true;
      } catch (error) {
        if (!(error instanceof DriveRequestError && error.status === 404)) throw error;
        cachedRootMissing = true;
      }
    }
    if (cachedRootInvalid) {
      this.updateView({
        connection: 'root-unavailable',
        error:
          'The previously selected Drive folder is no longer a verified 39Note sync root. Ordinary sync is paused.',
      });
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The previously selected Drive folder is not a verified 39Note sync root.',
      );
    }
    if (cachedRootMissing) {
      if (profile.deviceMode === 'temporary') {
        throw new PublicDeviceRootMissingError();
      }
      this.updateView({
        connection: 'root-unavailable',
        error:
          'The previously selected 39Note folder is missing. 39Note will not create a second folder automatically.',
      });
      throw new PaperRepositoryError(
        'drive-root-missing',
        'The previously selected 39Note folder is missing.',
      );
    }
    if (!root) {
      const roots = await discoverPaperRootsBeforeCreation(drive, signal);
      if (roots.length > 1) {
        this.updateView({
          connection: 'root-selection-required',
          rootChoices: roots,
          error: 'Choose the 39Note folder to use.',
        });
        throw new AmbiguousPaperFolderError('root');
      }
      root = roots[0];
    }
    if (!root) {
      if (profile.deviceMode === 'temporary') {
        throw new PublicDeviceRootMissingError();
      }
      root = await drive.createFolder(
        ROOT_NAME,
        null,
        {
          application: '39Note',
          role: 'root',
        },
        signal,
      );
      if (!isOwnedManagedPaperRootMetadata(root)) {
        throw new PaperRepositoryError(
          'drive-root-invalid',
          'Google Drive returned an invalid 39Note folder.',
        );
      }
      const confirmedRoots = await confirmCreatedPaperRoot(drive, root, signal);
      if (confirmedRoots.length !== 1) {
        this.updateView({
          connection: 'root-selection-required',
          rootChoices: confirmedRoots,
          error: 'Multiple 39Note folders were found. Choose the folder to use.',
        });
        throw new AmbiguousPaperFolderError('root');
      }
      root = confirmedRoots[0];
    }
    if (profile.rootFolderId !== root.id) {
      delete profile.driveChangeCursor;
      delete profile.driveAuditCheckpoint;
    }
    profile.rootFolderId = root.id;
    const workspaceLease = this.requireWorkspaceLease(signal);
    await savePaperSyncDeviceProfile(profile, {}, workspaceLease);
    this.repository = await this.createPaperDriveRepository(drive, root.id);
    if (profile.deviceMode === 'temporary' && profile.accountId) {
      const provenance = await beginTemporaryProvenance(
        profile.accountId,
        root.id,
        workspaceLease,
      );
      this.temporaryWorkspaceAccountId = provenance.accountId;
    }
    this.updateView(
      {
        rootUrl: rootUrl(root.id),
        rootChoices: [],
        lastVerifiedDriveAt: verifiedDriveCheckAt(profile),
      },
      { notify: false },
    );
    if (requireActiveLayout) await this.repository.assertActiveRoot(signal);
    return this.repository;
  }

  /**
   * Reconstructs only the exact persisted root by ID. Unlike ordinary setup it
   * never discovers alternatives, creates a root, or initializes a layout.
   */
  private async ensureVerifiedRepositoryReadOnly(
    signal: AbortSignal,
  ): Promise<PaperDriveRepository> {
    this.assertAuthorizedWorkspaceAccount();
    const profile = this.requireProfile();
    const rootFolderId = profile.rootFolderId;
    if (!rootFolderId) {
      throw new PaperRepositoryError(
        'drive-root-missing',
        'A verified existing 39Note Drive folder is required for this read-only check.',
      );
    }
    const drive = this.requireDrive();
    let root: DriveFileMetadata;
    try {
      root = await drive.getMetadata(rootFolderId, signal, {
        phase: 'read-timeout-recovery-root-validation',
        dependencyPhase: 'root-layout-guard',
        resource: 'root',
      });
    } catch (error) {
      if (!(error instanceof DriveRequestError && error.status === 404)) throw error;
      throw new PaperRepositoryError(
        'drive-root-missing',
        'The selected 39Note Drive folder is no longer available.',
      );
    }
    if (root.id !== rootFolderId || !isOwnedManagedPaperRootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not a verified active 39Note sync root.',
      );
    }
    // Keep the root-scoped verified immutable caches populated by the timed-out
    // read. The fresh root GET above and assertActiveRoot below still close the
    // recovery boundary; recreating the repository here only forced Retry to
    // redownload every manifest and presence record it had just verified.
    const repository =
      this.repository?.rootFolderId === rootFolderId
        ? this.repository
        : await this.createPaperDriveRepository(drive, rootFolderId);
    await repository.assertActiveRoot(signal);
    this.repository = repository;
    return repository;
  }

  /**
   * Rehydrates only locally cached immutable bodies. The repository still
   * obtains fresh Drive listings and compares exact metadata before reuse.
   */
  private async createPaperDriveRepository(
    drive: DriveClient,
    rootFolderId: string,
  ): Promise<PaperDriveRepository> {
    const accountId = this.assertAuthorizedWorkspaceAccount();
    const repository = new PaperDriveRepository(drive, rootFolderId, {
      persistVerifiedCacheEntries: async (entries) => {
        if (entries.length === 0) return;
        const fence = this.activeDriveOperationIdentityFence;
        const profile = this.profile;
        if (
          !fence ||
          fence.accountId !== accountId ||
          profile?.accountId !== accountId ||
          profile.rootFolderId !== rootFolderId
        ) {
          return;
        }
        try {
          await savePaperDriveVerificationCache(
            accountId,
            rootFolderId,
            entries,
            fence.workspaceLease,
          );
        } catch {
          // This cache is an optimization only; a local cache write failure
          // must not change the result of the authoritative Drive operation.
        }
      },
    });
    let cached: PaperVerificationCacheEntry[] = [];
    try {
      cached = await loadPaperDriveVerificationCache(accountId, rootFolderId);
    } catch {
      // A missing or unavailable local cache falls back to a cold Drive audit.
    }
    await repository.hydrateVerifiedReadCache(cached);
    return repository;
  }

  /**
   * Housekeeping is an opt-in operation on the already selected root. Starting
   * normal coordinator initialization here could discover or create a root,
   * which would violate the inventory action's read-only contract.
   */
  private async requireInitializedHousekeepingContext(): Promise<void> {
    if (!this.initializationPromise) {
      throw new LegacyDriveCleanupRefusedError(
        'Google Drive sync must finish connecting before legacy data can be checked.',
      );
    }
    await this.initializationPromise;
  }

  /** Freshly validates only the persisted root identity; there is no discovery/create path. */
  private async requireSelectedHousekeepingRepository(
    signal: AbortSignal,
  ): Promise<PaperDriveRepository> {
    this.assertAuthorizedWorkspaceAccount();
    const profile = this.requireProfile();
    if (!profile.rootFolderId) {
      throw new LegacyDriveCleanupRefusedError(
        'Select an existing verified 39Note Drive folder before checking legacy data.',
      );
    }
    if (!this.identity.hasDeviceSession) throw new GoogleReauthorizationRequiredError();
    const drive = this.requireDrive();
    let root: DriveFileMetadata;
    try {
      root = await drive.getMetadata(profile.rootFolderId, signal, {
        phase: 'legacy-inventory-root-validation',
        resource: 'root',
      });
    } catch (error) {
      if (!(error instanceof DriveRequestError && error.status === 404)) throw error;
      throw new PaperRepositoryError(
        'drive-root-missing',
        'The selected 39Note Drive folder is no longer available.',
      );
    }
    if (root.id !== profile.rootFolderId || !isRecognizedPaperRootMetadata(root)) {
      throw new PaperRepositoryError(
        'drive-root-invalid',
        'The selected Google Drive folder is not a verified 39Note sync root.',
      );
    }
    const repository = new PaperDriveRepository(drive, root.id);
    await repository.assertActiveRoot(signal);
    return repository;
  }

  private requireDrive(): DriveClient {
    this.drive ??= new DriveClient(
      (forceRefresh) => this.getFencedDriveAccessToken(forceRefresh),
      {
        onRequestActivity: (activity) => this.updateDriveRequestActivity(activity),
      },
    );
    return this.drive;
  }

  /**
   * Drive asks for a token for every request and may ask again after a 401.
   * Revalidate both before and after that asynchronous token acquisition so an
   * operation can never silently continue after a session/account switch.
   */
  private async getFencedDriveAccessToken(forceRefresh = false): Promise<string> {
    const fence = this.activeDriveOperationIdentityFence;
    if (!fence) throw new WorkspaceAccountIdentityUnavailableError();
    fence.signal.throwIfAborted();
    assertWorkspaceRestoreLease(fence.workspaceLease, { allowExclusive: true });
    await awaitDriveOperationDeadline(
      this.revalidateOperationWorkspaceAccount(fence.accountId, fence.operationType),
      fence.signal,
    );
    fence.signal.throwIfAborted();
    assertWorkspaceRestoreLease(fence.workspaceLease, { allowExclusive: true });
    const token = await this.identity.ensureAccessToken(forceRefresh);
    fence.signal.throwIfAborted();
    assertWorkspaceRestoreLease(fence.workspaceLease, { allowExclusive: true });
    await awaitDriveOperationDeadline(
      this.revalidateOperationWorkspaceAccount(fence.accountId, fence.operationType),
      fence.signal,
    );
    fence.signal.throwIfAborted();
    assertWorkspaceRestoreLease(fence.workspaceLease, { allowExclusive: true });
    return token.value;
  }

  private async assertActiveLayout(
    repository: PaperDriveRepository,
    signal: AbortSignal,
  ): Promise<void> {
    const inspection = await repository.detectLayout(signal);
    if (inspection.state === 'paper-v3') return;
    if (
      inspection.state === 'legacy-upgrade-required' ||
      inspection.state === 'paper-v2-upgrade-required' ||
      inspection.state === 'protocol-upgrade-required'
    ) {
      const layoutUpgradeKind =
        inspection.state === 'protocol-upgrade-required'
          ? ('protocol-2-to-3' as const)
          : inspection.state === 'paper-v2-upgrade-required'
            ? ('v2-to-v3' as const)
            : ('legacy-to-v2' as const);
      this.updateView({
        connection: 'layout-upgrade-required',
        layoutUpgradeKind,
        error: 'Drive layout upgrade required.',
      });
      throw new PaperRepositoryError(
        'layout-upgrade-required',
        'Drive layout upgrade required.',
      );
    }
    if (inspection.state === 'migration-incomplete') {
      this.updateView({
        connection: 'migration-incomplete',
        layoutUpgradeKind:
          inspection.detectedLayoutVersion === 3 &&
          inspection.detectedPaperSyncProtocolVersion === 2
            ? 'protocol-2-to-3'
            : inspection.detectedLayoutVersion === 2 ||
                inspection.controlManagedFileIds.length > 0
              ? 'v2-to-v3'
              : 'legacy-to-v2',
        error: 'Drive layout upgrade did not finish. Ordinary sync is paused.',
      });
      throw new PaperRepositoryError(
        'layout-migration-incomplete',
        'Drive layout upgrade did not finish. Ordinary sync is paused.',
      );
    }
    if (inspection.state === 'unsupported-layout') {
      throw new PaperRepositoryError(
        'unsupported-layout',
        'This Drive library was created by a newer 39Note version.',
      );
    }
    if (inspection.state === 'unsupported-protocol') {
      throw new PaperRepositoryError(
        'unsupported-protocol',
        'This 39Note version is too old to access this Drive library. Open the latest 39Note version. Do not attempt another Drive upgrade.',
      );
    }
    if (this.requireProfile().deviceMode === 'temporary') {
      throw new PublicDeviceRootMissingError();
    }
    await repository.initializeEmptyLayout(signal);
  }

  private async inspectAndScan(): Promise<void> {
    const signal = await this.beginOperation('scan');
    try {
      const repository = await this.ensureRepository(signal, false);
      const inspection = await repository.detectLayout(signal);
      if (
        inspection.state === 'legacy-upgrade-required' ||
        inspection.state === 'paper-v2-upgrade-required' ||
        inspection.state === 'protocol-upgrade-required'
      ) {
        this.updateView({
          connection: 'layout-upgrade-required',
          layoutUpgradeKind:
            inspection.state === 'protocol-upgrade-required'
              ? 'protocol-2-to-3'
              : inspection.state === 'paper-v2-upgrade-required'
                ? 'v2-to-v3'
                : 'legacy-to-v2',
          error: 'Drive layout upgrade required.',
        });
        return;
      }
      if (inspection.state === 'migration-incomplete') {
        this.updateView({
          connection: 'migration-incomplete',
          layoutUpgradeKind:
            inspection.detectedLayoutVersion === 3 &&
            inspection.detectedPaperSyncProtocolVersion === 2
              ? 'protocol-2-to-3'
              : inspection.detectedLayoutVersion === 2 ||
                  inspection.controlManagedFileIds.length > 0
                ? 'v2-to-v3'
                : 'legacy-to-v2',
          error: 'Drive layout upgrade did not finish. Ordinary sync is paused.',
        });
        return;
      }
      if (inspection.state === 'unsupported-layout') {
        throw new PaperRepositoryError(
          'unsupported-layout',
          'This Drive library was created by a newer 39Note version.',
        );
      }
      if (inspection.state === 'unsupported-protocol') {
        throw new PaperRepositoryError(
          'unsupported-protocol',
          'This 39Note version is too old to access this Drive library. Open the latest 39Note version. Do not attempt another Drive upgrade.',
        );
      }
      if (inspection.state === 'empty') {
        if (this.requireProfile().deviceMode === 'temporary') {
          this.applySecurityError(
            new PublicDeviceRootMissingError(),
            'public-root-missing',
          );
          return;
        }
        await repository.initializeEmptyLayout(signal);
      }
    } finally {
      this.endOperation(signal);
    }
    await this.scanCloudPapers();
  }

  private localRemovalEpoch(documentId: string): number {
    return this.localRemovalEpochs.get(documentId) ?? 0;
  }

  private beginLocalRemoval(documentIds: readonly string[]): void {
    for (const documentId of documentIds) {
      this.localRemovalEpochs.set(documentId, this.localRemovalEpoch(documentId) + 1);
      this.activeLocalRemovalIds.add(documentId);
    }
  }

  private finishLocalRemoval(documentIds: readonly string[], committed: boolean): void {
    for (const documentId of documentIds) {
      if (committed) {
        this.committedLocalRemovalEpochs.set(
          documentId,
          this.localRemovalEpoch(documentId),
        );
      }
      this.activeLocalRemovalIds.delete(documentId);
    }
    for (const resolve of this.localRemovalWaiters) resolve();
    this.localRemovalWaiters.clear();
  }

  private async waitForActiveLocalRemovals(): Promise<void> {
    while (this.activeLocalRemovalIds.size > 0) {
      await new Promise<void>((resolve) => this.localRemovalWaiters.add(resolve));
    }
  }

  private async waitForActiveLocalRemoval(documentId: string): Promise<void> {
    while (this.activeLocalRemovalIds.has(documentId)) {
      await new Promise<void>((resolve) => this.localRemovalWaiters.add(resolve));
    }
  }

  private async waitForLocalRemovalSettlement(): Promise<void> {
    while (true) {
      await this.waitForActiveLocalRemovals();
      const reconciliation = this.localRemovalReconcilePromise;
      if (reconciliation) await reconciliation;
      if (
        this.activeLocalRemovalIds.size === 0 &&
        this.localRemovalReconcilePromise === null
      ) {
        return;
      }
    }
  }

  /**
   * Waits only for the local IndexedDB boundary. It is safe to call while this
   * operation owns Drive because the local mutation never waits for Drive.
   */
  private async staleBecauseLocalRemoval(
    documentId: string,
    capturedEpoch: number,
  ): Promise<boolean> {
    const observedEpoch = this.localRemovalEpoch(documentId);
    const activeAtObservation = this.activeLocalRemovalIds.has(documentId);
    const changed = observedEpoch !== capturedEpoch || activeAtObservation;
    if (!changed) return false;
    await this.waitForActiveLocalRemoval(documentId);
    const committedEpoch = this.committedLocalRemovalEpochs.get(documentId) ?? 0;
    return committedEpoch > capturedEpoch;
  }

  private async handleLocalRemovalLifecycle(
    detail: PersistentChangeDetail,
    existingLease?: WorkspaceRestoreLease,
  ): Promise<void> {
    const documentIds = [
      ...new Set([
        ...(detail.documentIds ?? []),
        ...(detail.documentId ? [detail.documentId] : []),
      ]),
    ];
    if (!documentIds.length || !detail.localRemoval) return;
    if (detail.localRemoval === 'started') {
      this.beginLocalRemoval(documentIds);
      return;
    }
    if (detail.localRemoval === 'aborted') {
      this.finishLocalRemoval(documentIds, false);
      return;
    }

    // A commit may arrive just as initialization installs the persistence
    // listener. Synthesize the missing start so stale operation epochs still
    // advance and the committed boundary remains deterministic.
    for (const documentId of documentIds) {
      if (!this.activeLocalRemovalIds.has(documentId)) {
        this.beginLocalRemoval([documentId]);
      }
    }

    await this.runWorkspaceMutation(async (workspaceLease) => {
      const catalogByDocument = new Map(
        this.view.papers.map((paper) => [paper.documentId, paper] as const),
      );
      const statesToSave: PaperSyncState[] = [];
      const stateIdsToDelete: string[] = [];
      for (const documentId of documentIds) {
        const paper = catalogByDocument.get(documentId);
        let state = this.paperStates.get(documentId);
        const hasKnownCloudCopy = Boolean(
          (paper && paper.presenceState !== 'removed') ||
          (state?.cloudPresence !== 'removed' && state?.remoteHeadIds.length),
        );
        if (!state && hasKnownCloudCopy) {
          state = createDefaultPaperSyncState(
            documentId,
            this.requireProfile().deviceId,
            'cloud-only',
          );
        }
        if (!state || !hasKnownCloudCopy) {
          this.paperStates.delete(documentId);
          stateIdsToDelete.push(documentId);
          catalogByDocument.delete(documentId);
          continue;
        }

        state.locallyDeleted = false;
        state.availability = 'cloud-only';
        state.dirtyReasons = [];
        if (paper) {
          state.displayName = paper.displayName;
          state.remoteHeadIds = [...paper.headIds];
          state.cloudPresence = 'present';
          state.presenceHeadIds = [...(paper.presenceHeadIds ?? [])];
          state.cloudCleanupPending = false;
          state.driveFiles.paperFolderId = paper.paperFolderId;
          state.driveFiles.dataFolderId = paper.dataFolderId;
          state.driveFiles.sourceArtifactFileId = paper.sourceArtifact?.fileId;
          state.driveFiles.sourcePdfFileId =
            paper.sourceArtifact?.documentType === 'pdf'
              ? paper.sourceArtifact.fileId
              : undefined;
        }
        const preserveAttention =
          this.blockingPaperIssues.has(documentId) ||
          paper?.status === 'needs-attention' ||
          paper?.issue !== undefined;
        state.status = preserveAttention ? 'needs-attention' : 'cloud-only';
        this.paperStates.set(documentId, state);
        statesToSave.push(state);
        if (paper) {
          const settledPaper: PaperCloudSummary = {
            ...paper,
            localAvailability: 'cloud-only',
            status: preserveAttention ? 'needs-attention' : 'cloud-only',
          };
          if (!preserveAttention) delete settledPaper.issue;
          catalogByDocument.set(documentId, settledPaper);
        }
      }

      const catalog = [...catalogByDocument.values()].sort((first, second) =>
        first.documentId.localeCompare(second.documentId),
      );
      this.refreshStateView(catalog);
      try {
        await Promise.all([
          ...statesToSave.map((state) => savePaperSyncState(state, workspaceLease)),
          ...(stateIdsToDelete.length
            ? [deletePaperSyncRecords(stateIdsToDelete, workspaceLease)]
            : []),
          saveCloudPaperCatalog(catalog, workspaceLease),
        ]);
      } finally {
        // Queue the exact remote check before releasing Retry/discovery waiters so
        // FIFO Drive ownership always places it on the safe side of the commit.
        this.scheduleLocalRemovalReconciliation(documentIds);
        this.finishLocalRemoval(documentIds, true);
      }
    }, existingLease);
  }

  private scheduleLocalRemovalReconciliation(documentIds: readonly string[]): void {
    if (this.restorePublicationOperation) return;
    for (const documentId of documentIds) {
      this.pendingLocalRemovalReconcileIds.add(documentId);
    }
    if (this.localRemovalReconcilePromise) return;
    const reconciliation = Promise.resolve()
      .then(() => this.drainLocalRemovalReconciliation())
      .catch((error) => this.applyError(error))
      .finally(() => {
        if (this.localRemovalReconcilePromise === reconciliation) {
          this.localRemovalReconcilePromise = null;
        }
        if (this.pendingLocalRemovalReconcileIds.size > 0) {
          this.scheduleLocalRemovalReconciliation([]);
        }
      });
    this.localRemovalReconcilePromise = reconciliation;
  }

  private async drainLocalRemovalReconciliation(): Promise<void> {
    // Give same-turn batch commits one deterministic coalescing point.
    await Promise.resolve();
    while (this.pendingLocalRemovalReconcileIds.size > 0) {
      const documentIds = [...this.pendingLocalRemovalReconcileIds].sort();
      this.pendingLocalRemovalReconcileIds.clear();
      await this.reconcileCommittedLocalRemovals(documentIds);
    }
  }

  private async reconcileCommittedLocalRemovals(
    documentIds: readonly string[],
  ): Promise<void> {
    if (!documentIds.length) return;
    // The persistence listener is installed only after the profile is loaded.
    // Avoid joining initialization here: its initial scan may itself be waiting
    // for this local-removal settlement.
    if (!this.profile) await this.initialize();
    if (
      !this.identity.hasDeviceSession ||
      !this.profile?.rootFolderId ||
      this.driveOperationSuspensionCount > 0
    ) {
      return;
    }
    const capturedEpochs = new Map(
      documentIds.map((documentId) => [documentId, this.localRemovalEpoch(documentId)]),
    );
    const signal = await this.beginOperation('scan');
    try {
      const repository = await this.ensureRepository(signal, false);
      this.updateView({
        connection: 'syncing',
        progress: {
          phase: 'discovering',
          detail:
            documentIds.length === 1
              ? 'Updating local availability'
              : `Updating ${documentIds.length} local papers`,
        },
        error: undefined,
        issue: this.firstBlockingPaperIssue(),
      });
      for (const documentId of documentIds) {
        this.drive?.recordOperationStateTransition?.({
          phase: 'local-removal-reconciliation',
          transition: 'local-removal-commit-observed',
          documentId,
          outcome: 'started',
          classification: 'intentional-local-removal',
        });
      }

      let scoped: Awaited<ReturnType<PaperDriveRepository['discoverPapers']>> | null =
        null;
      for (
        let attempt = 0;
        attempt < MAX_LOCAL_REMOVAL_RECONCILE_ATTEMPTS;
        attempt += 1
      ) {
        try {
          scoped = await repository.discoverPapers(
            documentIds,
            [...this.paperStates.values()],
            signal,
            { layoutValidated: true, reuseVerifiedManifests: true },
          );
          break;
        } catch (error) {
          const issue = classifyPaperCoordinatorError(error);
          const mayRetry =
            issue.retrySafe &&
            !issue.blocksOrdinarySync &&
            attempt + 1 < MAX_LOCAL_REMOVAL_RECONCILE_ATTEMPTS;
          if (!mayRetry) throw error;
          this.requireDrive().recordOperationRetry();
          this.requireDrive().recordOperationStateTransition?.({
            phase: 'local-removal-reconciliation',
            transition: 'operation-retry-classified',
            outcome: 'deferred',
            classification: 'transient-scoped-local-removal-refresh',
          });
        }
      }
      if (!scoped) return;
      await this.applyLocalRemovalDiscovery(
        documentIds,
        capturedEpochs,
        scoped.papers,
        scoped.missingDocumentIds,
        this.requireWorkspaceLease(signal),
      );
      const blockingIssue = this.firstBlockingPaperIssue();
      this.updateView(
        {
          connection: this.connectionAfterPaperSettlement(blockingIssue),
          progress: { phase: 'idle' },
          issue: blockingIssue,
          error: blockingIssue?.message,
        },
        { actualWork: false },
      );
    } catch (error) {
      const issue = classifyPaperCoordinatorError(error);
      if (isPaperScopedBlockingFailure(error, issue)) {
        for (const documentId of documentIds) {
          if (this.localRemovalEpoch(documentId) === capturedEpochs.get(documentId)) {
            await this.markPaperFailure(
              documentId,
              error,
              this.requireWorkspaceLease(signal),
            );
          }
        }
      }
      this.applyError(error);
    } finally {
      this.endOperation(signal);
    }
  }

  private async applyLocalRemovalDiscovery(
    documentIds: readonly string[],
    capturedEpochs: ReadonlyMap<string, number>,
    papers: readonly PaperCloudSummary[],
    missingDocumentIds: readonly string[],
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    const paperByDocument = new Map(papers.map((paper) => [paper.documentId, paper]));
    const missing = new Set(missingDocumentIds);
    const catalogByDocument = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper] as const),
    );
    const statesToSave: PaperSyncState[] = [];
    const stateIdsToDelete: string[] = [];
    for (const documentId of documentIds) {
      if (
        this.activeLocalRemovalIds.has(documentId) ||
        this.localRemovalEpoch(documentId) !== capturedEpochs.get(documentId)
      ) {
        continue;
      }
      const paper = paperByDocument.get(documentId);
      if (!paper || missing.has(documentId)) {
        const state = this.paperStates.get(documentId);
        if (state) {
          state.status = 'needs-attention';
          statesToSave.push(state);
        }
        const issue = persistedPaperAttentionIssue(documentId);
        this.blockingPaperIssues.set(documentId, { issue });
        const previous = catalogByDocument.get(documentId);
        if (previous) {
          catalogByDocument.set(documentId, {
            ...previous,
            localAvailability: 'cloud-only',
            status: 'needs-attention',
            issue: { code: issue.code, message: issue.message },
          });
        }
        continue;
      }
      if (paper.presenceState === 'removed') {
        this.paperStates.delete(documentId);
        this.blockingPaperIssues.delete(documentId);
        stateIdsToDelete.push(documentId);
        catalogByDocument.delete(documentId);
        continue;
      }

      const state =
        this.paperStates.get(documentId) ??
        createDefaultPaperSyncState(
          documentId,
          this.requireProfile().deviceId,
          'cloud-only',
        );
      state.locallyDeleted = false;
      state.availability = 'cloud-only';
      state.dirtyReasons = [];
      state.displayName = paper.displayName;
      state.remoteHeadIds = [...paper.headIds];
      state.cloudPresence = 'present';
      state.presenceHeadIds = [...(paper.presenceHeadIds ?? [])];
      state.cloudCleanupPending = false;
      state.driveFiles.paperFolderId = paper.paperFolderId;
      state.driveFiles.dataFolderId = paper.dataFolderId;
      state.driveFiles.sourceArtifactFileId = paper.sourceArtifact?.fileId;
      state.driveFiles.sourcePdfFileId =
        paper.sourceArtifact?.documentType === 'pdf'
          ? paper.sourceArtifact.fileId
          : undefined;
      if (paper.status === 'needs-attention' || paper.issue) {
        state.status = 'needs-attention';
        this.blockingPaperIssues.set(documentId, {
          headSetId: paper.headSetId,
          issue: persistedPaperAttentionIssue(documentId),
        });
        catalogByDocument.set(documentId, {
          ...paper,
          localAvailability: 'cloud-only',
          status: 'needs-attention',
        });
      } else {
        state.status = 'cloud-only';
        this.blockingPaperIssues.delete(documentId);
        const settledPaper: PaperCloudSummary = {
          ...paper,
          localAvailability: 'cloud-only',
          status: 'cloud-only',
        };
        delete settledPaper.issue;
        catalogByDocument.set(documentId, settledPaper);
      }
      this.paperStates.set(documentId, state);
      statesToSave.push(state);
      this.drive?.recordOperationStateTransition?.({
        phase: 'local-removal-reconciliation',
        transition: 'paper-state-updated',
        documentId,
        nextPaperState: state.status,
        presenceState: 'present',
        ...(paper.issue?.code ? { issueCode: paper.issue.code } : {}),
        outcome: state.status === 'needs-attention' ? 'failed' : 'succeeded',
        classification:
          state.status === 'needs-attention'
            ? 'remote-paper-still-needs-attention'
            : 'intentional-local-removal-settled-cloud-only',
      });
    }
    const catalog = [...catalogByDocument.values()].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
    await Promise.all([
      ...statesToSave.map((state) => savePaperSyncState(state, workspaceLease)),
      ...(stateIdsToDelete.length
        ? [deletePaperSyncRecords(stateIdsToDelete, workspaceLease)]
        : []),
      saveCloudPaperCatalog(catalog, workspaceLease),
    ]);
    this.refreshStateView(catalog);
    this.updateReminder(catalog);
  }

  /**
   * Restore writes intentionally bypass normal change notifications. Derive one
   * idempotent, conservative dirty state from the committed restore plan while
   * the publication hold still fences every Drive operation.
   */
  private async markRestoredPlanDirty(
    operation: DurableRestoreOperation,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    const plan = operation.enginePlan;
    if (!plan || !operation.commitEvidence || operation.phase !== 'publication-hold') {
      throw new WorkspaceRestoreBarrierError(
        'The restored publication hold is missing verified commit evidence.',
        operation,
      );
    }
    const localPapers = new Map(
      (await this.local.listLocalPapers()).map((paper) => [paper.documentId, paper]),
    );
    const touched: PaperSyncState[] = [];
    for (const decision of plan.documentDecisions) {
      if (decision.resolution === 'skip') continue;
      const paper = localPapers.get(decision.documentId);
      if (!paper) {
        throw new WorkspaceRestoreBarrierError(
          'A committed restored document is unavailable locally.',
          operation,
        );
      }
      let state = this.paperStates.get(decision.documentId);
      if (!state) {
        state = createDefaultPaperSyncState(
          decision.documentId,
          this.requireProfile().deviceId,
        );
      }
      const retainedReasons = state.dirtyReasons.filter(
        (reason) => reason !== 'deleted',
      );
      const nextReasons = [
        ...new Set([...retainedReasons, ...RESTORED_LIBRARY_DIRTY_REASONS]),
      ];
      if (
        state.locallyDeleted ||
        nextReasons.length !== state.dirtyReasons.length ||
        nextReasons.some((reason) => !state!.dirtyReasons.includes(reason))
      ) {
        state.dirtyGeneration += 1;
      }
      state.locallyDeleted = false;
      state.dirtyReasons = nextReasons;
      state.displayName = paper.displayName;
      if (state.cloudPresence === 'removed') {
        state.availability = 'local-only';
        state.status = 'local-only';
        state.remoteHeadIds = [];
      } else {
        state.availability = state.remoteHeadIds.length
          ? 'local-and-cloud'
          : 'local-only';
        const remoteChanged = state.remoteHeadIds.some(
          (head) => !state!.incorporatedHeadIds.includes(head),
        );
        state.status = state.remoteHeadIds.length
          ? remoteChanged
            ? 'both-changed'
            : 'local-changes'
          : 'local-only';
      }
      this.paperStates.set(decision.documentId, state);
      touched.push(state);
    }
    if (touched.length) await savePaperSyncStates(touched, workspaceLease);
  }

  private async reconcileLocalPaperStates(
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    const localPapers = await this.local.listLocalPapers();
    const localIds = new Set(localPapers.map((paper) => paper.documentId));
    for (const paper of localPapers) {
      let state = this.paperStates.get(paper.documentId);
      if (!state) {
        state = createDefaultPaperSyncState(
          paper.documentId,
          this.requireProfile().deviceId,
        );
        this.paperStates.set(paper.documentId, state);
      } else if (state.availability === 'cloud-only') {
        state.availability = state.remoteHeadIds.length
          ? 'local-and-cloud'
          : 'local-only';
      }
      state.displayName = paper.displayName;
    }
    for (const state of this.paperStates.values()) {
      if (
        !localIds.has(state.documentId) &&
        state.locallyDeleted &&
        !state.remoteHeadIds.length
      ) {
        this.paperStates.delete(state.documentId);
        await deletePaperSyncRecords([state.documentId], workspaceLease);
      } else if (
        !localIds.has(state.documentId) &&
        state.remoteHeadIds.length &&
        !state.locallyDeleted
      ) {
        state.availability = 'cloud-only';
        state.dirtyReasons = [];
        state.status = 'cloud-only';
      }
    }
    await savePaperSyncStates([...this.paperStates.values()], workspaceLease);
    this.refreshStateView();
  }

  private async applyDiscovery(
    papers: readonly PaperCloudSummary[],
    scopedDocumentIds: readonly string[] | undefined,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    const discoveryScope = scopedDocumentIds ? new Set(scopedDocumentIds) : undefined;
    const localIds = new Set(
      (await this.local.listLocalPapers()).map((paper) => paper.documentId),
    );
    const cloudIds = new Set<string>();
    const presentedPapers: PaperCloudSummary[] = [];
    const removedCloudOnlyIds: string[] = [];
    for (const paper of papers) {
      cloudIds.add(paper.documentId);
      if (this.isPaperQuarantined(paper.documentId)) {
        const preserved = this.view.papers.find(
          (existing) => existing.documentId === paper.documentId,
        );
        if (preserved) presentedPapers.push(preserved);
        continue;
      }
      if (discoveryScope && !discoveryScope.has(paper.documentId)) {
        // Scoped discovery carries the existing catalog as its merge baseline.
        // Keep those unrelated entries byte-for-byte equivalent in presentation
        // and, critically, do not re-run state settlement without a fresh Drive
        // read for that paper.
        presentedPapers.push(paper);
        continue;
      }
      const blocked = this.blockingPaperIssues.get(paper.documentId);
      const previousPaperState = this.paperStates.get(paper.documentId)?.status;
      if (blocked && blocked.headSetId && blocked.headSetId !== paper.headSetId) {
        this.blockingPaperIssues.delete(paper.documentId);
        this.paperRetryIntents.delete(paper.documentId);
        this.drive?.recordOperationStateTransition?.({
          phase: 'discovery-settlement',
          transition: 'paper-issue-cleared',
          documentId: paper.documentId,
          issueCode: blocked.issue.code,
          outcome: 'succeeded',
          classification: 'authoritative-head-changed',
        });
      }
      let state = this.paperStates.get(paper.documentId);
      if (paper.presenceState === 'removed') {
        this.blockingPaperIssues.delete(paper.documentId);
        this.paperRetryIntents.delete(paper.documentId);
        if (!localIds.has(paper.documentId)) {
          this.paperStates.delete(paper.documentId);
          this.blockingPaperIssues.delete(paper.documentId);
          removedCloudOnlyIds.push(paper.documentId);
          this.drive?.recordOperationStateTransition?.({
            phase: 'discovery-settlement',
            transition: 'discovery-state-applied',
            documentId: paper.documentId,
            ...(previousPaperState ? { previousPaperState } : {}),
            presenceState: 'removed',
            outcome: 'succeeded',
            classification: 'removed-cloud-only-record-cleared',
          });
          continue;
        }
        state ??= createDefaultPaperSyncState(
          paper.documentId,
          this.requireProfile().deviceId,
          'local-only',
        );
        state.displayName = paper.displayName;
        state.availability = 'local-only';
        state.cloudPresence = 'removed';
        state.presenceHeadIds = [...(paper.presenceHeadIds ?? [])];
        state.cloudCleanupPending = paper.cleanupPending === true;
        state.remoteHeadIds = [];
        delete state.dismissedRemoteHeadIds;
        state.driveFiles.paperFolderId = paper.paperFolderId;
        state.status =
          paper.status === 'needs-attention' ? 'needs-attention' : 'local-only';
        this.paperStates.set(paper.documentId, state);
        this.drive?.recordOperationStateTransition?.({
          phase: 'discovery-settlement',
          transition: 'discovery-state-applied',
          documentId: paper.documentId,
          ...(previousPaperState ? { previousPaperState } : {}),
          nextPaperState: state.status,
          presenceState: 'removed',
          ...(paper.issue?.code ? { issueCode: paper.issue.code } : {}),
          outcome: 'succeeded',
          classification:
            state.status === 'needs-attention'
              ? 'removed-presence-with-distinct-issue'
              : 'authoritative-removed-presence',
        });
        presentedPapers.push({
          ...paper,
          localAvailability: 'local-only',
          status: state.status,
        });
        continue;
      }
      if (!state) {
        state = createDefaultPaperSyncState(
          paper.documentId,
          this.requireProfile().deviceId,
          localIds.has(paper.documentId) ? 'local-and-cloud' : 'cloud-only',
        );
        if (!localIds.has(paper.documentId)) {
          state.dirtyReasons = [];
          state.dirtyGeneration = 0;
        }
      }
      const previousHeadSet = [...state.remoteHeadIds].sort().join('|');
      const discoveredHeadSet = [...paper.headIds].sort().join('|');
      if (
        state.dismissedRemoteHeadIds &&
        !sameIdentitySet(state.dismissedRemoteHeadIds, paper.headIds)
      ) {
        delete state.dismissedRemoteHeadIds;
      }
      const preservePersistedAttention =
        state.status === 'needs-attention' && previousHeadSet === discoveredHeadSet;
      const hadActiveBlock = this.blockingPaperIssues.has(paper.documentId);
      if (
        preservePersistedAttention &&
        !this.blockingPaperIssues.has(paper.documentId)
      ) {
        this.blockingPaperIssues.set(paper.documentId, {
          headSetId: paper.headSetId,
          issue: persistedPaperAttentionIssue(paper.documentId),
        });
      }
      const activeBlock = this.blockingPaperIssues.get(paper.documentId);
      const authoritativeBlockMatchesPaper = Boolean(
        activeBlock &&
        paper.issue &&
        activeBlock.issue.diagnostic.operation === paper.issue.code,
      );
      const precisePresenceFailurePersisted = isQuarantinablePresenceCatalogIssue(
        paper.issue,
      );
      // A generic reconstructed blocking issue must not erase the exact durable
      // failure tuple that makes a later, explicitly selected re-quarantine safe.
      const presentedPaper = activeBlock
        ? {
            ...paper,
            status: 'needs-attention' as const,
            issue:
              authoritativeBlockMatchesPaper || precisePresenceFailurePersisted
                ? {
                    ...paper.issue!,
                    message: activeBlock.issue.message,
                  }
                : {
                    code: activeBlock.issue.code,
                    message: activeBlock.issue.message,
                  },
          }
        : paper;
      presentedPapers.push(presentedPaper);
      state.remoteHeadIds = [...paper.headIds];
      state.cloudPresence = 'present';
      state.presenceHeadIds = [...(paper.presenceHeadIds ?? [])];
      state.cloudCleanupPending = false;
      state.displayName = paper.displayName;
      state.availability =
        localIds.has(paper.documentId) || state.locallyDeleted
          ? 'local-and-cloud'
          : 'cloud-only';
      const remoteUpdate = paper.headIds.some(
        (head) => !state!.incorporatedHeadIds.includes(head),
      );
      state.status =
        presentedPaper.status === 'needs-attention' || preservePersistedAttention
          ? 'needs-attention'
          : state.dirtyReasons.length && remoteUpdate
            ? 'both-changed'
            : state.dirtyReasons.length
              ? 'local-changes'
              : remoteUpdate
                ? 'remote-update-available'
                : state.availability === 'cloud-only'
                  ? 'cloud-only'
                  : 'synced';
      state.driveFiles.paperFolderId = paper.paperFolderId;
      state.driveFiles.dataFolderId = paper.dataFolderId;
      state.driveFiles.sourceArtifactFileId = paper.sourceArtifact?.fileId;
      state.driveFiles.sourcePdfFileId =
        paper.sourceArtifact?.documentType === 'pdf'
          ? paper.sourceArtifact.fileId
          : undefined;
      this.paperStates.set(paper.documentId, state);
      this.drive?.recordOperationStateTransition?.({
        phase: 'discovery-settlement',
        transition: 'discovery-state-applied',
        documentId: paper.documentId,
        ...(previousPaperState ? { previousPaperState } : {}),
        nextPaperState: state.status,
        presenceState: 'present',
        ...(presentedPaper.issue?.code ? { issueCode: presentedPaper.issue.code } : {}),
        outcome: 'succeeded',
        classification:
          state.status === 'needs-attention'
            ? 'authoritative-present-with-issue'
            : 'authoritative-present-presence',
      });
      if (state.status === 'needs-attention' && presentedPaper.issue?.code) {
        const issueAlreadyExisted =
          previousPaperState === 'needs-attention' ||
          preservePersistedAttention ||
          hadActiveBlock;
        this.drive?.recordOperationStateTransition?.({
          phase: 'discovery-settlement',
          transition: issueAlreadyExisted
            ? 'operation-issue-observed'
            : 'paper-issue-created',
          documentId: paper.documentId,
          issueCode: presentedPaper.issue.code,
          outcome: 'failed',
          classification: issueAlreadyExisted
            ? 'discovery-paper-issue-observed'
            : 'discovery-paper-issue-created',
        });
      }
    }
    for (const state of this.paperStates.values()) {
      if (
        !this.isPaperQuarantined(state.documentId) &&
        (!discoveryScope || discoveryScope.has(state.documentId)) &&
        state.cloudPresence !== 'removed' &&
        state.remoteHeadIds.length &&
        !cloudIds.has(state.documentId)
      ) {
        const previousPaperState = state.status;
        state.status = 'needs-attention';
        this.drive?.recordOperationStateTransition?.({
          phase: 'discovery-settlement',
          transition: 'discovery-state-applied',
          documentId: state.documentId,
          previousPaperState,
          nextPaperState: state.status,
          issueCode: 'paper-integrity-failed',
          outcome: 'failed',
          classification: 'known-cloud-paper-missing',
        });
      }
    }
    const presentedIds = new Set(presentedPapers.map(({ documentId }) => documentId));
    for (const previous of this.view.papers) {
      if (
        this.isPaperQuarantined(previous.documentId) &&
        !presentedIds.has(previous.documentId)
      ) {
        presentedPapers.push(previous);
        presentedIds.add(previous.documentId);
      }
    }
    presentedPapers.sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
    if (removedCloudOnlyIds.length) {
      await deletePaperSyncRecords(removedCloudOnlyIds, workspaceLease);
    }
    await Promise.all([
      savePaperSyncStates([...this.paperStates.values()], workspaceLease),
      saveCloudPaperCatalog(presentedPapers, workspaceLease),
    ]);
    this.refreshStateView(presentedPapers);
    this.updateReminder(presentedPapers);
  }

  private async markMigrationPublicationsIncorporated(
    record: LayoutMigrationRecord,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    for (const documentId of record.targetDocumentIds) {
      const generationId = record.publishedGenerationIds[documentId];
      const state = this.paperStates.get(documentId);
      if (!generationId || !state) {
        throw new PaperRepositoryError(
          'layout-migration-proof-invalid',
          'The rebuilt paper baseline is incomplete.',
        );
      }
      incorporateVerifiedMigrationHead(state, generationId);
      state.lastSuccessfulAt = Date.now();
    }
    await savePaperSyncStates([...this.paperStates.values()], workspaceLease);
    this.refreshStateView();
  }

  private async uploadSelectedOwned(documentIds: readonly string[]): Promise<void> {
    await this.initialize();
    this.assertNoReviewedCloudIssueRevalidation();
    const ids = [...new Set(documentIds)].filter((id) => {
      const state = this.paperStates.get(id);
      return Boolean(
        state?.dirtyReasons.length &&
        state.cloudPresence !== 'removed' &&
        state.targetedPurge === undefined &&
        !this.isPaperQuarantined(id),
      );
    });
    if (!ids.length) return;
    await this.flushPersistenceChanges();
    if (this.isReadTimeoutRecoveryBoundaryActive()) return;
    let completed = 0;
    let actualWork = false;
    const settledCloud: PaperCloudSummary[] = [];
    const failures: Array<{
      documentId: string;
      error: unknown;
      issue: SyncOperationalIssue;
    }> = [];
    let signal: AbortSignal;
    try {
      signal = await this.beginOperation('upload', true, 'global', () => {
        if (this.isReadTimeoutRecoveryBoundaryActive()) {
          throw new ReadTimeoutUploadDeferredError();
        }
      });
    } catch (error) {
      if (error instanceof ReadTimeoutUploadDeferredError) return;
      throw error;
    }
    try {
      // Recovery can start while account/workspace admission awaits. Recheck at
      // the last boundary before repository access or any Drive mutation.
      if (this.isReadTimeoutRecoveryBoundaryActive()) return;
      this.assertNoReviewedCloudIssueRevalidation();
      const repository = await this.ensureRepository(signal, false);
      this.updateView({
        connection: 'syncing',
        progress: { phase: 'uploading', completed: 0, total: ids.length },
        error: undefined,
        issue: this.firstBlockingPaperIssue(),
      });
      await mapWithConcurrency(ids, PAPER_TRANSFER_CONCURRENCY, async (documentId) => {
        const capturedLocalRemovalEpoch = this.localRemovalEpoch(documentId);
        try {
          await this.paperFlights.run(`upload:${documentId}`, async () => {
            if (
              await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
            ) {
              return;
            }
            const state = this.paperStates.get(documentId);
            if (
              !state ||
              !state.dirtyReasons.length ||
              state.targetedPurge ||
              this.isPaperQuarantined(documentId)
            )
              return;
            const capturedGeneration = state.dirtyGeneration;
            const preUploadStatus = state.status;
            state.status = 'uploading';
            this.drive?.recordOperationStateTransition?.({
              phase: 'upload-local-state',
              transition: 'paper-state-updated',
              documentId,
              previousPaperState: preUploadStatus,
              nextPaperState: state.status,
              outcome: 'started',
            });
            await savePaperSyncState(state, this.requireWorkspaceLease(signal));
            this.refreshStateView();
            if (
              await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
            ) {
              return;
            }
            const local = state.locallyDeleted
              ? this.local.createDeletedPaperPackage(documentId, state, this.writer())
              : await this.local.createPaperPackage(documentId, state, this.writer());
            assertPdfOnlyLocalPublication(
              local,
              this.view.papers.find((paper) => paper.documentId === documentId),
            );
            if (
              await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
            ) {
              return;
            }
            const result = await repository.publishPaper(
              local,
              state,
              signal,
              (progress) => this.applyPaperProgress(progress, completed, ids.length),
              { layoutValidated: true },
            );
            if (
              await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
            ) {
              this.drive?.recordOperationStateTransition?.({
                phase: 'upload-local-state',
                transition: 'stale-local-snapshot-discarded',
                documentId,
                outcome: 'deferred',
                classification: 'intentional-local-removal',
              });
              return;
            }
            this.applyPublishResult(state, result, capturedGeneration);
            this.drive?.recordOperationStateTransition?.({
              phase: 'upload-local-state',
              transition: 'paper-state-updated',
              documentId,
              previousPaperState: 'uploading',
              nextPaperState: state.status,
              presenceState: 'present',
              outcome: 'succeeded',
            });
            await savePaperSyncState(state, this.requireWorkspaceLease(signal));
            this.paperStates.set(documentId, state);
            this.blockingPaperIssues.delete(documentId);
            this.paperRetryIntents.delete(documentId);
            settledCloud.push(result.cloud);
            actualWork ||= !result.noOp;
          });
        } catch (error) {
          if (
            await this.staleBecauseLocalRemoval(documentId, capturedLocalRemovalEpoch)
          ) {
            this.drive?.recordOperationStateTransition?.({
              phase: 'upload-local-state',
              transition: 'operation-retry-classified',
              documentId,
              outcome: 'deferred',
              classification: 'intentional-local-removal-superseded-upload',
            });
            return;
          }
          failures.push({
            documentId,
            error,
            issue: await this.markPaperFailure(
              documentId,
              error,
              this.requireWorkspaceLease(signal),
            ),
          });
        } finally {
          completed += 1;
          this.updateView({
            progress: { phase: 'uploading', completed, total: ids.length },
          });
        }
      });
      // Publication already verifies the exact paper after manifest-last. Updating
      // that result locally avoids a full root/catalog confirmation scan.
      if (settledCloud.length > 0) {
        await this.applyTransferCatalog(
          settledCloud,
          this.requireWorkspaceLease(signal),
        );
      }
      const profile = this.requireProfile();
      if (!failures.length) {
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(
          profile,
          {},
          this.requireWorkspaceLease(signal),
        );
      }
      const primaryIssue =
        failures.find((failure) => failure.issue.blocksOrdinarySync)?.issue ??
        failures[0]?.issue ??
        this.firstBlockingPaperIssue();
      this.updateView(
        {
          connection: this.connectionAfterPaperSettlement(primaryIssue),
          lastSuccessfulAt: profile.lastSuccessfulAt,
          progress: { phase: 'idle' },
          issue: primaryIssue,
          error: primaryIssue?.message,
        },
        { actualWork },
      );
      this.scheduleDirtyFollowUp(failures.map((failure) => failure.issue));
      if (failures.length) throw failures[0].error;
    } catch (error) {
      if (!failures.some((failure) => failure.error === error)) {
        for (const documentId of ids) {
          if (this.paperStates.get(documentId)?.status === 'uploading') {
            await this.markPaperFailure(
              documentId,
              error,
              this.requireWorkspaceLease(signal),
            );
          }
        }
        this.applyError(error);
        this.scheduleDirtyFollowUp([classifyPaperCoordinatorError(error)]);
      }
      throw error;
    } finally {
      this.endOperation(signal);
    }
  }

  private applyPublishResult(
    state: PaperSyncState,
    result: Awaited<ReturnType<PaperDriveRepository['publishPaper']>>,
    capturedGeneration: number,
  ): void {
    const previousSourceArtifactFileId = state.driveFiles.sourceArtifactFileId;
    const previousSourcePdfFileId = state.driveFiles.sourcePdfFileId;
    state.availability = 'local-and-cloud';
    state.cloudPresence = 'present';
    state.presenceHeadIds = [...(result.cloud.presenceHeadIds ?? [])];
    state.cloudCleanupPending = false;
    delete state.dismissedRemoteHeadIds;
    state.remoteHeadIds = [...result.cloud.headIds];
    state.incorporatedHeadIds = result.noOp
      ? [...result.cloud.headIds]
      : [result.manifest.generation.id];
    state.entityVersions = Object.fromEntries(
      result.snapshot.entities.map((entity) => [entity.key, entity.version]),
    );
    state.baselineHashes = Object.fromEntries(
      result.snapshot.entities.map((entity) => [entity.key, entity.version.hash]),
    );
    state.tombstones = result.snapshot.tombstones;
    state.conflicts = result.conflicts;
    state.driveFiles.paperFolderId = result.cloud.paperFolderId;
    state.driveFiles.dataFolderId = result.cloud.dataFolderId;
    state.driveFiles.sourceArtifactFileId = result.cloud.sourceArtifact?.fileId;
    state.driveFiles.sourcePdfFileId =
      result.cloud.sourceArtifact?.documentType === 'pdf'
        ? result.cloud.sourceArtifact.fileId
        : undefined;
    if (result.sourceArtifactDriveEvidence) {
      state.driveFiles.sourceArtifactEvidence = result.sourceArtifactDriveEvidence;
    } else if (
      !state.driveFiles.sourceArtifactFileId ||
      state.driveFiles.sourceArtifactFileId !== previousSourceArtifactFileId
    ) {
      delete state.driveFiles.sourceArtifactEvidence;
    }
    if (result.sourcePdfDriveEvidence) {
      state.driveFiles.sourcePdfEvidence = result.sourcePdfDriveEvidence;
    } else if (
      !state.driveFiles.sourcePdfFileId ||
      state.driveFiles.sourcePdfFileId !== previousSourcePdfFileId
    ) {
      delete state.driveFiles.sourcePdfEvidence;
    }
    state.lastSuccessfulAt = Date.now();
    state.displayName = result.displayName;
    if (result.manifest.deleted) {
      state.locallyDeleted = false;
      state.availability = 'cloud-only';
    }
    settleCapturedDirtyGeneration(state, capturedGeneration);
    const unincorporated = result.cloud.headIds.some(
      (head) => !state.incorporatedHeadIds.includes(head),
    );
    state.status =
      state.dirtyReasons.length && unincorporated
        ? 'both-changed'
        : state.dirtyReasons.length
          ? 'local-changes'
          : unincorporated
            ? 'remote-update-available'
            : 'synced';
  }

  private async applyTransferCatalog(
    settledPapers: readonly PaperCloudSummary[],
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    const byDocumentId = new Map(
      this.view.papers.map((paper) => [paper.documentId, paper]),
    );
    for (const paper of settledPapers) {
      const state = this.paperStates.get(paper.documentId);
      // A removed cloud-only paper has no local row or sync state to retain.
      if (paper.presenceState === 'removed' && !state) {
        byDocumentId.delete(paper.documentId);
        continue;
      }
      const blocking = this.blockingPaperIssues.get(paper.documentId)?.issue;
      const presented: PaperCloudSummary = {
        ...paper,
        status: blocking ? 'needs-attention' : (state?.status ?? paper.status),
        localAvailability: state?.availability ?? paper.localAvailability,
      };
      delete presented.issue;
      if (blocking) {
        presented.issue = { code: blocking.code, message: blocking.message };
      }
      byDocumentId.set(paper.documentId, presented);
    }
    const catalog = [...byDocumentId.values()].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
    // The operation already persisted each affected PaperSyncState. Only replace
    // the compact cloud catalog here; do not enumerate or rewrite unrelated local
    // papers as full discovery does.
    await this.requireDrive().measureOperationPhase('catalog-settlement', async () => {
      await saveCloudPaperCatalog(catalog, workspaceLease);
      this.refreshStateView(catalog);
      this.updateReminder(catalog);
    });
  }

  private async runPostMigrationFullAudit(
    signal: AbortSignal,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!this.repository) return;
    const papers = await this.repository.discover(
      [...this.paperStates.values()],
      signal,
    );
    await this.applyDiscovery(papers, undefined, workspaceLease);
  }

  private async markDirty(
    detail: PersistentChangeDetail,
    existingLease?: WorkspaceRestoreLease,
  ): Promise<void> {
    if (detail.kind === 'ai-settings') return;
    if (detail.localRemoval) {
      await this.handleLocalRemovalLifecycle(detail, existingLease);
      return;
    }
    const ids = [
      ...new Set([
        ...(detail.documentIds ?? []),
        ...(detail.documentId ? [detail.documentId] : []),
      ]),
    ];
    if (!ids.length) return;
    const categories = mapDirtyReasons(detail);
    await this.runWorkspaceMutation(async (workspaceLease) => {
      for (const documentId of ids) {
        // The explicit local-removal lifecycle owns this document until its local
        // transaction commits or aborts. Generic persistence noise must not turn
        // an intentional absence into uploadable dirt.
        if (this.activeLocalRemovalIds.has(documentId)) continue;
        let state = this.paperStates.get(documentId);
        if (!state) {
          state = createDefaultPaperSyncState(
            documentId,
            this.requireProfile().deviceId,
          );
          state.dirtyReasons = [];
          state.dirtyGeneration = 0;
        }
        const preserveAttention = state.status === 'needs-attention';
        if (categories.includes('deleted')) {
          state.locallyDeleted = true;
          if (!state.remoteHeadIds.length) {
            this.paperStates.delete(documentId);
            await deletePaperSyncRecords([documentId], workspaceLease);
            continue;
          }
        } else {
          state.locallyDeleted = false;
        }
        if (!state.displayName) {
          state.displayName = (await this.local.listLocalPapers()).find(
            (paper) => paper.documentId === documentId,
          )?.displayName;
        }
        state.dirtyGeneration += 1;
        state.dirtyReasons = [...new Set([...state.dirtyReasons, ...categories])];
        if (state.cloudPresence === 'removed') {
          state.remoteHeadIds = [];
          delete state.dismissedRemoteHeadIds;
          state.status = 'local-only';
          state.availability = 'local-only';
        } else {
          const remoteUpdate = state.remoteHeadIds.some(
            (head) => !state!.incorporatedHeadIds.includes(head),
          );
          state.status = preserveAttention
            ? 'needs-attention'
            : remoteUpdate
              ? 'both-changed'
              : 'local-changes';
          state.availability = state.remoteHeadIds.length
            ? 'local-and-cloud'
            : 'local-only';
        }
        this.paperStates.set(documentId, state);
        await savePaperSyncState(state, workspaceLease);
        if (this.requireProfile().deviceMode === 'temporary') {
          await recordTemporaryPaperIds([documentId], [], workspaceLease);
        }
      }
    }, existingLease);
    this.refreshStateView();
    this.transientRetryAttempt = 0;
    if (
      this.isAutoSyncEffectivelyEnabled() &&
      this.getAutoSyncEligibleDirtyPaperIds().length
    ) {
      this.scheduleAutoUpload();
    }
  }

  private async flushPersistenceChanges(): Promise<void> {
    await flushLocalPersistence();
    while (this.pendingPersistentChanges.size > 0) {
      await Promise.all([...this.pendingPersistentChanges]);
    }
  }

  private clearScheduledAutoUpload(): void {
    if (this.autoUploadTimer === null) return;
    globalThis.clearTimeout(this.autoUploadTimer);
    this.autoUploadTimer = null;
  }

  private isReadTimeoutRecoveryBoundaryActive(): boolean {
    return Boolean(
      this.readTimeoutRecoveryInProgress ||
      this.view.issue?.code === 'drive-operation-timeout',
    );
  }

  private scheduleAutoUpload(delay = AUTO_UPLOAD_DELAY): void {
    if (this.autoUploadTimer !== null) window.clearTimeout(this.autoUploadTimer);
    if (
      !this.isAutoSyncEffectivelyEnabled() ||
      !this.getAutoSyncEligibleDirtyPaperIds().length
    ) {
      this.autoUploadTimer = null;
      return;
    }
    this.autoUploadTimer = window.setTimeout(() => {
      this.autoUploadTimer = null;
      if (
        !navigator.onLine ||
        !this.identity.hasDeviceSession ||
        !this.isAutoSyncEffectivelyEnabled()
      )
        return;
      const eligible = this.getAutoSyncEligibleDirtyPaperIds();
      if (eligible.length) void this.startUpload(eligible).catch(() => undefined);
    }, delay);
  }

  private scheduleDirtyFollowUp(issues: readonly SyncOperationalIssue[]): void {
    if (
      !this.isAutoSyncEffectivelyEnabled() ||
      !this.getAutoSyncEligibleDirtyPaperIds().length
    ) {
      return;
    }
    const policy = autoSyncFollowUpPolicy(issues);
    if (policy === 'none') {
      this.transientRetryAttempt = 0;
      return;
    }
    if (policy === 'backoff') {
      const delay = transientAutoRetryDelay(this.transientRetryAttempt);
      this.transientRetryAttempt += 1;
      this.scheduleAutoUpload(delay);
      return;
    }
    this.transientRetryAttempt = 0;
    this.scheduleAutoUpload();
  }

  private updateReminder(papers: readonly PaperCloudSummary[]): void {
    this.updateView(
      {
        reminder: nextRemoteUpdateReminder(
          this.view.reminder,
          papers.filter((paper) => !this.isPaperQuarantined(paper.documentId)),
          new Map(
            [...this.paperStates.entries()].filter(
              ([documentId]) => !this.isPaperQuarantined(documentId),
            ),
          ),
          this.seenRemoteReminderStateIds,
        ),
      },
      { notify: false },
    );
  }

  async adoptCurrentAccountForWorkspace(): Promise<void> {
    await this.initialize();
    await this.runWorkspaceMutation(async (workspaceLease) => {
      const profile = this.requireProfile();
      if (
        profile.deviceMode !== 'personal' ||
        this.view.securityState?.kind !== 'account-association-required'
      ) {
        throw new WorkspaceAccountAssociationRequiredError();
      }
      const accountId = this.identity.accountId;
      if (!accountId) throw new WorkspaceAccountIdentityUnavailableError();
      await bindPersonalWorkspaceAccount(accountId, workspaceLease);
      const updated = {
        ...profile,
        workspaceAccountId: accountId,
        accountId,
        autoSync: false,
      };
      await savePaperSyncDeviceProfile(
        updated,
        { authentication: 'replace' },
        workspaceLease,
      );
      this.profile = updated;
      this.updateView({
        connection: 'connected',
        lastVerifiedDriveAt: verifiedDriveCheckAt(updated),
        securityState: undefined,
        autoSync: false,
        issue: undefined,
        error:
          'Google account associated. Auto sync remains off; choose Upload changes when you are ready.',
        progress: { phase: 'idle' },
      });
    });
  }

  private resolveAuthorizedAccount(): Promise<boolean> {
    return this.runWorkspaceMutation((workspaceLease) =>
      this.resolveAuthorizedAccountOwned(workspaceLease),
    );
  }

  private async resolveAuthorizedAccountOwned(
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<boolean> {
    const profile = this.requireProfile();
    const accountId = this.identity.accountId;
    if (!accountId) {
      this.applySecurityError(
        new WorkspaceAccountIdentityUnavailableError(),
        'account-identity-unavailable',
      );
      return false;
    }
    if (profile.deviceMode === 'temporary') {
      try {
        const activeWorkspaceId = this.requireMatchingTemporaryWorkspaceId();
        const provenance = await loadTemporarySessionProvenance();
        if (provenance) {
          this.assertUsableTemporaryProvenance(provenance, 'other');
          if (provenance.temporarySessionId !== activeWorkspaceId) {
            throw new WorkspaceAccountMismatchError();
          }
          if (
            this.temporaryWorkspaceAccountId &&
            provenance.accountId !== this.temporaryWorkspaceAccountId
          ) {
            throw new WorkspaceAccountMismatchError();
          }
          this.temporaryWorkspaceAccountId = provenance.accountId;
        } else if (profile.accountId || this.temporaryWorkspaceAccountId) {
          throw new WorkspaceAccountMismatchError();
        }
        this.assertTemporaryWorkspaceAccountClaim(accountId);
        const boundProvenance = await beginTemporaryProvenance(
          accountId,
          profile.rootFolderId,
          workspaceLease,
        );
        if (boundProvenance.temporarySessionId !== activeWorkspaceId) {
          throw new WorkspaceAccountMismatchError();
        }
        this.temporaryWorkspaceAccountId = boundProvenance.accountId;
        profile.accountId = accountId;
        await savePaperSyncDeviceProfile(
          profile,
          { authentication: 'replace' },
          workspaceLease,
        );
        this.updateView(
          {
            securityState: undefined,
            autoSync: false,
            lastVerifiedDriveAt: verifiedDriveCheckAt(profile),
          },
          { notify: false },
        );
        return true;
      } catch (error) {
        this.applySecurityError(
          error instanceof WorkspaceAccountMismatchError
            ? error
            : new WorkspaceAccountMismatchError(),
          'account-mismatch',
        );
        return false;
      }
    }
    if (profile.workspaceAccountId) {
      if (profile.workspaceAccountId !== accountId) {
        this.applySecurityError(
          new WorkspaceAccountMismatchError(),
          'account-mismatch',
        );
        return false;
      }
      profile.accountId = accountId;
      await savePaperSyncDeviceProfile(
        profile,
        { authentication: 'replace' },
        workspaceLease,
      );
      this.updateView(
        {
          securityState: undefined,
          autoSync: profile.autoSync,
          lastVerifiedDriveAt: verifiedDriveCheckAt(profile),
          issue: undefined,
          error: undefined,
        },
        { notify: false },
      );
      return true;
    }
    if (await this.personalWorkspaceIsEligibleForFirstBinding()) {
      try {
        await bindPersonalWorkspaceAccount(accountId, workspaceLease);
      } catch (error) {
        this.applySecurityError(
          error instanceof WorkspaceAccountBindingConflictError
            ? error
            : new WorkspaceAccountMismatchError(),
          'account-mismatch',
        );
        return false;
      }
      profile.workspaceAccountId = accountId;
      profile.accountId = accountId;
      await savePaperSyncDeviceProfile(
        profile,
        { authentication: 'replace' },
        workspaceLease,
      );
      this.updateView(
        {
          securityState: undefined,
          autoSync: profile.autoSync,
          lastVerifiedDriveAt: verifiedDriveCheckAt(profile),
          issue: undefined,
          error: undefined,
        },
        { notify: false },
      );
      return true;
    }
    this.applySecurityError(
      new WorkspaceAccountAssociationRequiredError(),
      'account-association-required',
    );
    return false;
  }

  private async personalWorkspaceIsEligibleForFirstBinding(): Promise<boolean> {
    const profile = this.requireProfile();
    if (
      profile.rootFolderId ||
      profile.lastSuccessfulAt ||
      this.paperStates.size > 0 ||
      this.view.papers.length > 0
    ) {
      return false;
    }
    return (await this.local.listLocalPapers()).length === 0;
  }

  private assertAuthorizedWorkspaceAccount(): string {
    const profile = this.requireProfile();
    if (!this.view.deviceModeChoiceConfirmed) {
      throw new DeviceModeSelectionRequiredError();
    }
    const accountId = this.identity.accountId;
    if (!accountId) throw new WorkspaceAccountIdentityUnavailableError();
    if (profile.deviceMode === 'temporary') {
      if (!profile.accountId) throw new WorkspaceAccountMismatchError();
      this.assertTemporaryWorkspaceAccountClaim(accountId);
      return accountId;
    }
    if (!profile.workspaceAccountId) {
      throw new WorkspaceAccountAssociationRequiredError();
    }
    if (
      profile.workspaceAccountId !== accountId ||
      (profile.accountId !== undefined && profile.accountId !== accountId)
    ) {
      throw new WorkspaceAccountMismatchError();
    }
    return accountId;
  }

  /**
   * Checks every account identity already known for the active temporary
   * workspace. Profile state alone is not authoritative: older code could
   * overwrite it with a newly returned OAuth identity before consulting the
   * immutable temporary-session provenance.
   */
  private assertTemporaryWorkspaceAccountClaim(accountId: string): void {
    const profile = this.requireProfile();
    if (profile.deviceMode !== 'temporary') return;
    if (
      (profile.accountId !== undefined && profile.accountId !== accountId) ||
      (this.temporaryWorkspaceAccountId !== undefined &&
        this.temporaryWorkspaceAccountId !== accountId)
    ) {
      throw new WorkspaceAccountMismatchError();
    }
  }

  /** Returns the UUID-scoped workspace captured during initialization. */
  private requireMatchingTemporaryWorkspaceId(): string {
    const activeWorkspaceId = getActiveTemporaryWorkspaceId();
    if (
      !activeWorkspaceId ||
      !this.temporaryWorkspaceId ||
      activeWorkspaceId !== this.temporaryWorkspaceId
    ) {
      throw new WorkspaceAccountMismatchError();
    }
    return activeWorkspaceId;
  }

  /**
   * Only an active temporary session may run ordinary Drive work. The
   * uploading phase is reserved for the exact upload operation used by Finish.
   */
  private assertUsableTemporaryProvenance(
    provenance: TemporarySessionProvenance,
    operationType: DriveSyncOperationType,
  ): void {
    if (
      provenance.finishPhase !== 'active' &&
      !(provenance.finishPhase === 'uploading' && operationType === 'upload')
    ) {
      throw new WorkspaceAccountMismatchError();
    }
  }

  /**
   * Operation admission re-reads durable provenance after FIFO ownership is
   * acquired. This closes the window where another queued command could use a
   * profile that still looks valid after temporary provenance changed or was
   * lost. Normal initialized temporary sessions bind provenance before any
   * Drive operation, so an absent record also fails closed.
   */
  private async revalidateTemporaryWorkspaceAccount(
    operationType: DriveSyncOperationType,
  ): Promise<void> {
    const profile = this.requireProfile();
    if (profile.deviceMode !== 'temporary') return;
    const accountId = this.identity.accountId;
    if (!accountId) throw new WorkspaceAccountIdentityUnavailableError();
    const activeWorkspaceId = this.requireMatchingTemporaryWorkspaceId();
    const provenance = await loadTemporarySessionProvenance();
    if (!provenance) {
      throw new WorkspaceAccountMismatchError();
    }
    this.assertUsableTemporaryProvenance(provenance, operationType);
    if (
      provenance.temporarySessionId !== activeWorkspaceId ||
      (this.temporaryWorkspaceAccountId &&
        this.temporaryWorkspaceAccountId !== provenance.accountId)
    ) {
      throw new WorkspaceAccountMismatchError();
    }
    this.temporaryWorkspaceAccountId = provenance.accountId;
    this.assertTemporaryWorkspaceAccountClaim(accountId);
  }

  /**
   * Operation admission and each token handoff consult durable workspace state,
   * not only this tab's cached profile. This makes another tab's disconnect or
   * mismatched callback visible before the next Drive request can start.
   */
  private async revalidateOperationWorkspaceAccount(
    expectedAccountId: string,
    operationType: DriveSyncOperationType,
  ): Promise<void> {
    const accountIdBeforeRead = this.assertAuthorizedWorkspaceAccount();
    if (accountIdBeforeRead !== expectedAccountId) {
      throw new WorkspaceAccountMismatchError();
    }
    const profile = this.requireProfile();
    if (profile.deviceMode === 'temporary') {
      await this.revalidateTemporaryWorkspaceAccount(operationType);
    } else {
      const durableProfile = await loadPaperSyncDeviceProfile();
      if (
        durableProfile.deviceMode !== 'personal' ||
        durableProfile.workspaceAccountId !== expectedAccountId ||
        durableProfile.accountId !== expectedAccountId
      ) {
        throw new WorkspaceAccountMismatchError();
      }
    }
    if (this.identity.accountId !== expectedAccountId) {
      throw new WorkspaceAccountMismatchError();
    }
  }

  private applySecurityError(
    error: Error,
    kind: PaperSyncSecurityState['kind'],
    connection: PaperConnectionStatus = 'attention',
  ): void {
    const issue = classifyPaperCoordinatorError(error);
    this.updateView({
      connection,
      securityState: { kind } as PaperSyncSecurityState,
      autoSync: false,
      issue,
      error: issue.message,
      progress: { phase: 'idle' },
    });
  }

  private securityStateError(state: PaperSyncSecurityState): Error {
    switch (state.kind) {
      case 'device-mode-required':
        return new DeviceModeSelectionRequiredError();
      case 'public-root-missing':
        return new PublicDeviceRootMissingError();
      case 'account-association-required':
        return new WorkspaceAccountAssociationRequiredError();
      case 'account-mismatch':
        return new WorkspaceAccountMismatchError();
      case 'account-identity-unavailable':
        return new WorkspaceAccountIdentityUnavailableError();
    }
  }

  private isAutoSyncEffectivelyEnabled(): boolean {
    const profile = this.profile;
    const accountId = this.identity.accountId;
    return Boolean(
      profile?.deviceMode === 'personal' &&
      profile.autoSync &&
      !this.activeReviewedCloudIssueRevalidation() &&
      !this.isReadTimeoutRecoveryBoundaryActive() &&
      !this.restorePublicationOperation &&
      this.view.deviceModeChoiceConfirmed &&
      !this.view.securityState &&
      accountId &&
      profile.workspaceAccountId === accountId &&
      (profile.accountId === undefined || profile.accountId === accountId),
    );
  }

  private writer() {
    const profile = this.requireProfile();
    return { deviceId: profile.deviceId, deviceLabel: profile.deviceLabel };
  }

  private activeCloudIssueQuarantines(): PaperCloudIssueQuarantineEntry[] {
    const profile = this.profile;
    const accountId = this.identity.accountId;
    if (
      !profile ||
      profile.deviceMode !== 'personal' ||
      !accountId ||
      profile.accountId !== accountId ||
      profile.workspaceAccountId !== accountId ||
      !profile.rootFolderId
    ) {
      return [];
    }
    return (profile.cloudIssueQuarantines ?? []).filter(
      (entry) =>
        entry.reviewedAt === undefined &&
        entry.accountId === accountId &&
        entry.rootFolderId === profile.rootFolderId,
    );
  }

  private activeReviewedCloudIssueRevalidation():
    PaperCloudIssueQuarantineEntry | undefined {
    const profile = this.profile;
    if (
      profile?.deviceMode !== 'personal' ||
      !profile.accountId ||
      profile.workspaceAccountId !== profile.accountId ||
      !profile.rootFolderId ||
      (this.identity.accountId && this.identity.accountId !== profile.accountId)
    ) {
      return undefined;
    }
    return profile.cloudIssueQuarantines?.find(
      (entry) =>
        entry.accountId === profile.accountId &&
        entry.rootFolderId === profile.rootFolderId &&
        entry.reviewedAt !== undefined &&
        entry.revalidationPending === true,
    );
  }

  private reviewedCloudIssueRevalidationIssue(): SyncOperationalIssue | undefined {
    if (!this.activeReviewedCloudIssueRevalidation()) return undefined;
    return {
      code: 'drive-integrity-mismatch',
      message:
        'A previously ignored paper needs a complete read-only Drive check before sync can resume.',
      severity: 'warning',
      state: 'attention',
      actions: ['retry-now', 'details'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: {
        source: 'google-drive',
        operation: 'paper-presence-review-revalidation',
        phase: 'read-only-revalidation-required',
      },
    };
  }

  private assertNoReviewedCloudIssueRevalidation(): void {
    if (!this.activeReviewedCloudIssueRevalidation()) return;
    throw new PaperRepositoryError(
      'paper-presence-invalid',
      'A previously ignored paper needs a complete read-only Drive check before upload.',
      { diagnosticPhase: 'read-only-revalidation-required' },
    );
  }

  private activeQuarantinedDocumentIds(): string[] {
    return this.activeCloudIssueQuarantines()
      .map(({ documentId }) => documentId)
      .sort();
  }

  private isPaperQuarantined(documentId: string): boolean {
    return this.activeCloudIssueQuarantines().some(
      (entry) => entry.documentId === documentId,
    );
  }

  private ignoredCloudIssueView(): IgnoredPaperCloudIssue[] {
    return this.activeCloudIssueQuarantines()
      .map((entry) => ({
        documentId: entry.documentId,
        displayName:
          this.view.papers.find((paper) => paper.documentId === entry.documentId)
            ?.displayName ??
          this.paperStates.get(entry.documentId)?.displayName ??
          'Inaccessible paper',
        confirmedAt: entry.confirmedAt,
      }))
      .sort((first, second) => first.documentId.localeCompare(second.documentId));
  }

  private getDirtyPaperIds(): string[] {
    return [...this.paperStates.values()]
      .filter(
        (state) =>
          state.dirtyReasons.length > 0 &&
          state.targetedPurge === undefined &&
          !this.isPaperQuarantined(state.documentId),
      )
      .map((state) => state.documentId)
      .sort();
  }

  /**
   * Public pending state represents work that ordinary sync is actually allowed
   * to publish. A locally retained, explicitly removed paper may continue to be
   * edited, but those edits stay local until the user explicitly restores it.
   */
  private getPendingSyncPaperIds(): string[] {
    return pendingSyncPaperIds(
      [...this.paperStates.values()].filter(
        (state) => !this.isPaperQuarantined(state.documentId),
      ),
    );
  }

  private getAutoSyncEligibleDirtyPaperIds(): string[] {
    if (this.hasGlobalBlockingIssue()) return [];
    return this.getDirtyPaperIds().filter(
      (documentId) =>
        !this.activeLocalRemovalIds.has(documentId) &&
        !this.pendingLocalRemovalReconcileIds.has(documentId) &&
        !this.blockingPaperIssues.has(documentId) &&
        this.paperStates.get(documentId)?.status !== 'needs-attention' &&
        this.paperStates.get(documentId)?.cloudPresence !== 'removed',
    );
  }

  private rememberRootWidePresenceIssue(
    error: unknown,
    issue: SyncOperationalIssue,
  ): void {
    if (
      !(error instanceof PaperRepositoryError) ||
      error.code !== 'paper-presence-invalid' ||
      error.diagnosticPhase !== 'paper-presence-resolution' ||
      error.diagnosticPresenceResolutionScope !== 'all'
    ) {
      return;
    }
    const profile = this.profile;
    if (!profile?.accountId || !profile.rootFolderId) return;
    this.rootWideBlockingIssue = {
      accountId: profile.accountId,
      rootFolderId: profile.rootFolderId,
      issue,
    };
  }

  private activeRootWideBlockingIssue(): SyncOperationalIssue | undefined {
    const retained = this.rootWideBlockingIssue;
    const profile = this.profile;
    if (
      !retained ||
      !profile?.accountId ||
      !profile.rootFolderId ||
      retained.accountId !== profile.accountId ||
      retained.rootFolderId !== profile.rootFolderId
    ) {
      return undefined;
    }
    const exactDocumentId = retained.issue.diagnostic.documentId;
    if (exactDocumentId && this.isPaperQuarantined(exactDocumentId)) {
      // Keep the root-wide evidence dormant rather than discarding it. A local
      // quarantine authorizes excluding only this exact paper; reviewing it
      // again must restore the original fail-closed warning immediately.
      return undefined;
    }
    return retained.issue;
  }

  private clearRootWidePresenceIssueAfterAuthoritativeBaseline(
    rootFolderId: string,
  ): void {
    const retained = this.rootWideBlockingIssue;
    const profile = this.profile;
    if (
      retained &&
      profile?.accountId === retained.accountId &&
      rootFolderId === retained.rootFolderId &&
      profile.rootFolderId === retained.rootFolderId
    ) {
      this.rootWideBlockingIssue = undefined;
    }
  }

  private firstBlockingPaperIssue(): SyncOperationalIssue | undefined {
    return (
      this.activeRootWideBlockingIssue() ??
      this.reviewedCloudIssueRevalidationIssue() ??
      [...this.blockingPaperIssues.entries()].find(
        ([documentId]) => !this.isPaperQuarantined(documentId),
      )?.[1].issue
    );
  }

  private connectionAfterPaperSettlement(
    issue: SyncOperationalIssue | undefined,
  ): PaperConnectionStatus {
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return 'offline';
    const rootWideIssue = this.activeRootWideBlockingIssue();
    if (rootWideIssue) return connectionForIssue(rootWideIssue);
    if (!issue) return 'connected';
    return [...this.blockingPaperIssues.entries()].some(
      ([documentId, paperIssue]) =>
        !this.isPaperQuarantined(documentId) && paperIssue.issue === issue,
    )
      ? 'connected'
      : connectionForIssue(issue);
  }

  private hasGlobalBlockingIssue(): boolean {
    if (this.activeReviewedCloudIssueRevalidation()) return true;
    const activeRootWideIssue = this.activeRootWideBlockingIssue();
    if (activeRootWideIssue?.blocksOrdinarySync) return true;
    const issue = this.view.issue;
    if (!issue?.blocksOrdinarySync) return false;
    if (
      this.rootWideBlockingIssue?.issue === issue &&
      activeRootWideIssue === undefined
    ) {
      // The retained root evidence is either outside the current account/root
      // or dormant behind the exact user-confirmed local quarantine. Do not let
      // its stale presentation block unrelated ordinary sync.
      return false;
    }
    return ![...this.blockingPaperIssues.values()].some(
      (paperIssue) => paperIssue.issue === issue,
    );
  }

  private refreshStateView(papers = this.view.papers): void {
    const states = [...this.paperStates.values()].sort((a, b) =>
      a.documentId.localeCompare(b.documentId),
    );
    this.updateView(
      {
        papers: [...papers],
        paperStates: states,
        dirtyPaperIds: this.getPendingSyncPaperIds(),
        ignoredCloudIssues: this.ignoredCloudIssueView(),
        reviewedCloudIssueRevalidationPending: Boolean(
          this.activeReviewedCloudIssueRevalidation(),
        ),
      },
      { notify: false },
    );
  }

  private applyPaperProgress(
    progress: PaperTransferProgress,
    completedPapers: number,
    totalPapers: number,
  ): void {
    const phase = progress.phase === 'resolving' ? 'discovering' : progress.phase;
    // A single byte counter cannot truthfully represent interleaved concurrent
    // paper transfers. Keep exact byte progress for a one-paper operation and
    // use the authoritative completed-paper count for multi-paper batches.
    const byteProgress =
      totalPapers === 1
        ? {
            bytesCompleted: progress.bytesCompleted,
            bytesTotal: progress.bytesTotal,
          }
        : {};
    this.updateView(
      {
        progress: {
          phase:
            phase === 'downloading' ||
            phase === 'uploading' ||
            phase === 'publishing' ||
            phase === 'verifying'
              ? phase
              : 'merging',
          completed: completedPapers,
          total: totalPapers,
          ...byteProgress,
          detail: progress.detail,
        },
      },
      { notify: false },
    );
  }

  private async markPaperFailure(
    documentId: string,
    error: unknown,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<SyncOperationalIssue> {
    const classifiedIssue = classifyPaperCoordinatorError(error);
    const issue =
      isTargetedPaperPurgeCandidate(classifiedIssue) &&
      !classifiedIssue.diagnostic.documentId
        ? {
            ...classifiedIssue,
            diagnostic: {
              ...classifiedIssue.diagnostic,
              documentId,
            },
          }
        : classifiedIssue;
    const paperScopedBlock = isPaperScopedBlockingFailure(error, issue);
    const state = this.paperStates.get(documentId);
    const previousPaperState = state?.status;
    const previousBlockingIssue = this.blockingPaperIssues.get(documentId);
    const retryOperation = failedPaperRetryOperation(state, previousPaperState, issue);
    if (issue.retrySafe || paperScopedBlock) {
      this.paperRetryIntents.set(documentId, retryOperation);
    } else {
      this.paperRetryIntents.delete(documentId);
    }
    if (state) {
      state.status = paperStatusAfterFailure(state, paperScopedBlock);
      if (state.status !== previousPaperState) {
        this.drive?.recordOperationStateTransition?.({
          phase: 'paper-failure-settlement',
          transition: 'paper-state-updated',
          documentId,
          previousPaperState,
          nextPaperState: state.status,
          issueCode: issue.code,
          outcome: 'failed',
          classification: paperScopedBlock
            ? 'blocking-paper-failure'
            : 'transient-paper-failure',
        });
      }
      await savePaperSyncState(state, workspaceLease).catch(() => undefined);
    }
    if (paperScopedBlock) {
      this.blockingPaperIssues.set(documentId, {
        headSetId: this.view.papers.find((paper) => paper.documentId === documentId)
          ?.headSetId,
        issue,
      });
    } else {
      this.blockingPaperIssues.delete(documentId);
    }
    const createdBlockingIssue =
      paperScopedBlock && previousBlockingIssue?.issue.code !== issue.code;
    this.drive?.recordOperationStateTransition?.({
      phase: 'paper-failure-settlement',
      transition: createdBlockingIssue
        ? 'paper-issue-created'
        : 'operation-issue-observed',
      documentId,
      ...(previousPaperState ? { previousPaperState } : {}),
      ...(state?.status ? { nextPaperState: state.status } : {}),
      issueCode: issue.code,
      outcome: 'failed',
      classification: createdBlockingIssue
        ? 'blocking-paper-issue-created'
        : paperScopedBlock
          ? 'blocking-paper-issue-observed'
          : 'transient-operation-issue',
    });
    this.refreshStateView(
      this.view.papers.map((paper) => {
        if (paper.documentId !== documentId) return paper;
        const paperWithoutIssue = { ...paper };
        delete paperWithoutIssue.issue;
        return {
          ...paperWithoutIssue,
          status: paperScopedBlock
            ? ('needs-attention' as const)
            : (state?.status ?? paper.status),
          ...(paperScopedBlock
            ? { issue: { code: issue.code, message: issue.message } }
            : {}),
        };
      }),
    );
    return issue;
  }

  private applyError(error: unknown, notify = true): void {
    if (error instanceof DOMException && error.name === 'AbortError') {
      this.updateView({
        connection: this.identity.hasDeviceSession ? 'connected' : 'disconnected',
        progress: { phase: 'idle' },
      });
      return;
    }
    const securityKind = securityStateKindForError(error);
    if (securityKind) {
      const issue = classifyPaperCoordinatorError(error);
      this.updateView(
        {
          connection:
            securityKind === 'device-mode-required' ? 'disconnected' : 'attention',
          securityState: { kind: securityKind } as PaperSyncSecurityState,
          autoSync: false,
          issue,
          error: issue.message,
          progress: { phase: 'idle' },
        },
        { notify },
      );
      return;
    }
    if (error instanceof PaperRepositoryError) {
      const issue = classifyPaperCoordinatorError(error);
      this.rememberRootWidePresenceIssue(error, issue);
      const connection: PaperConnectionStatus =
        error.code === 'layout-upgrade-required'
          ? 'layout-upgrade-required'
          : error.code === 'layout-migration-incomplete'
            ? 'migration-incomplete'
            : error.code === 'drive-root-missing' || error.code === 'drive-root-invalid'
              ? 'root-unavailable'
              : connectionForIssue(issue);
      this.updateView(
        {
          connection,
          issue,
          error: issue.message,
          progress: { phase: 'idle' },
        },
        { notify },
      );
      return;
    }
    const issue = classifyPaperCoordinatorError(error);
    this.updateView(
      {
        connection: connectionForIssue(issue),
        issue,
        error: issue.message,
        progress: { phase: 'idle' },
      },
      { notify },
    );
  }

  private async beginOperation(
    operationType: DriveSyncOperationType = 'other',
    mayHaveMutated = driveOperationMayHaveMutated(operationType),
    timeoutVisibility: DriveOperationTimeoutVisibility = 'global',
    assertAfterOwnership?: () => void,
  ): Promise<AbortSignal> {
    const queued = this.operationOwner.active;
    const signal = await this.operationOwner.begin();
    try {
      assertAfterOwnership?.();
    } catch (error) {
      this.operationOwner.end(signal);
      throw error;
    }
    this.startDriveOperationWatchdog(
      signal,
      operationType,
      mayHaveMutated,
      timeoutVisibility,
    );
    let workspaceLeaseHandle: HeldWorkspaceRestoreLease | undefined;
    try {
      // Revalidate after FIFO ownership is acquired. A queued command must not
      // inherit a different or no-longer-trusted account session while waiting.
      const accountId = this.assertAuthorizedWorkspaceAccount();
      await awaitDriveOperationDeadline(
        this.revalidateOperationWorkspaceAccount(accountId, operationType),
        signal,
      );
      signal.throwIfAborted();
      // FIFO ownership precedes workspace-lock acquisition. Holding a shared
      // lock while queued behind another FIFO owner could starve an exclusive
      // restore request and deadlock nested persistence work.
      workspaceLeaseHandle = await acquireSharedWorkspaceRestoreLease(signal);
      signal.throwIfAborted();
      await awaitDriveOperationDeadline(
        this.assertWorkspaceMutationAdmission(workspaceLeaseHandle.lease),
        signal,
      );
      signal.throwIfAborted();
      await awaitDriveOperationDeadline(
        this.revalidateOperationWorkspaceAccount(accountId, operationType),
        signal,
      );
      signal.throwIfAborted();
      this.activeDriveOperationIdentityFence = {
        signal,
        accountId,
        operationType,
        workspaceLease: workspaceLeaseHandle.lease,
        workspaceLeaseHandle,
      };
      const drive = this.requireDrive();
      const operationId = drive.beginOperationTelemetry(operationType);
      this.operationTelemetryIds.set(signal, operationId);
      drive.recordOperationStateTransition({
        phase: 'operation-owner',
        transition: 'operation-owner-acquired',
        outcome: 'succeeded',
        classification: queued ? 'queued' : 'immediate',
      });
      this.markDriveOperationRunning(signal);
      return signal;
    } catch (error) {
      const settledError = signal.aborted ? (signal.reason ?? error) : error;
      if (this.activeDriveOperationIdentityFence?.signal === signal) {
        this.activeDriveOperationIdentityFence = undefined;
      }
      this.clearDriveOperationWatchdog(signal);
      workspaceLeaseHandle?.release();
      await workspaceLeaseHandle?.settled.catch(() => undefined);
      this.operationOwner.end(signal);
      throw settledError;
    }
  }

  /**
   * Retains one logical paper command in the workspace service rather than in
   * the React surface that submitted it. Repeated submissions of the same
   * command rejoin the existing Promise, which prevents a Home remount from
   * starting a second mutation while the first one is still in flight.
   */
  private retainPaperOperation<T>(
    type: PaperActiveOperationType,
    documentIds: readonly string[],
    start: () => Promise<T>,
  ): Promise<T> {
    if (this.driveOperationSuspensionCount > 0) {
      return Promise.reject(
        new DOMException('Google Drive session is closing.', 'AbortError'),
      );
    }
    const normalizedIds = [...new Set(documentIds)].sort();
    const key = `${type}\u0000${normalizedIds.join('\u0000')}`;
    const existing = this.activePaperOperationTasks.get(key);
    if (existing) return existing.promise as Promise<T>;

    const operation: PaperActiveOperation = {
      id: `paper-operation-${++this.paperOperationSequence}`,
      type,
      documentIds: normalizedIds,
      startedAt: Date.now(),
    };
    const promise = Promise.resolve()
      .then(start)
      .finally(() => {
        if (this.activePaperOperationTasks.get(key)?.promise !== promise) return;
        this.activePaperOperationTasks.delete(key);
        this.publishActivePaperOperations();
      });
    this.activePaperOperationTasks.set(key, { operation, promise });
    this.publishActivePaperOperations();
    return promise;
  }

  private async withDriveOperationsQuiesced<T>(
    reason: DOMException,
    task: () => Promise<T>,
  ): Promise<T> {
    this.driveOperationSuspensionCount += 1;
    const activeTasks = [...this.activePaperOperationTasks.values()].map(
      ({ promise }) => promise,
    );
    const ownerDrain = this.operationOwner.suspendAndDrain(reason);
    try {
      await Promise.all([ownerDrain, Promise.allSettled(activeTasks)]);
      return await task();
    } finally {
      this.operationOwner.resume();
      this.driveOperationSuspensionCount = Math.max(
        0,
        this.driveOperationSuspensionCount - 1,
      );
    }
  }

  private clearDriveOperationDiagnostics(): void {
    this.lastDriveOperationDiagnostic = undefined;
    this.recentDriveOperationDiagnostics.length = 0;
    if (this.view.lastDriveOperationTimeout) {
      this.updateView({ lastDriveOperationTimeout: undefined }, { notify: false });
    }
  }

  private expireTargetedPaperPurgePreviews(now = Date.now()): void {
    for (const [token, preview] of this.targetedPaperPurgePreviews) {
      if (now - preview.createdAt > TARGETED_PURGE_PREVIEW_TTL) {
        this.targetedPaperPurgePreviews.delete(token);
      }
    }
  }

  private activePaperTransferPromises(): Promise<unknown>[] {
    return [...this.activePaperOperationTasks.values()]
      .filter(
        ({ operation }) => operation.type === 'download' || operation.type === 'upload',
      )
      .map(({ promise }) => promise);
  }

  private publishActivePaperOperations(): void {
    this.updateView(
      {
        activePaperOperations: [...this.activePaperOperationTasks.values()]
          .map(({ operation }) => operation)
          .sort(
            (first, second) =>
              first.startedAt - second.startedAt || first.id.localeCompare(second.id),
          ),
      },
      { notify: false },
    );
  }

  private startDriveOperationWatchdog(
    signal: AbortSignal,
    operationType: DriveSyncOperationType,
    mayHaveMutated = driveOperationMayHaveMutated(operationType),
    timeoutVisibility: DriveOperationTimeoutVisibility = 'global',
  ): void {
    const startedAt = Date.now();
    const timeoutMs = driveOperationTimeoutMs(operationType, mayHaveMutated);
    const diagnostic: ActiveDriveOperationDiagnostic = {
      operationType,
      stage: 'admission',
      startedAt,
      deadlineAt: startedAt + timeoutMs,
      pendingRequestCount: 0,
      completedRequestCount: 0,
    };
    this.operationWatchdogs.set(signal, {
      diagnostic,
      idleTimeoutMs: timeoutMs,
      hardDeadlineAt:
        startedAt + (mayHaveMutated ? timeoutMs : DRIVE_READ_OPERATION_HARD_TIMEOUT),
      mayHaveMutated,
      timeoutVisibility,
    });
    this.armDriveOperationWatchdog(signal, diagnostic.deadlineAt);
  }

  private armDriveOperationWatchdog(
    signal: AbortSignal,
    requestedDeadlineAt: number,
  ): void {
    const active = this.operationWatchdogs.get(signal);
    if (!active || active.diagnostic.stage === 'timed-out') return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    const deadlineAt = Math.min(requestedDeadlineAt, active.hardDeadlineAt);
    active.diagnostic = { ...active.diagnostic, deadlineAt };
    const timer = setTimeout(
      () => this.expireDriveOperationWatchdog(signal, timer, deadlineAt),
      Math.max(0, deadlineAt - Date.now()),
    );
    active.timer = timer;
    this.updateView({ activeDriveOperation: active.diagnostic }, { notify: false });
  }

  private expireDriveOperationWatchdog(
    signal: AbortSignal,
    timer: ReturnType<typeof setTimeout>,
    deadlineAt: number,
  ): void {
    const active = this.operationWatchdogs.get(signal);
    if (!active || active.timer !== timer || active.diagnostic.stage === 'timed-out') {
      return;
    }
    const operationType = active.diagnostic.operationType;
    const timedOutFromStage =
      active.diagnostic.stage === 'admission' ? 'admission' : 'running';
    const hardReadDeadlineExceeded =
      !active.mayHaveMutated &&
      timedOutFromStage === 'running' &&
      deadlineAt >= active.hardDeadlineAt;
    const effectiveTimeoutMs = hardReadDeadlineExceeded
      ? DRIVE_READ_OPERATION_HARD_TIMEOUT
      : active.idleTimeoutMs;
    const timeoutError = new DriveOperationTimeoutError(
      operationType,
      effectiveTimeoutMs,
      active.mayHaveMutated,
      operationType === 'scan' &&
        hardReadDeadlineExceeded &&
        active.diagnostic.completedRequestCount > 0 &&
        this.profile !== null &&
        this.currentDriveAuditCheckpoint() !== undefined,
    );
    const timeoutDiagnostic: DriveOperationTimeoutDiagnostic = {
      operationType,
      timedOutFromStage,
      failureCode:
        timedOutFromStage === 'admission'
          ? 'admission-deadline-exceeded'
          : hardReadDeadlineExceeded
            ? 'read-operation-hard-deadline-exceeded'
            : active.diagnostic.pendingRequestCount > 0
              ? 'drive-request-in-flight-deadline-exceeded'
              : 'running-without-request-in-flight-deadline-exceeded',
      timedOutAt: Date.now(),
      pendingRequestCount: active.diagnostic.pendingRequestCount,
      completedRequestCount: active.diagnostic.completedRequestCount,
      observedPhases: [],
    };
    active.timeoutDiagnostic = timeoutDiagnostic;
    active.diagnostic = { ...active.diagnostic, stage: 'timed-out' };
    this.updateView(
      {
        activeDriveOperation: active.diagnostic,
        lastDriveOperationTimeout: timeoutDiagnostic,
      },
      { notify: false },
    );
    this.operationOwner.cancel(timeoutError);
    // An abort-insensitive local read can keep the owning async function from
    // reaching its catch/finally block. Global operations leave "syncing" at
    // the deadline without releasing ownership or claiming that an uncertain
    // remote mutation stopped. Optional diagnostics report their failure only
    // inside their own fail-closed result and must not poison connection state.
    if (active.timeoutVisibility === 'global') {
      this.clearScheduledAutoUpload();
      this.applyError(timeoutError);
    }
  }

  private markDriveOperationRunning(signal: AbortSignal): void {
    const active = this.operationWatchdogs.get(signal);
    if (!active || active.diagnostic.stage === 'timed-out') return;
    const enteredRunning = active.diagnostic.stage !== 'running';
    active.diagnostic = { ...active.diagnostic, stage: 'running' };
    if (enteredRunning && !active.mayHaveMutated) {
      this.armDriveOperationWatchdog(signal, Date.now() + active.idleTimeoutMs);
    } else {
      this.updateView({ activeDriveOperation: active.diagnostic }, { notify: false });
    }
  }

  private clearDriveOperationWatchdog(signal: AbortSignal): void {
    const active = this.operationWatchdogs.get(signal);
    if (!active) return;
    if (active.timer !== undefined) clearTimeout(active.timer);
    this.operationWatchdogs.delete(signal);
    if (this.view.activeDriveOperation === active.diagnostic) {
      this.updateView({ activeDriveOperation: undefined }, { notify: false });
    }
  }

  private updateDriveRequestActivity(activity: DriveRequestActivity): void {
    const signal = this.activeDriveOperationIdentityFence?.signal;
    if (!signal) return;
    const active = this.operationWatchdogs.get(signal);
    if (!active || active.diagnostic.stage === 'timed-out') return;
    const madeProgress =
      activity.completedRequestCount > active.diagnostic.completedRequestCount;
    active.diagnostic = {
      ...active.diagnostic,
      pendingRequestCount: activity.pendingRequestCount,
      completedRequestCount: activity.completedRequestCount,
    };
    if (
      madeProgress &&
      active.diagnostic.stage === 'running' &&
      !active.mayHaveMutated
    ) {
      this.armDriveOperationWatchdog(signal, Date.now() + active.idleTimeoutMs);
    } else {
      this.updateView({ activeDriveOperation: active.diagnostic }, { notify: false });
    }
  }

  private endOperation(signal: AbortSignal): void {
    const operationId = this.operationTelemetryIds.get(signal);
    const timeoutDiagnostic = this.operationWatchdogs.get(signal)?.timeoutDiagnostic;
    this.clearDriveOperationWatchdog(signal);
    if (this.activeDriveOperationIdentityFence?.signal === signal) {
      this.activeDriveOperationIdentityFence.workspaceLeaseHandle.release();
      this.activeDriveOperationIdentityFence = undefined;
    }
    this.operationOwner.end(signal);
    if (operationId && this.drive) {
      this.drive.recordOperationStateTransition({
        phase: 'operation-owner',
        transition: 'operation-owner-released',
        outcome: signal.aborted ? 'failed' : 'succeeded',
        classification: signal.aborted ? 'aborted' : 'completed',
      });
      const snapshot = this.drive.finishOperationTelemetry(operationId);
      if (snapshot) {
        this.lastDriveOperationDiagnostic = summarizeDriveOperationTelemetry(snapshot);
        if (
          timeoutDiagnostic &&
          this.view.lastDriveOperationTimeout === timeoutDiagnostic
        ) {
          this.updateView(
            {
              lastDriveOperationTimeout: {
                ...timeoutDiagnostic,
                observedPhases: this.lastDriveOperationDiagnostic.phases.map(
                  ({ phase, elapsedMs, requestCount, retryCount }) => ({
                    phase,
                    elapsedMs,
                    requestCount,
                    retryCount,
                  }),
                ),
              },
            },
            { notify: false },
          );
        }
        this.recentDriveOperationDiagnostics.push(this.lastDriveOperationDiagnostic);
        if (
          this.recentDriveOperationDiagnostics.length > RECENT_DRIVE_DIAGNOSTIC_LIMIT
        ) {
          this.recentDriveOperationDiagnostics.splice(
            0,
            this.recentDriveOperationDiagnostics.length - RECENT_DRIVE_DIAGNOSTIC_LIMIT,
          );
        }
        if (import.meta.env.DEV) {
          // Development-only and fully redacted: no URLs, queries, bodies, or tokens.
          console.debug(
            formatDriveOperationDiagnostic(this.lastDriveOperationDiagnostic),
          );
        }
      }
      this.operationTelemetryIds.delete(signal);
    }
  }

  private requireWorkspaceLease(signal: AbortSignal): WorkspaceRestoreLease {
    const fence = this.activeDriveOperationIdentityFence;
    if (!fence || fence.signal !== signal) {
      throw new WorkspaceAccountIdentityUnavailableError();
    }
    assertWorkspaceRestoreLease(fence.workspaceLease, { allowExclusive: true });
    return fence.workspaceLease;
  }

  private assertWorkspaceMutationAdmission(
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void> {
    return assertWorkspaceCloudOperationAllowed(workspaceLease).then(() => undefined);
  }

  private runWorkspaceMutation<T>(
    task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
    existingLease?: WorkspaceRestoreLease,
  ): Promise<T> {
    return withWorkspaceMutation(task, existingLease);
  }

  private updateView(
    update: Partial<PaperSyncViewState>,
    options: { notify?: boolean; actualWork?: boolean } = {},
  ): void {
    const previousStatus = getPaperSyncUiStatus(this.view);
    this.view = { ...this.view, ...update };
    if (options.notify !== false) {
      this.soundFeedback.notify({
        id: ++this.soundSequence,
        previousStatus,
        currentStatus: getPaperSyncUiStatus(this.view),
        actualWork: options.actualWork === true,
      });
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.view);
  }

  private async legacyDriveHousekeepingOptions() {
    const migration = await loadLayoutMigrationRecord();
    return {
      migrationInProgress: migration !== null,
      protectedLegacyFileIds: migration?.verifiedLegacyFileIds ?? [],
    };
  }

  private requireProfile(): PaperSyncDeviceProfile {
    if (!this.profile) throw new Error('Google Drive sync is not initialized.');
    return this.profile;
  }

  private handleOnline = () => {
    if (
      !this.identity.hasDeviceSession ||
      !this.view.deviceModeChoiceConfirmed ||
      this.view.securityState ||
      this.restorePublicationOperation
    )
      return;
    const recoveringTimedOutRead = this.isReadTimeoutRecoveryBoundaryActive();
    const scan = recoveringTimedOutRead
      ? this.scanCloudPapersUsingVerifiedRepository()
      : this.scanCloudPapers();
    void scan
      .then(() => {
        this.transientRetryAttempt = 0;
        // The first transition out of a read timeout only re-establishes the
        // authoritative Drive boundary. Existing dirty work needs a later,
        // separately visible publication trigger.
        if (recoveringTimedOutRead) return;
        if (
          this.isAutoSyncEffectivelyEnabled() &&
          this.getAutoSyncEligibleDirtyPaperIds().length
        ) {
          this.scheduleAutoUpload();
        }
      })
      .catch((error) => {
        this.scheduleDirtyFollowUp([classifyPaperCoordinatorError(error)]);
      });
  };

  private handleOffline = () => {
    this.applyError(new TypeError('Offline'));
  };
}

function securityStateKindForError(
  error: unknown,
): PaperSyncSecurityState['kind'] | undefined {
  if (error instanceof DeviceModeSelectionRequiredError) return 'device-mode-required';
  if (error instanceof PublicDeviceRootMissingError) return 'public-root-missing';
  if (error instanceof WorkspaceAccountAssociationRequiredError) {
    return 'account-association-required';
  }
  if (
    error instanceof WorkspaceAccountMismatchError ||
    error instanceof WorkspaceAccountBindingConflictError
  ) {
    return 'account-mismatch';
  }
  if (error instanceof WorkspaceAccountIdentityUnavailableError) {
    return 'account-identity-unavailable';
  }
  return undefined;
}

/**
 * Released clients stored the verified session account but not a dedicated
 * workspace binding. An account ID is promotable only when the old account
 * switch path could not have produced it: that path deleted both the selected
 * root and its cursor before writing the new account ID.
 */
export function trustedLegacyWorkspaceAccountId(
  profile: PaperSyncDeviceProfile,
): string | undefined {
  // This compatibility promotion is intentionally one-shot. Once the new
  // explicit device-mode gate has touched a profile, a later OAuth callback's
  // accountId must never be reinterpreted as legacy root-bound evidence on
  // reload; populated unbound workspaces still require explicit adoption.
  if (
    profile.deviceMode !== 'personal' ||
    profile.deviceModeChoiceConfirmed === true ||
    !profile.rootFolderId
  ) {
    return undefined;
  }
  const cursor = profile.driveChangeCursor;
  if (
    cursor &&
    cursor.deviceMode === 'personal' &&
    cursor.rootFolderId === profile.rootFolderId
  ) {
    return cursor.accountId;
  }
  return profile.accountId;
}

export class TemporaryDirtyWorkError extends Error {
  readonly documentIds: string[];

  constructor(documentIds: readonly string[]) {
    super(
      'Unsynced work remains on this temporary device. Confirm before leaving it behind.',
    );
    this.name = 'TemporaryDirtyWorkError';
    this.documentIds = [...documentIds];
  }
}

export class OfficeNativePaperProductDisabledError extends Error {
  readonly documentId: string;

  constructor(documentId: string) {
    super(
      'This experimental Office-native paper was preserved, but direct Office sync is no longer available. Convert the original DOCX or PPTX to PDF and add that PDF as a new paper.',
    );
    this.name = 'OfficeNativePaperProductDisabledError';
    this.documentId = documentId;
  }
}

export function assertPdfOnlyCloudPaper(paper: PaperCloudSummary): void {
  if (paper.sourceArtifact?.documentType !== 'pdf') {
    throw new OfficeNativePaperProductDisabledError(paper.documentId);
  }
}

export function assertPdfOnlyLocalPublication(
  local: LocalPaperPackage,
  cloud?: PaperCloudSummary,
): void {
  const sourceType =
    local.sourceArtifact?.documentType ?? cloud?.sourceArtifact?.documentType;
  if (sourceType && sourceType !== 'pdf') {
    throw new OfficeNativePaperProductDisabledError(local.documentId);
  }
}

function mapDirtyReasons(detail: PersistentChangeDetail): PaperDirtyReason[] {
  const mapped = detail.categories?.map((category): PaperDirtyReason => category);
  if (mapped?.length) return mapped;
  if (detail.kind === 'pdf') return ['source-pdf'];
  if (detail.kind === 'productivity') return ['print-draft'];
  if (detail.kind === 'library') return ['metadata'];
  return ['notes', 'annotations', 'glossary', 'metadata'];
}

function connectionForIssue(issue: SyncOperationalIssue): PaperConnectionStatus {
  if (issue.state === 'offline') return 'offline';
  if (issue.state === 'disconnected') return 'disconnected';
  if (
    issue.code === 'google-authorization-required' ||
    issue.actions.includes('reconnect')
  )
    return 'reconnect-required';
  return issue.state === 'pending' ? 'connected' : 'attention';
}

function isPaperScopedBlockingFailure(
  error: unknown,
  issue: SyncOperationalIssue,
): boolean {
  if (!issue.blocksOrdinarySync) return false;
  if (
    error instanceof PaperRepositoryError &&
    [
      'drive-root-invalid',
      'drive-root-missing',
      'layout-upgrade-required',
      'layout-migration-incomplete',
      'layout-migration-proof-invalid',
      'unsupported-layout',
      'unsupported-protocol',
    ].includes(error.code)
  ) {
    return false;
  }
  return ![
    'google-authorization-required',
    'authorization-cancelled',
    'authorization-failed',
    'sync-service-unavailable',
    'sync-service-rate-limited',
    'drive-storage-full',
    'drive-rate-limited',
    'drive-backend-unavailable',
    'drive-access-denied',
    'drive-root-missing',
    'drive-root-ambiguous',
    'reset-incomplete',
    'layout-upgrade-failed',
    'sync-not-configured',
  ].includes(issue.code);
}

function failedPaperRetryOperation(
  state: PaperSyncState | undefined,
  previousStatus: PaperSyncState['status'] | undefined,
  issue: SyncOperationalIssue,
): PaperRetryOperation {
  if (issue.code === 'drive-mutation-uncertain') return 'revalidate';
  if (state?.cloudPresence === 'removed' && state.cloudCleanupPending) {
    return 'remove-cleanup';
  }
  if (previousStatus === 'uploading') return 'upload';
  if (previousStatus === 'downloading') return 'download';
  const operation = issue.diagnostic.operation?.toLocaleLowerCase('en-US') ?? '';
  if (operation.includes('upload') || operation.includes('publish')) return 'upload';
  if (operation.includes('download')) return 'download';
  return 'revalidate';
}

function persistedPaperAttentionIssue(documentId: string): SyncOperationalIssue {
  return {
    code: 'drive-integrity-mismatch',
    message: 'Drive paper data needs verification.',
    severity: 'error',
    state: 'attention',
    actions: ['retry-now', 'details'],
    retrySafe: true,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-validation',
      documentId,
    },
  };
}

function authoritativePaperAttentionIssue(
  paper: Pick<PaperCloudSummary, 'documentId' | 'issue'>,
): SyncOperationalIssue {
  const operation = paper.issue?.code ?? 'paper-validation';
  const retrySafe = operation === 'paper-snapshot-unstable';
  const messages: Record<string, string> = {
    'ambiguous-paper-folder': 'Multiple Drive folders claim the same paper.',
    'paper-integrity-failed': 'Drive paper data needs verification.',
    'paper-source-pdf-conflict': 'The paper source PDF conflicts with Drive.',
    'paper-presence-invalid': 'Drive paper presence data needs verification.',
    'paper-snapshot-unstable':
      'This Drive paper kept changing during download. Try again when edits settle.',
    'unsupported-layout': 'This paper was created by a newer 39Note version.',
    'unsupported-protocol':
      'This 39Note version is too old to access this Drive paper. Open the latest 39Note version. Do not attempt another Drive upgrade.',
  };
  return {
    code: 'drive-integrity-mismatch',
    message:
      messages[operation] ??
      paper.issue?.message ??
      'Drive paper data needs verification.',
    severity: 'error',
    state: 'attention',
    actions: retrySafe ? ['retry-now', 'details'] : ['details'],
    retrySafe,
    blocksOrdinarySync: true,
    backupRecommended: operation === 'paper-source-pdf-conflict',
    diagnostic: {
      source: 'google-drive',
      operation,
      documentId: paper.documentId,
      ...(paper.issue?.phase ? { phase: paper.issue.phase } : {}),
      ...(paper.issue?.causeCode ? { causeCode: paper.issue.causeCode } : {}),
    },
  };
}

function migrationProof(record: LayoutMigrationRecord): PaperLayoutMigrationProof {
  if (record.phase !== 'publishing-papers' && record.phase !== 'activating-layout') {
    throw new PaperRepositoryError(
      'layout-migration-proof-invalid',
      'The Drive layout migration checkpoint has an unsupported phase.',
    );
  }
  return {
    recordId: 'layout',
    rootFolderId: record.rootFolderId,
    phase: record.phase,
    targetDocumentIds: record.targetDocumentIds,
    publishedDocumentIds: record.publishedDocumentIds,
    publishedGenerationIds: record.publishedGenerationIds,
    verifiedLegacyFileIds: record.verifiedLegacyFileIds,
  };
}

function sameIdentitySet(first: readonly string[], second: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
}

function userMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Google Drive sync could not complete. Local work remains available.';
}

function legacyHousekeepingMessage(
  error: unknown,
  operation: 'check' | 'cleanup',
): string {
  if (
    operation === 'check' &&
    error instanceof DriveOperationTimeoutError &&
    !error.mayHaveMutated
  ) {
    return 'The read-only legacy check reached its safety deadline. No Google Drive data was changed.';
  }
  if (error instanceof LegacyDriveCleanupRefusedError && error.message.trim()) {
    return error.message;
  }
  const issue = classifyPaperCoordinatorError(error);
  if (issue.code !== 'unexpected-sync-failure') return issue.message;
  return operation === 'check'
    ? 'Legacy Drive data could not be checked. Nothing was changed.'
    : 'Legacy Drive cleanup did not finish. Remaining data was preserved.';
}

function paperFolderNameMaintenanceMessage(
  error: unknown,
  operation: 'preview' | 'normalize',
): string {
  if (
    operation === 'preview' &&
    error instanceof DriveOperationTimeoutError &&
    !error.mayHaveMutated
  ) {
    return 'The read-only folder-name preview reached its safety deadline. No Google Drive data was changed.';
  }
  if (
    (error instanceof PaperFolderNameNormalizationRefusedError ||
      error instanceof LegacyDriveCleanupRefusedError) &&
    error.message.trim()
  ) {
    return error.message;
  }
  const issue = classifyPaperCoordinatorError(error);
  if (issue.code !== 'unexpected-sync-failure') return issue.message;
  return operation === 'preview'
    ? 'Paper folder names could not be previewed. Nothing was changed.'
    : 'Paper folder name normalization did not finish. Remaining names were preserved.';
}

function rootUrl(rootFolderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(rootFolderId)}`;
}

let singleton: PaperGoogleDriveSyncCoordinator | null = null;

export function getPaperGoogleDriveSyncCoordinator(): PaperGoogleDriveSyncCoordinator {
  singleton ??= new PaperGoogleDriveSyncCoordinator();
  return singleton;
}
