import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViteDevServer } from 'vite';
import { getProviderKeyGuidance } from '../src/ai/providerGuidance.ts';
import type { AiProviderId } from '../src/ai/types.ts';
import { readingThemes, themes } from '../src/themes.ts';
import {
  resolveLibraryScrollContainer,
  scrollLibraryContainerToTop,
} from '../src/utils/libraryScroll.ts';
import {
  clearWorkspaceNavigationHandoff,
  peekWorkspaceReloadDestination,
  rememberDriveAfterWorkspaceReload,
} from '../src/utils/workspaceNavigationHandoff.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const expectedSections = [
  ['home', 'Home'],
  ['library', 'Library'],
  ['collections', 'Collections'],
  ['theme', 'Theme'],
  ['ai', 'AI'],
  ['drive', 'Google Drive'],
  ['settings', 'Settings'],
] as const;

let server: ViteDevServer;
let homeUi: typeof import('../src/components/HomeWorkspace.tsx');
let notesUi: typeof import('../src/components/NotesPanel.tsx');
let collectionEditor: typeof import('../src/components/collectionEditorModel.ts');
let collectionViews: typeof import('../src/components/CollectionWorkspaceViews.tsx');

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
  homeUi = (await server.ssrLoadModule(
    '/src/components/HomeWorkspace.tsx',
  )) as typeof import('../src/components/HomeWorkspace.tsx');
  notesUi = (await server.ssrLoadModule(
    '/src/components/NotesPanel.tsx',
  )) as typeof import('../src/components/NotesPanel.tsx');
  collectionEditor = (await server.ssrLoadModule(
    '/src/components/collectionEditorModel.ts',
  )) as typeof import('../src/components/collectionEditorModel.ts');
  collectionViews = (await server.ssrLoadModule(
    '/src/components/CollectionWorkspaceViews.tsx',
  )) as typeof import('../src/components/CollectionWorkspaceViews.tsx');
});

after(async () => server.close());

test('the floating Home entry point has an accessible name and compact icon', () => {
  const markup = renderToStaticMarkup(
    createElement(homeUi.HomeFloatingButton, { onClick: () => undefined }),
  );

  assert.match(markup, /^<button[^>]*aria-label="Home"[^>]*>/u);
  assert.match(markup, /<button[^>]*title="Home"[^>]*type="button"[^>]*>/u);
  assert.match(markup, /<svg aria-hidden="true"/u);
  assert.doesNotMatch(markup, />\s*Home\s*</u);
});

test('workspace reload preserves only a fresh one-shot Drive UI destination', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage,
  });
  try {
    rememberDriveAfterWorkspaceReload(1_000);
    assert.equal(peekWorkspaceReloadDestination(1_000), 'drive');
    assert.equal(peekWorkspaceReloadDestination(61_000), 'drive');
    assert.equal(peekWorkspaceReloadDestination(61_001), null);
    clearWorkspaceNavigationHandoff();
    assert.equal(peekWorkspaceReloadDestination(1_000), null);

    storage.setItem('39note-workspace-navigation-handoff-v1', '{"version":2}');
    assert.equal(peekWorkspaceReloadDestination(1_000), null);
  } finally {
    if (previousStorage) {
      Object.defineProperty(globalThis, 'sessionStorage', previousStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  }
});

test('Home uses an accessible icon-only Back action', () => {
  const markup = renderToStaticMarkup(
    createElement(
      homeUi.HomeWorkspace,
      {
        activeSection: 'home',
        isOpen: true,
        onReturnToReader: () => undefined,
        onSectionChange: () => undefined,
      },
      createElement('p', null, 'Home content'),
    ),
  );

  const backButton = markup.match(
    /<button(?=[^>]*aria-label="Back to reader")(?=[^>]*class="home-back-button")[^>]*>([\s\S]*?)<\/button>/u,
  );
  assert.ok(backButton, 'Home should expose its Back action in the header');
  assert.match(backButton[0], /title="Back to reader"/u);
  assert.match(backButton[1], /<svg aria-hidden="true"/u);
  assert.doesNotMatch(backButton[1], /Back|Reader/u);
});

test('Home exposes each explicit destination and identifies only the current page', () => {
  const markup = renderToStaticMarkup(
    createElement(
      homeUi.HomeWorkspace,
      {
        activeSection: 'theme',
        isOpen: true,
        onReturnToReader: () => undefined,
        onSectionChange: () => undefined,
      },
      createElement('p', null, 'Compact home content'),
    ),
  );
  const navigation = markup.match(
    /<nav[^>]*aria-label="Home sections"[^>]*>([\s\S]*?)<\/nav>/u,
  )?.[1];
  assert.ok(navigation, 'Home section navigation should be rendered');

  const buttons = [...navigation.matchAll(/<button([^>]*)>([^<]+)<\/button>/gu)];
  assert.deepEqual(
    buttons.map((match) => match[2]),
    expectedSections.map(([, label]) => label),
  );
  assert.equal(
    buttons.filter((match) => /aria-current="page"/u.test(match[1])).length,
    1,
  );
  assert.match(navigation, /<button[^>]*aria-current="page"[^>]*>Theme<\/button>/u);
  assert.match(markup, /data-home-section="theme"/u);
  assert.match(markup, /class="home-workspace is-open"/u);
  assert.match(markup, /data-motion-state="open"/u);
  assert.equal(markup.match(/Compact home content/gu)?.length, 1);

  const closedMarkup = renderToStaticMarkup(
    createElement(
      homeUi.HomeWorkspace,
      {
        activeSection: 'home',
        isOpen: false,
        onReturnToReader: () => undefined,
        onSectionChange: () => undefined,
      },
      createElement('p', null, 'Inactive content'),
    ),
  );
  assert.equal(closedMarkup, '');
});

