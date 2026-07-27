import type {
  HighlightAnnotation,
  HighlightColor,
  NormalizedHighlightRectangle,
  PdfAnnotation,
  UnderlineAnnotation,
  UnderlineColor,
} from '../types/highlight';
import type { PdfTextSelection, PdfTextSelectionRectangle } from '../types/textSelection';

interface HighlightRenderGroup {
  color: HighlightColor;
  rects: NormalizedHighlightRectangle[];
}

const RECTANGLE_EPSILON = 0.75;

export function createHighlightsFromSelections(
  selections: PdfTextSelection[],
  color: HighlightColor,
): HighlightAnnotation[] {
  return createAnnotationsFromSelections(selections, 'highlight', color);
}

export function createUnderlinesFromSelections(
  selections: PdfTextSelection[],
  color: UnderlineColor,
): UnderlineAnnotation[] {
  return createAnnotationsFromSelections(selections, 'underline', color);
}

function createAnnotationsFromSelections<TType extends PdfAnnotation['type']>(
  selections: PdfTextSelection[],
  type: TType,
  color: Extract<PdfAnnotation, { type: TType }>['color'],
): Extract<PdfAnnotation, { type: TType }>[] {
  return selections.flatMap((selection) => {
    if (
      selection.text.trim().length === 0 ||
      selection.pageWidth <= 0 ||
      selection.pageHeight <= 0
    ) {
      return [];
    }

    const rects = normalizeRectangles(
      simplifySelectionRectangles(selection.boundingRectangles),
      selection.pageWidth,
      selection.pageHeight,
    );

    if (rects.length === 0) {
      return [];
    }

    const timestamp = Date.now();

    return [{
      id: crypto.randomUUID(),
      type,
      pageNumber: selection.pageNumber,
      text: selection.text,
      rects,
      color,
      createdAt: timestamp,
      updatedAt: timestamp,
    }] as Extract<PdfAnnotation, { type: TType }>[];
  });
}

export function upsertHighlights(
  currentHighlights: HighlightAnnotation[],
  nextHighlights: HighlightAnnotation[],
): HighlightAnnotation[] {
  return nextHighlights.reduce((updatedHighlights, nextHighlight) => {
    const duplicateIndex = updatedHighlights.findIndex((existingHighlight) =>
      isSubstantiallySameHighlight(existingHighlight, nextHighlight),
    );

    if (duplicateIndex === -1) {
      return [...updatedHighlights, nextHighlight];
    }

    return updatedHighlights.map((existingHighlight, index) =>
      index === duplicateIndex
        ? {
            ...existingHighlight,
            text: nextHighlight.text,
            rects: nextHighlight.rects,
            color: nextHighlight.color,
            updatedAt: Date.now(),
          }
        : existingHighlight,
    );
  }, currentHighlights);
}

export function upsertAnnotations(
  currentAnnotations: PdfAnnotation[],
  nextAnnotations: PdfAnnotation[],
): PdfAnnotation[] {
  return nextAnnotations.reduce<PdfAnnotation[]>((updatedAnnotations, nextAnnotation) => {
    const duplicateIndex = updatedAnnotations.findIndex((existingAnnotation) =>
      existingAnnotation.type === nextAnnotation.type &&
      isSubstantiallySameHighlight(existingAnnotation, nextAnnotation),
    );

    if (duplicateIndex === -1) {
      return [...updatedAnnotations, nextAnnotation];
    }

    return updatedAnnotations.map((existingAnnotation, index) =>
      index === duplicateIndex
        ? {
            ...existingAnnotation,
            text: nextAnnotation.text,
            rects: nextAnnotation.rects,
            color: nextAnnotation.color,
            updatedAt: Date.now(),
          } as PdfAnnotation
        : existingAnnotation,
    );
  }, currentAnnotations);
}

