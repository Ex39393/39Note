import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  downloadLibraryBackup,
  getBackupCreationErrorMessage,
} from '../services/libraryBackup.ts';
import {
  getPaperGoogleDriveSyncCoordinator,
  getBlockingPaperIssueCount,
  getPaperSyncUiStatus,
  LEGACY_CLEANUP_CONFIRMATION,
  PAPER_SYNC_COORDINATOR_RUNTIME_REVISION,
  PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION,
  TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION,
  targetedPaperPurgeCandidateFromView,
  TemporaryDirtyWorkError,
  type PaperGoogleDriveSyncCoordinator,
  type PaperConnectionStatus,
  type ForgetInaccessiblePaperCandidate,
  type ForgetInaccessiblePaperDiagnostic,
  type PaperRetryDiagnosticSnapshot,
  type PaperSyncStatusDiagnosticSnapshot,
  type PaperSyncViewState,
  type TargetedPaperPurgeVisibilityDiagnostic,
  type TargetedPaperPurgePreview,
  type TargetedPaperPurgeResult,
} from './paperCoordinator.ts';
import type { PaperFolderNameNormalizationPreview } from './paperDriveRepository.ts';
import type { LegacyDriveInventory } from './legacyDriveHousekeeping.ts';
import type {
  PaperCloudSummary,
  PaperDirtyReason,
  PaperSyncState,
} from './paperTypes.ts';
import { getSyncProgressPresentation } from './progressPresentation.ts';
import {
  getPaperStatusPresentation,
  syncToneClass,
  syncToneForPaper,
  syncToneForView,
} from './syncPresentation.ts';
import type { ReaderStatusIndicatorDisplay } from '../utils/readerPreferences.ts';
import { getSyncSoundFeedback } from './syncSounds.ts';
import { defaultDirtyPaperSelection } from './paperStateMachine.ts';

const PANEL_ID = 'google-drive-paper-sync-panel';
const TITLE_ID = 'google-drive-paper-sync-title';
const DRIVE_ACCESS_TITLE_ID = 'google-drive-access-title';
const DRIVE_ACCESS_DESCRIPTION_ID = 'google-drive-access-description';
const RESTORE_RESUME_TITLE_ID = 'restore-publication-resume-title';
const RESTORE_RESUME_DESCRIPTION_ID = 'restore-publication-resume-description';
const TARGETED_PURGE_TITLE_ID = 'targeted-paper-purge-title';
const TARGETED_PURGE_DESCRIPTION_ID = 'targeted-paper-purge-description';
const FORGET_PAPER_TITLE_ID = 'forget-inaccessible-paper-title';
const FORGET_PAPER_DESCRIPTION_ID = 'forget-inaccessible-paper-description';
const GOOGLE_DRIVE_URL = 'https://drive.google.com/drive/my-drive';
/** Development runtime contract only. It is not a paper or Drive protocol version. */
export const PAPER_SYNC_CONTROL_RUNTIME_REVISION = 3 as const;

// eslint-disable-next-line react-refresh/only-export-components -- exported for pure state-model tests.
export const initialPaperSyncViewState: PaperSyncViewState = {
  connection: 'loading',
  backendConfigured: false,
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

/** Reader status is defensive against a late operation-progress update. */
// eslint-disable-next-line react-refresh/only-export-components -- pure status model is regression-tested.
export function getReaderPaperSyncUiStatus(state: PaperSyncViewState) {
  const status = getPaperSyncUiStatus(state);
  if (
    status !== 'attention' &&
    status !== 'offline' &&
    status !== 'not-configured' &&
    status !== 'disconnected' &&
    status !== 'loading' &&
    state.progress.phase !== 'idle'
  ) {
    return 'syncing' as const;
  }
  return status;
}

function assertNeverConnectionStatus(status: never): never {
  throw new Error(`Unhandled Google Drive connection status: ${String(status)}`);
}

/**
 * Connection labels are derived from the authoritative connection state. A
 * connected account may additionally have paper-level work, but it must never
 * fall through to the disconnected copy.
 */
// eslint-disable-next-line react-refresh/only-export-components -- exhaustive presentation model is regression-tested.
export function paperSyncStatusLabel(state: PaperSyncViewState): string {
  const ignoredCount = state.ignoredCloudIssues?.length ?? 0;
  const withIgnoredIssue = (label: string) =>
    ignoredCount > 0
      ? `${label} · ${ignoredCount} ignored cloud ${ignoredCount === 1 ? 'issue' : 'issues'}`
      : label;
  if (state.progress.phase === 'resetting') return 'Resetting Drive sync';
  switch (state.connection) {
    case 'loading':
      return 'Checking';
    case 'not-configured':
    case 'disconnected':
      return 'Not connected';
    case 'connecting':
      return 'Connecting';
    case 'syncing':
      return 'Syncing';
    case 'offline':
      return withIgnoredIssue('Offline');
    case 'reconnect-required':
      return 'Reconnect required';
    case 'root-selection-required':
      return 'Choose Drive folder';
    case 'root-unavailable':
      return 'Drive folder unavailable';
    case 'layout-upgrade-required':
      return 'Drive upgrade required';
    case 'migration-incomplete':
      return 'Drive upgrade incomplete';
    case 'attention':
      return 'Needs attention';
    case 'connected': {
      if (state.restorePublicationHold?.status === 'revalidating') {
        return 'Revalidating Drive';
      }
      if (state.restorePublicationHold) return 'Restore sync paused';
      if (state.progress.phase !== 'idle') return 'Syncing';
      const status = getPaperSyncUiStatus(state);
      if (status === 'attention') {
        const count = getBlockingPaperIssueCount(state);
        return count > 0
          ? `Connected · Needs attention — ${count} ${count === 1 ? 'paper' : 'papers'}`
          : 'Needs attention';
      }
      if (status === 'pending') return withIgnoredIssue('Changes waiting');
      if (status === 'synced') return withIgnoredIssue('Synced');
      return withIgnoredIssue('Connected');
    }
    default:
      return assertNeverConnectionStatus(state.connection);
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- pure presentation filter is regression-tested.
export function normalCloudPapers(
  state: Pick<PaperSyncViewState, 'papers' | 'ignoredCloudIssues'>,
): PaperCloudSummary[] {
  const ignored = new Set(
    (state.ignoredCloudIssues ?? []).map(({ documentId }) => documentId),
  );
  return state.papers.filter((paper) => !ignored.has(paper.documentId));
}

export type PaperConnectionAction = 'none' | 'connect' | 'reconnect' | 'disconnect';

// eslint-disable-next-line react-refresh/only-export-components -- exhaustive action model is regression-tested.
export function paperConnectionAction(
  connection: PaperConnectionStatus,
): PaperConnectionAction {
  switch (connection) {
    case 'loading':
    case 'not-configured':
    case 'connecting':
      return 'none';
    case 'disconnected':
      return 'connect';
    case 'reconnect-required':
      return 'reconnect';
    case 'connected':
    case 'syncing':
    case 'offline':
    case 'root-selection-required':
    case 'root-unavailable':
    case 'layout-upgrade-required':
    case 'migration-incomplete':
    case 'attention':
      return 'disconnect';
    default:
      return assertNeverConnectionStatus(connection);
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- pure status model is regression-tested.
export function readerPaperSyncLabel(state: PaperSyncViewState): string {
  return paperSyncStatusLabel(state);
}

export function ReaderSyncStatusPill({
  display = 'full',
  state,
  onOpenDrive,
}: {
  display?: ReaderStatusIndicatorDisplay;
  state: PaperSyncViewState;
  onOpenDrive(affectedDocumentIds?: readonly string[]): void;
}) {
  const status = getReaderPaperSyncUiStatus(state);
  const tone = syncToneForView(state, status);
  const label = readerPaperSyncLabel(state);
  const affectedDocumentIds = state.reminder?.paperIds ?? [];
  const updateLabel =
    affectedDocumentIds.length === 1
      ? 'Update available'
      : `${affectedDocumentIds.length} updates available`;
  if (display === 'hidden') return null;
  return (
    <button
      aria-label={
        affectedDocumentIds.length
          ? `Google Drive sync: ${label}. ${updateLabel}. Review updates`
          : `Google Drive sync: ${label}. Open Google Drive`
      }
      className={`toolbar-button sync-trigger reader-sync-status-pill is-${status} is-${display} ${syncToneClass(tone)}`}
      title={
        affectedDocumentIds.length
          ? `Google Drive sync: ${label} · ${updateLabel}`
          : `Google Drive sync: ${label}`
      }
      type="button"
      onClick={() =>
        onOpenDrive(affectedDocumentIds.length ? [...affectedDocumentIds] : undefined)
      }
    >
      <span aria-hidden="true" className="sync-status-dot" />
      <span
        className={display === 'compact' ? 'visually-hidden' : undefined}
        aria-live="polite"
      >
        Drive · {label}
      </span>
      {display === 'full' && affectedDocumentIds.length ? (
        <span className="reader-sync-update-count sync-tone-warning">
          {updateLabel}
        </span>
      ) : null}
    </button>
  );
}

/** Live Reader-only wrapper. Its button opens Home management; it owns no drawer. */
export function PaperReaderSyncStatus({
  display = 'full',
  onOpenDrive,
}: {
  display?: ReaderStatusIndicatorDisplay;
  onOpenDrive(affectedDocumentIds?: readonly string[]): void;
}) {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const soundFeedback = useMemo(() => getSyncSoundFeedback(), []);
  const [state, setState] = useState(initialPaperSyncViewState);

  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);

  useEffect(() => {
    const unlock = () => soundFeedback.unlock();
    document.addEventListener('pointerdown', unlock, { capture: true, once: true });
    document.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [soundFeedback]);

  return (
    <ReaderSyncStatusPill display={display} state={state} onOpenDrive={onOpenDrive} />
  );
}

type SelectorMode = 'download' | 'updates' | 'upload' | 'finish';

interface SelectorRequest {
  mode: SelectorMode;
  affectedDocumentIds?: string[];
}

export interface PaperUpdateReviewRequest {
  requestId: number;
  documentIds: string[];
}

interface PaperSyncDrawerProps {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  soundEnabled: boolean;
  backupBusy?: boolean;
  backupError?: string | null;
  embedded?: boolean;
  onClose?(): void;
  onOpenSelector(mode: SelectorMode, affectedDocumentIds?: readonly string[]): void;
  onSoundEnabledChange(enabled: boolean): void;
  onDownloadBackup(): void;
}

type TargetedPaperPurgeVisibilityPresentation = Omit<
  TargetedPaperPurgeVisibilityDiagnostic,
  'hiddenReason' | 'implementationRevision' | 'predicates'
> & {
  hiddenReason: string;
  implementationRevision: number;
  predicates: Record<string, boolean>;
  runtime: {
    activeUiModuleRevision: number;
    activeCoordinatorModuleRevision: number;
    mountedCoordinatorRevision: number;
    expectedVisibilityRevision: number;
    runtimeVersionsCurrent: boolean;
  };
};

function localTargetedPaperPurgeVisibility(
  diagnostic: PaperSyncStatusDiagnosticSnapshot | undefined,
): Omit<TargetedPaperPurgeVisibilityPresentation, 'runtime'> {
  const failure = diagnostic?.failure;
  const target = diagnostic?.targets[0];
  const diagnosticPresent = diagnostic !== undefined;
  const diagnosticPhaseFailed = diagnostic?.phase === 'failed';
  const diagnosticTargetCountOne = diagnostic?.targetCount === 1;
  const diagnosticFailurePresent = failure !== undefined;
  const diagnosticFailureCodeMatches = failure?.code === 'drive-integrity-mismatch';
  const diagnosticFailureBlocksOrdinarySync = failure?.blocksOrdinarySync === true;
  const diagnosticOperationMatches = failure?.operation === 'paper-presence-invalid';
  const diagnosticFailurePhaseMatches = failure?.phase === 'paper-presence-resolution';
  const diagnosticCauseMatches =
    failure?.causeCode === 'presence-control-resolution-failed';
  const failureTupleMatches = Boolean(
    diagnosticPresent &&
    diagnosticPhaseFailed &&
    diagnosticTargetCountOne &&
    diagnosticFailureCodeMatches &&
    diagnosticFailureBlocksOrdinarySync &&
    diagnosticOperationMatches &&
    diagnosticFailurePhaseMatches &&
    diagnosticCauseMatches,
  );
  const exactDiagnosticFailure = Boolean(
    failureTupleMatches && diagnosticFailureBlocksOrdinarySync,
  );
  const exactFailedDiagnosticVisible = Boolean(
    diagnosticPresent && diagnosticPhaseFailed && exactDiagnosticFailure,
  );

  return {
    implementationRevision: 0,
    visible: false,
    showRecoveryCard: failureTupleMatches,
    candidateSource: 'none',
    hiddenReason: failureTupleMatches
      ? 'runtime-coordinator-implementation-outdated'
      : 'no-exact-candidate',
    exactBlockingCandidateCount: 0,
    retryCandidateCount: diagnostic?.targetCount ?? 0,
    predicates: {
      implementationCurrent: false,
      checkpointCandidateAvailable: false,
      exactBlockingCandidateUnique: false,
      exactBlockingCandidatesUnambiguous: false,
      diagnosticPresent,
      diagnosticContextPresent: false,
      diagnosticSequenceCurrent: false,
      diagnosticPhaseFailed,
      diagnosticTargetCountOne,
      diagnosticContextTargetCountOne: false,
      diagnosticContextIdentityPresent: false,
      diagnosticFailurePresent,
      diagnosticFailureCodeMatches,
      diagnosticFailureBlocksOrdinarySync,
      diagnosticOperationMatches,
      diagnosticFailurePhaseMatches,
      diagnosticCauseMatches,
      exactDiagnosticFailure,
      exactFailedDiagnosticVisible,
      failureTupleMatches,
      diagnosticTargetPresent: target !== undefined,
      diagnosticSnapshotNeedsAttention: target?.current.status === 'needs-attention',
      diagnosticSnapshotPresencePresent: target?.current.cloudPresence === 'present',
      diagnosticUploadBlocked: target?.upload.permitted === false,
      diagnosticUploadFailedClosed:
        target?.upload.reason === 'inspection-failed-closed',
      currentStatePresent: false,
      currentStateNeedsAttention: false,
      currentPresencePresent: false,
      retryCandidateContainsCorrelatedTarget: false,
      failedInspectionEvidenceComplete: false,
      viewCandidateAvailable: false,
      candidateResolved: false,
      componentMounted: true,
      coordinatorVisibilityAvailable: false,
      runtimeVersionsCurrent: false,
      identityCorrelationExists: false,
      recoveryCardEligible: failureTupleMatches,
      previewEligible: false,
    },
  };
}

function targetedPaperPurgeVisibilityPresentation(
  coordinator: PaperGoogleDriveSyncCoordinator,
  diagnostic: PaperSyncStatusDiagnosticSnapshot | undefined,
): TargetedPaperPurgeVisibilityPresentation {
  const local = localTargetedPaperPurgeVisibility(diagnostic);
  const coordinatorVisibilityAvailable =
    typeof coordinator.getTargetedPaperPurgeVisibilityDiagnostic === 'function';
  let coordinatorDiagnostic: TargetedPaperPurgeVisibilityDiagnostic | undefined;
  if (coordinatorVisibilityAvailable) {
    try {
      coordinatorDiagnostic = coordinator.getTargetedPaperPurgeVisibilityDiagnostic();
    } catch {
      coordinatorDiagnostic = undefined;
    }
  }
  const mountedCoordinatorRevision =
    typeof coordinator.getRuntimeRevision === 'function'
      ? coordinator.getRuntimeRevision()
      : 0;
  const runtimeVersionsCurrent = Boolean(
    mountedCoordinatorRevision === PAPER_SYNC_COORDINATOR_RUNTIME_REVISION &&
    coordinatorDiagnostic?.implementationRevision ===
      TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION,
  );
  const identityCorrelationExists = Boolean(
    runtimeVersionsCurrent &&
    coordinatorDiagnostic?.visible &&
    coordinatorDiagnostic.predicates.candidateResolved,
  );
  const failureTupleMatches = local.predicates.failureTupleMatches;
  const diagnosticTargetQuarantined =
    coordinatorDiagnostic?.predicates.diagnosticTargetQuarantined === true;
  const recoveryCardEligible = Boolean(
    (failureTupleMatches && !diagnosticTargetQuarantined) ||
    coordinatorDiagnostic?.showRecoveryCard,
  );
  const previewEligible = identityCorrelationExists;
  const hiddenReason = diagnosticTargetQuarantined
    ? 'local-quarantine-active'
    : previewEligible
      ? (coordinatorDiagnostic?.hiddenReason ?? 'not-hidden')
      : failureTupleMatches && !runtimeVersionsCurrent
        ? 'runtime-coordinator-implementation-outdated'
        : failureTupleMatches
          ? (coordinatorDiagnostic?.hiddenReason ?? 'diagnostic-context-missing')
          : (coordinatorDiagnostic?.hiddenReason ?? local.hiddenReason);

  return {
    implementationRevision: coordinatorDiagnostic?.implementationRevision ?? 0,
    visible: previewEligible,
    showRecoveryCard: recoveryCardEligible,
    candidateSource: previewEligible
      ? (coordinatorDiagnostic?.candidateSource ?? 'none')
      : 'none',
    hiddenReason,
    exactBlockingCandidateCount:
      coordinatorDiagnostic?.exactBlockingCandidateCount ?? 0,
    retryCandidateCount:
      coordinatorDiagnostic?.retryCandidateCount ?? diagnostic?.targetCount ?? 0,
    predicates: {
      ...local.predicates,
      ...(coordinatorDiagnostic?.predicates ?? {}),
      diagnosticPresent: local.predicates.diagnosticPresent,
      diagnosticPhaseFailed: local.predicates.diagnosticPhaseFailed,
      diagnosticTargetCountOne: local.predicates.diagnosticTargetCountOne,
      diagnosticFailurePresent: local.predicates.diagnosticFailurePresent,
      diagnosticFailureCodeMatches: local.predicates.diagnosticFailureCodeMatches,
      diagnosticFailureBlocksOrdinarySync:
        local.predicates.diagnosticFailureBlocksOrdinarySync,
      diagnosticOperationMatches: local.predicates.diagnosticOperationMatches,
      diagnosticFailurePhaseMatches: local.predicates.diagnosticFailurePhaseMatches,
      diagnosticCauseMatches: local.predicates.diagnosticCauseMatches,
      exactDiagnosticFailure: local.predicates.exactDiagnosticFailure,
      exactFailedDiagnosticVisible: local.predicates.exactFailedDiagnosticVisible,
      failureTupleMatches,
      implementationCurrent: runtimeVersionsCurrent,
      candidateResolved: previewEligible,
      componentMounted: true,
      coordinatorVisibilityAvailable,
      runtimeVersionsCurrent,
      identityCorrelationExists,
      recoveryCardEligible,
      previewEligible,
    },
    runtime: {
      activeUiModuleRevision: PAPER_SYNC_CONTROL_RUNTIME_REVISION,
      activeCoordinatorModuleRevision: PAPER_SYNC_COORDINATOR_RUNTIME_REVISION,
      mountedCoordinatorRevision,
      expectedVisibilityRevision: TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION,
      runtimeVersionsCurrent,
    },
  };
}

export function PaperSyncControl() {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const soundFeedback = useMemo(() => getSyncSoundFeedback(), []);
  const [state, setState] = useState(initialPaperSyncViewState);
  const [isOpen, setIsOpen] = useState(false);
  const [selector, setSelector] = useState<SelectorRequest | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(soundFeedback.enabled);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);

  useEffect(() => {
    const unlock = () => soundFeedback.unlock();
    document.addEventListener('pointerdown', unlock, { capture: true, once: true });
    document.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [soundFeedback]);

  const close = () => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const changeSounds = (enabled: boolean) => {
    soundFeedback.setEnabled(enabled);
    setSoundEnabled(enabled);
    if (enabled) soundFeedback.unlock();
  };
  const downloadBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      await downloadLibraryBackup(() => undefined);
    } catch (error) {
      setBackupError(getBackupCreationErrorMessage(error));
    } finally {
      setBackupBusy(false);
    }
  };
  const openSelector = (
    mode: SelectorMode,
    affectedDocumentIds?: readonly string[],
  ) => {
    setSelector({
      mode,
      affectedDocumentIds:
        mode === 'updates' ? [...(affectedDocumentIds ?? [])] : undefined,
    });
  };

  const status = getPaperSyncUiStatus(state);
  const tone = syncToneForView(state, status);
  return (
    <div className="sync-control paper-sync-control">
      <button
        ref={triggerRef}
        aria-controls={PANEL_ID}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`toolbar-button sync-trigger is-${status} ${syncToneClass(tone)}`}
        title="Google Drive sync"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span aria-hidden="true" className="sync-status-dot" />
        {toolbarLabel(state)}
      </button>

      {!selector && state.reminder && state.reminder.dismissStage < 2 ? (
        <RemoteUpdateRecommendation
          coordinator={coordinator}
          state={state}
          onBrowse={(documentIds) => openSelector('updates', documentIds)}
        />
      ) : null}

      {isOpen ? (
        <PaperSyncDrawer
          backupBusy={backupBusy}
          backupError={backupError}
          coordinator={coordinator}
          soundEnabled={soundEnabled}
          state={state}
          onClose={close}
          onDownloadBackup={() => void downloadBackup()}
          onOpenSelector={openSelector}
          onSoundEnabledChange={changeSounds}
        />
      ) : null}

      {selector ? (
        <PaperSelectorDialog
          affectedDocumentIds={selector.affectedDocumentIds}
          coordinator={coordinator}
          mode={selector.mode}
          state={state}
          onBrowseAll={() => setSelector({ mode: 'download' })}
          onClose={() => setSelector(null)}
        />
      ) : null}
    </div>
  );
}

export function PaperSyncHomePage({
  updateReviewRequest,
  onUpdateReviewOpened,
}: {
  updateReviewRequest?: PaperUpdateReviewRequest | null;
  onUpdateReviewOpened?(requestId: number): void;
}) {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const soundFeedback = useMemo(() => getSyncSoundFeedback(), []);
  const [state, setState] = useState<PaperSyncViewState>(() =>
    coordinator.getSnapshot(),
  );
  const [selector, setSelector] = useState<SelectorRequest | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(soundFeedback.enabled);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const handledReviewRequestId = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);

  useEffect(() => {
    if (
      !updateReviewRequest ||
      updateReviewRequest.requestId === handledReviewRequestId.current
    ) {
      return;
    }
    handledReviewRequestId.current = updateReviewRequest.requestId;
    setSelector({
      mode: 'updates',
      affectedDocumentIds: [...updateReviewRequest.documentIds],
    });
    onUpdateReviewOpened?.(updateReviewRequest.requestId);
  }, [onUpdateReviewOpened, updateReviewRequest]);

  const openSelector = (
    mode: SelectorMode,
    affectedDocumentIds?: readonly string[],
  ) => {
    setSelector({
      mode,
      affectedDocumentIds:
        mode === 'updates' ? [...(affectedDocumentIds ?? [])] : undefined,
    });
  };

  const downloadBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      await downloadLibraryBackup(() => undefined);
    } catch (error) {
      setBackupError(getBackupCreationErrorMessage(error));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <section className="paper-sync-home-page" aria-label="Google Drive management">
      <PaperSyncDrawer
        backupBusy={backupBusy}
        backupError={backupError}
        embedded
        coordinator={coordinator}
        soundEnabled={soundEnabled}
        state={state}
        onDownloadBackup={() => void downloadBackup()}
        onOpenSelector={openSelector}
        onSoundEnabledChange={(enabled) => {
          soundFeedback.setEnabled(enabled);
          setSoundEnabled(enabled);
          if (enabled) soundFeedback.unlock();
        }}
      />
      {selector ? (
        <PaperSelectorDialog
          affectedDocumentIds={selector.affectedDocumentIds}
          coordinator={coordinator}
          mode={selector.mode}
          state={state}
          onBrowseAll={() => setSelector({ mode: 'download' })}
          onClose={() => setSelector(null)}
        />
      ) : null}
    </section>
  );
}

