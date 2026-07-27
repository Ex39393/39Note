import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  getLibraryStorageSummary,
  createCollection,
  createTag,
  deleteCollection,
  deleteTag,
  listCollections,
  listTags,
  listLibraryDocuments,
  type LibraryDocument,
  type LibraryStorageSummary,
} from '../services/annotationPersistence';
import type { CollectionRecord, TagRecord } from '../types/library';
import {
  downloadLibraryBackup,
  downloadSelectedPackage,
  inspectBackup,
  restoreBackup,
  type RestorePreview,
} from '../services/libraryBackup';

interface LibraryPanelProps {
  isOpen: boolean;
  refreshToken: number;
  onClose: () => void;
  onForget: (documentId: string) => Promise<boolean>;
  onOpenFile: (file: File) => void;
  onOpenStoredPdf: (documentId: string) => Promise<boolean>;
  onOpenLibraryNote: (documentId: string, noteId: string, annotationId: string, pageNumber: number) => Promise<boolean>;
  onSelectPdfForLibraryNote: (
    file: File,
    documentId: string,
    noteId: string,
    annotationId: string,
    pageNumber: number,
  ) => void;
  onRenameDocument: (documentId: string, displayTitle: string) => Promise<boolean>;
  onRemovePdfCopy: (documentId: string) => Promise<boolean>;
  focusSearchRequestId: number;
  onPinDocument: (documentId: string, isPinned: boolean) => Promise<boolean>;
  onForgetMany: (documentIds: string[]) => Promise<{ deleted: string[]; failed: string[] }>;
  onUpdateOrganization: (documentId: string, update: { collectionIds?: string[]; tagIds?: string[] }) => Promise<boolean>;
}

interface LibraryNoteResult {
  document: LibraryDocument;
  noteId: string;
  annotationId: string;
  displayNumber: string;
  content: string;
  pageNumber: number;
  selectedText: string;
}

type LibraryScope =
  | { type: 'all' }
  | { type: 'collection'; id: string }
  | { type: 'tag'; id: string };

interface LibraryWorkspaceSize { width: number; height: number; }

function readLibraryWorkspaceSize(): LibraryWorkspaceSize | null {
  const width = Number(sessionStorage.getItem('39note.library-width'));
  const height = Number(sessionStorage.getItem('39note.library-height'));
  return Number.isFinite(width) && Number.isFinite(height) && width >= 680 && height >= 460 ? { width, height } : null;
}

