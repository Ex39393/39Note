import type { RestorePreview } from '../../src/services/libraryBackup.ts';
import type { ProductivityBackupDocument } from '../../src/services/productivityPersistence.ts';
import type {
  PaperGoogleDriveSyncCoordinator,
  PaperSyncViewState,
} from '../../src/sync/paperCoordinator.ts';
import type { StoredDocumentSource } from '../../src/types/document.ts';
import type { CollectionRecord } from '../../src/types/library.ts';
import type { StoredRenderedPrintPdf } from '../../src/types/productivity.ts';

interface NativeResult {
  name: string;
  outcome: 'PASS' | 'FAIL';
  detail?: string;
}

const results: NativeResult[] = [];
const hashes: Array<{ name: string; before: string; after: string }> = [];
const databaseNames = new Set<string>();
const originalFetch = window.fetch.bind(window);
let unauthorizedRequests = 0;

const [
  engine,
  annotation,
  productivity,
  temporaryWorkspace,
  hashing,
  restoreStartup,
  restoreSafety,
  workspaceLocks,
  syncStorage,
  syncTypes,
  coordinatorModule,
  repositoryModule,
  localAdapterModule,
  reactModule,
  reactDomClient,
  paperSyncUi,
] = await Promise.all([
  import('../../src/services/crashSafeRestoreEngine.ts'),
  import('../../src/services/annotationPersistence.ts'),
  import('../../src/services/productivityPersistence.ts'),
  import('../../src/services/temporaryWorkspace.ts'),
  import('../../src/services/restoreFingerprint.ts'),
  import('../../src/services/restoreSafetyStartup.ts'),
  import('../../src/services/restoreSafety.ts'),
  import('../../src/services/workspaceRestoreLock.ts'),
  import('../../src/sync/storage.ts'),
  import('../../src/sync/types.ts'),
  import('../../src/sync/paperCoordinator.ts'),
  import('../../src/sync/paperDriveRepository.ts'),
  import('../../src/sync/paperLocalAdapter.ts'),
  import('react'),
  import('react-dom/client'),
  import('../../src/sync/PaperSyncControl.tsx'),
]);

window.fetch = async (...args) => {
  const raw = args[0] instanceof Request ? args[0].url : String(args[0]);
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) unauthorizedRequests += 1;
  return originalFetch(...args);
};

await runCase(
  'backup formats v1-v5 restore into isolated publication holds',
  async () => {
    for (const version of [1, 2, 3, 4, 5]) {
      await activateFreshWorkspace();
      const documentId = crypto.randomUUID();
      const preview = await createPreview(version, documentId, {
        rich: version === 5,
        title: `Synthetic v${version}`,
      });
      const result = await engine.runCrashSafeRestore({ preview });
      assertEqual(result.phase, 'publication-hold', `v${version} phase`);
      assertEqual(result.created, 1, `v${version} create count`);
      const bundle = await readBundle(documentId);
      assertEqual(
        bundle.state?.displayTitle,
        `Synthetic v${version}`,
        `v${version} title`,
      );
      if (version === 5) {
        assert(bundle.source, 'v5 source missing');
        assert(bundle.renderedPrintPdf, 'v5 Print PDF missing');
        assertEqual(bundle.state?.links.length, 1, 'v5 Link count');
        assertEqual(bundle.productivity?.aiConversations.length, 1, 'v5 conversation');
        assertEqual(
          await sha256(bundle.source!.blob),
          preview.documents[0].source?.sha256,
          'v5 source Blob hash',
        );
      } else {
        assertEqual(bundle.renderedPrintPdf, null, `v${version} Print PDF semantics`);
      }
    }
  },
);

await runCase(
  'legacy replace semantics preserve unspecified productivity and clear legacy Print PDFs',
  async () => {
    await activateFreshWorkspace();
    const v1DocumentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, v1DocumentId, {
        rich: true,
        title: 'Legacy v1 old',
      }),
    );
    const v1Replacement = await createPreview(1, v1DocumentId, {
      rich: false,
      title: 'Legacy v1 target',
    });
    await engine.runCrashSafeRestore({
      preview: v1Replacement,
      collisionResolutions: { [v1DocumentId]: 'replace' },
    });
    const v1Bundle = await readBundle(v1DocumentId);
    assertEqual(v1Bundle.state?.displayTitle, 'Legacy v1 target');
    assertEqual(v1Bundle.source, null, 'v1 absent source deletes replaced source');
    assertEqual(v1Bundle.renderedPrintPdf, null, 'v1 clears stale Print PDF');
    assertEqual(
      v1Bundle.productivity?.aiConversations.length,
      1,
      'v1 preserves unspecified productivity',
    );

    await activateFreshWorkspace();
    const v4DocumentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, v4DocumentId, {
        rich: true,
        title: 'Legacy v4 old',
      }),
    );
    const v4Replacement = await createPreview(4, v4DocumentId, {
      rich: false,
      title: 'Legacy v4 target',
    });
    await engine.runCrashSafeRestore({
      preview: v4Replacement,
      collisionResolutions: { [v4DocumentId]: 'replace' },
    });
    const v4Bundle = await readBundle(v4DocumentId);
    assertEqual(v4Bundle.productivity?.aiConversations.length, 0);
    assertEqual(v4Bundle.renderedPrintPdf, null);
  },
);

await runCase(
  'replace and skip preserve skipped documents with zero ancillary writes',
  async () => {
    await activateFreshWorkspace();
    const replaceId = crypto.randomUUID();
    const skipId = crypto.randomUUID();
    const replaceOld = await createPreview(5, replaceId, {
      rich: true,
      title: 'Replace old',
      collectionId: 'collection-old',
    });
    const skipOld = await createPreview(5, skipId, {
      rich: true,
      title: 'Skip old',
      collectionId: 'collection-skip-old',
    });
    await seedPreview(replaceOld);
    await seedPreview(skipOld);
    const skippedBefore = await fingerprintBundle(skipId);
    const replacement = await createPreview(5, replaceId, {
      rich: true,
      title: 'Replace new',
      collectionId: 'collection-active-new',
    });
    const skipped = await createPreview(5, skipId, {
      rich: true,
      title: 'Skip forbidden new',
      collectionId: 'collection-skip-forbidden',
    });
    const combined = combinePreviews([replacement, skipped]);
    const result = await engine.runCrashSafeRestore({
      preview: combined,
      collisionResolutions: { [replaceId]: 'replace', [skipId]: 'skip' },
    });
    assertEqual(result.replaced, 1, 'replace count');
    assertEqual(result.skipped, 1, 'skip count');
    assertEqual((await readBundle(replaceId)).state?.displayTitle, 'Replace new');
    const skippedAfter = await fingerprintBundle(skipId);
    assertEqual(skippedAfter, skippedBefore, 'skipped document fingerprint');
    const collectionIds = new Set(
      (await annotation.listCollections()).map(({ id }) => id),
    );
    assert(collectionIds.has('collection-active-new'), 'active Collection missing');
    assert(
      !collectionIds.has('collection-skip-forbidden'),
      'skipped-only Collection received an ancillary write',
    );
  },
);

