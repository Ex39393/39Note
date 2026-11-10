import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { themes } from '../src/themes.ts';
import {
  SEA_PDF_MAX_IMAGE_COVERAGE,
  SEA_PDF_MAX_COLORFUL_PIXEL_RATIO,
  SEA_PDF_MAX_PHOTO_MIDTONE_RATIO,
  SEA_PDF_MIN_PHOTO_COVERAGE,
  SEA_PDF_PAGE_BACKGROUND,
  SEA_PDF_PAGE_COLORS,
  SEA_PDF_PAGE_FOREGROUND,
  SEA_PDF_SAMPLE_SIZE,
  classifySeaPdfPresentation,
  decideSeaPdfPresentation,
  estimatePdfImageCoverage,
  getSeaPdfPageColors,
  resolveSeaPdfDocumentPresentations,
  summarizeSeaPdfPixels,
} from '../src/utils/seaPdfPresentation.ts';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const source = (relativePath: string) =>
  readFileSync(resolve(testDirectory, relativePath), 'utf8');

const pdfPageSource = source('../src/components/pdf/PdfPage.tsx');
const viewerSource = source('../src/components/Viewer.tsx');
const providerSource = source('../src/components/ThemeProvider.tsx');
const styleSource = source('../src/styles/index.css');
const exportSource = source('../src/services/annotatedPdfExport.ts');
const printSource = source('../src/print/PrintComposer.tsx');

