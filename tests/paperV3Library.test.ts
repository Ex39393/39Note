import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  getLibraryPaperDrivePresentation,
  getLibraryPaperDriveStatusIndicators,
  mergeLibraryBulkDriveRemovalProgress,
  planLibraryBulkDriveRemoval,
  selectCloudOnlyLibraryPapers,
  startLibraryBackgroundOperation,
  summarizeLibraryBulkDriveRemoval,
  type LibraryBulkDriveRemovalCandidate,
} from '../src/components/libraryCloudPresentation.ts';
import {
  defaultDirtyPaperSelection,
  pendingSyncPaperIds,
} from '../src/sync/paperStateMachine.ts';
import { settleIndependentOperations } from '../src/sync/syncConcurrency.ts';
import type { PaperCloudSummary, PaperSyncState } from '../src/sync/paperTypes.ts';
import { normalizePaperV3MigrationRecord } from '../src/sync/storage.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Paper-v3 Library bulk Drive removal is selective, independent, and explicit', async (t) => {
  const localPresent = bulkCandidate('doc-local', {
    hasLocalCopy: true,
    syncPaper: paperState('doc-local', {
      availability: 'local-and-cloud',
      status: 'synced',
      cloudPresence: 'present',
    }),
  });
  const cloudOnlyPresent = bulkCandidate('doc-cloud', {
    cloudPaper: cloudPaper('doc-cloud', 'Cloud paper'),
  });

  await t.test(
    '37. multi-select exposes eligible local and cloud-only Drive papers',
    () => {
      const plan = planLibraryBulkDriveRemoval(
        ['doc-local', 'doc-cloud'],
        [localPresent, cloudOnlyPresent],
        'personal',
      );
      assert.deepEqual(
        plan.eligible.map(({ documentId }) => documentId),
        ['doc-local', 'doc-cloud'],
      );
      const panel = source('../src/components/LibraryPanel.tsx');
      assert.match(
        panel,
        /Remove \$\{bulkDriveRemovalPlan\.eligible\.length\} from Google Drive/u,
      );
      assert.match(
        panel,
        /<CloudOnlyPaperCard[\s\S]*selectionMode=\{isSelectionMode\}/u,
      );
    },
  );

  await t.test(
    '38. confirmation shows the exact eligible count and required warning',
    () => {
      const panel = source('../src/components/LibraryPanel.tsx');
      assert.match(
        panel,
        /Remove \{pendingBulkDriveRemoval\.eligible\.length\}[\s\S]*papers'\} from[\s\S]*Google Drive\?/u,
      );
      assert.match(panel, /Local copies on this device are kept where present/u);
      assert.match(panel, /moved to Google Drive Trash/u);
      assert.match(panel, /ordinary sync will not[\s\S]*restore them\s+automatically/u);
      assert.match(panel, /Explicit Restore is required/u);
      assert.match(panel, /ineligible and will be skipped/u);
    },
  );

  await t.test(
    '39-44. coordinator runs independent bounded operations and retains exact failures',
    async () => {
      const durableSuccesses: string[] = [];
      const progress: number[] = [];
      const settlements = await settleIndependentOperations(
        ['paper-a', 'paper-b', 'paper-c'],
        2,
        async (documentId) => {
          if (documentId === 'paper-b') throw new Error('Still safely present.');
          durableSuccesses.push(documentId);
          return `${documentId}:removed`;
        },
        (completed) => progress.push(completed),
      );
      assert.deepEqual(durableSuccesses.sort(), ['paper-a', 'paper-c']);
      assert.deepEqual(progress, [1, 2, 3]);
      assert.deepEqual(
        settlements.map(({ input: documentId, status }) => ({ documentId, status })),
        [
          { documentId: 'paper-a', status: 'fulfilled' },
          { documentId: 'paper-b', status: 'rejected' },
          { documentId: 'paper-c', status: 'fulfilled' },
        ],
      );
      const coordinator = source('../src/sync/paperCoordinator.ts');
      const start = coordinator.indexOf('\n  removeFromGoogleDriveSelected(');
      const end = coordinator.indexOf('\n  restoreToGoogleDrive(', start);
      const method = coordinator.slice(start, end);
      assert.ok(start >= 0 && end > start);
      assert.match(method, /settleIndependentOperations\(/u);
      assert.match(method, /outcome\.failed\.push/u);
      assert.match(
        method,
        /if \(settledCloud\.length\) await this\.applyTransferCatalog/u,
      );
      assert.doesNotMatch(method, /rollback|Promise\.all\(/iu);
      assert.equal(
        summarizeLibraryBulkDriveRemoval({
          removed: ['paper-a', 'paper-c'],
          alreadyRemoved: [],
          cleanupPending: [],
          failed: [{ documentId: 'paper-b', message: 'Still safely present.' }],
        }),
        '2 removed · 1 failed',
      );
      const panel = source('../src/components/LibraryPanel.tsx');
      assert.match(panel, /result\.failed\.map\(\(failure\)/u);
      assert.match(panel, /failure\.documentId/u);
      assert.match(panel, /failure\.message/u);
    },
  );

  await t.test(
    '40-41. local copies are kept and presence precedes Trash per paper',
    () => {
      const coordinator = source('../src/sync/paperCoordinator.ts');
      assert.match(coordinator, /state\.availability = 'local-only'/u);
      assert.match(coordinator, /state\.cloudPresence = 'removed'/u);
      const repository = source('../src/sync/paperDriveRepository.ts');
      const start = repository.indexOf('async removePaperFromDrive(');
      const end = repository.indexOf('\n  async prepareV3Migration(', start);
      const method = repository.slice(start, end);
      assert.ok(start >= 0 && end > start);
      const presenceIndex = method.indexOf('publishRemoved');
      const trashIndex = method.indexOf('trashManagedPaperFolder');
      assert.ok(presenceIndex >= 0 && trashIndex > presenceIndex);
    },
  );

  await t.test(
    '45. ambiguous, removed, active-transfer, and temporary targets are skipped',
    () => {
      const candidates: LibraryBulkDriveRemovalCandidate[] = [
        bulkCandidate('attention', {
          cloudPaper: {
            ...cloudPaper('attention', 'Attention'),
            status: 'needs-attention',
            issue: { code: 'paper-integrity-failed', message: 'Ambiguous identity.' },
          },
        }),
        bulkCandidate('removed', {
          syncPaper: paperState('removed', { cloudPresence: 'removed' }),
        }),
        bulkCandidate('busy', {
          syncPaper: paperState('busy', {
            status: 'uploading',
            cloudPresence: 'present',
          }),
        }),
        bulkCandidate('local-only'),
      ];
      const personal = planLibraryBulkDriveRemoval(
        candidates.map(({ documentId }) => documentId),
        candidates,
        'personal',
      );
      assert.deepEqual(personal.eligible, []);
      assert.deepEqual(
        personal.skipped.map(({ reason }) => reason),
        ['needs-attention', 'removed', 'transfer-active', 'not-cloud-present'],
      );
      const temporary = planLibraryBulkDriveRemoval(
        ['doc-cloud'],
        [cloudOnlyPresent],
        'temporary',
      );
      assert.equal(temporary.skipped[0]?.reason, 'cloud-removal-disabled');
    },
  );

  await t.test('46. bulk Drive removal only uses recoverable Trash operations', () => {
    const repository = source('../src/sync/paperDriveRepository.ts');
    const start = repository.indexOf('async removePaperFromDrive(');
    const end = repository.indexOf('\n  async prepareV3Migration(', start);
    const method = repository.slice(start, end);
    assert.match(method, /trashManagedPaperFolder/u);
    assert.doesNotMatch(method, /deletePermanently|DELETE/iu);
  });

  await t.test('47. concurrent progress remains monotonic and bounded', () => {
    let progress = mergeLibraryBulkDriveRemovalProgress(null, {
      completed: 0,
      total: 5,
    });
    progress = mergeLibraryBulkDriveRemovalProgress(progress, {
      completed: 3,
      total: 5,
    });
    progress = mergeLibraryBulkDriveRemovalProgress(progress, {
      completed: 2,
      total: 5,
    });
    progress = mergeLibraryBulkDriveRemovalProgress(progress, {
      completed: 9,
      total: 5,
    });
    assert.deepEqual(progress, { completed: 5, total: 5 });
  });

  await t.test('48. already-removed retries are reported separately and safely', () => {
    assert.equal(
      summarizeLibraryBulkDriveRemoval({
        removed: [],
        alreadyRemoved: ['paper-a'],
        cleanupPending: [],
        failed: [],
      }),
      '0 removed · 1 already removed',
    );
    const coordinator = source('../src/sync/paperCoordinator.ts');
    assert.match(
      coordinator,
      /const wasAlreadyRemoved = summary\.presenceState === 'removed'/u,
    );
    assert.match(
      coordinator,
      /if \(wasAlreadyRemoved\) outcome\.alreadyRemoved\.push/u,
    );
  });
});

test('Paper-v3 Library cloud management remains identity-safe and explicit', async (t) => {
  await t.test('49. a local-only paper is shown as local only', () => {
    const presentation = getLibraryPaperDrivePresentation(
      undefined,
      paperState('doc-local', { availability: 'local-only', status: 'local-only' }),
    );
    assert.equal(presentation.primaryStatus, 'Local only');
    assert.equal(presentation.action, 'upload');
  });

  await t.test('50. a cloud-only paper is selected as metadata-only', () => {
    const cloudOnly = cloudPaper('doc-cloud', 'Cloud paper');
    const selected = selectCloudOnlyLibraryPapers([cloudOnly], new Set(), {
      includeCloudOnly: true,
      query: '',
    });
    assert.deepEqual(
      selected.map((paper) => paper.documentId),
      ['doc-cloud'],
    );
    assert.equal(
      getLibraryPaperDrivePresentation(cloudOnly, undefined).primaryStatus,
      'Cloud only',
    );
    assert.match(
      source('../src/components/LibraryPanel.tsx'),
      /Metadata only\. The PDF and editable state stay in Google Drive until you choose Download\./u,
    );
  });

  await t.test('51. the same documentId is rendered only by the local row', () => {
    const selected = selectCloudOnlyLibraryPapers(
      [cloudPaper('stable-id', 'Same title')],
      new Set(['stable-id']),
      { includeCloudOnly: true, query: '' },
    );
    assert.deepEqual(selected, []);
  });

  await t.test('52. a verified local-and-cloud paper is shown as synced', () => {
    const state = paperState('doc-synced', {
      availability: 'local-and-cloud',
      status: 'synced',
      cloudPresence: 'present',
    });
    const presentation = getLibraryPaperDrivePresentation(
      cloudPaper('doc-synced', 'Synced paper'),
      state,
    );
    assert.equal(presentation.primaryStatus, 'Synced');
    assert.equal(presentation.action, 'remove');
  });

  await t.test('53. a removed local paper stays local with a removal marker', () => {
    const presentation = getLibraryPaperDrivePresentation(
      undefined,
      paperState('doc-removed', {
        availability: 'local-only',
        status: 'local-only',
        cloudPresence: 'removed',
      }),
    );
    assert.equal(presentation.primaryStatus, 'Local only');
    assert.equal(presentation.removedFromDrive, true);
    assert.equal(presentation.action, 'restore');
  });

  await t.test('54. a never-uploaded local paper offers Upload', () => {
    assert.equal(
      getLibraryPaperDrivePresentation(
        undefined,
        paperState('doc-new', { availability: 'local-only', status: 'local-changes' }),
      ).action,
      'upload',
    );
    assert.match(
      source('../src/components/LibraryPanel.tsx'),
      /Upload to Google Drive/u,
    );
  });

  await t.test('55. a cloud-only paper offers an explicit Download', () => {
    const panel = source('../src/components/LibraryPanel.tsx');
    assert.match(panel, /<CloudOnlyPaperCard/u);
    assert.match(panel, /operation === 'download' \? 'Downloading…' : 'Download'/u);
  });

  await t.test('56. Remove from Google Drive requires confirmation', () => {
    const panel = source('../src/components/LibraryPanel.tsx');
    assert.match(panel, /setPendingDriveRemoval\(\{/u);
    assert.match(panel, /aria-label="Remove paper from Google Drive"/u);
    assert.match(panel, /<h3>Remove from Google Drive\?<\/h3>/u);
  });

  await t.test(
    '56a. confirming Remove closes decision UI before background Drive work settles',
    async () => {
      let resolveOperation!: (value: 'removed') => void;
      const pendingOperation = new Promise<'removed'>((resolve) => {
        resolveOperation = resolve;
      });
      const events: string[] = [];
      let settled = false;
      const operation = startLibraryBackgroundOperation(
        () => {
          events.push('started');
          return pendingOperation;
        },
        () => events.push('closed'),
      );
      void operation.then(() => {
        settled = true;
        events.push('settled');
      });

      assert.deepEqual(events, ['started', 'closed']);
      assert.equal(settled, false);
      resolveOperation('removed');
      assert.equal(await operation, 'removed');
      await Promise.resolve();
      assert.deepEqual(events, ['started', 'closed', 'settled']);

      const panel = source('../src/components/LibraryPanel.tsx');
      const actionStart = panel.indexOf('const runCloudAction = async');
      const actionEnd = panel.indexOf('const runBulkDriveRemoval = async', actionStart);
      const action = panel.slice(actionStart, actionEnd);
      assert.match(
        action,
        /startLibraryBackgroundOperation\([\s\S]*?syncCoordinator\.removeFromGoogleDrive\(documentId\)[\s\S]*?setPendingDriveRemoval\(null\)[\s\S]*?await operation;/u,
      );

      const modalStart = panel.indexOf('{pendingDriveRemoval ? (');
      const modalEnd = panel.indexOf('{pendingSourceRemoval ? (', modalStart);
      const modal = panel.slice(modalStart, modalEnd);
      assert.match(modal, />\s*Cancel\s*</u);
      assert.match(modal, />\s*Remove from Google Drive\s*</u);
      assert.doesNotMatch(modal, /disabled=|Removing/u);
    },
  );

  await t.test(
    '56b. removal progress is row-scoped and unrelated Library reading stays enabled',
    () => {
      const panel = source('../src/components/LibraryPanel.tsx');
      assert.match(
        panel,
        /cloudOperation=\{cloudOperations\[document\.documentId\]\}/u,
      );
      assert.match(
        panel,
        /syncBusy=\{[\s\S]{0,180}Boolean\(cloudOperations\[document\.documentId\]\)/u,
      );
      assert.match(panel, /cloudOperationLabel\(cloudOperation\)/u);
      assert.match(panel, /operation === 'remove' \? 'Removing…'/u);
      assert.match(
        panel,
        /aria-label="Read Now"[\s\S]{0,180}disabled=\{!document\.hasStoredSource \|\| isOpening\}/u,
      );
      assert.doesNotMatch(
        panel,
        /syncBusy=\{[\s\S]{0,160}syncState\.connection === 'syncing'/u,
      );
    },
  );

  await t.test(
    '56c. bulk confirmation also closes before progress and failures remain non-blocking',
    () => {
      const panel = source('../src/components/LibraryPanel.tsx');
      const runStart = panel.indexOf('const runBulkDriveRemoval = async');
      const runEnd = panel.indexOf('if (!isOpen)', runStart);
      const run = panel.slice(runStart, runEnd);
      assert.match(
        run,
        /startLibraryBackgroundOperation\([\s\S]*?syncCoordinator\.removeFromGoogleDriveSelected\([\s\S]*?setPendingBulkDriveRemoval\(null\)[\s\S]*?const result = await operation;/u,
      );
      assert.match(run, /setBulkDriveRemovalProgress/u);
      assert.match(run, /setError\(/u);
      assert.match(panel, /className="library-error" role="status"/u);
    },
  );

  await t.test('57. the confirmation and coordinator preserve a local copy', () => {
    const panel = source('../src/components/LibraryPanel.tsx');
    const coordinator = source('../src/sync/paperCoordinator.ts');
    assert.match(
      panel,
      /will stay on this device with its source document, annotations, Notes, Glossary, reading state, Collections, Tags, and Print Draft/u,
    );
    assert.match(coordinator, /state\.availability = 'local-only'/u);
    assert.match(coordinator, /state\.cloudPresence = 'removed'/u);
  });

  await t.test('58. cloud-only removal does not fabricate a local document', () => {
    const coordinator = source('../src/sync/paperCoordinator.ts');
    const localBranch = coordinator.indexOf('if (hasLocalCopy) {');
    const cloudOnlyBranch = coordinator.indexOf('} else {', localBranch);
    const deleteRecord = coordinator.indexOf(
      'await deletePaperSyncRecords([documentId]);',
      cloudOnlyBranch,
    );
    const nextLocalFactory = coordinator.indexOf(
      'createDefaultPaperSyncState(',
      cloudOnlyBranch,
    );
    assert.ok(localBranch >= 0 && cloudOnlyBranch > localBranch);
    assert.ok(deleteRecord > cloudOnlyBranch);
    assert.ok(nextLocalFactory < 0 || nextLocalFactory > deleteRecord);
  });

  await t.test('59. a removed local paper offers Restore', () => {
    const presentation = getLibraryPaperDrivePresentation(
      undefined,
      paperState('doc-removed', { cloudPresence: 'removed' }),
    );
    assert.equal(presentation.action, 'restore');
    assert.match(
      source('../src/components/LibraryPanel.tsx'),
      /Restore to Google Drive/u,
    );
  });

  await t.test('60. Restore is wired only to the explicit coordinator method', () => {
    const panel = source('../src/components/LibraryPanel.tsx');
    const coordinator = source('../src/sync/paperCoordinator.ts');
    assert.match(panel, /syncCoordinator\.restoreToGoogleDrive\(documentId\)/u);
    assert.match(
      coordinator,
      /restoreToGoogleDrive\(\s*documentId: string,?\s*\): Promise<'fast-untrash' \| 'fallback-rebuild'>/u,
    );
    assert.match(coordinator, /await repository\.restorePaper\(/u);
  });

  await t.test('61. an ordinary edit cannot restore a removed paper', () => {
    const removedDirty = paperState('doc-removed', {
      status: 'local-changes',
      cloudPresence: 'removed',
      dirtyReasons: ['notes'],
    });
    assert.deepEqual(pendingSyncPaperIds([removedDirty]), []);
    assert.deepEqual(defaultDirtyPaperSelection([removedDirty]), []);
    const coordinator = source('../src/sync/paperCoordinator.ts');
    assert.match(
      coordinator,
      /if \(state\.cloudPresence === 'removed'\) \{[\s\S]*state\.status = 'local-only'[\s\S]*state\.availability = 'local-only'/u,
    );
    assert.doesNotMatch(
      coordinator,
      /paper\.presenceState === 'removed'[\s\S]{0,1200}local\.delete/u,
    );
  });

  await t.test('62. local removal and Drive removal remain distinct actions', () => {
    const panel = source('../src/components/LibraryPanel.tsx');
    assert.match(panel, /Remove from this device/u);
    assert.match(panel, /Remove from Google Drive/u);
    assert.doesNotMatch(panel, />\s*Delete\s*</u);
  });

  await t.test('63. Needs attention blocks unsafe Drive removal', () => {
    const presentation = getLibraryPaperDrivePresentation(
      {
        ...cloudPaper('doc-bad', 'Needs review'),
        status: 'needs-attention',
        issue: {
          code: 'paper-integrity-failed',
          message: 'Drive package could not be verified.',
        },
      },
      paperState('doc-bad', { status: 'needs-attention' }),
    );
    assert.equal(presentation.needsAttention, true);
    assert.deepEqual(presentation.issue, {
      key: 'needs-attention',
      label: 'Needs attention',
      code: 'paper-integrity-failed',
      message: 'Drive package could not be verified.',
    });
    assert.deepEqual(
      getLibraryPaperDriveStatusIndicators(presentation)
        .map(({ label }) => label)
        .filter((label) => label === 'Needs attention'),
      ['Needs attention'],
    );
    assert.deepEqual(
      getLibraryPaperDriveStatusIndicators(
        presentation,
        'Removing from Google Drive…',
      ).map(({ label }) => label),
      ['Removing from Google Drive…', 'Needs attention'],
    );
    const retrying = getLibraryPaperDrivePresentation(
      {
        ...cloudPaper('doc-bad', 'Needs review'),
        status: 'needs-attention',
        issue: {
          code: 'paper-integrity-failed',
          message: 'Drive package could not be verified.',
        },
      },
      paperState('doc-bad', { status: 'uploading' }),
    );
    assert.equal(retrying.primaryStatus, 'Uploading');
    assert.equal(retrying.needsAttention, true);
    assert.deepEqual(
      getLibraryPaperDriveStatusIndicators(retrying).map(({ label }) => label),
      ['Uploading', 'Needs attention'],
    );
    assert.match(
      source('../src/components/LibraryPanel.tsx'),
      /disabled=\{[\s\S]{0,180}cloudNeedsAttention[\s\S]{0,180}selectionMode/u,
    );
    assert.match(
      source('../src/components/LibraryPanel.tsx'),
      /<LibraryPaperDriveStatus[\s\S]{0,120}presentation=\{drivePresentation\}/u,
    );
    assert.doesNotMatch(
      source('../src/components/LibraryPanel.tsx'),
      /cloudNeedsAttention \? <small>Needs attention<\/small>/u,
    );
  });

  await t.test(
    '64. distinct removal, cleanup, and integrity states remain distinguishable',
    () => {
      const presentation = getLibraryPaperDrivePresentation(
        {
          ...cloudPaper('doc-distinct', 'Distinct states'),
          presenceState: 'removed',
          cleanupPending: true,
          status: 'needs-attention',
          issue: {
            code: 'paper-integrity-failed',
            message: 'Drive package could not be verified.',
          },
        },
        paperState('doc-distinct', {
          availability: 'local-only',
          cloudPresence: 'removed',
          cloudCleanupPending: true,
          status: 'needs-attention',
        }),
      );

      assert.equal(presentation.primaryStatus, 'Needs attention');
      assert.deepEqual(presentation.secondaryStatuses, [
        { key: 'removed-from-drive', label: 'Removed from Drive' },
        { key: 'drive-cleanup-pending', label: 'Drive cleanup pending' },
      ]);
      assert.equal(presentation.issue?.message, 'Drive package could not be verified.');
      assert.deepEqual(
        getLibraryPaperDriveStatusIndicators(presentation).map(({ label }) => label),
        ['Needs attention', 'Removed from Drive', 'Drive cleanup pending'],
      );
    },
  );

  await t.test('65. normal removed state has no attention indicator', () => {
    const presentation = getLibraryPaperDrivePresentation(
      undefined,
      paperState('doc-removed-normal', {
        availability: 'local-only',
        cloudPresence: 'removed',
        status: 'local-only',
      }),
    );

    assert.equal(presentation.primaryStatus, 'Local only');
    assert.deepEqual(presentation.secondaryStatuses, [
      { key: 'removed-from-drive', label: 'Removed from Drive' },
    ]);
    assert.equal(presentation.issue, undefined);
    assert.equal(presentation.needsAttention, false);
    assert.deepEqual(
      getLibraryPaperDriveStatusIndicators(presentation).map(({ label }) => label),
      ['Local only', 'Removed from Drive'],
    );
  });

  await t.test('66. generic issue copy does not duplicate the attention label', () => {
    const presentation = getLibraryPaperDrivePresentation(
      {
        ...cloudPaper('doc-generic-attention', 'Generic attention'),
        status: 'needs-attention',
        issue: {
          code: 'paper-integrity-failed',
          message: 'Needs attention.',
        },
      },
      paperState('doc-generic-attention', { status: 'needs-attention' }),
    );

    assert.equal(presentation.issue?.message, undefined);
    assert.deepEqual(
      getLibraryPaperDriveStatusIndicators(presentation).map(({ label }) => label),
      ['Needs attention'],
    );
    const panel = source('../src/components/LibraryPanel.tsx');
    assert.match(
      panel,
      /function CloudOnlyPaperCard[\s\S]*?<LibraryPaperDriveStatus[\s\S]*?presentation=\{presentation\}/u,
    );
    assert.doesNotMatch(
      panel,
      /function CloudOnlyPaperCard[\s\S]*?\{paper\.issue\.message\}/u,
    );
  });
});

test('Paper-v3 migration checkpoints retain exact resumable activation evidence', () => {
  const generationId = 'a'.repeat(64);
  const packageHeadId = 'b'.repeat(64);
  const normalized = normalizePaperV3MigrationRecord({
    id: 'paper-v3',
    formatVersion: 1,
    rootFolderId: 'root-id',
    phase: 'activating-layout',
    startedAt: 123,
    controlFolderId: 'control-id',
    targetDocumentIds: ['doc-b', 'doc-a'],
    seeds: {
      'doc-b': {
        generationId,
        paperFolderId: 'folder-b',
        state: 'present',
        packageHeadIds: [packageHeadId],
      },
      'doc-a': {
        generationId: 'c'.repeat(64),
        paperFolderId: 'folder-a',
        state: 'present',
        packageHeadIds: ['d'.repeat(64)],
      },
    },
  });
  assert.deepEqual(normalized.targetDocumentIds, ['doc-a', 'doc-b']);
  assert.deepEqual(Object.keys(normalized.seeds), ['doc-a', 'doc-b']);
  assert.deepEqual(normalized.seeds['doc-b'].packageHeadIds, [packageHeadId]);

  assert.throws(
    () =>
      normalizePaperV3MigrationRecord({
        ...normalized,
        seeds: {
          ...normalized.seeds,
          'doc-b': { ...normalized.seeds['doc-b'], packageHeadIds: [] },
        },
      }),
    /migration seed checkpoint/iu,
  );
  assert.throws(
    () =>
      normalizePaperV3MigrationRecord({
        ...normalized,
        seeds: { 'doc-a': normalized.seeds['doc-a'] },
      }),
    /activation evidence is incomplete/iu,
  );
});

function paperState(
  documentId: string,
  overrides: Partial<PaperSyncState> = {},
): PaperSyncState {
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
    ...overrides,
  };
}

function cloudPaper(documentId: string, displayName: string): PaperCloudSummary {
  return {
    documentId,
    displayName,
    deleted: false,
    paperFolderId: `folder-${documentId}`,
    dataFolderId: `data-${documentId}`,
    headIds: ['head-a'],
    headSetId: 'head-a',
    presenceState: 'present',
    presenceHeadIds: ['presence-a'],
    localAvailability: 'cloud-only',
    status: 'cloud-only',
  };
}

function bulkCandidate(
  documentId: string,
  overrides: Partial<LibraryBulkDriveRemovalCandidate> = {},
): LibraryBulkDriveRemovalCandidate {
  return {
    documentId,
    displayName: documentId,
    hasLocalCopy: false,
    ...overrides,
  };
}