export function getHighlightRenderGroups(
  highlights: HighlightAnnotation[],
  pageWidth = 1,
  pageHeight = 1,
): HighlightRenderGroup[] {
  const highlightsByColor = new Map<HighlightColor, NormalizedHighlightRectangle[]>();

  for (const highlight of highlights) {
    const rectangles = highlightsByColor.get(highlight.color) ?? [];
    rectangles.push(...highlight.rects);
    highlightsByColor.set(highlight.color, rectangles);
  }

  return Array.from(highlightsByColor, ([color, rectangles]) => ({
    color,
    rects: mergeNormalizedRectangles(rectangles, pageWidth, pageHeight),
  }));
}

/**
 * Display-only geometry cleanup. Persisted annotation rectangles remain untouched,
 * while fragmented runs on a single visual line render as one continuous segment.
 */
export function normalizeAnnotationVisualGeometry(
  rectangles: NormalizedHighlightRectangle[],
  pageWidth = 1,
  pageHeight = 1,
): NormalizedHighlightRectangle[] {
  return mergeNormalizedRectangles(rectangles, pageWidth, pageHeight);
}

function simplifySelectionRectangles(
  rectangles: PdfTextSelectionRectangle[],
): PdfTextSelectionRectangle[] {
  const ordered = rectangles
    .filter((rectangle) => rectangle.width > RECTANGLE_EPSILON && rectangle.height > RECTANGLE_EPSILON)
    .sort((first, second) => first.top - second.top || first.left - second.left);
  const unique = ordered.filter(
    (rectangle, index) =>
      !ordered.slice(0, index).some((existing) =>
        areNearlyEqual(existing, rectangle) ||
        rectangleCoverage(rectangle, existing) >= 0.94,
      ),
  );

  return mergeLineRectangles(unique);
}

function mergeLineRectangles(
  rectangles: PdfTextSelectionRectangle[],
): PdfTextSelectionRectangle[] {
  return rectangles.reduce<PdfTextSelectionRectangle[]>((merged, rectangle) => {
    const previous = merged.at(-1);

    if (!previous || !belongsToSameVisualLine(previous, rectangle)) {
      merged.push({ ...rectangle });
      return merged;
    }

    const right = Math.max(previous.left + previous.width, rectangle.left + rectangle.width);
    previous.width = right - previous.left;
    previous.height = Math.max(previous.height, rectangle.height);
    return merged;
  }, []);
}

function belongsToSameVisualLine(
  first: PdfTextSelectionRectangle,
  second: PdfTextSelectionRectangle,
): boolean {
  const lineTolerance = Math.max(1.5, Math.min(first.height, second.height) * 0.3);
  const horizontalGap = second.left - (first.left + first.width);

  return (
    Math.abs(first.top - second.top) <= lineTolerance &&
    Math.abs(first.height - second.height) <= lineTolerance &&
    horizontalGap >= -lineTolerance &&
    horizontalGap <= Math.max(3, first.height * 0.35)
  );
}

function normalizeRectangles(
  rectangles: PdfTextSelectionRectangle[],
  pageWidth: number,
  pageHeight: number,
): NormalizedHighlightRectangle[] {
  return rectangles.map((rectangle) => ({
    x: rectangle.left / pageWidth,
    y: rectangle.top / pageHeight,
    width: rectangle.width / pageWidth,
    height: rectangle.height / pageHeight,
  }));
}

