import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type {
  PaperConnectionStatus,
  PaperGoogleDriveSyncCoordinator as PaperGoogleDriveSyncCoordinatorType,
  PaperSyncViewState,
} from '../src/sync/paperCoordinator.ts';
import type { PaperCloudSummary, PaperSyncState } from '../src/sync/paperTypes.ts';
import type { PaperSyncDeviceProfile } from '../src/sync/storage.ts';

const TEST_STORAGE_ID = '\0local-removal-test-storage';

let server: ViteDevServer;
let PaperGoogleDriveSyncCoordinator: typeof import('../src/sync/paperCoordinator.ts').PaperGoogleDriveSyncCoordinator;

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: 'local-removal-test-storage',
        enforce: 'pre',
        resolveId(source) {
          return source === './storage.ts' ? TEST_STORAGE_ID : undefined;
        },
        load(id) {
          return id === TEST_STORAGE_ID ? inMemoryStorageModule : undefined;
        },
      },
    ],
    server: { middlewareMode: true },
  });
  const coordinator = (await server.ssrLoadModule(
    '/src/sync/paperCoordinator.ts',
  )) as typeof import('../src/sync/paperCoordinator.ts');
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
});

after(async () => server.close());

test('intentional local-removal lifecycle converges immediately without upload dirt', async () => {
  const coordinator = configuredCoordinator(['doc-a']);
  const scheduled: string[][] = [];
  Reflect.set(
    coordinator,
    'scheduleLocalRemovalReconciliation',
    (documentIds: readonly string[]) => scheduled.push([...documentIds]),
  );

  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-a',
    localRemoval: 'started',
  });
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-a',
    categories: ['deleted', 'metadata', 'notes'],
  });
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'productivity',
    documentId: 'doc-a',
  });

  assert.equal(
    (Reflect.get(coordinator, 'activeLocalRemovalIds') as Set<string>).has('doc-a'),
    true,
  );
  assert.deepEqual(stateFor(coordinator, 'doc-a').dirtyReasons, []);

  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-a',
    localRemoval: 'committed',
  });

  const state = stateFor(coordinator, 'doc-a');
  const paper = paperFor(coordinator, 'doc-a');
  assert.equal(state.availability, 'cloud-only');
  assert.equal(state.status, 'cloud-only');
  assert.equal(state.locallyDeleted, false);
  assert.deepEqual(state.dirtyReasons, []);
  assert.equal(paper.localAvailability, 'cloud-only');
  assert.equal(paper.status, 'cloud-only');
  assert.equal(paper.issue, undefined);
  assert.equal(coordinator.getSnapshot().issue, undefined);
  assert.equal(
    (Reflect.get(coordinator, 'blockingPaperIssues') as Map<string, unknown>).size,
    0,
  );
  assert.deepEqual(scheduled, [['doc-a']]);
});

test('post-delete reconciliation is exact-paper scoped and never enumerates local papers', async () => {
  const coordinator = configuredCoordinator(['doc-a', 'doc-b']);
  const calls: Array<{
    documentIds: string[];
    options: { layoutValidated?: boolean; reuseVerifiedManifests?: boolean };
  }> = [];
  let fullDiscoveryCalls = 0;
  let localListCalls = 0;
  const signal = new AbortController().signal;

  Reflect.set(coordinator, 'identity', { hasDeviceSession: true });
  Reflect.set(coordinator, 'local', {
    async listLocalPapers() {
      localListCalls += 1;
      throw new Error('Scoped local-removal reconciliation must not list the library.');
    },
  });
  Reflect.set(coordinator, 'beginOperation', async () => signal);
  Reflect.set(coordinator, 'endOperation', () => undefined);
  Reflect.set(coordinator, 'ensureRepository', async () => ({
    async discover() {
      fullDiscoveryCalls += 1;
      throw new Error('Full discovery is forbidden for a local removal.');
    },
    async discoverPapers(
      documentIds: readonly string[],
      _states: readonly PaperSyncState[],
      _signal: AbortSignal,
      options: { layoutValidated?: boolean; reuseVerifiedManifests?: boolean },
    ) {
      calls.push({ documentIds: [...documentIds], options });
      return {
        papers: documentIds.map((documentId) => cloudPaper(documentId)),
        missingDocumentIds: [],
      };
    },
  }));

  await invokePrivate(coordinator, 'reconcileCommittedLocalRemovals', ['doc-b']);

  assert.deepEqual(calls, [
    {
      documentIds: ['doc-b'],
      options: { layoutValidated: true, reuseVerifiedManifests: true },
    },
  ]);
  assert.equal(fullDiscoveryCalls, 0);
  assert.equal(localListCalls, 0);
  assert.equal(stateFor(coordinator, 'doc-b').status, 'cloud-only');
  assert.equal(stateFor(coordinator, 'doc-b').availability, 'cloud-only');
  assert.equal(stateFor(coordinator, 'doc-a').status, 'synced');
  assert.equal(stateFor(coordinator, 'doc-a').availability, 'local-and-cloud');
});

