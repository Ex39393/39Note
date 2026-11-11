import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type { SyncOperationalIssue } from '../src/sync/errorModel.ts';
import type {
  PaperActiveOperationType,
  PaperRetryOperation,
  PaperSyncViewState,
} from '../src/sync/paperCoordinator.ts';
import type { PaperCloudSummary, PaperSyncState } from '../src/sync/paperTypes.ts';

let server: ViteDevServer;
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let selectPaperRetryAction: (typeof import('../src/sync/paperCoordinator.ts'))['selectPaperRetryAction'];
let mergeScopedPaperDiscoveryCatalog: (typeof import('../src/sync/paperCoordinator.ts'))['mergeScopedPaperDiscoveryCatalog'];
let hasVerifiedPresenceRecovery: (typeof import('../src/sync/paperCoordinator.ts'))['hasVerifiedPresenceRecovery'];
let canRunPaperSyncStatusReadOnlyInspection: (typeof import('../src/sync/paperCoordinator.ts'))['canRunPaperSyncStatusReadOnlyInspection'];
let PaperRepositoryError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperRepositoryError'];

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const [module, repository] = await Promise.all([
    server.ssrLoadModule('/src/sync/paperCoordinator.ts') as Promise<
      typeof import('../src/sync/paperCoordinator.ts')
    >,
    server.ssrLoadModule('/src/sync/paperDriveRepository.ts') as Promise<
      typeof import('../src/sync/paperDriveRepository.ts')
    >,
  ]);
  PaperGoogleDriveSyncCoordinator = module.PaperGoogleDriveSyncCoordinator;
  selectPaperRetryAction = module.selectPaperRetryAction;
  mergeScopedPaperDiscoveryCatalog = module.mergeScopedPaperDiscoveryCatalog;
  hasVerifiedPresenceRecovery = module.hasVerifiedPresenceRecovery;
  canRunPaperSyncStatusReadOnlyInspection =
    module.canRunPaperSyncStatusReadOnlyInspection;
  PaperRepositoryError = repository.PaperRepositoryError;
});

after(async () => {
  await server?.close();
});

test('production read-only diagnostics admit only an exact verified Browse-row scope', () => {
  assert.equal(canRunPaperSyncStatusReadOnlyInspection(false, false), false);
  assert.equal(canRunPaperSyncStatusReadOnlyInspection(false, true), true);
  assert.equal(canRunPaperSyncStatusReadOnlyInspection(true, false), true);
});

interface BlockingPaperIssue {
  headSetId?: string;
  issue: SyncOperationalIssue;
}

interface RetryHarness {
  view: PaperSyncViewState;
  paperStates: Map<string, PaperSyncState>;
  blockingPaperIssues: Map<string, BlockingPaperIssue>;
  paperRetryIntents: Map<string, PaperRetryOperation>;
  waitForLocalRemovalSettlement(): Promise<void>;
  revalidatePaperRetryTargets(documentIds: readonly string[]): Promise<void>;
  uploadSelected(documentIds: readonly string[]): Promise<void>;
  downloadSelected(documentIds: readonly string[]): Promise<void>;
  removeFromGoogleDriveSelected(documentIds: readonly string[]): Promise<{
    cleanupPending: Array<{ documentId: string }>;
    failed: Array<{ documentId: string; message: string }>;
  }>;
  retainPaperOperation<T>(
    type: PaperActiveOperationType,
    documentIds: readonly string[],
    start: () => Promise<T>,
  ): Promise<T>;
}

function harness(
  state: PaperSyncState,
  issue: SyncOperationalIssue,
  intent: PaperRetryOperation,
): {
  coordinator: InstanceType<typeof PaperGoogleDriveSyncCoordinator>;
  internals: RetryHarness;
} {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  internals.paperStates = new Map([[state.documentId, state]]);
  internals.blockingPaperIssues = new Map([
    [state.documentId, { headSetId: 'head-a', issue }],
  ]);
  internals.paperRetryIntents = new Map([[state.documentId, intent]]);
  internals.view = viewState(state, issue);
  internals.waitForLocalRemovalSettlement = async () => undefined;
  return { coordinator, internals };
}

function paperState(overrides: Partial<PaperSyncState> = {}): PaperSyncState {
  return {
    documentId: 'paper-a',
    deviceId: 'device-a',
    availability: 'local-and-cloud',
    status: 'needs-attention',
    dirtyGeneration: 1,
    dirtyReasons: ['notes'],
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    incorporatedHeadIds: ['head-a'],
    remoteHeadIds: ['head-a'],
    pdfFingerprints: {},
    driveFiles: { fileIds: {} },
    cloudPresence: 'present',
    ...overrides,
  };
}

function cloudPaper(documentId: string, headId: string): PaperCloudSummary {
  return {
    documentId,
    displayName: `${documentId}.pdf`,
    deleted: false,
    paperFolderId: `folder-${documentId}`,
    headIds: [headId],
    headSetId: headId,
    localAvailability: 'local-and-cloud',
    status: 'synced',
    presenceState: 'present',
    presenceHeadIds: [`presence-${headId}`],
  };
}

function retryIssue(
  overrides: Partial<SyncOperationalIssue> = {},
): SyncOperationalIssue {
  return {
    code: 'drive-integrity-mismatch',
    message: 'The failed paper operation can be retried.',
    severity: 'error',
    state: 'attention',
    actions: ['retry-now', 'details'],
    retrySafe: true,
    blocksOrdinarySync: true,
    backupRecommended: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-upload',
      documentId: 'paper-a',
    },
    ...overrides,
  };
}

