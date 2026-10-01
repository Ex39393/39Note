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
  createSemanticGlossaryEntry,
  getDefaultPrintLayout,
  getPrintContentItems,
  markDefinitionBubbleAdded,
  removeGlossaryEntry,
  sortGlossaryEntries,
  getPrintLayoutClass,
} from '../src/utils/glossaryModel.ts';
import { getGlossaryUnderlineColor, readingThemes, themes } from '../src/themes.ts';
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
import {
  clampDefinitionBubblePosition,
  getAnchoredDefinitionBubblePosition,
  normalizeDefinitionBubblePosition,
  resolveManualDefinitionBubblePosition,
} from '../src/utils/definitionBubblePosition.ts';
import { formatGlossaryEntryForPrint } from '../src/utils/glossaryPrint.ts';

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
const themeProviderSource = readFileSync(
  new URL('../src/components/ThemeProvider.tsx', import.meta.url),
  'utf8',
);
const themeCssSource = readFileSync(
  new URL('../src/styles/index.css', import.meta.url),
  'utf8',
);
const notesPanelSource = readFileSync(
  new URL('../src/components/NotesPanel.tsx', import.meta.url),
  'utf8',
);
const viewerSource = readFileSync(
  new URL('../src/components/Viewer.tsx', import.meta.url),
  'utf8',
);
const annotationTagSource = readFileSync(
  new URL('../src/components/pdf/AnnotationTag.tsx', import.meta.url),
  'utf8',
);
const pdfPageSource = readFileSync(
  new URL('../src/components/pdf/PdfPage.tsx', import.meta.url),
  'utf8',
);
const appLayoutSource = readFileSync(
  new URL('../src/components/AppLayout.tsx', import.meta.url),
  'utf8',
);
const printComposerEditorSource = readFileSync(
  new URL('../src/print/PrintComposerEditor.tsx', import.meta.url),
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

test('definition bubbles retain anchored placement until independently dragged', () => {
  const page = { width: 600, height: 800 };
  const bubble = { width: 286, height: 208 };
  const anchored = getAnchoredDefinitionBubblePosition(
    { x: 0.2, y: 0.3, width: 0.2, height: 0.03 },
    page,
    bubble,
  );
  assert.equal(anchored.left, 120);
  assert.ok(Math.abs(anchored.top - 274) < 0.001);

  const first = normalizeDefinitionBubblePosition({ left: 180, top: 300 }, page);
  const second = normalizeDefinitionBubblePosition({ left: 30, top: 60 }, page);
  assert.deepEqual(resolveManualDefinitionBubblePosition(first, page, bubble), {
    left: 180,
    top: 300,
  });
  assert.deepEqual(resolveManualDefinitionBubblePosition(second, page, bubble), {
    left: 30,
    top: 60,
  });
});

test('definition bubble movement and viewport resizing clamp every edge', () => {
  const page = { width: 600, height: 800 };
  const bubble = { width: 286, height: 208 };
  assert.deepEqual(
    clampDefinitionBubblePosition({ left: -500, top: -400 }, page, bubble),
    { left: 10, top: 10 },
  );
  assert.deepEqual(
    clampDefinitionBubblePosition({ left: 900, top: 900 }, page, bubble),
    { left: 304, top: 582 },
  );
  const manual = normalizeDefinitionBubblePosition({ left: 300, top: 580 }, page);
  const resized = resolveManualDefinitionBubblePosition(
    manual,
    { width: 380, height: 440 },
    bubble,
  );
  assert.deepEqual(resized, { left: 84, top: 222 });
});

test('definition bubbles use a dedicated pointer-captured handle without persisting drag state', () => {
  assert.match(definitionBubbleSource, /definition-bubble-drag-handle/);
  assert.match(definitionBubbleSource, /setPointerCapture/);
  assert.match(definitionBubbleSource, /releasePointerCapture/);
  assert.match(definitionBubbleSource, /onPointerCancel/);
  assert.match(definitionBubbleSource, /onLostPointerCapture/);
  assert.match(definitionBubbleSource, /definition-bubble-content/);
  assert.doesNotMatch(
    definitionBubbleSource,
    /localStorage|indexedDB|saveDefinitionBubble/,
  );
});

test('Glossary bubble actions use one wrapping, evenly spaced semantic control group', () => {
  assert.match(
    definitionBubbleSource,
    /className="definition-bubble-actions"[\s\S]*?className="definition-more-button"[\s\S]*?className="definition-remove-glossary"/,
  );
  assert.match(
    themeCssSource,
    /\.definition-bubble-actions\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:\s*var\(--gap-compact\);/s,
  );
  assert.match(
    themeCssSource,
    /\.definition-bubble-actions\s*>\s*button\s*\{[^}]*max-width:\s*100%;[^}]*min-height:\s*var\(--control-height-compact\);[^}]*padding:\s*4px 9px;[^}]*border-radius:\s*var\(--control-radius\);[^}]*font-size:\s*var\(--font-control\);[^}]*white-space:\s*normal;/s,
  );
  assert.match(
    themeCssSource,
    /\.definition-bubble \.definition-remove-glossary\s*\{[^}]*background:\s*var\(--destructive-bg\);[^}]*color:\s*var\(--destructive-text\);/s,
  );
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

