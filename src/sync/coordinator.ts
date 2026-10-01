import type { StoredPdfFile } from '../services/annotationPersistence.ts';
import {
  flushLocalPersistence,
  subscribeToPersistentChanges,
} from '../services/persistentChange.ts';
import {
  DriveRootUnavailableError,
  GoogleDrivePayloadIntegrityError,
  GoogleDriveSyncRepository,
  MultipleDriveRootsError,
  RemoteManifestChangedError,
} from './driveRepository.ts';
import {
  payloadForContext,
  replacePayloadForContext,
  type CloudEntityPayload,
} from './cloudFormat.ts';
import {
  DriveAuthorizationError,
  DriveClient,
  DriveRequestError,
  type DriveFileMetadata,
} from './driveClient.ts';
import {
  classifySyncError,
  createLocalChangesWaitingIssue,
  createResetIncompleteIssue,
  isTransientConnectivityIssue,
  issueForOfflineTransition,
  type SyncOperationalIssue,
} from './errorModel.ts';
import {
  getBuildTimeSyncAuthUrl,
  GoogleReauthorizationRequiredError,
  PersistentGoogleAuthSession,
  SyncBackendUnavailableError,
  type GoogleDeviceSessionSummary,
} from './googleIdentity.ts';
import { sha256Hex, stableStringify } from './hash.ts';
import { BrowserSyncLocalAdapter } from './localAdapter.ts';
import { shouldWarnBeforeUnload } from './lifecycle.ts';
import { mergeSyncSnapshots } from './merge.ts';
import { haveEquivalentSyncContent } from './syncContent.ts';
import {
  loadSyncDeviceState,
  LocalSyncPersistenceError,
  saveSyncDeviceState,
} from './storage.ts';
import { getSyncSoundFeedback, type SyncSoundFeedback } from './syncSounds.ts';
import type {
  LocalSyncPdf,
  SyncApplyResult,
  SyncConflict,
  SyncDeviceState,
  SyncIntegrityIssue,
  SyncProgress,
  SyncSnapshot,
  SyncSummary,
} from './types.ts';

const AUTO_SYNC_DELAY = 5_000;
const ACTIVE_PULL_INTERVAL = 90_000;

export type SyncConnectionStatus =
  | 'loading'
  | 'not-configured'
  | 'disconnected'
  | 'connecting'
  | 'disconnecting'
  | 'connected'
  | 'syncing'
  | 'offline'
  | 'backend-unavailable'
  | 'reconnect-required'
  | 'error'
  | 'root-unavailable'
  | 'root-selection-required';

export interface SyncViewState {
  connection: SyncConnectionStatus;
  autoSync: boolean;
  dirty: boolean;
  backendConfigured: boolean;
  sessions: GoogleDeviceSessionSummary[];
  lastSuccessfulAt?: number;
  error?: string;
  issue?: SyncOperationalIssue;
  progress: SyncProgress;
  summary?: SyncSummary;
  rootUrl?: string;
  rootChoices: DriveFileMetadata[];
  conflicts: SyncConflict[];
  integrityIssue?: SyncIntegrityIssue;
  resetRequired?: boolean;
}

export type SyncUiStatus =
  | 'loading'
  | 'not-configured'
  | 'disconnected'
  | 'connecting'
  | 'disconnecting'
  | 'connected'
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'attention'
  | 'offline';

export function getSyncUiStatus(state: SyncViewState): SyncUiStatus {
  if (state.connection === 'syncing') return 'syncing';
  if (state.issue?.state === 'attention') return 'attention';
  if (
    state.integrityIssue ||
    state.resetRequired ||
    state.connection === 'reconnect-required' ||
    state.connection === 'error' ||
    state.connection === 'root-unavailable' ||
    state.connection === 'root-selection-required' ||
    (state.connection === 'connected' &&
      state.conflicts.some((conflict) => !conflict.dismissedAt))
  ) {
    return 'attention';
  }
  if (
    state.issue?.state === 'offline' ||
    state.connection === 'offline' ||
    state.connection === 'backend-unavailable'
  ) {
    return 'offline';
  }
  if (state.issue?.state === 'pending') return 'pending';
  if (state.connection === 'connected') {
    if (state.dirty) return 'pending';
    if (state.error) return 'connected';
    if (state.lastSuccessfulAt !== undefined) return 'synced';
    return 'connected';
  }
  return state.connection;
}

type Listener = (state: SyncViewState) => void;

export class GoogleDriveSyncCoordinator {
  private readonly identity = new PersistentGoogleAuthSession();
  private readonly local = new BrowserSyncLocalAdapter();
  private readonly loadDeviceState: typeof loadSyncDeviceState;
  private state: SyncDeviceState | null = null;
  private repository: GoogleDriveSyncRepository | null = null;
  private initializationPromise: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private syncPromise: Promise<void> | null = null;
  private syncCycleSequence = 0;
  private activeSyncCycleId: number | null = null;
  private abortController: AbortController | null = null;
  private activeApplyAbortController: AbortController | null = null;
  private integrityFailure: GoogleDrivePayloadIntegrityError | null = null;
  private disconnecting = false;
  private resetting = false;
  private resetPromise: Promise<void> | null = null;
  private autoSyncTimer: number | null = null;
  private periodicTimer: number | null = null;
  private transientRetryAttempt = 0;
  private consecutiveUploadFailures = 0;
  private soundTransitionSequence = 0;
  private removePersistentListener: (() => void) | null = null;
  private view: SyncViewState = {
    connection: 'loading',
    autoSync: true,
    dirty: false,
    backendConfigured: Boolean(getBuildTimeSyncAuthUrl()),
    sessions: [],
    progress: { phase: 'idle' },
    rootChoices: [],
    conflicts: [],
    resetRequired: false,
  };

  constructor(
    loadDeviceState: typeof loadSyncDeviceState = loadSyncDeviceState,
    private readonly soundFeedback: Pick<
      SyncSoundFeedback,
      'notify'
    > = getSyncSoundFeedback(),
  ) {
    this.loadDeviceState = loadDeviceState;
  }

  initialize(): Promise<void> {
    this.initializationPromise ??= this.initializeOnce();
    return this.initializationPromise;
  }