function viewState(
  state: PaperSyncState,
  issue: SyncOperationalIssue,
): PaperSyncViewState {
  return {
    connection: 'attention',
    backendConfigured: true,
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    papers: [],
    paperStates: [state],
    dirtyPaperIds: state.dirtyReasons.length ? [state.documentId] : [],
    sessions: [],
    rootChoices: [],
    progress: { phase: 'idle' },
    activePaperOperations: [],
    legacyHousekeeping: { status: 'idle' },
    folderNameMaintenance: { status: 'idle' },
    issue,
    error: issue.message,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('Retry classifies upload, download, cleanup, conflict, and removed state safely', () => {
  assert.equal(selectPaperRetryAction(paperState(), retryIssue(), 'upload'), 'upload');
  assert.equal(
    selectPaperRetryAction(
      paperState({
        availability: 'cloud-only',
        dirtyGeneration: 0,
        dirtyReasons: [],
        incorporatedHeadIds: [],
        remoteHeadIds: ['head-a'],
      }),
      retryIssue({ diagnostic: { source: 'google-drive', operation: 'download' } }),
      'download',
    ),
    'download',
  );
  assert.equal(
    selectPaperRetryAction(
      paperState({ cloudPresence: 'removed', cloudCleanupPending: true }),
      retryIssue(),
      'remove-cleanup',
    ),
    'remove-cleanup',
  );
  assert.equal(
    selectPaperRetryAction(
      paperState(),
      retryIssue({
        actions: ['details'],
        retrySafe: false,
        diagnostic: {
          source: 'google-drive',
          operation: 'paper-source-pdf-conflict',
          documentId: 'paper-a',
        },
      }),
      'upload',
    ),
    'revalidate',
  );
  assert.equal(
    selectPaperRetryAction(
      paperState({ cloudPresence: 'removed', cloudCleanupPending: false }),
      retryIssue(),
      'upload',
    ),
    'none',
  );
});

test('scoped Retry settlement preserves every unrelated catalog paper unchanged', () => {
  const target = cloudPaper('paper-a', 'head-a');
  const unrelated = cloudPaper('paper-b', 'head-b');
  const refreshedTarget = cloudPaper('paper-a', 'head-a-2');
  const incidentalUnrelated = cloudPaper('paper-b', 'unexpected-head');

  const merged = mergeScopedPaperDiscoveryCatalog(
    [target, unrelated],
    [refreshedTarget, incidentalUnrelated],
    ['paper-a'],
  );

  assert.equal(merged.length, 2);
  assert.equal(
    merged.find((paper) => paper.documentId === 'paper-a'),
    refreshedTarget,
  );
  assert.equal(
    merged.find((paper) => paper.documentId === 'paper-b'),
    unrelated,
  );
  assert.deepEqual(
    merged.map((paper) => [paper.documentId, paper.headSetId]),
    [
      ['paper-a', 'head-a-2'],
      ['paper-b', 'head-b'],
    ],
  );
});

test('healthy exact presence reread retires stale presence attention without requiring a package-head change', () => {
  const paper = cloudPaper('paper-a', 'head-a');
  const presenceIssue = retryIssue({
    message: 'Drive paper presence data needs verification.',
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });

  assert.equal(
    hasVerifiedPresenceRecovery(paper, presenceIssue, undefined),
    true,
    'the same package head is allowed because presence was independently verified',
  );
  assert.equal(
    hasVerifiedPresenceRecovery(paper, undefined, 'paper-presence-invalid'),
    true,
    'a persisted catalog presence issue is recoverable after reload',
  );
});

test('presence recovery remains fail-closed for ambiguous, missing, removed, or unrelated failures', () => {
  const healthy = cloudPaper('paper-a', 'head-a');
  const presenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const invalidPresence: PaperCloudSummary = {
    ...healthy,
    status: 'needs-attention',
    issue: {
      code: 'paper-presence-invalid',
      message: 'Drive data for this paper needs verification.',
    },
  };

  assert.equal(
    hasVerifiedPresenceRecovery(invalidPresence, presenceIssue, undefined),
    false,
  );
  assert.equal(
    hasVerifiedPresenceRecovery(
      { ...healthy, presenceHeadIds: [] },
      presenceIssue,
      undefined,
    ),
    false,
  );
  assert.equal(
    hasVerifiedPresenceRecovery(
      { ...healthy, presenceState: 'removed' },
      presenceIssue,
      undefined,
    ),
    false,
  );
  assert.equal(hasVerifiedPresenceRecovery(healthy, retryIssue(), undefined), false);
  assert.equal(
    hasVerifiedPresenceRecovery(
      healthy,
      retryIssue({
        actions: ['details'],
        retrySafe: false,
        diagnostic: {
          source: 'google-drive',
          operation: 'paper-source-pdf-conflict',
          documentId: 'paper-a',
        },
      }),
      'paper-presence-invalid',
    ),
    false,
    'a newer exact source conflict cannot be hidden by an older catalog issue',
  );
});

test('Retry clears a stale non-retryable presence block after a healthy exact reread with unchanged package heads', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    message: 'Drive paper presence data needs verification.',
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, presenceIssue, 'upload');
  const healthy = cloudPaper('paper-a', 'head-a');
  internals.view.papers = [
    {
      ...healthy,
      status: 'needs-attention',
      issue: {
        code: 'paper-presence-invalid',
        message: presenceIssue.message,
      },
    },
  ];
  let applied = false;
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => ({
    catalog: [healthy],
    scoped: { papers: [healthy], missingDocumentIds: [] },
  }));
  Reflect.set(internals, 'requireWorkspaceLease', () => ({}));
  Reflect.set(internals, 'endOperation', () => undefined);
  Reflect.set(
    internals,
    'applyDiscovery',
    async (papers: readonly PaperCloudSummary[]) => {
      applied = true;
      assert.equal(internals.blockingPaperIssues.has('paper-a'), false);
      assert.equal(state.status, 'local-changes');
      internals.view.papers = [...papers];
    },
  );
  let uploads = 0;
  internals.uploadSelected = async (documentIds) => {
    uploads += 1;
    assert.deepEqual(documentIds, ['paper-a']);
    state.dirtyReasons = [];
    state.status = 'synced';
    internals.paperRetryIntents.delete('paper-a');
  };

  await coordinator.retryNow();

  assert.equal(applied, true);
  assert.equal(uploads, 1);
  assert.equal(internals.blockingPaperIssues.has('paper-a'), false);
  assert.equal(state.status, 'synced');
  assert.equal(internals.view.issue, undefined);
  const diagnostic = coordinator.getLastPaperRetryDiagnostic();
  assert.ok(diagnostic);
  assert.equal(diagnostic.operation, 'paper-retry');
  assert.equal(diagnostic.phase, 'settled');
  assert.equal(diagnostic.targetCount, 1);
  assert.equal(diagnostic.targets[0]?.target, 'Paper 1');
  assert.equal(
    diagnostic.targets[0]?.admission.activeBlockingIssue?.operation,
    'paper-presence-invalid',
  );
  assert.equal(diagnostic.targets[0]?.repository?.result, 'verified');
  assert.equal(diagnostic.targets[0]?.repository?.status, 'synced');
  assert.equal(diagnostic.targets[0]?.repository?.presenceState, 'present');
  assert.equal(diagnostic.targets[0]?.repository?.packageHeadCount, 1);
  assert.equal(diagnostic.targets[0]?.repository?.presenceHeadCount, 1);
  assert.equal(diagnostic.targets[0]?.settlement?.blockDisposition, 'cleared');
  assert.equal(diagnostic.targets[0]?.settlement?.selectedAction, 'upload');
  assert.equal(diagnostic.targets[0]?.settlement?.finalStatus, 'synced');
  assert.equal(diagnostic.targets[0]?.settlement?.activeBlockingIssue, undefined);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /paper-a|device-a|folder-paper-a|paper-a\.pdf/u,
  );
});

