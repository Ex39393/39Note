import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { Viewer, type ViewerHandle } from './Viewer';
import { NotesPanel } from './NotesPanel';
import { LargeNoteEditor } from './LargeNoteEditor';
import { WebLocalDataNotice } from './WebLocalDataNotice';
import { AnnotatedPdfExportDialog } from './AnnotatedPdfExportDialog';
import type { AnnotationFilterState } from './pdf/AnnotationFilterControl';
import type {
  AnnotationType,
  HighlightColor,
  PdfAnnotation,
  UnderlineColor,
} from '../types/highlight';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import type {
  DefinitionBubble,
  DictionaryDefinition,
  GlossaryEntry,
  NotesPrintLayout,
} from '../types/glossary';
import type {
  AnnotatedPdfExportOptions,
  AnnotatedPdfExportProgress,
  PdfPageGeometry,
} from '../types/annotatedPdfExport';
import type { DocumentIdentity } from '../types/persistence';
import type { PdfTextSelection } from '../types/textSelection';
import type { PrintDraftAddition } from '../types/productivity';
import type {
  DocumentOpenRequest,
  DocumentOpenSource,
  DocumentOpenTarget,
} from '../types/documentOpen';
import type { ReadingPosition } from '../types/library';
import {
  createNoteAnchorFromAnnotation,
  createNoteAnchorFromSelection,
  findMatchingNote,
  findMatchingNoteForSources,
} from '../utils/annotationOverlap';
import {
  deleteDocumentState,
  deleteDocumentStates,
  loadStoredPdfFile,
  loadDocumentState,
  removeStoredPdfCopy,
  saveDocumentState,
  saveReadingPosition,
  storePdfFile,
  updateDocumentDisplayTitle,
  updateDocumentOrganization,
} from '../services/annotationPersistence';
import {
  createHighlightsFromSelections,
  createUnderlinesFromSelections,
  createAnnotationFromSource,
  addAnnotationFromSourceIfMissing,
  upsertAnnotations,
} from '../utils/highlights';
import { exportNotesAsPdf } from '../utils/noteExport';
import {
  resolveInitialNavigation,
  type AnnotationLookupState,
  type InitialNavigationDecision,
} from '../utils/initialNavigation';
import { logNavigationDiagnostic } from '../utils/navigationDiagnostics';
import { normalizePdfRotation } from '../utils/annotatedPdfExportModel';
import { selectAnnotationsForExport } from '../utils/annotatedPdfExportSelection';
import {
  createGlossaryEntryFromBubble,
  removeGlossaryEntry as removeGlossaryEntryFromState,
} from '../utils/glossary';
import {
  appendPrintDraftAddition,
  deleteProductivityDocumentData,
} from '../services/productivityPersistence';

const LibraryPanel = lazy(() =>
  import('./LibraryPanel').then((module) => ({ default: module.LibraryPanel })),
);
const PrintComposer = lazy(() =>
  import('../print/PrintComposer').then((module) => ({ default: module.PrintComposer })),
);
const AssistantPanel = lazy(() =>
  import('../ai/AssistantPanel').then((module) => ({ default: module.AssistantPanel })),
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
}

