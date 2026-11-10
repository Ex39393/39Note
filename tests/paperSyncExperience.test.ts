import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViteDevServer } from 'vite';
import {
  advanceRemoteUpdateDismissal,
  defaultDirtyPaperSelection,
  derivePaperStatus,
  incorporateVerifiedMigrationHead,
  nextRemoteUpdateReminder,
  settleCapturedDirtyGeneration,
} from '../src/sync/paperStateMachine.ts';
import { getSyncProgressPresentation } from '../src/sync/progressPresentation.ts';
import {
  SyncSoundFeedback,
  transitionCue,
  type SyncSoundCue,
} from '../src/sync/syncSounds.ts';
import {
  syncToneForIssue,
  syncToneForPaper,
  syncToneForView,
} from '../src/sync/syncPresentation.ts';
import { SYNC_DATABASE_VERSION, SYNC_SCHEMA_VERSION } from '../src/sync/types.ts';
import {
  normalizeLayoutMigrationRecord,
  normalizePaperSyncState,
  type PaperSyncDeviceProfile,
} from '../src/sync/storage.ts';
import type { PaperCloudSummary, PaperSyncState } from '../src/sync/paperTypes.ts';
import type { LegacyDriveInventory } from '../src/sync/legacyDriveHousekeeping.ts';
import type { WorkspaceRestoreLease } from '../src/services/workspaceRestoreLock.ts';
import type {
  PaperConnectionStatus,
  PaperRetryDiagnosticSnapshot,
  PaperSyncStatusDiagnosticSnapshot,
  PaperSyncViewState,
  TargetedPaperPurgePreview,
} from '../src/sync/paperCoordinator.ts';
import type { PaperFolderNameNormalizationPreview } from '../src/sync/paperDriveRepository.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

type PaperFailureIssue = {
  code: string;
  blocksOrdinarySync: boolean;
  diagnostic: {
    operation?: string;
    phase?: string;
    causeCode?: string;
    documentId?: string;
  };
};

async function markPaperFailureWithWorkspaceLease(
  coordinator: object,
  documentId: string,
  error: unknown,
): Promise<PaperFailureIssue> {
  const runWorkspaceMutation = Reflect.get(coordinator, 'runWorkspaceMutation') as (
    task: (lease: WorkspaceRestoreLease) => Promise<PaperFailureIssue>,
  ) => Promise<PaperFailureIssue>;
  const markPaperFailure = Reflect.get(coordinator, 'markPaperFailure') as (
    documentId: string,
    error: unknown,
    lease: WorkspaceRestoreLease,
  ) => Promise<PaperFailureIssue>;
  return runWorkspaceMutation.call(coordinator, (lease) =>
    markPaperFailure.call(coordinator, documentId, error, lease),
  );
}
const VIRTUAL_SECURITY_IDB_ID = '\0paper-sync-security-idb-test';
const SECURITY_IDB_HARNESS_SYMBOL = Symbol.for('39note.test.paper-sync-security-idb');
const securityDatabaseRecords = new Map<
  string,
  Map<string, Map<string, Record<string, unknown>>>
>();
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let server: ViteDevServer;
let PaperSyncDrawer: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSyncDrawer'];
let GoogleDriveAccessDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['GoogleDriveAccessDialog'];
let RestorePublicationResumeDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['RestorePublicationResumeDialog'];
let TargetedPaperPurgeDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['TargetedPaperPurgeDialog'];
let ForgetInaccessiblePaperDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['ForgetInaccessiblePaperDialog'];
let LegacyCleanupConfirmation: (typeof import('../src/sync/PaperSyncControl.tsx'))['LegacyCleanupConfirmation'];
let PaperFolderNameNormalizationConfirmation: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperFolderNameNormalizationConfirmation'];
let PaperSelectorDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSelectorDialog'];
let paperRows: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperRows'];
let PaperLibraryCloudView: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperLibraryCloudView'];
let getPaperDownloadBatchFeedback: (typeof import('../src/sync/PaperSyncControl.tsx'))['getPaperDownloadBatchFeedback'];
let ReaderSyncStatusPill: (typeof import('../src/sync/PaperSyncControl.tsx'))['ReaderSyncStatusPill'];
let readerPaperSyncLabel: (typeof import('../src/sync/PaperSyncControl.tsx'))['readerPaperSyncLabel'];
let paperSyncStatusLabel: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperSyncStatusLabel'];
let normalCloudPapers: (typeof import('../src/sync/PaperSyncControl.tsx'))['normalCloudPapers'];
let paperConnectionAction: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperConnectionAction'];
let shouldShowRemoteUpdateRecommendation: (typeof import('../src/sync/PaperSyncControl.tsx'))['shouldShowRemoteUpdateRecommendation'];
let targetedPaperPurgeCandidate: (typeof import('../src/sync/PaperSyncControl.tsx'))['targetedPaperPurgeCandidate'];
let shouldOfferForgetIdentityVerification: (typeof import('../src/sync/PaperSyncControl.tsx'))['shouldOfferForgetIdentityVerification'];
let getPaperSyncUiStatus: (typeof import('../src/sync/paperCoordinator.ts'))['getPaperSyncUiStatus'];
let getBlockingPaperIssueCount: (typeof import('../src/sync/paperCoordinator.ts'))['getBlockingPaperIssueCount'];
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let DeviceModeSelectionRequiredError: (typeof import('../src/sync/paperCoordinator.ts'))['DeviceModeSelectionRequiredError'];
let PublicDeviceRootMissingError: (typeof import('../src/sync/paperCoordinator.ts'))['PublicDeviceRootMissingError'];
let WorkspaceAccountAssociationRequiredError: (typeof import('../src/sync/paperCoordinator.ts'))['WorkspaceAccountAssociationRequiredError'];
let WorkspaceAccountIdentityUnavailableError: (typeof import('../src/sync/paperCoordinator.ts'))['WorkspaceAccountIdentityUnavailableError'];
let WorkspaceAccountMismatchError: (typeof import('../src/sync/paperCoordinator.ts'))['WorkspaceAccountMismatchError'];
let PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION: (typeof import('../src/sync/paperCoordinator.ts'))['PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION'];
let SerializedDriveOperationOwner: (typeof import('../src/sync/paperCoordinator.ts'))['SerializedDriveOperationOwner'];
let DriveOperationTimeoutError: (typeof import('../src/sync/paperCoordinator.ts'))['DriveOperationTimeoutError'];
let classifyPaperCoordinatorError: (typeof import('../src/sync/paperCoordinator.ts'))['classifyPaperCoordinatorError'];
let autoSyncFollowUpPolicy: (typeof import('../src/sync/paperCoordinator.ts'))['autoSyncFollowUpPolicy'];
let paperStatusAfterFailure: (typeof import('../src/sync/paperCoordinator.ts'))['paperStatusAfterFailure'];
let transientAutoRetryDelay: (typeof import('../src/sync/paperCoordinator.ts'))['transientAutoRetryDelay'];
let trustedLegacyWorkspaceAccountId: (typeof import('../src/sync/paperCoordinator.ts'))['trustedLegacyWorkspaceAccountId'];
let discoverPaperRootsBeforeCreation: (typeof import('../src/sync/paperCoordinator.ts'))['discoverPaperRootsBeforeCreation'];
let confirmCreatedPaperRoot: (typeof import('../src/sync/paperCoordinator.ts'))['confirmCreatedPaperRoot'];
let PaperRepositoryError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperRepositoryError'];
let AmbiguousPaperFolderError: (typeof import('../src/sync/paperDriveRepository.ts'))['AmbiguousPaperFolderError'];
let PaperManifestIntegrityError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperManifestIntegrityError'];
let PaperPayloadPartitionError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperPayloadPartitionError'];
let PaperSnapshotUnstableError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperSnapshotUnstableError'];
let PaperV3ControlIntegrityError: (typeof import('../src/sync/paperPresenceDriveRepository.ts'))['PaperV3ControlIntegrityError'];
let finalizeAppliedPaperDownload: (typeof import('../src/sync/paperLocalAdapter.ts'))['finalizeAppliedPaperDownload'];
let CloudPayloadPartitionError: (typeof import('../src/sync/cloudFormat.ts'))['CloudPayloadPartitionError'];
let DriveClient: (typeof import('../src/sync/driveClient.ts'))['DriveClient'];
let DriveNetworkError: (typeof import('../src/sync/driveClient.ts'))['DriveNetworkError'];
let DriveRequestError: (typeof import('../src/sync/driveClient.ts'))['DriveRequestError'];
let evaluateTemporaryModeFootprint: (typeof import('../src/sync/temporaryDeviceSession.ts'))['evaluateTemporaryModeFootprint'];
let createTemporaryCleanupPlan: (typeof import('../src/sync/temporaryDeviceSession.ts'))['createTemporaryCleanupPlan'];
let createLayoutMigrationIssue: (typeof import('../src/sync/errorModel.ts'))['createLayoutMigrationIssue'];
let createLayoutMigrationFailure: (typeof import('../src/sync/layoutMigration.ts'))['createLayoutMigrationFailure'];
let GoogleAuthorizationStartError: (typeof import('../src/sync/googleIdentity.ts'))['GoogleAuthorizationStartError'];
let SyncOriginNotAllowedError: (typeof import('../src/sync/googleIdentity.ts'))['SyncOriginNotAllowedError'];
let closeSyncPersistenceWorkspace: (typeof import('../src/sync/storage.ts'))['closeSyncPersistenceWorkspace'];
let deletePaperSyncRecords: (typeof import('../src/sync/storage.ts'))['deletePaperSyncRecords'];
let loadPaperSyncStates: (typeof import('../src/sync/storage.ts'))['loadPaperSyncStates'];
let loadCloudPaperCatalog: (typeof import('../src/sync/storage.ts'))['loadCloudPaperCatalog'];
let loadPaperSyncDeviceProfile: (typeof import('../src/sync/storage.ts'))['loadPaperSyncDeviceProfile'];
let saveCloudPaperCatalog: (typeof import('../src/sync/storage.ts'))['saveCloudPaperCatalog'];
let savePaperSyncState: (typeof import('../src/sync/storage.ts'))['savePaperSyncState'];
let savePaperSyncDeviceProfile: (typeof import('../src/sync/storage.ts'))['savePaperSyncDeviceProfile'];
let PUBLIC_DEVICE_LIMITATION: string;

before(async () => {
  Object.defineProperty(globalThis, SECURITY_IDB_HARNESS_SYMBOL, {
    configurable: true,
    value: securityDatabaseRecords,
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
        name: 'paper-sync-security-idb-test-double',
        enforce: 'pre',
        resolveId(id) {
          return id === 'idb' ? VIRTUAL_SECURITY_IDB_ID : undefined;
        },
        load(id) {
          if (id !== VIRTUAL_SECURITY_IDB_ID) return undefined;
          return `
            const harness = () => globalThis[Symbol.for('39note.test.paper-sync-security-idb')];
            const keyFor = (value) => value.id ?? value.documentId ?? value.workspaceId;
            const storeFor = (databaseName, storeName) => {
              const state = harness();
              let database = state.get(databaseName);
              if (!database) {
                database = new Map();
                state.set(databaseName, database);
              }
              let store = database.get(storeName);
              if (!store) {
                store = new Map();
                database.set(storeName, store);
              }
              return store;
            };
            const operations = (databaseName, storeName) => ({
              async put(value) {
                storeFor(databaseName, storeName).set(keyFor(value), { ...value });
              },
              async get(key) {
                return storeFor(databaseName, storeName).get(key);
              },
              async getAll() {
                return [...storeFor(databaseName, storeName).values()];
              },
              async delete(key) {
                storeFor(databaseName, storeName).delete(key);
              },
              async clear() {
                storeFor(databaseName, storeName).clear();
              },
            });
            export async function openDB(name, _version, options = {}) {
              options.upgrade?.({
                objectStoreNames: { contains: () => false },
                createObjectStore() {},
              });
              return {
                async put(storeName, value) {
                  return operations(name, storeName).put(value);
                },
                async get(storeName, key) {
                  return operations(name, storeName).get(key);
                },
                async getAll(storeName) {
                  return operations(name, storeName).getAll();
                },
                async delete(storeName, key) {
                  return operations(name, storeName).delete(key);
                },
                transaction(storeName) {
                  return {
                    store: operations(name, storeName),
                    objectStore(selectedStoreName) {
                      return operations(name, selectedStoreName);
                    },
                    done: Promise.resolve(),
                  };
                },
                close() {},
              };
            }
            export async function deleteDB(name) {
              harness().delete(name);
            }
          `;
        },
      },
    ],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });
  const [
    ui,
    coordinator,
    temporary,
    repository,
    presenceRepository,
    drive,
    cloudFormat,
    localAdapter,
    errorModel,
    layoutMigration,
    identity,
    syncStorage,
  ] = await Promise.all([
    server.ssrLoadModule('/src/sync/PaperSyncControl.tsx') as Promise<
      typeof import('../src/sync/PaperSyncControl.tsx')
    >,
    server.ssrLoadModule('/src/sync/paperCoordinator.ts') as Promise<
      typeof import('../src/sync/paperCoordinator.ts')
    >,
    server.ssrLoadModule('/src/sync/temporaryDeviceSession.ts') as Promise<
      typeof import('../src/sync/temporaryDeviceSession.ts')
    >,
    server.ssrLoadModule('/src/sync/paperDriveRepository.ts') as Promise<
      typeof import('../src/sync/paperDriveRepository.ts')
    >,
    server.ssrLoadModule('/src/sync/paperPresenceDriveRepository.ts') as Promise<
      typeof import('../src/sync/paperPresenceDriveRepository.ts')
    >,
    server.ssrLoadModule('/src/sync/driveClient.ts') as Promise<
      typeof import('../src/sync/driveClient.ts')
    >,
    server.ssrLoadModule('/src/sync/cloudFormat.ts') as Promise<
      typeof import('../src/sync/cloudFormat.ts')
    >,
    server.ssrLoadModule('/src/sync/paperLocalAdapter.ts') as Promise<
      typeof import('../src/sync/paperLocalAdapter.ts')
    >,
    server.ssrLoadModule('/src/sync/errorModel.ts') as Promise<
      typeof import('../src/sync/errorModel.ts')
    >,
    server.ssrLoadModule('/src/sync/layoutMigration.ts') as Promise<
      typeof import('../src/sync/layoutMigration.ts')
    >,
    server.ssrLoadModule('/src/sync/googleIdentity.ts') as Promise<
      typeof import('../src/sync/googleIdentity.ts')
    >,
    server.ssrLoadModule('/src/sync/storage.ts') as Promise<
      typeof import('../src/sync/storage.ts')
    >,
  ]);
  PaperSyncDrawer = ui.PaperSyncDrawer;
  GoogleDriveAccessDialog = ui.GoogleDriveAccessDialog;
  RestorePublicationResumeDialog = ui.RestorePublicationResumeDialog;
  TargetedPaperPurgeDialog = ui.TargetedPaperPurgeDialog;
  ForgetInaccessiblePaperDialog = ui.ForgetInaccessiblePaperDialog;
  LegacyCleanupConfirmation = ui.LegacyCleanupConfirmation;
  PaperFolderNameNormalizationConfirmation =
    ui.PaperFolderNameNormalizationConfirmation;
  PaperSelectorDialog = ui.PaperSelectorDialog;
  paperRows = ui.paperRows;
  PaperLibraryCloudView = ui.PaperLibraryCloudView;
  getPaperDownloadBatchFeedback = ui.getPaperDownloadBatchFeedback;
  ReaderSyncStatusPill = ui.ReaderSyncStatusPill;
  readerPaperSyncLabel = ui.readerPaperSyncLabel;
  paperSyncStatusLabel = ui.paperSyncStatusLabel;
  normalCloudPapers = ui.normalCloudPapers;
  paperConnectionAction = ui.paperConnectionAction;
  shouldShowRemoteUpdateRecommendation = ui.shouldShowRemoteUpdateRecommendation;
  targetedPaperPurgeCandidate = ui.targetedPaperPurgeCandidate;
  shouldOfferForgetIdentityVerification = ui.shouldOfferForgetIdentityVerification;
  getPaperSyncUiStatus = coordinator.getPaperSyncUiStatus;
  getBlockingPaperIssueCount = coordinator.getBlockingPaperIssueCount;
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  DeviceModeSelectionRequiredError = coordinator.DeviceModeSelectionRequiredError;
  PublicDeviceRootMissingError = coordinator.PublicDeviceRootMissingError;
  WorkspaceAccountAssociationRequiredError =
    coordinator.WorkspaceAccountAssociationRequiredError;
  WorkspaceAccountIdentityUnavailableError =
    coordinator.WorkspaceAccountIdentityUnavailableError;
  WorkspaceAccountMismatchError = coordinator.WorkspaceAccountMismatchError;
  PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION =
    coordinator.PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION;
  SerializedDriveOperationOwner = coordinator.SerializedDriveOperationOwner;
  DriveOperationTimeoutError = coordinator.DriveOperationTimeoutError;
  classifyPaperCoordinatorError = coordinator.classifyPaperCoordinatorError;
  autoSyncFollowUpPolicy = coordinator.autoSyncFollowUpPolicy;
  paperStatusAfterFailure = coordinator.paperStatusAfterFailure;
  transientAutoRetryDelay = coordinator.transientAutoRetryDelay;
  trustedLegacyWorkspaceAccountId = coordinator.trustedLegacyWorkspaceAccountId;
  discoverPaperRootsBeforeCreation = coordinator.discoverPaperRootsBeforeCreation;
  confirmCreatedPaperRoot = coordinator.confirmCreatedPaperRoot;
  PaperRepositoryError = repository.PaperRepositoryError;
  AmbiguousPaperFolderError = repository.AmbiguousPaperFolderError;
  PaperManifestIntegrityError = repository.PaperManifestIntegrityError;
  PaperPayloadPartitionError = repository.PaperPayloadPartitionError;
  PaperSnapshotUnstableError = repository.PaperSnapshotUnstableError;
  PaperV3ControlIntegrityError = presenceRepository.PaperV3ControlIntegrityError;
  CloudPayloadPartitionError = cloudFormat.CloudPayloadPartitionError;
  finalizeAppliedPaperDownload = localAdapter.finalizeAppliedPaperDownload;
  DriveClient = drive.DriveClient;
  DriveNetworkError = drive.DriveNetworkError;
  DriveRequestError = drive.DriveRequestError;
  evaluateTemporaryModeFootprint = temporary.evaluateTemporaryModeFootprint;
  createTemporaryCleanupPlan = temporary.createTemporaryCleanupPlan;
  createLayoutMigrationIssue = errorModel.createLayoutMigrationIssue;
  createLayoutMigrationFailure = layoutMigration.createLayoutMigrationFailure;
  GoogleAuthorizationStartError = identity.GoogleAuthorizationStartError;
  SyncOriginNotAllowedError = identity.SyncOriginNotAllowedError;
  closeSyncPersistenceWorkspace = syncStorage.closeSyncPersistenceWorkspace;
  deletePaperSyncRecords = syncStorage.deletePaperSyncRecords;
  loadPaperSyncStates = syncStorage.loadPaperSyncStates;
  loadCloudPaperCatalog = syncStorage.loadCloudPaperCatalog;
  loadPaperSyncDeviceProfile = syncStorage.loadPaperSyncDeviceProfile;
  saveCloudPaperCatalog = syncStorage.saveCloudPaperCatalog;
  savePaperSyncState = syncStorage.savePaperSyncState;
  savePaperSyncDeviceProfile = syncStorage.savePaperSyncDeviceProfile;
  PUBLIC_DEVICE_LIMITATION = temporary.PUBLIC_DEVICE_LIMITATION;
});

after(async () => {
  await server.close();
  Reflect.deleteProperty(globalThis, SECURITY_IDB_HARNESS_SYMBOL);
  if (originalIndexedDb) {
    Object.defineProperty(globalThis, 'indexedDB', originalIndexedDb);
  } else {
    Reflect.deleteProperty(globalThis, 'indexedDB');
  }
});

test('per-paper state transitions and selection semantics are deterministic', async (context) => {
  await context.test('cloud-only paper is distinct from local-only paper', () => {
    assert.equal(derivePaperStatus(undefined, ['head-a']), 'cloud-only');
    assert.equal(
      derivePaperStatus(
        { availability: 'local-only', dirtyReasons: [], incorporatedHeadIds: [] },
        [],
      ),
      'synced',
    );
  });

  await context.test('clean incorporated paper is synced', () => {
    assert.equal(
      derivePaperStatus(
        {
          availability: 'local-and-cloud',
          dirtyReasons: [],
          incorporatedHeadIds: ['head-a'],
        },
        ['head-a'],
      ),
      'synced',
    );
  });

  await context.test('only local change becomes local-changes', () => {
    assert.equal(
      derivePaperStatus(
        {
          availability: 'local-and-cloud',
          dirtyReasons: ['notes'],
          incorporatedHeadIds: ['head-a'],
        },
        ['head-a'],
      ),
      'local-changes',
    );
  });

  await context.test('only remote head becomes remote-update-available', () => {
    assert.equal(
      derivePaperStatus(
        {
          availability: 'local-and-cloud',
          dirtyReasons: [],
          incorporatedHeadIds: ['head-a'],
        },
        ['head-b'],
      ),
      'remote-update-available',
    );
  });

  await context.test('local and remote changes become both-changed', () => {
    assert.equal(
      derivePaperStatus(
        {
          availability: 'local-and-cloud',
          dirtyReasons: ['annotations'],
          incorporatedHeadIds: ['head-a'],
        },
        ['head-b'],
      ),
      'both-changed',
    );
  });

  await context.test(
    'upload selection defaults to every and only genuinely dirty paper',
    () => {
      const states = [
        paperState('doc-a', ['notes']),
        paperState('doc-b'),
        paperState('doc-c', ['metadata']),
      ];
      assert.deepEqual(defaultDirtyPaperSelection(states), ['doc-a', 'doc-c']);
    },
  );

  await context.test('late local edit during upload remains pending', () => {
    const state = paperState('doc-a', ['notes']);
    state.dirtyGeneration = 2;
    assert.equal(settleCapturedDirtyGeneration(state, 1), false);
    assert.deepEqual(state.dirtyReasons, ['notes']);
  });

  await context.test(
    'persisted deletion remains queued after state normalization',
    () => {
      const state = paperState('doc-deleted', ['deleted']);
      state.dirtyGeneration = 4;
      const restored = normalizePaperSyncState(state);
      assert.deepEqual(restored.dirtyReasons, ['deleted']);
      assert.equal(restored.dirtyGeneration, 4);
    },
  );

  await context.test(
    'a confirmed targeted purge checkpoint is strict and excluded from publication',
    () => {
      const state = paperState('doc-purge-checkpoint', ['metadata']);
      state.targetedPurge = {
        version: 1,
        operationId: '12345678-1234-4123-8123-1234567890ab',
        phase: 'cloud-cleanup-pending',
        confirmedAt: 123,
        accountId: 'synthetic-account',
        rootFolderId: 'synthetic-root',
        paperFolderId: 'synthetic-paper-folder',
      };
      const restored = normalizePaperSyncState(state);
      assert.deepEqual(restored.targetedPurge, state.targetedPurge);
      assert.deepEqual(defaultDirtyPaperSelection([restored]), []);

      state.targetedPurge.operationId = 'not-a-uuid';
      assert.equal(normalizePaperSyncState(state).targetedPurge, undefined);
    },
  );

  await context.test(
    'synthetic IndexedDB retains an interrupted purge checkpoint until idempotent cleanup',
    async () => {
      const documentId = 'synthetic-targeted-purge-checkpoint';
      await deletePaperSyncRecords([documentId]);
      const state = paperState(documentId, ['metadata']);
      state.targetedPurge = {
        version: 1,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        phase: 'local-cleanup-pending',
        confirmedAt: 456,
        accountId: 'synthetic-account',
        rootFolderId: 'synthetic-root',
        paperFolderId: 'synthetic-paper-folder',
      };
      await savePaperSyncState(state);
      await closeSyncPersistenceWorkspace();

      const reopened = (await loadPaperSyncStates()).find(
        (candidate) => candidate.documentId === documentId,
      );
      assert.deepEqual(reopened?.targetedPurge, state.targetedPurge);
      assert.deepEqual(defaultDirtyPaperSelection(reopened ? [reopened] : []), []);

      await deletePaperSyncRecords([documentId]);
      await deletePaperSyncRecords([documentId]);
      assert.equal(
        (await loadPaperSyncStates()).some(
          (candidate) => candidate.documentId === documentId,
        ),
        false,
      );
    },
  );

  await context.test(
    'active and reviewed cloud-issue proof survives reload and deduplicates repeated confirmation',
    async () => {
      const previous = await loadPaperSyncDeviceProfile();
      const profile: PaperSyncDeviceProfile = {
        id: 'paper-device',
        deviceId: 'quarantine-device',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: true,
        cloudIssueQuarantines: [
          {
            version: 1,
            documentId: 'synthetic-quarantined-paper',
            accountId: 'synthetic-quarantine-account',
            rootFolderId: 'synthetic-quarantine-root',
            reason: 'presence-control-resolution-failed',
            confirmedAt: 200,
          },
          {
            version: 1,
            documentId: 'synthetic-quarantined-paper',
            accountId: 'synthetic-quarantine-account',
            rootFolderId: 'synthetic-quarantine-root',
            reason: 'presence-control-resolution-failed',
            confirmedAt: 300,
          },
          {
            version: 1,
            documentId: 'synthetic-reviewed-paper',
            accountId: 'synthetic-quarantine-account',
            rootFolderId: 'synthetic-quarantine-root',
            reason: 'presence-control-resolution-failed',
            confirmedAt: 400,
            reviewedAt: 500,
            paperFolderId: 'synthetic-reviewed-folder',
          },
        ],
      };
      try {
        await savePaperSyncDeviceProfile(profile, { authentication: 'replace' });
        await closeSyncPersistenceWorkspace();
        const reopened = await loadPaperSyncDeviceProfile();
        assert.deepEqual(reopened.cloudIssueQuarantines, [
          profile.cloudIssueQuarantines![0],
          profile.cloudIssueQuarantines![2],
        ]);

        await savePaperSyncDeviceProfile(reopened, { authentication: 'replace' });
        await closeSyncPersistenceWorkspace();
        assert.equal(
          (await loadPaperSyncDeviceProfile()).cloudIssueQuarantines?.length,
          2,
        );
      } finally {
        await savePaperSyncDeviceProfile(previous, { authentication: 'replace' });
        await closeSyncPersistenceWorkspace();
      }
    },
  );

  await context.test('persisted Drive PDF evidence is strict and optional', () => {
    const state = paperState('doc-evidence');
    state.driveFiles.sourcePdfEvidence = {
      fileId: 'pdf-a',
      version: '7',
      md5Checksum: 'ABCDEF0123456789ABCDEF0123456789',
      size: '123',
    };
    assert.deepEqual(normalizePaperSyncState(state).driveFiles.sourcePdfEvidence, {
      fileId: 'pdf-a',
      version: '7',
      md5Checksum: 'abcdef0123456789abcdef0123456789',
      size: '123',
    });
    state.driveFiles.sourcePdfEvidence.md5Checksum = 'not-a-checksum';
    assert.equal(
      normalizePaperSyncState(state).driveFiles.sourcePdfEvidence,
      undefined,
    );
  });

  await context.test(
    'dismissed remote identity is canonical and persisted exactly',
    () => {
      const state = paperState('doc-dismissed');
      state.dismissedRemoteHeadIds = ['b'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)];
      assert.deepEqual(normalizePaperSyncState(state).dismissedRemoteHeadIds, [
        'a'.repeat(64),
        'b'.repeat(64),
      ]);
      state.dismissedRemoteHeadIds = ['not-a-generation-id'];
      assert.equal(normalizePaperSyncState(state).dismissedRemoteHeadIds, undefined);
    },
  );

  await context.test('unchanged captured generation clears after success', () => {
    const state = paperState('doc-a', ['notes']);
    state.dirtyGeneration = 2;
    assert.equal(settleCapturedDirtyGeneration(state, 2), true);
    assert.deepEqual(state.dirtyReasons, []);
  });

  await context.test('global pending never means an empty local queue', () => {
    const state = viewState({
      connection: 'connected',
      dirtyPaperIds: [],
      lastSuccessfulAt: undefined,
    });
    assert.equal(getPaperSyncUiStatus(state), 'connected');
    assert.notEqual(getPaperSyncUiStatus(state), 'pending');
  });
});

