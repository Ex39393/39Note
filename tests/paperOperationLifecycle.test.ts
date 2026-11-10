import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type {
  PaperActiveOperationType,
  PaperSyncViewState,
} from '../src/sync/paperCoordinator.ts';
import { withExclusiveWorkspaceRestoreLease } from '../src/services/workspaceRestoreLock.ts';

let server: ViteDevServer;
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let SerializedDriveOperationOwner: (typeof import('../src/sync/paperCoordinator.ts'))['SerializedDriveOperationOwner'];
let DriveOperationTimeoutError: (typeof import('../src/sync/paperCoordinator.ts'))['DriveOperationTimeoutError'];
let PaperManifestIntegrityError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperManifestIntegrityError'];
let classifyPaperCoordinatorError: (typeof import('../src/sync/paperCoordinator.ts'))['classifyPaperCoordinatorError'];
let driveOperationTimeoutMs: (typeof import('../src/sync/paperCoordinator.ts'))['driveOperationTimeoutMs'];

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
  const coordinator = (await server.ssrLoadModule(
    '/src/sync/paperCoordinator.ts',
  )) as typeof import('../src/sync/paperCoordinator.ts');
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  SerializedDriveOperationOwner = coordinator.SerializedDriveOperationOwner;
  DriveOperationTimeoutError = coordinator.DriveOperationTimeoutError;
  classifyPaperCoordinatorError = coordinator.classifyPaperCoordinatorError;
  driveOperationTimeoutMs = coordinator.driveOperationTimeoutMs;
  PaperManifestIntegrityError = (
    (await server.ssrLoadModule(
      '/src/sync/paperDriveRepository.ts',
    )) as typeof import('../src/sync/paperDriveRepository.ts')
  ).PaperManifestIntegrityError;
});

after(async () => {
  await server?.close();
});

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

interface RetainedOperationHarness {
  retainPaperOperation<T>(
    type: PaperActiveOperationType,
    documentIds: readonly string[],
    start: () => Promise<T>,
  ): Promise<T>;
}

function retainedOperations(
  coordinator: InstanceType<typeof PaperGoogleDriveSyncCoordinator>,
): RetainedOperationHarness {
  return coordinator as unknown as RetainedOperationHarness;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test('paper operation lifetime belongs to the coordinator, not a UI subscription', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const operations = retainedOperations(coordinator);
  const gate = deferred<string>();
  const firstSubscriber: PaperSyncViewState[] = [];
  const unsubscribe = coordinator.subscribe((state) => firstSubscriber.push(state));
  let starts = 0;

  const operation = operations.retainPaperOperation('download', ['paper-a'], () => {
    starts += 1;
    return gate.promise;
  });
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.deepEqual(coordinator.getSnapshot().activePaperOperations, [
    {
      id: 'paper-operation-1',
      type: 'download',
      documentIds: ['paper-a'],
      startedAt: coordinator.getSnapshot().activePaperOperations[0]?.startedAt,
    },
  ]);

  unsubscribe();
  assert.equal(gate.promise instanceof Promise, true);
  assert.equal(coordinator.getSnapshot().activePaperOperations.length, 1);

  const returningSubscriber: PaperSyncViewState[] = [];
  const unsubscribeReturning = coordinator.subscribe((state) =>
    returningSubscriber.push(state),
  );
  assert.equal(returningSubscriber[0]?.activePaperOperations[0]?.type, 'download');

  gate.resolve('complete');
  assert.equal(await operation, 'complete');
  assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
  assert.deepEqual(returningSubscriber.at(-1)?.activePaperOperations, []);
  unsubscribeReturning();
  assert.ok(firstSubscriber.some((state) => state.activePaperOperations.length === 1));
});

test('all paper command types are single-flight and clear after success or failure', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const operations = retainedOperations(coordinator);
  const types: PaperActiveOperationType[] = [
    'download',
    'upload',
    'remove',
    'restore',
    'keep-local',
  ];

  for (const [index, type] of types.entries()) {
    const gate = deferred<number>();
    let starts = 0;
    const first = operations.retainPaperOperation(type, ['paper-b', 'paper-a'], () => {
      starts += 1;
      return gate.promise;
    });
    const duplicate = operations.retainPaperOperation(
      type,
      ['paper-a', 'paper-b', 'paper-a'],
      async () => {
        starts += 1;
        return -1;
      },
    );

    assert.strictEqual(duplicate, first);
    await Promise.resolve();
    assert.equal(starts, 1);
    assert.deepEqual(coordinator.getSnapshot().activePaperOperations[0]?.documentIds, [
      'paper-a',
      'paper-b',
    ]);
    gate.resolve(index);
    assert.equal(await first, index);
    assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
  }

  const failure = new Error('expected operation failure');
  const rejected = operations.retainPaperOperation('restore', ['paper-failure'], () =>
    Promise.reject(failure),
  );
  await assert.rejects(rejected, failure);
  assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
});

test('different paper selections remain genuine commands instead of phantom batch joins', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const operations = retainedOperations(coordinator);
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const starts: string[] = [];

  const first = operations.retainPaperOperation('download', ['paper-a'], () => {
    starts.push('paper-a');
    return firstGate.promise;
  });
  const second = operations.retainPaperOperation('download', ['paper-b'], () => {
    starts.push('paper-b');
    return secondGate.promise;
  });
  assert.notStrictEqual(first, second);
  await Promise.resolve();
  assert.deepEqual(starts, ['paper-a', 'paper-b']);
  assert.deepEqual(
    coordinator
      .getSnapshot()
      .activePaperOperations.map(({ documentIds }) => documentIds),
    [['paper-a'], ['paper-b']],
  );

  firstGate.resolve();
  secondGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
});

