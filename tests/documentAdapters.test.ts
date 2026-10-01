import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import JSZip from 'jszip';
import type { ViteDevServer } from 'vite';
import {
  createSimpleDocxFixture,
  createSimplePptxFixture,
  docxSource,
  pptxSource,
} from './fixtures/ooxmlFixtures.ts';

type RegistryModule = typeof import('../src/documents/registry.ts');
type AnchorModule = typeof import('../src/documents/anchors.ts');
type LazyModule = typeof import('../src/documents/lazyWindow.ts');
type PptxModule = typeof import('../src/documents/pptx/PptxAdapter.ts');
type DocxModule = typeof import('../src/documents/docx/DocxAdapter.ts');
type SourceValidationModule =
  typeof import('../src/services/documentSourceValidation.ts');

let server: ViteDevServer;
let registry: RegistryModule;
let anchors: AnchorModule;
let lazy: LazyModule;
let pptxModule: PptxModule;
let docxModule: DocxModule;
let sourceValidation: SourceValidationModule;

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
  [registry, anchors, lazy, pptxModule, docxModule, sourceValidation] =
    await Promise.all([
      server.ssrLoadModule('/src/documents/registry.ts') as Promise<RegistryModule>,
      server.ssrLoadModule('/src/documents/anchors.ts') as Promise<AnchorModule>,
      server.ssrLoadModule('/src/documents/lazyWindow.ts') as Promise<LazyModule>,
      server.ssrLoadModule('/src/documents/pptx/PptxAdapter.ts') as Promise<PptxModule>,
      server.ssrLoadModule('/src/documents/docx/DocxAdapter.ts') as Promise<DocxModule>,
      server.ssrLoadModule(
        '/src/services/documentSourceValidation.ts',
      ) as Promise<SourceValidationModule>,
    ]);
});

after(async () => {
  await server.close();
});

test('registry selects PDF only after MIME, extension, and signature agree', async () => {
  const selected = await registry.selectDocumentAdapter({
    documentId: 'pdf-document',
    fileName: 'Paper.pdf',
    mimeType: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.7\n'),
  });
  assert.equal(selected.adapter.documentType, 'pdf');
  assert.equal(
    (await selected.adapter.open(selected.source)).renderModel.kind,
    'existing-pdfjs-pipeline',
  );

  assert.throws(
    () =>
      registry.validateDocumentSource({
        documentId: 'mismatch',
        fileName: 'Paper.pptx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: new TextEncoder().encode('%PDF-1.7\n'),
      }),
    /signature does not match/iu,
  );
});

