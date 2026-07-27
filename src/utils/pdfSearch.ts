import { Util, type PDFPageProxy } from 'pdfjs-dist';
import type {
  NormalizedSearchRectangle,
  PdfSearchPageIndex,
  PdfSearchResult,
} from '../types/pdfSearch';

export async function createPdfSearchPageIndex(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<PdfSearchPageIndex> {
  const [textContent, viewport] = await Promise.all([
    page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
    Promise.resolve(page.getViewport({ scale: 1 })),
  ]);

  let text = '';
  const items: PdfSearchPageIndex['items'] = [];

  for (const contentItem of textContent.items) {
    if (!('str' in contentItem)) {
      continue;
    }

    const item = contentItem as PdfTextItem;
    const itemText = normalizePdfSearchText(item.str);
    if (itemText.length === 0) {
      continue;
    }

    if (text.length > 0 && !text.endsWith(' ')) {
      text += ' ';
    }

    const start = text.length;
    text += itemText;
    const end = text.length;
    items.push({
      start,
      end,
      rect: getNormalizedItemRectangle(item, viewport),
      direction: item.dir,
    });
  }

  return { pageNumber, text, items };
}

export function findPdfSearchResults(
  index: PdfSearchPageIndex[],
  query: string,
): PdfSearchResult[] {
  const normalizedQuery = normalizePdfSearchText(query);
  if (normalizedQuery.length === 0) {
    return [];
  }

  return index.flatMap((page) => {
    const matches: PdfSearchResult[] = [];
    let offset = 0;
    let matchIndexOnPage = 0;

    while (offset < page.text.length) {
      const matchStart = page.text.indexOf(normalizedQuery, offset);
      if (matchStart === -1) {
        break;
      }

      const matchEnd = matchStart + normalizedQuery.length;
      const rects = page.items
        .filter((item) => item.start < matchEnd && item.end > matchStart)
        .map((item) => getOverlappingMatchRectangle(item, matchStart, matchEnd))
        .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0);

      matches.push({
        id: `search-${page.pageNumber}-${matchIndexOnPage}-${matchStart}`,
        pageNumber: page.pageNumber,
        matchIndexOnPage,
        matchedText: page.text.slice(matchStart, matchEnd),
        contextBefore: page.text.slice(Math.max(0, matchStart - 42), matchStart).trimStart(),
        contextAfter: page.text.slice(matchEnd, matchEnd + 42).trimEnd(),
        rects,
        firstRect: rects[0] ?? null,
        bounds: getCombinedBounds(rects),
      });

      matchIndexOnPage += 1;
      offset = matchEnd;
    }

    return matches;
  });
}

export function normalizePdfSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
}

function getNormalizedItemRectangle(
  item: PdfTextItem,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
): PdfSearchPageIndex['items'][number]['rect'] {
  const transform = Util.transform(viewport.transform, item.transform);
  const width = Math.max(Math.abs(item.width), 0);
  const height = Math.max(Math.hypot(transform[2], transform[3]), Math.abs(item.height), 0);
  const x = transform[4];
  const y = transform[5] - height;

  return {
    x: clamp(x / viewport.width, 0, 1),
    y: clamp(y / viewport.height, 0, 1),
    width: clamp(width / viewport.width, 0, 1),
    height: clamp(height / viewport.height, 0, 1),
  };
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  dir: string;
}

function getOverlappingMatchRectangle(
  item: PdfSearchPageIndex['items'][number],
  matchStart: number,
  matchEnd: number,
): PdfSearchPageIndex['items'][number]['rect'] {
  const textLength = Math.max(1, item.end - item.start);
  const overlapStart = Math.max(item.start, matchStart);
  const overlapEnd = Math.min(item.end, matchEnd);
  const startRatio = clamp((overlapStart - item.start) / textLength, 0, 1);
  const endRatio = clamp((overlapEnd - item.start) / textLength, 0, 1);
  const width = item.rect.width * Math.max(0, endRatio - startRatio);
  const isRightToLeft = item.direction === 'rtl';

  return {
    ...item.rect,
    x: isRightToLeft
      ? item.rect.x + item.rect.width * (1 - endRatio)
      : item.rect.x + item.rect.width * startRatio,
    width,
  };
}

function getCombinedBounds(
  rectangles: NormalizedSearchRectangle[],
): NormalizedSearchRectangle | null {
  if (rectangles.length === 0) {
    return null;
  }
  const left = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const top = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.width));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
