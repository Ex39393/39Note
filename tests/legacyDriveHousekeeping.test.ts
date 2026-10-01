import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type {
  DriveClient as DriveClientInstance,
  DriveFileMetadata,
} from '../src/sync/driveClient.ts';
import type { PaperDriveRepository as PaperDriveRepositoryInstance } from '../src/sync/paperDriveRepository.ts';
import type { LocalPaperPackage, PaperSyncState } from '../src/sync/paperTypes.ts';
import type {
  LocalSyncPdf,
  SyncEntityRecord,
  SyncSnapshot,
} from '../src/sync/types.ts';

const signal = new AbortController().signal;
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
let server: ViteDevServer;
let DriveClient: (typeof import('../src/sync/driveClient.ts'))['DriveClient'];
let LegacyDriveCleanupRefusedError: (typeof import('../src/sync/paperDriveRepository.ts'))['LegacyDriveCleanupRefusedError'];
let PaperDriveRepository: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperDriveRepository'];
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let LEGACY_CLEANUP_CONFIRMATION: (typeof import('../src/sync/paperCoordinator.ts'))['LEGACY_CLEANUP_CONFIRMATION'];
let buildLegacyDriveInventory: (typeof import('../src/sync/legacyDriveHousekeeping.ts'))['buildLegacyDriveInventory'];
let LEGACY_PAPER_MANIFEST_STORAGE: string;
let LEGACY_PAPER_PACKAGE_LAYOUT_VERSION: number;
let PAPER_MANIFEST_STORAGE: string;
let PAPER_SYNC_PROTOCOL_VERSION: number;
let PAPER_PACKAGE_LAYOUT_VERSION: number;
let SYNC_SCHEMA_VERSION: number;
let createSyncEntityKey: (typeof import('../src/sync/types.ts'))['createSyncEntityKey'];
let sha256Hex: (typeof import('../src/sync/hash.ts'))['sha256Hex'];
let stableStringify: (typeof import('../src/sync/hash.ts'))['stableStringify'];

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
  const [drive, repository, coordinator, paperTypes, syncTypes, hash, housekeeping] =
    await Promise.all([
      server.ssrLoadModule('/src/sync/driveClient.ts') as Promise<
        typeof import('../src/sync/driveClient.ts')
      >,
      server.ssrLoadModule('/src/sync/paperDriveRepository.ts') as Promise<
        typeof import('../src/sync/paperDriveRepository.ts')
      >,
      server.ssrLoadModule('/src/sync/paperCoordinator.ts') as Promise<
        typeof import('../src/sync/paperCoordinator.ts')
      >,
      server.ssrLoadModule('/src/sync/paperTypes.ts') as Promise<
        typeof import('../src/sync/paperTypes.ts')
      >,
      server.ssrLoadModule('/src/sync/types.ts') as Promise<
        typeof import('../src/sync/types.ts')
      >,
      server.ssrLoadModule('/src/sync/hash.ts') as Promise<
        typeof import('../src/sync/hash.ts')
      >,
      server.ssrLoadModule('/src/sync/legacyDriveHousekeeping.ts') as Promise<
        typeof import('../src/sync/legacyDriveHousekeeping.ts')
      >,
    ]);
  DriveClient = drive.DriveClient;
  LegacyDriveCleanupRefusedError = repository.LegacyDriveCleanupRefusedError;
  PaperDriveRepository = repository.PaperDriveRepository;
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  LEGACY_CLEANUP_CONFIRMATION = coordinator.LEGACY_CLEANUP_CONFIRMATION;
  buildLegacyDriveInventory = housekeeping.buildLegacyDriveInventory;
  LEGACY_PAPER_MANIFEST_STORAGE = paperTypes.LEGACY_PAPER_MANIFEST_STORAGE;
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION = paperTypes.LEGACY_PAPER_PACKAGE_LAYOUT_VERSION;
  PAPER_MANIFEST_STORAGE = paperTypes.PAPER_MANIFEST_STORAGE;
  PAPER_SYNC_PROTOCOL_VERSION = paperTypes.PAPER_SYNC_PROTOCOL_VERSION;
  PAPER_PACKAGE_LAYOUT_VERSION = paperTypes.PAPER_PACKAGE_LAYOUT_VERSION;
  SYNC_SCHEMA_VERSION = syncTypes.SYNC_SCHEMA_VERSION;
  createSyncEntityKey = syncTypes.createSyncEntityKey;
  sha256Hex = hash.sha256Hex;
  stableStringify = hash.stableStringify;
});

after(async () => server.close());

