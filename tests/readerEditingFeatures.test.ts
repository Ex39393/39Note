import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import {
  defaultHighlightPalette,
  defaultUnderlinePalette,
  getHighlightColorOpaqueHex,
  getUnderlineColorOpaqueHex,
  normalizeHighlightColor,
  normalizeOpaqueHexColor,
  normalizeUnderlineColor,
  type PdfAnnotation,
} from '../src/types/highlight.ts';
import type { Note } from '../src/types/note.ts';
import type { NoteAnchor } from '../src/types/noteAnchor.ts';
import type { DocumentLink } from '../src/types/documentLink.ts';
import {
  connectDocumentLinkFromAnnotation,
  createUnpairedDocumentLinkFromAnnotation,
} from '../src/utils/documentLinks.ts';
import {
  MAX_READER_HISTORY_DOCUMENTS,
  MAX_READER_HISTORY_BYTES,
  MAX_READER_HISTORY_ENTRIES,
  ReaderHistoryStore,
  createReaderHistoryEntry,
  type ReaderEditableState,
  type ReaderHistoryEntry,
} from '../src/utils/readerHistory.ts';
import {
  addCustomAnnotationColor,
  defaultReaderAnnotationPalettes,
  findEquivalentAnnotationPaletteColor,
  readReaderAnnotationPalettes,
  readReaderStatusIndicatorDisplay,
  resolveReaderWarning,
  writeReaderAnnotationPalettes,
  writeReaderStatusIndicatorDisplay,
} from '../src/utils/readerPreferences.ts';
import {
  LEGACY_PAPER_SYNC_PROTOCOL_VERSION,
  PAPER_SYNC_PROTOCOL_VERSION,
  SYNC_LAYOUT_VERSION,
} from '../src/sync/paperTypes.ts';
import { PAPER_PRESENCE_PROTOCOL_VERSION } from '../src/sync/paperPresence.ts';
import {
  isPaperV3Protocol2RootMetadata,
  isPaperV3RootMetadata,
} from '../src/sync/paperRootValidation.ts';

const appLayoutSource = source('../src/components/AppLayout.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const annotationTagSource = source('../src/components/pdf/AnnotationTag.tsx');
const syncControlSource = source('../src/sync/PaperSyncControl.tsx');
const settingsSource = source('../src/components/HomeWorkspace.tsx');
const persistenceSource = source('../src/services/annotationPersistence.ts');

let server: ViteDevServer;
let persistence: typeof import('../src/services/annotationPersistence.ts');
let annotatedPdfExport: typeof import('../src/services/annotatedPdfExport.ts');
let localAdapter: typeof import('../src/sync/localAdapter.ts');

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
  [persistence, annotatedPdfExport, localAdapter] = await Promise.all([
    server.ssrLoadModule('/src/services/annotationPersistence.ts') as Promise<
      typeof persistence
    >,
    server.ssrLoadModule('/src/services/annotatedPdfExport.ts') as Promise<
      typeof annotatedPdfExport
    >,
    server.ssrLoadModule('/src/sync/localAdapter.ts') as Promise<typeof localAdapter>,
  ]);
});

after(async () => {
  await server.close();
});

test('opaque custom colors normalize canonically and reject unsupported formats', () => {
  assert.equal(normalizeOpaqueHexColor('#a1b2c3'), '#A1B2C3');
  assert.equal(normalizeHighlightColor('yellow'), 'yellow');
  assert.equal(normalizeUnderlineColor('blue'), 'blue');
  for (const invalid of [
    '#fff',
    '#A1B2C3FF',
    'A1B2C3',
    'rgb(1 2 3)',
    'transparent',
    ' #A1B2C3',
    '',
    null,
  ]) {
    assert.equal(normalizeOpaqueHexColor(invalid), null);
  }
});