test('remote update recommendation separates persisted dismissal from reconciliation', async (context) => {
  const papers = [cloudPaper('doc-a', 'head-set-a')];
  const states = new Map([['doc-a', { status: 'remote-update-available' as const }]]);

  await context.test(
    'duplicate cloud publications for one document count as one paper',
    () => {
      const duplicatePublications = [
        cloudPaper('doc-a', 'generation-a'),
        cloudPaper('doc-a', 'generation-b'),
      ];
      const reminder = nextRemoteUpdateReminder(
        undefined,
        duplicatePublications,
        states,
      );
      assert.deepEqual(reminder?.paperIds, ['doc-a']);
      assert.equal(
        paperRows(viewState({ papers: duplicatePublications }), 'download').length,
        1,
      );
    },
  );

  await context.test('one cloud document still counts as one paper', () => {
    assert.equal(paperRows(viewState({ papers }), 'download').length, 1);
    assert.equal(
      nextRemoteUpdateReminder(undefined, papers, states)?.paperIds.length,
      1,
    );
  });

  await context.test(
    'prompt count is distinct and title previews are capped at two',
    () => {
      const promptPapers = [
        cloudPaper('doc-a', 'generation-a'),
        cloudPaper('doc-a', 'generation-b'),
        cloudPaper('doc-b', 'generation-c'),
        cloudPaper('doc-c', 'generation-d'),
      ];
      const promptStates = new Map([
        ['doc-a', { status: 'remote-update-available' as const }],
        ['doc-b', { status: 'remote-update-available' as const }],
        ['doc-c', { status: 'remote-update-available' as const }],
      ]);
      const reminder = nextRemoteUpdateReminder(undefined, promptPapers, promptStates);
      assert.deepEqual(reminder?.paperIds, ['doc-a', 'doc-b', 'doc-c']);

      const ui = source('../src/sync/PaperSyncControl.tsx');
      const start = ui.indexOf('function RemoteUpdateRecommendation');
      const end = ui.indexOf('function StatusMessage', start);
      assert.ok(start >= 0 && end > start);
      const recommendation = ui.slice(start, end);
      assert.match(recommendation, /reminder\.paperIds\.length/u);
      assert.match(recommendation, /affected\.slice\(0,\s*2\)/u);
      assert.doesNotMatch(recommendation, /state\.papers\.length/u);
      assert.match(recommendation, />\s*Dismiss for now\s*</u);
      assert.match(recommendation, /dismissRemoteUpdates\(\)/u);
      assert.match(
        ui,
        /shouldShowRemoteUpdateRecommendation\(\s*state,\s*isReaderActive,\s*false,?\s*\)/u,
      );
    },
  );

  await context.test(
    'verified migration head becomes the persisted baseline and does not prompt again',
    () => {
      const rebuilt = paperState('doc-a');
      rebuilt.status = 'remote-update-available';
      rebuilt.incorporatedHeadIds = ['old-generation'];
      rebuilt.remoteHeadIds = ['old-generation'];
      rebuilt.baselineHashes = { 'note:doc-a': 'baseline-hash' };

      incorporateVerifiedMigrationHead(rebuilt, 'verified-generation');

      assert.deepEqual(rebuilt.incorporatedHeadIds, ['verified-generation']);
      assert.deepEqual(rebuilt.remoteHeadIds, ['verified-generation']);
      assert.deepEqual(rebuilt.baselineHashes, { 'note:doc-a': 'baseline-hash' });
      assert.equal(rebuilt.availability, 'local-and-cloud');
      assert.equal(rebuilt.status, 'synced');
      const status = derivePaperStatus(rebuilt, ['verified-generation']);
      assert.equal(status, 'synced');
      assert.equal(
        nextRemoteUpdateReminder(
          undefined,
          [cloudPaper('doc-a', 'verified-generation')],
          new Map([['doc-a', { status }]]),
        ),
        undefined,
      );
    },
  );

  await context.test(
    'mismatched verified generation fails before migration baseline incorporation',
    () => {
      const repository = source('../src/sync/paperDriveRepository.ts');
      assert.match(
        repository,
        /resolved\.heads\[0\]\.manifest\.generation\.id !==\s*proof\.publishedGenerationIds\[documentId\][\s\S]{0,120}throw new PaperRemoteChangedError\(documentId\)/u,
      );

      const coordinator = source('../src/sync/paperCoordinator.ts');
      const verification = coordinator.indexOf(
        'await activation.verifyPublishedPapers(signal)',
      );
      const incorporation = coordinator.indexOf(
        'await this.markMigrationPublicationsIncorporated(',
      );
      assert.ok(verification >= 0 && incorporation > verification);
      assert.match(
        coordinator.slice(incorporation, incorporation + 220),
        /record,\s*this\.requireWorkspaceLease\(signal\)/u,
      );
      assert.match(
        coordinator,
        /const generationId = record\.publishedGenerationIds\[documentId\][\s\S]{0,360}incorporateVerifiedMigrationHead\(state, generationId\)/u,
      );
    },
  );

  await context.test(
    'existing personal device identifies affected unincorporated papers',
    () => {
      assert.deepEqual(nextRemoteUpdateReminder(undefined, papers, states)?.paperIds, [
        'doc-a',
      ]);
    },
  );

  await context.test('Dismiss for now hides the current reminder in one action', () => {
    const reminder = nextRemoteUpdateReminder(undefined, papers, states)!;
    assert.equal(advanceRemoteUpdateDismissal(reminder).dismissStage, 2);
  });

  await context.test(
    'the exact persisted head set stays dismissed after reload',
    () => {
      const dismissedStates = new Map([
        [
          'doc-a',
          {
            status: 'remote-update-available' as const,
            dismissedRemoteHeadIds: ['head-set-a'],
          },
        ],
      ]);
      const reloaded = nextRemoteUpdateReminder(undefined, papers, dismissedStates);
      assert.equal(reloaded?.dismissStage, 2);
      assert.equal(
        shouldShowRemoteUpdateRecommendation(
          viewState({ reminder: reloaded }),
          true,
          false,
        ),
        false,
      );
    },
  );

  await context.test(
    'Dismiss for now persists locally without a Drive operation',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      const start = coordinator.indexOf('async dismissRemoteUpdates(');
      const end = coordinator.indexOf('upgradePaperSyncProtocolToV3()', start);
      const method = coordinator.slice(start, end);
      assert.ok(start >= 0 && end > start);
      assert.match(
        method,
        /state\.dismissedRemoteHeadIds = \[\.\.\.paper\.headIds\]\.sort\(\)/u,
      );
      assert.match(method, /await savePaperSyncStates/u);
      assert.match(method, /this\.updateReminder\(this\.view\.papers\)/u);
      assert.doesNotMatch(method, /beginOperation|ensureRepository|this\.drive/u);
    },
  );

  await context.test(
    'shrinking the affected paper set preserves dismissal for unchanged remote heads',
    () => {
      const sessionSeenStateIds = new Set<string>();
      const twoPapers = [
        cloudPaper('doc-a', 'head-set-a'),
        cloudPaper('doc-b', 'head-set-b'),
      ];
      const bothRemote = new Map([
        ['doc-a', { status: 'remote-update-available' as const }],
        ['doc-b', { status: 'remote-update-available' as const }],
      ]);
      const initial = nextRemoteUpdateReminder(
        undefined,
        twoPapers,
        bothRemote,
        sessionSeenStateIds,
      )!;
      const dismissed = advanceRemoteUpdateDismissal(initial);
      const onlyBRemote = new Map([
        ['doc-a', { status: 'synced' as const }],
        ['doc-b', { status: 'remote-update-available' as const }],
      ]);

      const shrunk = nextRemoteUpdateReminder(
        dismissed,
        twoPapers,
        onlyBRemote,
        sessionSeenStateIds,
      )!;

      assert.equal(shrunk.episodeId, dismissed.episodeId);
      assert.equal(shrunk.dismissStage, 2);
      assert.deepEqual(shrunk.paperIds, ['doc-b']);
      assert.strictEqual(
        nextRemoteUpdateReminder(shrunk, twoPapers, onlyBRemote, sessionSeenStateIds),
        shrunk,
      );
    },
  );

  await context.test(
    'session knowledge suppresses unchanged heads after a temporary empty discovery',
    () => {
      const sessionSeenStateIds = new Set<string>();
      const initial = nextRemoteUpdateReminder(
        undefined,
        papers,
        states,
        sessionSeenStateIds,
      );
      assert.ok(initial);
      assert.equal(
        nextRemoteUpdateReminder(
          initial,
          papers,
          new Map([['doc-a', { status: 'synced' as const }]]),
          sessionSeenStateIds,
        ),
        undefined,
      );
      assert.equal(
        nextRemoteUpdateReminder(undefined, papers, states, sessionSeenStateIds),
        undefined,
      );

      const newer = nextRemoteUpdateReminder(
        undefined,
        [cloudPaper('doc-a', 'head-set-new')],
        states,
        sessionSeenStateIds,
      );
      assert.equal(newer?.dismissStage, 0);
      assert.deepEqual(newer?.paperIds, ['doc-a']);
    },
  );

  await context.test('Home queues but does not present the centered prompt', () => {
    const state = viewState({
      reminder: nextRemoteUpdateReminder(undefined, papers, states),
    });
    assert.equal(shouldShowRemoteUpdateRecommendation(state, false, false), false);
    assert.equal(shouldShowRemoteUpdateRecommendation(state, true, false), true);
    assert.equal(shouldShowRemoteUpdateRecommendation(state, true, true), false);

    const dismissed = {
      ...state,
      reminder: advanceRemoteUpdateDismissal(state.reminder!),
    };
    assert.equal(shouldShowRemoteUpdateRecommendation(dismissed, true, false), false);
  });

  await context.test(
    'next launch reminds again when no session episode is retained',
    () => {
      assert.equal(
        nextRemoteUpdateReminder(undefined, papers, states)?.dismissStage,
        0,
      );
    },
  );

  await context.test(
    'new remote head set always creates a new reminder episode',
    () => {
      const old = advanceRemoteUpdateDismissal(
        nextRemoteUpdateReminder(undefined, papers, states)!,
      );
      const newer = nextRemoteUpdateReminder(
        old,
        [cloudPaper('doc-a', 'head-set-b')],
        new Map([
          [
            'doc-a',
            {
              status: 'remote-update-available' as const,
              dismissedRemoteHeadIds: ['head-set-a'],
            },
          ],
        ]),
      )!;
      assert.notEqual(newer.episodeId, old.episodeId);
      assert.equal(newer.dismissStage, 0);
    },
  );

  await context.test(
    'writer and time remain display metadata rather than ordering inputs',
    () => {
      const first = cloudPaper('doc-a', 'same-head');
      const second = {
        ...first,
        writerLabel: 'Other device',
        publishedAt: Number.MAX_SAFE_INTEGER,
      };
      assert.equal(
        nextRemoteUpdateReminder(undefined, [first], states)?.episodeId,
        nextRemoteUpdateReminder(undefined, [second], states)?.episodeId,
      );
    },
  );
});

