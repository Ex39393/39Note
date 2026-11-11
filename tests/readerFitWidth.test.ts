import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  calculateManualZoomStep,
  calculatePdfPageScale,
} from '../src/utils/pdfPageScale.ts';
import {
  deriveReaderOcclusionInsets,
  measureReaderEdgeOverlap,
} from '../src/utils/readerOcclusion.ts';
import { readingThemes } from '../src/themes.ts';
import {
  DARK_EMPTY_READER_MOTE_COUNT,
  EMPTY_READER_AMBIENT_EFFECT_BY_THEME,
  TWILIGHT_EMPTY_READER_MOTE_COUNT,
  darkEmptyReaderDustGroups,
  twilightEmptyReaderDustGroups,
} from '../src/utils/emptyReaderAmbient.ts';

const appLayoutSource = source('../src/components/AppLayout.tsx');
const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const elementSizeSource = source('../src/hooks/useElementSize.ts');
const occlusionHookSource = source('../src/hooks/useReaderOcclusionInsets.ts');
const notesPanelSource = source('../src/components/NotesPanel.tsx');
const sidebarSource = source('../src/components/Sidebar.tsx');
const styleSource = source('../src/styles/index.css');
const emptyReaderAmbientSource = source('../src/components/EmptyReaderAmbient.tsx');
const emptyReaderAmbientModelSource = source('../src/utils/emptyReaderAmbient.ts');

test('empty Reader ambient model covers ten distinct active-theme concepts', () => {
  assert.deepEqual(Object.keys(EMPTY_READER_AMBIENT_EFFECT_BY_THEME), readingThemes);
  assert.equal(
    new Set(Object.values(EMPTY_READER_AMBIENT_EFFECT_BY_THEME)).size,
    readingThemes.length,
  );
  assert.deepEqual(EMPTY_READER_AMBIENT_EFFECT_BY_THEME, {
    original: 'paper-window',
    'soft-gray': 'frosted-reflections',
    mint: 'water-caustics',
    dark: 'white-dust',
    midnight: 'aurora-curtains',
    twilight: 'tyndall-dust',
    dawn: 'sunrise-clouds',
    sea: 'subsurface-light',
    bay: 'coastal-horizon',
    bright: 'cherry-sky',
  });

  const twilightCount = countMotes(twilightEmptyReaderDustGroups);
  const darkCount = countMotes(darkEmptyReaderDustGroups);
  assert.equal(twilightCount, TWILIGHT_EMPTY_READER_MOTE_COUNT);
  assert.equal(darkCount, DARK_EMPTY_READER_MOTE_COUNT);
  assert.ok(twilightCount >= 40 && twilightCount <= 60);
  assert.ok(darkCount >= 35 && darkCount <= 55);
  assert.ok(countCompactMotes(twilightEmptyReaderDustGroups) < twilightCount);
  assert.ok(countCompactMotes(darkEmptyReaderDustGroups) < darkCount);

  for (const group of [
    ...twilightEmptyReaderDustGroups,
    ...darkEmptyReaderDustGroups,
  ]) {
    assert.ok(group.duration >= 7 && group.duration <= 35);
    assert.ok(group.delay < 0);
    for (const mote of group.motes) {
      assert.ok(mote.x >= 0 && mote.x <= 100);
      assert.ok(mote.y >= 0 && mote.y <= 100);
      assert.ok(mote.size >= 0.8 && mote.size <= 3.35);
      assert.ok(mote.opacity >= 0.32 && mote.opacity <= 0.88);
    }
  }
  assert.doesNotMatch(
    emptyReaderAmbientModelSource,
    /Math\.random|requestAnimationFrame/u,
  );
});