await runCase(
  'pre-commit crash rolls back exact records after module re-instantiation',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Rollback old',
      collectionId: 'collection-rollback-old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Rollback target',
      collectionId: 'collection-rollback-target',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview: replacement,
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point) {
          if (point === 'after-action-transaction') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'synthetic interruption was not observed');
    await closePersistenceConnections();
    const reloaded = await reloadEngine('rollback');
    const recovered = await reloaded.recoverCrashSafeRestore();
    assertEqual(recovered.outcome, 'rolled-back', 'rollback outcome');
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'pre-commit rollback', before, after });
    assertEqual(after, before, 'exact rollback fingerprint');
    assertEqual((await reloaded.recoverCrashSafeRestore()).outcome, 'none');
  },
);

await runCase(
  'startup recovery rolls back an interrupted restore before the app can mount',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Startup rollback old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Startup rollback target',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview: replacement,
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point) {
          if (point === 'after-action-transaction') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'startup rollback interruption was not observed');
    await closePersistenceConnections();
    await restoreStartup.verifyRestoreSafetyBeforeAppMount();
    const notice = restoreStartup.consumeRestoreStartupRecoveryNotice();
    assertEqual(notice?.title, 'Interrupted restore rolled back safely');
    assertEqual(
      restoreStartup.consumeRestoreStartupRecoveryNotice(),
      null,
      'startup notice is one-shot',
    );
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'startup pre-commit rollback', before, after });
    assertEqual(after, before, 'startup exact rollback fingerprint');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
  },
);

await runCase(
  'productivity-action interruption rolls back document and ancillary state',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Productivity old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Productivity target',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview: replacement,
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point, context) {
          if (
            point === 'after-action-transaction' &&
            context.actionKind === 'productivity-document'
          ) {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'productivity interruption was not observed');
    assertEqual((await engine.recoverCrashSafeRestore()).outcome, 'rolled-back');
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'productivity rollback', before, after });
    assertEqual(after, before, 'productivity rollback fingerprint');
  },
);

await runCase(
  'verification failure rolls back before the immutable commit marker',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Verify old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Verify target',
    });
    await assertRejects(
      engine.runCrashSafeRestore({
        preview: replacement,
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point) {
          if (point === 'before-commit-verification') {
            throw new Error('Synthetic verification failure');
          }
        },
      }),
      'verification failure',
    );
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'verification rollback', before, after });
    assertEqual(after, before, 'verification rollback fingerprint');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
  },
);

await runCase('pre-aborted restore performs no durable or live writes', async () => {
  await activateFreshWorkspace();
  const documentId = crypto.randomUUID();
  const before = await fingerprintBundle(documentId);
  const controller = new AbortController();
  controller.abort();
  let failureName = '';
  try {
    await engine.runCrashSafeRestore({
      preview: await createPreview(5, documentId, {
        rich: true,
        title: 'Pre-aborted target',
      }),
      signal: controller.signal,
    });
  } catch (error) {
    failureName = error instanceof DOMException ? error.name : String(error);
  }
  assertEqual(failureName, 'AbortError', 'pre-aborted restore error');
  const after = await fingerprintBundle(documentId);
  hashes.push({ name: 'pre-aborted restore', before, after });
  assertEqual(after, before, 'pre-aborted restore fingerprint');
  assertEqual(await annotation.loadDurableRestoreOperation(), null);
});

await runCase(
  'queued restore cancellation rejects before a shared holder releases ownership',
  async () => {
    const workspaceId = await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const before = await fingerprintBundle(documentId);
    const held = await workspaceLocks.acquireSharedWorkspaceRestoreLease();
    try {
      const controller = new AbortController();
      let settled = false;
      let failureName = '';
      const restore = engine.runCrashSafeRestore({
        preview: await createPreview(5, documentId, {
          rich: true,
          title: 'Queued cancellation target',
        }),
        signal: controller.signal,
      });
      void restore.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await waitForPendingLock(
        workspaceLocks.workspaceRestoreLockName(`temporary:${workspaceId}`),
      );
      assertEqual(settled, false, 'restore settled before cancellation');
      controller.abort(new DOMException('Synthetic queued cancellation', 'AbortError'));
      try {
        await withTimeout(
          restore,
          1_000,
          'Queued restore did not reject while the shared holder remained active.',
        );
        failureName = 'resolved';
      } catch (error) {
        failureName = error instanceof DOMException ? error.name : String(error);
      }

      assertEqual(failureName, 'AbortError', 'queued restore cancellation error');
      workspaceLocks.assertWorkspaceRestoreLease(held.lease);
      assertEqual(
        await annotation.loadDurableRestoreOperation(),
        null,
        'queued cancellation durable operation',
      );
      const after = await fingerprintBundle(documentId);
      hashes.push({ name: 'queued restore cancellation', before, after });
      assertEqual(after, before, 'queued cancellation live-data fingerprint');
    } finally {
      held.release();
      await held.settled;
    }
  },
);

await runCase(
  'mid-action cancellation rolls back every applied database action',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, documentId, {
        rich: true,
        title: 'Mid-action cancel old',
      }),
    );
    const before = await fingerprintBundle(documentId);
    const controller = new AbortController();
    let aborted = false;
    let failureName = '';
    try {
      await engine.runCrashSafeRestore({
        preview: await createPreview(5, documentId, {
          rich: true,
          title: 'Mid-action cancel target',
        }),
        collisionResolutions: { [documentId]: 'replace' },
        signal: controller.signal,
        failureInjector(point) {
          if (point === 'after-action-transaction' && !aborted) {
            aborted = true;
            controller.abort();
          }
        },
      });
    } catch (error) {
      failureName = error instanceof DOMException ? error.name : String(error);
    }
    assert(aborted, 'mid-action cancellation was not injected');
    assertEqual(failureName, 'AbortError', 'mid-action cancellation error');
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'mid-action cancellation rollback', before, after });
    assertEqual(after, before, 'mid-action cancellation exact rollback fingerprint');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
  },
);

await runCase(
  'cancellation after target verification still rolls back before commit',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, documentId, {
        rich: true,
        title: 'Late cancel old',
      }),
    );
    const before = await fingerprintBundle(documentId);
    const controller = new AbortController();
    let failureName = '';
    try {
      await engine.runCrashSafeRestore({
        preview: await createPreview(5, documentId, {
          rich: true,
          title: 'Late cancel target',
        }),
        collisionResolutions: { [documentId]: 'replace' },
        signal: controller.signal,
        failureInjector(point) {
          if (point === 'after-commit-verification') controller.abort();
        },
      });
    } catch (error) {
      failureName = error instanceof DOMException ? error.name : String(error);
    }
    assertEqual(failureName, 'AbortError', 'late cancellation error');
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'late cancellation rollback', before, after });
    assertEqual(after, before, 'late cancellation exact rollback fingerprint');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
  },
);

