import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createNoteAnchorFromAnnotation,
  createNoteAnchorFromSelection,
  findMatchingNote,
  findOverlappingAnnotations,
} from '../src/utils/annotationOverlap.ts';
import { buildAnnotationExportReferences } from '../src/utils/annotatedPdfExportModel.ts';
import type { PdfAnnotation } from '../src/types/highlight.ts';
import type { Note } from '../src/types/note.ts';
import type { PdfTextSelection } from '../src/types/textSelection.ts';

const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const appLayoutSource = source('../src/components/AppLayout.tsx');
const persistenceSource = source('../src/services/annotationPersistence.ts');
const exportServiceSource = source('../src/services/annotatedPdfExport.ts');

test('selection overlap resolves exact, partial, multiline, and tiny underline geometry', () => {
  const exact = annotation('exact', 'highlight', 0.1, 0.1, 0.2, 0.03);
  const partial = annotation('partial', 'underline', 0.24, 0.1, 0.18, 0.03);
  const multiline: PdfAnnotation = {
    ...annotation('multiline', 'highlight', 0.1, 0.2, 0.25, 0.025),
    rects: [
      { x: 0.1, y: 0.2, width: 0.25, height: 0.025 },
      { x: 0.1, y: 0.235, width: 0.18, height: 0.025 },
    ],
  };
  const tiny = annotation('tiny', 'underline', 0.5, 0.3, 0.03, 0.006);
  assert.deepEqual(ids(findOverlappingAnnotations([selection(60, 80, 120, 24)], [exact])), ['exact']);
  assert.deepEqual(ids(findOverlappingAnnotations([selection(150, 80, 100, 24)], [partial])), ['partial']);
  assert.deepEqual(
    ids(findOverlappingAnnotations([
      selection(60, 160, 150, 20, [{ left: 60, top: 188, width: 108, height: 20 }]),
    ], [multiline])),
    ['multiline'],
  );
  assert.deepEqual(ids(findOverlappingAnnotations([selection(300, 240, 18, 5)], [tiny])), ['tiny']);
});

test('adjacent and unrelated same-line annotations are not selected for Delete', () => {
  const first = annotation('first', 'highlight', 0.1, 0.1, 0.15, 0.03);
  const adjacent = annotation('adjacent', 'underline', 0.255, 0.1, 0.15, 0.03);
  const matches = findOverlappingAnnotations([selection(60, 80, 90, 24)], [first, adjacent]);
  assert.deepEqual(ids(matches), ['first']);
});

test('overlap is normalized and remains stable for rotated page dimensions', () => {
  const rotatedSelection = selection(80, 60, 24, 120, [], 800, 600);
  const rotated = annotation('rotated', 'underline', 0.1, 0.1, 0.03, 0.2);
  assert.deepEqual(ids(findOverlappingAnnotations([rotatedSelection], [rotated])), ['rotated']);
});

test('direct Add Note creates a semantic anchor and no visible annotation', () => {
  const anchor = createNoteAnchorFromSelection(selection(60, 80, 120, 24), 'anchor-1', 10);
  assert.ok(anchor);
  assert.equal(anchor.type, 'note-anchor');
  assert.equal(anchor.id, 'anchor-1');
  assert.equal(anchor.pageNumber, 2);
  assert.deepEqual(anchor.rects, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }]);
  assert.doesNotMatch(JSON.stringify(anchor), /yellow|underline|highlight/);
});

test('old visible sources and new semantic anchors both resolve to Open Note', () => {
  const visible = annotation('visible-source', 'highlight', 0.1, 0.1, 0.2, 0.03);
  const oldNote = note('old-note', visible.id, visible.text);
  assert.equal(
    findMatchingNote([selection(60, 80, 120, 24)], [oldNote], [visible], [])?.id,
    oldNote.id,
  );
  const anchor = createNoteAnchorFromAnnotation(visible, 'anchor-source', 20);
  const directNote = note('direct-note', anchor.id, anchor.text);
  assert.equal(
    findMatchingNote([selection(60, 80, 120, 24)], [directNote], [], [anchor])?.id,
    directNote.id,
  );
});

