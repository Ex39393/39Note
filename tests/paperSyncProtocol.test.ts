import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import { DriveClient, type DriveFileMetadata } from '../src/sync/driveClient.ts';
import { estimateDriveRequestDag } from '../src/sync/driveOperationTelemetry.ts';
import {
  CloudPayloadPartitionError,
  encodeCloudPayload,
  parseCloudPayloadBlob,
} from '../src/sync/cloudFormat.ts';
import {
  createPaperManifestGeneration,
  parsePaperCloudManifestForSupportedLayout,
  parsePaperPayloadBlob,
  partitionPaperSnapshot,
} from '../src/sync/paperCloudFormat.ts';
import type {
  PaperDriveRepository as PaperDriveRepositoryInstance,
  PaperLayoutMigrationProof,
  PaperV3MigrationSeed,
} from '../src/sync/paperDriveRepository.ts';
import { sha256Hex, stableStringify } from '../src/sync/hash.ts';
import { isRecognizedPaperRootMetadata } from '../src/sync/paperRootValidation.ts';
import { PAPER_PRESENCE_PROTOCOL_VERSION } from '../src/sync/paperPresence.ts';
import {
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
  type LocalPaperPackage,
  type PaperCloudManifest,
  type PaperSyncState,
} from '../src/sync/paperTypes.ts';
import {
  PAPER_MEDIA_CONCURRENCY,
  PAPER_METADATA_CONCURRENCY,
  PAPER_TRANSFER_CONCURRENCY,
  KeyedSingleFlight,
  mapWithConcurrency,
} from '../src/sync/syncConcurrency.ts';
import { derivePaperStatus } from '../src/sync/paperStateMachine.ts';
import {
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type LocalSyncPdf,
  type LocalSyncSourceArtifact,
  type SyncConflict,
  type SyncEntityRecord,
  type SyncSnapshot,
} from '../src/sync/types.ts';

const signal = new AbortController().signal;
let server: ViteDevServer;
let PaperDriveRepository: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperDriveRepository'];
let PaperManifestIntegrityError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperManifestIntegrityError'];
let PaperRemoteChangedError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperRemoteChangedError'];
let PaperSnapshotUnstableError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperSnapshotUnstableError'];
let PaperSourcePdfConflictError: (typeof import('../src/sync/paperDriveRepository.ts'))['PaperSourcePdfConflictError'];
let createPaperDownloadOperationCache: (typeof import('../src/sync/paperDriveRepository.ts'))['createPaperDownloadOperationCache'];
let runScopedPaperDownload: (typeof import('../src/sync/paperDownloadRetry.ts'))['runScopedPaperDownload'];
let DriveRequestError: (typeof import('../src/sync/driveClient.ts'))['DriveRequestError'];
let DriveNetworkError: (typeof import('../src/sync/driveClient.ts'))['DriveNetworkError'];
let GoogleReauthorizationRequiredError: (typeof import('../src/sync/googleIdentity.ts'))['GoogleReauthorizationRequiredError'];
let SyncBackendUnavailableError: (typeof import('../src/sync/googleIdentity.ts'))['SyncBackendUnavailableError'];
let SyncServiceRateLimitedError: (typeof import('../src/sync/googleIdentity.ts'))['SyncServiceRateLimitedError'];

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
  const [module, driveModule, identityModule, retryModule] = await Promise.all([
    server.ssrLoadModule('/src/sync/paperDriveRepository.ts') as Promise<
      typeof import('../src/sync/paperDriveRepository.ts')
    >,
    server.ssrLoadModule('/src/sync/driveClient.ts') as Promise<
      typeof import('../src/sync/driveClient.ts')
    >,
    server.ssrLoadModule('/src/sync/googleIdentity.ts') as Promise<
      typeof import('../src/sync/googleIdentity.ts')
    >,
    server.ssrLoadModule('/src/sync/paperDownloadRetry.ts') as Promise<
      typeof import('../src/sync/paperDownloadRetry.ts')
    >,
  ]);
  PaperDriveRepository = module.PaperDriveRepository;
  PaperManifestIntegrityError = module.PaperManifestIntegrityError;
  PaperRemoteChangedError = module.PaperRemoteChangedError;
  PaperSnapshotUnstableError = module.PaperSnapshotUnstableError;
  PaperSourcePdfConflictError = module.PaperSourcePdfConflictError;
  createPaperDownloadOperationCache = module.createPaperDownloadOperationCache;
  runScopedPaperDownload = retryModule.runScopedPaperDownload;
  DriveRequestError = driveModule.DriveRequestError;
  DriveNetworkError = driveModule.DriveNetworkError;
  GoogleReauthorizationRequiredError =
    identityModule.GoogleReauthorizationRequiredError;
  SyncBackendUnavailableError = identityModule.SyncBackendUnavailableError;
  SyncServiceRateLimitedError = identityModule.SyncServiceRateLimitedError;
});

after(async () => server.close());

test('Paper-v3 compatibility versions remain unchanged', () => {
  assert.deepEqual(
    {
      rootLayout: SYNC_LAYOUT_VERSION,
      paperPackageLayout: PAPER_PACKAGE_LAYOUT_VERSION,
      paperSyncProtocol: PAPER_SYNC_PROTOCOL_VERSION,
      presenceProtocol: PAPER_PRESENCE_PROTOCOL_VERSION,
    },
    {
      rootLayout: 3,
      paperPackageLayout: 3,
      paperSyncProtocol: 2,
      presenceProtocol: 1,
    },
  );
});

test('layout-3 Drive round trip preserves an honestly typed Office source', async () => {
  const drive = new MemoryDrive();
  const repository = await initializedRepository(drive);
  const local = await officeLocalPackage('doc-docx', 'Research notes', 'docx');
  const published = await repository.publishPaper(
    local,
    paperState(local.documentId),
    signal,
  );

  assert.equal(published.manifest.syncLayoutVersion, 3);
  assert.equal(published.manifest.sourceArtifact?.documentType, 'docx');
  assert.equal(
    published.manifest.sourceArtifact?.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(published.manifest.sourceArtifact?.driveRole, 'paper-source-document');
  assert.equal(published.manifest.sourcePdf, undefined);
  assert.equal(published.snapshot.pdfs.length, 0);
  assert.equal(drive.byRole('paper-source-pdf').length, 0);
  assert.equal(drive.byRole('paper-source-document').length, 1);

  const downloaded = await repository.downloadPaper(published.cloud, signal);
  assert.equal(downloaded.sourcePdf, undefined);
  assert.equal(downloaded.sourceArtifact?.documentType, 'docx');
  assert.equal(downloaded.sourceArtifact?.fileName, 'Research notes.docx');
  assert.equal(downloaded.sourceArtifact?.sha256, local.sourceArtifact?.sha256);
  assert.equal(downloaded.sourceArtifact?.size, local.sourceArtifact?.size);
  assert.equal(downloaded.snapshot.pdfs.length, 0);
});

test('a layout-2 client rejects layout 3 before applying payloads or publishing descendants', async () => {
  const fixture = await publishedFixture('doc-new-layout', 'New layout paper');
  const manifestFile = fixture.drive.byRole('paper-manifest-generation')[0];
  const manifestText = await fixture.drive.peekText(manifestFile.id);
  const manifestCountBefore = fixture.drive.byRole('paper-manifest-generation').length;
  let appliedSnapshot: SyncSnapshot | undefined;
  fixture.drive.resetRequestLog();

  await assert.rejects(async () => {
    const manifest = parsePaperCloudManifestForSupportedLayout(
      manifestText,
      LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
    );
    const state = await fixture.drive.downloadBlob(manifest.state.fileId, signal);
    appliedSnapshot = {
      ...fixture.first.snapshot,
      generatedAt: state.size,
    };
    await fixture.repository.publishPaper(
      await localPackage('doc-new-layout', 'Legacy descendant'),
      fixture.state,
      signal,
    );
  }, /newer 39Note version/u);

  assert.equal(appliedSnapshot, undefined);
  assert.equal(fixture.drive.blobReads.length, 0);
  assert.equal(fixture.drive.writes.length, 0);
  assert.equal(
    fixture.drive.byRole('paper-manifest-generation').length,
    manifestCountBefore,
  );
});

test('Office papers use the same explicit Remove and exact-folder Restore path', async () => {
  const drive = new MemoryDrive();
  const repository = await initializedRepository(drive);
  const local = await officeLocalPackage('doc-pptx-restore', 'Lecture deck', 'pptx');
  const state = paperState(local.documentId);
  const published = await repository.publishPaper(local, state, signal);
  incorporate(state, published);
  const originalFolderId = published.cloud.paperFolderId;

  const removed = await repository.removePaperFromDrive(
    published.cloud,
    { deviceId: 'device-remover' },
    signal,
  );
  state.cloudPresence = 'removed';
  state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
  assert.equal(drive.file(originalFolderId).trashed, true);

  const unchanged = await officeLocalPackage(
    'doc-pptx-restore',
    'Lecture deck',
    'pptx',
  );
  unchanged.snapshot = published.snapshot;
  const sourceUploads = drive.uploadsByRole('paper-source-document');
  const restored = await repository.restorePaper(unchanged, state, signal);

  assert.equal(restored.restoreMode, 'fast-untrash');
  assert.equal(restored.cloud.paperFolderId, originalFolderId);
  assert.equal(restored.filesUploaded, 0);
  assert.equal(restored.sourcePdfUploaded, false);
  assert.equal(drive.file(originalFolderId).trashed, false);
  assert.equal(drive.uploadsByRole('paper-source-document'), sourceUploads);
});

test('rendered Print PDF replacement updates only the verified secondary artifact', async () => {
  const drive = new MemoryDrive();
  const repository = await initializedRepository(drive);
  const local = await localPackage('doc-print', 'Research paper');
  const printDraftValue = {
    editorStateJson: '{"root":{"children":[{"text":"unchanged draft"}]}}',
  };
  local.snapshot.entities.push(
    await entity('print-draft', local.documentId, local.documentId, printDraftValue, 1),
  );
  const printBlob = new Blob(['%PDF-1.7\nartifact A\n%%EOF'], {
    type: 'application/pdf',
  });
  local.renderedPrintPdf = {
    kind: 'rendered-print-pdf',
    documentId: local.documentId,
    fileName: 'Research paper - Print.pdf',
    mimeType: 'application/pdf',
    size: printBlob.size,
    sha256: await sha256Hex(printBlob),
    renderedFromDraftHash: 'd'.repeat(64),
    createdAt: 10,
    storedAt: 10,
    blob: printBlob,
  };
  local.renderedPrintPdfHashVerified = true;
  const state = paperState(local.documentId);
  state.dirtyReasons = ['rendered-print-pdf'];

  const published = await repository.publishPaper(local, state, signal);
  assert.equal(published.renderedPrintPdfUploaded, true);
  assert.equal(
    published.manifest.renderedPrintPdf?.sha256,
    local.renderedPrintPdf.sha256,
  );
  assert.equal(drive.byRole('paper-rendered-print-pdf').length, 1);
  assert.equal(drive.byRole('paper-source-pdf').length, 1);
  assert.notEqual(
    published.manifest.renderedPrintPdf?.fileId,
    published.manifest.sourceArtifact?.fileId,
  );

  const downloaded = await repository.downloadPaper(published.cloud, signal);
  assert.equal(downloaded.renderedPrintPdf?.sha256, local.renderedPrintPdf.sha256);
  assert.equal(await downloaded.renderedPrintPdf?.blob.text(), await printBlob.text());
  assert.equal(downloaded.sourcePdf?.sha256, local.sourcePdf?.sha256);

  incorporate(state, published);
  const originalSourceFileId = published.manifest.sourceArtifact?.fileId;
  const originalSourceHash = published.manifest.sourceArtifact?.sha256;
  const originalPrintFileId = published.manifest.renderedPrintPdf?.fileId;
  const replacement = await localPackage('doc-print', 'Research paper');
  replacement.snapshot = published.snapshot;
  replacement.sourcePdfHashVerified = true;
  const replacementBlob = new Blob(['%PDF-1.7\nartifact B\n%%EOF'], {
    type: 'application/pdf',
  });
  replacement.renderedPrintPdf = {
    kind: 'rendered-print-pdf',
    documentId: replacement.documentId,
    fileName: 'Research paper - Print.pdf',
    mimeType: 'application/pdf',
    size: replacementBlob.size,
    sha256: await sha256Hex(replacementBlob),
    renderedFromDraftHash: 'e'.repeat(64),
    createdAt: 20,
    storedAt: 20,
    blob: replacementBlob,
  };
  replacement.renderedPrintPdfHashVerified = true;
  state.dirtyReasons = ['rendered-print-pdf'];

  const replaced = await repository.publishPaper(replacement, state, signal);
  assert.equal(replaced.renderedPrintPdfUploaded, true);
  assert.equal(replaced.manifest.sourceArtifact?.fileId, originalSourceFileId);
  assert.equal(replaced.manifest.sourceArtifact?.sha256, originalSourceHash);
  assert.notEqual(replaced.manifest.renderedPrintPdf?.fileId, originalPrintFileId);
  assert.equal(
    replaced.manifest.renderedPrintPdf?.sha256,
    replacement.renderedPrintPdf.sha256,
  );

  const replacementDownload = await repository.downloadPaper(replaced.cloud, signal);
  assert.equal(
    await replacementDownload.renderedPrintPdf?.blob.text(),
    await replacementBlob.text(),
  );
  assert.notEqual(
    await replacementDownload.renderedPrintPdf?.blob.text(),
    await printBlob.text(),
  );
  assert.equal(replacementDownload.sourcePdf?.sha256, originalSourceHash);
  assert.deepEqual(
    replacementDownload.snapshot.entities.find(
      (record) => record.kind === 'print-draft',
    )?.value,
    printDraftValue,
  );
});

test('removing a rendered Print PDF publishes a new manifest without deleting the paper', async () => {
  const fixture = await publishedFixture('doc-print-remove', 'Paper');
  const withPrint = await localPackage('doc-print-remove', 'Paper', 'with-print');
  const printBlob = new Blob(['%PDF-1.7\nsecondary\n%%EOF'], {
    type: 'application/pdf',
  });
  withPrint.sourcePdfHashVerified = true;
  withPrint.renderedPrintPdf = {
    kind: 'rendered-print-pdf',
    documentId: withPrint.documentId,
    fileName: 'Paper - Print.pdf',
    mimeType: 'application/pdf',
    size: printBlob.size,
    sha256: await sha256Hex(printBlob),
    renderedFromDraftHash: 'e'.repeat(64),
    createdAt: 20,
    storedAt: 20,
    blob: printBlob,
  };
  withPrint.renderedPrintPdfHashVerified = true;
  fixture.state.dirtyReasons = ['rendered-print-pdf'];
  const attached = await fixture.repository.publishPaper(
    withPrint,
    fixture.state,
    signal,
  );
  incorporate(fixture.state, attached);
  assert.ok(attached.manifest.renderedPrintPdf);

  const withoutPrint = await localPackage('doc-print-remove', 'Paper', 'with-print');
  withoutPrint.sourcePdfHashVerified = true;
  fixture.state.dirtyReasons = ['rendered-print-pdf'];
  const removed = await fixture.repository.publishPaper(
    withoutPrint,
    fixture.state,
    signal,
  );
  assert.equal(removed.manifest.deleted, false);
  assert.equal(removed.manifest.renderedPrintPdf, undefined);
  assert.ok(removed.manifest.sourceArtifact);
  const downloaded = await fixture.repository.downloadPaper(removed.cloud, signal);
  assert.equal(downloaded.renderedPrintPdf, undefined);
  assert.ok(downloaded.sourcePdf);
});

test('cached roots must be owned and carry an explicit supported 39Note layout', async () => {
  const root: DriveFileMetadata = {
    id: 'root-id',
    name: '39Note',
    mimeType: 'application/vnd.google-apps.folder',
    ownedByMe: true,
    appProperties: {
      application: '39Note',
      role: 'root',
      layoutVersion: String(SYNC_LAYOUT_VERSION),
      paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
      presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
      controlFolderId: 'control-folder',
      migrationCompletionId: 'a'.repeat(64),
    },
  };
  assert.equal(isRecognizedPaperRootMetadata(root), true);
  assert.equal(
    isRecognizedPaperRootMetadata({
      ...root,
      appProperties: {
        application: '39Note',
        role: 'root',
        layoutVersion: '2',
        paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
      },
    }),
    true,
    'the controlled migration must still recognize a legacy package-v2 root',
  );
  assert.equal(isRecognizedPaperRootMetadata({ ...root, ownedByMe: false }), false);
  assert.equal(
    isRecognizedPaperRootMetadata({ ...root, appProperties: undefined }),
    false,
  );
  assert.equal(
    isRecognizedPaperRootMetadata({
      ...root,
      appProperties: {
        application: '39Note',
        role: 'root',
        syncSchema: '1',
      },
    }),
    true,
  );

  const unownedDrive = new MemoryDrive();
  unownedDrive.seed({ ...root, ownedByMe: false });
  const repository = new PaperDriveRepository(unownedDrive, root.id);
  await assert.rejects(
    () => repository.detectLayout(signal),
    (error: unknown) =>
      error instanceof Error && Reflect.get(error, 'code') === 'drive-root-invalid',
  );
  assert.equal(unownedDrive.queries.length, 0);
});

test('paper identity and Drive presentation remain separate', async (context) => {
  await context.test('one visible Drive folder is created per paper', async () => {
    const fixture = await publishedFixture('doc-a', 'Attention Is All You Need');
    assert.equal(fixture.drive.byRole('paper-folder').length, 1);
    assert.equal(fixture.drive.byRole('paper-data').length, 1);
    assert.equal(fixture.drive.byRole('paper-source-pdf').length, 1);
  });

  await context.test('folder and source PDF names follow display name', async () => {
    const fixture = await publishedFixture('doc-a', 'Attention Is All You Need');
    assert.equal(
      fixture.drive.byRole('paper-folder')[0].name,
      'Attention Is All You Need',
    );
    assert.equal(
      fixture.drive.byRole('paper-source-pdf')[0].name,
      'Attention Is All You Need.pdf',
    );
  });

  await context.test(
    'new paper folders strip only a final PDF extension case-insensitively',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Clinical Review.PDF');
      assert.equal(fixture.drive.byRole('paper-folder')[0].name, 'Clinical Review');
      assert.equal(fixture.first.displayName, 'Clinical Review.PDF');
    },
  );

  await context.test(
    'ordinary sync never renames an existing folder or source filename',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Old title');
      const folderId = fixture.drive.byRole('paper-folder')[0].id;
      const source = fixture.drive.byRole('paper-source-pdf')[0];
      incorporate(fixture.state, fixture.first);
      fixture.drive.resetRequestLog();
      const renamed = await fixture.repository.publishPaper(
        await localPackage('doc-a', 'New title'),
        fixture.state,
        signal,
      );
      assert.equal(renamed.documentId, 'doc-a');
      assert.equal(fixture.drive.byRole('paper-folder')[0].id, folderId);
      assert.equal(fixture.drive.byRole('paper-folder')[0].name, 'Old title');
      assert.equal(fixture.drive.file(source.id).name, 'Old title.pdf');
      assert.equal(
        fixture.drive.writes.some(
          ({ kind, fileId }) =>
            kind === 'update-metadata' && (fileId === folderId || fileId === source.id),
        ),
        false,
      );
    },
  );

  await context.test(
    'explicit folder normalization previews read-only and patches verified names only',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      const first = await repository.publishPaper(
        await localPackage('doc-a', 'Same'),
        paperState('doc-a'),
        signal,
      );
      const second = await repository.publishPaper(
        await localPackage('doc-b', 'Other'),
        paperState('doc-b'),
        signal,
      );
      const firstFolder = drive.file(first.cloud.paperFolderId);
      const secondFolder = drive.file(second.cloud.paperFolderId);
      const firstSource = drive
        .byRole('paper-source-pdf')
        .find(({ appProperties }) => appProperties?.documentId === 'doc-a');
      assert.ok(firstSource);
      await drive.updateMetadata(firstFolder.id, { name: 'Same.PdF' });
      await drive.updateMetadata(secondFolder.id, { name: 'Same' });
      drive.seed({
        id: 'unknown-pdf-folder',
        name: 'Unknown.pdf',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        ownedByMe: true,
      });
      drive.seed({
        id: 'malformed-control-pdf-folder',
        name: 'Control.pdf',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        ownedByMe: true,
        appProperties: {
          application: 'Other',
          role: 'paper-v3-control',
        },
      });
      drive.seed({
        id: 'outside-paper-folder',
        name: 'Outside.pdf',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['outside-root'],
        ownedByMe: true,
        appProperties: paperProperties('paper-folder', 'doc-outside'),
      });
      drive.resetRequestLog();

      const preview = await repository.inspectPaperFolderNames(signal);
      assert.equal(preview.candidateCount, 1);
      assert.deepEqual(
        preview.items.map(({ folderId, currentName, normalizedName }) => ({
          folderId,
          currentName,
          normalizedName,
        })),
        [
          {
            folderId: firstFolder.id,
            currentName: 'Same.PdF',
            normalizedName: 'Same',
          },
        ],
      );
      assert.equal(drive.writes.length, 0, 'preview must be read-only');

      const before = drive.file(firstFolder.id);
      const result = await repository.normalizePaperFolderNames(preview, signal);
      const after = drive.file(firstFolder.id);
      assert.deepEqual(result.renamedFolderIds, [firstFolder.id]);
      assert.equal(after.name, 'Same');
      assert.equal(after.id, before.id);
      assert.deepEqual(after.parents, before.parents);
      assert.deepEqual(after.appProperties, before.appProperties);
      assert.equal(drive.file(secondFolder.id).name, 'Same');
      assert.notEqual(
        firstFolder.id,
        secondFolder.id,
        'same-name folders stay separate',
      );
      assert.equal(drive.file(firstSource.id).name, firstSource.name);
      assert.equal(drive.file('unknown-pdf-folder').name, 'Unknown.pdf');
      assert.equal(drive.file('malformed-control-pdf-folder').name, 'Control.pdf');
      assert.equal(drive.file('outside-paper-folder').name, 'Outside.pdf');
      assert.deepEqual(
        drive.writes.filter(({ kind }) => kind === 'update-metadata'),
        [
          {
            kind: 'update-metadata',
            fileId: firstFolder.id,
            role: 'paper-folder',
          },
        ],
      );
    },
  );

  await context.test(
    'folder normalization refuses changed ancestry before its name-only mutation',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      const folderId = fixture.first.cloud.paperFolderId;
      await fixture.drive.updateMetadata(folderId, { name: 'Paper.pdf' });
      const preview = await fixture.repository.inspectPaperFolderNames(signal);
      assert.equal(preview.candidateCount, 1);
      await fixture.drive.updateMetadata(folderId, { parents: ['outside-root'] });
      fixture.drive.resetRequestLog();

      await assert.rejects(
        fixture.repository.normalizePaperFolderNames(preview, signal),
        /changed after the folder-name preview/u,
      );
      assert.equal(fixture.drive.file(folderId).name, 'Paper.pdf');
      assert.equal(fixture.drive.writes.length, 0);
    },
  );

  await context.test(
    'two same-name papers keep distinct stable identities',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'Same title'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'Same title'),
        paperState('doc-b'),
        signal,
      );
      const folders = drive.byRole('paper-folder');
      assert.equal(folders.length, 2);
      assert.deepEqual(
        new Set(folders.map((file) => file.appProperties?.documentId)),
        new Set(['doc-a', 'doc-b']),
      );
    },
  );

  await context.test(
    'source and rendered Print PDF roles cannot be confused',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      const manifest = fixture.first.manifest;
      assert.equal(manifest.sourceArtifact?.documentId, 'doc-a');
      assert.equal(manifest.sourceArtifact?.documentType, 'pdf');
      assert.equal(manifest.renderedPrintPdf, undefined);
      assert.equal(fixture.drive.byRole('paper-rendered-print-pdf').length, 0);
      assert.notEqual('paper-source-pdf', 'paper-rendered-print-pdf');
    },
  );

  await context.test(
    'unknown root files survive initialization and publication',
    async () => {
      const drive = new MemoryDrive();
      drive.seed(
        {
          id: 'unknown-file',
          name: 'Keep me.txt',
          mimeType: 'text/plain',
          parents: ['root'],
        },
        new Blob(['keep']),
      );
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'Paper'),
        paperState('doc-a'),
        signal,
      );
      assert.equal(drive.file('unknown-file').trashed, false);
      assert.equal(await drive.downloadText('unknown-file', signal), 'keep');
    },
  );
});