  private async initializeOnce(): Promise<void> {
    try {
      this.state = await this.loadDeviceState();
    } catch (error) {
      const persistenceError =
        error instanceof LocalSyncPersistenceError
          ? error
          : new LocalSyncPersistenceError('read', error);
      const issue = classifySyncError(persistenceError, {
        online: browserIsOnline(),
        area: 'initialization',
      });
      this.updateView(
        {
          connection: 'error',
          progress: { phase: 'idle' },
          error: issue.message,
          issue,
        },
        { notify: false },
      );
      throw persistenceError;
    }
    const backendUrl = getBuildTimeSyncAuthUrl();
    this.updateView(
      {
        connection: backendUrl ? 'disconnected' : 'not-configured',
        autoSync: this.state.autoSync,
        dirty: this.state.dirty,
        backendConfigured: Boolean(backendUrl),
        lastSuccessfulAt: this.state.lastSuccessfulAt,
        conflicts: this.state.conflicts,
        resetRequired: this.state.resetIncomplete === true,
        error: this.state.resetIncomplete
          ? createResetIncompleteIssue().message
          : undefined,
        issue: this.state.resetIncomplete ? createResetIncompleteIssue() : undefined,
      },
      { notify: false },
    );
    this.removePersistentListener = subscribeToPersistentChanges(
      () => void this.markDirty().catch(() => undefined),
    );
    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    this.periodicTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && this.canSyncAutomatically) {
        void this.syncNow('periodic').catch(() => undefined);
      }
    }, ACTIVE_PULL_INTERVAL);
    if (!backendUrl) return;
    this.identity.configure(
      backendUrl,
      this.state.deviceId,
      this.state.googleDeviceSessionToken,
    );
    this.updateView({
      connection: this.identity.hasDeviceSession ? 'connecting' : 'disconnected',
    });
    try {
      const exchange = await this.identity.completeAuthorizationIfPresent();
      if (exchange) {
        this.state.googleDeviceSessionToken = exchange.sessionToken;
        await this.persistState(this.state);
      }
      if (!this.identity.hasDeviceSession) {
        this.updateView({ connection: 'disconnected', error: undefined, sessions: [] });
        return;
      }
      await this.ensureRepository();
      await this.refreshSessions();
      this.updateView({ connection: 'connected', error: undefined });
      if (exchange) {
        void this.syncNow('connect').catch(() => undefined);
      } else if (this.state.dirty && this.canSyncAutomatically) {
        void this.syncNow('automatic').catch(() => undefined);
      }
    } catch (error) {
      await this.handleAuthenticationError(error);
    }
  }

  destroy(): void {
    this.removePersistentListener?.();
    window.removeEventListener('online', this.handleOnline);
    window.removeEventListener('offline', this.handleOffline);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.clearAutoSyncTimer();
    if (this.periodicTimer !== null) clearInterval(this.periodicTimer);
    this.activeSyncCycleId = null;
    this.activeApplyAbortController?.abort();
    this.abortController?.abort();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncViewState {
    return this.view;
  }

  async connect(): Promise<void> {
    await this.initialize();
    if (!this.view.backendConfigured) {
      this.updateView({ connection: 'not-configured' });
      throw new Error('Persistent sync backend not configured.');
    }
    this.updateView({ connection: 'connecting', error: undefined });
    try {
      await this.identity.beginAuthorization();
    } catch (error) {
      await this.handleAuthenticationError(error);
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    await this.initialize();
    if (!this.view.backendConfigured)
      throw new Error('Persistent sync backend not configured.');
    this.updateView({ connection: 'connecting', error: undefined });
    try {
      await this.identity.beginAuthorization({ forceConsent: true });
    } catch (error) {
      await this.handleAuthenticationError(error);
      throw error;
    }
  }

  async retryNow(): Promise<void> {
    await this.initialize();
    if (!this.identity.hasDeviceSession) {
      await this.connect();
      return;
    }
    await this.syncNow('manual');
  }

  async switchGoogleAccount(): Promise<void> {
    await this.initialize();
    if (!this.view.backendConfigured)
      throw new Error('Persistent sync backend not configured.');
    this.beginDisconnecting();
    try {
      await this.stopActiveSync();
      if (this.identity.hasDeviceSession) {
        await this.identity.disconnectCurrent();
        const state = this.requireState();
        delete state.googleDeviceSessionToken;
        await this.persistState(state);
        this.repository = null;
        this.updateView({ sessions: [] });
      }
      this.updateView({ connection: 'connecting', error: undefined });
      await this.identity.beginAuthorization({
        forceConsent: true,
        switchAccount: true,
      });
    } catch (error) {
      await this.handleAuthenticationError(error);
      throw error;
    } finally {
      this.disconnecting = false;
    }
  }

  async disconnect(): Promise<void> {
    await this.initialize();
    this.beginDisconnecting();
    try {
      await this.stopActiveSync();
      await this.identity.disconnectCurrent();
      await this.completeDisconnect();
    } catch (error) {
      await this.handleAuthenticationError(error);
      throw error;
    } finally {
      this.disconnecting = false;
    }
  }

  async disconnectAll(): Promise<void> {
    await this.initialize();
    this.beginDisconnecting();
    try {
      await this.stopActiveSync();
      await this.identity.disconnectAll();
      await this.completeDisconnect();
    } catch (error) {
      await this.handleAuthenticationError(error);
      throw error;
    } finally {
      this.disconnecting = false;
    }
  }

  async refreshSessions(): Promise<void> {
    if (!this.identity.hasDeviceSession) {
      this.updateView({ sessions: [] });
      return;
    }
    this.updateView({ sessions: await this.identity.listSessions() });
  }

  async setAutoSync(enabled: boolean): Promise<void> {
    await this.initialize();
    if (this.resetting) throw new Error('Google Drive reset is currently running.');
    const state = this.requireState();
    state.autoSync = enabled;
    if (state.resetIncomplete) state.autoSyncBeforeReset = enabled;
    await this.persistState(state);
    this.updateView({ autoSync: enabled });
    if (!enabled) this.clearAutoSyncTimer();
    else if (state.dirty) this.scheduleAutoSync();
  }

  async chooseRoot(rootId: string): Promise<void> {
    const state = this.requireState();
    const root = this.view.rootChoices.find((candidate) => candidate.id === rootId);
    if (!root || !this.repository)
      throw new Error('The selected Drive folder is no longer available.');
    this.repository.chooseRoot(root, state);
    await this.persistState(state);
    this.updateView({ connection: 'connected', rootChoices: [], error: undefined });
    await this.syncNow('root-selection');
  }

  async createReplacementRoot(): Promise<void> {
    await this.initialize();
    if (!this.identity.hasDeviceSession) {
      this.updateView({ connection: 'reconnect-required' });
      throw new Error('Reconnect Google Drive before creating a replacement folder.');
    }
    const state = this.requireState();
    state.driveFiles = { fileIds: {} };
    delete state.remoteManifestVersion;
    delete state.remoteManifest;
    delete state.remoteSnapshot;
    await this.persistState(state);
    await this.ensureRepository();
    this.updateView({ connection: 'connected', error: undefined, rootUrl: undefined });
    await this.syncNow('root-recovery');
  }

  async dismissConflict(conflictId: string): Promise<void> {
    const state = this.requireState();
    state.conflicts = state.conflicts.map((conflict) =>
      conflict.id === conflictId ? { ...conflict, dismissedAt: Date.now() } : conflict,
    );
    await this.persistState(state);
    this.updateView({ conflicts: state.conflicts });
  }

  retryIntegrityVerification(): Promise<void> {
    if (!this.integrityFailure) {
      return Promise.reject(new Error('No Google Drive integrity failure is active.'));
    }
    return this.syncNow('integrity-retry');
  }

  repairIntegrityFromLocal(): Promise<void> {
    if (!this.integrityFailure) {
      return Promise.reject(new Error('No Google Drive integrity failure is active.'));
    }
    return this.syncNow('integrity-repair');
  }

  preserveAndMergeRemoteIntegrityGeneration(): Promise<void> {
    if (!this.integrityFailure) {
      return Promise.reject(new Error('No Google Drive integrity failure is active.'));
    }
    return this.syncNow('integrity-remote-merge');
  }

  resetDriveSyncFromThisDevice(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.resetting = true;
    const run = this.runDriveResetRequest();
    const trackedRun = run.finally(() => {
      this.resetting = false;
      if (this.resetPromise === trackedRun) this.resetPromise = null;
      if (this.state?.dirty && this.canSyncAutomatically) this.scheduleAutoSync();
    });
    this.resetPromise = trackedRun;
    return trackedRun;
  }

  private async runDriveResetRequest(): Promise<void> {
    await this.initialize();
    if (this.disconnecting) throw new Error('Google Drive is disconnecting.');
    this.clearAutoSyncTimer();
    await this.stopActiveSync();
    await this.syncNow('drive-reset');
  }

  cancel(): void {
    this.clearAutoSyncTimer();
    this.abortController?.abort(new DOMException('Sync cancelled.', 'AbortError'));
  }

  private async stopActiveSync(): Promise<void> {
    this.cancel();
    await this.syncPromise?.catch(() => undefined);
  }

  private beginDisconnecting(): void {
    if (this.disconnecting) throw new Error('Google Drive is already disconnecting.');
    this.disconnecting = true;
    this.updateView({
      connection: 'disconnecting',
      progress: { phase: 'idle' },
      error: undefined,
    });
  }

  private async completeDisconnect(): Promise<void> {
    const state = this.requireState();
    delete state.googleDeviceSessionToken;
    await this.persistState(state);
    this.repository = null;
    this.integrityFailure = null;
    this.updateView({
      connection: this.view.backendConfigured ? 'disconnected' : 'not-configured',
      progress: { phase: 'idle' },
      rootChoices: [],
      rootUrl: undefined,
      sessions: [],
      error: undefined,
      integrityIssue: undefined,
    });
  }

  syncNow(
    reason:
      | 'manual'
      | 'connect'
      | 'reconnect'
      | 'automatic'
      | 'periodic'
      | 'online'
      | 'visible'
      | 'root-selection'
      | 'root-recovery'
      | 'integrity-retry'
      | 'integrity-repair'
      | 'integrity-remote-merge'
      | 'drive-reset' = 'manual',
  ): Promise<void> {
    if (this.disconnecting) {
      return Promise.reject(new Error('Google Drive is disconnecting.'));
    }
    if (reason !== 'drive-reset' && (this.resetting || this.state?.resetIncomplete)) {
      return Promise.reject(
        new Error('Finish or retry the Google Drive reset before ordinary sync.'),
      );
    }
    if (this.syncPromise) return this.syncPromise;

    const cycleId = ++this.syncCycleSequence;
    const controller = new AbortController();
    this.activeSyncCycleId = cycleId;
    this.abortController = controller;
    const run = this.runSyncCycle(reason, cycleId, controller.signal);
    const trackedRun = run.finally(() => {
      if (this.activeSyncCycleId === cycleId) this.activeSyncCycleId = null;
      if (this.abortController === controller) this.abortController = null;
      if (this.syncPromise === trackedRun) this.syncPromise = null;
    });
    this.syncPromise = trackedRun;
    return trackedRun;
  }

  private async runSyncCycle(
    _reason:
      | 'manual'
      | 'connect'
      | 'reconnect'
      | 'automatic'
      | 'periodic'
      | 'online'
      | 'visible'
      | 'root-selection'
      | 'root-recovery'
      | 'integrity-retry'
      | 'integrity-repair'
      | 'integrity-remote-merge'
      | 'drive-reset',
    cycleId: number,
    signal: AbortSignal,
  ): Promise<void> {
    void _reason;
    try {
      await this.initialize();
      signal.throwIfAborted();
      if (!navigator.onLine) {
        const offline = classifySyncError(undefined, {
          online: false,
          area: 'sync',
        });
        this.applyIssue(issueForOfflineTransition(this.view.issue, offline), cycleId);
        return;
      }
      if (!this.identity.hasDeviceSession) {
        this.updateCycleView(cycleId, {
          connection: this.view.backendConfigured
            ? 'reconnect-required'
            : 'not-configured',
          progress: { phase: 'idle' },
        });
        throw new Error('Connect Google Drive before syncing.');
      }
      if (!this.repository) {
        await this.ensureRepository();
      }
      signal.throwIfAborted();
      this.clearAutoSyncTimer();
      if (_reason === 'drive-reset') {
        await this.performDriveReset(cycleId, signal);
        return;
      }
      if (_reason === 'integrity-retry') {
        try {
          await this.performReadOnlyIntegrityVerification(cycleId, signal);
        } catch (error) {
          await this.handleSyncError(error, cycleId);
          throw error;
        }
        return;
      }
      if (_reason === 'integrity-repair' || _reason === 'integrity-remote-merge') {
        try {
          await this.performIntegrityRepair(
            cycleId,
            signal,
            _reason === 'integrity-remote-merge' ? 'remote' : 'local',
          );
        } catch (error) {
          if (error instanceof RemoteManifestChangedError) {
            this.updateCycleView(cycleId, {
              connection: 'syncing',
              progress: { phase: 'pulling', detail: 'Drive changed; verifying again' },
              error: undefined,
            });
          } else {
            await this.handleSyncError(error, cycleId);
            throw error;
          }
        }
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.performSync(cycleId, signal);
          break;
        } catch (error) {
          if (error instanceof RemoteManifestChangedError && attempt === 0) {
            this.updateCycleView(cycleId, {
              connection: 'syncing',
              progress: { phase: 'pulling', detail: 'Drive changed; pulling again' },
              error: undefined,
            });
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (signal.aborted) {
        if (this.disconnecting) {
          this.updateCycleView(cycleId, { progress: { phase: 'idle' } });
        } else {
          this.applyIssue(
            classifySyncError(
              error instanceof DOMException
                ? error
                : new DOMException('Sync cancelled.', 'AbortError'),
              {
                online: browserIsOnline(),
                area: 'sync',
                pendingLocalChanges: this.state?.dirty === true,
              },
            ),
            cycleId,
          );
        }
        throw error;
      }
      if (!this.repository) await this.handleAuthenticationError(error, cycleId);
      throw error;
    }
  }

  private async performDriveReset(cycleId: number, signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    const repository = this.repository;
    if (!repository) throw new Error('Google Drive is not connected.');
    const autoSyncAfterReset = state.autoSyncBeforeReset ?? state.autoSync;
    const originalDirty = state.dirty;
    const resetWasAlreadyIncomplete = state.resetIncomplete === true;
    let resetMarkerPersisted = false;
    const releaseEditingLock = this.acquireEditingLock();
    try {
      state.lastAttemptedAt = Date.now();
      this.updateCycleView(cycleId, {
        connection: 'syncing',
        progress: {
          phase: 'verifying',
          detail: 'Validating this device before Drive reset',
        },
        error: undefined,
      });
      await this.flushPersistence();
      signal.throwIfAborted();
      const snapshotGeneration = state.dirtyGeneration;
      const local = await this.local.createSnapshot(state);
      this.local.validateSnapshot(local);
      await validateLocalResetPdfs(local.pdfs);
      if (state.dirtyGeneration !== snapshotGeneration) {
        throw new LocalChangedDuringSyncError();
      }

      state.autoSyncBeforeReset = autoSyncAfterReset;
      state.autoSync = false;
      state.resetIncomplete = true;
      state.dirty = true;
      await this.persistState(state);
      resetMarkerPersisted = true;
      this.updateCycleView(cycleId, {
        autoSync: false,
        dirty: true,
        resetRequired: true,
        progress: { phase: 'resetting', detail: 'Preparing the selected Drive folder' },
      });

      const reset = await repository.resetFromLocal(
        local,
        local.pdfs,
        state,
        signal,
        (progress) => this.updateCycleView(cycleId, { progress }),
      );
      signal.throwIfAborted();
      this.updateCycleView(cycleId, { progress: { phase: 'finalizing' } });

      state.entityVersions = Object.fromEntries(
        reset.snapshot.entities.map((entity) => [entity.key, entity.version]),
      );
      state.baselineHashes = Object.fromEntries(
        reset.snapshot.entities.map((entity) => [entity.key, entity.version.hash]),
      );
      state.tombstones = reset.snapshot.tombstones;
      state.remoteSnapshot = reset.snapshot;
      state.remoteManifestVersion = reset.manifestVersion;
      state.lastSuccessfulAt = Date.now();
      state.dirty = state.dirtyGeneration !== snapshotGeneration;
      state.autoSync = autoSyncAfterReset;
      delete state.autoSyncBeforeReset;
      delete state.resetIncomplete;
      await this.persistState(state);
      this.integrityFailure = null;
      const summary: SyncSummary = {
        localDocuments: countDocuments(local),
        cloudDocuments: countDocuments(reset.snapshot),
        mergedDocuments: countDocuments(reset.snapshot),
        pdfsDownloaded: 0,
        pdfsUploaded: reset.pdfsUploaded,
        filesUpdated: reset.filesUpdated,
        conflictsPreserved: state.conflicts.length,
      };
      this.transientRetryAttempt = 0;
      this.consecutiveUploadFailures = 0;
      this.updateCycleView(
        cycleId,
        {
          connection: 'connected',
          autoSync: state.autoSync,
          dirty: state.dirty,
          lastSuccessfulAt: state.lastSuccessfulAt,
          progress: { phase: 'idle' },
          summary,
          conflicts: state.conflicts,
          rootUrl: repository.getRootFolderUrl() ?? undefined,
          error: undefined,
          integrityIssue: undefined,
          resetRequired: false,
        },
        { actualWork: !state.dirty },
      );
    } catch (error) {
      if (resetMarkerPersisted || resetWasAlreadyIncomplete) {
        state.resetIncomplete = true;
        state.autoSyncBeforeReset = autoSyncAfterReset;
        state.autoSync = false;
        state.dirty = true;
      } else {
        delete state.resetIncomplete;
        delete state.autoSyncBeforeReset;
        state.autoSync = autoSyncAfterReset;
        state.dirty = originalDirty;
      }
      let reportedError = error;
      try {
        await this.persistState(state);
      } catch (persistenceError) {
        reportedError = persistenceError;
      }
      await this.handleSyncError(reportedError, cycleId);
      this.updateCycleView(cycleId, {
        autoSync: state.autoSync,
        dirty: state.dirty,
        progress: { phase: 'idle' },
        resetRequired: state.resetIncomplete === true,
      });
      throw error;
    } finally {
      releaseEditingLock();
    }
  }

  private async performSync(cycleId: number, signal: AbortSignal): Promise<void> {
    const state = this.requireState();
    const repository = this.repository;
    if (!repository) throw new Error('Google Drive is not connected.');
    state.lastAttemptedAt = Date.now();
    this.updateCycleView(cycleId, {
      connection: 'syncing',
      progress: {
        phase: 'discovering',
        detail: 'Discovering immutable Drive generations',
      },
      error: undefined,
    });
    await this.persistState(state);
    try {
      await this.flushPersistence();
      const remote = await repository.pull(state, signal);
      this.updateCycleView(cycleId, {
        progress: { phase: 'merging' },
        rootUrl: repository.getRootFolderUrl() ?? undefined,
      });
      const snapshotGeneration = state.dirtyGeneration;
      const local = await this.local.createSnapshot(state);
      if (state.dirtyGeneration !== snapshotGeneration) {
        throw new LocalChangedDuringSyncError();
      }
      const merged = mergeSyncSnapshots(local, remote.snapshot, state.baselineHashes);
      const syncDidWork = !haveEquivalentSyncContent(local, merged.snapshot);
      const availablePdfs = new Map<string, StoredPdfFile>();
      const localPdfByHash = new Map(local.pdfs.map((pdf) => [pdf.sha256, pdf]));
      let pdfsDownloaded = 0;
      const totalPdfsToDownload = merged.snapshot.pdfs.filter(
        (pdf) => !localPdfByHash.has(pdf.sha256),
      ).length;
      for (const pdf of merged.snapshot.pdfs) {
        const localPdf = localPdfByHash.get(pdf.sha256);
        if (localPdf) {
          availablePdfs.set(pdf.documentId, localPdf);
          continue;
        }
        this.updateCycleView(cycleId, {
          progress: {
            phase: 'downloading',
            completed: pdfsDownloaded,
            total: totalPdfsToDownload,
            detail: pdf.fileName,
          },
        });
        availablePdfs.set(pdf.documentId, await repository.downloadPdf(pdf, signal));
        pdfsDownloaded += 1;
        this.updateCycleView(cycleId, {
          progress: {
            phase: 'downloading',
            completed: pdfsDownloaded,
            total: totalPdfsToDownload,
          },
        });
      }

      if (state.dirtyGeneration !== snapshotGeneration) {
        throw new LocalChangedDuringSyncError();
      }
      this.updateCycleView(cycleId, {
        progress: { phase: 'merging', detail: 'Applying synchronized data' },
      });
      const applyController = new AbortController();
      const abortApply = () => applyController.abort(signal.reason);
      signal.addEventListener('abort', abortApply, { once: true });
      this.activeApplyAbortController = applyController;
      const releaseEditingLock = this.acquireEditingLock();
      let applyResult: SyncApplyResult;
      try {
        await this.flushPersistence();
        if (state.dirtyGeneration !== snapshotGeneration) {
          throw new LocalChangedDuringSyncError();
        }
        applyResult = await this.local.applySnapshot(
          merged.snapshot,
          availablePdfs,
          applyController.signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (applyController.signal.aborted) throw new LocalChangedDuringSyncError();
        throw error;
      } finally {
        releaseEditingLock();
        signal.removeEventListener('abort', abortApply);
        if (this.activeApplyAbortController === applyController) {
          this.activeApplyAbortController = null;
        }
      }
      state.entityVersions = Object.fromEntries(
        merged.snapshot.entities.map((entity) => [entity.key, entity.version]),
      );
      state.tombstones = merged.snapshot.tombstones;
      state.conflicts = mergeConflictJournal(
        state.conflicts,
        remote.conflicts ?? [],
        merged.conflicts,
      );
      await this.persistState(state);
      if (state.dirtyGeneration !== snapshotGeneration) {
        throw new LocalChangedDuringSyncError();
      }
      const outbound: SyncSnapshot = {
        ...merged.snapshot,
        generatedAt: Date.now(),
        generatedBy: state.deviceId,
      };
      const needsPush =
        remote.requiresPublicationUpgrade ||
        !haveEquivalentSyncContent(outbound, remote.snapshot);
      let finalSnapshot = remote.snapshot;
      let pdfsUploaded = 0;
      let filesUpdated = 0;
      let manifestVersion = remote.manifestVersion;
      if (needsPush) {
        this.updateCycleView(cycleId, {
          progress: { phase: 'uploading', detail: 'Updating Google Drive' },
        });
        const pdfsForPush: LocalSyncPdf[] = merged.snapshot.pdfs.map((descriptor) => {
          const stored = availablePdfs.get(descriptor.documentId);
          if (!stored)
            throw new Error(`Original PDF ${descriptor.documentId} is unavailable.`);
          return { ...descriptor, blob: stored.blob };
        });
        const pushed = await repository.push(
          outbound,
          pdfsForPush,
          state,
          signal,
          (progress) => this.updateCycleView(cycleId, { progress }),
        );
        finalSnapshot = pushed.snapshot;
        pdfsUploaded = pushed.pdfsUploaded;
        filesUpdated = pushed.filesUpdated;
        manifestVersion = pushed.manifestVersion;
      }

      signal.throwIfAborted();
      this.updateCycleView(cycleId, {
        progress: { phase: 'finalizing' },
      });

      state.entityVersions = Object.fromEntries(
        finalSnapshot.entities.map((entity) => [entity.key, entity.version]),
      );
      state.baselineHashes = Object.fromEntries(
        finalSnapshot.entities.map((entity) => [entity.key, entity.version.hash]),
      );
      state.tombstones = finalSnapshot.tombstones;
      state.conflicts = mergeConflictJournal(
        state.conflicts,
        remote.conflicts ?? [],
        merged.conflicts,
      );
      state.remoteSnapshot = finalSnapshot;
      state.remoteManifestVersion = manifestVersion;
      state.lastSuccessfulAt = Date.now();
      state.dirty = state.dirtyGeneration !== snapshotGeneration;
      await this.persistState(state);
      signal.throwIfAborted();
      const summary: SyncSummary = {
        localDocuments: countDocuments(local),
        cloudDocuments: countDocuments(remote.snapshot),
        mergedDocuments: countDocuments(finalSnapshot),
        pdfsDownloaded,
        pdfsUploaded,
        filesUpdated,
        conflictsPreserved: mergeConflictJournal(
          remote.conflicts ?? [],
          merged.conflicts,
        ).length,
      };
      this.transientRetryAttempt = 0;
      this.consecutiveUploadFailures = 0;
      this.updateCycleView(
        cycleId,
        {
          connection: 'connected',
          dirty: state.dirty,
          lastSuccessfulAt: state.lastSuccessfulAt,
          progress: { phase: 'idle' },
          summary,
          conflicts: state.conflicts,
          rootUrl: repository.getRootFolderUrl() ?? undefined,
          error: undefined,
          integrityIssue: undefined,
        },
        { actualWork: !state.dirty && (syncDidWork || needsPush) },
      );
      this.integrityFailure = null;
      if (this.activeSyncCycleId === cycleId) {
        window.dispatchEvent(
          new CustomEvent('39note:sync-applied', {
            detail: {
              changedDocumentIds: applyResult.changedDocumentIds,
              deletedDocumentIds: applyResult.deletedDocumentIds,
            },
          }),
        );
      }
      if (state.dirty) this.scheduleAutoSync();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      } else if (error instanceof MultipleDriveRootsError) {
        this.applyIssue(
          classifySyncError(error, { online: browserIsOnline(), area: 'sync' }),
          cycleId,
          { rootChoices: error.roots },
        );
      } else if (error instanceof DriveRootUnavailableError) {
        this.applyIssue(
          classifySyncError(error, { online: browserIsOnline(), area: 'sync' }),
          cycleId,
        );
      } else if (error instanceof LocalChangedDuringSyncError) {
        state.dirty = true;
        await this.persistState(state);
        this.applyIssue(createLocalChangesWaitingIssue(), cycleId, { dirty: true });
        this.scheduleAutoSync();
      } else {
        await this.handleSyncError(error, cycleId);
      }
      throw error;
    }
  }

  private async markDirty(): Promise<void> {
    const state = this.requireState();
    state.dirty = true;
    state.dirtyGeneration += 1;
    this.activeApplyAbortController?.abort(
      new DOMException('Local data changed during sync application.', 'AbortError'),
    );
    this.updateView({ dirty: true });
    this.scheduleAutoSync();
    await this.persistState(state);
  }

  private async performReadOnlyIntegrityVerification(
    cycleId: number,
    signal: AbortSignal,
  ): Promise<void> {
    const priorFailure = this.integrityFailure;
    const repository = this.repository;
    if (!priorFailure || !repository) {
      throw new Error('No Google Drive integrity failure is active.');
    }
    this.updateCycleView(cycleId, {
      connection: 'syncing',
      progress: {
        phase: 'pulling',
        detail: 'Read-only integrity verification',
      },
      error: undefined,
    });
    const verification = await repository.verifyIntegrityFailureReadOnly(
      priorFailure,
      signal,
    );
    signal.throwIfAborted();
    const currentFailure = verification.failure ?? priorFailure;
    const diagnostic = await this.assessIntegrityIssue(
      currentFailure,
      verification.diagnostic,
      verification.verifiedPayload,
    );
    this.integrityFailure = currentFailure;
    this.applyIssue(
      classifySyncError(currentFailure, {
        online: browserIsOnline(),
        area: 'sync',
      }),
      cycleId,
      { integrityIssue: diagnostic },
    );
  }

  private async assessIntegrityIssue(
    failure: GoogleDrivePayloadIntegrityError,
    baseDiagnostic: SyncIntegrityIssue = failure.diagnostic,
    verifiedPayload?: CloudEntityPayload,
  ): Promise<SyncIntegrityIssue> {
    const state = this.requireState();
    const repository = this.repository;
    const diagnosticState: SyncDeviceState = {
      ...state,
      pdfFingerprints: Object.fromEntries(
        Object.entries(state.pdfFingerprints).map(([key, value]) => [
          key,
          { ...value },
        ]),
      ),
    };
    let localSnapshot: SyncSnapshot | undefined;
    try {
      const current = await this.local.createSnapshot(diagnosticState);
      this.local.validateSnapshot(current);
      localSnapshot = current;
    } catch {
      localSnapshot = undefined;
    }
    const cachedSnapshot = this.validatedSnapshotOrUndefined(state.remoteSnapshot);
    const locallyHeldCandidates = [localSnapshot, cachedSnapshot].filter(
      (candidate): candidate is SyncSnapshot => Boolean(candidate),
    );
    const localPayloadSemanticallyValid = Boolean(
      localSnapshot && payloadForContext(localSnapshot, failure.context),
    );
    const diagnosticRemotePayload =
      baseDiagnostic.verificationState === 'verified'
        ? verifiedPayload
        : failure.actualPayload;
    const remotePayloadSemanticallyValid = Boolean(
      diagnosticRemotePayload &&
      locallyHeldCandidates.some((candidate) =>
        this.isPayloadSemanticallyValidForContext(
          failure,
          candidate,
          diagnosticRemotePayload,
        ),
      ),
    );
    const immutableManifestRecoveryAvailable =
      baseDiagnostic.immutableManifestRecoveryAvailable;
    const localRepairAvailable =
      immutableManifestRecoveryAvailable &&
      baseDiagnostic.verificationState === 'mismatch' &&
      Boolean(
        repository &&
        (await firstSuccessfulCandidate(locallyHeldCandidates, (candidate) =>
          repository.canRepairFromSnapshot(failure, candidate),
        )),
      );
    const remoteMergeAvailable =
      immutableManifestRecoveryAvailable &&
      baseDiagnostic.verificationState === 'mismatch' &&
      Boolean(
        repository &&
        remotePayloadSemanticallyValid &&
        (await firstSuccessfulCandidate(locallyHeldCandidates, (candidate) =>
          this.canSafelyMergeRemoteGeneration(failure, candidate),
        )),
      );
    const recommendedRecoveryChoices: SyncIntegrityIssue['recommendedRecoveryChoices'] =
      baseDiagnostic.verificationState === 'verified'
        ? ['continue-sync']
        : [
            ...(localRepairAvailable ? (['repair-from-local'] as const) : []),
            ...(remoteMergeAvailable ? (['preserve-and-merge-remote'] as const) : []),
          ];
    if (recommendedRecoveryChoices.length === 0) {
      recommendedRecoveryChoices.push('manual-inspection');
    }
    const documentTitle =
      failure.context.documentId &&
      diagnosticDocumentTitle(
        localSnapshot ?? cachedSnapshot,
        failure.context.documentId,
      );
    return {
      ...baseDiagnostic,
      ...(documentTitle ? { documentTitle } : {}),
      validAlternateGenerationAvailable:
        baseDiagnostic.verificationState === 'mismatch' &&
        Boolean(failure.actualPayload && remotePayloadSemanticallyValid),
      localPayloadSemanticallyValid,
      remotePayloadSemanticallyValid,
      immutableManifestRecoveryAvailable,
      recommendedRecoveryChoices,
      localRepairAvailable,
      remoteMergeAvailable,
    };
  }

  private validatedSnapshotOrUndefined(
    snapshot: SyncSnapshot | undefined,
  ): SyncSnapshot | undefined {
    if (!snapshot) return undefined;
    try {
      this.local.validateSnapshot(snapshot);
      return snapshot;
    } catch {
      return undefined;
    }
  }

  private async performIntegrityRepair(
    cycleId: number,
    signal: AbortSignal,
    source: 'local' | 'remote',
  ): Promise<void> {
    const failure = this.integrityFailure;
    const repository = this.repository;
    const state = this.requireState();
    if (!failure || !repository) {
      throw new Error('No verified Google Drive repair candidate is available.');
    }
    this.updateCycleView(cycleId, {
      connection: 'syncing',
      progress: {
        phase: 'finalizing',
        detail:
          source === 'remote'
            ? 'Preserving the valid Drive generation for merge'
            : 'Verifying the local repair copy',
      },
      error: undefined,
    });
    await this.flushPersistence();
    signal.throwIfAborted();
    const current = await this.local.createSnapshot(state);
    const candidate =
      source === 'remote'
        ? (await repository.canMergeValidRemoteFromSnapshot(failure, current))
          ? current
          : state.remoteSnapshot &&
              (await repository.canMergeValidRemoteFromSnapshot(
                failure,
                state.remoteSnapshot,
              ))
            ? state.remoteSnapshot
            : null
        : (await repository.canRepairFromSnapshot(failure, current))
          ? current
          : state.remoteSnapshot &&
              (await repository.canRepairFromSnapshot(failure, state.remoteSnapshot))
            ? state.remoteSnapshot
            : null;
    if (!candidate) {
      throw new Error(
        'The local copy no longer matches the failed Drive generation. Retry verification first.',
      );
    }
    let recoveryConflicts: SyncConflict[];
    if (source === 'remote') {
      if (!(await this.canSafelyMergeRemoteGeneration(failure, candidate))) {
        throw new Error(
          'The Drive generation failed semantic validation, so 39Note refused to publish it.',
        );
      }
      recoveryConflicts = await repository.repairFromValidRemoteGeneration(
        failure,
        candidate,
        state,
        signal,
      );
    } else {
      recoveryConflicts = await repository.repairPayloadFromSnapshot(
        failure,
        candidate,
        state,
        signal,
      );
    }
    state.conflicts = mergeConflictJournal(state.conflicts, recoveryConflicts);
    await this.persistState(state);
  }

  private async canSafelyMergeRemoteGeneration(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
  ): Promise<boolean> {
    if (
      !this.repository ||
      !failure.actualPayload ||
      !(await this.repository.canMergeValidRemoteFromSnapshot(failure, snapshot))
    ) {
      return false;
    }
    return this.isPayloadSemanticallyValidForContext(
      failure,
      snapshot,
      failure.actualPayload,
    );
  }

  private isPayloadSemanticallyValidForContext(
    failure: GoogleDrivePayloadIntegrityError,
    snapshot: SyncSnapshot,
    payload: CloudEntityPayload,
  ): boolean {
    const prospective = replacePayloadForContext(snapshot, failure.context, payload);
    if (!prospective) return false;
    try {
      this.local.validateSnapshot(prospective);
      return true;
    } catch {
      return false;
    }
  }

  private acquireEditingLock(): () => void {
    const appRoot =
      typeof document.querySelector === 'function'
        ? document.querySelector<HTMLElement>('.app-layout')
        : null;
    if (!appRoot) return () => undefined;
    const wasInert = appRoot.inert;
    const previousBusy = appRoot.getAttribute('aria-busy');
    appRoot.inert = true;
    appRoot.setAttribute('aria-busy', 'true');
    return () => {
      appRoot.inert = wasInert;
      if (previousBusy === null) appRoot.removeAttribute('aria-busy');
      else appRoot.setAttribute('aria-busy', previousBusy);
    };
  }

  private scheduleAutoSync(): void {
    if (!this.canSyncAutomatically) return;
    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      if (!this.state?.dirty || !this.canSyncAutomatically) return;
      void this.syncNow('automatic').catch(() => undefined);
    }, AUTO_SYNC_DELAY);
  }

  private scheduleTransientRetry(): void {
    if (!this.state?.autoSync || this.resetting || this.disconnecting) return;
    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    const delay = Math.min(60_000, 5_000 * 2 ** this.transientRetryAttempt);
    this.transientRetryAttempt = Math.min(this.transientRetryAttempt + 1, 4);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      if (!this.canRetryTransiently) return;
      void this.syncNow('automatic').catch(() => undefined);
    }, delay);
  }

  private clearAutoSyncTimer(): void {
    if (this.autoSyncTimer === null) return;
    clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = null;
  }

  private async ensureRepository(): Promise<void> {
    await this.identity.ensureAccessToken();
    this.repository ??= new GoogleDriveSyncRepository(
      new DriveClient(async (forceRefresh) => {
        const token = await this.identity.ensureAccessToken(forceRefresh);
        return token.value;
      }),
    );
  }

  private async persistState(state: SyncDeviceState): Promise<void> {
    try {
      await saveSyncDeviceState(state);
    } catch (error) {
      const persistenceError =
        error instanceof LocalSyncPersistenceError
          ? error
          : new LocalSyncPersistenceError('write', error);
      const issue = classifySyncError(persistenceError, {
        online: browserIsOnline(),
        area: 'sync',
        resetIncomplete: state.resetIncomplete === true,
      });
      this.updateView({
        connection: 'error',
        progress: { phase: 'idle' },
        error: issue.message,
        issue,
      });
      throw persistenceError;
    }
  }

  private async flushPersistence(): Promise<void> {
    try {
      await flushLocalPersistence();
    } catch (error) {
      throw new LocalSyncPersistenceError('flush', error);
    }
  }

  private async handleAuthenticationError(
    error: unknown,
    cycleId?: number,
  ): Promise<void> {
    if (error instanceof GoogleReauthorizationRequiredError) {
      if (error.clearDeviceSession) {
        const state = this.requireState();
        delete state.googleDeviceSessionToken;
        this.identity.clearLocalSession();
        this.repository = null;
        await this.persistState(state);
      }
    }
    const issue = classifySyncError(error, {
      online: browserIsOnline(),
      area: 'authentication',
      resetIncomplete: this.state?.resetIncomplete === true,
      hasDeviceSession: this.identity.hasDeviceSession,
    });
    this.applyIssue(issue, cycleId, {
      ...(error instanceof GoogleReauthorizationRequiredError &&
      error.clearDeviceSession
        ? { sessions: [] }
        : {}),
    });
  }

  private async handleSyncError(error: unknown, cycleId: number): Promise<void> {
    if (
      error instanceof SyncBackendUnavailableError ||
      error instanceof GoogleReauthorizationRequiredError
    ) {
      await this.handleAuthenticationError(error, cycleId);
      return;
    }
    if (error instanceof DriveAuthorizationError) {
      this.identity.clearAccessToken();
      this.applyIssue(
        classifySyncError(error, {
          online: browserIsOnline(),
          area: 'sync',
          resetIncomplete: this.state?.resetIncomplete === true,
        }),
        cycleId,
      );
      return;
    }
    if (error instanceof GoogleDrivePayloadIntegrityError) {
      let diagnostic = error.diagnostic;
      try {
        diagnostic = await this.assessIntegrityIssue(error);
      } catch {
        diagnostic = error.diagnostic;
      }
      this.integrityFailure = error;
      this.applyIssue(
        classifySyncError(error, {
          online: browserIsOnline(),
          area: 'sync',
          resetIncomplete: this.state?.resetIncomplete === true,
        }),
        cycleId,
        { integrityIssue: diagnostic },
      );
      return;
    }
    if (error instanceof DriveRequestError && error.operation === 'upload') {
      this.consecutiveUploadFailures += 1;
    } else {
      this.consecutiveUploadFailures = 0;
    }
    const issue = classifySyncError(error, {
      online: browserIsOnline(),
      area: this.resetting ? 'reset' : 'sync',
      resetIncomplete: this.state?.resetIncomplete === true,
      repeatedUploadFailure: this.consecutiveUploadFailures >= 2,
      hasDeviceSession: this.identity.hasDeviceSession,
    });
    this.applyIssue(issue, cycleId);
  }

  private applyIssue(
    issue: SyncOperationalIssue,
    cycleId?: number,
    extra: Partial<SyncViewState> = {},
  ): void {
    this.updateCycleView(cycleId, {
      ...extra,
      connection: connectionForIssue(issue),
      progress: { phase: 'idle' },
      error: issue.message,
      issue,
    });
    if (
      issue.code === 'offline' ||
      issue.code === 'sync-service-unavailable' ||
      issue.code === 'sync-service-rate-limited' ||
      issue.code === 'drive-rate-limited' ||
      issue.code === 'drive-backend-unavailable' ||
      issue.code === 'drive-response-invalid' ||
      issue.code === 'drive-changed'
    ) {
      this.scheduleTransientRetry();
    }
  }

  private updateView(
    update: Partial<SyncViewState>,
    options: { notify?: boolean; actualWork?: boolean } = {},
  ): void {
    const previousStatus = getSyncUiStatus(this.view);
    const clearsError =
      Object.prototype.hasOwnProperty.call(update, 'error') &&
      update.error === undefined;
    const normalizedUpdate =
      clearsError && !Object.prototype.hasOwnProperty.call(update, 'issue')
        ? { ...update, issue: undefined }
        : update;
    const next = { ...this.view, ...normalizedUpdate };
    this.view =
      next.connection === 'syncing' || next.progress.phase === 'idle'
        ? next
        : { ...next, progress: { phase: 'idle' } };
    if (options.notify !== false) {
      const currentStatus = getSyncUiStatus(this.view);
      this.soundFeedback.notify({
        id: ++this.soundTransitionSequence,
        previousStatus,
        currentStatus,
        actualWork: options.actualWork === true,
      });
    }
    for (const listener of this.listeners) listener(this.view);
  }

  private updateCycleView(
    cycleId: number | undefined,
    update: Partial<SyncViewState>,
    options: { actualWork?: boolean } = {},
  ): void {
    if (cycleId !== undefined && this.activeSyncCycleId !== cycleId) return;
    this.updateView(update, options);
  }

  private requireState(): SyncDeviceState {
    if (!this.state) throw new Error('Google Drive sync is not initialized.');
    return this.state;
  }

  private get canSyncAutomatically(): boolean {
    return Boolean(
      this.state?.autoSync &&
      !this.disconnecting &&
      !this.resetting &&
      !this.state.resetIncomplete &&
      !this.integrityFailure &&
      !this.view.integrityIssue &&
      !this.view.issue?.blocksOrdinarySync &&
      this.repository &&
      this.identity.hasDeviceSession &&
      navigator.onLine,
    );
  }

  private get canRetryTransiently(): boolean {
    return Boolean(
      this.state?.autoSync &&
      !this.disconnecting &&
      !this.resetting &&
      !this.state.resetIncomplete &&
      !this.integrityFailure &&
      !this.view.integrityIssue &&
      !this.view.issue?.blocksOrdinarySync &&
      this.identity.hasDeviceSession &&
      navigator.onLine,
    );
  }

  private handleOnline = () => {
    if (this.identity.hasDeviceSession) void this.restorePersistentConnection('online');
  };

  private handleOffline = () => {
    const offline = classifySyncError(undefined, { online: false, area: 'sync' });
    const issue = issueForOfflineTransition(this.view.issue, offline);
    if (issue === this.view.issue) return;
    this.applyIssue(issue);
  };

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && this.identity.hasDeviceSession) {
      void this.restorePersistentConnection('visible');
    }
  };

  private async restorePersistentConnection(
    reason: 'online' | 'visible',
  ): Promise<void> {
    if (this.disconnecting) return;
    if (this.view.issue?.blocksOrdinarySync) return;
    try {
      await this.ensureRepository();
    } catch (error) {
      await this.handleAuthenticationError(error);
      return;
    }
    if (this.syncPromise) {
      await this.syncPromise.catch(() => undefined);
      return;
    }
    if (!this.view.issue || isTransientConnectivityIssue(this.view.issue)) {
      this.updateView({ connection: 'connected', error: undefined });
    }
    if (this.canSyncAutomatically) {
      await this.syncNow(reason).catch(() => undefined);
    }
  }

  private handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (
      !shouldWarnBeforeUnload(
        this.state?.dirty ?? false,
        Boolean(this.state?.driveFiles.rootFolderId || this.state?.lastSuccessfulAt),
      )
    )
      return;
    event.preventDefault();
    event.returnValue = '';
  };
}