test('empty Reader renders one assistive-hidden, theme-specific atmosphere only', () => {
  assert.match(
    viewerSource,
    /className=\{`viewer is-empty \$\{isDragging \? 'is-dragging' : ''\}`\}/u,
  );
  assert.equal(viewerSource.match(/<EmptyReaderAmbient \/>/gu)?.length, 1);
  assert.match(
    viewerSource,
    /if \(!file\)[\s\S]*?<EmptyReaderAmbient \/>[\s\S]*?className="viewer is-document-loaded"/u,
  );
  assert.doesNotMatch(
    viewerSource.slice(viewerSource.indexOf('className="viewer is-document-loaded"')),
    /EmptyReaderAmbient/u,
  );
  assert.match(emptyReaderAmbientSource, /const \{ themeId \} = useTheme\(\)/u);
  assert.match(emptyReaderAmbientSource, /aria-hidden="true"/u);
  assert.match(emptyReaderAmbientSource, /data-empty-reader-theme=\{themeId\}/u);
  assert.match(
    emptyReaderAmbientSource,
    /data-empty-reader-effect=\{EMPTY_READER_AMBIENT_EFFECT_BY_THEME\[themeId\]\}/u,
  );
  for (const theme of readingThemes) {
    assert.match(emptyReaderAmbientSource, new RegExp(`case '${theme}'`, 'u'));
  }
  assert.doesNotMatch(
    emptyReaderAmbientSource,
    /tabIndex=|<button|<input|<a\s|setInterval|requestAnimationFrame/u,
  );

  const midnightCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'midnight':"),
    emptyReaderAmbientSource.indexOf("case 'dawn':"),
  );
  assert.match(
    midnightCase,
    /<svg[\s\S]*?reader-empty-aurora-curtains[\s\S]*?focusable="false"/u,
  );
  assert.equal(midnightCase.match(/reader-empty-aurora-curtain--/gu)?.length, 2);
  assert.match(midnightCase, /reader-empty-aurora-curtain--left/u);
  assert.match(midnightCase, /reader-empty-aurora-curtain--right/u);
  assert.equal(midnightCase.match(/reader-empty-midnight-depth/gu)?.length, 1);
  assert.equal(
    midnightCase.match(
      /className="reader-empty-aurora-fold reader-empty-aurora-fold--left-/gu,
    )?.length,
    3,
  );
  assert.equal(
    midnightCase.match(
      /className="reader-empty-aurora-fold reader-empty-aurora-fold--right-/gu,
    )?.length,
    2,
  );
  assert.match(midnightCase, /reader-aurora-left-fold-volume/u);
  assert.match(midnightCase, /reader-aurora-right-fold-volume/u);
  assert.equal(
    midnightCase.match(/fill="url\(#reader-aurora-left-fold-volume\)"/gu)?.length,
    3,
  );
  assert.equal(
    midnightCase.match(/fill="url\(#reader-aurora-right-fold-volume\)"/gu)?.length,
    2,
  );
  assert.equal(
    midnightCase.match(/mask="url\(#reader-aurora-left-mask\)"/gu)?.length,
    4,
  );
  assert.equal(
    midnightCase.match(/mask="url\(#reader-aurora-right-mask\)"/gu)?.length,
    3,
  );
  assert.doesNotMatch(
    midnightCase,
    /reader-empty-aurora-ribbon|fill="none"|\bstroke(?:Width)?=/u,
  );
  assert.doesNotMatch(midnightCase, /DustFields|dust-mote/u);

  const dawnCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'dawn':"),
    emptyReaderAmbientSource.indexOf("case 'mint':"),
  );
  assert.match(dawnCase, /<svg[\s\S]*?reader-empty-dawn-clouds/u);
  assert.equal(dawnCase.match(/reader-empty-dawn-wisp--/gu)?.length, 3);
  assert.doesNotMatch(dawnCase, /reader-empty-dawn-cloud reader/u);

  const softGrayCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'soft-gray':"),
    emptyReaderAmbientSource.indexOf("case 'original':"),
  );
  assert.match(softGrayCase, /reader-empty-frosted-sheen--primary/u);
  assert.match(softGrayCase, /reader-empty-frosted-sheen--secondary/u);
  assert.equal(softGrayCase.match(/reader-empty-frosted-curve--/gu)?.length, 2);
  assert.doesNotMatch(softGrayCase, /reader-empty-frosted-contour/u);

  const seaCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'sea':"),
    emptyReaderAmbientSource.indexOf("case 'bay':"),
  );
  assert.equal(seaCase.match(/reader-empty-sea-shaft--/gu)?.length, 2);
  assert.match(seaCase, /reader-empty-sea-surface/u);
  assert.match(seaCase, /reader-empty-sea-current/u);
  assert.doesNotMatch(seaCase, /DustFields|<svg/u);

  const bayCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'bay':"),
    emptyReaderAmbientSource.indexOf("case 'bright':"),
  );
  assert.match(bayCase, /return null;/u);
  assert.doesNotMatch(bayCase, /reader-empty-bay-|DustFields|<span|<svg/u);

  const brightCase = emptyReaderAmbientSource.slice(
    emptyReaderAmbientSource.indexOf("case 'bright':"),
    emptyReaderAmbientSource.indexOf("case 'twilight':"),
  );
  assert.equal(brightCase.match(/reader-empty-bright-bloom--/gu)?.length, 2);
  assert.match(brightCase, /reader-empty-bright-lustre/u);
  assert.match(brightCase, /reader-empty-bright-veil/u);
  assert.doesNotMatch(brightCase, /DustFields|<svg/u);
});

