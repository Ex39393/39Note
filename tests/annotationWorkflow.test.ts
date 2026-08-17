import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createNoteAnchorFromAnnotation,
  createNoteAnchorFromSelection,
  findAnnotationsAtNormalizedPoint,
  findMatchingNote,
  findMatchingNoteForSources,
  findOverlappingAnnotations,
} from '../src/utils/annotationOverlap.ts';
import {
  addAnnotationFromSourceIfMissing,
  createAnnotationFromSource,
} from '../src/utils/highlights.ts';
import { isSimpleAnnotationTap } from '../src/utils/annotationInteraction.ts';
import { buildAnnotationExportReferences } from '../src/utils/annotatedPdfExportModel.ts';
import {
  createPrintSourceGroups,
  getNotesInPrintOrder,
  getPrintModeContent,
} from '../src/utils/annotationPrint.ts';
import type { PdfAnnotation } from '../src/types/highlight.ts';
import type { Note } from '../src/types/note.ts';
import type { PdfTextSelection } from '../src/types/textSelection.ts';
import type { NoteAnchor } from '../src/types/noteAnchor.ts';

const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const appLayoutSource = source('../src/components/AppLayout.tsx');
const persistenceSource = source('../src/services/annotationPersistence.ts');
const exportServiceSource = source('../src/services/annotatedPdfExport.ts');
const noteExportSource = source('../src/utils/noteExport.ts');

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

test('page-level tap hit testing uses full Highlight and Underline source rectangles', () => {
  const highlight = annotation('tap-highlight', 'highlight', 0.1, 0.1, 0.25, 0.04);
  const underline = annotation('tap-underline', 'underline', 0.1, 0.3, 0.25, 0.04);
  assert.deepEqual(
    ids(findAnnotationsAtNormalizedPoint(2, { x: 0.2, y: 0.12 }, [highlight, underline])),
    ['tap-highlight'],
  );
  assert.deepEqual(
    ids(findAnnotationsAtNormalizedPoint(2, { x: 0.2, y: 0.32 }, [highlight, underline])),
    ['tap-underline'],
  );
  assert.deepEqual(
    findAnnotationsAtNormalizedPoint(2, { x: 0.2, y: 0.36 }, [underline]),
    [],
  );
});

test('tap discrimination rejects drag selection and accepts a small simple click', () => {
  const start = { pointerId: 4, clientX: 100, clientY: 100 };
  assert.equal(
    isSimpleAnnotationTap(start, { pointerId: 4, clientX: 103, clientY: 102 }, false),
    true,
  );
  assert.equal(
    isSimpleAnnotationTap(start, { pointerId: 4, clientX: 120, clientY: 100 }, false),
    false,
  );
  assert.equal(
    isSimpleAnnotationTap(start, { pointerId: 4, clientX: 103, clientY: 102 }, true),
    false,
  );
});

test('overlapping Highlight and Underline resolve to one existing logical Note', () => {
  const highlight = annotation('same-highlight', 'highlight', 0.1, 0.1, 0.2, 0.03);
  const underline = annotation('same-underline', 'underline', 0.1, 0.1, 0.2, 0.03);
  const anchor = createNoteAnchorFromAnnotation(highlight, 'same-anchor', 2);
  const existing = note('same-note', anchor.id, anchor.text);
  const hits = findAnnotationsAtNormalizedPoint(2, { x: 0.15, y: 0.115 }, [highlight, underline]);
  assert.deepEqual(ids(hits), ['same-highlight', 'same-underline']);
  assert.equal(
    findMatchingNoteForSources(hits, [existing], [highlight, underline], [anchor])?.id,
    existing.id,
  );
});

