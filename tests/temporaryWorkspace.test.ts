import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViteDevServer } from 'vite';
import type { PaperSyncViewState } from '../src/sync/paperCoordinator.ts';
import type { PaperSyncDeviceProfile } from '../src/sync/storage.ts';

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const STARTUP_HANDOFF_KEY = '39note.workspace.temporary-startup.v1';
const VALID_WORKSPACE_ID = '7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';
const SECOND_WORKSPACE_ID = '8b45e4a2-2e3f-4b6c-9d7e-2345678901bc';
const THIRD_WORKSPACE_ID = '9c56f5b3-3f40-4c7d-8e8f-3456789012cd';
const OAUTH_LEASE_ID = 'ad6706c4-4051-4d8e-9f90-4567890123de';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VIRTUAL_IDB_ID = '\0temporary-workspace-idb-test';
const IDB_HARNESS_SYMBOL = Symbol.for('39note.test.temporary-workspace-idb');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

interface RegistryHarness {
  databaseRecords: Map<string, Map<string, Map<string, Record<string, unknown>>>>;
  transactionQueues: Map<string, Promise<void>>;
  transactionReadControls: Array<{
    entered(): void;
    release: Promise<void>;
    error?: Error;
  }>;
  deleteFailureCounts: Map<string, number>;
  deletedDatabases: string[];
  opens: Array<{ name: string; version: number }>;
  records: Map<string, Record<string, unknown>>;
  stores: Array<{ name: string; keyPath?: string }>;
}

interface TemporaryWorkspaceModule {
  PERSONAL_ANNOTATION_DATABASE_NAME: string;
  PERSONAL_PRODUCTIVITY_DATABASE_NAME: string;
  PERSONAL_SYNC_DATABASE_NAME: string;
  armTemporaryWorkspaceOAuthReturn: (typeof import('../src/services/temporaryWorkspace.ts'))['armTemporaryWorkspaceOAuthReturn'];
  beginTemporaryWorkspace: (typeof import('../src/services/temporaryWorkspace.ts'))['beginTemporaryWorkspace'];
  clearTemporaryWorkspaceOAuthReturn: (typeof import('../src/services/temporaryWorkspace.ts'))['clearTemporaryWorkspaceOAuthReturn'];
  completeTemporaryWorkspace: (typeof import('../src/services/temporaryWorkspace.ts'))['completeTemporaryWorkspace'];
  cleanupAbandonedTemporaryWorkspaces: (typeof import('../src/services/temporaryWorkspace.ts'))['cleanupAbandonedTemporaryWorkspaces'];
  deleteTemporaryWorkspaceDatabases: (typeof import('../src/services/temporaryWorkspace.ts'))['deleteTemporaryWorkspaceDatabases'];
  getActiveTemporaryWorkspaceId: (typeof import('../src/services/temporaryWorkspace.ts'))['getActiveTemporaryWorkspaceId'];
  getTemporaryWorkspaceStartupCleanupReport: (typeof import('../src/services/temporaryWorkspace.ts'))['getTemporaryWorkspaceStartupCleanupReport'];
  prepareTemporaryWorkspaceStartup: (typeof import('../src/services/temporaryWorkspace.ts'))['prepareTemporaryWorkspaceStartup'];
  scopedDatabaseName: (typeof import('../src/services/temporaryWorkspace.ts'))['scopedDatabaseName'];
  scopedLocalStorageKey: (typeof import('../src/services/temporaryWorkspace.ts'))['scopedLocalStorageKey'];
  temporaryDatabaseName: (typeof import('../src/services/temporaryWorkspace.ts'))['temporaryDatabaseName'];
}

class MemoryLockManager {
  readonly heldNames = new Set<string>();
  private readonly holders = new Map<string, { mode: LockMode; count: number }>();
  private readonly waiters = new Map<string, Set<() => void>>();

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';
    while (!this.canAcquire(name, mode)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve, reject) => {
        const listeners = this.waiters.get(name) ?? new Set<() => void>();
        const wake = () => {
          options.signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          listeners.delete(wake);
          reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        listeners.add(wake);
        this.waiters.set(name, listeners);
        options.signal?.addEventListener('abort', abort, { once: true });
      });
      options.signal?.throwIfAborted();
    }
    const current = this.holders.get(name);
    this.holders.set(name, { mode, count: (current?.count ?? 0) + 1 });
    this.heldNames.add(name);
    try {
      return await callback({ name, mode } as Lock);
    } finally {
      const held = this.holders.get(name);
      if (held && held.count > 1) {
        this.holders.set(name, { ...held, count: held.count - 1 });
      } else {
        this.holders.delete(name);
        this.heldNames.delete(name);
      }
      const listeners = this.waiters.get(name);
      this.waiters.delete(name);
      for (const wake of listeners ?? []) wake();
    }
  }

  hold(name: string): () => void {
    if (this.heldNames.has(name)) {
      throw new Error(`The test lock ${name} is already held.`);
    }
    this.holders.set(name, { mode: 'exclusive', count: 1 });
    this.heldNames.add(name);
    return () => {
      this.holders.delete(name);
      this.heldNames.delete(name);
      const listeners = this.waiters.get(name);
      this.waiters.delete(name);
      for (const wake of listeners ?? []) wake();
    };
  }

  private canAcquire(name: string, mode: LockMode): boolean {
    const held = this.holders.get(name);
    return !held || (held.mode === 'shared' && mode === 'shared');
  }
}

let server: ViteDevServer;
let workspace: TemporaryWorkspaceModule;
let PaperSyncDrawer: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSyncDrawer'];
let paperRows: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperRows'];
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let evaluateTemporaryModeFootprint: (typeof import('../src/sync/temporaryDeviceSession.ts'))['evaluateTemporaryModeFootprint'];
let beginTemporaryProvenance: (typeof import('../src/sync/temporaryDeviceSession.ts'))['beginTemporaryProvenance'];
let closeSyncPersistenceWorkspace: (typeof import('../src/sync/storage.ts'))['closeSyncPersistenceWorkspace'];
let bindPersonalWorkspaceAccount: (typeof import('../src/sync/storage.ts'))['bindPersonalWorkspaceAccount'];
let hasExplicitOrEstablishedDeviceMode: (typeof import('../src/sync/storage.ts'))['hasExplicitOrEstablishedDeviceMode'];
let loadPaperSyncDeviceProfile: (typeof import('../src/sync/storage.ts'))['loadPaperSyncDeviceProfile'];
let loadTemporarySessionProvenance: (typeof import('../src/sync/storage.ts'))['loadTemporarySessionProvenance'];
let savePaperSyncDeviceProfile: (typeof import('../src/sync/storage.ts'))['savePaperSyncDeviceProfile'];
let normalizeTemporarySessionProvenance: (typeof import('../src/sync/storage.ts'))['normalizeTemporarySessionProvenance'];

const registry: RegistryHarness = {
  databaseRecords: new Map(),
  transactionQueues: new Map(),
  transactionReadControls: [],
  deleteFailureCounts: new Map(),
  deletedDatabases: [],
  opens: [],
  records: new Map(),
  stores: [],
};
const browserLocks = new MemoryLockManager();
const originalSessionStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'sessionStorage',
);
const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
);
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalIdbHarness = Object.getOwnPropertyDescriptor(
  globalThis,
  IDB_HARNESS_SYMBOL,
);

