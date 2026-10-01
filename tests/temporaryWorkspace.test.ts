import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViteDevServer } from 'vite';
import type { PaperSyncViewState } from '../src/sync/paperCoordinator.ts';

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const VALID_WORKSPACE_ID = '7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VIRTUAL_IDB_ID = '\0temporary-workspace-idb-test';
const IDB_HARNESS_SYMBOL = Symbol.for('39note.test.temporary-workspace-idb');

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

interface RegistryHarness {
  deletedDatabases: string[];
  opens: Array<{ name: string; version: number }>;
  records: Map<string, Record<string, unknown>>;
  stores: Array<{ name: string; keyPath?: string }>;
}

interface TemporaryWorkspaceModule {
  PERSONAL_ANNOTATION_DATABASE_NAME: string;
  PERSONAL_PRODUCTIVITY_DATABASE_NAME: string;
  PERSONAL_SYNC_DATABASE_NAME: string;
  beginTemporaryWorkspace: (typeof import('../src/services/temporaryWorkspace.ts'))['beginTemporaryWorkspace'];
  completeTemporaryWorkspace: (typeof import('../src/services/temporaryWorkspace.ts'))['completeTemporaryWorkspace'];
  deleteTemporaryWorkspaceDatabases: (typeof import('../src/services/temporaryWorkspace.ts'))['deleteTemporaryWorkspaceDatabases'];
  getActiveTemporaryWorkspaceId: (typeof import('../src/services/temporaryWorkspace.ts'))['getActiveTemporaryWorkspaceId'];
  scopedDatabaseName: (typeof import('../src/services/temporaryWorkspace.ts'))['scopedDatabaseName'];
  scopedLocalStorageKey: (typeof import('../src/services/temporaryWorkspace.ts'))['scopedLocalStorageKey'];
  temporaryDatabaseName: (typeof import('../src/services/temporaryWorkspace.ts'))['temporaryDatabaseName'];
}

let server: ViteDevServer;
let workspace: TemporaryWorkspaceModule;
let PaperSyncDrawer: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSyncDrawer'];
let paperRows: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperRows'];
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let evaluateTemporaryModeFootprint: (typeof import('../src/sync/temporaryDeviceSession.ts'))['evaluateTemporaryModeFootprint'];

const registry: RegistryHarness = {
  deletedDatabases: [],
  opens: [],
  records: new Map(),
  stores: [],
};
const originalSessionStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'sessionStorage',
);
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
                async put(_storeName, value) {
                  state.records.set(value.id, { ...value });
                },
                async get(_storeName, key) {
                  return state.records.get(key);
                },
                async delete(_storeName, key) {
                  state.records.delete(key);
                },
                close() {},
              };
            }
            export async function deleteDB(name) {
              harness().deletedDatabases.push(name);
            }
          `;
        },
      },
    ],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });

  const [workspaceModule, ui, coordinator, temporarySession] = await Promise.all([
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
  ]);
  workspace = workspaceModule;
  PaperSyncDrawer = ui.PaperSyncDrawer;
  paperRows = ui.paperRows;
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  evaluateTemporaryModeFootprint = temporarySession.evaluateTemporaryModeFootprint;
});

after(async () => {
  await server?.close();
  restoreGlobal('sessionStorage', originalSessionStorage);
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

test('cleanup deletes only the active registered temporary workspace', async () => {
  const storage = memoryStorage();
  installSessionStorage(storage);
  registry.deletedDatabases.length = 0;
  registry.records.clear();

  const first = await workspace.beginTemporaryWorkspace();
  storage.removeItem(ACTIVE_WORKSPACE_KEY);
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

test('isolated temporary mode does not reject occupied personal storage', () => {
  assert.deepEqual(
    evaluateTemporaryModeFootprint({
      annotationDocumentCount: 2,
      pdfDocumentCount: 1,
      collectionCount: 3,
      tagCount: 4,
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

test('mode selection switches workspaces without overwriting the personal profile', () => {
  const coordinatorSource = source('../src/sync/paperCoordinator.ts');
  const setDeviceMode = sourceSection(
    coordinatorSource,
    'async setDeviceMode(',
    '\n  async connect():',
  );
  assert.match(setDeviceMode, /await beginTemporaryWorkspace\(\)/u);
  assert.match(setDeviceMode, /await leaveEmptyTemporaryWorkspace\(\)/u);
  assert.match(setDeviceMode, /reloadForWorkspaceChange\(\)/u);
  assert.doesNotMatch(setDeviceMode, /profile\.deviceMode\s*=/u);
  assert.doesNotMatch(setDeviceMode, /savePaperSyncDeviceProfile\(/u);
  assert.match(
    setDeviceMode,
    /catch \(error\)[\s\S]*updateView\(\{ error: userMessage\(error\)/u,
  );
  assert.ok(
    setDeviceMode.indexOf('await this.flushPersistenceChanges()') <
      setDeviceMode.indexOf('await beginTemporaryWorkspace()'),
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
    'export async function cleanupTemporaryOrigin()',
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
    /await cleanupTemporaryOrigin\(\)[\s\S]*catch \(error\)[\s\S]*this\.applyError\(error\)[\s\S]*throw error/u,
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