test('paper-selective sync UI stays compact, honest, and accessible', async (context) => {
  await context.test(
    'Reader status pill is status-only, textual, accessible, and opens Drive management',
    () => {
      let opened = 0;
      const state = viewState({ lastSuccessfulAt: 10 });
      const markup = renderToStaticMarkup(
        createElement(ReaderSyncStatusPill, {
          state,
          onOpenDrive: () => {
            opened += 1;
          },
        }),
      );
      assert.match(
        markup,
        /aria-label="Google Drive sync: Synced\. Open Google Drive"/u,
      );
      assert.match(markup, /class="sync-status-dot"/u);
      assert.match(markup, /aria-live="polite">Drive · Synced</u);
      assert.doesNotMatch(markup, /aria-haspopup|aria-expanded/u);

      const element = ReaderSyncStatusPill({
        state,
        onOpenDrive: () => {
          opened += 1;
        },
      });
      element.props.onClick();
      assert.equal(opened, 1);
    },
  );

  await context.test(
    'Reader status display modes keep full semantics while hiding only presentation',
    () => {
      const state = viewState({ lastSuccessfulAt: 10 });
      const compactMarkup = renderToStaticMarkup(
        createElement(ReaderSyncStatusPill, {
          display: 'compact',
          state,
          onOpenDrive: () => undefined,
        }),
      );
      assert.match(compactMarkup, /is-compact/u);
      assert.match(
        compactMarkup,
        /aria-label="Google Drive sync: Synced\. Open Google Drive"/u,
      );
      assert.match(compactMarkup, /class="sync-status-dot"/u);
      assert.match(compactMarkup, /class="visually-hidden"[^>]*>Drive · Synced</u);

      const hiddenMarkup = renderToStaticMarkup(
        createElement(ReaderSyncStatusPill, {
          display: 'hidden',
          state,
          onOpenDrive: () => undefined,
        }),
      );
      assert.equal(hiddenMarkup, '');
    },
  );

  await context.test('Reader status labels cover every operational state', () => {
    assert.equal(
      readerPaperSyncLabel(viewState({ connection: 'disconnected' })),
      'Not connected',
    );
    assert.equal(readerPaperSyncLabel(viewState({ connection: 'syncing' })), 'Syncing');
    assert.equal(
      readerPaperSyncLabel(
        viewState({
          dirtyPaperIds: ['doc-a'],
          paperStates: [paperState('doc-a', ['notes'])],
        }),
      ),
      'Changes waiting',
    );
    assert.equal(readerPaperSyncLabel(viewState({ connection: 'offline' })), 'Offline');
    assert.equal(
      readerPaperSyncLabel(viewState({ connection: 'attention' })),
      'Needs attention',
    );
  });

  await context.test(
    'Home section changes and unchanged reconnect scans cannot recreate an episode',
    () => {
      const sessionSeenStateIds = new Set<string>();
      const papers = [cloudPaper('doc-a', 'head-set-a')];
      const states = new Map([
        ['doc-a', { status: 'remote-update-available' as const }],
      ]);
      const reminder = nextRemoteUpdateReminder(
        undefined,
        papers,
        states,
        sessionSeenStateIds,
      )!;
      for (const section of ['home', 'library', 'collections', 'tags', 'drive']) {
        assert.equal(
          shouldShowRemoteUpdateRecommendation(
            viewState({ reminder }),
            section === 'reader',
            section === 'drive',
          ),
          false,
        );
      }
      assert.strictEqual(
        nextRemoteUpdateReminder(reminder, papers, states, sessionSeenStateIds),
        reminder,
      );
      const coordinator = source('../src/sync/paperCoordinator.ts');
      assert.doesNotMatch(
        coordinator,
        /addEventListener\(['"](?:focus|visibilitychange)/u,
      );
    },
  );

  await context.test('Reader pill cannot claim Synced during active progress', () => {
    assert.equal(
      readerPaperSyncLabel(
        viewState({
          connection: 'connected',
          lastSuccessfulAt: 10,
          progress: { phase: 'uploading', completed: 1, total: 2 },
        }),
      ),
      'Syncing',
    );
  });

  await context.test(
    'normal synced drawer is compact and keeps diagnostics collapsed',
    () => {
      const html = renderDrawer(viewState({ lastSuccessfulAt: 10 }));
      assert.match(html, /Google Drive/u);
      assert.match(html, /Browse Drive papers/u);
      assert.match(html, /Upload changes/u);
      assert.match(html, /<summary>Details<\/summary>/u);
      assert.doesNotMatch(html, /generation hash|fingerprint|deviceId/u);
    },
  );

  await context.test('status is textual and never color-only', () => {
    const html = renderDrawer(viewState({ lastSuccessfulAt: 10 }));
    assert.match(html, /role="status">Synced</u);
  });

  await context.test(
    'development Retry diagnostics expose redacted repository and settlement state',
    () => {
      const diagnostic: PaperRetryDiagnosticSnapshot = {
        operation: 'paper-retry',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            admission: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 1,
              incorporatedHeadCount: 1,
              presenceHeadCount: 1,
              retryIntent: 'upload',
              activeBlockingIssue: {
                code: 'drive-integrity-mismatch',
                operation: 'paper-presence-invalid',
                retrySafe: false,
                blocksOrdinarySync: true,
              },
            },
            repository: {
              result: 'needs-attention',
              status: 'needs-attention',
              presenceState: 'present',
              packageHeadCount: 1,
              presenceHeadCount: 1,
              issueCode: 'paper-source-pdf-conflict',
              phase: 'source-identity-verification',
              causeCode: 'source-sha-mismatch',
            },
            settlement: {
              blockDisposition: 'retained',
              selectedAction: 'revalidate',
              finalStatus: 'needs-attention',
              activeBlockingIssue: {
                code: 'drive-integrity-mismatch',
                operation: 'paper-presence-invalid',
                retrySafe: false,
                blocksOrdinarySync: true,
              },
            },
          },
        ],
      };
      const html = renderDrawer(viewState(), false, diagnostic);
      assert.match(html, /Last Retry diagnostic/u);
      assert.match(html, /paper-retry/u);
      assert.match(html, /Paper 1/u);
      assert.match(html, /paper-source-pdf-conflict/u);
      assert.match(html, /source-identity-verification/u);
      assert.match(html, /source-sha-mismatch/u);
      assert.match(html, /Failure operation<\/dt><dd>paper-presence-invalid/u);
      assert.match(html, /Failure phase<\/dt><dd>paper-presence-resolution/u);
      assert.match(html, /Failure cause<\/dt><dd>presence-control-resolution-failed/u);
      assert.match(html, /Block result<\/dt><dd>retained/u);
      assert.match(html, /Selected action<\/dt><dd>revalidate/u);
      assert.doesNotMatch(
        html,
        /paper-a|folder-paper-a|device-a|private-paper\.pdf|Bearer|token|local path/iu,
      );
      assert.match(
        source('../src/sync/PaperSyncControl.tsx'),
        /const retryDiagnostic = import\.meta\.env\.DEV/u,
      );
    },
  );

  await context.test(
    'development read-only sync status action shows current and authoritative blockers without identities',
    () => {
      const localPaper = paperState('private-paper', ['notes']);
      localPaper.status = 'needs-attention';
      localPaper.cloudPresence = 'present';
      localPaper.remoteHeadIds = ['private-head'];
      localPaper.presenceHeadIds = ['private-presence-head'];
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'complete',
        targetCount: 1,
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 1,
              presenceHeadCount: 1,
              blockingIssue: {
                code: 'drive-integrity-mismatch',
                operation: 'paper-presence-invalid',
                retrySafe: false,
                blocksOrdinarySync: true,
              },
            },
            authoritative: {
              result: 'needs-attention',
              status: 'needs-attention',
              presenceState: 'present',
              packageHeadCount: 1,
              presenceHeadCount: 1,
              issue: {
                code: 'drive-integrity-mismatch',
                operation: 'paper-source-pdf-conflict',
                phase: 'source-identity-verification',
                causeCode: 'source-sha-mismatch',
                retrySafe: false,
                blocksOrdinarySync: true,
              },
            },
            upload: {
              permitted: false,
              reason: 'current-blocking-issue',
            },
          },
        ],
      };
      const html = renderDrawer(
        viewState({
          connection: 'attention',
          paperStates: [localPaper],
          dirtyPaperIds: ['private-paper'],
        }),
        false,
        undefined,
        diagnostic,
      );

      assert.match(html, /Check sync status/u);
      assert.match(html, /paper-sync-status-check/u);
      assert.match(html, /Current issue<\/dt><dd>drive-integrity-mismatch/u);
      assert.match(html, /Current operation<\/dt><dd>paper-presence-invalid/u);
      assert.match(html, /Authoritative issue<\/dt><dd>drive-integrity-mismatch/u);
      assert.match(html, /Authoritative operation<\/dt><dd>paper-source-pdf-conflict/u);
      assert.match(html, /Authoritative phase<\/dt><dd>source-identity-verification/u);
      assert.match(html, /Authoritative cause<\/dt><dd>source-sha-mismatch/u);
      assert.match(html, /Upload permitted<\/dt><dd>No/u);
      assert.match(html, /The current blocking issue pauses upload/u);
      assert.doesNotMatch(
        html,
        /private-paper|private-head|private-presence-head|device-a|Bearer|token/iu,
      );
      const control = source('../src/sync/PaperSyncControl.tsx');
      assert.match(control, /import\.meta\.env\.DEV[\s\S]*Check sync status/u);
      assert.match(control, /onClick=\{checkSyncStatus\}/u);

      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const inspectionStart = coordinatorSource.indexOf(
        'async checkSyncStatusReadOnly(',
      );
      const inspectionEnd = coordinatorSource.indexOf(
        '\n  destroy(): void',
        inspectionStart,
      );
      const inspection = coordinatorSource.slice(inspectionStart, inspectionEnd);
      assert.ok(inspectionStart >= 0 && inspectionEnd > inspectionStart);
      assert.match(
        inspection,
        /canRunPaperSyncStatusReadOnlyInspection\([\s\S]*import\.meta\.env\.DEV,[\s\S]*requestedForgetScope !== undefined/u,
      );
      assert.match(
        coordinatorSource,
        /return development \|\| exactForgetScopeAvailable/u,
      );
      assert.match(inspection, /repository\.discoverPapers\(/u);
      assert.doesNotMatch(
        inspection,
        /retryNow\(|uploadSelected\(|applyDiscovery\(|savePaper|saveCloud|createFolder\(|uploadJson\(|updateMetadata\(|trashFile\(/u,
      );
    },
  );

  await context.test(
    'targeted purge is limited to the exact presence-resolution blocker and previews one paper',
    () => {
      const affected = viewState({
        connection: 'attention',
        issue: {
          code: 'drive-integrity-mismatch',
          message: 'Drive paper presence data needs verification.',
          severity: 'error',
          state: 'attention',
          actions: ['details'],
          retrySafe: false,
          blocksOrdinarySync: true,
          backupRecommended: false,
          diagnostic: {
            source: 'google-drive',
            operation: 'paper-presence-invalid',
            phase: 'paper-presence-resolution',
            causeCode: 'presence-control-resolution-failed',
            documentId: 'document-target',
            paperName: 'Synthetic purge paper',
          },
        },
      });
      assert.equal(targetedPaperPurgeCandidate(affected), 'document-target');
      assert.equal(
        targetedPaperPurgeCandidate(
          viewState({
            ...affected,
            issue: {
              ...affected.issue!,
              diagnostic: {
                ...affected.issue!.diagnostic,
                causeCode: 'source-sha-mismatch',
              },
            },
          }),
        ),
        undefined,
      );

      const catalogCandidate = cloudPaper('catalog-target', 'head-a');
      catalogCandidate.status = 'needs-attention';
      catalogCandidate.issue = {
        code: 'paper-presence-invalid',
        message: 'Drive paper presence data needs verification.',
        phase: 'paper-presence-resolution',
        causeCode: 'presence-control-resolution-failed',
      };
      assert.equal(
        targetedPaperPurgeCandidate(
          viewState({ connection: 'attention', papers: [catalogCandidate] }),
        ),
        'catalog-target',
      );
      assert.equal(
        targetedPaperPurgeCandidate(
          viewState({
            connection: 'attention',
            papers: [
              catalogCandidate,
              { ...catalogCandidate, documentId: 'ambiguous-second-target' },
            ],
          }),
        ),
        undefined,
      );

      const interrupted = paperState('confirmed-target');
      interrupted.targetedPurge = {
        version: 1,
        operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        phase: 'cloud-cleanup-pending',
        confirmedAt: 789,
        accountId: 'synthetic-account',
        rootFolderId: 'synthetic-root',
        paperFolderId: 'synthetic-folder',
      };
      assert.equal(
        targetedPaperPurgeCandidate(
          viewState({ connection: 'attention', paperStates: [interrupted] }),
        ),
        'confirmed-target',
      );

      const displayCoordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(displayCoordinator, 'view', affected);
      const drawer = renderToStaticMarkup(
        createElement(PaperSyncDrawer, {
          state: affected,
          coordinator: displayCoordinator,
          embedded: true,
          soundEnabled: true,
          onDownloadBackup() {},
          onOpenSelector() {},
          onSoundEnabledChange() {},
        }),
      );
      assert.match(drawer, /Remove inaccessible paper/u);
      assert.match(drawer, />Preview targeted purge</u);
      assert.match(drawer, /first proves the exact paper boundary/u);
      assert.doesNotMatch(
        renderDrawer(viewState({ connection: 'attention' }), true),
        /Preview targeted purge/u,
      );
    },
  );

  await context.test(
    'targeted purge visibility recovers one exact document key from the authoritative blocker map',
    async () => {
      const exactPresenceFailure = () =>
        new PaperRepositoryError(
          'paper-presence-invalid',
          'Drive paper presence data needs verification.',
          {
            diagnosticPhase: 'paper-presence-resolution',
            diagnosticCauseCode: 'presence-control-resolution-failed',
          },
        );
      const issueWithoutDocumentId =
        classifyPaperCoordinatorError(exactPresenceFailure());
      assert.equal(issueWithoutDocumentId.diagnostic.documentId, undefined);

      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([['exact-document-key', { issue: issueWithoutDocumentId }]]),
      );
      assert.equal(
        coordinator.getTargetedPaperPurgeCandidateDocumentId(),
        'exact-document-key',
      );

      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([
          ['exact-document-key', { issue: issueWithoutDocumentId }],
          ['second-document-key', { issue: issueWithoutDocumentId }],
        ]),
      );
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      const genericAttention = classifyPaperCoordinatorError(
        new PaperRepositoryError(
          'paper-integrity-failed',
          'Drive paper data needs verification.',
        ),
      );
      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([['unrelated-document-key', { issue: genericAttention }]]),
      );
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      const affected = paperState('known-document-key');
      affected.status = 'uploading';
      const markedCoordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(
        markedCoordinator,
        'paperStates',
        new Map([[affected.documentId, affected]]),
      );
      Reflect.set(
        markedCoordinator,
        'view',
        viewState({
          connection: 'connected',
          papers: [cloudPaper(affected.documentId, 'head-a')],
          paperStates: [affected],
          dirtyPaperIds: [affected.documentId],
        }),
      );
      const markedIssue = await markPaperFailureWithWorkspaceLease(
        markedCoordinator,
        affected.documentId,
        exactPresenceFailure(),
      );
      assert.deepEqual(markedIssue.diagnostic, {
        source: 'google-drive',
        operation: 'paper-presence-invalid',
        phase: 'paper-presence-resolution',
        causeCode: 'presence-control-resolution-failed',
        documentId: affected.documentId,
      });
      assert.equal(
        markedCoordinator.getTargetedPaperPurgeCandidateDocumentId(),
        affected.documentId,
      );
    },
  );

  await context.test(
    'failed scoped presence inspection exposes one session-only targeted purge preview candidate',
    async () => {
      const documentId = 'failed-inspection-target';
      const state = paperState(documentId);
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      state.dirtyReasons = ['notes'];
      state.remoteHeadIds = ['head-a'];
      state.presenceHeadIds = ['presence-a'];
      const paper = cloudPaper(documentId, 'head-a');
      const view = viewState({
        connection: 'attention',
        papers: [paper],
        paperStates: [state],
        dirtyPaperIds: [documentId],
      });
      const failedDiagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 1,
              presenceHeadCount: 1,
            },
            upload: {
              permitted: false,
              reason: 'inspection-failed-closed',
            },
          },
        ],
      };
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'paperStates', new Map([[documentId, state]]));
      Reflect.set(coordinator, 'view', view);
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', failedDiagnostic);
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnosticContext', {
        inspectionSequence: 9,
        documentIds: [documentId],
      });
      Reflect.set(coordinator, 'paperSyncStatusInspectionSequence', 9);

      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), documentId);
      const drawer = renderToStaticMarkup(
        createElement(PaperSyncDrawer, {
          state: view,
          coordinator,
          embedded: true,
          soundEnabled: true,
          onDownloadBackup() {},
          onOpenSelector() {},
          onSoundEnabledChange() {},
        }),
      );
      assert.match(drawer, /Remove inaccessible paper/u);
      assert.match(drawer, />Preview targeted purge</u);
      assert.match(drawer, /read-only inspection failed closed/iu);
      assert.match(drawer, /Repository result<\/dt><dd>Not recorded/u);
      assert.match(drawer, /Authoritative issue<\/dt><dd>Not recorded/u);
      assert.match(drawer, /Current presence<\/dt><dd>present/u);
      assert.match(drawer, /Upload permitted<\/dt><dd>No/u);
      assert.match(drawer, /Targeted purge visibility predicate matrix/u);
      assert.match(
        drawer,
        /<details aria-label="Targeted purge predicate matrix" class="sync-details"><summary>Targeted purge visibility predicate matrix<\/summary>/u,
      );
      assert.match(drawer, /Active UI module revision<\/dt><dd>3/u);
      assert.match(drawer, /Active coordinator module revision<\/dt><dd>3/u);
      assert.match(drawer, /Mounted coordinator revision<\/dt><dd>3/u);
      assert.match(drawer, /Expected visibility revision<\/dt><dd>2/u);
      assert.match(drawer, /Implementation revision<\/dt><dd>2/u);
      assert.match(drawer, /Runtime versions current<\/dt><dd>True/u);
      assert.match(drawer, /Implementation current<\/dt><dd>True/u);
      assert.match(drawer, /Diagnostic context present<\/dt><dd>True/u);
      assert.match(drawer, /Hidden reason<\/dt><dd>not-hidden/u);
      assert.match(drawer, /Candidate resolved<\/dt><dd>True/u);
      assert.match(drawer, /Component mounted<\/dt><dd>True/u);
      assert.match(drawer, /Failure tuple matches<\/dt><dd>True/u);
      assert.match(drawer, /Identity correlation exists<\/dt><dd>True/u);
      assert.match(drawer, /Recovery card eligible<\/dt><dd>True/u);
      assert.match(drawer, /Preview eligible<\/dt><dd>True/u);

      const blockedInspection = {
        eligible: false as const,
        documentId,
        validPresenceCount: 0,
        corruptPresenceCount: 1,
        preservedPresenceCount: 0,
        presenceHeadCount: 0,
        presenceState: 'present' as const,
        paperFolderCount: 0,
        paperFileCount: 0,
        blocker: {
          code: 'presence-validation-failed' as const,
          message: 'The exact owned paper boundary could not be proved.',
        },
        ancestryDiagnostic: {
          schemaVersion: 1 as const,
          mode: 'read-only' as const,
          validationStage: 'ancestry' as const,
          failureCode: 'presence-missing-parent' as const,
          ordering: {
            timestamps: 'ignored' as const,
            driveListing: 'ignored' as const,
          },
          topology: {
            status: 'invalid' as const,
            failureCode: 'presence-missing-parent' as const,
            recordCount: 2,
            uniqueGenerationCount: 2,
            rootCount: 1,
            structuralHeadCount: 2,
            weakComponentCount: 2,
            missingParentReferenceCount: 1,
            records: [
              {
                ordinal: 1,
                state: 'present' as const,
                intent: 'migration' as const,
                parentOrdinals: [],
                missingParentCount: 0,
                childCount: 0,
                root: true,
                structuralHead: true,
              },
              {
                ordinal: 2,
                state: 'removed' as const,
                intent: 'remove' as const,
                parentOrdinals: [],
                missingParentCount: 1,
                childCount: 0,
                root: false,
                structuralHead: true,
              },
            ],
          },
        },
      };
      Reflect.set(coordinator, 'initialize', async () => undefined);
      Reflect.set(coordinator, 'profile', {
        deviceMode: 'personal',
        rootFolderId: 'synthetic-root',
      });
      Reflect.set(coordinator, 'beginOperation', async () => {
        const signal = new AbortController().signal;
        Reflect.set(coordinator, 'activeDriveOperationIdentityFence', {
          signal,
          accountId: 'synthetic-account',
          operationType: 'scan',
        });
        return signal;
      });
      Reflect.set(coordinator, 'endOperation', () => undefined);
      Reflect.set(coordinator, 'ensureRepository', async () => ({
        rootFolderId: 'synthetic-root',
        inspectTargetedPaperPurge: async () => blockedInspection,
      }));
      Reflect.set(coordinator, 'local', {
        inspectPaperPurgeRecords: async () => ({
          documentRecord: false,
          sourceRecord: false,
          syncStateRecord: true,
          cloudCatalogRecord: true,
          printDraftRecord: false,
          renderedPrintPdfRecord: false,
          aiConversationCount: 0,
        }),
      });

      const preview = await coordinator.previewTargetedPaperPurge(documentId);
      assert.equal(preview.eligible, false);
      assert.equal(preview.previewToken, undefined);
      assert.equal(preview.blocker?.code, 'presence-validation-failed');
      assert.equal(
        preview.cloud.ancestryDiagnostic?.failureCode,
        'presence-missing-parent',
      );
      assert.equal(
        (Reflect.get(coordinator, 'targetedPaperPurgePreviews') as Map<string, unknown>)
          .size,
        0,
      );
      const blockedDialog = renderToStaticMarkup(
        createElement(TargetedPaperPurgeDialog, {
          preview,
          onCancel() {},
          onConfirm() {
            assert.fail('A blocked preview must not expose purge execution.');
          },
        }),
      );
      assert.match(blockedDialog, /Purge blocked/u);
      assert.match(blockedDialog, /exact owned paper boundary could not be proved/u);
      assert.match(blockedDialog, /Presence ancestry diagnostic/u);
      assert.match(blockedDialog, /Strictly read-only and redacted/u);
      assert.match(blockedDialog, /remain 0 while validation is blocked/u);
      assert.match(blockedDialog, /presence-missing-parent/u);
      assert.match(blockedDialog, /Structural heads<\/dt><dd>2/u);
      assert.match(blockedDialog, /Missing parent references<\/dt><dd>1/u);
      assert.match(blockedDialog, /<strong>R1<\/strong>/u);
      assert.match(blockedDialog, /<strong>R2<\/strong>/u);
      assert.doesNotMatch(blockedDialog, /[a-f0-9]{64}/iu);
      assert.doesNotMatch(blockedDialog, />Purge this paper<\/button>/u);
    },
  );

  await context.test(
    'an exact failed inspection without session identity renders a redacted Purge blocked card',
    () => {
      const documentId = 'identity-must-not-render';
      const state = paperState(documentId);
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      state.dirtyReasons = ['notes'];
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'paperStates', new Map([[documentId, state]]));
      Reflect.set(
        coordinator,
        'view',
        viewState({
          connection: 'attention',
          paperStates: [state],
          dirtyPaperIds: [documentId],
        }),
      );
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', diagnostic);

      const visibility = coordinator.getTargetedPaperPurgeVisibilityDiagnostic();
      assert.equal(visibility.visible, false);
      assert.equal(visibility.showRecoveryCard, true);
      assert.equal(visibility.hiddenReason, 'diagnostic-context-missing');
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      const drawer = renderToStaticMarkup(
        createElement(PaperSyncDrawer, {
          state: coordinator.getSnapshot(),
          coordinator,
          embedded: true,
          soundEnabled: true,
          onDownloadBackup() {},
          onOpenSelector() {},
          onSoundEnabledChange() {},
        }),
      );
      assert.match(drawer, /Remove inaccessible paper/u);
      assert.match(drawer, /Purge blocked/u);
      assert.match(drawer, /diagnostic-context-missing/u);
      assert.match(drawer, /Diagnostic context present<\/dt><dd>False/u);
      assert.match(drawer, /Preview unavailable — exact paper not correlated/u);
      assert.match(drawer, /Failure tuple matches<\/dt><dd>True/u);
      assert.match(drawer, /Identity correlation exists<\/dt><dd>False/u);
      assert.match(drawer, /Recovery card eligible<\/dt><dd>True/u);
      assert.match(drawer, /Preview eligible<\/dt><dd>False/u);
      assert.doesNotMatch(drawer, /Preview targeted purge/u);
      assert.doesNotMatch(drawer, new RegExp(documentId, 'u'));
    },
  );

  await context.test(
    'a retained pre-diagnostic coordinator exposes the exact stale-runtime predicate',
    () => {
      const state = paperState('stale-runtime-paper');
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const html = renderDrawer(
        viewState({
          connection: 'attention',
          paperStates: [state],
          dirtyPaperIds: [state.documentId],
        }),
        true,
        undefined,
        diagnostic,
      );

      assert.match(html, /Remove inaccessible paper/u);
      assert.match(html, /Purge blocked/u);
      assert.match(html, /runtime-coordinator-implementation-outdated/u);
      assert.match(html, /Active UI module revision<\/dt><dd>3/u);
      assert.match(html, /Active coordinator module revision<\/dt><dd>3/u);
      assert.match(html, /Mounted coordinator revision<\/dt><dd>0/u);
      assert.match(html, /Expected visibility revision<\/dt><dd>2/u);
      assert.match(html, /Implementation revision<\/dt><dd>0/u);
      assert.match(html, /Runtime versions current<\/dt><dd>False/u);
      assert.match(html, /Implementation current<\/dt><dd>False/u);
      assert.match(html, /Failure tuple matches<\/dt><dd>True/u);
      assert.match(html, /Identity correlation exists<\/dt><dd>False/u);
      assert.match(html, /Recovery card eligible<\/dt><dd>True/u);
      assert.match(html, /Preview eligible<\/dt><dd>False/u);
      assert.match(html, /Preview unavailable — exact paper not correlated/u);
      assert.doesNotMatch(html, /Preview targeted purge/u);
      assert.doesNotMatch(html, /stale-runtime-paper/u);
    },
  );

  await context.test(
    'a retained previous visibility implementation cannot hide the recognized failure tuple',
    () => {
      const state = paperState('retained-runtime-paper');
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const previousVisibility = {
        implementationRevision: 1,
        visible: false,
        showRecoveryCard: false,
        candidateSource: 'none',
        hiddenReason: 'no-exact-candidate',
        exactBlockingCandidateCount: 0,
        retryCandidateCount: 0,
        predicates: { candidateResolved: false },
      };
      const html = renderDrawer(
        viewState({
          connection: 'attention',
          paperStates: [state],
          dirtyPaperIds: [state.documentId],
        }),
        true,
        undefined,
        diagnostic,
        previousVisibility,
        1,
      );

      assert.match(html, /Remove inaccessible paper/u);
      assert.match(html, /Purge blocked/u);
      assert.match(html, /runtime-coordinator-implementation-outdated/u);
      assert.match(html, /Active UI module revision<\/dt><dd>3/u);
      assert.match(html, /Active coordinator module revision<\/dt><dd>3/u);
      assert.match(html, /Mounted coordinator revision<\/dt><dd>1/u);
      assert.match(html, /Expected visibility revision<\/dt><dd>2/u);
      assert.match(html, /Implementation revision<\/dt><dd>1/u);
      assert.match(html, /Runtime versions current<\/dt><dd>False/u);
      assert.match(html, /Failure tuple matches<\/dt><dd>True/u);
      assert.match(html, /Identity correlation exists<\/dt><dd>False/u);
      assert.match(html, /Recovery card eligible<\/dt><dd>True/u);
      assert.match(html, /Preview eligible<\/dt><dd>False/u);
      assert.match(html, /Preview unavailable — exact paper not correlated/u);
      assert.doesNotMatch(html, /Preview targeted purge/u);
      assert.doesNotMatch(html, /retained-runtime-paper/u);
    },
  );

  await context.test(
    'the redacted predicate matrix persists after the live paper guard clears',
    () => {
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const html = renderDrawer(
        viewState({
          connection: 'connected',
          paperStates: [],
          dirtyPaperIds: [],
        }),
        true,
        undefined,
        diagnostic,
      );

      assert.match(html, /Remove inaccessible paper/u);
      assert.match(html, /Read-only sync status/u);
      assert.match(html, /Sync status diagnostic result/u);
      assert.match(html, /Targeted purge visibility predicate matrix/u);
      assert.match(
        html,
        /<details aria-label="Targeted purge predicate matrix" class="sync-details"><summary>Targeted purge visibility predicate matrix<\/summary>/u,
      );
      assert.match(html, /Failure tuple matches<\/dt><dd>True/u);
      assert.match(html, /Recovery card eligible<\/dt><dd>True/u);
      assert.match(html, /Preview eligible<\/dt><dd>False/u);
      assert.match(html, /<button disabled="" type="button">Check sync status/u);
    },
  );

  await context.test(
    'a later nonmatching failed inspection keeps the matrix but removes card eligibility',
    () => {
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-manifest-invalid',
          phase: 'paper-manifest-validation',
          causeCode: 'manifest-integrity-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const html = renderDrawer(viewState(), true, undefined, diagnostic);

      assert.match(html, /Targeted purge visibility predicate matrix/u);
      assert.match(
        html,
        /<details aria-label="Targeted purge predicate matrix" class="sync-details"><summary>Targeted purge visibility predicate matrix<\/summary>/u,
      );
      assert.match(html, /Failure tuple matches<\/dt><dd>False/u);
      assert.match(html, /Recovery card eligible<\/dt><dd>False/u);
      assert.match(html, /Preview eligible<\/dt><dd>False/u);
      assert.doesNotMatch(html, /Remove inaccessible paper/u);
    },
  );

  await context.test(
    'failed diagnostic targeted purge evidence rejects generic, ambiguous, stale, and changed state',
    () => {
      const documentId = 'fail-closed-target';
      const state = paperState(documentId);
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      state.dirtyReasons = ['notes'];
      const diagnostic: PaperSyncStatusDiagnosticSnapshot = {
        operation: 'paper-sync-status-check',
        phase: 'failed',
        targetCount: 1,
        failure: {
          code: 'drive-integrity-mismatch',
          operation: 'paper-presence-invalid',
          phase: 'paper-presence-resolution',
          causeCode: 'presence-control-resolution-failed',
          retrySafe: false,
          blocksOrdinarySync: true,
        },
        targets: [
          {
            target: 'Paper 1',
            current: {
              status: 'needs-attention',
              cloudPresence: 'present',
              dirtyReasonCount: 1,
              packageHeadCount: 0,
              presenceHeadCount: 0,
            },
            upload: { permitted: false, reason: 'inspection-failed-closed' },
          },
        ],
      };
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'paperStates', new Map([[documentId, state]]));
      Reflect.set(
        coordinator,
        'view',
        viewState({
          connection: 'attention',
          paperStates: [state],
          dirtyPaperIds: [documentId],
        }),
      );
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', diagnostic);
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnosticContext', {
        inspectionSequence: 3,
        documentIds: [documentId],
      });
      Reflect.set(coordinator, 'paperSyncStatusInspectionSequence', 3);
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), documentId);

      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', {
        ...diagnostic,
        failure: {
          ...diagnostic.failure!,
          operation: 'paper-integrity-failed',
        },
      });
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', {
        ...diagnostic,
        targetCount: 2,
        targets: [
          diagnostic.targets[0]!,
          { ...diagnostic.targets[0]!, target: 'Paper 2' },
        ],
      });
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnosticContext', {
        inspectionSequence: 3,
        documentIds: [documentId, 'second-target'],
      });
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', {
        ...diagnostic,
        phase: 'stale',
      });
      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnosticContext', {
        inspectionSequence: 3,
        documentIds: [documentId],
      });
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);

      Reflect.set(coordinator, 'lastPaperSyncStatusDiagnostic', diagnostic);
      state.status = 'synced';
      assert.equal(coordinator.getTargetedPaperPurgeCandidateDocumentId(), undefined);
    },
  );

  await context.test(
    'targeted purge uses an explicit accessible preview and preserves unrelated records',
    () => {
      const preview: TargetedPaperPurgePreview = {
        eligible: true,
        previewToken: 'opaque-never-rendered-token',
        documentId: 'synthetic-document-id',
        displayName: 'Synthetic purge paper',
        local: {
          documentRecord: false,
          sourceRecord: false,
          syncStateRecord: true,
          cloudCatalogRecord: true,
          printDraftRecord: false,
          renderedPrintPdfRecord: false,
          aiConversationCount: 0,
        },
        cloud: {
          paperFolderCount: 1,
          paperFileCount: 8,
          validPresenceCount: 2,
          corruptPresenceCount: 1,
          presenceState: 'present',
          presenceHeadCount: 1,
          preservedPresenceCount: 2,
        },
        preserved: {
          collectionRecords: true,
          sharedRootAndControl: true,
          unrelatedPapers: true,
          removedPresenceTombstone: true,
        },
      };
      const dialog = renderToStaticMarkup(
        createElement(TargetedPaperPurgeDialog, {
          preview,
          onCancel() {},
          onConfirm() {},
        }),
      );

      assert.match(dialog, /^<dialog/u);
      assert.match(dialog, /aria-describedby="targeted-paper-purge-description"/u);
      assert.match(dialog, /aria-labelledby="targeted-paper-purge-title"/u);
      assert.match(dialog, />Targeted purge preview<\/h2>/u);
      assert.match(dialog, /Synthetic purge paper/u);
      assert.match(dialog, /synthetic-document-id/u);
      assert.match(dialog, /Document state<\/dt><dd>Not present/u);
      assert.match(dialog, /Sync state<\/dt><dd>Will remove/u);
      assert.match(dialog, /Owned paper folders to Trash<\/dt><dd>1/u);
      assert.match(dialog, /Invalid presence candidates to Trash<\/dt><dd>1/u);
      assert.match(dialog, /Every unrelated paper and its files/u);
      assert.match(dialog, /managed root and control records/iu);
      assert.match(dialog, /Google Drive Trash/u);
      assert.match(dialog, /type="checkbox"/u);
      assert.match(dialog, />Cancel<\/button>/u);
      assert.match(dialog, /class="is-destructive" disabled=""/u);
      assert.match(dialog, />Purge this paper<\/button>/u);
      assert.doesNotMatch(dialog, /opaque-never-rendered-token/u);

      const blocked = renderToStaticMarkup(
        createElement(TargetedPaperPurgeDialog, {
          preview: {
            ...preview,
            eligible: false,
            previewToken: undefined,
            blocker: {
              code: 'ambiguous-owned-boundary',
              message: 'The exact owned paper boundary could not be proved.',
            },
          },
          onCancel() {},
          onConfirm() {},
        }),
      );
      assert.match(blocked, /Purge blocked/u);
      assert.match(blocked, /exact owned paper boundary could not be proved/u);
      assert.match(blocked, />Close<\/button>/u);
      assert.doesNotMatch(blocked, />Purge this paper<\/button>/u);

      const control = source('../src/sync/PaperSyncControl.tsx');
      assert.match(
        control,
        /if \([\s\S]*?targetedPurgePreviewRef\.current[\s\S]*?targetedPurgeExecutionRef\.current[\s\S]*?\) \{[\s\S]*?return;/u,
      );
      assert.match(
        control,
        /setTargetedPurgeDialogOpen\(false\);[\s\S]*?phase: 'purging'[\s\S]*?executeTargetedPaperPurge\(preview\.previewToken\)/u,
      );
      assert.match(
        control,
        /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?onCancel\(\);/u,
      );
      assert.match(control, /cancelRef\.current\?\.focus/u);
      assert.match(control, /if \(event\.key !== 'Tab'\) return/u);

      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const executeStart = coordinatorSource.indexOf('executeTargetedPaperPurge(');
      const executeEnd = coordinatorSource.indexOf(
        '\n  removeFromGoogleDriveSelected(',
        executeStart,
      );
      const execute = coordinatorSource.slice(executeStart, executeEnd);
      assert.ok(executeStart >= 0 && executeEnd > executeStart);
      assert.ok(
        execute.indexOf("phase: 'cloud-cleanup-pending'") <
          execute.indexOf('repository.executeTargetedPaperPurge('),
      );
      assert.ok(
        execute.indexOf("phase: 'local-cleanup-pending'") <
          execute.indexOf('this.local.ensurePaperAbsent('),
      );
      assert.ok(
        execute.indexOf('this.local.ensurePaperAbsent(') <
          execute.indexOf('deletePaperSyncRecords('),
      );
      assert.match(execute, /this\.paperStates\.delete\(pending\.documentId\)/u);

      const css = source('../src/styles/index.css');
      assert.match(css, /\.sync-targeted-purge-dialog/u);
      assert.match(css, /\.sync-targeted-purge-acknowledgement/u);
      assert.match(
        css,
        /@media \(max-width: 700px\)[\s\S]*?\.theme-root \.sync-targeted-purge-records > div/u,
      );
    },
  );

  await context.test(
    'Forget inaccessible paper is explicit, local-only, reversible, and honestly labelled',
    () => {
      const dialog = renderToStaticMarkup(
        createElement(ForgetInaccessiblePaperDialog, {
          candidate: {
            documentId: 'synthetic-broken-paper',
            displayName: 'Broken paper.pdf',
          },
          busy: false,
          onCancel() {},
          onConfirm() {},
        }),
      );
      assert.match(dialog, /Forget inaccessible paper\?/u);
      assert.match(dialog, /No Google Drive object will be deleted or changed/u);
      assert.match(dialog, /not be reported as successfully synced/u);
      assert.match(dialog, /current Google account and 39Note folder/u);
      assert.match(dialog, /Forget and ignore this issue/u);
      assert.match(dialog, /type="checkbox"/u);

      const broken = paperState('synthetic-broken-paper', ['metadata']);
      broken.status = 'needs-attention';
      broken.cloudPresence = 'present';
      const state = viewState({
        lastSuccessfulAt: 123,
        papers: [
          {
            ...cloudPaper('synthetic-broken-paper', 'broken-head'),
            status: 'needs-attention',
          },
        ],
        paperStates: [broken],
        ignoredCloudIssues: [
          {
            documentId: broken.documentId,
            displayName: 'Broken paper.pdf',
            confirmedAt: 123,
          },
        ],
      });
      assert.equal(getBlockingPaperIssueCount(state), 0);
      assert.equal(getPaperSyncUiStatus(state), 'synced');
      assert.equal(paperSyncStatusLabel(state), 'Synced · 1 ignored cloud issue');
      assert.equal(
        paperSyncStatusLabel({ ...state, connection: 'offline' }),
        'Offline · 1 ignored cloud issue',
      );
      assert.deepEqual(paperRows(state, 'download'), []);
      assert.deepEqual(normalCloudPapers(state), []);
      assert.doesNotMatch(renderCloudLibrary(state), /SYNTHETIC-BROKEN-PAPER/u);

      const drawer = renderDrawer(state);
      assert.match(drawer, /Ignored cloud issue/u);
      assert.match(drawer, /Review this paper again/u);
      assert.match(drawer, /Drive objects and integrity evidence were not/u);
      assert.match(drawer, /not included in Browse Drive papers/u);
      assert.match(drawer, /<dt>Cloud papers<\/dt><dd>0<\/dd>/u);
      assert.match(drawer, /restores the original fail-closed sync warning/u);
      assert.ok(
        drawer.indexOf('<details class="sync-details">') <
          drawer.indexOf('Ignored cloud issue'),
      );
      assert.ok(
        drawer.indexOf('<summary>Details</summary>') <
          drawer.indexOf('Review this paper again'),
      );
      const offlineDrawer = renderDrawer({ ...state, connection: 'offline' });
      assert.match(offlineDrawer, /Offline · 1 ignored cloud issue/u);
      assert.match(offlineDrawer, /Ignored cloud issue/u);
    },
  );

  await context.test(
    'active Drive diagnostics are bounded, redacted, and kept inside Details',
    () => {
      const drawer = renderDrawer(
        viewState({
          connection: 'syncing',
          activeDriveOperation: {
            operationType: 'scan',
            stage: 'running',
            startedAt: 1_000,
            deadlineAt: 91_000,
            pendingRequestCount: 1,
            completedRequestCount: 2,
          },
        }),
      );
      const detailsIndex = drawer.indexOf('<details class="sync-details">');
      const diagnosticIndex = drawer.indexOf('Active Drive operation');
      assert.ok(detailsIndex >= 0 && diagnosticIndex > detailsIndex);
      assert.match(drawer, /<dt>Operation<\/dt><dd>scan<\/dd>/u);
      assert.match(drawer, /<dt>Stage<\/dt><dd>Running<\/dd>/u);
      assert.match(drawer, /Safety deadline/u);
      assert.match(drawer, /<dt>Requests in flight<\/dt><dd>1<\/dd>/u);
      assert.match(drawer, /<dt>Requests completed<\/dt><dd>2<\/dd>/u);
      assert.match(drawer, /contains no paper identity, file name, request URL/u);
      assert.match(drawer, /does not report the operation as successful/u);

      const timedOutDrawer = renderDrawer(
        viewState({
          connection: 'offline',
          activeDriveOperation: {
            operationType: 'scan',
            stage: 'timed-out',
            startedAt: 1_000,
            deadlineAt: 91_000,
            pendingRequestCount: 0,
            completedRequestCount: 0,
          },
        }),
      );
      assert.match(timedOutDrawer, /Timed out · settlement pending/u);

      const settledTimeoutDrawer = renderDrawer(
        viewState({
          connection: 'offline',
          lastDriveOperationTimeout: {
            operationType: 'scan',
            timedOutFromStage: 'running',
            failureCode: 'drive-request-in-flight-deadline-exceeded',
            timedOutAt: 91_000,
            pendingRequestCount: 1,
            completedRequestCount: 2,
            observedPhases: [
              {
                phase: 'read-timeout-recovery-root-validation',
                elapsedMs: 90_000,
                requestCount: 1,
                retryCount: 0,
              },
            ],
          },
        }),
      );
      assert.doesNotMatch(settledTimeoutDrawer, /Active Drive operation/u);
      assert.match(settledTimeoutDrawer, /Last Drive timeout/u);
      assert.match(settledTimeoutDrawer, /drive-request-in-flight-deadline-exceeded/u);
      assert.match(settledTimeoutDrawer, /Running after admission/u);
      assert.match(settledTimeoutDrawer, /read-timeout-recovery-root-validation/u);
      assert.match(settledTimeoutDrawer, /90000 ms/u);
      assert.match(
        settledTimeoutDrawer,
        /remains visible after the operation settles/u,
      );

      const ambiguousTimeoutDrawer = renderDrawer(
        viewState({
          connection: 'offline',
          lastDriveOperationTimeout: {
            operationType: 'scan',
            timedOutFromStage: 'running',
            failureCode: 'running-without-request-in-flight-deadline-exceeded',
            timedOutAt: 91_000,
            pendingRequestCount: 0,
            completedRequestCount: 0,
            observedPhases: [],
          },
        }),
      );
      assert.match(ambiguousTimeoutDrawer, /No completed Drive request phase/u);
      assert.match(ambiguousTimeoutDrawer, /does not identify one of those causes/u);

      const hardDeadlineDrawer = renderDrawer(
        viewState({
          connection: 'offline',
          lastDriveOperationTimeout: {
            operationType: 'scan',
            timedOutFromStage: 'running',
            failureCode: 'read-operation-hard-deadline-exceeded',
            timedOutAt: 301_000,
            pendingRequestCount: 4,
            completedRequestCount: 308,
            observedPhases: [],
          },
        }),
      );
      assert.match(hardDeadlineDrawer, /read-operation-hard-deadline-exceeded/u);
      assert.match(hardDeadlineDrawer, /five-minute absolute safety cap/u);
      assert.match(hardDeadlineDrawer, /No remote change was reported as successful/u);
    },
  );

  await context.test(
    'read timeout recovery is explicitly read-only and waits for prior settlement',
    () => {
      const timeoutIssue = classifyPaperCoordinatorError(
        new DriveOperationTimeoutError('scan', 90_000, false),
      );
      const ready = renderDrawer(
        viewState({
          connection: 'offline',
          issue: timeoutIssue,
          dirtyPaperIds: ['unrelated-dirty-paper'],
        }),
      );
      assert.match(ready, />Check Drive again \(read-only\)</u);
      assert.doesNotMatch(ready, />Retry now</u);
      assert.match(
        ready,
        /<button disabled="" type="button">Upload changes \(1\)<\/button>/u,
      );

      const settling = renderDrawer(
        viewState({
          connection: 'offline',
          issue: timeoutIssue,
          activeDriveOperation: {
            operationType: 'scan',
            stage: 'timed-out',
            startedAt: 1_000,
            deadlineAt: 91_000,
            pendingRequestCount: 0,
            completedRequestCount: 0,
          },
        }),
      );
      assert.match(
        settling,
        /<button disabled="" type="button">Check Drive again \(read-only\)<\/button>/u,
      );
    },
  );

  await context.test(
    'account-root quarantine removes only the exact paper from pending and Auto-sync queues',
    () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const broken = paperState('quarantined-paper', ['notes']);
      broken.status = 'needs-attention';
      broken.cloudPresence = 'present';
      const unrelated = paperState('unrelated-upload', ['annotations']);
      const reimported = paperState(
        'quarantined-paper:instance:11111111-1111-4111-8111-111111111111',
        ['source-pdf'],
      );
      const issue = classifyPaperCoordinatorError(
        new PaperRepositoryError('paper-presence-invalid', 'Presence failed.', {
          diagnosticPhase: 'paper-presence-resolution',
          diagnosticCauseCode: 'presence-control-resolution-failed',
        }),
      );
      const profile: PaperSyncDeviceProfile = {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: true,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
        rootFolderId: 'root-a',
        cloudIssueQuarantines: [
          {
            version: 1,
            documentId: broken.documentId,
            accountId: 'account-a',
            rootFolderId: 'root-a',
            reason: 'presence-control-resolution-failed',
            confirmedAt: 100,
          },
        ],
      };
      Reflect.set(coordinator, 'profile', profile);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      Reflect.set(
        coordinator,
        'paperStates',
        new Map([
          [broken.documentId, broken],
          [reimported.documentId, reimported],
          [unrelated.documentId, unrelated],
        ]),
      );
      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([[broken.documentId, { issue }]]),
      );
      Reflect.set(
        coordinator,
        'view',
        viewState({
          issue,
          paperStates: [broken, reimported, unrelated],
          dirtyPaperIds: [
            broken.documentId,
            reimported.documentId,
            unrelated.documentId,
          ],
        }),
      );
      const pending = Reflect.get(
        coordinator,
        'getPendingSyncPaperIds',
      ) as () => string[];
      const auto = Reflect.get(
        coordinator,
        'getAutoSyncEligibleDirtyPaperIds',
      ) as () => string[];
      assert.deepEqual(pending.call(coordinator), [
        reimported.documentId,
        unrelated.documentId,
      ]);
      assert.deepEqual(auto.call(coordinator), [
        reimported.documentId,
        unrelated.documentId,
      ]);

      profile.rootFolderId = 'root-b';
      assert.deepEqual(pending.call(coordinator).sort(), [
        broken.documentId,
        reimported.documentId,
        unrelated.documentId,
      ]);
      profile.rootFolderId = 'root-a';
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-b');
      assert.deepEqual(pending.call(coordinator).sort(), [
        broken.documentId,
        reimported.documentId,
        unrelated.documentId,
      ]);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      assert.deepEqual(pending.call(coordinator), [
        reimported.documentId,
        unrelated.documentId,
      ]);
    },
  );

  await context.test(
    'Forget eligibility accepts session proof or an explicitly requested durable Browse identity',
    () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const first = paperState('exact-broken-paper');
      first.status = 'needs-attention';
      first.cloudPresence = 'present';
      const second = paperState('second-broken-paper');
      second.status = 'needs-attention';
      second.cloudPresence = 'present';
      const issue = classifyPaperCoordinatorError(
        new PaperRepositoryError('paper-presence-invalid', 'Presence failed.', {
          diagnosticPhase: 'paper-presence-resolution',
          diagnosticCauseCode: 'presence-control-resolution-failed',
        }),
      );
      Reflect.set(coordinator, 'profile', {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: true,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
        rootFolderId: 'root-a',
      } satisfies PaperSyncDeviceProfile);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      Reflect.set(coordinator, 'paperStates', new Map([[first.documentId, first]]));
      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([[first.documentId, { issue }]]),
      );
      Reflect.set(
        coordinator,
        'view',
        viewState({
          papers: [cloudPaper(first.documentId, 'head-a')],
          paperStates: [first],
        }),
      );
      assert.deepEqual(coordinator.getForgetInaccessiblePaperCandidate(), {
        documentId: first.documentId,
        displayName: first.documentId.toUpperCase(),
      });

      Reflect.set(
        coordinator,
        'paperStates',
        new Map([
          [first.documentId, first],
          [second.documentId, second],
        ]),
      );
      Reflect.set(
        coordinator,
        'blockingPaperIssues',
        new Map([
          [first.documentId, { issue }],
          [second.documentId, { issue }],
        ]),
      );
      assert.equal(coordinator.getForgetInaccessiblePaperCandidate(), undefined);

      Reflect.set(coordinator, 'blockingPaperIssues', new Map());
      Reflect.set(
        coordinator,
        'view',
        viewState({
          papers: [
            {
              ...cloudPaper(first.documentId, 'head-a'),
              status: 'needs-attention',
              issue: {
                code: 'paper-presence-invalid',
                message: 'Presence failed.',
                phase: 'paper-presence-resolution',
                causeCode: 'presence-control-resolution-failed',
              },
            },
          ],
          paperStates: [first],
        }),
      );
      assert.equal(coordinator.getForgetInaccessiblePaperCandidate(), undefined);
      assert.equal(
        coordinator.getForgetInaccessiblePaperCandidate(first.documentId),
        undefined,
      );
      first.driveFiles.paperFolderId = `folder-${first.documentId}`;
      assert.deepEqual(
        coordinator.getForgetInaccessiblePaperCandidate(first.documentId),
        {
          documentId: first.documentId,
          displayName: first.documentId.toUpperCase(),
        },
      );
    },
  );

  await context.test(
    'quarantine, review, and re-quarantine survive every synthetic reload without changing cloud evidence',
    async () => {
      await closeSyncPersistenceWorkspace();
      const persistedSnapshot = new Map(
        [...securityDatabaseRecords].map(([databaseName, stores]) => [
          databaseName,
          new Map(
            [...stores].map(([storeName, records]) => [
              storeName,
              new Map(
                [...records].map(([key, value]) => [key, structuredClone(value)]),
              ),
            ]),
          ),
        ]),
      );
      const documentId = 'synthetic-recurring-broken-paper';
      const accountId = 'synthetic-recurring-account';
      const rootFolderId = 'synthetic-recurring-root';
      const paperFolderId = `folder-${documentId}`;
      const brokenState = paperState(documentId);
      brokenState.status = 'synced';
      brokenState.cloudPresence = 'present';
      brokenState.driveFiles.paperFolderId = paperFolderId;
      // This is the real resolver-failure shape after review/reload: the cached
      // catalog keeps the cloud row in Needs-attention while the persisted local
      // state retains its last successfully settled healthy status. There is no
      // idealized per-paper failure tuple, so the reviewed scoped proof is what
      // makes an exact re-quarantine safe.
      const brokenPaper: PaperCloudSummary = {
        ...cloudPaper(documentId, 'cached-head'),
        paperFolderId,
        presenceState: 'present',
        status: 'needs-attention',
      };
      const retainedCursor = {
        version: 1 as const,
        accountId,
        rootFolderId,
        deviceMode: 'personal' as const,
        pageToken: 'cursor-before-local-quarantine',
        lastFullAuditAt: 50,
      };
      const initialProfile: PaperSyncDeviceProfile = {
        id: 'paper-device',
        deviceId: 'synthetic-recurring-device',
        deviceLabel: 'Synthetic recurring issue device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        accountId,
        workspaceAccountId: accountId,
        rootFolderId,
        driveChangeCursor: retainedCursor,
        cloudIssueQuarantines: [
          {
            version: 1,
            documentId,
            accountId,
            rootFolderId,
            reason: 'presence-control-resolution-failed',
            confirmedAt: 100,
          },
        ],
      };

      const reopen = async () => {
        await closeSyncPersistenceWorkspace();
        const [profile, states, papers] = await Promise.all([
          loadPaperSyncDeviceProfile(),
          loadPaperSyncStates(),
          loadCloudPaperCatalog(),
        ]);
        const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
        Reflect.set(coordinator, 'profile', profile);
        Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', accountId);
        Reflect.set(
          coordinator,
          'paperStates',
          new Map(states.map((state) => [state.documentId, state])),
        );
        Reflect.set(coordinator, 'view', viewState({ papers, paperStates: states }));
        const refreshStateView = Reflect.get(coordinator, 'refreshStateView') as (
          papers: readonly PaperCloudSummary[],
        ) => void;
        refreshStateView.call(coordinator, papers);
        Reflect.set(coordinator, 'initialize', async () => undefined);
        Reflect.set(coordinator, 'isAutoSyncEffectivelyEnabled', () => false);
        return coordinator;
      };

      const runLocalQuarantineAction = async (
        coordinator: object,
        action: () => Promise<unknown>,
      ) => {
        const runWorkspaceMutation = Reflect.get(
          coordinator,
          'runWorkspaceMutation',
        ) as (
          task: (lease: WorkspaceRestoreLease) => Promise<unknown>,
        ) => Promise<unknown>;
        await runWorkspaceMutation.call(coordinator, async (lease) => {
          const signal = new AbortController().signal;
          Reflect.set(coordinator, 'beginOperation', async () => signal);
          Reflect.set(coordinator, 'requireWorkspaceLease', () => lease);
          Reflect.set(coordinator, 'endOperation', () => undefined);
          return action();
        });
      };

      try {
        securityDatabaseRecords.clear();
        await savePaperSyncDeviceProfile(initialProfile, {
          authentication: 'replace',
        });
        await savePaperSyncState(brokenState);
        await saveCloudPaperCatalog([brokenPaper]);

        // quarantine -> reload
        let coordinator = await reopen();
        assert.equal(
          coordinator.getSnapshot().ignoredCloudIssues?.[0]?.documentId,
          documentId,
        );
        assert.deepEqual(normalCloudPapers(coordinator.getSnapshot()), []);
        assert.deepEqual(paperRows(coordinator.getSnapshot(), 'download'), []);

        // review again -> reload
        await runLocalQuarantineAction(coordinator, () =>
          coordinator.reviewIgnoredCloudIssue(documentId),
        );
        coordinator = await reopen();
        const reviewedProfile = await loadPaperSyncDeviceProfile();
        assert.deepEqual(reviewedProfile.driveChangeCursor, retainedCursor);
        assert.equal(reviewedProfile.cloudIssueQuarantines?.length, 1);
        assert.equal(
          typeof reviewedProfile.cloudIssueQuarantines?.[0]?.reviewedAt,
          'number',
        );
        assert.equal(
          reviewedProfile.cloudIssueQuarantines?.[0]?.paperFolderId,
          paperFolderId,
        );
        assert.equal(coordinator.getSnapshot().ignoredCloudIssues?.length, 0);
        assert.equal(paperRows(coordinator.getSnapshot(), 'download').length, 1);
        assert.equal(coordinator.getSnapshot().papers[0]?.issue, undefined);
        const diagnostic = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);
        assert.equal(diagnostic.evidenceSource, 'reviewed-quarantine');
        assert.equal(diagnostic.predicates.catalogNeedsAttention, true);
        assert.equal(diagnostic.predicates.localStateNeedsAttention, false);
        assert.equal(diagnostic.predicates.localPresencePresent, true);
        assert.equal(diagnostic.predicates.paperFolderMatches, true);
        assert.equal(diagnostic.predicates.reviewedProofPresent, true);
        assert.equal(diagnostic.predicates.identityProofAvailable, true);
        assert.equal(diagnostic.reason, 'eligible');
        assert.deepEqual(coordinator.getForgetInaccessiblePaperCandidate(documentId), {
          documentId,
          displayName: brokenPaper.displayName,
        });
        const browseMarkup = renderToStaticMarkup(
          createElement(PaperSelectorDialog, {
            state: coordinator.getSnapshot(),
            coordinator,
            mode: 'download',
            onClose() {},
          }),
        );
        assert.match(browseMarkup, /Needs attention/u);
        assert.match(browseMarkup, new RegExp(`Document ID.*${documentId}`, 'u'));
        assert.match(browseMarkup, />Forget inaccessible paper<\/button>/u);
        assert.doesNotMatch(
          browseMarkup,
          /disabled="" type="button">Forget inaccessible paper/u,
        );
        assert.doesNotMatch(
          browseMarkup,
          /Verify identity \(read-only\)|local-state-not-needs-attention/u,
        );
        const catalogBeforeRequarantine = await loadCloudPaperCatalog();

        // re-quarantine -> reload
        await runLocalQuarantineAction(coordinator, () =>
          coordinator.forgetInaccessiblePaper(documentId),
        );
        assert.deepEqual(await loadCloudPaperCatalog(), catalogBeforeRequarantine);
        coordinator = await reopen();
        assert.equal(
          coordinator.getSnapshot().ignoredCloudIssues?.[0]?.documentId,
          documentId,
        );
        assert.deepEqual(normalCloudPapers(coordinator.getSnapshot()), []);
        assert.deepEqual(paperRows(coordinator.getSnapshot(), 'download'), []);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).cloudIssueQuarantines?.length,
          1,
        );
        assert.equal(
          (await loadPaperSyncDeviceProfile()).cloudIssueQuarantines?.[0]?.reviewedAt,
          undefined,
        );
        assert.deepEqual(
          (await loadPaperSyncDeviceProfile()).driveChangeCursor,
          retainedCursor,
        );
        assert.deepEqual(await loadCloudPaperCatalog(), catalogBeforeRequarantine);

        const finalRefreshStateView = Reflect.get(coordinator, 'refreshStateView') as (
          papers: readonly PaperCloudSummary[],
        ) => void;
        const finalIdentity = Reflect.get(coordinator, 'identity');
        Reflect.set(finalIdentity, 'accountIdValue', undefined);
        finalRefreshStateView.call(coordinator, catalogBeforeRequarantine);
        assert.equal(
          (await loadPaperSyncDeviceProfile()).cloudIssueQuarantines?.length,
          1,
        );
        Reflect.set(finalIdentity, 'accountIdValue', accountId);
        finalRefreshStateView.call(coordinator, catalogBeforeRequarantine);
        assert.equal(
          coordinator.getSnapshot().ignoredCloudIssues?.[0]?.documentId,
          documentId,
        );
        assert.deepEqual(normalCloudPapers(coordinator.getSnapshot()), []);
      } finally {
        await closeSyncPersistenceWorkspace();
        securityDatabaseRecords.clear();
        for (const [databaseName, stores] of persistedSnapshot) {
          securityDatabaseRecords.set(databaseName, stores);
        }
      }
    },
  );

  await context.test(
    'production visibility offers only read-only verification while exact proof is unavailable',
    () => {
      assert.equal(
        shouldOfferForgetIdentityVerification(false, 'identity-proof-unavailable'),
        true,
      );
      assert.equal(shouldOfferForgetIdentityVerification(false, undefined), true);
      assert.equal(
        shouldOfferForgetIdentityVerification(false, 'paper-folder-mismatch'),
        false,
      );
      assert.equal(
        shouldOfferForgetIdentityVerification(true, 'identity-proof-unavailable'),
        false,
      );
    },
  );

  await context.test(
    'Browse exposes the exact document ID and a fail-closed recovery blocker when proof is unavailable',
    () => {
      const documentId = 'synthetic-visible-blocked-paper';
      const paperFolderId = `folder-${documentId}`;
      const state = paperState(documentId, [], 'cloud-only');
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      state.driveFiles.paperFolderId = paperFolderId;
      const paper = {
        ...cloudPaper(documentId, 'cached-head'),
        paperFolderId,
        presenceState: 'present' as const,
        status: 'needs-attention' as const,
      };
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'profile', {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
        rootFolderId: 'root-a',
      } satisfies PaperSyncDeviceProfile);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      Reflect.set(coordinator, 'paperStates', new Map([[documentId, state]]));
      Reflect.set(
        coordinator,
        'view',
        viewState({ papers: [paper], paperStates: [state] }),
      );

      assert.equal(
        coordinator.getForgetInaccessiblePaperDiagnostic(documentId).reason,
        'identity-proof-unavailable',
      );
      const markup = renderToStaticMarkup(
        createElement(PaperSelectorDialog, {
          state: coordinator.getSnapshot(),
          coordinator,
          mode: 'download',
          onClose() {},
        }),
      );
      assert.match(markup, new RegExp(`Document ID.*${documentId}`, 'u'));
      assert.match(
        markup,
        /<button disabled="" type="button">Forget inaccessible paper<\/button>/u,
      );
      assert.match(markup, /Verify identity \(read-only\)/u);
      assert.match(markup, /Failed predicate:.*identity-proof-unavailable/u);
    },
  );

  await context.test(
    'Forget requires cloud-catalog attention and never combines an old proof with unrelated local attention',
    () => {
      const documentId = 'synthetic-local-only-attention';
      const paperFolderId = `folder-${documentId}`;
      const state = paperState(documentId);
      state.status = 'needs-attention';
      state.cloudPresence = 'present';
      state.driveFiles.paperFolderId = paperFolderId;
      const paper = {
        ...cloudPaper(documentId, 'healthy-head'),
        paperFolderId,
        presenceState: 'present' as const,
      };
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'profile', {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
        rootFolderId: 'root-a',
        cloudIssueQuarantines: [
          {
            version: 1,
            documentId,
            accountId: 'account-a',
            rootFolderId: 'root-a',
            paperFolderId,
            reason: 'presence-control-resolution-failed',
            confirmedAt: 100,
            reviewedAt: 200,
          },
        ],
      } satisfies PaperSyncDeviceProfile);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      Reflect.set(coordinator, 'paperStates', new Map([[documentId, state]]));
      Reflect.set(
        coordinator,
        'view',
        viewState({ papers: [paper], paperStates: [state] }),
      );

      const diagnostic = coordinator.getForgetInaccessiblePaperDiagnostic(documentId);
      assert.equal(diagnostic.predicates.localStateNeedsAttention, true);
      assert.equal(diagnostic.predicates.catalogNeedsAttention, false);
      assert.equal(diagnostic.predicates.reviewedProofPresent, true);
      assert.equal(diagnostic.reason, 'paper-not-needs-attention');
      assert.equal(diagnostic.eligible, false);
      assert.equal(
        coordinator.getForgetInaccessiblePaperCandidate(documentId),
        undefined,
      );
    },
  );

  await context.test(
    'repeated Forget confirmation is an idempotent local no-op',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const entry = {
        version: 1 as const,
        documentId: 'already-quarantined-paper',
        accountId: 'account-a',
        rootFolderId: 'root-a',
        reason: 'presence-control-resolution-failed' as const,
        confirmedAt: 100,
      };
      const profile: PaperSyncDeviceProfile = {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Synthetic device',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
        rootFolderId: 'root-a',
        cloudIssueQuarantines: [entry],
      };
      Reflect.set(coordinator, 'profile', profile);
      Reflect.set(Reflect.get(coordinator, 'identity'), 'accountIdValue', 'account-a');
      Reflect.set(coordinator, 'view', viewState());
      Reflect.set(coordinator, 'initialize', async () => undefined);
      Reflect.set(
        coordinator,
        'beginOperation',
        async () => new AbortController().signal,
      );
      Reflect.set(coordinator, 'endOperation', () => undefined);
      Reflect.set(coordinator, 'isAutoSyncEffectivelyEnabled', () => false);

      assert.deepEqual(await coordinator.forgetInaccessiblePaper(entry.documentId), {
        documentId: entry.documentId,
        alreadyIgnored: true,
      });
      assert.deepEqual(await coordinator.forgetInaccessiblePaper(entry.documentId), {
        documentId: entry.documentId,
        alreadyIgnored: true,
      });
      assert.deepEqual(profile.cloudIssueQuarantines, [entry]);
    },
  );

  await context.test(
    'shared semantic tones distinguish success, activity, warnings, and blocking danger',
    () => {
      const state = viewState();
      assert.equal(syncToneForView(state, 'synced'), 'success');
      assert.equal(syncToneForView(state, 'connected'), 'neutral');
      assert.equal(syncToneForView(state, 'syncing'), 'neutral');
      assert.equal(syncToneForView(state, 'pending'), 'warning');
      assert.equal(
        syncToneForView(viewState({ connection: 'offline' }), 'offline'),
        'warning',
      );
      assert.equal(
        syncToneForView(viewState({ connection: 'reconnect-required' }), 'attention'),
        'warning',
      );
      assert.equal(
        syncToneForView(
          viewState({ connection: 'root-selection-required' }),
          'attention',
        ),
        'danger',
      );
      assert.equal(
        syncToneForIssue({
          code: 'google-authorization-required',
          severity: 'error',
          blocksOrdinarySync: true,
        }),
        'warning',
      );
      assert.equal(
        syncToneForIssue({
          code: 'drive-integrity-mismatch',
          severity: 'error',
          blocksOrdinarySync: true,
        }),
        'danger',
      );
      assert.equal(syncToneForPaper('synced'), 'success');
      assert.equal(syncToneForPaper('uploading'), 'neutral');
      assert.equal(syncToneForPaper('remote-update-available'), 'warning');
      assert.equal(
        syncToneForPaper('needs-attention', 'paper-integrity-failed'),
        'danger',
      );
    },
  );

  await context.test(
    'paper browser metadata exposes cloud-only and update labels',
    () => {
      const state = viewState({
        papers: [cloudPaper('doc-a', 'head-a')],
        paperStates: [],
      });
      assert.equal(paperRows(state, 'download')[0].statusLabel, 'Cloud only');
    },
  );

  await context.test(
    'a cloud-only download immediately becomes a busy paper row and blocks duplicates',
    () => {
      const downloading = paperState('doc-a', [], 'cloud-only');
      downloading.status = 'downloading';
      const markup = renderCloudLibrary(
        viewState({
          connection: 'syncing',
          papers: [cloudPaper('doc-a', 'head-a')],
          paperStates: [downloading],
          progress: { phase: 'downloading', completed: 0, total: 1 },
        }),
      );

      assert.match(markup, /role="status"[^>]*>[\s\S]*Downloading…/u);
      assert.match(markup, /Downloading 1 paper…/u);
      assert.doesNotMatch(markup, />Retry download<|>Download</u);
      assert.doesNotMatch(markup, /<progress/u);

      const coordinator = source('../src/sync/paperCoordinator.ts');
      const status = coordinator.indexOf("state.status = 'downloading'");
      const insert = coordinator.indexOf(
        'this.paperStates.set(documentId, state)',
        status,
      );
      const refresh = coordinator.indexOf('this.refreshStateView()', insert);
      const persist = coordinator.indexOf('await savePaperSyncState(', refresh);
      assert.ok(
        status >= 0 && insert > status && refresh > insert && persist > refresh,
      );
      assert.match(
        coordinator.slice(persist, persist + 180),
        /state,\s*this\.requireWorkspaceLease\(signal\)/u,
      );
    },
  );

  await context.test(
    'download batches expose authoritative paper counts without fake percentages',
    () => {
      const state = viewState({
        connection: 'syncing',
        papers: [
          cloudPaper('doc-a', 'head-a'),
          cloudPaper('doc-b', 'head-b'),
          cloudPaper('doc-c', 'head-c'),
        ],
        progress: { phase: 'downloading', completed: 1, total: 3 },
      });
      assert.equal(getPaperDownloadBatchFeedback(state), 'Downloading 2 of 3 papers');
      const markup = renderCloudLibrary(state);
      assert.match(markup, /Downloading 2 of 3 papers/u);
      assert.doesNotMatch(markup, /\b\d+%\b/u);
      assert.match(markup, />Download all</u);
      assert.match(markup, /<button disabled="" type="button">Download all/u);
    },
  );

  await context.test(
    'concurrent paper callbacks cannot regress the shared determinate progress',
    () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const applyProgress = Reflect.get(coordinator, 'applyPaperProgress');
      assert.equal(typeof applyProgress, 'function');

      Reflect.apply(applyProgress, coordinator, [
        {
          documentId: 'doc-a',
          phase: 'uploading',
          bytesCompleted: 80,
          bytesTotal: 100,
          detail: 'Paper A',
        },
        0,
        2,
      ]);
      const first = coordinator.getSnapshot().progress;
      assert.equal(first.bytesCompleted, undefined);
      assert.deepEqual(getSyncProgressPresentation(first)?.determinate, {
        value: 0,
        max: 2,
      });

      Reflect.apply(applyProgress, coordinator, [
        {
          documentId: 'doc-b',
          phase: 'uploading',
          bytesCompleted: 20,
          bytesTotal: 100,
          detail: 'Paper B',
        },
        0,
        2,
      ]);
      const interleaved = coordinator.getSnapshot().progress;
      assert.equal(interleaved.bytesCompleted, undefined);
      assert.deepEqual(getSyncProgressPresentation(interleaved)?.determinate, {
        value: 0,
        max: 2,
      });

      Reflect.apply(applyProgress, coordinator, [
        {
          documentId: 'doc-a',
          phase: 'uploading',
          bytesCompleted: 80,
          bytesTotal: 100,
          detail: 'Paper A',
        },
        0,
        1,
      ]);
      assert.deepEqual(
        getSyncProgressPresentation(coordinator.getSnapshot().progress)?.determinate,
        { value: 80, max: 100 },
      );
    },
  );

  await context.test(
    'download feedback becomes indeterminate when exact counts are unavailable',
    () => {
      const state = viewState({
        connection: 'syncing',
        progress: { phase: 'downloading' },
      });
      assert.equal(getPaperDownloadBatchFeedback(state), 'Downloading papers…');
      const markup = renderCloudLibrary(state);
      assert.match(markup, /class="sync-activity-indicator"/u);
      assert.doesNotMatch(markup, /<progress/u);
    },
  );

  await context.test(
    'download completion and failure both clear busy feedback with a safe retry policy',
    () => {
      const synced = paperState('doc-a');
      synced.status = 'synced';
      const completeMarkup = renderCloudLibrary(
        viewState({
          papers: [cloudPaper('doc-a', 'head-a')],
          paperStates: [synced],
          progress: { phase: 'idle' },
        }),
      );
      assert.match(completeMarkup, />Synced</u);
      assert.doesNotMatch(completeMarkup, /Downloading…/u);

      const failed = paperState('doc-a');
      failed.status = 'needs-attention';
      const failureMarkup = renderCloudLibrary(
        viewState({
          connection: 'attention',
          papers: [
            {
              ...cloudPaper('doc-a', 'head-a'),
              issue: {
                code: 'paper-operation-failed',
                message: 'Google Drive temporarily interrupted this download.',
              },
            },
          ],
          paperStates: [failed],
          progress: { phase: 'idle' },
        }),
      );
      assert.match(
        failureMarkup,
        /role="alert">Google Drive temporarily interrupted this download\./u,
      );
      assert.match(failureMarkup, />Retry download</u);
      assert.doesNotMatch(failureMarkup, /Downloading…/u);

      const integrityMarkup = renderCloudLibrary(
        viewState({
          connection: 'attention',
          papers: [
            {
              ...cloudPaper('doc-a', 'head-a'),
              issue: {
                code: 'paper-integrity-failed',
                message: 'Drive data needs verification.',
              },
            },
          ],
          paperStates: [failed],
        }),
      );
      assert.match(integrityMarkup, /Drive data needs verification\./u);
      assert.doesNotMatch(integrityMarkup, />Retry download</u);
    },
  );

  await context.test(
    'failed downloads retain paper errors and every terminal path clears progress',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      assert.match(
        coordinator,
        /if \(settledCloud\.length > 0\) \{[\s\S]*?phase: 'verifying'[\s\S]*?await this\.applyTransferCatalog\(\s*settledCloud,\s*this\.requireWorkspaceLease\(signal\)/u,
      );
      assert.doesNotMatch(coordinator, /scanAfterBatch/u);
      assert.match(
        coordinator,
        /connection: this\.connectionAfterPaperSettlement\(primaryIssue\),[\s\S]*?progress: \{ phase: 'idle' \}/u,
      );
      assert.match(
        coordinator,
        /catch \(error\) \{[\s\S]*?if \(!failures\.some\(\(failure\) => failure\.error === error\)\)[\s\S]*?this\.applyError\(error\)/u,
      );
    },
  );

  await context.test(
    'single-paper settlement updates only the compact catalog without a Library scan',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      const start = coordinator.indexOf('private async applyTransferCatalog(');
      const end = coordinator.indexOf('private async runPostMigrationFullAudit', start);
      const settlement = coordinator.slice(start, end);
      assert.match(
        settlement,
        /await saveCloudPaperCatalog\(catalog, workspaceLease\)/u,
      );
      assert.doesNotMatch(
        settlement,
        /listLocalPapers|applyDiscovery|savePaperSyncStates/u,
      );

      const removeStart = coordinator.indexOf('\n  removeFromGoogleDriveSelected(');
      const removeEnd = coordinator.indexOf('\n  restoreToGoogleDrive(', removeStart);
      assert.doesNotMatch(
        coordinator.slice(removeStart, removeEnd),
        /listLocalPapers/u,
      );

      const annotationPersistence = source('../src/services/annotationPersistence.ts');
      const backupReadStart = annotationPersistence.indexOf(
        'async function readBackupDocumentData(',
      );
      const backupReadEnd = annotationPersistence.indexOf(
        'export async function removeStoredPdfCopy',
        backupReadStart,
      );
      const scopedBackupRead = annotationPersistence.slice(
        backupReadStart,
        backupReadEnd,
      );
      assert.match(scopedBackupRead, /database\.get\(DOCUMENT_STATE_STORE/u);
      assert.match(
        source('../src/services/productivityPersistence.ts'),
        /getAllFromIndex\(\s*AI_CONVERSATION_STORE,\s*'by-document'/u,
      );
      const localAdapter = source('../src/sync/paperLocalAdapter.ts');
      assert.match(localAdapter, /getCollectionsByIds/u);
      assert.doesNotMatch(localAdapter, /listCollections|getTagsByIds|listTags/u);
    },
  );

  await context.test(
    'upload selector excludes clean papers and includes dirty reasons',
    () => {
      const state = viewState({
        paperStates: [paperState('doc-a', ['notes']), paperState('doc-b')],
      });
      const rows = paperRows(state, 'upload');
      assert.deepEqual(
        rows.map((row) => row.documentId),
        ['doc-a'],
      );
      assert.deepEqual(rows[0].reasons, ['notes']);
    },
  );

  await context.test(
    'download, upload, and Keep local selectors close before background work settles',
    () => {
      const ui = source('../src/sync/PaperSyncControl.tsx');
      const start = ui.indexOf('const run = async (all = false) =>');
      const end = ui.indexOf('return (', start);
      const actions = ui.slice(start, end);
      for (const [operationStart, closeText, settleText] of [
        [
          'const operation = coordinator.downloadSelected(ids);',
          'onClose();',
          'await operation.catch(() => undefined);',
        ],
        [
          'const operation = coordinator.uploadSelected(ids);',
          'onClose();',
          'await operation.catch(() => undefined);',
        ],
        [
          'const operation = coordinator.keepLocalSelected(selectedKeepLocalIds);',
          'onClose();',
          'await operation.catch(() => undefined);',
        ],
      ] as const) {
        const operation = actions.indexOf(operationStart);
        const close = actions.indexOf(closeText, operation);
        const settled = actions.indexOf(settleText, close);
        assert.ok(operation >= 0 && close > operation && settled > close);
      }
    },
  );

  await context.test(
    'download applies locally only after a bounded scoped snapshot retry returns',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      const start = coordinator.indexOf(
        'const result = await runScopedPaperDownload({',
      );
      const apply = coordinator.indexOf("'indexeddb-commit'", start);
      assert.ok(start >= 0 && apply > start);
      assert.match(coordinator.slice(start, apply), /Refreshing latest Drive version/u);
      assert.match(
        coordinator.slice(start, apply),
        /discoverPapers\(\s*\[documentId\]/u,
      );
      assert.match(coordinator.slice(start, apply), /layoutValidated:\s*true/u);
      assert.match(
        coordinator.slice(start, apply),
        /avoid a root-wide layout inventory/u,
      );
      assert.doesNotMatch(
        coordinator.slice(start, apply),
        /this\.local\.applyDownloadedPaper/u,
      );
    },
  );

  await context.test(
    'verified local application stays unpublished until baseline commit and rolls back on failure',
    async () => {
      const events: string[] = [];
      let releaseBaseline!: () => void;
      const baselineGate = new Promise<void>((resolve) => {
        releaseBaseline = resolve;
      });
      const application = {
        changedDocumentIds: ['doc-a'],
        deletedDocumentIds: [],
        async rollback() {
          events.push('rollback');
        },
        publish() {
          events.push('publish');
        },
      };
      const finishing = finalizeAppliedPaperDownload(application, async () => {
        events.push('baseline-start');
        await baselineGate;
        events.push('baseline-committed');
      });
      assert.deepEqual(events, ['baseline-start']);
      releaseBaseline();
      await finishing;
      assert.deepEqual(events, ['baseline-start', 'baseline-committed', 'publish']);

      events.length = 0;
      const persistenceFailure = new Error('baseline failed');
      await assert.rejects(
        () =>
          finalizeAppliedPaperDownload(application, async () => {
            events.push('baseline-failed');
            throw persistenceFailure;
          }),
        (error: unknown) => error === persistenceFailure,
      );
      assert.deepEqual(events, ['baseline-failed', 'rollback']);

      const adapter = source('../src/sync/paperLocalAdapter.ts');
      const persistence = source('../src/services/annotationPersistence.ts');
      assert.match(adapter, /restoreDownloadedPaperBundle/u);
      assert.match(adapter, /deleteProductivityDocumentDataStrict/u);
      assert.match(
        persistence,
        /\[DOCUMENT_STATE_STORE, PDF_FILE_STORE, COLLECTION_STORE\]/u,
      );
      assert.match(
        source('../src/sync/paperCoordinator.ts'),
        /finalizeAppliedPaperDownload\(localApplication,[\s\S]*?savePaperSyncState\(\s*state,\s*this\.requireWorkspaceLease\(signal\)/u,
      );
    },
  );

  await context.test(
    'cloud tombstones are hidden on devices that never had the paper',
    () => {
      const state = viewState({
        papers: [{ ...cloudPaper('doc-a', 'head-a'), deleted: true }],
        paperStates: [paperState('doc-a', [], 'cloud-only')],
      });
      assert.equal(paperRows(state, 'download').length, 0);
    },
  );

  await context.test(
    'authoritative item counts render a determinate progress bar',
    () => {
      const progress = getSyncProgressPresentation({
        phase: 'downloading',
        completed: 1,
        total: 3,
      });
      assert.deepEqual(progress?.determinate, { value: 1, max: 3 });
      assert.match(progress?.label ?? '', /2 of 3/u);
    },
  );

  await context.test(
    'non-measurable phases use an indeterminate activity label',
    () => {
      const progress = getSyncProgressPresentation({
        phase: 'merging',
        detail: 'Paper A',
      });
      assert.equal(progress?.determinate, undefined);
      assert.match(progress?.label ?? '', /Merging/u);
    },
  );

  await context.test('terminal state clears progress UI', () => {
    assert.equal(getSyncProgressPresentation({ phase: 'idle' }), null);
  });

  await context.test(
    'drawer content surface is opaque in every theme token path',
    () => {
      const css = source('../src/styles/index.css');
      assert.match(
        css,
        /\.paper-sync-panel\s*\{[^}]*background:\s*var\(--theme-drawer\)/su,
      );
    },
  );
});

test('validated Drive status and remote-update review remain coherent', async (context) => {
  await context.test(
    'persisted Personal session plus successful discovery cannot render Not connected',
    () => {
      const state = remoteUpdateView(['doc-c']);
      state.sessions = [
        {
          id: 'session-a',
          deviceId: 'device-a',
          createdAt: 1,
          lastUsedAt: 2,
          current: true,
          sessionMode: 'personal',
          expiresAt: null,
        },
      ];
      const markup = renderDrawer(state);
      assert.equal(paperSyncStatusLabel(state), 'Connected');
      assert.match(markup, /role="status">Connected</u);
      assert.doesNotMatch(markup, />Not connected</u);
      assert.match(markup, />Disconnect this device</u);

      const coordinator = source('../src/sync/paperCoordinator.ts');
      const initialize = coordinator.indexOf('private async initializeOnce');
      const refreshSessions = coordinator.indexOf(
        'await this.refreshSessions()',
        initialize,
      );
      const discovery = coordinator.indexOf(
        'await this.scanCloudPapersOwned(false)',
        refreshSessions,
      );
      const discoveredConnection = coordinator.indexOf(
        'connection: this.connectionAfterPaperSettlement(blockingIssue)',
        coordinator.indexOf('private async scanCloudPapersOwned'),
      );
      assert.ok(
        initialize >= 0 &&
          refreshSessions > initialize &&
          discovery > refreshSessions &&
          discoveredConnection > 0,
      );
    },
  );

  await context.test('every connection status has an explicit display label', () => {
    const expected = {
      loading: 'Checking',
      'not-configured': 'Not connected',
      disconnected: 'Not connected',
      connecting: 'Connecting',
      connected: 'Connected',
      syncing: 'Syncing',
      offline: 'Offline',
      'reconnect-required': 'Reconnect required',
      'root-selection-required': 'Choose Drive folder',
      'root-unavailable': 'Drive folder unavailable',
      'layout-upgrade-required': 'Drive upgrade required',
      'migration-incomplete': 'Drive upgrade incomplete',
      attention: 'Needs attention',
    } satisfies Record<PaperConnectionStatus, string>;
    for (const [connection, label] of Object.entries(expected)) {
      assert.equal(
        paperSyncStatusLabel(
          viewState({ connection: connection as PaperConnectionStatus }),
        ),
        label,
      );
    }
    assert.match(
      source('../src/sync/PaperSyncControl.tsx'),
      /assertNeverConnectionStatus\(state\.connection\)/u,
    );
  });

  await context.test('connection actions match actual auth state', () => {
    const disconnected = renderDrawer(viewState({ connection: 'disconnected' }));
    assert.equal(paperConnectionAction('disconnected'), 'connect');
    assert.match(disconnected, />Connect Google Drive</u);
    assert.doesNotMatch(disconnected, />Disconnect this device</u);

    const reconnect = renderDrawer(
      viewState({
        connection: 'reconnect-required',
        error: 'Google Drive authorization needs to be renewed.',
      }),
    );
    assert.equal(paperConnectionAction('reconnect-required'), 'reconnect');
    assert.match(reconnect, />Reconnect Google Drive</u);
    assert.doesNotMatch(reconnect, /role="status">Not connected</u);

    const connected = renderDrawer(viewState());
    assert.equal(paperConnectionAction('connected'), 'disconnect');
    assert.match(connected, />Disconnect this device</u);
  });

  await context.test(
    'connection disclosure appears only in the native Connect confirmation',
    () => {
      const disconnected = renderDrawer(
        viewState({ connection: 'disconnected' }),
        true,
      );
      assert.match(disconnected, />Connect Google Drive</u);
      assert.doesNotMatch(
        disconnected,
        /developer approval|request access|mailto:|sync-access-notice/iu,
      );

      const dialog = renderToStaticMarkup(
        createElement(GoogleDriveAccessDialog, {
          onCancel() {},
          onContinue() {},
        }),
      );
      assert.match(dialog, /^<dialog/u);
      assert.match(dialog, /aria-describedby="google-drive-access-description"/u);
      assert.match(dialog, /aria-labelledby="google-drive-access-title"/u);
      assert.match(dialog, />Google Drive Access<\/h2>/u);
      assert.match(dialog, /Connecting opens Google(?:&#x27;|')s permission screen/u);
      assert.match(dialog, /requests only access to files it creates/u);
      assert.doesNotMatch(dialog, /mailto:|request access/iu);
      assert.match(dialog, />Cancel<\/button>/u);
      assert.match(dialog, />Continue to Google<\/button>/u);

      const controlSource = source('../src/sync/PaperSyncControl.tsx');
      assert.match(controlSource, /onClick=\{onRequestConnect\}/u);
      assert.match(
        controlSource,
        /onCancel=\{\(\) => setDriveAccessConfirmationOpen\(false\)\}/u,
      );
      assert.match(
        controlSource,
        /onCancel=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?onCancel\(\);/u,
      );
      assert.match(
        controlSource,
        /if \(connectAttemptRef\.current\) return;[\s\S]*?const attempt = coordinator\.connect\(\);/u,
      );
      assert.match(
        controlSource,
        /deviceModeAttemptRef\.current[\s\S]*?setDeviceModeAttemptPending\(true\)[\s\S]*?coordinator\.setDeviceMode\(mode\)/u,
      );
      assert.match(
        controlSource,
        /39note:workspace-changing[\s\S]*?setDriveAccessConfirmationOpen\(false\)/u,
      );
      assert.match(
        controlSource,
        /const interactionBusy =[\s\S]*?busy \|\|[\s\S]*?connectAttemptPending \|\|[\s\S]*?deviceModeAttemptPending \|\|[\s\S]*?state\.restorePublicationHold\?\.status === 'revalidating'/u,
      );
      assert.match(
        controlSource,
        /<PaperPrimaryActions[\s\S]*?busy=\{interactionBusy\}/u,
      );
      assert.match(
        controlSource,
        /aria-label="Auto sync"[\s\S]*?disabled=\{[\s\S]*?interactionBusy \|\|/u,
      );
      assert.match(
        controlSource,
        /onChange=\{\(\) => onSelectDeviceMode\('personal'\)\}/u,
      );
      assert.match(
        controlSource,
        /onChange=\{\(\) => onSelectDeviceMode\('temporary'\)\}/u,
      );
      assert.doesNotMatch(
        controlSource,
        /onClick=\{\(\) => void coordinator\.connect\(\)/u,
      );
      assert.match(
        controlSource,
        /returnFocus\?\.isConnected\) returnFocus\.focus\(\{ preventScroll: true \}\)/u,
      );
      assert.match(controlSource, /if \(event\.key !== 'Tab'\) return/u);

      const css = source('../src/styles/index.css');
      assert.match(css, /\.sync-access-dialog::backdrop/u);
      assert.match(css, /\.sync-access-dialog\s*\{[^}]*var\(--surface-raised\)/su);
      assert.match(
        css,
        /@media \(max-width: 700px\)[\s\S]*?\.theme-root \.sync-access-dialog/u,
      );
    },
  );

  await context.test(
    'restore publication hold stays local and requires an explicit accessible revalidation',
    () => {
      const held = viewState({
        connection: 'connected',
        rootUrl: 'https://drive.google.com/drive/folders/root',
        autoSync: true,
        dirtyPaperIds: ['restored-document'],
        restorePublicationHold: {
          status: 'waiting',
          restoredDocumentCount: 1,
        },
      });
      assert.equal(paperSyncStatusLabel(held), 'Restore sync paused');
      assert.equal(getPaperSyncUiStatus(held), 'pending');
      const markup = renderDrawer(held, true);
      assert.match(markup, /Restored work is saved locally/u);
      assert.match(markup, /Local reading and editing remain available/u);
      assert.match(markup, /saved Auto sync preference has not changed/u);
      assert.match(markup, />Review and resume Google Drive sync</u);
      assert.match(
        markup,
        /aria-label="Auto sync" disabled="" type="checkbox" checked=""/u,
      );
      assert.match(markup, />Disconnect this device</u);
      assert.doesNotMatch(markup, />Disconnect all devices</u);
      assert.doesNotMatch(markup, /Paper folder names|Legacy Drive data/u);

      const dialog = renderToStaticMarkup(
        createElement(RestorePublicationResumeDialog, {
          busy: false,
          onCancel() {},
          onContinue() {},
        }),
      );
      assert.match(dialog, /^<dialog/u);
      assert.match(
        dialog,
        /aria-describedby="restore-publication-resume-description"/u,
      );
      assert.match(dialog, /aria-labelledby="restore-publication-resume-title"/u);
      assert.match(dialog, />Resume Google Drive sync\?<\/h2>/u);
      assert.match(dialog, /This review does not upload the restored Library/u);
      assert.match(dialog, /If anything is ambiguous, restored work stays local/u);
      assert.match(dialog, /saved Auto sync setting becomes active again/u);
      assert.match(dialog, />Cancel<\/button>/u);
      assert.match(dialog, />Revalidate and resume<\/button>/u);

      const failed = renderDrawer(
        viewState({
          ...held,
          restorePublicationHold: {
            status: 'failed',
            restoredDocumentCount: 1,
            error: 'Account verification failed. Publication remains blocked.',
          },
        }),
      );
      assert.match(
        failed,
        /role="alert">Account verification failed\. Publication remains blocked\./u,
      );

      const sourceText = source('../src/sync/PaperSyncControl.tsx');
      assert.match(
        sourceText,
        /resumeAfterRestorePublication\('resume-restored-library'\)/u,
      );
      assert.match(sourceText, /if \(!busy\) onCancel\(\)/u);
      assert.match(sourceText, /if \(event\.key !== 'Tab'\) return/u);
    },
  );

  await context.test(
    'Advanced presents read-only legacy counts, safe details, and a deliberate confirmation',
    () => {
      const inventory = legacyInventory();
      const markup = renderDrawer(
        viewState({
          rootUrl: 'https://drive.google.com/drive/folders/root',
          legacyHousekeeping: { status: 'ready', inventory },
        }),
        true,
      );
      assert.match(markup, /<summary>Advanced<\/summary>/u);
      assert.match(markup, />Check legacy Drive data</u);
      assert.match(markup, /Current paper data<\/dt><dd>4/u);
      assert.match(markup, /Recognized legacy items<\/dt><dd>2/u);
      assert.match(markup, /Unknown\/unclassified items<\/dt><dd>1/u);
      assert.match(markup, /<summary>Inventory details<\/summary>/u);
      assert.match(markup, /legacy-library\.json/u);
      assert.match(markup, /Unknown — preserved/u);
      assert.match(markup, /Eligible for Drive Trash after explicit confirmation/u);
      assert.doesNotMatch(markup, /legacy-file-id|unknown-file-id/u);
      assert.match(markup, />Remove recognized legacy data</u);

      const confirmation = renderToStaticMarkup(
        createElement(LegacyCleanupConfirmation, {
          inventory,
          busy: false,
          onConfirm() {},
          onCancel() {},
        }),
      );
      assert.match(confirmation, /role="group"/u);
      assert.match(confirmation, /2 recognized legacy items were found/u);
      assert.match(confirmation, /1 unknown\/unclassified item will be preserved/u);
      assert.match(
        confirmation,
        /Current paper and Drive control data will be preserved/u,
      );
      assert.match(
        confirmation,
        /Only positively identified obsolete 39Note global-v1 data is targeted/u,
      );
      assert.match(confirmation, />Move recognized legacy data to Trash</u);
      assert.match(confirmation, />Cancel</u);
    },
  );

  await context.test(
    'Advanced previews folder normalization and requires an explicit name-only confirmation',
    () => {
      const preview = paperFolderNamePreview();
      const markup = renderDrawer(
        viewState({
          rootUrl: 'https://drive.google.com/drive/folders/root',
          folderNameMaintenance: { status: 'ready', preview },
        }),
        true,
      );
      assert.match(markup, /Paper folder names/u);
      assert.match(markup, />Preview folder name changes</u);
      assert.match(markup, /1 verified paper folder can be normalized/u);
      assert.match(markup, /Review\.PDF/u);
      assert.match(markup, /→ Review/u);
      assert.match(markup, />Normalize paper folder names</u);
      assert.doesNotMatch(markup, /folder-id|document-id/u);

      const confirmation = renderToStaticMarkup(
        createElement(PaperFolderNameNormalizationConfirmation, {
          preview,
          busy: false,
          onConfirm() {},
          onCancel() {},
        }),
      );
      assert.match(confirmation, /role="group"/u);
      assert.match(confirmation, /removing only a final “\.pdf” extension/u);
      assert.match(confirmation, /This changes folder names only/u);
      assert.match(confirmation, /source filenames/u);
      assert.match(confirmation, /Same-name folders remain separate/u);
      assert.match(confirmation, />Normalize paper folder names</u);
      assert.match(confirmation, />Cancel</u);
    },
  );

  await context.test(
    'folder normalization coordinator rejects missing or stale confirmation state',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      await assert.rejects(
        coordinator.normalizePaperFolderNames('wrong-token' as never),
        /Explicit confirmation is required/u,
      );
      assert.equal(
        PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION,
        'normalize-paper-folder-names',
      );
      await assert.rejects(
        coordinator.normalizePaperFolderNames(
          PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION,
        ),
        /sync must finish connecting/u,
      );
    },
  );

  await context.test('legacy cleanup failure stays visible and actionable', () => {
    const markup = renderDrawer(
      viewState({
        rootUrl: 'https://drive.google.com/drive/folders/root',
        legacyHousekeeping: {
          status: 'failed',
          inventory: legacyInventory(),
          error: 'Legacy cleanup stopped. Remaining data was preserved.',
        },
      }),
      true,
    );
    assert.match(
      markup,
      /role="alert">Legacy cleanup stopped\. Remaining data was preserved\./u,
    );
    assert.match(markup, />Check legacy Drive data</u);
    assert.doesNotMatch(markup, />Remove recognized legacy data</u);
  });

  await context.test(
    'one paper update remains separate from the connected global state',
    () => {
      const state = remoteUpdateView(['doc-c']);
      assert.equal(getPaperSyncUiStatus(state), 'connected');
      assert.equal(paperSyncStatusLabel(state), 'Connected');
      const markup = renderDrawer(state);
      assert.match(markup, /role="status">Connected</u);
      assert.match(markup, />1 paper update available</u);
      assert.doesNotMatch(markup, />Not connected</u);
    },
  );

  await context.test(
    'Reader update affordance carries the exact affected document IDs',
    () => {
      const state = remoteUpdateView(['doc-c']);
      let routedIds: readonly string[] | undefined;
      const element = ReaderSyncStatusPill({
        state,
        onOpenDrive(documentIds) {
          routedIds = documentIds;
        },
      });
      element.props.onClick();
      assert.deepEqual(routedIds, ['doc-c']);

      const markup = renderToStaticMarkup(
        createElement(ReaderSyncStatusPill, {
          state,
          onOpenDrive() {},
        }),
      );
      assert.match(markup, /Google Drive sync: Connected\./u);
      assert.match(markup, />Drive · Connected</u);
      assert.match(markup, />Update available</u);
    },
  );

  await context.test(
    'five cloud papers with one affected ID render one selected update row',
    () => {
      const state = remoteUpdateView(['doc-c']);
      const rows = paperRows(state, 'updates', ['doc-c']);
      assert.deepEqual(
        rows.map((row) => row.documentId),
        ['doc-c'],
      );
      assert.equal(rows[0].statusLabel, 'Update available');

      const markup = renderSelector(state, 'updates', ['doc-c']);
      assert.match(markup, /Updates available \(1\)/u);
      assert.match(markup, /checked=""/u);
      assert.match(markup, />DOC-C</u);
      assert.doesNotMatch(markup, />DOC-[ABDE]</u);
      assert.match(markup, />Keep local · Replace Drive version</u);
      assert.match(markup, />Browse all Drive papers</u);
    },
  );

  await context.test(
    'explicit Browse Drive papers still shows all papers with updates first',
    () => {
      const state = remoteUpdateView(['doc-c']);
      const rows = paperRows(state, 'download');
      assert.equal(rows.length, 5);
      assert.equal(rows[0].documentId, 'doc-c');
      assert.equal(rows[0].statusLabel, 'Update available');
      assert.equal(rows.filter((row) => row.updateAvailable).length, 1);
      const markup = renderSelector(state, 'download');
      assert.match(markup, /Google Drive papers/u);
      assert.equal((markup.match(/>DOC-[A-E]</gu) ?? []).length, 5);
      assert.ok(markup.indexOf('DOC-C') < markup.indexOf('DOC-A'));
      assert.match(markup, /is-update-available/u);
    },
  );

  await context.test('two affected IDs exclude every unrelated cloud paper', () => {
    const state = remoteUpdateView(['doc-b', 'doc-e']);
    const rows = paperRows(state, 'updates', ['doc-b', 'doc-e']);
    assert.deepEqual(
      rows.map((row) => row.documentId),
      ['doc-b', 'doc-e'],
    );
    const markup = renderSelector(state, 'updates', ['doc-b', 'doc-e']);
    assert.match(markup, /Updates available \(2\)/u);
    assert.match(markup, />DOC-B</u);
    assert.match(markup, />DOC-E</u);
    assert.doesNotMatch(markup, />DOC-[ACD]</u);
  });

  await context.test(
    'navigation preserves IDs rather than reopening the catalog',
    () => {
      const app = source('../src/components/AppLayout.tsx');
      assert.match(
        app,
        /openDriveUpdateReview[\s\S]*?new Set\(affectedDocumentIds\)[\s\S]*?documentIds/u,
      );
      assert.match(app, /updateReviewRequest=\{paperUpdateReviewRequest\}/u);
      assert.match(app, /onReviewUpdates=\{openDriveUpdateReview\}/u);
      const control = source('../src/sync/PaperSyncControl.tsx');
      assert.match(
        control,
        /mode: 'updates',[\s\S]*?affectedDocumentIds: \[\.\.\.updateReviewRequest\.documentIds\]/u,
      );
    },
  );

  await context.test(
    'successful final download clears reminder, review rows, and Reader update state',
    () => {
      const before = remoteUpdateView(['doc-c']);
      const afterStates = before.paperStates.map((state) => ({
        ...state,
        status: 'synced' as const,
        incorporatedHeadIds: [...state.remoteHeadIds],
      }));
      const reminder = nextRemoteUpdateReminder(
        before.reminder,
        before.papers,
        new Map(
          afterStates.map((state) => [state.documentId, { status: state.status }]),
        ),
        new Set(before.reminder?.seenStateIds),
      );
      const after = viewState({
        ...before,
        paperStates: afterStates,
        reminder,
        lastSuccessfulAt: 20,
      });
      assert.equal(reminder, undefined);
      assert.deepEqual(paperRows(after, 'updates', ['doc-c']), []);
      assert.equal(readerPaperSyncLabel(after), 'Synced');
      assert.doesNotMatch(renderDrawer(after), /paper update available/u);
      assert.deepEqual(
        afterStates
          .filter((state) => state.documentId !== 'doc-c')
          .map((state) => [state.documentId, state.status]),
        before.paperStates
          .filter((state) => state.documentId !== 'doc-c')
          .map((state) => [state.documentId, state.status]),
      );
    },
  );

  await context.test(
    'Keep local clears update UI only after verified convergence, not on failure',
    () => {
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const start = coordinatorSource.indexOf('\n  keepLocalSelected(');
      const end = coordinatorSource.indexOf('async dismissRemoteUpdates(', start);
      const method = coordinatorSource.slice(start, end);
      const reconcile = method.indexOf('await repository.reconcileKeepLocalPaper(');
      const apply = method.indexOf('this.applyPublishResult(', reconcile);
      const clearDismissal = method.indexOf(
        'delete state.dismissedRemoteHeadIds',
        apply,
      );
      const failure = method.indexOf('this.markPaperFailure(', reconcile);
      assert.ok(start >= 0 && end > start);
      assert.ok(reconcile >= 0 && apply > reconcile && clearDismissal > apply);
      assert.ok(failure > reconcile);

      const failed = remoteUpdateView(['doc-c']);
      assert.ok(failed.reminder);
      assert.equal(readerPaperSyncLabel(failed), 'Connected');
      assert.match(renderDrawer(failed), />1 paper update available</u);

      const convergedStates = failed.paperStates.map((state) =>
        state.documentId === 'doc-c'
          ? {
              ...state,
              status: 'synced' as const,
              incorporatedHeadIds: [...state.remoteHeadIds],
            }
          : state,
      );
      assert.equal(
        nextRemoteUpdateReminder(
          failed.reminder,
          failed.papers,
          new Map(convergedStates.map((state) => [state.documentId, state] as const)),
        ),
        undefined,
      );
    },
  );

  await context.test(
    'paper-scoped attention keeps authentication connected and aggregates globally',
    () => {
      const paper = cloudPaper('doc-c', 'head-c');
      paper.status = 'needs-attention';
      const state = viewState({
        connection: 'connected',
        lastSuccessfulAt: 10,
        papers: [paper],
        paperStates: [{ ...paperState('doc-c'), status: 'needs-attention' as const }],
      });
      assert.equal(state.connection, 'connected');
      assert.equal(getBlockingPaperIssueCount(state), 1);
      assert.equal(getPaperSyncUiStatus(state), 'attention');
      assert.equal(
        paperSyncStatusLabel(state),
        'Connected · Needs attention — 1 paper',
      );
      assert.deepEqual(
        paperRows(
          { ...state, reminder: remoteUpdateView(['doc-c']).reminder },
          'updates',
          ['doc-c'],
        ).map((row) => row.documentId),
        ['doc-c'],
      );
      const markup = renderDrawer(state);
      assert.match(markup, /role="status">Connected · Needs attention — 1 paper</u);
      assert.match(markup, />Retry now</u);
      assert.doesNotMatch(markup, />Not connected</u);

      const paperOnly = viewState({
        connection: 'connected',
        papers: [paper],
        paperStates: [],
      });
      const stateOnly = viewState({
        connection: 'connected',
        papers: [],
        paperStates: [{ ...paperState('doc-c'), status: 'needs-attention' as const }],
      });
      assert.equal(getBlockingPaperIssueCount(paperOnly), 1);
      assert.equal(getBlockingPaperIssueCount(stateOnly), 1);

      const secondPaper = cloudPaper('doc-d', 'head-d');
      secondPaper.status = 'needs-attention';
      assert.equal(
        getBlockingPaperIssueCount(
          viewState({
            papers: [paper, secondPaper],
            paperStates: [
              { ...paperState('doc-c'), status: 'needs-attention' as const },
            ],
          }),
        ),
        2,
      );

      const clearedPaper = { ...paper, status: 'synced' as const };
      const cleared = viewState({
        connection: 'connected',
        lastSuccessfulAt: 10,
        papers: [clearedPaper],
        paperStates: [{ ...paperState('doc-c'), status: 'synced' as const }],
      });
      assert.equal(getPaperSyncUiStatus(cleared), 'synced');
      assert.equal(paperSyncStatusLabel(cleared), 'Synced');
    },
  );

  await context.test(
    'durable background work does not expose an unscoped fake Cancel control',
    () => {
      const markup = renderDrawer(viewState({ connection: 'syncing' }));
      assert.doesNotMatch(markup, />Cancel</u);
      assert.doesNotMatch(
        source('../src/sync/PaperSyncControl.tsx'),
        /coordinator\.cancel\(\)/u,
      );
    },
  );

  await context.test('global root and layout blocks keep their specific labels', () => {
    for (const [connection, label] of [
      ['root-selection-required', 'Choose Drive folder'],
      ['root-unavailable', 'Drive folder unavailable'],
      ['layout-upgrade-required', 'Drive upgrade required'],
      ['migration-incomplete', 'Drive upgrade incomplete'],
    ] as const) {
      const markup = renderDrawer(viewState({ connection }));
      assert.match(markup, new RegExp(`role="status">${label}`));
      assert.doesNotMatch(markup, />Not connected</u);
    }
  });
});

test('device choice and account ownership fail closed before Drive work', async (context) => {
  const temporaryWorkspaceId = '7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';
  const alternateTemporaryWorkspaceId = '8b45e4a2-2e3f-4b6c-9d7e-2345678901bc';
  const activeTemporaryWorkspaceKey = '39note.workspace.temporary.v1';
  const temporarySyncDatabaseName = `39note-sync--temporary--${temporaryWorkspaceId}`;
  const sessionValues = new Map<string, string>();
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage',
  );
  const sessionStorageDouble: Storage = {
    get length() {
      return sessionValues.size;
    },
    clear() {
      sessionValues.clear();
    },
    getItem(key) {
      return sessionValues.get(key) ?? null;
    },
    key(index) {
      return [...sessionValues.keys()][index] ?? null;
    },
    removeItem(key) {
      sessionValues.delete(key);
    },
    setItem(key, value) {
      sessionValues.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: sessionStorageDouble,
  });
  context.after(() => {
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', sessionStorageDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });

  const invokePrivate = async <T>(
    target: object,
    name: string,
    ...args: unknown[]
  ): Promise<T> => {
    const method = Reflect.get(target, name);
    assert.equal(typeof method, 'function');
    return Reflect.apply(method, target, args) as Promise<T>;
  };

  const profile = (
    overrides: Partial<PaperSyncDeviceProfile> = {},
  ): PaperSyncDeviceProfile => ({
    id: 'paper-device',
    deviceId: 'device-security',
    deviceLabel: 'Security test device',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    ...overrides,
  });

  const configureCoordinator = (
    configuredProfile: PaperSyncDeviceProfile,
    accountId: string | null,
    state = viewState(),
  ) => {
    const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'profile', configuredProfile);
    Reflect.set(coordinator, 'identity', {
      hasDeviceSession: accountId !== null,
      accountId,
    });
    Reflect.set(coordinator, 'view', state);
    if (configuredProfile.deviceMode === 'temporary') {
      Reflect.set(coordinator, 'temporaryWorkspaceId', temporaryWorkspaceId);
    }
    return coordinator;
  };

  const activateTemporaryWorkspace = () => {
    sessionStorageDouble.setItem(
      activeTemporaryWorkspaceKey,
      JSON.stringify({ version: 1, id: temporaryWorkspaceId }),
    );
  };

  const setTemporaryProvenance = (
    accountId: string,
    options: {
      workspaceId?: string;
      finishPhase?:
        'active' | 'uploading' | 'revoking' | 'cleaning' | 'cleanup-incomplete';
    } = {},
  ) => {
    activateTemporaryWorkspace();
    let database = securityDatabaseRecords.get(temporarySyncDatabaseName);
    if (!database) {
      database = new Map();
      securityDatabaseRecords.set(temporarySyncDatabaseName, database);
    }
    let store = database.get('temporary-session');
    if (!store) {
      store = new Map();
      database.set('temporary-session', store);
    }
    store.set('temporary', {
      id: 'temporary',
      temporarySessionId: options.workspaceId ?? temporaryWorkspaceId,
      accountId,
      createdAt: 1,
      documentIds: [],
      collectionIds: [],
      finishPhase: options.finishPhase ?? 'active',
    });
  };

  const clearTemporaryProvenance = (keepWorkspaceActive = false) => {
    securityDatabaseRecords
      .get(temporarySyncDatabaseName)
      ?.get('temporary-session')
      ?.delete('temporary');
    if (!keepWorkspaceActive) {
      sessionStorageDouble.removeItem(activeTemporaryWorkspaceKey);
    }
  };
  context.after(clearTemporaryProvenance);

  await context.test(
    'publication hold blocks mode changes, disconnect-all, autosync, and background scans',
    async () => {
      const coordinator = configureCoordinator(profile(), 'account-a');
      const hold = {
        operationId: '9d44a3b0-4ed6-4f79-8561-df8825c8f18a',
        workspaceId: 'personal',
        phase: 'publication-hold',
        generation: 7,
        createdAt: 1,
        recoveryRequired: false,
        publicationHold: true,
        remoteRevalidationRequired: true,
      };
      Reflect.set(coordinator, 'restorePublicationOperation', hold);
      Reflect.set(
        coordinator,
        'view',
        viewState({
          restorePublicationHold: {
            status: 'waiting',
            restoredDocumentCount: 1,
          },
        }),
      );
      let scans = 0;
      Reflect.set(coordinator, 'scanCloudPapers', async () => {
        scans += 1;
      });

      await assert.rejects(
        coordinator.setDeviceMode('temporary'),
        /reviewing the restored Library/u,
      );
      await assert.rejects(
        coordinator.disconnectAll(),
        /Disconnect-all is unavailable/u,
      );
      await assert.rejects(coordinator.setAutoSync(false), /Auto sync cannot change/u);
      assert.equal(Reflect.get(coordinator, 'profile').autoSync, true);
      await assert.rejects(
        coordinator.resumeAfterRestorePublication('wrong' as never),
        /explicit user authorization/u,
      );
      assert.equal(
        await invokePrivate<boolean>(coordinator, 'isAutoSyncEffectivelyEnabled'),
        false,
      );
      await invokePrivate<void>(coordinator, 'handleOnline');
      await Promise.resolve();
      assert.equal(scans, 0, 'online event started a Drive scan under hold');
    },
  );

  await context.test(
    'first Connect has no preselected mode and cannot start OAuth before a choice',
    async () => {
      const unconfirmed = viewState({
        connection: 'disconnected',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: false,
        autoSync: false,
        securityState: { kind: 'device-mode-required' },
      });
      const markup = renderDrawer(unconfirmed);
      assert.match(markup, /How are you using this device\?/u);
      assert.match(markup, />Personal device</u);
      assert.match(markup, />Public \/ temporary device</u);
      const radioInputs = markup.match(/<input[^>]*type="radio"[^>]*>/gu) ?? [];
      assert.equal(radioInputs.length, 2);
      assert.ok(radioInputs.every((input) => !input.includes('checked')));
      assert.match(
        markup,
        /<button disabled="" type="button">Connect Google Drive<\/button>/u,
      );

      let authorizationCalls = 0;
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
      Reflect.set(coordinator, 'view', unconfirmed);
      Reflect.set(coordinator, 'identity', {
        hasDeviceSession: false,
        beginAuthorization() {
          authorizationCalls += 1;
          return Promise.reject(new Error('OAuth must not start.'));
        },
      });

      await assert.rejects(
        () => coordinator.connect(),
        DeviceModeSelectionRequiredError,
      );
      assert.equal(authorizationCalls, 0);
      assert.equal(coordinator.getSnapshot().connection, 'disconnected');
      assert.equal(coordinator.getSnapshot().issue?.code, 'device-mode-required');
    },
  );

  await context.test(
    'Public mode with no managed root cannot create one through discovery, Retry, or replacement recovery',
    async () => {
      setTemporaryProvenance('account-a');
      const publicProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
      });
      const publicView = viewState({
        connection: 'connected',
        deviceMode: 'temporary',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
      });
      const coordinator = configureCoordinator(publicProfile, 'account-a', publicView);
      const drive = new DriveClient(() => 'synthetic-access-token');
      let listCalls = 0;
      let createCalls = 0;
      Reflect.set(drive, 'listFiles', async () => {
        listCalls += 1;
        return [];
      });
      Reflect.set(drive, 'createFolder', async () => {
        createCalls += 1;
        throw new Error('Public mode must never create a root.');
      });
      Reflect.set(coordinator, 'drive', drive);

      await assert.rejects(
        () =>
          invokePrivate(
            coordinator,
            'ensureRepository',
            new AbortController().signal,
            false,
          ),
        PublicDeviceRootMissingError,
      );
      assert.equal(listCalls, 2);
      assert.equal(createCalls, 0);

      await assert.rejects(
        () => coordinator.scanCloudPapers(),
        PublicDeviceRootMissingError,
      );
      assert.equal(createCalls, 0);

      await assert.rejects(() => coordinator.retryNow(), PublicDeviceRootMissingError);
      assert.equal(createCalls, 0);
      assert.equal(
        coordinator.getSnapshot().securityState?.kind,
        'public-root-missing',
      );
      assert.equal(coordinator.getSnapshot().issue?.code, 'public-root-missing');

      await assert.rejects(
        () => coordinator.createReplacementRoot(),
        PublicDeviceRootMissingError,
      );
      assert.equal(createCalls, 0);

      const recoveryMarkup = renderDrawer(
        viewState({
          connection: 'root-unavailable',
          deviceMode: 'temporary',
          deviceModeChoiceConfirmed: true,
          autoSync: false,
        }),
      );
      assert.doesNotMatch(recoveryMarkup, /Create replacement folder/u);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'Public root discovery failure cannot fall back to creation',
    async () => {
      setTemporaryProvenance('account-a');
      const coordinator = configureCoordinator(
        profile({
          deviceMode: 'temporary',
          autoSync: false,
          workspaceAccountId: undefined,
        }),
        'account-a',
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      const drive = new DriveClient(() => 'synthetic-access-token');
      let createCalls = 0;
      Reflect.set(drive, 'listFiles', async () => {
        throw new DriveNetworkError();
      });
      Reflect.set(drive, 'createFolder', async () => {
        createCalls += 1;
        throw new Error('Discovery failure must never become root creation.');
      });
      Reflect.set(coordinator, 'drive', drive);

      await assert.rejects(() => coordinator.scanCloudPapers(), DriveNetworkError);
      assert.equal(createCalls, 0);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'Public mode can validate an already verified existing root without a write',
    async () => {
      setTemporaryProvenance('account-a');
      const coordinator = configureCoordinator(
        profile({
          deviceMode: 'temporary',
          autoSync: false,
          workspaceAccountId: undefined,
          rootFolderId: 'existing-root',
        }),
        'account-a',
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      Reflect.set(
        coordinator,
        'drive',
        new DriveClient(() => 'synthetic-access-token'),
      );
      let activeRootChecks = 0;
      const repository = {
        async assertActiveRoot() {
          activeRootChecks += 1;
        },
      };
      Reflect.set(coordinator, 'repository', repository);

      const signal = await invokePrivate<AbortSignal>(
        coordinator,
        'beginOperation',
        'scan',
      );
      try {
        assert.equal(
          await invokePrivate(coordinator, 'ensureRepository', signal, true),
          repository,
        );
      } finally {
        Reflect.apply(Reflect.get(coordinator, 'endOperation'), coordinator, [signal]);
      }
      assert.equal(activeRootChecks, 1);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'Public OAuth arms the temporary-workspace return handoff before navigation',
    async () => {
      const publicProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
      });
      const coordinator = configureCoordinator(
        publicProfile,
        null,
        viewState({
          connection: 'disconnected',
          deviceMode: 'temporary',
          deviceModeChoiceConfirmed: true,
          autoSync: false,
        }),
      );
      let authorizationOptions:
        | {
            beforeNavigation?: () => void | Promise<void>;
            onNavigationFailure?: () => void | Promise<void>;
          }
        | undefined;
      Reflect.set(coordinator, 'identity', {
        hasDeviceSession: false,
        accountId: null,
        beginAuthorization(options: {
          beforeNavigation?: () => void | Promise<void>;
          onNavigationFailure?: () => void | Promise<void>;
        }) {
          authorizationOptions = options;
          return Promise.reject(new GoogleAuthorizationStartError('request-failed'));
        },
      });

      await assert.rejects(coordinator.connect(), GoogleAuthorizationStartError);
      assert.equal(typeof authorizationOptions?.beforeNavigation, 'function');
      assert.equal(
        authorizationOptions?.beforeNavigation?.name,
        'armTemporaryWorkspaceOAuthReturn',
      );
      assert.equal(typeof authorizationOptions?.onNavigationFailure, 'function');
      assert.equal(
        authorizationOptions?.onNavigationFailure?.name,
        'clearTemporaryWorkspaceOAuthReturn',
      );
    },
  );

  await context.test(
    'temporary provenance blocks account B before profile overwrite or queued account-A publication',
    async () => {
      setTemporaryProvenance('account-a');
      const dirty = paperState('temporary-account-a-paper', ['notes']);
      const publicProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
        accountId: 'account-a',
      });
      const coordinator = configureCoordinator(
        publicProfile,
        'account-b',
        viewState({
          connection: 'connecting',
          deviceMode: 'temporary',
          autoSync: false,
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));
      let driveReads = 0;
      const drive = new DriveClient(() => 'synthetic-access-token');
      Reflect.set(drive, 'listFiles', async () => {
        driveReads += 1;
        return [];
      });
      Reflect.set(coordinator, 'drive', drive);

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'resolveAuthorizedAccount'),
        false,
      );
      assert.equal(publicProfile.accountId, 'account-a');
      assert.equal(
        Reflect.get(coordinator, 'temporaryWorkspaceAccountId'),
        'account-a',
      );
      assert.equal(coordinator.getSnapshot().securityState?.kind, 'account-mismatch');
      assert.equal(coordinator.getSnapshot().autoSync, false);

      await assert.rejects(
        () => coordinator.uploadSelected([dirty.documentId]),
        WorkspaceAccountMismatchError,
      );
      assert.equal(driveReads, 0);
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
      assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [dirty.documentId]);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'Public mode refuses to initialize an existing empty root',
    async () => {
      const coordinator = configureCoordinator(
        profile({
          deviceMode: 'temporary',
          autoSync: false,
          workspaceAccountId: undefined,
          rootFolderId: 'existing-empty-root',
        }),
        'account-a',
        viewState({
          deviceMode: 'temporary',
          deviceModeChoiceConfirmed: true,
          autoSync: false,
        }),
      );
      let initializationWrites = 0;
      const repository = {
        async detectLayout() {
          return { state: 'empty' };
        },
        async initializeEmptyLayout() {
          initializationWrites += 1;
        },
      };
      await assert.rejects(
        () =>
          invokePrivate(
            coordinator,
            'assertActiveLayout',
            repository,
            new AbortController().signal,
          ),
        PublicDeviceRootMissingError,
      );
      assert.equal(initializationWrites, 0);
    },
  );

  await context.test(
    'a verified account mismatch blocks autosync, manual Upload, and Retry without touching local edits',
    async () => {
      const dirty = paperState('doc-account-a', ['notes']);
      const configuredProfile = profile({
        accountId: 'account-b',
        workspaceAccountId: 'account-a',
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-b',
        viewState({
          connection: 'connected',
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));
      const drive = new DriveClient(() => 'synthetic-access-token');
      let driveReads = 0;
      Reflect.set(drive, 'listFiles', async () => {
        driveReads += 1;
        return [];
      });
      Reflect.set(coordinator, 'drive', drive);

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'isAutoSyncEffectivelyEnabled'),
        false,
      );
      await invokePrivate<void>(coordinator, 'scheduleAutoUpload');
      assert.equal(Reflect.get(coordinator, 'autoUploadTimer'), null);

      await assert.rejects(
        () => coordinator.uploadSelected([dirty.documentId]),
        WorkspaceAccountMismatchError,
      );
      assert.equal(coordinator.getSnapshot().securityState?.kind, 'account-mismatch');
      assert.equal(coordinator.getSnapshot().autoSync, false);
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
      assert.equal(driveReads, 0);

      await assert.rejects(() => coordinator.retryNow(), WorkspaceAccountMismatchError);
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
      assert.equal(driveReads, 0);
      assert.deepEqual(
        await invokePrivate<string[]>(coordinator, 'getAutoSyncEligibleDirtyPaperIds'),
        [],
      );
    },
  );

  await context.test(
    'account mismatch directly blocks Download, Keep local, and Restore before repository work',
    async () => {
      const download = paperState('doc-download', [], 'cloud-only');
      const keepLocal = paperState('doc-keep-local', ['notes']);
      keepLocal.status = 'both-changed';
      keepLocal.cloudPresence = 'present';
      keepLocal.remoteHeadIds = ['remote-head'];
      const restore = paperState('doc-restore', ['annotations']);
      restore.status = 'local-only';
      restore.cloudPresence = 'removed';

      const coordinator = configureCoordinator(
        profile({ accountId: 'account-b', workspaceAccountId: 'account-a' }),
        'account-b',
        viewState({
          paperStates: [download, keepLocal, restore],
          dirtyPaperIds: [keepLocal.documentId, restore.documentId],
        }),
      );
      Reflect.set(
        coordinator,
        'paperStates',
        new Map(
          [download, keepLocal, restore].map((state) => [state.documentId, state]),
        ),
      );
      let repositoryCalls = 0;
      Reflect.set(coordinator, 'repository', {
        async assertActiveRoot() {
          repositoryCalls += 1;
          throw new Error('Repository work must not start for another account.');
        },
      });

      await assert.rejects(
        () => coordinator.downloadSelected([download.documentId]),
        WorkspaceAccountMismatchError,
      );
      await assert.rejects(
        () => coordinator.keepLocalSelected([keepLocal.documentId]),
        WorkspaceAccountMismatchError,
      );
      await assert.rejects(
        () => coordinator.restoreToGoogleDrive(restore.documentId),
        WorkspaceAccountMismatchError,
      );

      assert.equal(repositoryCalls, 0);
      assert.deepEqual(keepLocal.dirtyReasons, ['notes']);
      assert.deepEqual(restore.dirtyReasons, ['annotations']);
      assert.equal(keepLocal.status, 'both-changed');
      assert.equal(restore.cloudPresence, 'removed');
      assert.equal(coordinator.getSnapshot().securityState?.kind, 'account-mismatch');
      assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);
    },
  );

  await context.test(
    'account mismatch presents explicit reconnect and disconnect recovery without exposing identities',
    () => {
      const mismatch = viewState({
        connection: 'attention',
        autoSync: false,
        securityState: { kind: 'account-mismatch' },
      });
      const markup = renderDrawer(mismatch);
      assert.match(markup, />Google account mismatch</u);
      assert.match(markup, />Reconnect with original account</u);
      assert.match(markup, />Disconnect</u);
      assert.match(markup, /Sync has been paused to protect your papers/u);
      assert.match(markup, /Auto sync is enabled, it may resume only after/u);
      assert.doesNotMatch(markup, /account-a|account-b/u);
      assert.deepEqual(
        classifyPaperCoordinatorError(new WorkspaceAccountMismatchError()).actions,
        ['reconnect', 'disconnect', 'details'],
      );
    },
  );

  await context.test(
    'Reconnect with original account detaches one mismatched session and preserves binding and queued edits',
    async () => {
      const dirty = paperState('doc-reconnect-original', ['notes']);
      const configuredProfile = profile({
        accountId: 'account-b',
        workspaceAccountId: 'account-a',
        googleDeviceSessionToken: 's'.repeat(43),
        autoSync: true,
      });
      await savePaperSyncDeviceProfile(configuredProfile, {
        authentication: 'replace',
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-b',
        viewState({
          connection: 'attention',
          autoSync: false,
          securityState: { kind: 'account-mismatch' },
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));

      let disconnectCalls = 0;
      let authorizationCalls = 0;
      let authorizationOptions:
        { forceConsent?: boolean; switchAccount?: boolean } | undefined;
      let rejectAuthorization!: (error: Error) => void;
      let markAuthorizationStarted!: () => void;
      const authorizationStarted = new Promise<void>((resolve) => {
        markAuthorizationStarted = resolve;
      });
      const authorizationGate = new Promise<never>((_resolve, reject) => {
        rejectAuthorization = reject;
      });
      const identity = {
        hasDeviceSession: true,
        accountId: 'account-b' as string | null,
        async disconnectCurrent() {
          disconnectCalls += 1;
          this.hasDeviceSession = false;
          this.accountId = null;
        },
        beginAuthorization(options: {
          forceConsent?: boolean;
          switchAccount?: boolean;
        }) {
          authorizationCalls += 1;
          authorizationOptions = options;
          markAuthorizationStarted();
          return authorizationGate;
        },
      };
      Reflect.set(coordinator, 'identity', identity);

      const first = coordinator.reconnectOriginalAccount();
      const duplicate = coordinator.reconnectOriginalAccount();
      assert.strictEqual(duplicate, first);
      await authorizationStarted;

      assert.equal(disconnectCalls, 1);
      assert.equal(authorizationCalls, 1);
      assert.equal(authorizationOptions?.forceConsent, true);
      assert.equal(authorizationOptions?.switchAccount, true);
      const persisted = await loadPaperSyncDeviceProfile();
      assert.equal(persisted.workspaceAccountId, 'account-a');
      assert.equal(persisted.accountId, undefined);
      assert.equal(persisted.googleDeviceSessionToken, undefined);
      assert.equal(persisted.autoSync, true);
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
      assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [dirty.documentId]);

      rejectAuthorization(new GoogleAuthorizationStartError('request-failed'));
      await assert.rejects(first, GoogleAuthorizationStartError);
      await assert.rejects(duplicate, GoogleAuthorizationStartError);
      assert.notEqual(coordinator.getSnapshot().connection, 'connecting');
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
    },
  );

  await context.test(
    'Disconnect from a mismatch preserves the immutable binding and every pending local change',
    async () => {
      const dirty = paperState('doc-mismatch-disconnect', ['annotations', 'notes']);
      const configuredProfile = profile({
        accountId: 'account-b',
        workspaceAccountId: 'account-a',
        googleDeviceSessionToken: 'd'.repeat(43),
        autoSync: true,
      });
      await savePaperSyncDeviceProfile(configuredProfile, {
        authentication: 'replace',
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-b',
        viewState({
          connection: 'attention',
          autoSync: false,
          securityState: { kind: 'account-mismatch' },
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));
      let disconnectCalls = 0;
      const identity = {
        hasDeviceSession: true,
        accountId: 'account-b' as string | null,
        async disconnectCurrent() {
          disconnectCalls += 1;
          this.hasDeviceSession = false;
          this.accountId = null;
        },
      };
      Reflect.set(coordinator, 'identity', identity);

      await coordinator.disconnect();

      const persisted = await loadPaperSyncDeviceProfile();
      assert.equal(disconnectCalls, 1);
      assert.equal(persisted.workspaceAccountId, 'account-a');
      assert.equal(persisted.accountId, undefined);
      assert.equal(persisted.googleDeviceSessionToken, undefined);
      assert.equal(persisted.autoSync, true);
      assert.deepEqual(dirty.dirtyReasons, ['annotations', 'notes']);
      assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [dirty.documentId]);
      assert.equal(coordinator.getSnapshot().connection, 'disconnected');
      assert.equal(coordinator.getSnapshot().securityState, undefined);
    },
  );

  await context.test(
    'a durable cross-tab disconnect fences an admitted operation before token use',
    async () => {
      const configuredProfile = profile({
        googleDeviceSessionToken: 'x'.repeat(43),
      });
      await savePaperSyncDeviceProfile(configuredProfile, {
        authentication: 'replace',
      });
      let tokenCalls = 0;
      const coordinator = configureCoordinator(configuredProfile, 'account-a');
      Reflect.set(coordinator, 'identity', {
        hasDeviceSession: true,
        accountId: 'account-a',
        async ensureAccessToken() {
          tokenCalls += 1;
          return { value: 'must-not-be-used', expiresAt: Date.now() + 60_000 };
        },
      });
      const signal = await invokePrivate<AbortSignal>(
        coordinator,
        'beginOperation',
        'upload',
      );
      const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      let driveRequests = 0;
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async () => {
          driveRequests += 1;
          return new Response('{}', { status: 200 });
        },
      });
      try {
        await savePaperSyncDeviceProfile(
          {
            ...configuredProfile,
            accountId: undefined,
            googleDeviceSessionToken: undefined,
          },
          { authentication: 'replace' },
        );
        await savePaperSyncDeviceProfile({
          ...configuredProfile,
          lastSuccessfulAt: 123,
        });
        const afterStaleSettlement = await loadPaperSyncDeviceProfile();
        assert.equal(afterStaleSettlement.workspaceAccountId, 'account-a');
        assert.equal(afterStaleSettlement.accountId, undefined);
        assert.equal(afterStaleSettlement.googleDeviceSessionToken, undefined);
        assert.equal(afterStaleSettlement.lastSuccessfulAt, 123);
        const drive = Reflect.apply(
          Reflect.get(coordinator, 'requireDrive'),
          coordinator,
          [],
        ) as InstanceType<typeof DriveClient>;
        await assert.rejects(
          () => drive.getMetadata('synthetic-file', signal),
          WorkspaceAccountMismatchError,
        );
        assert.equal(tokenCalls, 0);
        assert.equal(driveRequests, 0);
      } finally {
        Reflect.apply(Reflect.get(coordinator, 'endOperation'), coordinator, [signal]);
        await savePaperSyncDeviceProfile(configuredProfile, {
          authentication: 'replace',
        });
        if (fetchDescriptor) {
          Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, 'fetch');
        }
      }
    },
  );

  await context.test(
    'token refresh cannot switch an admitted operation from account A to account B',
    async () => {
      const configuredProfile = profile();
      await savePaperSyncDeviceProfile(configuredProfile, {
        authentication: 'replace',
      });
      const identity = {
        hasDeviceSession: true,
        accountId: 'account-a',
        async ensureAccessToken() {
          this.accountId = 'account-b';
          return { value: 'account-b-token', expiresAt: Date.now() + 60_000 };
        },
      };
      const coordinator = configureCoordinator(configuredProfile, 'account-a');
      Reflect.set(coordinator, 'identity', identity);
      const signal = await invokePrivate<AbortSignal>(
        coordinator,
        'beginOperation',
        'upload',
      );
      const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      let driveRequests = 0;
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: async () => {
          driveRequests += 1;
          return new Response('{}', { status: 200 });
        },
      });
      try {
        const drive = Reflect.apply(
          Reflect.get(coordinator, 'requireDrive'),
          coordinator,
          [],
        ) as InstanceType<typeof DriveClient>;
        await assert.rejects(
          () => drive.getMetadata('synthetic-file', signal),
          WorkspaceAccountMismatchError,
        );
        assert.equal(identity.accountId, 'account-b');
        assert.deepEqual(configuredProfile.workspaceAccountId, 'account-a');
        assert.equal(driveRequests, 0);
      } finally {
        Reflect.apply(Reflect.get(coordinator, 'endOperation'), coordinator, [signal]);
        if (fetchDescriptor) {
          Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, 'fetch');
        }
      }
    },
  );

  await context.test(
    'the verified same account preserves the dirty queue and auto sync without an association prompt',
    async () => {
      const dirty = paperState('doc-same-account', ['notes']);
      const configuredProfile = profile();
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-a',
        viewState({
          connection: 'attention',
          autoSync: false,
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
          securityState: { kind: 'account-association-required' },
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'resolveAuthorizedAccount'),
        true,
      );
      assert.equal(coordinator.getSnapshot().securityState, undefined);
      assert.equal(coordinator.getSnapshot().issue, undefined);
      assert.equal(coordinator.getSnapshot().autoSync, true);
      assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [dirty.documentId]);
      assert.deepEqual(dirty.dirtyReasons, ['notes']);
      assert.equal(
        await invokePrivate<boolean>(coordinator, 'isAutoSyncEffectivelyEnabled'),
        true,
      );
      assert.deepEqual(
        await invokePrivate<string[]>(coordinator, 'getAutoSyncEligibleDirtyPaperIds'),
        [dirty.documentId],
      );
      assert.doesNotMatch(
        renderDrawer(coordinator.getSnapshot()),
        /Confirm this Library’s Google account/u,
      );
    },
  );

  await context.test(
    'an unavailable verified identity disables auto sync and blocks Upload and Retry before Drive reads',
    async () => {
      const dirty = paperState('doc-identity-unavailable', ['annotations']);
      const coordinator = configureCoordinator(
        profile(),
        null,
        viewState({
          connection: 'connecting',
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));
      const drive = new DriveClient(() => 'synthetic-access-token');
      let driveReads = 0;
      Reflect.set(drive, 'listFiles', async () => {
        driveReads += 1;
        return [];
      });
      Reflect.set(coordinator, 'drive', drive);

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'resolveAuthorizedAccount'),
        false,
      );
      assert.equal(
        coordinator.getSnapshot().securityState?.kind,
        'account-identity-unavailable',
      );
      assert.equal(
        coordinator.getSnapshot().issue?.code,
        'account-identity-unavailable',
      );
      assert.equal(coordinator.getSnapshot().autoSync, false);
      assert.equal(
        await invokePrivate<boolean>(coordinator, 'isAutoSyncEffectivelyEnabled'),
        false,
      );

      await assert.rejects(
        () => coordinator.uploadSelected([dirty.documentId]),
        WorkspaceAccountIdentityUnavailableError,
      );
      await assert.rejects(
        () => coordinator.retryNow(),
        WorkspaceAccountIdentityUnavailableError,
      );
      assert.equal(driveReads, 0);
      assert.deepEqual(dirty.dirtyReasons, ['annotations']);
      assert.deepEqual(coordinator.getSnapshot().dirtyPaperIds, [dirty.documentId]);
      assert.equal(
        (Reflect.get(coordinator, 'operationOwner') as { active: boolean }).active,
        false,
      );
    },
  );

  await context.test(
    'a queued operation revalidates account ownership after FIFO admission',
    async () => {
      const configuredProfile = profile();
      const identity = { hasDeviceSession: true, accountId: 'account-a' as string };
      const coordinator = configureCoordinator(configuredProfile, identity.accountId);
      Reflect.set(coordinator, 'identity', identity);
      Reflect.set(
        coordinator,
        'drive',
        new DriveClient(() => 'synthetic-access-token'),
      );
      const begin = Reflect.get(coordinator, 'beginOperation') as (
        operationType: 'scan' | 'upload',
      ) => Promise<AbortSignal>;
      const end = Reflect.get(coordinator, 'endOperation') as (
        signal: AbortSignal,
      ) => void;
      const owner = Reflect.get(coordinator, 'operationOwner') as {
        active: boolean;
      };

      const first = await begin.call(coordinator, 'scan');
      const queued = begin.call(coordinator, 'upload');
      await Promise.resolve();
      assert.equal(owner.active, true);

      identity.accountId = 'account-b';
      end.call(coordinator, first);
      await assert.rejects(queued, WorkspaceAccountMismatchError);
      assert.equal(owner.active, false);

      identity.accountId = 'account-a';
      const next = await begin.call(coordinator, 'scan');
      assert.equal(owner.active, true);
      end.call(coordinator, next);
      assert.equal(owner.active, false);
    },
  );

  await context.test(
    'a queued temporary operation rereads durable provenance after FIFO admission',
    async () => {
      setTemporaryProvenance('account-a');
      const configuredProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
      });
      const identity = { hasDeviceSession: true, accountId: 'account-a' };
      const coordinator = configureCoordinator(
        configuredProfile,
        identity.accountId,
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'identity', identity);
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      Reflect.set(
        coordinator,
        'drive',
        new DriveClient(() => 'synthetic-access-token'),
      );
      const begin = Reflect.get(coordinator, 'beginOperation') as (
        operationType: 'scan' | 'upload',
      ) => Promise<AbortSignal>;
      const end = Reflect.get(coordinator, 'endOperation') as (
        signal: AbortSignal,
      ) => void;
      const owner = Reflect.get(coordinator, 'operationOwner') as {
        active: boolean;
      };

      const first = await begin.call(coordinator, 'scan');
      const queued = begin.call(coordinator, 'upload');
      await Promise.resolve();
      setTemporaryProvenance('account-b');
      end.call(coordinator, first);

      await assert.rejects(queued, WorkspaceAccountMismatchError);
      assert.equal(owner.active, false);
      assert.equal(configuredProfile.accountId, 'account-a');
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'temporary operation admission rejects provenance from another workspace UUID',
    async () => {
      setTemporaryProvenance('account-a', {
        workspaceId: alternateTemporaryWorkspaceId,
      });
      const configuredProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-a',
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      Reflect.set(
        coordinator,
        'drive',
        new DriveClient(() => 'synthetic-access-token'),
      );

      await assert.rejects(
        () => invokePrivate<AbortSignal>(coordinator, 'beginOperation', 'scan'),
        WorkspaceAccountMismatchError,
      );
      assert.equal(Reflect.get(coordinator, 'operationOwner').active, false);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'an established temporary profile cannot heal deleted provenance',
    async () => {
      activateTemporaryWorkspace();
      clearTemporaryProvenance(true);
      const configuredProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
        accountId: 'account-a',
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-a',
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'resolveAuthorizedAccount'),
        false,
      );
      assert.equal(configuredProfile.accountId, 'account-a');
      assert.equal(coordinator.getSnapshot().securityState?.kind, 'account-mismatch');
      assert.equal(
        securityDatabaseRecords
          .get(temporarySyncDatabaseName)
          ?.get('temporary-session')
          ?.has('temporary') ?? false,
        false,
      );
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'temporary lifecycle phases admit only the Finish upload phase',
    async () => {
      const configuredProfile = profile({
        deviceMode: 'temporary',
        autoSync: false,
        workspaceAccountId: undefined,
      });
      const coordinator = configureCoordinator(
        configuredProfile,
        'account-a',
        viewState({ deviceMode: 'temporary', autoSync: false }),
      );
      Reflect.set(coordinator, 'temporaryWorkspaceAccountId', 'account-a');
      Reflect.set(
        coordinator,
        'drive',
        new DriveClient(() => 'synthetic-access-token'),
      );

      setTemporaryProvenance('account-a', { finishPhase: 'cleanup-incomplete' });
      await assert.rejects(
        () => invokePrivate<AbortSignal>(coordinator, 'beginOperation', 'upload'),
        WorkspaceAccountMismatchError,
      );

      setTemporaryProvenance('account-a', { finishPhase: 'uploading' });
      const uploadSignal = await invokePrivate<AbortSignal>(
        coordinator,
        'beginOperation',
        'upload',
      );
      Reflect.apply(Reflect.get(coordinator, 'endOperation'), coordinator, [
        uploadSignal,
      ]);
      await assert.rejects(
        () => invokePrivate<AbortSignal>(coordinator, 'beginOperation', 'scan'),
        WorkspaceAccountMismatchError,
      );
      assert.equal(Reflect.get(coordinator, 'operationOwner').active, false);
      clearTemporaryProvenance();
    },
  );

  await context.test(
    'a populated legacy workspace remains unbound until explicit account adoption',
    async () => {
      const dirty = paperState('legacy-local-paper', ['annotations']);
      const legacyProfile = profile({
        // Released account-switch logic could leave exactly this state after
        // clearing account A's root/baselines and accepting account B.
        accountId: 'verified-account-b',
        workspaceAccountId: undefined,
        rootFolderId: undefined,
        driveChangeCursor: undefined,
      });
      const coordinator = configureCoordinator(
        legacyProfile,
        'verified-account-b',
        viewState({
          connection: 'connecting',
          dirtyPaperIds: [dirty.documentId],
          paperStates: [dirty],
        }),
      );
      Reflect.set(coordinator, 'paperStates', new Map([[dirty.documentId, dirty]]));

      assert.equal(
        await invokePrivate<boolean>(coordinator, 'resolveAuthorizedAccount'),
        false,
      );
      assert.equal(legacyProfile.workspaceAccountId, undefined);
      assert.deepEqual(dirty.dirtyReasons, ['annotations']);
      assert.equal(
        coordinator.getSnapshot().securityState?.kind,
        'account-association-required',
      );
      assert.equal(
        coordinator.getSnapshot().issue?.code,
        'account-association-required',
      );

      const markup = renderDrawer(coordinator.getSnapshot());
      assert.match(markup, /Confirm this Library’s Google account/u);
      assert.match(markup, />Associate this local Library<\/button>/u);
      assert.match(markup, /This step does not upload anything/u);

      await assert.rejects(
        () => coordinator.uploadSelected([dirty.documentId]),
        WorkspaceAccountAssociationRequiredError,
      );
      assert.deepEqual(dirty.dirtyReasons, ['annotations']);
    },
  );

  await context.test(
    'explicit legacy adoption binds only the verified account without publishing',
    async () => {
      await closeSyncPersistenceWorkspace();
      securityDatabaseRecords.delete('39note-sync');
      const legacyProfile = profile({
        accountId: 'verified-account-a',
        workspaceAccountId: undefined,
        rootFolderId: undefined,
        driveChangeCursor: undefined,
      });
      const profileStore = new Map<string, Record<string, unknown>>();
      profileStore.set('paper-device', structuredClone(legacyProfile));
      securityDatabaseRecords.set(
        '39note-sync',
        new Map([['paper-device', profileStore]]),
      );

      const coordinator = configureCoordinator(
        legacyProfile,
        'verified-account-a',
        viewState({
          connection: 'attention',
          autoSync: false,
          securityState: { kind: 'account-association-required' },
        }),
      );
      let DriveOperations = 0;
      Reflect.set(coordinator, 'drive', {
        listFiles() {
          DriveOperations += 1;
        },
        createFolder() {
          DriveOperations += 1;
        },
      });

      try {
        await coordinator.adoptCurrentAccountForWorkspace();
        assert.equal(DriveOperations, 0);
        const boundProfile = Reflect.get(
          coordinator,
          'profile',
        ) as PaperSyncDeviceProfile;
        assert.notEqual(boundProfile, legacyProfile);
        assert.equal(boundProfile.workspaceAccountId, 'verified-account-a');
        assert.equal(boundProfile.accountId, 'verified-account-a');
        assert.equal(boundProfile.autoSync, false);
        assert.equal(legacyProfile.workspaceAccountId, undefined);
        assert.equal(coordinator.getSnapshot().securityState, undefined);
        assert.equal(coordinator.getSnapshot().connection, 'connected');
        assert.equal(coordinator.getSnapshot().autoSync, false);

        await closeSyncPersistenceWorkspace();
        const reopened = await loadPaperSyncDeviceProfile();
        assert.equal(reopened.workspaceAccountId, 'verified-account-a');
        assert.equal(reopened.deviceModeChoiceConfirmed, true);
        assert.equal(reopened.autoSync, false);
      } finally {
        await closeSyncPersistenceWorkspace();
        securityDatabaseRecords.delete('39note-sync');
      }
    },
  );

  await context.test(
    'legacy account identity is promoted only with old root-bound evidence',
    () => {
      const risky = profile({
        accountId: 'account-b',
        workspaceAccountId: undefined,
        rootFolderId: undefined,
        driveChangeCursor: undefined,
      });
      assert.equal(trustedLegacyWorkspaceAccountId(risky), undefined);

      const rootBound = profile({
        accountId: 'account-a',
        workspaceAccountId: undefined,
        rootFolderId: 'root-a',
        deviceModeChoiceConfirmed: undefined,
      });
      assert.equal(trustedLegacyWorkspaceAccountId(rootBound), 'account-a');

      const cursorBound = profile({
        accountId: 'account-b',
        workspaceAccountId: undefined,
        rootFolderId: 'root-a',
        deviceModeChoiceConfirmed: undefined,
        driveChangeCursor: {
          version: 1,
          accountId: 'account-a',
          rootFolderId: 'root-a',
          deviceMode: 'personal',
          pageToken: 'cursor-a',
          lastFullAuditAt: 1,
        },
      });
      assert.equal(trustedLegacyWorkspaceAccountId(cursorBound), 'account-a');

      const returnedWrongAccountAfterGate = profile({
        accountId: 'account-b',
        workspaceAccountId: undefined,
        rootFolderId: 'root-a',
        driveChangeCursor: undefined,
        deviceModeChoiceConfirmed: true,
      });
      assert.equal(
        trustedLegacyWorkspaceAccountId(returnedWrongAccountAfterGate),
        undefined,
      );
    },
  );

  await context.test(
    'a callback mode mismatch is rejected before profile persistence or Drive scan',
    () => {
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const mismatchGuard = coordinatorSource.indexOf(
        'if (exchange.sessionMode !== profile.deviceMode)',
      );
      const profilePersistence = coordinatorSource.indexOf(
        'await savePaperSyncDeviceProfile(',
        mismatchGuard,
      );
      const accountResolution = coordinatorSource.indexOf(
        'await this.resolveAuthorizedAccount()',
        mismatchGuard,
      );
      const DriveScan = coordinatorSource.indexOf(
        'await this.scanCloudPapersOwned(false)',
        mismatchGuard,
      );
      assert.ok(mismatchGuard >= 0);
      assert.ok(profilePersistence > mismatchGuard);
      assert.match(
        coordinatorSource.slice(profilePersistence, profilePersistence + 240),
        /profile,\s*\{ authentication: 'replace' \},\s*workspaceLease/u,
      );
      assert.ok(accountResolution > mismatchGuard);
      assert.ok(DriveScan > mismatchGuard);
    },
  );

  await context.test(
    'a temporary callback account is checked and cleared before profile persistence',
    () => {
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const callbackStart = coordinatorSource.indexOf(
        'const exchange = await this.identity.completeAuthorizationIfPresent()',
      );
      const accountGuard = coordinatorSource.indexOf(
        'this.assertTemporaryWorkspaceAccountClaim(exchange.accountId)',
        callbackStart,
      );
      const clearRejectedSession = coordinatorSource.indexOf(
        'this.identity.clearLocalSession()',
        accountGuard,
      );
      const profileOverwrite = coordinatorSource.indexOf(
        'profile.accountId = exchange.accountId',
        callbackStart,
      );
      const profilePersistence = coordinatorSource.indexOf(
        'await savePaperSyncDeviceProfile(',
        profileOverwrite,
      );

      assert.ok(callbackStart >= 0);
      assert.ok(accountGuard > callbackStart);
      assert.ok(clearRejectedSession > accountGuard);
      assert.ok(profileOverwrite > clearRejectedSession);
      assert.ok(profilePersistence > profileOverwrite);
      assert.match(
        coordinatorSource.slice(profilePersistence, profilePersistence + 240),
        /profile,\s*\{ authentication: 'replace' \},\s*workspaceLease/u,
      );
    },
  );

  await context.test(
    'leaving an empty temporary workspace persists the explicit Personal choice before reload',
    () => {
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      const modeMethod = coordinatorSource.indexOf(
        'async setDeviceMode(mode: SyncDeviceMode)',
      );
      const leaveTemporary = coordinatorSource.indexOf(
        'await leaveEmptyTemporaryWorkspace()',
        modeMethod,
      );
      const loadPersonal = coordinatorSource.indexOf(
        'const personalProfile = await loadPaperSyncDeviceProfile()',
        leaveTemporary,
      );
      const confirmPersonal = coordinatorSource.indexOf(
        'personalProfile.deviceModeChoiceConfirmed = true',
        loadPersonal,
      );
      const savePersonal = coordinatorSource.indexOf(
        'await savePaperSyncDeviceProfile(',
        confirmPersonal,
      );
      const reload = coordinatorSource.indexOf(
        'reloadForWorkspaceChange()',
        savePersonal,
      );

      assert.ok(modeMethod >= 0);
      assert.ok(leaveTemporary > modeMethod);
      assert.ok(loadPersonal > leaveTemporary);
      assert.ok(confirmPersonal > loadPersonal);
      assert.ok(savePersonal > confirmPersonal);
      assert.match(
        coordinatorSource.slice(savePersonal, savePersonal + 220),
        /personalProfile,\s*\{\},\s*workspaceLease/u,
      );
      assert.ok(reload > savePersonal);
    },
  );
});

