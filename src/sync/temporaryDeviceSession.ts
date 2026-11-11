import { clearTemporaryAiStorage } from '../ai/configuration.ts';
import {
  closeAnnotationPersistenceWorkspace,
  inspectAnnotationStorageFootprintStrict,
  withWorkspaceMutation,
} from '../services/annotationPersistence.ts';
import {
  closeProductivityPersistenceWorkspace,
  inspectProductivityStorageFootprintStrict,
} from '../services/productivityPersistence.ts';
import { flushLocalPersistence } from '../services/persistentChange.ts';
import {
  completeTemporaryWorkspace,
  deleteTemporaryWorkspaceDatabases,
  getTemporaryWorkspaceStartupCleanupReport,
  requireActiveTemporaryWorkspace,
} from '../services/temporaryWorkspace.ts';
import {
  assertWorkspaceRestoreLease,
  withWorkspaceIdentityTransition,
  type WorkspaceRestoreLease,
} from '../services/workspaceRestoreLock.ts';
import {
  clearTemporarySessionProvenance,
  closeSyncPersistenceWorkspace,
  loadCloudPaperCatalog,
  loadLayoutMigrationRecord,
  loadPaperSyncStates,
  loadTemporarySessionProvenance,
  saveTemporarySessionProvenance,
  type TemporarySessionProvenance,
} from './storage.ts';

export const PUBLIC_DEVICE_LIMITATION =
  'Finish clears 39Note-controlled browser data and revokes this 39Note session. It cannot erase browser or operating-system traces, guarantee cleanup after a crash, or sign the browser out of Google. Use a Private, Incognito, or InPrivate window on a shared computer.';

export interface TemporaryModePreflight {
  safe: boolean;
  reason?: string;
}

export interface TemporaryOriginFootprint {
  annotationDocumentCount: number;
  pdfDocumentCount: number;
  collectionCount: number;
  printDraftCount: number;
  conversationCount: number;
  aiStorageKeyCount: number;
  paperStateCount: number;
  cloudPaperCount: number;
  hasMigration: boolean;
  hasProvenance: boolean;
  hasPaperAccountState: boolean;
  hasLegacyAccountState: boolean;
}

export function evaluateTemporaryModeFootprint(
  footprint: TemporaryOriginFootprint,
): TemporaryModePreflight {
  void footprint;
  return { safe: true };
}

/**
 * Personal data is no longer an eligibility input: temporary sessions use their own
 * registered, UUID-scoped databases and storage keys.
 */
export async function inspectTemporaryModePreflight(): Promise<TemporaryModePreflight> {
  if (
    typeof indexedDB === 'undefined' ||
    typeof sessionStorage === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.locks
  ) {
    return {
      safe: false,
      reason: 'This browser cannot create an isolated temporary 39Note workspace.',
    };
  }
  const cleanup = getTemporaryWorkspaceStartupCleanupReport();
  if (
    cleanup.failedWorkspaceIds.length > 0 ||
    cleanup.ambiguousWorkspaceIds.length > 0
  ) {
    return {
      safe: false,
      reason:
        'An earlier temporary workspace could not be safely cleared. Use a new Private or Incognito window.',
    };
  }
  return { safe: true };
}

export async function beginTemporaryProvenance(
  accountId: string,
  rootFolderId?: string,
  workspaceLease?: WorkspaceRestoreLease,
): Promise<TemporarySessionProvenance> {
  return withWorkspaceMutation(async (lease) => {
    // Resolve the UUID-scoped identity only after shared workspace ownership is
    // active. Otherwise an identity transition could win between this read and
    // admission, causing provenance for the old workspace to reach the new DB.
    const workspace = await requireActiveTemporaryWorkspace();
    const existing = await loadTemporarySessionProvenance();
    if (existing) {
      if (
        existing.accountId !== accountId ||
        existing.temporarySessionId !== workspace.id ||
        (existing.rootFolderId !== undefined &&
          rootFolderId !== undefined &&
          existing.rootFolderId !== rootFolderId)
      ) {
        throw new Error(
          'Temporary data belongs to a different Google-backed 39Note workspace.',
        );
      }
      if (rootFolderId && !existing.rootFolderId) {
        const updated = { ...existing, rootFolderId };
        await saveTemporarySessionProvenance(updated, lease);
        return updated;
      }
      return existing;
    }
    const provenance: TemporarySessionProvenance = {
      id: 'temporary',
      temporarySessionId: workspace.id,
      accountId,
      ...(rootFolderId ? { rootFolderId } : {}),
      createdAt: Date.now(),
      documentIds: [],
      collectionIds: [],
      finishPhase: 'active',
    };
    await saveTemporarySessionProvenance(provenance, lease);
    return provenance;
  }, workspaceLease);
}

