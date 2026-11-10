import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ViteDevServer } from 'vite';
import {
  GETTING_STARTED_PREFERENCE_KEY,
  markGettingStartedCompleted,
  markGettingStartedDismissed,
  readGettingStartedPreference,
  shouldAutoOpenGettingStarted,
} from '../src/utils/gettingStarted.ts';
import {
  TUTORIAL_CHAPTERS,
  TUTORIAL_SCREEN_IDS,
  getNextTutorialScreen,
  getPreviousTutorialScreen,
  getTutorialChapterNumber,
  getTutorialProgressState,
} from '../src/utils/gettingStartedWalkthrough.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

let server: ViteDevServer;
let walkthroughUi: typeof import('../src/components/GettingStartedWalkthrough.tsx');
let feedbackUi: typeof import('../src/components/FeedbackNotice.tsx');

function renderWalkthrough(
  initialScreenId: (typeof TUTORIAL_SCREEN_IDS)[number] = 'cover',
) {
  return renderToStaticMarkup(
    createElement(walkthroughUi.GettingStartedWalkthrough, {
      initialScreenId,
      onClose() {},
      onDismiss() {},
      onFinish() {},
      onOpenLibrary() {},
    }),
  );
}

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
  walkthroughUi = (await server.ssrLoadModule(
    '/src/components/GettingStartedWalkthrough.tsx',
  )) as typeof import('../src/components/GettingStartedWalkthrough.tsx');
  feedbackUi = (await server.ssrLoadModule(
    '/src/components/FeedbackNotice.tsx',
  )) as typeof import('../src/components/FeedbackNotice.tsx');
});

after(async () => server.close());

test('first-use eligibility waits for a successful empty-Library scan', () => {
  assert.equal(
    shouldAutoOpenGettingStarted({
      documentCount: 0,
      libraryState: 'ready',
      preference: 'pending',
    }),
    true,
  );
  for (const candidate of [
    { documentCount: 1, libraryState: 'ready', preference: 'pending' },
    { documentCount: 0, libraryState: 'loading', preference: 'pending' },
    { documentCount: 0, libraryState: 'failed', preference: 'pending' },
    { documentCount: 0, libraryState: 'ready', preference: 'dismissed' },
    { documentCount: 0, libraryState: 'ready', preference: 'completed' },
  ] as const) {
    assert.equal(shouldAutoOpenGettingStarted(candidate), false);
  }
});

test('Getting Started dismissal and completion persist locally across reloads', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };

  assert.equal(readGettingStartedPreference(storage), 'pending');
  markGettingStartedDismissed(storage);
  assert.equal(values.get(GETTING_STARTED_PREFERENCE_KEY), 'dismissed');
  assert.equal(readGettingStartedPreference(storage), 'dismissed');
  markGettingStartedCompleted(storage);
  assert.equal(readGettingStartedPreference(storage), 'completed');
  markGettingStartedDismissed(storage);
  assert.equal(
    readGettingStartedPreference(storage),
    'completed',
    'manual reopening must not downgrade a completed preference',
  );
});

