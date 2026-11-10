import type { PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type {
  DefinitionBubble,
  DictionaryDefinition,
  GlossaryEntry,
  NotesPrintLayout,
  PdfGlossaryEntry,
  SemanticGlossaryEntry,
} from '../types/glossary';
import { isPdfGlossaryEntry, isSemanticGlossaryEntry } from '../types/glossary.ts';
import type { DocxSemanticAnchor, PptxSemanticAnchor } from '../documents/anchors';

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

export function createSemanticGlossaryEntry(
  documentId: string,
  displayedWord: string,
  preferredDefinition: DictionaryDefinition,
  anchor: PptxSemanticAnchor | DocxSemanticAnchor,
  timestamp = Date.now(),
  glossaryEntryId = crypto.randomUUID(),
): SemanticGlossaryEntry {
  return {
    glossaryEntryId,
    documentId,
    displayedWord,
    normalizedLookupWord: displayedWord.toLocaleLowerCase('en-US'),
    definition: preferredDefinition.text,
    locationKind: 'semantic',
    anchor,
    locationLabel:
      anchor.kind === 'pptx-text'
        ? `Slide ${anchor.slideIndex + 1}`
        : `Block ${anchor.blockIndex + 1}`,
    createdAt: timestamp,
    source: preferredDefinition.source,
  };
}

export function markDefinitionBubbleAdded(
  bubble: DefinitionBubble,
  glossaryEntryId: string,
  confirmationToken = Date.now(),
): DefinitionBubble {
  return {
    ...bubble,
    glossaryEntryId,
    addedConfirmationToken: confirmationToken,
  };
}

export function findMatchingPdfGlossaryEntry(
  bubble: Pick<
    DefinitionBubble,
    'documentId' | 'pageNumber' | 'rects' | 'startOffset' | 'endOffset'
  >,
  entries: readonly GlossaryEntry[],
): PdfGlossaryEntry | null {
  return (
    entries.find(
      (entry): entry is PdfGlossaryEntry =>
        isPdfGlossaryEntry(entry) &&
        entry.documentId === bubble.documentId &&
        entry.pageNumber === bubble.pageNumber &&
        entry.startOffset === bubble.startOffset &&
        entry.endOffset === bubble.endOffset &&
        glossaryRectanglesMatch(entry.sourceRects, bubble.rects),
    ) ?? null
  );
}

export function sortGlossaryEntries(
  entries: readonly GlossaryEntry[],
): GlossaryEntry[] {
  return [...entries].sort((first, second) => {
    if (isPdfGlossaryEntry(first) && isPdfGlossaryEntry(second)) {
      const firstRect = first.sourceRects[0] ?? { x: 0, y: 0 };
      const secondRect = second.sourceRects[0] ?? { x: 0, y: 0 };
      return (
        first.pageNumber - second.pageNumber ||
        firstRect.y - secondRect.y ||
        firstRect.x - secondRect.x ||
        first.createdAt - second.createdAt ||
        first.glossaryEntryId.localeCompare(second.glossaryEntryId)
      );
    }
    if (isSemanticGlossaryEntry(first) && isSemanticGlossaryEntry(second)) {
      const firstPosition =
        first.anchor.kind === 'pptx-text'
          ? [first.anchor.slideIndex, first.anchor.paragraphIndex]
          : [first.anchor.blockIndex, first.anchor.startOffset];
      const secondPosition =
        second.anchor.kind === 'pptx-text'
          ? [second.anchor.slideIndex, second.anchor.paragraphIndex]
          : [second.anchor.blockIndex, second.anchor.startOffset];
      return (
        firstPosition[0] - secondPosition[0] ||
        firstPosition[1] - secondPosition[1] ||
        first.createdAt - second.createdAt ||
        first.glossaryEntryId.localeCompare(second.glossaryEntryId)
      );
    }
    return isPdfGlossaryEntry(first) ? -1 : 1;
  });
}

export function getPrintContentItems(
  notes: readonly Note[],
  glossaryEntries: readonly GlossaryEntry[],
): { notes: Note[]; glossaryEntries: GlossaryEntry[] } {
  return {
    notes: [...notes],
    glossaryEntries: sortGlossaryEntries(glossaryEntries),
  };
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
    removedMarkerId:
      entry && isPdfGlossaryEntry(entry) ? entry.markerAnnotationId : null,
  };
}

export function getDefaultPrintLayout(): NotesPrintLayout {
  return 'standard';
}

export function getPrintLayoutClass(layout: NotesPrintLayout): string {
  return `print-layout-${layout}`;
}

function glossaryRectanglesMatch(
  first: Array<{ x: number; y: number; width: number; height: number }>,
  second: Array<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return (
    first.length === second.length &&
    first.every((rectangle, index) => {
      const candidate = second[index];
      return (
        candidate !== undefined &&
        Math.abs(rectangle.x - candidate.x) < 0.0001 &&
        Math.abs(rectangle.y - candidate.y) < 0.0001 &&
        Math.abs(rectangle.width - candidate.width) < 0.0001 &&
        Math.abs(rectangle.height - candidate.height) < 0.0001
      );
    })
  );
}
