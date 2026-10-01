import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import test, { after, before, beforeEach } from 'node:test';
import type { ViteDevServer } from 'vite';

const VIRTUAL_IDB_ID = '\0existing-pdf-library-open-idb';
const IDB_HARNESS_SYMBOL = Symbol.for('39note.test.existing-pdf-library-open-idb');

interface PersistenceHarness {
  documentStates: Map<string, Record<string, unknown>>;
  sourceFiles: Map<string, Record<string, unknown>>;
}

interface PersistenceModule {
  closeAnnotationPersistenceWorkspace(): Promise<void>;
  loadDocumentState(documentId: string): Promise<{
    annotations: Array<{ id: string }>;
    notes: Array<{ id: string; annotationId: string }>;
    glossaryEntries: Array<{
      glossaryEntryId: string;
      documentId: string;
      displayedWord: string;
    }>;
  } | null>;
  saveDocumentState(
    identity: { documentId: string; documentName: string },
    annotations: Array<Record<string, unknown>>,
    noteAnchors: Array<Record<string, unknown>>,
    notes: Array<Record<string, unknown>>,
    glossaryEntries: Array<Record<string, unknown>>,
    nextNoteNumber: number,
    displayTitle: string,
    documentType?: 'pdf',
  ): Promise<boolean>;
  listLibraryDocuments(): Promise<
    Array<{
      documentId: string;
      documentType: string;
      sourceMimeType: string | null;
      hasStoredSource: boolean;
      hasStoredPdf: boolean;
      sourceSize: number | null;
    }>
  >;
  loadStoredDocumentSource(documentId: string): Promise<{
    documentId: string;
    documentType: string;
    fileName: string;
    mimeType: string;
    sha256: string;
    size: number;
    lastModified: number;
    storedAt: number;
    blob: Blob;
  } | null>;
}

interface DocumentTypesModule {
  getDocumentTypeForMimeType(mimeType: string): string | null;
  hasDocumentFileExtension(fileName: string, documentType: string): boolean;
}

interface DocumentRegistryModule {
  selectDocumentAdapter(source: {
    documentId: string;
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{
    adapter: {
      documentType: string;
      open(validated: unknown): Promise<{
        documentType: string;
        renderModel: { kind: string; bytes: Uint8Array };
      }>;
    };
    source: unknown;
  }>;
}

interface HashModule {
  sha256Hex(value: Blob | ArrayBuffer | string): Promise<string>;
}

const harness: PersistenceHarness = {
  documentStates: new Map(),
  sourceFiles: new Map(),
};
const originalIndexedDb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const originalHarness = Object.getOwnPropertyDescriptor(globalThis, IDB_HARNESS_SYMBOL);

let server: ViteDevServer;
let persistence: PersistenceModule;
let documentTypes: DocumentTypesModule;
let registry: DocumentRegistryModule;
let hash: HashModule;

before(async () => {
  Object.defineProperty(globalThis, IDB_HARNESS_SYMBOL, {
    configurable: true,
    value: harness,
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
        name: 'existing-pdf-library-open-idb-test-double',
        enforce: 'pre',
        resolveId(id) {
          return id === 'idb' ? VIRTUAL_IDB_ID : undefined;
        },
        load(id) {
          if (id !== VIRTUAL_IDB_ID) return undefined;
          return `
            const harness = () => globalThis[Symbol.for('39note.test.existing-pdf-library-open-idb')];
            const records = (storeName) =>
              storeName === 'document-states'
                ? harness().documentStates
                : storeName === 'pdf-files'
                  ? harness().sourceFiles
                  : new Map();
            const objectStore = (storeName) => ({
              async get(key) {
                return records(storeName).get(key);
              },
              async getAll() {
                return [...records(storeName).values()];
              },
            });
            export async function openDB() {
              return {
                objectStoreNames: { contains: () => true },
                async get(storeName, key) {
                  return records(storeName).get(key);
                },
                async put(storeName, value) {
                  const key = value.documentId ?? value.id;
                  records(storeName).set(key, value);
                  return key;
                },
                transaction() {
                  return {
                    objectStore,
                    done: Promise.resolve(),
                  };
                },
                close() {},
              };
            }
            export async function deleteDB() {}
          `;
        },
      },
    ],
    ssr: { noExternal: ['idb'] },
    server: { middlewareMode: true },
  });

  [persistence, documentTypes, registry, hash] = await Promise.all([
    server.ssrLoadModule(
      '/src/services/annotationPersistence.ts',
    ) as Promise<PersistenceModule>,
    server.ssrLoadModule('/src/types/document.ts') as Promise<DocumentTypesModule>,
    server.ssrLoadModule(
      '/src/documents/registry.ts',
    ) as Promise<DocumentRegistryModule>,
    server.ssrLoadModule('/src/sync/hash.ts') as Promise<HashModule>,
  ]);
});

