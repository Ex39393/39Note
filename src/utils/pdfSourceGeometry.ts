import type { NormalizedHighlightRectangle } from '../types/highlight';
import { formatPdfSourceTextForDisplay } from './pdfSourceText.ts';

export interface PdfSourceGeometry {
  id: string;
  pageNumber: number;
  text: string;
  rects: readonly NormalizedHighlightRectangle[];
  createdAt: number;
  startOffset?: number;
}

export interface RectangleSetOverlap {
  firstCoverage: number;
  secondCoverage: number;
}

export function getRectangleSetOverlap(
  firstRects: readonly NormalizedHighlightRectangle[],
  secondRects: readonly NormalizedHighlightRectangle[],
): RectangleSetOverlap {
  const firstArea = totalArea(firstRects);
  const secondArea = totalArea(secondRects);
  if (firstArea === 0 || secondArea === 0) {
    return { firstCoverage: 0, secondCoverage: 0 };
  }
  const intersection = firstRects.reduce(
    (total, first) =>
      total + secondRects.reduce(
        (subtotal, second) => subtotal + intersectionArea(first, second),
        0,
      ),
    0,
  );
  return {
    firstCoverage: Math.min(1, intersection / firstArea),
    secondCoverage: Math.min(1, intersection / secondArea),
  };
}

export function isSameLogicalPdfSource(
  first: PdfSourceGeometry,
  second: PdfSourceGeometry,
): boolean {
  if (first.pageNumber !== second.pageNumber) return false;
  const overlap = getRectangleSetOverlap(first.rects, second.rects);
  const textMatches = normalizePdfSourceText(first.text) === normalizePdfSourceText(second.text);
  return (
    overlap.firstCoverage >= 0.72 &&
    overlap.secondCoverage >= 0.72 &&
    (textMatches || (
      overlap.firstCoverage >= 0.9 && overlap.secondCoverage >= 0.9
    ))
  );
}

export function getPdfSourcePosition(
  source: Pick<PdfSourceGeometry, 'pageNumber' | 'rects' | 'startOffset' | 'createdAt' | 'id'>,
): { pageNumber: number; y: number; x: number; startOffset: number; createdAt: number; id: string } {
  const position = source.rects.reduce(
    (current, rectangle) => ({
      x: Math.min(current.x, rectangle.x),
      y: Math.min(current.y, rectangle.y),
    }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
  );
  return {
    pageNumber: source.pageNumber,
    y: position.y,
    x: position.x,
    startOffset: source.startOffset ?? Number.POSITIVE_INFINITY,
    createdAt: source.createdAt,
    id: source.id,
  };
}

export function comparePdfSourcePosition(
  first: Pick<PdfSourceGeometry, 'pageNumber' | 'rects' | 'startOffset' | 'createdAt' | 'id'>,
  second: Pick<PdfSourceGeometry, 'pageNumber' | 'rects' | 'startOffset' | 'createdAt' | 'id'>,
): number {
  const firstPosition = getPdfSourcePosition(first);
  const secondPosition = getPdfSourcePosition(second);
  return (
    firstPosition.pageNumber - secondPosition.pageNumber ||
    firstPosition.y - secondPosition.y ||
    firstPosition.x - secondPosition.x ||
    firstPosition.startOffset - secondPosition.startOffset ||
    firstPosition.createdAt - secondPosition.createdAt ||
    firstPosition.id.localeCompare(secondPosition.id)
  );
}

export function normalizePdfSourceText(text: string): string {
  return formatPdfSourceTextForDisplay(text).toLocaleLowerCase('en-US');
}

function totalArea(rects: readonly NormalizedHighlightRectangle[]): number {
  return rects.reduce((sum, rectangle) => sum + rectangle.width * rectangle.height, 0);
}

function intersectionArea(
  first: NormalizedHighlightRectangle,
  second: NormalizedHighlightRectangle,
): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
  );
  return width * height;
}
