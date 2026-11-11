import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PdfOcrError } from '../src/types/pdfOcr.ts';
import {
  alignPdfOcrWordsToLines,
  createPdfOcrPageResult,
  mergePdfSearchPageIndexes,
} from '../src/utils/pdfOcr.ts';
import {
  createHighlightsFromSelections,
  normalizeAnnotationVisualGeometry,
  normalizeSelectionRectangles,
} from '../src/utils/highlights.ts';

const source = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

test('OCR blocks become bounded reading-order words and a searchable page index', () => {
  const result = createPdfOcrPageResult({
    pageNumber: 3,
    imageWidth: 1000,
    imageHeight: 500,
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  {
                    text: 'Hello',
                    confidence: 96,
                    bbox: { x0: 100, y0: 50, x1: 300, y1: 100 },
                  },
                  {
                    text: 'world',
                    confidence: 92,
                    bbox: { x0: 330, y0: 50, x1: 560, y1: 100 },
                  },
                ],
              },
              {
                words: [
                  {
                    text: 'Again',
                    confidence: 88,
                    bbox: { x0: 100, y0: 130, x1: 320, y1: 180 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.text, 'Hello world\nAgain');
  assert.equal(result.words[0].separator, 'space');
  assert.equal(result.words[1].separator, 'line');
  assert.deepEqual(result.words[0].rect, {
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.1,
  });
  assert.equal(result.searchIndex.pageNumber, 3);
  assert.equal(result.searchIndex.text, 'hello world again');
  assert.deepEqual(
    result.searchIndex.items.map(({ start, end }) => ({ start, end })),
    [
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ],
  );
});

test('OCR rejects empty and low-confidence output instead of exposing fabricated text', () => {
  assert.throws(
    () =>
      createPdfOcrPageResult({
        pageNumber: 1,
        imageWidth: 100,
        imageHeight: 100,
        blocks: [],
      }),
    (error: unknown) => error instanceof PdfOcrError && error.code === 'no-text',
  );
  assert.throws(
    () =>
      createPdfOcrPageResult({
        pageNumber: 1,
        imageWidth: 100,
        imageHeight: 100,
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    words: [
                      {
                        text: 'uncertain',
                        confidence: 30,
                        bbox: { x0: 0, y0: 0, x1: 80, y1: 20 },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    (error: unknown) => error instanceof PdfOcrError && error.code === 'low-confidence',
  );
});

test('OCR search supplements only pages without native PDF text', () => {
  const native = [
    { pageNumber: 1, text: 'native text', items: [] },
    { pageNumber: 2, text: '', items: [] },
  ];
  const supplemental = [
    { pageNumber: 1, text: 'wrong replacement', items: [] },
    { pageNumber: 2, text: 'recognized page', items: [] },
  ];
  assert.deepEqual(mergePdfSearchPageIndexes(native, supplemental), [
    native[0],
    supplemental[1],
  ]);
});

test('OCR line boxes and annotation geometry join words without joining lines', () => {
  const words = alignPdfOcrWordsToLines([
    {
      text: 'same',
      confidence: 95,
      rect: { x: 0.1, y: 0.1, width: 0.08, height: 0.03 },
      separator: 'space',
    },
    {
      text: 'line',
      confidence: 95,
      rect: { x: 0.19, y: 0.095, width: 0.07, height: 0.04 },
      separator: 'line',
    },
    {
      text: 'next',
      confidence: 95,
      rect: { x: 0.1, y: 0.16, width: 0.08, height: 0.03 },
      separator: 'none',
    },
  ]);
  assert.equal(words[0].rect.y, words[1].rect.y);
  assert.equal(words[0].rect.height, words[1].rect.height);
  assert.notEqual(words[1].rect.y, words[2].rect.y);

  const normalized = normalizeSelectionRectangles(
    [
      { left: 80, top: 60, width: 64, height: 18 },
      { left: 151, top: 57, width: 56, height: 24 },
      { left: 80, top: 100, width: 64, height: 18 },
    ],
    800,
    600,
  );
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].x, 0.1);
  assert.ok(normalized[0].width > 0.15);

  const rectangles = [
    { x: 0.1, y: 0.1, width: 0.08, height: 0.03 },
    { x: 0.19, y: 0.095, width: 0.07, height: 0.04 },
    { x: 0.1, y: 0.17, width: 0.08, height: 0.03 },
  ];
  const atOneTimes = normalizeAnnotationVisualGeometry(rectangles, 800, 600);
  const atThreeTimes = normalizeAnnotationVisualGeometry(rectangles, 2400, 1800);
  assert.deepEqual(atThreeTimes, atOneTimes);
  assert.equal(atOneTimes.length, 2);
});

test('raw local OCR remains explicit, session-only, bounded, cancellable, and same-origin', () => {
  const service = source('src/services/pdfOcr.ts');
  const assets = source('src/services/pdfOcrAssets.ts');
  const hook = source('src/hooks/usePdfOcr.ts');
  const page = source('src/components/pdf/PdfPage.tsx');
  const search = source('src/hooks/usePdfSearch.ts');
  const css = source('src/styles/index.css');
  const vite = source('vite.config.ts');
  const packageJson = source('package.json');

  assert.match(service, /MAX_OCR_PIXELS = 4_000_000/u);
  assert.match(service, /OCR_HARD_TIMEOUT_MS = 90_000/u);
  assert.match(service, /inspectPdfPageOcrEligibility/u);
  assert.match(service, /cacheMethod: 'none'/u);
  assert.match(service, /workerBlobURL: false/u);
  assert.match(service, /signal\.addEventListener\('abort'/u);
  assert.match(assets, /eng\.traineddata\.gz\?url/u);
  assert.match(assets, /url\.origin !== window\.location\.origin/u);
  assert.match(hook, /documentRun: IDLE_PDF_OCR_DOCUMENT_STATE/u);
  assert.doesNotMatch(hook, /indexedDB|localStorage|annotationPersistence/u);
  assert.match(page, /Recognize English text on this page/u);
  assert.match(page, /Recognize all image-only pages/u);
  assert.match(page, /width: dimensions\.width/u);
  assert.match(page, /onCancelRecognition/u);
  assert.match(search, /supplementalIndexes/u);
  assert.match(css, /\.textLayer \.ocr-text-word/u);
  assert.match(vite, /eng\.traineddata\.gz/u);
  assert.match(packageJson, /verify-ocr-runtime-assets\.mjs/u);
});

test('raw OCR remains session-only while explicit derived marks follow normal persistence', () => {
  const result = createPdfOcrPageResult({
    pageNumber: 2,
    imageWidth: 1000,
    imageHeight: 500,
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  {
                    text: 'Persisted',
                    confidence: 98,
                    bbox: { x0: 100, y0: 50, x1: 320, y1: 100 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const word = result.words[0];
  const [annotation] = createHighlightsFromSelections(
    [
      {
        text: result.text,
        pageNumber: result.pageNumber,
        pageWidth: 1000,
        pageHeight: 500,
        boundingRectangles: [
          {
            left: word.rect.x * 1000,
            top: word.rect.y * 500,
            width: word.rect.width * 1000,
            height: word.rect.height * 500,
          },
        ],
        startOffset: 0,
        endOffset: result.text.length,
      },
    ],
    'yellow',
  );
  assert.equal(annotation.text, 'Persisted');
  assert.equal(annotation.pageNumber, 2);
  assert.equal(annotation.rects.length, 1);

  const readme = source('README.md');
  const changelog = source('CHANGELOG.md');
  assert.match(readme, /Raw recognition text and coordinates remain session-only/u);
  assert.match(readme, /normal local persistence, backup, and optional Drive sync/u);
  assert.match(changelog, /ordinary user records[\s\S]*optional Drive sync/u);
  assert.match(source('src/services/annotationPersistence.ts'), /annotations/u);
  assert.match(source('src/sync/paperLocalAdapter.ts'), /annotation/u);
});