test('empty Reader atmosphere stays clipped, responsive, and motion-accessible', () => {
  const ambientCss = styleSource.slice(
    styleSource.indexOf('.reader-empty-ambient {'),
    styleSource.indexOf('.viewer-icon {'),
  );
  assert.match(
    ambientCss,
    /\.reader-empty-ambient\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*overflow:\s*hidden[^}]*contain:\s*paint[^}]*pointer-events:\s*none/su,
  );
  assert.match(
    ambientCss,
    /\.viewer\.is-empty \.viewer-panel > :not\(\.reader-empty-ambient\)\s*\{[^}]*z-index:\s*2/su,
  );
  for (const className of [
    'reader-empty-ambient--original',
    'reader-empty-ambient--soft-gray',
    'reader-empty-ambient--mint',
    'reader-empty-ambient--dark',
    'reader-empty-ambient--midnight',
    'reader-empty-ambient--twilight',
    'reader-empty-ambient--dawn',
    'reader-empty-ambient--sea',
    'reader-empty-ambient--bay',
    'reader-empty-ambient--bright',
  ]) {
    assert.match(ambientCss, new RegExp(`\\.${className}\\s*\\{`, 'u'));
  }
  assert.match(ambientCss, /@keyframes reader-empty-dust-drift/u);
  assert.match(ambientCss, /@keyframes reader-empty-aurora-curtain-left/u);
  assert.match(ambientCss, /@keyframes reader-empty-aurora-curtain-right/u);
  assert.match(ambientCss, /@keyframes reader-empty-dawn-wisp-one/u);
  assert.match(ambientCss, /@keyframes reader-empty-mint-caustic-one/u);
  assert.match(ambientCss, /@keyframes reader-empty-frosted-sheen-primary/u);
  assert.match(ambientCss, /@keyframes reader-empty-frosted-curve-primary/u);
  assert.match(ambientCss, /@keyframes reader-empty-window-shadow-one/u);
  assert.match(ambientCss, /@keyframes reader-empty-sea-shaft-left/u);
  assert.doesNotMatch(ambientCss, /reader-empty-bay-sun/u);
  assert.match(ambientCss, /@keyframes reader-empty-bright-lustre/u);
  const midnightCss = ambientCss.slice(
    ambientCss.indexOf('/* Midnight:'),
    ambientCss.indexOf('/* Dawn:'),
  );
  assert.match(
    midnightCss,
    /\.reader-empty-aurora-curtain--left\s*\{[\s\S]*?animation:\s*reader-empty-aurora-curtain-left 34s/u,
  );
  assert.match(
    midnightCss,
    /\.reader-empty-aurora-curtain--right\s*\{[\s\S]*?animation:\s*reader-empty-aurora-curtain-right 41s/u,
  );
  assert.match(
    midnightCss,
    /\.reader-empty-midnight-depth\s*\{[\s\S]*?animation:\s*reader-empty-midnight-depth 48s/u,
  );
  assert.match(
    midnightCss,
    /\.reader-empty-aurora-folds\s*\{[^}]*filter:\s*blur\(3px\)[^}]*mix-blend-mode:\s*screen/su,
  );
  assert.match(
    midnightCss,
    /\.reader-empty-aurora-fold\s*\{[^}]*opacity:\s*var\(--reader-aurora-fold-opacity-rest\)/su,
  );
  assert.match(ambientCss, /@keyframes reader-empty-aurora-fold-breathe/u);
  for (const [foldClass, duration, delay] of [
    ['left-one', 37, -19],
    ['left-two', 43, -31],
    ['left-three', 46, -9],
    ['right-one', 39, -24],
    ['right-two', 47, -13],
  ] as const) {
    assert.match(
      midnightCss,
      new RegExp(
        `\\.reader-empty-aurora-fold--${foldClass}\\s*\\{[\\s\\S]*?--reader-aurora-fold-duration:\\s*${duration}s;[\\s\\S]*?--reader-aurora-fold-delay:\\s*${delay}s`,
        'u',
      ),
    );
  }
  assert.doesNotMatch(
    midnightCss,
    /aurora-ribbon|aurora-curtain--(?:one|two|three)|aurora-curtain-three/u,
  );
  assert.doesNotMatch(midnightCss, /\bstroke(?:-width)?\s*:/u);
  const softGrayCss = ambientCss.slice(
    ambientCss.indexOf('/* Soft Gray:'),
    ambientCss.indexOf('/* Original:'),
  );
  assert.match(softGrayCss, /reader-empty-frosted-reflections/u);
  assert.doesNotMatch(softGrayCss, /frosted-contour|border:\s*1px/iu);
  const keyframes = ambientCss.slice(ambientCss.indexOf('@keyframes'));
  assert.doesNotMatch(
    keyframes,
    /background-position:|filter:|backdrop-filter:|(?:^|\s)(?:top|left|width|height):/mu,
  );
  assert.doesNotMatch(ambientCss, /will-change:|position:\s*fixed/u);
  assert.match(
    ambientCss,
    /@media \(max-width: 620px\)[\s\S]*?\.reader-empty-dust-field\[data-compact-hidden='true'\][\s\S]*?display:\s*none/u,
  );
  assert.match(
    ambientCss,
    /@media \(max-width: 620px\)[\s\S]*?\.reader-empty-sea-shaft--right[\s\S]*?\.reader-empty-bright-lustre[\s\S]*?display:\s*none/u,
  );
  assert.match(
    ambientCss,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.reader-empty-ambient \*[\s\S]*?animation:\s*none !important;[\s\S]*?transition:\s*none !important;/u,
  );
  assert.doesNotMatch(ambientCss, /viewer-empty-particles-drift/u);
});