test('legacy inventory classifies current, recognized legacy, and unknown data fail closed', async () => {
  const fixture = await housekeepingFixture();
  const mutationCount = fixture.drive.mutations.length;
  const inventory = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );

  assert.ok(inventory.currentPaperCount >= 6);
  assert.ok(inventory.recognizedLegacyCount >= 6);
  assert.equal(inventory.unknownCount, 4);
  assert.equal(fixture.drive.mutations.length, mutationCount, 'inventory is read-only');
  assert.ok(
    inventory.items
      .filter(
        (item) =>
          item.classification === 'current-paper-v2' ||
          item.classification === 'current-layout-v3',
      )
      .every((item) => !item.cleanupEligible),
  );
  assert.equal(
    inventory.items.filter(
      ({ classification }) => classification === 'current-layout-v3',
    ).length,
    4,
  );
  const currentControl = inventory.items.filter(
    ({ classification }) => classification === 'current-layout-v3',
  );
  assert.deepEqual(
    new Set(currentControl.map(({ role }) => role)),
    new Set([
      'paper-v3-control',
      'paper-v3-layout-descriptor',
      'paper-v3-migration-completion',
      'paper-presence-generation',
    ]),
    'every active layout-3 control artifact is classified as current and preserved',
  );
  assert.ok(
    currentControl.every(
      ({ cleanupEligible, cleanupDisposition }) =>
        !cleanupEligible && /preserved/u.test(cleanupDisposition),
    ),
  );
  assert.equal(item(inventory, 'legacy-manifest').classification, 'recognized-legacy');
  assert.equal(item(inventory, 'legacy-library').classification, 'recognized-legacy');
  assert.equal(item(inventory, 'legacy-state').classification, 'recognized-legacy');
  assert.equal(
    item(inventory, 'legacy-productivity').classification,
    'recognized-legacy',
  );
  assert.equal(item(inventory, 'mismatched-legacy-state').classification, 'unknown');
  assert.equal(
    item(inventory, 'orphan-legacy-state').classification,
    'recognized-legacy',
  );
  assert.equal(item(inventory, 'orphan-legacy-state').cleanupEligible, false);
  assert.match(
    item(inventory, 'orphan-legacy-state').cleanupDisposition,
    /does not prove this item obsolete/u,
  );
  assert.equal(item(inventory, 'personal-file').classification, 'unknown');
  assert.equal(item(inventory, 'legacy-looking-name').classification, 'unknown');
  assert.match(item(inventory, 'legacy-looking-name').reason, /name resembles/u);
  assert.equal(item(inventory, 'malformed-legacy').classification, 'unknown');
  assert.equal(
    inventory.items.some(({ id }) => id === 'outside-user-file'),
    false,
    'items outside the managed root are not inventoried',
  );
  assert.ok(
    inventory.cleanupTargetIds.every(
      (id) => item(inventory, id).classification === 'recognized-legacy',
    ),
  );
  assert.ok(
    inventory.items
      .filter(({ kind }) => kind === 'folder')
      .every(({ cleanupEligible }) => !cleanupEligible),
    'Drive folders are never cleanup eligible',
  );
  const referencedCurrentIds = new Set(fixture.published.cloud.managedFileIds ?? []);
  assert.ok(
    inventory.cleanupTargetIds.every((id) => !referencedCurrentIds.has(id)),
    'current manifest and payload references are never cleanup targets',
  );
});

