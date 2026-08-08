import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationFilterState } from '../src/components/pdf/AnnotationFilterControl.tsx';
import type { PdfAnnotation } from '../src/types/highlight.ts';
import type { Note } from '../src/types/note.ts';
import { matchesAnnotationFilter } from '../src/utils/annotationFilter.ts';
import {
  buildAnnotationExportReferences,
  findUnsupportedAppendixCharacters,
  normalizedRectangleToPdfRectangle,
  normalizedRectangleToPdfUnderline,
  normalizedRectanglesToPdfRectangles,
  paginateAppendixItems,
  sanitizeAnnotatedPdfFilename,
  sortAnnotationsForExport,
  wrapAppendixText,
} from '../src/utils/annotatedPdfExportModel.ts';

const geometry = {
  viewBox: [10, 20, 210, 320] as [number, number, number, number],
  userUnit: 1,
  rotation: 0 as const,
};
const rectangle = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

function annotation(
  id: string,
  pageNumber: number,
  x: number,
  y: number,
  overrides: Partial<PdfAnnotation> = {},
): PdfAnnotation {
  return {
    id,
    type: 'highlight',
    pageNumber,
    text: `text-${id}`,
    rects: [{ x, y, width: 0.1, height: 0.04 }],
    color: 'yellow',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as PdfAnnotation;
}

function note(id: string, annotationId: string, content: string): Note {
  return {
    id,
    annotationId,
    pageNumber: 1,
    displayNumber: id,
    selectedText: '',
    content,
    createdAt: 1,
    updatedAt: 1,
  };
}

function assertRectangleClose(
  actual: ReturnType<typeof normalizedRectangleToPdfRectangle>,
  expected: ReturnType<typeof normalizedRectangleToPdfRectangle>,
): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
  assert.ok(Math.abs(actual.width - expected.width) < 1e-9);
  assert.ok(Math.abs(actual.height - expected.height) < 1e-9);
}

test('converts normalized top-left rectangles to PDF bottom-left coordinates with CropBox offsets', () => {
  assertRectangleClose(normalizedRectangleToPdfRectangle(rectangle, geometry), {
    x: 30,
    y: 230,
    width: 60,
    height: 30,
  });
});

test('coordinate conversion is independent of browser zoom', () => {
  const baseline = normalizedRectangleToPdfRectangle(rectangle, geometry, 1);
  for (const scale of [0.5, 2, 3.75]) {
    assertRectangleClose(
      normalizedRectangleToPdfRectangle(rectangle, geometry, scale),
      baseline,
    );
  }
});

test('handles all four PDF page rotations', () => {
  const expected = new Map([
    [0, { x: 30, y: 230, width: 60, height: 30 }],
    [90, { x: 50, y: 50, width: 20, height: 90 }],
    [180, { x: 130, y: 80, width: 60, height: 30 }],
    [270, { x: 150, y: 200, width: 20, height: 90 }],
  ]);

  for (const rotation of [0, 90, 180, 270] as const) {
    assertRectangleClose(
      normalizedRectangleToPdfRectangle(rectangle, {
        ...geometry,
        rotation,
      }),
      expected.get(rotation)!,
    );
  }
});

test('UserUnit and display scale do not change stored page-space geometry', () => {
  const baseline = normalizedRectangleToPdfRectangle(rectangle, geometry);
  assertRectangleClose(
    normalizedRectangleToPdfRectangle(rectangle, { ...geometry, userUnit: 2 }, 2),
    baseline,
  );
});

test('preserves every multiline rectangle as an independent PDF rectangle', () => {
  const lines = [
    rectangle,
    { x: 0.1, y: 0.31, width: 0.45, height: 0.1 },
    { x: 0.1, y: 0.42, width: 0.2, height: 0.1 },
  ];
  const converted = normalizedRectanglesToPdfRectangles(lines, geometry);
  assert.equal(converted.length, lines.length);
  assert.notDeepEqual(converted[0], converted[1]);
  assert.notDeepEqual(converted[1], converted[2]);
});

