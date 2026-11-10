import type {
  PdfOcrNormalizedRectangle,
  PdfOcrPageResult,
  PdfOcrWord,
} from '../types/pdfOcr.ts';
import { PdfOcrError } from '../types/pdfOcr.ts';
import type { PdfSearchPageIndex } from '../types/pdfSearch.ts';
import { normalizePdfSearchText } from './pdfSearch.ts';

const MIN_WORD_CONFIDENCE = 25;
const MIN_PAGE_CONFIDENCE = 40;
const MAX_OCR_WORDS_PER_PAGE = 12_000;

export interface RawPdfOcrWord {
  text?: unknown;
  confidence?: unknown;
  bbox?: {
    x0?: unknown;
    y0?: unknown;
    x1?: unknown;
    y1?: unknown;
  } | null;
}

export interface RawPdfOcrLine {
  words?: readonly RawPdfOcrWord[] | null;
}

export interface RawPdfOcrParagraph {
  lines?: readonly RawPdfOcrLine[] | null;
}

export interface RawPdfOcrBlock {
  paragraphs?: readonly RawPdfOcrParagraph[] | null;
}

export function createPdfOcrPageResult(input: {
  pageNumber: number;
  imageWidth: number;
  imageHeight: number;
  blocks: readonly RawPdfOcrBlock[] | null | undefined;
}): PdfOcrPageResult {
  if (!Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new PdfOcrError('recognition-failed', 'OCR returned an invalid page number.');
  }
  if (!isPositiveFinite(input.imageWidth) || !isPositiveFinite(input.imageHeight)) {
    throw new PdfOcrError('recognition-failed', 'OCR returned invalid image bounds.');
  }

  const lines = (input.blocks ?? []).flatMap((block) =>
    (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? []),
  );
  const wordsByLine = lines
    .map((line) =>
      (line.words ?? [])
        .map((word) => normalizeRawWord(word, input.imageWidth, input.imageHeight))
        .filter((word): word is Omit<PdfOcrWord, 'separator'> => word !== null),
    )
    .filter((words) => words.length > 0);

  const recognizedWordCount = wordsByLine.reduce(
    (count, words) => count + words.length,
    0,
  );
  if (recognizedWordCount === 0) {
    throw new PdfOcrError('no-text', 'No sufficiently reliable text was recognized.');
  }
  if (recognizedWordCount > MAX_OCR_WORDS_PER_PAGE) {
    throw new PdfOcrError(
      'recognition-failed',
      'The OCR result exceeded the safe per-page word limit.',
    );
  }

  const words = wordsByLine.flatMap((lineWords, lineIndex) =>
    lineWords.map((word, wordIndex) => ({
      ...word,
      separator:
        wordIndex < lineWords.length - 1
          ? ('space' as const)
          : lineIndex < wordsByLine.length - 1
            ? ('line' as const)
            : ('none' as const),
    })),
  );
  const confidence =
    words.reduce((total, word) => total + word.confidence, 0) / words.length;
  if (!Number.isFinite(confidence) || confidence < MIN_PAGE_CONFIDENCE) {
    throw new PdfOcrError(
      'low-confidence',
      'OCR confidence was too low to expose selectable text safely.',
    );
  }

  const text = words
    .map(
      (word) =>
        `${word.text}${word.separator === 'space' ? ' ' : word.separator === 'line' ? '\n' : ''}`,
    )
    .join('')
    .trim();
  const resultWithoutSearch = {
    pageNumber: input.pageNumber,
    language: 'eng' as const,
    confidence,
    text,
    words,
  };
  return {
    ...resultWithoutSearch,
    searchIndex: createPdfOcrSearchPageIndex(resultWithoutSearch),
  };
}

export function createPdfOcrSearchPageIndex(
  result: Pick<PdfOcrPageResult, 'pageNumber' | 'words'>,
): PdfSearchPageIndex {
  let text = '';
  const items: PdfSearchPageIndex['items'] = [];

  for (const word of result.words) {
    const normalizedWord = normalizePdfSearchText(word.text);
    if (!normalizedWord) continue;
    if (text && !text.endsWith(' ')) text += ' ';
    const start = text.length;
    text += normalizedWord;
    items.push({
      start,
      end: text.length,
      rect: { ...word.rect },
      direction: 'ltr',
    });
  }

  return { pageNumber: result.pageNumber, text, items };
}