before(async () => {
  Object.defineProperty(globalThis, IDB_HARNESS_SYMBOL, {
    configurable: true,
    value: registry,
  });
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: browserLocks },
    writable: true,
  });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {},
  });
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: 'temporary-workspace-idb-test-double',
        enforce: 'pre',
        resolveId(id) {
          return id === 'idb' ? VIRTUAL_IDB_ID : undefined;
        },
        load(id) {
          if (id !== VIRTUAL_IDB_ID) return undefined;
          return `
            const harness = () => globalThis[Symbol.for('39note.test.temporary-workspace-idb')];
            const keyFor = (value) => value.id ?? value.documentId ?? value.workspaceId;
            const storeFor = (state, databaseName, storeName) => {
              if (databaseName === '39note-workspace-registry' && storeName === 'temporary-workspaces') {
                return state.records;
              }
              let database = state.databaseRecords.get(databaseName);
              if (!database) {
                database = new Map();
                state.databaseRecords.set(databaseName, database);
              }
              let store = database.get(storeName);
              if (!store) {
                store = new Map();
                database.set(storeName, store);
              }
              return store;
            };
            const operations = (state, databaseName, storeName) => ({
              async put(value) {
                storeFor(state, databaseName, storeName).set(keyFor(value), { ...value });
              },
              async get(key) {
                return storeFor(state, databaseName, storeName).get(key);
              },
              async getAll() {
                return [...storeFor(state, databaseName, storeName).values()];
              },
              async delete(key) {
                storeFor(state, databaseName, storeName).delete(key);
              },
              async clear() {
                storeFor(state, databaseName, storeName).clear();
              },
            });
            export async function openDB(name, version, options = {}) {
              const state = harness();
              state.opens.push({ name, version });
              const database = {
                objectStoreNames: { contains: () => false },
                createObjectStore(storeName, configuration = {}) {
                  state.stores.push({ name: storeName, keyPath: configuration.keyPath });
                },
              };
              options.upgrade?.(database);
              return {
                async put(storeName, value) {
                  return operations(state, name, storeName).put(value);
                },
                async get(storeName, key) {
                  return operations(state, name, storeName).get(key);
                },
                async getAll(storeName) {
                  return operations(state, name, storeName).getAll();
                },
                async delete(storeName, key) {
                  return operations(state, name, storeName).delete(key);
                },
                transaction(storeName) {
                  const queueKey = name + '\\u0000' + storeName;
                  const previous = state.transactionQueues.get(queueKey) ?? Promise.resolve();
                  let release;
                  const released = new Promise((resolve) => {
                    release = resolve;
                  });
                  const queued = previous.catch(() => undefined).then(() => released);
                  state.transactionQueues.set(queueKey, queued);
                  queued.finally(() => {
                    if (state.transactionQueues.get(queueKey) === queued) {
                      state.transactionQueues.delete(queueKey);
                    }
                  });
                  let closed = false;
                  const close = () => {
                    if (closed) return;
                    closed = true;
                    release();
                  };
                  let operationTail = previous.catch(() => undefined);
                  const schedule = (operation) => {
                    const result = operationTail.then(operation);
                    operationTail = result.then(
                      () => undefined,
                      () => {
                        close();
                        return undefined;
                      },
                    );
                    return result;
                  };
                  const base = operations(state, name, storeName);
                  const store = {
                    put(value) {
                      return schedule(() => base.put(value));
                    },
                    get(key) {
                      return schedule(async () => {
                        const value = await base.get(key);
                        const control = state.transactionReadControls.shift();
                        if (control) {
                          control.entered();
                          await control.release;
                          if (control.error) throw control.error;
                        }
                        return value;
                      });
                    },
                    getAll() {
                      return schedule(() => base.getAll());
                    },
                    delete(key) {
                      return schedule(() => base.delete(key));
                    },
                    clear() {
                      return schedule(() => base.clear());
                    },
                  };
                  return {
                    store,
                    abort: close,
                    get done() {
                      return operationTail.then(
                        () => close(),
                        (error) => {
                          close();
                          throw error;
                        },
                      );
                    },
                  };
                },
                close() {},
              };
            }
            export async function deleteDB(name) {
              const state = harness();
              const failures = state.deleteFailureCounts.get(name) ?? 0;
              if (failures > 0) {
                state.deleteFailureCounts.set(name, failures - 1);
                throw new Error('Synthetic IndexedDB deletion failure');
              }
              state.deletedDatabases.push(name);
              state.databaseRecords.delete(name);
            }
          `;
        },
      },
    ],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });

  const [workspaceModule, ui, coordinator, temporarySession, syncStorage] =
    await Promise.all([
      server.ssrLoadModule(
        '/src/services/temporaryWorkspace.ts',
      ) as Promise<TemporaryWorkspaceModule>,
      server.ssrLoadModule('/src/sync/PaperSyncControl.tsx') as Promise<
        typeof import('../src/sync/PaperSyncControl.tsx')
      >,
      server.ssrLoadModule('/src/sync/paperCoordinator.ts') as Promise<
        typeof import('../src/sync/paperCoordinator.ts')
      >,
      server.ssrLoadModule('/src/sync/temporaryDeviceSession.ts') as Promise<
        typeof import('../src/sync/temporaryDeviceSession.ts')
      >,
      server.ssrLoadModule('/src/sync/storage.ts') as Promise<
        typeof import('../src/sync/storage.ts')
      >,
    ]);
  workspace = workspaceModule;
  PaperSyncDrawer = ui.PaperSyncDrawer;
  paperRows = ui.paperRows;
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  evaluateTemporaryModeFootprint = temporarySession.evaluateTemporaryModeFootprint;
  beginTemporaryProvenance = temporarySession.beginTemporaryProvenance;
  closeSyncPersistenceWorkspace = syncStorage.closeSyncPersistenceWorkspace;
  bindPersonalWorkspaceAccount = syncStorage.bindPersonalWorkspaceAccount;
  hasExplicitOrEstablishedDeviceMode = syncStorage.hasExplicitOrEstablishedDeviceMode;
  loadPaperSyncDeviceProfile = syncStorage.loadPaperSyncDeviceProfile;
  loadTemporarySessionProvenance = syncStorage.loadTemporarySessionProvenance;
  savePaperSyncDeviceProfile = syncStorage.savePaperSyncDeviceProfile;
  normalizeTemporarySessionProvenance = syncStorage.normalizeTemporarySessionProvenance;
});

after(async () => {
  await server?.close();
  restoreGlobal('sessionStorage', originalSessionStorage);
  restoreGlobal('localStorage', originalLocalStorage);
  restoreGlobal('navigator', originalNavigator);
  restoreGlobal('indexedDB', originalIndexedDb);
  restoreGlobal(IDB_HARNESS_SYMBOL, originalIdbHarness);
});

test('personal and temporary workspaces isolate the same document ID', () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  const documentId = 'same-document-id';
  const personalDatabaseNames = [
    workspace.PERSONAL_ANNOTATION_DATABASE_NAME,
    workspace.PERSONAL_PRODUCTIVITY_DATABASE_NAME,
    workspace.PERSONAL_SYNC_DATABASE_NAME,
  ];

  const personalRecords = personalDatabaseNames.map((databaseName) => ({
    databaseName: workspace.scopedDatabaseName(databaseName),
    documentId,
  }));
  assert.deepEqual(
    personalRecords.map((record) => record.databaseName),
    ['39note-db', '39note-productivity-db', '39note-sync'],
  );

  storage.setItem(
    ACTIVE_WORKSPACE_KEY,
    JSON.stringify({ version: 1, id: VALID_WORKSPACE_ID }),
  );
  const temporaryRecords = personalDatabaseNames.map((databaseName) => ({
    databaseName: workspace.scopedDatabaseName(databaseName),
    documentId,
  }));
  assert.deepEqual(
    temporaryRecords.map((record) => record.databaseName),
    personalDatabaseNames.map(
      (databaseName) => `${databaseName}--temporary--${VALID_WORKSPACE_ID}`,
    ),
  );
  for (let index = 0; index < personalRecords.length; index += 1) {
    assert.equal(temporaryRecords[index].documentId, personalRecords[index].documentId);
    assert.notEqual(
      temporaryRecords[index].databaseName,
      personalRecords[index].databaseName,
    );
  }

  assert.equal(
    workspace.scopedLocalStorageKey('39note.ai.provider.v1'),
    `39note.ai.provider.v1.temporary-workspace.${VALID_WORKSPACE_ID}`,
  );

  const persistenceSources = [
    source('../src/services/annotationPersistence.ts'),
    source('../src/services/productivityPersistence.ts'),
    source('../src/sync/storage.ts'),
  ];
  for (const persistenceSource of persistenceSources) {
    assert.match(persistenceSource, /scopedDatabaseName\(/u);
  }
});

test('workspace markers accept only versioned UUIDv4 identities', () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  storage.setItem(
    ACTIVE_WORKSPACE_KEY,
    JSON.stringify({ version: 1, id: VALID_WORKSPACE_ID }),
  );
  assert.equal(workspace.getActiveTemporaryWorkspaceId(), VALID_WORKSPACE_ID);
  assert.equal(
    workspace.temporaryDatabaseName('39note-sync', VALID_WORKSPACE_ID),
    `39note-sync--temporary--${VALID_WORKSPACE_ID}`,
  );

  for (const invalid of [
    '{not-json',
    JSON.stringify({ version: 2, id: VALID_WORKSPACE_ID }),
    JSON.stringify({ version: 1, id: '7a34d3f1-1d2e-3a5b-8c6d-1234567890ab' }),
    JSON.stringify({ version: 1, id: 'shared-device' }),
  ]) {
    storage.setItem(ACTIVE_WORKSPACE_KEY, invalid);
    assert.equal(workspace.getActiveTemporaryWorkspaceId(), null);
  }
  assert.throws(
    () => workspace.temporaryDatabaseName('39note-sync', 'shared-device'),
    /Invalid temporary workspace database identity/u,
  );
  assert.throws(
    () => workspace.temporaryDatabaseName('unregistered-db', VALID_WORKSPACE_ID),
    /Invalid temporary workspace database identity/u,
  );
});