test('intentional cancellation aborts only owned work and releases FIFO ownership', async () => {
  const owner = new SerializedDriveOperationOwner();
  const first = await owner.begin();
  const queued = owner.begin();
  let queuedAcquired = false;
  void queued.then(() => {
    queuedAcquired = true;
  });

  owner.cancel();
  assert.equal(first.aborted, true);
  await Promise.resolve();
  assert.equal(queuedAcquired, false);

  owner.end(first);
  const second = await queued;
  assert.equal(second.aborted, false);
  assert.equal(queuedAcquired, true);
  owner.end(second);

  const third = await owner.begin();
  assert.equal(third.aborted, false);
  owner.end(third);
  assert.equal(owner.active, false);
});

test('session teardown aborts current work, rejects queued work, drains, and can resume', async () => {
  const owner = new SerializedDriveOperationOwner();
  const first = await owner.begin();
  const queuedResult = owner.begin().then(
    () => null,
    (error: unknown) => error,
  );
  const reason = new DOMException('Session closing.', 'AbortError');
  const drained = owner.suspendAndDrain(reason);

  assert.equal(first.aborted, true);
  await assert.rejects(owner.begin(), /Session closing/u);
  owner.end(first);
  assert.strictEqual(await queuedResult, reason);
  await drained;
  assert.equal(owner.active, false);

  owner.resume();
  const afterResume = await owner.begin();
  assert.equal(afterResume.aborted, false);
  owner.end(afterResume);
});

test('read-timeout recovery cannot initialize or create a missing Drive repository', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  let initializationAttempts = 0;
  let repositoryAttempts = 0;
  Reflect.set(coordinator, 'initialize', async () => {
    initializationAttempts += 1;
  });
  Reflect.set(coordinator, 'ensureRepository', async () => {
    repositoryAttempts += 1;
  });
  const scanOwned = Reflect.get(coordinator, 'scanCloudPapersOwned') as (
    waitForBatch: boolean,
    requireVerifiedRepository: boolean,
  ) => Promise<void>;

  await assert.rejects(
    scanOwned.call(coordinator, true, true),
    /verified existing 39Note Drive folder/u,
  );
  assert.equal(initializationAttempts, 0);
  assert.equal(repositoryAttempts, 0);
});

test('read-timeout recovery fails closed if the verified layout changes before baseline discovery', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const changed = new Error('synthetic active root changed before baseline');
  const calls = {
    startToken: 0,
    activeRoot: 0,
    layoutDetection: 0,
    layoutInitialization: 0,
    discovery: 0,
    create: 0,
    upload: 0,
    metadataUpdate: 0,
  };
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'read-timeout-device',
    deviceLabel: 'Read timeout device',
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
  Reflect.set(coordinator, 'drive', {
    async getStartPageToken() {
      calls.startToken += 1;
      return 'baseline-token';
    },
    async createFolder() {
      calls.create += 1;
    },
    async uploadJson() {
      calls.upload += 1;
    },
    async updateMetadata() {
      calls.metadataUpdate += 1;
    },
  });
  const repository = {
    rootFolderId: 'verified-root',
    async assertActiveRoot() {
      calls.activeRoot += 1;
      throw changed;
    },
    async detectLayout() {
      calls.layoutDetection += 1;
      return { state: 'empty' as const };
    },
    async initializeEmptyLayout() {
      calls.layoutInitialization += 1;
      throw new Error('strict read-only recovery initialized an empty layout');
    },
    async discover() {
      calls.discovery += 1;
      return [];
    },
  };
  const discoverWithFastPath = Reflect.get(coordinator, 'discoverWithFastPath') as (
    repository: typeof repository,
    signal: AbortSignal,
    workspaceLease: unknown,
    strictReadOnly: boolean,
  ) => Promise<void>;

  await assert.rejects(
    discoverWithFastPath.call(
      coordinator,
      repository,
      new AbortController().signal,
      {},
      true,
    ),
    changed,
  );
  assert.deepEqual(calls, {
    startToken: 1,
    activeRoot: 1,
    layoutDetection: 0,
    layoutInitialization: 0,
    discovery: 0,
    create: 0,
    upload: 0,
    metadataUpdate: 0,
  });
});

