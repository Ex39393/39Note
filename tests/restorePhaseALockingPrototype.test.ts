import assert from 'node:assert/strict';
import test from 'node:test';

type LockMode = 'exclusive' | 'shared';
type RestorePhase =
  'preparing' | 'applying' | 'verifying' | 'recovery-required' | 'publication-hold';

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

interface DurableBarrier {
  operationId: string;
  workspaceId: string;
  phase: RestorePhase;
  generation: number;
  createdAt: string;
  recoveryRequired: boolean;
  publicationHold: boolean;
}

interface PendingLockRequest {
  callback(): Promise<unknown>;
  label: string;
  mode: LockMode;
  reject(reason?: unknown): void;
  resolve(value: unknown): void;
}

interface RestoreHooks {
  afterBarrierCreated?(barrier: DurableBarrier): Promise<void> | void;
  afterExclusiveAdmission?(): Promise<void> | void;
}

class BarrierActiveError extends Error {
  readonly barrier: DurableBarrier;

  constructor(barrier: DurableBarrier) {
    super(`Restore barrier ${barrier.operationId} is ${barrier.phase}.`);
    this.name = 'BarrierActiveError';
    this.barrier = barrier;
  }
}

class BarrierOwnershipError extends Error {
  constructor() {
    super('Restore barrier ownership or generation did not match.');
    this.name = 'BarrierOwnershipError';
  }
}

class WebLocksUnavailableError extends Error {
  constructor() {
    super('Workspace writes fail closed without Web Locks support.');
    this.name = 'WebLocksUnavailableError';
  }
}

class SimulatedTabClosedError extends Error {
  constructor() {
    super('The synthetic tab closed.');
    this.name = 'SimulatedTabClosedError';
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

class DeterministicWorkspaceLockManager {
  private activeExclusive = false;
  private activeShared = 0;
  private readonly queue: PendingLockRequest[] = [];
  private readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  get pendingLabels(): string[] {
    return this.queue.map(({ label }) => label);
  }

  get snapshot(): { exclusive: boolean; shared: number } {
    return { exclusive: this.activeExclusive, shared: this.activeShared };
  }

  request<T>(
    mode: LockMode,
    label: string,
    callback: () => Promise<T> | T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        callback: async () => callback(),
        label,
        mode,
        reject,
        resolve: (value) => resolve(value as T),
      });
      this.events.push(`lock:queued:${mode}:${label}`);
      this.pump();
    });
  }

  private grant(request: PendingLockRequest): void {
    if (request.mode === 'exclusive') {
      this.activeExclusive = true;
    } else {
      this.activeShared += 1;
    }
    this.events.push(`lock:acquired:${request.mode}:${request.label}`);

    void Promise.resolve()
      .then(request.callback)
      .then(
        (value) => this.finish(request, () => request.resolve(value)),
        (error: unknown) => this.finish(request, () => request.reject(error)),
      );
  }

  private finish(request: PendingLockRequest, settle: () => void): void {
    if (request.mode === 'exclusive') {
      this.activeExclusive = false;
    } else {
      this.activeShared -= 1;
    }
    this.events.push(`lock:released:${request.mode}:${request.label}`);
    this.pump();
    settle();
  }

  private pump(): void {
    if (this.activeExclusive) return;

    if (this.activeShared > 0) {
      while (this.queue[0]?.mode === 'shared') {
        const next = this.queue.shift();
        if (next) this.grant(next);
      }
      return;
    }

    const first = this.queue.shift();
    if (!first) return;
    if (first.mode === 'exclusive') {
      this.grant(first);
      return;
    }

    this.grant(first);
    while (this.queue[0]?.mode === 'shared') {
      const next = this.queue.shift();
      if (next) this.grant(next);
    }
  }
}

interface DurableState {
  barriers: Map<string, DurableBarrier>;
  lastGeneration: Map<string, number>;
}

class DurableBarrierRepository {
  private readonly durableState: DurableState;
  readonly physicalDatabaseName: string;

