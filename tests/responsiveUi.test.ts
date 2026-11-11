import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPACT_READER_MEDIA_QUERY,
  clampFloatingSurfaceToViewport,
  getReaderLayoutMode,
} from '../src/utils/responsiveLayout.ts';
import { resolveReaderStatusIndicatorDisplay } from '../src/utils/readerPreferences.ts';
import { themes } from '../src/themes.ts';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = (relativePath: string) =>
  readFileSync(resolve(testDirectory, relativePath), 'utf8');

const appLayoutSource = source('../src/components/AppLayout.tsx');
const toolbarSource = source('../src/components/Toolbar.tsx');
const sidebarSource = source('../src/components/Sidebar.tsx');
const notesPanelSource = source('../src/components/NotesPanel.tsx');
const homeWorkspaceSource = source('../src/components/HomeWorkspace.tsx');
const noteDragHandleSource = source('../src/components/NoteDragHandle.tsx');
const selectionActionSource = source('../src/components/pdf/SelectionAction.tsx');
const annotationTagSource = source('../src/components/pdf/AnnotationTag.tsx');
const pdfSearchBarSource = source('../src/components/pdf/PdfSearchBar.tsx');
const themeProviderSource = source('../src/components/ThemeProvider.tsx');
const cssSource = source('../src/styles/index.css');
const htmlSource = source('../index.html');

const relativeLuminance = (hex: string) => {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  assert.ok(channels);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
};

const contrastRatio = (foreground: string, background: string) => {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
};

test('responsive Reader classification considers both width and input capability', () => {
  assert.equal(getReaderLayoutMode({ width: 320, coarsePointer: false }), 'compact');
  assert.equal(getReaderLayoutMode({ width: 844, coarsePointer: false }), 'compact');
  assert.equal(getReaderLayoutMode({ width: 1024, coarsePointer: true }), 'compact');
  assert.equal(getReaderLayoutMode({ width: 1024, coarsePointer: false }), 'docked');
  assert.equal(getReaderLayoutMode({ width: 1180, coarsePointer: true }), 'compact');
  assert.equal(getReaderLayoutMode({ width: 1280, coarsePointer: true }), 'docked');
  assert.match(COMPACT_READER_MEDIA_QUERY, /pointer: coarse/u);
  assert.match(COMPACT_READER_MEDIA_QUERY, /max-width: 900px/u);
});