test('incremental Drive discovery preserves a race-free durable cursor', async (context) => {
  const profile = (
    overrides: Partial<PaperSyncDeviceProfile> = {},
  ): PaperSyncDeviceProfile => ({
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    deviceMode: 'personal',
    deviceModeChoiceConfirmed: true,
    autoSync: true,
    accountId: 'account-a',
    workspaceAccountId: 'account-a',
    rootFolderId: 'root-a',
    driveChangeCursor: {
      version: 1,
      accountId: 'account-a',
      rootFolderId: 'root-a',
      deviceMode: 'personal',
      pageToken: 'cursor-a',
      lastFullAuditAt: Date.now(),
    },
    ...overrides,
  });
  const managedChange = (documentId: string) => ({
    fileId: `manifest-${documentId}`,
    removed: false,
    file: {
      id: `manifest-${documentId}`,
      name: `${documentId}.json`,
      mimeType: 'application/json',
      appProperties: {
        application: '39Note',
        role: 'paper-manifest-generation',
        documentId,
      },
    },
  });
  const invokePrivate = async <T>(
    target: object,
    name: string,
    ...args: unknown[]
  ): Promise<T> => {
    const method = Reflect.get(target, name);
    assert.equal(typeof method, 'function');
    return Reflect.apply(method, target, args) as Promise<T>;
  };
  const coordinator = (
    configuredProfile: PaperSyncDeviceProfile,
    papers: PaperCloudSummary[] = [],
  ) => {
    const instance = new PaperGoogleDriveSyncCoordinator({ notify() {} });
    Reflect.set(instance, 'profile', configuredProfile);
    Reflect.set(instance, 'identity', {
      hasDeviceSession: true,
      accountId: configuredProfile.accountId ?? null,
    });
    Reflect.set(
      instance,
      'view',
      viewState({
        deviceMode: configuredProfile.deviceMode,
        deviceModeChoiceConfirmed: configuredProfile.deviceModeChoiceConfirmed === true,
        papers,
      }),
    );
    return instance;
  };

  const recognizedRoot = (id: string, name = '39Note') => ({
    id,
    name,
    mimeType: 'application/vnd.google-apps.folder',
    trashed: false,
    ownedByMe: true,
    appProperties: {
      application: '39Note',
      role: 'root',
      layoutVersion: '2',
      paperProtocolVersion: '2',
    },
  });

  await context.test(
    'active root discovery finds a renamed root on its exhaustive confirmation pass',
    async () => {
      const queries: string[] = [];
      const renamed = recognizedRoot('renamed-root', 'My research papers');
      const roots = await discoverPaperRootsBeforeCreation(
        {
          async listFiles(query: string) {
            queries.push(query);
            return queries.length === 1 ? [] : [renamed];
          },
        },
        new AbortController().signal,
      );
      assert.deepEqual(roots, [renamed]);
      assert.equal(queries.length, 2);
      assert.ok(queries.every((query) => !query.includes("name='39Note'")));
    },
  );

  await context.test(
    'a concurrent root discovered after creation fails closed before local binding',
    async () => {
      const created = recognizedRoot('created-root');
      const competitor = recognizedRoot('concurrent-root', 'Renamed elsewhere');
      const confirmed = await confirmCreatedPaperRoot(
        {
          async listFiles() {
            return [competitor];
          },
        },
        created,
        new AbortController().signal,
      );
      assert.deepEqual(
        confirmed.map((root) => root.id),
        ['concurrent-root', 'created-root'],
      );

      const configuredProfile = profile({
        rootFolderId: undefined,
        driveChangeCursor: undefined,
      });
      const instance = coordinator(configuredProfile);
      Reflect.set(instance, 'identity', {
        hasDeviceSession: true,
        accountId: 'account-a',
      });
      let listCalls = 0;
      Reflect.set(instance, 'drive', {
        async listFiles() {
          listCalls += 1;
          return listCalls <= 2 ? [] : [competitor];
        },
        async createFolder() {
          return created;
        },
      });
      await assert.rejects(
        () =>
          invokePrivate(
            instance,
            'ensureRepository',
            new AbortController().signal,
            false,
          ),
        AmbiguousPaperFolderError,
      );
      assert.equal(configuredProfile.rootFolderId, undefined);
      assert.equal(instance.getSnapshot().connection, 'root-selection-required');
      assert.equal(instance.getSnapshot().rootChoices.length, 2);
    },
  );

  await context.test(
    'a missing cached active root cannot trigger discovery or replacement',
    async () => {
      const instance = coordinator(profile({ rootFolderId: 'missing-root' }));
      Reflect.set(instance, 'identity', {
        hasDeviceSession: true,
        accountId: 'account-a',
      });
      let listCalls = 0;
      let createCalls = 0;
      Reflect.set(instance, 'drive', {
        async getMetadata() {
          throw new DriveRequestError('missing', 404, 'not-found', 'metadata');
        },
        async listFiles() {
          listCalls += 1;
          return [];
        },
        async createFolder() {
          createCalls += 1;
          return recognizedRoot('replacement-root');
        },
      });
      await assert.rejects(
        () =>
          invokePrivate(
            instance,
            'ensureRepository',
            new AbortController().signal,
            false,
          ),
        PaperRepositoryError,
      );
      assert.equal(listCalls, 0);
      assert.equal(createCalls, 0);
      assert.equal(instance.getSnapshot().connection, 'root-unavailable');
    },
  );

  await context.test(
    'the baseline gets a token first, discovers, replays, durably applies, then commits',
    async () => {
      const events: string[] = [];
      const instance = coordinator(profile({ driveChangeCursor: undefined }));
      Reflect.set(instance, 'drive', {
        async getStartPageToken() {
          events.push('start-token');
          return 'baseline-token';
        },
        async listChanges(token: string) {
          events.push(`replay:${token}`);
          return {
            changes: [managedChange('doc-new')],
            newStartPageToken: 'after-replay',
            pages: 2,
          };
        },
      });
      const baseline = [cloudPaper('doc-existing', 'existing-head')];
      const replayed = [...baseline, cloudPaper('doc-new', 'new-head')];
      const repository = {
        rootFolderId: 'root-a',
        async discover() {
          events.push('exhaustive-discovery');
          return baseline;
        },
      };
      Reflect.set(instance, 'assertActiveLayout', async () => {
        events.push('layout-validation');
      });
      Reflect.set(
        instance,
        'applyScopedDiscovery',
        async (
          _repository: unknown,
          ids: string[],
          _signal: unknown,
          seen: unknown,
        ) => {
          assert.deepEqual(ids, ['doc-new']);
          assert.equal(seen, baseline);
          events.push('paper-scoped-replay');
          return replayed;
        },
      );
      Reflect.set(instance, 'applyDiscovery', async (papers: PaperCloudSummary[]) => {
        assert.deepEqual(papers, replayed);
        events.push('durable-apply');
      });
      Reflect.set(
        instance,
        'commitDriveChangeCursor',
        async (token: string, lastFullAuditAt: number) => {
          assert.equal(token, 'after-replay');
          assert.ok(lastFullAuditAt <= Date.now());
          events.push('cursor-commit');
        },
      );

      await invokePrivate(
        instance,
        'runAuthoritativeBaseline',
        repository,
        new AbortController().signal,
      );
      assert.deepEqual(events, [
        'start-token',
        'layout-validation',
        'exhaustive-discovery',
        'replay:baseline-token',
        'paper-scoped-replay',
        'durable-apply',
        'cursor-commit',
      ]);
    },
  );

  await context.test(
    'an abort after discovery, replay, or local apply cannot settle a late baseline cursor',
    async () => {
      for (const boundary of ['discovery', 'replay', 'apply'] as const) {
        const instance = coordinator(profile({ driveChangeCursor: undefined }));
        const controller = new AbortController();
        const timeout = new DriveOperationTimeoutError('scan', 90_000, false);
        let release!: (value: unknown) => void;
        let entered!: () => void;
        const enteredBoundary = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const boundaryGate = new Promise<unknown>((resolve) => {
          release = resolve;
        });
        let replayCalls = 0;
        let applyCalls = 0;
        let cursorCommits = 0;
        Reflect.set(instance, 'drive', {
          async getStartPageToken() {
            return 'baseline-token';
          },
          async listChanges() {
            replayCalls += 1;
            if (boundary === 'replay') {
              entered();
              return boundaryGate;
            }
            return { changes: [], newStartPageToken: 'late-cursor', pages: 1 };
          },
        });
        Reflect.set(instance, 'assertActiveLayout', async () => undefined);
        Reflect.set(instance, 'applyDiscovery', async () => {
          applyCalls += 1;
          if (boundary === 'apply') {
            entered();
            await boundaryGate;
          }
        });
        Reflect.set(instance, 'commitDriveChangeCursor', async () => {
          cursorCommits += 1;
        });
        const repository = {
          rootFolderId: 'root-a',
          async discover() {
            if (boundary === 'discovery') {
              entered();
              return boundaryGate;
            }
            return [];
          },
        };
        const operation = invokePrivate(
          instance,
          'runAuthoritativeBaseline',
          repository,
          controller.signal,
        );
        await enteredBoundary;
        controller.abort(timeout);
        release(
          boundary === 'discovery'
            ? []
            : boundary === 'replay'
              ? { changes: [], newStartPageToken: 'late-cursor', pages: 1 }
              : undefined,
        );

        await assert.rejects(operation, (error: unknown) => error === timeout);
        assert.equal(replayCalls, boundary === 'discovery' ? 0 : 1);
        assert.equal(applyCalls, boundary === 'apply' ? 1 : 0);
        assert.equal(cursorCommits, 0);
      }
    },
  );

  await context.test(
    'failed durable application cannot advance the replay cursor',
    async () => {
      const instance = coordinator(profile({ driveChangeCursor: undefined }));
      let cursorCommitted = false;
      Reflect.set(instance, 'drive', {
        async getStartPageToken() {
          return 'baseline-token';
        },
        async listChanges() {
          return { changes: [], newStartPageToken: 'must-not-commit', pages: 1 };
        },
      });
      Reflect.set(instance, 'assertActiveLayout', async () => undefined);
      Reflect.set(instance, 'applyDiscovery', async () => {
        throw new Error('injected local persistence failure');
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        cursorCommitted = true;
      });
      await assert.rejects(() =>
        invokePrivate(
          instance,
          'runAuthoritativeBaseline',
          {
            rootFolderId: 'root-a',
            async discover() {
              return [];
            },
          },
          new AbortController().signal,
        ),
      );
      assert.equal(cursorCommitted, false);
    },
  );

  await context.test(
    'a full baseline cannot forget a previously known cloud paper or advance its cursor',
    async () => {
      const existing = cloudPaper('doc-a', 'head-a');
      const instance = coordinator(profile({ driveChangeCursor: undefined }), [
        existing,
      ]);
      let applied: PaperCloudSummary[] = [];
      let cursorCommitted = false;
      Reflect.set(instance, 'drive', {
        async getStartPageToken() {
          return 'baseline-token';
        },
        async listChanges() {
          return { changes: [], newStartPageToken: 'must-not-commit', pages: 1 };
        },
      });
      Reflect.set(instance, 'assertActiveLayout', async () => undefined);
      Reflect.set(instance, 'applyDiscovery', async (papers: PaperCloudSummary[]) => {
        applied = papers;
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        cursorCommitted = true;
      });

      await assert.rejects(
        () =>
          invokePrivate(
            instance,
            'runAuthoritativeBaseline',
            {
              rootFolderId: 'root-a',
              async discover() {
                return [];
              },
            },
            new AbortController().signal,
          ),
        PaperManifestIntegrityError,
      );
      assert.equal(applied.length, 1);
      assert.equal(applied[0].documentId, 'doc-a');
      assert.equal(applied[0].status, 'needs-attention');
      assert.equal(cursorCommitted, false);
    },
  );

  await context.test(
    'a fail-closed scoped result retains the cursor for exact retry',
    async () => {
      const existing = cloudPaper('doc-a', 'head-a');
      const instance = coordinator(profile(), [existing]);
      let cursorCommitted = false;
      Reflect.set(instance, 'drive', {
        async listChanges() {
          return {
            changes: [managedChange('doc-a')],
            newStartPageToken: 'must-not-commit',
            pages: 1,
          };
        },
      });
      const failed = {
        ...existing,
        status: 'needs-attention' as const,
        issue: {
          code: 'paper-integrity-failed',
          message: 'Drive paper data needs verification.',
        },
      };
      Reflect.set(instance, 'applyScopedDiscovery', async () => [failed]);
      Reflect.set(instance, 'applyDiscovery', async () => undefined);
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        cursorCommitted = true;
      });
      await assert.rejects(
        () =>
          invokePrivate(
            instance,
            'discoverWithFastPath',
            { rootFolderId: 'root-a', async assertActiveRoot() {} },
            new AbortController().signal,
          ),
        PaperManifestIntegrityError,
      );
      assert.equal(cursorCommitted, false);
    },
  );

  await context.test(
    'a known immutable-file removal remains visible and cannot advance the cursor',
    async () => {
      const existing = {
        ...cloudPaper('doc-a', 'head-a'),
        managedFileIds: ['payload-a'],
      };
      const instance = coordinator(profile(), [existing]);
      let applied: PaperCloudSummary[] = [];
      let cursorCommitted = false;
      Reflect.set(instance, 'drive', {
        async listChanges() {
          return {
            changes: [{ fileId: 'payload-a', removed: true }],
            newStartPageToken: 'must-not-commit',
            pages: 1,
          };
        },
      });
      Reflect.set(instance, 'applyScopedDiscovery', async () => [existing]);
      Reflect.set(instance, 'applyDiscovery', async (papers: PaperCloudSummary[]) => {
        applied = papers;
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        cursorCommitted = true;
      });
      await assert.rejects(() =>
        invokePrivate(
          instance,
          'discoverWithFastPath',
          { rootFolderId: 'root-a', async assertActiveRoot() {} },
          new AbortController().signal,
        ),
      );
      assert.equal(applied[0].status, 'needs-attention');
      assert.deepEqual(applied[0].managedFileIds, ['payload-a']);
      assert.equal(cursorCommitted, false);
    },
  );

  await context.test(
    'a verified removed presence supersedes a removed-file invalidation without attention',
    async () => {
      const existing = {
        ...cloudPaper('doc-a', 'head-a'),
        managedFileIds: ['payload-a'],
      };
      const removed: PaperCloudSummary = {
        ...existing,
        headIds: [],
        headSetId: 'removed-presence-head',
        presenceState: 'removed',
        presenceHeadIds: ['removed-presence-head'],
        localAvailability: 'local-only',
        status: 'local-only',
        cleanupPending: false,
      };
      const instance = coordinator(profile(), [existing]);
      let applied: PaperCloudSummary[] = [];
      let committed = false;
      Reflect.set(instance, 'drive', {
        async listChanges() {
          return {
            changes: [{ fileId: 'payload-a', removed: true }],
            newStartPageToken: 'cursor-after-removal',
            pages: 1,
          };
        },
      });
      Reflect.set(instance, 'applyScopedDiscovery', async () => [removed]);
      Reflect.set(instance, 'applyDiscovery', async (papers: PaperCloudSummary[]) => {
        applied = papers;
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        committed = true;
      });

      await invokePrivate(
        instance,
        'discoverWithFastPath',
        { rootFolderId: 'root-a', async assertActiveRoot() {} },
        new AbortController().signal,
      );

      assert.equal(applied[0].presenceState, 'removed');
      assert.equal(applied[0].status, 'local-only');
      assert.equal(applied[0].issue, undefined);
      assert.equal(committed, true);
    },
  );

  await context.test(
    'an unchanged normal scan performs only the root guard and change feed',
    async () => {
      const events: string[] = [];
      let driveRequests = 0;
      const instance = coordinator(profile());
      Reflect.set(instance, 'drive', {
        async listChanges(token: string) {
          driveRequests += 1;
          events.push(`changes:${token}`);
          return { changes: [], newStartPageToken: 'cursor-b', pages: 1 };
        },
      });
      Reflect.set(instance, 'runAuthoritativeBaseline', async () => {
        assert.fail('unchanged incremental discovery must not run a full audit');
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        events.push('cursor-commit');
      });
      await invokePrivate(
        instance,
        'discoverWithFastPath',
        {
          rootFolderId: 'root-a',
          async assertActiveRoot() {
            driveRequests += 1;
            events.push('root-metadata');
          },
          async discover() {
            assert.fail('unchanged incremental discovery must not list manifests');
          },
          async discoverPapers() {
            assert.fail('unchanged incremental discovery has no affected paper');
          },
        },
        new AbortController().signal,
      );
      assert.deepEqual(events, ['root-metadata', 'changes:cursor-a', 'cursor-commit']);
      assert.equal(driveRequests, 2);
    },
  );

  await context.test(
    'an ignored-paper invalidation is skipped while the valid cursor still advances',
    async () => {
      const documentId = 'doc-ignored';
      const configuredProfile = profile({
        cloudIssueQuarantines: [
          {
            version: 1,
            documentId,
            accountId: 'account-a',
            rootFolderId: 'root-a',
            reason: 'presence-control-resolution-failed',
            confirmedAt: 100,
          },
        ],
      });
      const instance = coordinator(configuredProfile, [
        { ...cloudPaper(documentId, 'cached-head'), status: 'needs-attention' },
      ]);
      let committedToken: string | undefined;
      Reflect.set(instance, 'drive', {
        async listChanges() {
          return {
            changes: [managedChange(documentId)],
            newStartPageToken: 'cursor-after-ignored-change',
            pages: 1,
          };
        },
      });
      Reflect.set(instance, 'runAuthoritativeBaseline', async () => {
        assert.fail('a local quarantine must not discard a valid global cursor');
      });
      Reflect.set(instance, 'applyScopedDiscovery', async () => {
        assert.fail('an ignored paper must not be re-resolved by ordinary sync');
      });
      Reflect.set(instance, 'applyDiscovery', async () => {
        assert.fail('no paper settlement is needed when only an ignored paper changed');
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async (token: string) => {
        committedToken = token;
      });

      await invokePrivate(
        instance,
        'discoverWithFastPath',
        { rootFolderId: 'root-a', async assertActiveRoot() {} },
        new AbortController().signal,
      );

      assert.equal(committedToken, 'cursor-after-ignored-change');
    },
  );

  await context.test(
    'one changed paper triggers only paper-scoped revalidation before cursor commit',
    async () => {
      const events: string[] = [];
      const existing = cloudPaper('doc-a', 'head-a');
      const instance = coordinator(profile(), [existing]);
      Reflect.set(instance, 'drive', {
        async listChanges() {
          events.push('changes');
          return {
            changes: [managedChange('doc-a'), managedChange('doc-a')],
            newStartPageToken: 'cursor-b',
            pages: 1,
          };
        },
      });
      Reflect.set(instance, 'runAuthoritativeBaseline', async () => {
        assert.fail('a valid paper invalidation must stay paper-scoped');
      });
      const replacement = cloudPaper('doc-a', 'head-b');
      Reflect.set(
        instance,
        'applyScopedDiscovery',
        async (_repo: unknown, ids: string[]) => {
          assert.deepEqual(ids, ['doc-a']);
          events.push('paper:doc-a');
          return [replacement];
        },
      );
      Reflect.set(instance, 'applyDiscovery', async (papers: PaperCloudSummary[]) => {
        assert.deepEqual(papers, [replacement]);
        events.push('durable-apply');
      });
      Reflect.set(instance, 'commitDriveChangeCursor', async () => {
        events.push('cursor-commit');
      });
      await invokePrivate(
        instance,
        'discoverWithFastPath',
        {
          rootFolderId: 'root-a',
          async assertActiveRoot() {
            events.push('root-metadata');
          },
        },
        new AbortController().signal,
      );
      assert.deepEqual(events, [
        'root-metadata',
        'changes',
        'paper:doc-a',
        'durable-apply',
        'cursor-commit',
      ]);
    },
  );

  await context.test(
    'expired and identity-stale cursors fall back to a full audit',
    async () => {
      const expired = coordinator(profile());
      let expiredFallbacks = 0;
      Reflect.set(expired, 'drive', {
        async listChanges() {
          throw new DriveRequestError(
            'expired',
            410,
            'change-token-invalid',
            'changes',
          );
        },
      });
      Reflect.set(expired, 'runAuthoritativeBaseline', async () => {
        expiredFallbacks += 1;
      });
      await invokePrivate(
        expired,
        'discoverWithFastPath',
        { rootFolderId: 'root-a', async assertActiveRoot() {} },
        new AbortController().signal,
      );
      assert.equal(expiredFallbacks, 1);

      const stale = coordinator(
        profile({
          rootFolderId: 'root-b',
          driveChangeCursor: {
            version: 1,
            accountId: 'account-a',
            rootFolderId: 'root-a',
            deviceMode: 'personal',
            pageToken: 'wrong-root-cursor',
            lastFullAuditAt: Date.now(),
          },
        }),
      );
      let staleFallbacks = 0;
      Reflect.set(stale, 'drive', {
        async listChanges() {
          assert.fail('a cursor bound to another root must never be consumed');
        },
      });
      Reflect.set(stale, 'runAuthoritativeBaseline', async () => {
        staleFallbacks += 1;
      });
      await invokePrivate(
        stale,
        'discoverWithFastPath',
        { rootFolderId: 'root-b' },
        new AbortController().signal,
      );
      assert.equal(staleFallbacks, 1);
    },
  );

  await context.test(
    'weekly safety audit expiry and workspace-bound cursor storage are explicit',
    async () => {
      const instance = coordinator(
        profile({
          driveChangeCursor: {
            version: 1,
            accountId: 'account-a',
            rootFolderId: 'root-a',
            deviceMode: 'personal',
            pageToken: 'old-cursor',
            lastFullAuditAt: Date.now() - 8 * 24 * 60 * 60 * 1_000,
          },
        }),
      );
      let audits = 0;
      Reflect.set(instance, 'runAuthoritativeBaseline', async () => {
        audits += 1;
      });
      await invokePrivate(
        instance,
        'discoverWithFastPath',
        { rootFolderId: 'root-a' },
        new AbortController().signal,
      );
      assert.equal(audits, 1);

      const storage = source('../src/sync/storage.ts');
      assert.match(
        storage,
        /cursor\.deviceMode === deviceMode[\s\S]*?cursor\.accountId === accountId[\s\S]*?cursor\.rootFolderId === rootFolderId/u,
      );
      assert.match(storage, /scopedDatabaseName\(SYNC_DATABASE_NAME\)/u);
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      assert.match(
        coordinatorSource,
        /if \(profile\.rootFolderId !== root\.id\) delete profile\.driveChangeCursor/u,
      );
      assert.match(
        coordinatorSource,
        /delete profile\.rootFolderId;[\s\S]*?delete profile\.driveChangeCursor/u,
      );
    },
  );
});

