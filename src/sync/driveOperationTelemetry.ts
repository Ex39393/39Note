import type { DriveRequestTelemetryEvent } from './driveClient.ts';
import type { PaperSyncStatus } from './paperTypes.ts';

export type DriveSyncOperationType =
  | 'download'
  | 'keep-local'
  | 'remove'
  | 'restore'
  | 'upload'
  | 'scan'
  | 'migration'
  | 'housekeeping'
  | 'other';

export interface DriveOperationTelemetrySnapshot {
  operationId: string;
  operationType: DriveSyncOperationType;
  startedAtMs: number;
  endedAtMs: number;
  events: readonly DriveRequestTelemetryEvent[];
  phaseSpans: readonly DriveOperationPhaseSpan[];
  stateTransitions: readonly DriveOperationStateTransition[];
  /** Higher-level scoped retries in addition to individual HTTP retries. */
  operationRetryCount?: number;
}

export type DriveOperationTransitionName =
  | 'operation-owner-acquired'
  | 'operation-owner-released'
  | 'operation-issue-observed'
  | 'operation-retry-classified'
  | 'repository-remove-started'
  | 'repository-restore-started'
  | 'presence-resolved'
  | 'presence-upload-metadata-rejected'
  | 'removed-presence-published'
  | 'present-presence-published'
  | 'paper-folder-selected'
  | 'paper-folder-trashed'
  | 'paper-folder-untrashed'
  | 'paper-package-verified'
  | 'cleanup-deferred'
  | 'paper-state-updated'
  | 'paper-issue-created'
  | 'paper-issue-cleared'
  | 'local-removal-commit-observed'
  | 'stale-local-snapshot-discarded'
  | 'stale-local-application-discarded'
  | 'changes-invalidation-classified'
  | 'discovery-state-applied';

/**
 * Redacted domain-level trace for one serialized operation. `paperCorrelationId`
 * is an opaque DriveClient-session identity (paper-1, paper-2, …), which lets a
 * mutation and its later discovery trace be joined without retaining the
 * durable document identity in either diagnostic snapshot.
 */
export interface DriveOperationStateTransition {
  relativeTimeMs: number;
  phase: string;
  transition: DriveOperationTransitionName;
  paperCorrelationId?: string;
  previousPaperState?: PaperSyncStatus;
  nextPaperState?: PaperSyncStatus;
  issueCode?: string;
  presenceState?: 'missing' | 'present' | 'removed';
  folderIdentity?: 'missing' | 'mismatch' | 'selected-active' | 'selected-trashed';
  outcome?: 'started' | 'succeeded' | 'failed' | 'deferred';
  classification?: string;
}

export interface DriveOperationPhaseSpan {
  phase: string;
  relativeStartMs: number;
  relativeEndMs: number;
  elapsedMs: number;
  /** Session-scoped opaque identity. The durable documentId is never retained. */
  paperCorrelationId?: string;
  bytesProcessed?: number;
}

export interface DriveOperationPhaseSummary {
  phase: string;
  elapsedMs: number;
  requestCount: number;
  bytesTransferred: number;
  retryCount: number;
}

export interface DriveOperationDiagnosticSummary {
  operationId: string;
  operationType: DriveSyncOperationType;
  elapsedMs: number;
  requestCount: number;
  maximumSequentialDependencyDepth: number;
  parallelWaves: number;
  bytesTransferred: number;
  retryCount: number;
  phases: readonly DriveOperationPhaseSummary[];
  stateTransitions: readonly DriveOperationStateTransition[];
}

export interface DriveRequestDagNode {
  id: string;
  requestCategory: string;
  dependencies?: readonly string[];
}

export interface DriveRequestDagScheduleEntry {
  id: string;
  requestCategory: string;
  wave: number;
  startMs: number;
  endMs: number;
}

export interface DriveRequestDagEstimate {
  requestCount: number;
  maximumSequentialDependencyDepth: number;
  parallelWaves: number;
  estimatedCriticalPathLatencyMs: number;
  schedule: readonly DriveRequestDagScheduleEntry[];
}

