import {
  DriveAuthorizationError,
  DriveNetworkError,
  DriveRequestError,
  normalizeDriveErrorReason,
} from './driveClient.ts';
import {
  DriveRootUnavailableError,
  GoogleDrivePayloadIntegrityError,
  MultipleDriveRootsError,
  RemoteManifestChangedError,
} from './driveRepository.ts';
import {
  GoogleAuthorizationCancelledError,
  GoogleReauthorizationRequiredError,
  SyncBackendUnavailableError,
  SyncServiceRateLimitedError,
} from './googleIdentity.ts';
import { LocalSyncPersistenceError } from './storage.ts';
import type { LayoutMigrationFailure } from './layoutMigration.ts';

export type SyncOperationalErrorCode =
  | 'offline'
  | 'google-authorization-required'
  | 'authorization-cancelled'
  | 'authorization-failed'
  | 'sync-service-unavailable'
  | 'sync-service-rate-limited'
  | 'drive-storage-full'
  | 'drive-rate-limited'
  | 'drive-backend-unavailable'
  | 'drive-access-denied'
  | 'drive-data-missing'
  | 'drive-root-missing'
  | 'drive-root-ambiguous'
  | 'drive-changed'
  | 'drive-integrity-mismatch'
  | 'paper-logical-partition-invalid'
  | 'paper-removed-from-drive'
  | 'drive-response-invalid'
  | 'drive-upload-persistent'
  | 'reset-incomplete'
  | 'layout-upgrade-failed'
  | 'local-persistence-failed'
  | 'local-changes-waiting'
  | 'sync-not-configured'
  | 'sync-cancelled'
  | 'unexpected-sync-failure';

export type SyncIssueSeverity = 'info' | 'warning' | 'error' | 'critical';
export type SyncIssueState =
  'offline' | 'attention' | 'disconnected' | 'connected' | 'pending';
export type SyncRecommendedAction =
  | 'retry-now'
  | 'automatic-retry'
  | 'reconnect'
  | 'open-google-drive'
  | 'download-local-backup'
  | 'choose-root'
  | 'create-root'
  | 'retry-reset'
  | 'retry-layout-upgrade'
  | 'details';

export interface SyncIssueDiagnostic {
  source: 'browser' | 'google-drive' | 'sync-service' | 'local-storage' | 'sync';
  httpStatus?: number;
  reason?: string;
  operation?: string;
  phase?: LayoutMigrationFailure['phase'];
  causeCode?: string;
  documentId?: string;
  paperName?: string;
  expectedSemanticPartition?: string;
  actualSemanticPartitions?: string[];
  sourceProtocolVersion?: number;
  compatibilityNormalizationAttempted?: boolean;
}

export interface SyncOperationalIssue {
  code: SyncOperationalErrorCode;
  message: string;
  severity: SyncIssueSeverity;
  state: SyncIssueState;
  actions: SyncRecommendedAction[];
  retrySafe: boolean;
  blocksOrdinarySync: boolean;
  backupRecommended: boolean;
  diagnostic: SyncIssueDiagnostic;
}

export interface SyncErrorContext {
  online: boolean;
  area?: 'authentication' | 'sync' | 'reset' | 'initialization';
  resetIncomplete?: boolean;
  pendingLocalChanges?: boolean;
  repeatedUploadFailure?: boolean;
  hasDeviceSession?: boolean;
}

export function issueForOfflineTransition(
  current: SyncOperationalIssue | undefined,
  offline: SyncOperationalIssue,
): SyncOperationalIssue {
  if (
    current &&
    (current.blocksOrdinarySync ||
      current.state === 'attention' ||
      current.severity === 'critical')
  ) {
    return current;
  }
  return offline;
}

export function isTransientConnectivityIssue(
  issue: SyncOperationalIssue | undefined,
): boolean {
  return Boolean(issue && issue.state === 'offline' && !issue.blocksOrdinarySync);
}

export function createResetIncompleteIssue(): SyncOperationalIssue {
  return {
    code: 'reset-incomplete',
    message: 'Drive reset did not finish. Ordinary sync is paused.',
    severity: 'error',
    state: 'attention',
    actions: ['retry-reset', 'details'],
    retrySafe: true,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: { source: 'sync', operation: 'reset' },
  };
}

export function createLayoutMigrationIssue(
  failure: LayoutMigrationFailure,
): SyncOperationalIssue {
  return {
    code: 'layout-upgrade-failed',
    message: failure.message,
    severity: 'error',
    state: 'attention',
    actions: [...new Set([failure.recommendedAction, 'details' as const])],
    retrySafe: failure.retrySafe,
    blocksOrdinarySync: failure.blocksOrdinarySync,
    backupRecommended: false,
    diagnostic: {
      source: 'sync',
      operation: 'layout-upgrade',
      phase: failure.phase,
      causeCode: failure.causeCode,
      ...(failure.documentId ? { documentId: failure.documentId } : {}),
      ...(failure.paperName ? { paperName: failure.paperName } : {}),
    },
  };
}