test('PPTX is selected by MIME plus validated OOXML container and remains lazy', async () => {
  const bytes = await createSimplePptxFixture();
  const selected = await registry.selectDocumentAdapter(pptxSource(bytes));
  assert.ok(selected.adapter instanceof pptxModule.PptxAdapter);
  const document = await selected.adapter.open(selected.source);
  assert.equal(document.documentType, 'pptx');
  assert.equal(document.renderModel.slides.length, 2);
  assert.deepEqual(
    document.renderModel.slides.map((slide: { id: string }) => slide.id),
    ['300', '301'],
  );
  assert.equal(document.renderModel.slides[0].isLoaded(), false);
  assert.equal(document.renderModel.slides[1].isLoaded(), false);

  const secondSlide = await document.renderModel.slides[1].load();
  assert.equal(document.renderModel.slides[0].isLoaded(), false);
  assert.equal(document.renderModel.slides[1].isLoaded(), true);
  assert.match(secondSlide.extractedText, /Slide 2 searchable text/);
  assert.equal(
    secondSlide.shapes.some((shape: { kind: string }) => shape.kind === 'image'),
    true,
  );
  const imageShape = secondSlide.shapes.find(
    (shape: { kind: string }) => shape.kind === 'image',
  );
  assert.deepEqual(
    Array.from((await imageShape.image.load()).subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
  );
  assert.equal((await selected.adapter.search(document, 'searchable')).length, 2);
  const textUnits = await selected.adapter.extractTextUnits?.(document);
  assert.deepEqual(
    textUnits?.map((unit) => [unit.kind, unit.index]),
    [
      ['slide', 1],
      ['slide', 2],
    ],
  );
  assert.match(textUnits?.[0].text ?? '', /Slide 1 searchable text/u);
});

test('DOCX builds a reflow model with headings, lists, tables, safe images, and block search', async () => {
  const bytes = await createSimpleDocxFixture();
  const selected = await registry.selectDocumentAdapter(docxSource(bytes));
  assert.ok(selected.adapter instanceof docxModule.DocxAdapter);
  const document = await selected.adapter.open(selected.source);
  assert.equal(document.documentType, 'docx');
  assert.equal(document.renderModel.kind, 'docx-flow');
  assert.equal(document.outline[0].label, 'Research heading');
  assert.equal(document.renderModel.blocks[1].list.id, '7');
  assert.equal(document.renderModel.blocks[3].kind, 'table');
  assert.match(document.renderModel.blocks[3].text, /Table cell value/);
  assert.equal(document.renderModel.blocks[2].images.length, 1);
  assert.equal(
    (await selected.adapter.search(document, 'table cell')).length >= 1,
    true,
  );
  const textUnits = await selected.adapter.extractTextUnits?.(document);
  assert.equal(
    textUnits?.every((unit) => unit.kind === 'block'),
    true,
  );
  assert.equal(
    textUnits?.some((unit) => /Research heading/u.test(unit.text)),
    true,
  );
});

test('semantic DOCX anchors survive reflow and fail closed when resolution is ambiguous', () => {
  const anchor = anchors.createDocxTextAnchor({
    documentId: 'doc',
    blockId: 'paragraph-stable',
    blockIndex: 4,
    structuralPath: [4],
    containerText: 'Prefix selected phrase suffix',
    startOffset: 7,
    endOffset: 22,
  });
  assert.ok(anchor);
  const resolved = anchors.resolveDocxTextAnchor(anchor, [
    {
      blockId: 'paragraph-stable',
      blockIndex: 4,
      structuralPath: [4],
      text: 'Prefix selected phrase suffix',
    },
  ]);
  assert.equal(resolved.status, 'exact');
  const reflowed = anchors.resolveDocxTextAnchor(anchor, [
    {
      blockId: 'replacement-id',
      blockIndex: 8,
      structuralPath: [9],
      text: 'New preface. Prefix selected phrase suffix',
    },
  ]);
  assert.equal(reflowed.status, 'relocated');
  const ambiguous = anchors.resolveDocxTextAnchor(
    { ...anchor, prefix: '', suffix: '', startOffset: 100, endOffset: 115 },
    [
      { blockId: 'a', blockIndex: 1, structuralPath: [1], text: 'selected phrase' },
      { blockId: 'b', blockIndex: 2, structuralPath: [2], text: 'selected phrase' },
    ],
  );
  assert.equal(ambiguous.status, 'ambiguous');
});

test('external OOXML relationships are retained only as inert display links and never fetched', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (() => {
    fetchCount += 1;
    throw new Error('unexpected network access');
  }) as typeof fetch;
  try {
    const pptxBytes = await createSimplePptxFixture({ includeExternalHyperlink: true });
    const pptxSelected = await registry.selectDocumentAdapter(pptxSource(pptxBytes));
    const pptxDocument = await pptxSelected.adapter.open(pptxSelected.source);
    const slide = await pptxDocument.renderModel.slides[0].load();
    assert.equal(
      slide.shapes[0].paragraphs[0].runs[0].hyperlink,
      'https://example.test/reference',
    );

    const docxBytes = await createSimpleDocxFixture({ includeExternalHyperlink: true });
    const docxSelected = await registry.selectDocumentAdapter(docxSource(docxBytes));
    await docxSelected.adapter.open(docxSelected.source);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OOXML security rejects declarations, active content, traversing relationships, and type mismatches', async () => {
  const doctype = await createSimpleDocxFixture({
    documentXml:
      '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "unsafe">]><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>',
  });
  const doctypeSelected = await registry.selectDocumentAdapter(docxSource(doctype));
  await assert.rejects(
    () => doctypeSelected.adapter.open(doctypeSelected.source),
    /prohibited declaration/iu,
  );

  const macro = await createSimplePptxFixture({ macroEntry: true });
  const macroSelected = await registry.selectDocumentAdapter(pptxSource(macro));
  await assert.rejects(
    () => macroSelected.adapter.open(macroSelected.source),
    /active or embedded content/iu,
  );

  const traversal = await createSimplePptxFixture({
    maliciousRelationshipTarget: '../../../escape.png',
  });
  const traversalSelected = await registry.selectDocumentAdapter(pptxSource(traversal));
  const traversalDocument = await traversalSelected.adapter.open(
    traversalSelected.source,
  );
  await assert.rejects(
    () => traversalDocument.renderModel.slides[0].load(),
    /escapes the package root/iu,
  );

  const pptx = await createSimplePptxFixture();
  assert.throws(
    () =>
      registry.validateDocumentSource({
        documentId: 'wrong-office-type',
        fileName: 'Wrong.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: pptx,
      }),
    /does not match/iu,
  );
});

test('ZIP preflight rejects unsafe paths and high-ratio expansion before parser use', async () => {
  const unsafe = new JSZip();
  unsafe.file('../escape.xml', '<x/>');
  unsafe.file('[Content_Types].xml', '<Types/>');
  unsafe.file('word/document.xml', '<w:document/>');
  const unsafeBytes = await unsafe.generateAsync({ type: 'uint8array' });
  assert.throws(
    () => registry.validateDocumentSource(docxSource(unsafeBytes)),
    /unsafe|traversing/iu,
  );

  const bomb = new JSZip();
  bomb.file('[Content_Types].xml', 'A'.repeat(2 * 1024 * 1024));
  bomb.file('word/document.xml', '<w:document/>');
  const bombBytes = await bomb.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  });
  assert.throws(
    () => registry.validateDocumentSource(docxSource(bombBytes)),
    /compression ratio/iu,
  );
});

