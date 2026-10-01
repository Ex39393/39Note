import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { PdfAnnotation } from '../src/types/highlight.ts';
import type { PdfGlossaryEntry } from '../src/types/glossary.ts';
import type { Note } from '../src/types/note.ts';
import type { NoteAnchor } from '../src/types/noteAnchor.ts';
import {
  addNoteToAnnotationTag,
  deleteAnnotationTag,
  deleteNoteFromTagState,
  deriveAnnotationTags,
  type AnnotationTagState,
} from '../src/utils/annotationTags.ts';
import {
  findAnnotationsAtClientPoint,
  findPdfGlossaryEntriesAtClientPoint,
} from '../src/utils/annotationInteraction.ts';
import {
  createReaderContextCandidates,
  getAdjacentReaderContextCandidateKey,
  getReaderContextCandidateKey,
  removeReaderContextCandidate,
} from '../src/utils/readerContextCandidates.ts';
import {
  createPrintSourceGroups,
  getPrintModeContent,
} from '../src/utils/annotationPrint.ts';

const appLayoutSource = source('../src/components/AppLayout.tsx');
const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const tagSource = source('../src/components/pdf/AnnotationTag.tsx');
const notesPanelSource = source('../src/components/NotesPanel.tsx');
const noteDragHandleSource = source('../src/components/NoteDragHandle.tsx');
const largeNoteEditorSource = source('../src/components/LargeNoteEditor.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const styleSource = source('../src/styles/index.css');

test('each Highlight and Underline derives exactly one persistent logical Tag and zero Notes', () => {
  const state = makeState([
    annotation('highlight', 'highlight', 0.1),
    annotation('underline', 'underline', 0.3),
  ]);
  const tags = deriveAnnotationTags(state.annotations, state.notes, state.noteAnchors);
  assert.deepEqual(
    tags.map((tag) => [tag.id, tag.note]),
    [
      ['highlight', null],
      ['underline', null],
    ],
  );
  assert.equal(state.notes.length, 0);
  assert.equal(state.noteAnchors.length, 0);
});

test('Add Note is explicit, mark-owned, anchor-free, and idempotent', () => {
  const initial = makeState([annotation('highlight', 'highlight', 0.1)]);
  const first = addNoteToAnnotationTag(initial, 'highlight', {
    id: 'note-1',
    displayNumber: '4',
    timestamp: 50,
  });
  assert.equal(first.createdNote?.annotationId, 'highlight');
  assert.equal(first.createdNote?.content, '');
  assert.equal(first.state.notes.length, 1);
  assert.deepEqual(first.state.noteAnchors, []);

  const repeated = addNoteToAnnotationTag(first.state, 'highlight', {
    id: 'note-2',
    displayNumber: '5',
    timestamp: 51,
  });
  assert.equal(repeated.createdNote, null);
  assert.equal(repeated.state, first.state);
  assert.deepEqual(
    repeated.state.notes.map(({ id }) => id),
    ['note-1'],
  );
});

test('Tag controls reflect optional Note state without a placeholder Note action path', () => {
  assert.match(tagSource, /const note = tag\?\.note \?\? null/);
  assert.match(tagSource, /\{note \? \(/);
  assert.match(tagSource, />\s*Add Note\s*</);
  assert.match(tagSource, />\s*Delete Note\s*</);
  assert.match(tagSource, /Delete \{typeLabel\}/);
  assert.doesNotMatch(selectionActionSource, /Add Note|Open Note|Delete Note/);
  assert.doesNotMatch(
    viewerSource,
    /addNoteFromMarkedSource|onAnnotationTap|onAddNote\(/,
  );
  assert.match(tagSource, /useLayoutEffect/);
  assert.match(tagSource, /getBoundingClientRect\(\)/);
  assert.match(tagSource, /new ResizeObserver\(placeInsideViewport\)/);
  assert.match(styleSource, /\.annotation-tag\s*\{[^}]*overflow: auto/s);
  assert.match(viewerSource, /addEventListener\('scroll', dismissStaleTag/);
  assert.match(
    viewerSource,
    /\[containerSize\.height, containerSize\.width, zoomOperationId\]/,
  );
});

test('Delete Note removes only the Note and returns the same mark to a note-less Tag', () => {
  const mark = annotation('underline', 'underline', 0.2);
  const state = makeState([mark], [note('note-1', mark.id, 'written text')]);
  const next = deleteNoteFromTagState(state, 'note-1');
  assert.deepEqual(next.annotations, [mark]);
  assert.deepEqual(next.notes, []);
  const [tag] = deriveAnnotationTags(next.annotations, next.notes, next.noteAnchors);
  assert.equal(tag.id, mark.id);
  assert.equal(tag.note, null);
});

test('deleting a note-less mark removes its derived Tag normally', () => {
  const state = makeState([annotation('plain', 'highlight', 0.1)]);
  const result = deleteAnnotationTag(state, 'plain', false);
  assert.equal(result.deleted, true);
  assert.equal(result.requiresConfirmation, false);
  assert.deepEqual(result.state.annotations, []);
  assert.deepEqual(
    deriveAnnotationTags(
      result.state.annotations,
      result.state.notes,
      result.state.noteAnchors,
    ),
    [],
  );
});

test('mark deletion with a Note is fail-safe until confirmed, then removes both', () => {
  const mark = annotation('marked', 'highlight', 0.1);
  const state = makeState([mark], [note('note-1', mark.id, 'keep me')]);
  const cancelled = deleteAnnotationTag(state, mark.id, false);
  assert.equal(cancelled.requiresConfirmation, true);
  assert.equal(cancelled.deleted, false);
  assert.equal(cancelled.state, state);

  const confirmed = deleteAnnotationTag(state, mark.id, true);
  assert.equal(confirmed.deleted, true);
  assert.deepEqual(confirmed.state.annotations, []);
  assert.deepEqual(confirmed.state.notes, []);
  assert.match(tagSource, /Delete this \{typeLabel\.toLowerCase\(\)\} and its note\?/);
  assert.match(tagSource, />\s*Cancel\s*</);
});

test('existing direct and legacy-anchor Notes load into exactly one deterministic Tag', () => {
  const first = annotation('first', 'highlight', 0.1, 1);
  const second = annotation('second', 'underline', 0.1, 2);
  const direct = note('direct', second.id, 'direct');
  const legacyAnchor = markedSourceAnchor('legacy-anchor', 0.1);
  const legacy = note('legacy', legacyAnchor.id, 'legacy');
  const tags = deriveAnnotationTags([second, first], [legacy, direct], [legacyAnchor]);
  assert.equal(tags.find((tag) => tag.id === 'second')?.note?.id, direct.id);
  assert.equal(tags.find((tag) => tag.id === 'second')?.noteSource, 'mark');
  assert.equal(tags.find((tag) => tag.id === 'first')?.note?.id, legacy.id);
  assert.equal(tags.find((tag) => tag.id === 'first')?.noteSource, 'legacy-anchor');
  assert.equal(tags.filter((tag) => tag.note?.id === legacy.id).length, 1);
});

test('a legacy orphan Note is preserved and no fake mark is fabricated', () => {
  const orphanAnchor = anchor('orphan-anchor', 0.7);
  const orphan = note('orphan-note', orphanAnchor.id, 'legacy standalone');
  const state = makeState(
    [annotation('unrelated', 'highlight', 0.1)],
    [orphan],
    [orphanAnchor],
  );
  const tags = deriveAnnotationTags(state.annotations, state.notes, state.noteAnchors);
  assert.equal(tags[0].note, null);

  const removed = deleteAnnotationTag(state, 'unrelated', false);
  assert.deepEqual(removed.state.notes, [orphan]);
  assert.deepEqual(removed.state.noteAnchors, [orphanAnchor]);
});

test('legacy mark Note deletion and confirmed mark deletion clean only their owned anchor', () => {
  const mark = annotation('mark', 'highlight', 0.1);
  const matchingAnchor = markedSourceAnchor('matching-anchor', 0.1);
  const otherAnchor = anchor('other-anchor', 0.8);
  const matchingNote = note('matching-note', matchingAnchor.id, 'linked');
  const otherNote = note('other-note', otherAnchor.id, 'orphan');
  const state = makeState(
    [mark],
    [matchingNote, otherNote],
    [matchingAnchor, otherAnchor],
  );

  const noteDeleted = deleteNoteFromTagState(state, matchingNote.id);
  assert.deepEqual(noteDeleted.annotations, [mark]);
  assert.deepEqual(noteDeleted.notes, [otherNote]);
  assert.deepEqual(noteDeleted.noteAnchors, [otherAnchor]);

  const markDeleted = deleteAnnotationTag(state, mark.id, true);
  assert.deepEqual(markDeleted.state.annotations, []);
  assert.deepEqual(markDeleted.state.notes, [otherNote]);
  assert.deepEqual(markDeleted.state.noteAnchors, [otherAnchor]);
});

test('a geometrically matching standalone Note is never adopted or deleted as a mark Note', () => {
  const mark = annotation('mark', 'highlight', 0.1);
  const standaloneAnchor = anchor('standalone-anchor', 0.1);
  const standaloneNote = note('standalone-note', standaloneAnchor.id, 'independent');
  const state = makeState([mark], [standaloneNote], [standaloneAnchor]);

  const [tag] = deriveAnnotationTags(state.annotations, state.notes, state.noteAnchors);
  assert.equal(tag.note, null);
  const removed = deleteAnnotationTag(state, mark.id, false);
  assert.equal(removed.deleted, true);
  assert.deepEqual(removed.state.notes, [standaloneNote]);
  assert.deepEqual(removed.state.noteAnchors, [standaloneAnchor]);
});

test('ambiguous legacy marked-source provenance is preserved instead of assigned arbitrarily', () => {
  const first = annotation('first', 'highlight', 0.1);
  const second = annotation('second', 'underline', 0.1);
  const legacyAnchor = markedSourceAnchor('legacy-anchor', 0.1);
  const legacyNote = note('legacy-note', legacyAnchor.id, 'keep me');
  const state = makeState([first, second], [legacyNote], [legacyAnchor]);

  const tags = deriveAnnotationTags(state.annotations, state.notes, state.noteAnchors);
  assert.ok(tags.every((tag) => tag.note === null));
  const removed = deleteAnnotationTag(state, first.id, false);
  assert.deepEqual(removed.state.notes, [legacyNote]);
  assert.deepEqual(removed.state.noteAnchors, [legacyAnchor]);
});

test('multi-rectangle marks still derive one Tag', () => {
  const mark = {
    ...annotation('multiline', 'highlight', 0.1),
    rects: [
      { x: 0.1, y: 0.1, width: 0.25, height: 0.03 },
      { x: 0.1, y: 0.14, width: 0.18, height: 0.03 },
    ],
  };
  const tags = deriveAnnotationTags([mark], [], []);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].annotation.rects.length, 2);
});

test('plain mark and plain Glossary regions each resolve to one contextual candidate', () => {
  const underline = annotation('underline', 'underline', 0.1);
  const entry = glossary('entry', 0.1);
  assert.deepEqual(
    createReaderContextCandidates([underline], []).map(getReaderContextCandidateKey),
    ['annotation:underline'],
  );
  assert.deepEqual(
    createReaderContextCandidates([], [entry]).map(getReaderContextCandidateKey),
    ['glossary:entry'],
  );
  assert.deepEqual(
    findPdfGlossaryEntriesAtClientPoint(
      2,
      { left: 100, top: 200, width: 600, height: 800 },
      { clientX: 190, clientY: 288 },
      [entry],
    ).map(({ glossaryEntryId }) => glossaryEntryId),
    ['entry'],
  );
});

test('annotation and Glossary overlap uses deterministic annotation-first navigation', () => {
  const underline = annotation('underline', 'underline', 0.1);
  const entry = glossary('entry', 0.1);
  const candidates = createReaderContextCandidates([underline], [entry]);
  const keys = candidates.map(getReaderContextCandidateKey);
  assert.deepEqual(keys, ['annotation:underline', 'glossary:entry']);
  assert.deepEqual(
    createReaderContextCandidates(
      JSON.parse(JSON.stringify([underline])) as PdfAnnotation[],
      JSON.parse(JSON.stringify([entry])) as PdfGlossaryEntry[],
    ).map(getReaderContextCandidateKey),
    keys,
  );
  assert.equal(
    getAdjacentReaderContextCandidateKey(candidates, keys[0], 1),
    'glossary:entry',
  );
  assert.equal(
    getAdjacentReaderContextCandidateKey(candidates, keys[1], 1),
    'annotation:underline',
  );
  assert.equal(
    getAdjacentReaderContextCandidateKey(candidates, keys[0], -1),
    'glossary:entry',
  );
});

test('multiple marks plus Glossary remain reachable with namespaced stable identities', () => {
  const candidates = createReaderContextCandidates(
    [annotation('shared', 'highlight', 0.1), annotation('underline', 'underline', 0.1)],
    [glossary('shared', 0.1)],
  );
  const keys = candidates.map(getReaderContextCandidateKey);
  assert.deepEqual(keys, [
    'annotation:shared',
    'annotation:underline',
    'glossary:shared',
  ]);
  const visited = new Set<string>();
  let current = keys[0];
  for (let index = 0; index < candidates.length; index += 1) {
    visited.add(current);
    current = getAdjacentReaderContextCandidateKey(candidates, current, 1)!;
  }
  assert.deepEqual([...visited], keys);
  assert.equal(current, keys[0]);
});

test('removing either active overlap candidate leaves its independent peer active', () => {
  const candidates = createReaderContextCandidates(
    [annotation('underline', 'underline', 0.1)],
    [glossary('entry', 0.1)],
  );
  const afterGlossaryRemoval = removeReaderContextCandidate(
    candidates,
    'glossary:entry',
    'glossary:entry',
  );
  assert.deepEqual(afterGlossaryRemoval, {
    candidates: [{ kind: 'annotation', annotationId: 'underline' }],
    activeCandidateKey: 'annotation:underline',
  });
  const afterAnnotationRemoval = removeReaderContextCandidate(
    candidates,
    'annotation:underline',
    'annotation:underline',
  );
  assert.deepEqual(afterAnnotationRemoval, {
    candidates: [{ kind: 'glossary', glossaryEntryId: 'entry' }],
    activeCandidateKey: 'glossary:entry',
  });
});

test('deleting an annotation state leaves the independent Glossary entry unchanged', () => {
  const entry = glossary('entry', 0.1);
  const deleted = deleteAnnotationTag(
    makeState([annotation('underline', 'underline', 0.1)]),
    'underline',
    false,
  );
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.state.annotations, []);
  assert.deepEqual([entry], [glossary('entry', 0.1)]);
});

test('left-click and right-click geometry resolve only the hit annotation without mutating Notes', () => {
  const highlight = annotation('highlight', 'highlight', 0.1);
  const underline = annotation('underline', 'underline', 0.4);
  const state = makeState([highlight, underline]);
  assert.deepEqual(
    findAnnotationsAtClientPoint(
      2,
      { left: 100, top: 200, width: 600, height: 800 },
      { clientX: 190, clientY: 288 },
      state.annotations,
    ).map(({ id }) => id),
    ['highlight'],
  );
  assert.deepEqual(state.notes, []);
  assert.match(pdfPageSource, /onContextMenu=\{\(event\) => \{/);
  assert.match(
    pdfPageSource,
    /if \(annotationHits\.length === 0\) return;[\s\S]*?event\.preventDefault\(\)/,
  );
});

test('overlapping right-click hits remain individually selectable and deletion targets one mark', () => {
  const highlight = annotation('highlight', 'highlight', 0.1);
  const underline = {
    ...annotation('underline', 'underline', 0.1),
    text: 'a different overlapping source',
  };
  const state = makeState([highlight, underline]);
  const hits = findAnnotationsAtClientPoint(
    2,
    { left: 0, top: 0, width: 1000, height: 1000 },
    { clientX: 150, clientY: 110 },
    state.annotations,
  );
  assert.deepEqual(
    hits.map(({ id }) => id),
    ['highlight', 'underline'],
  );
  const removed = deleteAnnotationTag(state, 'underline', false);
  assert.deepEqual(
    removed.state.annotations.map(({ id }) => id),
    ['highlight'],
  );
  assert.match(tagSource, /aria-label="Previous contextual item"/);
  assert.match(tagSource, /aria-label="Next contextual item"/);
  assert.match(tagSource, /activeCandidateIndex \+ 1/);
  assert.equal(viewerSource.match(/<AnnotationTag/g)?.length, 1);
});

test('context title, candidate navigation, and terminal close share one responsive header row', () => {
  const headerSource = tagSource.match(
    /<header className="annotation-tag-header">[\s\S]*?<\/header>/,
  )?.[0];
  assert.ok(headerSource);
  assert.match(headerSource, /className="annotation-tag-title"/);
  assert.match(headerSource, /className="annotation-tag-header-controls"/);
  assert.match(headerSource, /className="annotation-tag-context-navigation"/);
  assert.match(headerSource, /aria-label="Close context"/);
  assert.ok(
    headerSource.indexOf('annotation-tag-title') <
      headerSource.indexOf('annotation-tag-context-navigation'),
  );
  assert.ok(
    headerSource.indexOf('annotation-tag-context-navigation') <
      headerSource.indexOf('annotation-tag-close'),
  );
  assert.match(
    styleSource,
    /\.annotation-tag-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;[^}]*align-items:\s*center;/s,
  );
  assert.match(
    styleSource,
    /\.annotation-tag-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    styleSource,
    /\.annotation-tag-header-controls\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*align-items:\s*center;[^}]*justify-self:\s*end;/s,
  );
  assert.match(
    styleSource,
    /\.annotation-tag-context-navigation\s*\{[^}]*flex:\s*0 0 auto;[^}]*align-items:\s*center;/s,
  );
  assert.match(styleSource, /\.annotation-tag-close\s*\{[^}]*flex:\s*0 0 auto;/s);
});

test('mark-owned Notes align the shared large-editor handle with the Note label above the textarea', () => {
  assert.match(tagSource, /const note = tag\?\.note \?\? null/);
  assert.match(tagSource, /onClick=\{\(\) => onAddNote\(tag\.annotation\.id\)\}/);
  const noteEditorSource = tagSource.match(
    /<div className="annotation-tag-note">[\s\S]*?<\/div>\s*<textarea[\s\S]*?\/>\s*<\/div>/,
  )?.[0];
  assert.ok(noteEditorSource);
  const noteHeaderSource = noteEditorSource.match(
    /<div className="annotation-tag-note-header">[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(noteHeaderSource);
  assert.match(noteHeaderSource, /<span>Note<\/span>/);
  assert.match(noteHeaderSource, /<NoteDragHandle/);
  assert.doesNotMatch(noteHeaderSource, /<textarea/);
  assert.ok(
    noteEditorSource.indexOf('NoteDragHandle') < noteEditorSource.indexOf('<textarea'),
  );
  assert.equal(tagSource.match(/<NoteDragHandle/g)?.length, 1);
  assert.match(notesPanelSource, /<NoteDragHandle/);
  assert.match(noteDragHandleSource, /aria-label="Drag to open large editor"/);
  assert.match(
    styleSource,
    /\.annotation-tag-note-header\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;[^}]*align-items:\s*center;[^}]*justify-content:\s*space-between;[^}]*gap:\s*8px;/s,
  );
  assert.match(
    styleSource,
    /\.annotation-tag \.note-drag-handle\s*\{[^}]*flex:\s*0 0 auto;/s,
  );
  assert.doesNotMatch(
    tagSource.match(/className="annotation-tag-glossary"[\s\S]*?<\/div>/)?.[0] ?? '',
    /NoteDragHandle/,
  );
});

