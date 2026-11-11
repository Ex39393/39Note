import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';

import {
  RESTORE_ACTION_STORE,
  RESTORE_OPERATION_STORE,
  RESTORE_SNAPSHOT_STORE,
  canTransitionRestorePhase,
  isDurableRestoreOperation,
  type DurableRestoreOperation,
} from '../src/services/restoreSafety.ts';
import {
  InvalidWorkspaceRestoreLeaseError,
  WorkspaceLocksUnavailableError,
  acquireSharedWorkspaceRestoreLease,
  assertWorkspaceRestoreLease,
  currentWorkspaceRestoreIdentity,
  withExclusiveWorkspaceRestoreLease,
  withSharedWorkspaceRestoreLease,
  withWorkspaceIdentityTransition,
  workspaceRestoreLockName,
  type WorkspaceRestoreLease,
} from '../src/services/workspaceRestoreLock.ts';
import {
  dispatchPersistentChange,
  subscribeToPersistentChanges,
} from '../src/services/persistentChange.ts';
import { isIntentionalSyncPersistenceBoundaryWarning } from '../vite.config.ts';

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const TEMPORARY_WORKSPACE_ID = '7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';

interface SchemaModule {
  ANNOTATION_DATABASE_VERSION: number;
  PRODUCTIVITY_DATABASE_VERSION?: number;
  upgradeAnnotationDatabaseSchema?: (database: unknown) => void;
  upgradeProductivityDatabaseSchema?: (database: unknown) => void;
}

interface StartupModule {
  verifyRestoreSafetyBeforeAppMount(dependencies: {
    prepareAnnotationPersistence(): Promise<void>;
    prepareProductivityPersistence(): Promise<void>;
    recoverRestore(): Promise<{
      operationId: string | null;
      outcome: 'none' | 'rolled-back' | 'publication-hold';
    }>;
  }): Promise<void>;
  describeRestoreSafetyStartupFailure(error: unknown): {
    heading: string;
    detail: string;
  } | null;
}

interface LifecycleModule {
  IndexedDbUpgradeBlockedError: new (
    databaseName: string,
    currentVersion: number,
    requestedVersion: number,
  ) => Error;
}

interface RestoreSafetyModule {
  RestoreStartupBlockedError: new (operation: DurableRestoreOperation) => Error;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

interface QueuedLockRequest<T = unknown> {
  callback: (lock: Lock | null) => T | PromiseLike<T>;
  mode: LockMode;
  name: string;
  options: LockOptions;
  reject(reason?: unknown): void;
  resolve(value: T): void;
}

class OrderedMemoryLockManager {
  readonly requestCounts = new Map<string, number>();
  private readonly holders = new Map<string, { mode: LockMode; count: number }>();
  private readonly queues = new Map<string, QueuedLockRequest[]>();

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) return Promise.reject(new TypeError('A lock callback is required.'));
    this.requestCounts.set(name, (this.requestCounts.get(name) ?? 0) + 1);
    const mode = options.mode ?? 'exclusive';
    if (options.signal?.aborted) {
      return Promise.reject(
        options.signal.reason ?? new DOMException('Aborted', 'AbortError'),
      );
    }
    if (options.ifAvailable && !this.canAcquireImmediately(name, mode)) {
      return Promise.resolve(callback(null));
    }
    return new Promise<T>((resolve, reject) => {
      const request: QueuedLockRequest<T> = {
        callback,
        mode,
        name,
        options,
        reject,
        resolve,
      };
      const queue = this.queues.get(name) ?? [];
      queue.push(request as QueuedLockRequest);
      this.queues.set(name, queue);
      const abort = () => {
        const current = this.queues.get(name);
        const index = current?.indexOf(request as QueuedLockRequest) ?? -1;
        if (index < 0) return;
        current!.splice(index, 1);
        reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        this.drain(name);
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      void request;
      this.drain(name);
    });
  }

  held(name: string): { count: number; mode: LockMode } | undefined {
    const holder = this.holders.get(name);
    return holder ? { ...holder } : undefined;
  }

  private canAcquireImmediately(name: string, mode: LockMode): boolean {
    const holders = this.holders.get(name);
    const queue = this.queues.get(name);
    return (
      (!holders || (holders.mode === 'shared' && mode === 'shared')) &&
      (!queue || queue.length === 0)
    );
  }

