import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  getLibraryStorageSummary,
  listTags,
  listLibraryDocuments,
  type LibraryDocument,
  type LibraryStorageSummary,
} from '../services/annotationPersistence';
import type { TagRecord } from '../types/library';
import {
  getPaperGoogleDriveSyncCoordinator,
  type PaperActiveOperationType,
  type PaperSyncViewState,
} from '../sync/paperCoordinator.ts';
import type { PaperCloudSummary, PaperSyncState } from '../sync/paperTypes.ts';
import {
  getLibraryPaperDrivePresentation,
  getLibraryPaperDriveStatusIndicators,
  mergeLibraryBulkDriveRemovalProgress,
  planLibraryBulkDriveRemoval,
  selectCloudOnlyLibraryPapers,
  startLibraryBackgroundOperation,
  summarizeLibraryBulkDriveRemoval,
  type LibraryBulkDriveRemovalCandidate,
  type LibraryBulkDriveRemovalPlan,
  type LibraryBulkDriveRemovalProgress,
  type LibraryBulkDriveRemovalResult,
  type LibraryBulkDriveRemovalSkipReason,
} from './libraryCloudPresentation.ts';
import {
  downloadLibraryBackup,
  downloadSelectedPackage,
  inspectBackup,
  restoreBackup,
  type RestorePreview,
} from '../services/libraryBackup';
import {
  DOCUMENT_FILE_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  type DocumentType,
} from '../types/document';

const SUPPORTED_DOCUMENT_ACCEPT = [
  ...Object.values(DOCUMENT_MIME_TYPES),
  ...Object.values(DOCUMENT_FILE_EXTENSIONS),
].join(',');