test('same-turn local removals coalesce once and keep every paper independent', async () => {
  const coordinator = configuredCoordinator(['doc-a', 'doc-b', 'doc-c']);
  const documentIds = ['doc-a', 'doc-b', 'doc-c'];
  const reconciliations: string[][] = [];
  Reflect.set(
    coordinator,
    'reconcileCommittedLocalRemovals',
    async (documentIds: readonly string[]) => {
      reconciliations.push([...documentIds]);
      const capturedEpochs = new Map(
        documentIds.map((documentId) => [
          documentId,
          (
            Reflect.get(coordinator, 'localRemovalEpoch') as (id: string) => number
          ).call(coordinator, documentId),
        ]),
      );
      await invokePrivate(
        coordinator,
        'applyLocalRemovalDiscovery',
        documentIds,
        capturedEpochs,
        documentIds.map((documentId) => cloudPaper(documentId)),
        [],
      );
    },
  );

  await Promise.all(
    documentIds.map((documentId) =>
      invokePrivate(coordinator, 'markDirty', {
        kind: 'document',
        documentId,
        localRemoval: 'started',
      }),
    ),
  );
  const commits = documentIds.map((documentId) =>
    invokePrivate(coordinator, 'markDirty', {
      kind: 'document',
      documentId,
      localRemoval: 'committed',
    }),
  );
  await Promise.all([
    ...commits,
    invokePrivate(coordinator, 'waitForLocalRemovalSettlement'),
  ]);

  assert.deepEqual(reconciliations, [['doc-a', 'doc-b', 'doc-c']]);
  for (const documentId of documentIds) {
    assert.equal(stateFor(coordinator, documentId).availability, 'cloud-only');
    assert.equal(stateFor(coordinator, documentId).status, 'cloud-only');
    assert.equal(paperFor(coordinator, documentId).status, 'cloud-only');
    assert.equal(paperFor(coordinator, documentId).issue, undefined);
  }
});

test('global Retry waits for both the local commit and its scoped reconciliation', async () => {
  const coordinator = configuredCoordinator(['doc-a']);
  const reconciliation = deferred<void>();
  const events: string[] = [];
  const signal = new AbortController().signal;
  const trackedReconciliation = reconciliation.promise.finally(() => {
    Reflect.set(coordinator, 'localRemovalReconcilePromise', null);
    events.push('scoped-reconcile-settled');
  });

  invokeSyncPrivate(coordinator, 'beginLocalRemoval', ['doc-a']);
  Reflect.set(coordinator, 'localRemovalReconcilePromise', trackedReconciliation);
  Reflect.set(coordinator, 'beginOperation', async () => {
    events.push('drive-owner');
    return signal;
  });
  Reflect.set(coordinator, 'endOperation', () => events.push('drive-released'));
  Reflect.set(coordinator, 'ensureRepository', async () => ({}));
  Reflect.set(coordinator, 'reconcileLocalPaperStates', async () => {
    events.push('local-state-scan');
  });
  Reflect.set(coordinator, 'discoverWithFastPath', async () => {
    events.push('drive-discovery');
  });

  const retry = coordinator.retryNow();
  await settleMicrotasks();
  assert.deepEqual(events, []);

  invokeSyncPrivate(coordinator, 'finishLocalRemoval', ['doc-a'], true);
  await settleMicrotasks();
  assert.deepEqual(events, []);

  reconciliation.resolve();
  await retry;
  assert.deepEqual(events, [
    'scoped-reconcile-settled',
    'drive-owner',
    'local-state-scan',
    'drive-discovery',
    'drive-released',
  ]);
});