test('the Home landing page stays compact and theme choices are real controls', () => {
  const landingMarkup = renderToStaticMarkup(
    createElement(homeUi.HomeLandingPage, {
      onOpenCollections: () => undefined,
      onOpenDrive: () => undefined,
      onOpenLibrary: () => undefined,
      onOpenOfficeConverter: () => undefined,
    }),
  );
  const summary = landingMarkup.match(
    /<div class="home-summary-grid">([\s\S]*?)<\/div>/u,
  )?.[1];
  assert.ok(summary, 'Home should include the compact summary grid');
  assert.equal(summary.match(/<button type="button">/gu)?.length, 3);
  assert.match(landingMarkup, /aria-label="Recently opened papers"/u);
  assert.match(landingMarkup, /Convert Word \/ PowerPoint to PDF/u);
  assert.match(landingMarkup, /Convert it to a normal 39Note PDF locally/u);

  const themeMarkup = renderToStaticMarkup(createElement(homeUi.ThemeHomePage));
  assert.equal(readingThemes.length, 10);
  for (const themeId of readingThemes) {
    assert.match(themeMarkup, new RegExp(`>${themes[themeId].label}<`, 'u'));
  }
  assert.equal(
    themeMarkup.match(/class="theme-preview-card"/gu)?.length,
    readingThemes.length,
  );
  assert.equal(themeMarkup.match(/aria-pressed="true"/gu)?.length, 1);
  assert.equal(
    themeMarkup.match(/aria-pressed="false"/gu)?.length,
    readingThemes.length - 1,
  );
  assert.match(themeMarkup, /aria-pressed="true"[^>]*[\s\S]*?>Original</u);
  assert.match(themeMarkup, /linear-gradient\(145deg, #061D2B/u);
  assert.match(themeMarkup, /background:#BCEBFA/u);
  assert.match(themeMarkup, /linear-gradient\(135deg, #99FFFF/u);
});

test('the Home section model, Reader toolbar, and mounted Reader shell stay separated', () => {
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const toolbarSource = source('../src/components/Toolbar.tsx');
  const appSource = source('../src/components/AppLayout.tsx');
  const cssSource = source('../src/styles/index.css');

  const sectionType = homeSource.match(/export type HomeSection =([\s\S]*?);/u)?.[1];
  assert.ok(sectionType, 'HomeSection should remain explicit');
  assert.deepEqual(
    [...sectionType.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    expectedSections.map(([id]) => id),
  );

  const navigationModel = homeSource.match(
    /const NAVIGATION:[\s\S]*?= \[([\s\S]*?)\];/u,
  )?.[1];
  assert.ok(
    navigationModel,
    'Home navigation should have a declarative destination model',
  );
  assert.deepEqual(
    [...navigationModel.matchAll(/\{ id: '([^']+)', label: '([^']+)' \}/gu)].map(
      (match) => [match[1], match[2]],
    ),
    expectedSections.map((entry) => [...entry]),
  );

  assert.doesNotMatch(toolbarSource, />\s*(?:Library|Theme|AI settings)\s*</u);
  assert.doesNotMatch(
    toolbarSource,
    /onOpen(?:Library|Theme|AiSettings)|onCycleTheme/u,
  );
  const zoomOut = toolbarSource.match(
    /<button(?=[^>]*aria-label="Zoom out")[^>]*>([\s\S]*?)<\/button>/u,
  )?.[1];
  const zoomIn = toolbarSource.match(
    /<button(?=[^>]*aria-label="Zoom in")[^>]*>([\s\S]*?)<\/button>/u,
  )?.[1];
  assert.equal(zoomOut?.trim(), '−');
  assert.equal(zoomIn?.trim(), '+');

  assert.equal(appSource.match(/<Viewer\b/gu)?.length, 1);
  assert.match(appSource, /className=\{`reader-workspace \$\{/u);
  assert.match(appSource, /applicationView === 'home' \? 'is-home-covered' : ''/u);
  assert.doesNotMatch(appSource, /applicationView === 'reader'\s*\?\s*\(?\s*<Viewer/u);

  assert.match(
    appSource,
    /applicationView === 'reader'\s*\?\s*\(\s*<>\s*<HomeFloatingButton/u,
  );
  assert.match(
    appSource,
    /applicationView === 'reader'[\s\S]*?<PaperReaderSyncStatus[\s\S]*?affectedDocumentIds\?\.length[\s\S]*?openDriveUpdateReview\(affectedDocumentIds\)[\s\S]*?openDriveManagement\(\)/u,
  );
  assert.match(
    appSource,
    /<PaperRemoteUpdateLayer\s*isReaderActive=\{applicationView === 'reader'\}/u,
  );
  assert.match(appSource, /onReviewUpdates=\{openDriveUpdateReview\}/u);
  assert.match(
    appSource,
    /onReturnToReader=\{\(\) => setApplicationView\('reader'\)\}/u,
  );
  assert.match(
    appSource,
    /workspaceReloadDestination === 'drive' \? 'home' : 'reader'/u,
  );
  assert.match(
    appSource,
    /rememberDriveAfterWorkspaceReload[\s\S]*?39note:workspace-changing/u,
  );
  assert.match(appSource, /clearWorkspaceNavigationHandoff\(\)/u);

  const openHomeSection = appSource.match(
    /const openHomeSection = useCallback\(\(section: HomeSection\) => \{([\s\S]*?)\n\s*\}, \[\]\);/u,
  )?.[1];
  assert.ok(openHomeSection, 'Home navigation should have one explicit entry point');
  assert.doesNotMatch(
    openHomeSection,
    /set(?:File|CurrentPage|Zoom|EffectiveZoom|FitMode|PdfDocument)/u,
  );

  const coveredReaderRule = cssSource.match(
    /\.reader-workspace\.is-home-covered\s*\{([^}]*)\}/u,
  )?.[1];
  assert.ok(coveredReaderRule, 'covered Reader CSS should be explicit');
  assert.match(coveredReaderRule, /visibility:\s*hidden/u);
  assert.match(coveredReaderRule, /pointer-events:\s*none/u);
  assert.doesNotMatch(coveredReaderRule, /display:\s*none/u);
});

test('Home and Reader drawers use bounded reversible presentation states', () => {
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const notesSource = source('../src/components/NotesPanel.tsx');
  const motionSource = source('../src/uiMotion.ts');
  const cssSource = source('../src/styles/index.css');

  assert.match(motionSource, /export const PANEL_MOTION_MS = \d+;/u);
  assert.match(homeSource, /const \[retainedForExit, setRetainedForExit\]/u);
  assert.match(homeSource, /if \(!isOpen && !retainedForExit\) return null;/u);
  assert.match(homeSource, /data-motion-state=\{motionState\}/u);
  assert.match(homeSource, /aria-hidden=\{isOpen \? undefined : true\}/u);
  assert.match(homeSource, /inert=\{isOpen \? undefined : true\}/u);
  assert.match(
    homeSource,
    /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)/u,
  );
  assert.match(homeSource, /PANEL_MOTION_MS/u);

  assert.match(
    notesSource,
    /className=\{`notes-panel \$\{isOpen \? 'is-open' : 'is-closed'\}`\}/u,
  );
  assert.match(notesSource, /className="notes-panel-content"/u);
  assert.match(notesSource, /inert=\{isOpen \? undefined : true\}/u);
  assert.match(cssSource, /\.home-workspace\.is-open\s*\{[^}]*home-workspace-enter/su);
  assert.match(
    cssSource,
    /\.home-workspace\.is-closing\s*\{[^}]*pointer-events:\s*none[^}]*home-workspace-exit/su,
  );
  const homeWorkspaceMotion = cssSource.slice(
    cssSource.indexOf('@keyframes home-workspace-enter'),
    cssSource.indexOf('@keyframes overlay-enter'),
  );
  assert.match(homeWorkspaceMotion, /from\s*\{\s*opacity:\s*0;/u);
  assert.match(homeWorkspaceMotion, /to\s*\{\s*opacity:\s*1;/u);
  assert.match(homeWorkspaceMotion, /from\s*\{\s*opacity:\s*1;/u);
  assert.match(homeWorkspaceMotion, /to\s*\{\s*opacity:\s*0;/u);
  assert.doesNotMatch(homeWorkspaceMotion, /transform|translate|scale/u);
  assert.doesNotMatch(
    cssSource,
    /\.notes-panel\s*\{[^}]*width var\(--motion-panel\)[^}]*flex-basis var\(--motion-panel\)/su,
  );
  assert.match(
    cssSource,
    /\.notes-panel\.is-closed\s*\{[^}]*translateX\(calc\(100% - 14px\)\)/su,
  );
  assert.doesNotMatch(
    cssSource,
    /\.sidebar\s*\{[^}]*width var\(--motion-panel\)[^}]*flex-basis var\(--motion-panel\)/su,
  );
  assert.match(
    cssSource,
    /\.is-sidebar-collapsed \.sidebar\s*\{[^}]*translateX\(calc\(-100% \+ 14px\)\)/su,
  );
});

test('the Notes drawer keeps its surface mounted and removes closed content from interaction', () => {
  const renderNotes = (isOpen: boolean) =>
    renderToStaticMarkup(
      createElement(notesUi.NotesPanel, {
        notes: [],
        glossaryEntries: [],
        annotationCount: 0,
        isOpen,
        draggedNoteId: null,
        isExporting: false,
        onToggle: () => undefined,
        focusedNoteId: null,
        onFocusComplete: () => undefined,
        onFocusedNoteReady: () => undefined,
        onNavigate: () => undefined,
        onUpdate: () => undefined,
        onUpdateDisplayNumber: () => undefined,
        onDelete: () => undefined,
        onExportNotes: () => undefined,
        onEditBeforePrinting: () => undefined,
        onNavigateGlossary: () => undefined,
        onRemoveGlossary: () => undefined,
        onBeginNoteDrag: () => undefined,
        onOpenLargeEditor: () => undefined,
      }),
    );

  const openMarkup = renderNotes(true);
  const closedMarkup = renderNotes(false);

  assert.match(openMarkup, /class="notes-panel is-open"/u);
  assert.match(openMarkup, /aria-label="Collapse Notes and Glossary"/u);
  assert.match(openMarkup, /class="notes-panel-content"/u);
  assert.doesNotMatch(openMarkup, /class="notes-panel-content"[^>]*aria-hidden/u);

  assert.match(closedMarkup, /class="notes-panel is-closed"/u);
  assert.match(closedMarkup, /aria-label="Open Notes and Glossary \(0\)"/u);
  assert.match(
    closedMarkup,
    /class="notes-panel-content" aria-hidden="true" inert=""/u,
  );
  assert.match(closedMarkup, /Notes &amp; Glossary/u);
});

test('semantic UI tokens and reduced-motion safeguards cover the application shell', () => {
  const providerSource = source('../src/components/ThemeProvider.tsx');
  const cssSource = source('../src/styles/index.css');

  for (const token of [
    '--surface-app',
    '--surface-reader',
    '--surface-base',
    '--surface-panel',
    '--surface-raised',
    '--surface-overlay',
    '--interactive-hover',
    '--interactive-selected',
    '--interactive-pressed',
    '--border-subtle',
    '--border-strong',
    '--shadow-soft',
    '--shadow-raised',
    '--shadow-overlay',
    '--motion-fast',
    '--motion-control',
    '--motion-panel',
    '--motion-ease-standard',
    '--motion-ease-out',
  ]) {
    assert.match(providerSource, new RegExp(token, 'u'));
    assert.match(cssSource, new RegExp(token, 'u'));
  }

  assert.match(
    cssSource,
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.theme-root \*[\s\S]*?animation:\s*none !important;[\s\S]*?transition:\s*none !important;/u,
  );
  assert.match(
    cssSource,
    /\.home-navigation button\.is-current\s*\{[^}]*var\(--interactive-selected\)[^}]*inset 3px 0 0 var\(--theme-accent\)/su,
  );
  assert.match(
    cssSource,
    /\.home-navigation button:not\(\.is-current\):hover\s*\{[^}]*var\(--interactive-hover\)[^}]*translate:\s*2px 0/su,
  );
  assert.match(cssSource, /\.home-navigation button:focus-visible\s*\{/u);
  assert.match(
    cssSource,
    /\.theme-preview-card\[aria-pressed='true'\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/su,
  );

  for (const pdfSelector of ['.pdf-page', '.textLayer', '.annotation-layer']) {
    const animatedRule = new RegExp(
      `${pdfSelector.replace('.', '\\.')}[^\\{]*\\{[^}]*animation:`,
      'su',
    );
    assert.doesNotMatch(cssSource, animatedRule);
  }
});

test('Collections is an independent Home page with an honest empty state', () => {
  const markup = renderToStaticMarkup(
    createElement(homeUi.CollectionsHomePage, {
      onOpenDocument: async () => false,
      onOpenLibrary: () => undefined,
    }),
  );
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const appSource = source('../src/components/AppLayout.tsx');

  assert.match(markup, /<h2 id="home-collections-title">Collections<\/h2>/u);
  assert.match(markup, />No Collections yet\.<\/p>/u);
  assert.match(markup, />\+ Create Collection<\/button>/u);
  assert.doesNotMatch(markup, /Saved documents|Opening Library/u);
  assert.match(homeSource, /onClick=\{onOpenCollections\}/u);
  assert.match(
    appSource,
    /homeSection === 'collections'\s*\?\s*\(\s*<CollectionsHomePage/u,
  );
});

test('Collections uses list, view, create, and staged edit modes', () => {
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const viewSource = source('../src/components/CollectionWorkspaceViews.tsx');
  const modelSource = source('../src/components/collectionEditorModel.ts');
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const persistenceSource = source('../src/services/annotationPersistence.ts');

  assert.match(
    modelSource,
    /type CollectionEditorMode = 'view' \| 'create' \| 'edit'/u,
  );
  assert.match(homeSource, /onClick=\{\(\) => openCollection\(collection\)\}/u);
  assert.match(
    homeSource,
    /const openCollection[\s\S]*?openCollectionEditorView\(current, collection\.id\)/u,
  );
  assert.match(homeSource, /<CollectionView[\s\S]*?onEdit=\{beginEdit\}/u);
  assert.match(homeSource, /className="collection-editor-heading-row"/u);
  assert.match(homeSource, /className="collection-editor-header-actions"/u);
  assert.match(homeSource, />\s*Cancel\s*<\/button>/u);
  assert.match(homeSource, /\{isSaving \? 'Saving…' : 'Done'\}/u);
  assert.doesNotMatch(homeSource, /className="collection-editor-actions"/u);
  assert.match(viewSource, /No papers in this Collection\./u);

  const atomicSave = persistenceSource.slice(
    persistenceSource.indexOf('export async function saveCollectionDraft'),
    persistenceSource.indexOf('export async function createTag'),
  );
  assert.ok(atomicSave, 'Collection draft persistence should be present');
  assert.match(
    atomicSave,
    /database\.transaction\(\s*\[COLLECTION_STORE, DOCUMENT_STATE_STORE\],\s*'readwrite'/u,
  );
  assert.match(atomicSave, /const record: CollectionRecord = existing/u);
  assert.match(atomicSave, /\.\.\.existing/u);
  assert.match(
    atomicSave,
    /existing && !collectionNameChanged && !collectionMembershipChanged[\s\S]*?return existing/u,
  );
  assert.match(atomicSave, /await transaction\.done/u);
  assert.match(homeSource, /action="Remove"[\s\S]*?disabled=\{isSaving\}/u);
  assert.match(homeSource, /action="Add"[\s\S]*?disabled=\{isSaving\}/u);
  assert.match(
    homeSource,
    /collectionOperationRef\.current[\s\S]*?setIsSaving\(true\)/u,
  );
  assert.match(homeSource, /refreshSequenceRef\.current/u);
  assert.match(homeSource, /void refresh\(\)\.catch/u);

  assert.doesNotMatch(
    librarySource,
    /createCollection|renameCollection|deleteCollection|Add Collection|Collection:/u,
  );
  assert.doesNotMatch(librarySource, /aria-label="Add Tag"|Browse Library by Tag/u);
  assert.doesNotMatch(homeSource, /export function TagsHomePage|id: 'tags'/u);
});

test('Collection drafts stage membership without mutating persisted inputs', () => {
  const existing = {
    id: 'collection-a',
    name: 'Cognitive Psychology',
    normalizedName: 'cognitive psychology',
    createdAt: 1,
    updatedAt: 1,
  };
  const initial = collectionEditor.createInitialCollectionEditorState();
  const viewed = collectionEditor.openCollectionEditorView(initial, existing.id);
  const editing = collectionEditor.beginCollectionEdit(viewed, existing, [
    'paper-a',
    'paper-b',
  ]);
  assert.equal(viewed.mode, 'view');
  assert.equal(viewed.draft, null);
  assert.equal(editing.mode, 'edit');
  assert.equal(editing.draft?.collectionId, existing.id);

  const draft = editing.draft!;
  const removed = collectionEditor.updateCollectionDraftMembership(
    draft,
    'paper-b',
    false,
  );
  const added = collectionEditor.updateCollectionDraftMembership(
    removed,
    'paper-c',
    true,
  );
  const duplicate = collectionEditor.updateCollectionDraftMembership(
    added,
    'paper-c',
    true,
  );

  assert.equal(draft.collectionId, existing.id);
  assert.deepEqual(draft.selectedDocumentIds, ['paper-a', 'paper-b']);
  assert.deepEqual(removed.selectedDocumentIds, ['paper-a']);
  assert.deepEqual(added.selectedDocumentIds, ['paper-a', 'paper-c']);
  assert.deepEqual(duplicate.selectedDocumentIds, ['paper-a', 'paper-c']);
  assert.deepEqual(
    draft.selectedDocumentIds,
    ['paper-a', 'paper-b'],
    'Cancel can discard the derived draft because the original was not mutated',
  );
  const cancelled = collectionEditor.cancelCollectionEditing({
    ...editing,
    draft: added,
  });
  assert.equal(cancelled.mode, 'view');
  assert.equal(cancelled.draft, null);
  assert.equal(cancelled.selectedCollectionId, existing.id);
});

test('Collection membership keeps an opaque new-paper instance ID exact', () => {
  const documentId =
    'pdfjs:synthetic-source-fingerprint:instance:11111111-1111-4111-8111-111111111111';
  const draft = collectionEditor.createCollectionEditorDraft();
  const included = collectionEditor.updateCollectionDraftMembership(
    draft,
    documentId,
    true,
  );
  assert.deepEqual(included.selectedDocumentIds, [documentId]);
  assert.deepEqual(
    collectionEditor.updateCollectionDraftMembership(included, documentId, false)
      .selectedDocumentIds,
    [],
  );
});

test('Collection create and edit complete into View without changing stable IDs', () => {
  const existing = {
    id: 'collection-a',
    name: 'Cognitive Psychology',
    normalizedName: 'cognitive psychology',
    createdAt: 1,
    updatedAt: 1,
  };
  const initial = collectionEditor.createInitialCollectionEditorState();
  const creating = collectionEditor.beginCollectionCreate(initial);
  const selectedDraft = collectionEditor.updateCollectionDraftMembership(
    { ...creating.draft!, name: 'New shelf' },
    'paper-a',
    true,
  );
  const created = collectionEditor.completeCollectionEditing(
    { ...creating, draft: selectedDraft },
    'collection-new',
  );
  assert.equal(creating.mode, 'create');
  assert.deepEqual(selectedDraft.selectedDocumentIds, ['paper-a']);
  assert.equal(created.mode, 'view');
  assert.equal(created.selectedCollectionId, 'collection-new');
  assert.equal(created.draft, null);

  const editing = collectionEditor.beginCollectionEdit(created, existing, ['paper-a']);
  const completed = collectionEditor.completeCollectionEditing(editing, existing.id);
  assert.equal(editing.draft?.collectionId, existing.id);
  assert.equal(completed.mode, 'view');
  assert.equal(completed.selectedCollectionId, existing.id);
});

test('an empty Collection renders as a valid read-only View', () => {
  const markup = renderToStaticMarkup(
    createElement(collectionViews.CollectionView, {
      collection: {
        id: 'collection-empty',
        name: 'Empty shelf',
        normalizedName: 'empty shelf',
        createdAt: 1,
        updatedAt: 1,
      },
      documents: [],
      onEdit() {},
      async onOpenDocument() {
        return true;
      },
      onOpenLibrary() {},
    }),
  );
  assert.match(markup, /<h3[^>]*>Empty shelf<\/h3>/u);
  assert.match(markup, />0 papers<\/p>/u);
  assert.match(markup, />No papers in this Collection\.<\/p>/u);
  assert.match(markup, />\s*Edit\s*<\/button>/u);
  assert.doesNotMatch(markup, />\s*(?:Add|Remove|Delete Collection)\s*</u);
});

test('normal Collection paper rows are open-only Reader entry points', () => {
  const markup = renderToStaticMarkup(
    createElement(collectionViews.CollectionView, {
      collection: {
        id: 'collection-a',
        name: 'Reading queue',
        normalizedName: 'reading queue',
        createdAt: 1,
        updatedAt: 1,
      },
      documents: [
        {
          documentId: 'paper-a',
          displayTitle: 'Open me',
          documentType: 'pdf',
          hasStoredSource: true,
        },
      ] as never,
      onEdit() {},
      async onOpenDocument() {
        return true;
      },
      onOpenLibrary() {},
    }),
  );

  assert.match(
    markup,
    /<button aria-label="Open Open me in Reader" class="collection-paper-open" type="button"><span>Open me<\/span>/u,
  );
  assert.doesNotMatch(
    markup,
    /Rename|Delete paper|Remove from Google Drive|Restore to Google Drive|Sync/u,
  );
});

test('Collection rows disclose unavailable sources and route recovery through Library', () => {
  assert.equal(
    collectionEditor.getCollectionPaperAvailability({
      documentType: 'pdf',
      hasStoredSource: true,
    }),
    'available',
  );
  assert.equal(
    collectionEditor.getCollectionPaperAvailability({
      documentType: 'pdf',
      hasStoredSource: false,
    }),
    'missing-source',
  );
  assert.equal(
    collectionEditor.getCollectionPaperAvailability({
      documentType: 'docx',
      hasStoredSource: true,
    }),
    'unsupported-source',
  );
  assert.equal(
    collectionEditor.getCollectionPaperAvailability({
      documentType: 'pptx',
      hasStoredSource: true,
    }),
    'unsupported-source',
  );
  assert.equal(
    collectionEditor.getCollectionPaperAvailability(
      { documentType: 'pdf', hasStoredSource: true },
      true,
    ),
    'open-failed',
  );

  const markup = renderToStaticMarkup(
    createElement(collectionViews.CollectionView, {
      collection: {
        id: 'collection-a',
        name: 'Reading queue',
        normalizedName: 'reading queue',
        createdAt: 1,
        updatedAt: 1,
      },
      documents: [
        {
          documentId: 'missing-paper',
          displayTitle: 'Missing source',
          documentType: 'pdf',
          hasStoredSource: false,
        },
        {
          documentId: 'legacy-office-paper',
          displayTitle: 'Legacy Office source',
          documentType: 'docx',
          hasStoredSource: true,
        },
        {
          documentId: 'legacy-presentation',
          displayTitle: 'Legacy presentation source',
          documentType: 'pptx',
          hasStoredSource: true,
        },
      ] as never,
      onEdit() {},
      async onOpenDocument() {
        return false;
      },
      onOpenLibrary() {},
    }),
  );

  assert.match(markup, /<strong>Unavailable\.<\/strong> Source is not stored/u);
  assert.match(markup, /must be converted to PDF before it can be opened/u);
  assert.equal(markup.match(/>Open Library<\/button>/gu)?.length, 3);
  assert.match(markup, /aria-label="Open Library for Missing source"/u);
  assert.doesNotMatch(markup, /class="collection-paper-open"/u);
  assert.doesNotMatch(
    markup,
    /Rename|Delete paper|Remove from Google Drive|Restore to Google Drive|Sync/u,
  );

  const viewSource = source('../src/components/CollectionWorkspaceViews.tsx');
  assert.match(
    viewSource,
    /await onOpenDocument\(documentId\)[\s\S]*?setFailedOpenDocumentIds/u,
  );
  assert.match(
    viewSource,
    /role=\{availability === 'open-failed' \? 'alert' : 'status'\}/u,
  );

  const cssSource = source('../src/styles/index.css');
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.collection-paper-unavailable\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/u,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.collection-paper-unavailable > button\s*\{[^}]*align-self:\s*flex-start;/u,
  );
});

test('Collection origin is retained for the Reader Home return path', () => {
  const appSource = source('../src/components/AppLayout.tsx');
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  assert.match(appSource, /const \[collectionReturnId, setCollectionReturnId\]/u);
  assert.match(
    appSource,
    /onOpenDocument=\{\(documentId, collectionId\) =>[\s\S]*?openStoredDocument\(documentId, true\)\.then\(\(opened\) => \{[\s\S]*?if \(opened\) setCollectionReturnId\(collectionId\)[\s\S]*?return opened/u,
  );
  assert.match(
    appSource,
    /onOpenLibrary=\{\(\) => \{[\s\S]*?setCollectionReturnId\(null\);[\s\S]*?setHomeSection\('library'\)/u,
  );
  assert.doesNotMatch(homeSource, /onSelectedCollectionChange/u);
  assert.match(
    appSource,
    /preserveCollectionOrigin = false[\s\S]*?if \(!preserveCollectionOrigin\) setCollectionReturnId\(null\)/u,
  );
  assert.match(
    appSource,
    /const openLibraryNote = useCallback\([\s\S]*?setCollectionReturnId\(null\)/u,
  );
  assert.match(
    appSource,
    /openHomeSection\(collectionReturnId \? 'collections' : 'home'\)/u,
  );
  assert.match(appSource, /initialCollectionId=\{collectionReturnId\}/u);
});

test('Collection editor completion controls stay in the top header and lists scroll', () => {
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const cssSource = source('../src/styles/index.css');
  const header = homeSource.slice(
    homeSource.indexOf('<header className="collection-editor-header">'),
    homeSource.indexOf(
      '</header>',
      homeSource.indexOf('<header className="collection-editor-header">'),
    ),
  );
  assert.match(header, />\s*Cancel\s*<\/button>/u);
  assert.match(header, /type="submit"[\s\S]*?\{isSaving \? 'Saving…' : 'Done'\}/u);
  assert.doesNotMatch(homeSource, /collection-editor-actions/u);
  assert.match(
    cssSource,
    /\.collection-editor > section ul\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/su,
  );
  assert.match(
    cssSource,
    /\.collection-editor-heading-row\s*\{[^}]*flex-wrap:\s*wrap/su,
  );
});

test('organizational Tags are absent while Reader contextual Tags remain', () => {
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const annotationTagSource = source('../src/utils/annotationTags.ts');
  const annotationTagUi = source('../src/components/pdf/AnnotationTag.tsx');

  assert.doesNotMatch(homeSource, /TagsHomePage|createTag|deleteTag|renameTag/u);
  assert.doesNotMatch(
    librarySource,
    /listTags|TagRecord|Add Tag|Browse Library by Tag|tagIds/u,
  );
  assert.match(annotationTagSource, /export function deriveAnnotationTags/u);
  assert.match(annotationTagUi, /Add Note/u);
  assert.match(annotationTagUi, /Delete Note/u);
});

test('Collection paper search is case-insensitive and changes no membership', () => {
  const papers = [
    { documentId: 'paper-a', displayTitle: 'Cognitive Load Theory' },
    { documentId: 'paper-b', displayTitle: 'NOTE TAKING Study' },
    { documentId: 'paper-c', displayTitle: 'Memory' },
  ] as never;
  const matches = collectionEditor.filterCollectionAvailablePapers(
    papers,
    'note taking',
  );
  assert.deepEqual(
    matches.map((paper) => paper.documentId),
    ['paper-b'],
  );
  assert.equal(collectionEditor.filterCollectionAvailablePapers(papers, '').length, 3);
});

test('Library import actions distinguish ordinary opens from explicit new-paper identity', () => {
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const appSource = source('../src/components/AppLayout.tsx');
  const cssSource = source('../src/styles/index.css');
  const importRule = cssSource.match(
    /\.library-panel-header button\.library-import-button\s*\{([^}]*)\}/u,
  )?.[1];

  assert.match(
    librarySource,
    /className="library-import-button"[\s\S]*?>\s*Import PDF or convert Office\s*<\/button>/u,
  );
  assert.match(
    librarySource,
    /className="library-import-button library-import-new-paper-button"[\s\S]*?>\s*Import as new paper\s*<\/button>/u,
  );
  assert.match(
    librarySource,
    /Import a PDF as a separate paper[\s\S]*?ignored cloud records are not deleted/u,
  );
  assert.match(librarySource, /accept=\{PDF_DOCUMENT_ACCEPT\}/u);
  assert.match(librarySource, /onImportAsNewPaper\(selectedFile\)/u);
  assert.match(
    appSource,
    /newPaperImportRef\.current = options\.importAsNewPaper[\s\S]*?instanceId: crypto\.randomUUID\(\)/u,
  );
  assert.match(
    appSource,
    /pendingNewPaper\?\.generation === generation[\s\S]*?createDocumentInstanceIdentity\(identity, pendingNewPaper\.instanceId\)/u,
  );
  assert.match(
    appSource,
    /preserveRequestedDocumentInstanceIdentity\(\s*identity,\s*requestedDocumentId/u,
  );
  assert.match(appSource, /onImportAsNewPaper=\{importPdfAsNewPaper\}/u);
  assert.ok(
    importRule,
    'Import document should override the square icon-button sizing',
  );
  assert.match(importRule, /display:\s*inline-flex/u);
  assert.match(importRule, /min-width:\s*max-content/u);
  assert.match(importRule, /align-items:\s*center/u);
  assert.match(importRule, /justify-content:\s*center/u);
  assert.match(importRule, /white-space:\s*nowrap/u);
  assert.doesNotMatch(importRule, /position:\s*absolute/u);
  assert.match(cssSource, /\.library-panel-header\s*\{[^}]*flex-wrap:\s*wrap/isu);
  assert.match(
    cssSource,
    /\.library-panel-header-actions\s*\{[^}]*flex-wrap:\s*wrap/isu,
  );
  assert.match(librarySource, /className="library-header-icon-button"/u);
});

test('Library paper cards use compact semantic regions without dropping actions', () => {
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const cssSource = source('../src/styles/index.css');

  for (const region of [
    'library-document-heading',
    'library-document-summary',
    'library-document-metadata',
    'library-document-actions',
  ]) {
    assert.match(librarySource, new RegExp(`className="${region}`, 'u'));
    assert.match(cssSource, new RegExp(`\\.${region}\\s*\\{`, 'u'));
  }

  for (const action of [
    'Rename',
    'Pin',
    'Upload to Google Drive',
    'Restore to Google Drive',
    'Remove from Google Drive',
    'Select PDF',
    'Remove source copy',
    'Read Now',
    'Remove from this device',
  ]) {
    assert.match(librarySource, new RegExp(action, 'u'));
  }

  const cardRule = cssSource.match(/\.library-document\s*\{([^}]*)\}/u)?.[1];
  assert.ok(cardRule);
  assert.doesNotMatch(cardRule, /(?:^|\s)height\s*:/u);
  assert.match(
    cssSource,
    /\.library-document-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*justify-content:\s*flex-start/su,
  );
  assert.match(
    cssSource,
    /\.library-document-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/su,
  );
});

test('Library management actions disclose cloud, source, and device scope without changing callbacks', () => {
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const cssSource = source('../src/styles/index.css');

  for (const className of [
    'library-management-action',
    'library-cloud-removal-action',
    'library-source-removal-action',
    'library-device-removal-action',
  ]) {
    assert.match(librarySource, new RegExp(className, 'u'));
    assert.match(cssSource, new RegExp(`\\.${className}`, 'u'));
  }

  assert.equal(librarySource.match(/kind="cloud"/gu)?.length, 2);
  assert.equal(librarySource.match(/kind="source"/gu)?.length, 1);
  assert.equal(librarySource.match(/kind="device"/gu)?.length, 1);
  assert.match(
    librarySource,
    /aria-hidden="true"[\s\S]*?className="library-management-icon"[\s\S]*?focusable="false"/u,
  );
  assert.match(
    librarySource,
    /library-cloud-removal-action[\s\S]*?onRemoveFromDrive\(\)/u,
  );
  assert.match(
    librarySource,
    /library-source-removal-action[\s\S]*?onRemoveSourceCopy\(\)/u,
  );
  assert.match(librarySource, /library-device-removal-action[\s\S]*?onForget\(\)/u);
  assert.doesNotMatch(librarySource, /library-management-destructive/u);

  assert.match(
    cssSource,
    /\.library-document-actions \.library-management-action\s*\{[^}]*display:\s*inline-flex[^}]*gap:\s*6px/su,
  );
  assert.match(
    cssSource,
    /\.library-document-actions \.library-cloud-removal-action\s*\{[^}]*var\(--theme-link\)[^}]*box-shadow:\s*inset 3px 0 0 var\(--theme-link\)/su,
  );
  assert.match(
    cssSource,
    /\.library-document-actions \.library-source-removal-action\s*\{[^}]*var\(--sync-warning\)[^}]*var\(--control-text\)/su,
  );
  assert.match(
    cssSource,
    /\.library-document-actions \.library-device-removal-action\s*\{[^}]*var\(--destructive-text\)[^}]*var\(--destructive-bg\)/su,
  );
});

test('Library cards disclose full long titles and collapse safely at narrow widths', () => {
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const cssSource = source('../src/styles/index.css');

  assert.match(
    librarySource,
    /<h3 title=\{document\.displayTitle\}>\{document\.displayTitle\}<\/h3>/u,
  );
  assert.match(
    librarySource,
    /<h3 title=\{paper\.displayName\}>\{paper\.displayName\}<\/h3>/u,
  );
  assert.match(
    librarySource,
    /className="library-original-file-name" title=\{document\.originalFileName\}/u,
  );
  assert.match(librarySource, /tabIndex=\{selectionMode \? 0 : undefined\}/u);
  assert.match(
    cssSource,
    /@media \(max-width: 620px\)\s*\{[\s\S]*?\.library-document-heading,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)[\s\S]*?\.library-document-actions > :is\(button, label, span\)[\s\S]*?flex:\s*1 1 170px/u,
  );
});

test('Library Back to top resolves only the active Library scroll container', () => {
  const embeddedScroller = { scrollTo: () => undefined } as unknown as HTMLElement;
  const content = {
    closest: (selector: string) =>
      selector === '.home-content' ? embeddedScroller : null,
    scrollTo: () => undefined,
  } as unknown as HTMLElement;

  assert.equal(resolveLibraryScrollContainer(content, 'embedded'), embeddedScroller);
  assert.equal(resolveLibraryScrollContainer(content, 'overlay'), content);

  const calls: ScrollToOptions[] = [];
  const scrollTarget = {
    scrollTo: (options: ScrollToOptions) => calls.push(options),
  } as unknown as Pick<HTMLElement, 'scrollTo'>;
  scrollLibraryContainerToTop(scrollTarget, false);
  scrollLibraryContainerToTop(scrollTarget, true);
  assert.deepEqual(calls, [
    { top: 0, left: 0, behavior: 'smooth' },
    { top: 0, left: 0, behavior: 'auto' },
  ]);
});

test('Back to top is a measured Library footer and preserves Library view state', () => {
  const librarySource = source('../src/components/LibraryPanel.tsx');
  const homeSource = source('../src/components/HomeWorkspace.tsx');
  const appSource = source('../src/components/AppLayout.tsx');

  assert.match(
    librarySource,
    /isLibraryScrollable &&[\s\S]*?<footer className="library-list-footer">/u,
  );
  assert.match(librarySource, /aria-label="Back to top"/u);
  assert.match(
    librarySource,
    /new ResizeObserver\(measureScrollability\)[\s\S]*?observer\?\.disconnect\(\)/u,
  );
  assert.match(
    librarySource,
    /scrollContainer\.scrollHeight > scrollContainer\.clientHeight \+ 1/u,
  );
  const footerIndex = librarySource.indexOf('<footer className="library-list-footer">');
  assert.ok(footerIndex > librarySource.indexOf('aria-label="Note results"'));
  const backToTopHandler = librarySource.slice(
    librarySource.lastIndexOf('onClick={() => {', footerIndex + 900),
    librarySource.indexOf('</button>', footerIndex),
  );
  assert.doesNotMatch(
    backToTopHandler,
    /setSearchQuery|setLibraryView|setSortMode|setSelectedDocumentIds|onClose/u,
  );
  assert.doesNotMatch(homeSource, /library-back-to-top|Back to top/u);
  assert.doesNotMatch(appSource, /library-back-to-top/u);
});

test('Library and Reader hierarchy use distinct parent, card, control, and backdrop roles', () => {
  const providerSource = source('../src/components/ThemeProvider.tsx');
  const cssSource = source('../src/styles/index.css');

  assert.match(providerSource, /'--surface-backdrop'/u);
  assert.match(providerSource, /const shadowColor = usesDarkSurfaces \? '#000000'/u);
  assert.match(providerSource, /'--control-bg': theme\.inputBackground/u);
  assert.match(
    cssSource,
    /\.library-panel\.is-embedded\s*\{[^}]*background:\s*var\(--surface-base\)/su,
  );
  assert.match(
    cssSource,
    /\.library-document,[\s\S]*?background:\s*var\(--surface-raised\)/u,
  );
  assert.match(
    cssSource,
    /\.notes-panel-content :is\(\.note-card, \.glossary-card, \.document-link-card\)\s*\{[^}]*background:\s*var\(--surface-raised\)/su,
  );
  assert.match(
    cssSource,
    /\.library-confirm-overlay,[\s\S]*?background:\s*var\(--surface-backdrop\)/u,
  );
});

test('Home AI guidance covers every provider without weakening local-only keys', () => {
  const providerIds: AiProviderId[] = [
    'openai',
    'anthropic',
    'gemini',
    'xai',
    'deepseek',
    'mistral',
    'cohere',
    'qwen',
    'custom-openai-compatible',
  ];
  for (const providerId of providerIds) {
    const guidance = getProviderKeyGuidance(providerId);
    assert.equal(guidance.steps.length, 3);
    if (providerId !== 'custom-openai-compatible') {
      assert.match(guidance.url ?? '', /^https:\/\//u);
    }
  }

  const assistant = source('../src/ai/AssistantPanel.tsx');
  assert.match(assistant, /API keys stay on this device and are not synchronized/u);
  assert.match(assistant, /'Hide API key' : 'Show API key'/u);
  assert.doesNotMatch(
    source('../src/sync/safeAiSettings.ts'),
    /apiKey:\s*sanitized|customHeaders:\s*sanitized/u,
  );
});