test('Retry keeps presence blocked and refreshes its exact cause when the reread is still invalid', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    message: 'Drive paper presence data needs verification.',
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, presenceIssue, 'upload');
  const invalid: PaperCloudSummary = {
    ...cloudPaper('paper-a', 'head-a'),
    status: 'needs-attention',
    issue: {
      code: 'paper-presence-invalid',
      message: presenceIssue.message,
      phase: 'paper-presence-folder-resolution',
      causeCode: 'presence-folder-missing',
    },
  };
  internals.view.papers = [invalid];
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => ({
    catalog: [invalid],
    scoped: { papers: [invalid], missingDocumentIds: [] },
  }));
  Reflect.set(internals, 'requireWorkspaceLease', () => ({}));
  Reflect.set(internals, 'endOperation', () => undefined);
  Reflect.set(internals, 'applyDiscovery', async () => {
    assert.equal(internals.blockingPaperIssues.has('paper-a'), true);
    state.status = 'needs-attention';
  });
  let uploads = 0;
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await coordinator.retryNow();

  assert.equal(uploads, 0);
  assert.equal(internals.blockingPaperIssues.has('paper-a'), true);
  assert.equal(
    internals.blockingPaperIssues.get('paper-a')?.issue.diagnostic.operation,
    'paper-presence-invalid',
  );
  assert.equal(
    internals.blockingPaperIssues.get('paper-a')?.issue.diagnostic.phase,
    'paper-presence-folder-resolution',
  );
  assert.equal(
    internals.blockingPaperIssues.get('paper-a')?.issue.diagnostic.causeCode,
    'presence-folder-missing',
  );
  assert.equal(state.status, 'needs-attention');
  const diagnostic = coordinator.getLastPaperRetryDiagnostic();
  assert.ok(diagnostic);
  assert.equal(diagnostic.phase, 'settled');
  assert.equal(diagnostic.targets[0]?.repository?.result, 'needs-attention');
  assert.equal(
    diagnostic.targets[0]?.repository?.phase,
    'paper-presence-folder-resolution',
  );
  assert.equal(diagnostic.targets[0]?.repository?.causeCode, 'presence-folder-missing');
  assert.equal(diagnostic.targets[0]?.settlement?.blockDisposition, 'replaced');
  assert.equal(diagnostic.targets[0]?.settlement?.selectedAction, 'revalidate');
  assert.equal(diagnostic.targets[0]?.settlement?.finalStatus, 'needs-attention');
});

test('Retry replaces a stale non-retryable block with the new authoritative issue', async () => {
  const state = paperState();
  const stalePresenceIssue = retryIssue({
    message: 'Drive paper presence data needs verification.',
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, stalePresenceIssue, 'upload');
  const authoritativeConflict: PaperCloudSummary = {
    ...cloudPaper('paper-a', 'head-a'),
    status: 'needs-attention',
    issue: {
      code: 'paper-source-pdf-conflict',
      message: 'Synthetic source identity conflict.',
      phase: 'source-identity-verification',
      causeCode: 'source-sha-mismatch',
    },
  };
  internals.view.papers = [authoritativeConflict];
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => ({
    catalog: [authoritativeConflict],
    scoped: { papers: [authoritativeConflict], missingDocumentIds: [] },
  }));
  Reflect.set(internals, 'requireWorkspaceLease', () => ({}));
  Reflect.set(internals, 'endOperation', () => undefined);
  Reflect.set(internals, 'applyDiscovery', async () => {
    state.status = 'needs-attention';
  });
  let uploads = 0;
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await coordinator.retryNow();

  assert.equal(uploads, 0);
  const diagnostic = coordinator.getLastPaperRetryDiagnostic();
  assert.ok(diagnostic);
  assert.equal(
    diagnostic.targets[0]?.repository?.issueCode,
    'paper-source-pdf-conflict',
  );
  assert.equal(
    diagnostic.targets[0]?.repository?.phase,
    'source-identity-verification',
  );
  assert.equal(diagnostic.targets[0]?.repository?.causeCode, 'source-sha-mismatch');
  assert.equal(diagnostic.targets[0]?.settlement?.blockDisposition, 'replaced');
  assert.equal(diagnostic.targets[0]?.settlement?.selectedAction, 'revalidate');
  assert.equal(
    diagnostic.targets[0]?.settlement?.activeBlockingIssue?.operation,
    'paper-source-pdf-conflict',
  );
  assert.equal(
    internals.blockingPaperIssues.get('paper-a')?.issue.diagnostic.operation,
    'paper-source-pdf-conflict',
  );
  assert.equal(diagnostic.targets[0]?.settlement?.finalStatus, 'needs-attention');
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(
    serialized,
    /paper-a|device-a|folder-paper-a|paper-a\.pdf|Synthetic source identity conflict/u,
  );
});

test('Retry retains the existing block when the exact reread returns no authoritative paper', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, presenceIssue, 'upload');
  const originalBlock = internals.blockingPaperIssues.get('paper-a');
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => ({
    catalog: [],
    scoped: { papers: [], missingDocumentIds: ['paper-a'] },
  }));
  Reflect.set(internals, 'requireWorkspaceLease', () => ({}));
  Reflect.set(internals, 'endOperation', () => undefined);
  Reflect.set(internals, 'applyDiscovery', async () => {
    assert.fail('a missing authoritative result must not be applied');
  });
  let uploads = 0;
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await coordinator.retryNow();

  assert.equal(uploads, 0);
  assert.equal(internals.blockingPaperIssues.get('paper-a'), originalBlock);
  assert.equal(internals.view.issue, presenceIssue);
  const diagnostic = coordinator.getLastPaperRetryDiagnostic();
  assert.equal(diagnostic?.targets[0]?.repository?.result, 'missing');
  assert.equal(diagnostic?.targets[0]?.settlement?.blockDisposition, 'retained');
});

test('Retry retains the existing block when the exact reread fails', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, presenceIssue, 'upload');
  const originalBlock = internals.blockingPaperIssues.get('paper-a');
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => {
    throw new Error('Synthetic read failure');
  });
  Reflect.set(internals, 'endOperation', () => undefined);
  let uploads = 0;
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await assert.rejects(coordinator.retryNow(), /Synthetic read failure/u);

  assert.equal(uploads, 0);
  assert.equal(internals.blockingPaperIssues.get('paper-a'), originalBlock);
  assert.equal(internals.view.issue, presenceIssue);
  assert.equal(coordinator.getLastPaperRetryDiagnostic()?.phase, 'failed');
});