test('stale snapshot detection is superseded only by a committed local removal', async () => {
  const committed = configuredCoordinator(['doc-commit']);
  const capturedCommitEpoch = invokeSyncPrivate<number>(
    committed,
    'localRemovalEpoch',
    'doc-commit',
  );
  invokeSyncPrivate(committed, 'beginLocalRemoval', ['doc-commit']);
  const committedDecision = invokePrivate<boolean>(
    committed,
    'staleBecauseLocalRemoval',
    'doc-commit',
    capturedCommitEpoch,
  );
  await settleMicrotasks();
  invokeSyncPrivate(committed, 'finishLocalRemoval', ['doc-commit'], true);
  assert.equal(await committedDecision, true);

  const aborted = configuredCoordinator(['doc-abort']);
  const capturedAbortEpoch = invokeSyncPrivate<number>(
    aborted,
    'localRemovalEpoch',
    'doc-abort',
  );
  invokeSyncPrivate(aborted, 'beginLocalRemoval', ['doc-abort']);
  const abortedDecision = invokePrivate<boolean>(
    aborted,
    'staleBecauseLocalRemoval',
    'doc-abort',
    capturedAbortEpoch,
  );
  await settleMicrotasks();
  invokeSyncPrivate(aborted, 'finishLocalRemoval', ['doc-abort'], false);
  assert.equal(await abortedDecision, false);

  const committedThenAborted = configuredCoordinator(['doc-commit-then-abort']);
  const capturedOriginalEpoch = invokeSyncPrivate<number>(
    committedThenAborted,
    'localRemovalEpoch',
    'doc-commit-then-abort',
  );
  invokeSyncPrivate(committedThenAborted, 'beginLocalRemoval', [
    'doc-commit-then-abort',
  ]);
  invokeSyncPrivate(
    committedThenAborted,
    'finishLocalRemoval',
    ['doc-commit-then-abort'],
    true,
  );
  invokeSyncPrivate(committedThenAborted, 'beginLocalRemoval', [
    'doc-commit-then-abort',
  ]);
  invokeSyncPrivate(
    committedThenAborted,
    'finishLocalRemoval',
    ['doc-commit-then-abort'],
    false,
  );
  assert.equal(
    await invokePrivate<boolean>(
      committedThenAborted,
      'staleBecauseLocalRemoval',
      'doc-commit-then-abort',
      capturedOriginalEpoch,
    ),
    true,
  );
});

test('committed local removal supersedes a failing Keep local snapshot without attention', async () => {
  const coordinator = configuredCoordinator(['doc-keep-local']);
  const state = stateFor(coordinator, 'doc-keep-local');
  state.status = 'remote-update-available';
  state.incorporatedHeadIds = [];
  paperFor(coordinator, 'doc-keep-local').status = 'remote-update-available';
  const enteredRepository = deferred<void>();
  const releaseRepository = deferred<void>();
  const signal = new AbortController().signal;
  let catalogApplications = 0;

  Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
  Reflect.set(coordinator, 'identity', { hasDeviceSession: true });
  Reflect.set(coordinator, 'beginOperation', async () => signal);
  Reflect.set(coordinator, 'endOperation', () => undefined);
  Reflect.set(coordinator, 'scheduleLocalRemovalReconciliation', () => undefined);
  Reflect.set(coordinator, 'applyTransferCatalog', async () => {
    catalogApplications += 1;
  });
  Reflect.set(coordinator, 'local', {
    async createPaperPackage() {
      return localPackage('doc-keep-local');
    },
  });
  Reflect.set(coordinator, 'ensureRepository', async () => ({
    async reconcileKeepLocalPaper() {
      enteredRepository.resolve();
      await releaseRepository.promise;
      throw new Error('Injected stale Keep local failure.');
    },
  }));

  const keepLocal = coordinator.keepLocalSelected(['doc-keep-local']);
  await enteredRepository.promise;
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-keep-local',
    localRemoval: 'started',
  });
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-keep-local',
    localRemoval: 'committed',
  });
  releaseRepository.resolve();
  await keepLocal;

  assert.equal(stateFor(coordinator, 'doc-keep-local').status, 'cloud-only');
  assert.equal(stateFor(coordinator, 'doc-keep-local').availability, 'cloud-only');
  assert.equal(catalogApplications, 0);
  assert.equal(
    (Reflect.get(coordinator, 'blockingPaperIssues') as Map<string, unknown>).size,
    0,
  );
  assert.equal(coordinator.getSnapshot().issue, undefined);
});