test('four reusable slots displace defaults then oldest custom without visual duplicates', () => {
  let highlight = [...defaultHighlightPalette];
  for (const expected of [
    ['yellow', 'green', 'blue', '#112233'],
    ['yellow', 'green', '#112233', '#223344'],
    ['yellow', '#112233', '#223344', '#334455'],
    ['#112233', '#223344', '#334455', '#445566'],
    ['#223344', '#334455', '#445566', '#556677'],
  ]) {
    const custom = expected.at(-1)!;
    highlight = addCustomAnnotationColor(
      highlight,
      custom,
      defaultHighlightPalette,
      getHighlightColorOpaqueHex,
    );
    assert.deepEqual(highlight, expected);
    assert.equal(highlight.length, 4);
  }

  const defaults = [...defaultHighlightPalette];
  assert.deepEqual(
    addCustomAnnotationColor(
      defaults,
      '#ffe600',
      defaultHighlightPalette,
      getHighlightColorOpaqueHex,
    ),
    defaults,
  );
  assert.equal(
    findEquivalentAnnotationPaletteColor('highlight', defaults, '#FFE600'),
    'yellow',
  );
});

test('palette and status presentation preferences round-trip locally and default safely', () => {
  const storage = new MemoryStorage();
  assert.equal(readReaderStatusIndicatorDisplay(storage), 'full');
  writeReaderStatusIndicatorDisplay('compact', storage);
  assert.equal(readReaderStatusIndicatorDisplay(storage), 'compact');
  writeReaderStatusIndicatorDisplay('hidden', storage);
  assert.equal(readReaderStatusIndicatorDisplay(storage), 'hidden');

  const palettes = defaultReaderAnnotationPalettes();
  palettes.highlight = addCustomAnnotationColor(
    palettes.highlight,
    '#123abc',
    defaultHighlightPalette,
    getHighlightColorOpaqueHex,
  );
  palettes.underline = addCustomAnnotationColor(
    palettes.underline,
    '#fedcba',
    defaultUnderlinePalette,
    getUnderlineColorOpaqueHex,
  );
  writeReaderAnnotationPalettes(palettes, storage);
  assert.deepEqual(readReaderAnnotationPalettes(storage), {
    highlight: ['yellow', 'green', 'blue', '#123ABC'],
    underline: ['red', 'green', 'blue', '#FEDCBA'],
  });

  storage.setItem('39note.reader-status-indicator.v1', 'unsupported');
  storage.setItem(
    '39note.annotation-palettes.v1',
    JSON.stringify({ highlight: ['#123', 'yellow'], underline: ['#FFFFFFFF'] }),
  );
  assert.equal(readReaderStatusIndicatorDisplay(storage), 'full');
  assert.deepEqual(
    readReaderAnnotationPalettes(storage),
    defaultReaderAnnotationPalettes(),
  );
});

test('local persistence warning stays visible until it clears, then reveals export feedback', () => {
  const storageWarning = 'The latest Reader edit is not stored.';
  const exportWarning = 'The browser blocked the export.';
  assert.equal(resolveReaderWarning(storageWarning, exportWarning), storageWarning);
  assert.equal(resolveReaderWarning(storageWarning, null), storageWarning);
  assert.equal(resolveReaderWarning(null, exportWarning), exportWarning);
  assert.equal(resolveReaderWarning(null, null), null);
  assert.match(
    appLayoutSource,
    /const activeReaderWarning = resolveReaderWarning\(storageWarning, exportWarning\);/u,
  );
  assert.match(
    appLayoutSource,
    /\{activeReaderWarning \? \([\s\S]*?\{activeReaderWarning\}[\s\S]*?\) : null\}/u,
  );
});