test('Retry never lets a stale exact reread overwrite a newer blocking issue', async () => {
  const state = paperState();
  const stalePresenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const newerIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-source-pdf-conflict',
      phase: 'source-identity-verification',
      causeCode: 'source-sha-mismatch',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, stalePresenceIssue, 'upload');
  const staleRemoteResult: PaperCloudSummary = {
    ...cloudPaper('paper-a', 'head-a'),
    status: 'needs-attention',
    issue: {
      code: 'paper-presence-invalid',
      message: 'Synthetic stale presence result.',
      phase: 'paper-presence-folder-resolution',
      causeCode: 'presence-folder-missing',
    },
  };
  const newerBlock = { headSetId: 'head-newer', issue: newerIssue };
  Reflect.set(internals, 'initialize', async () => undefined);
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'ensureRepository', async () => ({}));
  Reflect.set(internals, 'readScopedDiscovery', async () => {
    internals.blockingPaperIssues.set('paper-a', newerBlock);
    return {
      catalog: [staleRemoteResult],
      scoped: { papers: [staleRemoteResult], missingDocumentIds: [] },
    };
  });
  Reflect.set(internals, 'requireWorkspaceLease', () => ({}));
  Reflect.set(internals, 'endOperation', () => undefined);
  Reflect.set(internals, 'applyDiscovery', async () => {
    assert.fail('a stale authoritative result must not be applied');
  });
  let uploads = 0;
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await coordinator.retryNow();

  assert.equal(uploads, 0);
  assert.equal(internals.blockingPaperIssues.get('paper-a'), newerBlock);
  assert.equal(
    coordinator.getLastPaperRetryDiagnostic()?.targets[0]?.settlement
      ?.activeBlockingIssue?.operation,
    'paper-source-pdf-conflict',
  );
});

function configureReadOnlyInspection(
  internals: RetryHarness,
  discoverPapers: (
    documentIds: readonly string[],
    states: readonly PaperSyncState[],
    signal: AbortSignal,
    options: { layoutValidated?: boolean; reuseVerifiedManifests?: boolean },
  ) => Promise<{
    papers: PaperCloudSummary[];
    missingDocumentIds: string[];
  }>,
  assertActiveRoot: (signal: AbortSignal) => Promise<void> = async () => undefined,
): void {
  Reflect.set(internals, 'initializationPromise', Promise.resolve());
  Reflect.set(internals, 'profile', {});
  Reflect.set(internals, 'drive', {});
  Reflect.set(internals, 'repository', { assertActiveRoot, discoverPapers });
  Reflect.set(internals, 'beginOperation', async () => new AbortController().signal);
  Reflect.set(internals, 'endOperation', () => undefined);
}

test('read-only sync status checks a pending upload without Retry, persistence, or mutation', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, presenceIssue, 'upload');
  const healthy = cloudPaper('paper-a', 'head-a');
  const originalBlock = internals.blockingPaperIssues.get('paper-a');
  const originalView = internals.view;
  let reads = 0;
  let applied = 0;
  let uploads = 0;
  configureReadOnlyInspection(internals, async () => {
    reads += 1;
    return { papers: [healthy], missingDocumentIds: [] };
  });
  let beginArguments: unknown[] | undefined;
  Reflect.set(internals, 'beginOperation', async (...args: unknown[]) => {
    beginArguments = args;
    return new AbortController().signal;
  });
  Reflect.set(internals, 'applyDiscovery', async () => {
    applied += 1;
  });
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  const diagnostic = await coordinator.checkSyncStatusReadOnly();

  assert.equal(reads, 1);
  assert.deepEqual(beginArguments, ['scan', false, 'diagnostic-only']);
  assert.equal(applied, 0);
  assert.equal(uploads, 0);
  assert.equal(internals.view, originalView);
  assert.equal(internals.blockingPaperIssues.get('paper-a'), originalBlock);
  assert.deepEqual(state.dirtyReasons, ['notes']);
  assert.equal(diagnostic.operation, 'paper-sync-status-check');
  assert.equal(diagnostic.phase, 'complete');
  assert.equal(diagnostic.targets[0]?.authoritative?.result, 'verified');
  assert.equal(diagnostic.targets[0]?.authoritative?.presenceState, 'present');
  assert.equal(diagnostic.targets[0]?.authoritative?.packageHeadCount, 1);
  assert.equal(diagnostic.targets[0]?.authoritative?.presenceHeadCount, 1);
  assert.equal(diagnostic.targets[0]?.upload.permitted, false);
  assert.equal(diagnostic.targets[0]?.upload.reason, 'current-blocking-issue');
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /paper-a|device-a|folder-paper-a|paper-a\.pdf/u,
  );
});

test('read-only sync status distinguishes invalid presence and a changed authoritative issue', async () => {
  const cases: Array<{
    paper: PaperCloudSummary;
    operation: string;
    phase: string;
    causeCode: string;
  }> = [
    {
      paper: {
        ...cloudPaper('paper-a', 'head-a'),
        status: 'needs-attention',
        issue: {
          code: 'paper-presence-invalid',
          message: 'Synthetic invalid presence.',
          phase: 'paper-presence-folder-resolution',
          causeCode: 'presence-folder-missing',
        },
      },
      operation: 'paper-presence-invalid',
      phase: 'paper-presence-folder-resolution',
      causeCode: 'presence-folder-missing',
    },
    {
      paper: {
        ...cloudPaper('paper-a', 'head-a'),
        status: 'needs-attention',
        issue: {
          code: 'paper-source-pdf-conflict',
          message: 'Synthetic changed issue.',
          phase: 'source-identity-verification',
          causeCode: 'source-sha-mismatch',
        },
      },
      operation: 'paper-source-pdf-conflict',
      phase: 'source-identity-verification',
      causeCode: 'source-sha-mismatch',
    },
  ];

  for (const entry of cases) {
    const state = paperState();
    const currentIssue = retryIssue({
      actions: ['details'],
      retrySafe: false,
      diagnostic: {
        source: 'google-drive',
        operation: 'paper-presence-invalid',
        documentId: 'paper-a',
      },
    });
    const { coordinator, internals } = harness(state, currentIssue, 'upload');
    const originalBlock = internals.blockingPaperIssues.get('paper-a');
    configureReadOnlyInspection(internals, async () => ({
      papers: [entry.paper],
      missingDocumentIds: [],
    }));

    const diagnostic = await coordinator.checkSyncStatusReadOnly();

    assert.equal(internals.blockingPaperIssues.get('paper-a'), originalBlock);
    assert.equal(
      diagnostic.targets[0]?.current.blockingIssue?.operation,
      'paper-presence-invalid',
    );
    assert.equal(
      diagnostic.targets[0]?.authoritative?.issue?.operation,
      entry.operation,
    );
    assert.equal(diagnostic.targets[0]?.authoritative?.issue?.phase, entry.phase);
    assert.equal(
      diagnostic.targets[0]?.authoritative?.issue?.causeCode,
      entry.causeCode,
    );
    assert.equal(diagnostic.targets[0]?.upload.permitted, false);
  }
});