export function createLocalChangesWaitingIssue(): SyncOperationalIssue {
  return {
    code: 'local-changes-waiting',
    message: 'New changes are waiting for the next sync.',
    severity: 'info',
    state: 'pending',
    actions: ['automatic-retry', 'retry-now'],
    retrySafe: true,
    blocksOrdinarySync: false,
    backupRecommended: false,
    diagnostic: { source: 'sync', operation: 'reconciliation' },
  };
}

export function classifySyncError(
  error: unknown,
  context: SyncErrorContext,
): SyncOperationalIssue {
  if (error instanceof LocalSyncPersistenceError || isLocalStorageDomError(error)) {
    return {
      code: 'local-persistence-failed',
      message: '39Note could not save changes locally.',
      severity: 'critical',
      state: 'attention',
      actions: ['details'],
      retrySafe: false,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: {
        source: 'local-storage',
        operation:
          error instanceof LocalSyncPersistenceError ? error.operation : 'unknown',
      },
    };
  }

  if (
    error instanceof DriveAuthorizationError ||
    error instanceof GoogleReauthorizationRequiredError
  ) {
    return {
      code: 'google-authorization-required',
      message: 'Google Drive authorization needs to be renewed.',
      severity: 'warning',
      state: 'attention',
      actions: ['reconnect', 'details'],
      retrySafe: false,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'authorization' },
    };
  }

  if (error instanceof MultipleDriveRootsError) {
    return {
      code: 'drive-root-ambiguous',
      message: 'Choose which 39Note folder to use.',
      severity: 'warning',
      state: 'attention',
      actions: ['choose-root', 'details'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'folder-discovery' },
    };
  }

  if (error instanceof DriveRootUnavailableError) {
    return {
      code: 'drive-root-missing',
      message: 'The connected 39Note folder is no longer available.',
      severity: 'error',
      state: 'attention',
      actions: ['create-root', 'details'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'folder-discovery' },
    };
  }

  if (error instanceof GoogleDrivePayloadIntegrityError) {
    return {
      code: 'drive-integrity-mismatch',
      message: 'Drive data needs verification.',
      severity: 'error',
      state: 'attention',
      actions: ['details'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'integrity-verification' },
    };
  }

  if (error instanceof RemoteManifestChangedError) {
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

  if (error instanceof DriveRequestError) {
    const issue = classifyDriveRequestError(error);
    if (
      context.repeatedUploadFailure &&
      error.operation === 'upload' &&
      !issue.backupRecommended &&
      (error.code === 'backend-unavailable' ||
        error.code === 'invalid-response' ||
        error.code === 'request-failed')
    ) {
      const persistentIssue: SyncOperationalIssue = {
        code: 'drive-upload-persistent',
        message:
          'Google Drive has repeatedly failed to upload changes. Download a local backup while the problem continues.',
        severity: 'error',
        state: 'attention',
        actions: ['download-local-backup', 'open-google-drive', 'retry-now'],
        retrySafe: true,
        blocksOrdinarySync: false,
        backupRecommended: true,
        diagnostic: issue.diagnostic,
      };
      return context.resetIncomplete
        ? addResetRecovery(persistentIssue)
        : persistentIssue;
    }
    return context.resetIncomplete ? addResetRecovery(issue) : issue;
  }

  if (error instanceof DriveNetworkError || !context.online) {
    const issue: SyncOperationalIssue = {
      code: 'offline',
      message: 'No internet connection. Changes remain saved locally.',
      severity: 'warning',
      state: 'offline',
      actions: ['automatic-retry', 'retry-now'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: {
        source: 'browser',
        ...(error instanceof DriveNetworkError ? { operation: error.operation } : {}),
      },
    };
    return context.resetIncomplete ? addResetRecovery(issue) : issue;
  }

  if (error instanceof SyncBackendUnavailableError) {
    const needsInitialConnection = context.hasDeviceSession === false;
    return {
      code: 'sync-service-unavailable',
      message: 'Google Drive sign-in service is temporarily unavailable.',
      severity: 'warning',
      state: needsInitialConnection ? 'disconnected' : 'offline',
      actions: needsInitialConnection ? ['reconnect'] : ['retry-now'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: { source: 'sync-service', operation: 'authorization' },
    };
  }

  if (error instanceof SyncServiceRateLimitedError) {
    const needsInitialConnection = context.hasDeviceSession === false;
    return {
      code: 'sync-service-rate-limited',
      message: 'Google Drive sign-in is temporarily rate-limited. Try again shortly.',
      severity: 'warning',
      state: needsInitialConnection ? 'disconnected' : 'offline',
      actions: needsInitialConnection ? ['reconnect'] : ['retry-now'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: { source: 'sync-service', operation: 'authorization' },
    };
  }

  if (error instanceof GoogleAuthorizationCancelledError) {
    return {
      code: 'authorization-cancelled',
      message: 'Google Drive connection was cancelled.',
      severity: 'info',
      state: 'disconnected',
      actions: ['reconnect'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'authorization' },
    };
  }

  if (context.area === 'authentication') {
    return {
      code: 'authorization-failed',
      message: 'Google Drive connection failed. Your local data is safe.',
      severity: 'error',
      state: 'attention',
      actions: ['reconnect', 'details'],
      retrySafe: true,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'google-drive', operation: 'authorization' },
    };
  }

  if (
    error instanceof Error &&
    error.message === 'Persistent sync backend not configured.'
  ) {
    return {
      code: 'sync-not-configured',
      message: 'Google Drive sync is not configured.',
      severity: 'warning',
      state: 'attention',
      actions: ['details'],
      retrySafe: false,
      blocksOrdinarySync: true,
      backupRecommended: false,
      diagnostic: { source: 'sync', operation: 'configuration' },
    };
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      code: 'sync-cancelled',
      message: context.pendingLocalChanges
        ? 'Sync cancelled. Changes are still waiting.'
        : 'Sync cancelled.',
      severity: 'info',
      state: context.pendingLocalChanges ? 'pending' : 'connected',
      actions: ['retry-now'],
      retrySafe: true,
      blocksOrdinarySync: false,
      backupRecommended: false,
      diagnostic: { source: 'sync', operation: context.area ?? 'sync' },
    };
  }

  if (context.resetIncomplete || context.area === 'reset') {
    return createResetIncompleteIssue();
  }

  return {
    code: 'unexpected-sync-failure',
    message: 'Google Drive sync could not finish.',
    severity: 'error',
    state: 'attention',
    actions: ['retry-now', 'details'],
    retrySafe: true,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: { source: 'sync', operation: context.area ?? 'sync' },
  };
}

function classifyDriveRequestError(error: DriveRequestError): SyncOperationalIssue {
  const safeReason = normalizeDriveErrorReason(error.reason);
  const diagnostic: SyncIssueDiagnostic = {
    source: 'google-drive',
    httpStatus: error.status,
    operation: error.operation,
    ...(safeReason ? { reason: safeReason } : {}),
  };
  switch (error.code) {
    case 'storage-full':
      return {
        code: 'drive-storage-full',
        message: 'Google Drive is full. 39Note cannot upload new changes.',
        severity: 'error',
        state: 'attention',
        actions: ['download-local-backup', 'open-google-drive', 'retry-now'],
        retrySafe: true,
        blocksOrdinarySync: true,
        backupRecommended: true,
        diagnostic,
      };
    case 'rate-limited':
      return {
        code: 'drive-rate-limited',
        message:
          'Google Drive is temporarily rate-limiting sync. 39Note will retry automatically.',
        severity: 'warning',
        state: 'offline',
        actions: ['automatic-retry', 'retry-now'],
        retrySafe: true,
        blocksOrdinarySync: false,
        backupRecommended: false,
        diagnostic,
      };
    case 'backend-unavailable':
      return {
        code: 'drive-backend-unavailable',
        message: 'Google Drive is temporarily unavailable. Your changes remain local.',
        severity: 'warning',
        state: 'offline',
        actions: ['automatic-retry', 'retry-now'],
        retrySafe: true,
        blocksOrdinarySync: false,
        backupRecommended: false,
        diagnostic,
      };
    case 'permission-denied':
      return {
        code: 'drive-access-denied',
        message: '39Note no longer has access to part of its Drive data.',
        severity: 'error',
        state: 'attention',
        actions: ['reconnect', 'details'],
        retrySafe: false,
        blocksOrdinarySync: true,
        backupRecommended: false,
        diagnostic,
      };
    case 'not-found':
      return {
        code: 'drive-data-missing',
        message: 'Part of the 39Note data in Google Drive could not be found.',
        severity: 'error',
        state: 'attention',
        actions: ['details'],
        retrySafe: true,
        blocksOrdinarySync: true,
        backupRecommended: false,
        diagnostic,
      };
    case 'precondition-failed':
      return {
        code: 'drive-changed',
        message: 'Drive changed during sync. 39Note will safely retry.',
        severity: 'info',
        state: 'pending',
        actions: ['automatic-retry', 'retry-now'],
        retrySafe: true,
        blocksOrdinarySync: false,
        backupRecommended: false,
        diagnostic,
      };
    case 'invalid-response':
      return {
        code: 'drive-response-invalid',
        message:
          'Google Drive returned an invalid response. Your changes remain local.',
        severity: 'warning',
        state: 'offline',
        actions: ['retry-now', 'details'],
        retrySafe: true,
        blocksOrdinarySync: false,
        backupRecommended: false,
        diagnostic,
      };
    default:
      return {
        code: 'unexpected-sync-failure',
        message: 'Google Drive sync could not finish.',
        severity: 'error',
        state: 'attention',
        actions: ['retry-now', 'details'],
        retrySafe: true,
        blocksOrdinarySync: true,
        backupRecommended: false,
        diagnostic,
      };
  }
}

function addResetRecovery(issue: SyncOperationalIssue): SyncOperationalIssue {
  return {
    ...issue,
    actions: [...new Set([...issue.actions, 'retry-reset' as const])],
    blocksOrdinarySync: true,
  };
}

function isLocalStorageDomError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    [
      'ConstraintError',
      'DataError',
      'InvalidStateError',
      'NotReadableError',
      'QuotaExceededError',
      'ReadOnlyError',
      'TransactionInactiveError',
      'UnknownError',
    ].includes(error.name)
  );
}
