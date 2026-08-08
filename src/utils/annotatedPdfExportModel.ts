import type { NormalizedHighlightRectangle, PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type {
  AnnotationExportReference,
  AppendixLayoutItem,
  PdfCoordinateLine,
  PdfCoordinatePoint,
  PdfCoordinateRectangle,
  PdfPageGeometry,
} from '../types/annotatedPdfExport';

const PDF_ROTATIONS = [0, 90, 180, 270] as const;
const DEFAULT_UNDERLINE_OFFSET_POINTS = 1.75;
const DEFAULT_UNDERLINE_THICKNESS_POINTS = 1.25;
const WIN_ANSI_EXTRA_CODE_POINTS = new Set([
  0x0192, 0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x02c6, 0x02dc,
  0x2013, 0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021,
  0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

interface ViewportTransform {
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
}

export function normalizePdfRotation(rotation: number): PdfPageGeometry['rotation'] {
  const normalized = ((Math.round(rotation) % 360) + 360) % 360;
  if (!PDF_ROTATIONS.includes(normalized as PdfPageGeometry['rotation'])) {
    throw new Error('PDF page rotation must be 0, 90, 180, or 270 degrees.');
  }
  return normalized as PdfPageGeometry['rotation'];
}

/**
 * Recreates the PDF.js PageViewport transform used by 39Note's TextLayer.
 * Persisted rectangles are normalized against this rotated, top-left viewport.
 */
export function createPdfJsViewport(
  page: PdfPageGeometry,
  scale = 1,
): ViewportTransform {
  const [xMin, yMin, xMax, yMax] = page.viewBox;
  const userScale = scale * page.userUnit;
  const centerX = (xMax + xMin) / 2;
  const centerY = (yMax + yMin) / 2;
  let rotateA: number;
  let rotateB: number;
  let rotateC: number;
  let rotateD: number;

  switch (normalizePdfRotation(page.rotation)) {
    case 180:
      rotateA = -1;
      rotateB = 0;
      rotateC = 0;
      rotateD = 1;
      break;
    case 90:
      rotateA = 0;
      rotateB = 1;
      rotateC = 1;
      rotateD = 0;
      break;
    case 270:
      rotateA = 0;
      rotateB = -1;
      rotateC = -1;
      rotateD = 0;
      break;
    default:
      rotateA = 1;
      rotateB = 0;
      rotateC = 0;
      rotateD = -1;
  }

  let offsetCanvasX: number;
  let offsetCanvasY: number;
  let width: number;
  let height: number;

  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY - yMin) * userScale;
    offsetCanvasY = Math.abs(centerX - xMin) * userScale;
    width = (yMax - yMin) * userScale;
    height = (xMax - xMin) * userScale;
  } else {
    offsetCanvasX = Math.abs(centerX - xMin) * userScale;
    offsetCanvasY = Math.abs(centerY - yMin) * userScale;
    width = (xMax - xMin) * userScale;
    height = (yMax - yMin) * userScale;
  }

  return {
    transform: [
      rotateA * userScale,
      rotateB * userScale,
      rotateC * userScale,
      rotateD * userScale,
      offsetCanvasX - rotateA * userScale * centerX - rotateC * userScale * centerY,
      offsetCanvasY - rotateB * userScale * centerX - rotateD * userScale * centerY,
    ],
    width,
    height,
  };
}

export function normalizedPointToPdfPoint(
  x: number,
  y: number,
  page: PdfPageGeometry,
  viewportScale = 1,
): PdfCoordinatePoint {
  const viewport = createPdfJsViewport(page, viewportScale);
  return applyInverseTransform(
    x * viewport.width,
    y * viewport.height,
    viewport.transform,
  );
}

export function normalizedRectangleToPdfRectangle(
  rectangle: NormalizedHighlightRectangle,
  page: PdfPageGeometry,
  viewportScale = 1,
): PdfCoordinateRectangle {
  const corners = [
    normalizedPointToPdfPoint(rectangle.x, rectangle.y, page, viewportScale),
    normalizedPointToPdfPoint(
      rectangle.x + rectangle.width,
      rectangle.y,
      page,
      viewportScale,
    ),
    normalizedPointToPdfPoint(
      rectangle.x,
      rectangle.y + rectangle.height,
      page,
      viewportScale,
    ),
    normalizedPointToPdfPoint(
      rectangle.x + rectangle.width,
      rectangle.y + rectangle.height,
      page,
      viewportScale,
    ),
  ];
  const xValues = corners.map((corner) => corner.x);
  const yValues = corners.map((corner) => corner.y);
  const x = Math.min(...xValues);
  const y = Math.min(...yValues);

  return {
    x,
    y,
    width: Math.max(...xValues) - x,
    height: Math.max(...yValues) - y,
  };
}

export function normalizedRectanglesToPdfRectangles(
  rectangles: NormalizedHighlightRectangle[],
  page: PdfPageGeometry,
  viewportScale = 1,
): PdfCoordinateRectangle[] {
  return rectangles.map((rectangle) =>
    normalizedRectangleToPdfRectangle(rectangle, page, viewportScale),
  );
}

export function normalizedRectangleToPdfUnderline(
  rectangle: NormalizedHighlightRectangle,
  page: PdfPageGeometry,
  offsetPoints = DEFAULT_UNDERLINE_OFFSET_POINTS,
  thicknessPoints = DEFAULT_UNDERLINE_THICKNESS_POINTS,
): PdfCoordinateLine {
  const viewport = createPdfJsViewport(page);
  const normalizedOffset = offsetPoints / Math.max(viewport.height, 1);
  const y = clamp(rectangle.y + rectangle.height + normalizedOffset, 0, 1);

  return {
    start: normalizedPointToPdfPoint(rectangle.x, y, page),
    end: normalizedPointToPdfPoint(rectangle.x + rectangle.width, y, page),
    thickness: thicknessPoints / Math.max(page.userUnit, Number.EPSILON),
  };
}

export function sortAnnotationsForExport(
  annotations: PdfAnnotation[],
): PdfAnnotation[] {
  return [...annotations].sort((first, second) => {
    const firstPosition = getAnnotationPosition(first);
    const secondPosition = getAnnotationPosition(second);
    return (
      first.pageNumber - second.pageNumber ||
      firstPosition.y - secondPosition.y ||
      firstPosition.x - secondPosition.x ||
      first.id.localeCompare(second.id)
    );
  });
}

export function buildAnnotationExportReferences(
  annotations: PdfAnnotation[],
  notes: Note[],
): AnnotationExportReference[] {
  const notesByAnnotation = new Map(
    notes
      .filter((note) => note.content.trim().length > 0)
      .map((note) => [note.annotationId, note]),
  );

  return sortAnnotationsForExport(annotations)
    .flatMap((annotation) => {
      const note = notesByAnnotation.get(annotation.id);
      return note ? [{ annotation, note }] : [];
    })
    .map((reference, index) => ({
      ...reference,
      referenceNumber: index + 1,
    }));
}

export function sanitizeAnnotatedPdfFilename(documentTitle: string): string {
  const titleWithoutControlCharacters = Array.from(documentTitle, (character) =>
    (character.codePointAt(0) ?? 0) < 0x20 ? ' ' : character,
  ).join('');
  const sanitizedTitle = titleWithoutControlCharacters
    .replaceAll(/[<>:"/\\|?*]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/[. ]+$/g, '')
    .slice(0, 180)
    .trim();
  return `${sanitizedTitle || '39Note'} - annotated.pdf`;
}

export function findUnsupportedAppendixCharacters(text: string): string[] {
  return [
    ...new Set(
      Array.from(text).filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return !(
          character === '\n' ||
          character === '\r' ||
          character === '\t' ||
          (codePoint >= 0x20 && codePoint <= 0x7e) ||
          (codePoint >= 0x00a0 && codePoint <= 0x00ff) ||
          WIN_ANSI_EXTRA_CODE_POINTS.has(codePoint)
        );
      }),
    ),
  ];
}

export function wrapAppendixText(
  text: string,
  maxWidth: number,
  measureText: (value: string) => number,
): string[] {
  const sourceLines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  return sourceLines.flatMap((sourceLine) => {
    if (sourceLine.length === 0) {
      return [''];
    }

    const words = sourceLine.split(/(\s+)/).filter(Boolean);
    const wrapped: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const candidate = `${currentLine}${word}`;
      if (candidate.trim().length === 0 || measureText(candidate) <= maxWidth) {
        currentLine = candidate;
        continue;
      }

      if (currentLine.trim().length > 0) {
        wrapped.push(currentLine.trimEnd());
        currentLine = '';
      }

      if (measureText(word) <= maxWidth) {
        currentLine = word.trimStart();
        continue;
      }

      for (const character of word) {
        const characterCandidate = `${currentLine}${character}`;
        if (currentLine.length > 0 && measureText(characterCandidate) > maxWidth) {
          wrapped.push(currentLine);
          currentLine = character;
        } else {
          currentLine = characterCandidate;
        }
      }
    }

    if (currentLine.length > 0) {
      wrapped.push(currentLine.trimEnd());
    }
    return wrapped.length > 0 ? wrapped : [''];
  });
}