await runCase('progress observers cannot interrupt verified rollback', async () => {
  await activateFreshWorkspace();
  const documentId = crypto.randomUUID();
  await seedPreview(
    await createPreview(5, documentId, {
      rich: true,
      title: 'Observer old',
    }),
  );
  const before = await fingerprintBundle(documentId);
  await assertRejects(
    engine.runCrashSafeRestore({
      preview: await createPreview(5, documentId, {
        rich: true,
        title: 'Observer target',
      }),
      collisionResolutions: { [documentId]: 'replace' },
      onProgress(progress) {
        if (progress.phase === 'rollback') {
          throw new Error('Synthetic observer failure');
        }
      },
      failureInjector(point) {
        if (point === 'before-commit-verification') {
          throw new Error('Synthetic restore failure');
        }
      },
    }),
    'restore failure with throwing observer',
  );
  const after = await fingerprintBundle(documentId);
  hashes.push({ name: 'observer-safe rollback', before, after });
  assertEqual(after, before, 'observer-safe exact rollback fingerprint');
  assertEqual(await annotation.loadDurableRestoreOperation(), null);
});

await runCase(
  'restore inputs are frozen before progress callbacks can mutate caller data',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, documentId, {
        rich: true,
        title: 'Frozen input old',
      }),
    );
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Frozen input target',
    });
    const decisions: Record<string, 'replace' | 'skip'> = {
      [documentId]: 'replace',
    };
    const result = await engine.runCrashSafeRestore({
      preview: replacement,
      collisionResolutions: decisions,
      onProgress(progress) {
        if (progress.phase !== 'validation') return;
        replacement.documents[0].state.displayTitle = 'Caller tampered target';
        decisions[documentId] = 'skip';
      },
    });
    assertEqual(result.replaced, 1, 'frozen replacement count');
    assertEqual(result.skipped, 0, 'frozen skip count');
    assertEqual(
      (await readBundle(documentId)).state?.displayTitle,
      'Frozen input target',
      'frozen target title',
    );
  },
);

await runCase(
  'corrupt PDF Blob is rejected before the first durable journal write',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const preview = await createPreview(5, documentId, {
      rich: true,
      title: 'Corrupt source',
    });
    const source = preview.documents[0].source!;
    const bytes = new Uint8Array(await source.blob.arrayBuffer());
    bytes[Math.max(5, Math.floor(bytes.length / 2))] ^= 0x01;
    const corrupt = { ...source, blob: new Blob([bytes], { type: source.mimeType }) };
    preview.documents[0].source = corrupt;
    preview.documents[0].pdf = { ...corrupt, documentType: 'pdf' };
    await assertRejects(engine.runCrashSafeRestore({ preview }), 'corrupt source');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
    assertEqual((await annotation.getBackupDocumentDataStrict([documentId])).length, 0);
  },
);

await runCase(
  'dangling Collection references are rejected before the first durable write',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const preview = await createPreview(5, documentId, {
      rich: true,
      title: 'Dangling Collection',
    });
    preview.documents[0].state.collectionIds = ['missing-collection'];
    preview.collections = [];
    await assertRejects(engine.runCrashSafeRestore({ preview }), 'dangling Collection');
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
    assertEqual((await annotation.getBackupDocumentDataStrict([documentId])).length, 0);
    assertEqual((await annotation.listCollections()).length, 0);
  },
);

await runCase(
  'post-commit crash preserves target and finishes cleanup forward',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const preview = await createPreview(5, documentId, {
      rich: true,
      title: 'Committed target',
      collectionId: 'collection-committed',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview,
        failureInjector(point) {
          if (point === 'after-commit-marker') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'post-commit interruption was not observed');
    const committedBeforeRecovery = await fingerprintBundle(documentId);
    await closePersistenceConnections();
    const reloaded = await reloadEngine('forward');
    assertEqual(
      (await reloaded.recoverCrashSafeRestore()).outcome,
      'publication-hold',
      'forward recovery outcome',
    );
    const committedAfterRecovery = await fingerprintBundle(documentId);
    hashes.push({
      name: 'post-commit forward recovery',
      before: committedBeforeRecovery,
      after: committedAfterRecovery,
    });
    assertEqual(
      committedAfterRecovery,
      committedBeforeRecovery,
      'committed target fingerprint',
    );
    assertEqual(
      (await annotation.loadDurableRestoreOperation())?.phase,
      'publication-hold',
    );
    assertEqual(
      (await reloaded.recoverCrashSafeRestore()).outcome,
      'publication-hold',
      'repeated forward recovery',
    );
  },
);

await runCase(
  'startup recovery preserves a committed restore and its publication hold',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const preview = await createPreview(5, documentId, {
      rich: true,
      title: 'Startup committed target',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview,
        failureInjector(point) {
          if (point === 'after-commit-marker') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'startup forward interruption was not observed');
    const before = await fingerprintBundle(documentId);
    await closePersistenceConnections();
    await restoreStartup.verifyRestoreSafetyBeforeAppMount();
    const notice = restoreStartup.consumeRestoreStartupRecoveryNotice();
    assertEqual(notice?.title, 'Completed restore recovered');
    const after = await fingerprintBundle(documentId);
    hashes.push({ name: 'startup post-commit recovery', before, after });
    assertEqual(after, before, 'startup committed fingerprint');
    assertEqual(
      (await annotation.loadDurableRestoreOperation())?.phase,
      'publication-hold',
    );
  },
);

await runCase(
  'quota and aborted transactions expose no partial live mutation',
  async () => {
    for (const [name, failurePoint, errorFactory] of [
      [
        'quota',
        'after-snapshot-before-action-marker',
        () => new DOMException('Synthetic quota', 'QuotaExceededError'),
      ],
      [
        'abort',
        'after-live-write-before-action-marker',
        () => new DOMException('Synthetic abort', 'AbortError'),
      ],
    ] as const) {
      await activateFreshWorkspace();
      const documentId = crypto.randomUUID();
      const oldPreview = await createPreview(5, documentId, {
        rich: true,
        title: `${name} old`,
      });
      await seedPreview(oldPreview);
      const before = await fingerprintBundle(documentId);
      const replacement = await createPreview(5, documentId, {
        rich: true,
        title: `${name} target`,
      });
      let failureName = '';
      try {
        await engine.runCrashSafeRestore({
          preview: replacement,
          collisionResolutions: { [documentId]: 'replace' },
          failureInjector(point) {
            if (point === failurePoint) throw errorFactory();
          },
        });
      } catch (error) {
        failureName = error instanceof DOMException ? error.name : String(error);
      }
      assertEqual(failureName, errorFactory().name, `${name} error`);
      const after = await fingerprintBundle(documentId);
      hashes.push({ name: `${name} rollback`, before, after });
      assertEqual(after, before, `${name} exact baseline`);
      assertEqual(await annotation.loadDurableRestoreOperation(), null);
    }
  },
);

await runCase(
  'verification failures roll back and rollback failures retain evidence',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Verification old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Verification target',
    });
    let applyFailed = false;
    let rollbackFailed = false;
    await assertRejects(
      engine.runCrashSafeRestore({
        preview: replacement,
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point) {
          if (point === 'after-action-transaction' && !applyFailed) {
            applyFailed = true;
            throw new Error('Synthetic apply failure');
          }
          if (point === 'before-rollback-action' && !rollbackFailed) {
            rollbackFailed = true;
            throw new Error('Synthetic rollback failure');
          }
        },
      }),
      'restore plus rollback failure',
    );
    const retained = await annotation.loadDurableRestoreOperation();
    assertEqual(retained?.phase, 'recovery-required');
    assert(retained?.enginePlan, 'frozen plan was not retained');
    assertEqual((await engine.recoverCrashSafeRestore()).outcome, 'rolled-back');
    assertEqual(await fingerprintBundle(documentId), before);
  },
);

