import {
  flushLocalPersistence,
  subscribeToPersistentChanges,
  type PersistentChangeDetail,
} from '../services/persistentChange.ts';
import {
  DriveClient,
  DriveRequestError,
  type DriveFileMetadata,
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
  type PaperV3MigrationSeed,
} from './paperDriveRepository.ts';
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
import {
  clearLayoutMigrationRecord,
  clearPaperV3MigrationRecord,
  createDefaultPaperSyncState,
  deletePaperSyncRecords,
  loadLayoutMigrationRecord,
  loadPaperV3MigrationRecord,
  loadCloudPaperCatalog,
  loadPaperSyncDeviceProfile,
  loadPaperSyncStates,
  saveCloudPaperCatalog,
  saveLayoutMigrationRecord,
  savePaperV3MigrationRecord,
  savePaperSyncDeviceProfile,
  savePaperSyncState,
  savePaperSyncStates,
  type LayoutMigrationRecord,
  type PaperV3MigrationRecord,
  type PaperSyncDeviceProfile,
  type SyncDeviceMode,
} from './storage.ts';
import {
  KeyedSingleFlight,
  mapWithConcurrency,
  PAPER_TRANSFER_CONCURRENCY,
  settleIndependentOperations,
} from './syncConcurrency.ts';
import { getSyncSoundFeedback, type SyncSoundFeedback } from './syncSounds.ts';
import {
  beginTemporaryWorkspace,
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

export interface PaperSyncViewState {
  connection: PaperConnectionStatus;
  backendConfigured: boolean;
  deviceMode: SyncDeviceMode;
  autoSync: boolean;
  papers: PaperCloudSummary[];
  paperStates: PaperSyncState[];
  dirtyPaperIds: string[];
  sessions: GoogleDeviceSessionSummary[];
  rootChoices: DriveFileMetadata[];
  rootUrl?: string;
  lastSuccessfulAt?: number;
  progress: SyncProgress;
  /**
   * View-independent Drive tasks currently owned by this workspace coordinator.
   * React surfaces observe this list; subscribing or unsubscribing never owns or
   * cancels the underlying task.
   */
  activePaperOperations: PaperActiveOperation[];
  issue?: SyncOperationalIssue;
  error?: string;
  reminder?: RemoteUpdateReminder;
  publicDeviceNotice?: string;
  legacyHousekeeping: LegacyDriveHousekeepingViewState;
  folderNameMaintenance: PaperFolderNameMaintenanceViewState;
  /** Selects the only safe explicit upgrade flow for the detected root. */
  layoutUpgradeKind?: 'legacy-to-v2' | 'v2-to-v3';
}

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
  return new Set([
    ...state.papers
      .filter((paper) => paper.status === 'needs-attention')
      .map(({ documentId }) => documentId),
    ...state.paperStates
      .filter((paper) => paper.status === 'needs-attention')
      .map(({ documentId }) => documentId),
  ]).size;
}

