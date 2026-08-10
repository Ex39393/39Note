import type {
  NormalizedHighlightRectangle,
  PdfAnnotation,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type { PdfTextSelection } from '../types/textSelection';

const MIN_SELECTION_COVERAGE = 0.45;
const MIN_ANNOTATION_COVERAGE = 0.35;
const TEXT_MATCH_MIN_COVERAGE = 0.2;

export function findOverlappingAnnotations(
  selections: readonly PdfTextSelection[],
  annotations: readonly PdfAnnotation[],
): PdfAnnotation[] {
  const normalizedSelections = selections.flatMap((selection) => {
    const rects = normalizeRectangles(
      selection.boundingRectangles,
      selection.pageWidth,
      selection.pageHeight,
    );
    return rects.length > 0 ? [{ selection, rects }] : [];
  });

  return annotations.filter((annotation) =>
    normalizedSelections.some(({ selection, rects }) => {
      if (selection.pageNumber !== annotation.pageNumber) return false;
      const overlap = getRectangleSetOverlap(rects, annotation.rects);
      if (
        overlap.selectionCoverage >= MIN_SELECTION_COVERAGE ||
        overlap.annotationCoverage >= MIN_ANNOTATION_COVERAGE
      ) {
        return true;
      }
      return (
        overlap.selectionCoverage >= TEXT_MATCH_MIN_COVERAGE &&
        normalizeText(selection.text) === normalizeText(annotation.text)
      );
    }),
  );
}

export function findMatchingNote(
  selections: readonly PdfTextSelection[],
  notes: readonly Note[],
  annotations: readonly PdfAnnotation[],
  noteAnchors: readonly NoteAnchor[],
): Note | null {
  const sources = new Map(
    [...annotations, ...noteAnchors].map((source) => [source.id, source]),
  );

  for (const note of notes) {
    const source = sources.get(note.annotationId);
    if (!source) continue;
    const matchingSelection = selections.find(
      (selection) => selection.pageNumber === source.pageNumber,
    );
    if (!matchingSelection) continue;
    const selectionRects = normalizeRectangles(
      matchingSelection.boundingRectangles,
      matchingSelection.pageWidth,
      matchingSelection.pageHeight,
    );
    const overlap = getRectangleSetOverlap(selectionRects, source.rects);
    const textMatches =
      normalizeText(matchingSelection.text) === normalizeText(source.text);
    if (
      overlap.selectionCoverage >= 0.72 &&
      overlap.annotationCoverage >= 0.72 &&
      (textMatches || overlap.selectionCoverage >= 0.9)
    ) {
      return note;
    }
  }
  return null;
}

export function createNoteAnchorFromSelection(
  selection: PdfTextSelection,
  id = crypto.randomUUID(),
  timestamp = Date.now(),
): NoteAnchor | null {
  const rects = normalizeRectangles(
    selection.boundingRectangles,
    selection.pageWidth,
    selection.pageHeight,
  );
  if (!selection.text.trim() || rects.length === 0) return null;
  return {
    id,
    type: 'note-anchor',
    pageNumber: selection.pageNumber,
    text: selection.text,
    rects,
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createNoteAnchorFromAnnotation(
  annotation: PdfAnnotation,
  id = crypto.randomUUID(),
  timestamp = Date.now(),
): NoteAnchor {
  return {
    id,
    type: 'note-anchor',
    pageNumber: annotation.pageNumber,
    text: annotation.text,
    rects: annotation.rects.map((rect) => ({ ...rect })),
    startOffset: 0,
    endOffset: annotation.text.length,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

interface RectangleSetOverlap {
  selectionCoverage: number;
  annotationCoverage: number;
}

function getRectangleSetOverlap(
  selectionRects: readonly NormalizedHighlightRectangle[],
  annotationRects: readonly NormalizedHighlightRectangle[],
): RectangleSetOverlap {
  const selectionArea = totalArea(selectionRects);
  const annotationArea = totalArea(annotationRects);
  if (selectionArea === 0 || annotationArea === 0) {
    return { selectionCoverage: 0, annotationCoverage: 0 };
  }
  const intersection = selectionRects.reduce(
    (total, selection) =>
      total +
      annotationRects.reduce(
        (subtotal, annotation) => subtotal + intersectionArea(selection, annotation),
        0,
      ),
    0,
  );
  return {
    selectionCoverage: Math.min(1, intersection / selectionArea),
    annotationCoverage: Math.min(1, intersection / annotationArea),
  };
}

function totalArea(rects: readonly NormalizedHighlightRectangle[]): number {
  return rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
}

function intersectionArea(
  first: NormalizedHighlightRectangle,
  second: NormalizedHighlightRectangle,
): number {
  const width = Math.max(
    0,
    Math.min(first.x + first.width, second.x + second.width) -
      Math.max(first.x, second.x),
  );
  const height = Math.max(
    0,
    Math.min(first.y + first.height, second.y + second.height) -
      Math.max(first.y, second.y),
  );
  return width * height;
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

function normalizeRectangles(
  rectangles: PdfTextSelection['boundingRectangles'],
  pageWidth: number,
  pageHeight: number,
): NormalizedHighlightRectangle[] {
  if (pageWidth <= 0 || pageHeight <= 0) return [];
  return rectangles.flatMap((rectangle) =>
    rectangle.width > 0.75 && rectangle.height > 0.75
      ? [{
          x: rectangle.left / pageWidth,
          y: rectangle.top / pageHeight,
          width: rectangle.width / pageWidth,
          height: rectangle.height / pageHeight,
        }]
      : [],
  );
}