await runCase(
  'unprovable recovery retains journal evidence and fails closed',
  async () => {
    const workspaceId = await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    await seedPreview(
      await createPreview(5, documentId, {
        rich: true,
        title: 'Unprovable old',
      }),
    );
    const before = await fingerprintBundle(documentId);
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview: await createPreview(5, documentId, {
          rich: true,
          title: 'Unprovable target',
        }),
        collisionResolutions: { [documentId]: 'replace' },
        failureInjector(point) {
          if (point === 'after-action-transaction') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'unprovable recovery interruption was not observed');
    const operation = await annotation.loadDurableRestoreOperation();
    assert(operation?.enginePlan, 'interrupted restore plan missing');
    const annotationDatabaseName = temporaryWorkspace.temporaryDatabaseName(
      temporaryWorkspace.PERSONAL_ANNOTATION_DATABASE_NAME,
      workspaceId,
    );
    await updateRawIndexedDbRecord(
      annotationDatabaseName,
      restoreSafety.RESTORE_OPERATION_STORE,
      operation.workspaceId,
      (value) => ({
        ...value,
        enginePlan: {
          ...(value.enginePlan as Record<string, unknown>),
          planFingerprint: 'f'.repeat(64),
        },
      }),
    );
    await assertRejects(
      engine.recoverCrashSafeRestore(),
      'recovery with a mismatched frozen-plan fingerprint',
    );
    const retained = await annotation.loadDurableRestoreOperation();
    assertEqual(retained?.phase, 'recovery-required');
    const [snapshots, actions] = await Promise.all([
      readRawIndexedDbStore(
        annotationDatabaseName,
        restoreSafety.RESTORE_SNAPSHOT_STORE,
      ),
      readRawIndexedDbStore(annotationDatabaseName, restoreSafety.RESTORE_ACTION_STORE),
    ]);
    assert(snapshots.length > 0, 'recovery snapshots were discarded');
    assert(actions.length > 0, 'recovery action markers were discarded');
    assert(
      (await fingerprintBundle(documentId)) !== before,
      'synthetic interruption did not leave a state requiring recovery',
    );
  },
);

await runCase(
  'partial post-commit cleanup is idempotent and retains publication hold',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const preview = await createPreview(5, documentId, {
      rich: true,
      title: 'Cleanup target',
    });
    let interrupted = false;
    try {
      await engine.runCrashSafeRestore({
        preview,
        failureInjector(point) {
          if (point === 'after-productivity-cleanup') {
            throw new engine.SimulatedRestoreCrashError();
          }
        },
      });
    } catch (error) {
      interrupted = error instanceof engine.SimulatedRestoreCrashError;
    }
    assert(interrupted, 'cleanup interruption not observed');
    assertEqual((await engine.recoverCrashSafeRestore()).outcome, 'publication-hold');
    assertEqual((await readBundle(documentId)).state?.displayTitle, 'Cleanup target');
  },
);

await runCase(
  'collision decisions are frozen and stale/missing decisions write nothing',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const oldPreview = await createPreview(5, documentId, {
      rich: true,
      title: 'Collision old',
    });
    await seedPreview(oldPreview);
    const before = await fingerprintBundle(documentId);
    const replacement = await createPreview(5, documentId, {
      rich: true,
      title: 'Collision target',
    });
    await assertRejects(
      engine.runCrashSafeRestore({ preview: replacement }),
      'missing collision decision',
    );
    assertEqual(await fingerprintBundle(documentId), before);
    assertEqual(await annotation.loadDurableRestoreOperation(), null);
  },
);

await runCase(
  'publication hold permits local edits but fences ordinary cloud admission',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    await engine.runCrashSafeRestore({
      preview: await createPreview(5, documentId, {
        rich: true,
        title: 'Hold target',
      }),
    });
    assert(
      await annotation.updateDocumentDisplayTitle(
        documentId,
        'Edited locally during hold',
      ),
      'local edit was blocked by publication hold',
    );
    assertEqual(
      (await readBundle(documentId)).state?.displayTitle,
      'Edited locally during hold',
      'local edit under hold',
    );
    const operation = await annotation.loadDurableRestoreOperation();
    assert(operation, 'publication hold operation missing');
    await assertRejects(
      workspaceLocks.withSharedWorkspaceRestoreLease((lease) =>
        annotation.assertWorkspaceCloudOperationAllowed(lease),
      ),
      'ordinary cloud admission during hold',
    );
    const reviewed = await workspaceLocks.withExclusiveWorkspaceRestoreLease((lease) =>
      annotation.assertWorkspaceCloudOperationAllowed(lease, {
        operationId: operation.operationId,
        expectedGeneration: operation.generation,
      }),
    );
    assertEqual(reviewed?.operationId, operation.operationId, 'review operation');
    assertEqual(reviewed?.generation, operation.generation, 'review generation');
  },
);

