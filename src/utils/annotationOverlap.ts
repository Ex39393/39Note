import type {
  NormalizedHighlightRectangle,
  PdfAnnotation,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type { PdfTextSelection } from '../types/textSelection';
import {
  getRectangleSetOverlap,
  isSameLogicalPdfSource,
  normalizePdfSourceText,
  type PdfSourceGeometry,
} from './pdfSourceGeometry.ts';

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
        overlap.firstCoverage >= MIN_SELECTION_COVERAGE ||
        overlap.secondCoverage >= MIN_ANNOTATION_COVERAGE
      ) {
        return true;
      }
      return (
        overlap.firstCoverage >= TEXT_MATCH_MIN_COVERAGE &&
        normalizePdfSourceText(selection.text) === normalizePdfSourceText(annotation.text)
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
      normalizePdfSourceText(matchingSelection.text) === normalizePdfSourceText(source.text);
    if (
      overlap.firstCoverage >= 0.72 &&
      overlap.secondCoverage >= 0.72 &&
      (textMatches || overlap.firstCoverage >= 0.9)
    ) {
      return note;
    }
  }
  return null;
}

export function findMatchingNoteForSources(
  targetSources: readonly PdfSourceGeometry[],
  notes: readonly Note[],
  annotations: readonly PdfAnnotation[],
  noteAnchors: readonly NoteAnchor[],
): Note | null {
  const sourcesById = new Map<string, PdfSourceGeometry>(
    [...annotations, ...noteAnchors].map((source) => [source.id, source]),
  );
  return notes.find((note) => {
    const noteSource = sourcesById.get(note.annotationId);
    return Boolean(
      noteSource && targetSources.some((target) => isSameLogicalPdfSource(target, noteSource)),
    );
  }) ?? null;
}

export function findAnnotationsAtNormalizedPoint(
  pageNumber: number,
  point: { x: number; y: number },
  annotations: readonly PdfAnnotation[],
): PdfAnnotation[] {
  const hits = annotations.filter((annotation) =>
    annotation.pageNumber === pageNumber && annotation.rects.some((rectangle) =>
      point.x >= rectangle.x &&
      point.x <= rectangle.x + rectangle.width &&
      point.y >= rectangle.y &&
      point.y <= rectangle.y + rectangle.height,
    ),
  );
  const first = hits[0];
  return first ? hits.filter((annotation) => isSameLogicalPdfSource(first, annotation)) : [];
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