export function getPaperSyncUiStatus(state: PaperSyncViewState): PaperSyncUiStatus {
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
  if (state.dirtyPaperIds.length > 0) return 'pending';
  if (
    state.paperStates.some(
      (paper) =>
        paper.status === 'remote-update-available' || paper.status === 'both-changed',
    )
  )
    return 'connected';
  return state.lastSuccessfulAt ? 'synced' : 'connected';
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

  cancel(reason = new DOMException('Canceled', 'AbortError')): void {
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

export type PaperRetryOperation =
  'upload' | 'download' | 'remove-cleanup' | 'revalidate';

export type PaperRetryAction = PaperRetryOperation | 'none';

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

export function classifyPaperCoordinatorError(
  error: unknown,
  online = typeof navigator === 'undefined' || navigator.onLine !== false,
): SyncOperationalIssue {
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
      ...(Reflect.get(error, 'documentId')
        ? { documentId: String(Reflect.get(error, 'documentId')) }
        : {}),
    },
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
  private listeners = new Set<Listener>();
  private removePersistentListener: (() => void) | null = null;
  private readonly operationOwner = new SerializedDriveOperationOwner();
  private readonly operationTelemetryIds = new WeakMap<AbortSignal, string>();
  private lastDriveOperationDiagnostic?: DriveOperationDiagnosticSummary;
  private readonly recentDriveOperationDiagnostics: DriveOperationDiagnosticSummary[] =
    [];
  private scanPromise: Promise<void> | null = null;
  private layoutMigrationPromise: Promise<void> | null = null;
  private v3MigrationPromise: Promise<void> | null = null;
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
  private readonly paperRetryIntents = new Map<string, PaperRetryOperation>();
  private readonly activePaperRetryTasks = new Map<string, Promise<void>>();
  private autoUploadTimer: number | null = null;
  private transientRetryAttempt = 0;
  private soundSequence = 0;
  private readonly paperFlights = new KeyedSingleFlight<void>();
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
    autoSync: true,
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

  destroy(): void {
    this.removePersistentListener?.();
    this.operationOwner.destroy();
    if (this.autoUploadTimer !== null) window.clearTimeout(this.autoUploadTimer);
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
  }

  async setDeviceMode(mode: SyncDeviceMode): Promise<void> {
    await this.initialize();
    const profile = this.requireProfile();
    if (this.identity.hasDeviceSession) {
      throw new Error('Disconnect Google Drive before changing the device mode.');
    }
    if (mode === profile.deviceMode) return;
    try {
      if (mode === 'temporary') {
        const preflight = await inspectTemporaryModePreflight();
        if (!preflight.safe) throw new Error(preflight.reason);
        await this.flushPersistenceChanges();
        await beginTemporaryWorkspace();
      } else {
        await leaveEmptyTemporaryWorkspace();
      }
      reloadForWorkspaceChange();
    } catch (error) {
      this.updateView({ error: userMessage(error), issue: undefined });
      throw error;
    }
  }

  async connect(): Promise<void> {
    await this.initialize();
    if (!this.view.backendConfigured)
      throw new Error('Persistent sync backend not configured.');
    this.updateView({ connection: 'connecting', error: undefined, issue: undefined });
    await this.identity.beginAuthorization();
  }

  async reconnect(): Promise<void> {
    await this.initialize();
    this.updateView({ connection: 'connecting', error: undefined, issue: undefined });
    await this.identity.beginAuthorization({ forceConsent: true });
  }

  async disconnect(): Promise<void> {
    await this.initialize();
    await this.withDriveOperationsQuiesced(
      new DOMException('Google Drive disconnected.', 'AbortError'),
      async () => {
        if (this.identity.hasDeviceSession) await this.identity.disconnectCurrent();
        const profile = this.requireProfile();
        delete profile.googleDeviceSessionToken;
        await savePaperSyncDeviceProfile(profile);
        this.repository = null;
        this.clearDriveOperationDiagnostics();
        this.drive = null;
        this.updateView({
          connection: 'disconnected',
          sessions: [],
          progress: { phase: 'idle' },
          legacyHousekeeping: { status: 'idle' },
          folderNameMaintenance: { status: 'idle' },
        });
      },
    );
  }

  async disconnectAll(): Promise<void> {
    await this.initialize();
    await this.withDriveOperationsQuiesced(
      new DOMException('Google Drive sessions disconnected.', 'AbortError'),
      async () => {
        await this.identity.disconnectAll();
        const profile = this.requireProfile();
        delete profile.googleDeviceSessionToken;
        delete profile.accountId;
        delete profile.rootFolderId;
        delete profile.driveChangeCursor;
        await savePaperSyncDeviceProfile(profile);
        this.repository = null;
        this.clearDriveOperationDiagnostics();
        this.drive = null;
        this.seenRemoteReminderStateIds.clear();
        this.updateView({
          connection: 'disconnected',
          sessions: [],
          papers: [],
          progress: { phase: 'idle' },
          legacyHousekeeping: { status: 'idle' },
          folderNameMaintenance: { status: 'idle' },
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
    const root = this.view.rootChoices.find((candidate) => candidate.id === rootId);
    if (!root) throw new Error('The selected Drive folder is no longer available.');
    const signal = await this.beginOperation('other');
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
      await savePaperSyncDeviceProfile(profile);
      this.repository = new PaperDriveRepository(this.requireDrive(), refreshedRoot.id);
      this.updateView({
        rootChoices: [],
        rootUrl: rootUrl(refreshedRoot.id),
        legacyHousekeeping: { status: 'idle' },
        folderNameMaintenance: { status: 'idle' },
      });
    } finally {
      this.endOperation(signal);
    }
    await this.inspectAndScan();
  }

  async createReplacementRoot(): Promise<void> {
    await this.initialize();
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
      await savePaperSyncDeviceProfile(profile);
      this.repository = new PaperDriveRepository(drive, root.id);
      await this.repository.initializeEmptyLayout(signal);
      this.updateView(
        {
          rootUrl: rootUrl(root.id),
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
    const profile = this.requireProfile();
    profile.autoSync = profile.deviceMode === 'temporary' ? false : enabled;
    await savePaperSyncDeviceProfile(profile);
    this.updateView({ autoSync: profile.autoSync });
    if (!profile.autoSync && this.autoUploadTimer !== null) {
      window.clearTimeout(this.autoUploadTimer);
      this.autoUploadTimer = null;
    }
    if (profile.autoSync && this.getAutoSyncEligibleDirtyPaperIds().length) {
      this.scheduleAutoUpload();
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
    const signal = await this.beginOperation('housekeeping');
    this.updateView({ legacyHousekeeping: { status: 'checking' } }, { notify: false });
    try {
      const repository = await this.requireSelectedHousekeepingRepository(signal);
      const options = await this.legacyDriveHousekeepingOptions();
      const inventory = await repository.inspectLegacyDriveData(options, signal);
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
    const signal = await this.beginOperation('housekeeping');
    this.updateView(
      { folderNameMaintenance: { status: 'checking' } },
      { notify: false },
    );
    try {
      const repository = await this.requireSelectedHousekeepingRepository(signal);
      const preview = await repository.inspectPaperFolderNames(signal);
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

  private async scanCloudPapersOwned(waitForBatch: boolean): Promise<void> {
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
      return;
    }
    const signal = await this.beginOperation('scan');
    try {
      const repository = await this.ensureRepository(signal, false);
      this.updateView({
        connection: 'syncing',
        progress: { phase: 'discovering', detail: 'Checking Drive papers' },
        error: undefined,
        issue: undefined,
      });
      await this.reconcileLocalPaperStates();
      await this.discoverWithFastPath(repository, signal);
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
      if (error instanceof PaperManifestIntegrityError && error.documentId) {
        const issue = this.markPaperFailure(error.documentId, error);
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
      await this.runAuthoritativeBaseline(repository, signal);
      return;
    }

    await repository.assertActiveRoot(signal);
    let batch;
    try {
      batch = await this.requireDrive().listChanges(cursor.pageToken, signal);
    } catch (error) {
      if (error instanceof DriveRequestError && error.code === 'change-token-invalid') {
        this.requireDrive().recordOperationStateTransition?.({
          phase: 'changes-invalidation',
          transition: 'changes-invalidation-classified',
          outcome: 'deferred',
          classification: 'cursor-invalid-full-audit',
        });
        await this.runAuthoritativeBaseline(repository, signal);
        return;
      }
      throw error;
    }
    const plan = planPaperChangeDiscovery(
      batch.changes,
      repository.rootFolderId,
      this.view.papers,
    );
    if (plan.requiresFullAudit) {
      this.requireDrive().recordOperationStateTransition?.({
        phase: 'changes-invalidation',
        transition: 'changes-invalidation-classified',
        outcome: 'deferred',
        classification: 'unscoped-change-full-audit',
      });
      await this.runAuthoritativeBaseline(repository, signal);
      return;
    }
    if (plan.affectedDocumentIds.length === 0) {
      this.requireDrive().recordOperationStateTransition?.({
        phase: 'changes-invalidation',
        transition: 'changes-invalidation-classified',
        outcome: 'succeeded',
        classification: 'no-relevant-paper-change',
      });
    }
    for (const documentId of plan.affectedDocumentIds) {
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
    if (plan.affectedDocumentIds.length > 0) {
      let papers = await this.applyScopedDiscovery(
        repository,
        plan.affectedDocumentIds,
        signal,
      );
      papers = this.retainRemovedManagedFileFailures(papers, plan.removedManagedFiles);
      await this.applyDiscovery(papers);
      this.assertDiscoverySucceeded(papers, plan.affectedDocumentIds);
    }
    await this.commitDriveChangeCursor(batch.newStartPageToken, cursor.lastFullAuditAt);
  }

  private async runAuthoritativeBaseline(
    repository: PaperDriveRepository,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_BASELINE_REPLAY_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted();
      const startPageToken = await this.requireDrive().getStartPageToken(signal);
      await this.assertActiveLayout(repository, signal);
      let papers: readonly PaperCloudSummary[] = this.retainMissingKnownCloudPapers(
        await repository.discover([...this.paperStates.values()], signal, {
          layoutValidated: true,
        }),
      );
      const replay = await this.requireDrive().listChanges(startPageToken, signal);
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
        continue;
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
      if (plan.affectedDocumentIds.length > 0) {
        papers = await this.applyScopedDiscovery(
          repository,
          plan.affectedDocumentIds,
          signal,
          papers,
        );
      }
      papers = this.retainRemovedManagedFileFailures(papers, plan.removedManagedFiles);
      await this.applyDiscovery(papers);
      this.assertDiscoverySucceeded(papers);
      await this.commitDriveChangeCursor(replay.newStartPageToken, Date.now());
      return;
    }
    throw new PaperRepositoryError(
      'paper-remote-changed',
      'Google Drive changed repeatedly during the discovery baseline.',
    );
  }

  private async applyScopedDiscovery(
    repository: PaperDriveRepository,
    documentIds: readonly string[],
    signal: AbortSignal,
    baseline: readonly PaperCloudSummary[] = this.view.papers,
  ): Promise<PaperCloudSummary[]> {
    const scoped = await repository.discoverPapers(
      documentIds,
      [...this.paperStates.values()],
      signal,
      { layoutValidated: true, reuseVerifiedManifests: true },
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
    return [...merged, ...replacements.values()].sort((first, second) =>
      first.documentId.localeCompare(second.documentId),
    );
  }

  private async commitDriveChangeCursor(
    pageToken: string,
    lastFullAuditAt: number,
  ): Promise<void> {
    const profile = this.requireProfile();
    if (!profile.accountId || !profile.rootFolderId) {
      throw new Error('Google Drive discovery identity is incomplete.');
    }
    const next: PaperSyncDeviceProfile = {
      ...profile,
      lastDiscoveryAt: Date.now(),
      driveChangeCursor: {
        version: 1,
        accountId: profile.accountId,
        rootFolderId: profile.rootFolderId,
        deviceMode: profile.deviceMode,
        pageToken,
        lastFullAuditAt,
      },
    };
    await savePaperSyncDeviceProfile(next);
    this.profile = next;
  }

  private assertDiscoverySucceeded(
    papers: readonly PaperCloudSummary[],
    documentIds?: readonly string[],
  ): void {
    const affected = documentIds ? new Set(documentIds) : null;
    const failed = papers.find(
      (paper) =>
        (!affected || affected.has(paper.documentId)) &&
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
      for (const documentId of ids) this.blockingPaperIssues.delete(documentId);
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
    const uniqueIds = [...new Set(documentIds)];
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
              await savePaperSyncState(state);
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
                await this.local.ensurePaperAbsent(documentId, signal);
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
                  }),
                { documentId },
              );
              if (
                await this.staleBecauseLocalRemoval(
                  documentId,
                  capturedLocalRemovalEpoch,
                )
              ) {
                await this.local.ensurePaperAbsent(documentId, signal);
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
                      await savePaperSyncState(state);
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
                    const tagIds = applied.snapshot.entities
                      .filter((entity) => entity.kind === 'tag')
                      .map((entity) => entity.id);
                    await recordTemporaryPaperIds([documentId], collectionIds, tagIds);
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
              issue: this.markPaperFailure(documentId, error),
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
        await this.applyTransferCatalog(settledCloud);
      }
      const profile = this.requireProfile();
      if (!failures.length) {
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(profile);
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
            this.markPaperFailure(documentId, error);
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
            paper.presenceState !== 'removed' &&
            paper.status !== 'needs-attention' &&
            (!paper.deleted ||
              states.get(paper.documentId)?.availability !== 'cloud-only'),
        )
        .map((paper) => paper.documentId),
    );
  }

  uploadSelected(documentIds: readonly string[]): Promise<void> {
    for (const documentId of documentIds) this.blockingPaperIssues.delete(documentId);
    this.transientRetryAttempt = 0;
    return this.startUpload(documentIds);
  }

  private startUpload(documentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(documentIds)].sort();
    return this.retainPaperOperation('upload', ids, async () => {
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
    const documentIds = this.retryCandidatePaperIds();
    if (!documentIds.length) {
      await this.scanCloudPapers();
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
    return [...ids].sort();
  }

  private async retryFailedPaperWork(documentIds: readonly string[]): Promise<void> {
    const active = [...this.activePaperOperationTasks.values()].filter(
      ({ operation }) =>
        operation.documentIds.some((documentId) => documentIds.includes(documentId)),
    );
    const activelyCovered = new Set(
      active.flatMap(({ operation }) => operation.documentIds),
    );
    if (documentIds.every((documentId) => activelyCovered.has(documentId))) {
      await Promise.all(active.map(({ promise }) => promise));
      return;
    }
    if (active.length) {
      // Never race a Retry against work that already owns any requested paper.
      // Once those operations settle, the exact-paper refresh below classifies
      // only the still-relevant work for the full Retry selection.
      await Promise.allSettled(active.map(({ promise }) => promise));
    }

    await this.revalidatePaperRetryTargets(documentIds);

    const upload: string[] = [];
    const download: string[] = [];
    const cleanup: string[] = [];
    for (const documentId of documentIds) {
      const state = this.paperStates.get(documentId);
      if (!state) continue;
      const action = selectPaperRetryAction(
        state,
        this.blockingPaperIssues.get(documentId)?.issue,
        this.paperRetryIntents.get(documentId),
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
  }

  private async revalidatePaperRetryTargets(
    documentIds: readonly string[],
  ): Promise<void> {
    await this.initialize();
    const originalBlocks = new Map<string, BlockingPaperIssue>();
    for (const documentId of documentIds) {
      const block = this.blockingPaperIssues.get(documentId);
      if (block) originalBlocks.set(documentId, block);
    }
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
      const refreshed = mergeScopedPaperDiscoveryCatalog(
        this.view.papers,
        await this.applyScopedDiscovery(repository, documentIds, signal),
        documentIds,
      );

      // A successful exact-paper read is the evidence needed to retire a
      // retryable operational error. Structural/user-choice issues remain until
      // their authoritative evidence changes or the user takes the explicit
      // action they require.
      for (const documentId of documentIds) {
        const block = originalBlocks.get(documentId);
        if (!block?.issue.retrySafe || !block.issue.actions.includes('retry-now')) {
          continue;
        }
        this.blockingPaperIssues.delete(documentId);
        const state = this.paperStates.get(documentId);
        if (state) state.status = paperStatusAfterFailure(state, false);
      }

      await this.applyDiscovery(refreshed, documentIds);
      for (const documentId of documentIds) {
        const paper = refreshed.find(
          (candidate) => candidate.documentId === documentId,
        );
        if (paper?.status !== 'needs-attention') continue;
        const original = originalBlocks.get(documentId);
        this.blockingPaperIssues.set(documentId, {
          headSetId: paper.headSetId,
          issue:
            original && !original.issue.retrySafe
              ? original.issue
              : authoritativePaperAttentionIssue(paper),
        });
      }
      const issue = this.firstBlockingPaperIssue();
      this.updateView({
        connection: this.connectionAfterPaperSettlement(issue),
        progress: { phase: 'idle' },
        issue,
        error: issue?.message,
      });
    } catch (error) {
      const documentId =
        error instanceof PaperManifestIntegrityError ? error.documentId : undefined;
      if (documentId && documentIds.includes(documentId)) {
        this.markPaperFailure(documentId, error);
      }
      this.applyError(error);
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
              if (!summary || summary.issue || summary.status === 'needs-attention') {
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
                await savePaperSyncState(state);
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
                await deletePaperSyncRecords([documentId]);
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
          const issue = this.markPaperFailure(settlement.input, settlement.error);
          failureIssues.push(issue);
          outcome.failed.push({
            documentId: settlement.input,
            message: issue.message,
          });
        }

        if (settledCloud.length) await this.applyTransferCatalog(settledCloud);
        const profile = this.requireProfile();
        if (outcome.removed.length || outcome.alreadyRemoved.length) {
          profile.lastSuccessfulAt = Date.now();
          await savePaperSyncDeviceProfile(profile);
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
      if (!state || state.cloudPresence !== 'removed' || state.locallyDeleted) {
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
        await savePaperSyncState(state);
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
        await savePaperSyncState(state);
        this.paperStates.set(documentId, state);
        await this.applyTransferCatalog([result.cloud]);
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(profile);
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
        await savePaperSyncState(state).catch(() => undefined);
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
                await savePaperSyncState(state);
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
                await savePaperSyncState(state);
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
                issue: this.markPaperFailure(documentId, error),
              });
            } finally {
              completed += 1;
              this.updateView({
                progress: { phase: 'uploading', completed, total: ids.length },
              });
            }
          },
        );
        if (settledCloud.length) await this.applyTransferCatalog(settledCloud);
        const profile = this.requireProfile();
        if (settledCloud.length) {
          profile.lastSuccessfulAt = Date.now();
          await savePaperSyncDeviceProfile(profile);
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
        (state.status !== 'remote-update-available' && state.status !== 'both-changed')
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
      await savePaperSyncStates(changed.map(({ state }) => state));
      this.updateReminder(this.view.papers);
    } catch (error) {
      for (const { state, previous } of changed) {
        if (previous) state.dismissedRemoteHeadIds = previous;
        else delete state.dismissedRemoteHeadIds;
      }
      this.updateView({ error: userMessage(error) });
      throw error;
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
        await this.runPostMigrationFullAudit(signal);
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
        !(inspection.state === 'paper-v3' && record?.phase === 'activating-layout')
      ) {
        throw new PaperRepositoryError(
          inspection.state === 'unsupported-layout'
            ? 'unsupported-layout'
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

      if (inspection.state !== 'paper-v3') {
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
          await savePaperV3MigrationRecord(record);
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
          await savePaperV3MigrationRecord(record);
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
        await savePaperV3MigrationRecord(record);
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
      await this.runPostMigrationFullAudit(signal);
      phase = 'clear-migration-record';
      await clearPaperV3MigrationRecord();
      record = null;
      const profile = this.requireProfile();
      profile.lastSuccessfulAt = Date.now();
      await savePaperSyncDeviceProfile(profile);
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
        error: failure.message,
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
      await this.reconcileLocalPaperStates();
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
          await saveLayoutMigrationRecord(record);
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
        await saveLayoutMigrationRecord({
          ...record,
        });
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
          await savePaperSyncState(state);
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
          await saveLayoutMigrationRecord(record);
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
        await saveLayoutMigrationRecord(record);
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
      await this.markMigrationPublicationsIncorporated(record);
      phase = 'clear-migration-record';
      await clearLayoutMigrationRecord();
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
        error: failure.message,
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
          await saveLayoutMigrationRecord({ ...record, lastFailure: failure });
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
    const remaining = this.getDirtyPaperIds();
    if (remaining.length && !abandonRemaining) {
      throw new TemporaryDirtyWorkError(remaining);
    }
    try {
      await this.withDriveOperationsQuiesced(
        new DOMException('Temporary workspace is finishing.', 'AbortError'),
        async () => {
          await setTemporaryFinishPhase('revoking');
          if (this.identity.hasDeviceSession) await this.identity.disconnectCurrent();
          await cleanupTemporaryOrigin();
          this.paperStates.clear();
          this.repository = null;
          this.clearDriveOperationDiagnostics();
          this.drive = null;
          this.updateView({
            connection: 'disconnected',
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
      const [profile, states, cachedPapers] = await Promise.all([
        loadPaperSyncDeviceProfile(),
        loadPaperSyncStates(),
        loadCloudPaperCatalog(),
      ]);
      this.profile = profile;
      this.paperStates = new Map(states.map((state) => [state.documentId, state]));
      this.view = {
        ...this.view,
        connection: getBuildTimeSyncAuthUrl() ? 'disconnected' : 'not-configured',
        deviceMode: profile.deviceMode,
        autoSync: profile.autoSync,
        papers: cachedPapers,
        paperStates: states,
        dirtyPaperIds: pendingSyncPaperIds(states),
        lastSuccessfulAt: profile.lastSuccessfulAt,
        publicDeviceNotice:
          profile.deviceMode === 'temporary' ? PUBLIC_DEVICE_LIMITATION : undefined,
      };
      this.emit();
      this.removePersistentListener = subscribeToPersistentChanges((detail) => {
        const task = this.markDirty(detail);
        this.pendingPersistentChanges.add(task);
        void task
          .catch((error) => this.applyError(error))
          .finally(() => this.pendingPersistentChanges.delete(task));
      });
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('offline', this.handleOffline);
      const backendUrl = getBuildTimeSyncAuthUrl();
      if (!backendUrl) return;
      this.identity.configure(
        backendUrl,
        profile.deviceId,
        profile.googleDeviceSessionToken,
        profile.deviceMode,
      );
      const exchange = await this.identity.completeAuthorizationIfPresent();
      if (exchange) {
        await this.bindAuthorizedAccount(exchange.accountId);
        if (profile.deviceMode === 'personal') {
          profile.googleDeviceSessionToken = exchange.sessionToken;
        }
        profile.accountId = exchange.accountId;
        await savePaperSyncDeviceProfile(profile);
      }
      if (!this.identity.hasDeviceSession) {
        this.updateView({ connection: 'disconnected' }, { notify: false });
        return;
      }
      this.updateView({ connection: 'connecting' }, { notify: false });
      await this.refreshSessions();
      if (profile.deviceMode === 'temporary' && this.identity.accountId) {
        await beginTemporaryProvenance(this.identity.accountId, profile.rootFolderId);
      }
      if (this.view.connection === 'connecting') {
        await this.scanCloudPapersOwned(false);
      }
      if (profile.autoSync && this.getPendingSyncPaperIds().length)
        this.scheduleAutoUpload();
    } catch (error) {
      this.applyError(error, false);
    }
  }

  private async ensureRepository(
    signal: AbortSignal,
    requireActiveLayout = true,
  ): Promise<PaperDriveRepository> {
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
    if (profile.rootFolderId !== root.id) delete profile.driveChangeCursor;
    profile.rootFolderId = root.id;
    await savePaperSyncDeviceProfile(profile);
    this.repository = new PaperDriveRepository(drive, root.id);
    if (profile.deviceMode === 'temporary' && profile.accountId) {
      await beginTemporaryProvenance(profile.accountId, root.id);
    }
    this.updateView({ rootUrl: rootUrl(root.id), rootChoices: [] }, { notify: false });
    if (requireActiveLayout) await this.repository.assertActiveRoot(signal);
    return this.repository;
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
    this.drive ??= new DriveClient(async (forceRefresh) => {
      const token = await this.identity.ensureAccessToken(forceRefresh);
      return token.value;
    });
    return this.drive;
  }

  private async assertActiveLayout(
    repository: PaperDriveRepository,
    signal: AbortSignal,
  ): Promise<void> {
    const inspection = await repository.detectLayout(signal);
    if (inspection.state === 'paper-v3') return;
    if (
      inspection.state === 'legacy-upgrade-required' ||
      inspection.state === 'paper-v2-upgrade-required'
    ) {
      const layoutUpgradeKind =
        inspection.state === 'paper-v2-upgrade-required'
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
          inspection.detectedLayoutVersion === 2 ||
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
    await repository.initializeEmptyLayout(signal);
  }

  private async inspectAndScan(): Promise<void> {
    const signal = await this.beginOperation('scan');
    try {
      const repository = await this.ensureRepository(signal, false);
      const inspection = await repository.detectLayout(signal);
      if (
        inspection.state === 'legacy-upgrade-required' ||
        inspection.state === 'paper-v2-upgrade-required'
      ) {
        this.updateView({
          connection: 'layout-upgrade-required',
          layoutUpgradeKind:
            inspection.state === 'paper-v2-upgrade-required'
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
            inspection.detectedLayoutVersion === 2 ||
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
      if (inspection.state === 'empty') await repository.initializeEmptyLayout(signal);
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
        ...statesToSave.map((state) => savePaperSyncState(state)),
        ...(stateIdsToDelete.length ? [deletePaperSyncRecords(stateIdsToDelete)] : []),
        saveCloudPaperCatalog(catalog),
      ]);
    } finally {
      // Queue the exact remote check before releasing Retry/discovery waiters so
      // FIFO Drive ownership always places it on the safe side of the commit.
      this.scheduleLocalRemovalReconciliation(documentIds);
      this.finishLocalRemoval(documentIds, true);
    }
  }

  private scheduleLocalRemovalReconciliation(documentIds: readonly string[]): void {
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
            this.markPaperFailure(documentId, error);
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
      ...statesToSave.map((state) => savePaperSyncState(state)),
      ...(stateIdsToDelete.length ? [deletePaperSyncRecords(stateIdsToDelete)] : []),
      saveCloudPaperCatalog(catalog),
    ]);
    this.refreshStateView(catalog);
    this.updateReminder(catalog);
  }

  private async reconcileLocalPaperStates(): Promise<void> {
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
        await deletePaperSyncRecords([state.documentId]);
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
    await savePaperSyncStates([...this.paperStates.values()]);
    this.refreshStateView();
  }

  private async applyDiscovery(
    papers: readonly PaperCloudSummary[],
    scopedDocumentIds?: readonly string[],
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
      const presentedPaper = activeBlock
        ? {
            ...paper,
            status: 'needs-attention' as const,
            issue: {
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
    if (removedCloudOnlyIds.length) {
      await deletePaperSyncRecords(removedCloudOnlyIds);
    }
    await Promise.all([
      savePaperSyncStates([...this.paperStates.values()]),
      saveCloudPaperCatalog(presentedPapers),
    ]);
    this.refreshStateView(presentedPapers);
    this.updateReminder(presentedPapers);
  }

  private async markMigrationPublicationsIncorporated(
    record: LayoutMigrationRecord,
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
    await savePaperSyncStates([...this.paperStates.values()]);
    this.refreshStateView();
  }

  private async uploadSelectedOwned(documentIds: readonly string[]): Promise<void> {
    await this.initialize();
    const ids = [...new Set(documentIds)].filter((id) => {
      const state = this.paperStates.get(id);
      return Boolean(state?.dirtyReasons.length && state.cloudPresence !== 'removed');
    });
    if (!ids.length) return;
    await this.flushPersistenceChanges();
    let completed = 0;
    let actualWork = false;
    const settledCloud: PaperCloudSummary[] = [];
    const failures: Array<{
      documentId: string;
      error: unknown;
      issue: SyncOperationalIssue;
    }> = [];
    const signal = await this.beginOperation('upload');
    try {
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
            if (!state || !state.dirtyReasons.length) return;
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
            await savePaperSyncState(state);
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
            await savePaperSyncState(state);
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
            issue: this.markPaperFailure(documentId, error),
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
      if (settledCloud.length > 0) await this.applyTransferCatalog(settledCloud);
      const profile = this.requireProfile();
      if (!failures.length) {
        profile.lastSuccessfulAt = Date.now();
        await savePaperSyncDeviceProfile(profile);
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
            this.markPaperFailure(documentId, error);
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
      await saveCloudPaperCatalog(catalog);
      this.refreshStateView(catalog);
      this.updateReminder(catalog);
    });
  }

  private async runPostMigrationFullAudit(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.repository) return;
    const papers = await this.repository.discover(
      [...this.paperStates.values()],
      signal,
    );
    await this.applyDiscovery(papers);
  }

  private async markDirty(detail: PersistentChangeDetail): Promise<void> {
    if (detail.kind === 'ai-settings') return;
    if (detail.localRemoval) {
      await this.handleLocalRemovalLifecycle(detail);
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
    for (const documentId of ids) {
      // The explicit local-removal lifecycle owns this document until its local
      // transaction commits or aborts. Generic persistence noise must not turn
      // an intentional absence into uploadable dirt.
      if (this.activeLocalRemovalIds.has(documentId)) continue;
      let state = this.paperStates.get(documentId);
      if (!state) {
        state = createDefaultPaperSyncState(documentId, this.requireProfile().deviceId);
        state.dirtyReasons = [];
        state.dirtyGeneration = 0;
      }
      const preserveAttention = state.status === 'needs-attention';
      if (categories.includes('deleted')) {
        state.locallyDeleted = true;
        if (!state.remoteHeadIds.length) {
          this.paperStates.delete(documentId);
          await deletePaperSyncRecords([documentId]);
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
      await savePaperSyncState(state);
      if (this.requireProfile().deviceMode === 'temporary') {
        await recordTemporaryPaperIds([documentId]);
      }
    }
    this.refreshStateView();
    this.transientRetryAttempt = 0;
    if (
      this.requireProfile().autoSync &&
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

  private scheduleAutoUpload(delay = AUTO_UPLOAD_DELAY): void {
    if (this.autoUploadTimer !== null) window.clearTimeout(this.autoUploadTimer);
    if (!this.profile?.autoSync || !this.getAutoSyncEligibleDirtyPaperIds().length) {
      this.autoUploadTimer = null;
      return;
    }
    this.autoUploadTimer = window.setTimeout(() => {
      this.autoUploadTimer = null;
      if (!navigator.onLine || !this.identity.hasDeviceSession) return;
      const eligible = this.getAutoSyncEligibleDirtyPaperIds();
      if (eligible.length) void this.startUpload(eligible).catch(() => undefined);
    }, delay);
  }

  private scheduleDirtyFollowUp(issues: readonly SyncOperationalIssue[]): void {
    if (!this.profile?.autoSync || !this.getAutoSyncEligibleDirtyPaperIds().length) {
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
          papers,
          this.paperStates,
          this.seenRemoteReminderStateIds,
        ),
      },
      { notify: false },
    );
  }

  private async bindAuthorizedAccount(accountId: string): Promise<void> {
    const profile = this.requireProfile();
    if (!profile.accountId || profile.accountId === accountId) return;
    this.seenRemoteReminderStateIds.clear();
    // Preserve local papers but sever every remote baseline from the other account.
    for (const state of this.paperStates.values()) {
      state.availability = 'local-only';
      state.status = 'local-changes';
      state.dirtyGeneration += 1;
      state.dirtyReasons = [
        ...new Set<PaperDirtyReason>([...state.dirtyReasons, 'metadata', 'source-pdf']),
      ];
      state.incorporatedHeadIds = [];
      state.remoteHeadIds = [];
      delete state.cloudPresence;
      delete state.presenceHeadIds;
      delete state.cloudCleanupPending;
      delete state.dismissedRemoteHeadIds;
      state.driveFiles = { fileIds: {} };
    }
    await savePaperSyncStates([...this.paperStates.values()]);
    await saveCloudPaperCatalog([]);
    delete profile.rootFolderId;
    delete profile.driveChangeCursor;
    this.updateView({
      papers: [],
      reminder: undefined,
      legacyHousekeeping: { status: 'idle' },
      folderNameMaintenance: { status: 'idle' },
    });
  }

  private writer() {
    const profile = this.requireProfile();
    return { deviceId: profile.deviceId, deviceLabel: profile.deviceLabel };
  }

  private getDirtyPaperIds(): string[] {
    return [...this.paperStates.values()]
      .filter((state) => state.dirtyReasons.length > 0)
      .map((state) => state.documentId)
      .sort();
  }

  /**
   * Public pending state represents work that ordinary sync is actually allowed
   * to publish. A locally retained, explicitly removed paper may continue to be
   * edited, but those edits stay local until the user explicitly restores it.
   */
  private getPendingSyncPaperIds(): string[] {
    return pendingSyncPaperIds([...this.paperStates.values()]);
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

  private firstBlockingPaperIssue(): SyncOperationalIssue | undefined {
    return this.blockingPaperIssues.values().next().value?.issue;
  }

  private connectionAfterPaperSettlement(
    issue: SyncOperationalIssue | undefined,
  ): PaperConnectionStatus {
    if (!issue) return 'connected';
    return [...this.blockingPaperIssues.values()].some(
      (paperIssue) => paperIssue.issue === issue,
    )
      ? 'connected'
      : connectionForIssue(issue);
  }

  private hasGlobalBlockingIssue(): boolean {
    const issue = this.view.issue;
    if (!issue?.blocksOrdinarySync) return false;
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

  private markPaperFailure(documentId: string, error: unknown): SyncOperationalIssue {
    const issue = classifyPaperCoordinatorError(error);
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
      void savePaperSyncState(state).catch(() => undefined);
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
    if (error instanceof PaperRepositoryError) {
      const issue = classifyPaperCoordinatorError(error);
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
  ): Promise<AbortSignal> {
    const queued = this.operationOwner.active;
    const signal = await this.operationOwner.begin();
    const drive = this.requireDrive();
    const operationId = drive.beginOperationTelemetry(operationType);
    this.operationTelemetryIds.set(signal, operationId);
    drive.recordOperationStateTransition({
      phase: 'operation-owner',
      transition: 'operation-owner-acquired',
      outcome: 'succeeded',
      classification: queued ? 'queued' : 'immediate',
    });
    return signal;
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

  private endOperation(signal: AbortSignal): void {
    const operationId = this.operationTelemetryIds.get(signal);
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
    if (!this.identity.hasDeviceSession) return;
    void this.scanCloudPapers()
      .then(() => {
        this.transientRetryAttempt = 0;
        if (this.profile?.autoSync && this.getAutoSyncEligibleDirtyPaperIds().length) {
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
  if (issue.code === 'google-authorization-required') return 'reconnect-required';
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