test('paper-v2 logical partitions interoperate across local workspace boundaries', async (context) => {
  const temporaryWorkspaceId = '77777777-7777-4777-8777-777777777777';

  await context.test(
    'already-published document-scoped Collection metadata is accepted by paper-v2',
    async () => {
      const documentId = 'doc-a';
      const paperPackage = await localPackage(documentId, 'Paper A');
      paperPackage.writer = {
        deviceId: 'temporary-device',
        deviceLabel: 'Temporary browser',
      };
      paperPackage.snapshot.generatedBy = 'temporary-device';
      paperPackage.snapshot.entities.push(
        await entity(
          'collection',
          'collection-a',
          documentId,
          {
            id: 'collection-a',
            name: 'Research',
            normalizedName: 'research',
            createdAt: 1,
            updatedAt: 1,
          },
          1,
        ),
      );
      const partitions = partitionPaperSnapshot(paperPackage.snapshot, documentId);
      const encoded = await encodeCloudPayload(partitions.state);
      const parsed = await parsePaperPayloadBlob(
        new Blob([encoded.text]),
        encoded.sha256,
        'document-state',
        documentId,
      );

      assert.equal(
        parsed.entities.some((record) => record.kind === 'collection'),
        true,
      );
      assert.equal((await encodeCloudPayload(parsed)).sha256, encoded.sha256);
      assert.doesNotMatch(encoded.text, /temporary-workspace/iu);
      assert.doesNotMatch(encoded.text, new RegExp(temporaryWorkspaceId, 'u'));
      const adapterSource = readFileSync(
        new URL('../src/sync/paperLocalAdapter.ts', import.meta.url),
        'utf8',
      );
      const packageBuilder = adapterSource.slice(
        adapterSource.indexOf('async createPaperPackage'),
        adapterSource.indexOf('createDeletedPaperPackage'),
      );
      assert.doesNotMatch(
        packageBuilder,
        /temporaryWorkspace|workspaceId|databaseName|provenance/u,
      );
    },
  );

  await context.test(
    'Temporary publisher and Personal downloader share documentId cloud identity',
    async () => {
      const drive = new MemoryDrive();
      const temporaryRepository = await initializedRepository(drive);
      const temporaryState = paperState('doc-a');
      temporaryState.deviceId = 'temporary-device';
      const paperPackage = await localPackage('doc-a', 'Paper A');
      paperPackage.writer = { deviceId: 'temporary-device' };
      paperPackage.snapshot.entities.push(
        await entity(
          'tag',
          'tag-a',
          'doc-a',
          {
            id: 'tag-a',
            name: 'Study',
            normalizedName: 'study',
            createdAt: 1,
            updatedAt: 1,
          },
          1,
        ),
      );
      await temporaryRepository.publishPaper(paperPackage, temporaryState, signal);

      const personalRepository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const personalState = paperState('doc-a');
      personalState.deviceId = 'personal-device';
      const [summary] = await personalRepository.discover([personalState], signal);
      const downloaded = await personalRepository.downloadPaper(summary, signal);

      assert.equal(downloaded.documentId, 'doc-a');
      assert.equal(
        downloaded.snapshot.entities.some(
          (record) => record.kind === 'tag' && record.documentId === 'doc-a',
        ),
        true,
      );
    },
  );

  await context.test(
    'cross-paper, legacy-global, and invalid paper-v2 contexts remain fail-closed',
    async () => {
      const foreign = await entity(
        'collection',
        'collection-b',
        'doc-b',
        { name: 'Foreign' },
        1,
      );
      const payload = {
        app: '39Note' as const,
        syncSchemaVersion: SYNC_SCHEMA_VERSION,
        entities: [foreign],
        tombstones: [],
      };
      const encoded = await encodeCloudPayload(payload);
      await assert.rejects(
        () =>
          parsePaperPayloadBlob(
            new Blob([encoded.text]),
            encoded.sha256,
            'document-state',
            'doc-a',
          ),
        (error: unknown) =>
          error instanceof CloudPayloadPartitionError &&
          error.expectedSemanticPartition === 'paper-state' &&
          error.actualSemanticPartitions.includes('different-paper') &&
          error.sourceProtocolVersion === PAPER_SYNC_PROTOCOL_VERSION &&
          !error.compatibilityNormalizationAttempted,
      );
      await assert.rejects(
        () =>
          parseCloudPayloadBlob(new Blob([encoded.text]), encoded.sha256, {
            logicalType: 'document-state',
            logicalPath: '/39Note/documents/doc-a/state.json',
            documentId: 'doc-a',
          }),
        CloudPayloadPartitionError,
      );

      await assert.rejects(
        () =>
          parseCloudPayloadBlob(new Blob([encoded.text]), encoded.sha256, {
            logicalType: 'library-metadata',
            logicalPath: '/39Note/library.json',
            documentId: 'doc-b',
            partitionModel: 'paper-v2',
            sourceProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
          }),
        CloudPayloadPartitionError,
      );
    },
  );

  await context.test(
    'same-paper metadata tombstones are accepted while wrong roles remain fail-closed',
    async () => {
      const tombstonePayload = {
        app: '39Note' as const,
        syncSchemaVersion: SYNC_SCHEMA_VERSION,
        entities: [],
        tombstones: [
          {
            key: createSyncEntityKey('collection', 'collection-a', 'doc-a'),
            kind: 'collection' as const,
            id: 'collection-a',
            documentId: 'doc-a',
            deletedAt: 2,
            deviceId: 'temporary-device',
          },
        ],
      };
      const encodedTombstone = await encodeCloudPayload(tombstonePayload);
      const parsed = await parsePaperPayloadBlob(
        new Blob([encodedTombstone.text]),
        encodedTombstone.sha256,
        'document-state',
        'doc-a',
      );
      assert.equal(parsed.tombstones[0]?.kind, 'collection');

      const wrongRoleCases = [
        {
          logicalType: 'document-state' as const,
          record: await entity('print-draft', 'draft-a', 'doc-a', {}, 2),
          category: 'paper-productivity',
        },
        {
          logicalType: 'productivity-data' as const,
          record: await entity('annotation', 'annotation-a', 'doc-a', {}, 2),
          category: 'paper-state',
        },
        {
          logicalType: 'document-state' as const,
          record: await entity('prompt-profile', 'prompt-a', 'doc-a', {}, 2),
          category: 'ai-settings',
        },
        {
          logicalType: 'document-state' as const,
          record: await entity('annotation', 'annotation-b', 'doc-b', {}, 2),
          category: 'different-paper',
        },
      ];
      for (const { category, logicalType, record } of wrongRoleCases) {
        const payload = {
          app: '39Note' as const,
          syncSchemaVersion: SYNC_SCHEMA_VERSION,
          entities: [record],
          tombstones: [],
        };
        const encoded = await encodeCloudPayload(payload);
        await assert.rejects(
          () =>
            parsePaperPayloadBlob(
              new Blob([encoded.text]),
              encoded.sha256,
              logicalType,
              'doc-a',
            ),
          (error: unknown) =>
            error instanceof CloudPayloadPartitionError &&
            error.actualSemanticPartitions.includes(category),
        );
      }
    },
  );
});