test('temporary provenance accepts only exact UUID-scoped safe records', () => {
  const valid = {
    id: 'temporary',
    temporarySessionId: VALID_WORKSPACE_ID,
    accountId: 'verified-account-a',
    rootFolderId: 'verified-root-a',
    createdAt: 1,
    documentIds: ['paper-a', 'paper-a'],
    collectionIds: ['collection-a'],
    finishPhase: 'active',
  };
  assert.deepEqual(normalizeTemporarySessionProvenance(valid), {
    ...valid,
    documentIds: ['paper-a'],
  });
  for (const malformed of [
    { ...valid, temporarySessionId: 'not-a-uuid' },
    { ...valid, accountId: ' account-a' },
    { ...valid, rootFolderId: 'root-a\nunsafe' },
    { ...valid, createdAt: -1 },
    { ...valid, documentIds: [''] },
    { ...valid, collectionIds: [123] },
    { ...valid, finishPhase: 'unknown' },
  ]) {
    assert.throws(
      () => normalizeTemporarySessionProvenance(malformed),
      /Invalid temporary workspace provenance/u,
    );
  }
});

test('workspace creation registers a valid UUID before publishing its session marker', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  registry.opens.length = 0;
  registry.records.clear();
  registry.stores.length = 0;

  const record = await workspace.beginTemporaryWorkspace();
  assert.match(record.id, UUID_V4_PATTERN);
  assert.deepEqual(registry.opens, [{ name: '39note-workspace-registry', version: 1 }]);
  assert.deepEqual(registry.stores, [{ name: 'temporary-workspaces', keyPath: 'id' }]);
  assert.deepEqual(registry.records.get(record.id), record);
  assert.deepEqual(JSON.parse(storage.getItem(ACTIVE_WORKSPACE_KEY) ?? 'null'), {
    version: 1,
    id: record.id,
  });
  assert.equal(record.annotationDatabaseName, `39note-db--temporary--${record.id}`);
  assert.equal(
    record.productivityDatabaseName,
    `39note-productivity-db--temporary--${record.id}`,
  );
  assert.equal(record.syncDatabaseName, `39note-sync--temporary--${record.id}`);

  await workspace.completeTemporaryWorkspace(record);
  assert.equal(registry.records.has(record.id), false);
  assert.equal(storage.getItem(ACTIVE_WORKSPACE_KEY), null);
});

test('one-time startup handoff preserves the newly created workspace and its exclusive lock', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  registry.records.clear();

  const record = await workspace.beginTemporaryWorkspace();
  const handoff = JSON.parse(storage.getItem(STARTUP_HANDOFF_KEY) ?? 'null') as Record<
    string,
    unknown
  >;
  assert.equal(handoff.version, 1);
  assert.equal(handoff.id, record.id);
  assert.equal(handoff.purpose, 'workspace-created');
  assert.equal(typeof handoff.createdAt, 'number');
  assert.equal(handoff.oauthLeaseId, undefined);
  assert.equal(
    (
      registry.records.get(record.id) as
        | import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord
        | undefined
    )?.oauthLease,
    undefined,
  );
  assert.equal(
    browserLocks.heldNames.has(`39note:temporary-workspace:${record.id}`),
    true,
  );

  const report = await workspace.prepareTemporaryWorkspaceStartup();
  assert.deepEqual(report, {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [record.id],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.equal(storage.getItem(STARTUP_HANDOFF_KEY), null);
  assert.deepEqual(workspace.getTemporaryWorkspaceStartupCleanupReport(), report);
  assert.equal(registry.records.has(record.id), true);

  await workspace.completeTemporaryWorkspace(record);
  await Promise.resolve();
  assert.equal(
    browserLocks.heldNames.has(`39note:temporary-workspace:${record.id}`),
    false,
  );
});

test('startup clears an abandoned active workspace when no valid handoff exists', async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(local);
  registry.deletedDatabases.length = 0;
  registry.deleteFailureCounts.clear();
  registry.records.clear();

  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID);
  const suffix = `.temporary-workspace.${record.id}`;
  registry.records.set(record.id, record);
  session.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify({ version: 1, id: record.id }));
  session.setItem(`39note.ai.session.v1${suffix}`, 'temporary-ai-session');
  session.setItem(
    `39note.google-drive.temporary-session${suffix}`,
    'temporary-google-session',
  );
  session.setItem(
    `39note.google-drive.pending-exchange${suffix}`,
    'temporary-oauth-state',
  );
  local.setItem(`39note.ai.provider.v1${suffix}`, 'temporary-provider-key');
  local.setItem('39note.ai.provider.v1', 'personal-provider-key');

  const report = await workspace.prepareTemporaryWorkspaceStartup();

  assert.deepEqual(report, {
    cleanedWorkspaceIds: [record.id],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, [
    record.annotationDatabaseName,
    record.productivityDatabaseName,
    record.syncDatabaseName,
  ]);
  assert.equal(registry.records.has(record.id), false);
  assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY), null);
  assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
  assert.equal(session.getItem(`39note.ai.session.v1${suffix}`), null);
  assert.equal(session.getItem(`39note.google-drive.temporary-session${suffix}`), null);
  assert.equal(session.getItem(`39note.google-drive.pending-exchange${suffix}`), null);
  assert.equal(local.getItem(`39note.ai.provider.v1${suffix}`), null);
  assert.equal(local.getItem('39note.ai.provider.v1'), 'personal-provider-key');
});

test('a valid OAuth-return handoff preserves its workspace exactly once', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  installLocalStorage(memoryStorage());
  registry.records.clear();
  const restoreWindow = installWindowHash('#sync_auth_grant=synthetic-grant');

  try {
    const record = await workspace.beginTemporaryWorkspace();
    await workspace.armTemporaryWorkspaceOAuthReturn();
    const handoff = JSON.parse(
      storage.getItem(STARTUP_HANDOFF_KEY) ?? 'null',
    ) as Record<string, unknown>;
    assert.equal(handoff.id, record.id);
    assert.equal(handoff.purpose, 'oauth-return');
    assert.match(String(handoff.oauthLeaseId), UUID_V4_PATTERN);
    const leasedRecord = registry.records.get(record.id) as
      | (import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord & {
          oauthLease?: {
            version: 1;
            id: string;
            createdAt: number;
            expiresAt: number;
          };
        })
      | undefined;
    assert.equal(leasedRecord?.oauthLease?.id, handoff.oauthLeaseId);
    assert.equal(leasedRecord?.oauthLease?.createdAt, handoff.createdAt);
    assert.equal(
      (leasedRecord?.oauthLease?.expiresAt ?? 0) -
        (leasedRecord?.oauthLease?.createdAt ?? 0),
      20 * 60_000,
    );

    const report = await workspace.prepareTemporaryWorkspaceStartup();
    assert.deepEqual(report, {
      cleanedWorkspaceIds: [],
      activeWorkspaceIds: [record.id],
      ambiguousWorkspaceIds: [],
      failedWorkspaceIds: [],
    });
    assert.equal(storage.getItem(STARTUP_HANDOFF_KEY), null);
    assert.equal(registry.records.has(record.id), true);

    await workspace.completeTemporaryWorkspace(record);
    await Promise.resolve();
  } finally {
    restoreWindow();
  }
});

test('a cloned OAuth handoff without the callback cannot revoke an in-flight lease', async () => {
  const originalSession = memoryStorage();
  const clonedSession = memoryStorage();
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now,
    expiresAt: now + 20 * 60_000,
  });
  registry.records.set(record.id, record);
  const activeMarker = JSON.stringify({ version: 1, id: record.id });
  const handoffMarker = JSON.stringify({
    version: 1,
    id: record.id,
    purpose: 'oauth-return',
    createdAt: now,
    oauthLeaseId: OAUTH_LEASE_ID,
  });
  for (const storage of [originalSession, clonedSession]) {
    storage.setItem(ACTIVE_WORKSPACE_KEY, activeMarker);
    storage.setItem(STARTUP_HANDOFF_KEY, handoffMarker);
  }
  installSessionStorage(clonedSession);
  const restoreWindow = installWindowHash('');

  try {
    assert.equal(
      browserLocks.heldNames.has(`39note:temporary-workspace:${record.id}`),
      false,
    );
    await assert.rejects(
      workspace.prepareTemporaryWorkspaceStartup(),
      /could not be safely cleared/u,
    );
    assert.deepEqual(registry.deletedDatabases, []);
    assert.equal(registry.records.has(record.id), true);
    assert.equal(clonedSession.getItem(STARTUP_HANDOFF_KEY), null);
    assert.equal(originalSession.getItem(STARTUP_HANDOFF_KEY), handoffMarker);
  } finally {
    registry.records.clear();
    clonedSession.clear();
    originalSession.clear();
    restoreWindow();
  }
});

