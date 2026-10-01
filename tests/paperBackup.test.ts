import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import JSZip from 'jszip';
import type { ViteDevServer } from 'vite';

type BackupModule = typeof import('../src/services/libraryBackup.ts');

let server: ViteDevServer;
let backup: BackupModule;

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
  backup = (await server.ssrLoadModule(
    '/src/services/libraryBackup.ts',
  )) as BackupModule;
});

after(async () => {
  await server.close();
});

test('backup v5 counts locally available and cached cloud-only papers without content', () => {
  const coverage = backup.createBackupPaperCoverage(
    ['paper-local'],
    [
      { documentId: 'paper-local', displayName: 'Local' },
      { documentId: 'paper-cloud-b', displayName: 'Cloud B' },
      { documentId: 'paper-cloud-a', displayName: 'Cloud A' },
      { documentId: 'paper-cloud-b', displayName: 'Cloud B renamed' },
    ],
    1_725_000_000_000,
  );

  assert.deepEqual(coverage, {
    locallyAvailableCount: 1,
    cloudOnlyCount: 2,
    cloudOnlyContentIncluded: false,
    cloudCatalog: {
      status: 'cached-snapshot',
      scannedAt: 1_725_000_000_000,
    },
    cloudOnlyPapers: [
      { documentId: 'paper-cloud-a', displayName: 'Cloud A' },
      { documentId: 'paper-cloud-b', displayName: 'Cloud B renamed' },
    ],
  });
});

test('backup coverage reports unknown rather than pretending an unavailable catalog is empty', () => {
  assert.deepEqual(backup.createBackupPaperCoverage(['paper-local'], null), {
    locallyAvailableCount: 1,
    cloudOnlyCount: null,
    cloudOnlyContentIncluded: false,
    cloudCatalog: { status: 'unavailable' },
    cloudOnlyPapers: [],
  });
  assert.deepEqual(
    backup.createBackupPaperCoverage(
      ['paper-local'],
      [{ documentId: 'paper-cloud', displayName: 'Cloud' }],
      undefined,
    ),
    {
      locallyAvailableCount: 1,
      cloudOnlyCount: null,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'unavailable' },
      cloudOnlyPapers: [],
    },
  );
});

test('selected packages explicitly mark cloud coverage as not applicable', () => {
  assert.deepEqual(
    backup.createBackupPaperCoverage(
      ['paper-a', 'paper-b'],
      null,
      undefined,
      'selected',
    ),
    {
      locallyAvailableCount: 2,
      cloudOnlyCount: null,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'not-applicable' },
      cloudOnlyPapers: [],
    },
  );
});

test('every current manifest paper has an explicit productivity entry, including empty state', () => {
  const document = backup.createBackupManifestDocument('paper-local', false);
  assert.deepEqual(document, {
    documentId: 'paper-local',
    hasStoredSource: false,
    recordEntry: 'documents/paper-local.json',
    productivityEntry: 'productivity/paper-local.json',
  });
});

test('backup v5 validates truthful paper coverage and required productivity state', () => {
  const manifest = currentManifest();
  assert.deepEqual(backup.parseBackupManifest(manifest).paperCoverage, {
    locallyAvailableCount: 1,
    cloudOnlyCount: 1,
    cloudOnlyContentIncluded: false,
    cloudCatalog: { status: 'cached-snapshot', scannedAt: 42 },
    cloudOnlyPapers: [{ documentId: 'paper-cloud', displayName: 'Cloud paper' }],
  });

  const missingProductivity = structuredClone(manifest);
  delete missingProductivity.documents[0].productivityEntry;
  assert.throws(
    () => backup.parseBackupManifest(missingProductivity),
    /missing required productivity data/u,
  );

  const falseCloudCount = structuredClone(manifest);
  falseCloudCount.paperCoverage.cloudOnlyCount = 2;
  assert.throws(
    () => backup.parseBackupManifest(falseCloudCount),
    /cached cloud-paper coverage is invalid/u,
  );

  const overlappingCloudPaper = structuredClone(manifest);
  overlappingCloudPaper.paperCoverage.cloudOnlyPapers[0].documentId = 'paper-local';
  assert.throws(
    () => backup.parseBackupManifest(overlappingCloudPaper),
    /cloud-only paper metadata is invalid/u,
  );

  const claimsCloudBytes = structuredClone(manifest);
  claimsCloudBytes.paperCoverage.cloudOnlyContentIncluded = true;
  assert.throws(
    () => backup.parseBackupManifest(claimsCloudBytes),
    /paper coverage is invalid/u,
  );
});

