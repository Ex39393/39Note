import type { LibraryDocument } from '../services/annotationPersistence.ts';
import type { CollectionRecord } from '../types/library.ts';

export type CollectionEditorMode = 'view' | 'create' | 'edit';

export interface CollectionEditorDraft {
  collectionId?: string;
  name: string;
  selectedDocumentIds: string[];
}

export interface CollectionEditorState {
  mode: CollectionEditorMode;
  selectedCollectionId: string | null;
  draft: CollectionEditorDraft | null;
  paperSearch: string;
}

export function createInitialCollectionEditorState(): CollectionEditorState {
  return {
    mode: 'view',
    selectedCollectionId: null,
    draft: null,
    paperSearch: '',
  };
}

export function openCollectionEditorView(
  state: CollectionEditorState,
  collectionId: string,
): CollectionEditorState {
  return {
    ...state,
    mode: 'view',
    selectedCollectionId: collectionId,
    draft: null,
    paperSearch: '',
  };
}

export function beginCollectionCreate(
  state: CollectionEditorState,
): CollectionEditorState {
  return {
    ...state,
    mode: 'create',
    draft: createCollectionEditorDraft(),
    paperSearch: '',
  };
}

export function beginCollectionEdit(
  state: CollectionEditorState,
  collection: CollectionRecord,
  selectedDocumentIds: readonly string[],
): CollectionEditorState {
  return {
    ...state,
    mode: 'edit',
    selectedCollectionId: collection.id,
    draft: createCollectionEditorDraft(collection, selectedDocumentIds),
    paperSearch: '',
  };
}

export function cancelCollectionEditing(
  state: CollectionEditorState,
): CollectionEditorState {
  return {
    ...state,
    mode: 'view',
    draft: null,
    paperSearch: '',
  };
}

export function completeCollectionEditing(
  state: CollectionEditorState,
  collectionId: string,
): CollectionEditorState {
  return openCollectionEditorView(state, collectionId);
}

export function createCollectionEditorDraft(
  collection?: CollectionRecord,
  selectedDocumentIds: readonly string[] = [],
): CollectionEditorDraft {
  return {
    ...(collection ? { collectionId: collection.id } : {}),
    name: collection?.name ?? '',
    selectedDocumentIds: [...new Set(selectedDocumentIds)],
  };
}

export function updateCollectionDraftMembership(
  draft: CollectionEditorDraft,
  documentId: string,
  included: boolean,
): CollectionEditorDraft {
  const selected = new Set(draft.selectedDocumentIds);
  if (included) selected.add(documentId);
  else selected.delete(documentId);
  return { ...draft, selectedDocumentIds: [...selected] };
}

export function filterCollectionAvailablePapers(
  documents: readonly LibraryDocument[],
  query: string,
): LibraryDocument[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...documents];
  return documents.filter((paper) =>
    paper.displayTitle.toLocaleLowerCase().includes(normalizedQuery),
  );
}