test('paper discovery is metadata-only, paginated, selective, and isolated', async (context) => {
  await context.test(
    'discovery fetches manifests but zero editable/PDF blobs',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      fixture.drive.resetRequestLog();
      const papers = await fixture.repository.discover([], signal, {
        layoutValidated: true,
      });
      assert.equal(papers.length, 1);
      assert.equal(
        fixture.drive.metadataReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        0,
      );
      assert.equal(
        fixture.drive.textReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        1,
      );
      assert.equal(fixture.drive.blobReads.length, 0);
      assert.ok(
        fixture.drive.queries.some((query) =>
          query.includes("role' and value='paper-manifest-generation"),
        ),
      );
    },
  );

  await context.test(
    'conflict note bodies stay behind an immutable payload during discovery',
    async () => {
      const conflict = await sampleConflict('doc-a', 'PRIVATE_ALTERNATE_NOTE_BODY');
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      const state = paperState('doc-a');
      state.conflicts = [conflict];
      await repository.publishPaper(
        await localPackage('doc-a', 'Paper'),
        state,
        signal,
      );
      drive.resetReads();
      await repository.discover([], signal);
      const fetchedText = (
        await Promise.all(drive.textReads.map((id) => drive.peekText(id)))
      ).join('\n');
      assert.ok(!fetchedText.includes('PRIVATE_ALTERNATE_NOTE_BODY'));
      assert.equal(drive.blobReads.length, 0);
    },
  );

  await context.test(
    'cloud-only status does not imply a broken local paper',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Cloud paper');
      const [paper] = await fixture.repository.discover([], signal);
      assert.equal(paper.localAvailability, 'cloud-only');
      assert.equal(paper.status, 'cloud-only');
      assert.equal(paper.issue, undefined);
    },
  );

  await context.test(
    'operational Drive and token failures are never relabeled as paper corruption',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Cloud paper');
      const manifest = fixture.drive.byRole('paper-manifest-generation')[0];
      fixture.drive.replaceBlob(
        manifest.id,
        await fixture.drive.downloadBlob(manifest.id),
      );
      fixture.drive.failNextTextForRole(
        'paper-manifest-generation',
        new DriveNetworkError('download'),
      );
      await assert.rejects(
        () => fixture.repository.discover([], signal),
        (error: unknown) => error instanceof DriveNetworkError,
      );

      const [summary] = await fixture.repository.discover([], signal);
      for (const failure of [
        new GoogleReauthorizationRequiredError(),
        new SyncBackendUnavailableError(),
        new SyncServiceRateLimitedError(),
      ]) {
        fixture.drive.failNextBlobForRole('paper-state', failure);
        await assert.rejects(
          () => fixture.repository.downloadPaper(summary, signal),
          (error: unknown) => error === failure,
        );
      }
    },
  );

  await context.test(
    'download selected fetches only the selected complete package',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'A'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'B'),
        paperState('doc-b'),
        signal,
      );
      const papers = await repository.discover([], signal);
      drive.resetReads();
      await repository.downloadSelected(
        [papers.find((paper) => paper.documentId === 'doc-b')!],
        signal,
      );
      const readDocumentIds = new Set(
        drive.blobReads.map((id) => drive.file(id).appProperties?.documentId),
      );
      assert.deepEqual(readDocumentIds, new Set(['doc-b']));
    },
  );

  await context.test(
    'a selected manifest head changing during transfer rejects before local application',
    async () => {
      const fixture = await publishedFixture('doc-race', 'Race paper');
      const child = await siblingManifest(
        fixture.first.manifest,
        'Race paper latest',
        50,
      );
      fixture.drive.resetRequestLog();
      let injected = false;
      fixture.drive.onBlobRead = (file) => {
        if (injected || file.appProperties?.role !== 'paper-state') return;
        injected = true;
        fixture.drive.injectManifest(child);
        fixture.drive.onBlobRead = undefined;
      };

      await assert.rejects(
        () => fixture.repository.downloadPaper(fixture.first.cloud, signal),
        (error: unknown) =>
          error instanceof PaperRemoteChangedError &&
          error.reason === 'manifest-head-changed',
      );
      assert.equal(injected, true);
      assert.equal(fixture.drive.writes.length, 0);
    },
  );

  await context.test(
    'a bounded scoped retry reuses verified immutable payloads and the source PDF',
    async () => {
      const fixture = await publishedFixture('doc-retry', 'Retry paper');
      const child = await siblingManifest(
        fixture.first.manifest,
        'Retry paper latest',
        51,
      );
      const operationCache = createPaperDownloadOperationCache();
      let injected = false;
      let attempts = 0;
      let localApplications = 0;
      fixture.drive.resetRequestLog();
      fixture.drive.onBlobRead = (file) => {
        if (injected || file.appProperties?.role !== 'paper-source-pdf') return;
        injected = true;
        fixture.drive.injectManifest(child);
        fixture.drive.onBlobRead = undefined;
      };

      const downloaded = await runScopedPaperDownload({
        documentId: 'doc-retry',
        initialSnapshot: fixture.first.cloud,
        download: async (summary) => {
          attempts += 1;
          return fixture.repository.downloadPaper(
            summary,
            signal,
            undefined,
            undefined,
            false,
            operationCache,
          );
        },
        refresh: async () => {
          const scoped = await fixture.repository.discoverPapers(
            ['doc-retry'],
            [],
            signal,
            { layoutValidated: true },
          );
          return scoped.papers[0];
        },
      });
      localApplications += 1;

      assert.equal(injected, true);
      assert.equal(attempts, 2);
      assert.equal(localApplications, 1);
      assert.deepEqual(downloaded.headIds, [child.generation.id]);
      assert.equal(
        fixture.drive.queries.includes("'root' in parents and trashed=false"),
        false,
        'the scoped retry must not enumerate every root child',
      );
      assert.equal(
        fixture.drive.blobReads.filter(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
      for (const role of ['paper-state', 'paper-productivity', 'paper-conflicts']) {
        assert.equal(
          fixture.drive.blobReads.filter(
            (fileId) => fixture.drive.file(fileId).appProperties?.role === role,
          ).length,
          1,
        );
      }
    },
  );

  await context.test(
    'download commit guard rejects a control folder moved during transfer',
    async () => {
      const fixture = await publishedFixture('doc-control-race', 'Control race');
      const controlFolderId = fixture.drive.byRole('paper-v3-control')[0].id;
      let moved = false;
      fixture.drive.onBlobRead = (file) => {
        if (moved || file.appProperties?.role !== 'paper-source-pdf') return;
        moved = true;
        fixture.drive.file(controlFolderId).parents = ['foreign-root'];
        fixture.drive.onBlobRead = undefined;
      };

      await assert.rejects(
        () => fixture.repository.downloadPaper(fixture.first.cloud, signal),
        (error: unknown) =>
          error instanceof PaperRemoteChangedError &&
          error.reason === 'root-control-changed',
      );
      assert.equal(moved, true);
    },
  );

  await context.test(
    'a source identity change across the bounded retry cannot reuse stale PDF bytes',
    async () => {
      const fixture = await publishedFixture('doc-source-retry', 'Source retry');
      const child = await siblingManifest(
        fixture.first.manifest,
        'Source retry latest',
        52,
      );
      const descriptor = fixture.first.manifest.sourceArtifact!;
      const operationCache = createPaperDownloadOperationCache();
      let injected = false;
      let attempts = 0;
      let refreshes = 0;
      fixture.drive.resetRequestLog();
      fixture.drive.onBlobRead = (file) => {
        if (injected || file.appProperties?.role !== 'paper-source-pdf') return;
        injected = true;
        fixture.drive.injectManifest(child);
        fixture.drive.onBlobRead = undefined;
      };

      await assert.rejects(
        () =>
          runScopedPaperDownload({
            documentId: 'doc-source-retry',
            initialSnapshot: fixture.first.cloud,
            download: async (summary) => {
              attempts += 1;
              return fixture.repository.downloadPaper(
                summary,
                signal,
                undefined,
                undefined,
                false,
                operationCache,
              );
            },
            refresh: async () => {
              refreshes += 1;
              fixture.drive.replaceBlob(
                descriptor.fileId,
                new Blob(['x'.repeat(descriptor.size)], {
                  type: 'application/pdf',
                }),
              );
              const scoped = await fixture.repository.discoverPapers(
                ['doc-source-retry'],
                [],
                signal,
                { layoutValidated: true },
              );
              return scoped.papers[0];
            },
          }),
        (error: unknown) => error instanceof PaperSnapshotUnstableError,
      );
      assert.equal(attempts, 2);
      assert.equal(refreshes, 1);
      assert.equal(
        fixture.drive.blobReads.filter((fileId) => fileId === descriptor.fileId).length,
        1,
      );
    },
  );

  await context.test(
    'an unrelated paper head change does not invalidate the selected download',
    async () => {
      const fixture = await publishedFixture('doc-selected', 'Selected paper');
      const unrelated = await fixture.repository.publishPaper(
        await localPackage('doc-unrelated', 'Unrelated paper'),
        paperState('doc-unrelated'),
        signal,
      );
      const unrelatedChild = await siblingManifest(
        unrelated.manifest,
        'Unrelated paper latest',
        60,
      );
      let injected = false;
      fixture.drive.onBlobRead = (file) => {
        if (injected || file.appProperties?.role !== 'paper-state') return;
        injected = true;
        fixture.drive.injectManifest(unrelatedChild);
        fixture.drive.onBlobRead = undefined;
      };
      fixture.drive.resetRequestLog();

      const downloaded = await fixture.repository.downloadPaper(
        fixture.first.cloud,
        signal,
      );

      assert.equal(downloaded.documentId, 'doc-selected');
      assert.equal(injected, true);
      assert.equal(
        fixture.drive.blobReads.filter(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
      assert.equal(
        fixture.drive.queries.some(
          (query) =>
            query.includes("role' and value='paper-folder'") &&
            !query.includes("documentId' and value='doc-selected'"),
        ),
        false,
      );
    },
  );

  await context.test(
    'Download all remains an explicit caller-selected operation',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'A'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'B'),
        paperState('doc-b'),
        signal,
      );
      const papers = await repository.discover([], signal);
      drive.resetReads();
      const downloaded = await repository.downloadSelected(papers, signal);
      assert.deepEqual(downloaded.map((paper) => paper.documentId).sort(), [
        'doc-a',
        'doc-b',
      ]);
    },
  );

  await context.test(
    'DriveClient files.list exhausts nextPageToken before returning paper folders',
    async () => {
      const originalFetch = globalThis.fetch;
      const tokens: Array<string | null> = [];
      globalThis.fetch = (async (input) => {
        const url = new URL(String(input));
        const token = url.searchParams.get('pageToken');
        tokens.push(token);
        return Response.json(
          token
            ? {
                files: [
                  {
                    id: 'beyond-first-page',
                    name: 'Paper',
                    mimeType: 'application/vnd.google-apps.folder',
                  },
                ],
              }
            : { files: [], nextPageToken: 'page-2' },
        );
      }) as typeof fetch;
      try {
        const client = new DriveClient(() => 'token');
        const files = await client.listFiles(
          "appProperties has { key='role' and value='paper-folder' }",
          signal,
        );
        assert.deepEqual(tokens, [null, 'page-2']);
        assert.equal(files[0].id, 'beyond-first-page');
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await context.test(
    'ambiguous managed folders isolate only the affected paper',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'A'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'B'),
        paperState('doc-b'),
        signal,
      );
      const original = drive
        .byRole('paper-folder')
        .find((file) => file.appProperties?.documentId === 'doc-a')!;
      drive.seed({ ...structuredClone(original), id: 'duplicate-doc-a' });
      const papers = await repository.discover([], signal);
      assert.equal(
        papers.find((paper) => paper.documentId === 'doc-a')?.status,
        'needs-attention',
      );
      assert.equal(
        papers.find((paper) => paper.documentId === 'doc-b')?.status,
        'cloud-only',
      );
    },
  );

  await context.test(
    'an invalid manifest fails closed for one paper without hiding others',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'A'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'B'),
        paperState('doc-b'),
        signal,
      );
      const manifest = drive
        .byRole('paper-manifest-generation')
        .find((file) => file.appProperties?.documentId === 'doc-a')!;
      drive.replaceBlob(manifest.id, new Blob(['{}'], { type: 'application/json' }));
      const papers = await repository.discover([], signal);
      assert.equal(
        papers.find((paper) => paper.documentId === 'doc-a')?.status,
        'needs-attention',
      );
      assert.equal(
        papers.find((paper) => paper.documentId === 'doc-b')?.status,
        'cloud-only',
      );
    },
  );

  await context.test(
    'paper-scoped discovery queries only the invalidated document and reuses verified manifests',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      await repository.publishPaper(
        await localPackage('doc-a', 'A'),
        paperState('doc-a'),
        signal,
      );
      await repository.publishPaper(
        await localPackage('doc-b', 'B'),
        paperState('doc-b'),
        signal,
      );
      drive.resetRequestLog();
      const scoped = await repository.discoverPapers(['doc-b', 'doc-b'], [], signal, {
        layoutValidated: true,
      });
      assert.deepEqual(scoped.missingDocumentIds, []);
      assert.deepEqual(
        scoped.papers.map((paper) => paper.documentId),
        ['doc-b'],
      );
      assert.equal(
        drive.queries.filter((query) => query.includes("value='doc-b'")).length,
        4,
      );
      assert.equal(
        drive.queries.some((query) => query.includes("value='doc-a'")),
        false,
      );
      assert.equal(
        drive.textReads.some(
          (id) =>
            drive.file(id).appProperties?.role === 'paper-presence-generation' &&
            drive.file(id).appProperties?.documentId === 'doc-a',
        ),
        false,
      );
      assert.equal(
        drive.metadataReads.filter(
          (id) => drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        0,
      );
      assert.equal(
        drive.textReads.filter(
          (id) => drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        0,
      );
      assert.equal(drive.blobReads.length, 0);
    },
  );

  await context.test(
    'post-delete scoped reconciliation stays at five waves and coalesces multiple papers',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      for (const documentId of ['doc-a', 'doc-b', 'doc-c']) {
        await repository.publishPaper(
          await localPackage(documentId, documentId.toUpperCase()),
          paperState(documentId),
          signal,
        );
      }

      drive.resetRequestLog();
      const singleScheduler = new VirtualDriveLatencyScheduler(150);
      drive.useVirtualLatency(singleScheduler);
      const single = await singleScheduler.run(() =>
        repository.discoverPapers(['doc-a'], [], signal, {
          layoutValidated: true,
          reuseVerifiedManifests: true,
        }),
      );
      assert.deepEqual(single.result.missingDocumentIds, []);
      assert.deepEqual(
        single.result.papers.map(({ documentId }) => documentId),
        ['doc-a'],
      );
      assert.deepEqual(auditDriveRequests(drive), {
        metadataGets: 1,
        lists: 4,
        mediaDownloads: 0,
        mediaUploadUpdates: 0,
        controlPresenceOperations: 1,
        totalRequests: 5,
      });
      assert.deepEqual(
        {
          requests: single.requestCount,
          waves: single.parallelWaves,
          latencyMs: single.estimatedCriticalPathLatencyMs,
        },
        { requests: 5, waves: 5, latencyMs: 750 },
      );

      drive.resetRequestLog();
      const batchScheduler = new VirtualDriveLatencyScheduler(150);
      drive.useVirtualLatency(batchScheduler);
      const batch = await batchScheduler.run(() =>
        repository.discoverPapers(['doc-c', 'doc-a', 'doc-b'], [], signal, {
          layoutValidated: true,
          reuseVerifiedManifests: true,
        }),
      );
      assert.deepEqual(batch.result.missingDocumentIds, []);
      assert.deepEqual(
        batch.result.papers.map(({ documentId }) => documentId),
        ['doc-a', 'doc-b', 'doc-c'],
      );
      assert.deepEqual(auditDriveRequests(drive), {
        metadataGets: 1,
        lists: 12,
        mediaDownloads: 0,
        mediaUploadUpdates: 0,
        controlPresenceOperations: 3,
        totalRequests: 13,
      });
      assert.deepEqual(
        {
          requests: batch.requestCount,
          waves: batch.parallelWaves,
          latencyMs: batch.estimatedCriticalPathLatencyMs,
        },
        { requests: 13, waves: 5, latencyMs: 750 },
      );
      assert.equal(
        drive.queries.some(
          (query) =>
            query.includes("role' and value='paper-folder'") &&
            !['doc-a', 'doc-b', 'doc-c'].some((documentId) =>
              query.includes(`documentId' and value='${documentId}'`),
            ),
        ),
        false,
      );
    },
  );

  await context.test(
    'one remote child costs one exact-paper walk and one new immutable manifest read',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const child = await siblingManifest(
        fixture.first.manifest,
        'Paper updated remotely',
        fixture.first.manifest.generation.createdAt + 1,
      );
      fixture.drive.injectManifest(child);
      fixture.drive.resetRequestLog();
      const scoped = await fixture.repository.discoverPapers(
        ['doc-a'],
        [fixture.state],
        signal,
        { layoutValidated: true },
      );
      assert.deepEqual(scoped.papers[0].headIds, [child.generation.id]);
      assert.equal(scoped.papers[0].status, 'remote-update-available');
      assert.equal(
        fixture.drive.queries.filter((query) => query.includes("value='doc-a'")).length,
        4,
      );
      assert.equal(
        fixture.drive.metadataReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        0,
      );
      assert.equal(
        fixture.drive.textReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        1,
      );
      assert.equal(fixture.drive.blobReads.length, 0);
    },
  );

  await context.test(
    'manifest cache reuse requires fresh identical metadata and reloads after metadata changes',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      const manifest = fixture.drive.byRole('paper-manifest-generation')[0];
      fixture.drive.resetRequestLog();
      await fixture.repository.discoverPapers(['doc-a'], [], signal, {
        layoutValidated: true,
      });
      assert.deepEqual(
        fixture.drive.metadataReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ),
        [],
      );
      assert.equal(
        fixture.drive.textReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ).length,
        0,
      );

      const unchangedText = await fixture.drive.peekText(manifest.id);
      fixture.drive.replaceBlob(
        manifest.id,
        new Blob([unchangedText], { type: 'application/json' }),
      );
      fixture.drive.resetRequestLog();
      const refreshed = await fixture.repository.discoverPapers(['doc-a'], [], signal, {
        layoutValidated: true,
      });
      assert.equal(refreshed.papers[0].status, 'cloud-only');
      assert.deepEqual(
        fixture.drive.metadataReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ),
        [],
      );
      assert.deepEqual(
        fixture.drive.textReads.filter(
          (id) =>
            fixture.drive.file(id).appProperties?.role === 'paper-manifest-generation',
        ),
        [manifest.id],
      );
      assert.equal(fixture.drive.blobReads.length, 0);
    },
  );

  await context.test(
    'one known update downloads only current-head payloads and skips a proven unchanged PDF',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const changed = await localPackage('doc-a', 'Paper', 'changed-note');
      changed.sourcePdfHashVerified = true;
      changed.snapshot.entities.push(
        await entity('note', 'note-a', 'doc-a', { text: 'new note' }, 2),
      );
      const second = await fixture.repository.publishPaper(
        changed,
        fixture.state,
        signal,
        undefined,
        { layoutValidated: true },
      );
      incorporate(fixture.state, second);
      assert.ok(changed.sourcePdf);
      fixture.state.pdfFingerprints.source = {
        size: changed.sourcePdf.size,
        lastModified: changed.sourcePdf.lastModified,
        storedAt: changed.sourcePdf.storedAt,
        sha256: changed.sourcePdf.sha256,
      };

      fixture.drive.resetRequestLog();
      const downloaded = await fixture.repository.downloadPaper(
        second.cloud,
        signal,
        undefined,
        fixture.state,
        true,
      );
      assert.equal(downloaded.sourcePdf, undefined);
      assert.ok(downloaded.reusedSourcePdfFingerprint);
      assert.ok(downloaded.sourcePdfDriveEvidence);
      assert.equal(fixture.drive.queries.length, 7);
      assert.equal(fixture.drive.metadataReads.length, 9);
      assert.equal(fixture.drive.textReads.length, 2);
      assert.equal(fixture.drive.blobReads.length, 3);
      assert.deepEqual(
        new Set(
          fixture.drive.blobReads.map(
            (id) => fixture.drive.file(id).appProperties?.role,
          ),
        ),
        new Set(['paper-state', 'paper-productivity', 'paper-conflicts']),
      );
      assert.equal(
        fixture.drive.metadataReads.length +
          fixture.drive.queries.length +
          fixture.drive.textReads.length +
          fixture.drive.blobReads.length,
        21,
      );

      fixture.drive.resetRequestLog();
      const localBlobMissing = await fixture.repository.downloadPaper(
        second.cloud,
        signal,
        undefined,
        fixture.state,
        false,
      );
      assert.ok(localBlobMissing.sourcePdf);
      assert.equal(
        fixture.drive.blobReads.filter(
          (id) => fixture.drive.file(id).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
    },
  );

  await context.test(
    'cold multi-history download batches ancestry manifests and reads only current payload bytes',
    async () => {
      const fixture = await publishedFixture('doc-history', 'History paper');
      incorporate(fixture.state, fixture.first);
      const historicalStateFileIds = [fixture.first.manifest.state.fileId];
      let current = fixture.first;
      for (let generation = 1; generation <= 8; generation += 1) {
        const changed = await localPackage(
          'doc-history',
          'History paper',
          `history-${generation}`,
        );
        changed.sourcePdfHashVerified = true;
        changed.snapshot.entities.push(
          await entity(
            'note',
            `history-note-${generation}`,
            'doc-history',
            { text: `generation ${generation}` },
            generation + 1,
          ),
        );
        fixture.state.dirtyReasons = ['notes'];
        current = await fixture.repository.publishPaper(
          changed,
          fixture.state,
          signal,
          undefined,
          { layoutValidated: true },
        );
        historicalStateFileIds.push(current.manifest.state.fileId);
        incorporate(fixture.state, current);
      }

      const discoveryRepository = new PaperDriveRepository(fixture.drive, 'root');
      const [summary] = await discoveryRepository.discover([fixture.state], signal);
      const coldRepository = new PaperDriveRepository(fixture.drive, 'root');
      fixture.drive.resetRequestLog();
      const scheduler = new VirtualDriveLatencyScheduler(150);
      fixture.drive.useVirtualLatency(scheduler);
      const measured = await scheduler.run(() =>
        coldRepository.downloadPaper(summary, signal),
      );

      const currentStateFileId = current.manifest.state.fileId;
      const downloadedStateFileIds = fixture.drive.blobReads.filter(
        (fileId) => fixture.drive.file(fileId).appProperties?.role === 'paper-state',
      );
      assert.deepEqual(downloadedStateFileIds, [currentStateFileId]);
      assert.equal(
        historicalStateFileIds
          .slice(0, -1)
          .some((fileId) => fixture.drive.blobReads.includes(fileId)),
        false,
      );
      assert.equal(
        fixture.drive.textReads.filter(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role ===
            'paper-manifest-generation',
        ).length,
        9,
      );
      assert.equal(
        fixture.drive.blobReads.filter(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
      const manifestReadsByWave = new Map<number, number>();
      for (const record of scheduler.records.filter(
        ({ label }) => label === 'paper-manifest-generation',
      )) {
        manifestReadsByWave.set(
          record.wave,
          (manifestReadsByWave.get(record.wave) ?? 0) + 1,
        );
      }
      assert.ok(
        [...manifestReadsByWave.values()].every(
          (count) => count <= PAPER_MEDIA_CONCURRENCY,
        ),
      );
      assertLatencyWaveCeiling(measured, 14);
    },
  );

  await context.test(
    'external source-PDF mutation invalidates reuse and fails closed',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const descriptor = fixture.first.snapshot.pdfs[0];
      const originalPackage = await localPackage('doc-a', 'Paper');
      assert.ok(originalPackage.sourcePdf);
      fixture.state.pdfFingerprints.source = {
        size: originalPackage.sourcePdf.size,
        lastModified: originalPackage.sourcePdf.lastModified,
        storedAt: originalPackage.sourcePdf.storedAt,
        sha256: originalPackage.sourcePdf.sha256,
      };
      fixture.drive.replaceBlob(
        descriptor.fileId!,
        new Blob(['X'.repeat(descriptor.size)], { type: 'application/pdf' }),
      );
      fixture.drive.resetRequestLog();
      await assert.rejects(
        () =>
          fixture.repository.downloadPaper(
            fixture.first.cloud,
            signal,
            undefined,
            fixture.state,
            true,
          ),
        PaperManifestIntegrityError,
      );
      assert.equal(
        fixture.drive.blobReads.filter(
          (id) => fixture.drive.file(id).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
    },
  );
});

test('per-paper publication remains immutable, selective, and race-safe', async (context) => {
  await context.test('editing Paper A never changes Paper B state', async () => {
    const a = paperState('doc-a');
    const b = paperState('doc-b');
    a.dirtyReasons = ['notes'];
    a.dirtyGeneration += 1;
    assert.deepEqual(b.dirtyReasons, []);
    assert.equal(b.dirtyGeneration, 0);
  });

  await context.test(
    'Note-only publication uploads zero source-PDF bytes',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const sourceUploads = fixture.drive.uploadsByRole('paper-source-pdf');
      const changed = await localPackage('doc-a', 'Paper', 'new-note');
      changed.sourcePdfHashVerified = true;
      changed.snapshot.entities.push(
        await entity('note', 'note-1', 'doc-a', { text: 'new' }, 2),
      );
      fixture.state.dirtyReasons = ['notes'];
      const uploadsBefore = fixture.drive.uploads.length;
      fixture.drive.resetRequestLog();
      const result = await fixture.repository.publishPaper(
        changed,
        fixture.state,
        signal,
        undefined,
        { layoutValidated: true },
      );
      assert.equal(result.sourcePdfUploaded, false);
      assert.equal(fixture.drive.uploadsByRole('paper-source-pdf'), sourceUploads);
      assert.equal(fixture.drive.blobReads.length, 4);
      assert.equal(fixture.drive.uploads.length - uploadsBefore, 2);
      assert.equal(
        fixture.drive.blobReads.some(
          (id) => fixture.drive.file(id).appProperties?.role === 'paper-source-pdf',
        ),
        false,
      );
    },
  );

  await context.test(
    'source publication falls back to exact byte verification when Drive omits SHA-256',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      drive.omitNextUploadSha256ForRole('paper-source-pdf');
      drive.resetRequestLog();

      const result = await repository.publishPaper(
        await localPackage('doc-checksum-fallback', 'Checksum fallback'),
        paperState('doc-checksum-fallback'),
        signal,
        undefined,
        { layoutValidated: true },
      );

      assert.equal(result.sourcePdfUploaded, true);
      assert.equal(
        drive.blobReads.filter(
          (fileId) => drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
    },
  );

  await context.test('an unchanged paper creates no immutable generation', async () => {
    const fixture = await publishedFixture('doc-a', 'Paper');
    incorporate(fixture.state, fixture.first);
    const packageAgain = await localPackage('doc-a', 'Paper');
    packageAgain.snapshot = fixture.first.snapshot;
    const manifests = fixture.drive.uploadsByRole('paper-manifest-generation');
    const result = await fixture.repository.publishPaper(
      packageAgain,
      fixture.state,
      signal,
    );
    assert.equal(result.noOp, true);
    assert.equal(fixture.drive.uploadsByRole('paper-manifest-generation'), manifests);
  });

  await context.test(
    'deselected dirty papers remain dirty because selection is caller-owned',
    () => {
      const states = [paperState('doc-a'), paperState('doc-b')];
      states.forEach((state) => {
        state.dirtyReasons = ['notes'];
      });
      const selected = new Set(['doc-a']);
      states
        .filter((state) => selected.has(state.documentId))
        .forEach((state) => {
          state.dirtyReasons = [];
        });
      assert.deepEqual(
        states.find((state) => state.documentId === 'doc-b')?.dirtyReasons,
        ['notes'],
      );
    },
  );

  await context.test(
    'current Drive heads are resolved before every publish',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const before = fixture.drive.queries.length;
      await fixture.repository.publishPaper(
        await localPackage('doc-a', 'Paper', 'updated'),
        fixture.state,
        signal,
      );
      assert.ok(
        fixture.drive.queries
          .slice(before)
          .some((query) =>
            query.includes("role' and value='paper-manifest-generation"),
          ),
      );
    },
  );

  await context.test(
    'immutable payload corruption blocks selected download',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      const [summary] = await fixture.repository.discover([], signal);
      fixture.drive.replaceBlob(
        fixture.first.manifest.state.fileId,
        new Blob(['corrupt']),
      );
      await assert.rejects(
        () => fixture.repository.downloadPaper(summary, signal),
        PaperManifestIntegrityError,
      );
    },
  );

  await context.test(
    'document tombstones publish a deleted paper without resurrection',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const deletion = deletedPackage('doc-a', fixture.state);
      fixture.state.dirtyReasons = ['deleted'];
      const result = await fixture.repository.publishPaper(
        deletion,
        fixture.state,
        signal,
      );
      assert.equal(result.manifest.deleted, true);
      assert.equal(
        result.snapshot.entities.some((record) => record.kind === 'document'),
        false,
      );
      assert.ok(
        result.snapshot.tombstones.some((record) => record.kind === 'document'),
      );
    },
  );

  await context.test(
    'concurrent per-paper heads reconcile into a child of every head',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      const concurrent = await siblingManifest(
        fixture.first.manifest,
        'Remote presentation',
        5,
        [],
      );
      fixture.drive.injectManifest(concurrent);
      const result = await fixture.repository.publishPaper(
        await localPackage('doc-a', 'Paper', 'local-edit'),
        fixture.state,
        signal,
      );
      assert.equal(result.remoteChanged, true);
      assert.deepEqual(
        new Set(result.manifest.generation.parents),
        new Set([fixture.first.manifest.generation.id, concurrent.generation.id]),
      );
    },
  );

  await context.test(
    'a remote head arriving during upload is never silently overwritten',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      fixture.state.dirtyReasons = ['notes'];
      const concurrent = await siblingManifest(
        fixture.first.manifest,
        'Concurrent remote',
        7,
      );
      let injected = false;
      fixture.drive.onManifestUpload = () => {
        if (injected) return;
        injected = true;
        fixture.drive.injectManifest(concurrent);
      };
      await assert.rejects(
        async () =>
          fixture.repository.publishPaper(
            await localPackage('doc-a', 'Paper', 'local-edit'),
            fixture.state,
            signal,
          ),
        PaperRemoteChangedError,
      );
      assert.deepEqual(fixture.state.dirtyReasons, ['notes']);
    },
  );

  await context.test('bounded transfer and metadata limits are conservative', () => {
    assert.equal(PAPER_METADATA_CONCURRENCY, 4);
    assert.equal(PAPER_MEDIA_CONCURRENCY, 4);
    assert.equal(PAPER_TRANSFER_CONCURRENCY, 2);
  });

  await context.test('bounded mapper never exceeds its concurrency limit', async () => {
    let active = 0;
    let maximum = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
    });
    assert.equal(maximum, 2);
  });

  await context.test(
    'current-package media verification shares one repository-wide cap',
    async () => {
      const drive = new MemoryDrive();
      const repository = new PaperDriveRepository(drive, 'root');
      const paperPackage = await localPackage('doc-media-cap', 'Media cap');
      const encoded = await encodeCloudPayload(
        partitionPaperSnapshot(paperPackage.snapshot, 'doc-media-cap').state,
      );
      const references = Array.from({ length: 9 }, (_, index) => {
        const fileId = `bounded-payload-${index}`;
        drive.seed(
          {
            id: fileId,
            name: `state-${index}.json`,
            mimeType: 'application/json',
            parents: ['data-folder'],
            ownedByMe: true,
            appProperties: paperProperties('paper-state', 'doc-media-cap'),
          },
          new Blob([encoded.text], { type: 'application/json' }),
        );
        return { fileId, sha256: encoded.sha256 };
      });
      const downloadPayload = Reflect.get(repository, 'downloadPayload').bind(
        repository,
      ) as (
        reference: { fileId: string; sha256: string },
        logicalType: 'document-state',
        documentId: string,
        signal: AbortSignal,
      ) => Promise<unknown>;
      const scheduler = new VirtualDriveLatencyScheduler(150);
      drive.useVirtualLatency(scheduler);
      const measurement = await scheduler.run(() =>
        Promise.all(
          references.map((reference) =>
            downloadPayload(reference, 'document-state', 'doc-media-cap', signal),
          ),
        ),
      );
      const downloadCountsByWave = new Map<number, number>();
      for (const record of scheduler.records.filter(
        ({ category }) => category === 'download',
      )) {
        downloadCountsByWave.set(
          record.wave,
          (downloadCountsByWave.get(record.wave) ?? 0) + 1,
        );
      }
      assert.equal(measurement.result.length, references.length);
      assert.ok(downloadCountsByWave.size >= 3);
      assert.ok(
        [...downloadCountsByWave.values()].every(
          (count) => count <= PAPER_MEDIA_CONCURRENCY,
        ),
      );
    },
  );

  await context.test(
    'keyed single-flight deduplicates StrictMode-style duplicate ownership',
    async () => {
      const flights = new KeyedSingleFlight<number>();
      let calls = 0;
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = flights.run('doc-a', async () => {
        calls += 1;
        await wait;
        return 7;
      });
      const second = flights.run('doc-a', async () => {
        calls += 1;
        return 8;
      });
      assert.equal(first, second);
      release();
      assert.deepEqual(await Promise.all([first, second]), [7, 7]);
      assert.equal(calls, 1);
    },
  );
});