test('one read-timeout recovery defers an already queued Auto-sync upload and still scans', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const owner = Reflect.get(coordinator, 'operationOwner') as InstanceType<
    typeof SerializedDriveOperationOwner
  >;
  const activeRead = await owner.begin();
  const documentId = 'queued-dirty-paper';
  const dirtyState = {
    documentId,
    dirtyReasons: ['notes'],
    cloudPresence: 'present',
  };
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'queued-upload-device',
    deviceLabel: 'Queued upload device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'verified-root',
  });
  Reflect.set(coordinator, 'paperStates', new Map([[documentId, dirtyState]]));
  Reflect.set(coordinator, 'blockingPaperIssues', new Map());
  Reflect.set(coordinator, 'initialize', async () => undefined);
  Reflect.set(coordinator, 'flushPersistenceChanges', async () => undefined);
  Reflect.set(coordinator, 'waitForLocalRemovalSettlement', async () => undefined);
  Object.assign(coordinator.getSnapshot(), {
    connection: 'syncing',
    deviceModeChoiceConfirmed: true,
    dirtyPaperIds: [documentId],
    papers: [],
    paperStates: [dirtyState],
  });

  let ordinaryRepositoryCalls = 0;
  Reflect.set(coordinator, 'ensureRepository', async () => {
    ordinaryRepositoryCalls += 1;
    throw new Error('queued upload reached the ordinary repository');
  });
  const queuedUpload = coordinator.uploadSelected([documentId]);
  for (
    let attempt = 0;
    attempt < 20 && Reflect.get(owner, 'outstandingOperations') !== 2;
    attempt += 1
  ) {
    await Promise.resolve();
  }
  assert.equal(Reflect.get(owner, 'outstandingOperations'), 2);

  const timeoutIssue = classifyPaperCoordinatorError(
    new DriveOperationTimeoutError('scan', 90_000, false),
  );
  Object.assign(coordinator.getSnapshot(), {
    connection: 'offline',
    issue: timeoutIssue,
    error: timeoutIssue.message,
  });

  const recoverySignal = new AbortController().signal;
  let strictScans = 0;
  Reflect.set(coordinator, 'beginOperation', async (operationType: string) => {
    assert.equal(operationType, 'scan');
    return recoverySignal;
  });
  Reflect.set(coordinator, 'endOperation', () => undefined);
  Reflect.set(coordinator, 'ensureVerifiedRepositoryReadOnly', async () => ({
    rootFolderId: 'verified-root',
  }));
  Reflect.set(coordinator, 'requireWorkspaceLease', () => ({}));
  Reflect.set(coordinator, 'reconcileLocalPaperStates', async () => undefined);
  Reflect.set(
    coordinator,
    'discoverWithFastPath',
    async (
      _repository: unknown,
      _signal: AbortSignal,
      _workspaceLease: unknown,
      strictReadOnly: boolean,
    ) => {
      assert.equal(strictReadOnly, true);
      strictScans += 1;
    },
  );
  let autoUploadSchedules = 0;
  Reflect.set(coordinator, 'scheduleAutoUpload', () => {
    autoUploadSchedules += 1;
  });

  const recover = (
    Reflect.get(
      coordinator,
      'scanCloudPapersUsingVerifiedRepository',
    ) as () => Promise<void>
  ).call(coordinator);
  const handleOnline = Reflect.get(coordinator, 'handleOnline') as () => void;
  handleOnline();
  handleOnline();
  owner.end(activeRead);
  await Promise.all([queuedUpload, recover]);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ordinaryRepositoryCalls, 0);
  assert.equal(strictScans, 1);
  assert.deepEqual(dirtyState.dirtyReasons, ['notes']);
  assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [documentId]);
  assert.equal(coordinator.getSnapshot().connection, 'connected');
  assert.equal(coordinator.getSnapshot().issue, undefined);
  assert.equal(autoUploadSchedules, 0);
  assert.equal(Reflect.get(owner, 'outstandingOperations'), 0);
});