await runCase(
  'explicit coordinator review revalidates account and root before releasing the hold',
  async () => {
    await activateFreshPersonalWorkspace();
    const accountId = 'synthetic-restore-account';
    const rootFolderId = 'synthetic-restore-root';
    const profile = {
      id: 'paper-device' as const,
      deviceId: 'synthetic-restore-device',
      deviceLabel: 'Synthetic restore device',
      deviceMode: 'personal' as const,
      deviceModeChoiceConfirmed: true as const,
      autoSync: true,
      accountId,
      workspaceAccountId: accountId,
      rootFolderId,
    };
    await workspaceLocks.withSharedWorkspaceRestoreLease((lease) =>
      syncStorage.savePaperSyncDeviceProfile(
        profile,
        { authentication: 'replace' },
        lease,
      ),
    );
    const documentId = crypto.randomUUID();
    await engine.runCrashSafeRestore({
      preview: await createPreview(5, documentId, {
        rich: true,
        title: 'Coordinator resume target',
      }),
    });
    const operation = await annotation.loadDurableRestoreOperation();
    assert(operation?.phase === 'publication-hold', 'publication hold missing');

    let metadataReads = 0;
    let baselines = 0;
    let autoUploads = 0;
    const drive = {
      beginOperationTelemetry: () => 'synthetic-restore-review',
      finishOperationTelemetry: () => undefined,
      recordOperationStateTransition: () => undefined,
      async getMetadata(fileId: string) {
        metadataReads += 1;
        return {
          id: fileId,
          name: '39Note',
          mimeType: 'application/vnd.google-apps.folder',
          ownedByMe: true,
          trashed: false,
          appProperties: { application: '39Note', role: 'root' },
        };
      },
    };
    const coordinator = new coordinatorModule.PaperGoogleDriveSyncCoordinator({
      notify() {},
    });
    const initialView = coordinator.getSnapshot();
    Reflect.set(coordinator, 'initializationPromise', Promise.resolve());
    Reflect.set(coordinator, 'profile', profile);
    Reflect.set(coordinator, 'identity', {
      accountId,
      hasDeviceSession: true,
    });
    Reflect.set(coordinator, 'drive', drive);
    Reflect.set(coordinator, 'restorePublicationOperation', operation);
    Reflect.set(coordinator, 'view', {
      ...initialView,
      connection: 'connected',
      deviceMode: 'personal',
      deviceModeChoiceConfirmed: true,
      autoSync: true,
      restorePublicationHold: {
        status: 'waiting',
        restoredDocumentCount: 1,
      },
    });
    Reflect.set(coordinator, 'reconcileLocalPaperStates', async () => undefined);
    Reflect.set(coordinator, 'runAuthoritativeBaseline', async () => {
      baselines += 1;
    });
    Reflect.set(coordinator, 'scheduleAutoUpload', () => {
      autoUploads += 1;
    });

    const repositoryPrototype = repositoryModule.PaperDriveRepository.prototype as {
      assertActiveRoot(signal: AbortSignal): Promise<void>;
    };
    const originalAssertActiveRoot = repositoryPrototype.assertActiveRoot;
    repositoryPrototype.assertActiveRoot = async () => undefined;
    try {
      const first = coordinator.resumeAfterRestorePublication(
        'resume-restored-library',
      );
      const duplicate = coordinator.resumeAfterRestorePublication(
        'resume-restored-library',
      );
      assert(first === duplicate, 'duplicate resume did not reuse one operation');
      await first;
    } finally {
      repositoryPrototype.assertActiveRoot = originalAssertActiveRoot;
    }

    assertEqual(metadataReads, 1, 'existing root metadata review count');
    assertEqual(baselines, 1, 'authoritative baseline count');
    assertEqual(autoUploads, 0, 'automatic upload count during review');
    assertEqual(await annotation.loadDurableRestoreOperation(), null, 'cleared hold');
    assertEqual(
      coordinator.getSnapshot().restorePublicationHold,
      undefined,
      'coordinator hold state',
    );
  },
);

await runCase(
  'a second browser window shared writer blocks restore until it releases ownership',
  async () => {
    await activateFreshPersonalWorkspace();
    const channelId = `phase-d-lock-${crypto.randomUUID()}`;
    const ready = waitForWindowMessage(channelId, 'ready');
    const holder = window.open(
      `/tests/fixtures/restorePhaseDLockHolder.html?channel=${encodeURIComponent(channelId)}`,
      '_blank',
    );
    assert(holder, 'second browser window was blocked');
    try {
      await ready;
      holder.postMessage({ channelId, command: 'acquire' }, location.origin);
      await waitForWindowMessage(channelId, 'acquired');

      let settled = false;
      const documentId = crypto.randomUUID();
      const restore = engine
        .runCrashSafeRestore({
          preview: await createPreview(5, documentId, {
            rich: true,
            title: 'Cross-window target',
          }),
        })
        .finally(() => {
          settled = true;
        });
      await delay(100);
      assertEqual(settled, false, 'restore bypassed the second-window shared lock');

      holder.postMessage({ channelId, command: 'release' }, location.origin);
      await waitForWindowMessage(channelId, 'released');
      const result = await restore;
      assertEqual(result.phase, 'publication-hold', 'cross-window restore result');
    } finally {
      holder.close();
    }
  },
);

await runCase(
  'publication-resume dialog contains keyboard focus, cancels safely, and restores focus',
  async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open restore review';
    const host = document.createElement('div');
    document.body.append(opener, host);
    opener.focus();
    let cancelled = 0;
    let continued = 0;
    const root = reactDomClient.createRoot(host);
    root.render(
      reactModule.createElement(paperSyncUi.RestorePublicationResumeDialog, {
        busy: false,
        onCancel() {
          cancelled += 1;
        },
        onContinue() {
          continued += 1;
        },
      }),
    );
    await animationFrame();
    await animationFrame();
    const dialog = host.querySelector('dialog');
    const buttons = Array.from(host.querySelectorAll('button'));
    assert(dialog?.open, 'resume dialog did not open modally');
    assertEqual(
      dialog?.getAttribute('aria-labelledby'),
      'restore-publication-resume-title',
      'dialog heading association',
    );
    assertEqual(
      dialog?.getAttribute('aria-describedby'),
      'restore-publication-resume-description',
      'dialog description association',
    );
    assertEqual(document.activeElement, buttons[0], 'initial cancel focus');
    buttons[1].focus();
    dialog!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );
    assertEqual(document.activeElement, buttons[0], 'forward focus wrap');
    dialog!.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true }));
    assertEqual(cancelled, 1, 'Escape/cancel callback');
    assertEqual(continued, 0, 'unexpected resume callback');
    root.unmount();
    await animationFrame();
    assertEqual(document.activeElement, opener, 'dialog focus restoration');
    host.remove();
    opener.remove();
  },
);

