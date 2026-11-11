import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import type { ViteDevServer } from 'vite';
import type { AnnotatedPdfExportRequest } from '../src/types/annotatedPdfExport.ts';

type ExportServiceModule = typeof import('../src/services/annotatedPdfExport.ts');

let server: ViteDevServer;
let exportService: ExportServiceModule;
let sourceBlob: Blob;
let appendixFontBytes: Uint8Array;

before(async () => {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([612, 792]);
  sourceBlob = new Blob([await sourceDocument.save()], { type: 'application/pdf' });
  appendixFontBytes = readFileSync(
    new URL(
      '../node_modules/@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf',
      import.meta.url,
    ),
  );

  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  exportService = (await server.ssrLoadModule(
    '/src/services/annotatedPdfExport.ts',
  )) as ExportServiceModule;
});

after(async () => server.close());

test('exports a Chinese Note appendix with the bundled Unicode font', async () => {
  const result = await exportService.createAnnotatedPdf(
    createRequest({ noteContent: '中文笔记：微生物复习。' }),
    { loadAppendixFontBytes: async () => appendixFontBytes },
  );

  const output = await PDFDocument.load(result.bytes);
  assert.equal(output.getPageCount(), 2);
  assert.equal(result.appendixEntryCount, 1);
  assert.equal(result.exportedAnnotationCount, 1);
  assert.ok(result.bytes.byteLength < appendixFontBytes.byteLength / 2);
  assert.match(await extractPdfPageText(result.bytes, 2), /中文笔记/u);
});

test('does not load the appendix font for annotations-only export', async () => {
  let fontLoadCount = 0;
  const request = createRequest({ noteContent: '中文笔记🙂' });
  request.options.contentMode = 'annotations';

  const result = await exportService.createAnnotatedPdf(request, {
    loadAppendixFontBytes: async () => {
      fontLoadCount += 1;
      throw new Error('The font loader must not run.');
    },
  });

  assert.equal(fontLoadCount, 0);
  assert.equal(result.appendixEntryCount, 0);
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
});

test('fails closed with the precise Note location for an unsupported emoji', async () => {
  await assert.rejects(
    exportService.createAnnotatedPdf(
      createRequest({ noteContent: 'Valid 中文 followed by 🙂' }),
      { loadAppendixFontBytes: async () => appendixFontBytes },
    ),
    (error: unknown) => {
      assert.ok(error instanceof exportService.AnnotatedPdfExportError);
      assert.equal(error.code, 'unsupported-unicode');
      assert.match(error.message, /Note \[1\]/u);
      return true;
    },
  );
});

test('validates selected source text only when that appendix option is enabled', async () => {
  const enabled = createRequest({
    noteContent: '中文笔记',
    selectedText: 'Source with 🙂',
  });
  await assert.rejects(
    exportService.createAnnotatedPdf(enabled, {
      loadAppendixFontBytes: async () => appendixFontBytes,
    }),
    (error: unknown) => {
      assert.ok(error instanceof exportService.AnnotatedPdfExportError);
      assert.equal(error.code, 'unsupported-unicode');
      assert.match(error.message, /selected source text \[1\]/u);
      return true;
    },
  );

  const disabled = createRequest({
    noteContent: '中文笔记',
    selectedText: 'Source with 🙂',
  });
  disabled.options.includeSelectedText = false;
  const result = await exportService.createAnnotatedPdf(disabled, {
    loadAppendixFontBytes: async () => appendixFontBytes,
  });
  assert.equal(result.appendixEntryCount, 1);
});

test('reports a sanitized failure when the bundled appendix font cannot load', async () => {
  await assert.rejects(
    exportService.createAnnotatedPdf(createRequest({ noteContent: '中文笔记' }), {
      loadAppendixFontBytes: async () => {
        throw new Error('sensitive loader detail');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof exportService.AnnotatedPdfExportError);
      assert.equal(error.code, 'generic');
      assert.match(error.message, /bundled Unicode PDF font could not be loaded/u);
      assert.doesNotMatch(error.message, /sensitive loader detail/u);
      return true;
    },
  );
});

function createRequest({
  noteContent,
  selectedText = 'Selected 中文 text',
}: {
  noteContent: string;
  selectedText?: string;
}): AnnotatedPdfExportRequest {
  return {
    sourceBlob,
    documentTitle: '中文测试论文',
    annotations: [
      {
        id: 'annotation-1',
        type: 'highlight',
        pageNumber: 1,
        text: selectedText,
        rects: [{ x: 0.1, y: 0.12, width: 0.22, height: 0.03 }],
        color: 'yellow',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    notes: [
      {
        id: 'note-1',
        annotationId: 'annotation-1',
        pageNumber: 1,
        displayNumber: '1',
        selectedText,
        content: noteContent,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    noteAnchors: [],
    pageGeometries: [
      {
        viewBox: [0, 0, 612, 792],
        userUnit: 1,
        rotation: 0,
      },
    ],
    options: {
      contentMode: 'annotations-and-notes',
      includeAnnotationColors: true,
      includeSelectedText: true,
      includeHiddenAnnotations: true,
      includeReferenceMarkers: true,
    },
  };
}

async function extractPdfPageText(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
  });
  try {
    const document = await loadingTask.promise;
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
  } finally {
    await loadingTask.destroy();
  }
}
