import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DriveAuthorizationError,
  DriveClient,
  DriveNetworkError,
  DriveRequestError,
} from '../src/sync/driveClient.ts';
import { GoogleDrivePayloadIntegrityError } from '../src/sync/driveRepository.ts';
import {
  classifySyncError,
  createResetIncompleteIssue,
} from '../src/sync/errorModel.ts';
import { SyncBackendUnavailableError } from '../src/sync/googleIdentity.ts';
import { getSyncProgressPresentation } from '../src/sync/progressPresentation.ts';
import { LocalSyncPersistenceError } from '../src/sync/storage.ts';
import {
  SYNC_SOUNDS_PREFERENCE_KEY,
  SyncSoundFeedback,
  transitionCue,
  type SyncSoundCue,
  type SyncSoundStorage,
} from '../src/sync/syncSounds.ts';
import type { SyncViewState } from '../src/sync/coordinator.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('operational sync failures use stable, actionable, sanitized UI classes', async (context) => {
  await context.test('offline is not attention', () => {
    const issue = classifySyncError(new DriveNetworkError('download'), {
      online: false,
      area: 'sync',
    });
    assert.equal(issue.code, 'offline');
    assert.equal(issue.state, 'offline');
    assert.equal(issue.blocksOrdinarySync, false);
    assert.ok(issue.actions.includes('automatic-retry'));
  });

  await context.test('Drive full recommends the existing local backup path', () => {
    const issue = classifySyncError(
      new DriveRequestError(
        'sanitized',
        403,
        'storage-full',
        'upload',
        'storageQuotaExceeded',
      ),
      { online: true, area: 'sync' },
    );
    assert.equal(issue.code, 'drive-storage-full');
    assert.equal(
      issue.message,
      'Google Drive is full. 39Note cannot upload new changes.',
    );
    assert.equal(issue.backupRecommended, true);
    assert.ok(issue.actions.includes('download-local-backup'));
    assert.ok(issue.actions.includes('open-google-drive'));
    assert.equal(issue.blocksOrdinarySync, true);
  });

  await context.test(
    'rate limit is distinct from storage full and authorization',
    () => {
      const issue = classifySyncError(
        new DriveRequestError(
          'sanitized',
          403,
          'rate-limited',
          'list',
          'userRateLimitExceeded',
        ),
        { online: true, area: 'sync' },
      );
      assert.equal(issue.code, 'drive-rate-limited');
      assert.equal(issue.state, 'offline');
      assert.equal(issue.backupRecommended, false);
      assert.ok(issue.actions.includes('automatic-retry'));
      assert.ok(!issue.actions.includes('reconnect'));
    },
  );

  await context.test('repeated upload failure recommends a local backup', () => {
    const issue = classifySyncError(
      new DriveRequestError('sanitized', 503, 'backend-unavailable', 'upload'),
      { online: true, area: 'sync', repeatedUploadFailure: true },
    );
    assert.equal(issue.code, 'drive-upload-persistent');
    assert.equal(issue.backupRecommended, true);
    assert.ok(issue.actions.includes('download-local-backup'));
  });

  await context.test(
    'authorization and sign-in service outages remain distinct',
    () => {
      const authorization = classifySyncError(new DriveAuthorizationError(), {
        online: true,
        area: 'sync',
      });
      const service = classifySyncError(new SyncBackendUnavailableError(), {
        online: true,
        area: 'authentication',
      });
      assert.equal(authorization.code, 'google-authorization-required');
      assert.ok(authorization.actions.includes('reconnect'));
      assert.equal(service.code, 'sync-service-unavailable');
      assert.equal(service.state, 'offline');
    },
  );

  await context.test('Google backend and access failures have separate actions', () => {
    const backend = classifySyncError(
      new DriveRequestError('sanitized', 503, 'backend-unavailable', 'list'),
      { online: true, area: 'sync' },
    );
    const permission = classifySyncError(
      new DriveRequestError(
        'sanitized',
        403,
        'permission-denied',
        'metadata',
        'insufficientFilePermissions',
      ),
      { online: true, area: 'sync' },
    );
    assert.equal(backend.code, 'drive-backend-unavailable');
    assert.equal(backend.state, 'offline');
    assert.equal(permission.code, 'drive-access-denied');
    assert.equal(permission.state, 'attention');
    assert.ok(permission.actions.includes('reconnect'));
  });

  await context.test('integrity remains fail-closed behind concise copy', () => {
    const integrity = Object.create(
      GoogleDrivePayloadIntegrityError.prototype,
    ) as GoogleDrivePayloadIntegrityError;
    const issue = classifySyncError(integrity, { online: true, area: 'sync' });
    assert.equal(issue.code, 'drive-integrity-mismatch');
    assert.equal(issue.message, 'Drive data needs verification.');
    assert.equal(issue.blocksOrdinarySync, true);
    assert.equal(issue.state, 'attention');
  });

  await context.test(
    'local persistence failure never claims local data is safe',
    () => {
      const issue = classifySyncError(new LocalSyncPersistenceError('write'), {
        online: true,
        area: 'sync',
      });
      assert.equal(issue.code, 'local-persistence-failed');
      assert.equal(issue.severity, 'critical');
      assert.equal(issue.message, '39Note could not save changes locally.');
      assert.doesNotMatch(issue.message, /safe|saved locally/iu);
      assert.equal(issue.blocksOrdinarySync, true);
    },
  );

  await context.test('an interrupted reset keeps ordinary sync blocked', () => {
    const issue = createResetIncompleteIssue();
    assert.equal(issue.code, 'reset-incomplete');
    assert.equal(issue.blocksOrdinarySync, true);
    assert.ok(issue.actions.includes('retry-reset'));
  });
});