class LocalChangedDuringSyncError extends Error {
  constructor() {
    super('Local data changed while the sync merge was running.');
    this.name = 'LocalChangedDuringSyncError';
  }
}

async function validateLocalResetPdfs(pdfs: readonly LocalSyncPdf[]): Promise<void> {
  const documentIds = new Set<string>();
  for (const pdf of pdfs) {
    if (
      !pdf.documentId ||
      documentIds.has(pdf.documentId) ||
      pdf.blob.size !== pdf.size ||
      (await sha256Hex(pdf.blob)) !== pdf.sha256
    ) {
      throw new Error('A local original PDF failed reset validation.');
    }
    documentIds.add(pdf.documentId);
  }
}

async function firstSuccessfulCandidate(
  candidates: readonly SyncSnapshot[],
  predicate: (candidate: SyncSnapshot) => Promise<boolean>,
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await predicate(candidate)) return true;
  }
  return false;
}

function diagnosticDocumentTitle(
  snapshot: SyncSnapshot | undefined,
  documentId: string,
): string | undefined {
  const value = snapshot?.entities.find(
    (entity) => entity.kind === 'document' && entity.id === documentId,
  )?.value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const title = [
    record.displayTitle,
    record.documentName,
    record.originalFileName,
  ].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return (
    [...(title ?? '')]
      .map((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
      })
      .join('')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 160) || undefined
  );
}