test('Drive watchdog exits syncing immediately and distinguishes read timeout from uncertain mutation', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const callbacks = new Map<number, () => void>();
  let timerSequence = 0;
  let now = 10_000;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    assert.equal(typeof callback, 'function');
    timerSequence += 1;
    callbacks.set(timerSequence, callback as () => void);
    return timerSequence;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    callbacks.delete(Number(timer));
  }) as typeof clearTimeout;

  try {
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    const owner = Reflect.get(coordinator, 'operationOwner') as InstanceType<
      typeof SerializedDriveOperationOwner
    >;
    const startWatchdog = Reflect.get(coordinator, 'startDriveOperationWatchdog') as (
      signal: AbortSignal,
      operationType: 'scan' | 'upload',
      mayHaveMutated?: boolean,
      timeoutVisibility?: 'global' | 'diagnostic-only',
    ) => void;
    const markRunning = Reflect.get(coordinator, 'markDriveOperationRunning') as (
      signal: AbortSignal,
    ) => void;
    const updateRequestActivity = Reflect.get(
      coordinator,
      'updateDriveRequestActivity',
    ) as (activity: {
      pendingRequestCount: number;
      completedRequestCount: number;
    }) => void;
    const endOperation = Reflect.get(coordinator, 'endOperation') as (
      signal: AbortSignal,
    ) => void;

    const readSignal = await owner.begin();
    startWatchdog.call(coordinator, readSignal, 'scan');
    assert.deepEqual(coordinator.getSnapshot().activeDriveOperation, {
      operationType: 'scan',
      stage: 'admission',
      startedAt: coordinator.getSnapshot().activeDriveOperation?.startedAt,
      deadlineAt: coordinator.getSnapshot().activeDriveOperation?.deadlineAt,
      pendingRequestCount: 0,
      completedRequestCount: 0,
    });
    assert.equal(
      coordinator.getSnapshot().activeDriveOperation!.deadlineAt -
        coordinator.getSnapshot().activeDriveOperation!.startedAt,
      90_000,
    );
    const staleAdmissionTimer = callbacks.get(1)!;
    markRunning.call(coordinator, readSignal);
    assert.equal(callbacks.has(1), false);
    assert.equal(callbacks.has(2), true);
    staleAdmissionTimer();
    assert.equal(readSignal.aborted, false);
    const staleRunningTimer = callbacks.get(2)!;
    Reflect.set(coordinator, 'activeDriveOperationIdentityFence', {
      signal: readSignal,
      workspaceLeaseHandle: { release() {} },
    });
    now += 60_000;
    updateRequestActivity.call(coordinator, {
      pendingRequestCount: 4,
      completedRequestCount: 1,
    });
    assert.equal(callbacks.has(2), false);
    assert.equal(callbacks.has(3), true);
    assert.equal(
      coordinator.getSnapshot().activeDriveOperation?.deadlineAt,
      now + 90_000,
    );
    const progressDeadline = coordinator.getSnapshot().activeDriveOperation?.deadlineAt;
    const activeProgressTimer = callbacks.get(3)!;
    now += 30_000;
    updateRequestActivity.call(coordinator, {
      pendingRequestCount: 5,
      completedRequestCount: 1,
    });
    assert.equal(
      coordinator.getSnapshot().activeDriveOperation?.deadlineAt,
      progressDeadline,
    );
    assert.equal(callbacks.get(3), activeProgressTimer);
    staleRunningTimer();
    assert.equal(readSignal.aborted, false);
    Reflect.set(coordinator, 'drive', {
      recordOperationStateTransition() {},
      finishOperationTelemetry() {
        return {
          operationId: 'drive-operation-synthetic-timeout',
          operationType: 'scan',
          startedAtMs: 0,
          endedAtMs: 90_000,
          events: [
            {
              phase: 'read-timeout-recovery-root-validation',
              operation: 'get',
              requestCategory: 'get',
              method: 'GET',
              attempt: 1,
              retryCount: 0,
              outcome: 'network-error',
              elapsedMs: 90_000,
              startedAtMs: 0,
              endedAtMs: 90_000,
              relativeStartMs: 0,
              relativeEndMs: 90_000,
              parallelWave: 1,
              bytesTransferred: 0,
            },
          ],
          phaseSpans: [],
          stateTransitions: [],
          operationRetryCount: 0,
        };
      },
    });
    const telemetryIds = Reflect.get(coordinator, 'operationTelemetryIds') as WeakMap<
      AbortSignal,
      string
    >;
    telemetryIds.set(readSignal, 'drive-operation-synthetic-timeout');
    callbacks.set(99, () => assert.fail('stale Auto-sync timer must be cancelled'));
    Reflect.set(coordinator, 'autoUploadTimer', 99);
    assert.equal(coordinator.getSnapshot().activeDriveOperation?.stage, 'running');
    callbacks.get(3)?.();
    assert.equal(readSignal.aborted, true);
    assert.ok(readSignal.reason instanceof DriveOperationTimeoutError);
    assert.equal(coordinator.getSnapshot().activeDriveOperation?.stage, 'timed-out');
    assert.equal(coordinator.getSnapshot().connection, 'offline');
    assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
    assert.equal(coordinator.getSnapshot().issue?.code, 'drive-operation-timeout');
    assert.equal(Reflect.get(coordinator, 'autoUploadTimer'), null);
    assert.equal(callbacks.has(99), false);
    // Ownership is deliberately retained until the real task settles. A
    // timeout never creates a second concurrent Drive operation.
    assert.equal(owner.active, true);
    assert.deepEqual(coordinator.getSnapshot().lastDriveOperationTimeout, {
      operationType: 'scan',
      timedOutFromStage: 'running',
      failureCode: 'drive-request-in-flight-deadline-exceeded',
      timedOutAt: coordinator.getSnapshot().lastDriveOperationTimeout?.timedOutAt,
      pendingRequestCount: 5,
      completedRequestCount: 1,
      observedPhases: [],
    });
    const readIssue = classifyPaperCoordinatorError(readSignal.reason);
    assert.equal(readIssue.code, 'drive-operation-timeout');
    assert.equal(readIssue.retrySafe, true);
    assert.equal(readIssue.blocksOrdinarySync, false);
    assert.equal(readIssue.diagnostic.causeCode, 'deadline-exceeded');
    endOperation.call(coordinator, readSignal);
    assert.equal(owner.active, false);
    assert.equal(coordinator.getSnapshot().activeDriveOperation, undefined);
    assert.deepEqual(coordinator.getSnapshot().lastDriveOperationTimeout, {
      operationType: 'scan',
      timedOutFromStage: 'running',
      failureCode: 'drive-request-in-flight-deadline-exceeded',
      timedOutAt: coordinator.getSnapshot().lastDriveOperationTimeout?.timedOutAt,
      pendingRequestCount: 5,
      completedRequestCount: 1,
      observedPhases: [
        {
          phase: 'read-timeout-recovery-root-validation',
          elapsedMs: 90_000,
          requestCount: 1,
          retryCount: 0,
        },
      ],
    });

    const mutationSignal = await owner.begin();
    startWatchdog.call(coordinator, mutationSignal, 'upload');
    callbacks.get(4)?.();
    assert.equal(mutationSignal.aborted, true);
    assert.ok(mutationSignal.reason instanceof DriveOperationTimeoutError);
    assert.equal(coordinator.getSnapshot().activeDriveOperation?.stage, 'timed-out');
    assert.equal(coordinator.getSnapshot().connection, 'attention');
    assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
    assert.equal(coordinator.getSnapshot().issue?.code, 'drive-mutation-uncertain');
    assert.equal(owner.active, true);
    assert.equal(
      coordinator.getSnapshot().lastDriveOperationTimeout?.failureCode,
      'admission-deadline-exceeded',
    );
    const mutationIssue = classifyPaperCoordinatorError(mutationSignal.reason);
    assert.equal(mutationIssue.code, 'drive-mutation-uncertain');
    assert.equal(mutationIssue.retrySafe, false);
    assert.equal(mutationIssue.blocksOrdinarySync, true);
    assert.equal(
      mutationIssue.diagnostic.causeCode,
      'deadline-exceeded-remote-outcome-unknown',
    );
    assert.match(mutationIssue.message, /did not mark it successful/u);
    assert.equal(driveOperationTimeoutMs('upload'), 5 * 60_000);
    assert.equal(driveOperationTimeoutMs('housekeeping', false), 90_000);
    assert.equal(driveOperationTimeoutMs('housekeeping', true), 5 * 60_000);
    assert.equal(
      classifyPaperCoordinatorError(
        new DriveOperationTimeoutError('housekeeping', 90_000, false),
      ).code,
      'drive-operation-timeout',
    );
    endOperation.call(coordinator, mutationSignal);
    assert.equal(owner.active, false);
    assert.equal(coordinator.getSnapshot().activeDriveOperation, undefined);

    Object.assign(coordinator.getSnapshot(), {
      connection: 'connected',
      issue: undefined,
      error: undefined,
      progress: { phase: 'idle' },
    });
    const diagnosticSignal = await owner.begin();
    startWatchdog.call(coordinator, diagnosticSignal, 'scan', false, 'diagnostic-only');
    markRunning.call(coordinator, diagnosticSignal);
    callbacks.get(6)?.();
    assert.equal(diagnosticSignal.aborted, true);
    assert.ok(diagnosticSignal.reason instanceof DriveOperationTimeoutError);
    assert.equal(coordinator.getSnapshot().activeDriveOperation?.stage, 'timed-out');
    assert.equal(coordinator.getSnapshot().connection, 'connected');
    assert.equal(coordinator.getSnapshot().issue, undefined);
    assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
    assert.equal(owner.active, true);
    assert.equal(
      coordinator.getSnapshot().lastDriveOperationTimeout?.failureCode,
      'running-without-request-in-flight-deadline-exceeded',
    );
    endOperation.call(coordinator, diagnosticSignal);
    assert.equal(owner.active, false);
    assert.equal(coordinator.getSnapshot().activeDriveOperation, undefined);

    const stalled = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(stalled, 'profile', {
      id: 'paper-device',
      deviceId: 'deadline-device',
      deviceLabel: 'Deadline test device',
      deviceMode: 'personal',
      deviceModeChoiceConfirmed: true,
      autoSync: false,
      accountId: 'account-a',
      workspaceAccountId: 'account-a',
    });
    Reflect.set(stalled, 'identity', {
      hasDeviceSession: true,
      accountId: 'account-a',
    });
    stalled.getSnapshot().deviceModeChoiceConfirmed = true;
    Reflect.set(
      stalled,
      'revalidateOperationWorkspaceAccount',
      () => new Promise<void>(() => undefined),
    );
    const stalledBegin = Reflect.get(stalled, 'beginOperation') as (
      operationType: 'scan',
    ) => Promise<AbortSignal>;
    const stalledAttempt = stalledBegin.call(stalled, 'scan');
    for (let attempt = 0; attempt < 10 && !callbacks.has(7); attempt += 1) {
      await Promise.resolve();
    }
    assert.ok(callbacks.has(7));
    callbacks.get(7)?.();
    await assert.rejects(
      stalledAttempt,
      (error: unknown) => error instanceof DriveOperationTimeoutError,
    );
    const stalledOwner = Reflect.get(stalled, 'operationOwner') as InstanceType<
      typeof SerializedDriveOperationOwner
    >;
    assert.equal(stalledOwner.active, false);
    assert.equal(stalled.getSnapshot().activeDriveOperation, undefined);
    assert.equal(
      stalled.getSnapshot().lastDriveOperationTimeout?.failureCode,
      'admission-deadline-exceeded',
    );
    assert.equal(
      stalled.getSnapshot().lastDriveOperationTimeout?.timedOutFromStage,
      'admission',
    );
    const clearDiagnostics = Reflect.get(
      stalled,
      'clearDriveOperationDiagnostics',
    ) as () => void;
    clearDiagnostics.call(stalled);
    assert.equal(stalled.getSnapshot().lastDriveOperationTimeout, undefined);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('read watchdog has a five-minute hard cap even while requests keep completing', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const callbacks = new Map<number, () => void>();
  let timerSequence = 0;
  let now = 1_000;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    assert.equal(typeof callback, 'function');
    timerSequence += 1;
    callbacks.set(timerSequence, callback as () => void);
    return timerSequence;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    callbacks.delete(Number(timer));
  }) as typeof clearTimeout;

  try {
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    const owner = Reflect.get(coordinator, 'operationOwner') as InstanceType<
      typeof SerializedDriveOperationOwner
    >;
    const signal = await owner.begin();
    const startWatchdog = Reflect.get(coordinator, 'startDriveOperationWatchdog') as (
      signal: AbortSignal,
      operationType: 'scan',
    ) => void;
    const markRunning = Reflect.get(coordinator, 'markDriveOperationRunning') as (
      signal: AbortSignal,
    ) => void;
    const updateRequestActivity = Reflect.get(
      coordinator,
      'updateDriveRequestActivity',
    ) as (activity: {
      pendingRequestCount: number;
      completedRequestCount: number;
    }) => void;
    const endOperation = Reflect.get(coordinator, 'endOperation') as (
      signal: AbortSignal,
    ) => void;

    startWatchdog.call(coordinator, signal, 'scan');
    markRunning.call(coordinator, signal);
    Reflect.set(coordinator, 'activeDriveOperationIdentityFence', {
      signal,
      workspaceLeaseHandle: { release() {} },
    });
    for (const [elapsed, completed] of [
      [80_000, 1],
      [160_000, 2],
      [240_000, 3],
      [299_000, 4],
    ] as const) {
      now = 1_000 + elapsed;
      updateRequestActivity.call(coordinator, {
        pendingRequestCount: 4,
        completedRequestCount: completed,
      });
      assert.equal(signal.aborted, false);
    }
    assert.equal(
      coordinator.getSnapshot().activeDriveOperation?.deadlineAt,
      1_000 + 5 * 60_000,
    );
    const activeTimerId = Math.max(...callbacks.keys());
    callbacks.get(activeTimerId)?.();
    assert.equal(signal.aborted, true);
    assert.equal(
      coordinator.getSnapshot().lastDriveOperationTimeout?.failureCode,
      'read-operation-hard-deadline-exceeded',
    );
    assert.equal(
      coordinator.getSnapshot().lastDriveOperationTimeout?.completedRequestCount,
      4,
    );
    endOperation.call(coordinator, signal);
    assert.equal(owner.active, false);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('an aborted scan rejects late success or integrity failure without replacing timeout state', async () => {
  for (const settlement of ['resolve', 'integrity-error'] as const) {
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    const controller = new AbortController();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const profile = {
      id: 'paper-device',
      deviceId: 'late-settlement-device',
      deviceLabel: 'Late settlement device',
      deviceMode: 'personal',
      deviceModeChoiceConfirmed: true,
      autoSync: false,
      accountId: 'account-a',
      workspaceAccountId: 'account-a',
      rootFolderId: 'root-a',
    };
    Reflect.set(coordinator, 'profile', profile);
    Reflect.set(coordinator, 'beginOperation', async () => controller.signal);
    Reflect.set(coordinator, 'ensureRepository', async () => ({}));
    Reflect.set(coordinator, 'requireWorkspaceLease', () => ({}));
    Reflect.set(coordinator, 'reconcileLocalPaperStates', async () => undefined);
    Reflect.set(coordinator, 'discoverWithFastPath', async () => {
      entered.resolve();
      return gate.promise;
    });
    Reflect.set(coordinator, 'endOperation', () => undefined);
    let markedPaperFailures = 0;
    Reflect.set(coordinator, 'markPaperFailure', async () => {
      markedPaperFailures += 1;
      throw new Error('markPaperFailure must not run after timeout');
    });
    const scanCloudPapersOwned = Reflect.get(coordinator, 'scanCloudPapersOwned') as (
      waitForBatch: boolean,
    ) => Promise<void>;
    const attempt = scanCloudPapersOwned.call(coordinator, false);
    await entered.promise;
    const timeout = new DriveOperationTimeoutError('scan', 90_000, false);
    controller.abort(timeout);
    if (settlement === 'resolve') gate.resolve();
    else {
      gate.reject(
        new PaperManifestIntegrityError(
          'Synthetic late manifest failure.',
          'late-paper',
        ),
      );
    }
    await assert.rejects(attempt, (error: unknown) => error === timeout);
    assert.equal(markedPaperFailures, 0);
    assert.equal(coordinator.getSnapshot().connection, 'offline');
    assert.equal(coordinator.getSnapshot().issue?.code, 'drive-operation-timeout');
    assert.equal(coordinator.getSnapshot().progress.phase, 'idle');
  }
});

test('coordinator teardown waits for retained tasks and blocks new commands', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const operations = retainedOperations(coordinator);
  const owner = Reflect.get(coordinator, 'operationOwner') as InstanceType<
    typeof SerializedDriveOperationOwner
  >;
  let ownedSignal: AbortSignal | undefined;
  let confirmAbort!: () => void;
  const abortObserved = new Promise<void>((resolve) => {
    confirmAbort = resolve;
  });
  let finishOwned!: () => void;
  const finishGate = new Promise<void>((resolve) => {
    finishOwned = resolve;
  });
  const operation = operations
    .retainPaperOperation('remove', ['paper-a'], async () => {
      const signal = await owner.begin();
      ownedSignal = signal;
      try {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        confirmAbort();
        await finishGate;
        throw signal.reason;
      } finally {
        owner.end(signal);
      }
    })
    .then(
      () => null,
      (error: unknown) => error,
    );
  for (let attempt = 0; attempt < 20 && !ownedSignal; attempt += 1) {
    await Promise.resolve();
  }
  assert.ok(ownedSignal);

  let teardownRan = false;
  const quiesce = Reflect.get(coordinator, 'withDriveOperationsQuiesced') as <T>(
    reason: DOMException,
    task: () => Promise<T>,
  ) => Promise<T>;
  const teardown = quiesce.call(
    coordinator,
    new DOMException('Disconnecting.', 'AbortError'),
    async () => {
      teardownRan = true;
    },
  );
  const rejectedDuringTeardown = operations
    .retainPaperOperation('upload', ['paper-b'], async () => undefined)
    .then(
      () => null,
      (error: unknown) => error,
    );

  await abortObserved;
  assert.equal(teardownRan, false);
  finishOwned();
  assert.match(String(await operation), /Disconnecting/u);
  assert.match(String(await rejectedDuringTeardown), /session is closing/u);
  await teardown;
  assert.equal(teardownRan, true);
  assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
});