test('backup manifest parser retains versions 1 through 4 compatibility', () => {
  for (const version of [1, 2, 3, 4]) {
    const documentId = `legacy-paper-${version}`;
    const archiveKey = encodeURIComponent(documentId);
    const document: Record<string, unknown> = {
      documentId,
      hasStoredPdf: false,
      ...(version >= 2 ? { recordEntry: `documents/${archiveKey}.json` } : {}),
      ...(version === 3
        ? { productivityEntry: `productivity/${archiveKey}.json` }
        : {}),
      ...(version === 4
        ? { productivityEntry: `productivity/${archiveKey}.json` }
        : {}),
    };
    const parsed = backup.parseBackupManifest({
      backupFormatVersion: version,
      application: '39Note',
      createdAt: 1,
      documentCount: 1,
      annotationCount: 0,
      noteCount: 0,
      documents: [document],
      backupScope: 'library',
      ...(version === 4
        ? {
            paperCoverage: {
              locallyAvailableCount: 1,
              cloudOnlyCount: 0,
              cloudOnlyContentIncluded: false,
              cloudCatalog: { status: 'cached-snapshot', scannedAt: 1 },
              cloudOnlyPapers: [],
            },
          }
        : {}),
    });
    assert.equal(parsed.backupFormatVersion, version);
    assert.equal(parsed.documents[0].documentId, documentId);
    assert.equal(
      parsed.documents[0].productivityEntry,
      version >= 3 ? `productivity/${archiveKey}.json` : undefined,
    );
    assert.equal(parsed.paperCoverage === undefined, version < 4);
    assert.equal(parsed.renderedPrintPdfCount, undefined);
    assert.equal(parsed.documents[0].renderedPrintPdf, undefined);
  }

  const legacyWithPrintPdf = {
    backupFormatVersion: 4,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: 0,
    noteCount: 0,
    documents: [
      {
        documentId: 'legacy-paper-4',
        hasStoredPdf: false,
        recordEntry: 'documents/legacy-paper-4.json',
        productivityEntry: 'productivity/legacy-paper-4.json',
        renderedPrintPdf: {},
      },
    ],
    backupScope: 'library',
    paperCoverage: {
      locallyAvailableCount: 1,
      cloudOnlyCount: 0,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'cached-snapshot', scannedAt: 1 },
      cloudOnlyPapers: [],
    },
  };
  assert.throws(
    () => backup.parseBackupManifest(legacyWithPrintPdf),
    /unsupported Print PDF metadata/u,
  );
});

test('backup v5 round-trips a saved rendered Print PDF as an independent artifact', async () => {
  const printPdf = validPrintPdfBytes('saved print output');
  const printPdfSha256 = await sha256(printPdf);
  const draftHash = 'd'.repeat(64);
  const manifest = currentManifest();
  manifest.renderedPrintPdfCount = 1;
  manifest.documents[0].renderedPrintPdf = {
    kind: 'rendered-print-pdf',
    documentId: 'paper-local',
    fileName: 'Paper - Print.pdf',
    mimeType: 'application/pdf',
    size: printPdf.byteLength,
    sha256: printPdfSha256,
    renderedFromDraftHash: draftHash,
    createdAt: 11,
    storedAt: 12,
    artifactEntry: 'rendered-print-pdfs/paper-local.pdf',
  };
  manifest.paperCoverage.cloudOnlyCount = 0;
  manifest.paperCoverage.cloudOnlyPapers = [];

  const preview = await inspectArchive(manifest, emptyDocumentState(), {
    '39note-backup/rendered-print-pdfs/paper-local.pdf': printPdf,
  });

  assert.equal(preview.manifest.renderedPrintPdfCount, 1);
  assert.equal(preview.renderedPrintPdfCount, 1);
  assert.equal(preview.documents[0].renderedPrintPdf?.documentId, 'paper-local');
  assert.equal(preview.documents[0].renderedPrintPdf?.fileName, 'Paper - Print.pdf');
  assert.equal(preview.documents[0].renderedPrintPdf?.sha256, printPdfSha256);
  assert.equal(preview.documents[0].renderedPrintPdf?.renderedFromDraftHash, draftHash);
  assert.deepEqual(
    new Uint8Array(await preview.documents[0].renderedPrintPdf!.blob.arrayBuffer()),
    printPdf,
  );
  assert.equal(preview.documents[0].source, null);
});