  private drain(name: string): void {
    const queue = this.queues.get(name);
    if (!queue?.length) return;
    const holders = this.holders.get(name);
    if (holders?.mode === 'exclusive') return;
    const first = queue[0]!;
    if (holders && first.mode === 'exclusive') return;
    if (first.mode === 'exclusive') {
      queue.shift();
      this.start(first);
      return;
    }
    while (queue[0]?.mode === 'shared') this.start(queue.shift()!);
  }

  private start(request: QueuedLockRequest): void {
    const current = this.holders.get(request.name);
    this.holders.set(request.name, {
      mode: request.mode,
      count: (current?.count ?? 0) + 1,
    });
    Promise.resolve()
      .then(() => request.callback({ name: request.name, mode: request.mode } as Lock))
      .then(request.resolve, request.reject)
      .finally(() => {
        const held = this.holders.get(request.name);
        if (held && held.count > 1) {
          this.holders.set(request.name, { ...held, count: held.count - 1 });
        } else {
          this.holders.delete(request.name);
        }
        this.drain(request.name);
      });
  }
}

class SchemaImage {
  readonly records = new Map<string, Map<string, unknown>>();
  readonly schemas = new Map<
    string,
    { indexes: Map<string, string>; keyPath: string }
  >();

  readonly objectStoreNames = {
    contains: (name: string) => this.records.has(name),
  };

  seed(
    name: string,
    keyPath: string,
    records: ReadonlyArray<readonly [string, unknown]>,
    indexes: ReadonlyArray<readonly [string, string]> = [],
  ): void {
    this.records.set(name, new Map(records.map(([key, value]) => [key, value])));
    this.schemas.set(name, { indexes: new Map(indexes), keyPath });
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    if (this.records.has(name))
      throw new DOMException('Duplicate store', 'ConstraintError');
    this.records.set(name, new Map());
    const schema = { indexes: new Map<string, string>(), keyPath: options.keyPath };
    this.schemas.set(name, schema);
    return {
      createIndex: (indexName: string, keyPath: string) => {
        schema.indexes.set(indexName, keyPath);
      },
    };
  }

  deleteObjectStore(name: string): void {
    this.records.delete(name);
    this.schemas.delete(name);
  }
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSessionStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'sessionStorage',
);
const locks = new OrderedMemoryLockManager();
let server: ViteDevServer;
let annotationModule: SchemaModule;
let productivityModule: SchemaModule;
let startupModule: StartupModule;
let lifecycleModule: LifecycleModule;
let restoreSafetyModule: RestoreSafetyModule;

before(async () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    root: process.cwd(),
    server: { middlewareMode: true },
  });
  annotationModule = (await server.ssrLoadModule(
    '/src/services/annotationPersistence.ts',
  )) as SchemaModule;
  productivityModule = (await server.ssrLoadModule(
    '/src/services/productivityPersistence.ts',
  )) as SchemaModule;
  startupModule = (await server.ssrLoadModule(
    '/src/services/restoreSafetyStartup.ts',
  )) as StartupModule;
  lifecycleModule = (await server.ssrLoadModule(
    '/src/services/indexedDbLifecycle.ts',
  )) as LifecycleModule;
  restoreSafetyModule = (await server.ssrLoadModule(
    '/src/services/restoreSafety.ts',
  )) as RestoreSafetyModule;
});

after(async () => {
  await server.close();
  restoreProperty(globalThis, 'navigator', originalNavigator);
  restoreProperty(globalThis, 'sessionStorage', originalSessionStorage);
});

