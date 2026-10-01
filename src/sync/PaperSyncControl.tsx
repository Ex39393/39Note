import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadLibraryBackup } from '../services/libraryBackup.ts';
import { flushLocalPersistence } from '../services/persistentChange.ts';
import {
  getPaperGoogleDriveSyncCoordinator,
  getBlockingPaperIssueCount,
  getPaperSyncUiStatus,
  LEGACY_CLEANUP_CONFIRMATION,
  PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION,
  TemporaryDirtyWorkError,
  type PaperGoogleDriveSyncCoordinator,
  type PaperConnectionStatus,
  type PaperSyncViewState,
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
import { getSyncSoundFeedback } from './syncSounds.ts';
import { defaultDirtyPaperSelection } from './paperStateMachine.ts';

const PANEL_ID = 'google-drive-paper-sync-panel';
const TITLE_ID = 'google-drive-paper-sync-title';
const GOOGLE_DRIVE_URL = 'https://drive.google.com/drive/my-drive';
const DRIVE_ACCESS_REQUEST_URL =
  'mailto:Gmail39393@gmail.com?subject=39Note%20Google%20Drive%20Access%20Request';

// eslint-disable-next-line react-refresh/only-export-components -- exported for pure state-model tests.
export const initialPaperSyncViewState: PaperSyncViewState = {
  connection: 'loading',
  backendConfigured: false,
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
      return 'Offline';
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
      if (state.progress.phase !== 'idle') return 'Syncing';
      const status = getPaperSyncUiStatus(state);
      if (status === 'attention') {
        const count = getBlockingPaperIssueCount(state);
        return count > 0
          ? `Connected · Needs attention — ${count} ${count === 1 ? 'paper' : 'papers'}`
          : 'Needs attention';
      }
      if (status === 'pending') return 'Changes waiting';
      if (status === 'synced') return 'Synced';
      return 'Connected';
    }
    default:
      return assertNeverConnectionStatus(state.connection);
  }
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
  state,
  onOpenDrive,
}: {
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
  return (
    <button
      aria-label={
        affectedDocumentIds.length
          ? `Google Drive sync: ${label}. ${updateLabel}. Review updates`
          : `Google Drive sync: ${label}. Open Google Drive`
      }
      className={`toolbar-button sync-trigger reader-sync-status-pill is-${status} ${syncToneClass(tone)}`}
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
      <span aria-live="polite">Drive · {label}</span>
      {affectedDocumentIds.length ? (
        <span className="reader-sync-update-count sync-tone-warning">
          {updateLabel}
        </span>
      ) : null}
    </button>
  );
}