test('read-only sync status fails closed and marks a stale result without changing issues', async () => {
  const state = paperState();
  const presenceIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-presence-invalid',
      documentId: 'paper-a',
    },
  });

  const failed = harness(state, presenceIssue, 'upload');
  const failedBlock = failed.internals.blockingPaperIssues.get('paper-a');
  configureReadOnlyInspection(failed.internals, async () => {
    throw new Error('Synthetic diagnostic failure');
  });
  const failedDiagnostic = await failed.coordinator.checkSyncStatusReadOnly();
  assert.equal(failedDiagnostic.phase, 'failed');
  assert.equal(failedDiagnostic.targets[0]?.upload.permitted, false);
  assert.equal(failedDiagnostic.targets[0]?.upload.reason, 'inspection-failed-closed');
  assert.equal(failed.internals.blockingPaperIssues.get('paper-a'), failedBlock);

  const stale = harness(paperState(), presenceIssue, 'upload');
  const gate = deferred<{
    papers: PaperCloudSummary[];
    missingDocumentIds: string[];
  }>();
  configureReadOnlyInspection(stale.internals, () => gate.promise);
  const inspection = stale.coordinator.checkSyncStatusReadOnly();
  await Promise.resolve();
  const newerBlock = {
    headSetId: 'head-newer',
    issue: retryIssue({
      actions: ['details'],
      retrySafe: false,
      diagnostic: {
        source: 'google-drive',
        operation: 'paper-source-pdf-conflict',
        documentId: 'paper-a',
      },
    }),
  };
  stale.internals.blockingPaperIssues.set('paper-a', newerBlock);
  gate.resolve({ papers: [cloudPaper('paper-a', 'head-a')], missingDocumentIds: [] });

  const staleDiagnostic = await inspection;
  assert.equal(staleDiagnostic.phase, 'stale');
  assert.equal(
    staleDiagnostic.targets[0]?.upload.reason,
    'local-state-changed-during-inspection',
  );
  assert.equal(stale.internals.blockingPaperIssues.get('paper-a'), newerBlock);
});

function createForgetReadOnlyInspectionHarness() {
  const documentId = 'paper-a';
  const paperFolderId = `folder-${documentId}`;
  const state = paperState({
    documentId,
    status: 'synced',
    dirtyGeneration: 0,
    dirtyReasons: [],
    cloudPresence: 'present',
    driveFiles: { paperFolderId, fileIds: {} },
  });
  const catalogPaper: PaperCloudSummary = {
    ...cloudPaper(documentId, 'head-a'),
    paperFolderId,
    status: 'needs-attention',
  };
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  internals.paperStates = new Map([[documentId, state]]);
  internals.blockingPaperIssues = new Map();
  internals.paperRetryIntents = new Map();
  internals.view = {
    ...viewState(state, retryIssue()),
    connection: 'connected',
    papers: [catalogPaper],
    paperStates: [state],
    dirtyPaperIds: [],
    issue: undefined,
    error: undefined,
  };
  const profile = {
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Synthetic device',
    deviceMode: 'personal' as const,
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'root-a',
  };
  const identity = Reflect.get(coordinator, 'identity') as {
    accountIdValue?: string;
  };
  Reflect.set(internals, 'profile', profile);
  identity.accountIdValue = 'account-a';
  return {
    catalogPaper,
    coordinator,
    documentId,
    identity,
    internals,
    profile,
    state,
  };
}

test('row-scoped read-only verification proves Forget without relaxing targeted purge', async () => {
  const documentId = 'paper-a';
  const paperFolderId = `folder-${documentId}`;
  const state = paperState({
    documentId,
    status: 'synced',
    dirtyGeneration: 0,
    dirtyReasons: [],
    cloudPresence: 'present',
    driveFiles: { paperFolderId, fileIds: {} },
  });
  const catalogPaper: PaperCloudSummary = {
    ...cloudPaper(documentId, 'head-a'),
    paperFolderId,
    status: 'needs-attention',
  };
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  internals.paperStates = new Map([[documentId, state]]);
  internals.blockingPaperIssues = new Map();
  internals.paperRetryIntents = new Map();
  internals.view = {
    ...viewState(state, retryIssue()),
    connection: 'connected',
    papers: [catalogPaper],
    paperStates: [state],
    dirtyPaperIds: [],
    issue: undefined,
    error: undefined,
  };
  let repositoryReads = 0;
  const repositoryEvents: string[] = [];
  configureReadOnlyInspection(
    internals,
    async (documentIds, _states, _signal, options) => {
      repositoryEvents.push('discover');
      assert.deepEqual(documentIds, [documentId]);
      assert.deepEqual(options, {
        layoutValidated: true,
        reuseVerifiedManifests: true,
      });
      repositoryReads += 1;
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'Synthetic exact presence resolution failure.',
        {
          diagnosticPhase: 'paper-presence-resolution',
          diagnosticCauseCode: 'presence-control-resolution-failed',
        },
      );
    },
    async () => {
      repositoryEvents.push('root-guard');
    },
  );
  Reflect.set(internals, 'profile', {
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Synthetic device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'root-a',
  });
  Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');

  const before = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);
  assert.equal(before.reason, 'identity-proof-unavailable');
  assert.equal(before.predicates.catalogNeedsAttention, true);
  assert.equal(before.predicates.localStateNeedsAttention, false);

  const diagnostic = await coordinator.checkSyncStatusReadOnly(documentId);
  const after = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);

  assert.equal(repositoryReads, 1);
  assert.deepEqual(repositoryEvents, ['root-guard', 'discover']);
  assert.equal(diagnostic.targetCount, 1);
  assert.equal(diagnostic.phase, 'failed');
  assert.equal(diagnostic.failure?.operation, 'paper-presence-invalid');
  assert.equal(diagnostic.failure?.phase, 'paper-presence-resolution');
  assert.equal(diagnostic.failure?.causeCode, 'presence-control-resolution-failed');
  assert.equal(diagnostic.targets[0]?.current.status, 'synced');
  assert.equal(diagnostic.targets[0]?.upload.reason, 'inspection-failed-closed');
  assert.equal(after.reason, 'eligible');
  assert.equal(after.evidenceSource, 'failed-inspection');
  assert.equal(after.predicates.sessionProofPresent, true);
  assert.deepEqual(after.candidate, {
    documentId,
    displayName: catalogPaper.displayName,
  });
  assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

  state.driveFiles.paperFolderId = 'different-folder';
  const changed = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);
  assert.equal(changed.reason, 'paper-folder-mismatch');
  assert.equal(changed.predicates.sessionProofPresent, false);
});