test('the old text-card guide is removed and one native walkthrough remains', () => {
  assert.equal(
    existsSync(new URL('../src/components/GettingStarted.tsx', import.meta.url)),
    false,
  );
  const home = source('../src/components/HomeWorkspace.tsx');
  assert.match(home, /lazy\(\(\) =>[\s\S]*?GettingStartedWalkthrough\.tsx/u);
  assert.doesNotMatch(home, /from '\.\/GettingStarted\.tsx'/u);

  const markup = renderWalkthrough();
  assert.match(markup, /data-tutorial-screen="cover"/u);
  assert.match(markup, /aria-labelledby="getting-started-walkthrough-title"/u);
  assert.match(markup, /tabindex="-1"/u);
  assert.match(markup, /aria-label="Close Getting Started"/u);
  assert.match(markup, />Get Started /u);
  assert.match(markup, />Skip for now</u);
  assert.equal(markup.match(/aria-label="Chapter [1-5]:/gu)?.length, 5);
  assert.doesNotMatch(markup, /Step 1 of 5/u);
});

test('walkthrough model is cover, five deterministic chapters, then completion', () => {
  assert.deepEqual(TUTORIAL_SCREEN_IDS, [
    'cover',
    'import',
    'annotate',
    'organize',
    'protect',
    'drive',
    'completion',
  ]);
  assert.deepEqual(
    TUTORIAL_CHAPTERS.map(({ id, title }) => ({ id, title })),
    [
      { id: 'import', title: 'Import your first document' },
      { id: 'annotate', title: 'Annotate and connect ideas' },
      { id: 'organize', title: 'Organize your reading' },
      { id: 'protect', title: 'Keep your work safe' },
      { id: 'drive', title: 'Sync across your devices (optional)' },
    ],
  );
  assert.equal(getNextTutorialScreen('cover'), 'import');
  assert.equal(getPreviousTutorialScreen('cover'), 'cover');
  assert.equal(getPreviousTutorialScreen('import'), 'cover');
  assert.equal(getNextTutorialScreen('drive'), 'completion');
  assert.equal(getNextTutorialScreen('completion'), 'completion');
  assert.equal(getTutorialChapterNumber('cover'), null);
  assert.equal(getTutorialChapterNumber('import'), 1);
  assert.equal(getTutorialChapterNumber('drive'), 5);
  assert.equal(getTutorialChapterNumber('completion'), null);
});

test('chapter progress accurately distinguishes complete, current, and upcoming', () => {
  assert.equal(getTutorialProgressState('cover', 'import'), 'upcoming');
  assert.equal(getTutorialProgressState('organize', 'import'), 'complete');
  assert.equal(getTutorialProgressState('organize', 'organize'), 'current');
  assert.equal(getTutorialProgressState('organize', 'drive'), 'upcoming');
  assert.equal(getTutorialProgressState('completion', 'drive'), 'complete');
});

test('walkthrough copy and native visuals describe real 39Note workflows', () => {
  const copy = TUTORIAL_CHAPTERS.map(
    (chapter) =>
      `${chapter.title} ${chapter.description} ${chapter.points.join(' ')} ${chapter.visualLabel}`,
  ).join(' ');

  assert.match(copy, /DOCX and PPTX/u);
  assert.match(copy, /Legacy \.doc and \.ppt files are not supported/u);
  assert.match(copy, /Highlight or Underline, pick a colour, then Apply/u);
  assert.match(copy, /numbered purple badges/u);
  assert.match(copy, /Collections to group related reading/u);
  assert.match(copy, /Clearing browser or site storage may remove local data/u);
  assert.match(copy, /access must be requested and approved/u);
  assert.match(copy, /not end-to-end encrypted/u);

  const componentSource = source('../src/components/GettingStartedWalkthrough.tsx');
  assert.match(componentSource, /role="img"/u);
  assert.match(componentSource, /fictional tutorial paper/iu);
  assert.match(componentSource, /DEMONSTRATION · SYNTHETIC/u);
  assert.match(componentSource, /Auto sync/u);
  assert.doesNotMatch(componentSource, /organizational Tag|Add Tag/u);
});

test('chapter demonstrations use current product labels and interaction semantics', () => {
  const importMarkup = renderWalkthrough('import');
  assert.match(importMarkup, />Import PDF or convert Office</u);
  assert.match(importMarkup, />Read Now</u);
  assert.match(importMarkup, />Convert Word \/ PowerPoint to PDF</u);
  assert.match(importMarkup, />Choose a \.docx or \.pptx file</u);
  assert.match(importMarkup, />Convert locally</u);
  assert.match(importMarkup, />Add PDF to 39Note</u);
  assert.doesNotMatch(importMarkup, />＋ Import PDF or convert Office</u);

  const annotateMarkup = renderWalkthrough('annotate');
  assert.match(annotateMarkup, /tutorial-selection-toolbar/u);
  assert.match(annotateMarkup, /title="Look up word"/u);
  assert.match(annotateMarkup, />Create new Link</u);
  assert.match(annotateMarkup, />Connect to existing Link</u);
  assert.match(annotateMarkup, /tutorial-context-tag/u);
  assert.match(annotateMarkup, />Add Note</u);
  assert.match(annotateMarkup, /tutorial-link-endpoint is-first/u);
  assert.match(annotateMarkup, /tutorial-link-endpoint is-second/u);
  assert.equal(annotateMarkup.match(/<b>1<\/b>/gu)?.length, 2);
  assert.match(annotateMarkup, />Notes &amp; Glossary</u);
  assert.doesNotMatch(annotateMarkup, /tutorial-annotation-side|>Optional Note</u);
  assert.doesNotMatch(annotateMarkup, />A<\/span>[\s\S]*?>B<\/span>/u);

  const organizeMarkup = renderWalkthrough('organize');
  assert.match(organizeMarkup, />Saved documents</u);
  assert.match(organizeMarkup, />Collections</u);
  assert.match(organizeMarkup, />\+ Create Collection</u);
  assert.match(organizeMarkup, />Edit<\/b>/u);
  assert.equal(organizeMarkup.match(/>Open<\/b>/gu)?.length, 3);
  assert.doesNotMatch(organizeMarkup, /Browse and open|read-only Collection/iu);

  const protectMarkup = renderWalkthrough('protect');
  assert.match(protectMarkup, /39Note<\/strong><small>Library<\/small>/u);
  assert.match(protectMarkup, />Back up Library</u);
  assert.match(protectMarkup, />Restore backup</u);
  assert.match(protectMarkup, />Storage</u);
  assert.match(protectMarkup, />HOW BACKUP WORKS · DIAGRAM</u);
  assert.doesNotMatch(protectMarkup, /39Note<\/strong><small>Settings<\/small>/u);
});

test('Drive chapter is a synthetic current-state demonstration with optional access', () => {
  const markup = renderWalkthrough('drive');
  assert.match(markup, />DEMONSTRATION · SYNTHETIC</u);
  assert.match(markup, />Changes waiting</u);
  assert.match(markup, />1 paper change waiting\.</u);
  assert.match(markup, />Browse Drive papers</u);
  assert.match(markup, />Upload changes \(1\)</u);
  assert.match(markup, />Auto sync</u);
  assert.match(markup, />Local changes</u);
  assert.match(markup, />Open 39Note folder</u);
  assert.match(markup, /Connecting opens Google(?:&#x27;|')s permission screen/u);
  assert.match(markup, /requests only access to files it creates/u);
  assert.doesNotMatch(markup, /mailto:|request access/iu);
  assert.doesNotMatch(markup, />Connected</u);

  const componentSource = source('../src/components/GettingStartedWalkthrough.tsx');
  assert.doesNotMatch(
    componentSource,
    /\.click\(\)|window\.location|location\.href|sendBeacon|fetch\(|beginAuthorization|coordinator\.connect/iu,
  );
});

test('walkthrough owns one bounded content scroller and keeps chapter footer separate', () => {
  const markup = renderWalkthrough('import');
  assert.match(markup, /data-tutorial-scroll-owner="chapter-content"/u);
  assert.match(markup, /aria-label="Getting Started content"/u);
  assert.match(markup, /data-tutorial-footer="true"/u);
  assert.ok(
    markup.indexOf('data-tutorial-footer="true"') >
      markup.indexOf('data-tutorial-scroll-owner="chapter-content"'),
  );

  const componentSource = source('../src/components/GettingStartedWalkthrough.tsx');
  assert.match(componentSource, /contentScrollRef\.current\?\.scrollTo/u);
  assert.match(componentSource, /region\?\.closest<HTMLElement>\('\.home-content'\)/u);
  assert.match(componentSource, /scrollOwner\.scrollTo/u);
  assert.match(
    componentSource,
    /onFocus=\{\(event\) => \{[\s\S]*?event\.currentTarget === event\.target[\s\S]*?revealInHomeContent\(\)/u,
  );
  assert.match(componentSource, /event\.currentTarget !== event\.target/u);
  assert.match(componentSource, /event\.key !== 'Home' && event\.key !== 'End'/u);
  assert.match(
    componentSource,
    /top: event\.key === 'Home' \? 0 : scrollOwner\.scrollHeight/u,
  );
  assert.doesNotMatch(componentSource, /window\.scrollTo|scrollIntoView/u);
});

test('walkthrough is keyboard dismissible, offline, and independent of Drive APIs', () => {
  const componentSource = source('../src/components/GettingStartedWalkthrough.tsx');
  assert.match(componentSource, /event\.key !== 'Escape'/u);
  assert.match(componentSource, /onKeyDown=\{\(event\) =>/u);
  assert.match(
    componentSource,
    /headingRef\.current\?\.focus\(\{ preventScroll: true \}\)/u,
  );
  assert.match(componentSource, /contentScrollRef\.current\?\.scrollTo/u);
  assert.doesNotMatch(componentSource, /window\.addEventListener\('keydown'/u);
  assert.doesNotMatch(
    componentSource,
    /https?:|<iframe|<img|fetch\(|XMLHttpRequest|sendBeacon|oauth|beginAuthorization|coordinator\.connect/iu,
  );
});

test('shared feedback distinguishes transient status from persistent failures', () => {
  const persistent = renderToStaticMarkup(
    createElement(feedbackUi.FeedbackNotice, {
      description: 'Nothing was changed.',
      persistent: true,
      title: 'Action not completed',
      tone: 'error',
    }),
  );
  const transient = renderToStaticMarkup(
    createElement(feedbackUi.FeedbackNotice, {
      description: 'Done.',
      title: 'Saved',
      tone: 'success',
    }),
  );

  assert.match(persistent, /role="alert"/u);
  assert.match(persistent, /aria-live="assertive"/u);
  assert.match(persistent, /data-persistence="persistent"/u);
  assert.match(transient, /role="status"/u);
  assert.match(transient, /data-persistence="transient"/u);
});

test('Home and Settings wire first-use, dismissal, and deliberate reopening safely', () => {
  const home = source('../src/components/HomeWorkspace.tsx');
  const app = source('../src/components/AppLayout.tsx');

  assert.match(
    home,
    /shouldAutoOpenGettingStarted\(\{[\s\S]*?libraryState: summaryState/u,
  );
  assert.match(home, /markGettingStartedDismissed\(\)/u);
  assert.match(home, /markGettingStartedCompleted\(\)/u);
  assert.match(home, />\s*Open Getting Started tour\s*<\/button>/u);
  assert.match(home, /optional Drive sync/u);
  assert.match(home, /<GettingStartedWalkthrough/u);
  assert.match(home, /onFinish=\{finishGettingStarted\}/u);
  assert.match(home, /onOpenLibrary=\{openLibraryFromGettingStarted\}/u);
  assert.match(home, /onGettingStartedRequestHandled\?\.\(\)/u);
  assert.match(app, /setGettingStartedRequestId\(\(current\) => current \+ 1\)/u);
  assert.match(
    app,
    /onGettingStartedRequestHandled=\{\(\) => setGettingStartedRequestId\(0\)\}/u,
  );
  assert.match(app, /gettingStartedRequestId=\{gettingStartedRequestId\}/u);
  assert.match(
    app,
    /onOpenLibrary=\{\(\) => \{[\s\S]*?setLibrarySearchFocusRequestId\(\(current\) => current \+ 1\)[\s\S]*?setHomeSection\('library'\)/u,
  );
  assert.match(home, /homeLandingRef\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(home, /Getting Started guide opened\./u);
  assert.doesNotMatch(
    home.match(
      /export function HomeLandingPage[\s\S]*?export function ThemeHomePage/u,
    )?.[0] ?? '',
    /connect\(|beginAuthorization|requestOAuth/u,
  );
});

test('Library and Collection load failures settle and expose scoped Retry actions', () => {
  const library = source('../src/components/LibraryPanel.tsx');
  const home = source('../src/components/HomeWorkspace.tsx');

  assert.match(
    library,
    /listLibraryDocuments\(\)[\s\S]*?\.catch\(\(\) => \{[\s\S]*?setLibraryLoadFailed\(true\)[\s\S]*?setIsLoading\(false\)/u,
  );
  assert.match(library, /title="Library unavailable"/u);
  assert.match(library, /setLibraryLoadRetryToken\(\(current\) => current \+ 1\)/u);
  assert.match(library, /!libraryLoadFailed[\s\S]*?No saved documents yet\./u);
  assert.match(home, /title="Collection action not completed"/u);
  assert.match(home, /collectionRecovery === 'retry-load'/u);
  assert.match(home, /void refresh\(\)\.catch/u);
  assert.match(
    home,
    /The Collection was saved, but the Collection list could not be refreshed/u,
  );
  assert.match(
    home,
    /The Collection was deleted, but the Collection list could not be refreshed/u,
  );
  assert.equal(
    home.match(/setCollectionRecovery\('retry-load'\)/gu)?.length,
    4,
    'initial load, failed reload, post-save refresh, and post-delete refresh remain retryable',
  );
});

test('backup and PDF failures retain data-safe copy and actionable recovery', () => {
  const home = source('../src/components/HomeWorkspace.tsx');
  const viewer = source('../src/components/Viewer.tsx');
  const app = source('../src/components/AppLayout.tsx');

  assert.match(home, /title="Backup not created"/u);
  assert.match(home, /Your Library was not replaced or removed/u);
  assert.match(home, />\s*Retry\s*<\/button>/u);
  assert.match(viewer, /title=\{pdfOpenFailureTitle\(error\)\}/u);
  assert.match(viewer, />\s*Open Library\s*<\/button>/u);
  assert.match(app, /onOpenLibrary=\{\(\) => openHomeSection\('library'\)\}/u);
});

test('technical Drive identifiers stay behind development-only detail gates', () => {
  const paperSync = source('../src/sync/PaperSyncControl.tsx');
  const legacySync = source('../src/sync/SyncControl.tsx');

  assert.match(
    paperSync,
    /import\.meta\.env\.DEV && state\.issue\.diagnostic\.documentId/u,
  );
  assert.match(
    paperSync,
    /import\.meta\.env\.DEV &&[\s\S]*?expectedSemanticPartition/u,
  );
  assert.match(legacySync, /import\.meta\.env\.DEV && issue\.documentId/u);
  assert.match(legacySync, /import\.meta\.env\.DEV \? \([\s\S]*?<dt>Drive role/u);
});

test('shared onboarding and feedback styling is theme-token based and mobile-safe', () => {
  const css = source('../src/styles/index.css');
  const onboardingBlock = css.slice(
    css.indexOf('.getting-started-loading {'),
    css.indexOf('.home-summary-grid button {'),
  );

  assert.match(onboardingBlock, /var\(--theme-card\)/u);
  assert.match(onboardingBlock, /var\(--theme-accent\)/u);
  assert.match(onboardingBlock, /var\(--focus-ring\)/u);
  assert.doesNotMatch(onboardingBlock, /#[\da-f]{3,8}\b/iu);
  assert.doesNotMatch(css, /\.getting-started-steps\b|\.getting-started-content\b/u);
  assert.match(
    css,
    /@media \(max-width: 430px\)[\s\S]*?\.walkthrough-navigation\s*\{[\s\S]*?flex-direction:\s*column/u,
  );
  assert.match(
    css,
    /@media \(max-width: 760px\)[\s\S]*?\.walkthrough-cover,[\s\S]*?grid-template-columns:\s*1fr/u,
  );
  assert.match(
    css,
    /@media \(max-width: 900px\)[\s\S]*?\.walkthrough-chapter-copy\s*\{[\s\S]*?order:\s*-1/u,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.walkthrough-screen\s*\{[\s\S]*?animation:\s*none !important/u,
  );
  assert.match(onboardingBlock, /overflow:\s*clip/u);
  assert.match(
    onboardingBlock,
    /\.getting-started-walkthrough\s*\{[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/u,
  );
  assert.match(
    onboardingBlock,
    /\.walkthrough-content-scroll\s*\{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto/u,
  );
  assert.match(
    onboardingBlock,
    /\.home-content:has\(\.getting-started-walkthrough\)\s*\{[\s\S]*?overflow-y:\s*hidden/u,
  );
  assert.match(
    onboardingBlock,
    /\.walkthrough-navigation\s*\{[\s\S]*?border-top:[\s\S]*?background:\s*var\(--theme-card\)/u,
  );
  assert.doesNotMatch(
    onboardingBlock,
    /\.walkthrough-(?:chrome|progress)\s*\{[^}]*position:\s*sticky/gu,
  );
  assert.doesNotMatch(onboardingBlock, /position:\s*fixed/u);
});

test('existing destructive confirmations still state their exact scope', () => {
  const library = source('../src/components/LibraryPanel.tsx');
  const annotation = source('../src/components/pdf/AnnotationTag.tsx');
  const notes = source('../src/components/NotesPanel.tsx');

  assert.match(library, /Remove from this device\?/u);
  assert.match(library, /original document on your computer is not deleted/iu);
  assert.match(library, /Remove from Google Drive\?/u);
  assert.match(library, /moved to Google Drive Trash/u);
  assert.match(library, /Remove the saved source copy\?/u);
  assert.match(library, /highlights and Notes stay in the\s+Library/u);
  assert.match(annotation, /Both endpoints will be deleted/u);
  assert.match(notes, /Both endpoints will be deleted/u);
});

test('Library destructive confirmations and the Notes print dialog are keyboard-modal', () => {
  const library = source('../src/components/LibraryPanel.tsx');
  const notes = source('../src/components/NotesPanel.tsx');
  const drawerHandle = source('../src/components/DrawerEdgeHandle.tsx');
  const app = source('../src/components/AppLayout.tsx');

  assert.match(library, /const destructiveDialogKey =/u);
  assert.match(library, /const handleDestructiveDialogKeyDown =/u);
  assert.match(library, /event\.key === 'Escape'/u);
  assert.match(library, /event\.key !== 'Tab'/u);
  assert.equal(
    library.match(/ref=\{destructiveDialogRef\}/gu)?.length,
    5,
    'every Library destructive confirmation shares the focus boundary',
  );
  assert.equal(
    library.match(/data-dialog-initial-focus/gu)?.length,
    6,
    'five destructive Cancel buttons and the restore-safe focus query remain marked',
  );
  assert.match(library, /inert=\{isLibraryModalOpen \? true : undefined\}/u);

  assert.match(notes, /ref=\{printDialogRef\}/u);
  assert.match(notes, /onKeyDown=\{handlePrintDialogKeyDown\}/u);
  assert.match(notes, /event\.preventDefault\(\);\s*setIsPrintDialogOpen\(false\)/u);
  assert.match(
    notes,
    /setIsPrintDialogOpen\(false\);\s*\}, \[activeDocumentId, isOpen\]\)/u,
  );
  assert.match(notes, /disabled=\{isPrintDialogOpen\}/u);
  assert.match(drawerHandle, /disabled=\{disabled\}/u);
  assert.match(app, /activeDocumentId=\{documentIdentity\?\.documentId \?\? null\}/u);
});

test('Print Composer retains persistent failures and transient success settlement', () => {
  const printComposer = source('../src/print/PrintComposer.tsx');

  assert.match(
    printComposer,
    /const showStatus = useCallback\(\(message: string, transient = false\)/u,
  );
  assert.match(printComposer, /if \(!transient\) return/u);
  assert.match(printComposer, /Draft could not be saved locally\.'\)/u);
  assert.match(printComposer, /Saved Print PDF attached\.',\s*true/u);
});
