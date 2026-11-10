import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import JSZip from 'jszip';
import type { ViteDevServer } from 'vite';

const BACKUP_HARNESS_SYMBOL = Symbol.for('39note.test.backup-release-blockers');
const COLLECTION_IDB_HARNESS_SYMBOL = Symbol.for(
  '39note.test.backup-release-collections-idb',
);
const VIRTUAL_ANNOTATION_PERSISTENCE = '\0backup-release-annotation-persistence';
const VIRTUAL_PRODUCTIVITY_PERSISTENCE = '\0backup-release-productivity-persistence';
const VIRTUAL_SYNC_STORAGE = '\0backup-release-sync-storage';
const VIRTUAL_IDB = '\0backup-release-idb';

type BackupModule = typeof import('../src/services/libraryBackup.ts');
type PersistentChangeModule = typeof import('../src/services/persistentChange.ts');
type AnnotationPersistenceModule =
  typeof import('../src/services/annotationPersistence.ts');
type WorkspaceRestoreLockModule =
  typeof import('../src/services/workspaceRestoreLock.ts');

interface BackupHarness {
  documents: Array<{
    state: ReturnType<typeof emptyDocumentState>;
    source: null;
    pdf: null;
  }>;
  collections: Array<Record<string, unknown>>;
  snapshotReads: number;
  collectionReads: number;
  downloadClicks: number;
  capturedBlobs: Blob[];
  snapshotGate?: Promise<void>;
  snapshotStarted?: () => void;
}

let normalServer: ViteDevServer;
let harnessServer: ViteDevServer;
let collectionServer: ViteDevServer;
let backup: BackupModule;
let harnessBackup: BackupModule;
let persistentChange: PersistentChangeModule;
let annotationPersistence: AnnotationPersistenceModule;
let collectionPersistence: AnnotationPersistenceModule;
let workspaceRestoreLock: WorkspaceRestoreLockModule;
let harness: BackupHarness;
const collectionStore = new Map<string, Record<string, unknown>>();

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalHarness = Object.getOwnPropertyDescriptor(
  globalThis,
  BACKUP_HARNESS_SYMBOL,
);
const originalCollectionHarness = Object.getOwnPropertyDescriptor(
  globalThis,
  COLLECTION_IDB_HARNESS_SYMBOL,
);
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

before(async () => {
  installBrowserDownloadHarness();

  const { createServer } = await import('vite');
  normalServer = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  harnessServer = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [backupStorageTestDouble()],
    server: { middlewareMode: true },
  });
  collectionServer = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [collectionIdbTestDouble()],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });
  Object.defineProperty(globalThis, COLLECTION_IDB_HARNESS_SYMBOL, {
    configurable: true,
    value: collectionStore,
  });

  [
    backup,
    annotationPersistence,
    harnessBackup,
    persistentChange,
    collectionPersistence,
    workspaceRestoreLock,
  ] = await Promise.all([
    normalServer.ssrLoadModule(
      '/src/services/libraryBackup.ts',
    ) as Promise<BackupModule>,
    normalServer.ssrLoadModule(
      '/src/services/annotationPersistence.ts',
    ) as Promise<AnnotationPersistenceModule>,
    harnessServer.ssrLoadModule(
      '/src/services/libraryBackup.ts',
    ) as Promise<BackupModule>,
    harnessServer.ssrLoadModule(
      '/src/services/persistentChange.ts',
    ) as Promise<PersistentChangeModule>,
    collectionServer.ssrLoadModule(
      '/src/services/annotationPersistence.ts',
    ) as Promise<AnnotationPersistenceModule>,
    harnessServer.ssrLoadModule(
      '/src/services/workspaceRestoreLock.ts',
    ) as Promise<WorkspaceRestoreLockModule>,
  ]);
});

beforeEach(() => {
  harness = createHarness();
  collectionStore.clear();
  Object.defineProperty(globalThis, BACKUP_HARNESS_SYMBOL, {
    configurable: true,
    value: harness,
  });
});

after(async () => {
  await collectionPersistence?.closeAnnotationPersistenceWorkspace();
  await Promise.all([
    normalServer?.close(),
    harnessServer?.close(),
    collectionServer?.close(),
  ]);
  restoreProperty(globalThis, 'window', originalWindow);
  restoreProperty(globalThis, 'document', originalDocument);
  restoreProperty(globalThis, 'indexedDB', originalIndexedDb);
  restoreProperty(globalThis, BACKUP_HARNESS_SYMBOL, originalHarness);
  restoreProperty(globalThis, COLLECTION_IDB_HARNESS_SYMBOL, originalCollectionHarness);
  restoreProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  restoreProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
});