test('an expired OAuth-return handoff and lease are cleaned exactly', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const createdAt = Date.now() - 20 * 60_000 - 1;
  const record = temporaryWorkspaceRecord(SECOND_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt,
    expiresAt: createdAt + 20 * 60_000,
  });
  registry.records.set(record.id, record);
  session.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify({ version: 1, id: record.id }));
  session.setItem(
    STARTUP_HANDOFF_KEY,
    JSON.stringify({
      version: 1,
      id: record.id,
      purpose: 'oauth-return',
      createdAt,
      oauthLeaseId: OAUTH_LEASE_ID,
    }),
  );
  const restoreWindow = installWindowHash('#sync_auth_error=synthetic-error');

  try {
    const report = await workspace.prepareTemporaryWorkspaceStartup();
    assert.deepEqual(report, {
      cleanedWorkspaceIds: [record.id],
      activeWorkspaceIds: [],
      ambiguousWorkspaceIds: [],
      failedWorkspaceIds: [],
    });
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY), null);
    assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
    assert.equal(registry.records.has(record.id), false);
  } finally {
    restoreWindow();
  }
});

test('a mismatched OAuth-return handoff cannot consume another lease', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now,
    expiresAt: now + 20 * 60_000,
  });
  registry.records.set(record.id, record);
  session.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify({ version: 1, id: record.id }));
  session.setItem(
    STARTUP_HANDOFF_KEY,
    JSON.stringify({
      version: 1,
      id: record.id,
      purpose: 'oauth-return',
      createdAt: now,
      oauthLeaseId: THIRD_WORKSPACE_ID,
    }),
  );
  const restoreWindow = installWindowHash('#sync_auth_grant=synthetic-grant');

  try {
    await assert.rejects(
      workspace.prepareTemporaryWorkspaceStartup(),
      /could not be safely cleared/u,
    );
    assert.deepEqual(registry.deletedDatabases, []);
    assert.equal(registry.records.has(record.id), true);
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY) !== null, true);
    assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
  } finally {
    registry.records.clear();
    session.clear();
    restoreWindow();
  }
});

test('a stale creation handoff cannot reopen a workspace after OAuth leasing begins', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now,
    expiresAt: now + 20 * 60_000,
  });
  registry.records.set(record.id, record);
  session.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify({ version: 1, id: record.id }));
  session.setItem(
    STARTUP_HANDOFF_KEY,
    JSON.stringify({
      version: 1,
      id: record.id,
      purpose: 'workspace-created',
      createdAt: now,
    }),
  );

  await assert.rejects(
    workspace.prepareTemporaryWorkspaceStartup(),
    /could not be safely cleared/u,
  );
  assert.deepEqual(registry.deletedDatabases, []);
  assert.equal(registry.records.has(record.id), true);
  assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
  registry.records.clear();
  session.clear();
});

test('an unexpired OAuth navigation lease survives cleanup without a held Web Lock', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now,
    expiresAt: now + 20 * 60_000,
  });
  registry.records.set(record.id, record);

  assert.equal(
    browserLocks.heldNames.has(`39note:temporary-workspace:${record.id}`),
    false,
  );
  const report = await workspace.cleanupAbandonedTemporaryWorkspaces(null);

  assert.deepEqual(report, {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [record.id],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, []);
  assert.equal(registry.records.has(record.id), true);
  registry.records.clear();
});

test('a bounded OAuth lease survives apparent clock rollback', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now + 60_000,
    expiresAt: now + 21 * 60_000,
  });
  registry.records.set(record.id, record);

  const report = await workspace.prepareTemporaryWorkspaceStartup();

  assert.deepEqual(report, {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [record.id],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, []);
  assert.equal(registry.records.has(record.id), true);
  registry.records.clear();
});

test('an expired OAuth navigation lease no longer blocks deterministic cleanup', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const now = Date.now();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, 1, {
    version: 1,
    id: OAUTH_LEASE_ID,
    createdAt: now - 20 * 60_000,
    expiresAt: now - 1,
  });
  registry.records.set(record.id, record);

  const report = await workspace.cleanupAbandonedTemporaryWorkspaces(null);

  assert.deepEqual(report, {
    cleanedWorkspaceIds: [record.id],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, [
    record.annotationDatabaseName,
    record.productivityDatabaseName,
    record.syncDatabaseName,
  ]);
  assert.equal(registry.records.has(record.id), false);
});

test('clearing an OAuth return removes only the active workspace lease and handoff', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.records.clear();
  const record = await workspace.beginTemporaryWorkspace();

  try {
    await workspace.armTemporaryWorkspaceOAuthReturn();
    assert.ok(
      (
        registry.records.get(record.id) as
          | import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord
          | undefined
      )?.oauthLease,
    );
    assert.notEqual(session.getItem(STARTUP_HANDOFF_KEY), null);

    await workspace.clearTemporaryWorkspaceOAuthReturn();

    assert.equal(
      (
        registry.records.get(record.id) as
          | import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord
          | undefined
      )?.oauthLease,
      undefined,
    );
    assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY) !== null, true);
  } finally {
    await workspace.completeTemporaryWorkspace(record);
    await Promise.resolve();
  }
});

test('a failed OAuth handoff write rolls its lease back before navigation', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.records.clear();
  const record = await workspace.beginTemporaryWorkspace();
  const rejectingSession: Storage = {
    get length() {
      return session.length;
    },
    clear() {
      session.clear();
    },
    getItem(key) {
      return session.getItem(key);
    },
    key(index) {
      return session.key(index);
    },
    removeItem(key) {
      session.removeItem(key);
    },
    setItem(key, value) {
      if (key === STARTUP_HANDOFF_KEY) {
        throw new Error('Synthetic sessionStorage write failure');
      }
      session.setItem(key, value);
    },
  };
  installSessionStorage(rejectingSession);

  try {
    await assert.rejects(
      workspace.armTemporaryWorkspaceOAuthReturn(),
      /Synthetic sessionStorage write failure/u,
    );
    assert.equal(
      (
        registry.records.get(record.id) as
          | import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord
          | undefined
      )?.oauthLease,
      undefined,
    );
    assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
  } finally {
    installSessionStorage(session);
    await workspace.completeTemporaryWorkspace(record);
    await Promise.resolve();
  }
});

test('startup removes only attributable legacy temporary OAuth state', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.records.clear();

  session.setItem('39note.google-drive.temporary-session', 'legacy-session');
  session.setItem(
    '39note.google-drive.pending-exchange',
    JSON.stringify({ sessionMode: 'temporary', verifier: 'not-a-real-verifier' }),
  );
  await workspace.prepareTemporaryWorkspaceStartup();
  assert.equal(session.getItem('39note.google-drive.temporary-session'), null);
  assert.equal(session.getItem('39note.google-drive.pending-exchange'), null);

  const personalPending = JSON.stringify({
    sessionMode: 'personal',
    verifier: 'personal-state',
  });
  session.setItem('39note.google-drive.temporary-session', 'legacy-session');
  session.setItem('39note.google-drive.pending-exchange', personalPending);
  await workspace.prepareTemporaryWorkspaceStartup();
  assert.equal(session.getItem('39note.google-drive.temporary-session'), null);
  assert.equal(
    session.getItem('39note.google-drive.pending-exchange'),
    personalPending,
  );

  session.setItem('39note.google-drive.pending-exchange', '{malformed');
  await workspace.prepareTemporaryWorkspaceStartup();
  assert.equal(session.getItem('39note.google-drive.pending-exchange'), '{malformed');
});

test(
  'a rejected browser-lock request fails workspace creation and rolls back markers',
  { timeout: 1_000 },
  async () => {
    const session = memoryStorage();
    installSessionStorage(session);
    installLocalStorage(memoryStorage());
    registry.records.clear();
    const rejectingLocks = {
      async request(): Promise<never> {
        throw new Error('Synthetic browser-lock failure');
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: rejectingLocks },
      writable: true,
    });

    try {
      await assert.rejects(
        workspace.beginTemporaryWorkspace(),
        /Temporary workspace storage is unavailable/u,
      );
      assert.equal(registry.records.size, 0);
      assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY), null);
      assert.equal(session.getItem(STARTUP_HANDOFF_KEY), null);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { locks: browserLocks },
        writable: true,
      });
    }
  },
);

test('cleanup deletes only the active registered temporary workspace', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  registry.deletedDatabases.length = 0;
  registry.records.clear();

  const first = temporaryWorkspaceRecord(VALID_WORKSPACE_ID);
  registry.records.set(first.id, first);
  const second = await workspace.beginTemporaryWorkspace();

  await assert.rejects(
    workspace.deleteTemporaryWorkspaceDatabases(first),
    /ownership could not be verified/u,
  );
  assert.deepEqual(registry.deletedDatabases, []);

  await workspace.deleteTemporaryWorkspaceDatabases(second);
  assert.deepEqual(registry.deletedDatabases, [
    second.annotationDatabaseName,
    second.productivityDatabaseName,
    second.syncDatabaseName,
  ]);
  assert.equal(
    registry.deletedDatabases.some((name) =>
      ['39note-db', '39note-productivity-db', '39note-sync'].includes(name),
    ),
    false,
  );
  assert.equal(registry.records.has(first.id), true);
  await workspace.completeTemporaryWorkspace(second);
  registry.records.delete(first.id);
});