test('production physical schema callbacks are additive at document v5 and productivity v3', async () => {
  assert.equal(annotationModule.ANNOTATION_DATABASE_VERSION, 5);
  assert.equal(productivityModule.PRODUCTIVITY_DATABASE_VERSION, 3);
  assert.equal(typeof annotationModule.upgradeAnnotationDatabaseSchema, 'function');
  assert.equal(typeof productivityModule.upgradeProductivityDatabaseSchema, 'function');

  const source = new Blob([new Uint8Array([37, 80, 68, 70, 45, 66, 10])], {
    type: 'application/pdf',
  });
  const print = new Blob([new Uint8Array([37, 80, 68, 70, 45, 80, 10])], {
    type: 'application/pdf',
  });
  const documentState = {
    documentId: 'synthetic-phase-b',
    annotations: [{ id: 'annotation-a', type: 'highlight', color: 'yellow' }],
    links: [{ id: 'link-a', documentId: 'synthetic-phase-b' }],
    notes: [{ id: 'note-a', content: 'Synthetic only' }],
    schemaVersion: 9,
  };
  const collection = { id: 'collection-a', name: 'Synthetic collection' };
  const sourceRecord = { blob: source, documentId: 'synthetic-phase-b' };
  const documentDatabase = new SchemaImage();
  documentDatabase.seed('document-states', 'documentId', [
    ['synthetic-phase-b', documentState],
  ]);
  documentDatabase.seed('pdf-files', 'documentId', [
    ['synthetic-phase-b', sourceRecord],
  ]);
  documentDatabase.seed('collections', 'id', [['collection-a', collection]]);
  documentDatabase.seed('tags', 'id', [
    ['legacy-tag-a', { id: 'legacy-tag-a', name: 'Dormant legacy data' }],
  ]);
  const documentFingerprint = structuredClone(
    Object.fromEntries(
      [...documentDatabase.records].map(([name, records]) => [
        name,
        [...records.entries()],
      ]),
    ),
  );
  const sourceHash = await hashBlob(source);

  annotationModule.upgradeAnnotationDatabaseSchema!(documentDatabase);
  annotationModule.upgradeAnnotationDatabaseSchema!(documentDatabase);

  assert.deepEqual(
    documentDatabase.records.get('document-states')?.get('synthetic-phase-b'),
    documentState,
  );
  assert.deepEqual(
    documentDatabase.records.get('collections')?.get('collection-a'),
    collection,
  );
  assert.deepEqual(documentDatabase.records.get('tags')?.get('legacy-tag-a'), {
    id: 'legacy-tag-a',
    name: 'Dormant legacy data',
  });
  assert.equal(
    await hashBlob(
      (
        documentDatabase.records.get('pdf-files')?.get('synthetic-phase-b') as {
          blob: Blob;
        }
      ).blob,
    ),
    sourceHash,
  );
  assert.deepEqual(
    Object.fromEntries(
      [...documentDatabase.records]
        .filter(([name]) => !name.startsWith('restore-'))
        .map(([name, records]) => [name, [...records.entries()]]),
    ),
    documentFingerprint,
  );
  assert.deepEqual(restoreStoreSchemas(documentDatabase), {
    [RESTORE_ACTION_STORE]: 'id',
    [RESTORE_OPERATION_STORE]: 'workspaceId',
    [RESTORE_SNAPSHOT_STORE]: 'id',
  });

  const productivityDatabase = new SchemaImage();
  productivityDatabase.seed('print-drafts', 'documentId', [
    ['synthetic-phase-b', { documentId: 'synthetic-phase-b', title: 'Draft' }],
  ]);
  productivityDatabase.seed('rendered-print-pdfs', 'documentId', [
    ['synthetic-phase-b', { blob: print, documentId: 'synthetic-phase-b' }],
  ]);
  productivityDatabase.seed(
    'ai-conversations',
    'id',
    [['conversation-a', { documentId: 'synthetic-phase-b', id: 'conversation-a' }]],
    [['by-document', 'documentId']],
  );
  const printHash = await hashBlob(print);
  const productivityFingerprint = structuredClone(
    Object.fromEntries(
      [...productivityDatabase.records].map(([name, records]) => [
        name,
        [...records.entries()],
      ]),
    ),
  );

  productivityModule.upgradeProductivityDatabaseSchema!(productivityDatabase);
  productivityModule.upgradeProductivityDatabaseSchema!(productivityDatabase);

  assert.deepEqual(
    Object.fromEntries(
      [...productivityDatabase.records]
        .filter(([name]) => !name.startsWith('restore-'))
        .map(([name, records]) => [name, [...records.entries()]]),
    ),
    productivityFingerprint,
  );
  assert.equal(
    await hashBlob(
      (
        productivityDatabase.records
          .get('rendered-print-pdfs')
          ?.get('synthetic-phase-b') as { blob: Blob }
      ).blob,
    ),
    printHash,
  );
  assert.deepEqual(restoreStoreSchemas(productivityDatabase), {
    [RESTORE_ACTION_STORE]: 'id',
    [RESTORE_SNAPSHOT_STORE]: 'id',
  });
});