  constructor(durableState: DurableState, physicalDatabaseName: string) {
    this.durableState = durableState;
    this.physicalDatabaseName = physicalDatabaseName;
  }

  read(workspaceId: string): DurableBarrier | null {
    const barrier = this.durableState.barriers.get(workspaceId);
    return barrier ? { ...barrier } : null;
  }

  create(operationId: string, workspaceId: string): DurableBarrier {
    const active = this.read(workspaceId);
    if (active) throw new BarrierActiveError(active);
    const generation = (this.durableState.lastGeneration.get(workspaceId) ?? 0) + 1;
    this.durableState.lastGeneration.set(workspaceId, generation);
    const barrier: DurableBarrier = {
      operationId,
      workspaceId,
      phase: 'preparing',
      generation,
      createdAt: '2026-10-22T00:00:00.000Z',
      recoveryRequired: false,
      publicationHold: false,
    };
    this.durableState.barriers.set(workspaceId, barrier);
    return { ...barrier };
  }

  transition(
    operationId: string,
    workspaceId: string,
    expectedGeneration: number,
    patch: Partial<
      Pick<DurableBarrier, 'phase' | 'publicationHold' | 'recoveryRequired'>
    >,
  ): DurableBarrier {
    const current = this.requireOwner(operationId, workspaceId, expectedGeneration);
    const updated = { ...current, ...patch };
    this.durableState.barriers.set(workspaceId, updated);
    return { ...updated };
  }

  clear(operationId: string, workspaceId: string, expectedGeneration: number): void {
    this.requireOwner(operationId, workspaceId, expectedGeneration);
    this.durableState.barriers.delete(workspaceId);
  }

  private requireOwner(
    operationId: string,
    workspaceId: string,
    expectedGeneration: number,
  ): DurableBarrier {
    const current = this.durableState.barriers.get(workspaceId);
    if (
      !current ||
      current.operationId !== operationId ||
      current.generation !== expectedGeneration
    ) {
      throw new BarrierOwnershipError();
    }
    return current;
  }
}

class SyntheticDatabase {
  readonly records = new Map<string, string>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  get(key: string): string | undefined {
    return this.records.get(key);
  }

  put(key: string, value: string): void {
    this.records.set(key, value);
  }
}

interface SyntheticScenario {
  barriers: DurableBarrierRepository;
  docs: SyntheticDatabase;
  events: string[];
  locks: DeterministicWorkspaceLockManager;
  productivity: SyntheticDatabase;
  protocol: WorkspaceProtocol;
  state: DurableState;
  workspaceId: string;
}

interface NormalWriteOptions {
  actor: string;
  afterBarrierCheck?(barrier: null): Promise<void> | void;
  database: SyntheticDatabase;
  key: string;
  value: string;
}

class WorkspaceProtocol {
  private readonly workspaceId: string;
  private readonly barriers: DurableBarrierRepository;
  private readonly locks: DeterministicWorkspaceLockManager | null;
  private readonly events: string[];

  constructor(
    workspaceId: string,
    barriers: DurableBarrierRepository,
    locks: DeterministicWorkspaceLockManager | null,
    events: string[],
  ) {
    this.workspaceId = workspaceId;
    this.barriers = barriers;
    this.locks = locks;
    this.events = events;
  }

  normalWrite(options: NormalWriteOptions): Promise<void> {
    if (!this.locks) return Promise.reject(new WebLocksUnavailableError());

    return this.locks.request('shared', options.actor, async () => {
      const initialBarrier = this.barriers.read(this.workspaceId);
      this.events.push(
        `writer:checked:${options.actor}:${initialBarrier?.phase ?? 'clear'}`,
      );
      if (initialBarrier) throw new BarrierActiveError(initialBarrier);

      await options.afterBarrierCheck?.(null);

      // This second durable read is defense in depth. The actual serialization
      // guarantee is that every restore must hold the exclusive form of the same
      // lock before it is allowed to create or transition the barrier.
      const commitBarrier = this.barriers.read(this.workspaceId);
      if (commitBarrier) throw new BarrierActiveError(commitBarrier);
      options.database.put(options.key, options.value);
      this.events.push(`writer:committed:${options.actor}:${options.database.name}`);
    });
  }