test('backup waits for every pending persistence handler and archives the newest Note', async () => {
  const events: string[] = [];
  let releaseReader!: () => void;
  const readerGate = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  const unregisterReader = persistentChange.registerPersistenceFlusher(
    'release-blocker-reader',
    async () => {
      events.push('reader-start');
      await readerGate;
      harness.documents[0].state = stateWithLatestNote();
      events.push('reader-end');
      return true;
    },
  );
  const unregisterOther = persistentChange.registerPersistenceFlusher(
    'release-blocker-other',
    async () => {
      await Promise.resolve();
      events.push('other-end');
      return true;
    },
  );

  try {
    const operation = harnessBackup.downloadLibraryBackup(() => undefined);
    await waitFor(() => events.includes('reader-start'));
    assert.equal(harness.snapshotReads, 0, 'snapshot must not start before the flush');
    assert.equal(harness.downloadClicks, 0);

    releaseReader();
    await operation;

    assert.equal(harness.snapshotReads, 1);
    assert.equal(harness.downloadClicks, 1);
    assert.ok(events.includes('other-end'), 'all registered handlers must settle');
    assert.equal(harness.capturedBlobs.length, 1);

    const archiveBytes = new Uint8Array(await harness.capturedBlobs[0].arrayBuffer());
    const preview = await withMutedConsoleError(() =>
      backup.inspectBackup(archiveBytes as unknown as File),
    );
    assert.equal(preview.documents[0].state.annotations.length, 1);
    assert.equal(preview.documents[0].state.annotations[0].id, 'highlight-for-note');
    assert.equal(preview.documents[0].state.notes.length, 1);
    assert.equal(
      preview.documents[0].state.notes[0].content,
      'Newest accepted synthetic Note',
    );
  } finally {
    unregisterReader();
    unregisterOther();
  }
});

test('false and rejected flushes settle all handlers, preserve retry state, and create no ZIP', async () => {
  let pendingEdit = true;
  let delayedHandlerFinished = false;
  let shouldSave = false;
  const unregisterPending = persistentChange.registerPersistenceFlusher(
    'release-blocker-pending',
    async () => {
      await Promise.resolve();
      if (!shouldSave) return false;
      harness.documents[0].state = stateWithLatestNote();
      pendingEdit = false;
      return true;
    },
  );
  const unregisterDelayed = persistentChange.registerPersistenceFlusher(
    'release-blocker-delayed',
    async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      delayedHandlerFinished = true;
      return true;
    },
  );
  const unregisterRejected = persistentChange.registerPersistenceFlusher(
    'release-blocker-rejected',
    async () => {
      throw new Error('synthetic persistence rejection');
    },
  );

  try {
    await assert.rejects(
      () => harnessBackup.downloadLibraryBackup(() => undefined),
      (error: unknown) =>
        error instanceof harnessBackup.BackupPersistenceError &&
        /not created|pending local edit/iu.test(error.message),
    );
    assert.equal(
      delayedHandlerFinished,
      true,
      'a peer rejection must not skip handlers',
    );
    assert.equal(pendingEdit, true, 'failed persistence remains available for retry');
    assert.equal(harness.snapshotReads, 0);
    assert.equal(harness.downloadClicks, 0);
    assert.equal(harness.capturedBlobs.length, 0);

    unregisterRejected();
    shouldSave = true;
    await harnessBackup.downloadLibraryBackup(() => undefined);
    assert.equal(pendingEdit, false);
    assert.equal(harness.snapshotReads, 1);
    assert.equal(harness.downloadClicks, 1);
  } finally {
    unregisterPending();
    unregisterDelayed();
    unregisterRejected();
  }
});

test('concurrent backup requests share one operation and a later request starts a new one', async () => {
  let releaseFlush!: () => void;
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve;
  });
  let flushCount = 0;
  const unregister = persistentChange.registerPersistenceFlusher(
    'release-blocker-single-flight',
    async () => {
      flushCount += 1;
      await flushGate;
      return true;
    },
  );

  try {
    const first = harnessBackup.downloadLibraryBackup(() => undefined);
    const second = harnessBackup.downloadLibraryBackup(() => undefined);
    assert.equal(first, second, 'concurrent callers must share the same promise');
    releaseFlush();
    await Promise.all([first, second]);
    assert.equal(flushCount, 1);
    assert.equal(harness.snapshotReads, 1);
    assert.equal(harness.downloadClicks, 1);

    await harnessBackup.downloadLibraryBackup(() => undefined);
    assert.equal(flushCount, 2);
    assert.equal(harness.snapshotReads, 2);
    assert.equal(harness.downloadClicks, 2);
  } finally {
    unregister();
  }
});

