import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deduplicateDefinitions,
  extractEnglishLookupWord,
  getDictionaryShardKey,
  getSafeLookupCandidates,
  getVisibleDefinitions,
  moveDefinitionUp,
} from '../src/utils/dictionary.ts';
import {
  createGlossaryEntryFromBubble,
  getDefaultPrintLayout,
  getPrintContentItems,
  markDefinitionBubbleAdded,
  removeGlossaryEntry,
  sortGlossaryEntries,
  getPrintLayoutClass,
} from '../src/utils/glossaryModel.ts';
import { getGlossaryUnderlineColor } from '../src/themes.ts';
import {
  createIdempotentCleanup,
  getPrintLayoutCss,
} from '../src/utils/printSession.ts';
import { resolveInitialNavigation } from '../src/utils/initialNavigation.ts';
import { sanitizePersistedGlossaryEntries } from '../src/utils/glossaryPersistence.ts';
import {
  notesPrintLayouts,
  type DictionaryDefinition,
  type GlossaryEntry,
} from '../src/types/glossary.ts';
import type { DocumentOpenRequest } from '../src/types/documentOpen.ts';
import type { PdfAnnotation } from '../src/types/highlight.ts';

const source = {
  dataset: 'Princeton WordNet' as const,
  version: '3.1' as const,
  license: 'Princeton WordNet License' as const,
  sourceUrl: 'https://wordnet.princeton.edu/' as const,
  partOfSpeech: 'noun' as const,
};

const definitions: DictionaryDefinition[] = [
  { id: 'one', text: 'The first definition.', partOfSpeech: 'noun', source },
  { id: 'two', text: 'The second definition.', partOfSpeech: 'noun', source },
  { id: 'three', text: 'The third definition.', partOfSpeech: 'noun', source },
  { id: 'four', text: 'The fourth definition.', partOfSpeech: 'noun', source },
];

const addGlossaryFlowSource = getFunctionSource(
  readFileSync(new URL('../src/components/AppLayout.tsx', import.meta.url), 'utf8'),
  'const addGlossaryEntry',
  'const removeGlossaryEntry',
);
const definitionBubbleSource = readFileSync(
  new URL('../src/components/pdf/DefinitionBubble.tsx', import.meta.url),
  'utf8',
);
const noteExportSource = readFileSync(
  new URL('../src/utils/noteExport.ts', import.meta.url),
  'utf8',
);

test('punctuation trimming accepts one English lexical token', () => {
  assert.equal(extractEnglishLookupWord('“reinforcement,”'), 'reinforcement');
  assert.equal(extractEnglishLookupWord('(participant)'), 'participant');
  assert.equal(extractEnglishLookupWord("participant's"), "participant's");
  assert.equal(extractEnglishLookupWord('evidence-based'), 'evidence-based');
});

test('multi-word, numeric, punctuation, and empty selections are rejected', () => {
  for (const value of ['', '39', '...', 'two words', 'A full sentence.']) {
    assert.equal(extractEnglishLookupWord(value), null);
  }
});

test('safe lemmatization keeps exact first and handles restrained inflections', () => {
  assert.deepEqual(getSafeLookupCandidates('studies').slice(0, 2), [
    'studies',
    'study',
  ]);
  assert.ok(getSafeLookupCandidates('reinforced').includes('reinforce'));
  assert.ok(getSafeLookupCandidates('participants').includes('participant'));
  assert.ok(getSafeLookupCandidates("participant's").includes('participant'));
});

test('dictionary shards use the first two letters and a stable one-letter suffix', () => {
  assert.equal(getDictionaryShardKey('reinforcement'), 're');
  assert.equal(getDictionaryShardKey('A'), 'a_');
  assert.equal(getDictionaryShardKey("o'clock"), 'oc');
  assert.equal(getDictionaryShardKey('a-level'), 'al');
});

test('definition deduplication preserves stable source order', () => {
  const result = deduplicateDefinitions([
    definitions[0],
    { ...definitions[0], id: 'duplicate', text: '  The first definition. ' },
    definitions[1],
  ]);
  assert.deepEqual(
    result.map((definition) => definition.id),
    ['one', 'two'],
  );
});

test('definition promotion is immutable and cannot move the first definition', () => {
  const promoted = moveDefinitionUp(definitions, 'three');
  assert.deepEqual(
    promoted.map((definition) => definition.id),
    ['one', 'three', 'two', 'four'],
  );
  assert.deepEqual(
    definitions.map((definition) => definition.id),
    ['one', 'two', 'three', 'four'],
  );
  assert.deepEqual(
    moveDefinitionUp(definitions, 'one').map((definition) => definition.id),
    ['one', 'two', 'three', 'four'],
  );
});

