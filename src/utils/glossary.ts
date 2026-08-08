import type { DictionaryDefinition, GlossaryEntry } from '../types/glossary';
import type { PdfTextSelection } from '../types/textSelection';
import { normalizeSelectionRectangles } from './highlights';

export function createGlossaryEntry(
  documentId: string,
  displayedWord: string,
  normalizedLookupWord: string,
  selection: PdfTextSelection,
  preferredDefinition: DictionaryDefinition,
  timestamp = Date.now(),
  glossaryEntryId = crypto.randomUUID(),
  markerAnnotationId = crypto.randomUUID(),
): GlossaryEntry {
  return {
    glossaryEntryId,
    documentId,
    displayedWord,
    normalizedLookupWord,
    definition: preferredDefinition.text,
    pageNumber: selection.pageNumber,
    sourceRects: normalizeSelectionRectangles(
      selection.boundingRectangles,
      selection.pageWidth,
      selection.pageHeight,
    ),
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    createdAt: timestamp,
    source: preferredDefinition.source,
    markerAnnotationId,
  };
}

export {
  createGlossaryEntryFromBubble,
  getDefaultPrintLayout,
  getPrintContentItems,
  getPrintLayoutClass,
  markDefinitionBubbleAdded,
  removeGlossaryEntry,
  sortGlossaryEntries,
} from './glossaryModel';