await runCase(
  'targeted purge recovery is visible for an authoritative coordinator-scoped presence-control failure',
  async () => {
    const documentId = crypto.randomUUID();
    const state: PaperSyncViewState = {
      ...paperSyncUi.initialPaperSyncViewState,
      connection: 'attention',
      backendConfigured: true,
      deviceMode: 'personal',
      deviceModeChoiceConfirmed: true,
      papers: [
        {
          documentId,
          displayName: 'Synthetic inaccessible paper',
          deleted: false,
          paperFolderId: 'synthetic-paper-folder',
          headIds: [],
          headSetId: 'unavailable',
          localAvailability: 'cloud-only',
          status: 'needs-attention',
        },
      ],
      // Model the observed presentation state: both the catalog and top-level
      // issue omit the exact cause, while the coordinator retains that exact
      // paper-scoped blocker in its authoritative document-keyed map.
      issue: {
        code: 'drive-integrity-mismatch',
        message: 'Drive paper data needs verification.',
        severity: 'error',
        state: 'attention',
        actions: ['retry-now', 'details'],
        retrySafe: true,
        blocksOrdinarySync: true,
        backupRecommended: false,
        diagnostic: {
          source: 'google-drive',
          operation: 'paper-validation',
          documentId,
        },
      },
    };
    let previewCalls = 0;
    let executeCalls = 0;
    const coordinator = {
      getRuntimeRevision() {
        return coordinatorModule.PAPER_SYNC_COORDINATOR_RUNTIME_REVISION;
      },
      getTargetedPaperPurgeVisibilityDiagnostic() {
        return {
          implementationRevision:
            coordinatorModule.TARGETED_PURGE_VISIBILITY_IMPLEMENTATION_REVISION,
          visible: true,
          showRecoveryCard: true,
          candidateSource: 'blocking-map',
          hiddenReason: 'not-hidden',
          exactBlockingCandidateCount: 1,
          retryCandidateCount: 1,
          predicates: {
            candidateResolved: true,
            diagnosticTargetQuarantined: false,
          },
        };
      },
      getTargetedPaperPurgeCandidateDocumentId() {
        return documentId;
      },
      async previewTargetedPaperPurge(requestedDocumentId: string) {
        previewCalls += 1;
        assertEqual(requestedDocumentId, documentId, 'preview document identity');
        return {
          eligible: false,
          documentId,
          displayName: 'Synthetic inaccessible paper',
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
            paperFolderCount: 0,
            paperFileCount: 0,
            validPresenceCount: 0,
            corruptPresenceCount: 1,
            presenceState: 'unknown',
            presenceHeadCount: 0,
            preservedPresenceCount: 0,
          },
          preserved: {
            collectionRecords: true,
            sharedRootAndControl: true,
            unrelatedPapers: true,
            removedPresenceTombstone: true,
          },
          blocker: {
            code: 'valid-presence-ancestry-required',
            message: 'Synthetic preview remained fail-closed.',
          },
        };
      },
      async executeTargetedPaperPurge() {
        executeCalls += 1;
        throw new Error('The visibility fixture must never execute a purge.');
      },
    } as unknown as PaperGoogleDriveSyncCoordinator;
    const host = document.createElement('div');
    document.body.append(host);
    const root = reactDomClient.createRoot(host);
    const requestsBefore = unauthorizedRequests;
    root.render(
      reactModule.createElement(paperSyncUi.PaperSyncDrawer, {
        embedded: true,
        coordinator,
        soundEnabled: false,
        state,
        onDownloadBackup() {},
        onOpenSelector() {},
        onSoundEnabledChange() {},
      }),
    );
    await animationFrame();
    await animationFrame();

    const recoveryCard = host.querySelector('.sync-targeted-purge-card');
    assert(recoveryCard, 'targeted purge recovery card was not rendered');
    assert(
      recoveryCard.textContent?.includes('Remove inaccessible paper'),
      'targeted purge recovery heading was not visible',
    );
    const previewButton = Array.from(recoveryCard.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Preview targeted purge'),
    );
    assert(previewButton, 'targeted purge preview action was not visible');
    previewButton.click();
    await animationFrame();
    await animationFrame();

    const dialog = host.querySelector('dialog');
    assert(dialog?.open, 'targeted purge preview dialog did not open');
    assert(
      dialog.textContent?.includes('Purge blocked'),
      'fail-closed preview result was not presented',
    );
    assertEqual(previewCalls, 1, 'preview call count');
    assertEqual(executeCalls, 0, 'purge execution count');
    assertEqual(
      unauthorizedRequests,
      requestsBefore,
      'targeted purge visibility external requests',
    );
    root.unmount();
    await animationFrame();
    host.remove();
  },
);

await runCase(
  'targeted purge local cleanup removes only the synthetic paper and is idempotent',
  async () => {
    await activateFreshWorkspace();
    const documentId = crypto.randomUUID();
    const collectionId = `collection-${documentId}`;
    await seedPreview(
      await createPreview(5, documentId, {
        rich: true,
        title: 'Synthetic targeted purge',
        collectionId,
      }),
    );
    const state = syncStorage.createDefaultPaperSyncState(
      documentId,
      'synthetic-purge-device',
      'local-and-cloud',
    );
    state.targetedPurge = {
      version: 1,
      operationId: crypto.randomUUID(),
      phase: 'local-cleanup-pending',
      confirmedAt: Date.now(),
      accountId: 'synthetic-account',
      rootFolderId: 'synthetic-root',
      paperFolderId: 'synthetic-paper-folder',
    };
    await syncStorage.savePaperSyncState(state);
    await syncStorage.saveCloudPaperCatalog([
      {
        documentId,
        displayName: 'Synthetic targeted purge',
        deleted: false,
        paperFolderId: 'synthetic-paper-folder',
        headIds: ['a'.repeat(64)],
        headSetId: 'a'.repeat(64),
        localAvailability: 'local-and-cloud',
        status: 'needs-attention',
      },
    ]);
    const adapter = new localAdapterModule.BrowserPaperLocalAdapter();
    const before = await adapter.inspectPaperPurgeRecords(documentId, {
      syncStateRecord: true,
      cloudCatalogRecord: true,
    });
    assert(before.documentRecord, 'synthetic document preimage missing');
    assert(before.sourceRecord, 'synthetic source preimage missing');
    assert(before.renderedPrintPdfRecord, 'synthetic Print PDF preimage missing');
    assertEqual(before.aiConversationCount, 1, 'synthetic conversation preimage');

    const clean = () =>
      workspaceLocks.withSharedWorkspaceRestoreLease(async (lease) => {
        await adapter.ensurePaperAbsent(documentId, undefined, lease);
        await syncStorage.deletePaperSyncRecords([documentId], lease);
      });
    await clean();
    await clean();

    const after = await adapter.inspectPaperPurgeRecords(documentId, {
      syncStateRecord: false,
      cloudCatalogRecord: false,
    });
    assertEqual(after.documentRecord, false, 'document record cleanup');
    assertEqual(after.sourceRecord, false, 'source record cleanup');
    assertEqual(after.printDraftRecord, false, 'Print draft cleanup');
    assertEqual(after.renderedPrintPdfRecord, false, 'Print PDF cleanup');
    assertEqual(after.aiConversationCount, 0, 'conversation cleanup');
    assertEqual(
      (await syncStorage.loadPaperSyncStates()).some(
        (candidate) => candidate.documentId === documentId,
      ),
      false,
      'sync state cleanup',
    );
    assertEqual(
      (await syncStorage.loadCloudPaperCatalog()).some(
        (candidate) => candidate.documentId === documentId,
      ),
      false,
      'catalog cleanup',
    );
    assertEqual(
      (await annotation.getCollectionsByIds([collectionId])).length,
      1,
      'shared Collection preservation',
    );
    // Leave the fixture on a clean Personal workspace so the script's final
    // production-startup check never inherits this synthetic temporary scope.
    await activateFreshPersonalWorkspace();
  },
);

await runCase('restore engine performs zero external or Drive requests', async () => {
  assertEqual(unauthorizedRequests, 0, 'external request count');
});

await closePersistenceConnections();
for (const name of databaseNames) await deleteDatabase(name);
window.fetch = originalFetch;