test('housekeeping preserves current package layouts 2 and 3 with exact source and manifest roles', async () => {
  const hash = 'a'.repeat(64);
  const currentProperties = (
    layoutVersion: number,
    role: string,
    documentId: string,
    extra: Record<string, string> = {},
  ) => ({
    application: '39Note',
    syncSchema: '1',
    layoutVersion: String(layoutVersion),
    paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
    role,
    documentId,
    ...extra,
  });
  const file = (
    id: string,
    name: string,
    mimeType: string,
    parents: string[],
    appProperties: Record<string, string>,
  ): DriveFileMetadata => ({
    id,
    name,
    mimeType,
    parents,
    ownedByMe: true,
    trashed: false,
    appProperties,
  });
  const entries = [
    {
      file: file(
        'v2-folder',
        'Legacy PDF',
        'application/vnd.google-apps.folder',
        ['root'],
        currentProperties(
          LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-folder',
          'doc-v2',
        ),
      ),
      depth: 1,
    },
    {
      file: file(
        'v2-data',
        '39Note Data',
        'application/vnd.google-apps.folder',
        ['v2-folder'],
        currentProperties(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION, 'paper-data', 'doc-v2'),
      ),
      depth: 2,
    },
    {
      file: file(
        'v2-manifest',
        `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${hash}.json`,
        'application/json',
        ['v2-data'],
        currentProperties(
          LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-manifest-generation',
          'doc-v2',
          { manifestStorage: LEGACY_PAPER_MANIFEST_STORAGE, generationId: hash },
        ),
      ),
      depth: 3,
    },
    {
      file: file(
        'v2-source',
        'Legacy PDF.pdf',
        'application/pdf',
        ['v2-folder'],
        currentProperties(
          LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-source-pdf',
          'doc-v2',
          { sha256: hash },
        ),
      ),
      depth: 2,
    },
    {
      file: file(
        'v3-folder',
        'Current document',
        'application/vnd.google-apps.folder',
        ['root'],
        currentProperties(PAPER_PACKAGE_LAYOUT_VERSION, 'paper-folder', 'doc-v3'),
      ),
      depth: 1,
    },
    {
      file: file(
        'v3-data',
        '39Note Data',
        'application/vnd.google-apps.folder',
        ['v3-folder'],
        currentProperties(PAPER_PACKAGE_LAYOUT_VERSION, 'paper-data', 'doc-v3'),
      ),
      depth: 2,
    },
    {
      file: file(
        'v3-manifest',
        `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${hash}.json`,
        'application/json',
        ['v3-data'],
        currentProperties(
          PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-manifest-generation',
          'doc-v3',
          { manifestStorage: PAPER_MANIFEST_STORAGE, generationId: hash },
        ),
      ),
      depth: 3,
    },
    {
      file: file(
        'v3-source',
        'Current document.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ['v3-folder'],
        currentProperties(
          PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-source-document',
          'doc-v3',
          { sha256: hash },
        ),
      ),
      depth: 2,
    },
    {
      file: file(
        'wrong-storage',
        `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${hash}.json`,
        'application/json',
        ['v2-data'],
        currentProperties(
          LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
          'paper-manifest-generation',
          'doc-v2',
          { manifestStorage: PAPER_MANIFEST_STORAGE, generationId: hash },
        ),
      ),
      depth: 3,
    },
  ];

  const inventory = await buildLegacyDriveInventory('root', entries, {
    activePaperLayout: true,
    currentDataVerified: true,
  });
  for (const id of [
    'v2-folder',
    'v2-data',
    'v2-manifest',
    'v2-source',
    'v3-folder',
    'v3-data',
    'v3-manifest',
    'v3-source',
  ]) {
    assert.equal(item(inventory, id).classification, 'current-paper-v2', id);
    assert.match(item(inventory, id).cleanupDisposition, /Current paper package/u);
  }
  assert.equal(item(inventory, 'wrong-storage').classification, 'unknown');
  assert.match(item(inventory, 'v3-source').reason, /typed source document/u);
});

test('migration evidence blocks cleanup while leaving the inventory readable', async () => {
  const fixture = await housekeepingFixture();
  const inventory = await fixture.repository.inspectLegacyDriveData(
    {
      migrationInProgress: true,
      protectedLegacyFileIds: ['legacy-manifest'],
    },
    signal,
  );
  assert.ok(inventory.recognizedLegacyCount > 0);
  assert.equal(inventory.cleanupEligibleCount, 0);
  assert.deepEqual(inventory.cleanupTargetIds, []);
  assert.match(inventory.cleanupBlockedReason ?? '', /migration or recovery/u);
});

test('cleanup stays blocked without one verified migration activation and current paper', async () => {
  const fixture = await housekeepingFixture();
  fixture.drive.seed({ ...fixture.drive.file('layout-activation'), trashed: true });
  const withoutActivation = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  assert.equal(withoutActivation.cleanupEligibleCount, 0);
  assert.match(withoutActivation.cleanupBlockedReason ?? '', /migration evidence/u);

  const emptyDrive = createMemoryHousekeepingDrive();
  const emptyRepository = new PaperDriveRepository(emptyDrive, 'root');
  await emptyRepository.initializeEmptyLayout(signal);
  emptyDrive.seed({
    id: 'legacy-library-only',
    name: 'library.json',
    mimeType: 'application/json',
    parents: ['root'],
    ownedByMe: true,
    appProperties: legacyProperties('library'),
  });
  const empty = await emptyRepository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  assert.equal(empty.recognizedLegacyCount, 1);
  assert.equal(empty.cleanupEligibleCount, 0);
  assert.match(empty.cleanupBlockedReason ?? '', /current paper data/u);
});

test('duplicate activation evidence fails closed', async () => {
  const fixture = await housekeepingFixture();
  const original = fixture.drive.file('layout-activation');
  fixture.drive.seed(
    { ...original, id: 'layout-activation-duplicate' },
    await fixture.drive.downloadBlob(original.id),
  );
  const inventory = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  assert.equal(inventory.cleanupEligibleCount, 0);
  assert.match(inventory.cleanupBlockedReason ?? '', /migration evidence/u);
});