test('floating Reader controls clamp to the visible viewport, including keyboard offsets', () => {
  assert.deepEqual(
    clampFloatingSurfaceToViewport(
      { left: 500, top: 760 },
      { width: 280, height: 220 },
      { left: 12, top: 140, right: 402, bottom: 620, width: 390, height: 480 },
    ),
    { left: 114, top: 392 },
  );
  assert.deepEqual(
    clampFloatingSurfaceToViewport(
      { left: -40, top: 20 },
      { width: 280, height: 220 },
      { left: 12, top: 140, right: 402, bottom: 620, width: 390, height: 480 },
    ),
    { left: 20, top: 148 },
  );
  for (const componentSource of [selectionActionSource, annotationTagSource]) {
    assert.match(componentSource, /getVisualViewportBounds\(\)/u);
    assert.match(componentSource, /visualViewport\?\.addEventListener\('resize'/u);
    assert.match(componentSource, /visualViewport\?\.addEventListener\('scroll'/u);
    assert.match(componentSource, /visualViewport\?\.removeEventListener\('resize'/u);
    assert.match(componentSource, /visualViewport\?\.removeEventListener\('scroll'/u);
  }
});

test('phone Reader panels use an accessible floating disclosure and a dismissing scrim', () => {
  assert.match(appLayoutSource, /COMPACT_READER_MEDIA_QUERY/u);
  assert.match(appLayoutSource, /reader-mobile-actions/u);
  assert.match(appLayoutSource, /className="reader-mobile-action-trigger"/u);
  assert.match(appLayoutSource, /className="reader-mobile-action-items"/u);
  assert.match(appLayoutSource, /aria-controls="reader-mobile-action-items"/u);
  assert.match(appLayoutSource, /aria-expanded=\{isMobileReaderMenuOpen\}/u);
  assert.match(
    appLayoutSource,
    /inert=\{!isMobileReaderMenuOpen \? true : undefined\}/u,
  );
  assert.match(appLayoutSource, /Open Reader shortcuts/u);
  assert.match(appLayoutSource, /Close Reader shortcuts/u);
  assert.doesNotMatch(appLayoutSource, /reader-mobile-controls/u);
  assert.match(appLayoutSource, />\s*Navigation &amp; annotations\s*</u);
  assert.match(appLayoutSource, />\s*Notes &amp; Glossary\s*</u);
  assert.match(appLayoutSource, />\s*Home\s*</u);
  assert.match(appLayoutSource, /window\.addEventListener\('pointerdown'/u);
  assert.match(
    appLayoutSource,
    /event\.key !== 'Escape' \|\| event\.defaultPrevented/u,
  );
  assert.match(
    appLayoutSource,
    /mobileReaderMenuTriggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/u,
  );
  assert.match(appLayoutSource, /className="reader-mobile-scrim"/u);
  assert.match(
    appLayoutSource,
    /setIsNotesDrawerOpen\(false\);\s*setIsSidebarCollapsed\(false\);/u,
  );
  assert.match(
    appLayoutSource,
    /setIsSidebarCollapsed\(true\);\s*setIsNotesDrawerOpen\(true\);/u,
  );
  assert.match(cssSource, /\.app-layout\.is-compact-reader \.reader-mobile-actions/u);
  assert.match(cssSource, /bottom:\s*max\(12px,/u);
  assert.match(cssSource, /left:\s*max\(12px, env\(safe-area-inset-left\)\)/u);
  assert.match(cssSource, /flex-direction:\s*column-reverse/u);
  assert.match(
    cssSource,
    /\.reader-mobile-action-trigger[^}]*width:\s*48px;[^}]*height:\s*48px;/su,
  );
  assert.match(
    cssSource,
    /\.reader-mobile-actions\.is-open\s+\.reader-mobile-action-items[^}]*visibility:\s*visible;[^}]*opacity:\s*1;/su,
  );
  assert.match(cssSource, /\.app-layout\.is-compact-reader \.sidebar/u);
  assert.match(cssSource, /\.app-layout\.is-compact-reader \.notes-panel/u);
  assert.match(cssSource, /transform:\s*translateX\(calc\(-100% - 18px\)\)/u);
  assert.match(cssSource, /transform:\s*translateX\(calc\(100% \+ 18px\)\)/u);
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.sidebar,[\s\S]*?max-width:\s*calc\(100vw - 44px\);[\s\S]*?min-width:\s*0;/u,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.reader-tools-inner\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/su,
  );
  assert.match(notesPanelSource, /aria-label="Close Notes and Glossary"/u);
  assert.match(notesPanelSource, /className="notes-panel-mobile-close"/u);
  assert.match(notesPanelSource, /ref=\{printExportButtonRef\}/u);
  assert.match(
    notesPanelSource,
    /onEditBeforePrinting\([\s\S]*?printExportButtonRef\.current \?\? undefined/u,
  );
  assert.match(sidebarSource, /aria-label="Close navigation and annotations"/u);
  assert.match(sidebarSource, /className="sidebar-mobile-close"/u);
  assert.doesNotMatch(sidebarSource, /<aside[\s\S]*?aria-hidden=\{isCollapsed\}/u);
  assert.match(
    sidebarSource,
    /className="sidebar-inner reader-tools-inner"[\s\S]*?aria-hidden=\{isCollapsed \? true : undefined\}/u,
  );
  assert.match(sidebarSource, /'Open navigation and annotations'/u);
  assert.match(sidebarSource, /inert=\{isCollapsed \? true : undefined\}/u);
  assert.match(
    sidebarSource,
    /role=\{isModal && !isCollapsed \? 'dialog' : undefined\}/u,
  );
  assert.match(notesPanelSource, /role=\{isModal && isOpen \? 'dialog' : undefined\}/u);
  assert.match(appLayoutSource, /mobilePanelReturnFocusRef/u);
  assert.match(
    appLayoutSource,
    /returnFocusTarget=\{printComposerReturnFocusRef\.current\}/u,
  );
  assert.match(appLayoutSource, /returnFocus\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    appLayoutSource,
    /querySelector<HTMLElement>\(\s*'\.sidebar-mobile-close, \.notes-panel-mobile-close'/u,
  );
  assert.match(
    appLayoutSource,
    /if \(event\.key === 'Escape'\) \{\s*if \(event\.defaultPrevented\) return;/u,
  );
  assert.match(appLayoutSource, /event\.key !== 'Tab'/u);
  assert.match(appLayoutSource, /panel\.querySelectorAll<HTMLElement>/u);
  assert.match(homeWorkspaceSource, /backButtonRef\.current\?\.focus/u);
  assert.match(
    appLayoutSource,
    /inert=\{applicationView === 'home' \? true : undefined\}/u,
  );
  assert.match(
    appLayoutSource,
    /key === 'n' && file && isDocumentHydrated[\s\S]*?if \(isCompactReader\) setIsSidebarCollapsed\(true\);[\s\S]*?setIsNotesDrawerOpen/u,
  );
});

test('Reader Tools starts closed instead of restoring an open outer sidebar', () => {
  assert.match(
    appLayoutSource,
    /const \[isSidebarCollapsed, setIsSidebarCollapsed\] = useState\(true\);/u,
  );
  assert.doesNotMatch(appLayoutSource, /39note\.reader-tools-open/u);
  assert.match(
    appLayoutSource,
    /const applyLayoutMode = \(isCompact: boolean\) => \{[\s\S]*?setIsSidebarCollapsed\(true\);/u,
  );
  assert.match(sidebarSource, /39note\.reader-navigation-open/u);
  assert.match(sidebarSource, /39note\.reader-annotations-open/u);
});

test('compact toolbar exposes every desktop action through an accessible top drawer', () => {
  assert.match(toolbarSource, /isCompactReader: boolean/u);
  assert.match(toolbarSource, /isCompactToolsOpen/u);
  assert.match(toolbarSource, /toolbar-compact-tools-trigger/u);
  assert.match(toolbarSource, /toolbar-compact-tools-drawer/u);
  assert.match(toolbarSource, /Open Reader toolbar controls/u);
  assert.match(toolbarSource, /Close Reader toolbar controls/u);
  assert.match(toolbarSource, /aria-expanded=\{isCompactToolsOpen\}/u);
  assert.match(
    toolbarSource,
    /inert=\{isCompactReader && !isCompactToolsOpen \? true : undefined\}/u,
  );
  assert.match(toolbarSource, /window\.addEventListener\('pointerdown'/u);
  assert.match(toolbarSource, /window\.addEventListener\('keydown'/u);
  assert.match(
    toolbarSource,
    /compactToolsTriggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/u,
  );
  for (const label of ['Zoom out', 'Zoom in', 'Search document']) {
    assert.match(toolbarSource, new RegExp(label, 'u'));
  }
  assert.equal(toolbarSource.match(/toolbar-zoom-button/gu)?.length, 2);
  assert.match(toolbarSource, /toolbar-zoom-input/u);
  assert.match(toolbarSource, /className="toolbar-button toolbar-fit-width"/u);
  assert.match(toolbarSource, /className="toolbar-button toolbar-search-trigger"/u);
  assert.match(toolbarSource, /disabled=\{!canExportNotes\}/u);
  assert.match(
    toolbarSource,
    /onClick=\{\(\) => closeCompactToolsBefore\(onExportNotes\)\}/u,
  );
  assert.match(appLayoutSource, /onExportNotes=\{exportCurrentNotesAsMarkdown\}/u);
  assert.match(
    appLayoutSource,
    /canExportNotes=\{Boolean\([\s\S]*?activeDocumentType === 'pdf'[\s\S]*?documentIdentity[\s\S]*?isDocumentHydrated[\s\S]*?notes\.length > 0/u,
  );
  assert.match(toolbarSource, /className="page-indicator"/u);
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.toolbar-actions\s*\{[^}]*display:\s*none;/su,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.toolbar\.is-compact-tools-open \.toolbar-actions\s*\{[^}]*display:\s*flex;/su,
  );
  assert.match(
    cssSource,
    /\.toolbar\.is-compact-tools-open[\s\S]*?\.toolbar-actions[\s\S]*?> \.toolbar-button\s*\{[^}]*display:\s*inline-flex !important;/u,
  );
  assert.match(
    cssSource,
    /\.toolbar\.is-compact-tools-open \.toolbar-clock-slot\s*\{[^}]*display:\s*block !important;/su,
  );
  assert.match(
    cssSource,
    /\.toolbar\.is-compact-tools-open \.toolbar-zoom-input\s*\{[^}]*display:\s*inline-block !important;/su,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.ai-assistant-panel\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/su,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader:is\(\.is-reader-tools-open, \.is-reader-notes-open\)[\s\S]*?\.reader-sync-status-pill\s*\{[^}]*display:\s*none;/u,
  );
  assert.match(appLayoutSource, /isAiOpen \? 'is-reader-ai-open' : ''/u);
  assert.match(
    appLayoutSource,
    /if \(isCompactReader && !isAiOpen\) \{[\s\S]*?setIsMobileReaderMenuOpen\(false\);[\s\S]*?setIsSidebarCollapsed\(true\);[\s\S]*?setIsNotesDrawerOpen\(false\);/u,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader\.is-reader-ai-open[\s\S]*?:is\(\.reader-mobile-actions, \.reader-sync-status-pill\)\s*\{[^}]*display:\s*none;/u,
  );
  assert.match(
    cssSource,
    /\.app-layout:has\([\s\S]*?\.large-note-editor-overlay[\s\S]*?\)[\s\S]*?\.reader-sync-status-pill\s*\{[^}]*display:\s*none;/u,
  );
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.reader-sync-status-pill\s*\{[^}]*right:\s*max\(12px,[^}]*bottom:\s*max\(12px,/su,
  );
  assert.match(
    cssSource,
    /@media \(max-height: 430px\) and \(orientation: landscape\)[\s\S]*?\.reader-sync-status-pill\s*\{[^}]*display:\s*none;/u,
  );
  assert.match(
    cssSource,
    /@media \(max-height: 430px\) and \(orientation: landscape\)[\s\S]*?\.viewer\.is-empty\s*\{[^}]*padding:\s*64px 14px 8px;/u,
  );
  assert.match(
    cssSource,
    /@media \(pointer: coarse\)[\s\S]*?\.reader-mobile-action-trigger, \.reader-mobile-action-child\),[\s\S]*?min-height:\s*44px;/u,
  );
});

test('compact Reader resolves full Drive status to compact without rewriting preference', () => {
  assert.equal(resolveReaderStatusIndicatorDisplay('full', true), 'compact');
  assert.equal(resolveReaderStatusIndicatorDisplay('compact', true), 'compact');
  assert.equal(resolveReaderStatusIndicatorDisplay('hidden', true), 'hidden');
  assert.equal(resolveReaderStatusIndicatorDisplay('full', false), 'full');
  assert.match(
    appLayoutSource,
    /display=\{resolveReaderStatusIndicatorDisplay\(\s*readerStatusIndicatorDisplay,\s*isCompactReader,?\s*\)\}/u,
  );
  assert.match(
    appLayoutSource,
    /writeReaderStatusIndicatorDisplay\(readerStatusIndicatorDisplay\)/u,
  );
});

test('touch opens the exact existing Note editor without removing desktop drag initiation', () => {
  assert.match(noteDragHandleSource, /lastPointerTypeRef/u);
  assert.match(noteDragHandleSource, /event\.pointerType === 'touch'/u);
  assert.match(noteDragHandleSource, /onClick=\{\(event\) =>/u);
  assert.match(noteDragHandleSource, /onOpenLargeEditor\(note\)/u);
  assert.match(noteDragHandleSource, /onBeginNoteDrag\(note, event, onDropInTarget\)/u);
  assert.match(cssSource, /@media \(hover: none\), \(pointer: coarse\)/u);
  assert.match(
    cssSource,
    /\.theme-root \.annotation-tag \.note-drag-handle\s*\{[^}]*min-width:\s*44px;[^}]*touch-action:\s*manipulation;/su,
  );
});

test('coarse input receives larger Link and annotation targets without changing visible Link colour', () => {
  assert.match(
    cssSource,
    /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.document-link-badge\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/u,
  );
  assert.match(
    cssSource,
    /@media \(pointer: coarse\)[\s\S]*?\.theme-root \.document-link-badge\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*height:\s*44px;[^}]*min-height:\s*44px;/u,
  );
  assert.match(
    cssSource,
    /@media \(pointer: coarse\)[\s\S]*?\.theme-root \.selection-action \.highlight-color-swatch,[\s\S]*?width:\s*44px;[^}]*height:\s*44px;/u,
  );
  assert.match(
    cssSource,
    /\.document-link-badge-label\s*\{[^}]*background:\s*#7c3aed/su,
  );
  assert.match(cssSource, /\.document-link-underline\s*\{[^}]*stroke:\s*#581c87/su);
});

test('Bay uses bright golden fills with separate accessible accent text', () => {
  const bay = themes.bay;
  assert.equal(bay.accentColor.toUpperCase(), '#F59A3A');
  assert.equal(bay.accentTextColor?.toUpperCase(), '#A8440D');
  assert.equal(bay.semanticPalette?.chipSelectedText.toUpperCase(), '#3D250E');
  assert.equal(bay.shellBackground, '#BCEBFA');
  assert.equal(bay.navigationBackground, '#DFF3F7');
  assert.doesNotMatch(bay.shellBackground, /linear-gradient/iu);
  assert.doesNotMatch(bay.navigationBackground, /linear-gradient/iu);
  assert.match(themeProviderSource, /'--theme-accent-text'/u);
  for (const background of [
    bay.appBackground,
    bay.shellBackground,
    bay.navigationBackground,
    bay.surfaceBackground,
    bay.elevatedBackground,
    bay.panelBackground,
    bay.inputBackground,
    bay.semanticPalette?.toolbarBackground,
    bay.semanticPalette?.drawerBackground,
    bay.semanticPalette?.cardBackground,
    bay.semanticPalette?.sectionBackground,
  ]) {
    assert.ok(background);
    assert.doesNotMatch(background, /gradient/iu);
    assert.ok(contrastRatio(bay.accentTextColor ?? bay.accentColor, background) >= 4.5);
  }
  const bayCss = cssSource.slice(
    cssSource.indexOf(".theme-root[data-reading-theme='bay']"),
    cssSource.indexOf('.toolbar-open-compact'),
  );
  assert.match(bayCss, /--bay-sunlight:\s*#ffbe62/iu);
  assert.match(bayCss, /--bay-workspace-blue:\s*#bcebfa/iu);
  assert.match(
    bayCss,
    /--bay-reader-gradient:\s*linear-gradient\(\s*180deg,\s*#a0e0f8 0%,\s*#bcebfa 56%,\s*#f4debe 82%,\s*#f6b76f 100%\s*\)/iu,
  );
  assert.match(
    bayCss,
    /:is\(\.toolbar, \.home-workspace-header\)[\s\S]*?background:\s*var\(--theme-toolbar\)/u,
  );
  assert.match(
    bayCss,
    /:is\(\.home-content, \.app-content, \.viewer\)[\s\S]*?background:\s*var\(--bay-workspace-blue\)/u,
  );
  assert.match(bayCss, /\.viewer\.is-empty \.viewer-panel/u);
  assert.match(
    cssSource,
    /\.reader-empty-ambient--bay\s*\{[^}]*background:\s*var\(--bay-reader-gradient\)/su,
  );
  assert.doesNotMatch(cssSource, /reader-empty-bay-sun/u);
  assert.doesNotMatch(bayCss, /#(?:29b6f6|4fc3f7)/iu);
  assert.doesNotMatch(bayCss, /radial-gradient|circle at|ellipse at/iu);
  assert.doesNotMatch(bayCss, /inset 0 3px 0/u);
  assert.doesNotMatch(bayCss, /data-reading-theme='(?:sea|bright|midnight)'/u);
});

test('mobile shell retains safe areas, dynamic viewport handling and every major surface', () => {
  assert.match(htmlSource, /viewport-fit=cover/u);
  assert.match(htmlSource, /interactive-widget=resizes-content/u);
  assert.match(cssSource, /env\(safe-area-inset-top\)/u);
  assert.match(cssSource, /env\(safe-area-inset-bottom\)/u);
  assert.match(cssSource, /100dvh/u);
  assert.match(
    cssSource,
    /\.app-layout\.is-compact-reader \.annotation-tag\s*\{[^}]*max-height:\s*calc\(100dvh - 16px\);/su,
  );
  assert.match(pdfSearchBarSource, /visualViewport\?\.addEventListener\('resize'/u);
  assert.match(pdfSearchBarSource, /visualViewport\?\.addEventListener\('scroll'/u);
  assert.match(pdfSearchBarSource, /visualViewport\?\.removeEventListener\('resize'/u);
  assert.match(pdfSearchBarSource, /visualViewport\?\.removeEventListener\('scroll'/u);
  assert.match(pdfSearchBarSource, /visualViewport\.offsetLeft - boundsRect\.left/u);
  assert.match(pdfSearchBarSource, /visualViewport\.offsetTop - boundsRect\.top/u);
  assert.match(
    cssSource,
    /\.theme-root \.print-composer-header\s*\{[^}]*max-height:\s*min\(44dvh, 320px\);[^}]*overflow-y:\s*auto;/su,
  );
  assert.match(
    cssSource,
    /\.sync-panel\s*\{[^}]*max-height:\s*calc\(100dvh - 80px\);/su,
  );
  assert.match(
    cssSource,
    /\.paper-update-recommendation\s*\{[^}]*max-height:\s*calc\(100dvh - 80px\);[^}]*overflow:\s*auto;/su,
  );
  assert.match(
    cssSource,
    /\.collection-detail-heading h3\s*\{[^}]*overflow-wrap:\s*anywhere;/su,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.theme-root \.home-workspace-header\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/u,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.theme-root \.home-navigation\s*\{[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-left\)/u,
  );
  assert.match(
    cssSource,
    /@media \(max-width: 760px\)[\s\S]*?\.theme-root \.home-content\s*\{[^}]*env\(safe-area-inset-right\)[^}]*env\(safe-area-inset-bottom\)[^}]*env\(safe-area-inset-left\)/u,
  );
  assert.match(cssSource, /\.library-panel:not\(\.is-embedded\)/u);
  assert.match(
    cssSource,
    /\.theme-preview-grid\s*\{\s*grid-template-columns:\s*1fr;/su,
  );
  assert.match(cssSource, /\.large-note-editor\s*\{[^}]*height:\s*100%;/su);
  assert.match(cssSource, /\.print-editor-toolbar\s*\{[^}]*overflow-x:\s*auto;/su);
  assert.match(
    cssSource,
    /\.home-workspace-body:has\(\.getting-started-walkthrough\) \.home-navigation\s*\{[^}]*display:\s*none;/su,
  );
});