test('Bright uses the accepted icy cyan-to-Cherry-Blossom gradients', () => {
  const bright = themes.bright;
  assert.equal(
    bright.shellBackground,
    'linear-gradient(135deg, #99FFFF 0%, #E7F8FA 47%, #F2A3B6 100%)',
  );
  assert.equal(
    bright.navigationBackground,
    'linear-gradient(180deg, #D7FAFC 0%, #F1F4F6 58%, #F6D4DD 100%)',
  );
  assert.equal(bright.pageBackground, '#FFFFFF');
  assert.equal(bright.canvasFilter, 'none');
  assert.equal(bright.noteColor, '#EEA0B2');
  assert.match(styleSource, /reader-empty-ambient--bright[\s\S]*?#99ffff/iu);
  assert.match(styleSource, /reader-empty-bright-bloom--blue[\s\S]*?#7df9ff 30%/iu);
  assert.match(styleSource, /reader-empty-bright-bloom--pink[\s\S]*?#f2a3b6/iu);
});

test('Sea declares exact PDF.js page colors without a fragile CSS blend', () => {
  assert.equal(themes.sea.pageBackground, '#10263F');
  assert.equal(themes.sea.pageTextColor, '#D7E8F5');
  assert.equal(themes.sea.canvasFilter, 'none');
  assert.equal(SEA_PDF_PAGE_BACKGROUND, themes.sea.pageBackground);
  assert.equal(SEA_PDF_PAGE_FOREGROUND, themes.sea.pageTextColor);
  assert.deepEqual(SEA_PDF_PAGE_COLORS, {
    background: '#10263F',
    foreground: '#D7E8F5',
  });
  assert.equal(getSeaPdfPageColors('sea', 'dark'), SEA_PDF_PAGE_COLORS);
  assert.equal(getSeaPdfPageColors('sea', 'preserve'), undefined);
  assert.equal(getSeaPdfPageColors('sea', 'pending'), undefined);
  assert.equal(getSeaPdfPageColors('original', 'dark'), undefined);
  assert.doesNotMatch(providerSource, /sea-paper-tone-filter/u);
  assert.doesNotMatch(
    styleSource,
    /data-sea-paper-presentation[\s\S]*?mix-blend-mode/u,
  );
});

test('Bay uses a light solid workspace and reserves its coastal gradient for empty Reader ambience', () => {
  assert.equal(themes.bay.shellBackground, '#BCEBFA');
  assert.equal(themes.bay.navigationBackground, '#DFF3F7');
  assert.equal(themes.bay.pageBackground, '#FFFFFF');
  assert.equal(themes.bay.canvasFilter, 'none');
  assert.match(
    styleSource,
    /--bay-reader-gradient:\s*linear-gradient\(\s*180deg,\s*#a0e0f8 0%,\s*#bcebfa 56%,\s*#f4debe 82%,\s*#f6b76f 100%\s*\)/iu,
  );
  assert.match(
    styleSource,
    /data-reading-theme='bay'[\s\S]*?:is\(\.home-content, \.app-content, \.viewer\)[\s\S]*?background:\s*var\(--bay-workspace-blue\)/u,
  );
  assert.doesNotMatch(themes.bay.shellBackground, /gradient/iu);
  assert.doesNotMatch(themes.bay.navigationBackground, /gradient/iu);
  assert.doesNotMatch(
    styleSource,
    /--bay-(?:workspace-blue|reader-gradient):[^;]*#(?:29b6f6|4fc3f7)/iu,
  );
});

test('Sea classifier treats ordinary academic details as dark-safe while protecting complex pages', () => {
  assert.equal(SEA_PDF_SAMPLE_SIZE, 40);
  const darkCases = [
    {
      label: 'ordinary text',
      input: {
        averageLuminance: 228,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.08,
        imageCoverage: 0,
        lightPixelRatio: 0.82,
      },
    },
    {
      label: 'ordinary table',
      input: {
        averageLuminance: 182,
        colorfulPixelRatio: 0.002,
        darkPixelRatio: 0.3,
        imageCoverage: 0.04,
        lightPixelRatio: 0.51,
      },
    },
    {
      label: 'small grayscale diagram',
      input: {
        averageLuminance: 205,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.08,
        imageCoverage: 0.12,
        lightPixelRatio: 0.68,
      },
    },
    {
      label: 'small colored heading',
      input: {
        averageLuminance: 220,
        colorfulPixelRatio: 0.035,
        darkPixelRatio: 0.08,
        imageCoverage: 0,
        lightPixelRatio: 0.72,
      },
    },
  ] as const;

  for (const { input, label } of darkCases) {
    assert.equal(classifySeaPdfPresentation(input), 'dark', label);
  }
  assert.equal(SEA_PDF_MAX_IMAGE_COVERAGE, 0.35);
  assert.equal(SEA_PDF_MIN_PHOTO_COVERAGE, 0.15);
  assert.equal(SEA_PDF_MAX_PHOTO_MIDTONE_RATIO, 0.2);
  assert.equal(SEA_PDF_MAX_COLORFUL_PIXEL_RATIO, 0.055);

  const preserveCases = [
    {
      label: 'colored chart',
      input: {
        averageLuminance: 224,
        colorfulPixelRatio: 0.14,
        darkPixelRatio: 0.05,
        imageCoverage: 0,
        lightPixelRatio: 0.75,
      },
    },
    {
      label: 'photograph',
      input: {
        averageLuminance: 220,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.05,
        imageCoverage: 0.2,
        lightPixelRatio: 0.55,
      },
    },
    {
      label: 'full-page scan',
      input: {
        averageLuminance: 218,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.06,
        imageCoverage: 1,
        lightPixelRatio: 0.74,
      },
    },
    {
      label: 'already-dark PDF',
      input: {
        averageLuminance: 42,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.84,
        imageCoverage: 0,
        lightPixelRatio: 0.08,
      },
    },
    {
      label: 'large grayscale diagram',
      input: {
        averageLuminance: 220,
        colorfulPixelRatio: 0,
        darkPixelRatio: 0.04,
        imageCoverage: 0.4,
        lightPixelRatio: 0.78,
      },
    },
  ] as const;

  for (const { input, label } of preserveCases) {
    assert.equal(classifySeaPdfPresentation(input), 'preserve', label);
  }
  assert.deepEqual(decideSeaPdfPresentation(preserveCases[0].input), {
    presentation: 'preserve',
    reason: 'color-rich',
  });
  assert.deepEqual(decideSeaPdfPresentation(preserveCases[1].input), {
    presentation: 'preserve',
    reason: 'image-rich',
  });
  assert.deepEqual(decideSeaPdfPresentation(preserveCases[3].input), {
    presentation: 'preserve',
    reason: 'already-dark-or-mixed',
  });
});

test('Sea document policy coheres borderline academic pages without overriding safety exclusions', () => {
  const contextual = decideSeaPdfPresentation({
    averageLuminance: 170,
    colorfulPixelRatio: 0.01,
    darkPixelRatio: 0.36,
    imageCoverage: 0.08,
    lightPixelRatio: 0.44,
  });
  assert.deepEqual(contextual, {
    presentation: 'preserve',
    reason: 'document-context-required',
  });
  assert.deepEqual(resolveSeaPdfDocumentPresentations({ 1: contextual }), {
    1: contextual,
  });
  assert.equal(
    resolveSeaPdfDocumentPresentations({ 1: contextual }, 1)[1].presentation,
    'dark',
  );

  const ordinary = decideSeaPdfPresentation({
    averageLuminance: 224,
    colorfulPixelRatio: 0,
    darkPixelRatio: 0.1,
    imageCoverage: 0,
    lightPixelRatio: 0.78,
  });
  const colorRich = decideSeaPdfPresentation({
    averageLuminance: 210,
    colorfulPixelRatio: 0.18,
    darkPixelRatio: 0.08,
    imageCoverage: 0,
    lightPixelRatio: 0.68,
  });
  const scan = decideSeaPdfPresentation({
    averageLuminance: 214,
    colorfulPixelRatio: 0,
    darkPixelRatio: 0.08,
    imageCoverage: 1,
    lightPixelRatio: 0.7,
  });
  const alreadyDark = decideSeaPdfPresentation({
    averageLuminance: 42,
    colorfulPixelRatio: 0,
    darkPixelRatio: 0.84,
    imageCoverage: 0,
    lightPixelRatio: 0.08,
  });
  const resolved = resolveSeaPdfDocumentPresentations({
    1: ordinary,
    2: contextual,
    3: colorRich,
    4: scan,
    5: alreadyDark,
  });
  assert.deepEqual(resolved[1], ordinary);
  assert.deepEqual(resolved[2], {
    presentation: 'dark',
    reason: 'document-coherent-academic',
  });
  assert.deepEqual(resolved[3], colorRich);
  assert.deepEqual(resolved[4], scan);
  assert.deepEqual(resolved[5], alreadyDark);

  const secondContextual = { ...contextual };
  const contextOnly = resolveSeaPdfDocumentPresentations({
    7: contextual,
    8: secondContextual,
  });
  assert.equal(contextOnly[7].presentation, 'dark');
  assert.equal(contextOnly[8].presentation, 'dark');

  const tenPageArticle = resolveSeaPdfDocumentPresentations(
    Object.fromEntries(Array.from({ length: 10 }, (_, index) => [index + 1, ordinary])),
  );
  assert.equal(Object.values(tenPageArticle).length, 10);
  assert.ok(
    Object.values(tenPageArticle).every(({ presentation }) => presentation === 'dark'),
  );
});

test('Sea classifier uses bounded samples and normalized PDF.js image coverage', () => {
  const pixels = new Uint8ClampedArray(SEA_PDF_SAMPLE_SIZE ** 2 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 255;
    pixels[index + 1] = 255;
    pixels[index + 2] = 255;
    pixels[index + 3] = 255;
  }
  const summary = summarizeSeaPdfPixels(pixels);
  assert.ok(summary);
  assert.ok(Math.abs(summary.averageLuminance - 255) < 0.0001);
  assert.equal(summary.colorfulPixelRatio, 0);
  assert.equal(summary.darkPixelRatio, 0);
  assert.equal(summary.lightPixelRatio, 1);
  assert.equal(estimatePdfImageCoverage([0, 0, 0, 0.5, 0.5, 0]), 0.25);
  assert.equal(
    estimatePdfImageCoverage([0, 0, 0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 1, 1, 0.5]),
    0.5,
  );
  assert.equal(estimatePdfImageCoverage([Number.NaN, 0, 0, 1, 1, 0]), 0);
});

test('Sea dark presentation stays canvas-only, fail-safe, and theme-scoped', () => {
  assert.match(
    pdfPageSource,
    /recordImages:\s*classifiedSeaPageRef\.current !== page/u,
  );
  assert.match(
    pdfPageSource,
    /inspectSeaPdfCanvas\([\s\S]*?canvas,[\s\S]*?page\.imageCoordinates/u,
  );
  assert.match(
    pdfPageSource,
    /data-sea-paper-presentation=\{effectiveSeaPaperDecision\.presentation\}/u,
  );
  assert.match(
    pdfPageSource,
    /data-sea-paper-reason=\{effectiveSeaPaperDecision\.reason\}/u,
  );
  assert.match(pdfPageSource, /onSeaPaperDecision\(pageNumber, decision\)/u);
  assert.match(viewerSource, /resolveSeaPdfDocumentPresentations/u);
  assert.match(viewerSource, /seaPageDecisionState\.document === document/u);
  assert.match(
    pdfPageSource,
    /pageColors:\s*seaPageColors[\s\S]*?data-sea-paper-render-mode=\{seaPageColors \? 'pdfjs-page-colors' : 'original'\}/u,
  );
  assert.match(
    pdfPageSource,
    /\[\s*isNearViewport,\s*onSeaPaperDecision,\s*page,\s*pageNumber,\s*seaPageColors,\s*viewport,?\s*\]/u,
  );
  assert.doesNotMatch(
    styleSource,
    /\.theme-root\[data-reading-theme='(?:original|soft-gray|mint|bay|bright)'\][^{]*\.pdf-page/u,
  );

  for (const themeId of ['original', 'mint', 'bay', 'bright'] as const) {
    assert.equal(themes[themeId].canvasFilter, 'none');
  }
  assert.doesNotMatch(
    exportSource,
    /sea-paper|data-reading-theme|theme-canvas-filter/u,
  );
  assert.doesNotMatch(printSource, /sea-paper|data-reading-theme|theme-canvas-filter/u);
});