test('cleanup uses Drive Trash only for eligible legacy IDs and verifies preserved data', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  const currentBefore = evidenceByClassification(before, 'current-paper-v2');
  const controlBefore = evidenceByClassification(before, 'current-layout-v3');
  const unknownBefore = evidenceByClassification(before, 'unknown');
  fixture.drive.resetMutations();

  const result = await fixture.repository.cleanupLegacyDriveData(
    before,
    housekeepingOptions(),
    signal,
  );

  assert.ok(result.trashedIds.length > 0);
  assert.deepEqual(fixture.drive.trashCalls.sort(), result.trashedIds);
  assert.ok(
    result.trashedIds.every(
      (id) => item(before, id).classification === 'recognized-legacy',
    ),
  );
  assert.ok(result.trashedIds.every((id) => !currentBefore.has(id)));
  assert.ok(result.trashedIds.every((id) => !controlBefore.has(id)));
  assert.ok(result.trashedIds.every((id) => !unknownBefore.has(id)));
  assert.ok(
    result.trashedIds.every((id) => item(before, id).kind === 'file'),
    'legacy folders are never sent to Drive Trash',
  );
  assert.ok(
    result.trashedIds.every((id) => !result.inventory.items.some((x) => x.id === id)),
  );
  assert.deepEqual(
    evidenceByClassification(result.inventory, 'current-paper-v2'),
    currentBefore,
  );
  assert.deepEqual(
    evidenceByClassification(result.inventory, 'current-layout-v3'),
    controlBefore,
  );
  assert.deepEqual(
    evidenceByClassification(result.inventory, 'unknown'),
    unknownBefore,
  );
  assert.equal(fixture.drive.file('personal-file').trashed, false);
  assert.equal(fixture.drive.file('legacy-looking-name').trashed, false);
  assert.equal(fixture.drive.file('malformed-legacy').trashed, false);
  assert.equal(fixture.drive.file('outside-user-file').trashed, false);
  assert.ok(
    result.inventory.items.some(
      ({ id, classification }) =>
        id === 'legacy-documents' && classification === 'recognized-legacy',
    ),
    'a legacy folder containing an unknown file is intentionally preserved',
  );
  assert.equal(result.inventory.cleanupEligibleCount, 0);
  const papers = await fixture.repository.discover(undefined, signal);
  assert.deepEqual(
    papers.map(({ documentId }) => documentId),
    ['doc-current'],
    'current paper-v2 data remains discoverable after cleanup',
  );
});

test('a changed inventory refuses cleanup before any mutation', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  fixture.drive.seed({
    id: 'late-unknown',
    name: 'Added after inventory.txt',
    mimeType: 'text/plain',
    parents: ['root'],
    ownedByMe: true,
  });
  fixture.drive.resetMutations();

  await assert.rejects(
    () =>
      fixture.repository.cleanupLegacyDriveData(before, housekeepingOptions(), signal),
    (error: unknown) =>
      error instanceof LegacyDriveCleanupRefusedError &&
      /changed after the legacy check/u.test(error.message),
  );
  assert.deepEqual(fixture.drive.trashCalls, []);
  assert.equal(fixture.drive.file('late-unknown').trashed, false);
});

test('cleanup failure stops at the failing eligible ID without broadening scope', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  const eligible = new Set(
    before.items.filter(({ cleanupEligible }) => cleanupEligible).map(({ id }) => id),
  );
  fixture.drive.failTrashId = before.cleanupTargetIds.at(-1);
  fixture.drive.resetMutations();

  await assert.rejects(() =>
    fixture.repository.cleanupLegacyDriveData(before, housekeepingOptions(), signal),
  );
  assert.ok(fixture.drive.trashAttempts.length > 0);
  assert.ok(fixture.drive.trashAttempts.every((id) => eligible.has(id)));
  assert.equal(fixture.drive.file('personal-file').trashed, false);
  assert.equal(fixture.drive.file('legacy-looking-name').trashed, false);
  assert.equal(fixture.drive.file('outside-user-file').trashed, false);
});

test('cleanup refuses a newly appearing eligible file outside the confirmed scope', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  fixture.drive.afterFirstTrash = () => {
    fixture.drive.seed(
      {
        id: 'late-legacy-state',
        name: `state-${fixture.migratedStateHash.slice(0, 16)}.json`,
        mimeType: 'application/json',
        parents: ['legacy-document'],
        ownedByMe: true,
        appProperties: {
          ...legacyProperties('state'),
          sha256: fixture.migratedStateHash,
        },
      },
      fixture.migratedStateBlob,
    );
  };
  fixture.drive.resetMutations();

  await assert.rejects(
    () =>
      fixture.repository.cleanupLegacyDriveData(before, housekeepingOptions(), signal),
    /Drive contents changed during cleanup/u,
  );
  assert.equal(fixture.drive.file('late-legacy-state').trashed, false);
  assert.equal(fixture.drive.trashAttempts.includes('late-legacy-state'), false);
});