test('custom colors remain exact through persistence-shaped JSON and validation', () => {
  const state = persistedState([
    annotation('highlight-custom', 'highlight', '#12ABEF'),
    annotation('underline-custom', 'underline', '#C03D91'),
    annotation('legacy-named', 'highlight', 'yellow'),
  ]);
  const restored = persistence.validateBackupDocumentState(
    JSON.parse(JSON.stringify(state)),
  );
  assert.ok(restored);
  assert.deepEqual(
    restored.annotations.map(({ id, color }) => [id, color]),
    [
      ['highlight-custom', '#12ABEF'],
      ['underline-custom', '#C03D91'],
      ['legacy-named', 'yellow'],
    ],
  );

  const lowercase = structuredClone(state);
  lowercase.annotations[0].color = '#12abef';
  assert.equal(
    persistence.validateBackupDocumentState(lowercase)?.annotations[0]?.color,
    '#12ABEF',
  );

  for (const invalid of ['#ABC', '#12ABEF80', 'rgb(18 171 239)']) {
    const malformed = structuredClone(state);
    malformed.annotations[0].color = invalid as PdfAnnotation['color'];
    assert.equal(persistence.validateBackupDocumentState(malformed), null);
  }
  assert.match(
    persistenceSource,
    /sanitizedAnnotations\.length\s*!==\s*annotations\.length/u,
  );
});

test('simulated sync entity serialization preserves exact custom colors and rejects malformed ones', () => {
  const highlight = annotation('sync-highlight', 'highlight', '#12ABEF');
  const underline = annotation('sync-underline', 'underline', '#C03D91');
  const records = syncRecords([highlight, underline]);
  const restored = localAdapter.validatedDocumentState(
    'paper-custom-colors',
    structuredClone(records),
  );
  assert.deepEqual(
    restored.annotations.map(({ id, color }) => [id, color]),
    [
      ['sync-highlight', '#12ABEF'],
      ['sync-underline', '#C03D91'],
    ],
  );

  const malformed = structuredClone(records);
  const record = malformed.find((candidate) => candidate.kind === 'annotation');
  assert.ok(record && typeof record.value === 'object' && record.value);
  (record.value as { color: string }).color = '#12ABEF80';
  assert.throws(
    () => localAdapter.validatedDocumentState('paper-custom-colors', malformed),
    /failed validation/u,
  );
});

test('annotated PDF export resolves exact custom RGB while named Link styling stays separate', () => {
  const highlight = annotatedPdfExport.resolveAnnotationExportColor(
    annotation('custom-highlight', 'highlight', '#123456'),
    true,
  );
  assert.equal(highlight.red, 0x12 / 255);
  assert.equal(highlight.green, 0x34 / 255);
  assert.equal(highlight.blue, 0x56 / 255);

  const underline = annotatedPdfExport.resolveAnnotationExportColor(
    annotation('custom-underline', 'underline', '#A0B1C2'),
    true,
  );
  assert.equal(underline.red, 0xa0 / 255);
  assert.equal(underline.green, 0xb1 / 255);
  assert.equal(underline.blue, 0xc2 / 255);
  assert.match(annotationTagSource, /annotation-tag-link-action/u);
  assert.match(annotationTagSource, />\s*Link\s*</u);
});

test('history atomically undoes and redoes annotation creation with exact custom color', () => {
  const before = editableState();
  const created = annotation('mark-custom', 'highlight', '#12ABEF');
  const after = { ...before, annotations: [created] };
  const entry = requiredEntry('paper-a', 'Create Highlight', before, after);
  const history = new ReaderHistoryStore();
  history.record(entry);

  const undo = requireApplication(history.prepareUndo('paper-a', after));
  assert.deepEqual(undo.state.annotations, []);
  assert.equal(history.commitUndo('paper-a', entry.id), true);

  const redo = requireApplication(history.prepareRedo('paper-a', undo.state));
  assert.deepEqual(redo.state.annotations, [created]);
  assert.equal(redo.state.annotations[0]?.color, '#12ABEF');
  assert.equal(history.commitRedo('paper-a', entry.id), true);
});

