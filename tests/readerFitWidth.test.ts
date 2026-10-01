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

const appLayoutSource = source('../src/components/AppLayout.tsx');
const viewerSource = source('../src/components/Viewer.tsx');
const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const elementSizeSource = source('../src/hooks/useElementSize.ts');
const occlusionHookSource = source('../src/hooks/useReaderOcclusionInsets.ts');
const notesPanelSource = source('../src/components/NotesPanel.tsx');
const sidebarSource = source('../src/components/Sidebar.tsx');
const styleSource = source('../src/styles/index.css');

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

test('Notes and Glossary share one measured right drawer rather than double counting', () => {
  assert.match(notesPanelSource, /aria-label="Notes and Glossary"/);
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
