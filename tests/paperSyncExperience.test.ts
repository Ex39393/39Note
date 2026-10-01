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
import type {
  PaperConnectionStatus,
  PaperSyncViewState,
} from '../src/sync/paperCoordinator.ts';
import type { PaperFolderNameNormalizationPreview } from '../src/sync/paperDriveRepository.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
let server: ViteDevServer;
let PaperSyncDrawer: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSyncDrawer'];
let LegacyCleanupConfirmation: (typeof import('../src/sync/PaperSyncControl.tsx'))['LegacyCleanupConfirmation'];
let PaperFolderNameNormalizationConfirmation: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperFolderNameNormalizationConfirmation'];
let PaperSelectorDialog: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperSelectorDialog'];
let paperRows: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperRows'];
let PaperLibraryCloudView: (typeof import('../src/sync/PaperSyncControl.tsx'))['PaperLibraryCloudView'];
let getPaperDownloadBatchFeedback: (typeof import('../src/sync/PaperSyncControl.tsx'))['getPaperDownloadBatchFeedback'];
let ReaderSyncStatusPill: (typeof import('../src/sync/PaperSyncControl.tsx'))['ReaderSyncStatusPill'];
let readerPaperSyncLabel: (typeof import('../src/sync/PaperSyncControl.tsx'))['readerPaperSyncLabel'];
let paperSyncStatusLabel: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperSyncStatusLabel'];
let paperConnectionAction: (typeof import('../src/sync/PaperSyncControl.tsx'))['paperConnectionAction'];
let shouldShowRemoteUpdateRecommendation: (typeof import('../src/sync/PaperSyncControl.tsx'))['shouldShowRemoteUpdateRecommendation'];
let getPaperSyncUiStatus: (typeof import('../src/sync/paperCoordinator.ts'))['getPaperSyncUiStatus'];
let getBlockingPaperIssueCount: (typeof import('../src/sync/paperCoordinator.ts'))['getBlockingPaperIssueCount'];
let PaperGoogleDriveSyncCoordinator: (typeof import('../src/sync/paperCoordinator.ts'))['PaperGoogleDriveSyncCoordinator'];
let PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION: (typeof import('../src/sync/paperCoordinator.ts'))['PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION'];
let SerializedDriveOperationOwner: (typeof import('../src/sync/paperCoordinator.ts'))['SerializedDriveOperationOwner'];
let classifyPaperCoordinatorError: (typeof import('../src/sync/paperCoordinator.ts'))['classifyPaperCoordinatorError'];
let autoSyncFollowUpPolicy: (typeof import('../src/sync/paperCoordinator.ts'))['autoSyncFollowUpPolicy'];
let paperStatusAfterFailure: (typeof import('../src/sync/paperCoordinator.ts'))['paperStatusAfterFailure'];
let transientAutoRetryDelay: (typeof import('../src/sync/paperCoordinator.ts'))['transientAutoRetryDelay'];
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
let PUBLIC_DEVICE_LIMITATION: string;

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
  const [
    ui,
    coordinator,
    temporary,
    repository,
    presenceRepository,
    drive,
    cloudFormat,
    localAdapter,
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
  ]);
  PaperSyncDrawer = ui.PaperSyncDrawer;
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
  paperConnectionAction = ui.paperConnectionAction;
  shouldShowRemoteUpdateRecommendation = ui.shouldShowRemoteUpdateRecommendation;
  getPaperSyncUiStatus = coordinator.getPaperSyncUiStatus;
  getBlockingPaperIssueCount = coordinator.getBlockingPaperIssueCount;
  PaperGoogleDriveSyncCoordinator = coordinator.PaperGoogleDriveSyncCoordinator;
  PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION =
    coordinator.PAPER_FOLDER_NAME_NORMALIZATION_CONFIRMATION;
  SerializedDriveOperationOwner = coordinator.SerializedDriveOperationOwner;
  classifyPaperCoordinatorError = coordinator.classifyPaperCoordinatorError;
  autoSyncFollowUpPolicy = coordinator.autoSyncFollowUpPolicy;
  paperStatusAfterFailure = coordinator.paperStatusAfterFailure;
  transientAutoRetryDelay = coordinator.transientAutoRetryDelay;
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
  PUBLIC_DEVICE_LIMITATION = temporary.PUBLIC_DEVICE_LIMITATION;
});