test('backup v5 rejects unsafe, mismatched, or tampered Print PDF artifacts', async () => {
  const printPdf = validPrintPdfBytes('authentic output');
  const printPdfSha256 = await sha256(printPdf);
  const manifest = currentManifest();
  manifest.renderedPrintPdfCount = 1;
  manifest.documents[0].renderedPrintPdf = {
    kind: 'rendered-print-pdf',
    documentId: 'paper-local',
    fileName: 'Paper - Print.pdf',
    mimeType: 'application/pdf',
    size: printPdf.byteLength,
    sha256: printPdfSha256,
    renderedFromDraftHash: 'a'.repeat(64),
    createdAt: 11,
    storedAt: 12,
    artifactEntry: 'rendered-print-pdfs/paper-local.pdf',
  };
  manifest.paperCoverage.cloudOnlyCount = 0;
  manifest.paperCoverage.cloudOnlyPapers = [];

  const unsafeEntry = structuredClone(manifest);
  unsafeEntry.documents[0].renderedPrintPdf.artifactEntry = '../paper-local.pdf';
  assert.throws(
    () => backup.parseBackupManifest(unsafeEntry),
    /unsafe Print PDF entry path/u,
  );

  const mismatchedCount = structuredClone(manifest);
  mismatchedCount.renderedPrintPdfCount = 0;
  assert.throws(
    () => backup.parseBackupManifest(mismatchedCount),
    /Print PDF counts are invalid/u,
  );

  const tamperedPrintPdf = printPdf.slice();
  tamperedPrintPdf[10] ^= 0x01;
  await assert.rejects(
    () =>
      inspectArchive(manifest, emptyDocumentState(), {
        '39note-backup/rendered-print-pdfs/paper-local.pdf': tamperedPrintPdf,
      }),
    /invalid Print PDF/u,
  );

  const invalidPdf = new TextEncoder().encode('not a PDF but same metadata');
  const invalidManifest = structuredClone(manifest);
  invalidManifest.documents[0].renderedPrintPdf.size = invalidPdf.byteLength;
  invalidManifest.documents[0].renderedPrintPdf.sha256 = await sha256(invalidPdf);
  await assert.rejects(
    () =>
      inspectArchive(invalidManifest, emptyDocumentState(), {
        '39note-backup/rendered-print-pdfs/paper-local.pdf': invalidPdf,
      }),
    /invalid Print PDF/u,
  );
});

test('a v5 archive restores explicit empty productivity instead of retaining stale data', async () => {
  const manifest = currentManifest();
  manifest.paperCoverage.cloudOnlyCount = 0;
  manifest.paperCoverage.cloudOnlyPapers = [];
  const zip = new JSZip();
  zip.file('39note-backup/manifest.json', JSON.stringify(manifest));
  zip.file('39note-backup/collections.json', '[]');
  zip.file('39note-backup/tags.json', '[]');
  zip.file(
    '39note-backup/documents/paper-local.json',
    JSON.stringify(emptyDocumentState()),
  );
  zip.file(
    '39note-backup/productivity/paper-local.json',
    JSON.stringify({
      documentId: 'paper-local',
      printDraft: null,
      aiConversations: [],
    }),
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    const preview = await backup.inspectBackup(bytes as unknown as File);
    assert.deepEqual(preview.productivity, [
      {
        documentId: 'paper-local',
        printDraft: null,
        aiConversations: [],
      },
    ]);
  } finally {
    console.error = previousConsoleError;
  }
});

test('backup v5 preserves a validated DOCX source, semantic marks, and reading state', async () => {
  const sourceBytes = await simpleDocxBytes();
  const sourceSha256 = await sha256(sourceBytes);
  const state = officeDocumentState();
  const manifest = currentManifest();
  manifest.documents[0] = {
    documentId: 'paper-local',
    hasStoredSource: true,
    recordEntry: 'documents/paper-local.json',
    sourceArtifact: {
      documentId: 'paper-local',
      documentType: 'docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFileName: 'Paper.docx',
      sha256: sourceSha256,
      size: sourceBytes.byteLength,
      sourceEntry: 'sources/paper-local.docx',
    },
    productivityEntry: 'productivity/paper-local.json',
  };
  manifest.paperCoverage.cloudOnlyCount = 0;
  manifest.paperCoverage.cloudOnlyPapers = [];

  const preview = await inspectArchive(manifest, state, {
    '39note-backup/sources/paper-local.docx': sourceBytes,
  });
  assert.equal(preview.sourceCount, 1);
  assert.equal(preview.pdfCount, 0);
  assert.equal(preview.documents[0].source?.documentType, 'docx');
  assert.equal(
    preview.documents[0].source?.mimeType,
    manifest.documents[0].sourceArtifact.mimeType,
  );
  assert.equal(preview.documents[0].source?.sha256, sourceSha256);
  assert.deepEqual(
    preview.documents[0].state.officeAnnotations,
    state.officeAnnotations,
  );
  assert.deepEqual(
    preview.documents[0].state.documentReadingPosition,
    state.documentReadingPosition,
  );
});