test('mark deletion with its Note and anchor is one reversible transaction', () => {
  const mark = annotation('mark-note', 'underline', '#C03D91');
  const anchor = noteAnchor(mark);
  const ownedNote = note('note-1', mark.id, 'Exact text');
  const before = {
    ...editableState(),
    annotations: [mark],
    noteAnchors: [anchor],
    notes: [ownedNote],
    nextNoteNumber: 2,
  };
  const after = { ...before, annotations: [], noteAnchors: [], notes: [] };
  const entry = requiredEntry('paper-a', 'Delete Underline', before, after);
  assert.equal(entry.deltas.length, 3);
  const restored = requireApplication(
    new ReaderHistoryStoreWith(entry).prepareUndo('paper-a', after),
  ).state;
  assert.deepEqual(restored.annotations, [mark]);
  assert.deepEqual(restored.noteAnchors, [anchor]);
  assert.deepEqual(restored.notes, [ownedNote]);
  assert.equal(restored.nextNoteNumber, 2);
});

test('adding and deleting a Note are independently reversible without reusing numbers', () => {
  const mark = annotation('mark-note-actions', 'highlight', 'yellow');
  const beforeAdd = { ...editableState(), annotations: [mark] };
  const addedNote = note('note-added', mark.id, '');
  const afterAdd = {
    ...beforeAdd,
    notes: [addedNote],
    nextNoteNumber: 2,
  };
  const addEntry = requiredEntry('paper-a', 'Add Note', beforeAdd, afterAdd);
  const addHistory = new ReaderHistoryStoreWith(addEntry);
  const withoutNote = requireApplication(
    addHistory.prepareUndo('paper-a', afterAdd),
  ).state;
  assert.deepEqual(withoutNote.notes, []);
  assert.equal(withoutNote.nextNoteNumber, 2);

  const deleteEntry = requiredEntry('paper-a', 'Delete Note', afterAdd, withoutNote);
  const deleteHistory = new ReaderHistoryStoreWith(deleteEntry);
  const restored = requireApplication(
    deleteHistory.prepareUndo('paper-a', withoutNote),
  ).state;
  assert.deepEqual(restored.notes, [addedNote]);
});

test('paired Link deletion restores both endpoints, identity, name, and visible number', () => {
  const markA = annotation('mark-a', 'highlight', 'yellow');
  const markB = annotation('mark-b', 'underline', 'blue');
  const first = createUnpairedDocumentLinkFromAnnotation({
    documentId: 'paper-a',
    annotation: markA,
    nextLinkNumber: 12,
    linkId: 'link-12',
    endpointId: 'endpoint-a',
    timestamp: 10,
  });
  assert.ok(first);
  const paired = connectDocumentLinkFromAnnotation(first.link, markB, {
    endpointId: 'endpoint-b',
    timestamp: 11,
  });
  assert.ok(paired);
  const named = { ...paired, name: 'Evidence chain' };
  const before = {
    ...editableState(),
    annotations: [markA, markB],
    links: [named],
    nextLinkNumber: 13,
  };
  const after = { ...before, links: [] };
  const entry = requiredEntry('paper-a', 'Delete Link', before, after);
  const restored = requireApplication(
    new ReaderHistoryStoreWith(entry).prepareUndo('paper-a', after),
  ).state;
  assert.deepEqual(restored.links, [named]);
  assert.deepEqual(restored.annotations, [markA, markB]);
  assert.equal(restored.nextLinkNumber, 13);
});

