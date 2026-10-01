import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadLibraryBackup } from '../services/libraryBackup.ts';
import { flushLocalPersistence } from '../services/persistentChange.ts';
import {
  getSyncUiStatus,
  getGoogleDriveSyncCoordinator,
  type GoogleDriveSyncCoordinator,
  type SyncViewState,
} from './coordinator.ts';
import { getSyncProgressPresentation } from './progressPresentation.ts';
import { getSyncSoundFeedback } from './syncSounds.ts';

const PANEL_ID = 'google-drive-sync-panel';
const PANEL_TITLE_ID = 'google-drive-sync-title';
const GOOGLE_DRIVE_URL = 'https://drive.google.com/drive/my-drive';
const DRIVE_RESET_WARNING =
  'This deletes/replaces 39Note-managed sync data in the selected Google Drive 39Note folder and republishes the current local state. Other Google Drive files are not affected.';

const initialState: SyncViewState = {
  connection: 'loading',
  autoSync: true,
  dirty: false,
  backendConfigured: false,
  sessions: [],
  progress: { phase: 'idle' },
  rootChoices: [],
  conflicts: [],
  resetRequired: false,
};

interface BackupProgress {
  completed: number;
  total: number;
}

interface SyncDrawerProps {
  state: SyncViewState;
  coordinator: GoogleDriveSyncCoordinator;
  soundEnabled: boolean;
  backupProgress: BackupProgress | null;
  backupMessage: string | null;
  backupError: string | null;
  onClose(): void;
  onDownloadBackup(): void;
  onSoundEnabledChange(enabled: boolean): void;
}