test('backup v5 fails closed on MIME, signature, hash, or state type mismatch', async () => {
  const sourceBytes = await simpleDocxBytes();
  const sourceSha256 = await sha256(sourceBytes);
  const manifest = currentManifest();
  manifest.documents[0] = {
    documentId: 'paper-local',
    hasStoredSource: true,
    recordEntry: 'documents/paper-local.json',
    sourceArtifact: {
      documentId: 'paper-local',
      documentType: 'docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalFileName: 'Paper.docx',
      sha256: sourceSha256,
      size: sourceBytes.byteLength,
      sourceEntry: 'sources/paper-local.docx',
    },
    productivityEntry: 'productivity/paper-local.json',
  };
  manifest.paperCoverage.cloudOnlyCount = 0;
  manifest.paperCoverage.cloudOnlyPapers = [];

  const mimeMismatch = structuredClone(manifest);
  mimeMismatch.documents[0].sourceArtifact.mimeType = 'application/pdf';
  assert.throws(
    () => backup.parseBackupManifest(mimeMismatch),
    /invalid source metadata/u,
  );

  const wrongStateType = { ...officeDocumentState(), documentType: 'pptx' };
  await assert.rejects(
    () =>
      inspectArchive(manifest, wrongStateType, {
        '39note-backup/sources/paper-local.docx': sourceBytes,
      }),
    /invalid record|does not match its document record/u,
  );

  const tampered = sourceBytes.slice();
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(
    () =>
      inspectArchive(manifest, officeDocumentState(), {
        '39note-backup/sources/paper-local.docx': tampered,
      }),
    /invalid content or integrity metadata/u,
  );
});

test('a legacy v4 PDF backup maps to the generic PDF source in memory', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\nlegacy');
  const manifest = {
    backupFormatVersion: 4,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: 0,
    noteCount: 0,
    documents: [
      {
        documentId: 'paper-local',
        hasStoredPdf: true,
        recordEntry: 'documents/paper-local.json',
        pdfEntry: 'pdfs/paper-local.pdf',
        productivityEntry: 'productivity/paper-local.json',
      },
    ],
    backupScope: 'library',
    paperCoverage: {
      locallyAvailableCount: 1,
      cloudOnlyCount: 0,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'cached-snapshot', scannedAt: 1 },
      cloudOnlyPapers: [],
    },
  };
  const legacyState = {
    ...emptyDocumentState(),
    schemaVersion: 7,
  };
  delete (legacyState as { documentType?: string }).documentType;
  delete (legacyState as { officeAnnotations?: unknown[] }).officeAnnotations;
  const preview = await inspectArchive(manifest, legacyState, {
    '39note-backup/pdfs/paper-local.pdf': pdf,
  });
  assert.equal(preview.documents[0].state.documentType, 'pdf');
  assert.equal(preview.documents[0].source?.documentType, 'pdf');
  assert.equal(preview.documents[0].source?.mimeType, 'application/pdf');
  assert.equal(preview.documents[0].source?.sha256, await sha256(pdf));
  assert.equal(preview.pdfCount, 1);
  assert.equal(preview.documents[0].renderedPrintPdf, null);
  assert.equal(preview.renderedPrintPdfCount, 0);
});