test('Fit Width with closed Reader drawers retains the full Reader content width', () => {
  const insets = deriveReaderOcclusionInsets([
    { edge: 'left', width: 300, active: false },
    { edge: 'right', width: 340, active: false },
  ]);
  assert.deepEqual(insets, { left: 0, right: 0 });
  assert.equal(fitWidthScale(1000), (1000 - 64) / 600);
});

test('opening and closing Notes recalculates Fit Width against its measured occlusion', () => {
  const open = deriveReaderOcclusionInsets([
    { edge: 'right', width: 337, active: true },
  ]);
  const openScale = fitWidthScale(1000 - open.right);
  const closedScale = fitWidthScale(1000);
  assert.deepEqual(open, { left: 0, right: 337 });
  assert.ok(openScale < closedScale);
  assert.equal(fitWidthScale(1000 - 0), closedScale);
  assert.match(
    notesPanelSource,
    /data-reader-occlusion-active=\{isOpen \? 'true' : 'false'\}/,
  );
  assert.match(notesPanelSource, /data-reader-occlusion-edge="right"/);
});

test('Notes, Glossary, and Links share one measured right drawer rather than double counting', () => {
  assert.match(notesPanelSource, /aria-label="Notes, Glossary, and Links"/);
  const insets = deriveReaderOcclusionInsets([
    { edge: 'right', width: 340, active: true },
    { edge: 'right', width: 340, active: true },
  ]);
  assert.deepEqual(insets, { left: 0, right: 340 });
});