test('crash cleanup removes only the exact orphan databases and storage keys', async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(local);
  registry.deletedDatabases.length = 0;
  registry.records.clear();

  const orphan = temporaryWorkspaceRecord(VALID_WORKSPACE_ID);
  registry.records.set(orphan.id, orphan);
  const current = await workspace.beginTemporaryWorkspace();
  try {
    const orphanSuffix = `.temporary-workspace.${orphan.id}`;
    const currentSuffix = `.temporary-workspace.${current.id}`;
    local.setItem(`39note.ai.provider.v1${orphanSuffix}`, 'orphan-secret');
    session.setItem(`39note.ai.session.v1${orphanSuffix}`, 'orphan-session');
    session.setItem(
      `39note.google-drive.temporary-session${orphanSuffix}`,
      'orphan-temporary-auth',
    );
    session.setItem(
      `39note.google-drive.pending-exchange${orphanSuffix}`,
      'orphan-oauth-verifier',
    );
    local.setItem(`39note.ai.provider.v1${currentSuffix}`, 'current-secret');
    local.setItem('39note.ai.provider.v1', 'personal-secret');
    local.setItem(`unrelated${orphanSuffix}`, 'not-owned-by-ai-storage');
    local.setItem(`39note.ai.provider.v1${orphanSuffix}.extra`, 'not-an-exact-suffix');

    const report = await workspace.cleanupAbandonedTemporaryWorkspaces(current.id);

    assert.deepEqual(report, {
      cleanedWorkspaceIds: [orphan.id],
      activeWorkspaceIds: [current.id],
      ambiguousWorkspaceIds: [],
      failedWorkspaceIds: [],
    });
    assert.deepEqual(registry.deletedDatabases, [
      orphan.annotationDatabaseName,
      orphan.productivityDatabaseName,
      orphan.syncDatabaseName,
    ]);
    assert.equal(
      registry.deletedDatabases.some((name) =>
        [
          workspace.PERSONAL_ANNOTATION_DATABASE_NAME,
          workspace.PERSONAL_PRODUCTIVITY_DATABASE_NAME,
          workspace.PERSONAL_SYNC_DATABASE_NAME,
        ].includes(name),
      ),
      false,
    );
    assert.equal(registry.records.has(orphan.id), false);
    assert.equal(registry.records.has(current.id), true);
    assert.equal(local.getItem(`39note.ai.provider.v1${orphanSuffix}`), null);
    assert.equal(session.getItem(`39note.ai.session.v1${orphanSuffix}`), null);
    assert.equal(
      session.getItem(`39note.google-drive.temporary-session${orphanSuffix}`),
      null,
    );
    assert.equal(
      session.getItem(`39note.google-drive.pending-exchange${orphanSuffix}`),
      null,
    );
    assert.equal(
      local.getItem(`39note.ai.provider.v1${currentSuffix}`),
      'current-secret',
    );
    assert.equal(local.getItem('39note.ai.provider.v1'), 'personal-secret');
    assert.equal(local.getItem(`unrelated${orphanSuffix}`), 'not-owned-by-ai-storage');
    assert.equal(
      local.getItem(`39note.ai.provider.v1${orphanSuffix}.extra`),
      'not-an-exact-suffix',
    );
  } finally {
    await workspace.completeTemporaryWorkspace(current);
    await Promise.resolve();
  }
});

test('cleanup leaves a workspace untouched while another tab holds its lock', async () => {
  installSessionStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const record = temporaryWorkspaceRecord(VALID_WORKSPACE_ID);
  registry.records.set(record.id, record);
  const release = browserLocks.hold(`39note:temporary-workspace:${record.id}`);

  try {
    const report = await workspace.cleanupAbandonedTemporaryWorkspaces(null);
    assert.deepEqual(report, {
      cleanedWorkspaceIds: [],
      activeWorkspaceIds: [record.id],
      ambiguousWorkspaceIds: [],
      failedWorkspaceIds: [],
    });
    assert.deepEqual(registry.deletedDatabases, []);
    assert.equal(registry.records.has(record.id), true);
  } finally {
    release();
  }
});

test('legacy records without deterministic ownership remain ambiguous and are never deleted', async () => {
  installSessionStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  registry.records.clear();
  const legacy = temporaryWorkspaceRecord(VALID_WORKSPACE_ID, null);
  registry.records.set(legacy.id, legacy);

  const report = await workspace.cleanupAbandonedTemporaryWorkspaces(null);

  assert.deepEqual(report, {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [legacy.id],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, []);
  assert.equal(registry.records.has(legacy.id), true);
});

test('interrupted orphan deletion is resumable and removes the registry record last', async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(local);
  registry.deletedDatabases.length = 0;
  registry.deleteFailureCounts.clear();
  registry.records.clear();
  const record = temporaryWorkspaceRecord(THIRD_WORKSPACE_ID);
  registry.records.set(record.id, record);
  const ownedKey = `39note.ai.provider.v1.temporary-workspace.${record.id}`;
  local.setItem(ownedKey, 'temporary-secret');
  registry.deleteFailureCounts.set(record.productivityDatabaseName, 1);

  const interrupted = await workspace.cleanupAbandonedTemporaryWorkspaces(null);
  assert.deepEqual(interrupted, {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [record.id],
  });
  assert.deepEqual(registry.deletedDatabases, [record.annotationDatabaseName]);
  assert.equal(registry.records.has(record.id), true);
  assert.equal(local.getItem(ownedKey), 'temporary-secret');

  const resumed = await workspace.cleanupAbandonedTemporaryWorkspaces(null);
  assert.deepEqual(resumed, {
    cleanedWorkspaceIds: [record.id],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  });
  assert.deepEqual(registry.deletedDatabases, [
    record.annotationDatabaseName,
    record.annotationDatabaseName,
    record.productivityDatabaseName,
    record.syncDatabaseName,
  ]);
  assert.equal(registry.records.has(record.id), false);
  assert.equal(local.getItem(ownedKey), null);
});

test('isolated temporary mode does not reject occupied personal storage', () => {
  assert.deepEqual(
    evaluateTemporaryModeFootprint({
      annotationDocumentCount: 2,
      pdfDocumentCount: 1,
      collectionCount: 3,
      printDraftCount: 1,
      conversationCount: 2,
      aiStorageKeyCount: 5,
      paperStateCount: 2,
      cloudPaperCount: 2,
      hasMigration: true,
      hasProvenance: false,
      hasPaperAccountState: true,
      hasLegacyAccountState: true,
    }),
    { safe: true },
  );
});

test('zero-dirty temporary sessions expose an enabled Finish without forcing upload', () => {
  const state = viewState({ deviceMode: 'temporary' });
  const html = renderDrawer(state);
  const finishButton = html.match(
    /<button class="sync-finish-button"[^>]*>Finish on this device<\/button>/u,
  )?.[0];
  assert.ok(finishButton);
  assert.doesNotMatch(finishButton, /disabled/u);
  assert.deepEqual(paperRows(state, 'finish'), []);

  const coordinatorSource = source('../src/sync/paperCoordinator.ts');
  const finishOwned = sourceSection(
    coordinatorSource,
    'private async finishTemporaryDeviceOwned(',
    '\n  cancel(): void',
  );
  const guardedUpload = sourceSection(
    finishOwned,
    'if (selected.length)',
    'const remaining = this.getDirtyPaperIds()',
  );
  assert.match(guardedUpload, /await this\.uploadSelected\(selected\)/u);
  assert.doesNotMatch(
    finishOwned.slice(finishOwned.indexOf('const remaining')),
    /uploadSelected/u,
  );

  const selectorSource = sourceSection(
    source('../src/sync/PaperSyncControl.tsx'),
    'function PaperSelectorDialog(',
    '\nfunction RemoteUpdateRecommendation(',
  );
  assert.match(
    selectorSource,
    /disabled=\{busy \|\| \(mode !== 'finish' && selected\.size === 0\)\}/u,
  );
  assert.match(
    selectorSource,
    /selected\.size > 0[\s\S]*?'Upload selected and finish'[\s\S]*?: 'Finish on this device'/u,
  );
});