test('cleanup rechecks migration protection between Trash requests', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  let migrationStarted = false;
  fixture.drive.afterFirstTrash = () => {
    migrationStarted = true;
  };
  fixture.drive.resetMutations();

  await assert.rejects(
    () =>
      fixture.repository.cleanupLegacyDriveData(
        before,
        housekeepingOptions(),
        signal,
        async () => ({
          migrationInProgress: migrationStarted,
          protectedLegacyFileIds: migrationStarted ? ['legacy-state'] : [],
        }),
      ),
    /Migration or recovery state changed during cleanup/u,
  );
  assert.equal(fixture.drive.trashCalls.length, 1);
});

test('cleanup revalidates the exact ancestor chain before nested-file Trash', async () => {
  const fixture = await housekeepingFixture();
  const before = await fixture.repository.inspectLegacyDriveData(
    housekeepingOptions(),
    signal,
  );
  fixture.drive.onAncestryPreflight = (fileId) => {
    if (fileId === 'legacy-pdf') {
      fixture.drive.changeWithoutMutationLog('legacy-document', {
        parents: ['outside-root'],
      });
    }
  };
  fixture.drive.resetMutations();

  await assert.rejects(
    () =>
      fixture.repository.cleanupLegacyDriveData(before, housekeepingOptions(), signal),
    /parent changed after confirmation/u,
  );
  assert.deepEqual(fixture.drive.trashCalls, []);
  assert.equal(fixture.drive.file('legacy-pdf').trashed, false);
});

test('coordinator requires the explicit cleanup confirmation token before initialization', async () => {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  await assert.rejects(
    () => coordinator.removeRecognizedLegacyData('wrong-token' as never),
    /Explicit confirmation is required/u,
  );
  assert.equal(LEGACY_CLEANUP_CONFIRMATION, 'move-recognized-legacy-to-trash');

  Object.assign(coordinator, { initializationPromise: Promise.resolve() });
  await assert.rejects(
    () => coordinator.removeRecognizedLegacyData(LEGACY_CLEANUP_CONFIRMATION),
    /Check legacy Drive data again before cleanup/u,
  );
});

test('coordinator inventory cannot discover or create a root when none is selected', async () => {
  const drive = createMemoryHousekeepingDrive();
  drive.resetMutations();
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  Object.assign(coordinator, {
    drive,
    initializationPromise: Promise.resolve(),
    profile: {
      id: 'paper-device',
      deviceId: 'device-no-root',
      deviceLabel: 'No root device',
      deviceMode: 'personal',
      autoSync: true,
    },
  });

  await assert.rejects(
    () => coordinator.checkLegacyDriveData(),
    /Select an existing verified 39Note Drive folder/u,
  );
  assert.deepEqual(drive.mutations, []);
  assert.deepEqual(drive.trashAttempts, []);
});