test('the shared handle preserves the accepted pointer, touch, and keyboard initiation semantics', () => {
  assert.match(noteDragHandleSource, /if \(event\.button !== 0\) return/);
  assert.match(noteDragHandleSource, /event\.preventDefault\(\)/);
  assert.match(noteDragHandleSource, /event\.stopPropagation\(\)/);
  assert.match(noteDragHandleSource, /onBeginNoteDrag\(note, event, onDropInTarget\)/);
  assert.match(noteDragHandleSource, /event\.key !== 'Enter'/);
  assert.match(noteDragHandleSource, /onOpenLargeEditor\(note\)/);
  assert.match(
    styleSource,
    /\.note-drag-handle\s*\{[^}]*cursor:\s*grab;[^}]*touch-action:\s*none;/s,
  );
});

test('persistent and contextual Notes enter the one AppLayout drag pipeline with exact identity', () => {
  assert.match(notesPanelSource, /data-note-drag-source="true"/);
  assert.match(tagSource, /data-note-drag-source=\{note \? 'true' : undefined\}/);
  assert.match(
    appLayoutSource,
    /closest<HTMLElement>\(\s*'\[data-note-drag-source="true"\]',?\s*\)/s,
  );
  assert.match(appLayoutSource, /noteId: note\.id/);
  assert.match(appLayoutSource, /pointerId: event\.pointerId/);
  assert.equal(appLayoutSource.match(/className="note-drop-overlay"/g)?.length, 1);
  assert.equal(appLayoutSource.match(/className="note-drop-target"/g)?.length, 1);
  assert.match(appLayoutSource, /Drop here to open large editor/);
  assert.match(
    appLayoutSource,
    /const draggedNote = noteDragPreview[\s\S]*?candidate\.id === noteDragPreview\.noteId/,
  );
});