test('owner telemetry classifies same-tick FIFO contention as queued', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'telemetry-device',
    deviceLabel: 'Telemetry test device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
  });
  Reflect.set(coordinator, 'identity', {
    hasDeviceSession: true,
    accountId: 'account-a',
  });
  let accountRevalidations = 0;
  Reflect.set(
    coordinator,
    'revalidateOperationWorkspaceAccount',
    async (accountId: string, operationType: string) => {
      accountRevalidations += 1;
      assert.equal(accountId, 'account-a');
      assert.equal(operationType, 'scan');
    },
  );
  Reflect.set(coordinator, 'assertWorkspaceMutationAdmission', async () => {});
  coordinator.getSnapshot().deviceModeChoiceConfirmed = true;
  const transitions: Array<{ classification?: string }> = [];
  let operationSequence = 0;
  Reflect.set(coordinator, 'drive', {
    beginOperationTelemetry() {
      operationSequence += 1;
      return `operation-${operationSequence}`;
    },
    finishOperationTelemetry() {
      return undefined;
    },
    recordOperationStateTransition(event: { classification?: string }) {
      transitions.push(event);
    },
  });
  const beginOperation = Reflect.get(coordinator, 'beginOperation') as (
    operationType: 'scan',
  ) => Promise<AbortSignal>;
  const endOperation = Reflect.get(coordinator, 'endOperation') as (
    signal: AbortSignal,
  ) => void;

  const firstAttempt = beginOperation.call(coordinator, 'scan');
  const secondAttempt = beginOperation.call(coordinator, 'scan');
  const first = await firstAttempt;
  assert.equal(accountRevalidations, 2);
  assert.equal(transitions[0]?.classification, 'immediate');

  let secondAcquired = false;
  void secondAttempt.then(() => {
    secondAcquired = true;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);
  assert.equal(accountRevalidations, 2);

  endOperation.call(coordinator, first);
  const second = await secondAttempt;
  assert.equal(accountRevalidations, 4);
  assert.equal(transitions[2]?.classification, 'queued');
  endOperation.call(coordinator, second);
});