  runRestore<T>(
    operationId: string,
    action: (barrier: DurableBarrier) => Promise<T> | T,
    options: {
      finalize?: 'clear' | 'publication-hold';
      hooks?: RestoreHooks;
    } = {},
  ): Promise<T> {
    if (!this.locks) return Promise.reject(new WebLocksUnavailableError());

    return this.locks.request('exclusive', operationId, async () => {
      await options.hooks?.afterExclusiveAdmission?.();
      const barrier = this.barriers.create(operationId, this.workspaceId);
      this.events.push(`restore:barrier-created:${operationId}:${barrier.generation}`);
      await options.hooks?.afterBarrierCreated?.(barrier);

      try {
        const result = await action(barrier);
        if (options.finalize === 'publication-hold') {
          this.barriers.transition(operationId, this.workspaceId, barrier.generation, {
            phase: 'publication-hold',
            publicationHold: true,
          });
          this.events.push(`restore:publication-hold:${operationId}`);
        } else {
          this.barriers.clear(operationId, this.workspaceId, barrier.generation);
          this.events.push(`restore:barrier-cleared:${operationId}`);
        }
        return result;
      } catch (error) {
        this.barriers.transition(operationId, this.workspaceId, barrier.generation, {
          phase: 'recovery-required',
          recoveryRequired: true,
        });
        this.events.push(`restore:recovery-required:${operationId}`);
        throw error;
      }
    });
  }
}

let scenarioSequence = 0;

function createScenario(): SyntheticScenario {
  scenarioSequence += 1;
  const suffix = `synthetic-${process.pid}-${scenarioSequence}`;
  const events: string[] = [];
  const locks = new DeterministicWorkspaceLockManager(events);
  const state: DurableState = {
    barriers: new Map(),
    lastGeneration: new Map(),
  };
  const docsName = `39note-bkp03-prototype-docs-${suffix}`;
  const barriers = new DurableBarrierRepository(state, docsName);
  const workspaceId = `workspace-${suffix}`;
  return {
    barriers,
    docs: new SyntheticDatabase(docsName),
    events,
    locks,
    productivity: new SyntheticDatabase(
      `39note-bkp03-prototype-productivity-${suffix}`,
    ),
    protocol: new WorkspaceProtocol(workspaceId, barriers, locks, events),
    state,
    workspaceId,
  };
}

function eventIndex(events: string[], prefix: string): number {
  const index = events.findIndex((event) => event.startsWith(prefix));
  assert.notEqual(
    index,
    -1,
    `Missing event with prefix ${prefix}.\n${events.join('\n')}`,
  );
  return index;
}

test('case 1: a normal write commits before exclusive restore ownership begins', async () => {
  const scenario = createScenario();
  const writerChecked = deferred<void>();
  const releaseWriter = deferred<void>();
  const restoreEntered = deferred<void>();

  const write = scenario.protocol.normalWrite({
    actor: 'reader-a',
    afterBarrierCheck: async () => {
      writerChecked.resolve(undefined);
      await releaseWriter.promise;
    },
    database: scenario.docs,
    key: 'paper-a',
    value: 'reader-state',
  });
  await writerChecked.promise;

  const restore = scenario.protocol.runRestore('restore-a', () => {
    restoreEntered.resolve(undefined);
    scenario.docs.put('paper-a', 'restored-state');
  });
  assert.deepEqual(scenario.locks.snapshot, { exclusive: false, shared: 1 });
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-a']);

  releaseWriter.resolve(undefined);
  await write;
  await restoreEntered.promise;
  await restore;

  assert.equal(scenario.docs.get('paper-a'), 'restored-state');
  assert.ok(
    eventIndex(scenario.events, 'writer:committed:reader-a') <
      eventIndex(scenario.events, 'restore:barrier-created:restore-a'),
  );
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);
});

