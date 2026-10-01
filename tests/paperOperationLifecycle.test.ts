import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type {
  PaperActiveOperationType,
  PaperSyncViewState,
} from '../src/sync/paperCoordinator.ts';

let server: ViteDevServer;
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let SerializedDriveOperationOwner: (typeof import('../src/sync/paperCoordinator.ts'))['SerializedDriveOperationOwner'];

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
  assert.equal(transitions[0]?.classification, 'immediate');

  let secondAcquired = false;
  void secondAttempt.then(() => {
    secondAcquired = true;
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);

  endOperation.call(coordinator, first);
  const second = await secondAttempt;
  assert.equal(transitions[2]?.classification, 'queued');
  endOperation.call(coordinator, second);
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
