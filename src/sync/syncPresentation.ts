import type { SyncOperationalIssue } from './errorModel.ts';
import type {
  PaperConnectionStatus,
  PaperSyncUiStatus,
  PaperSyncViewState,
} from './paperCoordinator.ts';
import type {
  PaperCloudSummary,
  PaperSyncState,
  PaperSyncStatus,
} from './paperTypes.ts';

export type SyncSemanticTone = 'success' | 'neutral' | 'warning' | 'danger';

export interface PaperStatusPresentation {
  status: PaperSyncStatus;
  issue?: {
    key: 'needs-attention';
    label: 'Needs attention';
    code?: string;
    message?: string;
  };
}

const WARNING_ACTION_CODES = new Set([
  'authorization-cancelled',
  'authorization-failed',
  'google-authorization-required',
  'sync-not-configured',
]);

const ALWAYS_DANGEROUS_CODES = new Set([
  'ambiguous-paper-folder',
  'drive-data-missing',
  'drive-integrity-mismatch',
  'drive-root-ambiguous',
  'drive-root-invalid',
  'drive-root-missing',
  'layout-migration-incomplete',
  'layout-migration-proof-invalid',
  'layout-upgrade-failed',
  'layout-upgrade-required',
  'local-persistence-failed',
  'paper-integrity-failed',
  'paper-logical-partition-invalid',
  'paper-source-pdf-conflict',
  'reset-incomplete',
]);

const DANGEROUS_CONNECTIONS = new Set<PaperConnectionStatus>([
  'root-selection-required',
  'root-unavailable',
  'layout-upgrade-required',
  'migration-incomplete',
]);

/**
 * Collapses the local state and cloud summary for one document into a single
 * status/issue presentation. The two records frequently describe the same
 * attention episode, so they must not independently create UI indicators.
 */
export function getPaperStatusPresentation(
  cloudPaper: Pick<PaperCloudSummary, 'status' | 'issue'> | undefined,
  localPaper: Pick<PaperSyncState, 'status'> | undefined,
): PaperStatusPresentation {
  const statuses = [localPaper?.status, cloudPaper?.status];
  const activeStatus = statuses.find(
    (status): status is 'downloading' | 'uploading' =>
      status === 'downloading' || status === 'uploading',
  );
  const hasAttention =
    statuses.includes('needs-attention') || cloudPaper?.issue !== undefined;
  const status =
    activeStatus ??
    (hasAttention
      ? 'needs-attention'
      : (localPaper?.status ?? cloudPaper?.status ?? 'cloud-only'));
  if (!hasAttention) return { status };

  const rawMessage = cloudPaper?.issue?.message.trim();
  const normalizedMessage = rawMessage
    ?.toLocaleLowerCase()
    .replace(/[.!]+$/u, '')
    .trim();
  const message =
    normalizedMessage === 'needs attention' ||
    normalizedMessage === 'this paper needs attention'
      ? undefined
      : rawMessage;
  return {
    status,
    issue: {
      key: 'needs-attention',
      label: 'Needs attention',
      ...(cloudPaper?.issue?.code ? { code: cloudPaper.issue.code } : {}),
      ...(message ? { message } : {}),
    },
  };
}

/**
 * Maps operational state to the four visual meanings shared by every sync UI.
 * This is presentation only: it never changes retry or fail-closed behavior.
 */
export function syncToneForView(
  state: Pick<PaperSyncViewState, 'connection' | 'issue' | 'papers'>,
  status: PaperSyncUiStatus,
): SyncSemanticTone {
  if (status === 'synced') return 'success';
  if (status === 'pending' || status === 'offline') return 'warning';
  if (state.connection === 'reconnect-required') return 'warning';
  if (DANGEROUS_CONNECTIONS.has(state.connection)) return 'danger';
  if (status !== 'attention') return 'neutral';

  if (state.issue) return syncToneForIssue(state.issue);
  const paperIssue = state.papers.find((paper) => paper.status === 'needs-attention')
    ?.issue?.code;
  return paperIssue ? syncToneForPaper('needs-attention', paperIssue) : 'warning';
}

export function syncToneForIssue(
  issue: Pick<SyncOperationalIssue, 'code' | 'severity' | 'blocksOrdinarySync'>,
): SyncSemanticTone {
  if (WARNING_ACTION_CODES.has(issue.code)) return 'warning';
  if (ALWAYS_DANGEROUS_CODES.has(issue.code)) return 'danger';
  if (
    issue.severity === 'critical' ||
    (issue.severity === 'error' && issue.blocksOrdinarySync)
  ) {
    return 'danger';
  }
  return 'warning';
}

export function syncToneForPaper(
  status: PaperSyncStatus,
  issueCode?: string,
): SyncSemanticTone {
  switch (status) {
    case 'synced':
      return 'success';
    case 'local-only':
    case 'local-changes':
    case 'remote-update-available':
    case 'both-changed':
      return 'warning';
    case 'cloud-only':
    case 'downloading':
    case 'uploading':
      return 'neutral';
    case 'needs-attention':
      // Unknown paper blocks fail closed, so an unknown code also uses danger.
      return !issueCode || ALWAYS_DANGEROUS_CODES.has(issueCode) ? 'danger' : 'warning';
  }
}

export function syncToneClass(tone: SyncSemanticTone): string {
  return `sync-tone-${tone}`;
}