test('exact Glossary deletion preserves marks, mark-owned Note, and duplicate spellings', () => {
  const highlight: PdfAnnotation = {
    id: 'ordinary-highlight',
    type: 'highlight',
    pageNumber: 1,
    text: 'term',
    rects: [{ x: 0.1, y: 0.1, width: 0.1, height: 0.02 }],
    color: 'yellow',
    createdAt: 1,
    updatedAt: 1,
  };
  const underline: PdfAnnotation = {
    ...highlight,
    id: 'ordinary-underline',
    type: 'underline',
    color: 'blue',
  };
  const markOwnedNote = {
    id: 'note-1',
    annotationId: underline.id,
    pageNumber: 1,
    displayNumber: '1',
    selectedText: 'term',
    content: 'Independent Note',
    createdAt: 1,
    updatedAt: 1,
  };
  const target = glossary('target', 1, 0.1, 0.1, 1);
  const sameDocument = glossary('same-document', 1, 0.1, 0.1, 2);
  const otherDocument = {
    ...glossary('other-document', 1, 0.1, 0.1, 3),
    documentId: 'document-2',
  };
  const annotations = [highlight, underline];
  const notes = [markOwnedNote];
  const result = removeGlossaryEntry(
    [target, sameDocument, otherDocument],
    annotations,
    target.glossaryEntryId,
  );

  assert.deepEqual(
    result.entries.map(({ glossaryEntryId }) => glossaryEntryId),
    ['same-document', 'other-document'],
  );
  assert.deepEqual(result.annotations, annotations);
  assert.deepEqual(notes, [markOwnedNote]);
});

test('Glossary add/reload/remove/reload round-trip stays document scoped', () => {
  const added = glossary('persisted-entry', 1, 0.1, 0.1, 1);
  const firstReload = sanitizePersistedGlossaryEntries(
    JSON.parse(JSON.stringify([added])),
    'document-1',
    'pdf',
  );
  assert.deepEqual(
    firstReload.map(({ glossaryEntryId }) => glossaryEntryId),
    ['persisted-entry'],
  );

  const removed = removeGlossaryEntry(firstReload, [], 'persisted-entry');
  const secondReload = sanitizePersistedGlossaryEntries(
    JSON.parse(JSON.stringify(removed.entries)),
    'document-1',
    'pdf',
  );
  assert.deepEqual(secondReload, []);

  const otherDocumentEntry = {
    ...added,
    glossaryEntryId: 'other-document-entry',
    documentId: 'document-2',
    markerAnnotationId: 'other-document-marker',
  };
  assert.equal(
    sanitizePersistedGlossaryEntries(
      JSON.parse(JSON.stringify([otherDocumentEntry])),
      'document-2',
      'pdf',
    )[0]?.glossaryEntryId,
    'other-document-entry',
  );
});