test('durable restore records require exact phase flags, UUIDv4 workspace identity, and authorized transitions', () => {
  const base: DurableRestoreOperation = {
    operationId: 'ad6706c4-4051-4d8e-9f90-4567890123de',
    workspaceId: `temporary:${TEMPORARY_WORKSPACE_ID}`,
    phase: 'preparing',
    generation: 1,
    createdAt: 1,
    recoveryRequired: false,
    publicationHold: false,
    remoteRevalidationRequired: false,
  };
  assert.equal(isDurableRestoreOperation(base), true);
  assert.equal(
    isDurableRestoreOperation({
      ...base,
      operationId: 'not-a-uuid',
    }),
    false,
  );
  assert.equal(
    isDurableRestoreOperation({
      ...base,
      workspaceId: 'temporary:------------------------------------',
    }),
    false,
  );
  assert.equal(isDurableRestoreOperation({ ...base, recoveryRequired: true }), false);
  assert.equal(
    isDurableRestoreOperation({
      ...base,
      phase: 'publication-hold',
      publicationHold: false,
    }),
    false,
  );
  assert.equal(
    isDurableRestoreOperation({
      ...base,
      phase: 'publication-hold',
      publicationHold: true,
      remoteRevalidationRequired: true,
      publicationAccountId: ' invalid-account ',
    }),
    false,
  );
  assert.equal(
    isDurableRestoreOperation({
      ...base,
      publicationAccountId: 'account-a',
    }),
    false,
  );
  assert.equal(canTransitionRestorePhase('preparing', 'prepared'), true);
  assert.equal(canTransitionRestorePhase('prepared', 'applying'), true);
  assert.equal(canTransitionRestorePhase('verifying', 'committed'), true);
  assert.equal(canTransitionRestorePhase('committed', 'publication-hold'), true);
  assert.equal(canTransitionRestorePhase('publication-hold', 'preparing'), false);
  assert.equal(canTransitionRestorePhase('preparing', 'committed'), false);
});

test('shared writers overlap, an exclusive actor waits, and a queued writer cannot barge', async () => {
  const firstEntered = deferred<void>();
  const secondEntered = deferred<void>();
  const releaseShared = deferred<void>();
  const exclusiveEntered = deferred<void>();
  const releaseExclusive = deferred<void>();
  const lateWriterEntered = deferred<void>();
  const ordering: string[] = [];

  const first = withSharedWorkspaceRestoreLease(async () => {
    ordering.push('shared-a');
    firstEntered.resolve(undefined);
    await releaseShared.promise;
  });
  const second = withSharedWorkspaceRestoreLease(async () => {
    ordering.push('shared-b');
    secondEntered.resolve(undefined);
    await releaseShared.promise;
  });
  await Promise.all([firstEntered.promise, secondEntered.promise]);
  const exclusive = withExclusiveWorkspaceRestoreLease(async () => {
    ordering.push('exclusive');
    exclusiveEntered.resolve(undefined);
    await releaseExclusive.promise;
  });
  const lateWriter = withSharedWorkspaceRestoreLease(() => {
    ordering.push('shared-late');
    lateWriterEntered.resolve(undefined);
  });
  await drainMicrotasks();
  assert.deepEqual(ordering, ['shared-a', 'shared-b']);
  releaseShared.resolve(undefined);
  await exclusiveEntered.promise;
  assert.deepEqual(ordering, ['shared-a', 'shared-b', 'exclusive']);
  await drainMicrotasks();
  assert.equal(ordering.includes('shared-late'), false);
  releaseExclusive.resolve(undefined);
  await lateWriterEntered.promise;
  await Promise.all([first, second, exclusive, lateWriter]);
  assert.deepEqual(ordering, ['shared-a', 'shared-b', 'exclusive', 'shared-late']);
});

test('one outer lease avoids nested lock acquisition and stale or forged capabilities fail closed', async () => {
  const lockName = workspaceRestoreLockName('personal');
  const before = locks.requestCounts.get(lockName) ?? 0;
  let retained: WorkspaceRestoreLease | undefined;
  await withSharedWorkspaceRestoreLease(async (lease) => {
    retained = lease;
    assertWorkspaceRestoreLease(lease);
    await withSharedWorkspaceRestoreLease(async (nested) => {
      assert.equal(nested, lease);
      assertWorkspaceRestoreLease(nested, { allowExclusive: true });
    }, lease);
  });
  assert.equal((locks.requestCounts.get(lockName) ?? 0) - before, 1);
  assert.throws(
    () => assertWorkspaceRestoreLease(retained!),
    InvalidWorkspaceRestoreLeaseError,
  );
  assert.throws(
    () =>
      assertWorkspaceRestoreLease(
        Object.freeze({
          mode: 'shared',
          workspaceId: 'personal',
        }) as WorkspaceRestoreLease,
      ),
    InvalidWorkspaceRestoreLeaseError,
  );
});

