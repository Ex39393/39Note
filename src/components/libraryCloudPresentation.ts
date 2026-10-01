import type { PaperCloudSummary, PaperSyncState } from '../sync/paperTypes.ts';
import { getPaperStatusPresentation } from '../sync/syncPresentation.ts';

export interface LibraryPaperDrivePresentation {
  primaryStatus: string;
  secondaryStatuses: Array<{
    key: 'removed-from-drive' | 'drive-cleanup-pending';
    label: string;
  }>;
  issue?: {
    key: 'needs-attention';
    label: 'Needs attention';
    code?: string;
    message?: string;
  };
  removedFromDrive: boolean;
  hasCloudCopy: boolean;
  needsAttention: boolean;
  action: 'upload' | 'remove' | 'restore';
}

export interface LibraryPaperDriveStatusIndicator {
  key: string;
  label: string;
  primary: boolean;
}

export type LibraryBulkDriveRemovalSkipReason =
  | 'cloud-removal-disabled'
  | 'needs-attention'
  | 'not-cloud-present'
  | 'removed'
  | 'transfer-active';

export interface LibraryBulkDriveRemovalCandidate {
  documentId: string;
  displayName: string;
  hasLocalCopy: boolean;
  cloudPaper?: PaperCloudSummary;
  syncPaper?: PaperSyncState;
}

export interface LibraryBulkDriveRemovalSkippedCandidate extends LibraryBulkDriveRemovalCandidate {
  reason: LibraryBulkDriveRemovalSkipReason;
}

export interface LibraryBulkDriveRemovalPlan {
  eligible: LibraryBulkDriveRemovalCandidate[];
  skipped: LibraryBulkDriveRemovalSkippedCandidate[];
}

export interface LibraryBulkDriveRemovalProgress {
  completed: number;
  total: number;
}

export interface LibraryBulkDriveRemovalResult {
  removed: string[];
  alreadyRemoved: string[];
  cleanupPending: Array<{ documentId: string; message?: string }>;
  failed: Array<{ documentId: string; message: string }>;
}

/**
 * Starts durable work and dismisses its decision UI without waiting for the
 * returned operation to settle. Keeping this handoff synchronous makes the
 * interaction contract independently testable with a deferred Promise.
 */
export function startLibraryBackgroundOperation<T>(
  start: () => Promise<T>,
  dismissDecisionUi: () => void,
): Promise<T> {
  const operation = start();
  dismissDecisionUi();
  return operation;
}

/**
 * Builds the Drive-specific portion of one local Library row. Stable
 * documentId identity comes from the caller's map; filenames are presentation
 * only and never participate in this decision.
 */
export function getLibraryPaperDrivePresentation(
  cloudPaper: PaperCloudSummary | undefined,
  syncPaper: PaperSyncState | undefined,
): LibraryPaperDrivePresentation {
  const removedFromDrive =
    syncPaper?.cloudPresence === 'removed' || cloudPaper?.presenceState === 'removed';
  const hasCloudCopy =
    !removedFromDrive &&
    (syncPaper?.cloudPresence === 'present' ||
      cloudPaper?.presenceState === 'present' ||
      Boolean(syncPaper?.remoteHeadIds.length));
  const paperStatus = getPaperStatusPresentation(cloudPaper, syncPaper);
  const needsAttention = paperStatus.issue !== undefined;
  const issue = paperStatus.issue;
  const secondaryStatuses: LibraryPaperDrivePresentation['secondaryStatuses'] = [];
  if (removedFromDrive) {
    secondaryStatuses.push({
      key: 'removed-from-drive',
      label: 'Removed from Drive',
    });
  }
  if (syncPaper?.cloudCleanupPending || cloudPaper?.cleanupPending) {
    secondaryStatuses.push({
      key: 'drive-cleanup-pending',
      label: 'Drive cleanup pending',
    });
  }
  return {
    primaryStatus:
      paperStatus.status === 'downloading' || paperStatus.status === 'uploading'
        ? paperSyncStatusLabel(paperStatus.status)
        : (issue?.label ??
          (removedFromDrive
            ? 'Local only'
            : syncPaper
              ? paperSyncStatusLabel(paperStatus.status)
              : cloudPaper?.localAvailability === 'cloud-only' ||
                  paperStatus.status === 'cloud-only'
                ? 'Cloud only'
                : hasCloudCopy
                  ? 'Synced'
                  : 'Local only')),
    secondaryStatuses,
    issue,
    removedFromDrive,
    hasCloudCopy,
    needsAttention,
    action: removedFromDrive ? 'restore' : hasCloudCopy ? 'remove' : 'upload',
  };
}

/**
 * Produces the exact semantic status indicators rendered for one Library row.
 * A progress label may take the primary slot, but an existing issue is added at
 * most once and distinct removal/cleanup states retain their own labels.
 */