test('committed local removal prevents Restore failure from recreating local state or attention', async () => {
  const coordinator = configuredCoordinator(['doc-restore']);
  const state = stateFor(coordinator, 'doc-restore');
  state.availability = 'local-only';
  state.status = 'local-only';
  state.cloudPresence = 'removed';
  state.remoteHeadIds = [];
  const paper = paperFor(coordinator, 'doc-restore');
  paper.localAvailability = 'local-only';
  paper.status = 'local-only';
  paper.presenceState = 'removed';
  paper.headIds = [];
  const enteredRepository = deferred<void>();
  const releaseRepository = deferred<void>();
  const signal = new AbortController().signal;
  let appliedErrors = 0;

  Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
  Reflect.set(coordinator, 'identity', { hasDeviceSession: true });
  Reflect.set(coordinator, 'beginOperation', async () => signal);
  Reflect.set(coordinator, 'endOperation', () => undefined);
  Reflect.set(coordinator, 'scheduleLocalRemovalReconciliation', () => undefined);
  Reflect.set(coordinator, 'applyError', () => {
    appliedErrors += 1;
  });
  Reflect.set(coordinator, 'local', {
    async createPaperPackage() {
      return localPackage('doc-restore');
    },
  });
  Reflect.set(coordinator, 'ensureRepository', async () => ({
    async restorePaper() {
      enteredRepository.resolve();
      await releaseRepository.promise;
      throw new Error('Injected stale Restore failure.');
    },
  }));

  const restore = coordinator.restoreToGoogleDrive('doc-restore');
  await enteredRepository.promise;
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-restore',
    localRemoval: 'started',
  });
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'document',
    documentId: 'doc-restore',
    localRemoval: 'committed',
  });
  releaseRepository.resolve();
  await assert.rejects(() => restore, /Injected stale Restore failure/u);

  assert.equal(
    coordinator
      .getSnapshot()
      .paperStates.some(({ documentId }) => documentId === 'doc-restore'),
    false,
  );
  assert.equal(
    coordinator
      .getSnapshot()
      .papers.some(({ documentId }) => documentId === 'doc-restore'),
    false,
  );
  assert.equal(appliedErrors, 0);
  assert.equal(
    (Reflect.get(coordinator, 'blockingPaperIssues') as Map<string, unknown>).size,
    0,
  );
});

