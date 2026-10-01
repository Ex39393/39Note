import { clearTemporaryAiStorage } from '../ai/configuration.ts';
import {
  closeAnnotationPersistenceWorkspace,
  inspectAnnotationStorageFootprintStrict,
} from '../services/annotationPersistence.ts';
import {
  closeProductivityPersistenceWorkspace,
  inspectProductivityStorageFootprintStrict,
} from '../services/productivityPersistence.ts';
import { flushLocalPersistence } from '../services/persistentChange.ts';
import {
  completeTemporaryWorkspace,
  deleteTemporaryWorkspaceDatabases,
  requireActiveTemporaryWorkspace,
} from '../services/temporaryWorkspace.ts';
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
  tagCount: number;
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
  if (typeof indexedDB === 'undefined' || typeof sessionStorage === 'undefined') {
    return {
      safe: false,
      reason: 'This browser cannot create an isolated temporary 39Note workspace.',
    };
  }
  return { safe: true };
}

export async function beginTemporaryProvenance(
  accountId: string,
  rootFolderId?: string,
): Promise<TemporarySessionProvenance> {
  const workspace = await requireActiveTemporaryWorkspace();
  const existing = await loadTemporarySessionProvenance();
  if (existing) {
    if (
      existing.accountId !== accountId ||
      existing.temporarySessionId !== workspace.id
    ) {
      throw new Error(
        'Temporary data belongs to a different Google-backed 39Note account.',
      );
    }
    if (rootFolderId && !existing.rootFolderId) {
      const updated = { ...existing, rootFolderId };
      await saveTemporarySessionProvenance(updated);
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
    tagIds: [],
    finishPhase: 'active',
  };
  await saveTemporarySessionProvenance(provenance);
  return provenance;
}

export async function recordTemporaryPaperIds(
  documentIds: readonly string[],
  collectionIds: readonly string[] = [],
  tagIds: readonly string[] = [],
): Promise<void> {
  const provenance = await loadTemporarySessionProvenance();
  if (!provenance) throw new Error('Temporary-session provenance is unavailable.');
  await saveTemporarySessionProvenance({
    ...provenance,
    documentIds: sortedUnion(provenance.documentIds, documentIds),
    collectionIds: sortedUnion(provenance.collectionIds, collectionIds),
    tagIds: sortedUnion(provenance.tagIds, tagIds),
  });
}

export async function setTemporaryFinishPhase(
  finishPhase: TemporarySessionProvenance['finishPhase'],
): Promise<void> {
  const provenance = await loadTemporarySessionProvenance();
  if (!provenance) throw new Error('Temporary-session provenance is unavailable.');
  await saveTemporarySessionProvenance({ ...provenance, finishPhase });
}

/** Strict, provenance-only cleanup. Revocation must be awaited before this call. */
export async function cleanupTemporaryOrigin(): Promise<void> {
  const workspace = await requireActiveTemporaryWorkspace();
  const provenance = await loadTemporarySessionProvenance();
  if (!provenance) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  if (workspace.id !== provenance.temporarySessionId) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  await flushLocalPersistence();
  await setTemporaryFinishPhase('cleaning');
  try {
    clearTemporaryAiStorage();
    await clearTemporarySessionProvenance();
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
      await saveTemporarySessionProvenance({
        ...provenance,
        finishPhase: 'cleanup-incomplete',
      });
    } catch {
      // The registered workspace remains active, so a later retry still fails closed.
    }
    throw error;
  }
}

export async function leaveEmptyTemporaryWorkspace(): Promise<void> {
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
    annotation.tagIds.length > 0 ||
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
}

export function createTemporaryCleanupPlan(
  provenance: Pick<
    TemporarySessionProvenance,
    'documentIds' | 'collectionIds' | 'tagIds'
  >,
): {
  documentIds: string[];
  collectionIds: string[];
  tagIds: string[];
} {
  return {
    documentIds: [...new Set(provenance.documentIds)].sort(),
    collectionIds: [...new Set(provenance.collectionIds)].sort(),
    tagIds: [...new Set(provenance.tagIds)].sort(),
  };
}

function sortedUnion(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])].sort();
}