test('completing and renaming a Link each undo as one stable-record edit', () => {
  const markA = annotation('link-source-a', 'highlight', 'green');
  const markB = annotation('link-source-b', 'underline', 'black');
  const unpairedResult = createUnpairedDocumentLinkFromAnnotation({
    documentId: 'paper-a',
    annotation: markA,
    nextLinkNumber: 7,
    linkId: 'link-7',
    endpointId: 'endpoint-7a',
    timestamp: 40,
  });
  assert.ok(unpairedResult);
  const paired = connectDocumentLinkFromAnnotation(unpairedResult.link, markB, {
    endpointId: 'endpoint-7b',
    timestamp: 41,
  });
  assert.ok(paired);
  const beforePair = {
    ...editableState(),
    annotations: [markA, markB],
    links: [unpairedResult.link],
    nextLinkNumber: 8,
  };
  const afterPair = { ...beforePair, links: [paired] };
  const pairEntry = requiredEntry('paper-a', 'Complete Link', beforePair, afterPair);
  const unpairedAgain = requireApplication(
    new ReaderHistoryStoreWith(pairEntry).prepareUndo('paper-a', afterPair),
  ).state;
  assert.deepEqual(unpairedAgain.links, [unpairedResult.link]);

  const renamed = { ...paired, name: 'Result evidence', updatedAt: 42 };
  const renameEntry = requiredEntry('paper-a', 'Rename Link', afterPair, {
    ...afterPair,
    links: [renamed],
  });
  const nameRestored = requireApplication(
    new ReaderHistoryStoreWith(renameEntry).prepareUndo('paper-a', {
      ...afterPair,
      links: [renamed],
    }),
  ).state;
  assert.equal(nameRestored.links[0]?.id, paired.id);
  assert.equal(nameRestored.links[0]?.name, undefined);
});

test('Quick Link reuses the exact current mark geometry without changing the mark', () => {
  const mark = annotation('overlap-current', 'highlight', '#445566');
  mark.pageNumber = 7;
  mark.text = 'Exact selected passage';
  mark.rects = [
    { x: 0.11, y: 0.22, width: 0.33, height: 0.04 },
    { x: 0.11, y: 0.27, width: 0.19, height: 0.04 },
  ];
  const snapshot = structuredClone(mark);
  const created = createUnpairedDocumentLinkFromAnnotation({
    documentId: 'paper-a',
    annotation: mark,
    nextLinkNumber: 4,
    linkId: 'quick-link',
    endpointId: 'quick-endpoint-a',
    timestamp: 20,
  });
  assert.ok(created);
  assert.equal(created.link.endpointA.anchor.pageNumber, mark.pageNumber);
  assert.equal(created.link.endpointA.anchor.quote, mark.text);
  assert.deepEqual(created.link.endpointA.anchor.rects, mark.rects);
  assert.notEqual(created.link.endpointA.anchor.rects, mark.rects);
  assert.deepEqual(mark, snapshot);

  const paired = connectDocumentLinkFromAnnotation(
    created.link,
    annotation('second-mark', 'underline', 'red'),
    { endpointId: 'quick-endpoint-b', timestamp: 21 },
  );
  assert.ok(paired);
  assert.equal(connectDocumentLinkFromAnnotation(paired, mark), null);
});

test('Quick Link creation is undoable without removing the source mark or lowering high-water', () => {
  const mark = annotation('source-mark', 'highlight', 'green');
  const before = {
    ...editableState(),
    annotations: [mark],
    nextLinkNumber: 12,
  };
  const result = createUnpairedDocumentLinkFromAnnotation({
    documentId: 'paper-a',
    annotation: mark,
    nextLinkNumber: 12,
    linkId: 'link-12',
    endpointId: 'endpoint-12a',
    timestamp: 30,
  });
  assert.ok(result);
  const after = {
    ...before,
    links: [result.link],
    nextLinkNumber: result.nextLinkNumber,
  };
  const entry = requiredEntry('paper-a', 'Create Link from annotation', before, after);
  const history = new ReaderHistoryStoreWith(entry);
  const undone = requireApplication(history.prepareUndo('paper-a', after)).state;
  assert.deepEqual(undone.annotations, [mark]);
  assert.deepEqual(undone.links, []);
  assert.equal(undone.nextLinkNumber, 13);
});