test('a newer saved Print PDF survives an older Drive Download apply and remains dirty', async () => {
  const documentId = 'doc-print-race';
  const coordinator = configuredCoordinator([documentId]);
  const paper = paperFor(coordinator, documentId);
  paper.sourceArtifact = {
    documentId,
    documentType: 'pdf',
    fileName: 'source.pdf',
    mimeType: 'application/pdf',
    size: 4,
    sha256: '1'.repeat(64),
    fileId: 'source-file',
    driveRole: 'paper-source-pdf',
  };
  const artifactA = renderedPrintPdf(documentId, 'a');
  const artifactB = renderedPrintPdf(documentId, 'b');
  let storedArtifact = artifactA;
  let appliedArtifactSha: string | undefined;
  let capturedExpectedSha: unknown;
  const enteredApply = deferred<void>();
  const releaseApply = deferred<void>();
  const signal = new AbortController().signal;

  Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
  Reflect.set(coordinator, 'beginOperation', async () => signal);
  Reflect.set(coordinator, 'endOperation', () => undefined);
  Reflect.set(coordinator, 'scheduleAutoUpload', () => undefined);
  Reflect.set(coordinator, 'applyTransferCatalog', async () => undefined);
  Reflect.set(coordinator, 'drive', {
    async measureOperationPhase(_phase: string, operation: () => Promise<unknown>) {
      return operation();
    },
    recordOperationStateTransition() {},
    recordOperationRetry() {},
  });
  Reflect.set(coordinator, 'local', {
    async hasReusableStoredSource() {
      return false;
    },
    async captureRenderedPrintPdfStorageIdentity() {
      return renderedPrintPdfStorageIdentity(storedArtifact);
    },
    async applyDownloadedPaper(
      result: { renderedPrintPdf?: typeof artifactA },
      _signal: AbortSignal,
      options: {
        expectedRenderedPrintPdf: ReturnType<typeof renderedPrintPdfStorageIdentity>;
      },
    ) {
      appliedArtifactSha = result.renderedPrintPdf?.sha256;
      capturedExpectedSha =
        options.expectedRenderedPrintPdf.value.state === 'stored'
          ? options.expectedRenderedPrintPdf.value.sha256
          : undefined;
      enteredApply.resolve();
      await releaseApply.promise;
      if (capturedExpectedSha === storedArtifact.sha256 && result.renderedPrintPdf) {
        storedArtifact = result.renderedPrintPdf;
      }
      return {
        changedDocumentIds: [documentId],
        deletedDocumentIds: [],
        async rollback() {},
        publish() {},
      };
    },
  });
  Reflect.set(coordinator, 'ensureRepository', async () => ({
    async downloadPaper() {
      return {
        documentId,
        displayName: documentId.toUpperCase(),
        snapshot: {
          app: '39Note' as const,
          syncSchemaVersion: 1 as const,
          generatedAt: 2,
          generatedBy: 'device-remote',
          entities: [
            {
              key: `document::${documentId}`,
              kind: 'document' as const,
              id: documentId,
              value: {},
              version: {
                updatedAt: 2,
                deviceId: 'device-remote',
                hash: '2'.repeat(64),
              },
            },
          ],
          tombstones: [],
          pdfs: [],
        },
        renderedPrintPdf: artifactA,
        headIds: [...paper.headIds],
        conflicts: [],
        cloud: paper,
      };
    },
  }));

  const download = invokePrivate(coordinator, 'downloadSelectedOwned', [documentId]);
  await enteredApply.promise;
  storedArtifact = artifactB;
  await invokePrivate(coordinator, 'markDirty', {
    kind: 'productivity',
    documentId,
    categories: ['rendered-print-pdf'],
  });
  releaseApply.resolve();
  await download;

  assert.equal(capturedExpectedSha, artifactA.sha256);
  assert.equal(appliedArtifactSha, artifactA.sha256);
  assert.equal(storedArtifact.sha256, artifactB.sha256);
  assert.deepEqual(stateFor(coordinator, documentId).dirtyReasons, [
    'rendered-print-pdf',
  ]);
  assert.equal(stateFor(coordinator, documentId).dirtyGeneration, 1);
  assert.equal(stateFor(coordinator, documentId).status, 'local-changes');
});