test('an exact-tuple root guard failure never becomes paper identity proof', async () => {
  const { coordinator, documentId, identity, internals, profile } =
    createForgetReadOnlyInspectionHarness();
  const repositoryEvents: string[] = [];
  let discoverCalls = 0;
  configureReadOnlyInspection(
    internals,
    async () => {
      repositoryEvents.push('discover');
      discoverCalls += 1;
      return { papers: [], missingDocumentIds: [] };
    },
    async () => {
      repositoryEvents.push('root-guard');
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'Synthetic root failure with a colliding paper error tuple.',
        {
          diagnosticPhase: 'paper-presence-resolution',
          diagnosticCauseCode: 'presence-control-resolution-failed',
        },
      );
    },
  );
  Reflect.set(internals, 'profile', profile);
  identity.accountIdValue = 'account-a';

  const diagnostic = await coordinator.checkSyncStatusReadOnly(documentId);
  const proof = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);

  assert.deepEqual(repositoryEvents, ['root-guard']);
  assert.equal(discoverCalls, 0);
  assert.equal(diagnostic.phase, 'failed');
  assert.equal(diagnostic.failure?.operation, 'paper-presence-invalid');
  assert.equal(diagnostic.failure?.phase, 'paper-presence-resolution');
  assert.equal(diagnostic.failure?.causeCode, 'presence-control-resolution-failed');
  assert.equal(proof.predicates.sessionProofPresent, false);
  assert.equal(proof.predicates.identityProofAvailable, false);
  assert.equal(proof.reason, 'identity-proof-unavailable');
  assert.equal(proof.candidate, undefined);
  assert.equal(coordinator.getForgetInaccessiblePaperCandidate(documentId), undefined);
});

test('row-scoped proof becomes stale when identity correlation changes during inspection', async () => {
  const cases = [
    {
      name: 'account identity',
      mutate: (fixture: ReturnType<typeof createForgetReadOnlyInspectionHarness>) => {
        fixture.identity.accountIdValue = 'account-b';
      },
      expectedReason: 'account-scope-mismatch',
    },
    {
      name: 'root identity',
      mutate: (fixture: ReturnType<typeof createForgetReadOnlyInspectionHarness>) => {
        fixture.profile.rootFolderId = 'root-b';
      },
      expectedReason: 'identity-proof-unavailable',
    },
    {
      name: 'catalog head identity',
      mutate: (fixture: ReturnType<typeof createForgetReadOnlyInspectionHarness>) => {
        fixture.catalogPaper.headSetId = 'changed-head';
      },
      expectedReason: 'identity-proof-unavailable',
    },
    {
      name: 'managed folder identity',
      mutate: (fixture: ReturnType<typeof createForgetReadOnlyInspectionHarness>) => {
        fixture.state.driveFiles.paperFolderId = 'different-folder';
      },
      expectedReason: 'paper-folder-mismatch',
    },
  ] as const;

  for (const entry of cases) {
    const fixture = createForgetReadOnlyInspectionHarness();
    const discoveryStarted = deferred<void>();
    const releaseDiscovery = deferred<void>();
    configureReadOnlyInspection(fixture.internals, async () => {
      discoveryStarted.resolve();
      await releaseDiscovery.promise;
      throw new PaperRepositoryError(
        'paper-presence-invalid',
        'Synthetic exact presence resolution failure.',
        {
          diagnosticPhase: 'paper-presence-resolution',
          diagnosticCauseCode: 'presence-control-resolution-failed',
        },
      );
    });
    Reflect.set(fixture.internals, 'profile', fixture.profile);
    fixture.identity.accountIdValue = 'account-a';

    const inspection = fixture.coordinator.checkSyncStatusReadOnly(fixture.documentId);
    await discoveryStarted.promise;
    entry.mutate(fixture);
    releaseDiscovery.resolve();

    const diagnostic = await inspection;
    const proof = fixture.coordinator.getForgetInaccessiblePaperDiagnostic(
      fixture.documentId,
    );
    assert.equal(diagnostic.phase, 'stale', `${entry.name}: diagnostic phase`);
    assert.equal(
      proof.predicates.sessionProofPresent,
      false,
      `${entry.name}: session proof`,
    );
    assert.equal(
      proof.predicates.identityProofAvailable,
      false,
      `${entry.name}: identity proof`,
    );
    assert.equal(proof.eligible, false, `${entry.name}: eligibility`);
    assert.equal(proof.reason, entry.expectedReason, `${entry.name}: blocker`);
    assert.equal(proof.candidate, undefined, `${entry.name}: candidate`);
    assert.equal(
      fixture.coordinator.getForgetInaccessiblePaperCandidate(fixture.documentId),
      undefined,
      `${entry.name}: Forget candidate`,
    );
  }
});

test('row-scoped read-only verification refuses an uncorrelated Browse row before Drive access', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  const state = paperState({
    status: 'synced',
    dirtyGeneration: 0,
    dirtyReasons: [],
    cloudPresence: 'present',
    driveFiles: { paperFolderId: 'different-folder', fileIds: {} },
  });
  const catalogPaper = {
    ...cloudPaper('paper-a', 'head-a'),
    status: 'needs-attention' as const,
  };
  internals.paperStates = new Map([['paper-a', state]]);
  internals.blockingPaperIssues = new Map();
  internals.paperRetryIntents = new Map();
  internals.view = {
    ...viewState(state, retryIssue()),
    papers: [catalogPaper],
    paperStates: [state],
    issue: undefined,
    error: undefined,
  };
  let repositoryReads = 0;
  configureReadOnlyInspection(internals, async () => {
    repositoryReads += 1;
    return { papers: [catalogPaper], missingDocumentIds: [] };
  });
  Reflect.set(internals, 'profile', {
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Synthetic device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'root-a',
  });
  Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');

  const diagnostic = await coordinator.checkSyncStatusReadOnly('paper-a');

  assert.equal(repositoryReads, 0);
  assert.equal(diagnostic.targetCount, 0);
  assert.equal(diagnostic.failure?.causeCode, 'no-scoped-paper-target');
  assert.equal(
    coordinator.getForgetInaccessiblePaperDiagnostic('paper-a').reason,
    'paper-folder-mismatch',
  );
});