test('Keep local performs an explicit immutable graph reconciliation', async (context) => {
  await context.test(
    'current local editable state wins and acknowledges every current remote head',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      fixture.state.cloudPresence = 'present';

      const remoteState = structuredClone(fixture.state);
      const remotePackage = await localPackage('doc-a', 'Paper', 'remote-newer');
      remotePackage.writer = { deviceId: 'device-b' };
      remotePackage.snapshot.generatedBy = 'device-b';
      remotePackage.snapshot.entities = [
        await entity(
          'document',
          'doc-a',
          undefined,
          { displayTitle: 'Paper', marker: 'remote-newer' },
          50,
        ),
      ];
      const remote = await fixture.repository.publishPaper(
        remotePackage,
        remoteState,
        signal,
      );
      const sibling = await siblingManifest(
        fixture.first.manifest,
        'Concurrent remote presentation',
        51,
      );
      fixture.drive.injectManifest(sibling);

      const local = await localPackage('doc-a', 'Paper', 'local-winner');
      local.sourcePdfHashVerified = true;
      local.snapshot.entities = [
        await entity(
          'document',
          'doc-a',
          undefined,
          { displayTitle: 'Paper', marker: 'local-winner' },
          3,
        ),
      ];
      fixture.state.status = 'both-changed';
      fixture.state.dirtyReasons = ['metadata'];
      const sourceUploads = fixture.drive.uploadsByRole('paper-source-pdf');
      fixture.drive.resetRequestLog();

      const result = await fixture.repository.reconcileKeepLocalPaper(
        local,
        fixture.state,
        signal,
      );

      assert.deepEqual(
        new Set(result.manifest.generation.parents),
        new Set([remote.manifest.generation.id, sibling.generation.id]),
      );
      assert.equal(
        (
          result.snapshot.entities.find((record) => record.kind === 'document')
            ?.value as {
            marker?: string;
          }
        ).marker,
        'local-winner',
      );
      assert.equal(result.noOp, false);
      assert.equal(result.sourcePdfUploaded, false);
      assert.equal(fixture.drive.uploadsByRole('paper-source-pdf'), sourceUploads);
      assert.ok(
        fixture.drive.queries.some((query) =>
          query.includes("role' and value='paper-manifest-generation"),
        ),
      );

      incorporate(fixture.state, result);
      fixture.state.dirtyReasons = [];
      assert.equal(derivePaperStatus(fixture.state, result.cloud.headIds), 'synced');
      assert.equal(
        result.cloud.headIds.some((headId) =>
          [remote.manifest.generation.id, sibling.generation.id].includes(headId),
        ),
        false,
      );
    },
  );

  await context.test(
    'an identical local snapshot still publishes an acknowledgement generation',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      fixture.state.cloudPresence = 'present';
      fixture.state.status = 'remote-update-available';
      fixture.state.incorporatedHeadIds = [];
      const local = await localPackage('doc-a', 'Paper');
      local.snapshot = fixture.first.snapshot;
      local.sourcePdfHashVerified = true;
      const manifests = fixture.drive.uploadsByRole('paper-manifest-generation');
      const sourceUploads = fixture.drive.uploadsByRole('paper-source-pdf');

      const result = await fixture.repository.reconcileKeepLocalPaper(
        local,
        fixture.state,
        signal,
      );

      assert.equal(result.noOp, false);
      assert.deepEqual(result.manifest.generation.parents, [
        fixture.first.manifest.generation.id,
      ]);
      assert.equal(
        fixture.drive.uploadsByRole('paper-manifest-generation'),
        manifests + 1,
      );
      assert.equal(fixture.drive.uploadsByRole('paper-source-pdf'), sourceUploads);
    },
  );

  await context.test(
    'a source-PDF conflict fails before any replacement generation is written',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper');
      incorporate(fixture.state, fixture.first);
      fixture.state.cloudPresence = 'present';
      fixture.state.status = 'both-changed';
      const local = await localPackage('doc-a', 'Paper', 'local-winner');
      const replacementBlob = new Blob(['%PDF-1.7\nreplacement'], {
        type: 'application/pdf',
      });
      const replacementHash = await sha256Hex(replacementBlob);
      assert.ok(local.sourcePdf);
      local.sourcePdf = {
        ...local.sourcePdf,
        blob: replacementBlob,
        size: replacementBlob.size,
        sha256: replacementHash,
      };
      local.snapshot.pdfs = [withoutBlob(local.sourcePdf)];
      const uploadCount = fixture.drive.uploads.length;

      await assert.rejects(
        () => fixture.repository.reconcileKeepLocalPaper(local, fixture.state, signal),
        PaperSourcePdfConflictError,
      );
      assert.equal(fixture.drive.uploads.length, uploadCount);
    },
  );
});

test('legacy layout is explicit and unknown files are never migration targets', async (context) => {
  await context.test(
    'legacy global layout is detected and ordinary discovery is blocked',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root');
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'legacy-upgrade-required',
      );
      await assert.rejects(() => repository.discover([], signal), /upgrade required/iu);
    },
  );

  await context.test(
    'paper artifacts without activation are migration-incomplete',
    async () => {
      const drive = new MemoryDrive();
      drive.seed({
        id: 'paper-folder',
        name: 'Paper',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        appProperties: paperProperties('paper-folder', 'doc-a'),
      });
      const repository = new PaperDriveRepository(drive, 'root');
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'migration-incomplete',
      );
    },
  );

  await context.test(
    'unknown files are excluded from positively identified legacy scope',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      drive.seed(
        {
          id: 'unknown',
          name: 'Personal.txt',
          mimeType: 'text/plain',
          parents: ['root'],
        },
        new Blob(['personal']),
      );
      const repository = new PaperDriveRepository(drive, 'root');
      const layout = await repository.detectLayout(signal);
      assert.ok(layout.legacyManagedFileIds.includes('legacy-manifest'));
      assert.ok(layout.unknownFileIds.includes('unknown'));
      assert.ok(!layout.legacyManagedFileIds.includes('unknown'));
    },
  );

  await context.test(
    'interrupted rebuild remains blocked until explicit activation',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      drive.seed({
        id: 'paper-folder',
        name: 'Paper',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        appProperties: paperProperties('paper-folder', 'doc-a'),
      });
      const repository = new PaperDriveRepository(drive, 'root');
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'migration-incomplete',
      );
      await assert.rejects(() => repository.discover([], signal), /incomplete/iu);
    },
  );
});