/** Live Reader-only wrapper. Its button opens Home management; it owns no drawer. */
export function PaperReaderSyncStatus({
  onOpenDrive,
}: {
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

  return <ReaderSyncStatusPill state={state} onOpenDrive={onOpenDrive} />;
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
  embedded?: boolean;
  onClose?(): void;
  onOpenSelector(mode: SelectorMode, affectedDocumentIds?: readonly string[]): void;
  onSoundEnabledChange(enabled: boolean): void;
  onDownloadBackup(): void;
}

export function PaperSyncControl() {
  const coordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const soundFeedback = useMemo(() => getSyncSoundFeedback(), []);
  const [state, setState] = useState(initialPaperSyncViewState);
  const [isOpen, setIsOpen] = useState(false);
  const [selector, setSelector] = useState<SelectorRequest | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(soundFeedback.enabled);
  const [backupBusy, setBackupBusy] = useState(false);
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
    try {
      await flushLocalPersistence();
      await downloadLibraryBackup(() => undefined);
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

  return (
    <section className="paper-sync-home-page" aria-label="Google Drive management">
      <PaperSyncDrawer
        embedded
        coordinator={coordinator}
        soundEnabled={soundEnabled}
        state={state}
        onDownloadBackup={() =>
          void flushLocalPersistence().then(() =>
            downloadLibraryBackup(() => undefined),
          )
        }
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
  const cloud = new Map(state.papers.map((paper) => [paper.documentId, paper]));
  const local = new Map(state.paperStates.map((paper) => [paper.documentId, paper]));
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
            disabled={transferBusy || !state.papers.length}
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
    'paper-integrity-failed',
    'paper-logical-partition-invalid',
    'paper-source-pdf-conflict',
  ].includes(issueCode ?? 'paper-operation-failed');
}

export function PaperSyncDrawer({
  state,
  coordinator,
  soundEnabled,
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
  const closeRef = useRef<HTMLButtonElement>(null);
  const [legacyConfirmationOpen, setLegacyConfirmationOpen] = useState(false);
  const [folderNameConfirmationOpen, setFolderNameConfirmationOpen] = useState(false);

  useEffect(() => closeRef.current?.focus(), []);

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

      {embedded &&
      (state.connection === 'disconnected' ||
        state.connection === 'reconnect-required') ? (
        <aside className="sync-access-notice" aria-label="Google Drive access">
          <p>
            Google Drive sync currently requires an approved Google account. To request
            access, email Gmail39393@gmail.com.
          </p>
          <a href={DRIVE_ACCESS_REQUEST_URL}>Request access</a>
        </aside>
      ) : null}

      <PaperPrimaryActions
        busy={busy}
        coordinator={coordinator}
        state={state}
        onOpenSelector={onOpenSelector}
      />

      {state.issue?.backupRecommended ? (
        <div className="sync-recovery-card" role="alert">
          <strong>{state.issue.message}</strong>
          <p>Download a local 39Note backup while Drive uploads are unavailable.</p>
          <div className="sync-actions">
            <button type="button" onClick={onDownloadBackup}>
              Download local backup
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
            disabled={busy || state.deviceMode === 'temporary'}
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
        <dl className="paper-sync-summary">
          <div>
            <dt>Cloud papers</dt>
            <dd>{state.papers.length}</dd>
          </div>
          <div>
            <dt>Changes waiting</dt>
            <dd>{state.dirtyPaperIds.length}</dd>
          </div>
          <div>
            <dt>Device mode</dt>
            <dd>
              {state.deviceMode === 'temporary' ? 'Public / temporary' : 'Personal'}
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
            {state.issue.diagnostic.phase ? (
              <div>
                <dt>Failed step</dt>
                <dd>{state.issue.diagnostic.phase}</dd>
              </div>
            ) : null}
            {state.issue.diagnostic.causeCode ? (
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
            {state.issue.diagnostic.documentId ? (
              <div>
                <dt>Paper ID</dt>
                <dd>{state.issue.diagnostic.documentId}</dd>
              </div>
            ) : null}
            {state.issue.diagnostic.expectedSemanticPartition ? (
              <div>
                <dt>Expected data</dt>
                <dd>{state.issue.diagnostic.expectedSemanticPartition}</dd>
              </div>
            ) : null}
            {state.issue.diagnostic.actualSemanticPartitions?.length ? (
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
            {state.issue.diagnostic.compatibilityNormalizationAttempted !==
            undefined ? (
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
          </div>
        ) : null}
        {state.rootUrl &&
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
  onOpenSelector,
}: {
  state: PaperSyncViewState;
  coordinator: PaperGoogleDriveSyncCoordinator;
  busy: boolean;
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
  if (state.connection === 'disconnected') {
    return (
      <div className="paper-connect-options">
        <fieldset disabled={busy}>
          <legend>This device</legend>
          <label>
            <input
              checked={state.deviceMode === 'personal'}
              name="sync-device-mode"
              type="radio"
              onChange={() =>
                void coordinator.setDeviceMode('personal').catch(() => undefined)
              }
            />{' '}
            Personal device
          </label>
          <label>
            <input
              checked={state.deviceMode === 'temporary'}
              name="sync-device-mode"
              type="radio"
              onChange={() =>
                void coordinator.setDeviceMode('temporary').catch(() => undefined)
              }
            />{' '}
            Public / temporary device
          </label>
        </fieldset>
        {state.deviceMode === 'temporary' ? (
          <p className="sync-message">
            Use a Private, Incognito, or InPrivate window. Finish can clear only
            39Note-controlled data and cannot guarantee cleanup after a crash or sign
            Google out of the browser.
          </p>
        ) : null}
        <button
          disabled={busy || !state.backendConfigured}
          type="button"
          onClick={() => void coordinator.connect().catch(() => undefined)}
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
      </div>
    );
  }
  if (
    state.connection === 'layout-upgrade-required' ||
    state.connection === 'migration-incomplete'
  ) {
    const upgradingToV3 = state.layoutUpgradeKind === 'v2-to-v3';
    return (
      <div className="sync-recommendation">
        <strong>
          {state.connection === 'migration-incomplete'
            ? 'Drive layout upgrade did not finish'
            : 'Drive layout upgrade required'}
        </strong>
        {upgradingToV3 ? (
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
              upgradingToV3
                ? 'Close every other 39Note tab and device before continuing. Older 39Note builds must never sync this Drive library after upgrade. Continue?'
                : 'Rebuild paper packages from this device? Unknown Drive files and the legacy data will be preserved.',
            ) &&
            void (
              upgradingToV3
                ? coordinator.upgradeDriveSyncToV3()
                : coordinator.upgradeDriveLayoutFromThisDevice()
            ).catch(() => undefined)
          }
        >
          {upgradingToV3 ? 'Upgrade Drive sync' : 'Rebuild from this device'}
        </button>
      </div>
    );
  }
  return (
    <div className="sync-actions paper-sync-main-actions">
      <button disabled={busy} type="button" onClick={() => onOpenSelector('download')}>
        Browse Drive papers
      </button>
      <button
        disabled={busy || state.dirtyPaperIds.length === 0}
        type="button"
        onClick={() => onOpenSelector('upload')}
      >
        Upload changes
        {state.dirtyPaperIds.length ? ` (${state.dirtyPaperIds.length})` : ''}
      </button>
      {state.connection === 'offline' || getPaperSyncUiStatus(state) === 'attention' ? (
        <button
          disabled={busy}
          type="button"
          onClick={() => void coordinator.retryNow().catch(() => undefined)}
        >
          Retry now
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
            {rows.map((row) => (
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
                        toggleSelection(current, row.documentId, event.target.checked),
                      )
                    }
                  />
                  <span>
                    <strong>{row.displayName}</strong>
                    <small>
                      {row.statusLabel}
                      {row.writerLabel ? ` · from ${row.writerLabel}` : ''}
                      {row.publishedAt ? ` · ${formatTimestamp(row.publishedAt)}` : ''}
                    </small>
                    {row.reasons.length ? (
                      <small>{row.reasons.map(dirtyReasonLabel).join(' · ')}</small>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
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
  let message = state.error;
  if (!message) {
    if (status === 'not-configured') message = 'Google Drive sync is not configured.';
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