test('backup captures one mutation-fenced point in time before archive generation', async () => {
  let releaseSnapshot!: () => void;
  harness.snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let markSnapshotStarted!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => {
    markSnapshotStarted = resolve;
  });
  harness.snapshotStarted = markSnapshotStarted;

  const backupOperation = harnessBackup.downloadLibraryBackup(() => undefined);
  await snapshotStarted;

  let mutationEntered = false;
  const mutation = workspaceRestoreLock.withSharedWorkspaceRestoreLease(async () => {
    mutationEntered = true;
    harness.documents[0].state = stateWithLatestNote();
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(
    mutationEntered,
    false,
    'normal persistence must wait while the backup snapshot owns the exclusive lease',
  );

  releaseSnapshot();
  await Promise.all([backupOperation, mutation]);
  assert.equal(mutationEntered, true);
  assert.equal(harness.documents[0].state.notes.length, 1);

  const archiveBytes = new Uint8Array(await harness.capturedBlobs[0].arrayBuffer());
  const preview = await withMutedConsoleError(() =>
    backup.inspectBackup(archiveBytes as unknown as File),
  );
  assert.equal(
    preview.documents[0].state.notes.length,
    0,
    'archive generation must use the detached snapshot captured before the queued write',
  );
});

test('current and legacy backups require valid Collection data and preserve valid records', async () => {
  const collection = validCollection();
  const currentState = emptyDocumentState();
  currentState.collectionIds = [collection.id];
  const current = await inspectArchive({
    manifest: currentManifest(),
    state: currentState,
    collections: JSON.stringify([collection]),
  });
  assert.deepEqual(current.collections, [collection]);

  const empty = await inspectArchive({
    manifest: currentManifest(),
    state: emptyDocumentState(),
    collections: '[]',
  });
  assert.deepEqual(empty.collections, []);

  const legacy = await inspectArchive({
    manifest: legacyManifest(),
    state: emptyDocumentState(),
    collections: '[]',
  });
  assert.equal(legacy.manifest.backupFormatVersion, 1);
  assert.deepEqual(legacy.collections, []);

  for (const manifest of [currentManifest(), legacyManifest()]) {
    await assert.rejects(
      () =>
        inspectArchive({
          manifest,
          state: emptyDocumentState(),
          collections: undefined,
        }),
      /Collection data is missing/iu,
    );
  }
});

test('malformed, mistyped, duplicate, and dangling Collection data fail during preview', async () => {
  const collection = validCollection();
  const invalidRecords: Array<{ label: string; value: unknown }> = [
    { label: 'non-array', value: { collection } },
    { label: 'null record', value: [null] },
    { label: 'invalid id', value: [{ ...collection, id: '' }] },
    { label: 'invalid name', value: [{ ...collection, name: 7 }] },
    {
      label: 'incorrect normalized name',
      value: [{ ...collection, normalizedName: 'not-the-name' }],
    },
    {
      label: 'invalid timestamp',
      value: [{ ...collection, updatedAt: 'today' }],
    },
    {
      label: 'duplicate id',
      value: [collection, { ...collection, name: 'Second', normalizedName: 'second' }],
    },
  ];

  await assert.rejects(
    () =>
      inspectArchive({
        manifest: currentManifest(),
        state: emptyDocumentState(),
        collections: '{not-json',
      }),
    /Collection data is malformed JSON/iu,
  );

  for (const { label, value } of invalidRecords) {
    await assert.rejects(
      () =>
        inspectArchive({
          manifest: currentManifest(),
          state: emptyDocumentState(),
          collections: JSON.stringify(value),
        }),
      /Collection data contains invalid records/iu,
      label,
    );
  }

  const danglingState = emptyDocumentState();
  danglingState.collectionIds = ['collection-not-in-archive'];
  await assert.rejects(
    () =>
      inspectArchive({
        manifest: currentManifest(),
        state: danglingState,
        collections: '[]',
      }),
    /references an unknown Collection/iu,
  );

  for (const collectionIds of [['collection-reading', 'collection-reading'], [7]]) {
    const invalidMembershipState = emptyDocumentState();
    invalidMembershipState.collectionIds = collectionIds as string[];
    await assert.rejects(
      () =>
        inspectArchive({
          manifest: currentManifest(),
          state: invalidMembershipState,
          collections: JSON.stringify([collection]),
        }),
      /has an invalid record/iu,
    );
  }
});

test('the lower-level Collection restore rejects malformed input before opening storage', async () => {
  let indexedDbAccesses = 0;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      indexedDbAccesses += 1;
      throw new Error('IndexedDB must not be touched for invalid Collection input.');
    },
  });
  try {
    assert.equal(
      await annotationPersistence.restoreLibraryEntities([
        { ...validCollection(), name: 42 },
      ]),
      false,
    );
    assert.equal(indexedDbAccesses, 0);
  } finally {
    restoreProperty(globalThis, 'indexedDB', originalIndexedDb);
  }
});

