import type {
  HighlightAnnotation,
  HighlightColor,
  NormalizedHighlightRectangle,
  PdfAnnotation,
  UnderlineAnnotation,
  UnderlineColor,
} from '../types/highlight';
import type {
  PdfTextSelection,
  PdfTextSelectionRectangle,
} from '../types/textSelection';
import type { NoteAnchor } from '../types/noteAnchor';
import { isSameLogicalPdfSource } from './pdfSourceGeometry.ts';

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

export function createAnnotationFromSource<TType extends PdfAnnotation['type']>(
  source: PdfAnnotation | NoteAnchor,
  type: TType,
  color: Extract<PdfAnnotation, { type: TType }>['color'],
  id = crypto.randomUUID(),
  timestamp = Date.now(),
): Extract<PdfAnnotation, { type: TType }> | null {
  if (!source.text.trim() || source.rects.length === 0) return null;
  return {
    id,
    type,
    pageNumber: source.pageNumber,
    text: source.text,
    rects: source.rects.map((rectangle) => ({ ...rectangle })),
    color,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as Extract<PdfAnnotation, { type: TType }>;
}

export function addAnnotationFromSourceIfMissing(
  annotations: readonly PdfAnnotation[],
  nextAnnotation: PdfAnnotation,
): PdfAnnotation[] {
  return annotations.some(
    (annotation) =>
      annotation.type === nextAnnotation.type &&
      isSameLogicalPdfSource(annotation, nextAnnotation),
  )
    ? [...annotations]
    : [...annotations, nextAnnotation];
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

    const rects = normalizeSelectionRectangles(
      selection.boundingRectangles,
      selection.pageWidth,
      selection.pageHeight,
    );

    if (rects.length === 0) {
      return [];
    }

    const timestamp = Date.now();

    return [
      {
        id: crypto.randomUUID(),
        type,
        pageNumber: selection.pageNumber,
        text: selection.text,
        rects,
        color,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ] as Extract<PdfAnnotation, { type: TType }>[];
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
  return nextAnnotations.reduce<PdfAnnotation[]>(
    (updatedAnnotations, nextAnnotation) => {
      const duplicateIndex = updatedAnnotations.findIndex(
        (existingAnnotation) =>
          existingAnnotation.type === nextAnnotation.type &&
          isSubstantiallySameHighlight(existingAnnotation, nextAnnotation),
      );

      if (duplicateIndex === -1) {
        return [...updatedAnnotations, nextAnnotation];
      }

      return updatedAnnotations.map((existingAnnotation, index) =>
        index === duplicateIndex
          ? ({
              ...existingAnnotation,
              text: nextAnnotation.text,
              rects: nextAnnotation.rects,
              color: nextAnnotation.color,
              updatedAt: Date.now(),
            } as PdfAnnotation)
          : existingAnnotation,
      );
    },
    currentAnnotations,
  );
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
    .filter(
      (rectangle) =>
        rectangle.width > RECTANGLE_EPSILON && rectangle.height > RECTANGLE_EPSILON,
    )
    .sort((first, second) => first.top - second.top || first.left - second.left);
  const unique = ordered.filter(
    (rectangle, index) =>
      !ordered
        .slice(0, index)
        .some(
          (existing) =>
            areNearlyEqual(existing, rectangle) ||
            rectangleCoverage(rectangle, existing) >= 0.94,
        ),
  );

  return mergeLineRectangles(unique);
}

function mergeLineRectangles(
  rectangles: PdfTextSelectionRectangle[],
): PdfTextSelectionRectangle[] {
  return groupRectanglesByVisualLine(rectangles).flatMap((line) =>
    line.rectangles
      .sort((first, second) => first.left - second.left)
      .reduce<PdfTextSelectionRectangle[]>((merged, rectangle) => {
        const previous = merged.at(-1);
        if (!previous || !hasMergeableHorizontalGap(previous, rectangle)) {
          merged.push({ ...rectangle });
          return merged;
        }

        const right = Math.max(
          previous.left + previous.width,
          rectangle.left + rectangle.width,
        );
        const bottom = Math.max(
          previous.top + previous.height,
          rectangle.top + rectangle.height,
        );
        previous.top = Math.min(previous.top, rectangle.top);
        previous.width = right - previous.left;
        previous.height = bottom - previous.top;
        return merged;
      }, []),
  );
}

function hasMergeableHorizontalGap(
  first: PdfTextSelectionRectangle,
  second: PdfTextSelectionRectangle,
): boolean {
  const horizontalGap = second.left - (first.left + first.width);
  const overlapTolerance = Math.max(1.5, Math.min(first.height, second.height) * 0.3);
  const mergeGap = Math.max(3, Math.max(first.height, second.height) * 0.6);

  return horizontalGap >= -overlapTolerance && horizontalGap <= mergeGap;
}

interface VisualRectangleLine {
  rectangles: PdfTextSelectionRectangle[];
  center: number;
  averageHeight: number;
  top: number;
  bottom: number;
}

function groupRectanglesByVisualLine(
  rectangles: readonly PdfTextSelectionRectangle[],
): VisualRectangleLine[] {
  const lines: VisualRectangleLine[] = [];
  const ordered = [...rectangles].sort(
    (first, second) =>
      first.top + first.height / 2 - (second.top + second.height / 2) ||
      first.left - second.left,
  );

  for (const rectangle of ordered) {
    const rectangleCenter = rectangle.top + rectangle.height / 2;
    const matchingLine = lines
      .filter((line) => belongsToVisualLine(line, rectangle))
      .sort(
        (first, second) =>
          Math.abs(first.center - rectangleCenter) -
          Math.abs(second.center - rectangleCenter),
      )[0];

    if (!matchingLine) {
      lines.push({
        rectangles: [{ ...rectangle }],
        center: rectangleCenter,
        averageHeight: rectangle.height,
        top: rectangle.top,
        bottom: rectangle.top + rectangle.height,
      });
      continue;
    }

    const count = matchingLine.rectangles.length;
    matchingLine.rectangles.push({ ...rectangle });
    matchingLine.center = (matchingLine.center * count + rectangleCenter) / (count + 1);
    matchingLine.averageHeight =
      (matchingLine.averageHeight * count + rectangle.height) / (count + 1);
    matchingLine.top = Math.min(matchingLine.top, rectangle.top);
    matchingLine.bottom = Math.max(
      matchingLine.bottom,
      rectangle.top + rectangle.height,
    );
  }

  return lines.sort((first, second) => first.center - second.center);
}

function belongsToVisualLine(
  line: VisualRectangleLine,
  rectangle: PdfTextSelectionRectangle,
): boolean {
  const rectangleCenter = rectangle.top + rectangle.height / 2;
  const minimumHeight = Math.max(
    RECTANGLE_EPSILON,
    Math.min(line.averageHeight, rectangle.height),
  );
  const verticalOverlap =
    Math.min(line.bottom, rectangle.top + rectangle.height) -
    Math.max(line.top, rectangle.top);
  const centerTolerance = Math.max(
    1.5,
    Math.max(line.averageHeight, rectangle.height) * 0.48,
  );

  return (
    verticalOverlap / minimumHeight >= 0.35 &&
    Math.abs(line.center - rectangleCenter) <= centerTolerance
  );
}

export function normalizeSelectionRectangles(
  rectangles: PdfTextSelectionRectangle[],
  pageWidth: number,
  pageHeight: number,
): NormalizedHighlightRectangle[] {
  return simplifySelectionRectangles(rectangles).map((rectangle) => ({
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
  const textMatches =
    normalizeText(existingHighlight.text) === normalizeText(nextHighlight.text);

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
      total +
      second.reduce(
        (sum, secondRectangle) =>
          sum + intersectionArea(firstRectangle, secondRectangle),
        0,
      ),
    0,
  );

  return intersection / Math.min(firstArea, secondArea);
}

function mergeNormalizedRectangles(
  rectangles: NormalizedHighlightRectangle[],
  pageWidth: number,
  pageHeight: number,
): NormalizedHighlightRectangle[] {
  const safeWidth = Math.max(pageWidth, 1);
  const safeHeight = Math.max(pageHeight, 1);
  return mergeLineRectangles(
    rectangles
      .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
      .map((rectangle) => ({
        left: rectangle.x * safeWidth,
        top: rectangle.y * safeHeight,
        width: rectangle.width * safeWidth,
        height: rectangle.height * safeHeight,
      })),
  ).map((rectangle) => ({
    x: rectangle.left / safeWidth,
    y: rectangle.top / safeHeight,
    width: rectangle.width / safeWidth,
    height: rectangle.height / safeHeight,
  }));
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
  return rectangles.reduce(
    (total, rectangle) => total + rectangle.width * rectangle.height,
    0,
  );
}

function intersectionArea(
  first: PdfTextSelectionRectangle | NormalizedHighlightRectangle,
  second: PdfTextSelectionRectangle | NormalizedHighlightRectangle,
): number {
  const firstX = 'left' in first ? first.left : first.x;
  const firstY = 'top' in first ? first.top : first.y;
  const secondX = 'left' in second ? second.left : second.x;
  const secondY = 'top' in second ? second.top : second.y;
  const width = Math.max(
    0,
    Math.min(firstX + first.width, secondX + second.width) - Math.max(firstX, secondX),
  );
  const height = Math.max(
    0,
    Math.min(firstY + first.height, secondY + second.height) -
      Math.max(firstY, secondY),
  );

  return width * height;
}
