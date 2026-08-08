import type { PdfAnnotation } from '../types/highlight';
import type {
  DefinitionBubble,
  DictionaryDefinition,
  GlossaryEntry,
  NotesPrintLayout,
} from '../types/glossary';

export function createGlossaryEntryFromBubble(
  documentId: string,
  bubble: DefinitionBubble,
  preferredDefinition: DictionaryDefinition,
  timestamp = Date.now(),
  glossaryEntryId = crypto.randomUUID(),
  markerAnnotationId = crypto.randomUUID(),
): GlossaryEntry {
  return {
    glossaryEntryId,
    documentId,
    displayedWord: bubble.displayedWord,
    normalizedLookupWord: bubble.normalizedLookupWord,
    definition: preferredDefinition.text,
    pageNumber: bubble.pageNumber,
    sourceRects: bubble.rects.map((rectangle) => ({ ...rectangle })),
    startOffset: bubble.startOffset,
    endOffset: bubble.endOffset,
    createdAt: timestamp,
    source: preferredDefinition.source,
    markerAnnotationId,
  };
}

export function sortGlossaryEntries(
  entries: readonly GlossaryEntry[],
): GlossaryEntry[] {
  return [...entries].sort((first, second) => {
    const firstRect = first.sourceRects[0] ?? { x: 0, y: 0 };
    const secondRect = second.sourceRects[0] ?? { x: 0, y: 0 };
    return (
      first.pageNumber - second.pageNumber ||
      firstRect.y - secondRect.y ||
      firstRect.x - secondRect.x ||
      first.createdAt - second.createdAt ||
      first.glossaryEntryId.localeCompare(second.glossaryEntryId)
    );
  });
}

export function removeGlossaryEntry(
  entries: readonly GlossaryEntry[],
  annotations: readonly PdfAnnotation[],
  glossaryEntryId: string,
): {
  entries: GlossaryEntry[];
  annotations: PdfAnnotation[];
  removedMarkerId: string | null;
} {
  const entry = entries.find(
    (candidate) => candidate.glossaryEntryId === glossaryEntryId,
  );
  return {
    entries: entries.filter(
      (candidate) => candidate.glossaryEntryId !== glossaryEntryId,
    ),
    annotations: [...annotations],
    removedMarkerId: entry?.markerAnnotationId ?? null,
  };
}

export function getDefaultPrintLayout(): NotesPrintLayout {
  return 'standard';
}

export function getPrintLayoutClass(layout: NotesPrintLayout): string {
  return layout === 'space-saving'
    ? 'print-layout-space-saving'
    : 'print-layout-standard';
}