test('Reader Tools and a right drawer safely combine their actual rendered widths', () => {
  const insets = deriveReaderOcclusionInsets([
    { edge: 'left', width: 286.5, active: true },
    { edge: 'right', width: 332.25, active: true },
  ]);
  assert.deepEqual(insets, { left: 286.5, right: 332.25 });
  assert.match(sidebarSource, /data-reader-occlusion-edge="left"/);
  assert.match(
    sidebarSource,
    /data-reader-occlusion-active=\{isCollapsed \? 'false' : 'true'\}/,
  );
  assert.match(occlusionHookSource, /occluder\.offsetWidth/);
  assert.match(occlusionHookSource, /overlapWidth/);
});

test('Fit Width remains a true fit below the manual zoom floor with both drawers open', () => {
  const unobscuredWidth = 800 - 300 - 340;
  const scale = calculatePdfPageScale({
    fitMode: 'width',
    zoom: 1,
    containerWidth: unobscuredWidth,
    containerHeight: 800,
    pageWidth: 612,
    pageHeight: 792,
  });
  assert.equal(scale, (unobscuredWidth - 64) / 612);
  assert.ok(scale < 0.25);
  assert.ok(612 * scale + 64 <= unobscuredWidth);
  assert.match(
    styleSource,
    /\.pdf-scroll\.is-fit-width \.pdf-page-shell\s*\{[^}]*min-width: 0;[^}]*min-height: 0;/s,
  );
});

test('PDF page borders cannot consume and clip the rendered page dimensions', () => {
  assert.match(styleSource, /\.pdf-page-shell\s*\{[^}]*box-sizing: content-box;/s);
  assert.match(
    pdfPageSource,
    /width: dimensions\.width,\s*height: dimensions\.height,/,
  );
});

test('manual 100% zoom in keeps the existing normal step', () => {
  assert.equal(calculateManualZoomStep(1, 'in'), 1.2);
});

test('manual 100% zoom out keeps the existing normal step', () => {
  assert.equal(calculateManualZoomStep(1, 'out'), 1 / 1.2);
});

test('Fit Page zoom in starts from the exact effective scale, not stale manual zoom', () => {
  const effectiveFitPageZoom = 2.318;
  assert.equal(
    calculateManualZoomStep(effectiveFitPageZoom, 'in'),
    effectiveFitPageZoom * 1.2,
  );
  assert.notEqual(calculateManualZoomStep(effectiveFitPageZoom, 'in'), 1.2);
});

test('Fit Page zoom out starts from the exact effective scale, not stale manual zoom', () => {
  const effectiveFitPageZoom = 2.318;
  assert.equal(
    calculateManualZoomStep(effectiveFitPageZoom, 'out'),
    effectiveFitPageZoom / 1.2,
  );
  assert.notEqual(calculateManualZoomStep(effectiveFitPageZoom, 'out'), 1 / 1.2);
});

test('Fit Width zoom in uses its current unrounded effective scale', () => {
  const effectiveFitWidthZoom = fitWidthScale(926.374);
  assert.equal(
    calculateManualZoomStep(effectiveFitWidthZoom, 'in'),
    effectiveFitWidthZoom * 1.2,
  );
});