const MAX_RETAINED_DIAGNOSTIC_TRANSITIONS = 256;

function boundedDiagnosticTransitions(
  transitions: readonly DriveOperationStateTransition[],
): readonly DriveOperationStateTransition[] {
  if (transitions.length <= MAX_RETAINED_DIAGNOSTIC_TRANSITIONS) {
    return [...transitions];
  }
  const edgeCount = MAX_RETAINED_DIAGNOSTIC_TRANSITIONS / 2;
  return [...transitions.slice(0, edgeCount), ...transitions.slice(-edgeCount)];
}

export function summarizeDriveOperationTelemetry(
  snapshot: DriveOperationTelemetrySnapshot,
): DriveOperationDiagnosticSummary {
  const phases = new Map<
    string,
    {
      start: number;
      end: number;
      requestCount: number;
      bytesTransferred: number;
      retryCount: number;
    }
  >();
  let bytesTransferred = 0;
  let retryCount = snapshot.operationRetryCount ?? 0;
  const waves = new Set<number>();
  for (const event of snapshot.events) {
    const phase = event.phase ?? 'uncategorized';
    const start = event.relativeStartMs ?? 0;
    const end = event.relativeEndMs ?? start + event.elapsedMs;
    const current = phases.get(phase);
    phases.set(phase, {
      start: Math.min(current?.start ?? start, start),
      end: Math.max(current?.end ?? end, end),
      requestCount: (current?.requestCount ?? 0) + 1,
      bytesTransferred:
        (current?.bytesTransferred ?? 0) + (event.bytesTransferred ?? 0),
      retryCount: (current?.retryCount ?? 0) + Number(event.retryCount > 0),
    });
    bytesTransferred += event.bytesTransferred ?? 0;
    retryCount += Number(event.retryCount > 0);
    if (event.parallelWave !== undefined) waves.add(event.parallelWave);
  }
  for (const span of snapshot.phaseSpans) {
    const current = phases.get(span.phase);
    phases.set(span.phase, {
      start: Math.min(current?.start ?? span.relativeStartMs, span.relativeStartMs),
      end: Math.max(current?.end ?? span.relativeEndMs, span.relativeEndMs),
      requestCount: current?.requestCount ?? 0,
      bytesTransferred: current?.bytesTransferred ?? 0,
      retryCount: current?.retryCount ?? 0,
    });
  }
  const maximumSequentialDependencyDepth = waves.size
    ? Math.max(...waves)
    : snapshot.events.length > 0
      ? 1
      : 0;
  return {
    operationId: snapshot.operationId,
    operationType: snapshot.operationType,
    elapsedMs: Math.max(0, snapshot.endedAtMs - snapshot.startedAtMs),
    requestCount: snapshot.events.length,
    maximumSequentialDependencyDepth,
    parallelWaves: waves.size,
    bytesTransferred,
    retryCount,
    // Retain the beginning (where ownership/root cause is established) and the
    // end (where settlement is recorded) without allowing diagnostic history
    // to grow with an unbounded paper batch.
    stateTransitions: boundedDiagnosticTransitions(snapshot.stateTransitions),
    phases: [...phases.entries()]
      .map(([phase, value]) => ({
        phase,
        elapsedMs: Math.max(0, value.end - value.start),
        requestCount: value.requestCount,
        bytesTransferred: value.bytesTransferred,
        retryCount: value.retryCount,
      }))
      .sort((first, second) => first.phase.localeCompare(second.phase)),
  };
}

