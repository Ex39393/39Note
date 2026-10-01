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
  const module = (await server.ssrLoadModule(
    '/src/sync/paperCoordinator.ts',
  )) as typeof import('../src/sync/paperCoordinator.ts');
  PaperGoogleDriveSyncCoordinator = module.PaperGoogleDriveSyncCoordinator;
  selectPaperRetryAction = module.selectPaperRetryAction;
  mergeScopedPaperDiscoveryCatalog = module.mergeScopedPaperDiscoveryCatalog;
});

after(async () => {
  await server?.close();
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