test('case 2: restore ownership acquired first serializes a later writer', async () => {
  const scenario = createScenario();
  const restoreMutated = deferred<void>();
  const releaseRestore = deferred<void>();

  const restore = scenario.protocol.runRestore('restore-first', async () => {
    scenario.docs.put('paper-b', 'restored');
    restoreMutated.resolve(undefined);
    await releaseRestore.promise;
  });
  await restoreMutated.promise;

  const write = scenario.protocol.normalWrite({
    actor: 'reader-later',
    database: scenario.docs,
    key: 'paper-b',
    value: 'post-restore-edit',
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['reader-later']);
  assert.equal(scenario.docs.get('paper-b'), 'restored');

  releaseRestore.resolve(undefined);
  await restore;
  await write;
  assert.equal(scenario.docs.get('paper-b'), 'post-restore-edit');
  assert.ok(
    eventIndex(scenario.events, 'restore:barrier-cleared:restore-first') <
      eventIndex(scenario.events, 'writer:checked:reader-later:clear'),
  );
});

test('case 3: a checked writer holds shared ownership through commit so restore cannot overtake it', async () => {
  const scenario = createScenario();
  const writerChecked = deferred<void>();
  const allowCommit = deferred<void>();
  const restoreAdmitted = deferred<void>();

  const write = scenario.protocol.normalWrite({
    actor: 'collection-writer',
    afterBarrierCheck: async () => {
      writerChecked.resolve(undefined);
      await allowCommit.promise;
    },
    database: scenario.docs,
    key: 'collection-a',
    value: 'local-collection',
  });
  await writerChecked.promise;
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);

  const restore = scenario.protocol.runRestore(
    'restore-check-race',
    () => scenario.docs.put('collection-a', 'restored-collection'),
    {
      hooks: {
        afterExclusiveAdmission: () => restoreAdmitted.resolve(undefined),
      },
    },
  );
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-check-race']);
  assert.deepEqual(scenario.locks.snapshot, { exclusive: false, shared: 1 });

  allowCommit.resolve(undefined);
  await write;
  await restoreAdmitted.promise;
  await restore;
  assert.equal(scenario.docs.get('collection-a'), 'restored-collection');
  assert.ok(
    eventIndex(scenario.events, 'writer:committed:collection-writer') <
      eventIndex(scenario.events, 'lock:acquired:exclusive:restore-check-race'),
  );
});