test('explicit paper-layout migration is guarded, resumable, and idempotent', async (context) => {
  await context.test(
    'A/E/F: migration publishes the first legacy paper while ordinary publish stays blocked',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const state = paperState('doc-a');
      const local = await localPackage('doc-a', 'Paper A');
      await assert.rejects(
        () => repository.publishPaper(local, state, signal),
        hasRepositoryCode('layout-upgrade-required'),
      );
      assert.equal(drive.uploads.length, 0);

      const inspection = await repository.detectLayout(signal);
      const migration = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, ['doc-a']),
        signal,
      );
      const invalid = await localPackage('doc-a', 'Paper A');
      invalid.sourcePdf!.blob = new Blob(['tampered'], {
        type: 'application/pdf',
      });
      await assert.rejects(
        () => migration.publishPaper(invalid, paperState('doc-a'), signal),
        hasRepositoryCode('paper-integrity-failed'),
      );
      assert.equal(drive.uploads.length, 0);
      const result = await migration.publishPaper(local, state, signal);
      assert.equal(result.documentId, 'doc-a');
      assert.equal(drive.byRole('paper-folder').length, 1);
      assert.equal(drive.byRole('paper-manifest-generation').length, 1);
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'migration-incomplete',
      );
      assert.equal(drive.file('root').appProperties?.layoutVersion, undefined);
      assert.equal(drive.byRole('paper-layout-activation').length, 0);

      await assert.rejects(
        () => repository.publishPaper(local, state, signal),
        hasRepositoryCode('layout-migration-incomplete'),
      );
    },
  );

  await context.test(
    'B: an incomplete zero-checkpoint retry reuses an existing paper folder and completes',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      drive.seed({
        id: 'orphan-paper-folder',
        name: 'Paper A',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
        appProperties: paperProperties('paper-folder', 'doc-a'),
      });
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const inspection = await repository.detectLayout(signal);
      assert.equal(inspection.state, 'migration-incomplete');
      const publishing = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, ['doc-a']),
        signal,
      );
      const published = await publishing.publishPaper(
        await localPackage('doc-a', 'Paper A'),
        paperState('doc-a'),
        signal,
      );
      assert.equal(drive.byRole('paper-folder').length, 1);
      const activating = await repository.openLayoutMigration(
        migrationProof(
          inspection.legacyManagedFileIds,
          ['doc-a'],
          ['doc-a'],
          'activating-layout',
          { 'doc-a': published.manifest.generation.id },
        ),
        signal,
      );
      await activating.verifyPublishedPapers(signal);
      await activating.activate(signal);
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'paper-v2-upgrade-required',
      );
      assert.equal(drive.byRole('paper-layout-activation').length, 1);
    },
  );

  await context.test(
    'C: retry after paper 1 reuses its exact folder and generation before publishing paper 2',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const inspection = await repository.detectLayout(signal);
      const targets = ['doc-a', 'doc-b'];
      const firstAttempt = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, targets),
        signal,
      );
      const stateA = paperState('doc-a');
      const packageA = await localPackage('doc-a', 'Paper A');
      const firstResult = await firstAttempt.publishPaper(packageA, stateA, signal);
      const firstFolderId = drive.byRole('paper-folder')[0].id;
      const firstManifestId = drive.byRole('paper-manifest-generation')[0].id;

      const retry = await repository.openLayoutMigration(
        migrationProof(
          inspection.legacyManagedFileIds,
          targets,
          ['doc-a'],
          'publishing-papers',
          { 'doc-a': firstResult.manifest.generation.id },
        ),
        signal,
      );
      const replay = await retry.publishPaper(packageA, stateA, signal);
      assert.equal(replay.noOp, true);
      assert.equal(drive.byRole('paper-folder')[0].id, firstFolderId);
      assert.equal(drive.byRole('paper-manifest-generation')[0].id, firstManifestId);
      assert.equal(drive.byRole('paper-folder').length, 1);
      assert.equal(drive.byRole('paper-manifest-generation').length, 1);

      const resultB = await retry.publishPaper(
        await localPackage('doc-b', 'Paper B'),
        paperState('doc-b'),
        signal,
      );
      assert.equal(drive.byRole('paper-folder').length, 2);
      assert.equal(drive.byRole('paper-manifest-generation').length, 2);
      const activating = await repository.openLayoutMigration(
        migrationProof(
          inspection.legacyManagedFileIds,
          targets,
          targets,
          'activating-layout',
          {
            'doc-a': replay.manifest.generation.id,
            'doc-b': resultB.manifest.generation.id,
          },
        ),
        signal,
      );
      await activating.activate(signal);
      assert.equal(
        (await repository.detectLayout(signal)).state,
        'paper-v2-upgrade-required',
      );
    },
  );

  await context.test(
    'D: all-published and activated-but-not-cleared retries verify without duplicate generations',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const inspection = await repository.detectLayout(signal);
      const targets = ['doc-a', 'doc-b'];
      const generationIds: Record<string, string> = {};
      const publishing = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, targets),
        signal,
      );
      for (const documentId of targets) {
        const result = await publishing.publishPaper(
          await localPackage(documentId, documentId.toUpperCase()),
          paperState(documentId),
          signal,
        );
        generationIds[documentId] = result.manifest.generation.id;
      }
      const manifestsBefore = drive
        .byRole('paper-manifest-generation')
        .map(({ id }) => id);
      const proof = migrationProof(
        inspection.legacyManagedFileIds,
        targets,
        targets,
        'activating-layout',
        generationIds,
      );
      const activating = await repository.openLayoutMigration(proof, signal);
      await activating.verifyPublishedPapers(signal);
      drive.failNextRootActivation();
      await assert.rejects(() => activating.activate(signal), /activation failure/u);
      assert.equal(drive.file('root').appProperties?.layoutVersion, undefined);
      assert.equal(drive.byRole('paper-layout-activation').length, 1);

      const activationRetry = await repository.openLayoutMigration(proof, signal);
      await activationRetry.activate(signal);
      assert.deepEqual(
        drive.byRole('paper-manifest-generation').map(({ id }) => id),
        manifestsBefore,
      );
      assert.equal(drive.byRole('paper-layout-activation').length, 1);

      const strandedRecordRetry = await repository.openLayoutMigration(proof, signal);
      await strandedRecordRetry.activate(signal);
      assert.deepEqual(
        drive.byRole('paper-manifest-generation').map(({ id }) => id),
        manifestsBefore,
      );
      assert.equal(drive.byRole('paper-layout-activation').length, 1);
    },
  );

  await context.test(
    'G: a changed legacy managed set fails closed before activation',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const inspection = await repository.detectLayout(signal);
      const publishing = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, ['doc-a']),
        signal,
      );
      const published = await publishing.publishPaper(
        await localPackage('doc-a', 'Paper A'),
        paperState('doc-a'),
        signal,
      );
      drive.seed(
        {
          id: 'new-legacy-library',
          name: 'library.json',
          mimeType: 'application/json',
          parents: ['root'],
          appProperties: { application: '39Note', role: 'library' },
        },
        new Blob(['{}'], { type: 'application/json' }),
      );
      await assert.rejects(
        () =>
          repository.openLayoutMigration(
            migrationProof(
              inspection.legacyManagedFileIds,
              ['doc-a'],
              ['doc-a'],
              'activating-layout',
              { 'doc-a': published.manifest.generation.id },
            ),
            signal,
          ),
        hasRepositoryCode('paper-remote-changed'),
      );
      assert.equal(drive.file('root').appProperties?.layoutVersion, undefined);
      assert.equal(drive.byRole('paper-layout-activation').length, 0);
    },
  );

  await context.test(
    'H: unknown files retain exact metadata and bytes through a complete rebuild',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      drive.seed(
        {
          id: 'personal-file',
          name: 'Personal.txt',
          mimeType: 'text/plain',
          parents: ['root'],
          appProperties: { owner: 'user' },
        },
        new Blob(['do not touch'], { type: 'text/plain' }),
      );
      const before = structuredClone(drive.file('personal-file'));
      const beforeText = await drive.peekText('personal-file');
      const repository = new PaperDriveRepository(drive, 'root', {
        now: monotonicNow(),
      });
      const inspection = await repository.detectLayout(signal);
      const publishing = await repository.openLayoutMigration(
        migrationProof(inspection.legacyManagedFileIds, ['doc-a']),
        signal,
      );
      const published = await publishing.publishPaper(
        await localPackage('doc-a', 'Paper A'),
        paperState('doc-a'),
        signal,
      );
      const activating = await repository.openLayoutMigration(
        migrationProof(
          inspection.legacyManagedFileIds,
          ['doc-a'],
          ['doc-a'],
          'activating-layout',
          { 'doc-a': published.manifest.generation.id },
        ),
        signal,
      );
      await activating.activate(signal);
      assert.deepEqual(drive.file('personal-file'), before);
      assert.equal(await drive.peekText('personal-file'), beforeText);
    },
  );

  await context.test(
    'I: a migration record for another root is refused before writes',
    async () => {
      const drive = new MemoryDrive({ legacy: true });
      const repository = new PaperDriveRepository(drive, 'root');
      const inspection = await repository.detectLayout(signal);
      const proof = {
        ...migrationProof(inspection.legacyManagedFileIds, ['doc-a']),
        rootFolderId: 'different-root',
      };
      await assert.rejects(
        () => repository.openLayoutMigration(proof, signal),
        hasRepositoryCode('layout-migration-proof-invalid'),
      );
      assert.equal(drive.uploads.length, 0);
      assert.equal(drive.byRole('paper-folder').length, 0);
    },
  );
});

function migrationProof(
  verifiedLegacyFileIds: readonly string[],
  targetDocumentIds: readonly string[],
  publishedDocumentIds: readonly string[] = [],
  phase: PaperLayoutMigrationProof['phase'] = 'publishing-papers',
  publishedGenerationIds: Readonly<Record<string, string>> = {},
): PaperLayoutMigrationProof {
  return {
    recordId: 'layout',
    rootFolderId: 'root',
    phase,
    targetDocumentIds,
    publishedDocumentIds,
    publishedGenerationIds,
    verifiedLegacyFileIds,
  };
}

function hasRepositoryCode(expected: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expected;
}

test('single-realm Paper-v3 migration is explicit, resumable, and activates last', async (context) => {
  await context.test(
    'v2 packages are seeded, verified, and not rewritten',
    async () => {
      const fixture = await paperV2Fixture([
        ['doc-a', 'Paper A'],
        ['doc-b', 'Paper B'],
      ]);
      const packageFileIds = fixture.drive
        .byRole('paper-manifest-generation')
        .map(({ id }) => id)
        .sort();
      const preparation = await fixture.repository.prepareV3Migration([], signal);
      const control = fixture.drive.file(preparation.controlFolderId);
      assert.deepEqual(control.parents, ['root']);
      assert.equal(control.appProperties?.role, 'paper-v3-control');
      assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '2');

      const seeds: PaperV3MigrationSeed[] = [];
      for (const paper of preparation.papers) {
        seeds.push(
          await fixture.repository.seedV3MigrationPresence(
            preparation.controlFolderId,
            paper,
            { deviceId: 'device-migrator' },
            signal,
          ),
        );
      }
      assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '2');
      assert.deepEqual(
        fixture.drive
          .byRole('paper-manifest-generation')
          .map(({ id }) => id)
          .sort(),
        packageFileIds,
      );
      assert.equal(fixture.drive.byRole('paper-presence-generation').length, 2);
      assert.ok(
        fixture.drive
          .byRole('paper-presence-generation')
          .every((file) => file.appProperties?.state === 'present'),
      );

      await fixture.repository.activateV3Migration(
        preparation.controlFolderId,
        seeds,
        { deviceId: 'device-migrator' },
        signal,
      );
      assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '3');
      assert.equal(fixture.drive.byRole('paper-v3-migration-completion').length, 1);
      assert.equal(
        JSON.parse(
          await fixture.drive.peekText(
            fixture.drive.byRole('paper-v3-migration-completion')[0].id,
          ),
        ).sourceLayoutVersion,
        2,
      );
      assert.equal(
        fixture.drive.events.some((event) => event.startsWith('trash:')),
        false,
      );
      const discovered = await fixture.repository.discover([], signal);
      assert.deepEqual(
        discovered.map(({ documentId, presenceState }) => ({
          documentId,
          presenceState,
        })),
        [
          { documentId: 'doc-a', presenceState: 'present' },
          { documentId: 'doc-b', presenceState: 'present' },
        ],
      );
    },
  );

  await context.test(
    'failure before root activation leaves v2 and retries safely',
    async () => {
      const fixture = await paperV2Fixture([['doc-a', 'Paper A']]);
      const preparation = await fixture.repository.prepareV3Migration([], signal);
      const seed = await fixture.repository.seedV3MigrationPresence(
        preparation.controlFolderId,
        preparation.papers[0],
        { deviceId: 'device-migrator' },
        signal,
      );
      fixture.drive.failNextRootActivation();
      await assert.rejects(
        () =>
          fixture.repository.activateV3Migration(
            preparation.controlFolderId,
            [seed],
            { deviceId: 'device-migrator' },
            signal,
          ),
        /activation failure/iu,
      );
      assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '2');
      await fixture.repository.activateV3Migration(
        preparation.controlFolderId,
        [seed],
        { deviceId: 'device-migrator' },
        signal,
      );
      assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '3');
      assert.equal(fixture.drive.byRole('paper-presence-generation').length, 1);
    },
  );

  await context.test('a v2 head arriving after seeding aborts activation', async () => {
    const fixture = await paperV2Fixture([['doc-a', 'Paper A']]);
    const preparation = await fixture.repository.prepareV3Migration([], signal);
    const seed = await fixture.repository.seedV3MigrationPresence(
      preparation.controlFolderId,
      preparation.papers[0],
      { deviceId: 'device-migrator' },
      signal,
    );
    const current = fixture.drive.byRole('paper-manifest-generation')[0];
    const manifest = JSON.parse(
      await fixture.drive.peekText(current.id),
    ) as PaperCloudManifest;
    fixture.drive.injectManifest(
      await siblingManifest(
        manifest,
        'Changed by old build',
        manifest.generation.createdAt + 1,
      ),
    );
    await assert.rejects(
      () =>
        fixture.repository.activateV3Migration(
          preparation.controlFolderId,
          [seed],
          { deviceId: 'device-migrator' },
          signal,
        ),
      hasRepositoryCode('paper-remote-changed'),
    );
    assert.equal(fixture.drive.file('root').appProperties?.layoutVersion, '2');
  });

  await context.test(
    'a fresh root records that no prior layout was migrated',
    async () => {
      const drive = new MemoryDrive();
      await initializedRepository(drive);
      const completion = drive.byRole('paper-v3-migration-completion');
      assert.equal(completion.length, 1);
      assert.equal(
        JSON.parse(await drive.peekText(completion[0].id)).sourceLayoutVersion,
        0,
      );
    },
  );
});