test('multiple genuine overlaps remain individually identifiable for disambiguation', () => {
  const highlight = annotation('highlight-1', 'highlight', 0.1, 0.1, 0.2, 0.03);
  const underline = annotation('underline-1', 'underline', 0.1, 0.1, 0.2, 0.03);
  assert.deepEqual(
    ids(findOverlappingAnnotations([selection(60, 80, 120, 24)], [highlight, underline])),
    ['highlight-1', 'underline-1'],
  );
  assert.match(viewerSource, /createSelectionDeleteActions/);
  assert.match(selectionActionSource, /Choose annotation to delete/);
});

test('unified toolbar is the only annotation editing workflow', () => {
  for (const label of ['Highlight', 'Underline', 'Add Note', 'Open Note', 'Delete']) {
    assert.match(selectionActionSource + viewerSource, new RegExp(label));
  }
  assert.doesNotMatch(viewerSource, /selectedHighlight|selectHighlight|onAnnotationSelect|onUpdateAnnotationColor/);
  assert.doesNotMatch(pdfPageSource, /onAnnotationSelect|handleTextLayerClick/);
  assert.doesNotMatch(selectionActionSource, /Change colour/);
  assert.match(pdfPageSource, /className="highlight-layer"/);
  assert.match(source('../src/styles/index.css'), /\.highlight-layer[\s\S]*?pointer-events: none/);
});

test('visible annotation deletion preserves and relinks Notes while Note deletion cleans anchors', () => {
  assert.match(appLayoutSource, /createNoteAnchorFromAnnotation\(annotation\)/);
  assert.match(appLayoutSource, /note\.annotationId === annotationId[\s\S]*?annotationId: anchor\.id/);
  assert.doesNotMatch(appLayoutSource, /filter\(\(note\) => note\.annotationId !== annotationId\)/);
  assert.match(appLayoutSource, /currentAnchors\.filter\(\(anchor\) => anchor\.id !== note\.annotationId\)/);
});

test('persistence, Backup/Restore, Package Selected, and export carry semantic anchors safely', () => {
  assert.match(persistenceSource, /PERSISTENCE_SCHEMA_VERSION = 7/);
  assert.match(persistenceSource, /NOTE_ANCHOR_PREVIOUS_SCHEMA_VERSION = 6/);
  assert.match(persistenceSource, /noteAnchors: NoteAnchor\[\]/);
  assert.match(persistenceSource, /sanitizeNoteAnchors/);
  assert.match(source('../src/services/libraryBackup.ts'), /getBackupDocumentData/);
  assert.match(exportServiceSource, /reference\.annotation\.type === 'note-anchor'/);
});

test('annotated-PDF references include direct Notes without exporting anchors as annotations', () => {
  const selectionSource = annotation('source-template', 'highlight', 0.1, 0.1, 0.2, 0.03);
  const anchor = createNoteAnchorFromAnnotation(selectionSource, 'direct-anchor', 20);
  const references = buildAnnotationExportReferences(
    [],
    [{ ...note('direct-note', anchor.id, anchor.text), content: 'Direct content' }],
    [anchor],
  );
  assert.equal(references.length, 1);
  assert.equal(references[0].annotation.type, 'note-anchor');
  assert.equal(references[0].note.content, 'Direct content');
});

function annotation(
  id: string,
  type: PdfAnnotation['type'],
  x: number,
  y: number,
  width: number,
  height: number,
): PdfAnnotation {
  return {
    id,
    type,
    pageNumber: 2,
    text: 'selected source text',
    rects: [{ x, y, width, height }],
    color: type === 'highlight' ? 'yellow' : 'blue',
    createdAt: 1,
    updatedAt: 1,
  } as PdfAnnotation;
}

function selection(
  left: number,
  top: number,
  width: number,
  height: number,
  additional: PdfTextSelection['boundingRectangles'] = [],
  pageWidth = 600,
  pageHeight = 800,
): PdfTextSelection {
  return {
    text: 'selected source text',
    pageNumber: 2,
    pageWidth,
    pageHeight,
    boundingRectangles: [{ left, top, width, height }, ...additional],
    startOffset: 2,
    endOffset: 22,
  };
}

function note(id: string, annotationId: string, selectedText: string): Note {
  return {
    id,
    annotationId,
    pageNumber: 2,
    displayNumber: '1',
    selectedText,
    content: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

function ids(annotations: PdfAnnotation[]): string[] {
  return annotations.map(({ id }) => id);
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