const failures = results.filter(({ outcome }) => outcome === 'FAIL');
const summary = document.querySelector<HTMLElement>('#summary')!;
summary.dataset.phaseCResult = failures.length === 0 ? 'PASS' : 'FAIL';
summary.textContent = `${failures.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failures.length}/${results.length} Phase C native cases`;
document.querySelector<HTMLElement>('#details')!.textContent = JSON.stringify(
  { results, hashes, unauthorizedRequests },
  null,
  2,
);

async function activateFreshWorkspace(): Promise<string> {
  await closePersistenceConnections();
  const workspaceId = crypto.randomUUID();
  sessionStorage.setItem(
    '39note.workspace.temporary.v1',
    JSON.stringify({ id: workspaceId, version: 1 }),
  );
  databaseNames.add(
    temporaryWorkspace.temporaryDatabaseName(
      temporaryWorkspace.PERSONAL_ANNOTATION_DATABASE_NAME,
      workspaceId,
    ),
  );
  databaseNames.add(
    temporaryWorkspace.temporaryDatabaseName(
      temporaryWorkspace.PERSONAL_PRODUCTIVITY_DATABASE_NAME,
      workspaceId,
    ),
  );
  databaseNames.add(
    temporaryWorkspace.temporaryDatabaseName(syncTypes.SYNC_DATABASE_NAME, workspaceId),
  );
  await Promise.all([
    annotation.prepareAnnotationPersistenceStartup(),
    productivity.prepareProductivityPersistenceStartup(),
  ]);
  return workspaceId;
}

async function activateFreshPersonalWorkspace(): Promise<void> {
  await closePersistenceConnections();
  sessionStorage.removeItem('39note.workspace.temporary.v1');
  const names = [
    temporaryWorkspace.PERSONAL_ANNOTATION_DATABASE_NAME,
    temporaryWorkspace.PERSONAL_PRODUCTIVITY_DATABASE_NAME,
    syncTypes.SYNC_DATABASE_NAME,
  ];
  for (const name of names) {
    databaseNames.add(name);
    await deleteDatabase(name);
  }
  await Promise.all([
    annotation.prepareAnnotationPersistenceStartup(),
    productivity.prepareProductivityPersistenceStartup(),
  ]);
}

async function closePersistenceConnections(): Promise<void> {
  await Promise.all([
    annotation.closeAnnotationPersistenceWorkspace(),
    productivity.closeProductivityPersistenceWorkspace(),
    syncStorage.closeSyncPersistenceWorkspace(),
  ]);
}

function waitForWindowMessage(
  channelId: string,
  expectedType: string,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for second-window ${expectedType}.`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== location.origin ||
        !event.data ||
        event.data.channelId !== channelId ||
        event.data.type !== expectedType
      ) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      resolve();
    };
    window.addEventListener('message', onMessage);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForPendingLock(name: string, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const snapshot = await navigator.locks.query();
    if (
      snapshot.pending?.some((lock) => lock.name === name && lock.mode === 'exclusive')
    ) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for pending exclusive lock: ${name}`);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function seedPreview(preview: RestorePreview): Promise<void> {
  for (const document of preview.documents) {
    assert(
      await annotation.restoreBackupDocument(
        document.state,
        document.source,
        true,
        false,
      ),
      'seed document failed',
    );
    await productivity.restoreRenderedPrintPdf(
      document.state.documentId,
      document.renderedPrintPdf,
      false,
    );
  }
  await productivity.restoreProductivityBackupData(preview.productivity, false);
  assert(
    await annotation.restoreLibraryEntities(preview.collections, false),
    'seed Collections failed',
  );
}

async function readBundle(documentId: string) {
  const [documents, productivityRecords, renderedPrintPdf] = await Promise.all([
    annotation.getBackupDocumentDataStrict([documentId]),
    productivity.getProductivityBackupDataStrict([documentId]),
    productivity.loadRenderedPrintPdf(documentId),
  ]);
  return {
    state: documents[0]?.state ?? null,
    source: documents[0]?.source ?? null,
    productivity: productivityRecords[0] ?? null,
    renderedPrintPdf,
  };
}

async function fingerprintBundle(documentId: string): Promise<string> {
  const bundle = await readBundle(documentId);
  const collections = bundle.state
    ? await annotation.getCollectionsByIds(bundle.state.collectionIds)
    : [];
  return hashing.fingerprintRestoreValue({ bundle, collections });
}

async function createPreview(
  version: number,
  documentId: string,
  options: { rich: boolean; title: string; collectionId?: string },
): Promise<RestorePreview> {
  const collectionId = options.collectionId ?? `collection-${documentId}`;
  const collection: CollectionRecord = {
    id: collectionId,
    name: `${options.title} Collection`,
    normalizedName: `${options.title} collection`.toLocaleLowerCase('en-US'),
    createdAt: 1,
    updatedAt: 2,
  };
  const link = options.rich ? createLink(documentId) : null;
  const state = {
    schemaVersion: 9 as const,
    documentType: 'pdf' as const,
    documentId,
    documentName: `${options.title}.pdf`,
    originalFileName: `${options.title}.pdf`,
    displayTitle: options.title,
    annotations: [],
    links: link ? [link] : [],
    officeAnnotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    nextLinkNumber: link ? 2 : 1,
    updatedAt: 10 + version,
    collectionIds: [collectionId],
    isPinned: false,
  };
  const source = options.rich
    ? await createSource(documentId, `${options.title}.pdf`, `source-${options.title}`)
    : null;
  const renderedPrintPdf = options.rich
    ? await createPrintPdf(documentId, options.title)
    : null;
  const productivityRecord: ProductivityBackupDocument | null =
    version >= 3
      ? {
          documentId,
          printDraft: null,
          aiConversations: options.rich
            ? [
                {
                  id: `conversation-${documentId}`,
                  documentId,
                  title: 'Synthetic restore conversation',
                  promptProfileId: 'synthetic-profile',
                  messages: [],
                  createdAt: 3,
                  updatedAt: 4,
                },
              ]
            : [],
        }
      : null;
  const key = encodeURIComponent(documentId);
  const manifestDocument: Record<string, unknown> =
    version === 1
      ? { documentId, hasStoredPdf: Boolean(source) }
      : version < 5
        ? {
            documentId,
            hasStoredPdf: Boolean(source),
            recordEntry: `documents/${key}.json`,
            ...(source ? { pdfEntry: `pdfs/${key}.pdf` } : {}),
            ...(version >= 3 ? { productivityEntry: `productivity/${key}.json` } : {}),
          }
        : {
            documentId,
            hasStoredSource: Boolean(source),
            recordEntry: `documents/${key}.json`,
            productivityEntry: `productivity/${key}.json`,
            ...(source
              ? {
                  sourceArtifact: {
                    documentId,
                    documentType: 'pdf',
                    mimeType: 'application/pdf',
                    originalFileName: source.fileName,
                    sha256: source.sha256,
                    size: source.size,
                    sourceEntry: `sources/${key}.pdf`,
                  },
                }
              : {}),
            ...(renderedPrintPdf
              ? {
                  renderedPrintPdf: {
                    kind: 'rendered-print-pdf',
                    documentId,
                    fileName: renderedPrintPdf.fileName,
                    mimeType: 'application/pdf',
                    size: renderedPrintPdf.size,
                    sha256: renderedPrintPdf.sha256,
                    renderedFromDraftHash: renderedPrintPdf.renderedFromDraftHash,
                    createdAt: renderedPrintPdf.createdAt,
                    storedAt: renderedPrintPdf.storedAt,
                    artifactEntry: `rendered-print-pdfs/${key}.pdf`,
                  },
                }
              : {}),
          };
  const manifest: Record<string, unknown> = {
    backupFormatVersion: version,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: link ? 1 : 0,
    noteCount: 0,
    documents: [manifestDocument],
    backupScope: 'library',
    printDraftCount: 0,
    aiConversationCount: productivityRecord?.aiConversations.length ?? 0,
    ...(version === 5 ? { renderedPrintPdfCount: renderedPrintPdf ? 1 : 0 } : {}),
    ...(version >= 4
      ? {
          paperCoverage: {
            locallyAvailableCount: 1,
            cloudOnlyCount: null,
            cloudOnlyContentIncluded: false,
            cloudCatalog: { status: 'unavailable' },
            cloudOnlyPapers: [],
          },
        }
      : {}),
  };
  return {
    manifest: manifest as unknown as RestorePreview['manifest'],
    documents: [
      {
        state,
        source,
        pdf: source ? { ...source, documentType: 'pdf' } : null,
        renderedPrintPdf,
      },
    ],
    conflictCount: 0,
    sourceCount: source ? 1 : 0,
    pdfCount: source ? 1 : 0,
    highlightCount: 0,
    underlineCount: 0,
    noteCount: 0,
    collections: [collection],
    productivity: productivityRecord ? [productivityRecord] : [],
    renderedPrintPdfCount: renderedPrintPdf ? 1 : 0,
  };
}

