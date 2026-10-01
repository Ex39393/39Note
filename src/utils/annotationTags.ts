import type { PdfAnnotation } from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import { isSameLogicalPdfSource, normalizePdfSourceText } from './pdfSourceGeometry.ts';

export type AnnotationTagNoteSource = 'mark' | 'legacy-anchor' | null;

export interface AnnotationTagModel {
  id: string;
  annotation: PdfAnnotation;
  note: Note | null;
  noteSource: AnnotationTagNoteSource;
}

export interface AnnotationTagState {
  annotations: PdfAnnotation[];
  notes: Note[];
  noteAnchors: NoteAnchor[];
}

interface NewAnnotationNoteOptions {
  id?: string;
  displayNumber: string;
  timestamp?: number;
}

export interface AddAnnotationTagNoteResult {
  state: AnnotationTagState;
  createdNote: Note | null;
}

export interface DeleteAnnotationTagResult {
  state: AnnotationTagState;
  deleted: boolean;
  requiresConfirmation: boolean;
}

/**
 * A Tag is derived 1:1 from every persisted Highlight or Underline. Notes that
 * already point at a mark win. Notes with the structural provenance of the
 * previous marked-source workflow are adopted only when exactly one unnoted
 * mark has matching geometry; unmatched or ambiguous legacy Notes remain
 * standalone and untouched.
 */
export function deriveAnnotationTags(
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[],
): AnnotationTagModel[] {
  const orderedNotes = [...notes].sort(compareNotes);
  const tags = annotations.map<AnnotationTagModel>((annotation) => ({
    id: annotation.id,
    annotation,
    note: null,
    noteSource: null,
  }));
  const tagsByAnnotationId = new Map(tags.map((tag) => [tag.annotation.id, tag]));
  const usedNoteIds = new Set<string>();

  for (const note of orderedNotes) {
    const directTag = tagsByAnnotationId.get(note.annotationId);
    if (!directTag || directTag.note) continue;
    directTag.note = note;
    directTag.noteSource = 'mark';
    usedNoteIds.add(note.id);
  }

  const anchorsById = new Map(noteAnchors.map((anchor) => [anchor.id, anchor]));
  for (const note of orderedNotes) {
    if (usedNoteIds.has(note.id)) continue;
    const anchor = anchorsById.get(note.annotationId);
    if (!anchor || !hasLegacyMarkedSourceProvenance(note, anchor)) continue;
    const matchingTags = tags.filter(
      (tag) => !tag.note && isSameLogicalPdfSource(tag.annotation, anchor),
    );
    if (matchingTags.length !== 1) continue;
    const [targetTag] = matchingTags;
    targetTag.note = note;
    targetTag.noteSource = 'legacy-anchor';
    usedNoteIds.add(note.id);
  }

  return tags;
}

export function findAnnotationTag(
  annotationId: string,
  annotations: readonly PdfAnnotation[],
  notes: readonly Note[],
  noteAnchors: readonly NoteAnchor[],
): AnnotationTagModel | null {
  return (
    deriveAnnotationTags(annotations, notes, noteAnchors).find(
      (tag) => tag.annotation.id === annotationId,
    ) ?? null
  );
}

export function addNoteToAnnotationTag(
  state: AnnotationTagState,
  annotationId: string,
  options: NewAnnotationNoteOptions,
): AddAnnotationTagNoteResult {
  const tag = findAnnotationTag(
    annotationId,
    state.annotations,
    state.notes,
    state.noteAnchors,
  );
  if (!tag || tag.note) {
    return { state, createdNote: null };
  }

  const timestamp = options.timestamp ?? Date.now();
  const note: Note = {
    id: options.id ?? crypto.randomUUID(),
    annotationId: tag.annotation.id,
    pageNumber: tag.annotation.pageNumber,
    displayNumber: options.displayNumber,
    selectedText: tag.annotation.text,
    content: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    state: {
      ...state,
      notes: [note, ...state.notes],
    },
    createdNote: note,
  };
}

export function deleteNoteFromTagState(
  state: AnnotationTagState,
  noteId: string,
): AnnotationTagState {
  const note = state.notes.find((candidate) => candidate.id === noteId);
  if (!note) return state;

  const notes = state.notes.filter((candidate) => candidate.id !== noteId);
  const hasRemainingAnchorNote = notes.some(
    (candidate) => candidate.annotationId === note.annotationId,
  );
  return {
    ...state,
    notes,
    noteAnchors:
      !hasRemainingAnchorNote &&
      state.noteAnchors.some((anchor) => anchor.id === note.annotationId)
        ? state.noteAnchors.filter((anchor) => anchor.id !== note.annotationId)
        : state.noteAnchors,
  };
}

export function deleteAnnotationTag(
  state: AnnotationTagState,
  annotationId: string,
  confirmed: boolean,
): DeleteAnnotationTagResult {
  const tag = findAnnotationTag(
    annotationId,
    state.annotations,
    state.notes,
    state.noteAnchors,
  );
  if (!tag) {
    return { state, deleted: false, requiresConfirmation: false };
  }
  if (tag.note && !confirmed) {
    return { state, deleted: false, requiresConfirmation: true };
  }

  const stateWithoutNote = tag.note
    ? deleteNoteFromTagState(state, tag.note.id)
    : state;
  return {
    state: {
      ...stateWithoutNote,
      annotations: stateWithoutNote.annotations.filter(
        (annotation) => annotation.id !== annotationId,
      ),
    },
    deleted: true,
    requiresConfirmation: false,
  };
}

function compareNotes(first: Note, second: Note): number {
  return first.createdAt - second.createdAt || first.id.localeCompare(second.id);
}

function hasLegacyMarkedSourceProvenance(note: Note, anchor: NoteAnchor): boolean {
  return (
    anchor.startOffset === 0 &&
    anchor.endOffset === anchor.text.length &&
    note.pageNumber === anchor.pageNumber &&
    normalizePdfSourceText(note.selectedText) === normalizePdfSourceText(anchor.text) &&
    Math.abs(note.createdAt - anchor.createdAt) <= 1_000
  );
}