test('stored Office validation shares the strict package guard and loads JSZip lazily', async () => {
  const sourceCode = readFileSync(
    new URL('../src/services/documentSourceValidation.ts', import.meta.url),
    'utf8',
  );
  const packageCode = readFileSync(
    new URL('../src/documents/ooxml/package.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(sourceCode, /import\s+JSZip\s+from/u);
  assert.match(sourceCode, /await import\('\.\.\/documents\/ooxml\/package\.ts'\)/u);
  assert.match(packageCode, /await import\('jszip'\)/u);

  const bytes = await createSimpleDocxFixture();
  const valid = await sourceValidation.createStoredDocumentSource(
    'stored-docx',
    new File([bytes], 'Article.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }),
  );
  assert.equal(valid?.documentType, 'docx');

  const zip = await JSZip.loadAsync(bytes);
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  const mismatched = await zip.generateAsync({ type: 'uint8array' });
  assert.equal(
    await sourceValidation.createStoredDocumentSource(
      'stored-docx',
      new File([mismatched], 'Article.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ),
    null,
  );
});

test('OOXML preflight cross-checks local headers and escaped package paths', async () => {
  const valid = await createSimpleDocxFixture();
  const tamperedHeader = valid.slice();
  const localHeaderOffset = findLocalHeaderOffset(tamperedHeader, 'word/document.xml');
  const localNameLength = readUint16LittleEndian(
    tamperedHeader,
    localHeaderOffset + 26,
  );
  assert.ok(localNameLength > 0);
  tamperedHeader[localHeaderOffset + 30] ^= 1;
  assert.throws(
    () => registry.validateDocumentSource(docxSource(tamperedHeader)),
    /local filename disagrees/iu,
  );

  const unsafe = new JSZip();
  unsafe.file('[Content_Types].xml', '<Types/>');
  unsafe.file('word/document.xml', '<w:document/>');
  unsafe.file('word/%2e%2e/escape.xml', '<x/>');
  const unsafeBytes = await unsafe.generateAsync({ type: 'uint8array' });
  assert.throws(
    () => registry.validateDocumentSource(docxSource(unsafeBytes)),
    /unsafe escaped entry path/iu,
  );
});

test('OOXML rejects case-obscured active types and image pixel bombs', async () => {
  const source = await createSimpleDocxFixture();
  const activeZip = await JSZip.loadAsync(source);
  activeZip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types><Default Extension="bin" ContentType="application/vnd.ms-office.VbaProject"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  const activeBytes = await activeZip.generateAsync({ type: 'uint8array' });
  const activeSelected = await registry.selectDocumentAdapter(docxSource(activeBytes));
  await assert.rejects(
    () => activeSelected.adapter.open(activeSelected.source),
    /active or embedded content/iu,
  );

  const oversizedImage = new Uint8Array(24);
  oversizedImage.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10], 0);
  oversizedImage.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(oversizedImage.buffer).setUint32(16, 100_000);
  new DataView(oversizedImage.buffer).setUint32(20, 100_000);
  const imageBytes = await createSimpleDocxFixture({ imageBytes: oversizedImage });
  const imageSelected = await registry.selectDocumentAdapter(docxSource(imageBytes));
  const imageDocument = await imageSelected.adapter.open(imageSelected.source);
  const imageBlock = imageDocument.renderModel.blocks[2];
  assert.equal(imageBlock.kind, 'paragraph');
  if (imageBlock.kind !== 'paragraph')
    throw new Error('Expected the fixture image paragraph.');
  await assert.rejects(
    () => imageBlock.images[0].resource.load(),
    /decoded dimension limit/iu,
  );
});

test('lazy windows bound rendering work for large decks and documents', () => {
  assert.deepEqual(lazy.createLazyWindow(1_000, 500, 505), {
    start: 498,
    end: 508,
  });
  assert.deepEqual(lazy.lazyWindowIndices({ start: 2, end: 5 }), [2, 3, 4]);
  assert.equal(lazy.isInLazyWindow(5, { start: 2, end: 5 }), false);
});

test('the app shell routes Office input to conversion and keeps one PDF reader', () => {
  const appShell = readFileSync(
    new URL('../src/components/AppLayout.tsx', import.meta.url),
    'utf8',
  );
  const officeViewer = readFileSync(
    new URL('../src/components/OfficeDocumentViewer.tsx', import.meta.url),
    'utf8',
  );
  const toolbar = readFileSync(
    new URL('../src/components/Toolbar.tsx', import.meta.url),
    'utf8',
  );
  assert.match(appShell, /prepareSupportedDocumentFile\(nextFile\)/u);
  assert.match(appShell, /prepared\.documentType !== 'pdf'/u);
  assert.match(appShell, /setOfficeConversionRequest/u);
  assert.match(appShell, /activeDocumentType === 'pdf'/u);
  assert.doesNotMatch(appShell, /<OfficeDocumentViewer/u);
  assert.doesNotMatch(appShell, /import\('\.\/OfficeDocumentViewer/u);
  assert.doesNotMatch(appShell, /\.endsWith\(['"]\.(?:pdf|pptx|docx)/u);
  // The experimental renderer remains isolated compatibility code; it is not
  // reachable from the application shell.
  assert.match(officeViewer, /selectDocumentAdapter\(/u);
  assert.match(officeViewer, /adapter\.extractTextUnits/u);
  assert.match(officeViewer, /IntersectionObserver/u);
  assert.match(officeViewer, /function PptxThumbnail/u);
  assert.equal(selectedPptxCapabilities().thumbnails, true);
  assert.match(officeViewer, /saveOfficeDocumentAnnotations/u);
  assert.doesNotMatch(toolbar, /getDocumentAdapter|capabilities\?\./u);
  assert.match(toolbar, /documentType === 'pdf'/u);
  assert.match(appShell, /documentTextSource=\{null\}/u);
  assert.match(
    readFileSync(new URL('../src/ai/AssistantPanel.tsx', import.meta.url), 'utf8'),
    /documentTextSource\.loadUnits/u,
  );
});

test('isolated Office compatibility code remains non-networked and is not product-routed', () => {
  const viewer = readFileSync(
    new URL('../src/components/OfficeDocumentViewer.tsx', import.meta.url),
    'utf8',
  );
  assert.match(viewer, /adapter\.createAnchor\(opened, pendingSelection\.selection\)/u);
  assert.match(viewer, /Add an optional note/u);
  assert.match(viewer, /lookupDictionary\(/u);
  assert.match(viewer, /adapter\.resolveAnchor\(opened/u);
  assert.match(viewer, /Add to Glossary/u);
  assert.match(viewer, /Ambiguous location/u);
  assert.match(viewer, /kind === 'pptx-slide'/u);
  assert.match(viewer, /kind === 'docx-block'/u);
  assert.doesNotMatch(viewer, /fetch\(/u);
  const appShell = readFileSync(
    new URL('../src/components/AppLayout.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(appShell, /OfficeDocumentViewer/u);
});

test('Paper packages include Office semantic marks and format-native reading state', () => {
  const localPaperAdapter = readFileSync(
    new URL('../src/sync/paperLocalAdapter.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    localPaperAdapter,
    /for \(const annotation of document\.state\.officeAnnotations\)/u,
  );
  assert.match(
    localPaperAdapter,
    /document\.state\.documentReadingPosition[\s\S]*?'reading-position'/u,
  );
  assert.match(localPaperAdapter, /result\.renderedPrintPdf \?\? null/u);
});

function selectedPptxCapabilities() {
  return registry.getDocumentAdapter('pptx').capabilities;
}

function findLocalHeaderOffset(bytes: Uint8Array, expectedName: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (name === expectedName) return view.getUint32(offset + 42, true);
  }
  throw new Error(`Missing central-directory entry: ${expectedName}`);
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    offset,
    true,
  );
}