test('malformed and ambiguous scoped summaries remain blocking and paper-local', async () => {
  const coordinator = configuredCoordinator([
    'doc-malformed',
    'doc-ambiguous',
    'doc-safe',
  ]);
  const malformed = {
    ...cloudPaper('doc-malformed'),
    status: 'needs-attention' as const,
    issue: {
      code: 'paper-presence-invalid',
      message: 'Paper presence is malformed.',
    },
  };
  const ambiguous = {
    ...cloudPaper('doc-ambiguous'),
    status: 'needs-attention' as const,
    issue: {
      code: 'ambiguous-paper-folder',
      message: 'Multiple paper folders claim this identity.',
    },
  };

  await invokePrivate(
    coordinator,
    'applyLocalRemovalDiscovery',
    ['doc-malformed', 'doc-ambiguous'],
    new Map([
      ['doc-malformed', 0],
      ['doc-ambiguous', 0],
    ]),
    [malformed, ambiguous],
    [],
  );

  assert.equal(stateFor(coordinator, 'doc-malformed').status, 'needs-attention');
  assert.equal(stateFor(coordinator, 'doc-ambiguous').status, 'needs-attention');
  assert.equal(paperFor(coordinator, 'doc-malformed').status, 'needs-attention');
  assert.equal(paperFor(coordinator, 'doc-ambiguous').status, 'needs-attention');
  assert.equal(stateFor(coordinator, 'doc-safe').status, 'synced');
  assert.equal(paperFor(coordinator, 'doc-safe').issue, undefined);
  assert.deepEqual(
    [
      ...(
        Reflect.get(coordinator, 'blockingPaperIssues') as Map<string, unknown>
      ).keys(),
    ].sort(),
    ['doc-ambiguous', 'doc-malformed'],
  );
});

function configuredCoordinator(
  documentIds: readonly string[],
): PaperGoogleDriveSyncCoordinatorType {
  const coordinator = new PaperGoogleDriveSyncCoordinator({ notify() {} });
  const states = documentIds.map((documentId) => paperState(documentId));
  const papers = documentIds.map((documentId) => cloudPaper(documentId));
  Reflect.set(coordinator, 'profile', profile());
  Reflect.set(
    coordinator,
    'paperStates',
    new Map(states.map((state) => [state.documentId, state])),
  );
  Reflect.set(coordinator, 'view', viewState({ papers, paperStates: states }));
  return coordinator;
}

function stateFor(
  coordinator: PaperGoogleDriveSyncCoordinatorType,
  documentId: string,
): PaperSyncState {
  const state = coordinator
    .getSnapshot()
    .paperStates.find((candidate) => candidate.documentId === documentId);
  assert.ok(state, `Missing paper state for ${documentId}`);
  return state;
}

function paperFor(
  coordinator: PaperGoogleDriveSyncCoordinatorType,
  documentId: string,
): PaperCloudSummary {
  const paper = coordinator
    .getSnapshot()
    .papers.find((candidate) => candidate.documentId === documentId);
  assert.ok(paper, `Missing cloud paper for ${documentId}`);
  return paper;
}

function paperState(documentId: string): PaperSyncState {
  const headId = `head-${documentId}`;
  return {
    documentId,
    displayName: documentId.toUpperCase(),
    deviceId: 'device-a',
    availability: 'local-and-cloud',
    status: 'synced',
    dirtyGeneration: 0,
    dirtyReasons: [],
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    incorporatedHeadIds: [headId],
    remoteHeadIds: [headId],
    pdfFingerprints: {},
    driveFiles: {
      paperFolderId: `folder-${documentId}`,
      dataFolderId: `data-${documentId}`,
      sourcePdfFileId: `pdf-${documentId}`,
      fileIds: {},
    },
    cloudPresence: 'present',
    presenceHeadIds: [`presence-${documentId}`],
  };
}

function cloudPaper(documentId: string): PaperCloudSummary {
  return {
    documentId,
    displayName: documentId.toUpperCase(),
    deleted: false,
    paperFolderId: `folder-${documentId}`,
    dataFolderId: `data-${documentId}`,
    headIds: [`head-${documentId}`],
    headSetId: `head-set-${documentId}`,
    localAvailability: 'local-and-cloud',
    status: 'synced',
    presenceState: 'present',
    presenceHeadIds: [`presence-${documentId}`],
  };
}

function localPackage(documentId: string) {
  return {
    documentId,
    displayName: documentId.toUpperCase(),
    snapshot: {
      app: '39Note' as const,
      syncSchemaVersion: 1 as const,
      generatedAt: 1,
      generatedBy: 'device-a',
      entities: [],
      tombstones: [],
      pdfs: [],
    },
    writer: { deviceId: 'device-a' },
    deleted: false,
  };
}