test('failed exact inspection correlates one of 23 papers after settlement without touching two pending changes', async () => {
  const affectedId = 'paper-affected';
  const secondDirtyId = 'paper-second-dirty';
  const states = Array.from({ length: 23 }, (_, index) => {
    const documentId =
      index === 0
        ? affectedId
        : index === 1
          ? secondDirtyId
          : `paper-synced-${String(index).padStart(2, '0')}`;
    return paperState({
      documentId,
      status:
        documentId === affectedId
          ? 'needs-attention'
          : documentId === secondDirtyId
            ? 'local-changes'
            : 'synced',
      dirtyGeneration:
        documentId === affectedId || documentId === secondDirtyId ? 1 : 0,
      dirtyReasons:
        documentId === affectedId || documentId === secondDirtyId ? ['notes'] : [],
      remoteHeadIds: [`head-${index}`],
      incorporatedHeadIds: [`head-${index}`],
      presenceHeadIds: [`presence-${index}`],
      cloudPresence: 'present',
    });
  });
  const affected = states[0]!;
  const genericPersistedIssue = retryIssue({
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-validation',
      documentId: affectedId,
    },
  });
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  internals.paperStates = new Map(states.map((state) => [state.documentId, state]));
  internals.blockingPaperIssues = new Map([
    [affectedId, { headSetId: 'head-0', issue: genericPersistedIssue }],
  ]);
  internals.paperRetryIntents = new Map();
  internals.view = {
    ...viewState(affected, genericPersistedIssue),
    papers: states.map((state, index) => cloudPaper(state.documentId, `head-${index}`)),
    paperStates: states,
    dirtyPaperIds: [affectedId, secondDirtyId],
  };
  const beforeState = JSON.stringify(states);
  const beforeView = internals.view;
  const beforeVisibility = coordinator.getTargetedPaperPurgeVisibilityDiagnostic();
  assert.equal(beforeVisibility.visible, false);
  assert.equal(beforeVisibility.showRecoveryCard, false);

  let repositoryReads = 0;
  configureReadOnlyInspection(internals, async () => {
    repositoryReads += 1;
    throw new PaperRepositoryError(
      'paper-presence-invalid',
      'Synthetic presence resolution failure.',
      {
        diagnosticPhase: 'paper-presence-resolution',
        diagnosticCauseCode: 'presence-control-resolution-failed',
      },
    );
  });

  const diagnostic = await coordinator.checkSyncStatusReadOnly();
  const visibility = coordinator.getTargetedPaperPurgeVisibilityDiagnostic();

  assert.equal(repositoryReads, 1);
  assert.equal(diagnostic.phase, 'failed');
  assert.equal(diagnostic.targetCount, 1);
  assert.equal(diagnostic.failure?.operation, 'paper-presence-invalid');
  assert.equal(diagnostic.failure?.phase, 'paper-presence-resolution');
  assert.equal(diagnostic.failure?.causeCode, 'presence-control-resolution-failed');
  assert.equal(diagnostic.targets[0]?.upload.reason, 'inspection-failed-closed');
  assert.equal(visibility.visible, true);
  assert.equal(visibility.showRecoveryCard, true);
  assert.equal(visibility.candidateSource, 'failed-inspection');
  assert.equal(visibility.hiddenReason, 'not-hidden');
  assert.equal(visibility.retryCandidateCount, 1);
  for (const predicate of [
    'implementationCurrent',
    'diagnosticPresent',
    'diagnosticContextPresent',
    'diagnosticSequenceCurrent',
    'diagnosticPhaseFailed',
    'diagnosticTargetCountOne',
    'diagnosticContextTargetCountOne',
    'diagnosticContextIdentityPresent',
    'exactDiagnosticFailure',
    'exactFailedDiagnosticVisible',
    'diagnosticTargetPresent',
    'diagnosticSnapshotNeedsAttention',
    'diagnosticSnapshotPresencePresent',
    'diagnosticUploadBlocked',
    'diagnosticUploadFailedClosed',
    'currentStatePresent',
    'currentStateNeedsAttention',
    'currentPresencePresent',
    'retryCandidateContainsCorrelatedTarget',
    'failedInspectionEvidenceComplete',
    'candidateResolved',
  ] as const) {
    assert.equal(visibility.predicates[predicate], true, predicate);
  }
  assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), affectedId);
  assert.equal(internals.view, beforeView);
  assert.equal(JSON.stringify(states), beforeState);
  assert.deepEqual(internals.view.dirtyPaperIds, [affectedId, secondDirtyId]);
  assert.doesNotMatch(
    JSON.stringify(visibility),
    /paper-affected|paper-second-dirty|paper-synced|head-|presence-/u,
  );
});

test('recoverable upload Retry performs scoped reconciliation and converges without Upload changes', async () => {
  const state = paperState();
  const issue = retryIssue();
  const { coordinator, internals } = harness(state, issue, 'upload');
  let revalidations = 0;
  let uploads = 0;
  internals.revalidatePaperRetryTargets = async (documentIds) => {
    revalidations += 1;
    assert.deepEqual(documentIds, ['paper-a']);
    internals.blockingPaperIssues.delete('paper-a');
    state.status = 'local-changes';
  };
  internals.uploadSelected = async (documentIds) => {
    uploads += 1;
    assert.deepEqual(documentIds, ['paper-a']);
    state.dirtyReasons = [];
    state.status = 'synced';
    internals.blockingPaperIssues.delete('paper-a');
    internals.paperRetryIntents.delete('paper-a');
    internals.view = viewState(state, issue);
    internals.view.connection = 'connected';
    delete internals.view.issue;
    delete internals.view.error;
  };

  await coordinator.retryNow();

  assert.equal(revalidations, 1);
  assert.equal(uploads, 1);
  assert.equal(state.status, 'synced');
  assert.equal(internals.blockingPaperIssues.size, 0);
  assert.equal(internals.paperRetryIntents.size, 0);
});

test('an uncertain timed-out mutation makes the first Retry read-only', async () => {
  const state = paperState();
  const issue = retryIssue({
    code: 'drive-mutation-uncertain',
    message:
      'Google Drive stopped responding after a change may have started. 39Note did not mark it successful.',
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'upload',
      documentId: 'paper-a',
      phase: 'operation-watchdog',
      causeCode: 'deadline-exceeded-remote-outcome-unknown',
    },
  });
  const { coordinator, internals } = harness(state, issue, 'revalidate');
  let revalidations = 0;
  let uploads = 0;
  internals.revalidatePaperRetryTargets = async (documentIds) => {
    revalidations += 1;
    assert.deepEqual(documentIds, ['paper-a']);
    internals.blockingPaperIssues.delete('paper-a');
    state.status = 'local-changes';
  };
  internals.uploadSelected = async () => {
    uploads += 1;
  };

  await coordinator.retryNow();

  assert.equal(revalidations, 1);
  assert.equal(uploads, 0);
  assert.equal(state.status, 'local-changes');
  assert.equal(internals.paperRetryIntents.has('paper-a'), false);
});