test('collapsed definition display is limited to three senses', () => {
  assert.equal(getVisibleDefinitions(definitions, false).length, 3);
  assert.equal(getVisibleDefinitions(definitions, true).length, 4);
});

test('adding to Glossary stores only the currently first-ranked definition', () => {
  const reordered = moveDefinitionUp(moveDefinitionUp(definitions, 'three'), 'three');
  const entry = createGlossaryEntryFromBubble(
    'document-1',
    {
      id: 'bubble-1',
      documentId: 'document-1',
      pageNumber: 2,
      displayedWord: 'Term',
      normalizedLookupWord: 'term',
      rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.05 }],
      startOffset: 5,
      endOffset: 9,
      definitions: reordered,
      status: 'ready',
      isExpanded: false,
    },
    reordered[0],
    10,
    'glossary-1',
    'marker-1',
  );
  assert.equal(entry.definition, definitions[2].text);
  assert.equal(entry.markerAnnotationId, 'marker-1');
  assert.equal(entry.sourceRects[0].x, 0.1);
});

test('adding to Glossary leaves a closed or open drawer unchanged', () => {
  assert.match(addGlossaryFlowSource, /setGlossaryEntries/);
  assert.doesNotMatch(addGlossaryFlowSource, /setIsNotesDrawerOpen/);
});

test('adding to Glossary does not change Notes or Glossary expansion state', () => {
  assert.doesNotMatch(
    addGlossaryFlowSource,
    /setIsNotesSectionOpen|setIsGlossarySectionOpen/,
  );
});

test('successful Glossary addition marks the bubble for passive confirmation', () => {
  const bubble = {
    id: 'bubble-confirmation',
    documentId: 'document-1',
    pageNumber: 1,
    displayedWord: 'term',
    normalizedLookupWord: 'term',
    rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.03 }],
    startOffset: 1,
    endOffset: 5,
    definitions,
    status: 'ready' as const,
    isExpanded: false,
  };
  const updated = markDefinitionBubbleAdded(bubble, 'glossary-entry', 123);
  assert.equal(updated.glossaryEntryId, 'glossary-entry');
  assert.equal(updated.addedConfirmationToken, 123);
  assert.equal(bubble.glossaryEntryId, undefined);
  assert.match(definitionBubbleSource, /Added to Glossary/);
  assert.match(definitionBubbleSource, /aria-live="polite"/);
});

test('Glossary ordering is page, y, x, creation time, then id without mutation', () => {
  const entries = [
    glossary('b', 2, 0.2, 0.1, 1),
    glossary('c', 1, 0.3, 0.1, 2),
    glossary('a', 1, 0.1, 0.1, 3),
  ];
  assert.deepEqual(
    sortGlossaryEntries(entries).map((entry) => entry.glossaryEntryId),
    ['a', 'c', 'b'],
  );
  assert.deepEqual(
    entries.map((entry) => entry.glossaryEntryId),
    ['b', 'c', 'a'],
  );
});

test('Glossary deletion removes only the linked semantic marker', () => {
  const annotations: PdfAnnotation[] = [
    {
      id: 'ordinary-underline',
      type: 'underline',
      pageNumber: 1,
      text: 'term',
      rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }],
      color: 'blue',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const result = removeGlossaryEntry(
    [glossary('entry', 1, 0.1, 0.1, 1)],
    annotations,
    'entry',
  );
  assert.equal(result.entries.length, 0);
  assert.equal(result.removedMarkerId, 'marker-entry');
  assert.deepEqual(result.annotations, annotations);
});

test('all six themes expose a visible semantic marker colour', () => {
  const colors = ['original', 'soft-gray', 'dark', 'midnight', 'twilight', 'dawn'].map(
    getGlossaryUnderlineColor,
  );
  assert.equal(colors.length, 6);
  assert.equal(new Set(colors).size, 6);
  assert.ok(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
});

test('print layouts are explicit and Standard remains the default', () => {
  assert.deepEqual(notesPrintLayouts, ['standard', 'space-saving', 'extra-large']);
  assert.equal(getDefaultPrintLayout(), 'standard');
  assert.equal(getPrintLayoutClass('standard'), 'print-layout-standard');
  assert.equal(getPrintLayoutClass('space-saving'), 'print-layout-space-saving');
  assert.equal(getPrintLayoutClass('extra-large'), 'print-layout-extra-large');
});

test('Standard and Space-saving print styles remain unchanged', () => {
  assert.equal(getPrintLayoutCss('standard'), '');
  const compactCss = getPrintLayoutCss('space-saving');
  assert.match(compactCss, /margin: 12mm/);
  assert.match(compactCss, /font-size: 10pt/);
  assert.match(compactCss, /line-height: 1\.3/);
  assert.match(compactCss, /border-bottom-width: 0\.4pt/);
  assert.doesNotMatch(compactCss, /print-layout-extra-large/);
});

test('Extra Large uses materially larger isolated typography', () => {
  const largeCss = getPrintLayoutCss('extra-large');
  assert.match(noteExportSource, /\.note-body \{[^}]*font-size: 12\.5pt/);
  assert.match(largeCss, /margin: 18mm/);
  assert.match(largeCss, /font-size: 16pt; line-height: 1\.5/);
  assert.match(largeCss, /document-title[^}]*font-size: 24pt/);
  assert.match(largeCss, /glossary-print-section h2[^}]*font-size: 20pt/);
  assert.match(largeCss, /glossary-entry h3[^}]*font-size: 18pt/);
  assert.match(largeCss, /border-bottom-width: 0\.8pt/);
  assert.doesNotMatch(largeCss, /print-layout-space-saving/);
});