test('Note typing coalesces, blur keys split groups, and a new edit clears Redo', () => {
  const original = {
    ...editableState(),
    notes: [note('note-1', 'mark-1', '')],
  };
  const typedA = withNoteContent(original, 'a', 2);
  const typedAB = withNoteContent(typedA, 'ab', 3);
  const typedABC = withNoteContent(typedAB, 'abc', 4);
  const history = new ReaderHistoryStore();
  const first = requiredEntry('paper-a', 'Edit Note', original, typedA, {
    id: 'edit-a',
    coalesceKey: 'note:note-1:0',
    timestamp: 100,
  });
  const second = requiredEntry('paper-a', 'Edit Note', typedA, typedAB, {
    id: 'edit-b',
    coalesceKey: 'note:note-1:0',
    timestamp: 200,
  });
  const third = requiredEntry('paper-a', 'Edit Note', typedAB, typedABC, {
    id: 'edit-c',
    coalesceKey: 'note:note-1:1',
    timestamp: 300,
  });
  history.record(first);
  history.record(second);
  assert.equal(history.counts('paper-a').undo, 1);
  history.record(third);
  assert.equal(history.counts('paper-a').undo, 2);

  const undo = requireApplication(history.prepareUndo('paper-a', typedABC));
  assert.equal(undo.state.notes[0]?.content, 'ab');
  assert.equal(history.commitUndo('paper-a', third.id), true);
  assert.equal(history.counts('paper-a').redo, 1);

  const replacement = withNoteContent(undo.state, 'ab-new', 5);
  history.record(
    requiredEntry('paper-a', 'Edit Note', undo.state, replacement, {
      coalesceKey: 'note:note-1:2',
      timestamp: 400,
    }),
  );
  assert.equal(history.counts('paper-a').redo, 0);
});

test('Glossary add, edit-shaped replacement, and removal deltas are reversible', () => {
  const entry = glossaryEntry('glossary-1', 'First definition');
  const empty = editableState();
  const added = { ...empty, glossaryEntries: [entry] };
  const addHistory = new ReaderHistoryStoreWith(
    requiredEntry('paper-a', 'Add Glossary entry', empty, added),
  );
  assert.deepEqual(
    requireApplication(addHistory.prepareUndo('paper-a', added)).state.glossaryEntries,
    [],
  );

  const editedEntry = { ...entry, definition: 'Revised definition' };
  const edited = { ...added, glossaryEntries: [editedEntry] };
  const editHistory = new ReaderHistoryStoreWith(
    requiredEntry('paper-a', 'Edit Glossary entry', added, edited),
  );
  assert.deepEqual(
    requireApplication(editHistory.prepareUndo('paper-a', edited)).state
      .glossaryEntries,
    [entry],
  );

  const removeHistory = new ReaderHistoryStoreWith(
    requiredEntry('paper-a', 'Remove Glossary entry', edited, empty),
  );
  assert.deepEqual(
    requireApplication(removeHistory.prepareUndo('paper-a', empty)).state
      .glossaryEntries,
    [editedEntry],
  );
});

test('history is document-scoped, bounded, and rejects stale authoritative state', () => {
  const history = new ReaderHistoryStore();
  let state = editableState();
  for (let index = 0; index < MAX_READER_HISTORY_ENTRIES + 12; index += 1) {
    const next = {
      ...state,
      annotations: [annotation(`mark-${index}`, 'highlight', 'yellow')],
    };
    history.record(requiredEntry('paper-a', `Edit ${index}`, state, next));
    state = next;
  }
  assert.equal(history.counts('paper-a').undo, MAX_READER_HISTORY_ENTRIES);
  assert.ok(history.counts('paper-a').bytes <= MAX_READER_HISTORY_BYTES);
  assert.equal(history.counts('paper-b').undo, 0);

  for (let index = 0; index < MAX_READER_HISTORY_DOCUMENTS + 2; index += 1) {
    const next = {
      ...editableState(),
      annotations: [annotation(`d-${index}`, 'highlight', 'blue')],
    };
    history.record(requiredEntry(`document-${index}`, 'Edit', editableState(), next));
  }
  assert.equal(history.counts('document-0').undo, 0);

  const clean = editableState();
  const local = { ...clean, notes: [note('stale-note', 'mark-1', 'local')] };
  const staleEntry = requiredEntry('stale-paper', 'Add Note', clean, local);
  const staleHistory = new ReaderHistoryStoreWith(staleEntry);
  const remotelyChanged = {
    ...local,
    notes: [{ ...local.notes[0], content: 'remote', updatedAt: 99 }],
  };
  assert.deepEqual(staleHistory.prepareUndo('stale-paper', remotelyChanged), {
    ok: false,
    reason: 'stale-state',
  });
});

