import type { AnnotationType, PdfAnnotation } from '../../types/highlight';
import { matchesAnnotationFilter } from '../../utils/annotationFilter';

export interface AnnotationFilterState {
  types: AnnotationType[];
  noteStatus: 'all' | 'with-note' | 'without-note';
  colors: string[];
}

interface Props {
  annotations: PdfAnnotation[];
  notedIds: string[];
  filter: AnnotationFilterState;
  onChange: (filter: AnnotationFilterState) => void;
}

export function AnnotationFilterControl({ annotations, notedIds, filter, onChange }: Props) {
  const colors = [...new Set(annotations.map((annotation) => annotation.color))];
  const visible = annotations.filter((annotation) => matches(annotation, notedIds, filter)).length;
  const toggleType = (type: AnnotationType) => onChange({ ...filter, types: filter.types.includes(type) ? filter.types.filter((value) => value !== type) : [...filter.types, type] });
  const toggleColor = (color: string) => onChange({ ...filter, colors: filter.colors.includes(color) ? filter.colors.filter((value) => value !== color) : [...filter.colors, color] });
  return <details className="annotation-filter-control"><summary>Annotations {visible}/{annotations.length}</summary><div>
    <span>Type</span><button aria-pressed={filter.types.includes('highlight')} type="button" onClick={() => toggleType('highlight')}>Highlights</button><button aria-pressed={filter.types.includes('underline')} type="button" onClick={() => toggleType('underline')}>Underlines</button>
    <span>Notes</span>{(['all', 'with-note', 'without-note'] as const).map((status) => <button aria-pressed={filter.noteStatus === status} key={status} type="button" onClick={() => onChange({ ...filter, noteStatus: status })}>{status === 'all' ? 'All' : status === 'with-note' ? 'With Note' : 'Without Note'}</button>)}
    {colors.length > 0 ? <><span>Colour</span>{colors.map((color) => <button aria-pressed={filter.colors.includes(color)} key={color} type="button" onClick={() => toggleColor(color)}>{color}</button>)}</> : null}
    <button type="button" onClick={() => onChange({ types: ['highlight', 'underline'], noteStatus: 'all', colors: [] })}>Clear Filters</button>
  </div></details>;
}

function matches(annotation: PdfAnnotation, notedIds: string[], filter: AnnotationFilterState): boolean { return matchesAnnotationFilter(annotation, notedIds, filter); }
