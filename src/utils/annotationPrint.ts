import type { NormalizedHighlightRectangle, PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type { NotesPrintLayout } from '../types/glossary';
import {
  comparePdfSourcePosition,
  isSameLogicalPdfSource,
  type PdfSourceGeometry,
} from './pdfSourceGeometry.ts';
import { formatPdfSourceTextForDisplay } from './pdfSourceText.ts';

export interface PrintSourceGroup {
  id: string;
  pageNumber: number;
  rects: NormalizedHighlightRectangle[];
  sourceText: string;
  sourceOffset?: number;
  createdAt: number;
  annotations: PdfAnnotation[];
  notes: Note[];
}

interface WorkingPrintSourceGroup extends PrintSourceGroup {
  sources: PdfSourceGeometry[];
}

export function createPrintSourceGroups(
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[] = [],
): PrintSourceGroup[] {
  const sourcesById = new Map<string, PdfSourceGeometry>(
    [...annotations, ...noteAnchors].map((source) => [source.id, source]),
  );
  const groups: WorkingPrintSourceGroup[] = [];

  for (const annotation of [...annotations].sort(comparePdfSourcePosition)) {
    const group = findOrCreateGroup(groups, annotation);
    if (!group.annotations.some((candidate) => candidate.id === annotation.id)) {
      group.annotations.push(annotation);
    }
  }

  const seenNoteIds = new Set<string>();
  for (const note of notes) {
    if (seenNoteIds.has(note.id)) continue;
    seenNoteIds.add(note.id);
    const resolvedSource = sourcesById.get(note.annotationId);
    const source: PdfSourceGeometry = resolvedSource ?? {
      id: `unresolved:${note.id}`,
      pageNumber: note.pageNumber,
      text: note.selectedText,
      rects: [],
      createdAt: note.createdAt,
    };
    const group = findOrCreateGroup(groups, source);
    group.notes.push(note);
  }

  return groups
    .map((group): PrintSourceGroup => ({
      id: group.id,
      pageNumber: group.pageNumber,
      rects: group.rects.map((rectangle) => ({ ...rectangle })),
      sourceText: group.sourceText,
      sourceOffset: group.sourceOffset,
      createdAt: group.createdAt,
      annotations: [...group.annotations].sort(
        (first, second) =>
          annotationTypeOrder(first) - annotationTypeOrder(second) ||
          first.createdAt - second.createdAt ||
          first.id.localeCompare(second.id),
      ),
      notes: [...group.notes].sort(
        (first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id),
      ),
    }))
    .sort(comparePrintSourceGroups);
}

export function getAllAnnotationsPrintContent(
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[] = [],
): PrintSourceGroup[] {
  return createPrintSourceGroups(annotations, notes, noteAnchors);
}

export function getPrintModeContent(
  layout: NotesPrintLayout,
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[] = [],
): PrintSourceGroup[] {
  const groups = createPrintSourceGroups(annotations, notes, noteAnchors);
  return layout === 'all-annotations'
    ? groups
    : groups.filter((group) => group.notes.length > 0);
}

export function getNotesInPrintOrder(
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[] = [],
): Note[] {
  return createPrintSourceGroups(annotations, notes, noteAnchors)
    .flatMap((group) => group.notes);
}

function findOrCreateGroup(
  groups: WorkingPrintSourceGroup[],
  source: PdfSourceGeometry,
): WorkingPrintSourceGroup {
  const existing = groups.find((group) =>
    group.sources.some((candidate) => isSameLogicalPdfSource(candidate, source)),
  );
  if (existing) {
    existing.sources.push(source);
    existing.rects.push(...source.rects.map((rectangle) => ({ ...rectangle })));
    existing.sourceText = chooseSourceText(existing.sourceText, source.text);
    existing.sourceOffset = minimumOptional(existing.sourceOffset, source.startOffset);
    existing.createdAt = Math.min(existing.createdAt, source.createdAt);
    return existing;
  }
  const group: WorkingPrintSourceGroup = {
    id: `source:${source.id}`,
    pageNumber: source.pageNumber,
    rects: source.rects.map((rectangle) => ({ ...rectangle })),
    sourceText: source.text,
    sourceOffset: source.startOffset,
    createdAt: source.createdAt,
    annotations: [],
    notes: [],
    sources: [source],
  };
  groups.push(group);
  return group;
}

function comparePrintSourceGroups(first: PrintSourceGroup, second: PrintSourceGroup): number {
  return comparePdfSourcePosition(
    {
      id: first.id,
      pageNumber: first.pageNumber,
      rects: first.rects,
      createdAt: first.createdAt,
      startOffset: first.sourceOffset,
    },
    {
      id: second.id,
      pageNumber: second.pageNumber,
      rects: second.rects,
      createdAt: second.createdAt,
      startOffset: second.sourceOffset,
    },
  );
}

function annotationTypeOrder(annotation: PdfAnnotation): number {
  return annotation.type === 'highlight' ? 0 : 1;
}

function chooseSourceText(first: string, second: string): string {
  const firstDisplay = formatPdfSourceTextForDisplay(first);
  const secondDisplay = formatPdfSourceTextForDisplay(second);
  return secondDisplay.length > firstDisplay.length ? second : first;
}

function minimumOptional(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}