test('Reader shortcut ownership and persistence sequencing are explicit in source', () => {
  assert.match(appLayoutSource, /key === 'z'[\s\S]*?'redo'[\s\S]*?'undo'/u);
  assert.match(appLayoutSource, /key === 'y'[\s\S]*?'redo'/u);
  assert.match(appLayoutSource, /event\.isComposing/u);
  assert.match(appLayoutSource, /isPrintComposerOpen/u);
  assert.match(appLayoutSource, /getReaderHistoryTextInput\(event\.target\)/u);
  assert.match(appLayoutSource, /isEditableElement\(event\.target\) && !noteEditor/u);
  assert.match(appLayoutSource, /await readerPersistenceQueueRef\.current/u);
  assert.match(
    appLayoutSource,
    /const saved = await persistCurrentDocument\(\)[\s\S]*?if \(!saved\)[\s\S]*?const committed =[\s\S]*?commitUndo/u,
  );
  assert.match(annotationTagSource, /data-reader-history-input="note"/u);
});

test('status modes and permanent fifth color action are wired without disabling sync', () => {
  assert.match(settingsSource, /\['full', 'compact', 'hidden'\]/u);
  assert.match(syncControlSource, /if \(display === 'hidden'\) return null/u);
  assert.match(syncControlSource, /coordinator\.subscribe\(setState\)/u);
  assert.match(syncControlSource, /coordinator\.initialize\(\)/u);
  assert.match(syncControlSource, /display === 'compact' \? 'visually-hidden'/u);
  assert.match(selectionActionSource, /type="color"/u);
  assert.match(selectionActionSource, /highlight-color-picker/u);
  assert.match(
    selectionActionSource,
    /className="highlight-color-picker"[\s\S]*?onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/u,
  );
  assert.match(selectionActionSource, /Reset default colours/u);
  assert.match(selectionActionSource, /colorPalette\.map/u);
});

test('protocol-3 root remains a fail-closed boundary for the released protocol-2 reader', () => {
  assert.equal(LEGACY_PAPER_SYNC_PROTOCOL_VERSION, 2);
  assert.equal(PAPER_SYNC_PROTOCOL_VERSION, 3);
  const root = {
    id: 'root',
    name: '39Note',
    mimeType: 'application/vnd.google-apps.folder',
    ownedByMe: true,
    appProperties: {
      application: '39Note',
      role: 'root',
      layoutVersion: String(SYNC_LAYOUT_VERSION),
      paperProtocolVersion: String(PAPER_SYNC_PROTOCOL_VERSION),
      presenceProtocolVersion: String(PAPER_PRESENCE_PROTOCOL_VERSION),
      controlFolderId: 'control-folder',
      migrationCompletionId: 'a'.repeat(64),
      protocolMigrationCompletionId: 'b'.repeat(64),
    },
  };
  assert.equal(isPaperV3RootMetadata(root), true);
  assert.equal(isPaperV3Protocol2RootMetadata(root), false);
});

function editableState(): ReaderEditableState {
  return {
    annotations: [],
    links: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    nextLinkNumber: 1,
  };
}

function annotation(
  id: string,
  type: 'highlight' | 'underline',
  color: PdfAnnotation['color'],
): PdfAnnotation {
  return {
    id,
    type,
    pageNumber: 1,
    text: `Text for ${id}`,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    color,
    createdAt: 1,
    updatedAt: 1,
  } as PdfAnnotation;
}

function note(id: string, annotationId: string, content: string): Note {
  return {
    id,
    annotationId,
    pageNumber: 1,
    displayNumber: '1',
    selectedText: 'Selected text',
    content,
    createdAt: 1,
    updatedAt: 1,
  };
}