test('Fit Width zoom out uses its current unrounded effective scale', () => {
  const effectiveFitWidthZoom = fitWidthScale(926.374);
  assert.equal(
    calculateManualZoomStep(effectiveFitWidthZoom, 'out'),
    effectiveFitWidthZoom / 1.2,
  );
});

test('zoom controls read effective scale before switching either fit mode to manual', () => {
  const baselineIndex = appLayoutSource.indexOf(
    'calculateManualZoomStep(effectiveZoomRef.current, direction)',
  );
  const captureIndex = appLayoutSource.indexOf('beginZoomOperation()', baselineIndex);
  const manualIndex = appLayoutSource.indexOf('setFitMode(null)', baselineIndex);
  const zoomIndex = appLayoutSource.indexOf('setZoom(nextZoom)', baselineIndex);
  const effectiveIndex = appLayoutSource.indexOf(
    'updateEffectiveZoom(nextZoom)',
    baselineIndex,
  );
  assert.ok(
    baselineIndex >= 0 &&
      baselineIndex < captureIndex &&
      captureIndex < manualIndex &&
      manualIndex < zoomIndex &&
      zoomIndex < effectiveIndex,
  );
  assert.doesNotMatch(
    appLayoutSource,
    /setZoom\(\(currentZoom\) => Math\.(?:min|max)\(currentZoom/,
  );
  assert.match(appLayoutSource, /const zoomIn = \(\) => applyZoomStep\('in'\)/);
  assert.match(appLayoutSource, /const zoomOut = \(\) => applyZoomStep\('out'\)/);
  assert.match(
    appLayoutSource,
    /onFitWidth=\{\(\) => \{\s*beginZoomOperation\(\);\s*setFitMode\('width'\);/,
  );
  assert.match(
    appLayoutSource,
    /onFitPage=\{\(\) => \{\s*beginZoomOperation\(\);\s*setFitMode\('page'\);/,
  );
});

test('only the panel portion that actually intersects the Reader is subtracted', () => {
  const layout = { left: 0, right: 1200 };
  const readerWithAiSibling = { left: 0, right: 850 };
  assert.equal(measureReaderEdgeOverlap('left', 300, layout, readerWithAiSibling), 300);
  assert.equal(measureReaderEdgeOverlap('right', 340, layout, readerWithAiSibling), 0);
  assert.equal(measureReaderEdgeOverlap('right', 420, layout, readerWithAiSibling), 70);
});

test('Reader resize is observed so a resized AI sibling cannot leave stale occlusion', () => {
  assert.match(occlusionHookSource, /resizeObserver\.observe\(readerElement\)/);
  const layout = { left: 0, right: 1200 };
  assert.equal(
    measureReaderEdgeOverlap('right', 340, layout, { left: 0, right: 850 }),
    0,
  );
  assert.equal(
    measureReaderEdgeOverlap('right', 340, layout, { left: 0, right: 980 }),
    120,
  );
});

test('after +/- switches to manual, drawers no longer recalculate Fit Width', () => {
  const manualZoom = calculateManualZoomStep(fitWidthScale(926.374), 'in');
  for (const containerWidth of [1000, 660, 420]) {
    assert.equal(
      calculatePdfPageScale({
        fitMode: null,
        zoom: manualZoom,
        containerWidth,
        containerHeight: 800,
        pageWidth: 600,
        pageHeight: 800,
      }),
      manualZoom,
    );
  }
  assert.match(viewerSource, /useReaderOcclusionInsets\([\s\S]*?fitMode === 'width'/);
  assert.match(
    viewerSource,
    /fitMode === 'width' \? onFitWidthLayoutChange : undefined/,
  );
});

test('selecting Fit Width again restores responsive drawer-aware fitting', () => {
  assert.notEqual(fitWidthScale(1000), fitWidthScale(620));
  assert.match(
    appLayoutSource,
    /onFitWidth=\{\(\) => \{\s*beginZoomOperation\(\);\s*setFitMode\('width'\);/,
  );
});

test('Fit Width occlusion uses the content box and preserves the existing normal gutters', () => {
  assert.match(
    styleSource,
    /\.pdf-scroll\.is-fit-width[\s\S]*?--reader-occlusion-right/,
  );
  assert.match(
    styleSource,
    /\.pdf-scroll\.is-fit-width[\s\S]*?--reader-occlusion-left/,
  );
  assert.match(elementSizeSource, /entry\.contentRect\.width/);
  assert.match(pdfPageSource, /calculatePdfPageScale/);
});

test('a content-box resize captures and restores the existing semantic zoom anchor', () => {
  const callbackIndex = elementSizeSource.indexOf('onBeforeChangeRef.current?.()');
  const updateIndex = elementSizeSource.indexOf('sizeRef.current = nextSize');
  assert.ok(callbackIndex >= 0 && callbackIndex < updateIndex);
  assert.match(appLayoutSource, /const beginZoomOperation = useCallback/);
  assert.match(
    appLayoutSource,
    /viewerRef\.current\?\.captureZoomAnchor\(nextOperationId\)/,
  );
  assert.match(viewerSource, /centreOffset/);
  assert.match(viewerSource, /restoreZoomAnchor/);
  assert.match(viewerSource, /scroller\.scrollTop \+= targetCentre - scrollerCentre/);
});

test('drawer measurement cannot remount or reload the PDF document', () => {
  const loadingStart = viewerSource.indexOf('const loadingTask = getDocument');
  const loadingEnd = viewerSource.indexOf(
    'useEffect(() => {\n    setSearchPanelPosition',
    loadingStart,
  );
  const loadingBlock = viewerSource.slice(loadingStart, loadingEnd);
  assert.ok(loadingStart >= 0 && loadingEnd > loadingStart);
  assert.doesNotMatch(loadingBlock, /readerOcclusion|drawer|sidebar|containerSize/);
  assert.match(viewerSource, /key=\{index \+ 1\}/);
  assert.match(
    loadingBlock,
    /\[\s*file,\s*onCurrentPageChange,\s*onPageCountChange,\s*onDocumentReady,\s*onPdfDocumentChange,?\s*\]/,
  );
});

test('repeated drawer transitions are equality-guarded and use no animation-frame measurement loop', () => {
  assert.match(occlusionHookSource, /areReaderOcclusionInsetsEqual/);
  assert.match(elementSizeSource, /currentSize\.width === nextSize\.width/);
  assert.match(occlusionHookSource, /new ResizeObserver\(measure\)/);
  assert.match(occlusionHookSource, /new MutationObserver\(refreshOccluders\)/);
  assert.doesNotMatch(occlusionHookSource, /requestAnimationFrame|setInterval/);
  assert.match(occlusionHookSource, /resizeObserver\.disconnect\(\)/);
  assert.match(occlusionHookSource, /mutationObserver\.disconnect\(\)/);
  assert.match(occlusionHookSource, /attributeOldValue: true/);
  assert.match(occlusionHookSource, /transitionend/);
  assert.match(occlusionHookSource, /closingOccluders/);
});

function countMotes(groups: readonly { motes: readonly unknown[] }[]): number {
  return groups.reduce((total, group) => total + group.motes.length, 0);
}

function countCompactMotes(
  groups: readonly { compactHidden: boolean; motes: readonly unknown[] }[],
): number {
  return groups.reduce(
    (total, group) => total + (group.compactHidden ? 0 : group.motes.length),
    0,
  );
}

function fitWidthScale(containerWidth: number): number {
  return calculatePdfPageScale({
    fitMode: 'width',
    zoom: 1,
    containerWidth,
    containerHeight: 800,
    pageWidth: 600,
    pageHeight: 800,
  });
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}