test('queued long-lived shared acquisition honors AbortSignal and leaks no ownership', async () => {
  const exclusiveEntered = deferred<void>();
  const releaseExclusive = deferred<void>();
  const exclusive = withExclusiveWorkspaceRestoreLease(async () => {
    exclusiveEntered.resolve(undefined);
    await releaseExclusive.promise;
  });
  await exclusiveEntered.promise;
  const controller = new AbortController();
  const queued = acquireSharedWorkspaceRestoreLease(controller.signal);
  controller.abort(new DOMException('Synthetic cancellation', 'AbortError'));
  await assert.rejects(queued, { name: 'AbortError' });
  releaseExclusive.resolve(undefined);
  await exclusive;
  const lockName = workspaceRestoreLockName('personal');
  assert.equal(locks.held(lockName), undefined);
});

test('personal and temporary workspaces have different strict lock identities and cannot reuse a lease', async () => {
  assert.equal(currentWorkspaceRestoreIdentity(), 'personal');
  const personalName = workspaceRestoreLockName('personal');
  let personalLease: WorkspaceRestoreLease | undefined;
  await withSharedWorkspaceRestoreLease(async (lease) => {
    personalLease = lease;
    sessionStorage.setItem(
      ACTIVE_WORKSPACE_KEY,
      JSON.stringify({ id: TEMPORARY_WORKSPACE_ID, version: 1 }),
    );
    assert.equal(
      currentWorkspaceRestoreIdentity(),
      `temporary:${TEMPORARY_WORKSPACE_ID}`,
    );
    assert.notEqual(
      workspaceRestoreLockName(currentWorkspaceRestoreIdentity()),
      personalName,
    );
    assert.throws(
      () => assertWorkspaceRestoreLease(lease),
      InvalidWorkspaceRestoreLeaseError,
    );
  });
  sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  assert.throws(
    () => assertWorkspaceRestoreLease(personalLease!),
    InvalidWorkspaceRestoreLeaseError,
  );
  assert.throws(
    () => workspaceRestoreLockName('temporary:------------------------------------'),
    InvalidWorkspaceRestoreLeaseError,
  );
});

test('workspace identity transitions wait for active operations and queued writers cannot enter the old identity', async () => {
  const writerEntered = deferred<void>();
  const releaseWriter = deferred<void>();
  const transitionEntered = deferred<void>();
  const releaseTransition = deferred<void>();
  const lateWriterEntered = deferred<void>();
  const ordering: string[] = [];

  const writer = withSharedWorkspaceRestoreLease(async (lease) => {
    ordering.push('personal-writer');
    assert.equal(lease.workspaceId, 'personal');
    writerEntered.resolve(undefined);
    await releaseWriter.promise;
  });
  await writerEntered.promise;
  const transition = withWorkspaceIdentityTransition(async (lease) => {
    ordering.push('identity-transition');
    assert.equal(lease.mode, 'exclusive');
    assert.equal(lease.workspaceId, 'personal');
    sessionStorage.setItem(
      ACTIVE_WORKSPACE_KEY,
      JSON.stringify({ id: TEMPORARY_WORKSPACE_ID, version: 1 }),
    );
    transitionEntered.resolve(undefined);
    await releaseTransition.promise;
  });
  const lateWriter = withSharedWorkspaceRestoreLease(async (lease) => {
    ordering.push('temporary-writer');
    assert.equal(lease.workspaceId, `temporary:${TEMPORARY_WORKSPACE_ID}`);
    lateWriterEntered.resolve(undefined);
  });

  await drainMicrotasks();
  assert.deepEqual(ordering, ['personal-writer']);
  releaseWriter.resolve(undefined);
  await transitionEntered.promise;
  await drainMicrotasks();
  assert.equal(ordering.includes('temporary-writer'), false);
  releaseTransition.resolve(undefined);
  await lateWriterEntered.promise;
  await Promise.all([writer, transition, lateWriter]);
  assert.deepEqual(ordering, [
    'personal-writer',
    'identity-transition',
    'temporary-writer',
  ]);
  sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
});