beforeEach(() => {
  harness.documentStates.clear();
  harness.sourceFiles.clear();
});

after(async () => {
  await persistence?.closeAnnotationPersistenceWorkspace();
  await server?.close();
  restoreGlobal('indexedDB', originalIndexedDb);
  restoreGlobal(IDB_HARNESS_SYMBOL, originalHarness);
});

test('Glossary removal persists across reload without touching marks, Notes, or another document', async () => {
  const firstIdentity = {
    documentId: 'pdfjs:glossary-persistence-a',
    documentName: 'Glossary A.pdf',
  };
  const secondIdentity = {
    documentId: 'pdfjs:glossary-persistence-b',
    documentName: 'Glossary B.pdf',
  };
  const underline = {
    id: 'underline-1',
    type: 'underline',
    pageNumber: 1,
    text: 'term',
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    color: 'blue',
    createdAt: 1,
    updatedAt: 1,
  };
  const note = {
    id: 'note-1',
    annotationId: underline.id,
    pageNumber: 1,
    displayNumber: '1',
    selectedText: 'term',
    content: 'Keep this Note',
    createdAt: 1,
    updatedAt: 1,
  };
  const entry = (documentId: string, suffix: string) => ({
    glossaryEntryId: `glossary-${suffix}`,
    documentId,
    displayedWord: 'term',
    normalizedLookupWord: 'term',
    definition: 'A bounded expression.',
    pageNumber: 1,
    sourceRects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    startOffset: 0,
    endOffset: 4,
    createdAt: 1,
    source: {
      dataset: 'Princeton WordNet',
      version: '3.1',
      license: 'Princeton WordNet License',
      sourceUrl: 'https://wordnet.princeton.edu/',
      partOfSpeech: 'noun',
    },
    markerAnnotationId: `marker-${suffix}`,
  });
  const firstEntry = entry(firstIdentity.documentId, 'a');
  const secondEntry = entry(secondIdentity.documentId, 'b');

  assert.equal(
    await persistence.saveDocumentState(
      firstIdentity,
      [underline],
      [],
      [note],
      [firstEntry],
      2,
      'Glossary A',
      'pdf',
    ),
    true,
  );
  assert.equal(
    await persistence.saveDocumentState(
      secondIdentity,
      [],
      [],
      [],
      [secondEntry],
      1,
      'Glossary B',
      'pdf',
    ),
    true,
  );
  await persistence.closeAnnotationPersistenceWorkspace();

  const afterAddReload = await persistence.loadDocumentState(firstIdentity.documentId);
  assert.deepEqual(
    afterAddReload?.glossaryEntries.map(({ glossaryEntryId }) => glossaryEntryId),
    [firstEntry.glossaryEntryId],
  );

  assert.equal(
    await persistence.saveDocumentState(
      firstIdentity,
      [underline],
      [],
      [note],
      [],
      2,
      'Glossary A',
      'pdf',
    ),
    true,
  );
  await persistence.closeAnnotationPersistenceWorkspace();

  const [afterRemovalReload, untouchedOtherDocument] = await Promise.all([
    persistence.loadDocumentState(firstIdentity.documentId),
    persistence.loadDocumentState(secondIdentity.documentId),
  ]);
  assert.deepEqual(afterRemovalReload?.glossaryEntries, []);
  assert.deepEqual(
    afterRemovalReload?.annotations.map(({ id }) => id),
    [underline.id],
  );
  assert.deepEqual(
    afterRemovalReload?.notes.map(({ id, annotationId }) => [id, annotationId]),
    [[note.id, underline.id]],
  );
  assert.deepEqual(
    untouchedOtherDocument?.glossaryEntries.map(
      ({ glossaryEntryId, displayedWord }) => [glossaryEntryId, displayedWord],
    ),
    [[secondEntry.glossaryEntryId, 'term']],
  );
});

