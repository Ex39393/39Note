import type { PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type { NotesPrintLayout } from '../types/glossary';

export interface AnnotationPrintItem {
  annotation: PdfAnnotation;
  notes: Note[];
}

export interface AllAnnotationsPrintContent {
  annotationItems: AnnotationPrintItem[];
  standaloneNotes: Note[];
}

export function getAllAnnotationsPrintContent(
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
): AllAnnotationsPrintContent {
  const sortedAnnotations = [...annotations].sort((first, second) => {
    const firstPosition = getAnnotationPosition(first);
    const secondPosition = getAnnotationPosition(second);
    return (
      first.pageNumber - second.pageNumber ||
      firstPosition.y - secondPosition.y ||
      firstPosition.x - secondPosition.x ||
      first.id.localeCompare(second.id)
    );
  });
  const annotationIds = new Set(sortedAnnotations.map((annotation) => annotation.id));
  const seenNoteIds = new Set<string>();
  const notesByAnnotation = new Map<string, Note[]>();
  const standaloneNotes: Note[] = [];

  for (const note of notes) {
    if (seenNoteIds.has(note.id)) continue;
    seenNoteIds.add(note.id);
    if (!annotationIds.has(note.annotationId)) {
      standaloneNotes.push(note);
      continue;
    }
    const linkedNotes = notesByAnnotation.get(note.annotationId) ?? [];
    linkedNotes.push(note);
    notesByAnnotation.set(note.annotationId, linkedNotes);
  }

  return {
    annotationItems: sortedAnnotations.map((annotation) => ({
      annotation,
      notes: notesByAnnotation.get(annotation.id) ?? [],
    })),
    standaloneNotes: [...standaloneNotes].sort(
      (first, second) =>
        first.pageNumber - second.pageNumber || first.id.localeCompare(second.id),
    ),
  };
}

export function getPrintModeContent(
  layout: NotesPrintLayout,
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
): AllAnnotationsPrintContent {
  if (layout === 'all-annotations') {
    return getAllAnnotationsPrintContent(annotations, notes);
  }
  return { annotationItems: [], standaloneNotes: [...notes] };
}

function getAnnotationPosition(
  annotation: Pick<PdfAnnotation, 'rects'>,
): { x: number; y: number } {
  return annotation.rects.reduce(
    (position, rectangle) => ({
      x: Math.min(position.x, rectangle.x),
      y: Math.min(position.y, rectangle.y),
    }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY },
  );
}