export function PaperRemoteUpdateLayer({
  isReaderActive,
  onReviewUpdates,
}: {
  isReaderActive: boolean;
  onReviewUpdates(affectedDocumentIds: readonly string[]): void;
}) {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const [state, setState] = useState(initialPaperSyncViewState);
  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);
  return (
    <>
      {shouldShowRemoteUpdateRecommendation(state, isReaderActive, false) ? (
        <RemoteUpdateRecommendation
          coordinator={coordinator}
          state={state}
          onBrowse={(documentIds) => onReviewUpdates(documentIds)}
        />
      ) : null}
    </>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure presentation gate is regression-tested.
export function shouldShowRemoteUpdateRecommendation(
  state: Pick<PaperSyncViewState, 'reminder'>,
  isReaderActive: boolean,
  selectorOpen: boolean,
): boolean {
  return Boolean(
    isReaderActive &&
    !selectorOpen &&
    state.reminder &&
    state.reminder.dismissStage < 2,
  );
}

export function PaperLibraryCloudActions() {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const [state, setState] = useState(initialPaperSyncViewState);
  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);

  return <PaperLibraryCloudView coordinator={coordinator} state={state} />;
}

/** Testable Library presentation; sync ownership remains in the coordinator. */
export function PaperLibraryCloudView({
  coordinator,
  state,
}: {
  coordinator: PaperGoogleDriveSyncCoordinator;
  state: PaperSyncViewState;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const ignored = new Set(
    (state.ignoredCloudIssues ?? []).map(({ documentId }) => documentId),
  );
  const cloud = new Map(
    normalCloudPapers(state).map((paper) => [paper.documentId, paper]),
  );
  const local = new Map(
    state.paperStates
      .filter((paper) => !ignored.has(paper.documentId))
      .map((paper) => [paper.documentId, paper]),
  );
  const transferBusy = state.connection === 'syncing';
  const batchFeedback = getPaperDownloadBatchFeedback(state);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const ids = [...new Set([...cloud.keys(), ...local.keys()])]
    .filter((documentId) => {
      if (!normalizedQuery) return true;
      const displayName =
        cloud.get(documentId)?.displayName ?? local.get(documentId)?.displayName ?? '';
      return displayName.toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort((first, second) => {
      const firstName =
        cloud.get(first)?.displayName ?? local.get(first)?.displayName ?? '';
      const secondName =
        cloud.get(second)?.displayName ?? local.get(second)?.displayName ?? '';
      return firstName.localeCompare(secondName) || first.localeCompare(second);
    });
  const selectedIds = [...selected];
  const downloadable = selectedIds.filter((id) => {
    const status = local.get(id)?.status ?? cloud.get(id)?.status ?? 'cloud-only';
    return cloud.has(id) && isDownloadablePaperStatus(status);
  });
  const uploadable = selectedIds.filter((id) => {
    const paper = local.get(id);
    return Boolean(paper?.dirtyReasons.length && paper.cloudPresence !== 'removed');
  });
  return (
    <section
      className="paper-library-cloud"
      aria-labelledby="paper-library-cloud-title"
    >
      <header>
        <div>
          <p>Selective transfer</p>
          <h3 id="paper-library-cloud-title">Google Drive papers</h3>
        </div>
        <div className="sync-actions">
          <button
            disabled={transferBusy || !downloadable.length}
            type="button"
            onClick={() =>
              void coordinator.downloadSelected(downloadable).catch(() => undefined)
            }
          >
            Download selected
          </button>
          <button
            disabled={transferBusy || !uploadable.length}
            type="button"
            onClick={() =>
              void coordinator.uploadSelected(uploadable).catch(() => undefined)
            }
          >
            Upload selected
          </button>
          <button
            disabled={transferBusy || !cloud.size}
            type="button"
            onClick={() => void coordinator.downloadAll().catch(() => undefined)}
          >
            Download all
          </button>
        </div>
      </header>
      {batchFeedback ? (
        <div
          aria-live="polite"
          className="paper-library-batch-progress sync-tone-neutral"
          role="status"
        >
          <span aria-hidden="true" className="sync-activity-indicator" />
          <span>{batchFeedback}</span>
        </div>
      ) : null}
      <input
        aria-label="Search Google Drive papers"
        placeholder="Search Google Drive papers"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {ids.length ? (
        <ul>
          {ids.map((documentId) => {
            const cloudPaper = cloud.get(documentId);
            const localPaper = local.get(documentId);
            const paperPresentation = getPaperStatusPresentation(
              cloudPaper,
              localPaper,
            );
            const { status, issue } = paperPresentation;
            return (
              <li
                key={documentId}
                className={syncToneClass(syncToneForPaper(status, issue?.code))}
              >
                <label>
                  <input
                    aria-label={`Select ${cloudPaper?.displayName ?? localPaper?.displayName ?? 'paper'}`}
                    checked={selected.has(documentId)}
                    disabled={transferBusy}
                    type="checkbox"
                    onChange={(event) =>
                      setSelected((current) =>
                        toggleSelection(current, documentId, event.target.checked),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {cloudPaper?.displayName ??
                        localPaper?.displayName ??
                        'Untitled paper'}
                    </strong>
                    <small>{paperStatusLabel(status)}</small>
                    {status === 'downloading' ? (
                      <span
                        aria-live="polite"
                        className="paper-library-row-progress"
                        role="status"
                      >
                        <span aria-hidden="true" className="sync-activity-indicator" />
                        Downloading…
                      </span>
                    ) : null}
                    {status === 'needs-attention' && issue?.message ? (
                      <span className="paper-library-row-error" role="alert">
                        {issue.message}
                      </span>
                    ) : null}
                  </span>
                </label>
                <div>
                  {cloudPaper &&
                  (isDownloadablePaperStatus(status) ||
                    isSafePaperDownloadRetry(status, issue?.code)) ? (
                    <button
                      disabled={transferBusy || status === 'downloading'}
                      type="button"
                      onClick={() =>
                        void coordinator
                          .downloadSelected([documentId])
                          .catch(() => undefined)
                      }
                    >
                      {status === 'needs-attention' ? 'Retry download' : 'Download'}
                    </button>
                  ) : null}
                  {localPaper?.dirtyReasons.length &&
                  localPaper.cloudPresence !== 'removed' ? (
                    <button
                      disabled={transferBusy}
                      type="button"
                      onClick={() =>
                        void coordinator
                          .uploadSelected([documentId])
                          .catch(() => undefined)
                      }
                    >
                      Upload
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>Connect Google Drive to browse cloud papers.</p>
      )}
    </section>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure batch feedback is regression-tested.
export function getPaperDownloadBatchFeedback(
  state: Pick<PaperSyncViewState, 'connection' | 'progress'>,
): string | null {
  if (state.connection !== 'syncing') {
    return null;
  }
  if (
    state.progress.phase === 'verifying' &&
    state.progress.detail === 'Verifying downloaded papers'
  ) {
    return 'Verifying downloaded papers…';
  }
  if (state.progress.phase !== 'downloading') return null;
  const { completed, total } = state.progress;
  if (
    completed === undefined ||
    total === undefined ||
    !Number.isFinite(completed) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return 'Downloading papers…';
  }
  if (completed >= total) return 'Verifying downloaded papers…';
  const current = Math.min(Math.max(0, completed) + 1, total);
  return total === 1
    ? 'Downloading 1 paper…'
    : `Downloading ${current} of ${total} papers`;
}

function isSafePaperDownloadRetry(
  status: PaperSyncState['status'],
  issueCode?: string,
): boolean {
  if (status !== 'needs-attention') return false;
  return ![
    'ambiguous-paper-folder',
    'drive-root-invalid',
    'layout-migration-incomplete',
    'layout-upgrade-required',
    'unsupported-protocol',
    'paper-integrity-failed',
    'paper-logical-partition-invalid',
    'paper-source-pdf-conflict',
  ].includes(issueCode ?? 'paper-operation-failed');
}

// eslint-disable-next-line react-refresh/only-export-components -- pure eligibility guard is regression-tested.
export function targetedPaperPurgeCandidate(
  state: PaperSyncViewState,
): string | undefined {
  return targetedPaperPurgeCandidateFromView(state);
}

// eslint-disable-next-line react-refresh/only-export-components -- pure eligibility guard is regression-tested.
export function shouldOfferForgetIdentityVerification(
  hasVerifiedCandidate: boolean,
  diagnosticReason: ForgetInaccessiblePaperDiagnostic['reason'] | undefined,
): boolean {
  return Boolean(
    !hasVerifiedCandidate &&
    (!diagnosticReason || diagnosticReason === 'identity-proof-unavailable'),
  );
}

export function PaperSyncDrawer({
  state,
  coordinator,
  soundEnabled,
  backupBusy = false,
  backupError = null,
  onClose,
  onOpenSelector,
  onSoundEnabledChange,
  onDownloadBackup,
  embedded = false,
}: PaperSyncDrawerProps) {
  const status = getPaperSyncUiStatus(state);
  const tone = syncToneForView(state, status);
  const busy = state.connection === 'connecting' || state.connection === 'syncing';
  const progress = getSyncProgressPresentation(state.progress);
  const retryDiagnostic = import.meta.env.DEV
    ? coordinator.getLastPaperRetryDiagnostic?.()
    : undefined;
  const closeRef = useRef<HTMLButtonElement>(null);
  const connectAttemptRef = useRef<Promise<unknown> | null>(null);
  const deviceModeAttemptRef = useRef<Promise<unknown> | null>(null);
  const syncStatusCheckRef = useRef<Promise<PaperSyncStatusDiagnosticSnapshot> | null>(
    null,
  );
  const targetedPurgePreviewRef = useRef<Promise<TargetedPaperPurgePreview> | null>(
    null,
  );
  const targetedPurgeExecutionRef = useRef<Promise<TargetedPaperPurgeResult> | null>(
    null,
  );
  const workspaceReloadPendingRef = useRef(false);
  const [legacyConfirmationOpen, setLegacyConfirmationOpen] = useState(false);
  const [folderNameConfirmationOpen, setFolderNameConfirmationOpen] = useState(false);
  const [driveAccessConfirmationOpen, setDriveAccessConfirmationOpen] = useState(false);
  const [restoreResumeConfirmationOpen, setRestoreResumeConfirmationOpen] =
    useState(false);
  const [targetedPurgeDialogOpen, setTargetedPurgeDialogOpen] = useState(false);
  const [forgetPaperDialogOpen, setForgetPaperDialogOpen] = useState(false);
  const [forgetPaperPending, setForgetPaperPending] = useState(false);
  const [forgetPaperError, setForgetPaperError] = useState<string>();
  const [connectAttemptPending, setConnectAttemptPending] = useState(false);
  const [deviceModeAttemptPending, setDeviceModeAttemptPending] = useState(false);
  const [syncStatusCheckPending, setSyncStatusCheckPending] = useState(false);
  const [syncStatusDiagnostic, setSyncStatusDiagnostic] = useState<
    PaperSyncStatusDiagnosticSnapshot | undefined
  >(() =>
    import.meta.env.DEV ? coordinator.getLastPaperSyncStatusDiagnostic?.() : undefined,
  );
  const [targetedPurgePreview, setTargetedPurgePreview] = useState<
    TargetedPaperPurgePreview | undefined
  >();
  const [targetedPurgeStatus, setTargetedPurgeStatus] = useState<
    | { phase: 'checking' | 'purging' }
    | { phase: 'complete' | 'cleanup-pending'; message: string }
    | { phase: 'failed'; message: string }
  >();
  const targetedPurgeCandidateDocumentId =
    typeof coordinator.getTargetedPaperPurgeCandidateDocumentId === 'function'
      ? coordinator.getTargetedPaperPurgeCandidateDocumentId()
      : targetedPaperPurgeCandidate(state);
  const targetedPurgeVisibility: TargetedPaperPurgeVisibilityPresentation | undefined =
    import.meta.env.DEV
      ? targetedPaperPurgeVisibilityPresentation(coordinator, syncStatusDiagnostic)
      : undefined;
  const targetedPurgeDocumentId = import.meta.env.DEV
    ? targetedPurgeVisibility?.predicates.previewEligible
      ? targetedPurgeCandidateDocumentId
      : undefined
    : targetedPurgeCandidateDocumentId;
  const forgetPaperCandidate = coordinator.getForgetInaccessiblePaperCandidate?.();
  const interactionBusy =
    busy ||
    connectAttemptPending ||
    deviceModeAttemptPending ||
    state.restorePublicationHold?.status === 'revalidating';
  const readOnlySyncStatusAvailable = Boolean(
    state.paperStates.some((paper) => paper.status === 'needs-attention') ||
    state.issue?.diagnostic.documentId,
  );

  useEffect(() => closeRef.current?.focus(), []);

  useEffect(() => {
    const handleWorkspaceChanging = () => {
      workspaceReloadPendingRef.current = true;
      setDeviceModeAttemptPending(true);
      setDriveAccessConfirmationOpen(false);
    };
    window.addEventListener('39note:workspace-changing', handleWorkspaceChanging);
    return () =>
      window.removeEventListener('39note:workspace-changing', handleWorkspaceChanging);
  }, []);

  const openDriveAccessConfirmation = () => {
    if (
      busy ||
      connectAttemptRef.current ||
      deviceModeAttemptRef.current ||
      deviceModeAttemptPending ||
      state.connection !== 'disconnected' ||
      !state.backendConfigured ||
      !state.deviceModeChoiceConfirmed
    ) {
      return;
    }
    setDriveAccessConfirmationOpen(true);
  };

  const selectDeviceMode = (mode: PaperSyncViewState['deviceMode']) => {
    if (busy || connectAttemptRef.current || deviceModeAttemptRef.current) return;
    setDriveAccessConfirmationOpen(false);
    setDeviceModeAttemptPending(true);
    const attempt = coordinator.setDeviceMode(mode);
    deviceModeAttemptRef.current = attempt;
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (deviceModeAttemptRef.current !== attempt) return;
        deviceModeAttemptRef.current = null;
        if (!workspaceReloadPendingRef.current) setDeviceModeAttemptPending(false);
      });
  };

  const continueGoogleDriveConnection = () => {
    if (connectAttemptRef.current) return;
    setDriveAccessConfirmationOpen(false);
    setConnectAttemptPending(true);
    const attempt = coordinator.connect();
    connectAttemptRef.current = attempt;
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (connectAttemptRef.current !== attempt) return;
        connectAttemptRef.current = null;
        setConnectAttemptPending(false);
      });
  };

  const checkSyncStatus = () => {
    if (!import.meta.env.DEV || busy || syncStatusCheckRef.current) return;
    setSyncStatusCheckPending(true);
    const attempt = coordinator.checkSyncStatusReadOnly();
    syncStatusCheckRef.current = attempt;
    void attempt
      .then((diagnostic) => {
        if (syncStatusCheckRef.current === attempt) setSyncStatusDiagnostic(diagnostic);
      })
      .catch(() => undefined)
      .finally(() => {
        if (syncStatusCheckRef.current !== attempt) return;
        syncStatusCheckRef.current = null;
        setSyncStatusCheckPending(false);
      });
  };

  const previewTargetedPurge = () => {
    if (
      !targetedPurgeDocumentId ||
      busy ||
      targetedPurgePreviewRef.current ||
      targetedPurgeExecutionRef.current
    ) {
      return;
    }
    setTargetedPurgePreview(undefined);
    setTargetedPurgeStatus({ phase: 'checking' });
    const attempt = coordinator.previewTargetedPaperPurge(targetedPurgeDocumentId);
    targetedPurgePreviewRef.current = attempt;
    void attempt
      .then((preview: TargetedPaperPurgePreview) => {
        if (targetedPurgePreviewRef.current !== attempt) return;
        setTargetedPurgePreview(preview);
        setTargetedPurgeStatus(undefined);
        setTargetedPurgeDialogOpen(true);
      })
      .catch(() => {
        if (targetedPurgePreviewRef.current !== attempt) return;
        setTargetedPurgeStatus({
          phase: 'failed',
          message:
            'Purge blocked. The targeted purge preview could not be verified. No paper data was changed.',
        });
      })
      .finally(() => {
        if (targetedPurgePreviewRef.current === attempt) {
          targetedPurgePreviewRef.current = null;
        }
      });
  };

  const executeTargetedPurge = () => {
    const preview = targetedPurgePreview;
    if (
      !preview?.eligible ||
      !preview.previewToken ||
      preview.documentId !== targetedPurgeDocumentId ||
      targetedPurgeExecutionRef.current
    ) {
      return;
    }
    setTargetedPurgeDialogOpen(false);
    setTargetedPurgeStatus({ phase: 'purging' });
    const attempt = coordinator.executeTargetedPaperPurge(preview.previewToken);
    targetedPurgeExecutionRef.current = attempt;
    void attempt
      .then((result: TargetedPaperPurgeResult) => {
        if (targetedPurgeExecutionRef.current !== attempt) return;
        setTargetedPurgePreview(undefined);
        setTargetedPurgeStatus({
          phase: result.status,
          message:
            result.message ??
            (result.status === 'complete'
              ? 'Targeted purge completed. The paper cannot return through ordinary synchronization.'
              : 'The removal tombstone is verified, but Drive Trash cleanup still needs a safe retry.'),
        });
      })
      .catch(() => {
        if (targetedPurgeExecutionRef.current !== attempt) return;
        setTargetedPurgeStatus({
          phase: 'failed',
          message:
            'Targeted purge stopped safely. No unrelated paper was changed; preview the paper again before retrying.',
        });
      })
      .finally(() => {
        if (targetedPurgeExecutionRef.current === attempt) {
          targetedPurgeExecutionRef.current = null;
        }
      });
  };

  const confirmForgetInaccessiblePaper = () => {
    const candidate = forgetPaperCandidate;
    if (!candidate || forgetPaperPending) return;
    setForgetPaperPending(true);
    setForgetPaperError(undefined);
    void coordinator
      .forgetInaccessiblePaper(candidate.documentId)
      .then(() => setForgetPaperDialogOpen(false))
      .catch((error: unknown) =>
        setForgetPaperError(
          error instanceof Error
            ? error.message
            : 'The paper could not be safely ignored.',
        ),
      )
      .finally(() => setForgetPaperPending(false));
  };

  return (
    <section
      aria-labelledby={TITLE_ID}
      className={`sync-panel paper-sync-panel ${embedded ? 'is-home-page' : ''}`}
      id={PANEL_ID}
      role={embedded ? 'region' : 'dialog'}
    >
      <header>
        <div className="sync-heading">
          <h2 id={TITLE_ID}>Google Drive</h2>
          <span
            aria-live="polite"
            className={`sync-status-badge is-${status} ${syncToneClass(tone)}`}
            role="status"
          >
            {drawerLabel(state)}
          </span>
        </div>
        {onClose ? (
          <button
            ref={closeRef}
            aria-label="Close Google Drive sync"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </header>

      <StatusMessage state={state} />
      {state.temporaryCleanupNotice ? (
        <p
          className={`sync-cleanup-notice ${state.temporaryCleanupNotice.includes('could not') ? 'is-warning' : 'is-success'}`}
          role={state.temporaryCleanupNotice.includes('could not') ? 'alert' : 'status'}
        >
          {state.temporaryCleanupNotice}
        </p>
      ) : null}
      {state.reminder?.paperIds.length ? (
        <button
          className="paper-sync-update-summary sync-tone-warning"
          type="button"
          onClick={() => onOpenSelector('updates', state.reminder?.paperIds)}
        >
          <strong>
            {state.reminder.paperIds.length}{' '}
            {state.reminder.paperIds.length === 1
              ? 'paper update available'
              : 'paper updates available'}
          </strong>
          <span>Review updates</span>
        </button>
      ) : null}
      {progress ? (
        <div aria-live="polite" className="sync-progress" role="status">
          {progress.determinate ? (
            <progress
              aria-label={progress.label}
              max={progress.determinate.max}
              value={progress.determinate.value}
            />
          ) : (
            <span aria-hidden="true" className="sync-activity-indicator" />
          )}
          <span>{progress.label}</span>
        </div>
      ) : null}

      {state.lastSuccessfulAt ? (
        <p className="sync-last-synced">
          Last synced: {formatTimestamp(state.lastSuccessfulAt)}
        </p>
      ) : null}

      <PaperPrimaryActions
        busy={interactionBusy}
        coordinator={coordinator}
        state={state}
        onRequestConnect={openDriveAccessConfirmation}
        onRequestRestoreResume={() => setRestoreResumeConfirmationOpen(true)}
        onSelectDeviceMode={selectDeviceMode}
        onOpenSelector={onOpenSelector}
      />

      {driveAccessConfirmationOpen ? (
        <GoogleDriveAccessDialog
          onCancel={() => setDriveAccessConfirmationOpen(false)}
          onContinue={continueGoogleDriveConnection}
        />
      ) : null}

      {restoreResumeConfirmationOpen ? (
        <RestorePublicationResumeDialog
          busy={state.restorePublicationHold?.status === 'revalidating'}
          onCancel={() => setRestoreResumeConfirmationOpen(false)}
          onContinue={() => {
            setRestoreResumeConfirmationOpen(false);
            void coordinator
              .resumeAfterRestorePublication('resume-restored-library')
              .catch(() => undefined);
          }}
        />
      ) : null}

      {targetedPurgeDialogOpen &&
      targetedPurgePreview &&
      targetedPurgePreview.documentId === targetedPurgeDocumentId ? (
        <TargetedPaperPurgeDialog
          preview={targetedPurgePreview}
          onCancel={() => setTargetedPurgeDialogOpen(false)}
          onConfirm={executeTargetedPurge}
        />
      ) : null}

      {forgetPaperDialogOpen && forgetPaperCandidate ? (
        <ForgetInaccessiblePaperDialog
          busy={forgetPaperPending}
          candidate={forgetPaperCandidate}
          error={forgetPaperError}
          onCancel={() => {
            if (!forgetPaperPending) setForgetPaperDialogOpen(false);
          }}
          onConfirm={confirmForgetInaccessiblePaper}
        />
      ) : null}

      {state.issue?.backupRecommended ? (
        <div className="sync-recovery-card" role="alert">
          <strong>{state.issue.message}</strong>
          <p>Download a local 39Note backup while Drive uploads are unavailable.</p>
          <div className="sync-actions">
            <button disabled={backupBusy} type="button" onClick={onDownloadBackup}>
              {backupBusy ? 'Preparing local backup…' : 'Download local backup'}
            </button>
            <a
              href={state.rootUrl ?? GOOGLE_DRIVE_URL}
              rel="noreferrer"
              target="_blank"
            >
              Open Google Drive
            </a>
          </div>
        </div>
      ) : null}

      {backupError ? (
        <p className="sync-error" role="alert">
          {backupError}
        </p>
      ) : null}

      {targetedPurgeDocumentId ||
      targetedPurgeStatus ||
      targetedPurgeVisibility?.showRecoveryCard ? (
        <section
          aria-labelledby="targeted-paper-purge-recovery-title"
          className="sync-targeted-purge-card"
        >
          <h3 id="targeted-paper-purge-recovery-title">Remove inaccessible paper</h3>
          {targetedPurgeDocumentId ? (
            <p>
              {state.paperStates.find(
                (paper) => paper.documentId === targetedPurgeDocumentId,
              )?.targetedPurge
                ? 'A previously confirmed targeted purge did not finish. Preview the exact paper boundary again to retry it safely.'
                : "Ordinary Remove is blocked because this paper's Drive presence records cannot be verified. A targeted purge first proves the exact paper boundary and shows what would be removed."}
            </p>
          ) : targetedPurgeVisibility?.showRecoveryCard ? (
            <div className="sync-targeted-purge-result is-warning" role="status">
              <strong>Purge blocked</strong>
              <p>
                The recognized presence-resolution failure is visible, but this running
                session has not safely correlated it to one exact paper identity.
                Preview remains disabled. No paper data was changed.
              </p>
              <p>
                Failed runtime predicate:{' '}
                <code>{targetedPurgeVisibility.hiddenReason}</code>
              </p>
            </div>
          ) : null}
          {targetedPurgeStatus?.phase === 'purging' ? (
            <p aria-live="polite" role="status">
              Purging this paper… You may continue using 39Note.
            </p>
          ) : targetedPurgeStatus?.phase === 'checking' ? (
            <p aria-live="polite" role="status">
              Verifying exact local and Drive records…
            </p>
          ) : targetedPurgeStatus && 'message' in targetedPurgeStatus ? (
            <p
              role={targetedPurgeStatus.phase === 'failed' ? 'alert' : 'status'}
              className={
                targetedPurgeStatus.phase === 'failed' ||
                targetedPurgeStatus.phase === 'cleanup-pending'
                  ? 'sync-targeted-purge-result is-warning'
                  : 'sync-targeted-purge-result is-success'
              }
            >
              {targetedPurgeStatus.message}
            </p>
          ) : null}
          <div className="sync-actions">
            {targetedPurgeDocumentId ? (
              <button
                disabled={
                  busy ||
                  targetedPurgeStatus?.phase === 'checking' ||
                  targetedPurgeStatus?.phase === 'purging'
                }
                type="button"
                onClick={previewTargetedPurge}
              >
                {targetedPurgeStatus?.phase === 'checking'
                  ? 'Checking paper boundary…'
                  : 'Preview targeted purge'}
              </button>
            ) : targetedPurgeVisibility?.showRecoveryCard ? (
              <button disabled type="button">
                Preview unavailable — exact paper not correlated
              </button>
            ) : null}
            {forgetPaperCandidate ? (
              <button
                disabled={interactionBusy || forgetPaperPending}
                type="button"
                onClick={() => {
                  setForgetPaperError(undefined);
                  setForgetPaperDialogOpen(true);
                }}
              >
                Forget inaccessible paper
              </button>
            ) : targetedPurgeVisibility?.showRecoveryCard ? (
              <button disabled type="button">
                Forget unavailable — exact paper not correlated
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {import.meta.env.DEV && targetedPurgeVisibility ? (
        <TargetedPaperPurgeVisibilityDetails diagnostic={targetedPurgeVisibility} />
      ) : null}

      {state.rootChoices.length ? (
        <div className="sync-root-choices">
          <strong>Choose the 39Note folder</strong>
          {state.rootChoices.map((root) => (
            <button
              key={root.id}
              type="button"
              onClick={() =>
                void coordinator.chooseRoot(root.id).catch(() => undefined)
              }
            >
              Use {root.name}
            </button>
          ))}
        </div>
      ) : null}

      <div className="sync-preferences">
        <label className="sync-toggle">
          <span>Auto sync</span>
          <input
            aria-label="Auto sync"
            checked={state.autoSync}
            disabled={
              interactionBusy ||
              !state.deviceModeChoiceConfirmed ||
              state.deviceMode === 'temporary' ||
              Boolean(state.securityState) ||
              Boolean(state.restorePublicationHold)
            }
            type="checkbox"
            onChange={(event) =>
              void coordinator.setAutoSync(event.target.checked).catch(() => undefined)
            }
          />
        </label>
        <label className="sync-toggle">
          <span>Sync sounds</span>
          <input
            aria-label="Sync sounds"
            checked={soundEnabled}
            type="checkbox"
            onChange={(event) => onSoundEnabledChange(event.target.checked)}
          />
        </label>
      </div>

      <details className="sync-details">
        <summary>Details</summary>
        {state.ignoredCloudIssues?.length ? (
          <section
            aria-labelledby="ignored-cloud-issues-title"
            className="sync-ignored-cloud-issues"
          >
            <h3 id="ignored-cloud-issues-title">
              Ignored cloud {state.ignoredCloudIssues.length === 1 ? 'issue' : 'issues'}
            </h3>
            <p>
              These papers are excluded from ordinary sync only for this Google account
              and 39Note folder. Their Drive objects and integrity evidence were not
              deleted, repaired, or marked successfully synced.
            </p>
            <p>
              They are not included in Browse Drive papers or normal cloud-paper counts.
              Reviewing one removes only its local quarantine, so an unresolved cloud
              issue will appear again until you ignore it again or repair it separately.
            </p>
            <ul className="sync-targeted-purge-preserved">
              {state.ignoredCloudIssues.map((issue) => (
                <li key={issue.documentId}>
                  <strong>{issue.displayName}</strong>
                  <span> · Document ID {issue.documentId}</span>{' '}
                  <button
                    disabled={interactionBusy}
                    type="button"
                    onClick={() =>
                      void coordinator
                        .reviewIgnoredCloudIssue(issue.documentId)
                        .catch(() => undefined)
                    }
                  >
                    Review this paper again
                  </button>
                </li>
              ))}
            </ul>
            <p>
              Reviewing again removes only the local exception and restores the original
              fail-closed sync warning.
            </p>
          </section>
        ) : null}
        {state.activeDriveOperation ? (
          <section
            aria-label="Active Drive operation"
            className="sync-retry-diagnostic"
          >
            <h3>Active Drive operation</h3>
            <dl className="paper-sync-summary">
              <div>
                <dt>Operation</dt>
                <dd>{state.activeDriveOperation.operationType}</dd>
              </div>
              <div>
                <dt>Stage</dt>
                <dd>
                  {state.activeDriveOperation.stage === 'admission'
                    ? 'Admission checks'
                    : state.activeDriveOperation.stage === 'timed-out'
                      ? 'Timed out · settlement pending'
                      : 'Running'}
                </dd>
              </div>
              <div>
                <dt>Safety deadline</dt>
                <dd>
                  {new Date(state.activeDriveOperation.deadlineAt).toLocaleTimeString()}
                </dd>
              </div>
              <div>
                <dt>Requests in flight</dt>
                <dd>{state.activeDriveOperation.pendingRequestCount}</dd>
              </div>
              <div>
                <dt>Requests completed</dt>
                <dd>{state.activeDriveOperation.completedRequestCount}</dd>
              </div>
            </dl>
            <p>
              This diagnostic is redacted: it contains no paper identity, file name,
              request URL, or account data. If the deadline expires, 39Note does not
              report the operation as successful.
            </p>
          </section>
        ) : null}
        {import.meta.env.DEV && state.lastDriveOperationTimeout ? (
          <section aria-label="Last Drive timeout" className="sync-retry-diagnostic">
            <h3>Last Drive timeout</h3>
            <dl className="paper-sync-summary">
              <div>
                <dt>Operation</dt>
                <dd>{state.lastDriveOperationTimeout.operationType}</dd>
              </div>
              <div>
                <dt>Failure code</dt>
                <dd>{state.lastDriveOperationTimeout.failureCode}</dd>
              </div>
              <div>
                <dt>Timeout boundary</dt>
                <dd>
                  {state.lastDriveOperationTimeout.timedOutFromStage === 'admission'
                    ? 'Admission checks'
                    : 'Running after admission'}
                </dd>
              </div>
              <div>
                <dt>Requests in flight</dt>
                <dd>{state.lastDriveOperationTimeout.pendingRequestCount}</dd>
              </div>
              <div>
                <dt>Requests completed</dt>
                <dd>{state.lastDriveOperationTimeout.completedRequestCount}</dd>
              </div>
            </dl>
            {state.lastDriveOperationTimeout.observedPhases.length ? (
              <>
                <h4>Observed phases</h4>
                <ul>
                  {state.lastDriveOperationTimeout.observedPhases.map((phase) => (
                    <li key={phase.phase}>
                      <code>{phase.phase}</code> · {Math.round(phase.elapsedMs)} ms ·{' '}
                      {phase.requestCount}{' '}
                      {phase.requestCount === 1 ? 'request' : 'requests'} ·{' '}
                      {phase.retryCount} retries
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>No completed Drive request phase was retained for this timeout.</p>
            )}
            {state.lastDriveOperationTimeout.failureCode ===
            'running-without-request-in-flight-deadline-exceeded' ? (
              <p>
                This boundary can include token acquisition, response processing, local
                work, or a gap between Drive requests. It does not identify one of those
                causes without further evidence.
              </p>
            ) : null}
            {state.lastDriveOperationTimeout.failureCode ===
            'read-operation-hard-deadline-exceeded' ? (
              <p>
                The read kept reaching completed-request progress but reached the
                five-minute absolute safety cap. No remote change was reported as
                successful.
              </p>
            ) : null}
            <p>
              Development-only and redacted. This evidence contains no paper identity,
              file name, request URL, account data, or token, and it remains visible
              after the operation settles.
            </p>
          </section>
        ) : null}
        <dl className="paper-sync-summary">
          <div>
            <dt>Cloud papers</dt>
            <dd>{normalCloudPapers(state).length}</dd>
          </div>
          <div>
            <dt>Changes waiting</dt>
            <dd>{state.dirtyPaperIds.length}</dd>
          </div>
          <div>
            <dt>Device mode</dt>
            <dd>
              {!state.deviceModeChoiceConfirmed
                ? 'Not selected'
                : state.deviceMode === 'temporary'
                  ? 'Public / temporary'
                  : 'Personal'}
            </dd>
          </div>
        </dl>
        {state.issue ? (
          <dl className="sync-issue-details">
            <div>
              <dt>Code</dt>
              <dd>{state.issue.code}</dd>
            </div>
            <div>
              <dt>Retry</dt>
              <dd>{state.issue.retrySafe ? 'Safe' : 'Action required'}</dd>
            </div>
            <div>
              <dt>Ordinary sync</dt>
              <dd>{state.issue.blocksOrdinarySync ? 'Paused' : 'May retry'}</dd>
            </div>
            {import.meta.env.DEV && state.issue.diagnostic.phase ? (
              <div>
                <dt>Failed step</dt>
                <dd>{state.issue.diagnostic.phase}</dd>
              </div>
            ) : null}
            {import.meta.env.DEV && state.issue.diagnostic.causeCode ? (
              <div>
                <dt>Cause</dt>
                <dd>{state.issue.diagnostic.causeCode}</dd>
              </div>
            ) : null}
            {state.issue.diagnostic.paperName ? (
              <div>
                <dt>Affected paper</dt>
                <dd>{state.issue.diagnostic.paperName}</dd>
              </div>
            ) : null}
            {import.meta.env.DEV && state.issue.diagnostic.documentId ? (
              <div>
                <dt>Paper ID</dt>
                <dd>{state.issue.diagnostic.documentId}</dd>
              </div>
            ) : null}
            {import.meta.env.DEV && state.issue.diagnostic.expectedSemanticPartition ? (
              <div>
                <dt>Expected data</dt>
                <dd>{state.issue.diagnostic.expectedSemanticPartition}</dd>
              </div>
            ) : null}
            {import.meta.env.DEV &&
            state.issue.diagnostic.actualSemanticPartitions?.length ? (
              <div>
                <dt>Found data</dt>
                <dd>{state.issue.diagnostic.actualSemanticPartitions.join(', ')}</dd>
              </div>
            ) : null}
            {state.issue.diagnostic.sourceProtocolVersion !== undefined ? (
              <div>
                <dt>Paper protocol</dt>
                <dd>{state.issue.diagnostic.sourceProtocolVersion}</dd>
              </div>
            ) : null}
            {import.meta.env.DEV &&
            state.issue.diagnostic.compatibilityNormalizationAttempted !== undefined ? (
              <div>
                <dt>Compatibility check</dt>
                <dd>
                  {state.issue.diagnostic.compatibilityNormalizationAttempted
                    ? 'Applied'
                    : 'Not applicable'}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {retryDiagnostic ? (
          <PaperRetryDiagnosticDetails diagnostic={retryDiagnostic} />
        ) : null}
        {import.meta.env.DEV &&
        (readOnlySyncStatusAvailable || syncStatusDiagnostic) ? (
          <section
            aria-label="Read-only sync status check"
            className="sync-retry-diagnostic"
          >
            <h3>Read-only sync status</h3>
            <p>
              Rechecks only the affected paper. It cannot retry, upload, clear issues,
              or apply repository results.
            </p>
            <button
              disabled={busy || syncStatusCheckPending || !readOnlySyncStatusAvailable}
              type="button"
              onClick={checkSyncStatus}
            >
              {syncStatusCheckPending ? 'Checking sync status…' : 'Check sync status'}
            </button>
            {syncStatusDiagnostic ? (
              <PaperSyncStatusDiagnosticDetails diagnostic={syncStatusDiagnostic} />
            ) : null}
          </section>
        ) : null}
        {state.rootUrl ? (
          <a href={state.rootUrl} rel="noreferrer" target="_blank">
            Open 39Note folder
          </a>
        ) : null}
      </details>

      <details className="sync-advanced">
        <summary>Advanced</summary>
        <p>
          PDFs and editable paper data travel directly between this browser and Google
          Drive. The sign-in service receives no paper content.
        </p>
        {paperConnectionAction(state.connection) === 'disconnect' ||
        paperConnectionAction(state.connection) === 'reconnect' ? (
          <div className="sync-actions">
            <button
              type="button"
              onClick={() => void coordinator.disconnect().catch(() => undefined)}
            >
              Disconnect this device
            </button>
            {!state.restorePublicationHold ? (
              <button
                type="button"
                onClick={() =>
                  window.confirm(
                    'Disconnect every 39Note device and revoke Google authorization?',
                  ) && void coordinator.disconnectAll().catch(() => undefined)
                }
              >
                Disconnect all devices
              </button>
            ) : null}
          </div>
        ) : null}
        {state.rootUrl &&
        !state.restorePublicationHold &&
        (state.connection === 'connected' || state.connection === 'syncing') ? (
          <>
            <PaperFolderNameMaintenancePanel
              busy={busy}
              confirmationOpen={folderNameConfirmationOpen}
              coordinator={coordinator}
              maintenance={state.folderNameMaintenance}
              onCancelConfirmation={() => setFolderNameConfirmationOpen(false)}
              onOpenConfirmation={() => setFolderNameConfirmationOpen(true)}
            />
            <LegacyDriveHousekeepingPanel
              busy={busy}
              confirmationOpen={legacyConfirmationOpen}
              coordinator={coordinator}
              housekeeping={state.legacyHousekeeping}
              onCancelConfirmation={() => setLegacyConfirmationOpen(false)}
              onOpenConfirmation={() => setLegacyConfirmationOpen(true)}
            />
          </>
        ) : null}
      </details>
    </section>
  );
}

function PaperRetryDiagnosticDetails({
  diagnostic,
}: {
  diagnostic: PaperRetryDiagnosticSnapshot;
}) {
  const display = (value: string | number | undefined) =>
    value === undefined ? 'Not recorded' : String(value);

  return (
    <section aria-label="Last Retry diagnostic" className="sync-retry-diagnostic">
      <h3>Last Retry diagnostic</h3>
      <p>
        Read-only, redacted local trace. Paper, Drive, account, and content identifiers
        are omitted.
      </p>
      <dl className="sync-issue-details">
        <div>
          <dt>Operation</dt>
          <dd>{diagnostic.operation}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{diagnostic.phase}</dd>
        </div>
        <div>
          <dt>Targets</dt>
          <dd>{diagnostic.targetCount}</dd>
        </div>
        {diagnostic.failure ? (
          <>
            <div>
              <dt>Failure code</dt>
              <dd>{diagnostic.failure.code}</dd>
            </div>
            <div>
              <dt>Failure operation</dt>
              <dd>{display(diagnostic.failure.operation)}</dd>
            </div>
            <div>
              <dt>Failure phase</dt>
              <dd>{display(diagnostic.failure.phase)}</dd>
            </div>
            <div>
              <dt>Failure cause</dt>
              <dd>{display(diagnostic.failure.causeCode)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {diagnostic.targets.map((target) => {
        const admittedIssue = target.admission.activeBlockingIssue;
        const repository = target.repository;
        const settlement = target.settlement;
        const settledIssue = settlement?.activeBlockingIssue;
        return (
          <section className="sync-retry-diagnostic-target" key={target.target}>
            <h4>{target.target}</h4>
            <dl className="sync-issue-details">
              <div>
                <dt>Admission</dt>
                <dd>{display(target.admission.status)}</dd>
              </div>
              <div>
                <dt>Local presence</dt>
                <dd>{display(target.admission.cloudPresence)}</dd>
              </div>
              <div>
                <dt>Dirty reasons</dt>
                <dd>{target.admission.dirtyReasonCount}</dd>
              </div>
              <div>
                <dt>Package heads</dt>
                <dd>
                  {target.admission.packageHeadCount} remote /{' '}
                  {target.admission.incorporatedHeadCount} incorporated
                </dd>
              </div>
              <div>
                <dt>Presence heads</dt>
                <dd>{target.admission.presenceHeadCount}</dd>
              </div>
              <div>
                <dt>Retry intent</dt>
                <dd>{display(target.admission.retryIntent)}</dd>
              </div>
              <div>
                <dt>Catalog issue</dt>
                <dd>{display(target.admission.catalogIssueCode)}</dd>
              </div>
              <div>
                <dt>Catalog phase</dt>
                <dd>{display(target.admission.catalogIssuePhase)}</dd>
              </div>
              <div>
                <dt>Catalog cause</dt>
                <dd>{display(target.admission.catalogCauseCode)}</dd>
              </div>
              <div>
                <dt>Active block</dt>
                <dd>{display(admittedIssue?.code)}</dd>
              </div>
              <div>
                <dt>Block operation</dt>
                <dd>{display(admittedIssue?.operation)}</dd>
              </div>
              <div>
                <dt>Block phase</dt>
                <dd>{display(admittedIssue?.phase)}</dd>
              </div>
              <div>
                <dt>Block cause</dt>
                <dd>{display(admittedIssue?.causeCode)}</dd>
              </div>
              <div>
                <dt>Repository result</dt>
                <dd>{display(repository?.result)}</dd>
              </div>
              <div>
                <dt>Repository status</dt>
                <dd>{display(repository?.status)}</dd>
              </div>
              <div>
                <dt>Remote presence</dt>
                <dd>{display(repository?.presenceState)}</dd>
              </div>
              <div>
                <dt>Remote heads</dt>
                <dd>
                  {repository
                    ? `${repository.packageHeadCount} package / ${repository.presenceHeadCount} presence`
                    : 'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Repository issue</dt>
                <dd>{display(repository?.issueCode)}</dd>
              </div>
              <div>
                <dt>Repository phase</dt>
                <dd>{display(repository?.phase)}</dd>
              </div>
              <div>
                <dt>Repository cause</dt>
                <dd>{display(repository?.causeCode)}</dd>
              </div>
              <div>
                <dt>Block result</dt>
                <dd>{display(settlement?.blockDisposition)}</dd>
              </div>
              <div>
                <dt>Selected action</dt>
                <dd>{display(settlement?.selectedAction)}</dd>
              </div>
              <div>
                <dt>Final status</dt>
                <dd>{display(settlement?.finalStatus)}</dd>
              </div>
              <div>
                <dt>Final block</dt>
                <dd>{display(settledIssue?.code)}</dd>
              </div>
              <div>
                <dt>Final operation</dt>
                <dd>{display(settledIssue?.operation)}</dd>
              </div>
              <div>
                <dt>Final phase</dt>
                <dd>{display(settledIssue?.phase)}</dd>
              </div>
              <div>
                <dt>Final cause</dt>
                <dd>{display(settledIssue?.causeCode)}</dd>
              </div>
            </dl>
          </section>
        );
      })}
    </section>
  );
}

function targetedPurgePredicateLabel(predicate: string): string {
  const words = predicate.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function TargetedPaperPurgeVisibilityDetails({
  diagnostic,
}: {
  diagnostic: TargetedPaperPurgeVisibilityPresentation;
}) {
  return (
    <details aria-label="Targeted purge predicate matrix" className="sync-details">
      <summary>Targeted purge visibility predicate matrix</summary>
      <div className="sync-retry-diagnostic">
        <p>
          Redacted development checks only. No paper, account, Drive, or local-file
          identity is shown.
        </p>
        <dl className="sync-issue-details">
          <div>
            <dt>Active UI module revision</dt>
            <dd>{diagnostic.runtime.activeUiModuleRevision}</dd>
          </div>
          <div>
            <dt>Active coordinator module revision</dt>
            <dd>{diagnostic.runtime.activeCoordinatorModuleRevision}</dd>
          </div>
          <div>
            <dt>Mounted coordinator revision</dt>
            <dd>{diagnostic.runtime.mountedCoordinatorRevision}</dd>
          </div>
          <div>
            <dt>Expected visibility revision</dt>
            <dd>{diagnostic.runtime.expectedVisibilityRevision}</dd>
          </div>
          <div>
            <dt>Implementation revision</dt>
            <dd>{diagnostic.implementationRevision}</dd>
          </div>
          <div>
            <dt>Runtime versions current</dt>
            <dd>{diagnostic.runtime.runtimeVersionsCurrent ? 'True' : 'False'}</dd>
          </div>
          <div>
            <dt>Exact candidate visible</dt>
            <dd>{diagnostic.visible ? 'True' : 'False'}</dd>
          </div>
          <div>
            <dt>Recovery card requested</dt>
            <dd>{diagnostic.showRecoveryCard ? 'True' : 'False'}</dd>
          </div>
          <div>
            <dt>Candidate source</dt>
            <dd>{diagnostic.candidateSource}</dd>
          </div>
          <div>
            <dt>Hidden reason</dt>
            <dd>{diagnostic.hiddenReason}</dd>
          </div>
          <div>
            <dt>Exact blocker candidates</dt>
            <dd>{diagnostic.exactBlockingCandidateCount}</dd>
          </div>
          <div>
            <dt>Retry candidates</dt>
            <dd>{diagnostic.retryCandidateCount}</dd>
          </div>
          {Object.entries(diagnostic.predicates)
            .filter(([predicate]) => predicate !== 'runtimeVersionsCurrent')
            .map(([predicate, passed]) => (
              <div key={predicate}>
                <dt>{targetedPurgePredicateLabel(predicate)}</dt>
                <dd>{passed ? 'True' : 'False'}</dd>
              </div>
            ))}
        </dl>
      </div>
    </details>
  );
}

function PaperSyncStatusDiagnosticDetails({
  diagnostic,
}: {
  diagnostic: PaperSyncStatusDiagnosticSnapshot;
}) {
  const display = (value: string | number | undefined) =>
    value === undefined ? 'Not recorded' : String(value);
  const uploadReason = {
    permitted: 'Permitted by the inspected state',
    'no-local-state': 'No local paper state is available',
    'no-pending-local-changes': 'No local changes are waiting',
    'paper-removed': 'The authoritative paper is removed',
    'current-blocking-issue': 'The current blocking issue pauses upload',
    'authoritative-needs-attention': 'The authoritative repository needs attention',
    'remote-update-requires-reconciliation':
      'A remote update must be reconciled before upload',
    'authoritative-result-missing': 'No authoritative paper result was returned',
    'local-state-changed-during-inspection':
      'Local sync state changed during the inspection',
    'inspection-failed-closed': 'The read-only inspection failed closed',
  } as const;

  return (
    <section
      aria-label="Sync status diagnostic result"
      aria-live="polite"
      className="sync-retry-diagnostic"
    >
      <dl className="sync-issue-details">
        <div>
          <dt>Operation</dt>
          <dd>{diagnostic.operation}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{diagnostic.phase}</dd>
        </div>
        <div>
          <dt>Targets</dt>
          <dd>{diagnostic.targetCount}</dd>
        </div>
        {diagnostic.failure ? (
          <>
            <div>
              <dt>Failure code</dt>
              <dd>{diagnostic.failure.code}</dd>
            </div>
            <div>
              <dt>Failure operation</dt>
              <dd>{display(diagnostic.failure.operation)}</dd>
            </div>
            <div>
              <dt>Failure phase</dt>
              <dd>{display(diagnostic.failure.phase)}</dd>
            </div>
            <div>
              <dt>Failure cause</dt>
              <dd>{display(diagnostic.failure.causeCode)}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {diagnostic.targets.map((target) => {
        const currentIssue = target.current.blockingIssue;
        const authoritative = target.authoritative;
        const authoritativeIssue = authoritative?.issue;
        return (
          <section className="sync-retry-diagnostic-target" key={target.target}>
            <h4>{target.target}</h4>
            <dl className="sync-issue-details">
              <div>
                <dt>Current status</dt>
                <dd>{display(target.current.status)}</dd>
              </div>
              <div>
                <dt>Current presence</dt>
                <dd>{display(target.current.cloudPresence)}</dd>
              </div>
              <div>
                <dt>Current issue</dt>
                <dd>{display(currentIssue?.code)}</dd>
              </div>
              <div>
                <dt>Current operation</dt>
                <dd>{display(currentIssue?.operation)}</dd>
              </div>
              <div>
                <dt>Current phase</dt>
                <dd>{display(currentIssue?.phase)}</dd>
              </div>
              <div>
                <dt>Current cause</dt>
                <dd>{display(currentIssue?.causeCode)}</dd>
              </div>
              <div>
                <dt>Repository result</dt>
                <dd>{display(authoritative?.result)}</dd>
              </div>
              <div>
                <dt>Repository status</dt>
                <dd>{display(authoritative?.status)}</dd>
              </div>
              <div>
                <dt>Repository presence</dt>
                <dd>{display(authoritative?.presenceState)}</dd>
              </div>
              <div>
                <dt>Repository heads</dt>
                <dd>
                  {authoritative
                    ? `${authoritative.packageHeadCount} package / ${authoritative.presenceHeadCount} presence`
                    : 'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Authoritative issue</dt>
                <dd>{display(authoritativeIssue?.code)}</dd>
              </div>
              <div>
                <dt>Authoritative operation</dt>
                <dd>{display(authoritativeIssue?.operation)}</dd>
              </div>
              <div>
                <dt>Authoritative phase</dt>
                <dd>{display(authoritativeIssue?.phase)}</dd>
              </div>
              <div>
                <dt>Authoritative cause</dt>
                <dd>{display(authoritativeIssue?.causeCode)}</dd>
              </div>
              <div>
                <dt>Upload permitted</dt>
                <dd>{target.upload.permitted ? 'Yes' : 'No'}</dd>
              </div>
              <div>
                <dt>Upload decision</dt>
                <dd>{uploadReason[target.upload.reason]}</dd>
              </div>
            </dl>
          </section>
        );
      })}
    </section>
  );
}

export function ForgetInaccessiblePaperDialog({
  candidate,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  candidate: ForgetInaccessiblePaperCandidate;
  busy: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={FORGET_PAPER_DESCRIPTION_ID}
      aria-labelledby={FORGET_PAPER_TITLE_ID}
      className="sync-access-dialog sync-targeted-purge-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="sync-access-dialog-content">
        <h2 id={FORGET_PAPER_TITLE_ID}>Forget inaccessible paper?</h2>
        <p id={FORGET_PAPER_DESCRIPTION_ID}>
          39Note will locally ignore this exact cloud issue on this device for the
          current Google account and 39Note folder. No Google Drive object will be
          deleted or changed, and this paper will not be reported as successfully
          synced.
        </p>
        <dl className="sync-targeted-purge-records">
          <div>
            <dt>Paper</dt>
            <dd>{candidate.displayName}</dd>
          </div>
          <div>
            <dt>Document ID</dt>
            <dd>{candidate.documentId}</dd>
          </div>
        </dl>
        <p>
          Ordinary sync, Auto sync, and blocking status will skip only this paper.
          Unrelated papers can continue normally. You can reverse this later from the
          Ignored cloud issues section.
        </p>
        <label className="sync-targeted-purge-acknowledgement">
          <input
            checked={acknowledged}
            disabled={busy}
            type="checkbox"
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            I understand that the cloud paper and its integrity evidence remain in
            Google Drive and are not considered synced.
          </span>
        </label>
        {error ? (
          <p className="sync-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="sync-access-dialog-actions">
          <button ref={cancelRef} disabled={busy} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button disabled={busy || !acknowledged} type="button" onClick={onConfirm}>
            {busy ? 'Saving local exception…' : 'Forget and ignore this issue'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function TargetedPaperPurgeDialog({
  preview,
  onCancel,
  onConfirm,
}: {
  preview: TargetedPaperPurgePreview;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const canConfirm = preview.eligible && Boolean(preview.previewToken) && acknowledged;

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (dialog?.open) dialog.close();
      const returnFocus = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  const containFocus = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={TARGETED_PURGE_DESCRIPTION_ID}
      aria-labelledby={TARGETED_PURGE_TITLE_ID}
      className="sync-access-dialog sync-targeted-purge-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={containFocus}
    >
      <div className="sync-access-dialog-content">
        <h2 id={TARGETED_PURGE_TITLE_ID}>Targeted purge preview</h2>
        <p id={TARGETED_PURGE_DESCRIPTION_ID}>
          This recovery action is restricted to one verified paper. It removes that
          paper&apos;s local records, publishes a removed-presence tombstone, and moves
          its exclusively owned Drive package to Google Drive Trash.
        </p>

        <section aria-labelledby="targeted-paper-identity-title">
          <h3 id="targeted-paper-identity-title">Verified paper identity</h3>
          <dl className="sync-targeted-purge-records">
            <div>
              <dt>Paper</dt>
              <dd>{preview.displayName}</dd>
            </div>
            <div>
              <dt>Document ID</dt>
              <dd>{preview.documentId}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="targeted-purge-local-title">
          <h3 id="targeted-purge-local-title">Local records in scope</h3>
          <dl className="sync-targeted-purge-records">
            <PurgeRecord
              label="Document state"
              present={preview.local.documentRecord}
            />
            <PurgeRecord label="Source document" present={preview.local.sourceRecord} />
            <PurgeRecord label="Sync state" present={preview.local.syncStateRecord} />
            <PurgeRecord
              label="Cloud catalog record"
              present={preview.local.cloudCatalogRecord}
            />
            <PurgeRecord label="Print draft" present={preview.local.printDraftRecord} />
            <PurgeRecord
              label="Rendered Print PDF"
              present={preview.local.renderedPrintPdfRecord}
            />
            <div>
              <dt>AI conversations</dt>
              <dd>{preview.local.aiConversationCount}</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="targeted-purge-cloud-title">
          <h3 id="targeted-purge-cloud-title">Drive records reviewed</h3>
          <dl className="sync-targeted-purge-records">
            <div>
              <dt>Owned paper folders to Trash</dt>
              <dd>{preview.cloud.paperFolderCount}</dd>
            </div>
            <div>
              <dt>Package files inside that folder</dt>
              <dd>{preview.cloud.paperFileCount}</dd>
            </div>
            <div>
              <dt>Valid presence records preserved</dt>
              <dd>{preview.cloud.validPresenceCount}</dd>
            </div>
            <div>
              <dt>Invalid presence candidates to Trash</dt>
              <dd>{preview.cloud.corruptPresenceCount}</dd>
            </div>
            <div>
              <dt>Current presence</dt>
              <dd>{preview.cloud.presenceState ?? 'Unresolved'}</dd>
            </div>
            <div>
              <dt>Resolved presence heads</dt>
              <dd>{preview.cloud.presenceHeadCount}</dd>
            </div>
          </dl>
        </section>

        {preview.cloud.ancestryDiagnostic ? (
          <section aria-labelledby="targeted-purge-ancestry-title">
            <h3 id="targeted-purge-ancestry-title">Presence ancestry diagnostic</h3>
            <p>
              Strictly read-only and redacted. R numbers are inspection-local aliases;
              no Drive or record identities are shown.
            </p>
            <p>
              Resolved presence heads remain 0 while validation is blocked; Structural
              heads is the observed read-only topology count.
            </p>
            <dl className="sync-targeted-purge-records">
              <div>
                <dt>Validation stage</dt>
                <dd>{preview.cloud.ancestryDiagnostic.validationStage}</dd>
              </div>
              <div>
                <dt>Failure code</dt>
                <dd>{preview.cloud.ancestryDiagnostic.failureCode}</dd>
              </div>
              <div>
                <dt>Ancestry status</dt>
                <dd>{preview.cloud.ancestryDiagnostic.topology.status}</dd>
              </div>
              {preview.cloud.ancestryDiagnostic.topology.status === 'invalid' &&
              preview.cloud.ancestryDiagnostic.topology.failureCode !==
                preview.cloud.ancestryDiagnostic.failureCode ? (
                <div>
                  <dt>Ancestry failure code</dt>
                  <dd>{preview.cloud.ancestryDiagnostic.topology.failureCode}</dd>
                </div>
              ) : null}
              <div>
                <dt>Records</dt>
                <dd>
                  {preview.cloud.ancestryDiagnostic.topology.recordCount} reviewed /{' '}
                  {preview.cloud.ancestryDiagnostic.topology.uniqueGenerationCount}{' '}
                  unique
                </dd>
              </div>
              <div>
                <dt>Roots</dt>
                <dd>{preview.cloud.ancestryDiagnostic.topology.rootCount}</dd>
              </div>
              <div>
                <dt>Structural heads</dt>
                <dd>{preview.cloud.ancestryDiagnostic.topology.structuralHeadCount}</dd>
              </div>
              <div>
                <dt>Weak components</dt>
                <dd>{preview.cloud.ancestryDiagnostic.topology.weakComponentCount}</dd>
              </div>
              <div>
                <dt>Missing parent references</dt>
                <dd>
                  {
                    preview.cloud.ancestryDiagnostic.topology
                      .missingParentReferenceCount
                  }
                </dd>
              </div>
              <div>
                <dt>Ordering authority</dt>
                <dd>Timestamps ignored; Drive listing ignored</dd>
              </div>
            </dl>
            <ul className="sync-targeted-purge-preserved">
              {preview.cloud.ancestryDiagnostic.topology.records.map((record) => (
                <li key={record.ordinal}>
                  <strong>R{record.ordinal}</strong>: {record.state} / {record.intent};
                  parents{' '}
                  {record.parentOrdinals.length > 0
                    ? record.parentOrdinals.map((ordinal) => `R${ordinal}`).join(', ')
                    : 'none'}
                  ; missing parents {record.missingParentCount}; children{' '}
                  {record.childCount}; root {record.root ? 'yes' : 'no'}; structural
                  head {record.structuralHead ? 'yes' : 'no'}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="targeted-purge-preserved-title">
          <h3 id="targeted-purge-preserved-title">Preserved</h3>
          <ul className="sync-targeted-purge-preserved">
            <li>Collection records and shared Library organization</li>
            <li>Managed root and control records</li>
            <li>Every unrelated paper and its files</li>
            <li>
              Valid presence ancestry ({preview.cloud.preservedPresenceCount}{' '}
              {preview.cloud.preservedPresenceCount === 1 ? 'record' : 'records'}) and
              the verified removed tombstone
            </li>
          </ul>
        </section>

        {!preview.eligible || !preview.previewToken ? (
          <p className="sync-targeted-purge-blocker" role="alert">
            <strong>Purge blocked.</strong>{' '}
            {preview.blocker?.message ??
              '39Note could not prove an exclusive paper boundary. No records were changed.'}
          </p>
        ) : (
          <label className="sync-targeted-purge-acknowledgement">
            <input
              checked={acknowledged}
              type="checkbox"
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I understand that only this paper&apos;s verified local records are
              removed and its owned cloud package is moved to Google Drive Trash.
            </span>
          </label>
        )}

        <div className="sync-access-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {preview.eligible && preview.previewToken ? 'Cancel' : 'Close'}
          </button>
          {preview.eligible && preview.previewToken ? (
            <button
              className="is-destructive"
              disabled={!canConfirm}
              type="button"
              onClick={onConfirm}
            >
              Purge this paper
            </button>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function PurgeRecord({ label, present }: { label: string; present: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{present ? 'Will remove' : 'Not present'}</dd>
    </div>
  );
}

export function GoogleDriveAccessDialog({
  onCancel,
  onContinue,
}: {
  onCancel(): void;
  onContinue(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (dialog?.open) dialog.close();
      const returnFocus = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  const containFocus = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={DRIVE_ACCESS_DESCRIPTION_ID}
      aria-labelledby={DRIVE_ACCESS_TITLE_ID}
      className="sync-access-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={containFocus}
    >
      <div className="sync-access-dialog-content">
        <h2 id={DRIVE_ACCESS_TITLE_ID}>Google Drive Access</h2>
        <p id={DRIVE_ACCESS_DESCRIPTION_ID}>
          Connecting opens Google&apos;s permission screen. 39Note requests only access
          to files it creates or that you explicitly open with it. Continue only if you
          want to connect this Google account.
        </p>
        <div className="sync-access-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="is-primary" type="button" onClick={onContinue}>
            Continue to Google
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function RestorePublicationResumeDialog({
  busy,
  onCancel,
  onContinue,
}: {
  busy: boolean;
  onCancel(): void;
  onContinue(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    const focusFrame = window.requestAnimationFrame(() => {
      cancelRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (dialog?.open) dialog.close();
      const returnFocus = returnFocusRef.current;
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  const containFocus = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-describedby={RESTORE_RESUME_DESCRIPTION_ID}
      aria-labelledby={RESTORE_RESUME_TITLE_ID}
      aria-busy={busy}
      className="sync-access-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={containFocus}
    >
      <div className="sync-access-dialog-content">
        <h2 id={RESTORE_RESUME_TITLE_ID}>Resume Google Drive sync?</h2>
        <p id={RESTORE_RESUME_DESCRIPTION_ID}>
          39Note will first verify the connected Google account, the existing managed
          Drive folder, and current remote paper state. This review does not upload the
          restored Library. If anything is ambiguous, restored work stays local and
          publication remains paused. If review succeeds, your saved Auto sync setting
          becomes active again; restored changes still upload only through the existing
          authorized sync flow.
        </p>
        <div className="sync-access-dialog-actions">
          <button ref={cancelRef} disabled={busy} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="is-primary"
            disabled={busy}
            type="button"
            onClick={onContinue}
          >
            {busy ? 'Revalidating Drive…' : 'Revalidate and resume'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function PaperFolderNameMaintenancePanel({
  coordinator,
  maintenance,
  busy,
  confirmationOpen,
  onOpenConfirmation,
  onCancelConfirmation,
}: {
  coordinator: PaperGoogleDriveSyncCoordinator;
  maintenance: PaperSyncViewState['folderNameMaintenance'];
  busy: boolean;
  confirmationOpen: boolean;
  onOpenConfirmation(): void;
  onCancelConfirmation(): void;
}) {
  const preview = maintenance.preview;
  const operationBusy =
    busy || maintenance.status === 'checking' || maintenance.status === 'normalizing';
  return (
    <section
      className="sync-legacy-housekeeping"
      aria-labelledby="paper-folder-name-maintenance-title"
    >
      <h3 id="paper-folder-name-maintenance-title">Paper folder names</h3>
      <p>
        Preview cosmetic folder-name changes. Ordinary sync never renames existing paper
        folders or source files.
      </p>
      <button
        disabled={operationBusy}
        type="button"
        onClick={() =>
          void coordinator.previewPaperFolderNameNormalization().catch(() => undefined)
        }
      >
        {maintenance.status === 'checking'
          ? 'Checking…'
          : 'Preview folder name changes'}
      </button>
      {maintenance.status === 'checking' ? (
        <p aria-live="polite" role="status">
          Checking verified paper folders…
        </p>
      ) : null}
      {preview ? <PaperFolderNamePreview preview={preview} /> : null}
      {maintenance.status === 'complete' ? (
        <p className="sync-success" role="status">
          Normalized {maintenance.lastRenamedCount ?? 0} paper{' '}
          {(maintenance.lastRenamedCount ?? 0) === 1 ? 'folder' : 'folders'}. IDs,
          parents, and managed metadata were verified unchanged.
        </p>
      ) : null}
      {maintenance.status === 'failed' && maintenance.error ? (
        <p className="sync-error" role="alert">
          {maintenance.error}
        </p>
      ) : null}
      {preview && preview.candidateCount > 0 && maintenance.status === 'ready' ? (
        <button disabled={operationBusy} type="button" onClick={onOpenConfirmation}>
          Normalize paper folder names
        </button>
      ) : null}
      {confirmationOpen && preview ? (
        <PaperFolderNameNormalizationConfirmation
          busy={operationBusy}
          preview={preview}
          onCancel={onCancelConfirmation}
          onConfirm={() => {
            onCancelConfirmation();
            void coordinator
              .normalizePaperFolderNames(PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION)
              .catch(() => undefined);
          }}
        />
      ) : null}
    </section>
  );
}

function PaperFolderNamePreview({
  preview,
}: {
  preview: PaperFolderNameNormalizationPreview;
}) {
  return (
    <div className="sync-legacy-inventory" aria-live="polite">
      <p>
        {preview.candidateCount === 0
          ? 'No verified paper folder names need normalization.'
          : `${preview.candidateCount} verified paper ${
              preview.candidateCount === 1 ? 'folder can' : 'folders can'
            } be normalized.`}
      </p>
      {preview.items.length ? (
        <details>
          <summary>Preview name changes</summary>
          <ul>
            {preview.items.map((item) => (
              <li key={item.folderId}>
                <strong>{item.currentName}</strong>
                <span aria-label="will be renamed to">→ {item.normalizedName}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function PaperFolderNameNormalizationConfirmation({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: PaperFolderNameNormalizationPreview;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section
      aria-labelledby="paper-folder-name-confirmation-title"
      className="sync-legacy-confirmation"
      role="group"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <h3 id="paper-folder-name-confirmation-title">
        Confirm folder-name normalization
      </h3>
      <p>
        Rename {preview.candidateCount} verified paper{' '}
        {preview.candidateCount === 1 ? 'folder' : 'folders'} by removing only a final
        “.pdf” extension.
      </p>
      <p>
        This changes folder names only. Paper IDs, parent folders, source filenames,
        immutable data, and Drive control records are not changed. Same-name folders
        remain separate.
      </p>
      <div className="sync-actions">
        <button disabled={busy} type="button" onClick={onConfirm}>
          Normalize paper folder names
        </button>
        <button ref={cancelRef} disabled={busy} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function LegacyDriveHousekeepingPanel({
  coordinator,
  housekeeping,
  busy,
  confirmationOpen,
  onOpenConfirmation,
  onCancelConfirmation,
}: {
  coordinator: PaperGoogleDriveSyncCoordinator;
  housekeeping: PaperSyncViewState['legacyHousekeeping'];
  busy: boolean;
  confirmationOpen: boolean;
  onOpenConfirmation(): void;
  onCancelConfirmation(): void;
}) {
  const inventory = housekeeping.inventory;
  const operationBusy =
    busy || housekeeping.status === 'checking' || housekeeping.status === 'cleaning';
  return (
    <section className="sync-legacy-housekeeping" aria-labelledby="legacy-drive-title">
      <h3 id="legacy-drive-title">Legacy Drive data</h3>
      <p>
        Check for obsolete 39Note data left by an earlier sync layout. The check is
        read-only.
      </p>
      <button
        disabled={operationBusy}
        type="button"
        onClick={() => void coordinator.checkLegacyDriveData().catch(() => undefined)}
      >
        {housekeeping.status === 'checking' ? 'Checking…' : 'Check legacy Drive data'}
      </button>
      {housekeeping.status === 'checking' ? (
        <p aria-live="polite" role="status">
          Checking the managed 39Note folder…
        </p>
      ) : null}
      {inventory ? <LegacyDriveInventorySummary inventory={inventory} /> : null}
      {housekeeping.status === 'complete' ? (
        <p className="sync-success" role="status">
          Moved {housekeeping.lastTrashedCount ?? 0} recognized legacy{' '}
          {(housekeeping.lastTrashedCount ?? 0) === 1 ? 'item' : 'items'} to Google
          Drive Trash. The inventory was checked again.
        </p>
      ) : null}
      {housekeeping.status === 'failed' && housekeeping.error ? (
        <p className="sync-error" role="alert">
          {housekeeping.error}
        </p>
      ) : null}
      {inventory &&
      inventory.cleanupEligibleCount > 0 &&
      housekeeping.status === 'ready' ? (
        <button
          disabled={operationBusy || Boolean(inventory.cleanupBlockedReason)}
          type="button"
          onClick={onOpenConfirmation}
        >
          Remove recognized legacy data
        </button>
      ) : null}
      {confirmationOpen && inventory ? (
        <LegacyCleanupConfirmation
          busy={operationBusy}
          inventory={inventory}
          onCancel={onCancelConfirmation}
          onConfirm={() => {
            void coordinator
              .removeRecognizedLegacyData(LEGACY_CLEANUP_CONFIRMATION)
              .then(onCancelConfirmation, onCancelConfirmation);
          }}
        />
      ) : null}
    </section>
  );
}

function LegacyDriveInventorySummary({
  inventory,
}: {
  inventory: LegacyDriveInventory;
}) {
  const diagnosticItems = inventory.items.filter(
    ({ classification }) =>
      classification !== 'current-paper-v2' && classification !== 'current-layout-v3',
  );
  return (
    <div className="sync-legacy-inventory" aria-live="polite">
      <dl>
        <div>
          <dt>Current paper data</dt>
          <dd>{inventory.currentPaperCount}</dd>
        </div>
        <div>
          <dt>Recognized legacy items</dt>
          <dd>{inventory.recognizedLegacyCount}</dd>
        </div>
        <div>
          <dt>Unknown/unclassified items</dt>
          <dd>{inventory.unknownCount}</dd>
        </div>
      </dl>
      {inventory.cleanupBlockedReason ? <p>{inventory.cleanupBlockedReason}</p> : null}
      {diagnosticItems.length ? (
        <details>
          <summary>Inventory details</summary>
          <ul>
            {diagnosticItems.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong>
                <span>
                  {item.kind}
                  {item.role ? ` · ${item.role}` : ''} ·{' '}
                  {item.classification === 'recognized-legacy'
                    ? 'Recognized legacy'
                    : 'Unknown — preserved'}
                </span>
                <small>{item.reason}</small>
                <small>{item.cleanupDisposition}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function LegacyCleanupConfirmation({
  inventory,
  busy,
  onConfirm,
  onCancel,
}: {
  inventory: LegacyDriveInventory;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <section
      aria-labelledby="legacy-cleanup-confirmation-title"
      className="sync-legacy-confirmation"
      role="group"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || busy) return;
        event.preventDefault();
        onCancel();
      }}
    >
      <h3 id="legacy-cleanup-confirmation-title">Confirm legacy cleanup</h3>
      <p>
        {inventory.recognizedLegacyCount} recognized legacy{' '}
        {inventory.recognizedLegacyCount === 1 ? 'item was' : 'items were'} found;{' '}
        {inventory.cleanupEligibleCount} can be safely moved to Trash now.
      </p>
      <p>
        {inventory.unknownCount} unknown/unclassified{' '}
        {inventory.unknownCount === 1 ? 'item will' : 'items will'} be preserved.
      </p>
      <p>
        Current paper and Drive control data will be preserved. Only positively
        identified obsolete 39Note global-v1 data is targeted.
      </p>
      <div className="sync-actions">
        <button disabled={busy} type="button" onClick={onConfirm}>
          Move recognized legacy data to Trash
        </button>
        <button ref={cancelRef} disabled={busy} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function PaperPrimaryActions({
  state,
  coordinator,
  busy,
  onRequestConnect,
  onRequestRestoreResume,
  onSelectDeviceMode,
  onOpenSelector,
}: {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  busy: boolean;
  onRequestConnect(): void;
  onRequestRestoreResume(): void;
  onSelectDeviceMode(mode: PaperSyncViewState['deviceMode']): void;
  onOpenSelector(mode: SelectorMode): void;
}) {
  if (state.connection === 'not-configured') return null;
  if (state.issue?.code === 'layout-upgrade-failed') {
    const reconnect = state.issue.actions.includes('reconnect');
    const canRetry = state.issue.actions.includes('retry-layout-upgrade');
    const canRetryScan = state.issue.actions.includes('retry-now');
    return (
      <div className="sync-recommendation">
        <strong>Recommended</strong>
        {reconnect ? (
          <button
            disabled={busy}
            type="button"
            onClick={() => void coordinator.reconnect().catch(() => undefined)}
          >
            Reconnect Google Drive
          </button>
        ) : null}
        {canRetry ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void coordinator.upgradeDriveLayoutFromThisDevice().catch(() => undefined)
            }
          >
            Retry layout upgrade
          </button>
        ) : null}
        {canRetryScan ? (
          <button
            disabled={busy}
            type="button"
            onClick={() => void coordinator.retryNow().catch(() => undefined)}
          >
            Retry Drive scan
          </button>
        ) : null}
        {!reconnect && !canRetry && !canRetryScan ? (
          <span>Review Details before retrying.</span>
        ) : null}
      </div>
    );
  }
  if (state.connection === 'connecting') {
    return (
      <p className="sync-message" role="status">
        Connecting to Google Drive…
      </p>
    );
  }
  if (state.securityState && state.securityState.kind !== 'device-mode-required') {
    return (
      <SecurityRecoveryActions busy={busy} coordinator={coordinator} state={state} />
    );
  }
  if (state.restorePublicationHold) {
    const hold = state.restorePublicationHold;
    return (
      <div className="sync-recommendation sync-restore-publication-hold">
        <strong>Restored work is saved locally</strong>
        <p>
          Google Drive publication is paused for {hold.restoredDocumentCount}{' '}
          {hold.restoredDocumentCount === 1
            ? 'restored document'
            : 'restored documents'}
          . Local reading and editing remain available. Your saved Auto sync preference
          has not changed, but it cannot run while this hold is active.
        </p>
        {hold.status === 'failed' && hold.error ? (
          <p className="sync-error" role="alert">
            {hold.error}
          </p>
        ) : null}
        {!state.deviceModeChoiceConfirmed ? (
          <button
            disabled={busy}
            type="button"
            onClick={() => onSelectDeviceMode(state.deviceMode)}
          >
            Confirm{' '}
            {state.deviceMode === 'temporary'
              ? 'Public / temporary device'
              : 'Personal device'}
          </button>
        ) : state.connection === 'disconnected' ? (
          <button disabled={busy} type="button" onClick={onRequestConnect}>
            Reconnect Google Drive
          </button>
        ) : (
          <button disabled={busy} type="button" onClick={onRequestRestoreResume}>
            {hold.status === 'revalidating'
              ? 'Revalidating Google Drive…'
              : 'Review and resume Google Drive sync'}
          </button>
        )}
      </div>
    );
  }
  if (state.connection === 'disconnected') {
    return (
      <div className="paper-connect-options">
        <fieldset disabled={busy}>
          <legend>How are you using this device?</legend>
          <label
            className={
              state.deviceModeChoiceConfirmed && state.deviceMode === 'personal'
                ? 'is-selected'
                : undefined
            }
          >
            <input
              checked={
                state.deviceModeChoiceConfirmed && state.deviceMode === 'personal'
              }
              name="sync-device-mode"
              type="radio"
              onChange={() => onSelectDeviceMode('personal')}
            />
            <span>
              <strong>Personal device</strong>
              <small>
                Use this on a device you control. Local study data and connection
                settings may be retained.
              </small>
            </span>
          </label>
          <label
            className={
              state.deviceModeChoiceConfirmed && state.deviceMode === 'temporary'
                ? 'is-selected'
                : undefined
            }
          >
            <input
              checked={
                state.deviceModeChoiceConfirmed && state.deviceMode === 'temporary'
              }
              name="sync-device-mode"
              type="radio"
              onChange={() => onSelectDeviceMode('temporary')}
            />
            <span>
              <strong>Public / temporary device</strong>
              <small>
                Use this on a shared device. Automatic sync is disabled, and temporary
                data is cleared at safe startup boundaries.
              </small>
            </span>
          </label>
        </fieldset>
        {state.deviceMode === 'temporary' ? (
          <p className="sync-message">
            Use a Private, Incognito, or InPrivate window. Finish clears only
            39Note-controlled data. A reload or recovered crash clears the temporary
            workspace, so export or upload selected work before leaving.
          </p>
        ) : null}
        <button
          disabled={
            busy || !state.backendConfigured || !state.deviceModeChoiceConfirmed
          }
          type="button"
          onClick={onRequestConnect}
        >
          Connect Google Drive
        </button>
      </div>
    );
  }
  if (state.connection === 'reconnect-required') {
    return (
      <div className="sync-actions">
        <button
          disabled={busy}
          type="button"
          onClick={() => void coordinator.reconnect().catch(() => undefined)}
        >
          Reconnect Google Drive
        </button>
      </div>
    );
  }
  if (state.connection === 'root-unavailable') {
    return (
      <div className="sync-recommendation">
        <strong>Recommended</strong>
        <button
          disabled={busy}
          type="button"
          onClick={() => void coordinator.scanCloudPapers().catch(() => undefined)}
        >
          Check again
        </button>
        {state.deviceMode !== 'temporary' ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              window.confirm(
                'Create a new empty 39Note folder only if the previous folder was intentionally removed?',
              ) && void coordinator.createReplacementRoot().catch(() => undefined)
            }
          >
            Create replacement folder
          </button>
        ) : null}
      </div>
    );
  }
  if (
    state.connection === 'layout-upgrade-required' ||
    state.connection === 'migration-incomplete'
  ) {
    const upgradingToV3 = state.layoutUpgradeKind === 'v2-to-v3';
    const upgradingProtocol = state.layoutUpgradeKind === 'protocol-2-to-3';
    return (
      <div className="sync-recommendation">
        <strong>
          {state.connection === 'migration-incomplete'
            ? 'Drive layout upgrade did not finish'
            : 'Drive layout upgrade required'}
        </strong>
        {upgradingToV3 || upgradingProtocol ? (
          <p>
            Close other 39Note tabs and devices before upgrading. Older 39Note builds
            must not be used after this upgrade.
          </p>
        ) : null}
        <button
          disabled={busy}
          type="button"
          onClick={() =>
            window.confirm(
              upgradingToV3 || upgradingProtocol
                ? 'Close every other 39Note tab and device before continuing. Older 39Note builds must never sync this Drive library after upgrade. Continue?'
                : 'Rebuild paper packages from this device? Unknown Drive files and the legacy data will be preserved.',
            ) &&
            void (
              upgradingProtocol
                ? coordinator.upgradePaperSyncProtocolToV3()
                : upgradingToV3
                  ? coordinator.upgradeDriveSyncToV3()
                  : coordinator.upgradeDriveLayoutFromThisDevice()
            ).catch(() => undefined)
          }
        >
          {upgradingToV3 || upgradingProtocol
            ? 'Upgrade Drive sync'
            : 'Rebuild from this device'}
        </button>
      </div>
    );
  }
  return (
    <div className="sync-actions paper-sync-main-actions">
      <button
        disabled={busy || Boolean(state.securityState)}
        type="button"
        onClick={() => onOpenSelector('download')}
      >
        Browse Drive papers
      </button>
      <button
        disabled={
          busy ||
          Boolean(state.activeDriveOperation) ||
          state.issue?.code === 'drive-operation-timeout' ||
          Boolean(state.securityState) ||
          state.dirtyPaperIds.length === 0
        }
        type="button"
        onClick={() => onOpenSelector('upload')}
      >
        Upload changes
        {state.dirtyPaperIds.length ? ` (${state.dirtyPaperIds.length})` : ''}
      </button>
      {state.connection === 'offline' || getPaperSyncUiStatus(state) === 'attention' ? (
        <button
          disabled={busy || Boolean(state.activeDriveOperation)}
          type="button"
          onClick={() => void coordinator.retryNow().catch(() => undefined)}
        >
          {state.issue?.code === 'drive-operation-timeout'
            ? 'Check Drive again (read-only)'
            : 'Retry now'}
        </button>
      ) : null}
      {state.deviceMode === 'temporary' ? (
        <button
          className="sync-finish-button"
          disabled={busy}
          type="button"
          onClick={() => onOpenSelector('finish')}
        >
          Finish on this device
        </button>
      ) : null}
    </div>
  );
}

function SecurityRecoveryActions({
  state,
  coordinator,
  busy,
}: {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  busy: boolean;
}) {
  const kind = state.securityState?.kind;
  if (!kind || kind === 'device-mode-required') return null;
  const copy = {
    'public-root-missing': {
      title: 'Set up Drive sync on a personal device first',
      detail:
        'No existing 39Note Drive library was found. Nothing was created, and this Public / temporary session cannot create one.',
    },
    'account-association-required': {
      title: 'Confirm this Library’s Google account',
      detail:
        'This populated local Library has no trusted account association. Sync and Drive merging are paused until you explicitly associate the currently verified account. This step does not upload anything.',
    },
    'account-mismatch': {
      title: 'Google account mismatch',
      detail:
        'This local 39Note Library is linked to a different Google account. Sync has been paused to protect your papers, notes, and queued changes. Reconnect with the original account to restore sync eligibility. If Auto sync is enabled, it may resume only after that account is verified.',
    },
    'account-identity-unavailable': {
      title: 'Google account identity could not be verified',
      detail:
        'No Drive read, merge, or publication can continue until a verified account session is established. Your local data remains unchanged.',
    },
  }[kind];
  return (
    <aside className="sync-security-recovery" role="alert">
      <strong>{copy.title}</strong>
      <p>{copy.detail}</p>
      <div className="sync-actions">
        {kind === 'account-mismatch' ? (
          <button
            className="is-primary"
            disabled={busy}
            type="button"
            onClick={() =>
              void coordinator.reconnectOriginalAccount().catch(() => undefined)
            }
          >
            Reconnect with original account
          </button>
        ) : null}
        {kind === 'account-association-required' ? (
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void coordinator.adoptCurrentAccountForWorkspace().catch(() => undefined)
            }
          >
            Associate this local Library
          </button>
        ) : null}
        <button
          disabled={busy}
          type="button"
          onClick={() => void coordinator.disconnect().catch(() => undefined)}
        >
          {kind === 'public-root-missing'
            ? 'Disconnect and continue locally'
            : kind === 'account-mismatch'
              ? 'Disconnect'
              : 'Disconnect Google Drive'}
        </button>
      </div>
    </aside>
  );
}

export function PaperSelectorDialog({
  state,
  coordinator,
  mode,
  affectedDocumentIds,
  onBrowseAll,
  onClose,
}: {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  mode: SelectorMode;
  affectedDocumentIds?: readonly string[];
  onBrowseAll?(): void;
  onClose(): void;
}) {
  const affectedDocumentIdKey = affectedDocumentIds?.join('\u0000') ?? '';
  const rows = useMemo(
    () => paperRows(state, mode, affectedDocumentIds),
    // The key makes an immutable semantic set explicit without depending on an
    // array identity recreated by a parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [affectedDocumentIdKey, mode, state],
  );
  const isDownloadMode = mode === 'download' || mode === 'updates';
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        mode === 'updates'
          ? rows.map((row) => row.documentId)
          : mode === 'download'
            ? []
            : defaultDirtyPaperSelection(state.paperStates),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgetPaperCandidate, setForgetPaperCandidate] =
    useState<ForgetInaccessiblePaperCandidate>();
  const [forgetPaperPending, setForgetPaperPending] = useState(false);
  const [forgetPaperError, setForgetPaperError] = useState<string>();
  const [forgetProofCheckingId, setForgetProofCheckingId] = useState<string>();
  const [forgetProofMessage, setForgetProofMessage] = useState<{
    documentId: string;
    message: string;
  }>();
  const selectedKeepLocalIds =
    mode === 'updates'
      ? [...selected].filter((documentId) => {
          const paper = state.paperStates.find(
            (candidate) => candidate.documentId === documentId,
          );
          return Boolean(
            paper &&
            paper.availability !== 'cloud-only' &&
            paper.cloudPresence === 'present' &&
            (paper.status === 'remote-update-available' ||
              paper.status === 'both-changed'),
          );
        })
      : [];
  const affectedFailure =
    mode === 'updates' &&
    (affectedDocumentIds ?? []).some(
      (documentId) =>
        state.paperStates.find((paper) => paper.documentId === documentId)?.status ===
          'needs-attention' ||
        state.papers.find((paper) => paper.documentId === documentId)?.status ===
          'needs-attention',
    );
  const finishingUpdates = mode === 'updates' && busy && rows.length === 0;
  const title =
    mode === 'updates'
      ? finishingUpdates
        ? 'Finishing updates'
        : error || affectedFailure
          ? 'Update needs attention'
          : `Updates available (${rows.length})`
      : mode === 'download'
        ? 'Google Drive papers'
        : mode === 'upload'
          ? 'Changes on this device'
          : 'Finish on this device';

  const rowIdKey = rows.map((row) => row.documentId).join('\u0000');
  useEffect(() => {
    if (mode !== 'updates') return;
    if (!busy && !error) {
      const available = new Set(rows.map((row) => row.documentId));
      setSelected((current) => {
        const next = new Set(
          [...current].filter((documentId) => available.has(documentId)),
        );
        return next.size === current.size ? current : next;
      });
    }
    if (
      affectedDocumentIds?.length &&
      rows.length === 0 &&
      !busy &&
      !error &&
      !state.error &&
      !affectedFailure &&
      state.progress.phase === 'idle' &&
      state.connection !== 'loading' &&
      state.connection !== 'connecting' &&
      state.connection !== 'syncing'
    ) {
      onClose();
    }
    // rowIdKey captures the authoritative remaining update set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    affectedFailure,
    busy,
    error,
    mode,
    rowIdKey,
    state.connection,
    state.error,
    state.progress.phase,
  ]);

  const run = async (all = false) => {
    const ids = all ? rows.map((row) => row.documentId) : [...selected];
    if (isDownloadMode) {
      setError(null);
      const operation = coordinator.downloadSelected(ids);
      onClose();
      await operation.catch(() => undefined);
      return;
    }
    if (mode === 'upload') {
      setError(null);
      const operation = coordinator.uploadSelected(ids);
      onClose();
      await operation.catch(() => undefined);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const remaining = state.dirtyPaperIds.filter((id) => !ids.includes(id));
      const abandon =
        remaining.length > 0 &&
        window.confirm(
          `Leave ${remaining.length} unsynced paper(s) on this device and clear their local 39Note data? This cannot be undone.`,
        );
      if (remaining.length && !abandon) return;
      await coordinator.finishTemporaryDevice(ids, abandon);
      onClose();
    } catch (caught) {
      if (caught instanceof TemporaryDirtyWorkError) setError(caught.message);
      else
        setError(
          caught instanceof Error
            ? caught.message
            : 'The selected operation could not complete.',
        );
    } finally {
      setBusy(false);
    }
  };

  const keepLocal = async () => {
    if (!selectedKeepLocalIds.length) return;
    const confirmed = window.confirm(
      `Replace the Google Drive version for ${selectedKeepLocalIds.length} ${selectedKeepLocalIds.length === 1 ? 'paper' : 'papers'} with the current local editable state? A conflicting source PDF will not be overwritten.`,
    );
    if (!confirmed) return;
    const operation = coordinator.keepLocalSelected(selectedKeepLocalIds);
    onClose();
    await operation.catch(() => undefined);
  };

  const confirmForgetInaccessiblePaper = () => {
    const candidate = forgetPaperCandidate;
    if (!candidate || forgetPaperPending) return;
    setForgetPaperPending(true);
    setForgetPaperError(undefined);
    void coordinator
      .forgetInaccessiblePaper(candidate.documentId)
      .then(() => {
        setSelected((current) => {
          const next = new Set(current);
          next.delete(candidate.documentId);
          return next;
        });
        setForgetPaperCandidate(undefined);
      })
      .catch((caught: unknown) =>
        setForgetPaperError(
          caught instanceof Error
            ? caught.message
            : 'The paper could not be safely ignored.',
        ),
      )
      .finally(() => setForgetPaperPending(false));
  };

  const verifyForgetIdentity = async (documentId: string) => {
    if (forgetProofCheckingId) return;
    setForgetProofCheckingId(documentId);
    setForgetProofMessage(undefined);
    try {
      await coordinator.checkSyncStatusReadOnly(documentId);
      const diagnostic = coordinator.getForgetInaccessiblePaperDiagnostic?.(documentId);
      if (!diagnostic?.eligible) {
        setForgetProofMessage({
          documentId,
          message: forgetInaccessiblePaperBlockerMessage(
            diagnostic?.reason ?? 'identity-proof-unavailable',
          ),
        });
      }
    } catch (caught) {
      setForgetProofMessage({
        documentId,
        message:
          caught instanceof Error
            ? caught.message
            : 'The read-only identity check could not complete.',
      });
    } finally {
      setForgetProofCheckingId(undefined);
    }
  };

  return (
    <div className="paper-selector-backdrop" role="presentation">
      <section aria-label={title} className="paper-selector-dialog" role="dialog">
        <header>
          <h2>{title}</h2>
          <button
            aria-label={`Close ${title}`}
            disabled={busy}
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {mode === 'finish' ? (
          <p>
            Upload selected work, revoke this temporary 39Note session, then clear only
            data recorded for this temporary session.
          </p>
        ) : null}
        {rows.length ? (
          <ul className="paper-selector-list">
            {rows.map((row) => {
              const isForgetRecoveryRow =
                mode === 'download' && row.status === 'needs-attention';
              const forgetDiagnostic = isForgetRecoveryRow
                ? coordinator.getForgetInaccessiblePaperDiagnostic?.(row.documentId)
                : undefined;
              const verifiedForgetCandidate = isForgetRecoveryRow
                ? (forgetDiagnostic?.candidate ??
                  coordinator.getForgetInaccessiblePaperCandidate?.(row.documentId))
                : undefined;
              const showReadOnlyVerification = shouldOfferForgetIdentityVerification(
                Boolean(verifiedForgetCandidate),
                forgetDiagnostic?.reason,
              );
              return (
                <li
                  key={row.documentId}
                  className={`${row.updateAvailable ? 'is-update-available ' : ''}${syncToneClass(
                    syncToneForPaper(row.status, row.issueCode),
                  )}`}
                >
                  <label>
                    <input
                      checked={selected.has(row.documentId)}
                      disabled={busy || (!isDownloadMode && !row.dirty)}
                      type="checkbox"
                      onChange={(event) =>
                        setSelected((current) =>
                          toggleSelection(
                            current,
                            row.documentId,
                            event.target.checked,
                          ),
                        )
                      }
                    />
                    <span>
                      <strong>{row.displayName}</strong>
                      <small>
                        {row.statusLabel}
                        {row.writerLabel ? ` · from ${row.writerLabel}` : ''}
                        {row.publishedAt
                          ? ` · ${formatTimestamp(row.publishedAt)}`
                          : ''}
                      </small>
                      {row.status === 'needs-attention' ? (
                        <small className="paper-selector-document-id">
                          Document ID <code>{row.documentId}</code>
                        </small>
                      ) : null}
                      {row.reasons.length ? (
                        <small>{row.reasons.map(dirtyReasonLabel).join(' · ')}</small>
                      ) : null}
                    </span>
                  </label>
                  {isForgetRecoveryRow ? (
                    <div className="paper-selector-forget-recovery">
                      <button
                        disabled={
                          busy || forgetPaperPending || !verifiedForgetCandidate
                        }
                        type="button"
                        onClick={() => {
                          if (!verifiedForgetCandidate) return;
                          setForgetPaperError(undefined);
                          setForgetPaperCandidate(verifiedForgetCandidate);
                        }}
                      >
                        Forget inaccessible paper
                      </button>
                      {!verifiedForgetCandidate ? (
                        <small role="status">
                          Unavailable:{' '}
                          {forgetProofMessage?.documentId === row.documentId
                            ? forgetProofMessage.message
                            : forgetInaccessiblePaperBlockerMessage(
                                forgetDiagnostic?.reason ??
                                  'identity-proof-unavailable',
                              )}
                          {import.meta.env.DEV ? (
                            <>
                              {' '}
                              Failed predicate:{' '}
                              <code>
                                {forgetDiagnostic?.reason ??
                                  'identity-proof-unavailable'}
                              </code>
                            </>
                          ) : null}
                        </small>
                      ) : null}
                      {showReadOnlyVerification ? (
                        <button
                          disabled={busy || Boolean(forgetProofCheckingId)}
                          type="button"
                          onClick={() => void verifyForgetIdentity(row.documentId)}
                        >
                          {forgetProofCheckingId === row.documentId
                            ? 'Verifying identity…'
                            : 'Verify identity (read-only)'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : finishingUpdates ? (
          <p aria-live="polite" className="paper-selector-finishing" role="status">
            <span aria-hidden="true" className="sync-activity-indicator" />
            Verifying and saving the selected update…
          </p>
        ) : error || affectedFailure ? null : (
          <p>
            {mode === 'finish'
              ? 'All changes are synced. This temporary session is ready to finish.'
              : 'No papers are available for this action.'}
          </p>
        )}
        {error ? (
          <p className="sync-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="sync-actions">
          <button
            disabled={busy || (mode !== 'finish' && selected.size === 0)}
            type="button"
            onClick={() => void run(false)}
          >
            {busy
              ? mode === 'updates'
                ? finishingUpdates
                  ? 'Finishing update…'
                  : 'Downloading update…'
                : mode === 'download'
                  ? 'Downloading…'
                  : mode === 'upload'
                    ? 'Uploading…'
                    : 'Finishing…'
              : isDownloadMode
                ? 'Download selected'
                : mode === 'upload'
                  ? 'Upload selected'
                  : selected.size > 0
                    ? 'Upload selected and finish'
                    : 'Finish on this device'}
          </button>
          {mode === 'download' ? (
            <button
              disabled={busy || rows.length === 0}
              type="button"
              onClick={() => void run(true)}
            >
              Download all
            </button>
          ) : null}
          {mode === 'updates' && onBrowseAll ? (
            <>
              <button
                disabled={busy || selectedKeepLocalIds.length === 0}
                title="Publish the current local editable state as a descendant of every current Drive head."
                type="button"
                onClick={() => void keepLocal()}
              >
                Keep local · Replace Drive version
              </button>
              <button disabled={busy} type="button" onClick={onBrowseAll}>
                Browse all Drive papers
              </button>
            </>
          ) : null}
          <button disabled={busy} type="button" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </section>
      {forgetPaperCandidate ? (
        <ForgetInaccessiblePaperDialog
          busy={forgetPaperPending}
          candidate={forgetPaperCandidate}
          error={forgetPaperError}
          onCancel={() => {
            if (!forgetPaperPending) setForgetPaperCandidate(undefined);
          }}
          onConfirm={confirmForgetInaccessiblePaper}
        />
      ) : null}
    </div>
  );
}

function RemoteUpdateRecommendation({
  state,
  coordinator,
  onBrowse,
}: {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  onBrowse(affectedDocumentIds: readonly string[]): void;
}) {
  const reminder = state.reminder!;
  const affected = reminder.paperIds.flatMap((documentId) => {
    const paper = state.papers.find((candidate) => candidate.documentId === documentId);
    return paper ? [paper] : [];
  });
  const reviewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    reviewRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void coordinator.dismissRemoteUpdates();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [coordinator, reminder.episodeId]);
  return (
    <aside
      aria-describedby="paper-update-summary"
      aria-label="Google Drive updates"
      className="paper-update-recommendation sync-tone-warning"
      role="dialog"
    >
      <div>
        <strong id="paper-update-summary">
          {reminder.paperIds.length}{' '}
          {reminder.paperIds.length === 1 ? 'paper updated' : 'papers updated'} in Drive
        </strong>
        {affected.slice(0, 2).map((paper) => (
          <span key={paper.documentId}>
            {paper.displayName}
            {paper.writerLabel ? ` · from ${paper.writerLabel}` : ''}
          </span>
        ))}
      </div>
      <div className="paper-update-actions">
        <button
          ref={reviewRef}
          type="button"
          onClick={() => onBrowse([...reminder.paperIds])}
        >
          Review updates
        </button>
        <button type="button" onClick={() => void coordinator.dismissRemoteUpdates()}>
          Dismiss for now
        </button>
      </div>
    </aside>
  );
}

function isDownloadablePaperStatus(status: PaperSyncState['status']): boolean {
  return (
    status === 'cloud-only' ||
    status === 'remote-update-available' ||
    status === 'both-changed'
  );
}

function StatusMessage({ state }: { state: PaperSyncViewState }) {
  const status = getPaperSyncUiStatus(state);
  const tone = syncToneForView(state, status);
  let message = state.error ?? state.restorePublicationNotice;
  if (!message) {
    if (state.restorePublicationHold?.status === 'revalidating') {
      message =
        'Checking the connected account, managed Drive folder, and current remote state. Nothing is being uploaded.';
    } else if (state.restorePublicationHold?.status === 'failed') {
      message = state.restorePublicationHold.error;
    } else if (state.restorePublicationHold) {
      message =
        'Restored work is saved locally. Google Drive publication remains paused until you review and resume it.';
    } else if (status === 'not-configured')
      message = 'Google Drive sync is not configured.';
    else if (status === 'disconnected') message = 'Connect to browse or upload papers.';
    else if (status === 'connecting') message = 'Waiting for Google authorization…';
    else if (status === 'offline')
      message = 'No internet connection. Changes remain saved locally.';
    else if (status === 'pending')
      message = `${state.dirtyPaperIds.length} paper change${state.dirtyPaperIds.length === 1 ? '' : 's'} waiting.`;
  }
  if (!message) return null;
  return (
    <p
      className={`${status === 'attention' ? 'sync-error' : 'sync-message'} ${syncToneClass(tone)}`}
      role={status === 'attention' ? 'alert' : 'status'}
    >
      {message}
    </p>
  );
}

interface PaperRow {
  documentId: string;
  displayName: string;
  status: PaperSyncState['status'];
  statusLabel: string;
  updateAvailable: boolean;
  dirty: boolean;
  reasons: PaperDirtyReason[];
  writerLabel?: string;
  publishedAt?: number;
  issueCode?: string;
  issueMessage?: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- exported for pure selector tests.
export function paperRows(
  state: PaperSyncViewState,
  mode: SelectorMode,
  affectedDocumentIds: readonly string[] = [],
): PaperRow[] {
  const ignored = new Set(
    (state.ignoredCloudIssues ?? []).map(({ documentId }) => documentId),
  );
  const cloud = new Map(state.papers.map((paper) => [paper.documentId, paper]));
  const local = new Map(state.paperStates.map((paper) => [paper.documentId, paper]));
  const ids =
    mode === 'updates'
      ? [...new Set(affectedDocumentIds)]
      : mode === 'download'
        ? [...cloud.values()]
            .filter(
              (paper) =>
                paper.presenceState !== 'removed' &&
                (!paper.deleted ||
                  local.get(paper.documentId)?.availability !== 'cloud-only'),
            )
            .map((paper) => paper.documentId)
        : [...local.keys()];
  return ids
    .filter((documentId) => !ignored.has(documentId))
    .map((documentId) =>
      rowFor(documentId, cloud.get(documentId), local.get(documentId)),
    )
    .filter((row) => {
      if (mode === 'updates') {
        return (
          cloud.has(row.documentId) &&
          (row.updateAvailable ||
            row.status === 'downloading' ||
            row.status === 'needs-attention')
        );
      }
      return mode === 'download' || row.dirty;
    })
    .sort(
      (a, b) =>
        (mode === 'download'
          ? Number(b.updateAvailable) - Number(a.updateAvailable)
          : 0) ||
        a.displayName.localeCompare(b.displayName) ||
        a.documentId.localeCompare(b.documentId),
    );
}

function rowFor(
  documentId: string,
  cloud: PaperCloudSummary | undefined,
  local: PaperSyncState | undefined,
): PaperRow {
  const presentation = getPaperStatusPresentation(cloud, local);
  const { status } = presentation;
  return {
    documentId,
    displayName: cloud?.displayName ?? local?.displayName ?? 'Untitled paper',
    status,
    statusLabel: paperStatusLabel(status),
    updateAvailable: status === 'remote-update-available' || status === 'both-changed',
    dirty: Boolean(local?.dirtyReasons.length && local.cloudPresence !== 'removed'),
    reasons: local?.dirtyReasons ?? [],
    writerLabel: cloud?.writerLabel,
    publishedAt: cloud?.publishedAt,
    issueCode: presentation.issue?.code,
    issueMessage: presentation.issue?.message,
  };
}

function toggleSelection(
  current: Set<string>,
  id: string,
  checked: boolean,
): Set<string> {
  const next = new Set(current);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

function paperStatusLabel(status: PaperSyncState['status']): string {
  switch (status) {
    case 'cloud-only':
      return 'Cloud only';
    case 'local-only':
      return 'Local only';
    case 'synced':
      return 'Synced';
    case 'local-changes':
      return 'Local changes';
    case 'remote-update-available':
      return 'Update available';
    case 'both-changed':
      return 'Local and Drive changes';
    case 'downloading':
      return 'Downloading';
    case 'uploading':
      return 'Uploading';
    case 'needs-attention':
      return 'Needs attention';
  }
}

function forgetInaccessiblePaperBlockerMessage(
  reason: ForgetInaccessiblePaperDiagnostic['reason'],
): string {
  switch (reason) {
    case 'eligible':
      return 'The exact paper identity is verified.';
    case 'workspace-profile-missing':
    case 'personal-device-required':
    case 'account-identity-unavailable':
    case 'account-scope-mismatch':
    case 'root-scope-missing':
      return 'the current Google account and 39Note folder could not be verified.';
    case 'already-ignored':
      return 'this paper is already under Ignored cloud issues.';
    case 'catalog-paper-missing':
      return 'the matching cloud catalog record is unavailable.';
    case 'paper-not-needs-attention':
      return 'this paper no longer has a blocking cloud issue.';
    case 'paper-removed':
      return 'the current cloud record is removed or marked deleted.';
    case 'paper-folder-unavailable':
      return 'the managed Drive paper folder identity is unavailable.';
    case 'local-state-missing':
      return 'the matching local sync state is unavailable.';
    case 'local-cloud-presence-not-present':
      return 'the local sync state does not confirm present cloud data.';
    case 'paper-folder-mismatch':
      return 'the catalog and local state do not identify the same Drive folder.';
    case 'identity-proof-unavailable':
      return 'exact account/root/document proof is not available yet. Run the read-only identity check.';
  }
}

function dirtyReasonLabel(reason: PaperDirtyReason): string {
  switch (reason) {
    case 'metadata':
      return 'Name or organization changed';
    case 'source-pdf':
      return 'Source PDF changed';
    case 'source-document':
      return 'Source document changed';
    case 'notes':
      return 'Notes changed';
    case 'annotations':
      return 'Annotations changed';
    case 'glossary':
      return 'Glossary changed';
    case 'reading-state':
      return 'Reading position changed';
    case 'print-draft':
      return 'Print layout changed';
    case 'deleted':
      return 'Paper deleted';
    case 'rendered-print-pdf':
      return 'Print PDF updated';
    case 'ai-conversation':
      return 'AI conversation changed';
  }
}

function toolbarLabel(state: PaperSyncViewState): string {
  return `Drive · ${paperSyncStatusLabel(state).toLocaleLowerCase()}`;
}

function drawerLabel(state: PaperSyncViewState): string {
  return paperSyncStatusLabel(state);
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}
