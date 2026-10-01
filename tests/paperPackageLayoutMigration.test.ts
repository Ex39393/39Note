import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPaperManifestGeneration,
  paperManifestSourceArtifact,
  parsePaperCloudManifest,
  parsePaperCloudManifestForSupportedLayout,
  verifyPaperManifestGeneration,
  type PaperManifestBase,
} from '../src/sync/paperCloudFormat.ts';
import { stableStringify } from '../src/sync/hash.ts';
import {
  LEGACY_PAPER_MANIFEST_STORAGE,
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_PAYLOAD_STORAGE,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
} from '../src/sync/paperTypes.ts';
import { PAPER_PRESENCE_PROTOCOL_VERSION } from '../src/sync/paperPresence.ts';

const payload = (fileId: string, digit: string) => ({
  fileId,
  sha256: digit.repeat(64),
});

function commonBase() {
  return {
    app: '39Note' as const,
    paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
    payloadStorage: PAPER_PAYLOAD_STORAGE,
    documentId: 'doc-a',
    paperFolderId: 'paper-folder-a',
    dataFolderId: 'paper-data-a',
    displayName: 'Research notes',
    deleted: false,
    writer: { deviceId: 'device-a' },
    state: payload('state-a', '1'),
    productivity: payload('productivity-a', '2'),
    conflictJournal: payload('conflicts-a', '3'),
    conflictIds: [],
  };
}

test('Paper package layout 3 uses an honestly typed source artifact', async () => {
  assert.equal(PAPER_PACKAGE_LAYOUT_VERSION, 3);
  assert.equal(SYNC_LAYOUT_VERSION, 3);
  assert.equal(PAPER_SYNC_PROTOCOL_VERSION, 2);
  assert.equal(PAPER_PRESENCE_PROTOCOL_VERSION, 1);
  const base: PaperManifestBase = {
    ...commonBase(),
    syncLayoutVersion: PAPER_PACKAGE_LAYOUT_VERSION,
    manifestStorage: PAPER_MANIFEST_STORAGE,
    sourceArtifact: {
      documentId: 'doc-a',
      documentType: 'pptx',
      fileName: 'Seminar slides.pptx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: 1234,
      lastModified: 10,
      storedAt: 11,
      sha256: '4'.repeat(64),
      fileId: 'source-a',
      driveRole: 'paper-source-document',
    },
  };
  const manifest = await createPaperManifestGeneration(base, {
    createdAt: 12,
    createdBy: 'device-a',
    parents: [],
  });
  const serialized = stableStringify(manifest);
  assert.equal(serialized.includes('sourcePdf'), false);
  assert.equal(await verifyPaperManifestGeneration(manifest), true);
  const parsed = parsePaperCloudManifest(serialized);
  assert.deepEqual(paperManifestSourceArtifact(parsed), base.sourceArtifact);
});

test('an older layout-2 reader rejects layout 3 before payload application', async () => {
  const manifest = await createPaperManifestGeneration(
    {
      ...commonBase(),
      syncLayoutVersion: PAPER_PACKAGE_LAYOUT_VERSION,
      manifestStorage: PAPER_MANIFEST_STORAGE,
    },
    { createdAt: 12, createdBy: 'device-a', parents: [] },
  );
  assert.throws(
    () =>
      parsePaperCloudManifestForSupportedLayout(
        stableStringify(manifest),
        LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
      ),
    /newer 39Note version/u,
  );
});

test('immutable layout-2 PDF manifests dual-read without rewriting bytes', async () => {
  const base: PaperManifestBase = {
    ...commonBase(),
    syncLayoutVersion: LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
    manifestStorage: LEGACY_PAPER_MANIFEST_STORAGE,
    sourcePdf: {
      documentId: 'doc-a',
      fileName: 'Research notes.pdf',
      mimeType: 'application/pdf',
      size: 321,
      lastModified: 8,
      storedAt: 9,
      sha256: '5'.repeat(64),
      fileId: 'legacy-source-a',
    },
  };
  const manifest = await createPaperManifestGeneration(base, {
    createdAt: 12,
    createdBy: 'device-a',
    parents: [],
  });
  const original = stableStringify(manifest);
  const parsed = parsePaperCloudManifest(original);
  assert.equal(stableStringify(parsed), original);
  assert.deepEqual(paperManifestSourceArtifact(parsed), {
    ...base.sourcePdf,
    documentType: 'pdf',
    mimeType: 'application/pdf',
    driveRole: 'paper-source-pdf',
  });
  assert.equal(await verifyPaperManifestGeneration(parsed), true);
});

test('layout-specific source fields and MIME/type pairs fail closed', async () => {
  const layout2WithGenericSource = {
    ...commonBase(),
    syncLayoutVersion: LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
    manifestStorage: LEGACY_PAPER_MANIFEST_STORAGE,
    sourceArtifact: {
      documentId: 'doc-a',
      documentType: 'docx',
      fileName: 'Paper.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 1,
      lastModified: 1,
      storedAt: 1,
      sha256: '6'.repeat(64),
      fileId: 'source-a',
      driveRole: 'paper-source-document',
    },
    generation: {
      id: '7'.repeat(64),
      createdAt: 1,
      createdBy: 'device-a',
      parents: [],
    },
  };
  assert.throws(
    () => parsePaperCloudManifest(stableStringify(layout2WithGenericSource)),
    /failed validation/u,
  );

  const invalidMime = {
    ...layout2WithGenericSource,
    syncLayoutVersion: PAPER_PACKAGE_LAYOUT_VERSION,
    manifestStorage: PAPER_MANIFEST_STORAGE,
    sourceArtifact: {
      ...layout2WithGenericSource.sourceArtifact,
      mimeType: 'application/pdf',
    },
  };
  assert.throws(
    () => parsePaperCloudManifest(stableStringify(invalidMime)),
    /failed validation/u,
  );
});