function renderedPrintPdf(documentId: string, marker: string) {
  const blob = new Blob([`%PDF-1.7\n${marker}\n%%EOF\n`], {
    type: 'application/pdf',
  });
  return {
    kind: 'rendered-print-pdf' as const,
    documentId,
    fileName: `${documentId} - Print.pdf`,
    mimeType: 'application/pdf' as const,
    size: blob.size,
    sha256: marker.repeat(64),
    renderedFromDraftHash: 'd'.repeat(64),
    createdAt: marker === 'a' ? 1 : 2,
    storedAt: marker === 'a' ? 1 : 2,
    blob,
  };
}

function renderedPrintPdfStorageIdentity(
  artifact: ReturnType<typeof renderedPrintPdf>,
) {
  return {
    kind: 'rendered-print-pdf-storage-identity' as const,
    value: {
      state: 'stored' as const,
      kind: artifact.kind,
      documentId: artifact.documentId,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      size: artifact.size,
      blobSize: artifact.blob.size,
      sha256: artifact.sha256,
      renderedFromDraftHash: artifact.renderedFromDraftHash,
      createdAt: artifact.createdAt,
      storedAt: artifact.storedAt,
      fileId: undefined,
    },
  };
}

function profile(): PaperSyncDeviceProfile {
  return {
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    deviceMode: 'personal',
    autoSync: true,
    accountId: 'account-a',
    rootFolderId: 'root-a',
  };
}

function viewState(overrides: Partial<PaperSyncViewState> = {}): PaperSyncViewState {
  return {
    connection: 'connected' as PaperConnectionStatus,
    backendConfigured: true,
    deviceMode: 'personal',
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

async function invokePrivate<T = void>(
  target: object,
  name: string,
  ...args: unknown[]
): Promise<T> {
  const method = Reflect.get(target, name);
  assert.equal(typeof method, 'function', `${name} should be callable`);
  return Reflect.apply(method, target, args) as Promise<T>;
}

function invokeSyncPrivate<T = void>(
  target: object,
  name: string,
  ...args: unknown[]
): T {
  const method = Reflect.get(target, name);
  assert.equal(typeof method, 'function', `${name} should be callable`);
  return Reflect.apply(method, target, args) as T;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const inMemoryStorageModule = String.raw`
export class LocalSyncPersistenceError extends Error {
  constructor(operation, cause) {
    super('Local sync persistence failed.', { cause });
    this.name = 'LocalSyncPersistenceError';
    this.operation = operation;
  }
}

export function createDefaultPaperSyncState(documentId, deviceId, availability = 'local-only') {
  return {
    documentId,
    deviceId,
    availability,
    status: availability === 'cloud-only' ? 'cloud-only' : 'local-only',
    dirtyGeneration: availability === 'local-only' ? 1 : 0,
    dirtyReasons: availability === 'local-only' ? ['metadata', 'source-pdf'] : [],
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

const profile = {
  id: 'paper-device',
  deviceId: 'device-a',
  deviceLabel: 'Device A',
  deviceMode: 'personal',
  autoSync: true,
};

export const clearLayoutMigrationRecord = async () => undefined;
export const clearPaperV3MigrationRecord = async () => undefined;
export const clearTemporarySessionProvenance = async () => undefined;
export const closeSyncPersistenceWorkspace = async () => undefined;
export const deletePaperSyncRecords = async () => undefined;
export const loadCloudPaperCatalog = async () => [];
export const loadLayoutMigrationRecord = async () => null;
export const loadPaperSyncDeviceProfile = async () => ({ ...profile });
export const loadPaperSyncStates = async () => [];
export const loadPaperV3MigrationRecord = async () => null;
export const loadSyncDeviceState = async () => null;
export const loadTemporarySessionProvenance = async () => null;
export const saveCloudPaperCatalog = async () => undefined;
export const saveLayoutMigrationRecord = async () => undefined;
export const savePaperSyncDeviceProfile = async () => undefined;
export const savePaperSyncState = async () => undefined;
export const savePaperSyncStates = async () => undefined;
export const savePaperV3MigrationRecord = async () => undefined;
export const saveSyncDeviceState = async () => undefined;
export const saveTemporarySessionProvenance = async () => undefined;
`;