test('a global read timeout Retry checks Drive without uploading unrelated dirty work', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const internals = coordinator as unknown as RetryHarness;
  const dirty = paperState({
    documentId: 'unrelated-dirty-paper',
    status: 'needs-attention',
    dirtyReasons: ['notes'],
  });
  const timeoutIssue = retryIssue({
    code: 'drive-operation-timeout',
    message:
      'Google Drive did not respond before the safety deadline. The operation stopped without reporting success; local work remains saved.',
    actions: ['automatic-retry', 'retry-now', 'details'],
    retrySafe: true,
    blocksOrdinarySync: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'scan',
      phase: 'operation-watchdog',
      causeCode: 'deadline-exceeded',
    },
  });
  internals.paperStates = new Map([[dirty.documentId, dirty]]);
  internals.blockingPaperIssues = new Map();
  internals.paperRetryIntents = new Map();
  internals.view = {
    ...viewState(dirty, timeoutIssue),
    connection: 'offline',
    dirtyPaperIds: [dirty.documentId],
    papers: [],
    ignoredCloudIssues: [
      {
        documentId: 'ignored-broken-paper',
        displayName: 'Ignored broken paper.pdf',
        confirmedAt: 123,
      },
    ],
  };
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'timeout-recovery-device',
    deviceLabel: 'Timeout recovery device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'verified-root',
  });
  Reflect.set(coordinator, 'identity', {
    hasDeviceSession: true,
    accountId: 'account-a',
  });
  internals.waitForLocalRemovalSettlement = async () => undefined;
  let scans = 0;
  let paperRevalidations = 0;
  let uploads = 0;
  Reflect.set(coordinator, 'scanCloudPapersUsingVerifiedRepository', async () => {
    scans += 1;
    Object.assign(internals.view, {
      connection: 'connected',
      issue: undefined,
      error: undefined,
      lastSuccessfulAt: 456,
    });
  });
  internals.uploadSelected = async () => {
    uploads += 1;
  };
  internals.revalidatePaperRetryTargets = async () => {
    paperRevalidations += 1;
  };

  const isAutoSyncEffectivelyEnabled = Reflect.get(
    coordinator,
    'isAutoSyncEffectivelyEnabled',
  ) as () => boolean;
  const scheduleAutoUpload = Reflect.get(coordinator, 'scheduleAutoUpload') as (
    delay?: number,
  ) => void;
  assert.equal(isAutoSyncEffectivelyEnabled.call(coordinator), false);
  scheduleAutoUpload.call(coordinator, 0);
  assert.equal(Reflect.get(coordinator, 'autoUploadTimer'), null);

  await coordinator.retryNow();

  assert.equal(scans, 1);
  assert.equal(paperRevalidations, 0);
  assert.equal(uploads, 0);
  assert.deepEqual(dirty.dirtyReasons, ['notes']);
  assert.equal(internals.view.connection, 'connected');
  assert.equal(internals.view.issue, undefined);
  assert.equal(internals.view.ignoredCloudIssues?.length, 1);
  assert.deepEqual(internals.view.papers, []);
});

test('transient download Retry reruns only the failed paper download', async () => {
  const state = paperState({
    availability: 'cloud-only',
    dirtyGeneration: 0,
    dirtyReasons: [],
    incorporatedHeadIds: [],
    remoteHeadIds: ['head-a'],
  });
  const issue = retryIssue({
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-download',
      documentId: 'paper-a',
    },
  });
  const { coordinator, internals } = harness(state, issue, 'download');
  let downloads = 0;
  internals.revalidatePaperRetryTargets = async () => {
    internals.blockingPaperIssues.delete('paper-a');
    state.status = 'remote-update-available';
  };
  internals.downloadSelected = async (documentIds) => {
    downloads += 1;
    assert.deepEqual(documentIds, ['paper-a']);
    state.status = 'synced';
    state.availability = 'local-and-cloud';
    state.incorporatedHeadIds = ['head-a'];
    internals.paperRetryIntents.delete('paper-a');
  };

  await coordinator.retryNow();
  assert.equal(downloads, 1);
  assert.equal(state.status, 'synced');
});

test('Retry rejoins an identical active paper operation', async () => {
  const state = paperState();
  const issue = retryIssue();
  const { coordinator, internals } = harness(state, issue, 'upload');
  const gate = deferred<void>();
  let starts = 0;
  let revalidations = 0;
  const active = internals.retainPaperOperation('upload', ['paper-a'], () => {
    starts += 1;
    return gate.promise;
  });
  internals.revalidatePaperRetryTargets = async () => {
    revalidations += 1;
  };
  const retry = coordinator.retryNow();
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(revalidations, 0);
  gate.resolve();
  await Promise.all([active, retry]);
  assert.equal(starts, 1);
});

test('repeated Retry joins one reconciliation and never duplicates its Drive mutation', async () => {
  const state = paperState();
  const issue = retryIssue();
  const { coordinator, internals } = harness(state, issue, 'upload');
  const gate = deferred<void>();
  let revalidations = 0;
  let uploads = 0;
  internals.revalidatePaperRetryTargets = async () => {
    revalidations += 1;
    await gate.promise;
    internals.blockingPaperIssues.delete('paper-a');
    state.status = 'local-changes';
  };
  internals.uploadSelected = async () => {
    uploads += 1;
    state.status = 'synced';
    state.dirtyReasons = [];
    internals.paperRetryIntents.delete('paper-a');
  };

  const first = coordinator.retryNow();
  const second = coordinator.retryNow();
  await Promise.resolve();
  assert.equal(revalidations, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(uploads, 1);
});

test('removed papers never resurrect and unrecoverable conflicts stay precise', async () => {
  const removed = paperState({
    status: 'needs-attention',
    cloudPresence: 'removed',
    cloudCleanupPending: false,
  });
  const removedHarness = harness(removed, retryIssue(), 'upload');
  let removedMutations = 0;
  removedHarness.internals.revalidatePaperRetryTargets = async () => undefined;
  removedHarness.internals.uploadSelected = async () => {
    removedMutations += 1;
  };
  removedHarness.internals.downloadSelected = async () => {
    removedMutations += 1;
  };
  await removedHarness.coordinator.retryNow();
  assert.equal(removedMutations, 0);
  assert.equal(removed.cloudPresence, 'removed');

  const conflictIssue = retryIssue({
    message: 'The paper source PDF conflicts with Drive.',
    actions: ['details'],
    retrySafe: false,
    diagnostic: {
      source: 'google-drive',
      operation: 'paper-source-pdf-conflict',
      documentId: 'paper-a',
    },
  });
  const conflict = harness(paperState(), conflictIssue, 'upload');
  let conflictMutations = 0;
  conflict.internals.revalidatePaperRetryTargets = async () => undefined;
  conflict.internals.uploadSelected = async () => {
    conflictMutations += 1;
  };
  conflict.internals.downloadSelected = async () => {
    conflictMutations += 1;
  };
  await conflict.coordinator.retryNow();
  assert.equal(conflictMutations, 0);
  assert.equal(
    conflict.internals.blockingPaperIssues.get('paper-a')?.issue.message,
    'The paper source PDF conflicts with Drive.',
  );
});