test('schema-7 local PDF survives metadata listing, full load, and PDF routing', async () => {
  const fixture = await seedExistingPdf({
    documentId: 'pdfjs:legacy-local-pdf',
    stateSchemaVersion: 7,
    sourceShape: 'legacy-local',
  });

  await assertLibraryMetadataThenOpen(fixture);
  await assertRawRecordUnchanged(fixture);
});

test('legacy cloud-restored PDF with a verified SHA but no type still opens', async () => {
  const fixture = await seedExistingPdf({
    documentId: 'pdfjs:legacy-cloud-pdf',
    stateSchemaVersion: 7,
    sourceShape: 'legacy-cloud',
  });

  await assertLibraryMetadataThenOpen(fixture);
  await assertRawRecordUnchanged(fixture);
});

test('current typed and hashed PDF opens through the same stored-Blob path', async () => {
  const fixture = await seedExistingPdf({
    documentId: 'pdfjs:current-local-pdf',
    stateSchemaVersion: 8,
    sourceShape: 'current',
  });

  await assertLibraryMetadataThenOpen(fixture);
  await assertRawRecordUnchanged(fixture);
});

test('a mismatched historical SHA remains visible as metadata but fails the full read', async () => {
  const fixture = await seedExistingPdf({
    documentId: 'pdfjs:corrupt-cloud-pdf',
    stateSchemaVersion: 7,
    sourceShape: 'legacy-cloud',
    sha256: '0'.repeat(64),
  });
  const [listed] = await persistence.listLibraryDocuments();

  assert.equal(listed.documentId, fixture.documentId);
  assert.equal(listed.documentType, 'pdf');
  assert.equal(listed.sourceMimeType, 'application/pdf');
  assert.equal(listed.hasStoredSource, true);
  assert.equal(listed.hasStoredPdf, true);
  assert.equal(listed.sourceSize, fixture.bytes.byteLength);
  assert.equal(await persistence.loadStoredDocumentSource(fixture.documentId), null);
  await assertRawRecordUnchanged(fixture);
});

type SourceShape = 'legacy-local' | 'legacy-cloud' | 'current';

interface ExistingPdfFixture {
  documentId: string;
  bytes: Uint8Array;
  expectedSha256: string;
  state: Record<string, unknown>;
  source: Record<string, unknown> & { blob: Blob };
  initialStateKeys: string[];
  initialSourceKeys: string[];
  initialBlobBytes: Uint8Array;
}

async function seedExistingPdf(options: {
  documentId: string;
  stateSchemaVersion: 7 | 8;
  sourceShape: SourceShape;
  sha256?: string;
}): Promise<ExistingPdfFixture> {
  const bytes = createOnePagePdfBytes('Existing Library PDF');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const expectedSha256 = await hash.sha256Hex(blob);
  const state: Record<string, unknown> = {
    schemaVersion: options.stateSchemaVersion,
    documentId: options.documentId,
    documentName: 'Existing Library.pdf',
    originalFileName: 'Existing Library.pdf',
    displayTitle: 'Existing Library',
    annotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    updatedAt: 10,
    collectionIds: [],
    tagIds: [],
    isPinned: false,
    ...(options.stateSchemaVersion === 8
      ? { documentType: 'pdf', officeAnnotations: [] }
      : {}),
  };
  const source: Record<string, unknown> & { blob: Blob } = {
    documentId: options.documentId,
    fileName: 'Existing Library.pdf',
    mimeType: 'application/pdf',
    size: blob.size,
    lastModified: 11,
    blob,
    storedAt: 12,
    ...(options.sourceShape === 'legacy-cloud'
      ? { sha256: options.sha256 ?? expectedSha256 }
      : options.sourceShape === 'current'
        ? {
            documentType: 'pdf',
            sha256: options.sha256 ?? expectedSha256,
          }
        : {}),
  };
  harness.documentStates.set(options.documentId, state);
  harness.sourceFiles.set(options.documentId, source);
  return {
    documentId: options.documentId,
    bytes,
    expectedSha256,
    state,
    source,
    initialStateKeys: Object.keys(state).sort(),
    initialSourceKeys: Object.keys(source).sort(),
    initialBlobBytes: new Uint8Array(await blob.arrayBuffer()),
  };
}