test('normal sync paths do not invoke legacy cleanup', () => {
  const coordinator = source('../src/sync/paperCoordinator.ts');
  const cleanupCall = coordinator.match(/\.cleanupLegacyDriveData\(/gu) ?? [];
  assert.equal(cleanupCall.length, 1);
  const methodStart = coordinator.indexOf(
    'private async removeRecognizedLegacyDataOwned',
  );
  const callIndex = coordinator.indexOf('.cleanupLegacyDriveData(', methodStart);
  const nextMethod = coordinator.indexOf('\n  async scanCloudPapers()', methodStart);
  assert.ok(methodStart >= 0 && callIndex > methodStart && callIndex < nextMethod);
  assert.doesNotMatch(coordinator.slice(0, methodStart), /cleanupLegacyDriveData\(/u);
  const repository = source('../src/sync/paperDriveRepository.ts');
  assert.doesNotMatch(repository, /deleteFile|files\.delete/u);
});

function housekeepingOptions() {
  return { migrationInProgress: false, protectedLegacyFileIds: [] };
}

async function housekeepingFixture() {
  const drive = createMemoryHousekeepingDrive();
  const repository = new PaperDriveRepository(drive, 'root', {
    now: monotonicNow(),
  });
  await repository.initializeEmptyLayout(signal);
  const state = paperState('doc-current');
  const published = await repository.publishPaper(
    await localPackage('doc-current', 'Current paper'),
    state,
    signal,
  );

  const migratedStateBlob = await drive.downloadBlob(published.manifest.state.fileId);
  const migratedProductivityBlob = await drive.downloadBlob(
    published.manifest.productivity.fileId,
  );
  const migratedSource = published.manifest.sourceArtifact;
  assert.ok(migratedSource);
  const migratedSourceBlob = await drive.downloadBlob(migratedSource.fileId);

  drive.seed({
    id: 'legacy-manifest',
    name: '39note-manifest.json',
    mimeType: 'application/json',
    parents: ['root'],
    ownedByMe: true,
    appProperties: legacyProperties('manifest'),
  });
  drive.seed({
    id: 'legacy-library',
    name: 'library.json',
    mimeType: 'application/json',
    parents: ['root'],
    ownedByMe: true,
    appProperties: legacyProperties('library'),
  });
  drive.seed({
    id: 'legacy-documents',
    name: 'documents',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root'],
    ownedByMe: true,
    appProperties: legacyProperties('documents'),
  });
  drive.seed({
    id: 'legacy-document',
    name: 'document-doc-current',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['legacy-documents'],
    ownedByMe: true,
    appProperties: legacyProperties('document', 'doc-current'),
  });
  drive.seed(
    {
      id: 'legacy-state',
      name: 'state.json',
      mimeType: 'application/json',
      parents: ['legacy-document'],
      ownedByMe: true,
      appProperties: legacyProperties('state'),
    },
    migratedStateBlob,
  );
  drive.seed(
    {
      id: 'legacy-productivity',
      name: 'productivity.json',
      mimeType: 'application/json',
      parents: ['legacy-document'],
      ownedByMe: true,
      appProperties: legacyProperties('productivity'),
    },
    migratedProductivityBlob,
  );
  drive.seed({
    id: 'mismatched-legacy-state',
    name: 'state.json',
    mimeType: 'application/json',
    parents: ['orphan-legacy-document'],
    ownedByMe: true,
    appProperties: legacyProperties('state', 'different-document'),
  });
  drive.seed(
    {
      id: 'legacy-pdf',
      name: `original-${migratedSource.sha256.slice(0, 16)}.pdf`,
      mimeType: 'application/pdf',
      parents: ['legacy-document'],
      ownedByMe: true,
      appProperties: {
        ...legacyProperties('original-pdf', 'doc-current'),
        sha256: migratedSource.sha256,
      },
    },
    migratedSourceBlob,
  );
  drive.seed({
    id: 'orphan-legacy-document',
    name: 'document-doc-old',
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['legacy-documents'],
    ownedByMe: true,
    appProperties: legacyProperties('document', 'doc-old'),
  });
  drive.seed(
    {
      id: 'orphan-legacy-state',
      name: 'state.json',
      mimeType: 'application/json',
      parents: ['orphan-legacy-document'],
      ownedByMe: true,
      appProperties: legacyProperties('state'),
    },
    migratedStateBlob,
  );
  drive.seed({
    id: 'personal-file',
    name: 'Personal notes.txt',
    mimeType: 'text/plain',
    parents: ['legacy-documents'],
    ownedByMe: true,
  });
  drive.seed({
    id: 'legacy-looking-name',
    name: '39note-manifest-old.json',
    mimeType: 'application/json',
    parents: ['root'],
    ownedByMe: true,
  });
  drive.seed({
    id: 'malformed-legacy',
    name: 'library.json',
    mimeType: 'application/json',
    parents: ['root'],
    ownedByMe: true,
    appProperties: { application: '39Note', role: 'library' },
  });
  drive.seed({
    id: 'outside-user-file',
    name: '39note-manifest.json',
    mimeType: 'application/json',
    parents: ['other-root'],
    ownedByMe: true,
    appProperties: legacyProperties('manifest'),
  });
  const activation = {
    app: '39Note',
    syncLayoutVersion: LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
    paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
    rootFolderId: 'root',
    paperFolderIds: [published.cloud.paperFolderId],
    paperGenerations: {
      'doc-current': published.manifest.generation.id,
    },
    legacyManagedFileIds: [
      'legacy-documents',
      'legacy-library',
      'legacy-manifest',
    ].sort(),
  };
  const activationText = stableStringify(activation);
  const activationHash = await sha256Hex(activationText);
  drive.seed(
    {
      id: 'layout-activation',
      name: `paper-layout-v${LEGACY_PAPER_PACKAGE_LAYOUT_VERSION}-${activationHash}.json`,
      mimeType: 'application/json',
      parents: ['root'],
      ownedByMe: true,
      appProperties: {
        application: '39Note',
        syncSchema: '1',
        layoutVersion: String(LEGACY_PAPER_PACKAGE_LAYOUT_VERSION),
        paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
        role: 'paper-layout-activation',
        documentId: 'layout',
        sha256: activationHash,
      },
    },
    new Blob([activationText], { type: 'application/json' }),
  );
  return {
    drive,
    repository,
    state,
    published,
    migratedStateBlob,
    migratedStateHash: published.manifest.state.sha256,
  };
}

function legacyProperties(role: string, documentId?: string) {
  return {
    application: '39Note',
    syncSchema: '1',
    role,
    ...(documentId ? { documentId } : {}),
  };
}

function item(
  inventory: Awaited<
    ReturnType<PaperDriveRepositoryInstance['inspectLegacyDriveData']>
  >,
  id: string,
) {
  const found = inventory.items.find((candidate) => candidate.id === id);
  assert.ok(found, `Expected inventory item ${id}`);
  return found;
}

function evidenceByClassification(
  inventory: Awaited<
    ReturnType<PaperDriveRepositoryInstance['inspectLegacyDriveData']>
  >,
  classification:
    'current-paper-v2' | 'current-layout-v3' | 'recognized-legacy' | 'unknown',
) {
  return new Map(
    inventory.items
      .filter((item) => item.classification === classification)
      .map(({ id, evidenceHash }) => [id, evidenceHash]),
  );
}

function createMemoryHousekeepingDrive() {
  class MemoryHousekeepingDrive extends DriveClient {
    private readonly files = new Map<string, DriveFileMetadata>();
    private readonly blobs = new Map<string, Blob>();
    private sequence = 0;
    private revision = 0;
    readonly mutations: string[] = [];
    readonly trashCalls: string[] = [];
    readonly trashAttempts: string[] = [];
    failTrashId?: string;
    afterFirstTrash?: () => void;
    onAncestryPreflight?: (fileId: string) => void;

    constructor() {
      super(() => 'memory-token');
      this.seed({
        id: 'root',
        name: '39Note',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: true,
        appProperties: {
          application: '39Note',
          role: 'root',
        },
      });
    }

    seed(metadata: DriveFileMetadata, blob = new Blob()): DriveFileMetadata {
      this.revision += 1;
      const file: DriveFileMetadata = {
        trashed: false,
        ownedByMe: true,
        modifiedTime: new Date(1_700_000_000_000 + this.revision).toISOString(),
        version: String(this.revision),
        md5Checksum: this.revision.toString(16).padStart(32, '0'),
        size: String(blob.size),
        ...structuredClone(metadata),
      };
      this.files.set(file.id, file);
      this.blobs.set(file.id, blob);
      return structuredClone(file);
    }

    file(id: string): DriveFileMetadata {
      const file = this.files.get(id);
      if (!file) throw new Error(`Missing Drive file ${id}`);
      return structuredClone(file);
    }

    changeWithoutMutationLog(id: string, update: Partial<DriveFileMetadata>): void {
      this.files.set(id, { ...this.file(id), ...structuredClone(update) });
    }

    resetMutations(): void {
      this.mutations.length = 0;
      this.trashCalls.length = 0;
      this.trashAttempts.length = 0;
    }

    override async listFiles(query: string): Promise<DriveFileMetadata[]> {
      return [...this.files.values()]
        .filter((file) => matchesQuery(file, query))
        .map((file) => structuredClone(file));
    }

    override async getMetadata(
      fileId: string,
      _signal?: AbortSignal,
      context?: { phase?: string },
    ): Promise<DriveFileMetadata> {
      if (
        context?.phase === 'legacy-cleanup-ancestry-preflight' &&
        this.onAncestryPreflight
      ) {
        const callback = this.onAncestryPreflight;
        this.onAncestryPreflight = undefined;
        callback(fileId);
      }
      return this.file(fileId);
    }

    override async createFolder(
      name: string,
      parentId: string | null,
      appProperties: Record<string, string>,
    ): Promise<DriveFileMetadata> {
      this.mutations.push(`create:${name}`);
      return this.seed({
        id: this.nextId(),
        name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentId ? { parents: [parentId] } : {}),
        appProperties,
      });
    }

    override async updateMetadata(
      fileId: string,
      metadata: Record<string, unknown>,
    ): Promise<DriveFileMetadata> {
      this.mutations.push(`update:${fileId}`);
      const previous = this.file(fileId);
      this.revision += 1;
      const updated = {
        ...previous,
        ...metadata,
        version: String(this.revision),
        modifiedTime: new Date(1_700_000_000_000 + this.revision).toISOString(),
      } as DriveFileMetadata;
      this.files.set(fileId, updated);
      return structuredClone(updated);
    }

    override async uploadFile(
      name: string,
      content: Blob,
      metadata: { parents?: string[]; appProperties?: Record<string, string> },
      _signal: AbortSignal,
      onProgress?: (uploaded: number, total: number) => void,
    ): Promise<DriveFileMetadata> {
      this.mutations.push(`upload:${name}`);
      onProgress?.(content.size, content.size);
      return this.seed(
        {
          id: this.nextId(),
          name,
          mimeType: content.type || 'application/octet-stream',
          ...metadata,
        },
        content,
      );
    }

    override async downloadBlob(fileId: string): Promise<Blob> {
      const blob = this.blobs.get(fileId);
      if (!blob) throw new Error(`Missing Drive blob ${fileId}`);
      return blob;
    }

    override async downloadText(fileId: string): Promise<string> {
      return (await this.downloadBlob(fileId)).text();
    }

    override async trashManagedLegacyFile(fileId: string): Promise<DriveFileMetadata> {
      this.trashAttempts.push(fileId);
      if (fileId === this.failTrashId) throw new Error('Injected Trash failure.');
      this.mutations.push(`trash:${fileId}`);
      this.trashCalls.push(fileId);
      const previous = this.file(fileId);
      this.revision += 1;
      const trashed = {
        ...previous,
        trashed: true,
        version: String(this.revision),
        modifiedTime: new Date(1_700_000_000_000 + this.revision).toISOString(),
      };
      this.files.set(fileId, trashed);
      if (this.trashCalls.length === 1 && this.afterFirstTrash) {
        const callback = this.afterFirstTrash;
        this.afterFirstTrash = undefined;
        callback();
      }
      return structuredClone(trashed);
    }

    private nextId(): string {
      this.sequence += 1;
      return `drive-${this.sequence}`;
    }
  }
  return new MemoryHousekeepingDrive() as MemoryHousekeepingDrive & DriveClientInstance;
}

function matchesQuery(file: DriveFileMetadata, query: string): boolean {
  const parent = query.match(/'([^']+)' in parents/u)?.[1];
  const name = query.match(/name='([^']+)'/u)?.[1];
  const mimeType = query.match(/mimeType='([^']+)'/u)?.[1];
  const properties = [...query.matchAll(/key='([^']+)' and value='([^']+)'/gu)];
  return (
    (!parent || file.parents?.includes(parent)) &&
    (!name || file.name === name) &&
    (!mimeType || file.mimeType === mimeType) &&
    (!query.includes('trashed=false') || !file.trashed) &&
    properties.every(([, key, value]) => file.appProperties?.[key] === value)
  );
}