export function LibraryPanel({
  isOpen,
  refreshToken,
  onClose,
  onForget,
  onOpenFile,
  onOpenStoredPdf,
  onOpenLibraryNote,
  onSelectPdfForLibraryNote,
  onRenameDocument,
  onRemovePdfCopy,
  focusSearchRequestId,
  onPinDocument,
  onForgetMany,
  onUpdateOrganization,
}: LibraryPanelProps) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [forgettingDocumentId, setForgettingDocumentId] = useState<string | null>(null);
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [openingNoteId, setOpeningNoteId] = useState<string | null>(null);
  const [editingDocumentId, setEditingDocumentId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [libraryView, setLibraryView] = useState<'all' | 'recent' | 'pinned'>('all');
  const [sortMode, setSortMode] = useState<'modified' | 'read' | 'title'>('modified');
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [isBatchForgetting, setIsBatchForgetting] = useState(false);
  const [isBatchForgetConfirmationOpen, setIsBatchForgetConfirmationOpen] = useState(false);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [collectionDraft, setCollectionDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [scope, setScope] = useState<LibraryScope>({ type: 'all' });
  const [pendingForgetDocument, setPendingForgetDocument] = useState<LibraryDocument | null>(null);
  const [pendingPdfRemoval, setPendingPdfRemoval] = useState<LibraryDocument | null>(null);
  const [removingPdfDocumentId, setRemovingPdfDocumentId] = useState<string | null>(null);
  const [backupProgress, setBackupProgress] = useState<{ completed: number; total: number } | null>(null);
  const [packageProgress, setPackageProgress] = useState<{ completed: number; total: number } | null>(null);
  const [isInspectingBackup, setIsInspectingBackup] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [storageSummary, setStorageSummary] = useState<LibraryStorageSummary | null>(null);
  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [workspaceSize, setWorkspaceSize] = useState<LibraryWorkspaceSize | null>(readLibraryWorkspaceSize);
  const [isMaximized, setIsMaximized] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleDocuments = useMemo(() => sortDocuments(documents.filter((document) => {
    const matchesView = libraryView === 'all'
      || (libraryView === 'pinned' ? document.isPinned : Boolean(document.lastReadAt));
    const matchesScope = scope.type === 'all'
      || (scope.type === 'collection' && document.collectionIds.includes(scope.id))
      || (scope.type === 'tag' && document.tagIds.includes(scope.id));

    return matchesView && matchesScope;
  }), sortMode), [documents, libraryView, scope, sortMode]);
  const searchResults = useMemo(() => getSearchResults(visibleDocuments, searchQuery), [visibleDocuments, searchQuery]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let isDisposed = false;
    setIsLoading(true);
    setError(null);

    void listLibraryDocuments().then((nextDocuments) => {
      if (!isDisposed) {
        setDocuments(nextDocuments);
        setIsLoading(false);
      }
    });
    void Promise.all([listCollections(), listTags()]).then(([nextCollections, nextTags]) => {
      if (!isDisposed) { setCollections(nextCollections); setTags(nextTags); }
    });

    return () => {
      isDisposed = true;
    };
  }, [isOpen, refreshToken]);

  useEffect(() => {
    if (isOpen && focusSearchRequestId > 0) {
      searchInputRef.current?.focus();
    }
  }, [focusSearchRequestId, isOpen]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!isOpen || !panel || isMaximized) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width >= 680 && height >= 460) {
        const nextSize = { width: Math.round(width), height: Math.round(height) };
        setWorkspaceSize((currentSize) => currentSize?.width === nextSize.width && currentSize.height === nextSize.height ? currentSize : nextSize);
        sessionStorage.setItem('39note.library-width', String(nextSize.width));
        sessionStorage.setItem('39note.library-height', String(nextSize.height));
      }
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [isMaximized, isOpen]);

  useEffect(() => {
    if (
      (scope.type === 'collection' && !collections.some((collection) => collection.id === scope.id))
      || (scope.type === 'tag' && !tags.some((tag) => tag.id === scope.id))
    ) {
      setScope({ type: 'all' });
    }
  }, [collections, scope, tags]);

  const refreshLibrary = async () => {
    const [nextDocuments, nextSummary] = await Promise.all([
      listLibraryDocuments(),
      isStorageOpen ? getLibraryStorageSummary() : Promise.resolve(null),
    ]);
    setDocuments(nextDocuments);
    if (nextSummary) {
      setStorageSummary(nextSummary);
    }
  };

  const createBackup = async () => {
    setError(null);
    setBackupProgress({ completed: 0, total: documents.length });
    try {
      await downloadLibraryBackup((completed, total) => setBackupProgress({ completed, total }));
    } catch {
      setError('The Library backup could not be created. Please try again.');
    } finally {
      setBackupProgress(null);
    }
  };

  const packageSelectedDocuments = async () => {
    setError(null);
    setPackageProgress({ completed: 0, total: selectedDocumentIds.length });
    try {
      await downloadSelectedPackage(selectedDocumentIds, (completed, total) => setPackageProgress({ completed, total }));
    } catch (packageError) {
      setError(packageError instanceof Error ? packageError.message : 'The selected documents could not be packaged.');
    } finally {
      setPackageProgress(null);
    }
  };

  const selectBackup = async (file: File) => {
    setIsInspectingBackup(true);
    setError(null);
    try {
      setRestorePreview(await inspectBackup(file));
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : 'This backup could not be read.');
    } finally {
      setIsInspectingBackup(false);
    }
  };

  const restorePreviewDocuments = async (replaceExisting: boolean) => {
    if (!restorePreview) {
      return;
    }
    setIsRestoring(true);
    setError(null);
    const result = await restoreBackup(restorePreview, replaceExisting);
    setIsRestoring(false);
    setRestorePreview(null);
    if (result.failed > 0) {
      setError(`${result.imported} document${result.imported === 1 ? '' : 's'} restored; ${result.failed} could not be restored.`);
    }
    await refreshLibrary();
  };

  const removePdfCopy = async (document: LibraryDocument) => {
    setRemovingPdfDocumentId(document.documentId);
    setError(null);
    const wasRemoved = await onRemovePdfCopy(document.documentId);
    setRemovingPdfDocumentId(null);
    setPendingPdfRemoval(null);
    if (wasRemoved) {
      await refreshLibrary();
    } else {
      setError('The saved PDF copy could not be removed. Please try again.');
    }
  };

  const toggleStorage = async () => {
    const nextIsOpen = !isStorageOpen;
    setIsStorageOpen(nextIsOpen);
    if (nextIsOpen) {
      setStorageSummary(await getLibraryStorageSummary());
    }
  };

  if (!isOpen) {
    return null;
  }

  const forgetDocument = async (document: LibraryDocument) => {
    setForgettingDocumentId(document.documentId);
    setError(null);
    const wasForgotten = await onForget(document.documentId);
    setForgettingDocumentId(null);

    if (wasForgotten) {
      setDocuments((currentDocuments) => currentDocuments.filter(
        (candidate) => candidate.documentId !== document.documentId,
      ));
    } else {
      setError('The document could not be forgotten. Please try again.');
    }
    setPendingForgetDocument(null);
  };

  const openStoredPdf = async (documentId: string) => {
    setOpeningDocumentId(documentId);
    setError(null);
    const wasOpened = await onOpenStoredPdf(documentId);
    setOpeningDocumentId(null);

    if (!wasOpened) {
      setError('The saved PDF copy could not be opened. You can select the PDF again.');
    }
  };

  const openLibraryNote = async (result: LibraryNoteResult) => {
    setOpeningNoteId(result.noteId);
    setError(null);
    const wasOpened = await onOpenLibraryNote(
      result.document.documentId,
      result.noteId,
      result.annotationId,
      result.pageNumber,
    );
    setOpeningNoteId(null);

    if (!wasOpened && result.document.hasStoredPdf) {
      setError('The saved PDF copy could not be opened. You can select the PDF again.');
    }
  };

  const commitTitle = async (document: LibraryDocument) => {
    const displayTitle = titleDraft.trim();
    if (displayTitle.length === 0) {
      setEditingDocumentId(null);
      setTitleDraft(document.displayTitle);
      return;
    }

    const wasRenamed = await onRenameDocument(document.documentId, displayTitle);
    if (wasRenamed) {
      setDocuments((currentDocuments) => currentDocuments.map((candidate) => (
        candidate.documentId === document.documentId ? { ...candidate, displayTitle } : candidate
      )));
      setEditingDocumentId(null);
    } else {
      setError('The document title could not be updated. Please try again.');
    }
  };

  const isSearching = searchQuery.trim().length > 0;
  const activeScopeName = scope.type === 'collection'
    ? collections.find((collection) => collection.id === scope.id)?.name
    : scope.type === 'tag'
      ? tags.find((tag) => tag.id === scope.id)?.name
      : null;
  const hasActiveScope = scope.type !== 'all' || libraryView !== 'all';
  const applyScope = (nextScope: LibraryScope) => {
    setScope(nextScope);
    setSearchQuery('');
  };

  return (
    <section
      ref={panelRef}
      className={`library-panel ${isMaximized ? 'is-maximized' : ''}`}
      aria-label="Library"
      style={workspaceSize && !isMaximized ? { width: `${workspaceSize.width}px`, height: `${workspaceSize.height}px` } as CSSProperties : undefined}
    >
      <header className="library-panel-header">
        <div>
          <p>Library</p>
          <h2>Saved documents</h2>
        </div>
        <div className="library-panel-header-actions">
          <button aria-label={isMaximized ? 'Restore Library size' : 'Maximize Library'} title={isMaximized ? 'Restore Library size' : 'Maximize Library'} type="button" onClick={() => setIsMaximized((maximized) => !maximized)}>{isMaximized ? '↙' : '↗'}</button>
          <button aria-label="Return to Reader" title="Return to Reader" type="button" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="library-panel-content">
        <p className="library-description">
          Saved PDFs, highlights, and notes stay locally on this device.
        </p>
        <div className="library-backup-actions">
          <button
            disabled={backupProgress !== null}
            type="button"
            onClick={() => void createBackup()}
          >
            {backupProgress
              ? `Backing up ${backupProgress.completed}/${backupProgress.total}`
              : 'Back up Library'}
          </button>
          <button
            disabled={isInspectingBackup || isRestoring}
            type="button"
            onClick={() => restoreInputRef.current?.click()}
          >
            {isInspectingBackup ? 'Checking backup...' : 'Restore backup'}
          </button>
          <button type="button" onClick={() => void toggleStorage()}>
            {isStorageOpen ? 'Hide storage' : 'Storage'}
          </button>
          <input
            ref={restoreInputRef}
            className="visually-hidden"
            accept="application/zip,.zip"
            type="file"
            onChange={(event) => {
              const [selectedFile] = Array.from(event.target.files ?? []);
              if (selectedFile) {
                void selectBackup(selectedFile);
              }
              event.target.value = '';
            }}
          />
        </div>
        {isStorageOpen && storageSummary ? (
          <section className="library-storage-summary" aria-label="Library storage summary">
            <strong>Local storage</strong>
            <span>{storageSummary.documentCount} documents</span>
            <span>{storageSummary.storedPdfCount} PDF copies · {formatFileSize(storageSummary.storedPdfBytes)}</span>
            <span>{storageSummary.annotationCount} annotations · {storageSummary.noteCount} notes</span>
            {storageSummary.estimatedUsageBytes !== null ? (
              <span>
                Approx. browser storage used: {formatFileSize(storageSummary.estimatedUsageBytes)}
                {storageSummary.estimatedQuotaBytes !== null
                  ? ` of ${formatFileSize(storageSummary.estimatedQuotaBytes)} (${formatPercentage(storageSummary.estimatedUsageBytes, storageSummary.estimatedQuotaBytes)})`
                  : ''}
              </span>
            ) : (
              <span>Browser quota estimate is unavailable.</span>
            )}
            <p className="library-storage-location">
              This Library belongs to this website origin. Another browser or website domain
              has a separate Library. Back up your Library before clearing browser data.
            </p>
          </section>
        ) : null}
        <div className="library-search">
          <input
            ref={searchInputRef}
            aria-label="Search Library"
            placeholder="Search title or notes"
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
        <div className="library-backup-actions library-scope-controls" aria-label="Library views">
          <button aria-pressed={libraryView === 'all'} type="button" onClick={() => setLibraryView('all')}>All</button>
          <button aria-pressed={libraryView === 'recent'} type="button" onClick={() => setLibraryView('recent')}>Recent</button>
          <button aria-pressed={libraryView === 'pinned'} data-library-scope="pinned" type="button" onClick={() => setLibraryView('pinned')}>Pinned</button>
          <select aria-label="Sort Library" value={sortMode} onChange={(event) => setSortMode(event.target.value as typeof sortMode)}>
            <option value="modified">Recently modified</option><option value="read">Recently read</option><option value="title">Title A–Z</option>
          </select>
          <button type="button" onClick={() => { setIsSelectionMode((enabled) => !enabled); setSelectedDocumentIds([]); }}>{isSelectionMode ? 'Done selecting' : 'Select'}</button>
        </div>
        <div className="library-scope-row">
          <div className="library-scope-list" aria-label="Browse Library by Collection or Tag">
              <span>Browse:</span>
              {hasActiveScope ? <strong>{activeScopeName ?? (libraryView === 'recent' ? 'Recent' : libraryView === 'pinned' ? 'Pinned' : 'All documents')}</strong> : null}
              {collections.map((collection) => (
                <button
                  aria-pressed={scope.type === 'collection' && scope.id === collection.id}
                  className="library-scope-button"
                  key={`collection:${collection.id}`}
                  type="button"
                  onClick={() => applyScope({ type: 'collection', id: collection.id })}
                >
                  {collection.name}
                </button>
              ))}
              {tags.map((tag) => (
                <button
                  aria-pressed={scope.type === 'tag' && scope.id === tag.id}
                  className="library-scope-button"
                  key={`tag:${tag.id}`}
                  type="button"
                  onClick={() => applyScope({ type: 'tag', id: tag.id })}
                >
                  #{tag.name}
                </button>
              ))}
          </div>
          {hasActiveScope ? (
            <button className="library-clear-scope" type="button" onClick={() => { applyScope({ type: 'all' }); setLibraryView('all'); }}>Clear Scope</button>
          ) : null}
        </div>
        <section className="library-entities" aria-label="Collections and Tags">
          <form onSubmit={(event) => { event.preventDefault(); void createCollection(collectionDraft).then((record) => { if (record) { setCollections((items) => [...items, record]); setCollectionDraft(''); } else setError('Collection names must be unique and non-empty.'); }); }}><label>Collections<input value={collectionDraft} onChange={(event) => setCollectionDraft(event.target.value)} placeholder="New Collection" /></label><button type="submit">Add</button></form>
          <div>{collections.map((collection) => <span className="library-count" key={collection.id}>{collection.name}<button aria-label={`Delete ${collection.name}`} type="button" onClick={() => void deleteCollection(collection.id).then((deleted) => { if (deleted) setCollections((items) => items.filter((item) => item.id !== collection.id)); })}>×</button></span>)}</div>
          <form onSubmit={(event) => { event.preventDefault(); void createTag(tagDraft).then((record) => { if (record) { setTags((items) => [...items, record]); setTagDraft(''); } else setError('Tag names must be unique and non-empty.'); }); }}><label>Tags<input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="New Tag" /></label><button type="submit">Add</button></form>
          <div>{tags.map((tag) => <span className="library-count" key={tag.id}>{tag.name}<button aria-label={`Delete ${tag.name}`} type="button" onClick={() => void deleteTag(tag.id).then((deleted) => { if (deleted) setTags((items) => items.filter((item) => item.id !== tag.id)); })}>×</button></span>)}</div>
        </section>
        {isSelectionMode ? <div className="library-backup-actions library-selection-actions"><button type="button" onClick={() => setSelectedDocumentIds(searchResults.documents.map((document) => document.documentId))}>Select all</button><button type="button" onClick={() => setSelectedDocumentIds([])}>Clear</button><button disabled={selectedDocumentIds.length === 0 || packageProgress !== null} type="button" onClick={() => void packageSelectedDocuments()}>{packageProgress ? `Packaging ${packageProgress.completed}/${packageProgress.total}` : selectedDocumentIds.length === 0 ? 'Package Selected' : `Package ${selectedDocumentIds.length} Document${selectedDocumentIds.length === 1 ? '' : 's'}`}</button><button disabled={selectedDocumentIds.length === 0 || isBatchForgetting} className="library-forget-button" type="button" onClick={() => setIsBatchForgetConfirmationOpen(true)}>{isBatchForgetting ? 'Forgetting…' : `Forget ${selectedDocumentIds.length} Document${selectedDocumentIds.length === 1 ? '' : 's'}`}</button></div> : null}
        {error ? <p className="library-error" role="status">{error}</p> : null}
        {isLoading ? <p className="library-empty">Loading saved documents…</p> : null}
        {!isLoading && documents.length === 0 ? (
          <p className="library-empty">No saved documents yet.</p>
        ) : null}
        {!isLoading && documents.length > 0 && searchResults.documents.length === 0 && searchResults.notes.length === 0 ? (
          <p className="library-empty">No saved documents match this search.</p>
        ) : null}
        {searchResults.documents.length > 0 ? (
          <section className="library-result-section" aria-label="Document results">
            {isSearching ? <h3>Documents</h3> : null}
            {searchResults.documents.map((document) => (
              <LibraryDocumentCard
                key={document.documentId}
                document={document}
                editingTitle={editingDocumentId === document.documentId}
                titleDraft={titleDraft}
                isOpening={openingDocumentId === document.documentId}
                isForgetting={forgettingDocumentId === document.documentId}
                onStartEditing={() => {
                  setEditingDocumentId(document.documentId);
                  setTitleDraft(document.displayTitle);
                }}
                onTitleDraftChange={setTitleDraft}
                onCommitTitle={() => void commitTitle(document)}
                onCancelTitle={() => {
                  setEditingDocumentId(null);
                  setTitleDraft(document.displayTitle);
                }}
                onOpen={() => void openStoredPdf(document.documentId)}
                onOpenFile={onOpenFile}
                onForget={() => setPendingForgetDocument(document)}
                onRemovePdfCopy={() => setPendingPdfRemoval(document)}
                onPin={() => void onPinDocument(document.documentId, !document.isPinned).then((updated) => { if (updated) void refreshLibrary(); })}
                selectionMode={isSelectionMode}
                selected={selectedDocumentIds.includes(document.documentId)}
                onSelect={() => setSelectedDocumentIds((ids) => ids.includes(document.documentId) ? ids.filter((id) => id !== document.documentId) : [...ids, document.documentId])}
                collections={collections}
                tags={tags}
                onUpdateOrganization={(update) => void onUpdateOrganization(document.documentId, update).then((updated) => { if (updated) void refreshLibrary(); })}
                onScope={applyScope}
              />
            ))}
          </section>
        ) : null}
        {isSearching && searchResults.notes.length > 0 ? (
          <section className="library-result-section" aria-label="Note results">
            <h3>Notes</h3>
            {searchResults.notes.map((result) => (
              <LibraryNoteCard
                key={`note-result:${result.document.documentId}:${result.noteId}`}
                result={result}
                isOpening={openingNoteId === result.noteId}
                onOpen={() => void openLibraryNote(result)}
                onSelectPdf={(file) => onSelectPdfForLibraryNote(
                  file,
                  result.document.documentId,
                  result.noteId,
                  result.annotationId,
                  result.pageNumber,
                )}
              />
            ))}
          </section>
        ) : null}
      </div>
      {pendingForgetDocument ? (
        <div className="library-confirm-overlay" role="presentation">
          <section className="library-confirm-dialog" aria-modal="true" aria-label="Forget document" role="dialog">
            <h3>Forget this document?</h3>
            <p>
              This removes the saved PDF copy, annotations, and Notes from 39Note. The original PDF on your computer is not deleted.
            </p>
            <div>
              <button type="button" onClick={() => setPendingForgetDocument(null)}>Cancel</button>
              <button
                className="library-forget-button"
                disabled={forgettingDocumentId === pendingForgetDocument.documentId}
                type="button"
                onClick={() => void forgetDocument(pendingForgetDocument)}
              >
                {forgettingDocumentId === pendingForgetDocument.documentId ? 'Forgetting…' : 'Forget document'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {isBatchForgetConfirmationOpen ? (
        <div className="library-confirm-overlay" role="presentation">
          <section className="library-confirm-dialog" aria-modal="true" aria-label="Forget selected documents" role="dialog">
            <h3>Forget {selectedDocumentIds.length} selected documents?</h3>
            <p>
              This removes their saved PDF copies, annotations, and Notes from 39Note. Original PDFs on your computer are not deleted.
            </p>
            <div>
              <button disabled={isBatchForgetting} type="button" onClick={() => setIsBatchForgetConfirmationOpen(false)}>Cancel</button>
              <button
                className="library-forget-button"
                disabled={isBatchForgetting}
                type="button"
                onClick={() => {
                  setIsBatchForgetting(true);
                  void onForgetMany(selectedDocumentIds).then((result) => {
                    setIsBatchForgetting(false);
                    setIsBatchForgetConfirmationOpen(false);
                    setSelectedDocumentIds([]);
                    if (result.failed.length) setError(`${result.failed.length} documents could not be forgotten.`);
                    void refreshLibrary();
                  });
                }}
              >
                {isBatchForgetting ? 'Forgetting…' : 'Forget documents'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {pendingPdfRemoval ? (
        <div className="library-confirm-overlay" role="presentation">
          <section className="library-confirm-dialog" aria-modal="true" aria-label="Remove saved PDF copy" role="dialog">
            <h3>Remove the saved PDF copy?</h3>
            <p>
              The PDF bytes will be removed from 39Note, but its highlights and Notes stay in the Library. The original PDF on your computer is not deleted.
            </p>
            <div>
              <button type="button" onClick={() => setPendingPdfRemoval(null)}>Cancel</button>
              <button
                className="library-forget-button"
                disabled={removingPdfDocumentId === pendingPdfRemoval.documentId}
                type="button"
                onClick={() => void removePdfCopy(pendingPdfRemoval)}
              >
                {removingPdfDocumentId === pendingPdfRemoval.documentId ? 'Removing...' : 'Remove PDF copy'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {restorePreview ? (
        <div className="library-confirm-overlay" role="presentation">
          <section className="library-confirm-dialog library-restore-dialog" aria-modal="true" aria-label="Restore Library backup" role="dialog">
            <h3>Restore Library backup</h3>
            <p>
              {restorePreview.documents.length} documents, {restorePreview.pdfCount} PDF copies, {restorePreview.highlightCount} highlights, {restorePreview.underlineCount} underlines, and {restorePreview.noteCount} Notes are ready to restore.
            </p>
            <p>Created {formatUpdatedAt(restorePreview.manifest.createdAt)}.</p>
            {restorePreview.conflictCount > 0 ? (
              <p>{restorePreview.conflictCount} document{restorePreview.conflictCount === 1 ? '' : 's'} already exist{restorePreview.conflictCount === 1 ? 's' : ''} in this Library.</p>
            ) : null}
            <div>
              <button disabled={isRestoring} type="button" onClick={() => setRestorePreview(null)}>Cancel</button>
              <button disabled={isRestoring} type="button" onClick={() => void restorePreviewDocuments(false)}>
                {isRestoring ? 'Restoring...' : restorePreview.conflictCount > 0 ? 'Keep existing' : 'Restore'}
              </button>
              {restorePreview.conflictCount > 0 ? (
                <button
                  className="library-forget-button"
                  disabled={isRestoring}
                  type="button"
                  onClick={() => void restorePreviewDocuments(true)}
                >
                  Replace existing
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

interface LibraryDocumentCardProps {
  document: LibraryDocument;
  editingTitle: boolean;
  titleDraft: string;
  isOpening: boolean;
  isForgetting: boolean;
  onStartEditing: () => void;
  onTitleDraftChange: (value: string) => void;
  onCommitTitle: () => void;
  onCancelTitle: () => void;
  onOpen: () => void;
  onOpenFile: (file: File) => void;
  onForget: () => void;
  onRemovePdfCopy: () => void;
  onPin: () => void;
  selectionMode: boolean;
  selected: boolean;
  onSelect: () => void;
  collections: CollectionRecord[];
  tags: TagRecord[];
  onUpdateOrganization: (update: { collectionIds?: string[]; tagIds?: string[] }) => void;
  onScope: (scope: LibraryScope) => void;
}

function LibraryDocumentCard({
  document,
  editingTitle,
  titleDraft,
  isOpening,
  isForgetting,
  onStartEditing,
  onTitleDraftChange,
  onCommitTitle,
  onCancelTitle,
  onOpen,
  onOpenFile,
  onForget,
  onRemovePdfCopy,
  onPin,
  selectionMode,
  selected,
  onSelect,
  collections,
  tags,
  onUpdateOrganization,
  onScope,
}: LibraryDocumentCardProps) {
  return (
    <article
      className={`library-document ${selected ? 'is-selected' : ''}`}
      tabIndex={0}
      onClick={selectionMode ? onSelect : undefined}
      onKeyDown={(event) => {
        if (selectionMode && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="library-document-title-row">
        {selectionMode ? <input aria-label={`Select ${document.displayTitle}`} checked={selected} type="checkbox" onChange={onSelect} onClick={(event) => event.stopPropagation()} /> : null}
        {editingTitle ? (
          <input
            aria-label="Document title"
            autoFocus
            className="library-title-input"
            value={titleDraft}
            onBlur={onCommitTitle}
            onChange={(event) => onTitleDraftChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancelTitle();
              }
            }}
          />
        ) : (
          <h3>{document.displayTitle}</h3>
        )}
        <button
          aria-label="Rename document"
          className="library-rename-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onStartEditing();
          }}
        >
          Rename
        </button>
        <button aria-pressed={document.isPinned} className="library-rename-button" type="button" onClick={(event) => { event.stopPropagation(); onPin(); }}>
          {document.isPinned ? '● Pinned' : 'Pin'}
        </button>
      </div>
      {document.originalFileName !== document.displayTitle ? (
        <p className="library-original-file-name">{document.originalFileName}</p>
      ) : null}
      <div className="library-counts">
        <span className="library-count library-highlight-count">{document.highlightCount} Highlights</span>
        <span className="library-count library-underline-count">{document.underlineCount} Underlines</span>
        <span className="library-count library-note-count">{document.noteCount} Notes</span>
      </div>
      <div className="library-document-actions">
        <select aria-label="Add Collection" value="" onClick={(event) => event.stopPropagation()} onChange={(event) => { const id = event.target.value; if (id) onUpdateOrganization({ collectionIds: [...document.collectionIds, id] }); }}><option value="">Add Collection</option>{collections.filter((item) => !document.collectionIds.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="Add Tag" value="" onClick={(event) => event.stopPropagation()} onChange={(event) => { const id = event.target.value; if (id) onUpdateOrganization({ tagIds: [...document.tagIds, id] }); }}><option value="">Add Tag</option>{tags.filter((item) => !document.tagIds.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>
      {(document.collectionIds.length > 0 || document.tagIds.length > 0) ? <div className="library-counts" aria-label="Document organization">
        {collections.filter((item) => document.collectionIds.includes(item.id)).map((item) => <button className="library-scope-button" key={`scope-${item.id}`} type="button" onClick={(event) => { event.stopPropagation(); onScope({ type: 'collection', id: item.id }); }}>Collection: {item.name}</button>)}
        {tags.filter((item) => document.tagIds.includes(item.id)).map((item) => <button className="library-scope-button" key={`scope-${item.id}`} type="button" onClick={(event) => { event.stopPropagation(); onScope({ type: 'tag', id: item.id }); }}>Tag: {item.name}</button>)}
        {collections.filter((item) => document.collectionIds.includes(item.id)).map((item) => <span className="library-count" key={item.id}>Collection: {item.name}<button aria-label={`Remove ${item.name} collection`} type="button" onClick={(event) => { event.stopPropagation(); onUpdateOrganization({ collectionIds: document.collectionIds.filter((id) => id !== item.id) }); }}>×</button></span>)}
        {tags.filter((item) => document.tagIds.includes(item.id)).map((item) => <span className="library-count" key={item.id}>Tag: {item.name}<button aria-label={`Remove ${item.name} tag`} type="button" onClick={(event) => { event.stopPropagation(); onUpdateOrganization({ tagIds: document.tagIds.filter((id) => id !== item.id) }); }}>×</button></span>)}
      </div> : null}
      <time dateTime={toDateTime(document.updatedAt)}>Updated {formatUpdatedAt(document.updatedAt)}</time>
      {document.lastReadAt ? <time dateTime={toDateTime(document.lastReadAt)}>Last read {formatUpdatedAt(document.lastReadAt)}</time> : null}
      <p className="library-document-hint">
        {document.hasStoredPdf
          ? `Saved PDF copy: ${formatFileSize(document.pdfSize ?? 0)}.`
          : 'Select this PDF once from your device to enable direct reopening.'}
      </p>
      <div className="library-document-actions">
        {!document.hasStoredPdf ? (
          <label className="library-select-button" onClick={(event) => event.stopPropagation()}>
            Select PDF
            <input
              className="visually-hidden"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const [file] = Array.from(event.target.files ?? []);
                if (file) {
                  onOpenFile(file);
                }
                event.target.value = '';
              }}
            />
          </label>
        ) : (
          <button
            className="library-secondary-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemovePdfCopy();
            }}
          >
            Remove PDF copy
          </button>
        )}
        <button
          aria-label="Read Now"
          className="library-open-button library-read-now-button"
          disabled={!document.hasStoredPdf || isOpening}
          title={document.hasStoredPdf ? 'Read Now' : 'Select the PDF first'}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {isOpening ? 'Opening…' : 'Read Now'}
        </button>
        <button
          className="library-forget-button"
          disabled={isForgetting}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onForget();
          }}
        >
          {isForgetting ? 'Forgetting…' : 'Forget'}
        </button>
      </div>
    </article>
  );
}

interface LibraryNoteCardProps {
  result: LibraryNoteResult;
  isOpening: boolean;
  onOpen: () => void;
  onSelectPdf: (file: File) => void;
}

function LibraryNoteCard({ result, isOpening, onOpen, onSelectPdf }: LibraryNoteCardProps) {
  return (
    <article className={`library-note-result ${result.document.hasStoredPdf ? 'is-openable' : ''}`} onClick={result.document.hasStoredPdf ? onOpen : undefined}>
      <p className="library-note-document-title">{result.document.displayTitle}</p>
      <div className="library-note-result-meta">
        <span>Note {result.displayNumber}</span>
        <span>Page {result.pageNumber}</span>
      </div>
      <p className="library-note-excerpt">{createExcerpt(result.content, 150)}</p>
      <blockquote>{createExcerpt(result.selectedText, 120)}</blockquote>
      {result.document.hasStoredPdf ? (
        <button
          className="library-open-button"
          disabled={isOpening}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {isOpening ? 'Opening…' : 'Open Note'}
        </button>
      ) : (
        <label className="library-select-button" onClick={(event) => event.stopPropagation()}>
          Select PDF to open Note
          <input
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => {
              const [file] = Array.from(event.target.files ?? []);
              if (file) {
                onSelectPdf(file);
              }
              event.target.value = '';
            }}
          />
        </label>
      )}
    </article>
  );
}

function getSearchResults(documents: LibraryDocument[], query: string): {
  documents: LibraryDocument[];
  notes: LibraryNoteResult[];
} {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return { documents, notes: [] };
  }

  return {
    documents: documents.filter((document) => (
      document.displayTitle.toLocaleLowerCase().includes(normalizedQuery) ||
      document.originalFileName.toLocaleLowerCase().includes(normalizedQuery)
    )),
    notes: documents.flatMap((document) => document.notes.flatMap((note) => (
      note.content.toLocaleLowerCase().includes(normalizedQuery)
        ? [{
            document,
            noteId: note.id,
            annotationId: note.annotationId,
            displayNumber: note.displayNumber,
            content: note.content,
            pageNumber: note.pageNumber,
            selectedText: note.selectedText,
          }]
        : []
    ))),
  };
}

function createExcerpt(value: string, maximumLength: number): string {
  const normalizedValue = value.replaceAll(/\s+/g, ' ').trim();
  return normalizedValue.length > maximumLength
    ? `${normalizedValue.slice(0, maximumLength).trimEnd()}…`
    : normalizedValue;
}

function formatUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt);
  if (updatedAt <= 0 || Number.isNaN(date.valueOf())) {
    return 'unknown';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function toDateTime(updatedAt: number): string | undefined {
  const date = new Date(updatedAt);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPercentage(usage: number, quota: number): string {
  if (quota <= 0) {
    return '0%';
  }

  return `${Math.min(100, (usage / quota) * 100).toFixed(1)}%`;
}

function sortDocuments(documents: LibraryDocument[], mode: 'modified' | 'read' | 'title'): LibraryDocument[] {
  return [...documents].sort((first, second) => {
    if (first.isPinned !== second.isPinned) return first.isPinned ? -1 : 1;
    if (mode === 'title') return first.displayTitle.localeCompare(second.displayTitle);
    const firstValue = mode === 'read' ? first.lastReadAt ?? 0 : first.updatedAt;
    const secondValue = mode === 'read' ? second.lastReadAt ?? 0 : second.updatedAt;
    return secondValue - firstValue || first.displayTitle.localeCompare(second.displayTitle);
  });
}