test('batch sounds and overlapping ownership do not create duplicate feedback', async (context) => {
  await context.test('one meaningful batch completion maps to one success cue', () => {
    assert.equal(
      transitionCue({
        previousStatus: 'syncing',
        currentStatus: 'synced',
        actualWork: true,
      }),
      'success',
    );
  });

  await context.test('no-op polling never plays a success cue', () => {
    assert.equal(
      transitionCue({
        previousStatus: 'connected',
        currentStatus: 'synced',
        actualWork: false,
      }),
      null,
    );
  });

  await context.test('new attention episode maps to one warning cue', () => {
    assert.equal(
      transitionCue({ previousStatus: 'syncing', currentStatus: 'attention' }),
      'attention',
    );
  });

  await context.test(
    'duplicate transition IDs are consumed once under StrictMode remount pressure',
    () => {
      const cues: SyncSoundCue[] = [];
      const feedback = new SyncSoundFeedback({
        unlock() {},
        play(cue) {
          cues.push(cue);
        },
      });
      const transition = {
        id: 'batch-a',
        previousStatus: 'syncing',
        currentStatus: 'synced',
        actualWork: true,
      };
      feedback.notify(transition);
      feedback.notify(transition);
      assert.deepEqual(cues, ['success']);
    },
  );

  await context.test('persistent attention does not repeat warning sound', () => {
    const cues: SyncSoundCue[] = [];
    const feedback = new SyncSoundFeedback({
      unlock() {},
      play(cue) {
        cues.push(cue);
      },
    });
    feedback.notify({ id: 1, previousStatus: 'syncing', currentStatus: 'attention' });
    feedback.notify({ id: 2, previousStatus: 'attention', currentStatus: 'attention' });
    assert.deepEqual(cues, ['attention']);
  });

  await context.test('disabled sounds prevent playback without changing state', () => {
    const cues: SyncSoundCue[] = [];
    const feedback = new SyncSoundFeedback({
      unlock() {},
      play(cue) {
        cues.push(cue);
      },
    });
    feedback.setEnabled(false);
    feedback.notify({
      id: 1,
      previousStatus: 'syncing',
      currentStatus: 'synced',
      actualWork: true,
    });
    assert.deepEqual(cues, []);
  });
});