function connectionForIssue(issue: SyncOperationalIssue): SyncConnectionStatus {
  if (issue.state === 'offline') {
    return issue.code === 'sync-service-unavailable'
      ? 'backend-unavailable'
      : 'offline';
  }
  if (issue.state === 'disconnected') return 'disconnected';
  if (issue.state === 'connected') return 'connected';
  if (issue.state === 'pending') return 'connected';
  switch (issue.code) {
    case 'google-authorization-required':
      return 'reconnect-required';
    case 'drive-root-missing':
      return 'root-unavailable';
    case 'drive-root-ambiguous':
      return 'root-selection-required';
    case 'sync-not-configured':
      return 'not-configured';
    default:
      return 'error';
  }
}

function browserIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function countDocuments(snapshot: SyncSnapshot): number {
  return snapshot.entities.filter((entity) => entity.kind === 'document').length;
}

function mergeConflictJournal(
  ...journals: ReadonlyArray<readonly SyncConflict[]>
): SyncConflict[] {
  const byEvidence = new Map<string, SyncConflict>();
  for (const conflict of journals.flat()) {
    const key = stableStringify({
      entityKey: conflict.entityKey,
      winningHash: conflict.winningVersion.hash,
      alternateHash: conflict.alternateVersion.hash,
    });
    const existing = byEvidence.get(key);
    byEvidence.set(key, {
      ...(existing && existing.id < conflict.id ? existing : conflict),
      ...(existing?.dismissedAt !== undefined || conflict.dismissedAt !== undefined
        ? {
            dismissedAt: Math.max(
              existing?.dismissedAt ?? 0,
              conflict.dismissedAt ?? 0,
            ),
          }
        : {}),
    });
  }
  return [...byEvidence.values()]
    .sort(
      (first, second) =>
        second.detectedAt - first.detectedAt || first.id.localeCompare(second.id),
    )
    .slice(0, 500);
}

let singleton: GoogleDriveSyncCoordinator | null = null;

export function getGoogleDriveSyncCoordinator(): GoogleDriveSyncCoordinator {
  singleton ??= new GoogleDriveSyncCoordinator();
  return singleton;
}