export function formatDriveOperationDiagnostic(
  summary: DriveOperationDiagnosticSummary,
): string {
  const title =
    summary.operationType === 'keep-local'
      ? 'Keep local'
      : `${summary.operationType[0]?.toLocaleUpperCase() ?? ''}${summary.operationType.slice(1)}`;
  const phaseLines = summary.phases.map(
    ({ phase, elapsedMs }) => `${phase.padEnd(24)} ${Math.round(elapsedMs)} ms`,
  );
  const transitionLines = summary.stateTransitions.map((event) => {
    const stateChange =
      event.previousPaperState || event.nextPaperState
        ? ` ${event.previousPaperState ?? 'unknown'} -> ${event.nextPaperState ?? 'unknown'}`
        : '';
    const details = [
      event.paperCorrelationId,
      event.presenceState ? `presence=${event.presenceState}` : undefined,
      event.folderIdentity ? `folder=${event.folderIdentity}` : undefined,
      event.issueCode ? `issue=${event.issueCode}` : undefined,
      event.classification ? `class=${event.classification}` : undefined,
      event.outcome ? `outcome=${event.outcome}` : undefined,
    ].filter((value): value is string => Boolean(value));
    return `trace +${Math.round(event.relativeTimeMs)} ms ${event.phase}/${event.transition}${stateChange}${details.length ? ` (${details.join(', ')})` : ''}`;
  });
  return [
    `${title} paper:`,
    ...phaseLines,
    ...transitionLines,
    `total${' '.repeat(19)} ${Math.round(summary.elapsedMs)} ms`,
    `requests ${summary.requestCount} · waves ${summary.parallelWaves} · retries ${summary.retryCount} · bytes ${summary.bytesTransferred}`,
  ].join('\n');
}

/**
 * Evaluates a request dependency graph with deterministic virtual latency. No
 * timers or network calls are used, so latency regressions stay fast in CI.
 */
export function estimateDriveRequestDag(
  nodes: readonly DriveRequestDagNode[],
  latencyMs: number | Readonly<Record<string, number>>,
): DriveRequestDagEstimate {
  const byId = new Map<string, DriveRequestDagNode>();
  for (const node of nodes) {
    if (!node.id || byId.has(node.id)) {
      throw new Error('Drive request DAG node identities must be unique.');
    }
    byId.set(node.id, node);
  }
  const visiting = new Set<string>();
  const schedule = new Map<string, DriveRequestDagScheduleEntry>();
  const visit = (id: string): DriveRequestDagScheduleEntry => {
    const existing = schedule.get(id);
    if (existing) return existing;
    const node = byId.get(id);
    if (!node) throw new Error(`Drive request DAG dependency is missing: ${id}`);
    if (visiting.has(id)) throw new Error('Drive request DAG contains a cycle.');
    visiting.add(id);
    const dependencies = (node.dependencies ?? []).map(visit);
    const duration =
      typeof latencyMs === 'number'
        ? latencyMs
        : (latencyMs[node.requestCategory] ?? 0);
    if (!Number.isFinite(duration) || duration < 0) {
      throw new Error('Drive request latency must be a finite non-negative number.');
    }
    const entry: DriveRequestDagScheduleEntry = {
      id,
      requestCategory: node.requestCategory,
      wave: dependencies.length
        ? Math.max(...dependencies.map(({ wave }) => wave)) + 1
        : 1,
      startMs: dependencies.length
        ? Math.max(...dependencies.map(({ endMs }) => endMs))
        : 0,
      endMs:
        (dependencies.length
          ? Math.max(...dependencies.map(({ endMs }) => endMs))
          : 0) + duration,
    };
    visiting.delete(id);
    schedule.set(id, entry);
    return entry;
  };
  for (const node of nodes) visit(node.id);
  const ordered = nodes.map(({ id }) => schedule.get(id)!);
  const depth = ordered.length ? Math.max(...ordered.map(({ wave }) => wave)) : 0;
  return {
    requestCount: nodes.length,
    maximumSequentialDependencyDepth: depth,
    parallelWaves: new Set(ordered.map(({ wave }) => wave)).size,
    estimatedCriticalPathLatencyMs: ordered.length
      ? Math.max(...ordered.map(({ endMs }) => endMs))
      : 0,
    schedule: ordered,
  };
}