test('persistent change settlement retains the originating shared lease until downstream sync work completes', async () => {
  const listenerEntered = deferred<void>();
  const releaseListener = deferred<void>();
  const exclusiveEntered = deferred<void>();
  let originatingLease: WorkspaceRestoreLease | undefined;
  let observedLease: WorkspaceRestoreLease | undefined;
  let restoreEntered = false;
  const unsubscribe = subscribeToPersistentChanges(async (detail, lease) => {
    if (detail.documentId !== 'phase-b-dispatch') return;
    observedLease = lease;
    listenerEntered.resolve(undefined);
    await releaseListener.promise;
  });

  try {
    const writer = withSharedWorkspaceRestoreLease(async (lease) => {
      originatingLease = lease;
      await dispatchPersistentChange(
        {
          kind: 'document',
          documentId: 'phase-b-dispatch',
          categories: ['metadata'],
        },
        lease,
      );
    });
    await listenerEntered.promise;
    assert.strictEqual(observedLease, originatingLease);

    const restore = withExclusiveWorkspaceRestoreLease(() => {
      restoreEntered = true;
      exclusiveEntered.resolve(undefined);
    });
    await drainMicrotasks();
    assert.equal(restoreEntered, false);

    releaseListener.resolve(undefined);
    await writer;
    await exclusiveEntered.promise;
    await restore;
    assert.equal(restoreEntered, true);
  } finally {
    releaseListener.resolve(undefined);
    unsubscribe();
  }
});

test('missing Web Locks fails closed before task admission', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {},
  });
  let invoked = false;
  try {
    await assert.rejects(
      withSharedWorkspaceRestoreLease(() => {
        invoked = true;
      }),
      WorkspaceLocksUnavailableError,
    );
    assert.equal(invoked, false);
  } finally {
    restoreProperty(globalThis, 'navigator', descriptor);
  }
});

test('startup verifies the document barrier before productivity and fails closed on either dependency', async () => {
  const ordering: string[] = [];
  await startupModule.verifyRestoreSafetyBeforeAppMount({
    async prepareAnnotationPersistence() {
      ordering.push('document');
    },
    async prepareProductivityPersistence() {
      ordering.push('productivity');
    },
    async recoverRestore() {
      ordering.push('recovery');
      return { operationId: null, outcome: 'none' };
    },
  });
  assert.deepEqual(ordering, ['document', 'productivity', 'recovery']);

  const documentFailure = new Error('synthetic durable barrier');
  await assert.rejects(
    startupModule.verifyRestoreSafetyBeforeAppMount({
      async prepareAnnotationPersistence() {
        throw documentFailure;
      },
      async prepareProductivityPersistence() {
        ordering.push('must-not-open');
      },
      async recoverRestore() {
        ordering.push('must-not-recover');
        return { operationId: null, outcome: 'none' };
      },
    }),
    documentFailure,
  );
  assert.equal(ordering.includes('must-not-open'), false);
  assert.equal(ordering.includes('must-not-recover'), false);

  const productivityFailure = new Error('synthetic productivity upgrade');
  await assert.rejects(
    startupModule.verifyRestoreSafetyBeforeAppMount({
      async prepareAnnotationPersistence() {
        ordering.push('document-second');
      },
      async prepareProductivityPersistence() {
        throw productivityFailure;
      },
      async recoverRestore() {
        ordering.push('must-not-recover-productivity');
        return { operationId: null, outcome: 'none' };
      },
    }),
    productivityFailure,
  );
  assert.equal(ordering.includes('must-not-recover-productivity'), false);

  await assert.rejects(
    startupModule.verifyRestoreSafetyBeforeAppMount({
      async prepareAnnotationPersistence() {},
      async prepareProductivityPersistence() {},
      async recoverRestore() {
        throw new Error('synthetic recovery proof failure');
      },
    }),
    (error: Error) => error.name === 'RestoreStartupRecoveryError',
  );
});

test('startup safety failures present actionable blocked-upgrade, recovery, and publication-hold guidance', () => {
  assert.deepEqual(
    startupModule.describeRestoreSafetyStartupFailure(
      new lifecycleModule.IndexedDbUpgradeBlockedError('synthetic-document-db', 4, 5),
    ),
    {
      heading: 'Close or refresh other 39Note tabs',
      detail:
        'Another tab is holding an older local database connection. Your data was not changed. Close or refresh every other 39Note tab, then reload this page.',
    },
  );
  const base: DurableRestoreOperation = {
    operationId: 'ad6d9364-0439-4f06-8c7d-025d658f94ae',
    workspaceId: 'personal',
    phase: 'recovery-required',
    generation: 3,
    createdAt: 10,
    recoveryRequired: true,
    publicationHold: false,
    remoteRevalidationRequired: false,
  };
  assert.equal(
    startupModule.describeRestoreSafetyStartupFailure(
      new restoreSafetyModule.RestoreStartupBlockedError(base),
    )?.heading,
    'Restore recovery is required',
  );
  assert.equal(
    startupModule.describeRestoreSafetyStartupFailure(
      new restoreSafetyModule.RestoreStartupBlockedError({
        ...base,
        phase: 'publication-hold',
        recoveryRequired: false,
        publicationHold: true,
        remoteRevalidationRequired: true,
      }),
    )?.heading,
    'Restored work is waiting for review',
  );
});

