import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  GoogleDriveSyncCoordinator,
  SyncViewState,
} from '../src/sync/coordinator.ts';
import { DriveRequestError } from '../src/sync/driveClient.ts';
import { MultipleDriveRootsError } from '../src/sync/driveRepository.ts';
import { classifySyncError } from '../src/sync/errorModel.ts';
import { LocalSyncPersistenceError } from '../src/sync/storage.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('strict backup reads reject unavailable local storage and both packages use them', async () => {
  const previousIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  const previousConsoleError = console.error;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: undefined,
  });
  console.error = () => undefined;
  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    const { getBackupDocumentDataStrict } = (await server.ssrLoadModule(
      '/src/services/annotationPersistence.ts',
    )) as typeof import('../src/services/annotationPersistence.ts');
    await assert.rejects(
      () => getBackupDocumentDataStrict(),
      /Local Library storage is unavailable/u,
    );
  } finally {
    await server.close();
    console.error = previousConsoleError;
    if (previousIndexedDb) {
      Object.defineProperty(globalThis, 'indexedDB', previousIndexedDb);
    } else {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  }

  const backup = source('../src/services/libraryBackup.ts');
  assert.equal(
    backup.match(/getBackupDocumentDataStrict\(/gu)?.length,
    2,
    'full and selected backup entry points must both use strict reads',
  );
  assert.doesNotMatch(backup, /getBackupDocumentData\(/u);
});

test('drawer recovery copy and primary actions follow the classified issue', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  try {
    const { SyncDrawer } = (await server.ssrLoadModule(
      '/src/sync/SyncControl.tsx',
    )) as typeof import('../src/sync/SyncControl.tsx');
    const coordinator = coordinatorStub();

    const driveFullIssue = classifySyncError(
      new DriveRequestError(
        'sanitized',
        403,
        'storage-full',
        'upload',
        'storageQuotaExceeded',
      ),
      { online: true, area: 'sync' },
    );
    const driveFull = renderDrawer(
      SyncDrawer,
      viewState({ connection: 'error', issue: driveFullIssue }),
      coordinator,
    );
    assert.match(
      driveFull,
      /Download a local 39Note backup until Drive space is available\./u,
    );
    assert.match(driveFull, />Retry now</u);

    const persistentUploadIssue = classifySyncError(
      new DriveRequestError('sanitized', 503, 'backend-unavailable', 'upload'),
      { online: true, area: 'sync', repeatedUploadFailure: true },
    );
    const persistentUpload = renderDrawer(
      SyncDrawer,
      viewState({ connection: 'error', issue: persistentUploadIssue }),
      coordinator,
    );
    assert.match(
      persistentUpload,
      /Download a local 39Note backup while upload problems continue\./u,
    );
    assert.doesNotMatch(persistentUpload, /until Drive space is available/iu);

    const localPersistenceIssue = classifySyncError(
      new LocalSyncPersistenceError('write'),
      { online: true, area: 'sync' },
    );
    const localPersistence = renderDrawer(
      SyncDrawer,
      viewState({ connection: 'error', issue: localPersistenceIssue }),
      coordinator,
    );
    assert.doesNotMatch(localPersistence, />Retry now</u);
    assert.doesNotMatch(localPersistence, />Connect Google Drive</u);

    const roots = [
      {
        id: 'root-a',
        name: '39Note A',
        mimeType: 'application/vnd.google-apps.folder',
      },
      {
        id: 'root-b',
        name: '39Note B',
        mimeType: 'application/vnd.google-apps.folder',
      },
    ];
    const rootIssue = classifySyncError(new MultipleDriveRootsError(roots), {
      online: true,
      area: 'sync',
    });
    const rootSelection = renderDrawer(
      SyncDrawer,
      viewState({
        connection: 'root-selection-required',
        issue: rootIssue,
        rootChoices: roots,
      }),
      coordinator,
    );
    assert.match(rootSelection, /Choose a 39Note folder below\./u);
    assert.match(rootSelection, /Use 39Note A/u);
    assert.doesNotMatch(rootSelection, />Connect Google Drive</u);
  } finally {
    await server.close();
  }
});

test('open drawer installs and cleans up a document-level Escape handler', () => {
  const control = source('../src/sync/SyncControl.tsx');
  assert.match(control, /document\.addEventListener\('keydown', closeOnEscape\)/u);
  assert.match(control, /document\.removeEventListener\('keydown', closeOnEscape\)/u);
  assert.match(
    control,
    /window\.setTimeout\(\(\) => triggerRef\.current\?\.focus\(\), 0\)/u,
  );
  assert.doesNotMatch(control, /onKeyDown=\{[\s\S]*event\.key === 'Escape'/u);
});

function renderDrawer(
  SyncDrawer: typeof import('../src/sync/SyncControl.tsx').SyncDrawer,
  state: SyncViewState,
  coordinator: GoogleDriveSyncCoordinator,
): string {
  return renderToStaticMarkup(
    createElement(SyncDrawer, {
      state,
      coordinator,
      soundEnabled: true,
      backupProgress: null,
      backupMessage: null,
      backupError: null,
      onClose() {},
      onDownloadBackup() {},
      onSoundEnabledChange() {},
    }),
  );
}

function viewState(overrides: Partial<SyncViewState> = {}): SyncViewState {
  return {
    connection: 'connected',
    autoSync: true,
    dirty: false,
    backendConfigured: true,
    sessions: [],
    progress: { phase: 'idle' },
    rootChoices: [],
    conflicts: [],
    resetRequired: false,
    ...overrides,
  };
}

function coordinatorStub(): GoogleDriveSyncCoordinator {
  const resolved = async () => undefined;
  return {
    cancel() {},
    chooseRoot: resolved,
    connect: resolved,
    createReplacementRoot: resolved,
    disconnect: resolved,
    disconnectAll: resolved,
    dismissConflict: resolved,
    preserveAndMergeRemoteIntegrityGeneration: resolved,
    reconnect: resolved,
    repairIntegrityFromLocal: resolved,
    resetDriveSyncFromThisDevice: resolved,
    retryIntegrityVerification: resolved,
    setAutoSync: resolved,
    switchGoogleAccount: resolved,
    syncNow: resolved,
  } as unknown as GoogleDriveSyncCoordinator;
}