export function AppLayout() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(
    () => sessionStorage.getItem('39note.reader-tools-open') === 'false',
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const storedWidth = Number(sessionStorage.getItem('39note.sidebar-width'));
    return Number.isFinite(storedWidth) && storedWidth >= 240 && storedWidth <= 520
      ? storedWidth
      : 300;
  });
  const [file, setFile] = useState<File | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>('width');
  const [zoom, setZoom] = useState(1);
  const [effectiveZoom, setEffectiveZoom] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [noteAnchors, setNoteAnchors] = useState<NoteAnchor[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [glossaryEntries, setGlossaryEntries] = useState<GlossaryEntry[]>([]);
  const [nextNoteNumber, setNextNoteNumber] = useState(1);
  const [documentIdentity, setDocumentIdentity] = useState<DocumentIdentity | null>(
    null,
  );
  const [documentDisplayTitle, setDocumentDisplayTitle] = useState<string | null>(null);
  const [isDocumentHydrated, setIsDocumentHydrated] = useState(false);
  const [focusedNoteId, setFocusedNoteId] = useState<string | null>(null);
  const [isNotesDrawerOpen, setIsNotesDrawerOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryRefreshToken, setLibraryRefreshToken] = useState(0);
  const [librarySearchFocusRequestId, setLibrarySearchFocusRequestId] = useState(0);
  const [openFileRequestId, setOpenFileRequestId] = useState(0);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
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
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiStatus, setAiStatus] = useState<
    'disconnected' | 'connected' | 'generating'
  >('disconnected');
  const [readingRestoreToast, setReadingRestoreToast] = useState<string | null>(null);
  const [annotationFilter, setAnnotationFilter] = useState<AnnotationFilterState>({
    types: ['highlight', 'underline'],
    noteStatus: 'all',
    colors: [],
  });
  const readingRestoreToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const viewerRef = useRef<ViewerHandle>(null);
  const zoomOperationRef = useRef(0);
  const hydrationRequestRef = useRef(0);
  const documentGenerationRef = useRef(0);
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
  const readingPositionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNavigationDiagnosticKeyRef = useRef<string | null>(null);
  const noteDropTargetRef = useRef<HTMLDivElement>(null);
  const noteDragPreviewRef = useRef<HTMLDivElement>(null);
  const noteDragFrameRef = useRef<number | null>(null);
  const noteDragPositionRef = useRef({ x: 0, y: 0 });
  const pdfExportCleanupRef = useRef<(() => void) | null>(null);
  const documentStateRef = useRef({
    documentIdentity,
    annotations,
    noteAnchors,
    notes,
    glossaryEntries,
    nextNoteNumber,
    documentDisplayTitle,
    isDocumentHydrated,
  });

  documentStateRef.current = {
    documentIdentity,
    annotations,
    noteAnchors,
    notes,
    glossaryEntries,
    nextNoteNumber,
    documentDisplayTitle,
    isDocumentHydrated,
  };

  const commitDocumentOpenRequest = useCallback(
    (request: DocumentOpenRequest | null) => {
      documentOpenRequestRef.current = request;
      setDocumentOpenRequestState(request);
    },
    [],
  );

  const persistCurrentDocument = useCallback(async (): Promise<boolean> => {
    const currentState = documentStateRef.current;
    if (!currentState.documentIdentity || !currentState.isDocumentHydrated) {
      return false;
    }

    const wasSaved = await saveDocumentState(
      currentState.documentIdentity,
      currentState.annotations,
      currentState.noteAnchors,
      currentState.notes,
      currentState.glossaryEntries,
      currentState.nextNoteNumber,
      currentState.documentDisplayTitle ?? currentState.documentIdentity.documentName,
    );
    if (wasSaved) {
      setLibraryRefreshToken((currentToken) => currentToken + 1);
    }
    return wasSaved;
  }, []);

  const flushPersistence = useCallback(async (): Promise<boolean> => {
    if (persistenceTimerRef.current !== null) {
      clearTimeout(persistenceTimerRef.current);
      persistenceTimerRef.current = null;
    }

    return persistCurrentDocument();
  }, [persistCurrentDocument]);

  useEffect(() => {
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
    noteAnchors,
    documentIdentity,
    isDocumentHydrated,
    notes,
    glossaryEntries,
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
    sessionStorage.setItem('39note.reader-tools-open', String(!isSidebarCollapsed));
  }, [isSidebarCollapsed]);

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
    (nextFile: File, requestedOpen?: DocumentOpenRequest) => {
      void flushPersistence();
      hydrationRequestRef.current += 1;
      documentGenerationRef.current += 1;
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
      setFile(nextFile);
      setPdfDocument(null);
      setFitMode('width');
      setZoom(1);
      setEffectiveZoom(1);
      setPageCount(0);
      setCurrentPage(0);
      setAnnotations([]);
      setNoteAnchors([]);
      setAnnotationFilter({
        types: ['highlight', 'underline'],
        noteStatus: 'all',
        colors: [],
      });
      setNotes([]);
      setGlossaryEntries([]);
      setNextNoteNumber(1);
      setDocumentIdentity(null);
      setDocumentDisplayTitle(nextFile.name);
      setIsDocumentHydrated(false);
      setFocusedNoteId(null);
      setNoteDragPreview(null);
      setLargeEditorNoteId(null);
      setSelectedPdfText([]);
      setIsPrintComposerOpen(false);
      setExportWarning(null);
      setIsLibraryOpen(false);
    },
    [commitDocumentOpenRequest, createDocumentOpenRequest, flushPersistence],
  );

  const hydrateDocument = useCallback(
    (identity: DocumentIdentity, sourceFile: File) => {
      const requestId = hydrationRequestRef.current + 1;
      hydrationRequestRef.current = requestId;
      const generation = documentGenerationRef.current;
      const currentOpenRequest = documentOpenRequestRef.current;
      if (currentOpenRequest && currentOpenRequest.generation === generation) {
        if (
          currentOpenRequest.documentId &&
          currentOpenRequest.documentId !== identity.documentId
        ) {
          setStorageWarning(
            'The selected PDF does not match the requested Library document.',
          );
          return;
        }
        if (!currentOpenRequest.documentId) {
          commitDocumentOpenRequest({
            ...currentOpenRequest,
            documentId: identity.documentId,
          });
        }
      }

      setDocumentIdentity(identity);
      setDocumentDisplayTitle(identity.documentName);
      setIsDocumentHydrated(false);
      setAnnotations([]);
      setNoteAnchors([]);
      setNotes([]);
      setGlossaryEntries([]);
      setFocusedNoteId(null);

      void storePdfFile(identity, sourceFile).then((wasStored) => {
        if (wasStored) {
          setStorageWarning(null);
          setLibraryRefreshToken((currentToken) => currentToken + 1);
        } else {
          setStorageWarning(
            'The PDF copy could not be saved locally. Reading and annotations remain available.',
          );
        }
      });

      void loadDocumentState(identity.documentId).then((persistedState) => {
        if (
          hydrationRequestRef.current !== requestId ||
          documentGenerationRef.current !== generation
        ) {
          return;
        }

        setAnnotations(persistedState?.annotations ?? []);
        setNoteAnchors(persistedState?.noteAnchors ?? []);
        setNotes(persistedState?.notes ?? []);
        setGlossaryEntries(persistedState?.glossaryEntries ?? []);
        hydratedReadingPositionRef.current = persistedState?.readingPosition ?? null;
        setNextNoteNumber(persistedState?.nextNoteNumber ?? 1);
        setDocumentDisplayTitle(persistedState?.displayTitle ?? identity.documentName);
        setIsDocumentHydrated(true);
      });
    },
    [commitDocumentOpenRequest],
  );

  useEffect(() => {
    if (
      !documentIdentity ||
      !isDocumentHydrated ||
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
  }, [currentPage, documentIdentity, effectiveZoom, fitMode, isDocumentHydrated]);

  const createHighlights = useCallback(
    (selections: PdfTextSelection[], color: HighlightColor) => {
      if (!isDocumentHydrated) {
        return;
      }

      const nextHighlights = createHighlightsFromSelections(selections, color);
      setAnnotations((currentAnnotations) =>
        upsertAnnotations(currentAnnotations, nextHighlights),
      );
    },
    [isDocumentHydrated],
  );

  const createUnderlines = useCallback(
    (selections: PdfTextSelection[], color: UnderlineColor) => {
      if (!isDocumentHydrated) {
        return;
      }

      const nextUnderlines = createUnderlinesFromSelections(selections, color);
      setAnnotations((currentAnnotations) =>
        upsertAnnotations(currentAnnotations, nextUnderlines),
      );
    },
    [isDocumentHydrated],
  );

  const removeAnnotation = useCallback((annotationId: string) => {
    const annotation = annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation) return;
    const linkedNotes = notes.filter((note) => note.annotationId === annotationId);
    if (linkedNotes.length > 0) {
      const anchor = createNoteAnchorFromAnnotation(annotation);
      setNoteAnchors((currentAnchors) => [...currentAnchors, anchor]);
      setNotes((currentNotes) =>
        currentNotes.map((note) =>
          note.annotationId === annotationId
            ? { ...note, annotationId: anchor.id, updatedAt: Date.now() }
            : note,
        ),
      );
    }
    setAnnotations((currentAnnotations) =>
      currentAnnotations.filter((candidate) => candidate.id !== annotationId),
    );
  }, [annotations, notes]);

  const addNoteFromSelection = useCallback(
    (selections: PdfTextSelection[]) => {
      if (!isDocumentHydrated) {
        return;
      }

      const existingNote = findMatchingNote(
        selections,
        notes,
        annotations,
        noteAnchors,
      );
      if (existingNote) {
        setFocusedNoteId(existingNote.id);
        setIsNotesDrawerOpen(true);
        viewerRef.current?.navigateToAnnotation(existingNote.annotationId);
        return;
      }

      const anchor = selections.flatMap((selection) => {
        const nextAnchor = createNoteAnchorFromSelection(selection);
        return nextAnchor ? [nextAnchor] : [];
      })[0];
      if (!anchor) return;

      const timestamp = Date.now();
      const note: Note = {
        id: crypto.randomUUID(),
        annotationId: anchor.id,
        pageNumber: anchor.pageNumber,
        displayNumber: String(nextNoteNumber),
        selectedText: anchor.text,
        content: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      setNoteAnchors((currentAnchors) => [...currentAnchors, anchor]);
      setNotes((currentNotes) => [note, ...currentNotes]);
      setNextNoteNumber((currentNumber) => currentNumber + 1);
      setFocusedNoteId(note.id);
      setIsNotesDrawerOpen(true);
    },
    [annotations, isDocumentHydrated, nextNoteNumber, noteAnchors, notes],
  );

  const addNoteFromMarkedSource = useCallback(
    (sourceAnnotations: PdfAnnotation[]) => {
      if (!isDocumentHydrated || sourceAnnotations.length === 0) return;
      const existingNote = findMatchingNoteForSources(
        sourceAnnotations,
        notes,
        annotations,
        noteAnchors,
      );
      if (existingNote) {
        setFocusedNoteId(existingNote.id);
        setIsNotesDrawerOpen(true);
        viewerRef.current?.navigateToAnnotation(existingNote.annotationId);
        return;
      }
      const source = sourceAnnotations[0];
      const anchor = createNoteAnchorFromAnnotation(source);
      const timestamp = Date.now();
      const note: Note = {
        id: crypto.randomUUID(),
        annotationId: anchor.id,
        pageNumber: anchor.pageNumber,
        displayNumber: String(nextNoteNumber),
        selectedText: anchor.text,
        content: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setNoteAnchors((currentAnchors) => [...currentAnchors, anchor]);
      setNotes((currentNotes) => [note, ...currentNotes]);
      setNextNoteNumber((currentNumber) => currentNumber + 1);
      setFocusedNoteId(note.id);
      setIsNotesDrawerOpen(true);
    },
    [annotations, isDocumentHydrated, nextNoteNumber, noteAnchors, notes],
  );

  const createAnnotationFromNoteSource = useCallback(
    (
      source: PdfAnnotation | NoteAnchor,
      type: AnnotationType,
      color: HighlightColor | UnderlineColor,
    ) => {
      if (!isDocumentHydrated) return;
      const nextAnnotation = type === 'highlight'
        ? createAnnotationFromSource(source, type, color as HighlightColor)
        : createAnnotationFromSource(source, type, color as UnderlineColor);
      if (!nextAnnotation) return;
      setAnnotations((currentAnnotations) =>
        addAnnotationFromSourceIfMissing(currentAnnotations, nextAnnotation),
      );
    },
    [isDocumentHydrated],
  );

  const updateNote = useCallback((noteId: string, content: string) => {
    setNotes((currentNotes) =>
      currentNotes.map((note) =>
        note.id === noteId ? { ...note, content, updatedAt: Date.now() } : note,
      ),
    );
  }, []);

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
        displayNumber: String(nextNoteNumber),
        selectedText: selectedAnchor?.text ?? 'AI Assistant response',
        content: content.trim(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      setNoteAnchors((current) => [...current, anchor]);
      setNotes((current) => [note, ...current]);
      setNextNoteNumber((current) => current + 1);
      setFocusedNoteId(note.id);
      setIsNotesDrawerOpen(true);
    }, [currentPage, documentIdentity, isDocumentHydrated, nextNoteNumber, selectedPdfText],
  );

  const sendAiOutputToPrintDraft = useCallback(
    async (addition: PrintDraftAddition): Promise<boolean> => {
      if (!documentIdentity) return false;
      return appendPrintDraftAddition(documentIdentity.documentId, addition);
    },
    [documentIdentity],
  );

  const deleteNote = useCallback((noteId: string) => {
    const note = notes.find((candidate) => candidate.id === noteId);
    if (!note) return;
    setNotes((currentNotes) => currentNotes.filter((candidate) => candidate.id !== noteId));
    if (
      noteAnchors.some((anchor) => anchor.id === note.annotationId) &&
      !notes.some(
        (candidate) =>
          candidate.id !== noteId && candidate.annotationId === note.annotationId,
      )
    ) {
      setNoteAnchors((currentAnchors) =>
        currentAnchors.filter((anchor) => anchor.id !== note.annotationId),
      );
    }
  }, [noteAnchors, notes]);

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
      setGlossaryEntries((currentEntries) => [...currentEntries, entry]);
      return entry;
    },
    [documentIdentity, isDocumentHydrated],
  );

  const removeGlossaryEntry = useCallback((glossaryEntryId: string) => {
    setGlossaryEntries((currentEntries) => {
      const result = removeGlossaryEntryFromState(
        currentEntries,
        documentStateRef.current.annotations,
        glossaryEntryId,
      );
      return result.entries;
    });
    window.setTimeout(() => void flushPersistence(), 0);
  }, [flushPersistence]);

  const navigateToGlossaryEntry = useCallback((entry: GlossaryEntry) => {
    if (
      !documentIdentity ||
      !isDocumentHydrated ||
      entry.documentId !== documentIdentity.documentId
    ) {
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
  }, [commitDocumentOpenRequest, createDocumentOpenRequest, documentIdentity, isDocumentHydrated]);

  const updateNoteDisplayNumber = useCallback(
    (noteId: string, displayNumber: string) => {
      setNotes((currentNotes) =>
        currentNotes.map((note) =>
          note.id === noteId ? { ...note, displayNumber, updatedAt: Date.now() } : note,
        ),
      );
    },
    [],
  );

  const exportCurrentNotes = useCallback((layout: NotesPrintLayout) => {
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
  }, [annotations, documentDisplayTitle, file, glossaryEntries, isPdfExporting, noteAnchors, notes]);

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

  const beginNoteDrag = useCallback(
    (note: Note, event: ReactPointerEvent<HTMLButtonElement>) => {
      const noteCard = event.currentTarget.closest<HTMLElement>('.note-card');
      if (!noteCard) {
        return;
      }

      const rectangle = noteCard.getBoundingClientRect();
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
      });
    },
    [],
  );

  const openLargeEditor = useCallback((note: Note) => {
    setNoteDragPreview(null);
    setLargeEditorNoteId(note.id);
    setIsNotesDrawerOpen(true);
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
          setIsNotesDrawerOpen(true);
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

  const openLibrary = useCallback(() => {
    void flushPersistence().then(() => {
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      setIsLibraryOpen(true);
    });
  }, [flushPersistence]);

  const openLibrarySearch = useCallback(() => {
    void flushPersistence().then(() => {
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      setLibrarySearchFocusRequestId((currentRequest) => currentRequest + 1);
      setIsLibraryOpen(true);
    });
  }, [flushPersistence]);

  useEffect(() => {
    const handleShortcuts = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) {
        return;
      }

      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLocaleLowerCase();

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

      if (!modifier && !event.altKey && key === 'n') {
        event.preventDefault();
        setIsNotesDrawerOpen((isOpen) => !isOpen);
      }
    };

    window.addEventListener('keydown', handleShortcuts);
    return () => window.removeEventListener('keydown', handleShortcuts);
  }, [file, openLibrarySearch]);

  const forgetDocument = useCallback(
    async (documentId: string): Promise<boolean> => {
      await flushPersistence();
      const wasForgotten = await deleteDocumentState(documentId);
      if (!wasForgotten) {
        return false;
      }
      await deleteProductivityDocumentData(documentId);

      if (documentIdentity?.documentId === documentId) {
        hydrationRequestRef.current += 1;
        storedPdfLoadRequestRef.current += 1;
        setFile(null);
        setPageCount(0);
        setCurrentPage(0);
        setAnnotations([]);
        setNotes([]);
        setGlossaryEntries([]);
        setNextNoteNumber(1);
        setDocumentIdentity(null);
        setDocumentDisplayTitle(null);
        setIsDocumentHydrated(false);
        setFocusedNoteId(null);
        setNoteDragPreview(null);
        setLargeEditorNoteId(null);
        setExportWarning(null);
        setIsLibraryOpen(true);
      }

      return true;
    },
    [documentIdentity, flushPersistence],
  );

  const forgetLibraryDocuments = useCallback(
    async (ids: string[]): Promise<{ deleted: string[]; failed: string[] }> => {
      await flushPersistence();
      const result = await deleteDocumentStates(ids);
      await Promise.all(result.deleted.map(deleteProductivityDocumentData));
      if (documentIdentity && result.deleted.includes(documentIdentity.documentId)) {
        setFile(null);
        setDocumentIdentity(null);
        setAnnotations([]);
        setNotes([]);
        setGlossaryEntries([]);
        setPageCount(0);
        setCurrentPage(0);
        setIsDocumentHydrated(false);
        setIsLibraryOpen(true);
      }
      setLibraryRefreshToken((currentToken) => currentToken + 1);
      return result;
    },
    [documentIdentity, flushPersistence],
  );

  const removeLibraryPdfCopy = useCallback(
    async (documentId: string): Promise<boolean> => {
      await flushPersistence();
      const wasRemoved = await removeStoredPdfCopy(documentId);
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
      const storedPdfFile = await loadStoredPdfFile(documentId);

      if (!storedPdfFile || storedPdfLoadRequestRef.current !== requestId) {
        return null;
      }

      return new File([storedPdfFile.blob], storedPdfFile.fileName, {
        type: storedPdfFile.mimeType,
        lastModified: storedPdfFile.lastModified,
      });
    },
    [],
  );

  const openStoredDocument = useCallback(
    async (documentId: string): Promise<boolean> => {
      const storedDocumentFile = await getStoredDocumentFile(documentId);
      if (!storedDocumentFile) {
        return false;
      }

      openDocument(
        storedDocumentFile,
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

      openDocument(storedDocumentFile, openRequest);
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
      openDocument(fileToOpen, openRequest);
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
    const targetAnnotation =
      target?.type === 'annotation'
        ? [...annotations, ...noteAnchors].find(
            (candidate) => candidate.id === target.annotationId,
          )
        : undefined;
    const targetNote =
      target?.type === 'annotation' && target.noteId
        ? notes.find((candidate) => candidate.id === target.noteId)
        : undefined;
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
              (targetNote && targetNote.annotationId === targetAnnotation.id))
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
      const readyNavigation = { ...pendingNavigation, isReadyToFocus: true };
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
        annotationId: decision.annotationId,
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

      const pendingNavigation: PendingLibraryNavigation = {
        documentId: documentIdentity.documentId,
        noteId: note.id,
        annotationId: note.annotationId,
        isReadyToFocus: false,
      };
      const request = {
        ...createDocumentOpenRequest(documentIdentity.documentId, 'document-note', {
          type: 'annotation',
          annotationId: note.annotationId,
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
      documentIdentity,
      isDocumentHydrated,
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

  const beginZoomOperation = () => {
    const nextOperationId = zoomOperationRef.current + 1;
    zoomOperationRef.current = nextOperationId;
    viewerRef.current?.captureZoomAnchor(nextOperationId);
    setZoomOperationId(nextOperationId);
  };

  const zoomIn = () => {
    beginZoomOperation();
    setFitMode(null);
    setZoom((currentZoom) => Math.min(currentZoom * 1.2, 5));
  };

  const zoomOut = () => {
    beginZoomOperation();
    setFitMode(null);
    setZoom((currentZoom) => Math.max(currentZoom / 1.2, 0.25));
  };

  const applyZoom = (nextZoom: number) => {
    beginZoomOperation();
    setFitMode(null);
    setZoom(nextZoom);
    setEffectiveZoom(nextZoom);
  };

  const largeEditorNote = largeEditorNoteId
    ? (notes.find((candidate) => candidate.id === largeEditorNoteId) ?? null)
    : null;
  const draggedNote = noteDragPreview
    ? (notes.find((candidate) => candidate.id === noteDragPreview.noteId) ?? null)
    : null;
  const visibleExportAnnotations = selectAnnotationsForExport(
    annotations,
    notes,
    annotationFilter,
    false,
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
      (visibleAnnotationIds.has(note.annotationId) || noteAnchorIds.has(note.annotationId)),
  ).length;

  return (
    <main className={`app-layout ${isSidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
      <Toolbar
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
        onOpenLibrary={openLibrary}
        onExportAnnotatedPdf={() => {
          setAnnotatedPdfError(null);
          setAnnotatedPdfProgress(null);
          setIsAnnotatedPdfDialogOpen(true);
        }}
        isAnnotatedPdfExporting={isAnnotatedPdfExporting}
        hasDocument={Boolean(file)}
        pageCount={pageCount}
        currentPage={currentPage}
        documentTitle={documentDisplayTitle ?? file?.name ?? 'No document opened'}
        effectiveZoom={effectiveZoom}
        isAiOpen={isAiOpen}
        aiStatus={aiStatus}
        onToggleAi={() => setIsAiOpen((open) => !open)}
      />
      <WebLocalDataNotice />
      <div className="app-content">
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          onToggle={() => setIsSidebarCollapsed((isCollapsed) => !isCollapsed)}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          pdfDocument={pdfDocument}
          currentPage={currentPage}
          onGoToPage={navigateToPage}
          annotations={annotations}
          notedAnnotationIds={notes.map((note) => note.annotationId)}
          annotationFilter={annotationFilter}
          onAnnotationFilterChange={setAnnotationFilter}
        />
        <Viewer
          ref={viewerRef}
          file={file}
          fitMode={fitMode}
          zoom={zoom}
          onOpenFile={openDocument}
          onPageCountChange={setPageCount}
          onCurrentPageChange={setCurrentPage}
          onEffectiveZoomChange={setEffectiveZoom}
          onDocumentReady={hydrateDocument}
          documentId={documentIdentity?.documentId ?? null}
          annotations={annotations}
          noteAnchors={noteAnchors}
          notes={notes}
          glossaryEntries={glossaryEntries}
          onAddGlossaryEntry={addGlossaryEntry}
          onCreateHighlights={createHighlights}
          onCreateUnderlines={createUnderlines}
          onRemoveAnnotation={removeAnnotation}
          notedAnnotationIds={notes.map((note) => note.annotationId)}
          onAddNote={addNoteFromSelection}
          onAnnotationTap={addNoteFromMarkedSource}
          onCreateAnnotationFromSource={createAnnotationFromNoteSource}
          zoomOperationId={zoomOperationId}
          annotationFilter={annotationFilter}
          onPdfDocumentChange={setPdfDocument}
          onTextSelectionChange={setSelectedPdfText}
          onExplicitNavigation={handleExplicitNavigation}
          onAnnotationNavigationApplied={handleInitialAnnotationNavigationApplied}
        />
        {isAiOpen && file ? (
          <Suspense
            fallback={<aside className="ai-assistant-panel ai-panel-loading" role="status">Opening AI Assistant...</aside>}
          >
            <AssistantPanel
              isOpen={isAiOpen}
              document={pdfDocument}
              documentId={documentIdentity?.documentId ?? null}
              documentTitle={documentDisplayTitle ?? file.name}
              currentPage={currentPage}
              selectedText={selectedPdfText}
              onClose={() => setIsAiOpen(false)}
              onNavigateToPage={navigateToPage}
              onAddToNote={addAiOutputToNote}
              onSendToPrintDraft={sendAiOutputToPrintDraft}
              onStatusChange={setAiStatus}
            />
          </Suspense>
        ) : null}
        <NotesPanel
          notes={notes}
          glossaryEntries={glossaryEntries}
          annotationCount={annotations.length}
          isOpen={isNotesDrawerOpen}
          draggedNoteId={noteDragPreview?.noteId ?? null}
          isExporting={isPdfExporting}
          onToggle={() => setIsNotesDrawerOpen((isOpen) => !isOpen)}
          focusedNoteId={focusedNoteId}
          onFocusComplete={() => setFocusedNoteId(null)}
          onFocusedNoteReady={handleFocusedNoteReady}
          onNavigate={navigateToNote}
          onUpdate={updateNote}
          onUpdateDisplayNumber={updateNoteDisplayNumber}
          onDelete={deleteNote}
          onNavigateGlossary={navigateToGlossaryEntry}
          onRemoveGlossary={removeGlossaryEntry}
          onExportNotes={exportCurrentNotes}
          onEditBeforePrinting={(layout) => {
            if (!documentIdentity || !isDocumentHydrated) return;
            setPrintComposerLayout(layout);
            setIsPrintComposerOpen(true);
          }}
          onBeginNoteDrag={beginNoteDrag}
          onOpenLargeEditor={openLargeEditor}
        />
      </div>
      {isLibraryOpen ? (
        <Suspense
          fallback={
            <div className="library-loading" role="status">
              Opening Library…
            </div>
          }
        >
          <LibraryPanel
            isOpen={isLibraryOpen}
            refreshToken={libraryRefreshToken}
            onClose={() => setIsLibraryOpen(false)}
            onForget={forgetDocument}
            onOpenFile={openDocument}
            onOpenStoredPdf={openStoredDocument}
            onOpenLibraryNote={openLibraryNote}
            onSelectPdfForLibraryNote={selectPdfForLibraryNote}
            onRenameDocument={renameLibraryDocument}
            onRemovePdfCopy={removeLibraryPdfCopy}
            focusSearchRequestId={librarySearchFocusRequestId}
            onPinDocument={updateLibraryOrganization}
            onForgetMany={forgetLibraryDocuments}
            onUpdateOrganization={(documentId, update) =>
              updateDocumentOrganization([documentId], update)
            }
          />
        </Suspense>
      ) : null}
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
            setFocusedNoteId(largeEditorNote.id);
            setIsNotesDrawerOpen(true);
          }}
          onUpdate={updateNote}
          onUpdateDisplayNumber={updateNoteDisplayNumber}
        />
      ) : null}
      {isPrintComposerOpen && documentIdentity ? (
        <Suspense
          fallback={<div className="print-composer-overlay" role="status">Opening Print Composer…</div>}
        >
          <PrintComposer
            documentId={documentIdentity.documentId}
            documentTitle={documentDisplayTitle ?? file?.name ?? '39Note'}
            notes={notes}
            annotations={annotations}
            noteAnchors={noteAnchors}
            glossaryEntries={glossaryEntries}
            initialLayout={printComposerLayout}
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
      {storageWarning || exportWarning ? (
        <p className="storage-warning" role="status">
          {exportWarning ?? storageWarning}
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