test('restore admission failure prevents Drive setup and releases FIFO ownership', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'restore-admission-device',
    deviceLabel: 'Restore admission test device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
  });
  Reflect.set(coordinator, 'identity', {
    hasDeviceSession: true,
    accountId: 'account-a',
  });
  coordinator.getSnapshot().deviceModeChoiceConfirmed = true;

  let accountRevalidations = 0;
  Reflect.set(coordinator, 'revalidateOperationWorkspaceAccount', async () => {
    accountRevalidations += 1;
  });
  const restoreBarrier = new Error('synthetic restore admission barrier');
  let admissionChecks = 0;
  Reflect.set(coordinator, 'assertWorkspaceMutationAdmission', async () => {
    admissionChecks += 1;
    throw restoreBarrier;
  });
  let telemetryStarts = 0;
  Reflect.set(coordinator, 'drive', {
    beginOperationTelemetry() {
      telemetryStarts += 1;
      return 'operation-after-admission';
    },
    finishOperationTelemetry() {
      return undefined;
    },
    recordOperationStateTransition() {},
  });

  const beginOperation = Reflect.get(coordinator, 'beginOperation') as (
    operationType: 'upload',
  ) => Promise<AbortSignal>;
  const endOperation = Reflect.get(coordinator, 'endOperation') as (
    signal: AbortSignal,
  ) => void;
  const owner = Reflect.get(coordinator, 'operationOwner') as InstanceType<
    typeof SerializedDriveOperationOwner
  >;

  await assert.rejects(beginOperation.call(coordinator, 'upload'), restoreBarrier);
  assert.equal(admissionChecks, 1);
  assert.equal(accountRevalidations, 1);
  assert.equal(telemetryStarts, 0);
  assert.equal(owner.active, false);

  Reflect.set(coordinator, 'assertWorkspaceMutationAdmission', async () => {
    admissionChecks += 1;
  });
  const admitted = await beginOperation.call(coordinator, 'upload');
  assert.equal(admissionChecks, 2);
  assert.equal(accountRevalidations, 3);
  assert.equal(telemetryStarts, 1);
  endOperation.call(coordinator, admitted);
  assert.equal(owner.active, false);
});