test('temporary-device policy keeps Auto sync off before any publication can be scheduled', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  registry.records.clear();
  const workspaceRecord = await workspace.beginTemporaryWorkspace();
  try {
    const profile = await loadPaperSyncDeviceProfile();
    assert.equal(profile.deviceMode, 'temporary');
    assert.equal(profile.autoSync, false);

    profile.autoSync = true;
    await savePaperSyncDeviceProfile(profile);
    const persisted = await loadPaperSyncDeviceProfile();
    assert.equal(persisted.deviceMode, 'temporary');
    assert.equal(persisted.autoSync, false);

    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'profile', persisted satisfies PaperSyncDeviceProfile);
    Reflect.set(
      coordinator,
      'view',
      viewState({
        deviceMode: 'temporary',
        autoSync: false,
        dirtyPaperIds: ['synthetic-paper'],
      }),
    );
    Reflect.set(
      coordinator,
      'paperStates',
      new Map([
        [
          'synthetic-paper',
          {
            documentId: 'synthetic-paper',
            dirtyReasons: ['notes'],
            status: 'local-changes',
            cloudPresence: 'present',
          },
        ],
      ]),
    );
    let scheduledPublications = 0;
    Reflect.set(coordinator, 'scheduleAutoUpload', () => {
      scheduledPublications += 1;
    });

    await coordinator.setAutoSync(true);
    assert.equal(coordinator.getSnapshot().autoSync, false);
    assert.equal(persisted.autoSync, false);
    assert.equal(scheduledPublications, 0);
  } finally {
    await closeSyncPersistenceWorkspace();
    await workspace.completeTemporaryWorkspace(workspaceRecord);
    registry.records.delete('paper-device');
  }
});

test('temporary provenance cannot be rebound to a different Drive root', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  const record = await workspace.beginTemporaryWorkspace();
  try {
    const bound = await beginTemporaryProvenance('verified-account-a', 'root-a');
    assert.equal(bound.rootFolderId, 'root-a');
    await assert.rejects(
      beginTemporaryProvenance('verified-account-a', 'root-b'),
      /different Google-backed 39Note workspace/u,
    );
    const persisted = await loadTemporarySessionProvenance();
    assert.equal(persisted?.rootFolderId, 'root-a');
    assert.equal(persisted?.accountId, 'verified-account-a');
  } finally {
    await closeSyncPersistenceWorkspace();
    await workspace.deleteTemporaryWorkspaceDatabases(record);
    await workspace.completeTemporaryWorkspace(record);
  }
});

test('device-mode choice and legacy certainty survive reload without a migration', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  await closeSyncPersistenceWorkspace();
  registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);

  try {
    const fresh = await loadPaperSyncDeviceProfile();
    assert.equal(fresh.deviceMode, 'personal');
    assert.equal(fresh.deviceModeChoiceConfirmed, undefined);
    assert.equal(hasExplicitOrEstablishedDeviceMode(fresh), false);

    fresh.deviceModeChoiceConfirmed = true;
    await savePaperSyncDeviceProfile(fresh);
    await closeSyncPersistenceWorkspace();
    const confirmed = await loadPaperSyncDeviceProfile();
    assert.equal(confirmed.deviceMode, 'personal');
    assert.equal(confirmed.deviceModeChoiceConfirmed, true);
    assert.equal(hasExplicitOrEstablishedDeviceMode(confirmed), true);

    const profileStore = registry.databaseRecords
      .get(workspace.PERSONAL_SYNC_DATABASE_NAME)
      ?.get('paper-device');
    assert.ok(profileStore);
    profileStore.set('paper-device', {
      id: 'paper-device',
      deviceId: 'legacy-ambiguous-device',
      deviceLabel: 'Legacy device',
      deviceMode: 'personal',
      autoSync: true,
    });
    await closeSyncPersistenceWorkspace();
    const ambiguous = await loadPaperSyncDeviceProfile();
    assert.equal(ambiguous.deviceModeChoiceConfirmed, undefined);
    assert.equal(hasExplicitOrEstablishedDeviceMode(ambiguous), false);

    profileStore.set('paper-device', {
      ...ambiguous,
      googleDeviceSessionToken: 's'.repeat(43),
    });
    await closeSyncPersistenceWorkspace();
    const establishedLegacy = await loadPaperSyncDeviceProfile();
    assert.equal(establishedLegacy.deviceModeChoiceConfirmed, undefined);
    assert.equal(hasExplicitOrEstablishedDeviceMode(establishedLegacy), true);

    const temporary = await workspace.beginTemporaryWorkspace();
    try {
      await closeSyncPersistenceWorkspace();
      const publicProfile = await loadPaperSyncDeviceProfile();
      assert.equal(publicProfile.deviceMode, 'temporary');
      assert.equal(publicProfile.deviceModeChoiceConfirmed, true);
      assert.equal(publicProfile.autoSync, false);
      assert.equal(hasExplicitOrEstablishedDeviceMode(publicProfile), true);
    } finally {
      await closeSyncPersistenceWorkspace();
      await workspace.deleteTemporaryWorkspaceDatabases(temporary);
      await workspace.completeTemporaryWorkspace(temporary);
    }
  } finally {
    await closeSyncPersistenceWorkspace();
    registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);
  }
});

test('personal workspace account binding is atomic and immutable across reopen', async () => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());
  await closeSyncPersistenceWorkspace();
  registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);

  try {
    const created = await loadPaperSyncDeviceProfile();
    assert.equal(created.workspaceAccountId, undefined);

    await assert.rejects(
      bindPersonalWorkspaceAccount(' verified-account-a'),
      /associated with a different Google account/u,
    );

    await bindPersonalWorkspaceAccount('verified-account-a');
    await closeSyncPersistenceWorkspace();
    const rebound = await loadPaperSyncDeviceProfile();
    assert.equal(rebound.workspaceAccountId, 'verified-account-a');
    assert.equal(rebound.deviceModeChoiceConfirmed, true);

    await assert.rejects(
      bindPersonalWorkspaceAccount('verified-account-b'),
      /associated with a different Google account/u,
    );
    await assert.rejects(
      savePaperSyncDeviceProfile({
        ...rebound,
        workspaceAccountId: 'verified-account-b',
      }),
      /associated with a different Google account/u,
    );

    await closeSyncPersistenceWorkspace();
    const persisted = await loadPaperSyncDeviceProfile();
    assert.equal(persisted.workspaceAccountId, 'verified-account-a');
    assert.equal(persisted.deviceMode, 'personal');

    const profileStore = registry.databaseRecords
      .get(workspace.PERSONAL_SYNC_DATABASE_NAME)
      ?.get('paper-device');
    const stored = profileStore?.get('paper-device');
    assert.ok(stored);
    profileStore?.set('paper-device', {
      ...stored,
      workspaceAccountId: ' verified-account-a',
    });
    await closeSyncPersistenceWorkspace();
    await assert.rejects(
      loadPaperSyncDeviceProfile(),
      /could not save changes locally/u,
    );
  } finally {
    await closeSyncPersistenceWorkspace();
    registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);
  }
});