function paperState(documentId: string): PaperSyncState {
  return {
    documentId,
    displayName: documentId,
    deviceId: 'device-a',
    availability: 'local-only',
    status: 'local-only',
    dirtyGeneration: 0,
    dirtyReasons: [],
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    incorporatedHeadIds: [],
    remoteHeadIds: [],
    pdfFingerprints: {},
    driveFiles: { fileIds: {} },
  };
}

async function localPackage(
  documentId: string,
  displayName: string,
): Promise<LocalPaperPackage> {
  const value = { displayTitle: displayName };
  const document: SyncEntityRecord = {
    key: createSyncEntityKey('document', documentId),
    kind: 'document',
    id: documentId,
    value,
    version: {
      updatedAt: 1,
      deviceId: 'device-a',
      hash: await sha256Hex(stableStringify(value)),
    },
  };
  const pdfBlob = new Blob([`%PDF-1.7\n${documentId}`], {
    type: 'application/pdf',
  });
  const sourcePdf: LocalSyncPdf = {
    documentId,
    fileName: `${displayName}.pdf`,
    mimeType: 'application/pdf',
    size: pdfBlob.size,
    lastModified: 1,
    storedAt: 1,
    sha256: await sha256Hex(pdfBlob),
    blob: pdfBlob,
  };
  return {
    documentId,
    displayName,
    deleted: false,
    writer: { deviceId: 'device-a' },
    sourcePdf,
    snapshot: snapshot('device-a', [document], [withoutBlob(sourcePdf)]),
  };
}

function snapshot(
  generatedBy: string,
  entities: SyncEntityRecord[],
  pdfs: SyncSnapshot['pdfs'],
): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 1,
    generatedBy,
    entities,
    tombstones: [],
    pdfs,
  };
}

function withoutBlob(pdf: LocalSyncPdf) {
  return {
    documentId: pdf.documentId,
    fileName: pdf.fileName,
    mimeType: pdf.mimeType,
    size: pdf.size,
    lastModified: pdf.lastModified,
    storedAt: pdf.storedAt,
    sha256: pdf.sha256,
  };
}

function monotonicNow(): () => number {
  let now = 1_700_000_000_000;
  return () => ++now;
}