test('Drive operation retains shared restore ownership until endOperation settles', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  Reflect.set(coordinator, 'profile', {
    id: 'paper-device',
    deviceId: 'operation-lifetime-device',
    deviceLabel: 'Operation lifetime test device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
  });
  Reflect.set(coordinator, 'identity', {
    hasDeviceSession: true,
    accountId: 'account-a',
  });
  Reflect.set(coordinator, 'revalidateOperationWorkspaceAccount', async () => {});
  Reflect.set(coordinator, 'assertWorkspaceMutationAdmission', async () => {});
  coordinator.getSnapshot().deviceModeChoiceConfirmed = true;
  Reflect.set(coordinator, 'drive', {
    beginOperationTelemetry: () => 'operation-with-shared-lease',
    finishOperationTelemetry: () => undefined,
    recordOperationStateTransition() {},
  });
  const beginOperation = Reflect.get(coordinator, 'beginOperation') as (
    operationType: 'download',
  ) => Promise<AbortSignal>;
  const endOperation = Reflect.get(coordinator, 'endOperation') as (
    signal: AbortSignal,
  ) => void;

  const signal = await beginOperation.call(coordinator, 'download');
  let restoreEntered = false;
  const restore = withExclusiveWorkspaceRestoreLease(() => {
    restoreEntered = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(restoreEntered, false);

  endOperation.call(coordinator, signal);
  await restore;
  assert.equal(restoreEntered, true);
});

test('manual Upload, Retry, Auto-sync, and online reconnect all stop at restore admission', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  const scheduledCallbacks: Array<() => void> = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearTimeout() {},
      setTimeout(callback: () => void) {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      },
    },
  });
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value: true,
  });

  const createBlockedCoordinator = (autoSync: boolean) => {
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    const profile = {
      id: 'paper-device',
      deviceId: 'restore-route-device',
      deviceLabel: 'Restore route test device',
      deviceMode: 'personal' as const,
      deviceModeChoiceConfirmed: true,
      autoSync,
      accountId: 'account-a',
      workspaceAccountId: 'account-a',
    };
    const state = {
      documentId: 'paper-a',
      deviceId: profile.deviceId,
      availability: 'local-only',
      status: 'local-changes',
      dirtyGeneration: 1,
      dirtyReasons: ['metadata'],
      entityVersions: {},
      baselineHashes: {},
      tombstones: [],
      conflicts: [],
      incorporatedHeadIds: [],
      remoteHeadIds: [],
      pdfFingerprints: {},
      driveFiles: { fileIds: {} },
    };
    const admission = deferred<void>();
    const barrier = new Error('synthetic durable restore barrier');
    const counters = { admission: 0, repository: 0, telemetry: 0 };
    Reflect.set(coordinator, 'profile', profile);
    Reflect.set(coordinator, 'identity', {
      hasDeviceSession: true,
      accountId: 'account-a',
    });
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'paperStates', new Map([[state.documentId, state]]));
    Reflect.set(coordinator, 'flushPersistenceChanges', async () => {});
    Reflect.set(coordinator, 'revalidateOperationWorkspaceAccount', async () => {});
    Reflect.set(coordinator, 'assertWorkspaceMutationAdmission', async () => {
      counters.admission += 1;
      admission.resolve(undefined);
      throw barrier;
    });
    Reflect.set(coordinator, 'ensureRepository', async () => {
      counters.repository += 1;
      throw new Error('repository work must not begin behind the restore barrier');
    });
    Reflect.set(coordinator, 'drive', {
      beginOperationTelemetry() {
        counters.telemetry += 1;
        return 'must-not-start';
      },
      finishOperationTelemetry: () => undefined,
      recordOperationStateTransition() {},
    });
    Object.assign(coordinator.getSnapshot(), {
      autoSync,
      connection: 'connected',
      deviceModeChoiceConfirmed: true,
      securityState: undefined,
    });
    return { admission, barrier, coordinator, counters, profile };
  };

  try {
    const manual = createBlockedCoordinator(false);
    await assert.rejects(
      manual.coordinator.uploadSelected(['paper-a']),
      manual.barrier,
    );
    assert.deepEqual(manual.counters, { admission: 1, repository: 0, telemetry: 0 });

    const retry = createBlockedCoordinator(false);
    Reflect.set(
      retry.coordinator,
      'paperRetryIntents',
      new Map([['paper-a', 'upload']]),
    );
    await assert.rejects(retry.coordinator.retryNow(), retry.barrier);
    assert.deepEqual(retry.counters, { admission: 1, repository: 0, telemetry: 0 });

    const automatic = createBlockedCoordinator(true);
    const scheduleAutoUpload = Reflect.get(
      automatic.coordinator,
      'scheduleAutoUpload',
    ) as (delay?: number) => void;
    scheduleAutoUpload.call(automatic.coordinator, 0);
    const automaticCallback = scheduledCallbacks.shift();
    assert.ok(automaticCallback);
    automaticCallback();
    await automatic.admission.promise;
    const automaticTasks = Reflect.get(
      automatic.coordinator,
      'activePaperOperationTasks',
    ) as Map<string, { promise: Promise<unknown> }>;
    await Promise.allSettled(
      [...automaticTasks.values()].map(({ promise }) => promise),
    );
    await Promise.resolve();
    assert.deepEqual(automatic.counters, {
      admission: 1,
      repository: 0,
      telemetry: 0,
    });
    assert.equal(automatic.profile.autoSync, true);

    const reconnect = createBlockedCoordinator(true);
    const handleOnline = Reflect.get(
      reconnect.coordinator,
      'handleOnline',
    ) as () => void;
    handleOnline();
    await reconnect.admission.promise;
    const reconnectScan = Reflect.get(
      reconnect.coordinator,
      'scanPromise',
    ) as Promise<void>;
    await reconnectScan.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(reconnect.counters, {
      admission: 1,
      repository: 0,
      telemetry: 0,
    });
    assert.equal(reconnect.profile.autoSync, true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline);
    else Reflect.deleteProperty(navigator, 'onLine');
  }
});