test('valid Collections restore and enumerate exactly in isolated storage', async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {},
  });
  const collection = validCollection();
  try {
    assert.equal(
      await collectionPersistence.restoreLibraryEntities([collection], false),
      true,
    );
    assert.deepEqual(await collectionPersistence.listCollections(), [collection]);
  } finally {
    await collectionPersistence.closeAnnotationPersistenceWorkspace();
    restoreProperty(globalThis, 'indexedDB', originalIndexedDb);
  }
});

function backupStorageTestDouble() {
  return {
    name: 'backup-release-storage-test-double',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      const normalizedImporter = importer?.replaceAll('\\', '/');
      if (!normalizedImporter?.endsWith('/src/services/libraryBackup.ts')) return;
      if (id === './annotationPersistence' || id === './annotationPersistence.ts') {
        return VIRTUAL_ANNOTATION_PERSISTENCE;
      }
      if (id === './productivityPersistence' || id === './productivityPersistence.ts') {
        return VIRTUAL_PRODUCTIVITY_PERSISTENCE;
      }
      if (id === '../sync/storage' || id === '../sync/storage.ts') {
        return VIRTUAL_SYNC_STORAGE;
      }
    },
    load(id: string) {
      if (id === VIRTUAL_ANNOTATION_PERSISTENCE) {
        return `
          const harness = () => globalThis[Symbol.for('39note.test.backup-release-blockers')];
          export async function getBackupDocumentDataStrict() {
            harness().snapshotReads += 1;
            harness().snapshotStarted?.();
            await harness().snapshotGate;
            return structuredClone(harness().documents);
          }
          export async function listCollections() {
            harness().collectionReads += 1;
            return structuredClone(harness().collections);
          }
          export async function listLibraryDocuments() { return []; }
          export function validateBackupDocumentState(value) { return value; }
          export function validateLibraryEntities(value) {
            if (!Array.isArray(value)) return false;
            const ids = new Set();
            return value.every((item) => {
              if (!item || typeof item !== 'object' || typeof item.id !== 'string' ||
                  item.id.length === 0 || item.id.length > 128 ||
                  typeof item.name !== 'string' || item.name.trim().length === 0 ||
                  item.name.length > 80 ||
                  item.normalizedName !== item.name.trim().toLocaleLowerCase() ||
                  typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) ||
                  item.createdAt < 0 || typeof item.updatedAt !== 'number' ||
                  !Number.isFinite(item.updatedAt) || item.updatedAt < 0 || ids.has(item.id)) {
                return false;
              }
              ids.add(item.id);
              return true;
            });
          }
        `;
      }
      if (id === VIRTUAL_PRODUCTIVITY_PERSISTENCE) {
        return `
          export async function getProductivityBackupDataStrict(documentIds) {
            return documentIds.map((documentId) => ({
              documentId,
              printDraft: null,
              aiConversations: [],
            }));
          }
          export async function loadRenderedPrintPdf() { return null; }
          export function sanitizeProductivityBackupData(value) { return value; }
        `;
      }
      if (id === VIRTUAL_SYNC_STORAGE) {
        return `
          export async function loadCloudPaperCatalog() { return []; }
          export async function loadPaperSyncDeviceProfile() { return {}; }
        `;
      }
    },
  };
}

function collectionIdbTestDouble() {
  return {
    name: 'backup-release-collection-idb-test-double',
    enforce: 'pre' as const,
    resolveId(id: string) {
      return id === 'idb' ? VIRTUAL_IDB : undefined;
    },
    load(id: string) {
      if (id !== VIRTUAL_IDB) return undefined;
      return `
        const records = () => globalThis[Symbol.for('39note.test.backup-release-collections-idb')];
        const store = {
          async get(key) { return records().get(key); },
          async getAll() { return [...records().values()]; },
          async put(value) { records().set(value.id, structuredClone(value)); return value.id; },
          async clear() { records().clear(); },
        };
        export async function openDB(_name, _version, options = {}) {
          options.upgrade?.({
            objectStoreNames: { contains: (name) => name !== 'tags' },
            createObjectStore() {},
            deleteObjectStore() {},
          });
          return {
            objectStoreNames: { contains: () => true },
            async get(storeName, key) {
              return storeName === 'collections' ? store.get(key) : undefined;
            },
            async getAll(storeName) { return storeName === 'collections' ? store.getAll() : []; },
            transaction() { return { objectStore: () => store, done: Promise.resolve() }; },
            close() {},
          };
        }
        export async function deleteDB() {}
      `;
    },
  };
}