test('schema-8 source validation defaults only verified legacy PDF records to PDF', async () => {
  const validation = (await server.ssrLoadModule(
    '/src/services/documentSourceValidation.ts',
  )) as typeof import('../src/services/documentSourceValidation.ts');
  const blob = new Blob(['%PDF-1.7\nlegacy'], { type: 'application/pdf' });
  const legacy = await validation.validateStoredDocumentSource(
    {
      documentId: 'paper-local',
      fileName: 'Paper.PDF',
      mimeType: 'application/pdf',
      size: blob.size,
      lastModified: 1,
      blob,
      storedAt: 1,
    },
    'paper-local',
    { allowLegacyPdf: true },
  );
  assert.equal(legacy?.documentType, 'pdf');
  assert.match(legacy?.sha256 ?? '', /^[a-f0-9]{64}$/u);

  const disguisedOffice = await validation.validateStoredDocumentSource(
    {
      ...legacy,
      documentType: 'docx',
      fileName: 'Paper.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    'paper-local',
  );
  assert.equal(disguisedOffice, null);
});

test('current backup path uses strict productivity reads and never fetches cloud bytes', async () => {
  const source = readFileSync(
    new URL('../src/services/libraryBackup.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /getProductivityBackupDataStrict\(/u);
  assert.doesNotMatch(source, /getProductivityBackupData\(/u);
  assert.match(source, /loadCloudPaperCatalog\(\)/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /downloadSelected\(|downloadPaper\(|DriveClient/u);

  const productivity = (await server.ssrLoadModule(
    '/src/services/productivityPersistence.ts',
  )) as typeof import('../src/services/productivityPersistence.ts');
  await assert.rejects(() => productivity.getProductivityBackupDataStrict(['paper']));
});

function currentManifest() {
  return {
    backupFormatVersion: 5,
    application: '39Note',
    createdAt: 1,
    documentCount: 1,
    annotationCount: 0,
    noteCount: 0,
    documents: [
      {
        documentId: 'paper-local',
        hasStoredSource: false,
        recordEntry: 'documents/paper-local.json',
        productivityEntry: 'productivity/paper-local.json',
      },
    ],
    backupScope: 'library',
    paperCoverage: {
      locallyAvailableCount: 1,
      cloudOnlyCount: 1,
      cloudOnlyContentIncluded: false,
      cloudCatalog: { status: 'cached-snapshot', scannedAt: 42 },
      cloudOnlyPapers: [{ documentId: 'paper-cloud', displayName: 'Cloud paper' }],
    },
  };
}

function validPrintPdfBytes(content: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n${content}\n%%EOF\n`);
}

function emptyDocumentState() {
  return {
    schemaVersion: 8,
    documentType: 'pdf',
    documentId: 'paper-local',
    documentName: 'Paper.pdf',
    originalFileName: 'Paper.pdf',
    displayTitle: 'Paper',
    annotations: [],
    officeAnnotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    updatedAt: 1,
    collectionIds: [],
    tagIds: [],
    isPinned: false,
  };
}

function officeDocumentState() {
  return {
    ...emptyDocumentState(),
    documentType: 'docx',
    documentName: 'Paper.docx',
    originalFileName: 'Paper.docx',
    officeAnnotations: [
      {
        version: 1,
        id: 'mark-1',
        documentId: 'paper-local',
        markType: 'highlight',
        color: 'yellow',
        anchor: {
          version: 1,
          kind: 'docx-text',
          documentId: 'paper-local',
          blockId: 'paragraph-1',
          blockIndex: 0,
          structuralPath: [0],
          quote: 'Paper',
          prefix: '',
          suffix: ' text',
          startOffset: 0,
          endOffset: 5,
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    documentReadingPosition: {
      kind: 'docx-position',
      blockIndex: 0,
      blockId: 'paragraph-1',
      blockOffsetRatio: 0.25,
    },
  };
}

async function simpleDocxBytes(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Paper text</w:t></w:r></w:p></w:body></w:document>',
  );
  return zip.generateAsync({ type: 'uint8array' });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copied = new Uint8Array(bytes).buffer;
  const digest = await crypto.subtle.digest('SHA-256', copied);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function inspectArchive(
  manifest: unknown,
  state: unknown,
  sourceEntries: Record<string, Uint8Array>,
) {
  const zip = new JSZip();
  zip.file('39note-backup/manifest.json', JSON.stringify(manifest));
  zip.file('39note-backup/collections.json', '[]');
  zip.file('39note-backup/tags.json', '[]');
  zip.file('39note-backup/documents/paper-local.json', JSON.stringify(state));
  zip.file(
    '39note-backup/productivity/paper-local.json',
    JSON.stringify({
      documentId: 'paper-local',
      printDraft: null,
      aiConversations: [],
    }),
  );
  for (const [name, bytes] of Object.entries(sourceEntries)) zip.file(name, bytes);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    return await backup.inspectBackup(bytes as unknown as File);
  } finally {
    console.error = previousConsoleError;
  }
}
