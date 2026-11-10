import {
  recoverCrashSafeRestore,
  type CrashSafeRecoveryResult,
} from './crashSafeRestoreEngine.ts';
import { prepareAnnotationPersistenceRecoveryStartup } from './annotationPersistence.ts';
import { IndexedDbUpgradeBlockedError } from './indexedDbLifecycle.ts';
import {
  RestoreStartupBlockedError,
  WorkspaceRestoreBarrierError,
} from './restoreSafety.ts';
import { prepareProductivityPersistenceStartup } from './productivityPersistence.ts';
import { WorkspaceLocksUnavailableError } from './workspaceRestoreLock.ts';

export interface RestoreSafetyStartupDependencies {
  prepareAnnotationPersistence(): Promise<void>;
  prepareProductivityPersistence(): Promise<void>;
  recoverRestore(): Promise<CrashSafeRecoveryResult>;
}

export interface RestoreSafetyStartupPresentation {
  heading: string;
  detail: string;
}

const productionDependencies: RestoreSafetyStartupDependencies = {
  prepareAnnotationPersistence: prepareAnnotationPersistenceRecoveryStartup,
  prepareProductivityPersistence: prepareProductivityPersistenceStartup,
  recoverRestore: recoverCrashSafeRestore,
};

export interface RestoreStartupRecoveryNotice {
  title: string;
  detail: string;
}

let pendingRecoveryNotice: RestoreStartupRecoveryNotice | null = null;

export class RestoreStartupRecoveryError extends Error {
  constructor() {
    super('39Note could not prove that restore recovery completed safely.');
    this.name = 'RestoreStartupRecoveryError';
  }
}

/**
 * Runs before React and the sync coordinator exist. The document database is
 * authoritative for restore admission; productivity is upgraded only after a
 * clear document barrier has been verified.
 */
export async function verifyRestoreSafetyBeforeAppMount(
  dependencies: RestoreSafetyStartupDependencies = productionDependencies,
): Promise<void> {
  pendingRecoveryNotice = null;
  await dependencies.prepareAnnotationPersistence();
  await dependencies.prepareProductivityPersistence();
  try {
    const recovery = await dependencies.recoverRestore();
    if (recovery.outcome === 'rolled-back') {
      pendingRecoveryNotice = {
        title: 'Interrupted restore rolled back safely',
        detail:
          '39Note restored the exact previous local Library state before opening. No Google Drive work was started.',
      };
    } else if (recovery.outcome === 'publication-hold') {
      pendingRecoveryNotice = {
        title: 'Completed restore recovered',
        detail:
          'The restored Library is available locally. Google Drive publication remains paused until you review and explicitly resume it.',
      };
    }
  } catch {
    throw new RestoreStartupRecoveryError();
  }
}

export function consumeRestoreStartupRecoveryNotice(): RestoreStartupRecoveryNotice | null {
  const notice = pendingRecoveryNotice;
  pendingRecoveryNotice = null;
  return notice;
}

/** Pure read for React initializers, which StrictMode may invoke more than once. */
export function peekRestoreStartupRecoveryNotice(): RestoreStartupRecoveryNotice | null {
  return pendingRecoveryNotice;
}

export function describeRestoreSafetyStartupFailure(
  error: unknown,
): RestoreSafetyStartupPresentation | null {
  if (error instanceof IndexedDbUpgradeBlockedError) {
    return {
      heading: 'Close or refresh other 39Note tabs',
      detail:
        'Another tab is holding an older local database connection. Your data was not changed. Close or refresh every other 39Note tab, then reload this page.',
    };
  }
  if (error instanceof WorkspaceLocksUnavailableError) {
    return {
      heading: 'This browser cannot safely open 39Note',
      detail:
        'Workspace locking is unavailable, so 39Note stopped before enabling local edits or Google Drive. Open this Library in a current supported browser.',
    };
  }
  if (error instanceof RestoreStartupBlockedError) {
    return error.reason === 'publication-hold'
      ? {
          heading: 'Restored work is waiting for review',
          detail:
            'The completed restore and its publication hold were preserved, but 39Note could not safely enter the Drive-review state. No Google Drive work was started. Reload to retry safe startup.',
        }
      : {
          heading: 'Restore recovery is required',
          detail:
            '39Note found an incomplete restore operation and stopped before opening the Library or starting Google Drive. Recovery data was preserved.',
        };
  }
  if (error instanceof RestoreStartupRecoveryError) {
    return {
      heading: 'Restore recovery needs your attention',
      detail:
        '39Note could not prove a complete rollback or committed restore cleanup. Recovery evidence was preserved, Google Drive remains blocked, and the Library was not opened. Close other 39Note tabs, then retry recovery.',
    };
  }
  if (error instanceof WorkspaceRestoreBarrierError) {
    return {
      heading: 'Restore recovery needs your attention',
      detail:
        '39Note could not validate the durable restore record. Recovery evidence was preserved, Google Drive remains blocked, and the Library was not opened.',
    };
  }
  return null;
}