export interface LibraryPanelProps {
  isOpen: boolean;
  presentation?: 'overlay' | 'embedded';
  refreshToken: number;
  onClose: () => void;
  onForget: (documentId: string) => Promise<boolean>;
  onOpenFile: (file: File) => void;
  onOpenStoredDocument: (documentId: string) => Promise<boolean>;
  onOpenLibraryNote: (
    documentId: string,
    noteId: string,
    annotationId: string,
    pageNumber: number,
  ) => Promise<boolean>;
  onSelectSourceForLibraryNote: (
    file: File,
    documentId: string,
    noteId: string,
    annotationId: string,
    pageNumber: number,
  ) => void;
  onRenameDocument: (documentId: string, displayTitle: string) => Promise<boolean>;
  onRemoveSourceCopy: (documentId: string) => Promise<boolean>;
  focusSearchRequestId: number;
  onPinDocument: (documentId: string, isPinned: boolean) => Promise<boolean>;
  onForgetMany: (
    documentIds: string[],
  ) => Promise<{ deleted: string[]; failed: string[] }>;
  onUpdateOrganization: (
    documentId: string,
    update: { tagIds?: string[] },
  ) => Promise<boolean>;
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

type LibraryScope = { type: 'all' } | { type: 'tag'; id: string };

interface LibraryWorkspaceSize {
  width: number;
  height: number;
}

interface LibraryBulkDriveRemovalFeedback {
  result: LibraryBulkDriveRemovalResult;
  skipped: LibraryBulkDriveRemovalPlan['skipped'];
  displayNames: Record<string, string>;
}

type LibraryCloudOperation = PaperActiveOperationType;
type LibraryCloudAction = Exclude<LibraryCloudOperation, 'keep-local'>;

function cloudOperationLabel(operation: LibraryCloudOperation): string {
  if (operation === 'download') return 'Downloading…';
  if (operation === 'upload') return 'Uploading…';
  if (operation === 'remove') return 'Removing from Google Drive…';
  if (operation === 'restore') return 'Restoring to Google Drive…';
  return 'Keeping local version…';
}

function readLibraryWorkspaceSize(): LibraryWorkspaceSize | null {
  const width = Number(sessionStorage.getItem('39note.library-width'));
  const height = Number(sessionStorage.getItem('39note.library-height'));
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 680 &&
    height >= 460
    ? { width, height }
    : null;
}

export function LibraryPanel({
  isOpen,
  refreshToken,
  onClose,
  onForget,
  onOpenFile,
  onOpenStoredDocument,
  onOpenLibraryNote,
  onSelectSourceForLibraryNote,
  onRenameDocument,
  onRemoveSourceCopy,
  focusSearchRequestId,
  onPinDocument,
  onForgetMany,
  onUpdateOrganization,
  presentation = 'overlay',
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
  const [isBatchForgetConfirmationOpen, setIsBatchForgetConfirmationOpen] =
    useState(false);
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [scope, setScope] = useState<LibraryScope>({ type: 'all' });
  const [pendingForgetDocument, setPendingForgetDocument] =
    useState<LibraryDocument | null>(null);
  const [pendingSourceRemoval, setPendingSourceRemoval] =
    useState<LibraryDocument | null>(null);
  const [removingSourceDocumentId, setRemovingSourceDocumentId] = useState<
    string | null
  >(null);
  const [backupProgress, setBackupProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [packageProgress, setPackageProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const [isInspectingBackup, setIsInspectingBackup] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [storageSummary, setStorageSummary] = useState<LibraryStorageSummary | null>(
    null,
  );
  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [workspaceSize, setWorkspaceSize] = useState<LibraryWorkspaceSize | null>(
    readLibraryWorkspaceSize,
  );
  const [isMaximized, setIsMaximized] = useState(false);
  const syncCoordinator = useMemo(() => getPaperGoogleDriveSyncCoordinator(), []);
  const [syncState, setSyncState] = useState<PaperSyncViewState>(() =>
    syncCoordinator.getSnapshot(),
  );
  const cloudOperations = useMemo<Record<string, LibraryCloudOperation>>(() => {
    const operations: Record<string, LibraryCloudOperation> = {};
    for (const operation of syncState.activePaperOperations) {
      for (const documentId of operation.documentIds) {
        // The first retained command is the one currently running or nearest the
        // front of FIFO ownership. Later commands remain disabled until it settles.
        operations[documentId] ??= operation.type;
      }
    }
    return operations;
  }, [syncState.activePaperOperations]);
  const [cloudActionNotice, setCloudActionNotice] = useState<string | null>(null);
  const [pendingDriveRemoval, setPendingDriveRemoval] = useState<{
    documentId: string;
    displayName: string;
    hasLocalCopy: boolean;
  } | null>(null);
  const [pendingBulkDriveRemoval, setPendingBulkDriveRemoval] =
    useState<LibraryBulkDriveRemovalPlan | null>(null);
  const [bulkDriveRemovalProgress, setBulkDriveRemovalProgress] =
    useState<LibraryBulkDriveRemovalProgress | null>(null);
  const [bulkDriveRemovalFeedback, setBulkDriveRemovalFeedback] =
    useState<LibraryBulkDriveRemovalFeedback | null>(null);
  const [isBulkDriveRemovalRunning, setIsBulkDriveRemovalRunning] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const importDocumentInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const visibleDocuments = useMemo(
    () =>
      sortDocuments(
        documents.filter((document) => {
          const matchesView =
            libraryView === 'all' ||
            (libraryView === 'pinned'
              ? document.isPinned
              : Boolean(document.lastReadAt));
          const matchesScope =
            scope.type === 'all' ||
            (scope.type === 'tag' && document.tagIds.includes(scope.id));

          return matchesView && matchesScope;
        }),
        sortMode,
      ),
    [documents, libraryView, scope, sortMode],
  );
  const searchResults = useMemo(
    () => getSearchResults(visibleDocuments, searchQuery),
    [visibleDocuments, searchQuery],
  );
  const localDocumentIds = useMemo(
    () => new Set(documents.map((document) => document.documentId)),
    [documents],
  );
  const cloudOnlyPapers = useMemo(() => {
    return selectCloudOnlyLibraryPapers(syncState.papers, localDocumentIds, {
      includeCloudOnly: libraryView === 'all' && scope.type === 'all',
      query: searchQuery,
    });
  }, [libraryView, localDocumentIds, scope.type, searchQuery, syncState.papers]);
  const cloudByDocumentId = useMemo(
    () => new Map(syncState.papers.map((paper) => [paper.documentId, paper])),
    [syncState.papers],
  );
  const syncByDocumentId = useMemo(
    () => new Map(syncState.paperStates.map((paper) => [paper.documentId, paper])),
    [syncState.paperStates],
  );
  const bulkDriveRemovalCandidates = useMemo<LibraryBulkDriveRemovalCandidate[]>(() => {
    const candidates = new Map<string, LibraryBulkDriveRemovalCandidate>();
    for (const document of documents) {
      candidates.set(document.documentId, {
        documentId: document.documentId,
        displayName: document.displayTitle,
        hasLocalCopy: true,
        cloudPaper: cloudByDocumentId.get(document.documentId),
        syncPaper: syncByDocumentId.get(document.documentId),
      });
    }
    for (const paper of syncState.papers) {
      if (candidates.has(paper.documentId)) continue;
      candidates.set(paper.documentId, {
        documentId: paper.documentId,
        displayName: paper.displayName,
        hasLocalCopy: false,
        cloudPaper: paper,
        syncPaper: syncByDocumentId.get(paper.documentId),
      });
    }
    return [...candidates.values()];
  }, [cloudByDocumentId, documents, syncByDocumentId, syncState.papers]);
  const selectedLocalDocumentIds = useMemo(
    () => selectedDocumentIds.filter((documentId) => localDocumentIds.has(documentId)),
    [localDocumentIds, selectedDocumentIds],
  );
  const bulkDriveRemovalPlan = useMemo(
    () =>
      planLibraryBulkDriveRemoval(
        selectedDocumentIds,
        bulkDriveRemovalCandidates,
        syncState.deviceMode,
      ),
    [bulkDriveRemovalCandidates, selectedDocumentIds, syncState.deviceMode],
  );
  const hasActiveBulkDriveRemoval = bulkDriveRemovalPlan.eligible.some(
    ({ documentId }) => cloudOperations[documentId] === 'remove',
  );
  const visibleSelectableDocumentIds = useMemo(
    () => [
      ...new Set([
        ...searchResults.documents.map((document) => document.documentId),
        ...cloudOnlyPapers.map((paper) => paper.documentId),
      ]),
    ],
    [cloudOnlyPapers, searchResults.documents],
  );

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
    void listTags().then((nextTags) => {
      if (!isDisposed) {
        setTags(nextTags);
      }
    });

    return () => {
      isDisposed = true;
    };
  }, [isOpen, refreshToken]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const unsubscribe = syncCoordinator.subscribe(setSyncState);
    void syncCoordinator.initialize().catch(() => undefined);
    return unsubscribe;
  }, [isOpen, syncCoordinator]);

  useEffect(() => {
    if (isOpen && focusSearchRequestId > 0) {
      searchInputRef.current?.focus();
    }
  }, [focusSearchRequestId, isOpen]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!isOpen || !panel || isMaximized || presentation === 'embedded')
      return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width >= 680 && height >= 460) {
        const nextSize = { width: Math.round(width), height: Math.round(height) };
        setWorkspaceSize((currentSize) =>
          currentSize?.width === nextSize.width &&
          currentSize.height === nextSize.height
            ? currentSize
            : nextSize,
        );
        sessionStorage.setItem('39note.library-width', String(nextSize.width));
        sessionStorage.setItem('39note.library-height', String(nextSize.height));
      }
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [isMaximized, isOpen, presentation]);

  useEffect(() => {
    if (scope.type === 'tag' && !tags.some((tag) => tag.id === scope.id)) {
      setScope({ type: 'all' });
    }
  }, [scope, tags]);

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
      await downloadLibraryBackup((completed, total) =>
        setBackupProgress({ completed, total }),
      );
    } catch {
      setError('The Library backup could not be created. Please try again.');
    } finally {
      setBackupProgress(null);
    }
  };

  const packageSelectedDocuments = async () => {
    setError(null);
    setPackageProgress({ completed: 0, total: selectedLocalDocumentIds.length });
    try {
      await downloadSelectedPackage(selectedLocalDocumentIds, (completed, total) =>
        setPackageProgress({ completed, total }),
      );
    } catch (packageError) {
      setError(
        packageError instanceof Error
          ? packageError.message
          : 'The selected documents could not be packaged.',
      );
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
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : 'This backup could not be read.',
      );
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
      setError(
        `${result.imported} document${result.imported === 1 ? '' : 's'} restored; ${result.failed} could not be restored.`,
      );
    }
    await refreshLibrary();
  };

  const removeSourceCopy = async (document: LibraryDocument) => {
    setRemovingSourceDocumentId(document.documentId);
    setError(null);
    const wasRemoved = await onRemoveSourceCopy(document.documentId);
    setRemovingSourceDocumentId(null);
    setPendingSourceRemoval(null);
    if (wasRemoved) {
      await refreshLibrary();
    } else {
      setError('The saved source copy could not be removed. Please try again.');
    }
  };

  const toggleStorage = async () => {
    const nextIsOpen = !isStorageOpen;
    setIsStorageOpen(nextIsOpen);
    if (nextIsOpen) {
      setStorageSummary(await getLibraryStorageSummary());
    }
  };

  const runCloudAction = async (documentId: string, action: LibraryCloudAction) => {
    setError(null);
    setCloudActionNotice(null);
    try {
      if (action === 'download') {
        const operation = syncCoordinator.downloadSelected([documentId]);
        await operation;
        await refreshLibrary();
      } else if (action === 'upload') {
        await syncCoordinator.uploadSelected([documentId]);
      } else if (action === 'restore') {
        const restoreMode = await syncCoordinator.restoreToGoogleDrive(documentId);
        setCloudActionNotice(
          restoreMode === 'fast-untrash'
            ? 'Restored the original verified Google Drive folder.'
            : 'Restored by safely rebuilding the paper because the original Drive folder could not be reused.',
        );
      } else {
        const operation = startLibraryBackgroundOperation(
          () => syncCoordinator.removeFromGoogleDrive(documentId),
          () => setPendingDriveRemoval(null),
        );
        await operation;
      }
    } catch (cloudError) {
      setError(
        cloudError instanceof Error
          ? cloudError.message
          : 'The Google Drive action could not be completed.',
      );
    }
  };

  const runBulkDriveRemoval = async () => {
    const plan = pendingBulkDriveRemoval;
    if (
      !plan ||
      plan.eligible.length === 0 ||
      isBulkDriveRemovalRunning ||
      plan.eligible.some(({ documentId }) => cloudOperations[documentId] === 'remove')
    ) {
      return;
    }
    const documentIds = plan.eligible.map(({ documentId }) => documentId);
    const displayNames = Object.fromEntries(
      [...plan.eligible, ...plan.skipped].map(({ documentId, displayName }) => [
        documentId,
        displayName,
      ]),
    );
    setIsBulkDriveRemovalRunning(true);
    setBulkDriveRemovalFeedback(null);
    setBulkDriveRemovalProgress({ completed: 0, total: documentIds.length });
    setError(null);
    try {
      const operation = startLibraryBackgroundOperation(
        () =>
          syncCoordinator.removeFromGoogleDriveSelected(documentIds, (progress) =>
            setBulkDriveRemovalProgress((current) =>
              mergeLibraryBulkDriveRemovalProgress(current, progress),
            ),
          ),
        () => setPendingBulkDriveRemoval(null),
      );
      const result = await operation;
      const completed = new Set([...result.removed, ...result.alreadyRemoved]);
      setSelectedDocumentIds((current) =>
        current.filter((documentId) => !completed.has(documentId)),
      );
      setBulkDriveRemovalFeedback({ result, skipped: plan.skipped, displayNames });
    } catch (cloudError) {
      setError(
        cloudError instanceof Error
          ? cloudError.message
          : 'The selected Google Drive papers could not be removed.',
      );
    } finally {
      setIsBulkDriveRemovalRunning(false);
      setBulkDriveRemovalProgress(null);
    }
  };

  if (!isOpen) {
    return null;
  }

  const forgetDocument = async (document: LibraryDocument) => {
    setForgettingDocumentId(document.documentId);
    setError(null);
    try {
      const wasForgotten = await onForget(document.documentId);
      if (wasForgotten) {
        setDocuments((currentDocuments) =>
          currentDocuments.filter(
            (candidate) => candidate.documentId !== document.documentId,
          ),
        );
      } else {
        setError('The document could not be forgotten. Please try again.');
      }
    } catch (forgetError) {
      setError(
        forgetError instanceof Error
          ? forgetError.message
          : 'The document could not be forgotten. Please try again.',
      );
    } finally {
      setForgettingDocumentId(null);
      setPendingForgetDocument(null);
    }
  };

  const forgetSelectedDocuments = async () => {
    setIsBatchForgetting(true);
    setError(null);
    try {
      const result = await onForgetMany(selectedLocalDocumentIds);
      setSelectedDocumentIds([]);
      if (result.failed.length) {
        setError(`${result.failed.length} documents could not be forgotten.`);
      }
      await refreshLibrary();
    } catch (forgetError) {
      setError(
        forgetError instanceof Error
          ? forgetError.message
          : 'The selected documents could not be forgotten. Please try again.',
      );
    } finally {
      setIsBatchForgetting(false);
      setIsBatchForgetConfirmationOpen(false);
    }
  };

  const openStoredDocument = async (documentId: string) => {
    setOpeningDocumentId(documentId);
    setError(null);
    const wasOpened = await onOpenStoredDocument(documentId);
    setOpeningDocumentId(null);

    if (!wasOpened) {
      setError(
        'The saved source copy could not be opened. You can select the document again.',
      );
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

    if (!wasOpened && result.document.hasStoredSource) {
      setError(
        'The saved source copy could not be opened. You can select the document again.',
      );
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
      setDocuments((currentDocuments) =>
        currentDocuments.map((candidate) =>
          candidate.documentId === document.documentId
            ? { ...candidate, displayTitle }
            : candidate,
        ),
      );
      setEditingDocumentId(null);
    } else {
      setError('The document title could not be updated. Please try again.');
    }
  };

  const isSearching = searchQuery.trim().length > 0;
  const activeScopeName =
    scope.type === 'tag' ? tags.find((tag) => tag.id === scope.id)?.name : null;
  const hasActiveScope = scope.type !== 'all' || libraryView !== 'all';
  const applyScope = (nextScope: LibraryScope) => {
    setScope(nextScope);
    setSearchQuery('');
  };

  return (
    <section
      ref={panelRef}
      className={`library-panel ${presentation === 'embedded' ? 'is-embedded' : ''} ${isMaximized ? 'is-maximized' : ''}`}
      aria-label="Library"
      style={
        presentation === 'overlay' && workspaceSize && !isMaximized
          ? ({
              width: `${workspaceSize.width}px`,
              height: `${workspaceSize.height}px`,
            } as CSSProperties)
          : undefined
      }
    >
      <header className="library-panel-header">
        <div>
          <p>Library</p>
          <h2>Saved documents</h2>
        </div>
        <div className="library-panel-header-actions">
          <button
            className="library-import-button"
            type="button"
            onClick={() => importDocumentInputRef.current?.click()}
          >
            Import PDF or convert Office
          </button>
          <input
            ref={importDocumentInputRef}
            accept={SUPPORTED_DOCUMENT_ACCEPT}
            className="visually-hidden"
            type="file"
            onChange={(event) => {
              const [selectedFile] = Array.from(event.target.files ?? []);
              if (selectedFile) onOpenFile(selectedFile);
              event.target.value = '';
            }}
          />
          {presentation === 'overlay' ? (
            <>
              <button
                aria-label={isMaximized ? 'Restore Library size' : 'Maximize Library'}
                className="library-header-icon-button"
                title={isMaximized ? 'Restore Library size' : 'Maximize Library'}
                type="button"
                onClick={() => setIsMaximized((maximized) => !maximized)}
              >
                {isMaximized ? '↙' : '↗'}
              </button>
              <button
                aria-label="Return to Reader"
                className="library-header-icon-button"
                title="Return to Reader"
                type="button"
                onClick={onClose}
              >
                ×
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="library-panel-content">
        <p className="library-description">
          Your local papers and verified Google Drive papers appear together here. Word
          and PowerPoint files are converted locally to PDF before they are added.
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
          <section
            className="library-storage-summary"
            aria-label="Library storage summary"
          >
            <strong>Local storage</strong>
            <span>{storageSummary.documentCount} documents</span>
            <span>
              {storageSummary.storedSourceCount} source copies ·{' '}
              {formatFileSize(storageSummary.storedSourceBytes)}
            </span>
            <span>
              {storageSummary.annotationCount} annotations · {storageSummary.noteCount}{' '}
              notes
            </span>
            {storageSummary.estimatedUsageBytes !== null ? (
              <span>
                Approx. browser storage used:{' '}
                {formatFileSize(storageSummary.estimatedUsageBytes)}
                {storageSummary.estimatedQuotaBytes !== null
                  ? ` of ${formatFileSize(storageSummary.estimatedQuotaBytes)} (${formatPercentage(storageSummary.estimatedUsageBytes, storageSummary.estimatedQuotaBytes)})`
                  : ''}
              </span>
            ) : (
              <span>Browser quota estimate is unavailable.</span>
            )}
            <p className="library-storage-location">
              This Library belongs to this website origin. Another browser or website
              domain has a separate Library. Back up your Library before clearing
              browser data.
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
        <div
          className="library-backup-actions library-scope-controls"
          aria-label="Library views"
        >
          <button
            aria-pressed={libraryView === 'all'}
            type="button"
            onClick={() => setLibraryView('all')}
          >
            All
          </button>
          <button
            aria-pressed={libraryView === 'recent'}
            type="button"
            onClick={() => setLibraryView('recent')}
          >
            Recent
          </button>
          <button
            aria-pressed={libraryView === 'pinned'}
            data-library-scope="pinned"
            type="button"
            onClick={() => setLibraryView('pinned')}
          >
            Pinned
          </button>
          <select
            aria-label="Sort Library"
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as typeof sortMode)}
          >
            <option value="modified">Recently modified</option>
            <option value="read">Recently read</option>
            <option value="title">Title A–Z</option>
          </select>
          <button
            type="button"
            onClick={() => {
              setIsSelectionMode((enabled) => !enabled);
              setSelectedDocumentIds([]);
            }}
          >
            {isSelectionMode ? 'Done selecting' : 'Select'}
          </button>
        </div>
        <div className="library-scope-row">
          <div className="library-scope-list" aria-label="Browse Library by Tag">
            <span>Browse:</span>
            {hasActiveScope ? (
              <strong>
                {activeScopeName ??
                  (libraryView === 'recent'
                    ? 'Recent'
                    : libraryView === 'pinned'
                      ? 'Pinned'
                      : 'All documents')}
              </strong>
            ) : null}
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
            <button
              className="library-clear-scope"
              type="button"
              onClick={() => {
                applyScope({ type: 'all' });
                setLibraryView('all');
              }}
            >
              Clear Scope
            </button>
          ) : null}
        </div>
        {isSelectionMode ? (
          <div className="library-backup-actions library-selection-actions">
            <button
              type="button"
              onClick={() => setSelectedDocumentIds(visibleSelectableDocumentIds)}
            >
              Select all
            </button>
            <button type="button" onClick={() => setSelectedDocumentIds([])}>
              Clear
            </button>
            <button
              disabled={
                selectedLocalDocumentIds.length === 0 || packageProgress !== null
              }
              type="button"
              onClick={() => void packageSelectedDocuments()}
            >
              {packageProgress
                ? `Packaging ${packageProgress.completed}/${packageProgress.total}`
                : selectedLocalDocumentIds.length === 0
                  ? 'Package Selected'
                  : `Package ${selectedLocalDocumentIds.length} Document${selectedLocalDocumentIds.length === 1 ? '' : 's'}`}
            </button>
            <button
              disabled={selectedLocalDocumentIds.length === 0 || isBatchForgetting}
              className="library-forget-button"
              type="button"
              onClick={() => setIsBatchForgetConfirmationOpen(true)}
            >
              {isBatchForgetting
                ? 'Removing…'
                : `Remove ${selectedLocalDocumentIds.length} from this device`}
            </button>
            <button
              className="library-forget-button"
              disabled={
                bulkDriveRemovalPlan.eligible.length === 0 ||
                isBulkDriveRemovalRunning ||
                hasActiveBulkDriveRemoval
              }
              type="button"
              onClick={() => setPendingBulkDriveRemoval(bulkDriveRemovalPlan)}
            >
              {isBulkDriveRemovalRunning || hasActiveBulkDriveRemoval
                ? bulkDriveRemovalProgress
                  ? `Removing ${bulkDriveRemovalProgress.completed}/${bulkDriveRemovalProgress.total}…`
                  : 'Removing from Google Drive…'
                : `Remove ${bulkDriveRemovalPlan.eligible.length} from Google Drive`}
            </button>
            {selectedDocumentIds.length > 0 ? (
              <span role="status">
                {bulkDriveRemovalPlan.eligible.length} Drive eligible ·{' '}
                {bulkDriveRemovalPlan.skipped.length} skipped
              </span>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="library-error" role="status">
            {error}
          </p>
        ) : null}
        {cloudActionNotice ? (
          <p className="sync-success" role="status">
            {cloudActionNotice}
          </p>
        ) : null}
        {bulkDriveRemovalFeedback ? (
          <section className="library-cloud-state" aria-label="Drive removal result">
            <strong>
              {summarizeLibraryBulkDriveRemoval(bulkDriveRemovalFeedback.result)}
            </strong>
            {bulkDriveRemovalFeedback.result.cleanupPending.length > 0 ? (
              <span>
                {bulkDriveRemovalFeedback.result.cleanupPending.length} Drive cleanup{' '}
                {bulkDriveRemovalFeedback.result.cleanupPending.length === 1
                  ? 'is'
                  : 'items are'}{' '}
                pending.
              </span>
            ) : null}
            {bulkDriveRemovalFeedback.result.failed.length > 0 ||
            bulkDriveRemovalFeedback.skipped.length > 0 ? (
              <details>
                <summary>Review failures and skipped papers</summary>
                <ul>
                  {bulkDriveRemovalFeedback.result.failed.map((failure) => (
                    <li key={`failed:${failure.documentId}`}>
                      {bulkDriveRemovalFeedback.displayNames[failure.documentId] ??
                        failure.documentId}
                      : {failure.message}
                    </li>
                  ))}
                  {bulkDriveRemovalFeedback.skipped.map((paper) => (
                    <li key={`skipped:${paper.documentId}`}>
                      {paper.displayName}:{' '}
                      {bulkDriveRemovalSkipReasonLabel(paper.reason)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}
        {isLoading ? <p className="library-empty">Loading saved documents…</p> : null}
        {!isLoading && documents.length === 0 && cloudOnlyPapers.length === 0 ? (
          <p className="library-empty">No saved documents yet.</p>
        ) : null}
        {!isLoading &&
        (documents.length > 0 || cloudOnlyPapers.length > 0) &&
        searchResults.documents.length === 0 &&
        cloudOnlyPapers.length === 0 &&
        searchResults.notes.length === 0 ? (
          <p className="library-empty">No saved documents match this search.</p>
        ) : null}
        {searchResults.documents.length > 0 || cloudOnlyPapers.length > 0 ? (
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
                onOpen={() => void openStoredDocument(document.documentId)}
                onOpenFile={onOpenFile}
                onForget={() => setPendingForgetDocument(document)}
                onRemoveSourceCopy={() => setPendingSourceRemoval(document)}
                onPin={() =>
                  void onPinDocument(document.documentId, !document.isPinned).then(
                    (updated) => {
                      if (updated) void refreshLibrary();
                    },
                  )
                }
                selectionMode={isSelectionMode}
                selected={selectedDocumentIds.includes(document.documentId)}
                onSelect={() =>
                  setSelectedDocumentIds((ids) =>
                    ids.includes(document.documentId)
                      ? ids.filter((id) => id !== document.documentId)
                      : [...ids, document.documentId],
                  )
                }
                tags={tags}
                onUpdateOrganization={(update) =>
                  void onUpdateOrganization(document.documentId, update).then(
                    (updated) => {
                      if (updated) void refreshLibrary();
                    },
                  )
                }
                onScope={applyScope}
                cloudPaper={cloudByDocumentId.get(document.documentId)}
                syncPaper={syncByDocumentId.get(document.documentId)}
                cloudOperation={cloudOperations[document.documentId]}
                syncBusy={
                  Boolean(cloudOperations[document.documentId]) ||
                  ['downloading', 'uploading'].includes(
                    syncByDocumentId.get(document.documentId)?.status ?? '',
                  )
                }
                cloudMutationAllowed={syncState.deviceMode === 'personal'}
                onUploadToDrive={() =>
                  void runCloudAction(document.documentId, 'upload')
                }
                onRestoreToDrive={() =>
                  void runCloudAction(document.documentId, 'restore')
                }
                onRemoveFromDrive={() =>
                  setPendingDriveRemoval({
                    documentId: document.documentId,
                    displayName: document.displayTitle,
                    hasLocalCopy: true,
                  })
                }
              />
            ))}
            {cloudOnlyPapers.map((paper) => (
              <CloudOnlyPaperCard
                key={paper.documentId}
                paper={paper}
                selectionMode={isSelectionMode}
                selected={selectedDocumentIds.includes(paper.documentId)}
                onSelect={() =>
                  setSelectedDocumentIds((ids) =>
                    ids.includes(paper.documentId)
                      ? ids.filter((id) => id !== paper.documentId)
                      : [...ids, paper.documentId],
                  )
                }
                operation={cloudOperations[paper.documentId]}
                busy={Boolean(cloudOperations[paper.documentId])}
                cloudRemovalAllowed={syncState.deviceMode === 'personal'}
                onDownload={() => void runCloudAction(paper.documentId, 'download')}
                onRemove={() =>
                  setPendingDriveRemoval({
                    documentId: paper.documentId,
                    displayName: paper.displayName,
                    hasLocalCopy: false,
                  })
                }
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
                onSelectSource={(file) =>
                  onSelectSourceForLibraryNote(
                    file,
                    result.document.documentId,
                    result.noteId,
                    result.annotationId,
                    result.pageNumber,
                  )
                }
              />
            ))}
          </section>
        ) : null}
      </div>
      {pendingForgetDocument ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            className="library-confirm-dialog"
            aria-modal="true"
            aria-label="Forget document"
            role="dialog"
          >
            <h3>Remove from this device?</h3>
            <p>
              This removes the saved source copy, annotations, and Notes from 39Note.
              The original document on your computer is not deleted.
            </p>
            <div>
              {forgettingDocumentId !== pendingForgetDocument.documentId ? (
                <button type="button" onClick={() => setPendingForgetDocument(null)}>
                  Cancel
                </button>
              ) : null}
              <button
                className="library-forget-button"
                disabled={forgettingDocumentId === pendingForgetDocument.documentId}
                type="button"
                onClick={() => void forgetDocument(pendingForgetDocument)}
              >
                {forgettingDocumentId === pendingForgetDocument.documentId
                  ? 'Removing…'
                  : 'Remove from this device'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {isBatchForgetConfirmationOpen ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            className="library-confirm-dialog"
            aria-modal="true"
            aria-label="Forget selected documents"
            role="dialog"
          >
            <h3>Remove {selectedLocalDocumentIds.length} from this device?</h3>
            <p>
              This removes their saved source copies, annotations, and Notes from
              39Note. Original documents on your computer are not deleted.
            </p>
            <div>
              {!isBatchForgetting ? (
                <button
                  type="button"
                  onClick={() => setIsBatchForgetConfirmationOpen(false)}
                >
                  Cancel
                </button>
              ) : null}
              <button
                className="library-forget-button"
                disabled={isBatchForgetting}
                type="button"
                onClick={() => void forgetSelectedDocuments()}
              >
                {isBatchForgetting ? 'Removing…' : 'Remove from this device'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {pendingBulkDriveRemoval ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            aria-label="Remove selected papers from Google Drive"
            aria-modal="true"
            className="library-confirm-dialog"
            role="dialog"
          >
            <h3>
              Remove {pendingBulkDriveRemoval.eligible.length}{' '}
              {pendingBulkDriveRemoval.eligible.length === 1 ? 'paper' : 'papers'} from
              Google Drive?
            </h3>
            <p>
              Local copies on this device are kept where present. Verified cloud folders
              are moved to Google Drive Trash, and ordinary sync will not restore them
              automatically. Explicit Restore is required.
            </p>
            {pendingBulkDriveRemoval.skipped.length > 0 ? (
              <p>
                {pendingBulkDriveRemoval.skipped.length} selected{' '}
                {pendingBulkDriveRemoval.skipped.length === 1
                  ? 'paper is'
                  : 'papers are'}{' '}
                ineligible and will be skipped.
              </p>
            ) : null}
            <div>
              <button type="button" onClick={() => setPendingBulkDriveRemoval(null)}>
                Cancel
              </button>
              <button
                className="library-forget-button"
                type="button"
                onClick={() => void runBulkDriveRemoval()}
              >
                Remove from Google Drive
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {pendingDriveRemoval ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            aria-label="Remove paper from Google Drive"
            aria-modal="true"
            className="library-confirm-dialog"
            role="dialog"
          >
            <h3>Remove from Google Drive?</h3>
            <p>
              {pendingDriveRemoval.hasLocalCopy
                ? `${pendingDriveRemoval.displayName} will stay on this device with its source document, annotations, Notes, Glossary, reading state, Collections, Tags, and Print Draft.`
                : `${pendingDriveRemoval.displayName} will be removed from the active Drive library on every compatible device.`}
            </p>
            <p>The verified paper folder will be moved to Google Drive Trash.</p>
            <div>
              <button type="button" onClick={() => setPendingDriveRemoval(null)}>
                Cancel
              </button>
              <button
                className="library-forget-button"
                type="button"
                onClick={() =>
                  void runCloudAction(pendingDriveRemoval.documentId, 'remove')
                }
              >
                Remove from Google Drive
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {pendingSourceRemoval ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            className="library-confirm-dialog"
            aria-modal="true"
            aria-label="Remove saved source copy"
            role="dialog"
          >
            <h3>Remove the saved source copy?</h3>
            <p>
              The {formatDocumentTypeLabel(pendingSourceRemoval.documentType)} bytes
              will be removed from 39Note, but its highlights and Notes stay in the
              Library. The original document on your computer is not deleted.
            </p>
            <div>
              <button type="button" onClick={() => setPendingSourceRemoval(null)}>
                Cancel
              </button>
              <button
                className="library-forget-button"
                disabled={removingSourceDocumentId === pendingSourceRemoval.documentId}
                type="button"
                onClick={() => void removeSourceCopy(pendingSourceRemoval)}
              >
                {removingSourceDocumentId === pendingSourceRemoval.documentId
                  ? 'Removing...'
                  : 'Remove source copy'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {restorePreview ? (
        <div className="library-confirm-overlay" role="presentation">
          <section
            className="library-confirm-dialog library-restore-dialog"
            aria-modal="true"
            aria-label="Restore Library backup"
            role="dialog"
          >
            <h3>Restore Library backup</h3>
            <p>
              {restorePreview.documents.length} documents, {restorePreview.sourceCount}{' '}
              source copies, {restorePreview.highlightCount} highlights,{' '}
              {restorePreview.underlineCount} underlines, and {restorePreview.noteCount}{' '}
              Notes are ready to restore.
            </p>
            <p>Created {formatUpdatedAt(restorePreview.manifest.createdAt)}.</p>
            {restorePreview.conflictCount > 0 ? (
              <p>
                {restorePreview.conflictCount} document
                {restorePreview.conflictCount === 1 ? '' : 's'} already exist
                {restorePreview.conflictCount === 1 ? 's' : ''} in this Library.
              </p>
            ) : null}
            <div>
              <button
                disabled={isRestoring}
                type="button"
                onClick={() => setRestorePreview(null)}
              >
                Cancel
              </button>
              <button
                disabled={isRestoring}
                type="button"
                onClick={() => void restorePreviewDocuments(false)}
              >
                {isRestoring
                  ? 'Restoring...'
                  : restorePreview.conflictCount > 0
                    ? 'Keep existing'
                    : 'Restore'}
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
  onRemoveSourceCopy: () => void;
  onPin: () => void;
  selectionMode: boolean;
  selected: boolean;
  onSelect: () => void;
  tags: TagRecord[];
  onUpdateOrganization: (update: { tagIds?: string[] }) => void;
  onScope: (scope: LibraryScope) => void;
  cloudPaper?: PaperCloudSummary;
  syncPaper?: PaperSyncState;
  cloudOperation?: LibraryCloudOperation;
  syncBusy: boolean;
  cloudMutationAllowed: boolean;
  onUploadToDrive: () => void;
  onRestoreToDrive: () => void;
  onRemoveFromDrive: () => void;
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
  onRemoveSourceCopy,
  onPin,
  selectionMode,
  selected,
  onSelect,
  tags,
  onUpdateOrganization,
  onScope,
  cloudPaper,
  syncPaper,
  cloudOperation,
  syncBusy,
  cloudMutationAllowed,
  onUploadToDrive,
  onRestoreToDrive,
  onRemoveFromDrive,
}: LibraryDocumentCardProps) {
  const drivePresentation = getLibraryPaperDrivePresentation(cloudPaper, syncPaper);
  const {
    removedFromDrive,
    hasCloudCopy,
    needsAttention: cloudNeedsAttention,
  } = drivePresentation;
  const isPdfDocument = document.documentType === 'pdf';
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
        {selectionMode ? (
          <input
            aria-label={`Select ${document.displayTitle}`}
            checked={selected}
            type="checkbox"
            onChange={onSelect}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
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
        <span
          aria-label={`Document type: ${formatDocumentTypeLabel(document.documentType)}`}
          className="library-count"
        >
          {formatDocumentTypeLabel(document.documentType)}
        </span>
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
        <button
          aria-pressed={document.isPinned}
          className="library-rename-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onPin();
          }}
        >
          {document.isPinned ? '● Pinned' : 'Pin'}
        </button>
      </div>
      {document.originalFileName !== document.displayTitle ? (
        <p className="library-original-file-name">{document.originalFileName}</p>
      ) : null}
      <LibraryPaperDriveStatus
        cloudOperation={cloudOperation}
        presentation={drivePresentation}
      />
      <div className="library-counts">
        <span className="library-count library-highlight-count">
          {document.highlightCount} Highlights
        </span>
        <span className="library-count library-underline-count">
          {document.underlineCount} Underlines
        </span>
        <span className="library-count library-note-count">
          {document.noteCount} Notes
        </span>
      </div>
      <div className="library-document-actions">
        <select
          aria-label="Add Tag"
          value=""
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const id = event.target.value;
            if (id) onUpdateOrganization({ tagIds: [...document.tagIds, id] });
          }}
        >
          <option value="">Add Tag</option>
          {tags
            .filter((item) => !document.tagIds.includes(item.id))
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      </div>
      {document.tagIds.length > 0 ? (
        <div className="library-counts" aria-label="Document organization">
          {tags
            .filter((item) => document.tagIds.includes(item.id))
            .map((item) => (
              <button
                className="library-scope-button"
                key={`scope-${item.id}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onScope({ type: 'tag', id: item.id });
                }}
              >
                Tag: {item.name}
              </button>
            ))}
          {tags
            .filter((item) => document.tagIds.includes(item.id))
            .map((item) => (
              <span className="library-count" key={item.id}>
                Tag: {item.name}
                <button
                  aria-label={`Remove ${item.name} tag`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUpdateOrganization({
                      tagIds: document.tagIds.filter((id) => id !== item.id),
                    });
                  }}
                >
                  ×
                </button>
              </span>
            ))}
        </div>
      ) : null}
      <time dateTime={toDateTime(document.updatedAt)}>
        Updated {formatUpdatedAt(document.updatedAt)}
      </time>
      {document.lastReadAt ? (
        <time dateTime={toDateTime(document.lastReadAt)}>
          Last read {formatUpdatedAt(document.lastReadAt)}
        </time>
      ) : null}
      <p className="library-document-hint">
        {isPdfDocument
          ? document.hasStoredSource
            ? `Saved PDF source: ${formatFileSize(document.sourceSize ?? 0)}.`
            : 'Select this PDF once from your device to enable direct reopening.'
          : 'Experimental Office-native record preserved for compatibility. It is not treated as a readable 39Note paper.'}
      </p>
      {!isPdfDocument ? (
        <p className="library-compatibility-warning" role="note">
          Direct {formatDocumentTypeLabel(document.documentType)} reading and upload are
          disabled. Import the original file again and 39Note will convert it to a
          separate PDF paper; this record will not be changed automatically.
        </p>
      ) : null}
      <div className="library-document-actions">
        {removedFromDrive ? (
          <button
            disabled={syncBusy || !cloudMutationAllowed || selectionMode}
            title={
              cloudMutationAllowed
                ? undefined
                : 'Drive restore is available only on a Personal device.'
            }
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRestoreToDrive();
            }}
          >
            {cloudOperation === 'restore' ? 'Restoring…' : 'Restore to Google Drive'}
          </button>
        ) : hasCloudCopy ? (
          <button
            disabled={
              syncBusy || !cloudMutationAllowed || cloudNeedsAttention || selectionMode
            }
            title={
              !cloudMutationAllowed
                ? 'Drive removal is available only on a Personal device.'
                : cloudNeedsAttention
                  ? 'Resolve Drive verification before removing this paper.'
                  : undefined
            }
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveFromDrive();
            }}
          >
            {cloudOperation === 'remove' ? 'Removing…' : 'Remove from Google Drive'}
          </button>
        ) : isPdfDocument ? (
          <button
            disabled={syncBusy || selectionMode}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onUploadToDrive();
            }}
          >
            {cloudOperation === 'upload' ? 'Uploading…' : 'Upload to Google Drive'}
          </button>
        ) : (
          <span className="library-compatibility-action">
            Office-native Drive upload unavailable
          </span>
        )}
        {isPdfDocument && !document.hasStoredSource ? (
          <label
            className="library-select-button"
            onClick={(event) => event.stopPropagation()}
          >
            Select PDF
            <input
              className="visually-hidden"
              type="file"
              accept={getDocumentAccept('pdf')}
              onChange={(event) => {
                const [file] = Array.from(event.target.files ?? []);
                if (file) {
                  onOpenFile(file);
                }
                event.target.value = '';
              }}
            />
          </label>
        ) : document.hasStoredSource ? (
          <button
            className="library-secondary-button"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemoveSourceCopy();
            }}
          >
            Remove source copy
          </button>
        ) : null}
        {isPdfDocument ? (
          <button
            aria-label="Read Now"
            className="library-open-button library-read-now-button"
            disabled={!document.hasStoredSource || isOpening}
            title={document.hasStoredSource ? 'Read Now' : 'Select the PDF first'}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            {isOpening ? 'Opening…' : 'Read Now'}
          </button>
        ) : null}
        <button
          className="library-forget-button"
          disabled={isForgetting}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onForget();
          }}
        >
          {isForgetting ? 'Removing…' : 'Remove from this device'}
        </button>
      </div>
    </article>
  );
}

/**
 * Renders each semantic Drive state once. Operation progress temporarily takes
 * the primary slot, so an unresolved issue remains as one secondary indicator
 * until the operation settles.
 */
export function LibraryPaperDriveStatus({
  presentation,
  cloudOperation,
}: {
  presentation: ReturnType<typeof getLibraryPaperDrivePresentation>;
  cloudOperation?: LibraryCloudOperation;
}) {
  const indicators = getLibraryPaperDriveStatusIndicators(
    presentation,
    cloudOperation ? cloudOperationLabel(cloudOperation) : undefined,
  );
  return (
    <>
      <div className="library-cloud-state" aria-label="Google Drive paper status">
        {indicators.map((indicator) =>
          indicator.primary ? (
            <span key={indicator.key} role={cloudOperation ? 'status' : undefined}>
              {indicator.label}
            </span>
          ) : (
            <small data-status-key={indicator.key} key={indicator.key}>
              {indicator.label}
            </small>
          ),
        )}
      </div>
      {presentation.issue?.message ? (
        <p className="library-error" role="alert">
          {presentation.issue.message}
        </p>
      ) : null}
    </>
  );
}

function CloudOnlyPaperCard({
  paper,
  selectionMode,
  selected,
  onSelect,
  busy,
  operation,
  cloudRemovalAllowed,
  onDownload,
  onRemove,
}: {
  paper: PaperCloudSummary;
  selectionMode: boolean;
  selected: boolean;
  onSelect: () => void;
  busy: boolean;
  operation?: LibraryCloudOperation;
  cloudRemovalAllowed: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const presentation = getLibraryPaperDrivePresentation(paper, undefined);
  const needsAttention = presentation.needsAttention;
  const documentType =
    paper.sourceArtifact?.documentType ?? (paper.sourcePdf ? 'pdf' : null);
  const isPdfDocument = documentType === 'pdf';
  return (
    <article
      className={`library-document library-cloud-only-document ${selected ? 'is-selected' : ''}`}
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
        {selectionMode ? (
          <input
            aria-label={`Select ${paper.displayName}`}
            checked={selected}
            type="checkbox"
            onChange={onSelect}
            onClick={(event) => event.stopPropagation()}
          />
        ) : null}
        <h3>{paper.displayName}</h3>
        {documentType ? (
          <span
            aria-label={`Document type: ${formatDocumentTypeLabel(documentType)}`}
            className="library-count"
          >
            {formatDocumentTypeLabel(documentType)}
          </span>
        ) : null}
      </div>
      <LibraryPaperDriveStatus cloudOperation={operation} presentation={presentation} />
      <p className="library-document-hint">
        {isPdfDocument
          ? 'Metadata only. The PDF and editable state stay in Google Drive until you choose Download.'
          : 'Experimental Office-native Drive record preserved for compatibility.'}
      </p>
      {!isPdfDocument ? (
        <p className="library-compatibility-warning" role="note">
          Direct Office download is disabled. Convert the original DOCX or PPTX to PDF
          and add the resulting PDF as a new paper. This Drive record is unchanged.
        </p>
      ) : null}
      <div className="library-document-actions">
        {isPdfDocument ? (
          <button
            disabled={busy || needsAttention || selectionMode}
            type="button"
            onClick={onDownload}
          >
            {operation === 'download' ? 'Downloading…' : 'Download'}
          </button>
        ) : null}
        <button
          disabled={busy || !cloudRemovalAllowed || needsAttention || selectionMode}
          title={
            !cloudRemovalAllowed
              ? 'Drive removal is available only on a Personal device.'
              : needsAttention
                ? 'Resolve Drive verification before removing this paper.'
                : undefined
          }
          type="button"
          onClick={onRemove}
        >
          {operation === 'remove' ? 'Removing…' : 'Remove from Google Drive'}
        </button>
      </div>
    </article>
  );
}

interface LibraryNoteCardProps {
  result: LibraryNoteResult;
  isOpening: boolean;
  onOpen: () => void;
  onSelectSource: (file: File) => void;
}

function LibraryNoteCard({
  result,
  isOpening,
  onOpen,
  onSelectSource,
}: LibraryNoteCardProps) {
  const isPdfDocument = result.document.documentType === 'pdf';
  return (
    <article
      className={`library-note-result ${isPdfDocument && result.document.hasStoredSource ? 'is-openable' : ''}`}
      onClick={isPdfDocument && result.document.hasStoredSource ? onOpen : undefined}
    >
      <p className="library-note-document-title">{result.document.displayTitle}</p>
      <div className="library-note-result-meta">
        <span>Note {result.displayNumber}</span>
        <span>{formatLibraryNoteLocation(result)}</span>
      </div>
      <p className="library-note-excerpt">{createExcerpt(result.content, 150)}</p>
      <blockquote>{createExcerpt(result.selectedText, 120)}</blockquote>
      {!isPdfDocument ? (
        <p className="library-compatibility-warning" role="note">
          This note belongs to a preserved experimental Office-native record and cannot
          open in the PDF reader.
        </p>
      ) : result.document.hasStoredSource ? (
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
        <label
          className="library-select-button"
          onClick={(event) => event.stopPropagation()}
        >
          Select PDF to open Note
          <input
            className="visually-hidden"
            type="file"
            accept={getDocumentAccept('pdf')}
            onChange={(event) => {
              const [file] = Array.from(event.target.files ?? []);
              if (file) {
                onSelectSource(file);
              }
              event.target.value = '';
            }}
          />
        </label>
      )}
    </article>
  );
}

function getSearchResults(
  documents: LibraryDocument[],
  query: string,
): {
  documents: LibraryDocument[];
  notes: LibraryNoteResult[];
} {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return { documents, notes: [] };
  }

  return {
    documents: documents.filter(
      (document) =>
        document.displayTitle.toLocaleLowerCase().includes(normalizedQuery) ||
        document.originalFileName.toLocaleLowerCase().includes(normalizedQuery),
    ),
    notes: documents.flatMap((document) =>
      document.notes.flatMap((note) =>
        note.content.toLocaleLowerCase().includes(normalizedQuery)
          ? [
              {
                document,
                noteId: note.id,
                annotationId: note.annotationId,
                displayNumber: note.displayNumber,
                content: note.content,
                pageNumber: note.pageNumber,
                selectedText: note.selectedText,
              },
            ]
          : [],
      ),
    ),
  };
}

function createExcerpt(value: string, maximumLength: number): string {
  const normalizedValue = value.replaceAll(/\s+/g, ' ').trim();
  return normalizedValue.length > maximumLength
    ? `${normalizedValue.slice(0, maximumLength).trimEnd()}…`
    : normalizedValue;
}

function formatDocumentTypeLabel(documentType: DocumentType): string {
  return documentType.toLocaleUpperCase('en-US');
}

function getDocumentAccept(documentType: DocumentType): string {
  return [
    DOCUMENT_MIME_TYPES[documentType],
    DOCUMENT_FILE_EXTENSIONS[documentType],
  ].join(',');
}

function formatLibraryNoteLocation(result: LibraryNoteResult): string {
  if (result.document.documentType === 'pptx') {
    return `Slide ${result.pageNumber}`;
  }
  if (result.document.documentType === 'docx') {
    return `Block ${result.pageNumber}`;
  }
  return `Page ${result.pageNumber}`;
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

function bulkDriveRemovalSkipReasonLabel(
  reason: LibraryBulkDriveRemovalSkipReason,
): string {
  switch (reason) {
    case 'cloud-removal-disabled':
      return 'Drive removal is disabled on this device';
    case 'needs-attention':
      return 'Drive identity needs attention';
    case 'not-cloud-present':
      return 'no verified active Drive copy';
    case 'removed':
      return 'already removed from Drive';
    case 'transfer-active':
      return 'a transfer is active';
  }
}

function sortDocuments(
  documents: LibraryDocument[],
  mode: 'modified' | 'read' | 'title',
): LibraryDocument[] {
  return [...documents].sort((first, second) => {
    if (first.isPinned !== second.isPinned) return first.isPinned ? -1 : 1;
    if (mode === 'title') return first.displayTitle.localeCompare(second.displayTitle);
    const firstValue = mode === 'read' ? (first.lastReadAt ?? 0) : first.updatedAt;
    const secondValue = mode === 'read' ? (second.lastReadAt ?? 0) : second.updatedAt;
    return (
      secondValue - firstValue || first.displayTitle.localeCompare(second.displayTitle)
    );
  });
}