test('personal workspace account binding is first-writer-wins under deterministic races', async (context) => {
  installSessionStorage(memoryStorage());
  installLocalStorage(memoryStorage());

  const deferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };

  const resetPersonalWorkspace = async () => {
    await closeSyncPersistenceWorkspace();
    registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);
    registry.transactionQueues.clear();
    registry.transactionReadControls.length = 0;
    const created = await loadPaperSyncDeviceProfile();
    assert.equal(created.workspaceAccountId, undefined);
  };

  const pauseNextTransactionRead = (error?: Error) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    registry.transactionReadControls.push({
      entered: () => entered.resolve(),
      release: release.promise,
      ...(error ? { error } : {}),
    });
    return { entered: entered.promise, release: () => release.resolve() };
  };

  const twoActorReadBarrier = () => {
    let arrivals = 0;
    const ready = deferred<void>();
    return {
      ready: ready.promise,
      async arrive() {
        arrivals += 1;
        if (arrivals === 2) ready.resolve();
        await ready.promise;
      },
    };
  };

  try {
    await context.test(
      'simultaneous A/B transactions serialize and the pending loser cannot overwrite A',
      async () => {
        await resetPersonalWorkspace();
        const firstRead = pauseNextTransactionRead();
        const accountA = bindPersonalWorkspaceAccount('verified-account-a');
        await firstRead.entered;
        const accountB = bindPersonalWorkspaceAccount('verified-account-b');
        firstRead.release();
        const [aResult, bResult] = await Promise.allSettled([accountA, accountB]);
        assert.equal(aResult.status, 'fulfilled');
        assert.equal(bResult.status, 'rejected');
        assert.match(String(bResult.reason), /different Google account/u);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-a',
        );
        await assert.rejects(
          bindPersonalWorkspaceAccount('verified-account-b'),
          /different Google account/u,
        );
      },
    );

    await context.test(
      'both actors can observe unbound while B verification resolves first without relabeling',
      async () => {
        await resetPersonalWorkspace();
        const reads = twoActorReadBarrier();
        const verifiedA = deferred<string>();
        const verifiedB = deferred<string>();
        const observations: Array<string | undefined> = [];
        const actor = async (verified: Promise<string>) => {
          observations.push((await loadPaperSyncDeviceProfile()).workspaceAccountId);
          await reads.arrive();
          return bindPersonalWorkspaceAccount(await verified);
        };
        const accountA = actor(verifiedA.promise);
        const accountB = actor(verifiedB.promise);
        await reads.ready;
        assert.deepEqual(observations, [undefined, undefined]);
        verifiedB.resolve('verified-account-b');
        await accountB;
        verifiedA.resolve('verified-account-a');
        await assert.rejects(accountA, /different Google account/u);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-b',
        );
      },
    );

    await context.test(
      'both actors can observe unbound while A verification resolves first',
      async () => {
        await resetPersonalWorkspace();
        const reads = twoActorReadBarrier();
        const verifiedA = deferred<string>();
        const verifiedB = deferred<string>();
        const actor = async (verified: Promise<string>) => {
          assert.equal(
            (await loadPaperSyncDeviceProfile()).workspaceAccountId,
            undefined,
          );
          await reads.arrive();
          return bindPersonalWorkspaceAccount(await verified);
        };
        const accountB = actor(verifiedB.promise);
        const accountA = actor(verifiedA.promise);
        await reads.ready;
        verifiedA.resolve('verified-account-a');
        await accountA;
        verifiedB.resolve('verified-account-b');
        await assert.rejects(accountB, /different Google account/u);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-a',
        );
      },
    );

    await context.test(
      'an aborted first transaction releases the pending transaction without a false binding',
      async () => {
        await resetPersonalWorkspace();
        const failedRead = pauseNextTransactionRead(
          new Error('Synthetic transaction abort'),
        );
        const accountA = bindPersonalWorkspaceAccount('verified-account-a');
        await failedRead.entered;
        const accountB = bindPersonalWorkspaceAccount('verified-account-b');
        failedRead.release();
        const [aResult, bResult] = await Promise.allSettled([accountA, accountB]);
        assert.equal(aResult.status, 'rejected');
        assert.match(String(aResult.reason), /could not save changes locally/u);
        assert.equal(bResult.status, 'fulfilled');
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-b',
        );
      },
    );

    await context.test(
      'same-account concurrent actors are idempotent rather than mismatched',
      async () => {
        await resetPersonalWorkspace();
        const firstRead = pauseNextTransactionRead();
        const first = bindPersonalWorkspaceAccount('verified-account-a');
        await firstRead.entered;
        const second = bindPersonalWorkspaceAccount('verified-account-a');
        firstRead.release();
        const results = await Promise.allSettled([first, second]);
        assert.deepEqual(
          results.map(({ status }) => status),
          ['fulfilled', 'fulfilled'],
        );
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-a',
        );
      },
    );

    await context.test(
      'explicit legacy adoption wins atomically while a conflicting tab is pending',
      async () => {
        await resetPersonalWorkspace();
        const legacyProfile = await loadPaperSyncDeviceProfile();
        legacyProfile.rootFolderId = 'legacy-managed-root';
        legacyProfile.lastSuccessfulAt = 1;
        await savePaperSyncDeviceProfile(legacyProfile);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          undefined,
        );

        const adoptionRead = pauseNextTransactionRead();
        const explicitAdoption = bindPersonalWorkspaceAccount('verified-account-a');
        await adoptionRead.entered;
        const conflictingTab = bindPersonalWorkspaceAccount('verified-account-b');
        adoptionRead.release();
        const [adoptionResult, conflictingResult] = await Promise.allSettled([
          explicitAdoption,
          conflictingTab,
        ]);
        assert.equal(adoptionResult.status, 'fulfilled');
        assert.equal(conflictingResult.status, 'rejected');
        const persisted = await loadPaperSyncDeviceProfile();
        assert.equal(persisted.workspaceAccountId, 'verified-account-a');
        assert.equal(persisted.rootFolderId, 'legacy-managed-root');
        assert.equal(persisted.lastSuccessfulAt, 1);
      },
    );

    await context.test(
      'reload during a pending bind observes no partial state and later observes the commit',
      async () => {
        await resetPersonalWorkspace();
        const firstRead = pauseNextTransactionRead();
        const binding = bindPersonalWorkspaceAccount('verified-account-a');
        await firstRead.entered;
        await closeSyncPersistenceWorkspace();
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          undefined,
        );
        firstRead.release();
        await binding;
        await closeSyncPersistenceWorkspace();
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-a',
        );
      },
    );

    await context.test(
      'a delayed account-B callback cannot replace an already committed account-A binding',
      async () => {
        await resetPersonalWorkspace();
        const delayedCallback = deferred<string>();
        const callbackBinding = (async () =>
          bindPersonalWorkspaceAccount(await delayedCallback.promise))();
        await bindPersonalWorkspaceAccount('verified-account-a');
        delayedCallback.resolve('verified-account-b');
        await assert.rejects(callbackBinding, /different Google account/u);
        await closeSyncPersistenceWorkspace();
        assert.equal(
          (await loadPaperSyncDeviceProfile()).workspaceAccountId,
          'verified-account-a',
        );
      },
    );
  } finally {
    registry.transactionReadControls.length = 0;
    registry.transactionQueues.clear();
    await closeSyncPersistenceWorkspace();
    registry.databaseRecords.delete(workspace.PERSONAL_SYNC_DATABASE_NAME);
  }
});

test('Finish uses one owned flight and releases it after settlement', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: Array<[readonly string[], boolean]> = [];
  Object.defineProperty(coordinator, 'finishTemporaryDeviceOwned', {
    configurable: true,
    value: async (ids: readonly string[], abandon: boolean) => {
      calls += 1;
      received.push([ids, abandon]);
      if (calls === 1) await gate;
    },
  });

  const first = coordinator.finishTemporaryDevice([], false);
  const duplicate = coordinator.finishTemporaryDevice(['ignored-duplicate'], true);
  assert.equal(calls, 1);
  assert.deepEqual(received, [[[], false]]);
  release();
  await Promise.all([first, duplicate]);

  await coordinator.finishTemporaryDevice(['next-flight'], true);
  assert.equal(calls, 2);
  assert.deepEqual(received[1], [['next-flight'], true]);
});

test('zero-dirty Finish revokes once, cleans only its UUID scope, and never publishes', async () => {
  const session = memoryStorage();
  const local = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(local);
  registry.deletedDatabases.length = 0;
  const personalSentinel = new Map<string, Map<string, Record<string, unknown>>>([
    ['sentinel', new Map([['personal', { id: 'personal', retained: true }]])],
  ]);
  registry.databaseRecords.set(
    workspace.PERSONAL_ANNOTATION_DATABASE_NAME,
    personalSentinel,
  );
  local.setItem('unrelated-personal-setting', 'retained');
  const record = await workspace.beginTemporaryWorkspace();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let reloads = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent() {
        return true;
      },
      location: { reload: () => (reloads += 1) },
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
    },
  });

  try {
    const profile = await loadPaperSyncDeviceProfile();
    profile.accountId = 'temporary-account-a';
    await beginTemporaryProvenance(profile.accountId);
    await savePaperSyncDeviceProfile(profile);

    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'profile', profile);
    Reflect.set(coordinator, 'temporaryWorkspaceId', record.id);
    Reflect.set(coordinator, 'temporaryWorkspaceAccountId', profile.accountId);
    Reflect.set(coordinator, 'paperStates', new Map());
    Reflect.set(coordinator, 'view', viewState({ deviceMode: 'temporary' }));
    let revocations = 0;
    const identity = {
      hasDeviceSession: true,
      accountId: profile.accountId,
      async disconnectCurrent() {
        revocations += 1;
        identity.hasDeviceSession = false;
      },
    };
    Reflect.set(coordinator, 'identity', identity);
    let publications = 0;
    Object.defineProperty(coordinator, 'uploadSelected', {
      configurable: true,
      value: async () => {
        publications += 1;
      },
    });

    await coordinator.finishTemporaryDevice([], false);

    assert.equal(revocations, 1);
    assert.equal(publications, 0);
    assert.equal(registry.records.has(record.id), false);
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY), null);
    assert.deepEqual(registry.deletedDatabases.slice(-3), [
      record.annotationDatabaseName,
      record.productivityDatabaseName,
      record.syncDatabaseName,
    ]);
    assert.equal(
      registry.databaseRecords
        .get(workspace.PERSONAL_ANNOTATION_DATABASE_NAME)
        ?.get('sentinel')
        ?.get('personal')?.retained,
      true,
    );
    assert.equal(local.getItem('unrelated-personal-setting'), 'retained');
    assert.equal(coordinator.getSnapshot().connection, 'disconnected');
    assert.equal(coordinator.getSnapshot().deviceMode, 'personal');
    assert.equal(reloads, 1);
  } finally {
    restoreGlobal('window', windowDescriptor);
    await closeSyncPersistenceWorkspace();
    registry.databaseRecords.delete(workspace.PERSONAL_ANNOTATION_DATABASE_NAME);
    if (registry.records.has(record.id)) {
      registry.deleteFailureCounts.clear();
      await workspace.deleteTemporaryWorkspaceDatabases(record);
      await workspace.completeTemporaryWorkspace(record);
    }
  }
});