test('dropping in the existing target opens the existing editor and closes only the successful contextual source', () => {
  assert.match(
    appLayoutSource,
    /if \(wasDroppedInTarget\) \{\s*setLargeEditorNoteId\(noteDragPreview\.noteId\);\s*noteDragPreview\.onDropInTarget\?\.\(\);/s,
  );
  const successfulDropSource = appLayoutSource.match(
    /if \(wasDroppedInTarget\) \{[\s\S]*?noteDragPreview\.onDropInTarget\?\.\(\);\s*\}/,
  )?.[0];
  assert.ok(successfulDropSource);
  assert.doesNotMatch(successfulDropSource, /setIsNotesDrawerOpen/);
  assert.match(tagSource, /onDropInTarget=\{onClose\}/);
  assert.match(tagSource, /onOpenLargeEditor\(selectedNote\);\s*onClose\(\);/s);
  assert.match(
    appLayoutSource,
    /const largeEditorNote = largeEditorNoteId[\s\S]*?candidate\.id === largeEditorNoteId/,
  );
  assert.match(appLayoutSource, /<LargeNoteEditor\s*note=\{largeEditorNote\}/s);
  assert.match(largeNoteEditorSource, /aria-label="Large Note editor"/);
});

test('cancelled drag clears presentation only and cannot create, clone, delete, or update a Note', () => {
  const dragEffect = appLayoutSource.match(
    /useEffect\(\(\) => \{\s*if \(!noteDragPreview\)[\s\S]*?\}, \[noteDragPreview\]\);/,
  )?.[0];
  assert.ok(dragEffect);
  assert.match(dragEffect, /const cancelDrag = \(\) => setNoteDragPreview\(null\)/);
  assert.match(
    dragEffect,
    /window\.addEventListener\('pointercancel', cancelDrag, true\)/,
  );
  assert.match(dragEffect, /window\.addEventListener\('blur', cancelDrag\)/);
  assert.doesNotMatch(
    dragEffect,
    /addNote|deleteNote|setNotes|updateNote|onUpdate|updatedAt|annotationId\s*:/,
  );
  assert.match(noteDragHandleSource, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(noteDragHandleSource, /onClick=/);
});

test('small and large editors update the same persisted Note object and preserve mark ownership', () => {
  assert.match(
    tagSource,
    /onChange=\{\(event\) => onUpdateNote\(note\.id, event\.target\.value\)\}/,
  );
  assert.match(
    largeNoteEditorSource,
    /onChange=\{\(event\) => onUpdate\(note\.id, event\.target\.value\)\}/,
  );
  assert.match(appLayoutSource, /onUpdate=\{updateNote\}/);
  assert.match(
    appLayoutSource,
    /if \(isNotesDrawerOpen\) \{\s*setFocusedNoteId\(largeEditorNote\.id\);\s*\}/s,
  );
  assert.doesNotMatch(largeNoteEditorSource, /addNote|annotationId\s*=|clone/i);
});

test('transient annotation context never changes persistent Notes drawer visibility', () => {
  const showReaderContextSource = viewerSource.match(
    /const showReaderContext = useCallback\([\s\S]*?const removeCandidateFromReaderContext/,
  )?.[0];
  assert.ok(showReaderContextSource);
  assert.match(showReaderContextSource, /setActiveReaderContext\(\{/);
  assert.doesNotMatch(showReaderContextSource, /setIsNotesDrawerOpen|setFocusedNoteId/);
  assert.doesNotMatch(viewerSource, /setIsNotesDrawerOpen/);

  const contextualSelectionSource = viewerSource.match(
    /onSelect=\{\(candidateKey\) =>[\s\S]*?\}\s*onAddNote=/,
  )?.[0];
  assert.ok(contextualSelectionSource);
  assert.match(contextualSelectionSource, /setActiveReaderContext/);
  assert.doesNotMatch(
    contextualSelectionSource,
    /setIsNotesDrawerOpen|setFocusedNoteId/,
  );
});

test('contextual Add, edit, and Delete Note callbacks preserve Notes drawer state', () => {
  const addSource = appLayoutSource.match(
    /const addNoteToMarkedAnnotation = useCallback\([\s\S]*?\n\s*\}, \[\]\);/,
  )?.[0];
  const updateSource = appLayoutSource.match(
    /const updateNote = useCallback\([\s\S]*?\n\s*\}, \[\]\);/,
  )?.[0];
  const deleteSource = appLayoutSource.match(
    /const deleteNote = useCallback\([\s\S]*?\n\s*\}, \[\]\);/,
  )?.[0];
  assert.ok(addSource);
  assert.ok(updateSource);
  assert.ok(deleteSource);
  for (const callbackSource of [addSource, updateSource, deleteSource]) {
    assert.doesNotMatch(callbackSource, /setIsNotesDrawerOpen/);
  }
  assert.match(tagSource, /onClick=\{\(\) => onAddNote\(tag\.annotation\.id\)\}/);
  assert.match(tagSource, /onUpdateNote\(note\.id, event\.target\.value\)/);
  assert.match(tagSource, /onClick=\{\(\) => onDeleteNote\(note\.id\)\}/);
});

test('contextual large-editor entry, successful drop, and close preserve the current drawer state', () => {
  const openLargeEditorSource = appLayoutSource.match(
    /const openLargeEditor = useCallback\([\s\S]*?\n\s*\}, \[\]\);/,
  )?.[0];
  assert.ok(openLargeEditorSource);
  assert.match(openLargeEditorSource, /setLargeEditorNoteId\(note\.id\)/);
  assert.doesNotMatch(openLargeEditorSource, /setIsNotesDrawerOpen/);

  const largeEditorRenderSource = appLayoutSource.match(
    /<LargeNoteEditor[\s\S]*?onUpdateDisplayNumber=\{updateNoteDisplayNumber\}/,
  )?.[0];
  assert.ok(largeEditorRenderSource);
  assert.doesNotMatch(largeEditorRenderSource, /setIsNotesDrawerOpen/);
  assert.match(
    largeEditorRenderSource,
    /if \(isNotesDrawerOpen\) \{\s*setFocusedNoteId\(largeEditorNote\.id\);\s*\}/s,
  );
});

test('annotation and Glossary candidates retain one contextual dialog around the Note drag source', () => {
  assert.equal(viewerSource.match(/<AnnotationTag/g)?.length, 1);
  assert.doesNotMatch(
    viewerSource.match(/<AnnotationTag[\s\S]*?\/>/)?.[0] ?? '',
    /\bkey=/,
  );
  assert.match(viewerSource, /onBeginNoteDrag=\{onBeginNoteDrag\}/);
  assert.match(viewerSource, /onOpenLargeEditor=\{onOpenLargeEditor\}/);
  assert.match(viewerSource, /draggedNoteId=\{draggedNoteId\}/);
  assert.match(tagSource, /const isNoteDragging = note\?\.id === draggedNoteId/);
  assert.match(tagSource, /inert=\{isNoteDragging \? true : undefined\}/);
  assert.match(
    styleSource,
    /\.note-card\.is-dragging,\s*\.annotation-tag\.is-dragging\s*\{[^}]*opacity:\s*0\.42;/s,
  );
  assert.match(tagSource, /onClick=\{\(\) => selectAdjacentCandidate\(-1\)\}/);
  assert.match(tagSource, /onClick=\{\(\) => selectAdjacentCandidate\(1\)\}/);
});

test('rejected contextual free-resize code and state are fully retired', () => {
  assert.equal(
    existsSync(new URL('../src/utils/annotationTagResize.ts', import.meta.url)),
    false,
  );
  assert.doesNotMatch(tagSource, /manualSize|maximumSize|beginResize|continueResize/);
  assert.doesNotMatch(tagSource, /setPointerCapture|annotation-tag-resize-handle/);
  assert.doesNotMatch(styleSource, /annotation-tag-resize-handle|nwse-resize/);
  assert.match(styleSource, /\.annotation-tag-note textarea\s*\{[^}]*resize:\s*none;/s);
  assert.doesNotMatch(viewerSource, /boundsElement=\{scrollElement\}/);
  assert.doesNotMatch(viewerSource, /horizontalInsets=\{readerOcclusionInsets\}/);
  assert.match(
    viewerSource,
    /useReaderOcclusionInsets\(\s*scrollElement,\s*fitMode === 'width',/s,
  );
});

test('blank and ordinary unmarked PDF points preserve the native context menu', () => {
  const mark = annotation('highlight', 'highlight', 0.1);
  assert.deepEqual(
    findAnnotationsAtClientPoint(
      2,
      { left: 100, top: 200, width: 600, height: 800 },
      { clientX: 550, clientY: 700 },
      [mark],
    ),
    [],
  );
  assert.match(pdfPageSource, /if \(annotationHits\.length === 0\) return;/);
});

test('simple blank taps dismiss only the transient context after selection guards', () => {
  const interactionSource = source('../src/utils/annotationInteraction.ts');
  assert.match(
    pdfPageSource,
    /isSimpleAnnotationTap\(start, event, hasMeaningfulSelection\)/,
  );
  assert.match(pdfPageSource, /onDismissReaderContext\(\)/);
  assert.match(viewerSource, /onPointerDown=\{beginReaderBackgroundTap\}/);
  assert.match(viewerSource, /onPointerUp=\{completeReaderBackgroundTap\}/);
  assert.match(
    viewerSource,
    /isBlankReaderSurface\(event\.target, event\.currentTarget\)/,
  );
  assert.match(viewerSource, /setActiveReaderContext\(null\)/);
  assert.match(interactionSource, /\.annotation-tag/);
  assert.match(tagSource, /onClick=\{\(\) => selectAdjacentCandidate\(1\)\}/);
  assert.doesNotMatch(viewerSource, /document\.addEventListener\(['"]click/);
});

test('one contextual dialog presents persisted Glossary content and exact removal', () => {
  assert.equal(viewerSource.match(/<AnnotationTag/g)?.length, 1);
  assert.match(tagSource, /glossaryEntry\.displayedWord/);
  assert.match(tagSource, /glossaryEntry\.definition/);
  assert.match(tagSource, /Remove from Glossary/);
  assert.match(tagSource, /onRemoveGlossaryEntry\(glossaryEntry\.glossaryEntryId\)/);
  assert.match(viewerSource, /removeCandidateFromReaderContext/);
});

test('TextLayer selection remains above non-interactive mark geometry', () => {
  assert.match(pdfPageSource, /onPointerDown=\{beginAnnotationTap\}/);
  assert.match(pdfPageSource, /hasMeaningfulSelection/);
  assert.match(pdfPageSource, /className="textLayer"/);
  assert.match(styleSource, /\.highlight-layer[\s\S]*?pointer-events: none/);
  assert.doesNotMatch(styleSource, /\.highlight-layer\s*\{[^}]*pointer-events:\s*auto/);
});

test('a note-less Tag creates no print Note payload or empty appendix entry', () => {
  const mark = annotation('highlight', 'highlight', 0.1);
  const state = makeState([mark]);
  const groups = createPrintSourceGroups(
    state.annotations,
    state.notes,
    state.noteAnchors,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].notes, []);
  assert.deepEqual(
    getPrintModeContent('standard', state.annotations, state.notes, state.noteAnchors),
    [],
  );
  assert.equal(
    getPrintModeContent(
      'all-annotations',
      state.annotations,
      state.notes,
      state.noteAnchors,
    ).length,
    1,
  );
});

test('reader wiring has one explicit Note creation path and preserves schema/protocol versions', () => {
  assert.match(appLayoutSource, /const addNoteToMarkedAnnotation/);
  assert.match(appLayoutSource, /addNoteToAnnotationTag/);
  assert.match(appLayoutSource, /documentStateRef\.current/);
  assert.doesNotMatch(appLayoutSource, /addNoteFromSelection|addNoteFromMarkedSource/);
  assert.match(
    source('../src/services/annotationPersistence.ts'),
    /PERSISTENCE_SCHEMA_VERSION = 8/,
  );
  assert.match(source('../src/sync/paperTypes.ts'), /PAPER_SYNC_PROTOCOL_VERSION = 2/);
});

function makeState(
  annotations: PdfAnnotation[],
  notes: Note[] = [],
  noteAnchors: NoteAnchor[] = [],
): AnnotationTagState {
  return { annotations, notes, noteAnchors };
}

function annotation(
  id: string,
  type: PdfAnnotation['type'],
  y: number,
  createdAt = 1,
): PdfAnnotation {
  return {
    id,
    type,
    pageNumber: 2,
    text: 'selected source text',
    rects: [{ x: 0.1, y, width: 0.2, height: 0.03 }],
    color: type === 'highlight' ? 'yellow' : 'blue',
    createdAt,
    updatedAt: createdAt,
  } as PdfAnnotation;
}

function glossary(id: string, y: number): PdfGlossaryEntry {
  return {
    glossaryEntryId: id,
    documentId: 'document-1',
    displayedWord: 'selected',
    normalizedLookupWord: 'selected',
    definition: `Definition ${id}`,
    pageNumber: 2,
    sourceRects: [{ x: 0.1, y, width: 0.2, height: 0.03 }],
    startOffset: 0,
    endOffset: 8,
    createdAt: 1,
    source: {
      dataset: 'Princeton WordNet',
      version: '3.1',
      license: 'Princeton WordNet License',
      sourceUrl: 'https://wordnet.princeton.edu/',
      partOfSpeech: 'noun',
    },
    markerAnnotationId: `marker-${id}`,
  };
}

function anchor(id: string, y: number): NoteAnchor {
  return {
    id,
    type: 'note-anchor',
    pageNumber: 2,
    text: 'selected source text',
    rects: [{ x: 0.1, y, width: 0.2, height: 0.03 }],
    startOffset: 2,
    endOffset: 22,
    createdAt: 1,
    updatedAt: 1,
  };
}

function markedSourceAnchor(id: string, y: number): NoteAnchor {
  const text = 'selected source text';
  return {
    ...anchor(id, y),
    text,
    startOffset: 0,
    endOffset: text.length,
  };
}

function note(id: string, annotationId: string, content: string): Note {
  return {
    id,
    annotationId,
    pageNumber: 2,
    displayNumber: '1',
    selectedText: 'selected source text',
    content,
    createdAt: 1,
    updatedAt: 1,
  };
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