test('Google reason codes distinguish storage quota, API rate limit, and permission', async () => {
  const previousFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json(
        {
          error: {
            message: 'raw account-specific Google message',
            errors: [{ reason: 'storageQuotaExceeded' }],
          },
        },
        { status: 403 },
      );
    }) as typeof fetch;
    const storageClient = new DriveClient(() => 'fake-google-oauth-token');
    await assert.rejects(
      () => storageClient.listFiles('trashed=false', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError &&
        error.code === 'storage-full' &&
        error.reason === 'storageQuotaExceeded' &&
        !error.message.includes('raw account-specific Google message'),
    );
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json(
          { error: { errors: [{ reason: 'userRateLimitExceeded' }] } },
          { status: 403 },
        );
      }
      return Response.json({ files: [] });
    }) as typeof fetch;
    const rateClient = new DriveClient(() => 'fake-google-oauth-token');
    assert.deepEqual(
      await rateClient.listFiles('trashed=false', new AbortController().signal),
      [],
    );
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json(
        { error: { errors: [{ reason: 'insufficientFilePermissions' }] } },
        { status: 403 },
      );
    }) as typeof fetch;
    const permissionClient = new DriveClient(() => 'fake-google-oauth-token');
    await assert.rejects(
      () => permissionClient.listFiles('trashed=false', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError &&
        error.code === 'permission-denied' &&
        error.reason === 'insufficientFilePermissions',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('progress is determinate only when authoritative counts can advance', () => {
  assert.deepEqual(
    getSyncProgressPresentation({ phase: 'downloading', completed: 0, total: 4 }),
    {
      label: 'Downloading PDF 1 of 4',
      determinate: { value: 0, max: 4 },
    },
  );
  assert.deepEqual(
    getSyncProgressPresentation({ phase: 'downloading', completed: 2, total: 4 }),
    {
      label: 'Downloading PDF 3 of 4',
      determinate: { value: 2, max: 4 },
    },
  );
  assert.deepEqual(
    getSyncProgressPresentation({
      phase: 'uploading',
      completed: 0,
      total: 1,
      bytesCompleted: 8,
      bytesTotal: 16,
    }),
    {
      label: 'Uploading PDF 1 of 1 · 50%',
      determinate: { value: 8, max: 16 },
    },
  );
  assert.equal(
    getSyncProgressPresentation({ phase: 'uploading', completed: 0, total: 1 })
      ?.determinate,
    undefined,
    'a single opaque upload uses activity, not a static zero bar',
  );
  assert.equal(
    getSyncProgressPresentation({ phase: 'uploading', completed: 4, total: 4 })
      ?.determinate,
    undefined,
    '100% is not shown while publication still remains',
  );
  assert.equal(
    getSyncProgressPresentation({ phase: 'publishing' })?.determinate,
    undefined,
  );
  assert.equal(getSyncProgressPresentation({ phase: 'idle' }), null);
});

test('semantic sync sounds play once and never replay for no-op or persistent state', () => {
  const cues: SyncSoundCue[] = [];
  const feedback = new SyncSoundFeedback(
    {
      unlock() {},
      play(cue) {
        cues.push(cue);
      },
    },
    memoryStorage(),
  );

  feedback.notify({
    id: 'work-1',
    previousStatus: 'syncing',
    currentStatus: 'synced',
    actualWork: true,
  });
  feedback.notify({
    id: 'work-1',
    previousStatus: 'syncing',
    currentStatus: 'synced',
    actualWork: true,
  });
  feedback.notify({
    id: 'poll-1',
    previousStatus: 'syncing',
    currentStatus: 'synced',
    actualWork: false,
  });
  feedback.notify({
    id: 'steady-1',
    previousStatus: 'synced',
    currentStatus: 'synced',
    actualWork: true,
  });
  feedback.notify({
    id: 'warning-1',
    previousStatus: 'syncing',
    currentStatus: 'attention',
  });
  feedback.notify({
    id: 'warning-update',
    previousStatus: 'attention',
    currentStatus: 'attention',
  });
  assert.deepEqual(cues, ['success', 'attention']);
  assert.equal(
    transitionCue({
      previousStatus: 'loading',
      currentStatus: 'synced',
      actualWork: false,
    }),
    null,
    'reload initialization is silent',
  );
});

test('sync sound preference is local, defaults on, and audio failure is non-fatal', () => {
  const storage = memoryStorage();
  const cues: SyncSoundCue[] = [];
  const feedback = new SyncSoundFeedback(
    {
      unlock() {
        throw new Error('blocked');
      },
      play(cue) {
        cues.push(cue);
      },
    },
    storage,
  );
  assert.equal(feedback.enabled, true);
  assert.doesNotThrow(() => feedback.unlock());
  feedback.setEnabled(false);
  assert.equal(storage.getItem(SYNC_SOUNDS_PREFERENCE_KEY), 'false');
  feedback.notify({
    id: 1,
    previousStatus: 'syncing',
    currentStatus: 'synced',
    actualWork: true,
  });
  feedback.setEnabled(true);
  feedback.notify({
    id: 1,
    previousStatus: 'syncing',
    currentStatus: 'synced',
    actualWork: true,
  });
  assert.deepEqual(cues, [], 'a disabled event is consumed and never replayed');

  const failing = new SyncSoundFeedback(
    {
      unlock() {},
      play() {
        throw new Error('audio unavailable');
      },
    },
    memoryStorage(),
  );
  assert.doesNotThrow(() =>
    failing.notify({
      id: 2,
      previousStatus: 'syncing',
      currentStatus: 'attention',
    }),
  );

  const inaccessibleStorage: SyncSoundStorage = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  const resilient = new SyncSoundFeedback(
    { unlock() {}, play() {} },
    inaccessibleStorage,
  );
  assert.equal(resilient.enabled, true);
  assert.doesNotThrow(() => resilient.setEnabled(false));
  assert.equal(resilient.enabled, false);
});

test('coordinator surfaces initialization persistence failure instead of staying loading', async () => {
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
    const module = (await server.ssrLoadModule(
      '/src/sync/coordinator.ts',
    )) as typeof import('../src/sync/coordinator.ts');
    const coordinator = new module.GoogleDriveSyncCoordinator(
      async () => {
        throw new Error('simulated IndexedDB failure');
      },
      { notify() {} },
    );
    await assert.rejects(
      () => coordinator.initialize(),
      /could not save changes locally/u,
    );
    const state = coordinator.getSnapshot();
    assert.equal(state.connection, 'error');
    assert.equal(state.issue?.code, 'local-persistence-failed');
    assert.equal(state.progress.phase, 'idle');
    assert.equal(module.getSyncUiStatus(state), 'attention');
    assert.doesNotMatch(state.error ?? '', /safe|saved locally/iu);
  } finally {
    await server.close();
  }
});

test('sync drawer is compact, accessible, and keeps diagnostics expandable', async () => {
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
    const synced = viewState({
      connection: 'connected',
      lastSuccessfulAt: Date.now(),
    });
    const compact = renderToStaticMarkup(
      createElement(SyncDrawer, {
        state: synced,
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
    assert.match(compact, /Google Drive/);
    assert.match(compact, />Synced</);
    assert.match(compact, /Last synced:/);
    assert.match(compact, />Sync now</);
    assert.match(compact, /aria-label="Auto sync"/);
    assert.match(compact, /aria-label="Sync sounds"/);
    assert.match(compact, /<details class="sync-details">/);
    assert.match(compact, /<details class="sync-advanced">/);
    assert.doesNotMatch(compact, /sync-progress|sync-error/);

    const storageIssue = classifySyncError(
      new DriveRequestError(
        'sanitized',
        403,
        'storage-full',
        'upload',
        'storageQuotaExceeded',
      ),
      { online: true, area: 'sync' },
    );
    const driveFull = renderToStaticMarkup(
      createElement(SyncDrawer, {
        state: viewState({ connection: 'error', issue: storageIssue }),
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
    assert.match(driveFull, /data-sync-state="drive-full"/);
    assert.match(driveFull, /Download local backup/);
    assert.match(driveFull, /data-sync-action="open-google-drive"/);
    assert.match(driveFull, /<details class="sync-details">[\s\S]*drive-storage-full/);

    const determinate = renderToStaticMarkup(
      createElement(SyncDrawer, {
        state: viewState({
          connection: 'syncing',
          progress: { phase: 'uploading', completed: 1, total: 3 },
        }),
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
    assert.match(determinate, /<progress[^>]*max="3"[^>]*value="1"/);
    assert.match(determinate, /Uploading PDF 2 of 3/);

    const indeterminate = renderToStaticMarkup(
      createElement(SyncDrawer, {
        state: viewState({
          connection: 'syncing',
          progress: { phase: 'discovering' },
        }),
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
    assert.match(indeterminate, /sync-activity-indicator/);
    assert.doesNotMatch(indeterminate, /<progress/);
    assert.match(indeterminate, /Checking Drive…/);
  } finally {
    await server.close();
  }
});

test('drawer backup and sounds stay local and outside arbitrary React renders', () => {
  const control = source('../src/sync/SyncControl.tsx');
  const coordinator = source('../src/sync/coordinator.ts');
  const backup = source('../src/services/libraryBackup.ts');
  assert.match(control, /await flushLocalPersistence\(\)/);
  assert.match(control, /await downloadLibraryBackup\(/);
  assert.doesNotMatch(control, /fetch\(/);
  assert.match(backup, /URL\.createObjectURL\(blob\)/);
  assert.match(backup, /link\.download = filename/);
  assert.match(coordinator, /soundFeedback\.notify\(/);
  assert.match(coordinator, /!this\.view\.issue\?\.blocksOrdinarySync/);
  assert.doesNotMatch(control, /\.play\(/);
  assert.match(control, /aria-controls=\{PANEL_ID\}/);
  assert.match(control, /aria-labelledby=\{PANEL_TITLE_ID\}/);
  assert.match(control, /aria-live="polite"/);
});

function memoryStorage(): SyncSoundStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
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

function coordinatorStub() {
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
  } as unknown as import('../src/sync/coordinator.ts').GoogleDriveSyncCoordinator;
}