test('underline uses a fixed physical thickness below each text segment', () => {
  const line = normalizedRectangleToPdfUnderline(rectangle, geometry);
  assert.equal(line.thickness, 1.25);
  assert.deepEqual(line.start, { x: 30, y: 228.25 });
  assert.deepEqual(line.end, { x: 90, y: 228.25 });
  assert.equal(
    normalizedRectangleToPdfUnderline(rectangle, { ...geometry, userUnit: 2 })
      .thickness,
    0.625,
  );
});

test('sorts appendix entries by page, vertical position, horizontal position, then id', () => {
  const annotations = [
    annotation('d', 2, 0.1, 0.1),
    annotation('c', 1, 0.3, 0.2),
    annotation('b', 1, 0.2, 0.2),
    annotation('a', 1, 0.2, 0.2),
    annotation('e', 1, 0.8, 0.1),
  ];
  assert.deepEqual(
    sortAnnotationsForExport(annotations).map(({ id }) => id),
    ['e', 'a', 'b', 'c', 'd'],
  );
});

test('references only non-empty Notes and numbers them in stable annotation order', () => {
  const annotations = [
    annotation('later', 2, 0.1, 0.1),
    annotation('first', 1, 0.2, 0.2),
    annotation('empty', 1, 0.1, 0.1),
  ];
  const references = buildAnnotationExportReferences(annotations, [
    note('n-later', 'later', 'Later Note'),
    note('n-first', 'first', 'First Note'),
    note('n-empty', 'empty', '  '),
  ]);
  assert.deepEqual(
    references.map(({ annotation: value, referenceNumber }) => [
      value.id,
      referenceNumber,
    ]),
    [
      ['first', 1],
      ['later', 2],
    ],
  );
});

test('annotation filters include only the explicitly visible subset', () => {
  const filter: AnnotationFilterState = {
    types: ['highlight'],
    noteStatus: 'with-note',
    colors: ['yellow'],
  };
  const annotations = [
    annotation('visible', 1, 0.1, 0.1),
    annotation('wrong-color', 1, 0.2, 0.1, { color: 'green' }),
    annotation('wrong-type', 1, 0.3, 0.1, {
      type: 'underline',
      color: 'red',
    }),
    annotation('without-note', 1, 0.4, 0.1),
  ];
  assert.deepEqual(
    annotations
      .filter((value) => matchesAnnotationFilter(value, ['visible'], filter))
      .map(({ id }) => id),
    ['visible'],
  );
});

test('sanitizes invalid filename characters without changing the document title', () => {
  assert.equal(
    sanitizeAnnotatedPdfFilename('  Paper: A/B*Test?.pdf  '),
    'Paper A B Test .pdf - annotated.pdf',
  );
  assert.equal(sanitizeAnnotatedPdfFilename(' <>:"/\\|?* '), '39Note - annotated.pdf');
});

test('appendix pagination keeps headings with their first line and loses no items', () => {
  const items = [
    { text: 'preface', style: 'body' as const, height: 10 },
    {
      text: 'heading',
      style: 'entry-heading' as const,
      height: 8,
      keepWithNext: true,
    },
    { text: 'first line', style: 'body' as const, height: 10 },
    { text: 'second line', style: 'body' as const, height: 5 },
  ];
  const pages = paginateAppendixItems(items, 25, 25);
  assert.deepEqual(
    pages.map((page) => page.map(({ text }) => text)),
    [['preface'], ['heading', 'first line', 'second line']],
  );
  assert.deepEqual(pages.flat(), items);
});

test('appendix wrapping preserves explicit line breaks and does not truncate long words', () => {
  const lines = wrapAppendixText('first line\nabcdefghij', 4, (value) => value.length);
  assert.deepEqual(lines, ['firs', 't', 'line', 'abcd', 'efgh', 'ij']);
  assert.equal(lines.join('').replaceAll(' ', ''), 'firstlineabcdefghij');
});

test('detects unsupported CJK and emoji while accepting English and WinAnsi punctuation', () => {
  assert.deepEqual(findUnsupportedAppendixCharacters('English – café €'), []);
  assert.deepEqual(findUnsupportedAppendixCharacters('中文🙂'), ['中', '文', '🙂']);
});