function isSubstantiallySameHighlight(
  existingHighlight: Pick<PdfAnnotation, 'pageNumber' | 'rects' | 'text'>,
  nextHighlight: Pick<PdfAnnotation, 'pageNumber' | 'rects' | 'text'>,
): boolean {
  if (existingHighlight.pageNumber !== nextHighlight.pageNumber) {
    return false;
  }

  const coverage = highlightCoverage(existingHighlight.rects, nextHighlight.rects);
  const textMatches = normalizeText(existingHighlight.text) === normalizeText(nextHighlight.text);

  return coverage >= 0.9 || (textMatches && coverage >= 0.75);
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function highlightCoverage(
  first: NormalizedHighlightRectangle[],
  second: NormalizedHighlightRectangle[],
): number {
  const firstArea = totalArea(first);
  const secondArea = totalArea(second);

  if (firstArea === 0 || secondArea === 0) {
    return 0;
  }

  const intersection = first.reduce(
    (total, firstRectangle) =>
      total + second.reduce((sum, secondRectangle) => sum + intersectionArea(firstRectangle, secondRectangle), 0),
    0,
  );

  return intersection / Math.min(firstArea, secondArea);
}

function mergeNormalizedRectangles(
  rectangles: NormalizedHighlightRectangle[],
  pageWidth: number,
  pageHeight: number,
): NormalizedHighlightRectangle[] {
  const ordered = rectangles
    .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
    .sort((first, second) => first.y - second.y || first.x - second.x);

  return ordered.reduce<NormalizedHighlightRectangle[]>((merged, rectangle) => {
    const previous = merged.at(-1);

    if (!previous || !belongsToSameNormalizedLine(previous, rectangle, pageWidth, pageHeight)) {
      merged.push({ ...rectangle });
      return merged;
    }

    const right = Math.max(previous.x + previous.width, rectangle.x + rectangle.width);
    const bottom = Math.max(previous.y + previous.height, rectangle.y + rectangle.height);
    previous.width = right - previous.x;
    previous.height = bottom - previous.y;
    return merged;
  }, []);
}

function belongsToSameNormalizedLine(
  first: NormalizedHighlightRectangle,
  second: NormalizedHighlightRectangle,
  pageWidth: number,
  pageHeight: number,
): boolean {
  const lineTolerance = Math.max(0.002, Math.min(first.height, second.height) * 0.3);
  const horizontalGap = second.x - (first.x + first.width);
  const lineHeightInPixels = Math.min(first.height, second.height) * pageHeight;
  const mergeGapInPixels = Math.min(7, Math.max(1.75, lineHeightInPixels * 0.3));
  const mergeGap = mergeGapInPixels / Math.max(pageWidth, 1);

  return (
    Math.abs(first.y - second.y) <= lineTolerance &&
    Math.abs(first.height - second.height) <= lineTolerance &&
    horizontalGap >= -lineTolerance &&
    horizontalGap <= mergeGap
  );
}

function areNearlyEqual(
  first: PdfTextSelectionRectangle,
  second: PdfTextSelectionRectangle,
): boolean {
  return (
    Math.abs(first.left - second.left) <= RECTANGLE_EPSILON &&
    Math.abs(first.top - second.top) <= RECTANGLE_EPSILON &&
    Math.abs(first.width - second.width) <= RECTANGLE_EPSILON &&
    Math.abs(first.height - second.height) <= RECTANGLE_EPSILON
  );
}

function rectangleCoverage(
  target: PdfTextSelectionRectangle,
  container: PdfTextSelectionRectangle,
): number {
  const targetArea = target.width * target.height;
  if (targetArea === 0) {
    return 0;
  }

  return intersectionArea(target, container) / targetArea;
}

function totalArea(rectangles: NormalizedHighlightRectangle[]): number {
  return rectangles.reduce((total, rectangle) => total + rectangle.width * rectangle.height, 0);
}

function intersectionArea(
  first: PdfTextSelectionRectangle | NormalizedHighlightRectangle,
  second: PdfTextSelectionRectangle | NormalizedHighlightRectangle,
): number {
  const firstX = 'left' in first ? first.left : first.x;
  const firstY = 'top' in first ? first.top : first.y;
  const secondX = 'left' in second ? second.left : second.x;
  const secondY = 'top' in second ? second.top : second.y;
  const width = Math.max(0, Math.min(firstX + first.width, secondX + second.width) - Math.max(firstX, secondX));
  const height = Math.max(0, Math.min(firstY + first.height, secondY + second.height) - Math.max(firstY, secondY));

  return width * height;
}
