import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import type { ViewerHandle } from './Viewer';
import { NotesPanel } from './NotesPanel';
import { LargeNoteEditor } from './LargeNoteEditor';
import type { NoteDragStartHandler } from './NoteDragHandle';
import { WebLocalDataNotice } from './WebLocalDataNotice';
import { FeedbackNotice } from './FeedbackNotice.tsx';
import {
  consumeRestoreStartupRecoveryNotice,
  peekRestoreStartupRecoveryNotice,
} from '../services/restoreSafetyStartup.ts';
import { AnnotatedPdfExportDialog } from './AnnotatedPdfExportDialog';
import type { AnnotationFilterState } from './pdf/AnnotationFilterControl';
import type {
  AnnotationType,
  HighlightColor,
  PdfAnnotation,
  UnderlineColor,
} from '../types/highlight';
import {
  defaultHighlightPalette,
  defaultUnderlinePalette,
  getHighlightColorOpaqueHex,
  getUnderlineColorOpaqueHex,
  normalizeOpaqueHexColor,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type {
  DefinitionBubble,
  DictionaryDefinition,
  GlossaryEntry,
  NotesPrintLayout,
} from '../types/glossary';
import { isPdfGlossaryEntry } from '../types/glossary';
import type {
  AnnotatedPdfExportOptions,
  AnnotatedPdfExportProgress,
  PdfPageGeometry,
} from '../types/annotatedPdfExport';
import type { DocumentIdentity } from '../types/persistence';
import type { PdfTextSelection } from '../types/textSelection';
import type { DocumentLink } from '../types/documentLink';
import type { PrintDraftAddition } from '../types/productivity';
import type {
  DocumentOpenRequest,
  DocumentOpenSource,
  DocumentOpenTarget,
} from '../types/documentOpen';
import type { ReadingPosition } from '../types/library';
import { createNoteAnchorFromSelection } from '../utils/annotationOverlap';
import {
  createDocumentInstanceIdentity,
  preserveRequestedDocumentInstanceIdentity,
} from '../utils/documentIdentity.ts';
import {
  addNoteToAnnotationTag,
  deleteAnnotationTag,
  deleteNoteFromTagState,
  deriveAnnotationTags,
} from '../utils/annotationTags';
import {
  deleteDocumentState,
  deleteDocumentStates,
  loadStoredDocumentSource,
  loadStoredPdfFile,
  loadDocumentState,
  removeStoredDocumentSource,
  saveDocumentState,
  saveReadingPosition,
  storeDocumentSource,
  updateDocumentDisplayTitle,
  updateDocumentOrganization,
  withWorkspaceMutation,
} from '../services/annotationPersistence';
import {
  DOCUMENT_MIME_TYPES,
  getDocumentTypeForMimeType,
  hasDocumentFileExtension,
  type DocumentType,
} from '../types/document';
import {
  createHighlightsFromSelections,
  createUnderlinesFromSelections,
  createAnnotationFromSource,
  addAnnotationFromSourceIfMissing,
  upsertAnnotations,
} from '../utils/highlights';
import {
  MAX_DOCUMENT_LINK_RECTS,
  connectDocumentLink,
  connectDocumentLinkFromAnnotation,
  createUnpairedDocumentLink,
  createUnpairedDocumentLinkFromAnnotation,
  deleteDocumentLink,
  renameDocumentLink,
} from '../utils/documentLinks';
import { exportNotesAsMarkdown, exportNotesAsPdf } from '../utils/noteExport';
import {
  resolveInitialNavigation,
  type AnnotationLookupState,
  type InitialNavigationDecision,
} from '../utils/initialNavigation';
import { logNavigationDiagnostic } from '../utils/navigationDiagnostics';
import { normalizePdfRotation } from '../utils/annotatedPdfExportModel';
import { selectAnnotationsForExport } from '../utils/annotatedPdfExportSelection';
import { calculateManualZoomStep, type PdfZoomDirection } from '../utils/pdfPageScale';
import {
  createGlossaryEntryFromBubble,
  removeGlossaryEntry as removeGlossaryEntryFromState,
} from '../utils/glossary';
import {
  appendPrintDraftAddition,
  deleteProductivityDocumentData,
} from '../services/productivityPersistence';
import {
  addCustomAnnotationColor,
  findEquivalentAnnotationPaletteColor,
  readReaderAnnotationPalettes,
  readReaderStatusIndicatorDisplay,
  resetReaderAnnotationPalette,
  resolveReaderStatusIndicatorDisplay,
  resolveReaderWarning,
  writeReaderAnnotationPalettes,
  writeReaderStatusIndicatorDisplay,
  type ReaderStatusIndicatorDisplay,
} from '../utils/readerPreferences.ts';
import {
  ReaderHistoryStore,
  createReaderHistoryEntry,
  type ReaderEditableState,
  type ReaderHistoryEntry,
} from '../utils/readerHistory.ts';
import { COMPACT_READER_MEDIA_QUERY } from '../utils/responsiveLayout.ts';
import {
  clearWorkspaceNavigationHandoff,
  peekWorkspaceReloadDestination,
  rememberDriveAfterWorkspaceReload,
} from '../utils/workspaceNavigationHandoff.ts';
import {
  dispatchLocalRemovalLifecycle,
  notifyLocalRemovalLifecycle,
  registerPersistenceFlusher,
} from '../services/persistentChange';
import type { PaperUpdateReviewRequest } from '../sync/PaperSyncControl';
import {
  CollectionsHomePage,
  HomeFloatingButton,
  HomeLandingPage,
  HomeWorkspace,
  SettingsHomePage,
  ThemeHomePage,
  type HomeSection,
} from './HomeWorkspace.tsx';

const LibraryPanel = lazy(() =>
  import('./LibraryPanel').then((module) => ({ default: module.LibraryPanel })),
);
const Viewer = lazy(() =>
  import('./Viewer').then((module) => ({ default: module.Viewer })),
);
const PrintComposer = lazy(() =>
  import('../print/PrintComposer').then((module) => ({
    default: module.PrintComposer,
  })),
);
const AssistantPanel = lazy(() =>
  import('../ai/AssistantPanel').then((module) => ({ default: module.AssistantPanel })),
);
const AiConfigurationPage = lazy(() =>
  import('../ai/AssistantPanel').then((module) => ({
    default: module.AiConfigurationPage,
  })),
);
const PaperSyncHomePage = lazy(() =>
  import('../sync/PaperSyncControl').then((module) => ({
    default: module.PaperSyncHomePage,
  })),
);
const PaperReaderSyncStatus = lazy(() =>
  import('../sync/PaperSyncControl').then((module) => ({
    default: module.PaperReaderSyncStatus,
  })),
);
const PaperRemoteUpdateLayer = lazy(() =>
  import('../sync/PaperSyncControl').then((module) => ({
    default: module.PaperRemoteUpdateLayer,
  })),
);
const OfficePdfConverterDialog = lazy(() =>
  import('./OfficePdfConverterDialog').then((module) => ({
    default: module.OfficePdfConverterDialog,
  })),
);

type FitMode = 'width' | 'page' | null;

interface PendingLibraryNavigation {
  documentId: string;
  noteId: string;
  annotationId: string;
  isReadyToFocus: boolean;
}

interface NoteDragPreviewState {
  noteId: string;
  pointerId: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  initialX: number;
  initialY: number;
  onDropInTarget?: () => void;
}

export function AppLayout() {
  const [workspaceReloadDestination] = useState(peekWorkspaceReloadDestination);
  const [isCompactReader, setIsCompactReader] = useState(
    () => window.matchMedia(COMPACT_READER_MEDIA_QUERY).matches,
  );
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number(sessionStorage.getItem('39note.sidebar-width'));
    return Number.isFinite(storedWidth) && storedWidth >= 240 && storedWidth <= 520
      ? storedWidth
      : 300;
  });
  const [file, setFile] = useState<File | null>(null);
  const [activeDocumentType, setActiveDocumentType] = useState<'pdf' | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>('width');
  const [zoom, setZoom] = useState(1);
  const [effectiveZoom, setEffectiveZoom] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [documentLinks, setDocumentLinks] = useState<DocumentLink[]>([]);
  const [noteAnchors, setNoteAnchors] = useState<NoteAnchor[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [glossaryEntries, setGlossaryEntries] = useState<GlossaryEntry[]>([]);
  const [nextNoteNumber, setNextNoteNumber] = useState(1);
  const [nextLinkNumber, setNextLinkNumber] = useState(1);
  const [documentIdentity, setDocumentIdentity] = useState<DocumentIdentity | null>(
    null,
  );
  const [documentDisplayTitle, setDocumentDisplayTitle] = useState<string | null>(null);
  const [isDocumentHydrated, setIsDocumentHydrated] = useState(false);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [isNotesDrawerOpen, setIsNotesDrawerOpen] = useState(false);
  const [isMobileReaderMenuOpen, setIsMobileReaderMenuOpen] = useState(false);
  const mobileReaderMenuRef = useRef<HTMLElement>(null);
  const mobileReaderMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobilePanelReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobilePanelWasOpenRef = useRef(false);
  const [applicationView, setApplicationView] = useState<'reader' | 'home'>(() =>
    workspaceReloadDestination === 'drive' ? 'home' : 'reader',
  );
  const [homeSection, setHomeSection] = useState<HomeSection>(
    workspaceReloadDestination ?? 'home',
  );
  const [gettingStartedRequestId, setGettingStartedRequestId] = useState(0);
  const [collectionReturnId, setCollectionReturnId] = useState<string | null>(null);
  const [paperUpdateReviewRequest, setPaperUpdateReviewRequest] =
    useState<PaperUpdateReviewRequest | null>(null);
  const paperUpdateReviewSequenceRef = useRef(0);
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0);
  const [librarySearchFocusRequestId, setLibrarySearchFocusRequestId] = useState(0);
  const [openFileRequestId, setOpenFileRequestId] = useState(0);
  const [officeConversionRequest, setOfficeConversionRequest] = useState<{
    requestId: number;
    file?: File;
  } | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  useEffect(() => {
    clearWorkspaceNavigationHandoff();
  }, []);

  useEffect(() => {
    const preserveDriveDestination = () => {
      if (applicationView === 'home' && homeSection === 'drive') {
        rememberDriveAfterWorkspaceReload();
      }
    };
    window.addEventListener('39note:workspace-changing', preserveDriveDestination);
    return () =>
      window.removeEventListener('39note:workspace-changing', preserveDriveDestination);
  }, [applicationView, homeSection]);
  const [exportWarning, setExportWarning] = useState<string | null>(null);
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [isAnnotatedPdfDialogOpen, setIsAnnotatedPdfDialogOpen] = useState(false);
  const [isAnnotatedPdfExporting, setIsAnnotatedPdfExporting] = useState(false);
  const [annotatedPdfProgress, setAnnotatedPdfProgress] =
    useState<AnnotatedPdfExportProgress | null>(null);
  const [annotatedPdfError, setAnnotatedPdfError] = useState<string | null>(null);
  const annotatedPdfExportInFlightRef = useRef(false);
  const [pendingLibraryNavigation, setPendingLibraryNavigation] =
    useState<PendingLibraryNavigation | null>(null);
  const [documentOpenRequest, setDocumentOpenRequestState] =
    useState<DocumentOpenRequest | null>(null);
  const [zoomOperationId, setZoomOperationId] = useState(0);
  const [noteDragPreview, setNoteDragPreview] = useState<NoteDragPreviewState | null>(
    null,
  );
  const [largeEditorNoteId, setLargeEditorNoteId] = useState<string | null>(null);
  const [selectedPdfText, setSelectedPdfText] = useState<PdfTextSelection[]>([]);
  const [isPrintComposerOpen, setIsPrintComposerOpen] = useState(false);
  const [printComposerLayout, setPrintComposerLayout] =
    useState<NotesPrintLayout>('standard');
  const printComposerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<'disconnected' | 'connected' | 'generating'>(
    'disconnected',
  );
  const [readingRestoreToast, setReadingRestoreToast] = useState<string | null>(null);
  const [restoreStartupNotice, setRestoreStartupNotice] = useState(
    peekRestoreStartupRecoveryNotice,
  );
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilterState>({
    types: ['highlight', 'underline'],
    noteStatus: 'all',
    colors: [],
  });
  const [annotationPalettes, setAnnotationPalettes] = useState(
    readReaderAnnotationPalettes,
  );
  const [readerStatusIndicatorDisplay, setReaderStatusIndicatorDisplay] =
    useState<ReaderStatusIndicatorDisplay>(readReaderStatusIndicatorDisplay);
  const readingRestoreToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    if (restoreStartupNotice) consumeRestoreStartupRecoveryNotice();
  }, [restoreStartupNotice]);
  const viewerRef = useRef<ViewerHandle>(null);
  const effectiveZoomRef = useRef(effectiveZoom);
  const zoomOperationRef = useRef(0);
  const hydrationRequestRef = useRef(0);
  const documentGenerationRef = useRef(0);
  const newPaperImportRef = useRef<{
    generation: number;
    instanceId: string;
  } | null>(null);
  const documentOpenRequestRef = useRef<DocumentOpenRequest | null>(null);
  const openingResolutionRef = useRef<'pending' | 'resolved'>('resolved');
  const hydratedReadingPositionRef = useRef<ReadingPosition | null>(null);
  const initialNavigationApplicationRef = useRef<{
    requestId: string;
    decisionType: InitialNavigationDecision['type'];
  } | null>(null);
  const storedPdfLoadRequestRef = useRef(0);
  const libraryNavigationRequestRef = useRef(0);
  const pendingLibraryNavigationRef = useRef<PendingLibraryNavigation | null>(null);
  const persistenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readerPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const readerHistoryRef = useRef(new ReaderHistoryStore());
  const pendingReaderHistoryRef = useRef<ReaderHistoryEntry[]>([]);
  const readerHistoryInFlightRef = useRef(false);
  const noteEditEpochRef = useRef(new Map<string, number>());
  const readingPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextDocumentPersistenceRef = useRef(false);
  const skipNextReadingPositionSaveRef = useRef(false);
  const lastNavigationDiagnosticKeyRef = useRef<string | null>(null);
  const noteDropTargetRef = useRef<HTMLDivElement>(null);
  const noteDragPreviewRef = useRef<HTMLDivElement>(null);
  const noteDragFrameRef = useRef<number | null>(null);
  const noteDragPositionRef = useRef({ x: 0, y: 0 });
  const pdfExportCleanupRef = useRef<(() => void) | null>(null);
  const documentStateRef = useRef({
    documentIdentity,
    documentType: activeDocumentType,
    annotations,
    documentLinks,
    noteAnchors,
    notes,
    glossaryEntries,
    nextNoteNumber,
    nextLinkNumber,
    documentDisplayTitle,
    isDocumentHydrated,
  });

  effectiveZoomRef.current = effectiveZoom;

  const updateEffectiveZoom = useCallback((nextZoom: number) => {
    effectiveZoomRef.current = nextZoom;
    setEffectiveZoom(nextZoom);
  }, []);

  documentStateRef.current = {
    documentIdentity,
    documentType: activeDocumentType,
    annotations,
    documentLinks,
    noteAnchors,
    notes,
    glossaryEntries,
    nextNoteNumber,
    nextLinkNumber,
    documentDisplayTitle,
    isDocumentHydrated,
  };

  const applyReaderEditableState = useCallback(
    (next: ReaderEditableState, skipDebouncedPersistence = false) => {
      const current = documentStateRef.current;
      documentStateRef.current = {
        ...current,
        annotations: next.annotations,
        documentLinks: next.links,
        noteAnchors: next.noteAnchors,
        notes: next.notes,
        glossaryEntries: next.glossaryEntries,
        nextNoteNumber: next.nextNoteNumber,
        nextLinkNumber: next.nextLinkNumber,
      };
      if (skipDebouncedPersistence) skipNextDocumentPersistenceRef.current = true;
      setAnnotations(next.annotations);
      setDocumentLinks(next.links);
      setNoteAnchors(next.noteAnchors);
      setNotes(next.notes);
      setGlossaryEntries(next.glossaryEntries);
      setNextNoteNumber(next.nextNoteNumber);
      setNextLinkNumber(next.nextLinkNumber);
    },
    [],
  );

  const recordReaderMutation = useCallback(
    (
      label: string,
      update: (current: ReaderEditableState) => ReaderEditableState,
      options: { coalesceKey?: string } = {},
    ): boolean => {
      const current = documentStateRef.current;
      if (!current.documentIdentity || !current.isDocumentHydrated) return false;
      const before = readerEditableStateFromDocument(current);
      const after = update(before);
      const entry = createReaderHistoryEntry(
        current.documentIdentity.documentId,
        label,
        before,
        after,
        options,
      );
      if (!entry) return false;
      pendingReaderHistoryRef.current.push(entry);
      applyReaderEditableState(after);
      return true;
    },
    [applyReaderEditableState],
  );

  const commitDocumentOpenRequest = useCallback(
    (request: DocumentOpenRequest | null) => {
      documentOpenRequestRef.current = request;
      setDocumentOpenRequestState(request);
    },
    [],
  );

  const persistCurrentDocument = useCallback((): Promise<boolean> => {
    const currentState = documentStateRef.current;
    if (!currentState.documentIdentity || !currentState.isDocumentHydrated) {
      return Promise.resolve(false);
    }
    const captured = {
      ...currentState,
      documentIdentity: currentState.documentIdentity,
    };
    const documentId = captured.documentIdentity.documentId;
    const pendingIds = new Set(
      pendingReaderHistoryRef.current
        .filter((entry) => entry.documentId === documentId)
        .map((entry) => entry.id),
    );
    const save = async (): Promise<boolean> => {
      try {
        const wasSaved = await saveDocumentState(
          captured.documentIdentity,
          captured.annotations,
          captured.noteAnchors,
          captured.notes,
          captured.glossaryEntries,
          captured.nextNoteNumber,
          captured.documentDisplayTitle ?? captured.documentIdentity.documentName,
          captured.documentType ?? undefined,
          captured.documentLinks,
          captured.nextLinkNumber,
        );
        if (!wasSaved) {
          setStorageWarning(
            '39Note could not save the latest Reader edit. Undo and Redo remain paused until the edit is stored.',
          );
          return false;
        }
        const committed = pendingReaderHistoryRef.current.filter((entry) =>
          pendingIds.has(entry.id),
        );
        for (const entry of committed) readerHistoryRef.current.record(entry);
        pendingReaderHistoryRef.current = pendingReaderHistoryRef.current.filter(
          (entry) => !pendingIds.has(entry.id),
        );
        setStorageWarning(null);
        setLibraryRefreshToken((currentToken) => currentToken + 1);
        return true;
      } catch {
        setStorageWarning(
          '39Note could not save the latest Reader edit. Nothing was published, and Undo and Redo remain paused.',
        );
        return false;
      }
    };
    const result = readerPersistenceQueueRef.current.then(save, save);
    readerPersistenceQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const flushPersistence = useCallback(async (): Promise<boolean> => {
    if (persistenceTimerRef.current !== null) {
      clearTimeout(persistenceTimerRef.current);
      persistenceTimerRef.current = null;
    }

    return persistCurrentDocument();
  }, [persistCurrentDocument]);

  const finishNoteEditing = useCallback((noteId: string) => {
    noteEditEpochRef.current.set(
      noteId,
      (noteEditEpochRef.current.get(noteId) ?? 0) + 1,
    );
  }, []);

  const performReaderHistory = useCallback(
    async (
      direction: 'undo' | 'redo',
      textTarget: HTMLInputElement | HTMLTextAreaElement | null = null,
    ) => {
      if (readerHistoryInFlightRef.current) return;
      const startingDocumentId =
        documentStateRef.current.documentIdentity?.documentId ?? null;
      if (!startingDocumentId || !documentStateRef.current.isDocumentHydrated) return;
      readerHistoryInFlightRef.current = true;
      try {
        if (!(await flushPersistence())) return;
        const currentDocument = documentStateRef.current;
        if (currentDocument.documentIdentity?.documentId !== startingDocumentId) return;
        const current = readerEditableStateFromDocument(currentDocument);
        const prepared =
          direction === 'undo'
            ? readerHistoryRef.current.prepareUndo(startingDocumentId, current)
            : readerHistoryRef.current.prepareRedo(startingDocumentId, current);
        if (!prepared.ok) {
          if (prepared.reason === 'stale-state') {
            readerHistoryRef.current.clear(startingDocumentId);
            setStorageWarning(
              'Undo history was cleared because this paper changed after the recorded edit. Current authoritative content was preserved.',
            );
          }
          return;
        }
        applyReaderEditableState(prepared.application.state, true);
        const saved = await persistCurrentDocument();
        if (!saved) {
          applyReaderEditableState(current, true);
          setStorageWarning(
            `${direction === 'undo' ? 'Undo' : 'Redo'} was not applied because local storage rejected the change.`,
          );
          return;
        }
        const committed =
          direction === 'undo'
            ? readerHistoryRef.current.commitUndo(
                startingDocumentId,
                prepared.application.entry.id,
              )
            : readerHistoryRef.current.commitRedo(
                startingDocumentId,
                prepared.application.entry.id,
              );
        if (!committed) {
          readerHistoryRef.current.clear(startingDocumentId);
          setStorageWarning(
            'Undo history changed unexpectedly. The saved paper content was preserved and history was reset safely.',
          );
          return;
        }
        setStorageWarning(null);
        if (textTarget?.isConnected) {
          requestAnimationFrame(() => {
            const length = textTarget.value.length;
            textTarget.focus({ preventScroll: true });
            textTarget.setSelectionRange(length, length);
          });
        }
      } finally {
        readerHistoryInFlightRef.current = false;
      }
    },
    [applyReaderEditableState, flushPersistence, persistCurrentDocument],
  );

  useEffect(
    () =>
      registerPersistenceFlusher('reader', async () => {
        if (persistenceTimerRef.current !== null) return flushPersistence();
        await readerPersistenceQueueRef.current;
        if (pendingReaderHistoryRef.current.length > 0) return flushPersistence();
        return true;
      }),
    [flushPersistence],
  );

  useEffect(() => {
    const handleSyncApplied = (event: Event) => {
      const customEvent = event as CustomEvent<{
        changedDocumentIds?: string[];
        deletedDocumentIds?: string[];
      }>;
      const currentDocumentId = documentStateRef.current.documentIdentity?.documentId;
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      if (
        currentDocumentId &&
        customEvent.detail?.deletedDocumentIds?.includes(currentDocumentId)
      ) {
        readerHistoryRef.current.clear(currentDocumentId);
        pendingReaderHistoryRef.current = pendingReaderHistoryRef.current.filter(
          (entry) => entry.documentId !== currentDocumentId,
        );
        setFile(null);
        setActiveDocumentType(null);
        setPdfDocument(null);
        setDocumentIdentity(null);
        setDocumentDisplayTitle(null);
        setAnnotations([]);
        setDocumentLinks([]);
        setNoteAnchors([]);
        setNotes([]);
        setGlossaryEntries([]);
        setNextNoteNumber(1);
        setNextLinkNumber(1);
        setIsDocumentHydrated(false);
        setIsPrintComposerOpen(false);
        setIsAiOpen(false);
        setStorageWarning('The open document was deleted by a synchronized change.');
        return;
      }
      if (
        !currentDocumentId ||
        !customEvent.detail?.changedDocumentIds?.includes(currentDocumentId)
      )
        return;
      readerHistoryRef.current.clear(currentDocumentId);
      pendingReaderHistoryRef.current = pendingReaderHistoryRef.current.filter(
        (entry) => entry.documentId !== currentDocumentId,
      );
      setStorageWarning(
        'Reader undo history was cleared because a synchronized update changed this paper.',
      );
      void loadDocumentState(currentDocumentId).then((state) => {
        if (
          !state ||
          documentStateRef.current.documentIdentity?.documentId !== currentDocumentId
        )
          return;
        applyReaderEditableState(
          {
            annotations: state.annotations,
            links: state.links,
            noteAnchors: state.noteAnchors,
            notes: state.notes,
            glossaryEntries: state.glossaryEntries,
            nextNoteNumber: state.nextNoteNumber,
            nextLinkNumber: state.nextLinkNumber,
          },
          true,
        );
        setDocumentDisplayTitle(state.displayTitle);
        if (state.readingPosition) {
          skipNextReadingPositionSaveRef.current = true;
          hydratedReadingPositionRef.current = state.readingPosition;
          setFitMode(
            state.readingPosition.zoomMode === 'fit-width'
              ? 'width'
              : state.readingPosition.zoomMode === 'fit-page'
                ? 'page'
                : null,
          );
          setZoom(state.readingPosition.zoomPercent);
          setEffectiveZoom(state.readingPosition.zoomPercent);
          requestAnimationFrame(() => {
            viewerRef.current?.restoreReadingPosition(state.readingPosition!);
          });
        }
      });
    };
    window.addEventListener('39note:sync-applied', handleSyncApplied);
    return () => window.removeEventListener('39note:sync-applied', handleSyncApplied);
  }, [applyReaderEditableState]);

  useEffect(() => {
    if (skipNextDocumentPersistenceRef.current) {
      skipNextDocumentPersistenceRef.current = false;
      return;
    }
    if (!documentIdentity || !isDocumentHydrated) {
      return;
    }

    if (persistenceTimerRef.current !== null) {
      clearTimeout(persistenceTimerRef.current);
    }

    persistenceTimerRef.current = setTimeout(() => {
      persistenceTimerRef.current = null;
      void persistCurrentDocument();
    }, 450);

    return () => {
      if (persistenceTimerRef.current !== null) {
        clearTimeout(persistenceTimerRef.current);
        persistenceTimerRef.current = null;
      }
    };
  }, [
    annotations,
    documentLinks,
    noteAnchors,
    documentIdentity,
    isDocumentHydrated,
    notes,
    glossaryEntries,
    nextNoteNumber,
    nextLinkNumber,
    persistCurrentDocument,
  ]);

  useEffect(() => {
    const handlePageExit = () => {
      void flushPersistence();
    };

    window.addEventListener('pagehide', handlePageExit);
    return () => {
      window.removeEventListener('pagehide', handlePageExit);
      void flushPersistence();
    };
  }, [flushPersistence]);

  useEffect(
    () => () => {
      pdfExportCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    sessionStorage.setItem('39note.sidebar-width', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_READER_MEDIA_QUERY);
    const applyLayoutMode = (isCompact: boolean) => {
      setIsCompactReader(isCompact);
      setIsMobileReaderMenuOpen(false);
      setIsNotesDrawerOpen(false);
      setIsSidebarCollapsed(true);
    };
    const handleChange = (event: MediaQueryListEvent) => applyLayoutMode(event.matches);
    applyLayoutMode(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (
      !isCompactReader ||
      applicationView !== 'reader' ||
      !isSidebarCollapsed ||
      isNotesDrawerOpen ||
      isAiOpen
    ) {
      setIsMobileReaderMenuOpen(false);
    }
  }, [
    applicationView,
    isAiOpen,
    isCompactReader,
    isNotesDrawerOpen,
    isSidebarCollapsed,
  ]);

  useEffect(() => {
    if (!isMobileReaderMenuOpen) return undefined;

    const handleOutsidePointer = (event: PointerEvent) => {
      const menu = mobileReaderMenuRef.current;
      if (!menu || !(event.target instanceof Node) || menu.contains(event.target)) {
        return;
      }
      const focusWasInside =
        window.document.activeElement instanceof Node &&
        menu.contains(window.document.activeElement);
      setIsMobileReaderMenuOpen(false);
      if (focusWasInside) {
        window.requestAnimationFrame(() => {
          if (
            window.document.activeElement instanceof Node &&
            menu.contains(window.document.activeElement)
          ) {
            mobileReaderMenuTriggerRef.current?.focus({ preventScroll: true });
          }
        });
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setIsMobileReaderMenuOpen(false);
      mobileReaderMenuTriggerRef.current?.focus({ preventScroll: true });
    };

    window.addEventListener('pointerdown', handleOutsidePointer);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', handleOutsidePointer);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isMobileReaderMenuOpen]);

  useEffect(() => {
    if (!isCompactReader) {
      mobilePanelWasOpenRef.current = false;
      mobilePanelReturnFocusRef.current = null;
      return undefined;
    }

    const panelId = !isSidebarCollapsed
      ? 'reader-mobile-tools-panel'
      : isNotesDrawerOpen
        ? 'reader-mobile-notes-panel'
        : null;
    if (!panelId) {
      if (!mobilePanelWasOpenRef.current) return undefined;
      mobilePanelWasOpenRef.current = false;
      const returnFocus = mobilePanelReturnFocusRef.current;
      mobilePanelReturnFocusRef.current = null;
      const focusFrame = window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(focusFrame);
    }

    mobilePanelWasOpenRef.current = true;
    const panel = window.document.getElementById(panelId);
    if (!panel) return undefined;
    const focusFrame = window.requestAnimationFrame(() => {
      const preferredTarget =
        panel.querySelector<HTMLElement>(
          '.sidebar-mobile-close, .notes-panel-mobile-close',
        ) ??
        panel.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      (preferredTarget ?? panel).focus({ preventScroll: true });
    });
    const closeMobilePanel = () => {
      setIsSidebarCollapsed(true);
      setIsNotesDrawerOpen(false);
    };
    const containMobilePanelFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        closeMobilePanel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', containMobilePanelFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', containMobilePanelFocus);
    };
  }, [isCompactReader, isNotesDrawerOpen, isSidebarCollapsed]);

  useEffect(() => {
    writeReaderAnnotationPalettes(annotationPalettes);
  }, [annotationPalettes]);

  useEffect(() => {
    writeReaderStatusIndicatorDisplay(readerStatusIndicatorDisplay);
  }, [readerStatusIndicatorDisplay]);

  const createDocumentOpenRequest = useCallback(
    (
      documentId: string,
      source: DocumentOpenSource,
      target: DocumentOpenTarget,
    ): DocumentOpenRequest => {
      const request: DocumentOpenRequest = {
        requestId: crypto.randomUUID(),
        documentId,
        source,
        target,
        createdAt: Date.now(),
        generation: documentGenerationRef.current + 1,
        navigationEpoch: viewerRef.current?.getNavigationEpoch() ?? 0,
      };
      logNavigationDiagnostic('open-request-created', {
        requestId: request.requestId,
        documentId: request.documentId,
        source: request.source,
        targetType: request.target?.type ?? 'none',
        generation: request.generation,
        navigationEpoch: request.navigationEpoch,
      });
      return request;
    },
    [],
  );

  const openDocument = useCallback(
    (
      nextFile: File,
      requestedOpen?: DocumentOpenRequest,
      options: { importAsNewPaper?: boolean } = {},
    ) => {
      const prepared = prepareSupportedDocumentFile(nextFile);
      if (!prepared) {
        setStorageWarning(
          'Choose a valid PDF, PowerPoint (.pptx), or Word (.docx) document.',
        );
        return;
      }
      setCollectionReturnId(null);
      if (prepared.documentType !== 'pdf') {
        setStorageWarning(null);
        setOfficeConversionRequest({
          requestId: Date.now(),
          file: prepared.file,
        });
        return;
      }
      void flushPersistence();
      hydrationRequestRef.current += 1;
      documentGenerationRef.current += 1;
      newPaperImportRef.current = options.importAsNewPaper
        ? {
            generation: documentGenerationRef.current,
            instanceId: crypto.randomUUID(),
          }
        : null;
      storedPdfLoadRequestRef.current += 1;
      const openRequest =
        requestedOpen ?? createDocumentOpenRequest('', 'normal-library-open', null);
      commitDocumentOpenRequest({
        ...openRequest,
        generation: documentGenerationRef.current,
      });
      openingResolutionRef.current = 'pending';
      hydratedReadingPositionRef.current = null;
      initialNavigationApplicationRef.current = null;
      if (!requestedOpen?.target) {
        libraryNavigationRequestRef.current += 1;
        pendingLibraryNavigationRef.current = null;
        setPendingLibraryNavigation(null);
      }
      setFile(prepared.file);
      setActiveDocumentType('pdf');
      setPdfDocument(null);
      setFitMode('width');
      setZoom(1);
      setEffectiveZoom(1);
      setPageCount(0);
      setCurrentPage(0);
      setAnnotations([]);
      setDocumentLinks([]);
      setNoteAnchors([]);
      setAnnotationFilter({
        types: ['highlight', 'underline'],
        noteStatus: 'all',
        colors: [],
      });
      setNotes([]);
      setGlossaryEntries([]);
      setNextNoteNumber(1);
      setNextLinkNumber(1);
      setDocumentIdentity(null);
      setDocumentDisplayTitle(prepared.file.name);
      setIsDocumentHydrated(false);
      setFocusedNoteId(null);
      setNoteDragPreview(null);
      setLargeEditorNoteId(null);
      setSelectedPdfText([]);
      setIsPrintComposerOpen(false);
      setIsAiOpen(false);
      setExportWarning(null);
      setApplicationView('reader');
    },
    [commitDocumentOpenRequest, createDocumentOpenRequest, flushPersistence],
  );

  const importPdfAsNewPaper = useCallback(
    (nextFile: File) => openDocument(nextFile, undefined, { importAsNewPaper: true }),
    [openDocument],
  );

  const hydrateDocument = useCallback(
    (identity: DocumentIdentity, sourceFile: File) => {
      const requestId = hydrationRequestRef.current + 1;
      hydrationRequestRef.current = requestId;
      const generation = documentGenerationRef.current;
      const pendingNewPaper = newPaperImportRef.current;
      const currentOpenRequest = documentOpenRequestRef.current;
      const requestedDocumentId =
        currentOpenRequest?.generation === generation
          ? currentOpenRequest.documentId
          : undefined;
      const effectiveIdentity =
        pendingNewPaper?.generation === generation
          ? createDocumentInstanceIdentity(identity, pendingNewPaper.instanceId)
          : preserveRequestedDocumentInstanceIdentity(identity, requestedDocumentId);
      if (currentOpenRequest && currentOpenRequest.generation === generation) {
        if (
          currentOpenRequest.documentId &&
          currentOpenRequest.documentId !== effectiveIdentity.documentId
        ) {
          setStorageWarning(
            'The selected source does not match the requested Library document.',
          );
          return;
        }
        if (!currentOpenRequest.documentId) {
          commitDocumentOpenRequest({
            ...currentOpenRequest,
            documentId: effectiveIdentity.documentId,
          });
        }
      }

      setDocumentIdentity(effectiveIdentity);
      setActiveDocumentType('pdf');
      setDocumentDisplayTitle(effectiveIdentity.documentName);
      setIsDocumentHydrated(false);
      setAnnotations([]);
      setDocumentLinks([]);
      setNoteAnchors([]);
      setNotes([]);
      setGlossaryEntries([]);
      setNextLinkNumber(1);
      setFocusedNoteId(null);

      void storeDocumentSource(effectiveIdentity, sourceFile, 'pdf').then(
        (wasStored) => {
          if (wasStored) {
            setStorageWarning(null);
            setLibraryRefreshToken((currentToken) => currentToken + 1);
          } else {
            setStorageWarning(
              'The source document could not be saved locally. Reading and annotations remain available.',
            );
          }
        },
      );

      void loadDocumentState(effectiveIdentity.documentId).then((persistedState) => {
        if (
          hydrationRequestRef.current !== requestId ||
          documentGenerationRef.current !== generation
        ) {
          return;
        }

        if (persistedState && persistedState.documentType !== 'pdf') {
          setStorageWarning(
            'Stored data for this document has a different verified file type.',
          );
          return;
        }
        setAnnotations(persistedState?.annotations ?? []);
        setDocumentLinks(persistedState?.links ?? []);
        setNoteAnchors(persistedState?.noteAnchors ?? []);
        setNotes(persistedState?.notes ?? []);
        setGlossaryEntries(persistedState?.glossaryEntries ?? []);
        hydratedReadingPositionRef.current = persistedState?.readingPosition ?? null;
        setNextNoteNumber(persistedState?.nextNoteNumber ?? 1);
        setNextLinkNumber(persistedState?.nextLinkNumber ?? 1);
        setDocumentDisplayTitle(
          persistedState?.displayTitle ?? effectiveIdentity.documentName,
        );
        setIsDocumentHydrated(true);
      });
    },
    [commitDocumentOpenRequest],
  );

  useEffect(() => {
    if (skipNextReadingPositionSaveRef.current) {
      skipNextReadingPositionSaveRef.current = false;
      return;
    }
    if (
      !documentIdentity ||
      !isDocumentHydrated ||
      activeDocumentType !== 'pdf' ||
      currentPage < 1 ||
      openingResolutionRef.current === 'pending'
    )
      return;
    if (readingPositionTimerRef.current !== null)
      clearTimeout(readingPositionTimerRef.current);
    readingPositionTimerRef.current = setTimeout(() => {
      const position = viewerRef.current?.captureReadingPosition();
      if (position) void saveReadingPosition(documentIdentity.documentId, position);
      readingPositionTimerRef.current = null;
    }, 1200);
    return () => {
      if (readingPositionTimerRef.current !== null)
        clearTimeout(readingPositionTimerRef.current);
    };
  }, [
    activeDocumentType,
    currentPage,
    documentIdentity,
    effectiveZoom,
    fitMode,
    isDocumentHydrated,
  ]);

  const createHighlights = useCallback(
    (selections: PdfTextSelection[], color: HighlightColor) => {
      if (!isDocumentHydrated) {
        return;
      }

      const nextHighlights = createHighlightsFromSelections(selections, color);
      recordReaderMutation('Create Highlight', (current) => ({
        ...current,
        annotations: upsertAnnotations(current.annotations, nextHighlights),
      }));
    },
    [isDocumentHydrated, recordReaderMutation],
  );

  const createUnderlines = useCallback(
    (selections: PdfTextSelection[], color: UnderlineColor) => {
      if (!isDocumentHydrated) {
        return;
      }

      const nextUnderlines = createUnderlinesFromSelections(selections, color);
      recordReaderMutation('Create Underline', (current) => ({
        ...current,
        annotations: upsertAnnotations(current.annotations, nextUnderlines),
      }));
    },
    [isDocumentHydrated, recordReaderMutation],
  );

  const addCustomReaderAnnotationColor = useCallback(
    (type: AnnotationType, color: string): HighlightColor | UnderlineColor | null => {
      const selected = normalizeOpaqueHexColor(color);
      if (!selected) return null;
      const equivalent =
        type === 'highlight'
          ? findEquivalentAnnotationPaletteColor(
              'highlight',
              annotationPalettes.highlight,
              selected,
            )
          : findEquivalentAnnotationPaletteColor(
              'underline',
              annotationPalettes.underline,
              selected,
            );
      setAnnotationPalettes((current) => {
        if (type === 'highlight') {
          const highlight = addCustomAnnotationColor(
            current.highlight,
            selected,
            defaultHighlightPalette,
            getHighlightColorOpaqueHex,
          );
          return { ...current, highlight };
        }
        const underline = addCustomAnnotationColor(
          current.underline,
          selected,
          defaultUnderlinePalette,
          getUnderlineColorOpaqueHex,
        );
        return { ...current, underline };
      });
      return equivalent ?? selected;
    },
    [annotationPalettes.highlight, annotationPalettes.underline],
  );

  const resetAnnotationPalettePreference = useCallback((type: AnnotationType) => {
    setAnnotationPalettes((current) => resetReaderAnnotationPalette(type, current));
  }, []);

  const createDocumentLink = useCallback(
    (selection: PdfTextSelection): boolean => {
      const identity = documentStateRef.current.documentIdentity;
      if (!identity) return false;
      let created = false;
      const changed = recordReaderMutation('Create Link', (current) => {
        const result = createUnpairedDocumentLink({
          documentId: identity.documentId,
          selection,
          nextLinkNumber: current.nextLinkNumber,
        });
        if (!result) return current;
        created = true;
        return {
          ...current,
          links: [...current.links, result.link],
          nextLinkNumber: result.nextLinkNumber,
        };
      });
      if (!created || !changed) {
        setStorageWarning(
          selection.boundingRectangles.length > MAX_DOCUMENT_LINK_RECTS
            ? `This selection has more than ${MAX_DOCUMENT_LINK_RECTS} text fragments. Select a smaller passage before creating a Link.`
            : 'This text selection could not be stored as a Link. Select a shorter continuous passage and try again.',
        );
        return false;
      }
      setStorageWarning(null);
      return true;
    },
    [recordReaderMutation],
  );

  const connectToDocumentLink = useCallback(
    (linkId: string, selection: PdfTextSelection): boolean => {
      const identity = documentStateRef.current.documentIdentity;
      if (!identity) return false;
      let completed = false;
      const changed = recordReaderMutation('Complete Link', (current) => {
        const link = current.links.find((candidate) => candidate.id === linkId);
        if (!link || link.documentId !== identity.documentId) return current;
        const connected = connectDocumentLink(link, { selection });
        if (!connected) return current;
        completed = true;
        return {
          ...current,
          links: current.links.map((candidate) =>
            candidate.id === linkId ? connected : candidate,
          ),
        };
      });
      if (!completed || !changed) {
        const link = documentStateRef.current.documentLinks.find(
          (candidate) => candidate.id === linkId,
        );
        if (!link || link.documentId !== identity.documentId) {
          return false;
        }
        setStorageWarning(
          selection.boundingRectangles.length > MAX_DOCUMENT_LINK_RECTS
            ? `This selection has more than ${MAX_DOCUMENT_LINK_RECTS} text fragments. Select a smaller passage before completing the Link.`
            : 'This Link could not be completed. Refresh its current state and try again.',
        );
        return false;
      }
      setStorageWarning(null);
      return true;
    },
    [recordReaderMutation],
  );

  const createDocumentLinkFromAnnotation = useCallback(
    (annotationId: string): boolean => {
      const identity = documentStateRef.current.documentIdentity;
      if (!identity) return false;
      let created = false;
      const changed = recordReaderMutation('Create Link from annotation', (current) => {
        const annotation = current.annotations.find(
          (candidate) => candidate.id === annotationId,
        );
        if (!annotation) return current;
        const result = createUnpairedDocumentLinkFromAnnotation({
          documentId: identity.documentId,
          annotation,
          nextLinkNumber: current.nextLinkNumber,
        });
        if (!result) return current;
        created = true;
        return {
          ...current,
          links: [...current.links, result.link],
          nextLinkNumber: result.nextLinkNumber,
        };
      });
      if (!created || !changed) {
        setStorageWarning('This annotation could not be used as a Link endpoint.');
        return false;
      }
      setStorageWarning(null);
      return true;
    },
    [recordReaderMutation],
  );

  const connectToDocumentLinkFromAnnotation = useCallback(
    (annotationId: string, linkId: string): boolean => {
      const identity = documentStateRef.current.documentIdentity;
      if (!identity) return false;
      let completed = false;
      let wasAlreadyPaired = false;
      const changed = recordReaderMutation(
        'Complete Link from annotation',
        (current) => {
          const annotation = current.annotations.find(
            (candidate) => candidate.id === annotationId,
          );
          const link = current.links.find((candidate) => candidate.id === linkId);
          if (!annotation || !link || link.documentId !== identity.documentId) {
            return current;
          }
          wasAlreadyPaired = Boolean(link.endpointB);
          const connected = connectDocumentLinkFromAnnotation(link, annotation);
          if (!connected) return current;
          completed = true;
          return {
            ...current,
            links: current.links.map((candidate) =>
              candidate.id === linkId ? connected : candidate,
            ),
          };
        },
      );
      if (!completed || !changed) {
        setStorageWarning(
          wasAlreadyPaired
            ? 'This Link is already paired.'
            : 'This annotation could not be used to complete the Link.',
        );
        return false;
      }
      setStorageWarning(null);
      return true;
    },
    [recordReaderMutation],
  );

  const removeDocumentLink = useCallback(
    (linkId: string) => {
      recordReaderMutation('Delete Link', (current) => ({
        ...current,
        links: deleteDocumentLink(current.links, linkId),
      }));
    },
    [recordReaderMutation],
  );

  const renameDocumentLinkName = useCallback(
    (linkId: string, requestedName: string): boolean => {
      const documentState = documentStateRef.current;
      if (!documentState.documentIdentity || !documentState.isDocumentHydrated) {
        return false;
      }
      const current = readerEditableStateFromDocument(documentState);
      const link = current.links.find((candidate) => candidate.id === linkId);
      if (!link) return false;
      const renamed = renameDocumentLink(link, requestedName);
      if (!renamed) {
        setStorageWarning('Enter a shorter Link name without control characters.');
        return false;
      }
      if (renamed === link) {
        setStorageWarning(null);
        return true;
      }
      recordReaderMutation('Rename Link', (state) => ({
        ...state,
        links: state.links.map((candidate) =>
          candidate.id === linkId ? renamed : candidate,
        ),
      }));
      setStorageWarning(null);
      return true;
    },
    [recordReaderMutation],
  );

  const addNoteToMarkedAnnotation = useCallback(
    (annotationId: string) => {
      recordReaderMutation('Add Note', (current) => {
        const result = addNoteToAnnotationTag(
          {
            annotations: current.annotations,
            notes: current.notes,
            noteAnchors: current.noteAnchors,
          },
          annotationId,
          {
            id: crypto.randomUUID(),
            displayNumber: String(current.nextNoteNumber),
          },
        );
        return result.createdNote
          ? {
              ...current,
              notes: result.state.notes,
              noteAnchors: result.state.noteAnchors,
              nextNoteNumber: current.nextNoteNumber + 1,
            }
          : current;
      });
    },
    [recordReaderMutation],
  );

  const removeMarkedAnnotation = useCallback(
    (annotationId: string, confirmed: boolean) => {
      const current = documentStateRef.current;
      if (!current.isDocumentHydrated) return;
      const attachedNoteId = deriveAnnotationTags(
        current.annotations,
        current.notes,
        current.noteAnchors,
      ).find((tag) => tag.annotation.id === annotationId)?.note?.id;
      const result = deleteAnnotationTag(
        {
          annotations: current.annotations,
          notes: current.notes,
          noteAnchors: current.noteAnchors,
        },
        annotationId,
        confirmed,
      );
      if (!result.deleted) return;

      const annotationType = current.annotations.find(
        (annotation) => annotation.id === annotationId,
      )?.type;
      recordReaderMutation(
        annotationType === 'underline' ? 'Delete Underline' : 'Delete Highlight',
        (state) => ({
          ...state,
          annotations: result.state.annotations,
          notes: result.state.notes,
          noteAnchors: result.state.noteAnchors,
        }),
      );
      if (attachedNoteId) {
        setFocusedNoteId((currentId) =>
          currentId === attachedNoteId ? null : currentId,
        );
        setLargeEditorNoteId((currentId) =>
          currentId === attachedNoteId ? null : currentId,
        );
      }
    },
    [recordReaderMutation],
  );

  const createAnnotationFromNoteSource = useCallback(
    (
      source: PdfAnnotation | NoteAnchor,
      type: AnnotationType,
      color: HighlightColor | UnderlineColor,
    ) => {
      if (!isDocumentHydrated) return;
      const nextAnnotation =
        type === 'highlight'
          ? createAnnotationFromSource(source, type, color as HighlightColor)
          : createAnnotationFromSource(source, type, color as UnderlineColor);
      if (!nextAnnotation) return;
      recordReaderMutation(
        `Create ${type === 'highlight' ? 'Highlight' : 'Underline'}`,
        (current) => ({
          ...current,
          annotations: addAnnotationFromSourceIfMissing(
            current.annotations,
            nextAnnotation,
          ),
        }),
      );
    },
    [isDocumentHydrated, recordReaderMutation],
  );

  const updateNote = useCallback(
    (noteId: string, content: string) => {
      const epoch = noteEditEpochRef.current.get(noteId) ?? 0;
      recordReaderMutation(
        'Edit Note',
        (current) => ({
          ...current,
          notes: current.notes.map((note) =>
            note.id === noteId ? { ...note, content, updatedAt: Date.now() } : note,
          ),
        }),
        { coalesceKey: `note:${noteId}:${epoch}` },
      );
    },
    [recordReaderMutation],
  );

  const addAiOutputToNote = useCallback(
    (content: string) => {
      if (!isDocumentHydrated || !documentIdentity || !content.trim()) return;
      const timestamp = Date.now();
      const selectedAnchor = selectedPdfText[0]
        ? createNoteAnchorFromSelection(selectedPdfText[0])
        : null;
      const anchor: NoteAnchor = selectedAnchor ?? {
        id: crypto.randomUUID(),
        type: 'note-anchor',
        pageNumber: Math.max(1, currentPage),
        text: 'AI Assistant response',
        rects: [{ x: 0.04, y: 0.04, width: 0.01, height: 0.01 }],
        startOffset: 0,
        endOffset: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const note: Note = {
        id: crypto.randomUUID(),
        annotationId: anchor.id,
        pageNumber: anchor.pageNumber,
        displayNumber: String(documentStateRef.current.nextNoteNumber),
        selectedText: selectedAnchor?.text ?? 'AI Assistant response',
        content: content.trim(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const created = recordReaderMutation('Add AI output to Note', (current) => ({
        ...current,
        noteAnchors: [...current.noteAnchors, anchor],
        notes: [note, ...current.notes],
        nextNoteNumber: current.nextNoteNumber + 1,
      }));
      if (!created) return;
      setFocusedNoteId(note.id);
      setIsNotesDrawerOpen(true);
    },
    [
      currentPage,
      documentIdentity,
      isDocumentHydrated,
      recordReaderMutation,
      selectedPdfText,
    ],
  );

  const sendAiOutputToPrintDraft = useCallback(
    async (addition: PrintDraftAddition): Promise<boolean> => {
      if (!documentIdentity) return false;
      return appendPrintDraftAddition(documentIdentity.documentId, addition);
    },
    [documentIdentity],
  );

  const deleteNote = useCallback(
    (noteId: string) => {
      const current = documentStateRef.current;
      const state = deleteNoteFromTagState(
        {
          annotations: current.annotations,
          notes: current.notes,
          noteAnchors: current.noteAnchors,
        },
        noteId,
      );
      if (state.notes === current.notes) return;

      recordReaderMutation('Delete Note', (editable) => ({
        ...editable,
        notes: state.notes,
        noteAnchors: state.noteAnchors,
      }));
      setFocusedNoteId((currentId) => (currentId === noteId ? null : currentId));
      setLargeEditorNoteId((currentId) => (currentId === noteId ? null : currentId));
    },
    [recordReaderMutation],
  );

  const addGlossaryEntry = useCallback(
    (
      bubble: DefinitionBubble,
      preferredDefinition: DictionaryDefinition,
    ): GlossaryEntry | null => {
      if (
        !documentIdentity ||
        !isDocumentHydrated ||
        bubble.documentId !== documentIdentity.documentId
      ) {
        return null;
      }

      const entry = createGlossaryEntryFromBubble(
        documentIdentity.documentId,
        bubble,
        preferredDefinition,
      );
      return recordReaderMutation('Add Glossary entry', (current) => ({
        ...current,
        glossaryEntries: [...current.glossaryEntries, entry],
      }))
        ? entry
        : null;
    },
    [documentIdentity, isDocumentHydrated, recordReaderMutation],
  );

  const removeGlossaryEntry = useCallback(
    (glossaryEntryId: string): boolean => {
      const current = documentStateRef.current;
      const entry = current.glossaryEntries.find(
        (candidate) => candidate.glossaryEntryId === glossaryEntryId,
      );
      if (
        !current.documentIdentity ||
        !current.isDocumentHydrated ||
        !entry ||
        entry.documentId !== current.documentIdentity.documentId
      ) {
        return false;
      }
      const result = removeGlossaryEntryFromState(
        current.glossaryEntries,
        current.annotations,
        glossaryEntryId,
      );
      const changed = recordReaderMutation('Remove Glossary entry', (editable) => ({
        ...editable,
        glossaryEntries: result.entries,
      }));
      if (!changed) return false;
      window.setTimeout(() => void flushPersistence(), 0);
      return true;
    },
    [flushPersistence, recordReaderMutation],
  );

  const navigateToGlossaryEntry = useCallback(
    (entry: GlossaryEntry) => {
      if (
        !documentIdentity ||
        !isDocumentHydrated ||
        entry.documentId !== documentIdentity.documentId
      ) {
        return;
      }
      if (!isPdfGlossaryEntry(entry)) {
        viewerRef.current?.navigateToGlossaryEntry(entry.glossaryEntryId);
        return;
      }
      openingResolutionRef.current = 'pending';
      initialNavigationApplicationRef.current = null;
      commitDocumentOpenRequest({
        ...createDocumentOpenRequest(documentIdentity.documentId, 'document-glossary', {
          type: 'glossary',
          glossaryEntryId: entry.glossaryEntryId,
          pageNumber: entry.pageNumber,
        }),
        generation: documentGenerationRef.current,
      });
    },
    [
      commitDocumentOpenRequest,
      createDocumentOpenRequest,
      documentIdentity,
      isDocumentHydrated,
    ],
  );

  const updateNoteDisplayNumber = useCallback(
    (noteId: string, displayNumber: string) => {
      const epoch = noteEditEpochRef.current.get(noteId) ?? 0;
      recordReaderMutation(
        'Renumber Note',
        (current) => ({
          ...current,
          notes: current.notes.map((note) =>
            note.id === noteId
              ? { ...note, displayNumber, updatedAt: Date.now() }
              : note,
          ),
        }),
        { coalesceKey: `note-number:${noteId}:${epoch}` },
      );
    },
    [recordReaderMutation],
  );

  const exportCurrentNotes = useCallback(
    (layout: NotesPrintLayout) => {
      if (isPdfExporting) {
        return;
      }

      setIsPdfExporting(true);
      const completeExport = () => {
        pdfExportCleanupRef.current = null;
        setIsPdfExporting(false);
      };
      const cleanup = exportNotesAsPdf(
        notes,
        documentDisplayTitle ?? file?.name ?? '39Note',
        annotations,
        noteAnchors,
        glossaryEntries,
        layout,
        completeExport,
      );
      if (!cleanup) {
        setIsPdfExporting(false);
        setExportWarning(
          'The browser blocked the print window. Allow popups and try again.',
        );
        return;
      }

      pdfExportCleanupRef.current = cleanup;
      setExportWarning(null);
    },
    [
      annotations,
      documentDisplayTitle,
      file,
      glossaryEntries,
      isPdfExporting,
      noteAnchors,
      notes,
    ],
  );

  const exportCurrentNotesAsMarkdown = useCallback(() => {
    if (
      !file ||
      activeDocumentType !== 'pdf' ||
      !documentIdentity ||
      !isDocumentHydrated ||
      notes.length === 0
    ) {
      return;
    }

    try {
      if (exportNotesAsMarkdown(notes, documentDisplayTitle ?? file.name)) {
        setExportWarning(null);
      }
    } catch {
      setExportWarning('The Notes file could not be downloaded. Try again.');
    }
  }, [
    activeDocumentType,
    documentDisplayTitle,
    documentIdentity,
    file,
    isDocumentHydrated,
    notes,
  ]);

  const exportAnnotatedPdf = useCallback(
    async (options: AnnotatedPdfExportOptions) => {
      if (
        isAnnotatedPdfExporting ||
        annotatedPdfExportInFlightRef.current ||
        !file ||
        !pdfDocument ||
        !documentIdentity ||
        !isDocumentHydrated
      ) {
        return;
      }

      annotatedPdfExportInFlightRef.current = true;
      setIsAnnotatedPdfExporting(true);
      setAnnotatedPdfError(null);
      setAnnotatedPdfProgress({
        stage: 'preparing',
        message: 'Preparing original PDF...',
      });

      try {
        await flushPersistence();
        const storedPdf = await loadStoredPdfFile(documentIdentity.documentId);
        const sourceBlob = storedPdf?.blob ?? file;
        const pageGeometries = await collectPdfPageGeometries(pdfDocument);
        const exportAnnotations = selectAnnotationsForExport(
          annotations,
          notes,
          annotationFilter,
          options.includeHiddenAnnotations,
          noteAnchors,
        );
        const { createAnnotatedPdf } = await import('../services/annotatedPdfExport');
        const result = await createAnnotatedPdf({
          sourceBlob,
          documentTitle: documentDisplayTitle ?? file.name ?? '39Note',
          annotations: exportAnnotations,
          notes,
          noteAnchors,
          pageGeometries,
          options,
          onProgress: setAnnotatedPdfProgress,
        });
        downloadAnnotatedPdf(result.bytes, result.filename);
        setAnnotatedPdfProgress({
          stage: 'download',
          message: `Download ready: ${result.exportedAnnotationCount} annotations${result.appendixEntryCount > 0 ? `, ${result.appendixEntryCount} Notes` : ''}.`,
        });
      } catch (error) {
        setAnnotatedPdfError(
          error instanceof Error
            ? error.message
            : 'The annotated PDF could not be created. The original PDF was not changed.',
        );
        setAnnotatedPdfProgress(null);
      } finally {
        annotatedPdfExportInFlightRef.current = false;
        setIsAnnotatedPdfExporting(false);
      }
    },
    [
      annotationFilter,
      annotations,
      documentDisplayTitle,
      documentIdentity,
      file,
      flushPersistence,
      isAnnotatedPdfExporting,
      isDocumentHydrated,
      notes,
      noteAnchors,
      pdfDocument,
    ],
  );

  const beginNoteDrag = useCallback<NoteDragStartHandler>(
    (note, event, onDropInTarget) => {
      const dragSource = event.currentTarget.closest<HTMLElement>(
        '[data-note-drag-source="true"]',
      );
      if (!dragSource) {
        return;
      }

      const rectangle = dragSource.getBoundingClientRect();
      noteDragPositionRef.current = { x: rectangle.left, y: rectangle.top };
      setNoteDragPreview({
        noteId: note.id,
        pointerId: event.pointerId,
        width: rectangle.width,
        height: rectangle.height,
        offsetX: event.clientX - rectangle.left,
        offsetY: event.clientY - rectangle.top,
        initialX: rectangle.left,
        initialY: rectangle.top,
        onDropInTarget,
      });
    },
    [],
  );

  const openLargeEditor = useCallback((note: Note) => {
    setNoteDragPreview(null);
    setLargeEditorNoteId(note.id);
  }, []);

  useEffect(() => {
    if (!noteDragPreview) {
      return;
    }

    const setPreviewPosition = () => {
      const preview = noteDragPreviewRef.current;
      if (preview) {
        const { x, y } = noteDragPositionRef.current;
        preview.style.transform = `translate3d(${x}px, ${y}px, 0) scale(0.98)`;
      }
      noteDragFrameRef.current = null;
    };
    const schedulePreviewPosition = () => {
      if (noteDragFrameRef.current === null) {
        noteDragFrameRef.current = requestAnimationFrame(setPreviewPosition);
      }
    };
    const cancelDrag = () => setNoteDragPreview(null);
    const moveDrag = (event: PointerEvent) => {
      if (event.pointerId !== noteDragPreview.pointerId) {
        return;
      }

      noteDragPositionRef.current = {
        x: event.clientX - noteDragPreview.offsetX,
        y: event.clientY - noteDragPreview.offsetY,
      };
      schedulePreviewPosition();
    };
    const finishDrag = (event: PointerEvent) => {
      if (event.pointerId !== noteDragPreview.pointerId) {
        return;
      }

      const target = noteDropTargetRef.current;
      if (target) {
        const rectangle = target.getBoundingClientRect();
        const wasDroppedInTarget =
          event.clientX >= rectangle.left &&
          event.clientX <= rectangle.right &&
          event.clientY >= rectangle.top &&
          event.clientY <= rectangle.bottom;

        if (wasDroppedInTarget) {
          setLargeEditorNoteId(noteDragPreview.noteId);
          noteDragPreview.onDropInTarget?.();
        }
      }
      cancelDrag();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelDrag();
      }
    };

    schedulePreviewPosition();
    window.addEventListener('pointermove', moveDrag, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', cancelDrag, true);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      if (noteDragFrameRef.current !== null) {
        cancelAnimationFrame(noteDragFrameRef.current);
        noteDragFrameRef.current = null;
      }
      window.removeEventListener('pointermove', moveDrag, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', cancelDrag, true);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [noteDragPreview]);

  useEffect(() => {
    if (largeEditorNoteId && !notes.some((note) => note.id === largeEditorNoteId)) {
      setLargeEditorNoteId(null);
    }
  }, [largeEditorNoteId, notes]);

  useEffect(() => {
    if (noteDragPreview && !notes.some((note) => note.id === noteDragPreview.noteId)) {
      setNoteDragPreview(null);
    }
  }, [noteDragPreview, notes]);

  const renameLibraryDocument = useCallback(
    async (documentId: string, displayTitle: string): Promise<boolean> => {
      const wasRenamed = await updateDocumentDisplayTitle(documentId, displayTitle);
      if (!wasRenamed) {
        return false;
      }

      if (documentIdentity?.documentId === documentId) {
        setDocumentDisplayTitle(displayTitle.trim());
      }
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      return true;
    },
    [documentIdentity],
  );

  const openHomeSection = useCallback((section: HomeSection) => {
    setHomeSection(section);
    setApplicationView('home');
    setIsAiOpen(false);
    setIsNotesDrawerOpen(false);
    setNoteDragPreview(null);
    setLargeEditorNoteId(null);
    setIsPrintComposerOpen(false);
    setIsAnnotatedPdfDialogOpen(false);
  }, []);

  const openDriveManagement = useCallback(() => {
    setPaperUpdateReviewRequest(null);
    openHomeSection('drive');
  }, [openHomeSection]);

  const openDriveUpdateReview = useCallback(
    (affectedDocumentIds: readonly string[]) => {
      const documentIds = [...new Set(affectedDocumentIds)];
      if (!documentIds.length) {
        openDriveManagement();
        return;
      }
      setPaperUpdateReviewRequest({
        requestId: ++paperUpdateReviewSequenceRef.current,
        documentIds,
      });
      openHomeSection('drive');
    },
    [openDriveManagement, openHomeSection],
  );

  const markDriveUpdateReviewOpened = useCallback((requestId: number) => {
    setPaperUpdateReviewRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);

  const openLibrarySearch = useCallback(() => {
    void flushPersistence().then(() => {
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      setLibrarySearchFocusRequestId((currentRequest) => currentRequest + 1);
      openHomeSection('library');
    });
  }, [flushPersistence, openHomeSection]);

  useEffect(() => {
    const handleShortcuts = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLocaleLowerCase();
      const historyDirection =
        modifier && !event.altKey && key === 'z'
          ? event.shiftKey
            ? 'redo'
            : 'undo'
          : modifier && !event.altKey && !event.shiftKey && key === 'y'
            ? 'redo'
            : null;

      if (historyDirection) {
        if (
          event.isComposing ||
          applicationView !== 'reader' ||
          !file ||
          !isDocumentHydrated ||
          isPrintComposerOpen
        ) {
          return;
        }
        const noteEditor = getReaderHistoryTextInput(event.target);
        if (isEditableElement(event.target) && !noteEditor) return;
        if (isBlockingDialogTarget(event.target) && !noteEditor) return;

        event.preventDefault();
        const noteId = noteEditor?.dataset.readerHistoryNoteId;
        if (noteId) finishNoteEditing(noteId);
        void performReaderHistory(historyDirection, noteEditor);
        return;
      }

      if (isEditableElement(event.target)) return;

      if (modifier && event.shiftKey && key === 'f') {
        event.preventDefault();
        openLibrarySearch();
        return;
      }

      if (modifier && key === 'o') {
        event.preventDefault();
        setOpenFileRequestId((currentRequest) => currentRequest + 1);
        return;
      }

      if (modifier && key === 'f' && file) {
        event.preventDefault();
        viewerRef.current?.openSearch();
        return;
      }

      if (!modifier && !event.altKey && key === 'n' && file && isDocumentHydrated) {
        event.preventDefault();
        if (isCompactReader) setIsSidebarCollapsed(true);
        setIsNotesDrawerOpen((isOpen) => !isOpen);
      }
    };

    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [
    applicationView,
    file,
    finishNoteEditing,
    isCompactReader,
    isDocumentHydrated,
    isPrintComposerOpen,
    openLibrarySearch,
    performReaderHistory,
  ]);

  const forgetDocument = useCallback(
    async (documentId: string): Promise<boolean> => {
      await flushPersistence();
      notifyLocalRemovalLifecycle(documentId, 'started');
      try {
        const wasForgotten = await withWorkspaceMutation(async (lease) => {
          const deleted = await deleteDocumentState(
            documentId,
            false,
            undefined,
            lease,
          );
          if (!deleted) return false;
          await deleteProductivityDocumentData(documentId, false, undefined, lease);
          await dispatchLocalRemovalLifecycle(documentId, 'committed', lease);
          return true;
        });
        if (!wasForgotten) {
          notifyLocalRemovalLifecycle(documentId, 'aborted');
          return false;
        }
      } catch (error) {
        notifyLocalRemovalLifecycle(documentId, 'aborted');
        throw error;
      }

      if (documentIdentity?.documentId === documentId) {
        hydrationRequestRef.current += 1;
        storedPdfLoadRequestRef.current += 1;
        setFile(null);
        setActiveDocumentType(null);
        setPageCount(0);
        setCurrentPage(0);
        setAnnotations([]);
        setDocumentLinks([]);
        setNotes([]);
        setGlossaryEntries([]);
        setNextNoteNumber(1);
        setNextLinkNumber(1);
        setDocumentIdentity(null);
        setDocumentDisplayTitle(null);
        setIsDocumentHydrated(false);
        setFocusedNoteId(null);
        setNoteDragPreview(null);
        setLargeEditorNoteId(null);
        setExportWarning(null);
        setHomeSection('library');
        setApplicationView('home');
      }

      return true;
    },
    [documentIdentity, flushPersistence],
  );

  const forgetLibraryDocuments = useCallback(
    async (ids: string[]): Promise<{ deleted: string[]; failed: string[] }> => {
      await flushPersistence();
      const lifecycleIds = [...new Set(ids)];
      const settledLifecycleIds = new Set<string>();
      for (const documentId of lifecycleIds) {
        notifyLocalRemovalLifecycle(documentId, 'started');
      }
      let result: { deleted: string[]; failed: string[] };
      try {
        result = await withWorkspaceMutation(async (lease) => {
          const deletion = await deleteDocumentStates(ids, false, lease);
          for (const documentId of deletion.failed) {
            notifyLocalRemovalLifecycle(documentId, 'aborted');
            settledLifecycleIds.add(documentId);
          }
          await Promise.all(
            deletion.deleted.map(async (documentId) => {
              await deleteProductivityDocumentData(documentId, false, undefined, lease);
              await dispatchLocalRemovalLifecycle(documentId, 'committed', lease);
              settledLifecycleIds.add(documentId);
            }),
          );
          return deletion;
        });
        for (const documentId of lifecycleIds) {
          if (!settledLifecycleIds.has(documentId)) {
            notifyLocalRemovalLifecycle(documentId, 'aborted');
            settledLifecycleIds.add(documentId);
          }
        }
      } catch (error) {
        for (const documentId of lifecycleIds) {
          if (!settledLifecycleIds.has(documentId)) {
            notifyLocalRemovalLifecycle(documentId, 'aborted');
          }
        }
        throw error;
      }
      if (documentIdentity && result.deleted.includes(documentIdentity.documentId)) {
        setFile(null);
        setActiveDocumentType(null);
        setDocumentIdentity(null);
        setAnnotations([]);
        setDocumentLinks([]);
        setNotes([]);
        setGlossaryEntries([]);
        setPageCount(0);
        setCurrentPage(0);
        setNextLinkNumber(1);
        setIsDocumentHydrated(false);
        setHomeSection('library');
        setApplicationView('home');
      }
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      return result;
    },
    [documentIdentity, flushPersistence],
  );

  const removeLibrarySourceCopy = useCallback(
    async (documentId: string): Promise<boolean> => {
      await flushPersistence();
      const wasRemoved = await removeStoredDocumentSource(documentId);
      if (wasRemoved) {
        setLibraryRefreshToken((currentToken) => currentToken + 1);
      }
      return wasRemoved;
    },
    [flushPersistence],
  );

  const updateLibraryOrganization = useCallback(
    async (documentId: string, isPinned: boolean): Promise<boolean> => {
      const wasUpdated = await updateDocumentOrganization([documentId], {
        isPinned,
        ...(isPinned ? { pinnedAt: Date.now() } : { pinnedAt: undefined }),
      });
      if (wasUpdated) setLibraryRefreshToken((currentToken) => currentToken + 1);
      return wasUpdated;
    },
    [],
  );

  const getStoredDocumentFile = useCallback(
    async (documentId: string): Promise<File | null> => {
      const requestId = storedPdfLoadRequestRef.current + 1;
      storedPdfLoadRequestRef.current = requestId;
      const storedSource = await loadStoredDocumentSource(documentId);

      if (!storedSource || storedPdfLoadRequestRef.current !== requestId) {
        return null;
      }

      return new File([storedSource.blob], storedSource.fileName, {
        type: storedSource.mimeType,
        lastModified: storedSource.lastModified,
      });
    },
    [],
  );

  const openStoredDocument = useCallback(
    async (documentId: string, preserveCollectionOrigin = false): Promise<boolean> => {
      if (!preserveCollectionOrigin) setCollectionReturnId(null);
      const storedDocumentFile = await getStoredDocumentFile(documentId);
      if (!storedDocumentFile) {
        return false;
      }

      const prepared = prepareSupportedDocumentFile(storedDocumentFile);
      if (!prepared || prepared.documentType !== 'pdf') {
        setStorageWarning(
          'This experimental Office-native Library record was preserved but cannot be opened directly. Re-import the original DOCX or PPTX through the local PDF converter.',
        );
        return false;
      }

      openDocument(
        prepared.file,
        createDocumentOpenRequest(documentId, 'normal-library-open', null),
      );
      return true;
    },
    [createDocumentOpenRequest, getStoredDocumentFile, openDocument],
  );

  const openLibraryNote = useCallback(
    async (
      documentId: string,
      noteId: string,
      annotationId: string,
      pageNumber: number,
    ): Promise<boolean> => {
      setCollectionReturnId(null);
      const navigationRequestId = libraryNavigationRequestRef.current + 1;
      libraryNavigationRequestRef.current = navigationRequestId;
      const pendingNavigation: PendingLibraryNavigation = {
        documentId,
        noteId,
        annotationId,
        isReadyToFocus: false,
      };
      pendingLibraryNavigationRef.current = pendingNavigation;
      setPendingLibraryNavigation(pendingNavigation);
      const openRequest = createDocumentOpenRequest(documentId, 'library-note-result', {
        type: 'annotation',
        annotationId,
        pageNumber,
        noteId,
      });
      if (documentIdentity?.documentId === documentId && isDocumentHydrated) {
        const currentDocumentRequest = {
          ...openRequest,
          generation: documentGenerationRef.current,
        };
        openingResolutionRef.current = 'pending';
        initialNavigationApplicationRef.current = null;
        commitDocumentOpenRequest(currentDocumentRequest);
        return true;
      }

      commitDocumentOpenRequest(openRequest);

      const storedDocumentFile = await getStoredDocumentFile(documentId);
      const isStillActiveRequest =
        documentOpenRequestRef.current?.requestId === openRequest.requestId;
      if (
        !storedDocumentFile ||
        libraryNavigationRequestRef.current !== navigationRequestId ||
        !isStillActiveRequest
      ) {
        if (documentOpenRequestRef.current?.requestId === openRequest.requestId) {
          logNavigationDiagnostic('stale-request-ignored', {
            requestId: openRequest.requestId,
            documentId,
            source: openRequest.source,
            reason: storedDocumentFile
              ? 'superseded-library-navigation'
              : 'stored-pdf-unavailable',
          });
          commitDocumentOpenRequest(null);
        }
        return false;
      }

      const prepared = prepareSupportedDocumentFile(storedDocumentFile);
      if (!prepared || prepared.documentType !== 'pdf') {
        setStorageWarning(
          'Notes from an experimental Office-native record cannot open in the PDF reader. The record and its data were left unchanged.',
        );
        commitDocumentOpenRequest(null);
        return false;
      }

      openDocument(prepared.file, openRequest);
      return true;
    },
    [
      commitDocumentOpenRequest,
      createDocumentOpenRequest,
      documentIdentity,
      getStoredDocumentFile,
      isDocumentHydrated,
      openDocument,
    ],
  );

  const selectPdfForLibraryNote = useCallback(
    (
      fileToOpen: File,
      documentId: string,
      noteId: string,
      annotationId: string,
      pageNumber: number,
    ) => {
      const prepared = prepareSupportedDocumentFile(fileToOpen);
      if (!prepared || prepared.documentType !== 'pdf') {
        setStorageWarning(
          'Choose the PDF source for this paper. DOCX and PPTX files must be converted before they can be opened.',
        );
        return;
      }
      libraryNavigationRequestRef.current += 1;
      const pendingNavigation: PendingLibraryNavigation = {
        documentId,
        noteId,
        annotationId,
        isReadyToFocus: false,
      };
      pendingLibraryNavigationRef.current = pendingNavigation;
      setPendingLibraryNavigation(pendingNavigation);
      const openRequest = createDocumentOpenRequest(documentId, 'library-note-result', {
        type: 'annotation',
        annotationId,
        pageNumber,
        noteId,
      });
      commitDocumentOpenRequest(openRequest);
      openDocument(prepared.file, openRequest);
    },
    [commitDocumentOpenRequest, createDocumentOpenRequest, openDocument],
  );

  const showReadingPositionToast = useCallback((position: ReadingPosition) => {
    setReadingRestoreToast(
      `Reading position restored · Page ${position.pageNumber} · ${Math.round(position.zoomPercent * 100)}%`,
    );
    if (readingRestoreToastTimerRef.current !== null) {
      clearTimeout(readingRestoreToastTimerRef.current);
    }
    readingRestoreToastTimerRef.current = setTimeout(() => {
      setReadingRestoreToast(null);
      readingRestoreToastTimerRef.current = null;
    }, 5600);
  }, []);

  const handleInitialAnnotationNavigationApplied = useCallback(
    (annotationId: string) => {
      const openRequest = documentOpenRequestRef.current;
      const identity = documentStateRef.current.documentIdentity;
      if (
        !openRequest ||
        !['library-note-result', 'document-note'].includes(openRequest.source) ||
        openRequest.target?.type !== 'annotation' ||
        openRequest.target.annotationId !== annotationId ||
        !identity ||
        identity.documentId !== openRequest.documentId ||
        openRequest.generation !== documentGenerationRef.current ||
        viewerRef.current?.getNavigationEpoch() !== openRequest.navigationEpoch
      ) {
        logNavigationDiagnostic('stale-request-ignored', {
          requestId: openRequest?.requestId,
          documentId: openRequest?.documentId,
          source: openRequest?.source,
          targetType: openRequest?.target?.type ?? 'none',
          annotationId,
          reason: 'annotation-application-guard-failed',
        });
        return;
      }

      initialNavigationApplicationRef.current = {
        requestId: openRequest.requestId,
        decisionType: 'explicit-annotation-target',
      };
      logNavigationDiagnostic('navigation-applied', {
        requestId: openRequest.requestId,
        documentId: openRequest.documentId,
        source: openRequest.source,
        targetType: 'annotation',
        annotationId,
        generation: openRequest.generation,
        navigationEpoch: openRequest.navigationEpoch,
      });
      commitDocumentOpenRequest(null);
      logNavigationDiagnostic('request-consumed', {
        requestId: openRequest.requestId,
        documentId: openRequest.documentId,
        source: openRequest.source,
        targetType: 'annotation',
      });
      openingResolutionRef.current = 'resolved';
      pendingLibraryNavigationRef.current = null;
      setPendingLibraryNavigation(null);
    },
    [commitDocumentOpenRequest],
  );

  useEffect(() => {
    const openRequest = documentOpenRequest;
    if (!openRequest || !documentIdentity) {
      return;
    }

    const target = openRequest.target;
    const requestedTargetAnnotation =
      target?.type === 'annotation'
        ? [...annotations, ...noteAnchors].find(
            (candidate) => candidate.id === target.annotationId,
          )
        : undefined;
    const targetNote =
      target?.type === 'annotation' && target.noteId
        ? notes.find((candidate) => candidate.id === target.noteId)
        : undefined;
    const targetTag = targetNote
      ? deriveAnnotationTags(annotations, notes, noteAnchors).find(
          (tag) => tag.note?.id === targetNote.id,
        )
      : undefined;
    const targetAnnotation = targetTag?.annotation ?? requestedTargetAnnotation;
    const isRequestDocumentHydrated =
      isDocumentHydrated &&
      openRequest.documentId === documentIdentity.documentId &&
      openRequest.generation === documentGenerationRef.current;
    let annotationLookupState: AnnotationLookupState = 'not-required';
    if (target?.type === 'annotation') {
      annotationLookupState = !isRequestDocumentHydrated
        ? 'pending'
        : targetAnnotation &&
            (openRequest.source !== 'library-note-result' ||
              (targetNote &&
                (targetNote.annotationId === requestedTargetAnnotation?.id ||
                  targetTag?.note?.id === targetNote.id)))
          ? 'found'
          : 'missing';
    }

    const decision = resolveInitialNavigation({
      openRequest,
      activeRequestId: documentOpenRequestRef.current?.requestId ?? null,
      activeNavigationEpoch: viewerRef.current?.getNavigationEpoch() ?? 0,
      savedReadingPosition: hydratedReadingPositionRef.current,
      annotationLookupState,
      documentReadyState: isRequestDocumentHydrated ? 'hydrated' : 'loading',
      pageCount,
    });

    const diagnosticKey = decision
      ? `${decision.requestId}:${decision.type}`
      : `${openRequest.requestId}:stale`;
    const logDecisionOnce = (
      event: Parameters<typeof logNavigationDiagnostic>[0],
      details: Parameters<typeof logNavigationDiagnostic>[1],
    ) => {
      if (lastNavigationDiagnosticKeyRef.current === diagnosticKey) {
        return;
      }
      lastNavigationDiagnosticKeyRef.current = diagnosticKey;
      logNavigationDiagnostic(event, details);
    };

    if (!decision) {
      logDecisionOnce('stale-request-ignored', {
        requestId: openRequest.requestId,
        documentId: openRequest.documentId,
        source: openRequest.source,
        targetType: openRequest.target?.type ?? 'none',
        generation: openRequest.generation,
        navigationEpoch: openRequest.navigationEpoch,
        reason: 'request-id-or-navigation-epoch-mismatch',
      });
      return;
    }

    if (decision.type === 'wait-for-explicit-target') {
      logDecisionOnce('waiting-for-annotation-hydration', {
        requestId: openRequest.requestId,
        documentId: openRequest.documentId,
        source: openRequest.source,
        targetType: openRequest.target?.type ?? 'none',
        generation: openRequest.generation,
        navigationEpoch: openRequest.navigationEpoch,
      });
      return;
    }

    const existingApplication = initialNavigationApplicationRef.current;
    if (
      existingApplication?.requestId === decision.requestId &&
      existingApplication.decisionType === decision.type
    ) {
      return;
    }

    const generation = openRequest.generation;
    const requestId = openRequest.requestId;
    const documentId = documentIdentity.documentId;
    const isCurrentRequest = (expectedNavigationEpoch: number) => {
      const currentRequest = documentOpenRequestRef.current;
      return Boolean(
        currentRequest &&
        currentRequest.requestId === requestId &&
        currentRequest.documentId === documentId &&
        currentRequest.generation === generation &&
        documentGenerationRef.current === generation &&
        viewerRef.current?.getNavigationEpoch() === expectedNavigationEpoch,
      );
    };
    const applyReadingPosition = (position: ReadingPosition, showToast: boolean) => {
      initialNavigationApplicationRef.current = {
        requestId,
        decisionType: decision.type,
      };
      setFitMode(
        position.zoomMode === 'fit-width'
          ? 'width'
          : position.zoomMode === 'fit-page'
            ? 'page'
            : null,
      );
      setZoom(position.zoomPercent);
      setEffectiveZoom(position.zoomPercent);
      const expectedNavigationEpoch = openRequest.navigationEpoch;
      requestAnimationFrame(() => {
        if (!isCurrentRequest(expectedNavigationEpoch)) {
          return;
        }
        viewerRef.current?.restoreReadingPosition(position, () => {
          if (!isCurrentRequest(expectedNavigationEpoch)) {
            return;
          }
          const completedRequest = documentOpenRequestRef.current;
          if (completedRequest) {
            logNavigationDiagnostic('navigation-applied', {
              requestId: completedRequest.requestId,
              documentId: completedRequest.documentId,
              source: completedRequest.source,
              targetType: 'saved-position',
              pageNumber: position.pageNumber,
              navigationEpoch: expectedNavigationEpoch,
            });
            commitDocumentOpenRequest(null);
            logNavigationDiagnostic('request-consumed', {
              requestId: completedRequest.requestId,
              documentId: completedRequest.documentId,
              source: completedRequest.source,
              targetType: 'saved-position',
            });
          }
          openingResolutionRef.current = 'resolved';
          if (showToast) {
            showReadingPositionToast(position);
          }
        });
      });
    };

    if (decision.type === 'saved-position') {
      logDecisionOnce('saved-position-selected', {
        requestId,
        documentId,
        source: openRequest.source,
        targetType: 'none',
        pageNumber: decision.position.pageNumber,
      });
      applyReadingPosition(decision.position, true);
      return;
    }

    if (decision.type === 'invalid-target-fallback') {
      initialNavigationApplicationRef.current = {
        requestId,
        decisionType: decision.type,
      };
      setStorageWarning('The requested Note target could not be located.');
      logDecisionOnce('invalid-target-fallback-selected', {
        requestId,
        documentId,
        source: openRequest.source,
        targetType: 'annotation',
        fallback: decision.fallback,
        pageNumber: decision.position?.pageNumber,
      });
      pendingLibraryNavigationRef.current = null;
      setPendingLibraryNavigation(null);
      if (decision.fallback === 'saved-position' && decision.position) {
        applyReadingPosition(decision.position, false);
      } else {
        commitDocumentOpenRequest(null);
        logNavigationDiagnostic('request-consumed', {
          requestId,
          documentId,
          source: openRequest.source,
          targetType: 'annotation',
        });
        openingResolutionRef.current = 'resolved';
      }
      return;
    }

    if (decision.type === 'page-one') {
      initialNavigationApplicationRef.current = {
        requestId,
        decisionType: decision.type,
      };
      logDecisionOnce('page-one-selected', {
        requestId,
        documentId,
        source: openRequest.source,
        targetType: 'none',
        pageNumber: 1,
      });
      commitDocumentOpenRequest(null);
      logNavigationDiagnostic('request-consumed', {
        requestId,
        documentId,
        source: openRequest.source,
        targetType: 'page',
      });
      openingResolutionRef.current = 'resolved';
      return;
    }

    if (decision.type === 'explicit-target') {
      initialNavigationApplicationRef.current = {
        requestId,
        decisionType: decision.type,
      };
      if (decision.target.type === 'glossary') {
        viewerRef.current?.navigateToGlossaryEntry(decision.target.glossaryEntryId);
      } else {
        viewerRef.current?.goToPage(decision.target.pageNumber);
      }
      commitDocumentOpenRequest(null);
      openingResolutionRef.current = 'resolved';
      return;
    }

    if (!targetAnnotation) {
      return;
    }

    const pendingNavigation = pendingLibraryNavigationRef.current;
    if (targetNote && pendingNavigation) {
      const readyNavigation = {
        ...pendingNavigation,
        annotationId: targetAnnotation.id,
        isReadyToFocus: true,
      };
      pendingLibraryNavigationRef.current = readyNavigation;
      setPendingLibraryNavigation(readyNavigation);
      setIsNotesDrawerOpen(true);
      setFocusedNoteId(targetNote.id);
    }

    const expectedNavigationEpoch = (viewerRef.current?.getNavigationEpoch() ?? 0) + 1;
    logDecisionOnce('annotation-target-resolved', {
      requestId,
      documentId,
      source: openRequest.source,
      targetType: 'annotation',
      annotationId: targetAnnotation.id,
      pageNumber: targetAnnotation.pageNumber,
      generation,
      navigationEpoch: expectedNavigationEpoch,
    });
    commitDocumentOpenRequest({
      ...openRequest,
      target: {
        type: 'annotation',
        annotationId: targetAnnotation.id,
        ...(decision.noteId ? { noteId: decision.noteId } : {}),
        pageNumber: targetAnnotation.pageNumber,
      },
      navigationEpoch: expectedNavigationEpoch,
    });
    viewerRef.current?.navigateToAnnotation(targetAnnotation.id, {
      showSourceActions: Boolean(targetNote),
    });
  }, [
    annotations,
    commitDocumentOpenRequest,
    documentOpenRequest,
    documentIdentity,
    isDocumentHydrated,
    notes,
    noteAnchors,
    pageCount,
    pendingLibraryNavigation,
    showReadingPositionToast,
  ]);

  const handleFocusedNoteReady = useCallback((noteId: string) => {
    const pendingNavigation = pendingLibraryNavigationRef.current;
    if (
      !pendingNavigation ||
      !pendingNavigation.isReadyToFocus ||
      pendingNavigation.noteId !== noteId
    ) {
      return;
    }

    // Focusing the editor can happen before the target page has completed layout.
    // Retrying is safe, but only Viewer may report that annotation navigation applied.
    viewerRef.current?.navigateToAnnotation(pendingNavigation.annotationId, {
      showSourceActions: true,
    });
  }, []);

  const navigateToNote = useCallback(
    (note: Note) => {
      if (!documentIdentity || !isDocumentHydrated) {
        return;
      }

      const markTag = deriveAnnotationTags(annotations, notes, noteAnchors).find(
        (tag) => tag.note?.id === note.id,
      );
      const annotationId = markTag?.annotation.id ?? note.annotationId;
      const pendingNavigation: PendingLibraryNavigation = {
        documentId: documentIdentity.documentId,
        noteId: note.id,
        annotationId,
        isReadyToFocus: false,
      };
      const request = {
        ...createDocumentOpenRequest(documentIdentity.documentId, 'document-note', {
          type: 'annotation',
          annotationId,
          pageNumber: note.pageNumber,
          noteId: note.id,
        }),
        generation: documentGenerationRef.current,
      };

      pendingLibraryNavigationRef.current = pendingNavigation;
      setPendingLibraryNavigation(pendingNavigation);
      setIsNotesDrawerOpen(true);
      setFocusedNoteId(note.id);
      openingResolutionRef.current = 'pending';
      initialNavigationApplicationRef.current = null;
      commitDocumentOpenRequest(request);
    },
    [
      commitDocumentOpenRequest,
      createDocumentOpenRequest,
      annotations,
      documentIdentity,
      isDocumentHydrated,
      noteAnchors,
      notes,
    ],
  );

  const handleExplicitNavigation = useCallback(() => {
    const openRequest = documentOpenRequestRef.current;
    const isPendingAnnotationTarget = Boolean(
      openRequest &&
      ((['library-note-result', 'document-note'].includes(openRequest.source) &&
        openRequest.target?.type === 'annotation') ||
        (openRequest.source === 'document-glossary' &&
          openRequest.target?.type === 'glossary')),
    );
    if (!isPendingAnnotationTarget) {
      if (openRequest) {
        logNavigationDiagnostic('request-consumed', {
          requestId: openRequest.requestId,
          documentId: openRequest.documentId,
          source: openRequest.source,
          targetType: openRequest.target?.type ?? 'none',
          reason: 'overridden-by-explicit-navigation',
        });
        commitDocumentOpenRequest(null);
      }
      openingResolutionRef.current = 'resolved';
    }
    setReadingRestoreToast(null);
    if (readingRestoreToastTimerRef.current !== null) {
      clearTimeout(readingRestoreToastTimerRef.current);
      readingRestoreToastTimerRef.current = null;
    }
  }, [commitDocumentOpenRequest]);

  const navigateToPage = useCallback((pageNumber: number) => {
    viewerRef.current?.goToPage(pageNumber);
  }, []);

  const beginZoomOperation = useCallback(() => {
    const nextOperationId = zoomOperationRef.current + 1;
    zoomOperationRef.current = nextOperationId;
    viewerRef.current?.captureZoomAnchor(nextOperationId);
    setZoomOperationId(nextOperationId);
  }, []);

  const applyZoomStep = (direction: PdfZoomDirection) => {
    const nextZoom = calculateManualZoomStep(effectiveZoomRef.current, direction);
    beginZoomOperation();
    setFitMode(null);
    setZoom(nextZoom);
    updateEffectiveZoom(nextZoom);
  };

  const zoomIn = () => applyZoomStep('in');

  const zoomOut = () => applyZoomStep('out');

  const applyZoom = (nextZoom: number) => {
    beginZoomOperation();
    setFitMode(null);
    setZoom(nextZoom);
    updateEffectiveZoom(nextZoom);
  };

  const largeEditorNote = largeEditorNoteId
    ? (notes.find((candidate) => candidate.id === largeEditorNoteId) ?? null)
    : null;
  const draggedNote = noteDragPreview
    ? (notes.find((candidate) => candidate.id === noteDragPreview.noteId) ?? null)
    : null;
  const notedAnnotationIds = deriveAnnotationTags(
    annotations,
    notes,
    noteAnchors,
  ).flatMap((tag) => (tag.note ? [tag.annotation.id] : []));
  const visibleExportAnnotations = selectAnnotationsForExport(
    annotations,
    notes,
    annotationFilter,
    false,
    noteAnchors,
  );
  const nonEmptyNotedAnnotationIds = new Set(
    notes
      .filter((note) => note.content.trim().length > 0)
      .map((note) => note.annotationId),
  );
  const nonEmptyNoteCount = nonEmptyNotedAnnotationIds.size;
  const visibleAnnotationIds = new Set(
    visibleExportAnnotations.map((annotation) => annotation.id),
  );
  const noteAnchorIds = new Set(noteAnchors.map((anchor) => anchor.id));
  const visibleNonEmptyNoteCount = notes.filter(
    (note) =>
      note.content.trim().length > 0 &&
      (visibleAnnotationIds.has(note.annotationId) ||
        noteAnchorIds.has(note.annotationId)),
  ).length;
  const homeContent =
    homeSection === 'home' ? (
      <HomeLandingPage
        gettingStartedRequestId={gettingStartedRequestId}
        onGettingStartedRequestHandled={() => setGettingStartedRequestId(0)}
        onOpenCollections={() => setHomeSection('collections')}
        onOpenDrive={openDriveManagement}
        onOpenLibrary={() => {
          setLibrarySearchFocusRequestId((current) => current + 1);
          setHomeSection('library');
        }}
        onOpenOfficeConverter={() =>
          setOfficeConversionRequest({ requestId: Date.now() })
        }
      />
    ) : homeSection === 'library' ? (
      <div className="home-library-page">
        <Suspense fallback={<div role="status">Opening Library…</div>}>
          <LibraryPanel
            focusSearchRequestId={librarySearchFocusRequestId}
            isOpen
            presentation="embedded"
            refreshToken={libraryRefreshToken}
            onClose={() => setApplicationView('reader')}
            onForget={forgetDocument}
            onForgetMany={forgetLibraryDocuments}
            onOpenFile={openDocument}
            onImportAsNewPaper={importPdfAsNewPaper}
            onOpenLibraryNote={openLibraryNote}
            onOpenStoredDocument={openStoredDocument}
            onPinDocument={updateLibraryOrganization}
            onRemoveSourceCopy={removeLibrarySourceCopy}
            onRenameDocument={renameLibraryDocument}
            onSelectSourceForLibraryNote={selectPdfForLibraryNote}
          />
        </Suspense>
      </div>
    ) : homeSection === 'collections' ? (
      <CollectionsHomePage
        initialCollectionId={collectionReturnId}
        onOpenDocument={(documentId, collectionId) =>
          openStoredDocument(documentId, true).then((opened) => {
            if (opened) setCollectionReturnId(collectionId);
            return opened;
          })
        }
        onOpenLibrary={() => {
          setCollectionReturnId(null);
          setHomeSection('library');
        }}
      />
    ) : homeSection === 'theme' ? (
      <ThemeHomePage />
    ) : homeSection === 'ai' ? (
      <Suspense fallback={<div role="status">Opening AI configuration…</div>}>
        <AiConfigurationPage />
      </Suspense>
    ) : homeSection === 'drive' ? (
      <Suspense fallback={<div role="status">Opening Google Drive…</div>}>
        <PaperSyncHomePage
          updateReviewRequest={paperUpdateReviewRequest}
          onUpdateReviewOpened={markDriveUpdateReviewOpened}
        />
      </Suspense>
    ) : (
      <SettingsHomePage
        readerStatusIndicatorDisplay={readerStatusIndicatorDisplay}
        onReaderStatusIndicatorDisplayChange={setReaderStatusIndicatorDisplay}
        onOpenGettingStarted={() => {
          setGettingStartedRequestId((current) => current + 1);
          setHomeSection('home');
        }}
      />
    );

  const activeReaderWarning = resolveReaderWarning(storageWarning, exportWarning);

  return (
    <main
      className={`app-layout ${isSidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${isCompactReader ? 'is-compact-reader' : 'is-docked-reader'} ${!isSidebarCollapsed ? 'is-reader-tools-open' : ''} ${isNotesDrawerOpen ? 'is-reader-notes-open' : ''} ${isAiOpen ? 'is-reader-ai-open' : ''}`}
    >
      <div
        aria-hidden={applicationView === 'home' ? true : undefined}
        className={`reader-workspace ${applicationView === 'home' ? 'is-home-covered' : ''}`}
        inert={applicationView === 'home' ? true : undefined}
      >
        <Toolbar
          isCompactReader={isCompactReader}
          onOpenFile={openDocument}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onFitWidth={() => {
            beginZoomOperation();
            setFitMode('width');
          }}
          onFitPage={() => {
            beginZoomOperation();
            setFitMode('page');
          }}
          onApplyZoom={applyZoom}
          onGoToPage={navigateToPage}
          onOpenSearch={() => viewerRef.current?.openSearch()}
          openFileRequestId={openFileRequestId}
          onExportAnnotatedPdf={() => {
            setAnnotatedPdfError(null);
            setAnnotatedPdfProgress(null);
            setIsAnnotatedPdfDialogOpen(true);
          }}
          onExportNotes={exportCurrentNotesAsMarkdown}
          isAnnotatedPdfExporting={isAnnotatedPdfExporting}
          canExportNotes={Boolean(
            file &&
            activeDocumentType === 'pdf' &&
            documentIdentity &&
            isDocumentHydrated &&
            notes.length > 0,
          )}
          hasDocument={Boolean(file)}
          documentType={activeDocumentType}
          pageCount={pageCount}
          currentPage={currentPage}
          documentTitle={documentDisplayTitle ?? file?.name ?? 'No document opened'}
          effectiveZoom={effectiveZoom}
          isAiOpen={isAiOpen}
          aiStatus={aiStatus}
          isInteractionDisabled={
            isCompactReader && (!isSidebarCollapsed || isNotesDrawerOpen)
          }
          onToggleAi={() => {
            if (isCompactReader && !isAiOpen) {
              setIsMobileReaderMenuOpen(false);
              setIsSidebarCollapsed(true);
              setIsNotesDrawerOpen(false);
            }
            setIsAiOpen((open) => !open);
          }}
        />
        <WebLocalDataNotice />
        {restoreStartupNotice ? (
          <FeedbackNotice
            actions={
              <button type="button" onClick={() => setRestoreStartupNotice(null)}>
                Dismiss
              </button>
            }
            className="restore-startup-recovery-notice"
            description={restoreStartupNotice.detail}
            persistent
            title={restoreStartupNotice.title}
            tone="info"
          />
        ) : null}
        <div className="app-content">
          <nav
            ref={mobileReaderMenuRef}
            className={`reader-mobile-actions ${isMobileReaderMenuOpen ? 'is-open' : ''}`}
            aria-hidden={
              isCompactReader && (!isSidebarCollapsed || isNotesDrawerOpen)
                ? true
                : undefined
            }
            aria-label="Mobile Reader controls"
            inert={
              isCompactReader && (!isSidebarCollapsed || isNotesDrawerOpen)
                ? true
                : undefined
            }
          >
            <button
              ref={mobileReaderMenuTriggerRef}
              aria-controls="reader-mobile-action-items"
              aria-expanded={isMobileReaderMenuOpen}
              aria-label={
                isMobileReaderMenuOpen
                  ? 'Close Reader shortcuts'
                  : 'Open Reader shortcuts'
              }
              className="reader-mobile-action-trigger"
              title={
                isMobileReaderMenuOpen
                  ? 'Close Reader shortcuts'
                  : 'Open Reader shortcuts'
              }
              type="button"
              onClick={() => setIsMobileReaderMenuOpen((isOpen) => !isOpen)}
            >
              <span aria-hidden="true">{isMobileReaderMenuOpen ? '×' : '☰'}</span>
            </button>
            <div
              id="reader-mobile-action-items"
              aria-hidden={!isMobileReaderMenuOpen ? true : undefined}
              aria-label="Reader shortcuts"
              className="reader-mobile-action-items"
              inert={!isMobileReaderMenuOpen ? true : undefined}
              role="group"
            >
              <button
                className="reader-mobile-action-child"
                type="button"
                onClick={() => {
                  setIsMobileReaderMenuOpen(false);
                  setIsSidebarCollapsed(true);
                  setIsNotesDrawerOpen(false);
                  mobileReaderMenuTriggerRef.current?.focus({ preventScroll: true });
                  openHomeSection(collectionReturnId ? 'collections' : 'home');
                }}
              >
                Home
              </button>
              <button
                aria-controls="reader-mobile-tools-panel"
                aria-expanded={!isSidebarCollapsed}
                aria-haspopup="dialog"
                className="reader-mobile-action-child"
                type="button"
                onClick={() => {
                  setIsMobileReaderMenuOpen(false);
                  mobilePanelReturnFocusRef.current =
                    mobileReaderMenuTriggerRef.current;
                  setIsNotesDrawerOpen(false);
                  setIsSidebarCollapsed(false);
                }}
              >
                Navigation &amp; annotations
              </button>
              <button
                aria-controls="reader-mobile-notes-panel"
                aria-expanded={isNotesDrawerOpen}
                aria-haspopup="dialog"
                className="reader-mobile-action-child"
                disabled={activeDocumentType !== 'pdf'}
                title={
                  activeDocumentType === 'pdf'
                    ? 'Open Notes and Glossary'
                    : 'Open a PDF to use Notes and Glossary'
                }
                type="button"
                onClick={() => {
                  setIsMobileReaderMenuOpen(false);
                  mobilePanelReturnFocusRef.current =
                    mobileReaderMenuTriggerRef.current;
                  setIsSidebarCollapsed(true);
                  setIsNotesDrawerOpen(true);
                }}
              >
                Notes &amp; Glossary
              </button>
            </div>
          </nav>
          {isCompactReader && (!isSidebarCollapsed || isNotesDrawerOpen) ? (
            <button
              aria-label="Close Reader panel"
              className="reader-mobile-scrim"
              type="button"
              onClick={() => {
                setIsSidebarCollapsed(true);
                setIsNotesDrawerOpen(false);
              }}
            />
          ) : null}
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            isModal={isCompactReader}
            onToggle={() => setIsSidebarCollapsed((isCollapsed) => !isCollapsed)}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            onGoToPage={navigateToPage}
            annotations={annotations}
            notedAnnotationIds={notedAnnotationIds}
            annotationFilter={annotationFilter}
            onAnnotationFilterChange={setAnnotationFilter}
          />
          <Suspense
            fallback={
              <main className="viewer viewer-loading" role="status">
                Opening Reader…
              </main>
            }
          >
            <Viewer
              ref={viewerRef}
              file={activeDocumentType === 'pdf' ? file : null}
              fitMode={fitMode}
              zoom={zoom}
              onOpenFile={openDocument}
              onOpenLibrary={() => openHomeSection('library')}
              onPageCountChange={setPageCount}
              onCurrentPageChange={setCurrentPage}
              onEffectiveZoomChange={updateEffectiveZoom}
              onDocumentReady={hydrateDocument}
              documentId={documentIdentity?.documentId ?? null}
              annotations={annotations}
              documentLinks={documentLinks}
              noteAnchors={noteAnchors}
              notes={notes}
              glossaryEntries={glossaryEntries}
              draggedNoteId={noteDragPreview?.noteId ?? null}
              onAddGlossaryEntry={addGlossaryEntry}
              onRemoveGlossaryEntry={removeGlossaryEntry}
              onCreateHighlights={createHighlights}
              onCreateUnderlines={createUnderlines}
              onCreateLink={createDocumentLink}
              onConnectLink={connectToDocumentLink}
              onCreateLinkFromAnnotation={createDocumentLinkFromAnnotation}
              onConnectLinkFromAnnotation={connectToDocumentLinkFromAnnotation}
              onDeleteLink={removeDocumentLink}
              onRenameLink={renameDocumentLinkName}
              notedAnnotationIds={notedAnnotationIds}
              onAddNoteToAnnotation={addNoteToMarkedAnnotation}
              onUpdateNote={updateNote}
              onCommitNoteEdit={finishNoteEditing}
              onDeleteNote={deleteNote}
              onBeginNoteDrag={beginNoteDrag}
              onOpenLargeEditor={openLargeEditor}
              onDeleteAnnotation={removeMarkedAnnotation}
              onCreateAnnotationFromSource={createAnnotationFromNoteSource}
              annotationPalettes={annotationPalettes}
              onAddCustomAnnotationColor={addCustomReaderAnnotationColor}
              onResetAnnotationPalette={resetAnnotationPalettePreference}
              zoomOperationId={zoomOperationId}
              onFitWidthLayoutChange={beginZoomOperation}
              annotationFilter={annotationFilter}
              onPdfDocumentChange={setPdfDocument}
              onTextSelectionChange={setSelectedPdfText}
              onExplicitNavigation={handleExplicitNavigation}
              onAnnotationNavigationApplied={handleInitialAnnotationNavigationApplied}
              isInteractionDisabled={
                isCompactReader && (!isSidebarCollapsed || isNotesDrawerOpen)
              }
            />
          </Suspense>
          {isAiOpen && file && activeDocumentType ? (
            <Suspense
              fallback={
                <aside className="ai-assistant-panel ai-panel-loading" role="status">
                  Opening AI Assistant...
                </aside>
              }
            >
              <AssistantPanel
                isOpen={isAiOpen}
                document={pdfDocument}
                documentTextSource={null}
                documentId={documentIdentity?.documentId ?? null}
                documentTitle={documentDisplayTitle ?? file.name}
                currentPage={currentPage}
                selectedText={selectedPdfText}
                onClose={() => setIsAiOpen(false)}
                onNavigateToPage={navigateToPage}
                onAddToNote={addAiOutputToNote}
                onSendToPrintDraft={sendAiOutputToPrintDraft}
                onStatusChange={setAiStatus}
                onOpenConfiguration={() => openHomeSection('ai')}
              />
            </Suspense>
          ) : null}
          {activeDocumentType === 'pdf' ? (
            <NotesPanel
              notes={notes}
              glossaryEntries={glossaryEntries}
              documentLinks={documentLinks}
              annotationCount={annotations.length}
              activeDocumentId={documentIdentity?.documentId ?? null}
              isOpen={isNotesDrawerOpen}
              isModal={isCompactReader}
              draggedNoteId={noteDragPreview?.noteId ?? null}
              isExporting={isPdfExporting}
              onToggle={() => setIsNotesDrawerOpen((isOpen) => !isOpen)}
              focusedNoteId={focusedNoteId}
              onFocusComplete={() => setFocusedNoteId(null)}
              onFocusedNoteReady={handleFocusedNoteReady}
              onNavigate={navigateToNote}
              onUpdate={updateNote}
              onUpdateDisplayNumber={updateNoteDisplayNumber}
              onCommitNoteEdit={finishNoteEditing}
              onDelete={deleteNote}
              onNavigateGlossary={navigateToGlossaryEntry}
              onRemoveGlossary={removeGlossaryEntry}
              onNavigateLink={(linkId, endpointId) =>
                viewerRef.current?.navigateToLinkEndpoint(linkId, endpointId) ?? false
              }
              onRenameLink={renameDocumentLinkName}
              onDeleteLink={removeDocumentLink}
              onExportNotes={exportCurrentNotes}
              onEditBeforePrinting={(layout, returnFocusTarget) => {
                if (!documentIdentity || !isDocumentHydrated) return;
                printComposerReturnFocusRef.current = returnFocusTarget ?? null;
                setPrintComposerLayout(layout);
                setIsPrintComposerOpen(true);
              }}
              onBeginNoteDrag={beginNoteDrag}
              onOpenLargeEditor={openLargeEditor}
            />
          ) : null}
        </div>
      </div>
      <HomeWorkspace
        activeSection={homeSection}
        isOpen={applicationView === 'home'}
        onReturnToReader={() => setApplicationView('reader')}
        onSectionChange={(section) => {
          if (section !== 'collections') setCollectionReturnId(null);
          setHomeSection(section);
        }}
      >
        {homeContent}
      </HomeWorkspace>
      {officeConversionRequest ? (
        <Suspense
          fallback={
            <div className="office-converter-overlay" role="status">
              Loading the local converter…
            </div>
          }
        >
          <OfficePdfConverterDialog
            key={officeConversionRequest.requestId}
            initialFile={officeConversionRequest.file}
            onClose={() => setOfficeConversionRequest(null)}
            onImportPdf={openDocument}
          />
        </Suspense>
      ) : null}
      {applicationView === 'reader' ? (
        <>
          <HomeFloatingButton
            onClick={() => openHomeSection(collectionReturnId ? 'collections' : 'home')}
          />
          <Suspense fallback={null}>
            <PaperReaderSyncStatus
              display={resolveReaderStatusIndicatorDisplay(
                readerStatusIndicatorDisplay,
                isCompactReader,
              )}
              onOpenDrive={(affectedDocumentIds) =>
                affectedDocumentIds?.length
                  ? openDriveUpdateReview(affectedDocumentIds)
                  : openDriveManagement()
              }
            />
          </Suspense>
        </>
      ) : null}
      <Suspense fallback={null}>
        <PaperRemoteUpdateLayer
          isReaderActive={applicationView === 'reader'}
          onReviewUpdates={openDriveUpdateReview}
        />
      </Suspense>
      {noteDragPreview && draggedNote ? (
        <div className="note-drop-overlay" aria-hidden="true">
          <div ref={noteDropTargetRef} className="note-drop-target">
            Drop here to open large editor
          </div>
          <article
            ref={noteDragPreviewRef}
            className="note-drag-preview"
            style={{
              width: noteDragPreview.width,
              height: noteDragPreview.height,
              transform: `translate3d(${noteDragPreview.initialX}px, ${noteDragPreview.initialY}px, 0) scale(0.98)`,
            }}
          >
            <blockquote>
              {draggedNote.selectedText || 'Source text unavailable'}
            </blockquote>
            <div className="note-drag-preview-meta">
              <span>{draggedNote.displayNumber}</span>
              <span>Page {draggedNote.pageNumber}</span>
            </div>
            <p>{draggedNote.content || 'Empty note'}</p>
          </article>
        </div>
      ) : null}
      {largeEditorNote ? (
        <LargeNoteEditor
          note={largeEditorNote}
          documentTitle={documentDisplayTitle ?? file?.name ?? '39Note'}
          onClose={() => {
            setLargeEditorNoteId(null);
            if (isNotesDrawerOpen) {
              setFocusedNoteId(largeEditorNote.id);
            }
          }}
          onUpdate={updateNote}
          onUpdateDisplayNumber={updateNoteDisplayNumber}
          onCommitNoteEdit={finishNoteEditing}
        />
      ) : null}
      {isPrintComposerOpen && documentIdentity ? (
        <Suspense
          fallback={
            <div className="print-composer-overlay" role="status">
              Opening Print Composer…
            </div>
          }
        >
          <PrintComposer
            documentId={documentIdentity.documentId}
            documentTitle={documentDisplayTitle ?? file?.name ?? '39Note'}
            notes={notes}
            annotations={annotations}
            noteAnchors={noteAnchors}
            glossaryEntries={glossaryEntries}
            initialLayout={printComposerLayout}
            returnFocusTarget={printComposerReturnFocusRef.current}
            onClose={() => setIsPrintComposerOpen(false)}
          />
        </Suspense>
      ) : null}
      {isAnnotatedPdfDialogOpen ? (
        <AnnotatedPdfExportDialog
          annotationCount={annotations.length}
          visibleAnnotationCount={visibleExportAnnotations.length}
          noteCount={nonEmptyNoteCount}
          visibleNoteCount={visibleNonEmptyNoteCount}
          isExporting={isAnnotatedPdfExporting}
          progress={annotatedPdfProgress}
          error={annotatedPdfError}
          onClose={() => {
            if (!isAnnotatedPdfExporting) {
              setIsAnnotatedPdfDialogOpen(false);
              setAnnotatedPdfError(null);
              setAnnotatedPdfProgress(null);
            }
          }}
          onExport={(options) => {
            void exportAnnotatedPdf(options);
          }}
        />
      ) : null}
      {activeReaderWarning ? (
        <p className="storage-warning" role="status">
          {activeReaderWarning}
        </p>
      ) : null}
      {readingRestoreToast ? (
        <p className="reading-restore-toast" role="status">
          {readingRestoreToast}
        </p>
      ) : null}
    </main>
  );
}

function readerEditableStateFromDocument(state: {
  annotations: PdfAnnotation[];
  documentLinks: DocumentLink[];
  noteAnchors: NoteAnchor[];
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  nextNoteNumber: number;
  nextLinkNumber: number;
}): ReaderEditableState {
  return {
    annotations: state.annotations,
    links: state.documentLinks,
    noteAnchors: state.noteAnchors,
    notes: state.notes,
    glossaryEntries: state.glossaryEntries,
    nextNoteNumber: state.nextNoteNumber,
    nextLinkNumber: state.nextLinkNumber,
  };
}

function getReaderHistoryTextInput(
  target: EventTarget | null,
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const editor = target.closest('[data-reader-history-input="note"]');
  return editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
    ? editor
    : null;
}

function isBlockingDialogTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('[role="dialog"]:not(.annotation-tag)'))
  );
}

function prepareSupportedDocumentFile(
  file: File,
): { file: File; documentType: DocumentType } | null {
  const declaredType = getDocumentTypeForMimeType(file.type);
  if (declaredType) {
    return hasDocumentFileExtension(file.name, declaredType)
      ? { file, documentType: declaredType }
      : null;
  }
  if (file.type && file.type !== 'application/octet-stream') return null;
  const inferredType = (Object.keys(DOCUMENT_MIME_TYPES) as DocumentType[]).find(
    (candidate) => hasDocumentFileExtension(file.name, candidate),
  );
  if (!inferredType) return null;
  return {
    documentType: inferredType,
    file: new File([file], file.name, {
      type: DOCUMENT_MIME_TYPES[inferredType],
      lastModified: file.lastModified,
    }),
  };
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    Boolean(target.closest('input, textarea, [contenteditable="true"]'))
  );
}

async function collectPdfPageGeometries(
  document: PDFDocumentProxy,
): Promise<PdfPageGeometry[]> {
  return Promise.all(
    Array.from({ length: document.numPages }, async (_, index) => {
      const page = await document.getPage(index + 1);
      const [xMin, yMin, xMax, yMax] = page.view;
      if (
        ![xMin, yMin, xMax, yMax, page.userUnit].every(Number.isFinite) ||
        xMax <= xMin ||
        yMax <= yMin ||
        page.userUnit <= 0
      ) {
        throw new Error(`Page ${index + 1} has unsupported PDF geometry.`);
      }
      return {
        viewBox: [xMin, yMin, xMax, yMax],
        userUnit: page.userUnit,
        rotation: normalizePdfRotation(page.rotate),
      };
    }),
  );
}

function downloadAnnotatedPdf(bytes: Uint8Array, filename: string): void {
  const copiedBytes = new Uint8Array(bytes);
  const blob = new Blob([copiedBytes.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
