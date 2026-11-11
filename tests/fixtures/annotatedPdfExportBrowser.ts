import { PDFDocument } from 'pdf-lib';
import {
  AnnotatedPdfExportError,
  createAnnotatedPdf,
} from '../../src/services/annotatedPdfExport.ts';
import type { AnnotatedPdfExportRequest } from '../../src/types/annotatedPdfExport.ts';
import type { PdfAnnotation } from '../../src/types/highlight.ts';
import type { Note } from '../../src/types/note.ts';

declare global {
  var __39noteAnnotatedPdfExportFixture:
    | {
        failures: string[];
        remoteMutations: number;
        unicodeAppendixPages: number | null;
        unsupportedUnicodeCode: string | null;
      }
    | undefined;
}

const fixtureState = {
  failures: [] as string[],
  remoteMutations: 0,
  unicodeAppendixPages: null as number | null,
  unsupportedUnicodeCode: null as string | null,
};
globalThis.__39noteAnnotatedPdfExportFixture = fixtureState;

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fixtureState.failures.push(message);
  finish('FAIL', message);
});

async function run(): Promise<void> {
  const sourceDocument = await PDFDocument.create();
  sourceDocument.addPage([612, 792]);
  const sourceBytes = await sourceDocument.save();

  const unicodeResult = await createAnnotatedPdf(
    createRequest(sourceBytes, '中文笔记内容'),
  );
  assertEqual(unicodeResult.appendixEntryCount, 1, 'Unicode appendix entry count');
  const unicodeDocument = await PDFDocument.load(unicodeResult.bytes);
  fixtureState.unicodeAppendixPages = unicodeDocument.getPageCount();
  assertEqual(
    fixtureState.unicodeAppendixPages,
    2,
    'Unicode appendix output page count',
  );

  let unsupportedError: unknown;
  try {
    await createAnnotatedPdf(createRequest(sourceBytes, 'Emoji is unsupported 🙂'));
  } catch (error) {
    unsupportedError = error;
  }
  assert(
    unsupportedError instanceof AnnotatedPdfExportError,
    'Unsupported emoji did not produce an annotated PDF export error',
  );
  fixtureState.unsupportedUnicodeCode = unsupportedError.code;
  assertEqual(
    unsupportedError.code,
    'unsupported-unicode',
    'Unsupported emoji failure code',
  );
  assert(
    unsupportedError.message.includes('Note [1]'),
    'Unsupported emoji error did not identify Note [1]',
  );
  assertEqual(fixtureState.remoteMutations, 0, 'Remote mutation count');

  finish(
    'PASS',
    'Chinese Notes exported with the bundled font and unsupported emoji failed closed.',
  );
}

function createRequest(
  sourceBytes: Uint8Array,
  noteContent: string,
): AnnotatedPdfExportRequest {
  const annotation: PdfAnnotation = {
    id: 'synthetic-annotation',
    type: 'highlight',
    pageNumber: 1,
    text: 'Synthetic selected text',
    rects: [{ x: 0.1, y: 0.1, width: 0.25, height: 0.03 }],
    color: 'yellow',
    createdAt: 1,
    updatedAt: 1,
  };
  const note: Note = {
    id: 'synthetic-note',
    annotationId: annotation.id,
    pageNumber: 1,
    displayNumber: '1',
    selectedText: annotation.text,
    content: noteContent,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    sourceBlob: new Blob([sourceBytes], { type: 'application/pdf' }),
    documentTitle: 'Synthetic Unicode export',
    annotations: [annotation],
    notes: [note],
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

function finish(result: 'PASS' | 'FAIL', details: string): void {
  const summary = document.querySelector<HTMLElement>('#summary');
  const detailsElement = document.querySelector<HTMLElement>('#details');
  if (summary) {
    summary.dataset.exportResult = result;
    summary.textContent = result;
  }
  if (detailsElement) detailsElement.textContent = details;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}