test('Paper-v3 removal and restore preserve presence authority', async (context) => {
  await context.test(
    'present presence with a missing active folder remains a blocking integrity failure',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      await fixture.drive.updateMetadata(fixture.first.cloud.paperFolderId, {
        trashed: true,
      });

      const [discovered] = await fixture.repository.discover([fixture.state], signal);

      assert.equal(discovered.status, 'needs-attention');
      assert.equal(discovered.issue?.code, 'paper-presence-invalid');
    },
  );

  await context.test('malformed authoritative presence fails closed', async () => {
    const fixture = await publishedFixture('doc-a', 'Paper A');
    const presence = fixture.drive.byRole('paper-presence-generation')[0];
    fixture.drive.replaceBlob(
      presence.id,
      new Blob(['{}'], { type: 'application/json' }),
    );

    await assert.rejects(
      () => fixture.repository.discover([fixture.state], signal),
      hasRepositoryCode('paper-presence-invalid'),
    );
  });

  await context.test('failure before removed publication changes nothing', async () => {
    const fixture = await publishedFixture('doc-a', 'Paper A');
    const presenceCount = fixture.drive.byRole('paper-presence-generation').length;
    fixture.drive.failNextUploadForRole(
      'paper-presence-generation',
      new Error('Injected presence publication failure.'),
    );
    await assert.rejects(
      () =>
        fixture.repository.removePaperFromDrive(
          fixture.first.cloud,
          { deviceId: 'device-remover' },
          signal,
        ),
      /presence publication failure/iu,
    );
    assert.equal(
      fixture.drive.byRole('paper-presence-generation').length,
      presenceCount,
    );
    assert.equal(fixture.drive.file(fixture.first.cloud.paperFolderId).trashed, false);
    assert.equal(
      (await fixture.repository.discover([fixture.state], signal))[0].presenceState,
      'present',
    );
    assert.equal(
      fixture.drive.events.some((event) => event.startsWith('trash:')),
      false,
    );
  });

  await context.test('removed is published before exact-folder Trash', async () => {
    const fixture = await publishedFixture('doc-a', 'Paper A');
    const result = await fixture.repository.removePaperFromDrive(
      fixture.first.cloud,
      { deviceId: 'device-remover' },
      signal,
    );
    const removedEvent = fixture.drive.events.lastIndexOf(
      'upload:paper-presence-generation:removed',
    );
    const trashEvent = fixture.drive.events.lastIndexOf(
      `trash:${fixture.first.cloud.paperFolderId}`,
    );
    assert.ok(removedEvent >= 0 && trashEvent > removedEvent);
    assert.equal(result.cleanupPending, false);
    assert.equal(fixture.drive.file(fixture.first.cloud.paperFolderId).trashed, true);
    const discovered = await fixture.repository.discover([fixture.state], signal);
    assert.equal(discovered[0].presenceState, 'removed');
    assert.equal(discovered[0].status, 'local-only');

    const noOpOperationId = fixture.drive.beginOperationTelemetry('remove');
    await fixture.repository.removePaperFromDrive(
      discovered[0],
      { deviceId: 'device-remover' },
      signal,
    );
    const noOpTrace = fixture.drive.finishOperationTelemetry(noOpOperationId);
    assert.ok(noOpTrace);
    assert.equal(
      noOpTrace.stateTransitions.some(
        ({ transition }) => transition === 'removed-presence-published',
      ),
      false,
    );
  });

  await context.test(
    'a projected Remove upload response is recovered through discovery and explicit Restore',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      incorporate(fixture.state, fixture.first);
      const originalFolderId = fixture.first.cloud.paperFolderId;
      const eventStart = fixture.drive.events.length;

      // This reproduces the real-Drive failure mode from the former upload
      // fields projection: the immutable generation is retained with ownership,
      // but the create response does not contain the ownership evidence needed
      // for commit verification.
      const removeOperationId = fixture.drive.beginOperationTelemetry('remove');
      fixture.drive.omitNextUploadOwnershipForRole('paper-presence-generation');
      await assert.rejects(
        () =>
          fixture.repository.removePaperFromDrive(
            fixture.first.cloud,
            { deviceId: 'device-remover' },
            signal,
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'PaperV3ControlIntegrityError' &&
          /retain the exact paper-presence generation/iu.test(error.message),
      );
      const removeTrace = fixture.drive.finishOperationTelemetry(removeOperationId);
      assert.ok(removeTrace);
      assert.deepEqual(
        removeTrace.stateTransitions.map(({ transition }) => transition),
        [
          'repository-remove-started',
          'presence-resolved',
          'paper-folder-selected',
          'presence-upload-metadata-rejected',
        ],
      );
      assert.equal(
        removeTrace.stateTransitions.at(-1)?.classification,
        'upload-response-missing-ownership-evidence',
      );

      assert.equal(fixture.drive.file(originalFolderId).trashed, false);
      assert.equal(
        fixture.drive.events
          .slice(eventStart)
          .some((event) => event.startsWith('trash:')),
        false,
      );

      const [removed] = await fixture.repository.discover([fixture.state], signal);
      assert.equal(removed.presenceState, 'removed');
      assert.equal(removed.status, 'local-only');
      assert.equal(removed.cleanupPending, true);
      assert.equal(removed.issue, undefined);

      fixture.state.cloudPresence = 'removed';
      fixture.state.presenceHeadIds = [...(removed.presenceHeadIds ?? [])];
      const unchanged = await localPackage('doc-a', 'Paper A');
      unchanged.snapshot = fixture.first.snapshot;
      unchanged.sourcePdfHashVerified = true;

      const restoreOperationId = fixture.drive.beginOperationTelemetry('restore');
      const restored = await fixture.repository.restorePaper(
        unchanged,
        fixture.state,
        signal,
      );
      const restoreTrace = fixture.drive.finishOperationTelemetry(restoreOperationId);
      assert.ok(restoreTrace);

      assert.equal(restored.restoreMode, 'fast-untrash');
      assert.equal(restored.cloud.paperFolderId, originalFolderId);
      assert.equal(restored.cloud.presenceState, 'present');
      const [rediscovered] = await fixture.repository.discover([fixture.state], signal);
      assert.equal(rediscovered.presenceState, 'present');
      assert.equal(rediscovered.issue, undefined);
      assert.equal(
        restoreTrace.stateTransitions.find(
          ({ transition }) => transition === 'present-presence-published',
        )?.paperCorrelationId,
        removeTrace.stateTransitions[0]?.paperCorrelationId,
      );
      assert.equal(
        JSON.stringify({ removeTrace, restoreTrace }).includes('doc-a'),
        false,
      );
    },
  );

  await context.test(
    'a projected Restore upload response fails locally while discovery recovers present authority',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      incorporate(fixture.state, fixture.first);
      const originalFolderId = fixture.first.cloud.paperFolderId;
      const removed = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      fixture.state.cloudPresence = 'removed';
      fixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
      const unchanged = await localPackage('doc-a', 'Paper A');
      unchanged.snapshot = fixture.first.snapshot;
      unchanged.sourcePdfHashVerified = true;

      const restoreOperationId = fixture.drive.beginOperationTelemetry('restore');
      fixture.drive.omitNextUploadOwnershipForRole('paper-presence-generation');
      await assert.rejects(
        () => fixture.repository.restorePaper(unchanged, fixture.state, signal),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'PaperV3ControlIntegrityError' &&
          /retain the exact paper-presence generation/iu.test(error.message),
      );
      const restoreTrace = fixture.drive.finishOperationTelemetry(restoreOperationId);
      assert.ok(restoreTrace);
      assert.equal(
        restoreTrace.stateTransitions.at(-1)?.transition,
        'presence-upload-metadata-rejected',
      );
      assert.equal(
        restoreTrace.stateTransitions.at(-1)?.classification,
        'upload-response-missing-ownership-evidence',
      );

      assert.equal(fixture.state.cloudPresence, 'removed');
      assert.equal(fixture.drive.file(originalFolderId).trashed, false);
      assert.equal(
        fixture.drive.events.at(-1),
        'upload:paper-presence-generation:present',
      );

      const [rediscovered] = await fixture.repository.discover([fixture.state], signal);
      assert.equal(rediscovered.presenceState, 'present');
      assert.equal(rediscovered.status, 'synced');
      assert.equal(rediscovered.issue, undefined);
    },
  );

  await context.test(
    'Trash failure stays logically removed and a retry finishes cleanup',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      fixture.drive.failNextPaperTrash(new Error('Injected Trash failure.'));
      const first = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      assert.equal(first.cleanupPending, true);
      assert.equal(
        fixture.drive.file(fixture.first.cloud.paperFolderId).trashed,
        false,
      );
      const staleFolder = await fixture.repository.discover([fixture.state], signal);
      assert.equal(staleFolder[0].presenceState, 'removed');
      assert.equal(staleFolder[0].cleanupPending, true);
      assert.equal(staleFolder[0].status, 'local-only');
      assert.equal(staleFolder[0].issue, undefined);

      const retried = await fixture.repository.removePaperFromDrive(
        first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      assert.equal(retried.cleanupPending, false);
      assert.equal(fixture.drive.file(fixture.first.cloud.paperFolderId).trashed, true);
    },
  );

  await context.test(
    'fast Restore reuses and fully verifies the exact trashed package without immutable uploads',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      incorporate(fixture.state, fixture.first);
      const originalFolderId = fixture.first.cloud.paperFolderId;
      const removed = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      fixture.state.cloudPresence = 'removed';
      fixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
      const unchanged = await localPackage('doc-a', 'Paper A');
      unchanged.snapshot = fixture.first.snapshot;
      unchanged.sourcePdfHashVerified = true;
      const uploadCounts = {
        source: fixture.drive.uploadsByRole('paper-source-pdf'),
        state: fixture.drive.uploadsByRole('paper-state'),
        productivity: fixture.drive.uploadsByRole('paper-productivity'),
        conflicts: fixture.drive.uploadsByRole('paper-conflicts'),
        manifest: fixture.drive.uploadsByRole('paper-manifest-generation'),
      };
      const eventStart = fixture.drive.events.length;
      fixture.drive.resetRequestLog();

      const restored = await fixture.repository.restorePaper(
        unchanged,
        fixture.state,
        signal,
      );

      assert.equal(restored.restoreMode, 'fast-untrash');
      assert.equal(restored.cloud.paperFolderId, originalFolderId);
      assert.equal(restored.filesUploaded, 0);
      assert.equal(restored.sourcePdfUploaded, false);
      assert.equal(fixture.drive.file(originalFolderId).trashed, false);
      assert.equal(
        fixture.drive.uploadsByRole('paper-source-pdf'),
        uploadCounts.source,
      );
      assert.equal(fixture.drive.uploadsByRole('paper-state'), uploadCounts.state);
      assert.equal(
        fixture.drive.uploadsByRole('paper-productivity'),
        uploadCounts.productivity,
      );
      assert.equal(
        fixture.drive.uploadsByRole('paper-conflicts'),
        uploadCounts.conflicts,
      );
      assert.equal(
        fixture.drive.uploadsByRole('paper-manifest-generation'),
        uploadCounts.manifest,
      );
      assert.deepEqual(
        new Set(
          fixture.drive.blobReads.map(
            (fileId) => fixture.drive.file(fileId).appProperties?.role,
          ),
        ),
        new Set(['paper-state', 'paper-productivity', 'paper-conflicts']),
      );
      const restoreEvents = fixture.drive.events.slice(eventStart);
      assert.ok(restoreEvents.indexOf(`untrash:${originalFolderId}`) >= 0);
      assert.ok(
        restoreEvents.indexOf(`untrash:${originalFolderId}`) <
          restoreEvents.lastIndexOf('upload:paper-presence-generation:present'),
      );
      assert.equal(
        fixture.drive.queries
          .filter((query) => query.includes("role' and value='paper-folder"))
          .every((query) => query.includes("documentId' and value='doc-a")),
        true,
      );
    },
  );

  await context.test(
    'a conflicting local source aborts Restore and returns the original folder to Trash',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      incorporate(fixture.state, fixture.first);
      const removed = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      fixture.state.cloudPresence = 'removed';
      fixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
      const conflicting = await localPackage('doc-a', 'Paper A');
      const blob = new Blob(['%PDF-1.7\nconflicting-source'], {
        type: 'application/pdf',
      });
      const sourcePdf = {
        ...conflicting.sourcePdf!,
        size: blob.size,
        sha256: await sha256Hex(blob),
        blob,
      };
      conflicting.sourcePdf = sourcePdf;
      conflicting.sourcePdfHashVerified = true;
      conflicting.snapshot.pdfs = [withoutBlob(sourcePdf)];
      const sourceUploads = fixture.drive.uploadsByRole('paper-source-pdf');

      await assert.rejects(
        () => fixture.repository.restorePaper(conflicting, fixture.state, signal),
        PaperSourcePdfConflictError,
      );

      assert.equal(fixture.drive.file(fixture.first.cloud.paperFolderId).trashed, true);
      assert.equal(fixture.drive.uploadsByRole('paper-source-pdf'), sourceUploads);
      assert.equal(
        (await fixture.repository.discover([fixture.state], signal))[0].presenceState,
        'removed',
      );
    },
  );

  await context.test(
    'a permanently deleted original folder uses a verified fallback package',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      incorporate(fixture.state, fixture.first);
      const originalFolderId = fixture.first.cloud.paperFolderId;
      const removed = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      fixture.state.cloudPresence = 'removed';
      fixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
      fixture.drive.deletePermanently(originalFolderId);
      const local = await localPackage('doc-a', 'Paper A');

      const restored = await fixture.repository.restorePaper(
        local,
        fixture.state,
        signal,
      );

      assert.equal(restored.restoreMode, 'fallback-rebuild');
      assert.notEqual(restored.cloud.paperFolderId, originalFolderId);
      assert.equal(restored.cloud.presenceState, 'present');
      assert.equal(fixture.drive.file(restored.cloud.paperFolderId).trashed, false);
      assert.equal(
        fixture.drive.events.at(-1),
        'upload:paper-presence-generation:present',
      );
    },
  );

  await context.test(
    'a wrong trashed identity is never reused and ambiguity fails before mutation',
    async () => {
      const wrong = await publishedFixture('doc-a', 'Paper A');
      incorporate(wrong.state, wrong.first);
      await wrong.repository.removePaperFromDrive(
        wrong.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      await wrong.drive.updateMetadata(wrong.first.cloud.paperFolderId, {
        appProperties: paperProperties('paper-folder', 'doc-b'),
      });
      const rebuilt = await wrong.repository.restorePaper(
        await localPackage('doc-a', 'Paper A'),
        wrong.state,
        signal,
      );
      assert.equal(rebuilt.restoreMode, 'fallback-rebuild');
      assert.notEqual(rebuilt.cloud.paperFolderId, wrong.first.cloud.paperFolderId);
      assert.equal(wrong.drive.file(wrong.first.cloud.paperFolderId).trashed, true);
      assert.equal(
        wrong.drive.file(wrong.first.cloud.paperFolderId).appProperties?.documentId,
        'doc-b',
      );

      const ambiguous = await publishedFixture('doc-a', 'Paper A');
      await ambiguous.repository.removePaperFromDrive(
        ambiguous.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      ambiguous.drive.seed({
        id: 'conflicting-active-paper',
        name: 'Conflicting Paper A',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: true,
        parents: ['root'],
        appProperties: paperProperties('paper-folder', 'doc-a'),
      });
      const eventCount = ambiguous.drive.events.length;
      await assert.rejects(
        async () =>
          ambiguous.repository.restorePaper(
            await localPackage('doc-a', 'Paper A'),
            ambiguous.state,
            signal,
          ),
        /Multiple managed Drive folders/iu,
      );
      assert.equal(
        ambiguous.drive.file(ambiguous.first.cloud.paperFolderId).trashed,
        true,
      );
      assert.equal(
        ambiguous.drive.events
          .slice(eventCount)
          .some((event) => event.startsWith('untrash:')),
        false,
      );
    },
  );

  await context.test(
    'repeating an already completed removal is idempotent',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      const first = await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      const presenceUploads = fixture.drive.uploadsByRole('paper-presence-generation');
      const trashEvents = fixture.drive.events.filter((event) =>
        event.startsWith('trash:'),
      ).length;

      const repeated = await fixture.repository.removePaperFromDrive(
        first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );

      assert.equal(repeated.cloud.presenceState, 'removed');
      assert.equal(repeated.cleanupPending, false);
      assert.equal(
        fixture.drive.uploadsByRole('paper-presence-generation'),
        presenceUploads,
      );
      assert.equal(
        fixture.drive.events.filter((event) => event.startsWith('trash:')).length,
        trashEvents,
      );
    },
  );

  await context.test(
    'failed restore remains removed; successful restore publishes present last',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      await fixture.repository.removePaperFromDrive(
        fixture.first.cloud,
        { deviceId: 'device-remover' },
        signal,
      );
      fixture.drive.failNextUploadForRole(
        'paper-state',
        new Error('Injected upload failure.'),
      );
      const restorePackage = await localPackage('doc-a', 'Paper A', 'restored');
      await assert.rejects(
        () => fixture.repository.restorePaper(restorePackage, fixture.state, signal),
        /upload failure/iu,
      );
      assert.equal(
        (await fixture.repository.discover([fixture.state], signal))[0].presenceState,
        'removed',
      );

      const restored = await fixture.repository.restorePaper(
        restorePackage,
        fixture.state,
        signal,
      );
      assert.equal(restored.cloud.presenceState, 'present');
      assert.equal(
        fixture.drive.events.at(-1),
        'upload:paper-presence-generation:present',
      );
      assert.equal(
        (await fixture.repository.discover([fixture.state], signal))[0].presenceState,
        'present',
      );
    },
  );

  await context.test(
    'wrong, outside-root, and control targets are never trashed',
    async () => {
      const fixture = await publishedFixture('doc-a', 'Paper A');
      const control = fixture.drive.byRole('paper-v3-control')[0];
      const wrongPaper = fixture.drive.seed({
        id: 'other-paper-folder',
        name: 'Paper B',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: true,
        parents: ['root'],
        appProperties: paperProperties('paper-folder', 'doc-b'),
      });
      const outside = fixture.drive.seed({
        id: 'outside-folder',
        name: 'Paper A',
        mimeType: 'application/vnd.google-apps.folder',
        ownedByMe: true,
        parents: ['outside-root'],
        appProperties: paperProperties('paper-folder', 'doc-a'),
      });
      for (const paperFolderId of [
        wrongPaper.id,
        control.id,
        outside.id,
        'unknown-folder',
      ]) {
        await assert.rejects(
          () =>
            fixture.repository.removePaperFromDrive(
              { ...fixture.first.cloud, paperFolderId },
              { deviceId: 'device-remover' },
              signal,
            ),
          hasRepositoryCode('paper-presence-invalid'),
        );
      }
      assert.equal(
        fixture.drive.events.some((event) => event.startsWith('trash:')),
        false,
      );
    },
  );
});

test('measured request audit for optimized single-paper paths', async (context) => {
  await context.test(
    '32. Note-only upload stays within its measured ceiling',
    async () => {
      const fixture = await publishedFixture('audit-note', 'Note audit');
      incorporate(fixture.state, fixture.first);
      const changed = await localPackage('audit-note', 'Note audit', 'note-change');
      changed.sourcePdfHashVerified = true;
      changed.snapshot.entities.push(
        await entity('note', 'note-audit', 'audit-note', { text: 'changed' }, 2),
      );
      fixture.state.dirtyReasons = ['notes'];
      fixture.drive.resetRequestLog();

      const result = await fixture.repository.publishPaper(
        changed,
        fixture.state,
        signal,
        undefined,
        { layoutValidated: true },
      );

      assert.equal(result.sourcePdfUploaded, false);
      assertDriveRequestCeiling(fixture.drive, {
        metadataGets: 7,
        lists: 8,
        mediaDownloads: 7,
        mediaUploadUpdates: 2,
        controlPresenceOperations: 7,
        totalRequests: 24,
      });
      assert.equal(
        fixture.drive.blobReads.some(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ),
        false,
      );
    },
  );

  await context.test(
    '33. cloud-only download stays within its measured ceiling',
    async () => {
      const fixture = await publishedFixture('audit-cloud', 'Cloud audit');
      fixture.drive.resetRequestLog();

      const result = await fixture.repository.downloadPaper(
        fixture.first.cloud,
        signal,
      );

      assert.ok(result.sourcePdf);
      assertDriveRequestCeiling(fixture.drive, {
        metadataGets: 8,
        lists: 7,
        mediaDownloads: 6,
        mediaUploadUpdates: 0,
        controlPresenceOperations: 8,
        totalRequests: 21,
      });
      assert.equal(
        fixture.drive.blobReads.filter(
          (fileId) =>
            fixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ).length,
        1,
      );
    },
  );

  await context.test(
    '34. known remote update stays within its measured ceiling',
    async () => {
      const fixture = await publishedFixture('audit-update', 'Update audit');
      incorporate(fixture.state, fixture.first);
      const changed = await localPackage(
        'audit-update',
        'Update audit',
        'remote-change',
      );
      changed.sourcePdfHashVerified = true;
      changed.snapshot.entities.push(
        await entity('note', 'remote-note', 'audit-update', { text: 'remote' }, 2),
      );
      const remote = await fixture.repository.publishPaper(
        changed,
        fixture.state,
        signal,
        undefined,
        { layoutValidated: true },
      );
      incorporate(fixture.state, remote);
      assert.ok(changed.sourcePdf);
      fixture.state.pdfFingerprints.source = {
        size: changed.sourcePdf.size,
        lastModified: changed.sourcePdf.lastModified,
        storedAt: changed.sourcePdf.storedAt,
        sha256: changed.sourcePdf.sha256,
      };
      fixture.drive.resetRequestLog();

      const result = await fixture.repository.downloadPaper(
        remote.cloud,
        signal,
        undefined,
        fixture.state,
        true,
      );

      assert.equal(result.sourcePdf, undefined);
      assertDriveRequestCeiling(fixture.drive, {
        metadataGets: 9,
        lists: 7,
        mediaDownloads: 5,
        mediaUploadUpdates: 0,
        controlPresenceOperations: 8,
        totalRequests: 21,
      });
    },
  );

  await context.test('35. fast Restore stays within its measured ceiling', async () => {
    const fixture = await publishedFixture('audit-restore', 'Restore audit');
    incorporate(fixture.state, fixture.first);
    const removed = await fixture.repository.removePaperFromDrive(
      fixture.first.cloud,
      { deviceId: 'audit-remover' },
      signal,
    );
    fixture.state.cloudPresence = 'removed';
    fixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
    const unchanged = await localPackage('audit-restore', 'Restore audit');
    unchanged.snapshot = fixture.first.snapshot;
    unchanged.sourcePdfHashVerified = true;
    fixture.drive.resetRequestLog();

    const result = await fixture.repository.restorePaper(
      unchanged,
      fixture.state,
      signal,
    );

    assert.equal(result.restoreMode, 'fast-untrash');
    assertDriveRequestCeiling(fixture.drive, {
      metadataGets: 4,
      lists: 10,
      mediaDownloads: 6,
      mediaUploadUpdates: 2,
      controlPresenceOperations: 11,
      totalRequests: 22,
    });
    assert.deepEqual(fixture.drive.writes.map(({ role }) => role).sort(), [
      'paper-folder',
      'paper-presence-generation',
    ]);
  });

  await context.test(
    '36. new-paper upload stays within its measured ceiling',
    async () => {
      const drive = new MemoryDrive();
      const repository = await initializedRepository(drive);
      drive.resetRequestLog();

      const result = await repository.publishPaper(
        await localPackage('audit-new', 'New paper audit'),
        paperState('audit-new'),
        signal,
        undefined,
        { layoutValidated: true },
      );

      assert.equal(result.sourcePdfUploaded, true);
      assertDriveRequestCeiling(drive, {
        metadataGets: 18,
        lists: 17,
        mediaDownloads: 7,
        mediaUploadUpdates: 8,
        controlPresenceOperations: 22,
        totalRequests: 50,
      });
      assert.equal(
        drive.writes.filter(({ role }) => role === 'paper-source-pdf').length,
        1,
      );
      assert.equal(
        drive.blobReads.some(
          (fileId) => drive.file(fileId).appProperties?.role === 'paper-source-pdf',
        ),
        false,
      );
    },
  );
});

test('deterministic Drive latency model exposes dependency-depth regressions', () => {
  const nodes = [
    { id: 'root', requestCategory: 'metadata' },
    { id: 'presence', requestCategory: 'list', dependencies: ['root'] },
    { id: 'folder', requestCategory: 'metadata', dependencies: ['root'] },
    {
      id: 'state',
      requestCategory: 'download',
      dependencies: ['presence', 'folder'],
    },
    {
      id: 'productivity',
      requestCategory: 'download',
      dependencies: ['presence', 'folder'],
    },
    {
      id: 'conflicts',
      requestCategory: 'download',
      dependencies: ['presence', 'folder'],
    },
    {
      id: 'commit-guard',
      requestCategory: 'metadata',
      dependencies: ['state', 'productivity', 'conflicts'],
    },
  ] as const;

  for (const latencyMs of [50, 150, 300]) {
    const estimate = estimateDriveRequestDag(nodes, latencyMs);
    assert.equal(estimate.requestCount, 7);
    assert.equal(estimate.maximumSequentialDependencyDepth, 4);
    assert.equal(estimate.parallelWaves, 4);
    assert.equal(estimate.estimatedCriticalPathLatencyMs, latencyMs * 4);
    assert.equal(
      new Set(
        estimate.schedule
          .filter(({ id }) => ['state', 'productivity', 'conflicts'].includes(id))
          .map(({ wave }) => wave),
      ).size,
      1,
    );
  }

  const categoryEstimate = estimateDriveRequestDag(nodes, {
    metadata: 50,
    list: 150,
    download: 300,
  });
  assert.equal(categoryEstimate.estimatedCriticalPathLatencyMs, 550);

  const serializedRegression = estimateDriveRequestDag(
    Array.from({ length: 40 }, (_, index) => ({
      id: `request-${index}`,
      requestCategory: 'metadata',
      ...(index > 0 && index < 30 ? { dependencies: [`request-${index - 1}`] } : {}),
    })),
    150,
  );
  assert.equal(serializedRegression.requestCount, 40);
  assert.equal(serializedRegression.maximumSequentialDependencyDepth, 30);
  assert.throws(
    () => assertLatencyWaveCeiling(serializedRegression, 12),
    /30 sequential Drive waves exceeds the 12-wave ceiling/u,
  );
});

