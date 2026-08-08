import type { AnnotationFilterState } from '../components/pdf/AnnotationFilterControl';
import type { PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import { matchesAnnotationFilter } from './annotationFilter';
import { sortAnnotationsForExport } from './annotatedPdfExportModel';

export function selectAnnotationsForExport(
  annotations: PdfAnnotation[],
  notes: Note[],
  filter: AnnotationFilterState,
  includeHiddenAnnotations: boolean,
): PdfAnnotation[] {
  if (includeHiddenAnnotations) {
    return sortAnnotationsForExport(annotations);
  }

  const notedIds = notes.map((note) => note.annotationId);
  return sortAnnotationsForExport(
    annotations.filter((annotation) =>
      matchesAnnotationFilter(annotation, notedIds, filter),
    ),
  );
}
