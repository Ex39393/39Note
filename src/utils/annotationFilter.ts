import type { PdfAnnotation } from '../types/highlight';
import type { AnnotationFilterState } from '../components/pdf/AnnotationFilterControl';

export function matchesAnnotationFilter(annotation: PdfAnnotation, notedIds: string[], filter: AnnotationFilterState): boolean {
  return filter.types.includes(annotation.type) &&
    (filter.noteStatus === 'all' || (filter.noteStatus === 'with-note') === notedIds.includes(annotation.id)) &&
    (filter.colors.length === 0 || filter.colors.includes(annotation.color));
}