export function paginateAppendixItems<T extends AppendixLayoutItem>(
  items: T[],
  firstPageHeight: number,
  continuationPageHeight: number,
): T[][] {
  if (items.length === 0) {
    return [];
  }

  const pages: T[][] = [[]];
  let availableHeight = firstPageHeight;
  let usedHeight = 0;

  items.forEach((item, index) => {
    const nextHeight = item.keepWithNext ? (items[index + 1]?.height ?? 0) : 0;
    const requiredHeight = item.height + nextHeight;
    if (pages.at(-1)!.length > 0 && usedHeight + requiredHeight > availableHeight) {
      pages.push([]);
      availableHeight = continuationPageHeight;
      usedHeight = 0;
    }

    pages.at(-1)!.push(item);
    usedHeight += item.height;
  });

  return pages;
}

function getAnnotationPosition(annotation: PdfAnnotation): { x: number; y: number } {
  return annotation.rects.reduce(
    (position, rectangle) => ({
      x: Math.min(position.x, rectangle.x),
      y: Math.min(position.y, rectangle.y),
    }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
  );
}

function applyInverseTransform(
  x: number,
  y: number,
  transform: ViewportTransform['transform'],
): PdfCoordinatePoint {
  const determinant = transform[0] * transform[3] - transform[1] * transform[2];
  if (determinant === 0) {
    throw new Error('The PDF page transform is not invertible.');
  }
  return {
    x:
      (x * transform[3] -
        y * transform[2] +
        transform[2] * transform[5] -
        transform[4] * transform[3]) /
      determinant,
    y:
      (-x * transform[1] +
        y * transform[0] +
        transform[4] * transform[1] -
        transform[5] * transform[0]) /
      determinant,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
