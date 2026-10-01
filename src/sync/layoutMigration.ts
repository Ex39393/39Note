export type LayoutMigrationFailurePhase =
  | 'initialize'
  | 'ensure-repository'
  | 'detect-layout'
  | 'reconcile-local-state'
  | 'list-local-papers'
  | 'load-migration-record'
  | 'begin-operation'
  | 'save-migration-record'
  | 'create-paper-package'
  | 'publish-paper'
  | 'save-paper-state'
  | 'verify-publications'
  | 'activate-layout'
  | 'clear-migration-record'
  | 'post-migration-scan';

export interface LayoutMigrationFailure {
  code: 'layout-upgrade-failed';
  message: 'Drive layout upgrade failed.';
  phase: LayoutMigrationFailurePhase;
  causeCode: string;
  recommendedAction: 'retry-layout-upgrade' | 'retry-now' | 'reconnect' | 'details';
  retrySafe: boolean;
  blocksOrdinarySync: true;
  documentId?: string;
  paperName?: string;
}

export function createLayoutMigrationFailure(
  phase: LayoutMigrationFailurePhase,
  causeCode: string,
  paper?: { documentId: string; paperName: string },
  recovery: {
    recommendedAction: LayoutMigrationFailure['recommendedAction'];
    retrySafe: boolean;
  } = { recommendedAction: 'retry-layout-upgrade', retrySafe: true },
): LayoutMigrationFailure {
  const safeCauseCode = /^[a-z0-9-]{1,80}$/u.test(causeCode)
    ? causeCode
    : 'unexpected-sync-failure';
  const documentId = paper
    ? replaceControlCharacters(paper.documentId, '').slice(0, 512)
    : undefined;
  const paperName = paper
    ? replaceControlCharacters(paper.paperName, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 180)
    : undefined;
  return Object.freeze({
    code: 'layout-upgrade-failed',
    message: 'Drive layout upgrade failed.',
    phase,
    causeCode: safeCauseCode,
    recommendedAction: recovery.recommendedAction,
    retrySafe: recovery.retrySafe,
    blocksOrdinarySync: true,
    ...(paper
      ? {
          documentId: documentId || 'unknown-paper',
          paperName: paperName || 'Untitled Paper',
        }
      : {}),
  });
}

export class LayoutMigrationFailedError extends Error {
  readonly code = 'layout-upgrade-failed' as const;

  constructor(readonly failure: LayoutMigrationFailure) {
    super(failure.message);
    this.name = 'LayoutMigrationFailedError';
  }
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value)
    .map((character) =>
      (character.codePointAt(0) ?? 0) <= 0x1f ? replacement : character,
    )
    .join('');
}