test('Home views only subscribe and render coordinator-owned operation state', () => {
  const coordinator = source('../src/sync/paperCoordinator.ts');
  const library = source('../src/components/LibraryPanel.tsx');
  const driveUi = source('../src/sync/PaperSyncControl.tsx');

  for (const type of [
    'download',
    'upload',
    'remove',
    'restore',
    'keep-local',
  ] as const) {
    assert.match(coordinator, new RegExp(`retainPaperOperation\\('${type}'`, 'u'));
  }
  assert.doesNotMatch(coordinator, /batchPromise|downloadBatchPromise/u);
  assert.match(library, /syncState\.activePaperOperations/u);
  assert.match(library, /operations\[documentId\] \?\?= operation\.type/u);
  assert.doesNotMatch(library, /setCloudOperations/u);
  assert.match(library, /return unsubscribe/u);
  assert.doesNotMatch(
    library.slice(
      library.indexOf('const unsubscribe = syncCoordinator.subscribe'),
      library.indexOf(
        'useEffect',
        library.indexOf('const unsubscribe = syncCoordinator.subscribe') + 1,
      ),
    ),
    /cancel|destroy/u,
  );
  assert.match(driveUi, /activePaperOperations: \[\]/u);
  assert.doesNotMatch(driveUi, /return \(\) => coordinator\.(?:cancel|destroy)/u);
});

test('Drive Home remount renders the retained coordinator snapshot immediately', () => {
  const driveUi = source('../src/sync/PaperSyncControl.tsx');
  const homePage = driveUi.slice(
    driveUi.indexOf('export function PaperSyncHomePage('),
    driveUi.indexOf('\nexport function PaperRemoteUpdateLayer('),
  );

  assert.match(
    homePage,
    /useState<PaperSyncViewState>\(\(\) =>\s*coordinator\.getSnapshot\(\),?\s*\)/u,
  );
  assert.doesNotMatch(homePage, /useState\(initialPaperSyncViewState\)/u);
});