test('Note-source annotation creation clones exact geometry and never recolours duplicates', () => {
  const source = createNoteAnchorFromAnnotation(
    annotation('source-highlight', 'highlight', 0.1, 0.2, 0.3, 0.04),
    'note-source',
    10,
  );
  const highlight = createAnnotationFromSource(source, 'highlight', 'yellow', 'new-highlight', 20);
  const underline = createAnnotationFromSource(source, 'underline', 'blue', 'new-underline', 21);
  assert.ok(highlight);
  assert.ok(underline);
  assert.deepEqual(highlight.rects, source.rects);
  assert.notEqual(highlight.rects, source.rects);
  const existingHighlight = { ...highlight, id: 'existing-highlight', color: 'green' as const };
  const withoutDuplicate = addAnnotationFromSourceIfMissing(
    [existingHighlight],
    { ...highlight, color: 'pink' },
  );
  assert.equal(withoutDuplicate.length, 1);
  assert.equal(withoutDuplicate[0].color, 'green');
  const withOtherType = addAnnotationFromSourceIfMissing(withoutDuplicate, underline);
  assert.deepEqual(withOtherType.map((item) => item.type), ['highlight', 'underline']);
});

test('interaction wiring preserves SVG pass-through and ignores app controls', () => {
  const interactionSource = source('../src/utils/annotationInteraction.ts');
  const notesPanelSource = source('../src/components/NotesPanel.tsx');
  assert.match(pdfPageSource, /onPointerDown=\{beginAnnotationTap\}/);
  assert.match(pdfPageSource, /hasMeaningfulSelection/);
  assert.match(interactionSource, /'a'/);
  assert.match(interactionSource, /'button'/);
  assert.match(interactionSource, /\.definition-bubble/);
  assert.match(notesPanelSource, /onClick=\{\(\) => onNavigate\(note\)\}/);
  assert.match(notesPanelSource, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(viewerSource, /getSourceActionPosition/);
  assert.match(viewerSource, /showSourceActions/);
  assert.match(selectionActionSource, /already present/);
  assert.match(appLayoutSource, /const addNoteFromMarkedSource/);
  assert.match(appLayoutSource, /findMatchingNoteForSources/);
  assert.match(appLayoutSource, /createNoteAnchorFromAnnotation\(source\)/);
  assert.match(appLayoutSource, /onAnnotationTap=\{addNoteFromMarkedSource\}/);
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

test('All Annotations creates one reading-order group for every logical source kind', () => {
  const noteOnlyAnchor = anchor('note-only-anchor', 1, 0.05, 'Note only');
  const highlightOnly = onPage(annotation('highlight-only', 'highlight', 0.1, 0.15, 0.2, 0.03), 1);
  const underlineOnly = onPage(annotation('underline-only', 'underline', 0.1, 0.25, 0.2, 0.03), 1);
  const combinedHighlight = onPage(annotation('combined-highlight', 'highlight', 0.1, 0.35, 0.2, 0.03), 1);
  const combinedUnderline = onPage(annotation('combined-underline', 'underline', 0.1, 0.35, 0.2, 0.03), 1);
  const combinedAnchor = createNoteAnchorFromAnnotation(combinedHighlight, 'combined-anchor', 4);
  const groups = createPrintSourceGroups(
    [highlightOnly, underlineOnly, combinedHighlight, combinedUnderline],
    [
      { ...note('note-only', noteOnlyAnchor.id, noteOnlyAnchor.text), pageNumber: 1 },
      { ...note('combined-note', combinedAnchor.id, combinedAnchor.text), pageNumber: 1 },
    ],
    [noteOnlyAnchor, combinedAnchor],
  );
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.map((group) => [group.annotations.map((item) => item.type), group.notes.length]),
    [
      [[], 1],
      [['highlight'], 0],
      [['underline'], 0],
      [['highlight', 'underline'], 1],
    ],
  );
  assert.equal(groups[3].sourceText, combinedHighlight.text);
  assert.match(noteExportSource, /data-source-group-id/);
  assert.doesNotMatch(noteExportSource, /standaloneNotesSection/);
});

test('a direct NoteAnchor and overlapping annotation become one combined print group', () => {
  const highlight = annotation('overlap-highlight', 'highlight', 0.1, 0.2, 0.2, 0.03);
  const directAnchor = createNoteAnchorFromAnnotation(highlight, 'direct-anchor-print', 5);
  const directNote = note('direct-note-print', directAnchor.id, directAnchor.text);
  const groups = createPrintSourceGroups([highlight], [directNote], [directAnchor]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].annotations[0].id, highlight.id);
  assert.equal(groups[0].notes[0].id, directNote.id);
});

test('Notes print by page, Y, then X regardless of newest-first creation order', () => {
  const lowerAnchor = anchor('lower-anchor', 2, 0.7, 'Lower source', 0.2, 1);
  const upperAnchor = anchor('upper-anchor', 2, 0.2, 'Upper source', 0.3, 2);
  const nextPageAnchor = anchor('page-three-anchor', 3, 0.05, 'Page three', 0.1, 3);
  const lowerFirst = { ...note('lower-note', lowerAnchor.id, lowerAnchor.text), createdAt: 1 };
  const upperSecond = { ...note('upper-note', upperAnchor.id, upperAnchor.text), createdAt: 2 };
  const pageThree = { ...note('page-three-note', nextPageAnchor.id, nextPageAnchor.text), pageNumber: 3 };
  const ordered = getNotesInPrintOrder(
    [],
    [lowerFirst, pageThree, upperSecond],
    [lowerAnchor, upperAnchor, nextPageAnchor],
  );
  assert.deepEqual(ordered.map((item) => item.id), ['upper-note', 'lower-note', 'page-three-note']);
});

test('all four print layouts share Note reading order while All Annotations keeps all sources', () => {
  const upper = anchor('layout-upper', 1, 0.1, 'Upper');
  const lower = anchor('layout-lower', 1, 0.8, 'Lower');
  const notes = [note('layout-lower-note', lower.id, lower.text), note('layout-upper-note', upper.id, upper.text)];
  const annotationOnly = onPage(annotation('layout-highlight', 'highlight', 0.1, 0.5, 0.2, 0.03), 1);
  for (const layout of ['standard', 'space-saving', 'extra-large'] as const) {
    const content = getPrintModeContent(layout, [annotationOnly], notes, [upper, lower]);
    assert.deepEqual(content.flatMap((group) => group.notes.map((item) => item.id)), [
      'layout-upper-note',
      'layout-lower-note',
    ]);
    assert.equal(content.some((group) => group.annotations[0]?.id === annotationOnly.id), false);
  }
  const all = getPrintModeContent('all-annotations', [annotationOnly], notes, [upper, lower]);
  assert.deepEqual(all.map((group) => group.sourceText), ['Upper', annotationOnly.text, 'Lower']);
});

test('Direct Print and Print Composer consume the same grouped source model', () => {
  const composerSource = source('../src/print/PrintComposerEditor.tsx');
  assert.match(noteExportSource, /getPrintModeContent/);
  assert.match(composerSource, /getPrintModeContent/);
  assert.match(composerSource, /createSourceGroupBlock/);
  assert.match(noteExportSource, /formatSourceGroupForPrint/);
  assert.match(noteExportSource, /\$\{noteEntries\}[\s\S]*\$\{glossarySection\}/);
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

function anchor(
  id: string,
  pageNumber: number,
  y: number,
  text: string,
  x = 0.1,
  createdAt = 1,
): NoteAnchor {
  return {
    id,
    type: 'note-anchor',
    pageNumber,
    text,
    rects: [{ x, y, width: 0.2, height: 0.03 }],
    startOffset: Math.round(y * 10_000),
    endOffset: Math.round(y * 10_000) + text.length,
    createdAt,
    updatedAt: createdAt,
  };
}

function onPage(value: PdfAnnotation, pageNumber: number): PdfAnnotation {
  return { ...value, pageNumber };
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
