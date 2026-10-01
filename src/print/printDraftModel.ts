import type { Note } from '../types/note';
import { isPdfGlossaryEntry, type GlossaryEntry } from '../types/glossary.ts';
import type { PdfAnnotation } from '../types/highlight';
import type { NoteAnchor } from '../types/noteAnchor';
import type {
  PrintDraftRecord,
  RenderedPrintPdfDescriptor,
} from '../types/productivity.ts';
import { sha256Hex, stableStringify } from '../sync/hash.ts';

export const PRINT_SOURCE_MODEL_VERSION = 2;

export function createPrintSourceFingerprint(
  documentTitle: string,
  notes: readonly Note[],
  glossaryEntries: readonly GlossaryEntry[],
  annotations: readonly PdfAnnotation[] = [],
  noteAnchors: readonly NoteAnchor[] = [],
): string {
  const source = JSON.stringify({
    sourceModelVersion: PRINT_SOURCE_MODEL_VERSION,
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
      isPdfGlossaryEntry(entry)
        ? ['pdf', entry.pageNumber, entry.startOffset, entry.endOffset]
        : ['semantic', entry.anchor],
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
    noteAnchors: noteAnchors.map((anchor) => [
      anchor.id,
      anchor.pageNumber,
      anchor.text,
      anchor.rects,
      anchor.startOffset,
      anchor.endOffset,
      anchor.updatedAt,
    ]),
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${source.length}`;
}

/** Cryptographic identity of every input that can affect a future rendered PDF. */
export function createPrintDraftHash(
  draft: PrintDraftRecord,
  currentSourceFingerprint = draft.sourceFingerprint,
): Promise<string> {
  return sha256Hex(
    stableStringify({
      documentId: draft.documentId,
      printSourceModelVersion: PRINT_SOURCE_MODEL_VERSION,
      currentSourceFingerprint,
      draftSchemaVersion: draft.draftSchemaVersion,
      editorStateJson: draft.editorStateJson,
      contentMode: draft.contentMode,
      baseTemplateId: draft.baseTemplateId,
      templateVersion: draft.templateVersion,
      overrides: draft.overrides,
      pendingAdditions: draft.pendingAdditions,
    }),
  );
}

export async function isRenderedPrintPdfStale(
  draft: PrintDraftRecord,
  artifact: RenderedPrintPdfDescriptor,
  currentSourceFingerprint = draft.sourceFingerprint,
): Promise<boolean> {
  return (
    artifact.renderedFromDraftHash !==
    (await createPrintDraftHash(draft, currentSourceFingerprint))
  );
}