export async function recordTemporaryPaperIds(
  documentIds: readonly string[],
  collectionIds: readonly string[] = [],
  workspaceLease?: WorkspaceRestoreLease,
): Promise<void> {
  await withWorkspaceMutation(async (lease) => {
    const provenance = await loadTemporarySessionProvenance();
    if (!provenance) throw new Error('Temporary-session provenance is unavailable.');
    await saveTemporarySessionProvenance(
      {
        ...provenance,
        documentIds: sortedUnion(provenance.documentIds, documentIds),
        collectionIds: sortedUnion(provenance.collectionIds, collectionIds),
      },
      lease,
    );
  }, workspaceLease);
}

export async function setTemporaryFinishPhase(
  finishPhase: TemporarySessionProvenance['finishPhase'],
  workspaceLease?: WorkspaceRestoreLease,
): Promise<void> {
  await withWorkspaceMutation(async (lease) => {
    const provenance = await loadTemporarySessionProvenance();
    if (!provenance) throw new Error('Temporary-session provenance is unavailable.');
    await saveTemporarySessionProvenance({ ...provenance, finishPhase }, lease);
  }, workspaceLease);
}

/** Strict, provenance-only cleanup. Revocation must be awaited before this call. */
export async function cleanupTemporaryOrigin(
  existingTransitionLease?: WorkspaceRestoreLease,
): Promise<void> {
  const cleanup = (lease: WorkspaceRestoreLease) =>
    withWorkspaceMutation(async () => {
      const workspace = await requireActiveTemporaryWorkspace();
      const provenance = await loadTemporarySessionProvenance();
      if (!provenance) {
        throw new Error('Temporary workspace ownership could not be verified.');
      }
      if (workspace.id !== provenance.temporarySessionId) {
        throw new Error('Temporary workspace ownership could not be verified.');
      }
      await flushLocalPersistence();
      await setTemporaryFinishPhase('cleaning', lease);
      try {
        clearTemporaryAiStorage();
        await clearTemporarySessionProvenance(lease);
        await Promise.all([
          closeAnnotationPersistenceWorkspace(),
          closeProductivityPersistenceWorkspace(),
          closeSyncPersistenceWorkspace(),
        ]);
        await deleteTemporaryWorkspaceDatabases(workspace);
        await completeTemporaryWorkspace(workspace);
        window.dispatchEvent(new CustomEvent('39note:temporary-session-cleared'));
      } catch (error) {
        try {
          await saveTemporarySessionProvenance(
            {
              ...provenance,
              finishPhase: 'cleanup-incomplete',
            },
            lease,
          );
        } catch {
          // The registered workspace remains active, so a later retry still fails closed.
        }
        throw error;
      }
    }, lease);
  if (existingTransitionLease) {
    assertWorkspaceRestoreLease(existingTransitionLease, {
      requireExclusive: true,
    });
    await cleanup(existingTransitionLease);
    return;
  }
  await withWorkspaceIdentityTransition(cleanup);
}

export async function leaveEmptyTemporaryWorkspace(): Promise<void> {
  await withWorkspaceIdentityTransition((lease) =>
    withWorkspaceMutation(async () => {
      await flushLocalPersistence();
      const workspace = await requireActiveTemporaryWorkspace();
      const [annotation, productivity, states, cloudPapers, migration, provenance] =
        await Promise.all([
          inspectAnnotationStorageFootprintStrict(),
          inspectProductivityStorageFootprintStrict(),
          loadPaperSyncStates(),
          loadCloudPaperCatalog(),
          loadLayoutMigrationRecord(),
          loadTemporarySessionProvenance(),
        ]);
      const occupied =
        annotation.documentIds.length > 0 ||
        annotation.pdfDocumentIds.length > 0 ||
        annotation.collectionIds.length > 0 ||
        productivity.printDraftIds.length > 0 ||
        productivity.conversationIds.length > 0 ||
        states.length > 0 ||
        cloudPapers.length > 0 ||
        migration !== null ||
        provenance !== null;
      if (occupied) {
        throw new Error(
          'Finish on this device before returning to the personal workspace.',
        );
      }
      clearTemporaryAiStorage();
      await Promise.all([
        closeAnnotationPersistenceWorkspace(),
        closeProductivityPersistenceWorkspace(),
        closeSyncPersistenceWorkspace(),
      ]);
      await deleteTemporaryWorkspaceDatabases(workspace);
      await completeTemporaryWorkspace(workspace);
    }, lease),
  );
}

export function createTemporaryCleanupPlan(
  provenance: Pick<TemporarySessionProvenance, 'documentIds' | 'collectionIds'>,
): {
  documentIds: string[];
  collectionIds: string[];
} {
  return {
    documentIds: [...new Set(provenance.documentIds)].sort(),
    collectionIds: [...new Set(provenance.collectionIds)].sort(),
  };
}

function sortedUnion(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])].sort();
}