function noteAnchor(mark: PdfAnnotation): NoteAnchor {
  return {
    id: mark.id,
    type: 'note-anchor',
    pageNumber: mark.pageNumber,
    text: mark.text,
    rects: structuredClone(mark.rects),
    startOffset: 0,
    endOffset: mark.text.length,
    createdAt: mark.createdAt,
    updatedAt: mark.updatedAt,
  };
}

function glossaryEntry(
  id: string,
  definition: string,
): ReaderEditableState['glossaryEntries'][number] {
  return {
    glossaryEntryId: id,
    documentId: 'paper-a',
    displayedWord: 'term',
    normalizedLookupWord: 'term',
    definition,
    createdAt: 1,
    source: {
      dataset: 'Princeton WordNet',
      version: '3.1',
      license: 'Princeton WordNet License',
      sourceUrl: 'https://wordnet.princeton.edu/',
      partOfSpeech: 'noun',
    },
    pageNumber: 1,
    sourceRects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.04 }],
    startOffset: 0,
    endOffset: 4,
    markerAnnotationId: 'marker-1',
  };
}

function withNoteContent(
  state: ReaderEditableState,
  content: string,
  updatedAt: number,
): ReaderEditableState {
  return {
    ...state,
    notes: state.notes.map((item) => ({ ...item, content, updatedAt })),
  };
}

function requiredEntry(
  documentId: string,
  label: string,
  before: ReaderEditableState,
  after: ReaderEditableState,
  options: { id?: string; coalesceKey?: string; timestamp?: number } = {},
): ReaderHistoryEntry {
  const entry = createReaderHistoryEntry(documentId, label, before, after, options);
  assert.ok(entry);
  return entry;
}

function requireApplication(result: ReturnType<ReaderHistoryStore['prepareUndo']>) {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.application;
}

class ReaderHistoryStoreWith extends ReaderHistoryStore {
  constructor(entry: ReaderHistoryEntry) {
    super();
    this.record(entry);
  }
}

function persistedState(annotations: PdfAnnotation[]) {
  return {
    schemaVersion: 9,
    documentType: 'pdf',
    documentId: 'paper-custom-colors',
    documentName: 'Custom colors.pdf',
    originalFileName: 'Custom colors.pdf',
    displayTitle: 'Custom colors',
    annotations,
    links: [] as DocumentLink[],
    officeAnnotations: [],
    noteAnchors: [],
    notes: [],
    glossaryEntries: [],
    nextNoteNumber: 1,
    nextLinkNumber: 1,
    updatedAt: 1,
    collectionIds: [],
    isPinned: false,
  };
}

function syncRecords(annotations: PdfAnnotation[]) {
  const version = {
    updatedAt: 1,
    deviceId: 'test-device',
    hash: 'a'.repeat(64),
  };
  return [
    {
      key: 'document::paper-custom-colors',
      kind: 'document' as const,
      id: 'paper-custom-colors',
      value: {
        schemaVersion: 9,
        documentType: 'pdf',
        documentId: 'paper-custom-colors',
        documentName: 'Custom colors.pdf',
        originalFileName: 'Custom colors.pdf',
        displayTitle: 'Custom colors',
        nextNoteNumber: 1,
        collectionIds: [],
        isPinned: false,
      },
      version,
    },
    ...annotations.map((value) => ({
      key: `annotation:paper-custom-colors:${value.id}`,
      kind: 'annotation' as const,
      id: value.id,
      documentId: 'paper-custom-colors',
      value,
      version,
    })),
    {
      key: 'link-number-high-water:paper-custom-colors:link-numbers',
      kind: 'link-number-high-water' as const,
      id: 'link-numbers',
      documentId: 'paper-custom-colors',
      value: {
        version: 1,
        type: 'link-number-high-water',
        documentId: 'paper-custom-colors',
        nextLinkNumber: 1,
      },
      version,
    },
  ];
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