test('case 4: a long-running shared writer deterministically delays restore admission', async () => {
  const scenario = createScenario();
  const writerEntered = deferred<void>();
  const writerRelease = deferred<void>();
  const restoreEntered = deferred<void>();

  const writer = scenario.protocol.normalWrite({
    actor: 'long-reader-save',
    afterBarrierCheck: async () => {
      writerEntered.resolve(undefined);
      await writerRelease.promise;
    },
    database: scenario.docs,
    key: 'paper-long',
    value: 'saved',
  });
  await writerEntered.promise;

  const restore = scenario.protocol.runRestore('restore-after-long-save', () => {
    restoreEntered.resolve(undefined);
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-after-long-save']);
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);

  writerRelease.resolve(undefined);
  await writer;
  await restoreEntered.promise;
  await restore;
  assert.equal(scenario.docs.get('paper-long'), 'saved');
});

test('case 5: multiple normal writers share ownership and restore waits for every writer', async () => {
  const scenario = createScenario();
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const firstRelease = deferred<void>();
  const secondRelease = deferred<void>();
  const restoreEntered = deferred<void>();

  const first = scenario.protocol.normalWrite({
    actor: 'reader-shared',
    afterBarrierCheck: async () => {
      firstEntered.resolve(undefined);
      await firstRelease.promise;
    },
    database: scenario.docs,
    key: 'reader',
    value: 'reader-value',
  });
  const second = scenario.protocol.normalWrite({
    actor: 'productivity-shared',
    afterBarrierCheck: async () => {
      secondEntered.resolve(undefined);
      await secondRelease.promise;
    },
    database: scenario.productivity,
    key: 'draft',
    value: 'draft-value',
  });
  await Promise.all([firstEntered.promise, secondEntered.promise]);
  assert.deepEqual(scenario.locks.snapshot, { exclusive: false, shared: 2 });

  const restore = scenario.protocol.runRestore('restore-after-shared', () => {
    restoreEntered.resolve(undefined);
  });
  firstRelease.resolve(undefined);
  await first;
  assert.deepEqual(scenario.locks.snapshot, { exclusive: false, shared: 1 });
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-after-shared']);

  secondRelease.resolve(undefined);
  await second;
  await restoreEntered.promise;
  await restore;
  assert.equal(scenario.docs.get('reader'), 'reader-value');
  assert.equal(scenario.productivity.get('draft'), 'draft-value');
});

test('case 6: two restores serialize and a retained publication barrier rejects the duplicate', async () => {
  const scenario = createScenario();
  const firstEntered = deferred<void>();
  const firstRelease = deferred<void>();

  const first = scenario.protocol.runRestore(
    'restore-owner',
    async () => {
      firstEntered.resolve(undefined);
      await firstRelease.promise;
      scenario.docs.put('paper-owner', 'first');
    },
    { finalize: 'publication-hold' },
  );
  await firstEntered.promise;

  const second = scenario.protocol.runRestore('restore-duplicate', () => {
    scenario.docs.put('paper-owner', 'second');
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-duplicate']);

  firstRelease.resolve(undefined);
  await first;
  await assert.rejects(second, BarrierActiveError);
  assert.equal(scenario.docs.get('paper-owner'), 'first');
  assert.equal(scenario.barriers.read(scenario.workspaceId)?.publicationHold, true);
  assert.ok(
    eventIndex(scenario.events, 'lock:released:exclusive:restore-owner') <
      eventIndex(scenario.events, 'lock:acquired:exclusive:restore-duplicate'),
  );
});

test('case 7: a writer that starts with a durable restore barrier fails closed', async () => {
  const scenario = createScenario();
  const barrier = scenario.barriers.create('crashed-restore', scenario.workspaceId);
  scenario.barriers.transition(
    barrier.operationId,
    scenario.workspaceId,
    barrier.generation,
    { phase: 'applying' },
  );

  await assert.rejects(
    scenario.protocol.normalWrite({
      actor: 'reader-during-barrier',
      database: scenario.docs,
      key: 'paper-c',
      value: 'unsafe',
    }),
    BarrierActiveError,
  );
  assert.equal(scenario.docs.get('paper-c'), undefined);
  assert.equal(scenario.barriers.read(scenario.workspaceId)?.phase, 'applying');
});

test('case 8: a writer queued before barrier creation rechecks after restore and is rejected', async () => {
  const scenario = createScenario();
  const blockerEntered = deferred<void>();
  const releaseBlocker = deferred<void>();
  const restoreEntered = deferred<void>();

  const blocker = scenario.protocol.normalWrite({
    actor: 'existing-shared-writer',
    afterBarrierCheck: async () => {
      blockerEntered.resolve(undefined);
      await releaseBlocker.promise;
    },
    database: scenario.docs,
    key: 'existing',
    value: 'finished-before-restore',
  });
  await blockerEntered.promise;

  const restore = scenario.protocol.runRestore(
    'queued-restore',
    () => {
      restoreEntered.resolve(undefined);
    },
    { finalize: 'publication-hold' },
  );
  const queuedWriter = scenario.protocol.normalWrite({
    actor: 'queued-before-barrier',
    database: scenario.productivity,
    key: 'print-a',
    value: 'must-not-commit',
  });
  assert.deepEqual(scenario.locks.pendingLabels, [
    'queued-restore',
    'queued-before-barrier',
  ]);

  releaseBlocker.resolve(undefined);
  await blocker;
  await restoreEntered.promise;
  await restore;
  await assert.rejects(queuedWriter, BarrierActiveError);
  assert.equal(scenario.productivity.get('print-a'), undefined);
  assert.equal(scenario.barriers.read(scenario.workspaceId)?.publicationHold, true);
});

test('case 9: a writer exception releases shared ownership and permits restore', async () => {
  const scenario = createScenario();
  const writerEntered = deferred<void>();
  const throwNow = deferred<void>();
  const restoreEntered = deferred<void>();
  const failure = new Error('synthetic writer failure');

  const writer = scenario.protocol.normalWrite({
    actor: 'throwing-writer',
    afterBarrierCheck: async () => {
      writerEntered.resolve(undefined);
      await throwNow.promise;
      throw failure;
    },
    database: scenario.docs,
    key: 'paper-throw',
    value: 'never-written',
  });
  await writerEntered.promise;
  const restore = scenario.protocol.runRestore('restore-after-throw', () => {
    restoreEntered.resolve(undefined);
    scenario.docs.put('paper-throw', 'restored');
  });

  throwNow.resolve(undefined);
  await assert.rejects(writer, failure);
  await restoreEntered.promise;
  await restore;
  assert.equal(scenario.docs.get('paper-throw'), 'restored');
  assert.deepEqual(scenario.locks.snapshot, { exclusive: false, shared: 0 });
});

test('case 10: simulated tab closure releases its shared lock and restore proceeds', async () => {
  const scenario = createScenario();
  const tabEntered = deferred<void>();
  const tabLifetime = deferred<void>();
  const restoreEntered = deferred<void>();

  const tabWrite = scenario.protocol.normalWrite({
    actor: 'closing-tab',
    afterBarrierCheck: async () => {
      tabEntered.resolve(undefined);
      await tabLifetime.promise;
    },
    database: scenario.docs,
    key: 'closing-tab-write',
    value: 'must-not-commit',
  });
  await tabEntered.promise;
  const restore = scenario.protocol.runRestore('restore-after-tab-close', () => {
    restoreEntered.resolve(undefined);
  });

  tabLifetime.reject(new SimulatedTabClosedError());
  await assert.rejects(tabWrite, SimulatedTabClosedError);
  await restoreEntered.promise;
  await restore;
  assert.equal(scenario.docs.get('closing-tab-write'), undefined);
  assert.ok(
    eventIndex(scenario.events, 'lock:released:shared:closing-tab') <
      eventIndex(scenario.events, 'lock:acquired:exclusive:restore-after-tab-close'),
  );
});

test('case 11: a stale tab may ignore BroadcastChannel yet participating lock and barrier checks still fence it', async () => {
  const scenario = createScenario();
  const restoreEntered = deferred<void>();
  const releaseRestore = deferred<void>();

  const restore = scenario.protocol.runRestore(
    'restore-broadcast-ignored',
    async () => {
      restoreEntered.resolve(undefined);
      await releaseRestore.promise;
    },
    { finalize: 'publication-hold' },
  );
  await restoreEntered.promise;

  // This actor receives no synthetic broadcast. Safety rests only on the common
  // lock protocol and durable barrier, not on a cooperative notification.
  const staleTabWrite = scenario.protocol.normalWrite({
    actor: 'stale-tab-no-broadcast',
    database: scenario.docs,
    key: 'stale-tab',
    value: 'must-not-commit',
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['stale-tab-no-broadcast']);

  releaseRestore.resolve(undefined);
  await restore;
  await assert.rejects(staleTabWrite, BarrierActiveError);
  assert.equal(scenario.docs.get('stale-tab'), undefined);
});

test('case 12: clients without Web Locks fail closed for writes and restores', async () => {
  const scenario = createScenario();
  const unsupported = new WorkspaceProtocol(
    scenario.workspaceId,
    scenario.barriers,
    null,
    scenario.events,
  );

  await assert.rejects(
    unsupported.normalWrite({
      actor: 'no-lock-writer',
      database: scenario.docs,
      key: 'unsupported',
      value: 'must-not-commit',
    }),
    WebLocksUnavailableError,
  );
  await assert.rejects(
    unsupported.runRestore('no-lock-restore', () => {
      scenario.docs.put('unsupported', 'must-not-restore');
    }),
    WebLocksUnavailableError,
  );
  assert.equal(scenario.docs.get('unsupported'), undefined);
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);
});

test('case 13: reload after restoring tab termination observes the durable recovery barrier', async () => {
  const scenario = createScenario();
  const barrierCreated = deferred<void>();
  const tabLifetime = deferred<void>();

  const restore = scenario.protocol.runRestore('restore-crashed-tab', async () => {
    barrierCreated.resolve(undefined);
    await tabLifetime.promise;
  });
  await barrierCreated.promise;

  const reloadedProtocol = new WorkspaceProtocol(
    scenario.workspaceId,
    new DurableBarrierRepository(scenario.state, scenario.docs.name),
    scenario.locks,
    scenario.events,
  );
  const writeAfterReload = reloadedProtocol.normalWrite({
    actor: 'reloaded-tab',
    database: scenario.docs,
    key: 'after-reload',
    value: 'must-not-commit',
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['reloaded-tab']);

  tabLifetime.reject(new SimulatedTabClosedError());
  await assert.rejects(restore, SimulatedTabClosedError);
  await assert.rejects(writeAfterReload, BarrierActiveError);
  assert.equal(scenario.docs.get('after-reload'), undefined);
  assert.deepEqual(scenario.barriers.read(scenario.workspaceId), {
    operationId: 'restore-crashed-tab',
    workspaceId: scenario.workspaceId,
    phase: 'recovery-required',
    generation: 1,
    createdAt: '2026-10-22T00:00:00.000Z',
    recoveryRequired: true,
    publicationHold: false,
  });
});

test('case 14: a productivity writer remains serialized although the journal is in the document database', async () => {
  const scenario = createScenario();
  const productivityChecked = deferred<void>();
  const allowProductivityCommit = deferred<void>();
  const restoreEntered = deferred<void>();

  assert.notEqual(scenario.productivity.name, scenario.barriers.physicalDatabaseName);
  const productivityWrite = scenario.protocol.normalWrite({
    actor: 'productivity-cross-db',
    afterBarrierCheck: async () => {
      productivityChecked.resolve(undefined);
      await allowProductivityCommit.promise;
    },
    database: scenario.productivity,
    key: 'print-pdf',
    value: 'old-user-write',
  });
  await productivityChecked.promise;

  const restore = scenario.protocol.runRestore('restore-cross-db', () => {
    restoreEntered.resolve(undefined);
    scenario.docs.put('paper-cross-db', 'restored-document');
    scenario.productivity.put('print-pdf', 'restored-print');
  });
  assert.deepEqual(scenario.locks.pendingLabels, ['restore-cross-db']);
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);

  allowProductivityCommit.resolve(undefined);
  await productivityWrite;
  await restoreEntered.promise;
  await restore;
  assert.equal(scenario.docs.get('paper-cross-db'), 'restored-document');
  assert.equal(scenario.productivity.get('print-pdf'), 'restored-print');
  assert.ok(
    eventIndex(scenario.events, 'writer:committed:productivity-cross-db') <
      eventIndex(scenario.events, 'restore:barrier-created:restore-cross-db'),
  );
});

test('case 15: an old nonparticipating client can bypass the protocol, proving the mixed-client limit', async () => {
  const scenario = createScenario();
  const restoreEntered = deferred<void>();
  const releaseRestore = deferred<void>();

  const restore = scenario.protocol.runRestore(
    'restore-with-legacy-tab',
    async () => {
      restoreEntered.resolve(undefined);
      await releaseRestore.promise;
    },
    { finalize: 'publication-hold' },
  );
  await restoreEntered.promise;
  assert.equal(scenario.barriers.read(scenario.workspaceId)?.phase, 'preparing');

  // Deliberate unsafe legacy behavior: no shared lock and no durable barrier read.
  scenario.productivity.put('legacy-write', 'bypassed-locking-protocol');
  assert.equal(scenario.productivity.get('legacy-write'), 'bypassed-locking-protocol');

  const participatingWrite = scenario.protocol.normalWrite({
    actor: 'participating-control',
    database: scenario.productivity,
    key: 'participating-write',
    value: 'must-not-commit',
  });
  releaseRestore.resolve(undefined);
  await restore;
  await assert.rejects(participatingWrite, BarrierActiveError);
  assert.equal(scenario.productivity.get('participating-write'), undefined);

  // This is evidence of a boundary, not a claimed safety success: versionchange
  // fencing must prevent such a client from remaining writable in production.
  assert.equal(scenario.barriers.read(scenario.workspaceId)?.publicationHold, true);
});

test('durable barrier ownership and generation reject stale callbacks across service re-instantiation', () => {
  const scenario = createScenario();
  const first = scenario.barriers.create('restore-old', scenario.workspaceId);
  scenario.barriers.clear(first.operationId, scenario.workspaceId, first.generation);
  const second = scenario.barriers.create('restore-current', scenario.workspaceId);

  const reloadedRepository = new DurableBarrierRepository(
    scenario.state,
    scenario.docs.name,
  );
  assert.throws(
    () =>
      reloadedRepository.clear(
        first.operationId,
        scenario.workspaceId,
        first.generation,
      ),
    BarrierOwnershipError,
  );
  assert.throws(
    () =>
      reloadedRepository.transition(
        second.operationId,
        scenario.workspaceId,
        first.generation,
        { phase: 'publication-hold', publicationHold: true },
      ),
    BarrierOwnershipError,
  );
  assert.deepEqual(reloadedRepository.read(scenario.workspaceId), second);
  assert.deepEqual(reloadedRepository.read(scenario.workspaceId), second);
});

test('crash after exclusive admission but before durable barrier creation cannot mutate restore targets', async () => {
  const scenario = createScenario();
  scenario.docs.put('paper-pre-barrier', 'original');
  const crash = new SimulatedTabClosedError();

  await assert.rejects(
    scenario.protocol.runRestore(
      'restore-pre-barrier-crash',
      () => scenario.docs.put('paper-pre-barrier', 'unsafe-restored'),
      {
        hooks: {
          afterExclusiveAdmission: () => {
            throw crash;
          },
        },
      },
    ),
    crash,
  );
  assert.equal(scenario.docs.get('paper-pre-barrier'), 'original');
  assert.equal(scenario.barriers.read(scenario.workspaceId), null);
});

test('crash after durable barrier creation but before mutation remains recoverable after re-instantiation', async () => {
  const scenario = createScenario();
  scenario.docs.put('paper-post-barrier', 'original');
  const crash = new SimulatedTabClosedError();

  await assert.rejects(
    scenario.protocol.runRestore(
      'restore-post-barrier-crash',
      () => scenario.docs.put('paper-post-barrier', 'unsafe-restored'),
      {
        hooks: {
          afterBarrierCreated: () => {
            throw crash;
          },
        },
      },
    ),
    crash,
  );

  const restartedRepository = new DurableBarrierRepository(
    scenario.state,
    scenario.docs.name,
  );
  assert.equal(scenario.docs.get('paper-post-barrier'), 'original');
  assert.deepEqual(restartedRepository.read(scenario.workspaceId), {
    operationId: 'restore-post-barrier-crash',
    workspaceId: scenario.workspaceId,
    phase: 'preparing',
    generation: 1,
    createdAt: '2026-10-22T00:00:00.000Z',
    recoveryRequired: false,
    publicationHold: false,
  });
});