after(async () => server.close());

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
        'await this.markMigrationPublicationsIncorporated(record)',
      );
      assert.ok(verification >= 0 && incorporation > verification);
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
      const end = coordinator.indexOf('upgradeDriveSyncToV3()', start);
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
      const persist = coordinator.indexOf('await savePaperSyncState(state)', refresh);
      assert.ok(
        status >= 0 && insert > status && refresh > insert && persist > refresh,
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
        /if \(settledCloud\.length > 0\) \{[\s\S]*?phase: 'verifying'[\s\S]*?await this\.applyTransferCatalog\(settledCloud\)/u,
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
      assert.match(settlement, /await saveCloudPaperCatalog\(catalog\)/u);
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
      assert.match(localAdapter, /getTagsByIds/u);
      assert.doesNotMatch(localAdapter, /listCollections|listTags/u);
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
        /\[DOCUMENT_STATE_STORE, PDF_FILE_STORE, COLLECTION_STORE, TAG_STORE\]/u,
      );
      assert.match(
        source('../src/sync/paperCoordinator.ts'),
        /finalizeAppliedPaperDownload\(localApplication,[\s\S]*?savePaperSyncState\(state\)/u,
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
    'Home explains approved-account access without replacing connection controls',
    () => {
      const disconnected = renderDrawer(
        viewState({ connection: 'disconnected' }),
        true,
      );
      assert.match(
        disconnected,
        /Google Drive sync currently requires an approved Google account\. To request access, email Gmail39393@gmail\.com\./u,
      );
      assert.match(disconnected, />Connect Google Drive</u);
      assert.match(disconnected, />Request access</u);
      assert.equal(
        disconnected.match(/href="([^"]+)"[^>]*>Request access<\/a>/u)?.[1],
        'mailto:Gmail39393@gmail.com?subject=39Note%20Google%20Drive%20Access%20Request',
      );

      const reconnect = renderDrawer(
        viewState({ connection: 'reconnect-required' }),
        true,
      );
      assert.match(reconnect, />Reconnect Google Drive</u);
      assert.match(reconnect, />Request access</u);

      const connected = renderDrawer(viewState(), true);
      assert.match(connected, />Disconnect this device</u);
      assert.doesNotMatch(connected, /Request access|approved Google account/u);
      assert.doesNotMatch(
        disconnected,
        /client[_ -]?id|access token|device-session|worker|test-user/iu,
      );
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

test('incremental Drive discovery preserves a race-free durable cursor', async (context) => {
  const profile = (
    overrides: Partial<PaperSyncDeviceProfile> = {},
  ): PaperSyncDeviceProfile => ({
    id: 'paper-device',
    deviceId: 'device-a',
    deviceLabel: 'Device A',
    deviceMode: 'personal',
    autoSync: true,
    accountId: 'account-a',
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
    Reflect.set(instance, 'view', viewState({ papers }));
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
      Reflect.set(instance, 'identity', { hasDeviceSession: true });
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
      Reflect.set(instance, 'identity', { hasDeviceSession: true });
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
    () => {
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
      const markFailure = Reflect.get(coordinator, 'markPaperFailure') as (
        documentId: string,
        error: unknown,
      ) => { code: string; blocksOrdinarySync: boolean };
      const issue = markFailure.call(
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

  await context.test('a blocking paper failure changes only the affected paper', () => {
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
    const markFailure = Reflect.get(coordinator, 'markPaperFailure') as (
      documentId: string,
      error: unknown,
    ) => { code: string; blocksOrdinarySync: boolean };
    const issue = markFailure.call(
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
  });

  await context.test(
    'the redacted trace proves markPaperFailure is the first transition into attention',
    () => {
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
      const markFailure = Reflect.get(coordinator, 'markPaperFailure') as (
        documentId: string,
        error: unknown,
      ) => { code: string };
      const issue = markFailure.call(
        coordinator,
        state.documentId,
        new PaperV3ControlIntegrityError(
          'Projected upload response lacked ownership evidence.',
          state.documentId,
        ),
      );
      markFailure.call(
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
        /if \(settledCloud\.length > 0\) await this\.applyTransferCatalog\(settledCloud\)/u,
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
        ['private async scanCloudPapersOwned', '\n  downloadSelected('],
        ['private async downloadSelectedOwned', '\n  downloadAll('],
        ['private async uploadSelectedOwned', '\n  private applyPublishResult'],
      ]) {
        const start = coordinatorSource.indexOf(method);
        const end = coordinatorSource.indexOf(nextMethod, start);
        const body = coordinatorSource.slice(start, end);
        assert.ok(start >= 0 && end > start, `${method} should exist`);
        assert.ok(
          body.indexOf('await this.beginOperation()') <
            body.indexOf('await this.ensureRepository(signal'),
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
    tagCount: 0,
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
        tagIds: ['tag-b', 'tag-a'],
      }),
      {
        documentIds: ['doc-a', 'doc-b'],
        collectionIds: ['collection-a'],
        tagIds: ['tag-a', 'tag-b'],
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
    const revoke = coordinator.indexOf('await this.identity.disconnectCurrent()');
    const cleanup = coordinator.indexOf('await cleanupTemporaryOrigin()');
    assert.ok(revoke >= 0 && cleanup > revoke);
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

function renderDrawer(state: PaperSyncViewState, embedded = false): string {
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