test('latency-injected single-paper operations keep their critical path bounded', async () => {
  const noteFixture = await publishedFixture('latency-note', 'Latency note');
  incorporate(noteFixture.state, noteFixture.first);
  const noteChanged = await localPackage('latency-note', 'Latency note', 'note-change');
  noteChanged.sourcePdfHashVerified = true;
  noteChanged.snapshot.entities.push(
    await entity('note', 'latency-note-entity', 'latency-note', { text: 'changed' }, 2),
  );
  noteFixture.state.dirtyReasons = ['notes'];
  noteFixture.drive.resetRequestLog();
  const noteScheduler = new VirtualDriveLatencyScheduler(150);
  noteFixture.drive.useVirtualLatency(noteScheduler);
  const noteOnly = await noteScheduler.run(() =>
    noteFixture.repository.publishPaper(
      noteChanged,
      noteFixture.state,
      signal,
      undefined,
      { layoutValidated: true },
    ),
  );
  assert.equal(noteOnly.result.sourcePdfUploaded, false);
  assert.equal(
    noteFixture.drive.writes.some(({ role }) => role === 'paper-source-pdf'),
    false,
  );
  assertLatencyWaveCeiling(noteOnly, 20);
  assert.deepEqual(auditDriveRequests(noteFixture.drive), {
    metadataGets: 7,
    lists: 8,
    mediaDownloads: 7,
    mediaUploadUpdates: 2,
    controlPresenceOperations: 7,
    totalRequests: 24,
  });

  const knownUpdateFixture = await publishedFixture('latency-update', 'Latency update');
  incorporate(knownUpdateFixture.state, knownUpdateFixture.first);
  const remoteChanged = await localPackage(
    'latency-update',
    'Latency update',
    'remote-change',
  );
  remoteChanged.sourcePdfHashVerified = true;
  remoteChanged.snapshot.entities.push(
    await entity(
      'note',
      'latency-remote-note',
      'latency-update',
      { text: 'remote' },
      2,
    ),
  );
  const remoteUpdate = await knownUpdateFixture.repository.publishPaper(
    remoteChanged,
    knownUpdateFixture.state,
    signal,
    undefined,
    { layoutValidated: true },
  );
  incorporate(knownUpdateFixture.state, remoteUpdate);
  assert.ok(remoteChanged.sourcePdf);
  knownUpdateFixture.state.pdfFingerprints.source = {
    size: remoteChanged.sourcePdf.size,
    lastModified: remoteChanged.sourcePdf.lastModified,
    storedAt: remoteChanged.sourcePdf.storedAt,
    sha256: remoteChanged.sourcePdf.sha256,
  };
  knownUpdateFixture.drive.resetRequestLog();
  const knownUpdateScheduler = new VirtualDriveLatencyScheduler(150);
  knownUpdateFixture.drive.useVirtualLatency(knownUpdateScheduler);
  const knownUpdate = await knownUpdateScheduler.run(() =>
    knownUpdateFixture.repository.downloadPaper(
      remoteUpdate.cloud,
      signal,
      undefined,
      knownUpdateFixture.state,
      true,
    ),
  );
  assert.equal(knownUpdate.result.sourcePdf, undefined);
  assertLatencyWaveCeiling(knownUpdate, 12);
  assert.deepEqual(auditDriveRequests(knownUpdateFixture.drive), {
    metadataGets: 9,
    lists: 7,
    mediaDownloads: 5,
    mediaUploadUpdates: 0,
    controlPresenceOperations: 8,
    totalRequests: 21,
  });

  const removeFixture = await publishedFixture('latency-remove', 'Latency remove');
  removeFixture.drive.resetRequestLog();
  const removeEventStart = removeFixture.drive.events.length;
  const removeScheduler = new VirtualDriveLatencyScheduler(150);
  removeFixture.drive.useVirtualLatency(removeScheduler);
  const remove = await removeScheduler.run(() =>
    removeFixture.repository.removePaperFromDrive(
      removeFixture.first.cloud,
      { deviceId: 'latency-remover' },
      signal,
    ),
  );
  assert.equal(remove.result.cleanupPending, false);
  assert.equal(remove.result.cloud.presenceState, 'removed');
  assert.deepEqual(auditDriveRequests(removeFixture.drive), {
    metadataGets: 3,
    lists: 7,
    mediaDownloads: 3,
    mediaUploadUpdates: 2,
    controlPresenceOperations: 11,
    totalRequests: 15,
  });
  const removeEvents = removeFixture.drive.events.slice(removeEventStart);
  assert.ok(
    removeEvents.findIndex((event) =>
      event.startsWith('upload:paper-presence-generation:removed'),
    ) < removeEvents.findIndex((event) => event.startsWith('trash:')),
  );
  assertLatencyWaveCeiling(remove, 10);

  const downloadFixture = await publishedFixture(
    'latency-download',
    'Latency download',
  );
  downloadFixture.drive.resetRequestLog();
  const downloadScheduler = new VirtualDriveLatencyScheduler(150);
  downloadFixture.drive.useVirtualLatency(downloadScheduler);
  const download = await downloadScheduler.run(() =>
    downloadFixture.repository.downloadPaper(downloadFixture.first.cloud, signal),
  );
  assert.ok(download.result.sourcePdf);
  assert.equal(
    downloadFixture.drive.blobReads.filter(
      (fileId) =>
        downloadFixture.drive.file(fileId).appProperties?.role === 'paper-source-pdf',
    ).length,
    1,
  );
  assertLatencyWaveCeiling(download, 12);
  assert.deepEqual(auditDriveRequests(downloadFixture.drive), {
    metadataGets: 8,
    lists: 7,
    mediaDownloads: 6,
    mediaUploadUpdates: 0,
    controlPresenceOperations: 8,
    totalRequests: 21,
  });
  assert.equal(
    new Set(
      downloadScheduler.records
        .filter(
          ({ label }) =>
            label === 'paper-state' ||
            label === 'paper-productivity' ||
            label === 'paper-conflicts',
        )
        .map(({ wave }) => wave),
    ).size,
    1,
  );

  const restoreFixture = await publishedFixture('latency-restore', 'Latency restore');
  incorporate(restoreFixture.state, restoreFixture.first);
  const removed = await restoreFixture.repository.removePaperFromDrive(
    restoreFixture.first.cloud,
    { deviceId: 'latency-remover' },
    signal,
  );
  restoreFixture.state.cloudPresence = 'removed';
  restoreFixture.state.presenceHeadIds = [...(removed.cloud.presenceHeadIds ?? [])];
  const unchanged = await localPackage('latency-restore', 'Latency restore');
  unchanged.snapshot = restoreFixture.first.snapshot;
  unchanged.sourcePdfHashVerified = true;
  restoreFixture.drive.resetRequestLog();
  const restoreScheduler = new VirtualDriveLatencyScheduler(150);
  restoreFixture.drive.useVirtualLatency(restoreScheduler);
  const restore = await restoreScheduler.run(() =>
    restoreFixture.repository.restorePaper(unchanged, restoreFixture.state, signal),
  );
  assert.equal(restore.result.restoreMode, 'fast-untrash');
  assert.equal(
    restore.result.cloud.paperFolderId,
    restoreFixture.first.cloud.paperFolderId,
  );
  assert.equal(
    restoreFixture.drive.writes.some(({ role }) => role === 'paper-source-pdf'),
    false,
  );
  assertLatencyWaveCeiling(restore, 20);
  assert.deepEqual(auditDriveRequests(restoreFixture.drive), {
    metadataGets: 4,
    lists: 10,
    mediaDownloads: 6,
    mediaUploadUpdates: 2,
    controlPresenceOperations: 11,
    totalRequests: 22,
  });

  const keepLocalFixture = await publishedFixture('latency-local', 'Latency local');
  incorporate(keepLocalFixture.state, keepLocalFixture.first);
  keepLocalFixture.state.cloudPresence = 'present';
  keepLocalFixture.state.status = 'remote-update-available';
  keepLocalFixture.state.incorporatedHeadIds = [];
  const local = await localPackage('latency-local', 'Latency local');
  local.snapshot = keepLocalFixture.first.snapshot;
  local.sourcePdfHashVerified = true;
  keepLocalFixture.drive.resetRequestLog();
  const keepLocalScheduler = new VirtualDriveLatencyScheduler({
    folder: 50,
    list: 150,
    metadata: 50,
    download: 300,
    upload: 300,
    update: 150,
  });
  keepLocalFixture.drive.useVirtualLatency(keepLocalScheduler);
  const keepLocal = await keepLocalScheduler.run(() =>
    keepLocalFixture.repository.reconcileKeepLocalPaper(
      local,
      keepLocalFixture.state,
      signal,
    ),
  );
  assert.equal(keepLocal.result.sourcePdfUploaded, false);
  assert.equal(
    keepLocalFixture.drive.writes.some(({ role }) => role === 'paper-source-pdf'),
    false,
  );
  assertLatencyWaveCeiling(keepLocal, 20);
  assert.deepEqual(auditDriveRequests(keepLocalFixture.drive), {
    metadataGets: 5,
    lists: 8,
    mediaDownloads: 6,
    mediaUploadUpdates: 1,
    controlPresenceOperations: 7,
    totalRequests: 20,
  });
  incorporate(keepLocalFixture.state, keepLocal.result);
  keepLocalFixture.state.dirtyReasons = [];
  assert.equal(
    derivePaperStatus(keepLocalFixture.state, keepLocal.result.cloud.headIds),
    'synced',
  );

  assert.deepEqual(
    {
      noteOnly: {
        requests: noteOnly.requestCount,
        waves: noteOnly.parallelWaves,
        latencyMs: noteOnly.estimatedCriticalPathLatencyMs,
      },
      knownUpdate: {
        requests: knownUpdate.requestCount,
        waves: knownUpdate.parallelWaves,
        latencyMs: knownUpdate.estimatedCriticalPathLatencyMs,
      },
      remove: {
        requests: remove.requestCount,
        waves: remove.parallelWaves,
        latencyMs: remove.estimatedCriticalPathLatencyMs,
      },
      download: {
        requests: download.requestCount,
        waves: download.parallelWaves,
        latencyMs: download.estimatedCriticalPathLatencyMs,
      },
      restore: {
        requests: restore.requestCount,
        waves: restore.parallelWaves,
        latencyMs: restore.estimatedCriticalPathLatencyMs,
      },
      keepLocal: {
        requests: keepLocal.requestCount,
        waves: keepLocal.parallelWaves,
        latencyMs: keepLocal.estimatedCriticalPathLatencyMs,
      },
    },
    {
      noteOnly: { requests: 24, waves: 16, latencyMs: 2_400 },
      knownUpdate: { requests: 21, waves: 7, latencyMs: 1_050 },
      remove: { requests: 15, waves: 8, latencyMs: 1_200 },
      download: { requests: 21, waves: 7, latencyMs: 1_050 },
      restore: { requests: 22, waves: 12, latencyMs: 1_800 },
      keepLocal: { requests: 20, waves: 11, latencyMs: 2_150 },
    },
  );
});

test('cloud-only download retries only the selected immutable snapshot', async (context) => {
  await context.test('a stable paper completes on its first attempt', async () => {
    const attempts: string[] = [];
    const result = await runScopedPaperDownload({
      documentId: 'doc-stable',
      initialSnapshot: 'head-a',
      download: async (head) => {
        attempts.push(head);
        return `verified:${head}`;
      },
      refresh: async () => 'head-b',
    });
    assert.equal(result, 'verified:head-a');
    assert.deepEqual(attempts, ['head-a']);
  });

  await context.test(
    'one remote head change refreshes this document and applies only attempt two',
    async () => {
      const attempts: string[] = [];
      const transientStatuses: string[] = [];
      const locallyApplied: string[] = [];
      const verified = await runScopedPaperDownload({
        documentId: 'doc-race',
        initialSnapshot: 'head-a',
        download: async (head) => {
          attempts.push(head);
          if (head === 'head-a') {
            throw new PaperRemoteChangedError('doc-race', 'manifest-head-changed');
          }
          return `complete:${head}`;
        },
        refresh: async () => 'head-b',
        onRetry: ({ reason }) => transientStatuses.push(`refreshing:${reason}`),
      });
      assert.deepEqual(locallyApplied, []);
      locallyApplied.push(verified);
      assert.deepEqual(attempts, ['head-a', 'head-b']);
      assert.deepEqual(transientStatuses, ['refreshing:manifest-head-changed']);
      assert.deepEqual(locallyApplied, ['complete:head-b']);
    },
  );

  await context.test(
    'repeated scoped churn becomes blocking attention only after the bound',
    async () => {
      let attempts = 0;
      let refreshes = 0;
      await assert.rejects(
        () =>
          runScopedPaperDownload({
            documentId: 'doc-churn',
            initialSnapshot: 'head-a',
            download: async () => {
              attempts += 1;
              throw new PaperRemoteChangedError(
                'doc-churn',
                'presence-snapshot-changed',
              );
            },
            refresh: async () => {
              refreshes += 1;
              return 'head-b';
            },
          }),
        (error: unknown) =>
          error instanceof PaperSnapshotUnstableError &&
          error.lastRemoteChangeReason === 'presence-snapshot-changed',
      );
      assert.equal(attempts, 2);
      assert.equal(refreshes, 1);
    },
  );

  await context.test(
    'a second race while refreshing is normalized to bounded blocking attention',
    async () => {
      let attempts = 0;
      let refreshes = 0;
      await assert.rejects(
        () =>
          runScopedPaperDownload({
            documentId: 'doc-refresh-race',
            initialSnapshot: 'head-a',
            download: async () => {
              attempts += 1;
              throw new PaperRemoteChangedError(
                'doc-refresh-race',
                'manifest-head-changed',
              );
            },
            refresh: async () => {
              refreshes += 1;
              throw new PaperRemoteChangedError(
                'doc-refresh-race',
                'root-control-changed',
              );
            },
          }),
        (error: unknown) =>
          error instanceof PaperSnapshotUnstableError &&
          error.lastRemoteChangeReason === 'root-control-changed',
      );
      assert.equal(attempts, 1);
      assert.equal(refreshes, 1);
    },
  );
});

type VirtualDriveRequestCategory =
  'folder' | 'list' | 'metadata' | 'download' | 'upload' | 'update';

interface VirtualDriveRequestRecord {
  category: VirtualDriveRequestCategory;
  label: string;
  wave: number;
  startMs: number;
  endMs: number;
}

class VirtualDriveLatencyScheduler {
  private readonly latencyMs:
    number | Readonly<Record<VirtualDriveRequestCategory, number>>;
  private enabled = false;
  private nowMs = 0;
  private wave = 0;
  private pending: Array<{
    category: VirtualDriveRequestCategory;
    label: string;
    resolve(): void;
  }> = [];
  readonly records: VirtualDriveRequestRecord[] = [];

  constructor(
    latencyMs: number | Readonly<Record<VirtualDriveRequestCategory, number>>,
  ) {
    this.latencyMs = latencyMs;
  }

  wait(category: VirtualDriveRequestCategory, label: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return new Promise((resolve) => this.pending.push({ category, label, resolve }));
  }

  async run<T>(task: () => Promise<T>): Promise<{
    result: T;
    requestCount: number;
    maximumSequentialDependencyDepth: number;
    parallelWaves: number;
    estimatedCriticalPathLatencyMs: number;
  }> {
    this.enabled = true;
    this.nowMs = 0;
    this.wave = 0;
    this.records.length = 0;
    let result: T | undefined;
    let failure: unknown;
    let settled = false;
    void task().then(
      (value) => {
        result = value;
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      },
    );
    for (let guard = 0; guard < 2_000 && !settled; guard += 1) {
      await Promise.resolve();
      await Promise.resolve();
      if (this.pending.length === 0) {
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
        continue;
      }
      // Let CPU-only preparation (for example Web Crypto hashing of a tiny
      // descriptor) finish before closing the virtual network wave. In Chrome
      // those independent requests are launched while the first real request is
      // still in flight, so treating every microtask as a round trip would
      // overstate dependency depth.
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      const batch = this.pending.splice(0);
      this.wave += 1;
      const startMs = this.nowMs;
      const duration = Math.max(
        ...batch.map(({ category }) =>
          typeof this.latencyMs === 'number'
            ? this.latencyMs
            : this.latencyMs[category],
        ),
      );
      this.nowMs += duration;
      for (const request of batch) {
        const requestLatency =
          typeof this.latencyMs === 'number'
            ? this.latencyMs
            : this.latencyMs[request.category];
        this.records.push({
          category: request.category,
          label: request.label,
          wave: this.wave,
          startMs,
          endMs: startMs + requestLatency,
        });
        request.resolve();
      }
    }
    this.enabled = false;
    if (!settled)
      throw new Error('The virtual Drive latency scheduler did not settle.');
    if (failure !== undefined) throw failure;
    return {
      result: result as T,
      requestCount: this.records.length,
      maximumSequentialDependencyDepth: this.wave,
      parallelWaves: this.wave,
      estimatedCriticalPathLatencyMs: this.nowMs,
    };
  }
}

function assertLatencyWaveCeiling(
  measurement: {
    maximumSequentialDependencyDepth: number;
    parallelWaves: number;
  },
  maximumWaves: number,
): void {
  assert.equal(measurement.maximumSequentialDependencyDepth, measurement.parallelWaves);
  assert.ok(
    measurement.maximumSequentialDependencyDepth <= maximumWaves,
    `${measurement.maximumSequentialDependencyDepth} sequential Drive waves exceeds the ${maximumWaves}-wave ceiling`,
  );
}

class MemoryDrive extends DriveClient {
  private readonly files = new Map<string, DriveFileMetadata>();
  private readonly blobs = new Map<string, Blob>();
  private sequence = 0;
  private revisionSequence = 0;
  readonly queries: string[] = [];
  readonly metadataReads: string[] = [];
  readonly blobReads: string[] = [];
  readonly textReads: string[] = [];
  readonly uploads: DriveFileMetadata[] = [];
  readonly writes: Array<{
    kind: 'create-folder' | 'upload' | 'update-metadata';
    fileId: string;
    role?: string;
  }> = [];
  readonly events: string[] = [];
  onManifestUpload?: (file: DriveFileMetadata) => void;
  onBlobRead?: (file: DriveFileMetadata) => void;
  private failRootActivation = false;
  private metadataFailure?: { role: string; error: unknown };
  private blobFailure?: { role: string; error: unknown };
  private textFailure?: { role: string; error: unknown };
  private paperTrashFailure: unknown;
  private uploadFailure?: { role: string; error: unknown };
  private uploadSha256OmissionRole?: string;
  private uploadOwnershipOmissionRole?: string;
  private virtualLatency?: VirtualDriveLatencyScheduler;

  constructor(options: { legacy?: boolean } = {}) {
    super(() => 'memory-token');
    this.seed({
      id: 'root',
      name: '39Note',
      mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true,
      appProperties: options.legacy
        ? { application: '39Note', role: 'root', syncSchema: '1' }
        : { application: '39Note', role: 'root' },
    });
    if (options.legacy) {
      this.seed(
        {
          id: 'legacy-manifest',
          name: 'manifest.json',
          mimeType: 'application/json',
          parents: ['root'],
          appProperties: { application: '39Note', role: 'manifest', syncSchema: '1' },
        },
        new Blob(['{}'], { type: 'application/json' }),
      );
    }
  }

  seed(metadata: DriveFileMetadata, blob = new Blob()): DriveFileMetadata {
    const revision = ++this.revisionSequence;
    const value = {
      trashed: false,
      modifiedTime: new Date(1_700_000_000_000 + revision).toISOString(),
      version: String(revision),
      md5Checksum: revision.toString(16).padStart(32, '0'),
      sha256Checksum: undefined,
      size: String(blob.size),
      ...structuredClone(metadata),
    };
    this.files.set(value.id, value);
    this.blobs.set(value.id, blob);
    return value;
  }