test('Drive operation ownership and autosync retry policy are deterministic', async (context) => {
  await context.test(
    'coordinator diagnostics retain owner acquisition and release without Drive requests',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const drive = new DriveClient(() => 'not-transmitted');
      const configuredProfile = {
        id: 'paper-device',
        deviceId: 'device-a',
        deviceLabel: 'Device A',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        accountId: 'account-a',
        workspaceAccountId: 'account-a',
      } satisfies PaperSyncDeviceProfile;
      await savePaperSyncDeviceProfile(configuredProfile, {
        authentication: 'replace',
      });
      Reflect.set(coordinator, 'profile', configuredProfile);
      Reflect.set(coordinator, 'identity', {
        hasDeviceSession: true,
        accountId: 'account-a',
      });
      Reflect.set(coordinator, 'view', viewState({ deviceModeChoiceConfirmed: true }));
      Reflect.set(coordinator, 'drive', drive);
      const begin = Reflect.get(coordinator, 'beginOperation') as (
        type: 'remove',
      ) => Promise<AbortSignal>;
      const end = Reflect.get(coordinator, 'endOperation') as (
        signal: AbortSignal,
      ) => void;
      const signal = await begin.call(coordinator, 'remove');
      end.call(coordinator, signal);

      const diagnostic = coordinator.getLastDriveOperationDiagnostic();
      assert.ok(diagnostic);
      assert.equal(diagnostic.operationType, 'remove');
      assert.equal(diagnostic.requestCount, 0);
      assert.deepEqual(
        diagnostic.stateTransitions.map(({ transition, classification, outcome }) => ({
          transition,
          classification,
          outcome,
        })),
        [
          {
            transition: 'operation-owner-acquired',
            classification: 'immediate',
            outcome: 'succeeded',
          },
          {
            transition: 'operation-owner-released',
            classification: 'completed',
            outcome: 'succeeded',
          },
        ],
      );
      assert.deepEqual(coordinator.getRecentDriveOperationDiagnostics(), [diagnostic]);
    },
  );

  await context.test('a rejected operation releases ownership in finally', async () => {
    const owner = new SerializedDriveOperationOwner();
    const first = await owner.begin();
    assert.equal(owner.active, true);
    try {
      throw new Error('semantic validation failed');
    } catch {
      // The coordinator reports the validation error, then its finally releases.
    } finally {
      owner.end(first);
    }
    assert.equal(owner.active, false);
    const retry = await owner.begin();
    assert.equal(owner.active, true);
    owner.end(retry);
    assert.equal(owner.active, false);
  });

  await context.test(
    'a typed wrong-partition rejection releases ownership and exposes safe details',
    async () => {
      const cause = new CloudPayloadPartitionError(
        {
          app: '39Note',
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          entities: [
            {
              kind: 'collection',
              id: 'collection-b',
              documentId: 'doc-b',
            } as never,
          ],
          tombstones: [],
        },
        {
          logicalType: 'document-state',
          logicalPath: 'papers/doc-a/state.json',
          documentId: 'doc-a',
          partitionModel: 'paper-v2',
          sourceProtocolVersion: 2,
        },
      );
      const partitionError = new PaperPayloadPartitionError('doc-a', cause);
      const owner = new SerializedDriveOperationOwner();
      const first = await owner.begin();
      try {
        throw partitionError;
      } catch (error) {
        const issue = classifyPaperCoordinatorError(error);
        assert.equal(issue.code, 'paper-logical-partition-invalid');
        assert.equal(issue.blocksOrdinarySync, true);
        assert.equal(issue.retrySafe, false);
        assert.equal(issue.diagnostic.expectedSemanticPartition, 'paper-state');
        assert.deepEqual(issue.diagnostic.actualSemanticPartitions, [
          'different-paper',
        ]);
        assert.equal(issue.diagnostic.sourceProtocolVersion, 2);
        assert.equal(issue.diagnostic.compatibilityNormalizationAttempted, false);
        const html = renderDrawer(
          viewState({ connection: 'attention', issue, error: issue.message }),
        );
        assert.match(html, /Expected data<\/dt><dd>paper-state/u);
        assert.match(html, /Found data<\/dt><dd>different-paper/u);
        assert.match(html, /Paper protocol<\/dt><dd>2/u);
        assert.match(html, /Compatibility check<\/dt><dd>Not applicable/u);
        assert.doesNotMatch(html, /collection-b|doc-b/u);
      } finally {
        owner.end(first);
      }
      assert.equal(owner.active, false);
      const retry = await owner.begin();
      owner.end(retry);
    },
  );

  await context.test(
    'background/manual contention queues instead of throwing or overlapping',
    async () => {
      const owner = new SerializedDriveOperationOwner();
      const first = await owner.begin();
      let secondStarted = false;
      const secondAttempt = owner.begin().then((signal) => {
        secondStarted = true;
        return signal;
      });
      await Promise.resolve();
      assert.equal(secondStarted, false);
      owner.end(first);
      const second = await secondAttempt;
      assert.equal(secondStarted, true);
      assert.equal(owner.active, true);
      owner.end(second);
      assert.equal(owner.active, false);
    },
  );

  await context.test(
    'Home unsubscribe and remount observe retained paper commands without restarting them',
    async () => {
      const operationTypes = [
        'download',
        'upload',
        'remove',
        'restore',
        'keep-local',
      ] as const;

      for (const operationType of operationTypes) {
        const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
        const retain = Reflect.get(coordinator, 'retainPaperOperation') as <T>(
          type: (typeof operationTypes)[number],
          documentIds: readonly string[],
          start: () => Promise<T>,
        ) => Promise<T>;
        let starts = 0;
        let complete!: (value: string) => void;
        const deferred = new Promise<string>((resolve) => {
          complete = resolve;
        });
        const firstListenerStates: number[] = [];
        const unsubscribe = coordinator.subscribe((state) => {
          firstListenerStates.push(state.activePaperOperations.length);
        });
        const first = retain.call(coordinator, operationType, ['doc-a'], async () => {
          starts += 1;
          return deferred;
        });
        await Promise.resolve();
        assert.equal(starts, 1, `${operationType} should start once`);
        assert.deepEqual(coordinator.getSnapshot().activePaperOperations, [
          {
            id: 'paper-operation-1',
            type: operationType,
            documentIds: ['doc-a'],
            startedAt: coordinator.getSnapshot().activePaperOperations[0]?.startedAt,
          },
        ]);

        unsubscribe();
        assert.equal(
          coordinator.getSnapshot().activePaperOperations.length,
          1,
          `${operationType} must outlive the Home listener`,
        );

        const remountedStates: number[] = [];
        const unsubscribeRemount = coordinator.subscribe((state) => {
          remountedStates.push(state.activePaperOperations.length);
        });
        const duplicate = retain.call(
          coordinator,
          operationType,
          ['doc-a'],
          async () => {
            starts += 1;
            return 'duplicate';
          },
        );
        assert.equal(duplicate, first);
        assert.equal(starts, 1, `${operationType} must not restart on remount`);
        assert.equal(remountedStates[0], 1);

        complete('complete');
        assert.equal(await first, 'complete');
        assert.equal(coordinator.getSnapshot().activePaperOperations.length, 0);
        assert.equal(remountedStates.at(-1), 0);
        assert.ok(firstListenerStates.includes(1));
        unsubscribeRemount();
      }

      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      for (const [operationType, callPattern] of [
        ['download', /downloadSelected[\s\S]*?retainPaperOperation\('download'/u],
        ['upload', /startUpload[\s\S]*?retainPaperOperation\('upload'/u],
        [
          'remove',
          /removeFromGoogleDriveSelected[\s\S]*?retainPaperOperation\('remove'/u,
        ],
        ['restore', /restoreToGoogleDrive[\s\S]*?retainPaperOperation\('restore'/u],
        ['keep-local', /keepLocalSelected[\s\S]*?retainPaperOperation\('keep-local'/u],
      ] as const) {
        assert.match(
          coordinatorSource,
          callPattern,
          `${operationType} must be retained by the coordinator`,
        );
      }

      const librarySource = source('../src/components/LibraryPanel.tsx');
      assert.match(
        librarySource,
        /syncState\.activePaperOperations[\s\S]*?operations\[documentId\] \?\?= operation\.type/u,
      );
      const subscription = librarySource.slice(
        librarySource.indexOf('const unsubscribe = syncCoordinator.subscribe'),
        librarySource.indexOf('}, [isOpen, syncCoordinator]);'),
      );
      assert.match(subscription, /return unsubscribe/u);
      assert.doesNotMatch(subscription, /cancel|abort|destroy/iu);
    },
  );

  await context.test(
    'failed retained work clears stale progress and workspace destruction releases FIFO ownership',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const retain = Reflect.get(coordinator, 'retainPaperOperation') as <T>(
        type: 'download',
        documentIds: readonly string[],
        start: () => Promise<T>,
      ) => Promise<T>;
      await assert.rejects(
        retain.call(coordinator, 'download', ['doc-failed'], async () => {
          throw new Error('injected retained failure');
        }),
        /injected retained failure/u,
      );
      assert.deepEqual(coordinator.getSnapshot().activePaperOperations, []);

      const owner = new SerializedDriveOperationOwner();
      const active = await owner.begin();
      const queued = owner.begin();
      owner.destroy();
      assert.equal(active.aborted, true);
      assert.equal(owner.active, true);
      owner.end(active);
      await assert.rejects(
        queued,
        (error: unknown) =>
          error instanceof DOMException && error.name === 'AbortError',
      );
      assert.equal(owner.active, false);
      await assert.rejects(
        owner.begin(),
        (error: unknown) =>
          error instanceof DOMException && error.name === 'AbortError',
      );
    },
  );

  await context.test(
    'cancel aborts but cannot release ownership before finally',
    async () => {
      const owner = new SerializedDriveOperationOwner();
      const first = await owner.begin();
      let secondStarted = false;
      const secondAttempt = owner.begin().then((signal) => {
        secondStarted = true;
        return signal;
      });
      owner.cancel();
      assert.equal(first.aborted, true);
      assert.equal(owner.active, true);
      await Promise.resolve();
      assert.equal(secondStarted, false);
      owner.end(first);
      const second = await secondAttempt;
      owner.end(second);
    },
  );

  await context.test(
    'transient and blocking failures have distinct retry policy',
    () => {
      const transient = classifyPaperCoordinatorError(
        new DriveNetworkError('download'),
        true,
      );
      const blocking = classifyPaperCoordinatorError(
        new PaperRepositoryError(
          'paper-integrity-failed',
          'A paper payload is invalid.',
        ),
        true,
      );
      const remoteChanged = classifyPaperCoordinatorError(
        new PaperRepositoryError('paper-remote-changed', 'Drive changed.'),
        true,
      );
      const unstable = classifyPaperCoordinatorError(
        new PaperSnapshotUnstableError('doc-a'),
        true,
      );
      const newerProtocol = classifyPaperCoordinatorError(
        new PaperRepositoryError('unsupported-protocol', 'A newer protocol is active.'),
        true,
      );

      assert.equal(transient.code, 'offline');
      assert.equal(transient.retrySafe, true);
      assert.equal(transient.blocksOrdinarySync, false);
      assert.equal(blocking.blocksOrdinarySync, true);
      assert.equal(blocking.retrySafe, false);
      assert.equal(remoteChanged.code, 'drive-changed');
      assert.equal(remoteChanged.blocksOrdinarySync, false);
      assert.equal(unstable.code, 'drive-integrity-mismatch');
      assert.equal(unstable.state, 'attention');
      assert.equal(unstable.blocksOrdinarySync, true);
      assert.equal(unstable.retrySafe, true);
      assert.deepEqual(unstable.actions, ['retry-now', 'details']);
      assert.equal(unstable.diagnostic.documentId, 'doc-a');
      assert.equal(newerProtocol.state, 'attention');
      assert.equal(newerProtocol.blocksOrdinarySync, true);
      assert.equal(newerProtocol.retrySafe, false);
      assert.deepEqual(newerProtocol.actions, ['details']);
      assert.match(newerProtocol.message, /too old.*latest 39Note version/iu);
      assert.match(newerProtocol.message, /do not attempt another Drive upgrade/iu);
      assert.equal(newerProtocol.diagnostic.operation, 'unsupported-protocol');
    },
  );

  await context.test(
    'pre-authorization failure exits Connecting, reports a redacted phase, and permits one clean retry',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
      Reflect.set(coordinator, 'profile', {
        id: 'paper-device',
        deviceId: 'device-auth-failure',
        deviceLabel: 'Device A',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: true,
      } satisfies PaperSyncDeviceProfile);
      Reflect.set(
        coordinator,
        'view',
        viewState({ connection: 'disconnected', backendConfigured: true }),
      );
      let calls = 0;
      let rejectAttempt!: (error: unknown) => void;
      const identity = {
        hasDeviceSession: false,
        beginAuthorization() {
          calls += 1;
          return new Promise<never>((_resolve, reject) => {
            rejectAttempt = reject;
          });
        },
      };
      Reflect.set(coordinator, 'identity', identity);

      const first = coordinator.connect();
      const duplicate = coordinator.connect();
      const settledAttempts = Promise.allSettled([first, duplicate]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(coordinator.getSnapshot().connection, 'connecting');

      rejectAttempt(new GoogleAuthorizationStartError('request-failed'));
      const outcomes = await settledAttempts;
      assert.ok(
        outcomes.every(
          (outcome) =>
            outcome.status === 'rejected' &&
            outcome.reason instanceof GoogleAuthorizationStartError,
        ),
      );
      const failed = coordinator.getSnapshot();
      assert.equal(failed.connection, 'disconnected');
      assert.equal(failed.issue?.code, 'authorization-failed');
      assert.equal(failed.issue?.diagnostic.operation, 'authorization-start');
      assert.equal(failed.issue?.diagnostic.causeCode, 'request-failed');
      assert.match(failed.error ?? '', /local data is safe/u);
      assert.equal(failed.autoSync, true);

      identity.beginAuthorization = () => {
        calls += 1;
        return Promise.reject(new GoogleAuthorizationStartError('request-timed-out'));
      };
      await assert.rejects(coordinator.connect(), GoogleAuthorizationStartError);
      assert.equal(calls, 2);
      assert.equal(coordinator.getSnapshot().connection, 'disconnected');
    },
  );

  await context.test(
    'an explicit unsupported Origin returns to a usable disconnected state without claiming approval failed',
    async () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
      Reflect.set(coordinator, 'profile', {
        id: 'paper-device',
        deviceId: 'device-origin-rejected',
        deviceLabel: 'Device A',
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
      } satisfies PaperSyncDeviceProfile);
      Reflect.set(
        coordinator,
        'view',
        viewState({
          connection: 'disconnected',
          backendConfigured: true,
          autoSync: false,
        }),
      );
      Reflect.set(coordinator, 'identity', {
        hasDeviceSession: false,
        beginAuthorization() {
          return Promise.reject(new SyncOriginNotAllowedError());
        },
      });

      await assert.rejects(coordinator.connect(), SyncOriginNotAllowedError);
      const failed = coordinator.getSnapshot();
      assert.equal(failed.connection, 'disconnected');
      assert.equal(failed.issue?.code, 'sync-origin-not-allowed');
      assert.equal(failed.issue?.diagnostic.causeCode, 'origin-not-allowed');
      assert.equal(failed.autoSync, false);
      assert.doesNotMatch(failed.error ?? '', /developer approval|approved account/iu);
      assert.match(renderDrawer(failed), />Connect Google Drive</u);
    },
  );

  await context.test('transient retry uses capped exponential backoff', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 9].map(transientAutoRetryDelay),
      [5_000, 10_000, 20_000, 40_000, 60_000, 60_000],
    );
  });

  await context.test(
    'cancel is not automatically retried and transient paper state stays truthful',
    () => {
      const cancelled = classifyPaperCoordinatorError(
        new DOMException('Canceled', 'AbortError'),
      );
      assert.equal(cancelled.code, 'sync-cancelled');
      assert.equal(cancelled.actions.includes('automatic-retry'), false);
      assert.equal(autoSyncFollowUpPolicy([cancelled]), 'none');
      assert.equal(
        autoSyncFollowUpPolicy([
          {
            ...cancelled,
            code: 'sync-service-unavailable',
            actions: ['retry-now'],
          },
        ]),
        'none',
      );
      assert.equal(
        autoSyncFollowUpPolicy([
          {
            ...cancelled,
            code: 'offline',
            actions: ['automatic-retry', 'retry-now'],
          },
        ]),
        'backoff',
      );
      assert.equal(autoSyncFollowUpPolicy([]), 'debounce');
      assert.equal(
        autoSyncFollowUpPolicy([
          {
            ...cancelled,
            code: 'drive-integrity-mismatch',
            actions: ['details'],
            blocksOrdinarySync: true,
          },
        ]),
        'debounce',
      );
      assert.equal(
        paperStatusAfterFailure(
          {
            availability: 'cloud-only',
            dirtyReasons: [],
            incorporatedHeadIds: [],
            remoteHeadIds: ['head-a'],
          },
          false,
        ),
        'remote-update-available',
      );
      assert.equal(
        paperStatusAfterFailure(
          {
            availability: 'local-and-cloud',
            dirtyReasons: ['notes'],
            incorporatedHeadIds: [],
            remoteHeadIds: ['head-a'],
          },
          true,
        ),
        'needs-attention',
      );
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      assert.match(
        coordinatorSource,
        /const policy = autoSyncFollowUpPolicy\(issues\)/u,
      );
    },
  );

  await context.test(
    'a transient paper race cannot poison a later multi-paper catalog settlement',
    async () => {
      const transientState = paperState('doc-a', [], 'cloud-only');
      transientState.status = 'downloading';
      transientState.remoteHeadIds = ['head-a'];
      const unrelatedState = paperState('doc-b');
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(
        coordinator,
        'paperStates',
        new Map([
          [transientState.documentId, transientState],
          [unrelatedState.documentId, unrelatedState],
        ]),
      );
      Reflect.set(
        coordinator,
        'view',
        viewState({
          papers: [cloudPaper('doc-a', 'head-a'), cloudPaper('doc-b', 'head-b')],
          paperStates: [transientState, unrelatedState],
        }),
      );
      const issue = await markPaperFailureWithWorkspaceLease(
        coordinator,
        'doc-a',
        new PaperRepositoryError('paper-remote-changed', 'Drive changed.'),
      );
      const snapshot = coordinator.getSnapshot();
      assert.equal(issue.blocksOrdinarySync, false);
      assert.notEqual(
        snapshot.paperStates.find(({ documentId }) => documentId === 'doc-a')?.status,
        'needs-attention',
      );
      assert.equal(
        snapshot.papers.find(({ documentId }) => documentId === 'doc-a')?.issue,
        undefined,
      );
      assert.equal(
        snapshot.papers.find(({ documentId }) => documentId === 'doc-b')?.status,
        'cloud-only',
      );
      const settledConnection = Reflect.get(
        coordinator,
        'connectionAfterPaperSettlement',
      ) as (candidate: typeof issue) => PaperConnectionStatus;
      assert.equal(settledConnection.call(coordinator, issue), 'connected');

      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      assert.match(coordinatorSource, /presentedPaper\.status === 'needs-attention'/u);
      assert.doesNotMatch(
        coordinatorSource,
        /paper\.status === 'needs-attention' \|\| paper\.issue !== undefined/u,
      );
    },
  );

  await context.test(
    'paper settlement cannot report Connected while the browser is offline',
    () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const settledConnection = Reflect.get(
        coordinator,
        'connectionAfterPaperSettlement',
      ) as (candidate: undefined) => PaperConnectionStatus;
      const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
      try {
        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: false,
        });
        assert.equal(settledConnection.call(coordinator, undefined), 'offline');

        Object.defineProperty(navigator, 'onLine', {
          configurable: true,
          value: true,
        });
        assert.equal(settledConnection.call(coordinator, undefined), 'connected');
      } finally {
        if (originalOnline) Object.defineProperty(navigator, 'onLine', originalOnline);
        else Reflect.deleteProperty(navigator, 'onLine');
      }
    },
  );

  await context.test(
    'a blocking paper failure changes only the affected paper',
    async () => {
      const cause = new CloudPayloadPartitionError(
        {
          app: '39Note',
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          entities: [
            {
              kind: 'annotation',
              id: 'annotation-b',
              documentId: 'doc-b',
            } as never,
          ],
          tombstones: [],
        },
        {
          logicalType: 'document-state',
          logicalPath: 'papers/doc-a/state.json',
          documentId: 'doc-a',
          partitionModel: 'paper-v2',
          sourceProtocolVersion: 2,
        },
      );
      const bad = paperState('doc-a', ['notes']);
      bad.status = 'uploading';
      bad.remoteHeadIds = ['head-a'];
      const unrelated = paperState('doc-c');
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(
        coordinator,
        'paperStates',
        new Map([
          [bad.documentId, bad],
          [unrelated.documentId, unrelated],
        ]),
      );
      Reflect.set(
        coordinator,
        'view',
        viewState({
          papers: [cloudPaper('doc-a', 'head-a'), cloudPaper('doc-c', 'head-c')],
          paperStates: [bad, unrelated],
          dirtyPaperIds: ['doc-a'],
        }),
      );
      const issue = await markPaperFailureWithWorkspaceLease(
        coordinator,
        'doc-a',
        new PaperPayloadPartitionError('doc-a', cause),
      );
      const snapshot = coordinator.getSnapshot();

      assert.equal(issue.code, 'paper-logical-partition-invalid');
      assert.equal(issue.blocksOrdinarySync, true);
      assert.equal(
        snapshot.paperStates.find((state) => state.documentId === 'doc-a')?.status,
        'needs-attention',
      );
      assert.equal(
        snapshot.paperStates.find((state) => state.documentId === 'doc-c')?.status,
        'synced',
      );
      assert.equal(
        snapshot.papers.find((paper) => paper.documentId === 'doc-a')?.issue?.code,
        'paper-logical-partition-invalid',
      );
      assert.equal(
        snapshot.papers.find((paper) => paper.documentId === 'doc-c')?.issue,
        undefined,
      );
    },
  );

  await context.test(
    'the redacted trace proves markPaperFailure is the first transition into attention',
    async () => {
      let clock = 0;
      const drive = new DriveClient(() => 'not-transmitted', {
        now: () => (clock += 5),
      });
      const operationId = drive.beginOperationTelemetry('remove');
      drive.recordOperationStateTransition({
        phase: 'operation-owner',
        transition: 'operation-owner-acquired',
        outcome: 'succeeded',
      });

      const state = paperState('private-document-id');
      state.status = 'synced';
      state.cloudPresence = 'present';
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Reflect.set(coordinator, 'drive', drive);
      Reflect.set(coordinator, 'paperStates', new Map([[state.documentId, state]]));
      Reflect.set(
        coordinator,
        'view',
        viewState({
          papers: [cloudPaper(state.documentId, 'head-a')],
          paperStates: [state],
        }),
      );
      const issue = await markPaperFailureWithWorkspaceLease(
        coordinator,
        state.documentId,
        new PaperV3ControlIntegrityError(
          'Projected upload response lacked ownership evidence.',
          state.documentId,
        ),
      );
      await markPaperFailureWithWorkspaceLease(
        coordinator,
        state.documentId,
        new PaperV3ControlIntegrityError(
          'The same blocking issue was observed again.',
          state.documentId,
        ),
      );
      const snapshot = drive.finishOperationTelemetry(operationId);
      assert.ok(snapshot);

      const attentionIndex = snapshot.stateTransitions.findIndex(
        ({ nextPaperState }) => nextPaperState === 'needs-attention',
      );
      assert.equal(attentionIndex, 1);
      assert.equal(issue.code, 'unexpected-sync-failure');
      assert.deepEqual(snapshot.stateTransitions[attentionIndex], {
        relativeTimeMs: 10,
        phase: 'paper-failure-settlement',
        transition: 'paper-state-updated',
        paperCorrelationId: 'paper-1',
        previousPaperState: 'synced',
        nextPaperState: 'needs-attention',
        issueCode: issue.code,
        outcome: 'failed',
        classification: 'blocking-paper-failure',
      });
      assert.equal(
        snapshot.stateTransitions[attentionIndex + 1]?.transition,
        'paper-issue-created',
      );
      assert.equal(
        snapshot.stateTransitions[attentionIndex + 2]?.transition,
        'operation-issue-observed',
      );
      assert.equal(
        snapshot.stateTransitions
          .slice(0, attentionIndex)
          .some(({ nextPaperState }) => nextPaperState === 'needs-attention'),
        false,
      );
      assert.equal(JSON.stringify(snapshot).includes('private-document-id'), false);
    },
  );

  await context.test(
    'global blocking attention stops autosync while a paper-scoped block leaves unrelated work eligible',
    () => {
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      const blocked = paperState('doc-a', ['notes']);
      blocked.status = 'needs-attention';
      const unrelated = paperState('doc-b', ['annotations']);
      const issue = classifyPaperCoordinatorError(
        new PaperRepositoryError(
          'paper-integrity-failed',
          'Drive data needs verification.',
        ),
      );
      const eligiblePaperIds = Reflect.get(
        coordinator,
        'getAutoSyncEligibleDirtyPaperIds',
      ) as () => string[];

      Reflect.set(
        coordinator,
        'paperStates',
        new Map([
          [blocked.documentId, blocked],
          [unrelated.documentId, unrelated],
        ]),
      );
      Reflect.set(
        coordinator,
        'view',
        viewState({
          connection: 'attention',
          issue,
          paperStates: [blocked, unrelated],
          dirtyPaperIds: ['doc-a', 'doc-b'],
        }),
      );

      assert.deepEqual(eligiblePaperIds.call(coordinator), []);

      Reflect.set(coordinator, 'blockingPaperIssues', new Map([['doc-a', { issue }]]));
      assert.deepEqual(eligiblePaperIds.call(coordinator), ['doc-b']);

      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      assert.match(
        coordinatorSource,
        /getAutoSyncEligibleDirtyPaperIds\(\): string\[\] \{[\s\S]*?if \(this\.hasGlobalBlockingIssue\(\)\) return \[\]/u,
      );
    },
  );

  await context.test(
    'blocking paper failure pauses only that paper and clears terminal progress',
    () => {
      const coordinatorSource = source('../src/sync/paperCoordinator.ts');
      assert.doesNotMatch(
        coordinatorSource,
        /Another Google Drive operation is already running/u,
      );
      assert.match(
        coordinatorSource,
        /if \(settledCloud\.length > 0\) \{[\s\S]{0,180}await this\.applyTransferCatalog\(\s*settledCloud,\s*this\.requireWorkspaceLease\(signal\)/u,
      );
      assert.doesNotMatch(coordinatorSource, /scanAfterBatch/u);
      assert.match(
        coordinatorSource,
        /!this\.blockingPaperIssues\.has\(documentId\)[\s\S]*?status !== 'needs-attention'/u,
      );
      assert.match(
        coordinatorSource,
        /progress: \{ phase: 'idle' \}[\s\S]*?scheduleDirtyFollowUp/u,
      );
      assert.match(
        coordinatorSource,
        /this\.autoUploadTimer !== null[\s\S]*?clearTimeout\(this\.autoUploadTimer\)/u,
      );
      assert.match(
        coordinatorSource,
        /singleton \?\?= new PaperGoogleDriveSyncCoordinator\(\)/u,
      );
      assert.doesNotMatch(coordinatorSource, /new AbortController\(\)\.signal/u);
      for (const [method, nextMethod] of [
        [
          'private async scanCloudPapersOwned',
          '\n  private async discoverWithFastPath',
        ],
        ['private async downloadSelectedOwned', '\n  downloadAll('],
        ['private async uploadSelectedOwned', '\n  private applyPublishResult'],
        ['\n  removeFromGoogleDriveSelected(', '\n  restoreToGoogleDrive('],
        ['\n  restoreToGoogleDrive(', '\n  keepLocalSelected('],
        ['\n  keepLocalSelected(', '\n  async dismissRemoteUpdates('],
        [
          'private async upgradePaperSyncProtocolToV3Owned',
          '\n  upgradeDriveSyncToV3(',
        ],
        [
          'private async upgradeDriveSyncToV3Owned',
          '\n  upgradeDriveLayoutFromThisDevice(',
        ],
        [
          'private async upgradeDriveLayoutFromThisDeviceOwned',
          '\n  async finishTemporaryDevice(',
        ],
      ] as const) {
        const start = coordinatorSource.indexOf(method);
        const end = coordinatorSource.indexOf(nextMethod, start);
        const body = coordinatorSource.slice(start, end);
        assert.ok(start >= 0 && end > start, `${method} should exist`);
        const beginOperation = body.indexOf('await this.beginOperation(');
        const ensureRepository = body.indexOf('await this.ensureRepository(signal');
        assert.ok(
          beginOperation >= 0,
          `${method} must acquire serialized Drive ownership`,
        );
        assert.ok(
          ensureRepository > beginOperation,
          `${method} must own Drive before repository checks`,
        );
      }
      assert.match(
        coordinatorSource,
        /private scanPromise:[\s\S]*?this\.scanPromise \?\?=/u,
      );
      assert.match(
        coordinatorSource,
        /private handleOnline[\s\S]*?getAutoSyncEligibleDirtyPaperIds\(\)[\s\S]*?scheduleAutoUpload\(\)/u,
      );
    },
  );
});

test('layout rebuild failures are structured before the first preflight and retained by the UI', async (context) => {
  await context.test(
    'migration validation failures expose a safe reason without Drive identities',
    () => {
      const issue = createLayoutMigrationIssue(
        createLayoutMigrationFailure('verify-publications', 'ambiguous-paper-folder'),
      );
      assert.equal(
        issue.message,
        'Drive migration validation failed. Existing Drive data was left unchanged; review Details before retrying.',
      );
      assert.equal(issue.diagnostic.phase, 'verify-publications');
      assert.equal(issue.diagnostic.causeCode, 'ambiguous-paper-folder');
      assert.doesNotMatch(issue.message, /file|folder id|token|query/iu);
    },
  );

  await context.test(
    'J: initialize failure becomes a sanitized actionable coordinator issue',
    async () => {
      const rawSecret = 'Bearer raw-token client_secret=must-never-render';
      const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
      Object.defineProperty(coordinator, 'initialize', {
        configurable: true,
        value: async () => {
          throw new Error(rawSecret);
        },
      });
      const attempt = coordinator.upgradeDriveLayoutFromThisDevice();
      assert.equal(attempt, coordinator.upgradeDriveLayoutFromThisDevice());
      await assert.rejects(
        () => attempt,
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'LayoutMigrationFailedError' &&
          error.message === 'Drive layout upgrade failed.',
      );
      const state = coordinator.getSnapshot();
      assert.equal(state.connection, 'attention');
      assert.equal(state.progress.phase, 'idle');
      assert.equal(state.error, 'Drive layout upgrade failed.');
      assert.equal(state.issue?.code, 'layout-upgrade-failed');
      assert.equal(state.issue?.diagnostic.phase, 'initialize');
      assert.equal(state.issue?.diagnostic.causeCode, 'unexpected-sync-failure');
      assert.deepEqual(state.issue?.actions, ['retry-layout-upgrade', 'details']);
      assert.equal(state.issue?.retrySafe, true);
      assert.equal(state.issue?.blocksOrdinarySync, true);
      assert.doesNotMatch(JSON.stringify(state), /raw-token|client_secret/iu);
    },
  );

  await context.test(
    'K: the rebuild action keeps safe phase and paper diagnostics visible under Details',
    () => {
      const state = viewState({
        connection: 'migration-incomplete',
        error: 'Drive layout upgrade failed.',
        issue: {
          code: 'layout-upgrade-failed',
          message: 'Drive layout upgrade failed.',
          severity: 'error',
          state: 'attention',
          actions: ['retry-layout-upgrade', 'details'],
          retrySafe: true,
          blocksOrdinarySync: true,
          backupRecommended: false,
          diagnostic: {
            source: 'sync',
            operation: 'layout-upgrade',
            phase: 'publish-paper',
            causeCode: 'paper-integrity-failed',
            paperName: 'Paper A',
            documentId: 'doc-a',
          },
        },
      });
      const html = renderDrawer(state);
      assert.match(html, /role="alert">Drive layout upgrade failed\./u);
      assert.match(html, /Retry layout upgrade/u);
      assert.match(html, /<summary>Details<\/summary>/u);
      assert.match(html, /layout-upgrade-failed/u);
      assert.match(html, /publish-paper/u);
      assert.match(html, /paper-integrity-failed/u);
      assert.match(html, /Paper A/u);
      assert.match(html, /doc-a/u);
      assert.doesNotMatch(html, /Bearer|client_secret|raw-token/iu);

      const ui = source('../src/sync/PaperSyncControl.tsx');
      assert.match(
        ui,
        /upgradeDriveLayoutFromThisDevice\(\)[\s\S]{0,120}\.catch\(\(\) => undefined\)/u,
      );
      const coordinator = source('../src/sync/paperCoordinator.ts');
      const method = coordinator.indexOf('upgradeDriveLayoutFromThisDevice()');
      const boundary = coordinator.indexOf('try {', method);
      const initialize = coordinator.indexOf('await this.initialize()', method);
      const stateUpdate = coordinator.indexOf('this.updateView({', initialize);
      const sanitizedThrow = coordinator.indexOf(
        'throw new LayoutMigrationFailedError(failure)',
        stateUpdate,
      );
      assert.ok(method >= 0 && boundary > method && initialize > boundary);
      assert.ok(stateUpdate > initialize && sanitizedThrow > stateUpdate);
    },
  );

  await context.test(
    'the live old-format zero-publication checkpoint remains readable for one-time hydration',
    () => {
      const record = normalizeLayoutMigrationRecord({
        id: 'layout',
        rootFolderId: 'root',
        phase: 'publishing-papers',
        startedAt: 10,
        publishedDocumentIds: [],
        verifiedLegacyFileIds: ['legacy-manifest'],
      });
      assert.equal(record.formatVersion, undefined);
      assert.deepEqual(record.targetDocumentIds, []);
      assert.deepEqual(record.publishedDocumentIds, []);
      assert.deepEqual(record.publishedGenerationIds, {});
      const coordinator = source('../src/sync/paperCoordinator.ts');
      assert.match(coordinator, /record\.formatVersion !== 2/u);
      assert.match(coordinator, /record\.publishedDocumentIds\.length > 0/u);
      assert.match(
        coordinator,
        /targetDocumentIds:\s*localPapers\.map\(\(\{ documentId \}\) => documentId\)/u,
      );
    },
  );
});

test('temporary device mode is provenance-bound and limitations remain honest', async (context) => {
  const emptyFootprint = {
    annotationDocumentCount: 0,
    pdfDocumentCount: 0,
    collectionCount: 0,
    printDraftCount: 0,
    conversationCount: 0,
    aiStorageKeyCount: 0,
    paperStateCount: 0,
    cloudPaperCount: 0,
    hasMigration: false,
    hasProvenance: false,
    hasPaperAccountState: false,
    hasLegacyAccountState: false,
  };

  await context.test(
    'temporary mode remains selectable with existing personal data',
    () => {
      assert.deepEqual(evaluateTemporaryModeFootprint(emptyFootprint), { safe: true });
      assert.deepEqual(
        evaluateTemporaryModeFootprint({
          ...emptyFootprint,
          annotationDocumentCount: 1,
        }),
        { safe: true },
      );
    },
  );

  await context.test(
    'pre-existing account state cannot be erased by temporary cleanup',
    () => {
      const result = evaluateTemporaryModeFootprint({
        ...emptyFootprint,
        hasPaperAccountState: true,
      });
      assert.deepEqual(result, { safe: true });
    },
  );

  await context.test('cleanup plan contains only exact provenance IDs', () => {
    assert.deepEqual(
      createTemporaryCleanupPlan({
        documentIds: ['doc-b', 'doc-a', 'doc-a'],
        collectionIds: ['collection-a'],
      }),
      {
        documentIds: ['doc-a', 'doc-b'],
        collectionIds: ['collection-a'],
      },
    );
  });

  await context.test('abrupt-close and Google-account limitations are explicit', () => {
    assert.match(
      PUBLIC_DEVICE_LIMITATION,
      /cannot erase browser or operating-system traces/iu,
    );
    assert.match(PUBLIC_DEVICE_LIMITATION, /crash/iu);
    assert.match(PUBLIC_DEVICE_LIMITATION, /cannot guarantee signing|cannot.*sign/iu);
  });

  await context.test(
    'temporary session secrets are session-scoped rather than localStorage credentials',
    () => {
      const identity = source('../src/sync/googleIdentity.ts');
      assert.match(identity, /sessionStorage/u);
      assert.match(identity, /sessionMode === 'temporary'/u);
      assert.doesNotMatch(identity, /localStorage\.setItem\([^)]*sessionToken/u);
    },
  );

  await context.test(
    'Finish refuses silent abandonment of remaining dirty work',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      assert.match(coordinator, /remaining\.length && !abandonRemaining/u);
      assert.match(coordinator, /TemporaryDirtyWorkError/u);
    },
  );

  await context.test('temporary session is revoked before provenance cleanup', () => {
    const coordinator = source('../src/sync/paperCoordinator.ts');
    const finishStart = coordinator.indexOf(
      'private async finishTemporaryDeviceOwned(',
    );
    const finishEnd = coordinator.indexOf('\n  cancel(): void', finishStart);
    const finish = coordinator.slice(finishStart, finishEnd);
    const revoke = finish.indexOf('await this.identity.disconnectCurrent()');
    const cleanup = finish.indexOf('await cleanupTemporaryOrigin(workspaceLease)');
    assert.ok(revoke >= 0 && cleanup > revoke);
    assert.match(
      finish.slice(0, cleanup),
      /withWorkspaceIdentityTransition\([\s\S]*?withWorkspaceMutation\(async \(\) =>/u,
    );
  });

  await context.test('sync metadata schema migration is explicitly version 2', () => {
    assert.equal(SYNC_DATABASE_VERSION, 2);
    const storage = source('../src/sync/storage.ts');
    for (const store of [
      'DEVICE_STORE',
      'PAPER_DEVICE_STORE',
      'PAPER_STATE_STORE',
      'CLOUD_PAPER_STORE',
      'TEMPORARY_SESSION_STORE',
      'LAYOUT_MIGRATION_STORE',
    ]) {
      assert.match(
        storage,
        new RegExp(`!database\\.objectStoreNames\\.contains\\(${store}\\)`, 'u'),
      );
    }
    assert.doesNotMatch(storage, /deleteObjectStore/u);
  });

  await context.test('a cached root is revalidated before repository mutation', () => {
    const coordinator = source('../src/sync/paperCoordinator.ts');
    const metadataRead = coordinator.search(
      /drive\.getMetadata\(\s*profile\.rootFolderId/u,
    );
    const validation = coordinator.indexOf('isOwnedManagedPaperRootMetadata(cached)');
    const repositoryCreation = coordinator.indexOf(
      'new PaperDriveRepository(drive, root.id)',
      validation,
    );
    assert.ok(metadataRead >= 0 && validation > metadataRead);
    assert.ok(repositoryCreation > validation);
    assert.match(coordinator, /drive-root-invalid/u);
  });
});

function renderCloudLibrary(state: PaperSyncViewState): string {
  const coordinator = {
    downloadSelected: async () => undefined,
    downloadAll: async () => undefined,
    uploadSelected: async () => undefined,
  };
  return renderToStaticMarkup(
    createElement(PaperLibraryCloudView, {
      state,
      coordinator: coordinator as never,
    }),
  );
}

function renderDrawer(
  state: PaperSyncViewState,
  embedded = false,
  retryDiagnostic?: PaperRetryDiagnosticSnapshot,
  syncStatusDiagnostic?: PaperSyncStatusDiagnosticSnapshot,
  visibilityDiagnostic?: unknown,
  runtimeRevision?: number,
): string {
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
    getLastPaperRetryDiagnostic: () => retryDiagnostic,
    checkSyncStatusReadOnly: async () => syncStatusDiagnostic!,
    getLastPaperSyncStatusDiagnostic: () => syncStatusDiagnostic,
    ...(visibilityDiagnostic
      ? {
          getTargetedPaperPurgeVisibilityDiagnostic: () => visibilityDiagnostic,
        }
      : {}),
    ...(runtimeRevision !== undefined
      ? { getRuntimeRevision: () => runtimeRevision }
      : {}),
    cancel: () => undefined,
  };
  return renderToStaticMarkup(
    createElement(PaperSyncDrawer, {
      state,
      coordinator: coordinator as never,
      embedded,
      soundEnabled: true,
      onClose() {},
      onOpenSelector() {},
      onSoundEnabledChange() {},
      onDownloadBackup() {},
    }),
  );
}

function legacyInventory(): LegacyDriveInventory {
  return {
    inventoryId: 'inventory-hash',
    rootFolderId: 'root',
    scannedAt: 10,
    currentPaperCount: 4,
    recognizedLegacyCount: 2,
    unknownCount: 1,
    cleanupEligibleCount: 2,
    cleanupTargetIds: ['legacy-file-id'],
    items: [
      {
        id: 'legacy-file-id',
        name: 'legacy-library.json',
        kind: 'file',
        role: 'library',
        classification: 'recognized-legacy',
        reason: 'Verified app-owned global-v1 library payload.',
        cleanupEligible: true,
        cleanupDisposition: 'Eligible for Drive Trash after explicit confirmation.',
        depth: 1,
        evidenceHash: 'legacy-evidence',
      },
      {
        id: 'unknown-file-id',
        name: 'Personal notes.txt',
        kind: 'file',
        classification: 'unknown',
        reason: 'No trusted 39Note layout identity was found; this item is preserved.',
        cleanupEligible: false,
        cleanupDisposition: 'Unknown or unclassified data is always preserved.',
        depth: 1,
        evidenceHash: 'unknown-evidence',
      },
    ],
  };
}

function renderSelector(
  state: PaperSyncViewState,
  mode: 'download' | 'updates' | 'upload' | 'finish',
  affectedDocumentIds?: readonly string[],
): string {
  const coordinator = {
    downloadSelected: async () => undefined,
    uploadSelected: async () => undefined,
    finishTemporaryDevice: async () => undefined,
  };
  return renderToStaticMarkup(
    createElement(PaperSelectorDialog, {
      state,
      mode,
      affectedDocumentIds,
      coordinator: coordinator as never,
      onBrowseAll() {},
      onClose() {},
    }),
  );
}

function remoteUpdateView(affectedDocumentIds: readonly string[]): PaperSyncViewState {
  const affected = new Set(affectedDocumentIds);
  const papers = ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e'].map((documentId) =>
    cloudPaper(documentId, `head-${documentId}`),
  );
  const paperStates = papers.map((paper) => {
    const state = paperState(paper.documentId);
    state.cloudPresence = 'present';
    state.incorporatedHeadIds = [`old-${paper.documentId}`];
    state.remoteHeadIds = [...paper.headIds];
    if (affected.has(paper.documentId)) state.status = 'remote-update-available';
    else state.incorporatedHeadIds = [...paper.headIds];
    return state;
  });
  return viewState({
    lastSuccessfulAt: 10,
    papers,
    paperStates,
    reminder: {
      episodeId: affectedDocumentIds.join('|'),
      paperIds: [...affectedDocumentIds],
      dismissStage: 0,
      seenStateIds: affectedDocumentIds.map((documentId) =>
        JSON.stringify([documentId, `head-${documentId}`]),
      ),
    },
  });
}

function paperState(
  documentId: string,
  dirtyReasons: PaperSyncState['dirtyReasons'] = [],
  availability: PaperSyncState['availability'] = 'local-and-cloud',
): PaperSyncState {
  return {
    documentId,
    displayName: documentId.toUpperCase(),
    deviceId: 'device-a',
    availability,
    status: dirtyReasons.length
      ? 'local-changes'
      : availability === 'cloud-only'
        ? 'cloud-only'
        : 'synced',
    dirtyGeneration: dirtyReasons.length ? 1 : 0,
    dirtyReasons,
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

function cloudPaper(documentId: string, headSetId: string): PaperCloudSummary {
  return {
    documentId,
    displayName: documentId.toUpperCase(),
    deleted: false,
    paperFolderId: `folder-${documentId}`,
    dataFolderId: `data-${documentId}`,
    headIds: [headSetId],
    headSetId,
    localAvailability: 'cloud-only',
    status: 'cloud-only',
  };
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
    activePaperOperations: [],
    legacyHousekeeping: { status: 'idle' },
    folderNameMaintenance: { status: 'idle' },
    ...overrides,
  };
}

function paperFolderNamePreview(): PaperFolderNameNormalizationPreview {
  return {
    rootFolderId: 'root',
    controlFolderId: 'control',
    previewId: 'preview-hash',
    scannedAt: 1,
    candidateCount: 1,
    items: [
      {
        documentId: 'document-id',
        folderId: 'folder-id',
        currentName: 'Review.PDF',
        normalizedName: 'Review',
        folderEvidenceHash: 'folder-evidence',
        presenceHeadIds: ['presence-head'],
        packageHeadIds: ['package-head'],
      },
    ],
  };
}