function installBrowserDownloadHarness(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay?: number) {
        return setTimeout(callback, delay);
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tagName: string) {
        assert.equal(tagName, 'a');
        return {
          href: '',
          download: '',
          click() {
            harness.downloadClicks += 1;
          },
        };
      },
    },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value(blob: Blob) {
      harness.capturedBlobs.push(blob);
      return `blob:39note-backup-test-${harness.capturedBlobs.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value() {},
  });
}

function createHarness(): BackupHarness {
  return {
    documents: [{ state: emptyDocumentState(), source: null, pdf: null }],
    collections: [],
    snapshotReads: 0,
    collectionReads: 0,
    downloadClicks: 0,
    capturedBlobs: [],
  };
}

function emptyDocumentState() {
  return {
    schemaVersion: 9,
    documentType: 'pdf' as const,
    documentId: 'paper-local',
    documentName: 'Synthetic Paper.pdf',
    originalFileName: 'Synthetic Paper.pdf',
    displayTitle: 'Synthetic Paper',
    annotations: [] as Array<Record<string, unknown>>,
    officeAnnotations: [],
    noteAnchors: [],
    notes: [] as Array<Record<string, unknown>>,
    glossaryEntries: [],
    links: [],
    nextNoteNumber: 1,
    nextLinkNumber: 1,
    updatedAt: 1,
    collectionIds: [] as string[],
    isPinned: false,
  };
}

function stateWithLatestNote(): ReturnType<typeof emptyDocumentState> {
  const state = emptyDocumentState();
  state.annotations = [
    {
      id: 'highlight-for-note',
      type: 'highlight',
      pageNumber: 1,
      text: 'Synthetic selection',
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
      color: 'yellow',
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  state.notes = [
    {
      id: 'latest-note',
      annotationId: 'highlight-for-note',
      pageNumber: 1,
      displayNumber: '1',
      selectedText: 'Synthetic selection',
      content: 'Newest accepted synthetic Note',
      createdAt: 3,
      updatedAt: 3,
    },
  ];
  state.nextNoteNumber = 2;
  state.updatedAt = 3;
  return state;
}

function validCollection() {
  return {
    id: 'collection-reading',
    name: 'Reading Queue',
    normalizedName: 'reading queue',
    createdAt: 1,
    updatedAt: 2,
  };
}

function currentManifest() {
  return {
    backupFormatVersion: 5,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: 0,
    noteCount: 0,
    documents: [
      {
        documentId: 'paper-local',
        hasStoredSource: false,
        recordEntry: 'documents/paper-local.json',
        productivityEntry: 'productivity/paper-local.json',
      },
    ],
    backupScope: 'library',
    paperCoverage: {
      locallyAvailableCount: 1,
      cloudOnlyCount: 0,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'cached-snapshot', scannedAt: 1 },
      cloudOnlyPapers: [],
    },
  };
}

function legacyManifest() {
  return {
    backupFormatVersion: 1,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: 0,
    noteCount: 0,
    documents: [{ documentId: 'paper-local', hasStoredPdf: false }],
    backupScope: 'library',
  };
}

async function inspectArchive({
  manifest,
  state,
  collections,
}: {
  manifest: ReturnType<typeof currentManifest> | ReturnType<typeof legacyManifest>;
  state: ReturnType<typeof emptyDocumentState>;
  collections: string | undefined;
}) {
  const zip = new JSZip();
  zip.file('39note-backup/manifest.json', JSON.stringify(manifest));
  if (collections !== undefined)
    zip.file('39note-backup/collections.json', collections);
  zip.file('39note-backup/documents/paper-local.json', JSON.stringify(state));
  if (manifest.backupFormatVersion >= 3) {
    zip.file(
      '39note-backup/productivity/paper-local.json',
      JSON.stringify({
        documentId: 'paper-local',
        printDraft: null,
        aiConversations: [],
      }),
    );
  }
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return withMutedConsoleError(() => backup.inspectBackup(bytes as unknown as File));
}

async function withMutedConsoleError<T>(operation: () => Promise<T>): Promise<T> {
  const previous = console.error;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.error = previous;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the synthetic backup operation.');
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}