test('failed Finish remains scoped and recoverable without false success', async () => {
  const session = memoryStorage();
  installSessionStorage(session);
  installLocalStorage(memoryStorage());
  registry.deletedDatabases.length = 0;
  const record = await workspace.beginTemporaryWorkspace();
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let reloads = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent() {
        return true;
      },
      location: { reload: () => (reloads += 1) },
      setTimeout(callback: () => void) {
        callback();
        return 1;
      },
    },
  });

  try {
    const profile = await loadPaperSyncDeviceProfile();
    profile.accountId = 'temporary-account-a';
    await beginTemporaryProvenance(profile.accountId);
    await savePaperSyncDeviceProfile(profile);
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'profile', profile);
    Reflect.set(coordinator, 'temporaryWorkspaceId', record.id);
    Reflect.set(coordinator, 'temporaryWorkspaceAccountId', profile.accountId);
    Reflect.set(coordinator, 'paperStates', new Map());
    Reflect.set(coordinator, 'view', viewState({ deviceMode: 'temporary' }));
    Reflect.set(coordinator, 'identity', {
      hasDeviceSession: false,
      accountId: profile.accountId,
    });
    let publications = 0;
    Object.defineProperty(coordinator, 'uploadSelected', {
      configurable: true,
      value: async () => {
        publications += 1;
      },
    });
    registry.deleteFailureCounts.set(record.annotationDatabaseName, 1);

    await assert.rejects(
      () => coordinator.finishTemporaryDevice([], false),
      /Synthetic IndexedDB deletion failure/u,
    );
    assert.equal(publications, 0);
    assert.equal(registry.records.has(record.id), true);
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY) !== null, true);
    assert.equal(reloads, 0);
    assert.notEqual(coordinator.getSnapshot().connection, 'disconnected');
    assert.equal(
      (await loadTemporarySessionProvenance())?.finishPhase,
      'cleanup-incomplete',
    );

    await coordinator.finishTemporaryDevice([], false);
    assert.equal(registry.records.has(record.id), false);
    assert.equal(session.getItem(ACTIVE_WORKSPACE_KEY), null);
    assert.equal(reloads, 1);
    assert.equal(coordinator.getSnapshot().connection, 'disconnected');
  } finally {
    restoreGlobal('window', windowDescriptor);
    registry.deleteFailureCounts.clear();
    await closeSyncPersistenceWorkspace();
    if (registry.records.has(record.id)) {
      await workspace.deleteTemporaryWorkspaceDatabases(record);
      await workspace.completeTemporaryWorkspace(record);
    }
  }
});

test('mode selection switches workspaces without overwriting the personal profile', () => {
  const coordinatorSource = source('../src/sync/paperCoordinator.ts');
  const setDeviceMode = sourceSection(
    coordinatorSource,
    'async setDeviceMode(',
    '\n  async connect():',
  );
  assert.match(
    setDeviceMode,
    /await withWorkspaceIdentityTransition[\s\S]*beginTemporaryWorkspace\(\)/u,
  );
  assert.match(setDeviceMode, /await leaveEmptyTemporaryWorkspace\(\)/u);
  assert.match(setDeviceMode, /reloadForWorkspaceChange\(\)/u);
  assert.doesNotMatch(setDeviceMode, /profile\.deviceMode\s*=(?!=)/u);
  assert.match(
    setDeviceMode,
    /runWorkspaceMutation[\s\S]*deviceModeChoiceConfirmed: true[\s\S]*savePaperSyncDeviceProfile\([\s\S]*workspaceLease/u,
  );
  assert.match(
    setDeviceMode,
    /catch \(error\)[\s\S]*updateView\(\{ error: userMessage\(error\)/u,
  );
  assert.ok(
    setDeviceMode.indexOf('await this.flushPersistenceChanges()') <
      setDeviceMode.indexOf('beginTemporaryWorkspace()'),
  );

  const flushTracking = sourceSection(
    coordinatorSource,
    'private async flushPersistenceChanges()',
    '\n  private scheduleAutoUpload(',
  );
  assert.match(flushTracking, /await flushLocalPersistence\(\)/u);
  assert.match(
    flushTracking,
    /while \(this\.pendingPersistentChanges\.size > 0\)[\s\S]*Promise\.all/u,
  );
  assert.match(
    coordinatorSource,
    /subscribeToPersistentChanges[\s\S]*pendingPersistentChanges\.add\(task\)[\s\S]*finally\(\(\) => this\.pendingPersistentChanges\.delete\(task\)\)/u,
  );

  const storageSource = source('../src/sync/storage.ts');
  const getDatabase = sourceSection(
    storageSource,
    'function getDatabase()',
    '\nexport async function closeSyncPersistenceWorkspace(',
  );
  assert.match(
    getDatabase,
    /const databaseName = scopedDatabaseName\(SYNC_DATABASE_NAME\)/u,
  );
});

test('missing cleanup ownership fails closed and remains an attention error', () => {
  const cleanupSource = source('../src/sync/temporaryDeviceSession.ts');
  const cleanup = sourceSection(
    cleanupSource,
    'export async function cleanupTemporaryOrigin(',
    '\nexport async function leaveEmptyTemporaryWorkspace()',
  );
  assert.match(cleanup, /await requireActiveTemporaryWorkspace\(\)/u);
  assert.match(cleanup, /if \(!provenance\)[\s\S]*throw new Error/u);

  const coordinatorSource = source('../src/sync/paperCoordinator.ts');
  const finish = sourceSection(
    coordinatorSource,
    'private async finishTemporaryDeviceOwned(',
    '\n  cancel(): void',
  );
  assert.match(
    finish,
    /withWorkspaceIdentityTransition[\s\S]*await cleanupTemporaryOrigin\(workspaceLease\)[\s\S]*catch \(error\)[\s\S]*this\.applyError\(error\)[\s\S]*throw error/u,
  );
});

function renderDrawer(state: PaperSyncViewState): string {
  const coordinator = {
    setDeviceMode: async () => undefined,
    connect: async () => undefined,
    reconnect: async () => undefined,
    scanCloudPapers: async () => undefined,
    createReplacementRoot: async () => undefined,
    upgradeDriveLayoutFromThisDevice: async () => undefined,
    setAutoSync: async () => undefined,
    chooseRoot: async () => undefined,
    disconnect: async () => undefined,
    disconnectAll: async () => undefined,
    retryNow: async () => undefined,
    cancel: () => undefined,
  };
  return renderToStaticMarkup(
    createElement(PaperSyncDrawer, {
      state,
      coordinator: coordinator as never,
      soundEnabled: true,
      onClose() {},
      onOpenSelector() {},
      onSoundEnabledChange() {},
      onDownloadBackup() {},
    }),
  );
}

function viewState(overrides: Partial<PaperSyncViewState> = {}): PaperSyncViewState {
  return {
    connection: 'connected',
    backendConfigured: true,
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    papers: [],
    paperStates: [],
    dirtyPaperIds: [],
    sessions: [],
    rootChoices: [],
    progress: { phase: 'idle' },
    legacyHousekeeping: { status: 'idle' },
    folderNameMaintenance: { status: 'idle' },
    ...overrides,
  };
}

function sourceSection(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `Missing source boundary: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source boundary: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function installSessionStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
}

function installLocalStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
    writable: true,
  });
}

function installWindowHash(hash: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hash } },
    writable: true,
  });
  return () => restoreGlobal('window', descriptor);
}

function temporaryWorkspaceRecord(
  id: string,
  ownershipVersion: 1 | null = 1,
  oauthLease?: {
    version: 1;
    id: string;
    createdAt: number;
    expiresAt: number;
  },
): import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord {
  const record: import('../src/services/temporaryWorkspace.ts').TemporaryWorkspaceRecord =
    {
      id,
      createdAt: 1,
      annotationDatabaseName: `39note-db--temporary--${id}`,
      productivityDatabaseName: `39note-productivity-db--temporary--${id}`,
      syncDatabaseName: `39note-sync--temporary--${id}`,
    };
  if (ownershipVersion !== null) record.ownershipVersion = ownershipVersion;
  if (oauthLease) record.oauthLease = oauthLease;
  return record;
}

function restoreGlobal(
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