function combinePreviews(previews: RestorePreview[]): RestorePreview {
  const documents = previews.flatMap((preview) => preview.documents);
  const productivityRecords = previews.flatMap((preview) => preview.productivity);
  const collections = previews.flatMap((preview) => preview.collections);
  const manifestDocuments = previews.flatMap((preview) => preview.manifest.documents);
  return {
    manifest: {
      ...previews[0].manifest,
      documentCount: documents.length,
      documents: manifestDocuments,
      annotationCount: documents.reduce(
        (count, document) =>
          count +
          document.state.annotations.length +
          document.state.links.length +
          document.state.officeAnnotations.length,
        0,
      ),
      noteCount: documents.reduce(
        (count, document) => count + document.state.notes.length,
        0,
      ),
      printDraftCount: productivityRecords.filter(({ printDraft }) => printDraft)
        .length,
      aiConversationCount: productivityRecords.reduce(
        (count, record) => count + record.aiConversations.length,
        0,
      ),
      renderedPrintPdfCount: documents.filter(({ renderedPrintPdf }) =>
        Boolean(renderedPrintPdf),
      ).length,
      paperCoverage: {
        locallyAvailableCount: documents.length,
        cloudOnlyCount: null,
        cloudOnlyContentIncluded: false,
        cloudCatalog: { status: 'unavailable' },
        cloudOnlyPapers: [],
      },
    },
    documents,
    conflictCount: 0,
    sourceCount: documents.filter(({ source }) => source).length,
    pdfCount: documents.filter(({ pdf }) => pdf).length,
    highlightCount: 0,
    underlineCount: 0,
    noteCount: 0,
    collections,
    productivity: productivityRecords,
    renderedPrintPdfCount: documents.filter(({ renderedPrintPdf }) =>
      Boolean(renderedPrintPdf),
    ).length,
  };
}

async function createSource(
  documentId: string,
  fileName: string,
  marker: string,
): Promise<StoredDocumentSource> {
  const blob = new Blob([`%PDF-1.7\n${marker}\n%%EOF\n`], {
    type: 'application/pdf',
  });
  return {
    documentId,
    documentType: 'pdf',
    fileName,
    mimeType: 'application/pdf',
    sha256: await sha256(blob),
    size: blob.size,
    lastModified: 1,
    blob,
    storedAt: 2,
  };
}

async function createPrintPdf(
  documentId: string,
  title: string,
): Promise<StoredRenderedPrintPdf> {
  const blob = new Blob([`%PDF-1.7\nprint-${title}\n%%EOF\n`], {
    type: 'application/pdf',
  });
  return {
    kind: 'rendered-print-pdf',
    documentId,
    fileName: `${title} - Print.pdf`,
    mimeType: 'application/pdf',
    size: blob.size,
    sha256: await sha256(blob),
    renderedFromDraftHash: 'a'.repeat(64),
    createdAt: 3,
    storedAt: 4,
    blob,
  };
}

function createLink(documentId: string) {
  const anchor = (quote: string, pageNumber: number) => ({
    version: 1 as const,
    kind: 'pdf-text' as const,
    documentId,
    quote,
    prefix: '',
    suffix: '',
    startOffset: 0,
    endOffset: quote.length,
    pageNumber,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
  });
  return {
    version: 1 as const,
    type: 'link' as const,
    id: `link-${documentId}`,
    documentId,
    visibleNumber: 1,
    name: 'Synthetic Link',
    endpointA: {
      id: `link-${documentId}-a`,
      anchor: anchor('Synthetic source', 1),
      createdAt: 5,
    },
    endpointB: {
      id: `link-${documentId}-b`,
      anchor: anchor('Synthetic target', 2),
      createdAt: 6,
    },
    createdAt: 5,
    updatedAt: 6,
  };
}

async function reloadEngine(label: string): Promise<typeof engine> {
  const url = new URL('../../src/services/crashSafeRestoreEngine.ts', import.meta.url);
  url.searchParams.set('phase-c-instance', `${label}-${crypto.randomUUID()}`);
  return import(/* @vite-ignore */ url.href) as Promise<typeof engine>;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database cleanup blocked: ${name}`));
  });
}

async function updateRawIndexedDbRecord(
  databaseName: string,
  storeName: string,
  key: IDBValidKey,
  update: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const database = await openRawIndexedDb(databaseName);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const getRequest = store.get(key);
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        if (!getRequest.result || typeof getRequest.result !== 'object') {
          reject(new Error(`Missing ${storeName} record.`));
          return;
        }
        store.put(update(structuredClone(getRequest.result)));
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

async function readRawIndexedDbStore(
  databaseName: string,
  storeName: string,
): Promise<unknown[]> {
  const database = await openRawIndexedDb(databaseName);
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = database
        .transaction(storeName, 'readonly')
        .objectStore(storeName)
        .getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

async function openRawIndexedDb(databaseName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function runCase(name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    results.push({ name, outcome: 'PASS' });
  } catch (error) {
    results.push({
      name,
      outcome: 'FAIL',
      detail:
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}

async function assertRejects(promise: Promise<unknown>, label: string): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} did not reject`);
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label = 'value'): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