export function SyncControl() {
  const coordinator = useMemo(() => getGoogleDriveSyncCoordinator(), []);
  const soundFeedback = useMemo(() => getSyncSoundFeedback(), []);
  const [state, setState] = useState(initialState);
  const [isOpen, setIsOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(soundFeedback.enabled);
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unsubscribe = coordinator.subscribe(setState);
    void coordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [coordinator]);

  useEffect(() => {
    const unlock = () => {
      soundFeedback.unlock();
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, { capture: true, once: true });
    document.addEventListener('keydown', unlock, { capture: true, once: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
  }, [soundFeedback]);

  const close = useCallback(() => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [close, isOpen]);

  const downloadBackup = async () => {
    setBackupError(null);
    setBackupMessage(null);
    setBackupProgress({ completed: 0, total: 0 });
    try {
      await flushLocalPersistence();
      await downloadLibraryBackup((completed, total) => {
        setBackupProgress({ completed, total });
      });
      setBackupMessage('Local backup downloaded.');
    } catch {
      setBackupError('The local 39Note backup could not be created. Please try again.');
    } finally {
      setBackupProgress(null);
    }
  };

  const changeSoundPreference = (enabled: boolean) => {
    soundFeedback.setEnabled(enabled);
    setSoundEnabled(enabled);
    if (enabled) soundFeedback.unlock();
  };

  const uiStatus = getSyncUiStatus(state);
  return (
    <div className="sync-control">
      <button
        ref={triggerRef}
        aria-controls={PANEL_ID}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={`toolbar-button sync-trigger is-${uiStatus}`}
        title="Google Drive sync"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="sync-status-dot" aria-hidden="true" />
        {toolbarStatusLabel(state)}
      </button>
      {isOpen ? (
        <SyncDrawer
          backupError={backupError}
          backupMessage={backupMessage}
          backupProgress={backupProgress}
          coordinator={coordinator}
          soundEnabled={soundEnabled}
          state={state}
          onClose={close}
          onDownloadBackup={() => void downloadBackup()}
          onSoundEnabledChange={changeSoundPreference}
        />
      ) : null}
    </div>
  );
}

export function SyncDrawer({
  state,
  coordinator,
  soundEnabled,
  backupProgress,
  backupMessage,
  backupError,
  onClose,
  onDownloadBackup,
  onSoundEnabledChange,
}: SyncDrawerProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const isBusy =
    state.connection === 'connecting' ||
    state.connection === 'disconnecting' ||
    state.connection === 'syncing';
  const uiStatus = getSyncUiStatus(state);
  const message = statusMessage(state);
  const progress = getSyncProgressPresentation(state.progress);
  const backupRecommended = state.issue?.backupRecommended === true;
  const recommendedActions = state.issue?.actions ?? [];

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const retryReset = () => {
    if (
      window.confirm(
        `${DRIVE_RESET_WARNING}\n\nThe current local state on this device will become authoritative. Close 39Note on other devices before continuing.`,
      )
    ) {
      void coordinator.resetDriveSyncFromThisDevice().catch(() => undefined);
    }
  };

  return (
    <section
      aria-labelledby={PANEL_TITLE_ID}
      className="sync-panel"
      id={PANEL_ID}
      role="dialog"
      tabIndex={-1}
    >
      <header>
        <div className="sync-heading">
          <h2 id={PANEL_TITLE_ID}>Google Drive</h2>
          <span
            aria-live="polite"
            className={`sync-status-badge is-${uiStatus}`}
            role="status"
          >
            {drawerStatusLabel(state)}
          </span>
        </div>
        <button
          ref={closeRef}
          aria-label="Close Google Drive sync"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {message && !backupRecommended ? (
        <p
          className={uiStatus === 'attention' ? 'sync-error' : 'sync-message'}
          role={uiStatus === 'attention' ? 'alert' : 'status'}
        >
          {message}
        </p>
      ) : null}

      {backupRecommended && state.issue ? (
        <div
          className="sync-recovery-card"
          data-sync-state={
            state.issue.code === 'drive-storage-full' ? 'drive-full' : state.issue.code
          }
          role="alert"
        >
          <strong>{state.issue.message}</strong>
          <p>
            {state.issue.code === 'drive-storage-full'
              ? 'Download a local 39Note backup until Drive space is available.'
              : 'Download a local 39Note backup while upload problems continue.'}
          </p>
          <div className="sync-actions">
            <button
              data-sync-action="download-local-backup"
              disabled={backupProgress !== null}
              type="button"
              onClick={onDownloadBackup}
            >
              {backupProgress ? 'Creating backup…' : 'Download local backup'}
            </button>
            <a
              data-sync-action="open-google-drive"
              href={state.rootUrl ?? GOOGLE_DRIVE_URL}
              rel="noreferrer"
              target="_blank"
            >
              Open Google Drive
            </a>
          </div>
        </div>
      ) : null}

      {backupProgress ? (
        <p aria-live="polite" className="sync-message" role="status">
          {backupProgress.total > 0
            ? `Creating local backup · ${backupProgress.completed} of ${backupProgress.total}`
            : 'Preparing local backup…'}
        </p>
      ) : null}
      {backupMessage ? (
        <p aria-live="polite" className="sync-message" role="status">
          {backupMessage}
        </p>
      ) : null}
      {backupError ? (
        <p className="sync-error" role="alert">
          {backupError}
        </p>
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

      <PrimaryActions
        coordinator={coordinator}
        isBusy={isBusy}
        recommendedActions={recommendedActions}
        retryReset={retryReset}
        state={state}
      />

      {state.rootChoices.length > 0 ? (
        <div className="sync-root-choices">
          <h3>Choose the 39Note folder</h3>
          {state.rootChoices.map((root) => (
            <button
              key={root.id}
              type="button"
              onClick={() =>
                void coordinator.chooseRoot(root.id).catch(() => undefined)
              }
            >
              Use {root.name} · modified{' '}
              {formatTimestamp(
                root.modifiedTime ? Date.parse(root.modifiedTime) : undefined,
              )}
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
            disabled={isBusy || state.resetRequired}
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
        {state.summary ? (
          <p className="sync-summary">
            {state.summary.mergedDocuments} documents · {state.summary.pdfsUploaded}{' '}
            PDFs uploaded · {state.summary.pdfsDownloaded} downloaded
          </p>
        ) : null}
        {state.issue ? <IssueDetails state={state} /> : null}
        {state.integrityIssue ? <IntegrityDetails state={state} /> : null}
        {state.sessions.length > 0 ? <SessionDetails state={state} /> : null}
        {state.conflicts.some((conflict) => !conflict.dismissedAt) ? (
          <ConflictDetails coordinator={coordinator} state={state} />
        ) : null}
        <div className="sync-actions">
          {state.rootUrl ? (
            <a href={state.rootUrl} rel="noreferrer" target="_blank">
              Open 39Note folder
            </a>
          ) : null}
          {state.sessions.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() =>
                  void coordinator.switchGoogleAccount().catch(() => undefined)
                }
              >
                Switch Google account
              </button>
              <button
                type="button"
                onClick={() => void coordinator.disconnect().catch(() => undefined)}
              >
                Disconnect this device
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      'Disconnect every 39Note device and revoke this app’s Google authorization?',
                    )
                  ) {
                    void coordinator.disconnectAll().catch(() => undefined);
                  }
                }}
              >
                Disconnect all devices
              </button>
            </>
          ) : null}
        </div>
      </details>

      <details className="sync-advanced">
        <summary>Advanced</summary>
        {state.backendConfigured && state.sessions.length > 0 ? (
          <div className="sync-reset">
            <strong>Drive recovery</strong>
            <p>{DRIVE_RESET_WARNING}</p>
            <button
              disabled={
                isBusy ||
                state.connection === 'offline' ||
                state.connection === 'backend-unavailable' ||
                state.connection === 'root-selection-required' ||
                state.connection === 'root-unavailable'
              }
              type="button"
              onClick={retryReset}
            >
              Reset Drive sync from this device
            </button>
          </div>
        ) : null}
        <div className="sync-privacy-notice">
          <strong>Private by design</strong>
          <p>
            PDFs and editable data travel directly between this browser and Google Drive
            using the limited <code>drive.file</code> permission. They do not pass
            through the sign-in service.
          </p>
          <p>
            Google access tokens stay in memory. AI keys, passwords, client secrets, and
            custom authentication headers never sync.
          </p>
          <a href="./google-drive-sync-setup.html" target="_blank">
            Setup and troubleshooting
          </a>
        </div>
      </details>
    </section>
  );
}

function PrimaryActions({
  coordinator,
  isBusy,
  recommendedActions,
  retryReset,
  state,
}: {
  coordinator: GoogleDriveSyncCoordinator;
  isBusy: boolean;
  recommendedActions: NonNullable<SyncViewState['issue']>['actions'];
  retryReset(): void;
  state: SyncViewState;
}) {
  if (state.connection === 'disconnecting') {
    return (
      <div className="sync-actions">
        <button disabled type="button">
          Disconnecting…
        </button>
      </div>
    );
  }
  if (state.resetRequired) {
    return (
      <div className="sync-recommendation">
        <strong>Recommended</strong>
        <button disabled={isBusy} type="button" onClick={retryReset}>
          Retry Drive reset
        </button>
      </div>
    );
  }
  if (state.integrityIssue && state.connection !== 'syncing') {
    return (
      <div className="sync-actions">
        <button
          disabled={isBusy}
          type="button"
          onClick={() =>
            void coordinator.retryIntegrityVerification().catch(() => undefined)
          }
        >
          Retry verification
        </button>
        {state.integrityIssue.verificationState === 'verified' ? (
          <button
            disabled={isBusy}
            type="button"
            onClick={() => void coordinator.syncNow('manual').catch(() => undefined)}
          >
            Continue synchronization
          </button>
        ) : null}
        {state.integrityIssue.localRepairAvailable ? (
          <button
            disabled={isBusy}
            type="button"
            onClick={() =>
              void coordinator.repairIntegrityFromLocal().catch(() => undefined)
            }
          >
            Repair from verified local copy
          </button>
        ) : null}
        {state.integrityIssue.remoteMergeAvailable ? (
          <button
            disabled={isBusy}
            type="button"
            onClick={() =>
              void coordinator
                .preserveAndMergeRemoteIntegrityGeneration()
                .catch(() => undefined)
            }
          >
            Preserve and merge Drive generation
          </button>
        ) : null}
      </div>
    );
  }
  if (state.connection === 'root-unavailable') {
    return (
      <div className="sync-actions">
        <button
          type="button"
          onClick={() =>
            void coordinator.createReplacementRoot().catch(() => undefined)
          }
        >
          Create replacement 39Note folder
        </button>
      </div>
    );
  }
  if (
    recommendedActions.includes('choose-root') ||
    state.connection === 'root-selection-required'
  ) {
    return (
      <div className="sync-recommendation">
        <strong>Recommended</strong>
        <span>Choose a 39Note folder below.</span>
      </div>
    );
  }
  if (
    recommendedActions.includes('reconnect') ||
    state.connection === 'reconnect-required'
  ) {
    return (
      <div className="sync-recommendation">
        <strong>Recommended</strong>
        <button
          disabled={isBusy || !state.backendConfigured}
          type="button"
          onClick={() =>
            void (
              state.connection === 'disconnected'
                ? coordinator.connect()
                : coordinator.reconnect()
            ).catch(() => undefined)
          }
        >
          {state.connection === 'disconnected'
            ? 'Connect Google Drive'
            : 'Reconnect Google Drive'}
        </button>
      </div>
    );
  }
  const hasOrdinarySyncAction =
    state.connection === 'connected' ||
    state.connection === 'syncing' ||
    ((!state.issue || recommendedActions.includes('retry-now')) &&
      (state.connection === 'offline' ||
        state.connection === 'backend-unavailable' ||
        state.connection === 'error'));
  if (hasOrdinarySyncAction) {
    return (
      <div className="sync-actions">
        <button
          disabled={isBusy}
          type="button"
          onClick={() => void coordinator.retryNow().catch(() => undefined)}
        >
          {state.connection === 'offline' ||
          state.connection === 'backend-unavailable' ||
          state.connection === 'error'
            ? 'Retry now'
            : 'Sync now'}
        </button>
        {isBusy ? (
          <button type="button" onClick={() => coordinator.cancel()}>
            Cancel
          </button>
        ) : null}
      </div>
    );
  }
  if (
    state.connection === 'loading' ||
    state.connection === 'not-configured' ||
    state.connection === 'disconnected' ||
    state.connection === 'connecting'
  ) {
    return (
      <div className="sync-actions">
        <button
          disabled={isBusy || !state.backendConfigured}
          type="button"
          onClick={() => void coordinator.connect().catch(() => undefined)}
        >
          Connect Google Drive
        </button>
      </div>
    );
  }
  return null;
}

function IssueDetails({ state }: { state: SyncViewState }) {
  const issue = state.issue;
  if (!issue) return null;
  return (
    <dl className="sync-issue-details">
      <div>
        <dt>Code</dt>
        <dd>{issue.code}</dd>
      </div>
      <div>
        <dt>Severity</dt>
        <dd>{issue.severity}</dd>
      </div>
      <div>
        <dt>Retry</dt>
        <dd>{issue.retrySafe ? 'Safe' : 'User action required'}</dd>
      </div>
      <div>
        <dt>Ordinary sync</dt>
        <dd>{issue.blocksOrdinarySync ? 'Paused' : 'May retry'}</dd>
      </div>
      <div>
        <dt>Source</dt>
        <dd>
          {issue.diagnostic.source}
          {issue.diagnostic.httpStatus ? ` · HTTP ${issue.diagnostic.httpStatus}` : ''}
          {issue.diagnostic.reason ? ` · ${issue.diagnostic.reason}` : ''}
          {issue.diagnostic.operation ? ` · ${issue.diagnostic.operation}` : ''}
        </dd>
      </div>
    </dl>
  );
}

function IntegrityDetails({ state }: { state: SyncViewState }) {
  const issue = state.integrityIssue;
  if (!issue) return null;
  return (
    <dl className="sync-integrity-details">
      <div>
        <dt>Affected item</dt>
        <dd>{integrityTypeLabel(issue.logicalType)}</dd>
      </div>
      {issue.documentId ? (
        <div>
          <dt>Document</dt>
          <dd>
            {issue.documentTitle ? <>{issue.documentTitle} · </> : null}
            <code>{issue.documentId}</code>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Drive role</dt>
        <dd>
          <code>{issue.logicalPath}</code>
        </dd>
      </div>
      <div>
        <dt>Verification</dt>
        <dd>
          expected {issue.expectedHashPrefix}… · downloaded {issue.actualHashPrefix}… ·
          file {issue.fileIdFingerprint}
          {issue.driveFileVersion ? ` · version ${issue.driveFileVersion}` : ''}
        </dd>
      </div>
      <div>
        <dt>Evidence</dt>
        <dd>
          {issue.verificationState === 'verified'
            ? 'Payload currently verifies'
            : issue.actualPayloadValid
              ? 'Valid 39Note JSON from a different generation'
              : 'Invalid payload for this role'}
          {' · '}verification {issue.retryOutcome}
          {' · '}evidence {issue.evidenceStable ? 'stable' : 'changed'}
        </dd>
      </div>
      <div>
        <dt>Recommended choices</dt>
        <dd>
          {issue.recommendedRecoveryChoices
            .map(integrityRecoveryChoiceLabel)
            .join(' · ')}
        </dd>
      </div>
    </dl>
  );
}

function SessionDetails({ state }: { state: SyncViewState }) {
  return (
    <div className="sync-sessions">
      <strong>Authorized devices ({state.sessions.length})</strong>
      <ul>
        {state.sessions.map((session) => (
          <li key={session.id}>
            {session.current ? 'This device' : 'Other device'} · authorized{' '}
            {formatTimestamp(session.createdAt)} · last used{' '}
            {formatTimestamp(session.lastUsedAt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConflictDetails({
  coordinator,
  state,
}: {
  coordinator: GoogleDriveSyncCoordinator;
  state: SyncViewState;
}) {
  const conflicts = state.conflicts.filter((conflict) => !conflict.dismissedAt);
  return (
    <div className="sync-conflicts">
      <strong>{conflicts.length} preserved text conflict(s)</strong>
      {conflicts.map((conflict) => (
        <article key={conflict.id}>
          <strong>{conflict.entityKind}</strong>
          <p>The newest version is active. The alternate remains recoverable.</p>
          <details>
            <summary>Inspect recoverable alternate</summary>
            <pre>{formatConflictValue(conflict.alternateValue)}</pre>
          </details>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(formatConflictValue(conflict.alternateValue))
                .catch(() => undefined)
            }
          >
            Copy alternate
          </button>
          <button
            type="button"
            onClick={() => void coordinator.dismissConflict(conflict.id)}
          >
            Dismiss
          </button>
        </article>
      ))}
    </div>
  );
}

function toolbarStatusLabel(state: SyncViewState): string {
  switch (getSyncUiStatus(state)) {
    case 'syncing':
      return 'Drive · syncing';
    case 'offline':
      return 'Drive · offline';
    case 'pending':
      return 'Drive · changes waiting';
    case 'synced':
      return 'Drive · synced';
    case 'attention':
      return 'Drive · needs attention';
    case 'connected':
      return 'Drive · ready';
    case 'connecting':
      return 'Drive · connecting';
    case 'disconnecting':
      return 'Drive · disconnecting';
    default:
      return 'Drive sync';
  }
}

function drawerStatusLabel(state: SyncViewState): string {
  if (state.progress.phase === 'resetting') return 'Resetting Drive sync';
  switch (getSyncUiStatus(state)) {
    case 'syncing':
      return 'Syncing';
    case 'offline':
      return 'Offline';
    case 'pending':
      return 'Changes waiting';
    case 'synced':
      return 'Synced';
    case 'attention':
      return 'Needs attention';
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'disconnecting':
      return 'Disconnecting';
    default:
      return 'Not connected';
  }
}

function statusMessage(state: SyncViewState): string | null {
  if (state.issue) return state.issue.message;
  switch (getSyncUiStatus(state)) {
    case 'loading':
      return 'Loading sync settings…';
    case 'not-configured':
      return 'Google Drive sync is not configured.';
    case 'disconnected':
      return 'Connect Google Drive to sync this device.';
    case 'connecting':
      return 'Waiting for Google authorization…';
    case 'disconnecting':
      return 'Disconnecting this device…';
    case 'connected':
      return 'Ready to sync.';
    case 'pending':
      return 'Changes are waiting to sync.';
    case 'syncing':
    case 'synced':
      return null;
    case 'offline':
      return 'No internet connection. Changes remain saved locally.';
    case 'attention':
      if (state.resetRequired)
        return 'Drive reset did not finish. Ordinary sync is paused.';
      if (state.integrityIssue) return 'Drive data needs verification.';
      if (state.conflicts.some((conflict) => !conflict.dismissedAt))
        return 'A synchronized text conflict is ready for review.';
      return 'Google Drive sync needs attention.';
  }
}

function integrityTypeLabel(
  type: NonNullable<SyncViewState['integrityIssue']>['logicalType'],
): string {
  switch (type) {
    case 'library-metadata':
      return 'Library metadata';
    case 'ai-settings':
      return 'AI history and configuration';
    case 'document-state':
      return 'Document state, annotations, and notes';
    case 'productivity-data':
      return 'Document productivity data';
  }
}

function integrityRecoveryChoiceLabel(
  choice: NonNullable<
    SyncViewState['integrityIssue']
  >['recommendedRecoveryChoices'][number],
): string {
  switch (choice) {
    case 'repair-from-local':
      return 'Repair from verified local copy';
    case 'preserve-and-merge-remote':
      return 'Preserve and merge Drive generation';
    case 'continue-sync':
      return 'Continue synchronization';
    case 'manual-inspection':
      return 'Inspect before recovery';
  }
}

function formatTimestamp(value?: number): string {
  return value && Number.isFinite(value) ? new Date(value).toLocaleString() : 'Never';
}

function formatConflictValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