export function getLibraryPaperDriveStatusIndicators(
  presentation: LibraryPaperDrivePresentation,
  operationStatus?: string,
): LibraryPaperDriveStatusIndicator[] {
  const primaryLabel = operationStatus ?? presentation.primaryStatus;
  const indicators: LibraryPaperDriveStatusIndicator[] = [
    {
      key: operationStatus ? 'operation-progress' : 'primary',
      label: primaryLabel,
      primary: true,
    },
  ];
  if (presentation.issue && presentation.issue.label !== primaryLabel) {
    indicators.push({
      key: presentation.issue.key,
      label: presentation.issue.label,
      primary: false,
    });
  }
  for (const status of presentation.secondaryStatuses) {
    if (
      !indicators.some(({ key, label }) => key === status.key || label === status.label)
    ) {
      indicators.push({ ...status, primary: false });
    }
  }
  return indicators;
}

/**
 * Plans a destructive cloud action from stable document identities only. A
 * cached manifest head by itself is intentionally insufficient: bulk removal
 * requires an explicit, verified v3 `present` presence state and revalidates it
 * again in the coordinator before mutation.
 */
export function planLibraryBulkDriveRemoval(
  selectedDocumentIds: readonly string[],
  candidates: readonly LibraryBulkDriveRemovalCandidate[],
  deviceMode: 'personal' | 'temporary',
): LibraryBulkDriveRemovalPlan {
  const byDocumentId = new Map(
    candidates.map((candidate) => [candidate.documentId, candidate]),
  );
  const eligible: LibraryBulkDriveRemovalCandidate[] = [];
  const skipped: LibraryBulkDriveRemovalSkippedCandidate[] = [];

  for (const documentId of [...new Set(selectedDocumentIds)]) {
    const candidate = byDocumentId.get(documentId);
    if (!candidate) {
      skipped.push({
        documentId,
        displayName: 'Unavailable paper',
        hasLocalCopy: false,
        reason: 'not-cloud-present',
      });
      continue;
    }
    const { cloudPaper, syncPaper } = candidate;
    const removed =
      syncPaper?.cloudPresence === 'removed' || cloudPaper?.presenceState === 'removed';
    const explicitlyPresent =
      !removed &&
      (syncPaper?.cloudPresence === 'present' ||
        cloudPaper?.presenceState === 'present');
    const needsAttention =
      syncPaper?.status === 'needs-attention' ||
      cloudPaper?.status === 'needs-attention';
    const transferActive =
      syncPaper?.status === 'uploading' || syncPaper?.status === 'downloading';
    let reason: LibraryBulkDriveRemovalSkipReason | undefined;
    if (removed) reason = 'removed';
    else if (deviceMode !== 'personal') reason = 'cloud-removal-disabled';
    else if (needsAttention) reason = 'needs-attention';
    else if (transferActive) reason = 'transfer-active';
    else if (!explicitlyPresent) reason = 'not-cloud-present';

    if (reason) skipped.push({ ...candidate, reason });
    else eligible.push(candidate);
  }
  return { eligible, skipped };
}

/** Keeps UI progress truthful if concurrent completions arrive out of order. */
export function mergeLibraryBulkDriveRemovalProgress(
  current: LibraryBulkDriveRemovalProgress | null,
  incoming: LibraryBulkDriveRemovalProgress,
): LibraryBulkDriveRemovalProgress {
  const total = Math.max(0, current?.total ?? incoming.total, incoming.total);
  return {
    completed: Math.min(
      total,
      Math.max(0, current?.completed ?? 0, incoming.completed),
    ),
    total,
  };
}

export function summarizeLibraryBulkDriveRemoval(
  result: LibraryBulkDriveRemovalResult,
): string {
  const parts = [`${result.removed.length} removed`];
  if (result.alreadyRemoved.length > 0) {
    parts.push(`${result.alreadyRemoved.length} already removed`);
  }
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  return parts.join(' · ');
}

/** Returns metadata-only cloud rows after deduplicating strictly by documentId. */
export function selectCloudOnlyLibraryPapers(
  papers: readonly PaperCloudSummary[],
  localDocumentIds: ReadonlySet<string>,
  options: {
    includeCloudOnly: boolean;
    query: string;
  },
): PaperCloudSummary[] {
  if (!options.includeCloudOnly) return [];
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  const unique = new Map<string, PaperCloudSummary>();
  for (const paper of papers) {
    if (
      paper.deleted ||
      paper.presenceState === 'removed' ||
      localDocumentIds.has(paper.documentId) ||
      (normalizedQuery &&
        !paper.displayName.toLocaleLowerCase().includes(normalizedQuery))
    ) {
      continue;
    }
    const previous = unique.get(paper.documentId);
    if (!previous || (!previous.issue && paper.issue)) {
      unique.set(paper.documentId, paper);
    }
  }
  return [...unique.values()].sort(
    (first, second) =>
      first.displayName.localeCompare(second.displayName) ||
      first.documentId.localeCompare(second.documentId),
  );
}

export function paperSyncStatusLabel(status: PaperSyncState['status']): string {
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
      return 'Remote update';
    case 'both-changed':
      return 'Both changed';
    case 'uploading':
      return 'Uploading';
    case 'downloading':
      return 'Downloading';
    case 'needs-attention':
      return 'Needs attention';
  }
}