  file(id: string): DriveFileMetadata {
    const file = this.files.get(id);
    if (!file) throw new Error(`Missing memory Drive file ${id}`);
    return file;
  }

  async peekText(id: string): Promise<string> {
    return (await this.downloadBlobWithoutCount(id)).text();
  }

  replaceBlob(id: string, blob: Blob): void {
    const revision = ++this.revisionSequence;
    const previous = this.file(id);
    this.blobs.set(id, blob);
    this.files.set(id, {
      ...previous,
      version: String(revision),
      md5Checksum: revision.toString(16).padStart(32, '0'),
      sha256Checksum: undefined,
      size: String(blob.size),
      modifiedTime: new Date(1_700_000_000_000 + revision).toISOString(),
    });
  }

  deletePermanently(id: string): void {
    const pending = [id];
    while (pending.length > 0) {
      const next = pending.pop()!;
      for (const file of this.files.values()) {
        if (file.parents?.includes(next)) pending.push(file.id);
      }
      this.files.delete(next);
      this.blobs.delete(next);
    }
  }
  injectManifest(manifest: PaperCloudManifest): void {
    const text = stableStringify(manifest);
    this.seed(
      {
        id: `injected-${manifest.generation.id.slice(0, 12)}`,
        name: `paper-manifest-v${PAPER_SYNC_PROTOCOL_VERSION}-${manifest.generation.id}.json`,
        mimeType: 'application/json',
        parents: [manifest.dataFolderId],
        appProperties: {
          ...paperProperties('paper-manifest-generation', manifest.documentId),
          manifestStorage: PAPER_MANIFEST_STORAGE,
          generationId: manifest.generation.id,
        },
      },
      new Blob([text], { type: 'application/json' }),
    );
  }
  byRole(role: string): DriveFileMetadata[] {
    return [...this.files.values()].filter(
      (file) => !file.trashed && file.appProperties?.role === role,
    );
  }
  uploadsByRole(role: string): number {
    return this.uploads.filter((file) => file.appProperties?.role === role).length;
  }
  resetReads(): void {
    this.blobReads.length = 0;
    this.textReads.length = 0;
  }

  resetRequestLog(): void {
    this.queries.length = 0;
    this.metadataReads.length = 0;
    this.resetReads();
    this.writes.length = 0;
  }

  useVirtualLatency(scheduler: VirtualDriveLatencyScheduler): void {
    this.virtualLatency = scheduler;
  }

  failNextRootActivation(): void {
    this.failRootActivation = true;
  }

  failNextMetadataForRole(role: string, error: unknown): void {
    this.metadataFailure = { role, error };
  }

  failNextBlobForRole(role: string, error: unknown): void {
    this.blobFailure = { role, error };
  }

  failNextTextForRole(role: string, error: unknown): void {
    this.textFailure = { role, error };
  }

  failNextPaperTrash(error: unknown): void {
    this.paperTrashFailure = error;
  }

  failNextUploadForRole(role: string, error: unknown): void {
    this.uploadFailure = { role, error };
  }

  omitNextUploadSha256ForRole(role: string): void {
    this.uploadSha256OmissionRole = role;
  }

  omitNextUploadOwnershipForRole(role: string): void {
    this.uploadOwnershipOmissionRole = role;
  }

  override async listFiles(query: string): Promise<DriveFileMetadata[]> {
    await this.virtualLatency?.wait('list', query);
    this.queries.push(query);
    return [...this.files.values()]
      .filter((file) => matchesQuery(file, query))
      .map((file) => structuredClone(file));
  }

  override async getMetadata(fileId: string): Promise<DriveFileMetadata> {
    await this.virtualLatency?.wait(
      'metadata',
      this.files.get(fileId)?.appProperties?.role ?? fileId,
    );
    this.metadataReads.push(fileId);
    const file = this.files.get(fileId);
    if (!file) {
      throw new DriveRequestError(
        'The requested Google Drive item no longer exists.',
        404,
        'not-found',
        'metadata',
      );
    }
    if (this.metadataFailure?.role === file.appProperties?.role) {
      const { error } = this.metadataFailure;
      this.metadataFailure = undefined;
      throw error;
    }
    return structuredClone(file);
  }

  override async createFolder(
    name: string,
    parentId: string | null,
    appProperties: Record<string, string>,
  ): Promise<DriveFileMetadata> {
    await this.virtualLatency?.wait('folder', appProperties.role ?? name);
    const file = this.seed({
      id: this.nextId(),
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ownedByMe: true,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties,
    });
    this.uploads.push(file);
    this.writes.push({
      kind: 'create-folder',
      fileId: file.id,
      role: file.appProperties?.role,
    });
    return structuredClone(file);
  }

  override async updateMetadata(
    fileId: string,
    metadata: Record<string, unknown>,
  ): Promise<DriveFileMetadata> {
    await this.virtualLatency?.wait(
      'update',
      this.files.get(fileId)?.appProperties?.role ?? fileId,
    );
    const properties = metadata.appProperties;
    if (
      this.failRootActivation &&
      fileId === 'root' &&
      typeof properties === 'object' &&
      properties !== null &&
      'layoutVersion' in properties
    ) {
      this.failRootActivation = false;
      throw new Error('Injected activation failure.');
    }
    const previous = this.file(fileId);
    const revision = ++this.revisionSequence;
    const next = {
      ...previous,
      ...metadata,
      version: String(revision),
      modifiedTime: new Date(1_700_000_000_000 + revision).toISOString(),
    } as DriveFileMetadata;
    this.files.set(fileId, next);
    this.writes.push({
      kind: 'update-metadata',
      fileId,
      role: next.appProperties?.role,
    });
    return structuredClone(next);
  }

  override async uploadFile(
    name: string,
    content: Blob,
    metadata: { parents?: string[]; appProperties?: Record<string, string> },
    _signal: AbortSignal,
    onProgress?: (uploaded: number, total: number) => void,
  ): Promise<DriveFileMetadata> {
    const role = metadata.appProperties?.role ?? 'unknown';
    await this.virtualLatency?.wait('upload', role);
    if (this.uploadFailure?.role === role) {
      const { error } = this.uploadFailure;
      this.uploadFailure = undefined;
      throw error;
    }
    onProgress?.(content.size, content.size);
    const omitSha256 = this.uploadSha256OmissionRole === role;
    if (omitSha256) this.uploadSha256OmissionRole = undefined;
    const file = this.seed(
      {
        id: this.nextId(),
        name,
        mimeType: content.type || 'application/octet-stream',
        ownedByMe: true,
        ...metadata,
        size: String(content.size),
        sha256Checksum: omitSha256 ? undefined : await sha256Hex(content),
      },
      content,
    );
    this.uploads.push(file);
    this.writes.push({
      kind: 'upload',
      fileId: file.id,
      role: file.appProperties?.role,
    });
    this.events.push(`upload:${role}:${metadata.appProperties?.state ?? ''}`);
    if (file.appProperties?.role === 'paper-manifest-generation') {
      this.onManifestUpload?.(file);
    }
    const response = structuredClone(file);
    if (this.uploadOwnershipOmissionRole === role) {
      this.uploadOwnershipOmissionRole = undefined;
      delete response.ownedByMe;
    }
    return response;
  }

  override async trashManagedPaperFolder(fileId: string): Promise<DriveFileMetadata> {
    if (this.paperTrashFailure !== undefined) {
      const error = this.paperTrashFailure;
      this.paperTrashFailure = undefined;
      throw error;
    }
    const updated = await this.updateMetadata(fileId, { trashed: true });
    this.events.push(`trash:${fileId}`);
    return structuredClone(updated);
  }

  override async restoreManagedPaperFolder(
    fileId: string,
    rootFolderId: string,
  ): Promise<DriveFileMetadata> {
    const updated = await this.updateMetadata(fileId, {
      trashed: false,
      parents: [rootFolderId],
    });
    this.events.push(`untrash:${fileId}`);
    return structuredClone(updated);
  }

  override async downloadBlob(fileId: string): Promise<Blob> {
    await this.virtualLatency?.wait(
      'download',
      this.files.get(fileId)?.appProperties?.role ?? fileId,
    );
    this.blobReads.push(fileId);
    const file = this.file(fileId);
    this.onBlobRead?.(file);
    if (this.blobFailure?.role === file.appProperties?.role) {
      const { error } = this.blobFailure;
      this.blobFailure = undefined;
      throw error;
    }
    const blob = this.blobs.get(fileId);
    if (!blob) throw new Error(`Missing memory blob ${fileId}`);
    return blob;
  }

  override async downloadText(fileId: string): Promise<string> {
    await this.virtualLatency?.wait(
      'download',
      this.files.get(fileId)?.appProperties?.role ?? fileId,
    );
    this.textReads.push(fileId);
    if (
      this.textFailure !== undefined &&
      this.textFailure.role === this.file(fileId).appProperties?.role
    ) {
      const { error } = this.textFailure;
      this.textFailure = undefined;
      throw error;
    }
    return (await this.downloadBlobWithoutCount(fileId)).text();
  }

  private async downloadBlobWithoutCount(fileId: string): Promise<Blob> {
    const blob = this.blobs.get(fileId);
    if (!blob) throw new Error(`Missing memory blob ${fileId}`);
    return blob;
  }

  private nextId(): string {
    this.sequence += 1;
    return `drive-${this.sequence}`;
  }
}

interface DriveRequestAudit {
  metadataGets: number;
  lists: number;
  mediaDownloads: number;
  mediaUploadUpdates: number;
  controlPresenceOperations: number;
  totalRequests: number;
}

function auditDriveRequests(drive: MemoryDrive): DriveRequestAudit {
  const isControlPresenceRole = (role: string | undefined) =>
    role === 'paper-v3-control' ||
    role === 'paper-v3-layout-descriptor' ||
    role === 'paper-presence-generation' ||
    role === 'paper-v3-migration-completion';
  const roleForFile = (fileId: string) => drive.file(fileId).appProperties?.role;
  const controlQuery = (query: string) =>
    [
      'paper-v3-control',
      'paper-v3-layout-descriptor',
      'paper-presence-generation',
      'paper-v3-migration-completion',
    ].some((role) => query.includes(`value='${role}'`));
  const metadataGets = drive.metadataReads.length;
  const lists = drive.queries.length;
  const mediaDownloads = drive.blobReads.length + drive.textReads.length;
  const mediaUploadUpdates = drive.writes.length;
  const controlPresenceOperations =
    drive.queries.filter(controlQuery).length +
    drive.metadataReads.filter((fileId) => isControlPresenceRole(roleForFile(fileId)))
      .length +
    [...drive.blobReads, ...drive.textReads].filter((fileId) =>
      isControlPresenceRole(roleForFile(fileId)),
    ).length +
    drive.writes.filter(({ role }) => isControlPresenceRole(role)).length;
  return {
    metadataGets,
    lists,
    mediaDownloads,
    mediaUploadUpdates,
    controlPresenceOperations,
    totalRequests: metadataGets + lists + mediaDownloads + mediaUploadUpdates,
  };
}

function assertDriveRequestCeiling(
  drive: MemoryDrive,
  ceiling: DriveRequestAudit,
): void {
  const actual = auditDriveRequests(drive);
  for (const key of Object.keys(ceiling) as Array<keyof DriveRequestAudit>) {
    assert.ok(
      actual[key] <= ceiling[key],
      `${key} exceeded its measured ceiling: ${actual[key]} > ${ceiling[key]}`,
    );
  }
}

async function initializedRepository(
  drive: MemoryDrive,
): Promise<PaperDriveRepositoryInstance> {
  const repository = new PaperDriveRepository(drive, 'root', { now: monotonicNow() });
  await repository.initializeEmptyLayout(signal);
  return repository;
}

async function publishedFixture(documentId: string, displayName: string) {
  const drive = new MemoryDrive();
  const repository = await initializedRepository(drive);
  const state = paperState(documentId);
  const first = await repository.publishPaper(
    await localPackage(documentId, displayName),
    state,
    signal,
  );
  return { drive, repository, state, first };
}

async function paperV2Fixture(
  papers: readonly (readonly [documentId: string, displayName: string])[],
) {
  const drive = new MemoryDrive({ legacy: true });
  const repository = new PaperDriveRepository(drive, 'root', {
    now: monotonicNow(),
  });
  const inspection = await repository.detectLayout(signal);
  const documentIds = papers.map(([documentId]) => documentId);
  const publishing = await repository.openLayoutMigration(
    migrationProof(inspection.legacyManagedFileIds, documentIds),
    signal,
  );
  const generationIds: Record<string, string> = {};
  for (const [documentId, displayName] of papers) {
    const result = await publishing.publishPaper(
      await localPackage(documentId, displayName),
      paperState(documentId),
      signal,
    );
    generationIds[documentId] = result.manifest.generation.id;
  }
  const activation = await repository.openLayoutMigration(
    migrationProof(
      inspection.legacyManagedFileIds,
      documentIds,
      documentIds,
      'activating-layout',
      generationIds,
    ),
    signal,
  );
  await activation.activate(signal);
  assert.equal(
    (await repository.detectLayout(signal)).state,
    'paper-v2-upgrade-required',
  );
  return { drive, repository };
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
  marker = 'initial',
): Promise<LocalPaperPackage> {
  const document = await entity(
    'document',
    documentId,
    undefined,
    { displayTitle: displayName, marker },
    marker === 'initial' ? 1 : 2,
  );
  const pdfBlob = new Blob([`%PDF-1.7\n${documentId}`], { type: 'application/pdf' });
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
    writer: { deviceId: 'device-a', deviceLabel: 'Home PC' },
    sourcePdf,
    snapshot: snapshot('device-a', [document], [], [withoutBlob(sourcePdf)]),
  };
}

async function officeLocalPackage(
  documentId: string,
  displayName: string,
  documentType: 'pptx' | 'docx',
): Promise<LocalPaperPackage> {
  const document = await entity(
    'document',
    documentId,
    undefined,
    { displayTitle: displayName, documentType },
    1,
  );
  const mimeType =
    documentType === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const blob = new Blob([`PK\u0003\u0004${documentId}`], { type: mimeType });
  const sourceArtifact: LocalSyncSourceArtifact = {
    documentId,
    documentType,
    fileName: `${displayName}.${documentType}`,
    mimeType,
    size: blob.size,
    lastModified: 1,
    storedAt: 1,
    sha256: await sha256Hex(blob),
    blob,
  };
  return {
    documentId,
    displayName,
    deleted: false,
    writer: { deviceId: 'device-a', deviceLabel: 'Home PC' },
    sourceArtifact,
    sourceArtifactHashVerified: true,
    snapshot: snapshot('device-a', [document], [], []),
  };
}

function deletedPackage(documentId: string, state: PaperSyncState): LocalPaperPackage {
  const documentKey = createSyncEntityKey('document', documentId);
  const version = state.entityVersions[documentKey] ?? {
    updatedAt: 1,
    deviceId: 'device-a',
    hash: '0'.repeat(64),
  };
  return {
    documentId,
    displayName: state.displayName ?? 'Deleted paper',
    deleted: true,
    writer: { deviceId: 'device-a' },
    snapshot: snapshot(
      'device-a',
      [],
      [
        {
          key: documentKey,
          kind: 'document',
          id: documentId,
          deletedAt: version.updatedAt + 1,
          deviceId: 'device-a',
        },
      ],
      [],
    ),
  };
}

async function entity(
  kind: SyncEntityRecord['kind'],
  id: string,
  documentId: string | undefined,
  value: unknown,
  updatedAt: number,
): Promise<SyncEntityRecord> {
  return {
    key: createSyncEntityKey(kind, id, documentId),
    kind,
    id,
    ...(documentId ? { documentId } : {}),
    value,
    version: {
      updatedAt,
      deviceId: 'device-a',
      hash: await sha256Hex(stableStringify(value)),
    },
  };
}

function snapshot(
  generatedBy: string,
  entities: SyncEntityRecord[],
  tombstones: SyncSnapshot['tombstones'],
  pdfs: SyncSnapshot['pdfs'],
): SyncSnapshot {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 1,
    generatedBy,
    entities,
    tombstones,
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
    ...(pdf.fileId ? { fileId: pdf.fileId } : {}),
  };
}

function incorporate(
  state: PaperSyncState,
  result: Awaited<ReturnType<PaperDriveRepositoryInstance['publishPaper']>>,
): void {
  state.availability = 'local-and-cloud';
  state.incorporatedHeadIds = [result.manifest.generation.id];
  state.remoteHeadIds = [result.manifest.generation.id];
  state.entityVersions = Object.fromEntries(
    result.snapshot.entities.map((record) => [record.key, record.version]),
  );
  state.baselineHashes = Object.fromEntries(
    result.snapshot.entities.map((record) => [record.key, record.version.hash]),
  );
  state.displayName = result.displayName;
  state.driveFiles.paperFolderId = result.cloud.paperFolderId;
  state.driveFiles.dataFolderId = result.cloud.dataFolderId;
  state.driveFiles.sourcePdfFileId = result.snapshot.pdfs[0]?.fileId;
  if (result.sourcePdfDriveEvidence) {
    state.driveFiles.sourcePdfEvidence = result.sourcePdfDriveEvidence;
  }
}

async function sampleConflict(
  documentId: string,
  alternateText: string,
): Promise<SyncConflict> {
  const winningValue = { text: 'winner' };
  const alternateValue = { text: alternateText };
  return {
    id: `note:${documentId}:conflict`,
    entityKey: createSyncEntityKey('note', 'note-conflict', documentId),
    entityKind: 'note',
    documentId,
    detectedAt: 2,
    winningVersion: {
      updatedAt: 2,
      deviceId: 'device-a',
      hash: await sha256Hex(stableStringify(winningValue)),
    },
    alternateVersion: {
      updatedAt: 1,
      deviceId: 'device-b',
      hash: await sha256Hex(stableStringify(alternateValue)),
    },
    winningValue,
    alternateValue,
  };
}

async function siblingManifest(
  parent: PaperCloudManifest,
  displayName: string,
  createdAt: number,
  parents: readonly string[] = [parent.generation.id],
): Promise<PaperCloudManifest> {
  const { generation, ...base } = parent;
  assert.ok(generation.id);
  return createPaperManifestGeneration(
    {
      ...base,
      displayName,
      writer: { deviceId: 'device-b', deviceLabel: 'Other device' },
    },
    {
      createdAt,
      createdBy: 'device-b',
      parents,
    },
  );
}

function paperProperties(role: string, documentId: string): Record<string, string> {
  return {
    application: '39Note',
    syncSchema: '1',
    layoutVersion: String(PAPER_PACKAGE_LAYOUT_VERSION),
    paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
    role,
    documentId,
  };
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

function monotonicNow(): () => number {
  let now = 1_700_000_000_000;
  return () => ++now;
}
