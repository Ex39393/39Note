import type { Note } from '../types/note';
import type { GlossaryEntry } from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';

export function createPrintSourceFingerprint(
  documentTitle: string,
  notes: readonly Note[],
  glossaryEntries: readonly GlossaryEntry[],
  annotations: readonly PdfAnnotation[] = [],
): string {
  const source = JSON.stringify({
    documentTitle,
    notes: notes.map((note) => [
      note.id,
      note.displayNumber,
      note.pageNumber,
      note.selectedText,
      note.content,
      note.updatedAt,
    ]),
    glossary: glossaryEntries.map((entry) => [
      entry.glossaryEntryId,
      entry.displayedWord,
      entry.definition,
      entry.pageNumber,
      entry.source.dataset,
      entry.source.version,
    ]),
    annotations: annotations.map((annotation) => [
      annotation.id,
      annotation.type,
      annotation.pageNumber,
      annotation.text,
      annotation.rects,
      annotation.color,
      annotation.updatedAt,
    ]),
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${source.length}`;
}