test('all print layouts contain identical Note and Glossary content', () => {
  const note = {
    id: 'note-1',
    annotationId: 'annotation-1',
    pageNumber: 2,
    displayNumber: 'Review',
    selectedText: 'Selected source text',
    content: 'A long-form study note.',
    createdAt: 1,
    updatedAt: 1,
  };
  const entry = glossary('print-entry', 3, 0.1, 0.1, 1);
  const contentByLayout = notesPrintLayouts.map(() =>
    getPrintContentItems([note], [entry]),
  );
  assert.deepEqual(contentByLayout[0], contentByLayout[1]);
  assert.deepEqual(contentByLayout[1], contentByLayout[2]);
  assert.equal(contentByLayout[2].notes[0].content, 'A long-form study note.');
  assert.equal(
    contentByLayout[2].glossaryEntries[0].definition,
    'Definition print-entry',
  );
});

test('print cleanup remains idempotent', () => {
  let calls = 0;
  const cleanup = createIdempotentCleanup(() => {
    calls += 1;
  });
  cleanup();
  cleanup();
  assert.equal(calls, 1);
});

test('a cleaned print session does not block an immediate second session', () => {
  let activeSessions = 0;
  const beginSession = () => {
    activeSessions += 1;
    return createIdempotentCleanup(() => {
      activeSessions -= 1;
    });
  };
  const closeFirstSession = beginSession();
  closeFirstSession();
  closeFirstSession();
  const closeSecondSession = beginSession();
  assert.equal(activeSessions, 1);
  closeSecondSession();
  assert.equal(activeSessions, 0);
});

test('Glossary navigation wins over saved position and stale navigation is ignored', () => {
  const request: DocumentOpenRequest = {
    requestId: 'glossary-request',
    documentId: 'document-1',
    source: 'document-glossary',
    target: { type: 'glossary', glossaryEntryId: 'entry-1', pageNumber: 4 },
    createdAt: 1,
    generation: 1,
    navigationEpoch: 7,
  };
  const input = {
    openRequest: request,
    activeRequestId: request.requestId,
    activeNavigationEpoch: 7,
    savedReadingPosition: {
      pageNumber: 20,
      pageOffsetRatio: 0.5,
      zoomMode: 'fit-width' as const,
      zoomPercent: 1,
      updatedAt: 1,
    },
    annotationLookupState: 'not-required' as const,
    documentReadyState: 'hydrated' as const,
    pageCount: 30,
  };
  assert.equal(resolveInitialNavigation(input)?.type, 'explicit-target');
  assert.equal(resolveInitialNavigation({ ...input, activeNavigationEpoch: 8 }), null);
});

test('backup validation preserves Glossary entries and marker links', () => {
  const entry = glossary('entry', 1, 0.1, 0.1, 1);
  const restored = sanitizePersistedGlossaryEntries(
    JSON.parse(JSON.stringify([entry])),
    'document-1',
  );
  assert.equal(restored[0].glossaryEntryId, 'entry');
  assert.equal(restored[0].markerAnnotationId, 'marker-entry');
});

function glossary(
  id: string,
  pageNumber: number,
  x: number,
  y: number,
  createdAt: number,
): GlossaryEntry {
  return {
    glossaryEntryId: id,
    documentId: 'document-1',
    displayedWord: `Word ${id}`,
    normalizedLookupWord: `word-${id}`,
    definition: `Definition ${id}`,
    pageNumber,
    sourceRects: [{ x, y, width: 0.1, height: 0.02 }],
    startOffset: 1,
    endOffset: 2,
    createdAt,
    source,
    markerAnnotationId: `marker-${id}`,
  };
}

function getFunctionSource(sourceText: string, start: string, end: string): string {
  const startIndex = sourceText.indexOf(start);
  const endIndex = sourceText.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return sourceText.slice(startIndex, endIndex);
}