async function assertLibraryMetadataThenOpen(
  fixture: ExistingPdfFixture,
): Promise<void> {
  const [listed] = await persistence.listLibraryDocuments();
  assert.equal(listed.documentId, fixture.documentId);
  assert.equal(listed.documentType, 'pdf');
  assert.equal(listed.sourceMimeType, 'application/pdf');
  assert.equal(listed.hasStoredSource, true);
  assert.equal(listed.hasStoredPdf, true);
  assert.equal(listed.sourceSize, fixture.bytes.byteLength);

  const loaded = await persistence.loadStoredDocumentSource(fixture.documentId);
  assert.ok(loaded, 'the full source read must agree with Library metadata');
  assert.equal(loaded.documentId, fixture.documentId);
  assert.equal(loaded.documentType, 'pdf');
  assert.equal(loaded.fileName, 'Existing Library.pdf');
  assert.equal(loaded.mimeType, 'application/pdf');
  assert.equal(loaded.sha256, fixture.expectedSha256);
  assert.equal(loaded.size, fixture.bytes.byteLength);
  assert.equal(loaded.blob.size, fixture.bytes.byteLength);
  assert.deepEqual(new Uint8Array(await loaded.blob.arrayBuffer()), fixture.bytes);

  const reconstructedFile = new File([loaded.blob], loaded.fileName, {
    type: loaded.mimeType,
    lastModified: loaded.lastModified,
  });
  assert.equal(reconstructedFile.size, fixture.bytes.byteLength);
  assert.equal(reconstructedFile.type, 'application/pdf');
  assert.equal(documentTypes.getDocumentTypeForMimeType(reconstructedFile.type), 'pdf');
  assert.equal(
    documentTypes.hasDocumentFileExtension(reconstructedFile.name, 'pdf'),
    true,
  );

  const reconstructedBytes = new Uint8Array(await reconstructedFile.arrayBuffer());
  assert.deepEqual(reconstructedBytes, fixture.bytes);
  const selected = await registry.selectDocumentAdapter({
    documentId: fixture.documentId,
    fileName: reconstructedFile.name,
    mimeType: reconstructedFile.type,
    bytes: reconstructedBytes,
  });
  assert.equal(selected.adapter.documentType, 'pdf');
  const opened = await selected.adapter.open(selected.source);
  assert.equal(opened.documentType, 'pdf');
  assert.equal(opened.renderModel.kind, 'existing-pdfjs-pipeline');
  assert.deepEqual(opened.renderModel.bytes, fixture.bytes);
}

async function assertRawRecordUnchanged(fixture: ExistingPdfFixture): Promise<void> {
  assert.equal(harness.documentStates.get(fixture.documentId), fixture.state);
  assert.equal(harness.sourceFiles.get(fixture.documentId), fixture.source);
  assert.deepEqual(Object.keys(fixture.state).sort(), fixture.initialStateKeys);
  assert.deepEqual(Object.keys(fixture.source).sort(), fixture.initialSourceKeys);
  assert.equal(fixture.source.blob, harness.sourceFiles.get(fixture.documentId)?.blob);
  assert.deepEqual(
    new Uint8Array(await fixture.source.blob.arrayBuffer()),
    fixture.initialBlobBytes,
  );
}

function createOnePagePdfBytes(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const content = `BT /F1 18 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(pdf).byteLength);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = encoder.encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function escapePdfText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function restoreGlobal(
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, property, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, property);
  }
}
