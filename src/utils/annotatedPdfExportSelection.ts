import type { AnnotationFilterState } from '../components/pdf/AnnotationFilterControl';
import type { PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import { matchesAnnotationFilter } from './annotationFilter';
import { deriveAnnotationTags } from './annotationTags';
import { sortAnnotationsForExport } from './annotatedPdfExportModel';

export function selectAnnotationsForExport(
  annotations: PdfAnnotation[],
  notes: Note[],
  filter: AnnotationFilterState,
  includeHiddenAnnotations: boolean,
  noteAnchors: NoteAnchor[] = [],
): PdfAnnotation[] {
  if (includeHiddenAnnotations) {
    return sortAnnotationsForExport(annotations);
  }

  const notedIds = deriveAnnotationTags(annotations, notes, noteAnchors).flatMap(
    (tag) => (tag.note ? [tag.annotation.id] : []),
  );
  return sortAnnotationsForExport(
    annotations.filter((annotation) =>
      matchesAnnotationFilter(annotation, notedIds, filter),
    ),
  );
}