test('Reader removal UI uses exact identity and clears transient presentation state', () => {
  assert.match(notesPanelSource, />\s*Remove from Glossary\s*</);
  assert.match(annotationTagSource, /Remove from Glossary/);
  assert.match(definitionBubbleSource, /Remove from Glossary/);
  assert.match(
    definitionBubbleSource,
    /onRemoveFromGlossary\(persistedGlossaryEntryId\)/,
  );
  assert.match(
    annotationTagSource,
    /onRemoveGlossaryEntry\(glossaryEntry\.glossaryEntryId\)/,
  );
  assert.match(appLayoutSource, /candidate\.glossaryEntryId === glossaryEntryId/);
  assert.match(
    appLayoutSource,
    /documentStateRef\.current = \{[\s\S]*?glossaryEntries: result\.entries/,
  );
  assert.match(viewerSource, /glossaryEntryId: undefined/);
  assert.match(viewerSource, /addedConfirmationToken: undefined/);
  assert.match(pdfPageSource, /glossaryEntries\.flatMap\(\(entry\) =>/);
});

test('all seven themes expose a visible semantic marker colour', () => {
  const colors = readingThemes.map(getGlossaryUnderlineColor);
  assert.deepEqual(readingThemes, [
    'original',
    'soft-gray',
    'mint',
    'dark',
    'midnight',
    'twilight',
    'dawn',
  ]);
  assert.equal(colors.length, 7);
  assert.equal(new Set(colors).size, 7);
  assert.ok(colors.every((color) => /^#[0-9a-f]{6}$/i.test(color)));
});

test('Dawn, Twilight, and Mint expose complete differentiated semantic palettes', () => {
  const expectedSemanticKeys = [
    'accentActive',
    'accentBorderColor',
    'accentHover',
    'accentSoftFill',
    'cardBackground',
    'chipBackground',
    'chipSelectedBackground',
    'chipSelectedText',
    'destructiveColor',
    'dictionaryBackground',
    'dividerColor',
    'drawerBackground',
    'faintTextColor',
    'glossaryCardBackground',
    'informationalTint',
    'mainBackground',
    'navigationFocusColor',
    'noteFocusBackground',
    'secondaryAccentActive',
    'secondaryAccentColor',
    'secondaryAccentHover',
    'secondarySoftFill',
    'secondaryTextColor',
    'sectionBackground',
    'selectionToolbarActive',
    'selectionToolbarBackground',
    'strongerBorderColor',
    'toolbarBackground',
  ];

  for (const id of ['dawn', 'twilight', 'mint'] as const) {
    const theme = themes[id];
    const semantic = theme.semanticPalette;
    assert.ok(semantic, `${theme.label} should define its full semantic palette`);
    assert.deepEqual(Object.keys(semantic).sort(), expectedSemanticKeys);
    assert.ok(Object.values(semantic).every((color) => /^#[0-9a-f]{6}$/i.test(color)));
    assert.ok(
      new Set([
        theme.appBackground,
        semantic.mainBackground,
        semantic.sectionBackground,
        semantic.drawerBackground,
        semantic.cardBackground,
      ]).size >= 5,
      `${theme.label} should keep adjacent application surfaces distinct`,
    );
  }

  assert.equal(themes.mint.canvasFilter, 'none');
  assert.ok(
    relativeLuminance(themes.mint.appBackground) <
      relativeLuminance(themes.mint.surfaceBackground),
    'Mint should use a grounded surround and a lighter reading surface',
  );
  assert.ok(relativeLuminance(themes.dawn.appBackground) > 0.035);
  assert.ok(relativeLuminance(themes.twilight.appBackground) > 0.03);
});

test('semantic tokens drive app-owned UI without recolouring PDF or print output', () => {
  for (const token of [
    '--theme-card',
    '--theme-drawer',
    '--theme-dictionary',
    '--theme-selection-toolbar',
    '--theme-navigation-focus',
    '--theme-link',
    '--theme-divider',
  ]) {
    assert.match(themeProviderSource, new RegExp(token));
    assert.match(themeCssSource, new RegExp(token));
  }
  assert.doesNotMatch(noteExportSource, /data-reading-theme|--theme-/);
});

test('rebalanced themes retain practical reading and control contrast', () => {
  for (const id of ['dawn', 'twilight', 'mint'] as const) {
    const theme = themes[id];
    const semantic = theme.semanticPalette;
    assert.ok(semantic);

    assert.ok(contrastRatio(theme.textColor, theme.surfaceBackground) >= 6);
    assert.ok(
      contrastRatio(semantic.secondaryTextColor, semantic.drawerBackground) >= 4.5,
    );
    assert.ok(
      contrastRatio(semantic.secondaryTextColor, theme.inputBackground) >= 4.5,
      `${theme.label} secondary text should remain readable on controls`,
    );
    assert.ok(
      contrastRatio(semantic.faintTextColor, semantic.cardBackground) >= 4.5,
      `${theme.label} faint text should remain readable on cards`,
    );
    assert.ok(contrastRatio(semantic.chipSelectedText, theme.accentColor) >= 4.5);
    assert.ok(contrastRatio(theme.glossaryUnderlineColor, theme.pageBackground) >= 4.5);
  }
});

test('print layouts are explicit and Standard remains the default', () => {
  assert.deepEqual(notesPrintLayouts, [
    'standard',
    'space-saving',
    'extra-large',
    'all-annotations',
  ]);
  assert.equal(getDefaultPrintLayout(), 'standard');
  assert.equal(getPrintLayoutClass('standard'), 'print-layout-standard');
  assert.equal(getPrintLayoutClass('space-saving'), 'print-layout-space-saving');
  assert.equal(getPrintLayoutClass('extra-large'), 'print-layout-extra-large');
  assert.equal(getPrintLayoutClass('all-annotations'), 'print-layout-all-annotations');
});

test('Standard and Space-saving print styles remain unchanged', () => {
  assert.equal(getPrintLayoutCss('standard'), '');
  const compactCss = getPrintLayoutCss('space-saving');
  assert.match(compactCss, /margin: 12mm/);
  assert.match(compactCss, /font-size: 10pt/);
  assert.match(compactCss, /line-height: 1\.3/);
  assert.match(compactCss, /glossary-entry[^}]*font-size: 9\.5pt/);
  assert.doesNotMatch(compactCss, /print-layout-extra-large/);
});

test('Extra Large uses materially larger isolated typography', () => {
  const largeCss = getPrintLayoutCss('extra-large');
  assert.match(noteExportSource, /\.note-body \{[^}]*font-size: 12\.5pt/);
  assert.match(largeCss, /margin: 18mm/);
  assert.match(largeCss, /font-size: 16pt; line-height: 1\.5/);
  assert.match(largeCss, /document-title[^}]*font-size: 24pt/);
  assert.match(largeCss, /glossary-print-section h2[^}]*font-size: 20pt/);
  assert.match(largeCss, /glossary-entry[^}]*font-size: 16pt/);
  assert.doesNotMatch(largeCss, /print-layout-space-saving/);
});

test('the three existing print layouts retain identical Note and Glossary content', () => {
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
  const contentByLayout = notesPrintLayouts
    .slice(0, 3)
    .map(() => getPrintContentItems([note], [entry]));
  assert.deepEqual(contentByLayout[0], contentByLayout[1]);
  assert.deepEqual(contentByLayout[1], contentByLayout[2]);
  assert.equal(contentByLayout[2].notes[0].content, 'A long-form study note.');
  assert.equal(
    contentByLayout[2].glossaryEntries[0].definition,
    'Definition print-entry',
  );
});

test('printed Glossary entries are compact and keep one consolidated attribution', () => {
  const entry = {
    ...glossary('print-format', 37, 0.1, 0.1, 1),
    displayedWord: 'Reinforcement',
    definition:
      'A deliberately long definition that remains complete instead of being shortened for printing.',
  };
  const entryHtml = formatGlossaryEntryForPrint(entry);
  assert.equal(
    entryHtml,
    '<p class="glossary-entry"><strong>Reinforcement</strong>: A deliberately long definition that remains complete instead of being shortened for printing.</p>',
  );
  assert.doesNotMatch(entryHtml, /Page 37|Princeton|WordNet|License/);
  assert.doesNotMatch(entryHtml, /<h3>/);
  assert.match(noteExportSource, /getDictionaryAttributionText/);
  assert.match(noteExportSource, /dictionary-attribution/);
  assert.match(notesPanelSource, /Page \$\{entry\.pageNumber\}/);
  assert.doesNotMatch(
    printComposerEditorSource,
    /Page \$\{entry\.pageNumber\}.*entry\.source/,
  );
  assert.match(printComposerEditorSource, /term\.toggleFormat\('bold'\)/);
  assert.match(printComposerEditorSource, /glossary-attribution/);
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

test('Office Glossary entries persist semantic locations without PDF page fields', () => {
  const entry = createSemanticGlossaryEntry(
    'document-office',
    'Term',
    definitions[0],
    {
      version: 1,
      kind: 'docx-text',
      documentId: 'document-office',
      blockId: 'paragraph-4',
      blockIndex: 4,
      structuralPath: [4],
      quote: 'Term',
      prefix: 'A ',
      suffix: ' appears',
      startOffset: 2,
      endOffset: 6,
    },
    10,
    'semantic-entry',
  );
  const restored = sanitizePersistedGlossaryEntries(
    JSON.parse(JSON.stringify([entry])),
    'document-office',
    'docx',
  );

  assert.equal(restored.length, 1);
  assert.equal(restored[0].glossaryEntryId, entry.glossaryEntryId);
  assert.equal(restored[0].locationKind, 'semantic');
  assert.deepEqual(
    restored[0].locationKind === 'semantic' ? restored[0].anchor : null,
    entry.anchor,
  );
  assert.equal('pageNumber' in restored[0], false);
  assert.equal(
    sanitizePersistedGlossaryEntries([entry], 'document-office', 'pdf').length,
    0,
  );
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

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