test('production writer inventory routes local, productivity, sync, composite, and Drive mutations through the common fence', () => {
  const annotation = source('../src/services/annotationPersistence.ts');
  const productivity = source('../src/services/productivityPersistence.ts');
  const syncStorage = source('../src/sync/storage.ts');
  const coordinator = source('../src/sync/paperCoordinator.ts');
  const localAdapter = source('../src/sync/paperLocalAdapter.ts');
  const temporary = source('../src/sync/temporaryDeviceSession.ts');
  const appLayout = source('../src/components/AppLayout.tsx');
  const persistentChanges = source('../src/services/persistentChange.ts');

  for (const entryPoint of [
    'removeStoredDocumentSource',
    'restoreBackupDocument',
    'restoreDownloadedPaperBundle',
    'deleteDocumentState',
    'deleteDocumentStates',
    'storeDocumentSource',
    'updateDocumentDisplayTitle',
    'saveReadingPosition',
    'saveDocumentReadingPosition',
    'saveOfficeDocumentAnnotations',
    'restoreLibraryEntities',
    'replaceLibraryEntities',
    'createCollection',
    'saveCollectionDraft',
    'renameCollection',
    'deleteCollection',
    'updateDocumentOrganization',
    'saveDocumentState',
  ]) {
    assert.match(functionSource(annotation, entryPoint), /withWorkspaceMutation/u);
  }
  for (const entryPoint of [
    'savePrintDraft',
    'clearPrintDraft',
    'saveRenderedPrintPdf',
    'replaceRenderedPrintPdf',
    'removeRenderedPrintPdf',
    'restoreRenderedPrintPdf',
    'restoreRenderedPrintPdfIfUnchanged',
    'appendPrintDraftAddition',
    'saveAiConversation',
    'deleteAiConversation',
    'restoreProductivityBackupData',
    'restoreAiConversations',
    'deleteProductivityDocumentData',
    'deleteProductivityDocumentDataStrict',
  ]) {
    assert.match(functionSource(productivity, entryPoint), /withWorkspaceMutation/u);
  }
  assert.match(annotation, /await dispatchPersistentChange\([\s\S]*workspaceLease/u);
  assert.match(productivity, /await dispatchPersistentChange\([\s\S]*workspaceLease/u);
  assert.doesNotMatch(annotation, /notifyPersistentChange/u);
  assert.doesNotMatch(productivity, /notifyPersistentChange/u);
  assert.match(
    functionSource(persistentChanges, 'dispatchPersistentChange'),
    /await Promise\.all\([\s\S]*listener\(detail, workspaceLease\)/u,
  );
  for (const entryPoint of [
    'saveSyncDeviceState',
    'savePaperSyncDeviceProfile',
    'bindPersonalWorkspaceAccount',
    'savePaperSyncState',
    'savePaperSyncStates',
    'saveCloudPaperCatalog',
    'saveTemporarySessionProvenance',
    'clearTemporarySessionProvenance',
    'saveLayoutMigrationRecord',
    'clearLayoutMigrationRecord',
    'savePaperV3MigrationRecord',
    'clearPaperV3MigrationRecord',
    'deletePaperSyncRecords',
  ]) {
    assert.match(functionSource(syncStorage, entryPoint), /withSyncWorkspaceMutation/u);
  }
  assert.match(
    methodSource(coordinator, 'beginOperation'),
    /acquireSharedWorkspaceRestoreLease\(signal\)[\s\S]*assertWorkspaceMutationAdmission[\s\S]*revalidateOperationWorkspaceAccount/u,
  );
  for (const entryPoint of [
    'scanCloudPapersOwned',
    'revalidatePaperRetryTargets',
    'uploadSelectedOwned',
  ]) {
    assert.match(methodSource(coordinator, entryPoint), /beginOperation\(/u);
  }
  assert.match(methodSource(coordinator, 'scheduleAutoUpload'), /this\.startUpload\(/u);
  assert.match(
    methodSource(coordinator, 'resolveAuthorizedAccount'),
    /runWorkspaceMutation\([\s\S]*resolveAuthorizedAccountOwned/u,
  );
  assert.match(localAdapter, /workspaceLease:\s*WorkspaceRestoreLease/u);
  assert.match(temporary, /withWorkspaceMutation/u);
  assert.match(appLayout, /withWorkspaceMutation/u);
});

test('restore-lock imports stay static while the isolated sync persistence boundary remains explicit', () => {
  const annotation = source('../src/services/annotationPersistence.ts');
  const syncStorage = source('../src/sync/storage.ts');
  const temporaryOAuth = source('../src/sync/temporaryOAuthStartup.ts');
  const viteConfig = source('../vite.config.ts');

  assert.doesNotMatch(annotation, /import\(['"]\.\/workspaceRestoreLock\.ts['"]\)/u);
  assert.match(annotation, /WorkspaceLocksUnavailableError,/u);
  assert.match(
    syncStorage,
    /await import\(['"]\.\.\/services\/annotationPersistence\.ts['"]\)/u,
  );
  assert.match(
    temporaryOAuth,
    /await import\(['"]\.\.\/services\/annotationPersistence\.ts['"]\)/u,
  );
  assert.match(viteConfig, /isIntentionalSyncPersistenceBoundaryWarning/u);
  assert.match(viteConfig, /sourcePaths\.length === 2/u);
  assert.match(viteConfig, /\/src\/sync\/storage\.ts/u);
  assert.match(viteConfig, /\/src\/sync\/temporaryOAuthStartup\.ts/u);

  const exactWarning = {
    code: 'PLUGIN_WARNING',
    plugin: 'vite:reporter',
    message:
      '[plugin vite:reporter] C:/workspace/src/services/annotationPersistence.ts is dynamically imported by C:/workspace/src/sync/storage.ts, C:/workspace/src/sync/temporaryOAuthStartup.ts but also statically imported by C:/workspace/src/components/AppLayout.tsx, dynamic import will not move module into another chunk.',
  };
  assert.equal(isIntentionalSyncPersistenceBoundaryWarning(exactWarning), true);
  assert.equal(
    isIntentionalSyncPersistenceBoundaryWarning({
      ...exactWarning,
      message: exactWarning.message.replace(
        ' but also statically imported by',
        ', C:/workspace/src/sync/unreviewedImporter.ts but also statically imported by',
      ),
    }),
    false,
  );
  assert.equal(
    isIntentionalSyncPersistenceBoundaryWarning({
      ...exactWarning,
      plugin: 'another-plugin',
    }),
    false,
  );
});

function restoreStoreSchemas(database: SchemaImage): Record<string, string> {
  return Object.fromEntries(
    [...database.schemas]
      .filter(([name]) => name.startsWith('restore-'))
      .map(([name, schema]) => [name, schema.keyPath]),
  );
}

async function hashBlob(blob: Blob): Promise<string> {
  return createHash('sha256')
    .update(new Uint8Array(await blob.arrayBuffer()))
    .digest('hex');
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

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(String(key), String(value)),
  };
}

function restoreProperty(
  target: typeof globalThis,
  property: 'navigator' | 'sessionStorage',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, property, descriptor);
  else Reflect.deleteProperty(target, property);
}

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function functionSource(contents: string, name: string): string {
  const startPattern = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`,
    'u',
  );
  const start = contents.search(startPattern);
  assert.notEqual(start, -1, `${name} is missing from the production source.`);
  const next = contents
    .slice(start + 1)
    .search(/\n(?:export\s+)?(?:async\s+)?function\s+/u);
  return contents.slice(start, next < 0 ? contents.length : start + 1 + next);
}

function methodSource(contents: string, name: string): string {
  const startPattern = new RegExp(
    `\\n\\s+(?:(?:private|public|protected)\\s+)?(?:async\\s+)?${name}\\s*\\(`,
    'u',
  );
  const match = startPattern.exec(contents);
  assert.ok(match, `${name} is missing from the production source.`);
  const start = match.index;
  const bodyStart = start + match[0].length;
  const next = contents.slice(bodyStart).search(/\n\s+private\s+/u);
  return contents.slice(start, next < 0 ? contents.length : bodyStart + next);
}