export function mergePdfSearchPageIndexes(
  nativeIndexes: readonly PdfSearchPageIndex[],
  supplementalIndexes: readonly PdfSearchPageIndex[],
): PdfSearchPageIndex[] {
  const merged = new Map(nativeIndexes.map((page) => [page.pageNumber, page]));
  for (const supplemental of supplementalIndexes) {
    const native = merged.get(supplemental.pageNumber);
    if ((!native || native.text.trim().length === 0) && supplemental.text.trim()) {
      merged.set(supplemental.pageNumber, supplemental);
    }
  }
  return [...merged.values()].sort(
    (first, second) => first.pageNumber - second.pageNumber,
  );
}

export function renderPdfOcrTextLayer(
  container: HTMLElement,
  result: PdfOcrPageResult,
  pageWidth: number,
  pageHeight: number,
): void {
  container.replaceChildren();
  container.dataset.pdfOcrTextLayer = 'true';
  const measurementContext = document.createElement('canvas').getContext('2d');

  for (const word of alignPdfOcrWordsToLines(result.words)) {
    const left = word.rect.x * pageWidth;
    const top = word.rect.y * pageHeight;
    const width = word.rect.width * pageWidth;
    const height = word.rect.height * pageHeight;
    if (width <= 0 || height <= 0) continue;

    const span = document.createElement('span');
    span.className = 'ocr-text-word';
    span.dataset.ocrConfidence = word.confidence.toFixed(1);
    span.textContent = word.text;
    span.style.left = `${left}px`;
    span.style.top = `${top}px`;
    span.style.fontFamily = 'Arial, sans-serif';
    span.style.fontSize = `${height}px`;
    span.style.lineHeight = '1';
    span.style.transformOrigin = '0 0';
    if (measurementContext) {
      measurementContext.font = `${height}px Arial, sans-serif`;
      const measuredWidth = measurementContext.measureText(word.text).width;
      span.style.transform = `scaleX(${measuredWidth > 0 ? width / measuredWidth : 1})`;
    }
    container.append(span);
    if (word.separator !== 'none') {
      container.append(document.createTextNode(word.separator === 'line' ? '\n' : ' '));
    }
  }
}

/**
 * OCR engines return tight glyph boxes, so words with ascenders or descenders can
 * have slightly different vertical bounds even when they share one baseline.
 * A common line box keeps browser selection and the resulting Highlight/Underline
 * geometry continuous without changing the recognized text or stored OCR result.
 */
export function alignPdfOcrWordsToLines(words: readonly PdfOcrWord[]): PdfOcrWord[] {
  const aligned: PdfOcrWord[] = [];
  let line: PdfOcrWord[] = [];

  const flushLine = () => {
    if (line.length === 0) return;
    const top = Math.min(...line.map((word) => word.rect.y));
    const bottom = Math.max(...line.map((word) => word.rect.y + word.rect.height));
    const height = Math.max(0, bottom - top);
    aligned.push(
      ...line.map((word) => ({
        ...word,
        rect: { ...word.rect, y: top, height },
      })),
    );
    line = [];
  };

  for (const word of words) {
    line.push(word);
    if (word.separator === 'line') flushLine();
  }
  flushLine();
  return aligned;
}

export function clearPdfOcrTextLayer(container: HTMLElement): void {
  delete container.dataset.pdfOcrTextLayer;
  container.replaceChildren();
}

function normalizeRawWord(
  rawWord: RawPdfOcrWord,
  imageWidth: number,
  imageHeight: number,
): Omit<PdfOcrWord, 'separator'> | null {
  const text = typeof rawWord.text === 'string' ? rawWord.text.trim() : '';
  const confidence = toFiniteNumber(rawWord.confidence);
  if (!text || confidence === null || confidence < MIN_WORD_CONFIDENCE) return null;
  const bbox = rawWord.bbox;
  if (!bbox) return null;
  const x0 = toFiniteNumber(bbox.x0);
  const y0 = toFiniteNumber(bbox.y0);
  const x1 = toFiniteNumber(bbox.x1);
  const y1 = toFiniteNumber(bbox.y1);
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null;

  const left = clamp(Math.min(x0, x1), 0, imageWidth);
  const top = clamp(Math.min(y0, y1), 0, imageHeight);
  const right = clamp(Math.max(x0, x1), 0, imageWidth);
  const bottom = clamp(Math.max(y0, y1), 0, imageHeight);
  if (right <= left || bottom <= top) return null;

  const rect: PdfOcrNormalizedRectangle = {
    x: left / imageWidth,
    y: top / imageHeight,
    width: (right - left) / imageWidth,
    height: (bottom - top) / imageHeight,
  };
  return { text, confidence: clamp(confidence, 0, 100), rect };
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
