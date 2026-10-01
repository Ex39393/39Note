import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist/build/pdf.mjs';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useElementSize } from '../hooks/useElementSize';
import { useReaderOcclusionInsets } from '../hooks/useReaderOcclusionInsets';
import { usePdfSearch } from '../hooks/usePdfSearch';
import { usePdfTextSelection } from '../hooks/usePdfTextSelection';
import type {
  AnnotationType,
  HighlightColor,
  PdfAnnotation,
  UnderlineColor,
} from '../types/highlight';
import type { DocumentIdentity } from '../types/persistence';
import type { ReadingPosition } from '../types/library';
import type { PdfTextSelection } from '../types/textSelection';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import {
  isPdfGlossaryEntry,
  type DefinitionBubble,
  type DictionaryDefinition,
  type GlossaryEntry,
  type PdfGlossaryEntry,
} from '../types/glossary';
import { resolveDocumentIdentity } from '../utils/documentIdentity';
import {
  describePdfOpenFailure,
  type PdfOpenFailurePresentation,
} from '../utils/pdfOpenError';
import {
  createPdfDocumentInitParameters,
  resolvedPdfJsWasmUrl,
} from '../utils/pdfJsAssets';
import { PdfPage } from './pdf/PdfPage';
import { PdfSearchBar, type PdfSearchPanelPosition } from './pdf/PdfSearchBar';
import type { AnnotationFilterState } from './pdf/AnnotationFilterControl';
import { matchesAnnotationFilter } from '../utils/annotationFilter';
import { logNavigationDiagnostic } from '../utils/navigationDiagnostics';
import { SelectionAction } from './pdf/SelectionAction';
import { AnnotationTag } from './pdf/AnnotationTag';
import type { NoteDragStartHandler } from './NoteDragHandle';
import {
  getDictionaryLookupSelection,
  mergeDictionaryDefinitions,
  moveDefinitionUp,
} from '../utils/dictionary';
import { normalizeSelectionRectangles } from '../utils/highlights';
import { isSameLogicalPdfSource } from '../utils/pdfSourceGeometry';
import { markDefinitionBubbleAdded } from '../utils/glossary';
import { deriveAnnotationTags } from '../utils/annotationTags';
import {
  createReaderContextCandidates,
  getReaderContextCandidateKey,
  removeReaderContextCandidate,
  type ReaderContextCandidateReference,
} from '../utils/readerContextCandidates';
import {
  isSimpleAnnotationTap,
  type AnnotationPointerStart,
} from '../utils/annotationInteraction';

GlobalWorkerOptions.workerSrc = pdfWorker;

type FitMode = 'width' | 'page' | null;

interface ViewerProps {
  file: File | null;
  fitMode: FitMode;
  zoom: number;
  onOpenFile: (file: File) => void;
  onPageCountChange: (pageCount: number) => void;
  onCurrentPageChange: (pageNumber: number) => void;
  onEffectiveZoomChange: (zoom: number) => void;
  onDocumentReady: (identity: DocumentIdentity, file: File) => void;
  documentId: string | null;
  onTextSelectionChange?: (selection: PdfTextSelection[]) => void;
  annotations: PdfAnnotation[];
  noteAnchors: NoteAnchor[];
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  draggedNoteId: string | null;
  onAddGlossaryEntry: (
    bubble: DefinitionBubble,
    preferredDefinition: DictionaryDefinition,
  ) => GlossaryEntry | null;
  onRemoveGlossaryEntry: (glossaryEntryId: string) => boolean;
  onCreateHighlights: (selections: PdfTextSelection[], color: HighlightColor) => void;
  onCreateUnderlines: (selections: PdfTextSelection[], color: UnderlineColor) => void;
  notedAnnotationIds: string[];
  onAddNoteToAnnotation: (annotationId: string) => void;
  onUpdateNote: (noteId: string, content: string) => void;
  onDeleteNote: (noteId: string) => void;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
  onDeleteAnnotation: (annotationId: string, confirmed: boolean) => void;
  onCreateAnnotationFromSource: (
    source: PdfAnnotation | NoteAnchor,
    type: AnnotationType,
    color: HighlightColor | UnderlineColor,
  ) => void;
  zoomOperationId: number;
  onFitWidthLayoutChange: () => void;
  onSearchStateChange?: (state: PdfSearchToolbarState) => void;
  annotationFilter: AnnotationFilterState;
  onPdfDocumentChange?: (document: PDFDocumentProxy | null) => void;
  onExplicitNavigation?: () => void;
  onAnnotationNavigationApplied?: (annotationId: string) => void;
}

export interface PdfSearchToolbarState {
  isOpen: boolean;
  isIndexing: boolean;
  indexedPageCount: number;
  query: string;
  resultCount: number;
  activeResultIndex: number;
}

export interface ViewerHandle {
  captureZoomAnchor: (operationId: number) => void;
  navigateToAnnotation: (
    annotationId: string,
    options?: { showSourceActions?: boolean },
  ) => boolean;
  navigateToGlossaryEntry: (glossaryEntryId: string) => boolean;
  goToPage: (pageNumber: number) => void;
  openSearch: () => void;
  closeSearch: () => void;
  captureReadingPosition: () => ReadingPosition | null;
  restoreReadingPosition: (position: ReadingPosition, onApplied?: () => void) => void;
  getNavigationEpoch: () => number;
  setSearchQuery: (query: string) => void;
  goToPreviousSearchResult: () => void;
  goToNextSearchResult: () => void;
}

interface ZoomAnchor {
  operationId: number;
  pageNumber: number;
  centreOffset: number;
}

interface PendingReadingRestore {
  position: ReadingPosition;
  navigationEpoch: number;
  onApplied?: () => void;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(
  {
    file,
    fitMode,
    zoom,
    onOpenFile,
    onPageCountChange,
    onCurrentPageChange,
    onEffectiveZoomChange,
    onDocumentReady,
    documentId,
    onTextSelectionChange,
    annotations,
    noteAnchors,
    notes,
    glossaryEntries,
    draggedNoteId,
    onAddGlossaryEntry,
    onRemoveGlossaryEntry,
    onCreateHighlights,
    onCreateUnderlines,
    notedAnnotationIds,
    onAddNoteToAnnotation,
    onUpdateNote,
    onDeleteNote,
    onBeginNoteDrag,
    onOpenLargeEditor,
    onDeleteAnnotation,
    onCreateAnnotationFromSource,
    zoomOperationId,
    onFitWidthLayoutChange,
    onSearchStateChange,
    annotationFilter,
    onPdfDocumentChange,
    onExplicitNavigation,
    onAnnotationNavigationApplied,
  },
  ref,
) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<PdfOpenFailurePresentation | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [viewerShellElement, setViewerShellElement] = useState<HTMLElement | null>(
    null,
  );
  const [searchPanelPosition, setSearchPanelPosition] =
    useState<PdfSearchPanelPosition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textSelectionRef = useRef<PdfTextSelection[]>([]);
  const pendingZoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const restoredZoomOperationRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const highlightIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingAnnotationNavigationRef = useRef<string | null>(null);
  const pendingSourceActionRef = useRef<{
    annotationId: string;
    documentId: string;
  } | null>(null);
  const sourceActionFrameRef = useRef<number | null>(null);
  const pendingReadingRestoreRef = useRef<PendingReadingRestore | null>(null);
  const lastSearchNavigationIdRef = useRef<string | null>(null);
  const pendingSearchNavigationRef = useRef<{
    resultId: string;
    pageNumber: number;
    zoomOperationId: number;
    navigationEpoch: number;
  } | null>(null);
  const lastReportedPageRef = useRef(0);
  const navigationEpochRef = useRef(0);
  const readerBackgroundPointerStartRef = useRef<AnnotationPointerStart | null>(null);
  const [selectionActionPosition, setSelectionActionPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [sourceActionTarget, setSourceActionTarget] = useState<NoteAnchor | null>(null);
  const [activeReaderContext, setActiveReaderContext] = useState<{
    candidates: ReaderContextCandidateReference[];
    activeCandidateKey: string;
    position: { left: number; top: number };
  } | null>(null);
  const [annotationType, setAnnotationType] = useState<AnnotationType | null>(null);
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('yellow');
  const [underlineColor, setUnderlineColor] = useState<UnderlineColor>('blue');
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [activeGlossaryEntryId, setActiveGlossaryEntryId] = useState<string | null>(
    null,
  );
  const [definitionBubbles, setDefinitionBubbles] = useState<DefinitionBubble[]>([]);
  const dictionaryGenerationRef = useRef(0);
  const dictionaryLookupsRef = useRef(new Map<string, AbortController>());
  const [activePageNumber, setActivePageNumber] = useState(1);
  const search = usePdfSearch(document);
  const activeSearchResultId = search.activeResult?.id ?? null;
  const activeSearchResultPageNumber = search.activeResult?.pageNumber ?? null;
  const readerOcclusionInsets = useReaderOcclusionInsets(
    scrollElement,
    fitMode === 'width',
  );
  const containerSize = useElementSize(
    scrollElement,
    fitMode === 'width' ? onFitWidthLayoutChange : undefined,
  );
  const annotationTags = useMemo(
    () => deriveAnnotationTags(annotations, notes, noteAnchors),
    [annotations, noteAnchors, notes],
  );
  const activeContextCandidates = activeReaderContext
    ? activeReaderContext.candidates.filter((candidate) =>
        candidate.kind === 'annotation'
          ? annotationTags.some((tag) => tag.annotation.id === candidate.annotationId)
          : glossaryEntries.some(
              (entry) =>
                isPdfGlossaryEntry(entry) &&
                entry.glossaryEntryId === candidate.glossaryEntryId,
            ),
      )
    : [];
  const activeContextCandidate = activeReaderContext
    ? (activeContextCandidates.find(
        (candidate) =>
          getReaderContextCandidateKey(candidate) ===
          activeReaderContext.activeCandidateKey,
      ) ?? null)
    : null;
  const visibleAnnotationTag =
    activeContextCandidate?.kind === 'annotation'
      ? (annotationTags.find(
          (tag) => tag.annotation.id === activeContextCandidate.annotationId,
        ) ?? null)
      : null;
  const visibleGlossaryEntry: PdfGlossaryEntry | null =
    activeContextCandidate?.kind === 'glossary'
      ? (glossaryEntries.find(
          (entry): entry is PdfGlossaryEntry =>
            isPdfGlossaryEntry(entry) &&
            entry.glossaryEntryId === activeContextCandidate.glossaryEntryId,
        ) ?? null)
      : null;
  const setScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  }, []);
  const updateSearchPanelPosition = useCallback((position: PdfSearchPanelPosition) => {
    setSearchPanelPosition((current) =>
      current?.x === position.x && current.y === position.y ? current : position,
    );
  }, []);
  const showReaderContext = useCallback(
    (
      sourceAnnotations: readonly PdfAnnotation[],
      sourceGlossaryEntries: readonly PdfGlossaryEntry[],
      position: { left: number; top: number },
    ) => {
      const candidates = createReaderContextCandidates(
        sourceAnnotations,
        sourceGlossaryEntries,
      );
      if (candidates.length === 0) {
        setActiveReaderContext(null);
        return;
      }
      pendingSourceActionRef.current = null;
      setSourceActionTarget(null);
      setSelectionActionPosition(null);
      setAnnotationType(null);
      setActiveReaderContext({
        candidates,
        activeCandidateKey: getReaderContextCandidateKey(candidates[0]),
        position,
      });
    },
    [],
  );
  const removeCandidateFromReaderContext = useCallback(
    (removedCandidateKey: string) => {
      setActiveReaderContext((current) => {
        if (!current) return current;
        const next = removeReaderContextCandidate(
          current.candidates,
          current.activeCandidateKey,
          removedCandidateKey,
        );
        return next ? { ...current, ...next } : null;
      });
    },
    [],
  );
  const captureZoomAnchor = useCallback((operationId: number) => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    const scrollerRectangle = scroller.getBoundingClientRect();
    const scrollerCentre = scrollerRectangle.top + scrollerRectangle.height / 2;
    const pages = Array.from(scroller.querySelectorAll<HTMLElement>('.pdf-page-shell'));

    const closestPage = pages.reduce<HTMLElement | null>((closest, page) => {
      if (!closest) {
        return page;
      }

      const pageCentre =
        page.getBoundingClientRect().top + page.getBoundingClientRect().height / 2;
      const closestCentre =
        closest.getBoundingClientRect().top +
        closest.getBoundingClientRect().height / 2;

      return Math.abs(pageCentre - scrollerCentre) <
        Math.abs(closestCentre - scrollerCentre)
        ? page
        : closest;
    }, null);

    if (!closestPage) {
      return;
    }

    const pageRectangle = closestPage.getBoundingClientRect();
    const pageNumber = Number(closestPage.id.replace('page-', ''));

    if (!Number.isInteger(pageNumber) || pageRectangle.height === 0) {
      return;
    }

    pendingZoomAnchorRef.current = {
      operationId,
      pageNumber,
      centreOffset: Math.min(
        1,
        Math.max(0, (scrollerCentre - pageRectangle.top) / pageRectangle.height),
      ),
    };
    restoredZoomOperationRef.current = null;
  }, []);

  const applyAnnotationNavigation = useCallback(
    (annotationId: string) => {
      const annotation = [...annotations, ...noteAnchors].find(
        (candidate) => candidate.id === annotationId,
      );
      if (!annotation) {
        return false;
      }

      const scroller = scrollRef.current;
      const page = scroller?.querySelector<HTMLElement>(
        `#page-${annotation.pageNumber}`,
      );
      const firstRectangle = annotation.rects.find(
        (rectangle) => rectangle.width > 0 && rectangle.height > 0,
      );
      if (
        !scroller ||
        !page ||
        !firstRectangle ||
        !page.style.height ||
        page.clientHeight === 0
      ) {
        return false;
      }

      const scrollerRectangle = scroller.getBoundingClientRect();
      const pageRectangle = page.getBoundingClientRect();
      const annotationAnchorY =
        pageRectangle.top +
        (firstRectangle.y + firstRectangle.height / 2) * pageRectangle.height;
      const preferredViewportY = scrollerRectangle.top + scroller.clientHeight * 0.4;
      const maximumScrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      navigationEpochRef.current += 1;
      const appliedNavigationEpoch = navigationEpochRef.current;
      scroller.scrollTop = clamp(
        scroller.scrollTop + annotationAnchorY - preferredViewportY,
        0,
        maximumScrollTop,
      );
      onExplicitNavigation?.();

      setActiveAnnotationId(annotationId);
      if (highlightIndicatorTimeoutRef.current !== null) {
        clearTimeout(highlightIndicatorTimeoutRef.current);
      }
      highlightIndicatorTimeoutRef.current = setTimeout(() => {
        setActiveAnnotationId(null);
        highlightIndicatorTimeoutRef.current = null;
      }, 1200);
      pendingAnnotationNavigationRef.current = null;
      onAnnotationNavigationApplied?.(annotationId);
      const pendingSourceAction = pendingSourceActionRef.current;
      if (
        pendingSourceAction?.annotationId === annotationId &&
        pendingSourceAction.documentId === documentId
      ) {
        if (sourceActionFrameRef.current !== null) {
          cancelAnimationFrame(sourceActionFrameRef.current);
        }
        sourceActionFrameRef.current = requestAnimationFrame(() => {
          sourceActionFrameRef.current = null;
          if (
            pendingSourceActionRef.current !== pendingSourceAction ||
            navigationEpochRef.current !== appliedNavigationEpoch ||
            pendingSourceAction.documentId !== documentId
          ) {
            return;
          }
          const currentPage = scrollRef.current?.querySelector<HTMLElement>(
            `#page-${annotation.pageNumber}`,
          );
          const position = currentPage
            ? getSourceActionPosition(currentPage, annotation)
            : null;
          if (!position) return;
          pendingSourceActionRef.current = null;
          textSelectionRef.current = [];
          if (annotation.type === 'note-anchor') {
            setActiveReaderContext(null);
            setSourceActionTarget(annotation);
            setSelectionActionPosition(position);
            setAnnotationType(null);
          } else {
            showReaderContext([annotation], [], position);
          }
        });
      }
      return true;
    },
    [
      annotations,
      documentId,
      noteAnchors,
      onAnnotationNavigationApplied,
      onExplicitNavigation,
      showReaderContext,
    ],
  );

  const navigateToAnnotation = useCallback(
    (annotationId: string, options?: { showSourceActions?: boolean }) => {
      pendingAnnotationNavigationRef.current = annotationId;
      if (options?.showSourceActions && documentId) {
        pendingSourceActionRef.current = { annotationId, documentId };
      } else {
        pendingSourceActionRef.current = null;
        setSourceActionTarget(null);
        setActiveReaderContext(null);
      }
      return applyAnnotationNavigation(annotationId);
    },
    [applyAnnotationNavigation, documentId],
  );

  const navigateToGlossaryEntry = useCallback(
    (glossaryEntryId: string) => {
      const entry = glossaryEntries.find(
        (candidate) => candidate.glossaryEntryId === glossaryEntryId,
      );
      if (!entry || !isPdfGlossaryEntry(entry)) return false;
      const scroller = scrollRef.current;
      const page = scroller?.querySelector<HTMLElement>(`#page-${entry.pageNumber}`);
      const rectangle = entry.sourceRects[0];
      if (!scroller || !page || !rectangle || page.clientHeight === 0) return false;

      const scrollerRectangle = scroller.getBoundingClientRect();
      const pageRectangle = page.getBoundingClientRect();
      const anchorY =
        pageRectangle.top + (rectangle.y + rectangle.height / 2) * pageRectangle.height;
      const preferredY = scrollerRectangle.top + scroller.clientHeight * 0.4;
      navigationEpochRef.current += 1;
      scroller.scrollTop = clamp(
        scroller.scrollTop + anchorY - preferredY,
        0,
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );
      onExplicitNavigation?.();
      setActiveGlossaryEntryId(glossaryEntryId);
      if (highlightIndicatorTimeoutRef.current !== null) {
        clearTimeout(highlightIndicatorTimeoutRef.current);
      }
      highlightIndicatorTimeoutRef.current = setTimeout(() => {
        setActiveGlossaryEntryId(null);
        highlightIndicatorTimeoutRef.current = null;
      }, 1200);
      return true;
    },
    [glossaryEntries, onExplicitNavigation],
  );

  const goToPage = useCallback(
    (pageNumber: number) => {
      navigationEpochRef.current += 1;
      onExplicitNavigation?.();
      scrollRef.current
        ?.querySelector<HTMLElement>(`#page-${pageNumber}`)
        ?.scrollIntoView({ block: 'start', behavior: 'auto' });
    },
    [onExplicitNavigation],
  );

  const captureReadingPosition = useCallback((): ReadingPosition | null => {
    const scroller = scrollRef.current;
    const page = scroller?.querySelector<HTMLElement>(`#page-${activePageNumber}`);
    if (!scroller || !page || page.clientHeight === 0) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const pageTop = page.getBoundingClientRect().top;
    return {
      pageNumber: activePageNumber,
      pageOffsetRatio: Math.min(
        1,
        Math.max(0, (scrollerTop - pageTop) / page.clientHeight),
      ),
      zoomMode:
        fitMode === 'width' ? 'fit-width' : fitMode === 'page' ? 'fit-page' : 'custom',
      zoomPercent: zoom,
      updatedAt: Date.now(),
    };
  }, [activePageNumber, fitMode, zoom]);

  const applyPendingReadingPosition = useCallback(() => {
    const pendingRestore = pendingReadingRestoreRef.current;
    if (
      !pendingRestore ||
      pendingRestore.navigationEpoch !== navigationEpochRef.current
    ) {
      return false;
    }
    const scroller = scrollRef.current;
    const page = scroller?.querySelector<HTMLElement>(
      `#page-${pendingRestore.position.pageNumber}`,
    );
    if (!scroller || !page || !page.style.height || page.clientHeight === 0) {
      return false;
    }
    scroller.scrollTop +=
      page.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      page.clientHeight * pendingRestore.position.pageOffsetRatio;
    pendingReadingRestoreRef.current = null;
    pendingRestore.onApplied?.();
    return true;
  }, []);

  const restoreReadingPosition = useCallback(
    (position: ReadingPosition, onApplied?: () => void) => {
      pendingReadingRestoreRef.current = {
        position,
        navigationEpoch: navigationEpochRef.current,
        onApplied,
      };
      requestAnimationFrame(applyPendingReadingPosition);
    },
    [applyPendingReadingPosition],
  );

  const scrollToExactSearchResult = useCallback(
    (resultId: string, pageNumber: number) => {
      const scroller = scrollRef.current;
      const page = scroller?.querySelector<HTMLElement>(`#page-${pageNumber}`);
      const marker = page?.querySelector<HTMLElement>(
        `.pdf-search-rectangle[data-search-result-id="${CSS.escape(resultId)}"][data-search-rect-index="0"]`,
      );

      if (!scroller || !page || !marker || page.clientHeight === 0) {
        return false;
      }

      const scrollerRectangle = scroller.getBoundingClientRect();
      const markerRectangle = marker.getBoundingClientRect();
      const preferredViewportY = scrollerRectangle.top + scroller.clientHeight * 0.4;
      const markerAnchorY = markerRectangle.top + markerRectangle.height / 2;
      const maximumScrollTop = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      scroller.scrollTop = clamp(
        scroller.scrollTop + markerAnchorY - preferredViewportY,
        0,
        maximumScrollTop,
      );
      return true;
    },
    [],
  );

  const handleTextLayerReady = useCallback(
    (pageNumber: number) => {
      const pendingTarget = pendingSearchNavigationRef.current;
      if (
        !pendingTarget ||
        pendingTarget.pageNumber !== pageNumber ||
        pendingTarget.zoomOperationId !== zoomOperationId ||
        pendingTarget.navigationEpoch !== navigationEpochRef.current
      ) {
        return;
      }

      if (scrollToExactSearchResult(pendingTarget.resultId, pendingTarget.pageNumber)) {
        logNavigationDiagnostic('navigation-applied', {
          source: 'pdf-search-result',
          targetType: 'pdf-search',
          pageNumber: pendingTarget.pageNumber,
          navigationEpoch: pendingTarget.navigationEpoch,
        });
        pendingSearchNavigationRef.current = null;
      }
    },
    [scrollToExactSearchResult, zoomOperationId],
  );

  useEffect(() => {
    if (!activeSearchResultId || activeSearchResultPageNumber === null) {
      pendingSearchNavigationRef.current = null;
      return;
    }

    if (lastSearchNavigationIdRef.current !== activeSearchResultId) {
      navigationEpochRef.current += 1;
      lastSearchNavigationIdRef.current = activeSearchResultId;
      onExplicitNavigation?.();
    }

    const pendingTarget = {
      resultId: activeSearchResultId,
      pageNumber: activeSearchResultPageNumber,
      zoomOperationId,
      navigationEpoch: navigationEpochRef.current,
    };
    pendingSearchNavigationRef.current = pendingTarget;

    // This exact preliminary placement brings a virtualized page near the viewport.
    // The TextLayer-ready callback repeats it once with current-generation geometry.
    if (scrollToExactSearchResult(pendingTarget.resultId, pendingTarget.pageNumber)) {
      logNavigationDiagnostic('navigation-applied', {
        source: 'pdf-search-result',
        targetType: 'pdf-search',
        pageNumber: pendingTarget.pageNumber,
        navigationEpoch: pendingTarget.navigationEpoch,
      });
    }
  }, [
    activeSearchResultId,
    activeSearchResultPageNumber,
    onExplicitNavigation,
    scrollToExactSearchResult,
    zoomOperationId,
  ]);

  useEffect(() => {
    if (!search.isOpen) {
      lastSearchNavigationIdRef.current = null;
      pendingSearchNavigationRef.current = null;
    }
  }, [search.isOpen]);

  useEffect(() => {
    onSearchStateChange?.({
      isOpen: search.isOpen,
      isIndexing: search.isIndexing,
      indexedPageCount: search.indexedPageCount,
      query: search.query,
      resultCount: search.results.length,
      activeResultIndex: search.activeResult
        ? search.results.findIndex((result) => result.id === search.activeResult?.id)
        : -1,
    });
  }, [
    onSearchStateChange,
    search.activeResult,
    search.indexedPageCount,
    search.isIndexing,
    search.isOpen,
    search.query,
    search.results,
  ]);

  useImperativeHandle(
    ref,
    () => ({
      captureZoomAnchor,
      navigateToAnnotation,
      navigateToGlossaryEntry,
      goToPage,
      openSearch: search.open,
      closeSearch: search.close,
      setSearchQuery: search.setQuery,
      goToPreviousSearchResult: search.goToPreviousResult,
      goToNextSearchResult: search.goToNextResult,
      captureReadingPosition,
      restoreReadingPosition,
      getNavigationEpoch: () => navigationEpochRef.current,
    }),
    [
      captureReadingPosition,
      captureZoomAnchor,
      goToPage,
      navigateToAnnotation,
      navigateToGlossaryEntry,
      restoreReadingPosition,
      search.close,
      search.goToNextResult,
      search.goToPreviousResult,
      search.open,
      search.setQuery,
    ],
  );

  const lookupWord = useCallback(
    (selection: PdfTextSelection) => {
      const displayedWord = selection.text;
      if (!documentId || selection.pageWidth <= 0 || selection.pageHeight <= 0) {
        return;
      }
      const rects = normalizeSelectionRectangles(
        selection.boundingRectangles,
        selection.pageWidth,
        selection.pageHeight,
      );
      if (rects.length === 0) return;
      const bubbleId = createDefinitionBubbleId(selection.pageNumber, rects);
      if (
        dictionaryLookupsRef.current.has(bubbleId) ||
        definitionBubbles.some((candidate) => candidate.id === bubbleId)
      ) {
        return;
      }
      const generation = dictionaryGenerationRef.current;
      const controller = new AbortController();
      dictionaryLookupsRef.current.set(bubbleId, controller);
      const existingGlossaryEntry = glossaryEntries.find(
        (entry) =>
          isPdfGlossaryEntry(entry) &&
          entry.pageNumber === selection.pageNumber &&
          entry.startOffset === selection.startOffset &&
          entry.endOffset === selection.endOffset &&
          rectanglesMatch(entry.sourceRects, rects),
      );
      const bubble: DefinitionBubble = {
        id: bubbleId,
        documentId,
        pageNumber: selection.pageNumber,
        displayedWord,
        normalizedLookupWord: displayedWord.toLocaleLowerCase('en-US'),
        rects,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        definitions: [],
        status: 'loading',
        isExpanded: false,
        isEnriching: true,
        userHasReordered: false,
        ...(existingGlossaryEntry
          ? { glossaryEntryId: existingGlossaryEntry.glossaryEntryId }
          : {}),
      };
      setDefinitionBubbles((current) => {
        const index = current.findIndex((candidate) => candidate.id === bubbleId);
        return index === -1
          ? [...current, bubble]
          : current.map((candidate) =>
              candidate.id === bubbleId
                ? { ...candidate, status: 'loading', displayedWord }
                : candidate,
            );
      });

      const isCurrentLookup = () =>
        !controller.signal.aborted &&
        dictionaryGenerationRef.current === generation &&
        dictionaryLookupsRef.current.get(bubbleId) === controller;

      void import('../services/dictionaryService')
        .then(({ lookupDictionary }) =>
          lookupDictionary(
            displayedWord,
            {
              onLocalResult: (result) => {
                if (!isCurrentLookup()) return;
                setDefinitionBubbles((current) =>
                  current.map((candidate) => {
                    if (candidate.id !== bubbleId) return candidate;
                    const definitions = mergeDictionaryDefinitions(
                      candidate.definitions,
                      result.definitions,
                    );
                    return {
                      ...candidate,
                      normalizedLookupWord: result.normalizedWord,
                      definitions,
                      status: definitions.length > 0 ? 'ready' : 'loading',
                    };
                  }),
                );
              },
              onRemoteResult: (definitions) => {
                if (!isCurrentLookup()) return;
                setDefinitionBubbles((current) =>
                  current.map((candidate) =>
                    candidate.id === bubbleId
                      ? {
                          ...candidate,
                          definitions: mergeDictionaryDefinitions(
                            candidate.definitions,
                            definitions,
                          ),
                          status: 'ready',
                        }
                      : candidate,
                  ),
                );
              },
              onComplete: () => {
                if (!isCurrentLookup()) return;
                setDefinitionBubbles((current) =>
                  current.map((candidate) =>
                    candidate.id === bubbleId
                      ? {
                          ...candidate,
                          isEnriching: false,
                          status:
                            candidate.definitions.length > 0 ? 'ready' : 'not-found',
                        }
                      : candidate,
                  ),
                );
              },
            },
            controller.signal,
          ),
        )
        .catch(() => {
          if (!isCurrentLookup()) return;
          setDefinitionBubbles((current) =>
            current.map((candidate) =>
              candidate.id === bubbleId
                ? {
                    ...candidate,
                    isEnriching: false,
                    status: candidate.definitions.length > 0 ? 'ready' : 'error',
                  }
                : candidate,
            ),
          );
        })
        .finally(() => {
          if (dictionaryLookupsRef.current.get(bubbleId) === controller) {
            dictionaryLookupsRef.current.delete(bubbleId);
          }
        });
    },
    [definitionBubbles, documentId, glossaryEntries],
  );

  const addBubbleToGlossary = useCallback(
    (bubbleId: string) => {
      const bubble = definitionBubbles.find((candidate) => candidate.id === bubbleId);
      const preferredDefinition = bubble?.definitions[0];
      if (!bubble || !preferredDefinition || bubble.glossaryEntryId) return;
      const entry = onAddGlossaryEntry(bubble, preferredDefinition);
      if (!entry) return;
      setDefinitionBubbles((current) =>
        current.map((candidate) =>
          candidate.id === bubbleId
            ? markDefinitionBubbleAdded(candidate, entry.glossaryEntryId)
            : candidate,
        ),
      );
    },
    [definitionBubbles, onAddGlossaryEntry],
  );

  const closeDefinitionBubble = useCallback((bubbleId: string) => {
    dictionaryLookupsRef.current.get(bubbleId)?.abort();
    dictionaryLookupsRef.current.delete(bubbleId);
    setDefinitionBubbles((current) =>
      current.filter((bubble) => bubble.id !== bubbleId),
    );
  }, []);

  const moveBubbleDefinitionUp = useCallback(
    (bubbleId: string, definitionId: string) => {
      setDefinitionBubbles((current) =>
        current.map((bubble) =>
          bubble.id === bubbleId
            ? {
                ...bubble,
                definitions: moveDefinitionUp(bubble.definitions, definitionId),
                userHasReordered: true,
              }
            : bubble,
        ),
      );
    },
    [],
  );

  const toggleDefinitionsExpanded = useCallback((bubbleId: string) => {
    setDefinitionBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId ? { ...bubble, isExpanded: !bubble.isExpanded } : bubble,
      ),
    );
  }, []);
  const handleTextSelectionChange = useCallback(
    (selection: PdfTextSelection[]) => {
      textSelectionRef.current = selection;
      onTextSelectionChange?.(selection);
      if (selection.length > 0) {
        pendingSourceActionRef.current = null;
        setSourceActionTarget(null);
        setActiveReaderContext(null);
        setSelectionActionPosition(getSelectionActionPosition(selection));
      } else if (!sourceActionTarget) {
        setSelectionActionPosition(null);
      }
      setAnnotationType(null);
    },
    [onTextSelectionChange, sourceActionTarget],
  );

  usePdfTextSelection(scrollElement, handleTextSelectionChange);

  useEffect(() => {
    const annotationIds = new Set(annotations.map(({ id }) => id));
    const glossaryEntryIds = new Set(
      glossaryEntries
        .filter(isPdfGlossaryEntry)
        .map(({ glossaryEntryId }) => glossaryEntryId),
    );
    setActiveReaderContext((current) => {
      if (!current) return current;
      const remaining = current.candidates.filter((candidate) =>
        candidate.kind === 'annotation'
          ? annotationIds.has(candidate.annotationId)
          : glossaryEntryIds.has(candidate.glossaryEntryId),
      );
      if (remaining.length === 0) return null;
      const activeStillExists = remaining.some(
        (candidate) =>
          getReaderContextCandidateKey(candidate) === current.activeCandidateKey,
      );
      if (activeStillExists && remaining.length === current.candidates.length) {
        return current;
      }
      const previousActiveIndex = Math.max(
        0,
        current.candidates.findIndex(
          (candidate) =>
            getReaderContextCandidateKey(candidate) === current.activeCandidateKey,
        ),
      );
      return {
        ...current,
        candidates: remaining,
        activeCandidateKey: activeStillExists
          ? current.activeCandidateKey
          : getReaderContextCandidateKey(
              remaining[Math.min(previousActiveIndex, remaining.length - 1)],
            ),
      };
    });
  }, [annotations, glossaryEntries]);

  useEffect(() => {
    const glossaryEntryIds = new Set(
      glossaryEntries.map(({ glossaryEntryId }) => glossaryEntryId),
    );
    setDefinitionBubbles((current) => {
      let changed = false;
      const next = current.map((bubble) => {
        if (!bubble.glossaryEntryId || glossaryEntryIds.has(bubble.glossaryEntryId)) {
          return bubble;
        }
        changed = true;
        return {
          ...bubble,
          glossaryEntryId: undefined,
          addedConfirmationToken: undefined,
        };
      });
      return changed ? next : current;
    });
  }, [glossaryEntries]);

  useEffect(() => {
    if (!scrollElement || !activeReaderContext) return;
    const dismissStaleTag = () => setActiveReaderContext(null);
    scrollElement.addEventListener('scroll', dismissStaleTag, { passive: true });
    return () => scrollElement.removeEventListener('scroll', dismissStaleTag);
  }, [activeReaderContext, scrollElement]);

  useEffect(() => {
    setActiveReaderContext(null);
  }, [containerSize.height, containerSize.width, zoomOperationId]);

  const restoreZoomAnchor = useCallback(
    (pageNumber: number) => {
      const anchor = pendingZoomAnchorRef.current;
      const scroller = scrollRef.current;

      if (
        !anchor ||
        !scroller ||
        anchor.operationId !== zoomOperationId ||
        anchor.pageNumber !== pageNumber ||
        restoredZoomOperationRef.current === anchor.operationId
      ) {
        return;
      }

      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }

      restoreFrameRef.current = requestAnimationFrame(() => {
        const targetPage = scroller.querySelector<HTMLElement>(
          `#page-${anchor.pageNumber}`,
        );

        if (!targetPage || pendingZoomAnchorRef.current !== anchor) {
          return;
        }

        const scrollerCentre =
          scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
        const targetCentre =
          targetPage.getBoundingClientRect().top +
          targetPage.getBoundingClientRect().height * anchor.centreOffset;

        scroller.scrollTop += targetCentre - scrollerCentre;
        restoredZoomOperationRef.current = anchor.operationId;
        pendingZoomAnchorRef.current = null;
        restoreFrameRef.current = null;
      });
    },
    [zoomOperationId],
  );

  const handlePageLayoutChange = useCallback(
    (pageNumber: number) => {
      restoreZoomAnchor(pageNumber);
      if (pendingReadingRestoreRef.current?.position.pageNumber === pageNumber) {
        applyPendingReadingPosition();
      }
      const annotationId = pendingAnnotationNavigationRef.current;
      const annotation = [...annotations, ...noteAnchors].find(
        (candidate) => candidate.id === annotationId,
      );
      if (annotation?.pageNumber === pageNumber) {
        applyAnnotationNavigation(annotation.id);
      }
    },
    [
      annotations,
      noteAnchors,
      applyAnnotationNavigation,
      applyPendingReadingPosition,
      restoreZoomAnchor,
    ],
  );

  useEffect(
    () => () => {
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
      if (highlightIndicatorTimeoutRef.current !== null) {
        clearTimeout(highlightIndicatorTimeoutRef.current);
      }
      if (sourceActionFrameRef.current !== null) {
        cancelAnimationFrame(sourceActionFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const dismissActions = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'f' &&
        document
      ) {
        event.preventDefault();
        search.open();
        return;
      }
      if (event.key !== 'Escape') {
        return;
      }

      if (activeReaderContext) {
        setActiveReaderContext(null);
      } else if (selectionActionPosition) {
        window.getSelection()?.removeAllRanges();
        setSelectionActionPosition(null);
        setSourceActionTarget(null);
        pendingSourceActionRef.current = null;
      } else if (search.isOpen) {
        search.close();
      }
    };

    window.addEventListener('keydown', dismissActions);
    return () => window.removeEventListener('keydown', dismissActions);
  }, [activeReaderContext, document, search, selectionActionPosition]);

  useEffect(() => {
    if (!file) {
      setDocument(null);
      pendingAnnotationNavigationRef.current = null;
      pendingSourceActionRef.current = null;
      setSourceActionTarget(null);
      setActiveReaderContext(null);
      setSelectionActionPosition(null);
      pendingReadingRestoreRef.current = null;
      onPdfDocumentChange?.(null);
      setError(null);
      return;
    }

    let isDisposed = false;
    const objectUrl = URL.createObjectURL(file);
    const loadingTask = getDocument(
      createPdfDocumentInitParameters({ url: objectUrl }),
    );

    setDocument(null);
    setError(null);

    void loadingTask.promise
      .then((loadedDocument) => {
        if (isDisposed) {
          return;
        }

        setDocument(loadedDocument);
        onPdfDocumentChange?.(loadedDocument);
        onDocumentReady(resolveDocumentIdentity(file, loadedDocument), file);
        onPageCountChange(loadedDocument.numPages);
        onCurrentPageChange(1);
      })
      .catch((error: unknown) => {
        if (!isDisposed) {
          if (import.meta.env.DEV) {
            const diagnosticError =
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    code:
                      'code' in error &&
                      (typeof error.code === 'string' || typeof error.code === 'number')
                        ? error.code
                        : undefined,
                  }
                : { name: 'UnknownError', message: String(error) };
            const extension = file.name.includes('.')
              ? file.name.slice(file.name.lastIndexOf('.')).toLocaleLowerCase('en-US')
              : '';
            console.error(
              `[39Note PDF open diagnostic] ${JSON.stringify({
                phase: 'pdfjs-loading-task',
                error: diagnosticError,
                source: {
                  byteSize: file.size,
                  mimeType: file.type,
                  hasFileName: file.name.length > 0,
                  extension,
                },
                input: 'live-blob-url',
                getDocumentInvoked: true,
                workerConfigured: Boolean(GlobalWorkerOptions.workerSrc),
                workerInitialized: Boolean(
                  (loadingTask as unknown as { _worker?: unknown })._worker,
                ),
                wasmUrl: resolvedPdfJsWasmUrl,
              })}`,
            );
          }
          onPdfDocumentChange?.(null);
          setError(describePdfOpenFailure(error));
          onPageCountChange(0);
          onCurrentPageChange(0);
        }
      });

    return () => {
      isDisposed = true;
      onPdfDocumentChange?.(null);
      void loadingTask.destroy();
      URL.revokeObjectURL(objectUrl);
    };
  }, [
    file,
    onCurrentPageChange,
    onPageCountChange,
    onDocumentReady,
    onPdfDocumentChange,
  ]);

  useEffect(() => {
    setSearchPanelPosition(null);
    pendingSourceActionRef.current = null;
    setSourceActionTarget(null);
    setActiveReaderContext(null);
    setSelectionActionPosition(null);
    dictionaryGenerationRef.current += 1;
    dictionaryLookupsRef.current.forEach((controller) => controller.abort());
    dictionaryLookupsRef.current.clear();
    setDefinitionBubbles([]);
  }, [file]);

  useEffect(
    () => () => {
      dictionaryLookupsRef.current.forEach((controller) => controller.abort());
      dictionaryLookupsRef.current.clear();
    },
    [],
  );

  const visibleAnnotations = annotations.filter((annotation) =>
    matchesAnnotationFilter(annotation, notedAnnotationIds, annotationFilter),
  );
  const annotationsForPage = (pageNumber: number) => {
    const filteredPageAnnotations = visibleAnnotations.filter(
      (annotation) => annotation.pageNumber === pageNumber,
    );
    const activeFilteredAnnotation = annotations.find(
      (annotation) =>
        annotation.id === activeAnnotationId &&
        annotation.pageNumber === pageNumber &&
        !filteredPageAnnotations.some((candidate) => candidate.id === annotation.id),
    );

    return activeFilteredAnnotation
      ? [...filteredPageAnnotations, activeFilteredAnnotation]
      : filteredPageAnnotations;
  };

  useEffect(() => {
    if (!scrollElement || !document) {
      return;
    }

    let frameId: number | null = null;
    const reportCentrePage = () => {
      frameId = null;
      const scrollerRectangle = scrollElement.getBoundingClientRect();
      const centre = scrollerRectangle.top + scrollElement.clientHeight / 2;
      const pages = Array.from(
        scrollElement.querySelectorAll<HTMLElement>('.pdf-page-shell'),
      );
      const closestPage = pages.reduce<HTMLElement | null>((closest, page) => {
        if (!closest) {
          return page;
        }

        const pageCentre =
          page.getBoundingClientRect().top + page.getBoundingClientRect().height / 2;
        const closestCentre =
          closest.getBoundingClientRect().top +
          closest.getBoundingClientRect().height / 2;
        return Math.abs(pageCentre - centre) < Math.abs(closestCentre - centre)
          ? page
          : closest;
      }, null);
      const pageNumber = Number(closestPage?.id.replace('page-', ''));
      if (Number.isInteger(pageNumber) && pageNumber !== lastReportedPageRef.current) {
        lastReportedPageRef.current = pageNumber;
        setActivePageNumber(pageNumber);
        onCurrentPageChange(pageNumber);
      }
    };
    const requestReport = () => {
      if (frameId === null) {
        frameId = requestAnimationFrame(reportCentrePage);
      }
    };

    requestReport();
    scrollElement.addEventListener('scroll', requestReport, { passive: true });
    return () => {
      scrollElement.removeEventListener('scroll', requestReport);
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [document, onCurrentPageChange, scrollElement]);

  const openDroppedFile = (droppedFile: File | undefined) => {
    if (droppedFile && isPdfFile(droppedFile)) {
      onOpenFile(droppedFile);
    }
  };

  const beginReaderBackgroundTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    readerBackgroundPointerStartRef.current =
      event.button === 0 && isBlankReaderSurface(event.target, event.currentTarget)
        ? {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
          }
        : null;
  };

  const completeReaderBackgroundTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = readerBackgroundPointerStartRef.current;
    readerBackgroundPointerStartRef.current = null;
    if (!isBlankReaderSurface(event.target, event.currentTarget)) return;
    const hasMeaningfulSelection = Boolean(window.getSelection()?.toString().trim());
    if (isSimpleAnnotationTap(start, event, hasMeaningfulSelection)) {
      setActiveReaderContext(null);
    }
  };

  const createAnnotation = () => {
    if (sourceActionTarget && annotationType) {
      onCreateAnnotationFromSource(
        sourceActionTarget,
        annotationType,
        annotationType === 'highlight' ? highlightColor : underlineColor,
      );
      setAnnotationType(null);
      return;
    }
    if (annotationType === 'highlight') {
      onCreateHighlights(textSelectionRef.current, highlightColor);
    } else if (annotationType === 'underline') {
      onCreateUnderlines(textSelectionRef.current, underlineColor);
    } else {
      return;
    }
    window.getSelection()?.removeAllRanges();
    setSelectionActionPosition(null);
  };

  const activateDictionaryLookup = () => {
    const selection = getDictionaryLookupSelection(textSelectionRef.current);
    if (!selection) return;
    lookupWord(selection);
    window.getSelection()?.removeAllRanges();
    setSelectionActionPosition(null);
  };

  if (!file) {
    return (
      <section
        className={`viewer ${isDragging ? 'is-dragging' : ''}`}
        aria-label="PDF viewer"
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) {
            setIsDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          openDroppedFile(event.dataTransfer.files[0]);
        }}
      >
        <div className="viewer-panel">
          <span className="viewer-icon" aria-hidden="true">
            &#128196;
          </span>
          <h1>No PDF Loaded</h1>
          <p>Drop a PDF here</p>
          <label className="viewer-button">
            Open PDF
            <input
              className="visually-hidden"
              tabIndex={-1}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                openDroppedFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={setViewerShellElement}
      className="viewer is-document-loaded"
      aria-label="PDF viewer"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        openDroppedFile(event.dataTransfer.files[0]);
      }}
    >
      {error ? (
        <div className="viewer-error" role="alert">
          <p>{error.message}</p>
          {error.reloadRecommended ? (
            <button type="button" onClick={() => window.location.reload()}>
              Reload 39Note
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className={`pdf-scroll ${fitMode === 'width' ? 'is-fit-width' : ''}`}
          ref={setScrollContainer}
          onPointerCancel={() => {
            readerBackgroundPointerStartRef.current = null;
          }}
          onPointerDown={beginReaderBackgroundTap}
          onPointerUp={completeReaderBackgroundTap}
          style={
            {
              '--reader-occlusion-left': `${readerOcclusionInsets.left}px`,
              '--reader-occlusion-right': `${readerOcclusionInsets.right}px`,
            } as CSSProperties
          }
        >
          {document ? (
            <div className="pdf-page-stack">
              {Array.from({ length: document.numPages }, (_, index) => (
                <PdfPage
                  containerSize={containerSize}
                  document={document}
                  fitMode={fitMode}
                  annotations={annotationsForPage(index + 1)}
                  noteAnchors={noteAnchors.filter(
                    (anchor) => anchor.pageNumber === index + 1,
                  )}
                  glossaryEntries={glossaryEntries
                    .filter(isPdfGlossaryEntry)
                    .filter((entry) => entry.pageNumber === index + 1)}
                  definitionBubbles={definitionBubbles.filter(
                    (bubble) => bubble.pageNumber === index + 1,
                  )}
                  activeAnnotationId={activeAnnotationId}
                  activeGlossaryEntryId={activeGlossaryEntryId}
                  key={index + 1}
                  onCurrentPageChange={() => undefined}
                  onScaleChange={(pageNumber, scale) => {
                    if (pageNumber === activePageNumber) {
                      onEffectiveZoomChange(scale);
                    }
                  }}
                  onGoToPage={goToPage}
                  onAddBubbleToGlossary={addBubbleToGlossary}
                  onRemoveBubbleFromGlossary={(glossaryEntryId) => {
                    onRemoveGlossaryEntry(glossaryEntryId);
                  }}
                  onCloseDefinitionBubble={closeDefinitionBubble}
                  onMoveDefinitionUp={moveBubbleDefinitionUp}
                  onToggleDefinitionsExpanded={toggleDefinitionsExpanded}
                  onPageLayoutChange={handlePageLayoutChange}
                  onTextLayerReady={handleTextLayerReady}
                  onOpenReaderContext={(hitAnnotations, hitGlossaryEntries, point) =>
                    showReaderContext(
                      hitAnnotations,
                      hitGlossaryEntries,
                      getAnnotationTagPosition(point.clientX, point.clientY),
                    )
                  }
                  onDismissReaderContext={() => setActiveReaderContext(null)}
                  searchResults={search.results.filter(
                    (result) => result.pageNumber === index + 1,
                  )}
                  activeSearchResultId={search.activeResult?.id ?? null}
                  pageNumber={index + 1}
                  scrollElement={scrollElement}
                  zoom={zoom}
                />
              ))}
            </div>
          ) : (
            <div className="viewer-loading">Opening PDF...</div>
          )}
        </div>
      )}
      {selectionActionPosition ? (
        <SelectionAction
          position={selectionActionPosition}
          annotationType={annotationType}
          onAnnotationTypeChange={setAnnotationType}
          onApply={createAnnotation}
          existingAnnotationTypes={
            sourceActionTarget
              ? annotations
                  .filter((annotation) =>
                    isSameLogicalPdfSource(sourceActionTarget, annotation),
                  )
                  .map((annotation) => annotation.type)
              : []
          }
          onLookupWord={
            !sourceActionTarget &&
            getDictionaryLookupSelection(textSelectionRef.current)
              ? activateDictionaryLookup
              : undefined
          }
          selectedColor={
            annotationType === 'highlight' ? highlightColor : underlineColor
          }
          onColorChange={(color) => {
            if (annotationType === 'highlight') {
              setHighlightColor(color as HighlightColor);
            } else {
              setUnderlineColor(color as UnderlineColor);
            }
          }}
        />
      ) : null}
      {activeReaderContext && (visibleAnnotationTag || visibleGlossaryEntry) ? (
        <AnnotationTag
          tag={visibleAnnotationTag}
          glossaryEntry={visibleGlossaryEntry}
          draggedNoteId={draggedNoteId}
          candidates={activeContextCandidates}
          activeCandidateKey={activeReaderContext.activeCandidateKey}
          position={activeReaderContext.position}
          onSelect={(candidateKey) =>
            setActiveReaderContext((current) =>
              current ? { ...current, activeCandidateKey: candidateKey } : current,
            )
          }
          onAddNote={onAddNoteToAnnotation}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
          onBeginNoteDrag={onBeginNoteDrag}
          onOpenLargeEditor={onOpenLargeEditor}
          onDeleteAnnotation={(annotationId, confirmed) => {
            onDeleteAnnotation(annotationId, confirmed);
            removeCandidateFromReaderContext(
              getReaderContextCandidateKey({
                kind: 'annotation',
                annotationId,
              }),
            );
          }}
          onRemoveGlossaryEntry={(glossaryEntryId) => {
            if (!onRemoveGlossaryEntry(glossaryEntryId)) return;
            removeCandidateFromReaderContext(
              getReaderContextCandidateKey({
                kind: 'glossary',
                glossaryEntryId,
              }),
            );
          }}
          onClose={() => setActiveReaderContext(null)}
        />
      ) : null}
      {search.isOpen ? (
        <PdfSearchBar
          activeResultIndex={
            search.activeResult
              ? search.results.findIndex(
                  (result) => result.id === search.activeResult?.id,
                )
              : -1
          }
          indexedPageCount={search.indexedPageCount}
          isIndexing={search.isIndexing}
          query={search.query}
          resultCount={search.results.length}
          boundsElement={viewerShellElement}
          position={searchPanelPosition}
          onPositionChange={updateSearchPanelPosition}
          onClear={() => search.setQuery('')}
          onClose={search.close}
          onNext={search.goToNextResult}
          onPrevious={search.goToPreviousResult}
          onQueryChange={search.setQuery}
        />
      ) : null}
    </section>
  );
});

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

function isBlankReaderSurface(
  target: EventTarget | null,
  scrollElement: HTMLDivElement,
): boolean {
  return (
    target instanceof Element &&
    (target === scrollElement ||
      target.classList.contains('pdf-page-stack') ||
      target.classList.contains('pdf-page-shell'))
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function getSelectionActionPosition(
  selections: PdfTextSelection[],
): { left: number; top: number } | null {
  if (selections.length === 0) {
    return null;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rectangle = range.getBoundingClientRect();
  const firstRectangle = range.getClientRects()[0];
  const anchor =
    rectangle.width > 0 && rectangle.height > 0 ? rectangle : firstRectangle;

  if (!anchor) {
    return null;
  }

  return {
    left: Math.min(Math.max(anchor.left, 8), Math.max(8, window.innerWidth - 390)),
    top: Math.max(anchor.top - 42, 8),
  };
}

function getSourceActionPosition(
  page: HTMLElement,
  source: PdfAnnotation | NoteAnchor,
): { left: number; top: number } | null {
  const firstRectangle = [...source.rects]
    .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
    .sort((first, second) => first.y - second.y || first.x - second.x)[0];
  if (!firstRectangle) return null;
  const pageRectangle = page.getBoundingClientRect();
  if (pageRectangle.width <= 0 || pageRectangle.height <= 0) return null;
  const sourceLeft = pageRectangle.left + firstRectangle.x * pageRectangle.width;
  const sourceTop = pageRectangle.top + firstRectangle.y * pageRectangle.height;
  return {
    left: Math.min(Math.max(sourceLeft, 8), Math.max(8, window.innerWidth - 390)),
    top: Math.max(sourceTop - 42, 8),
  };
}

function getAnnotationTagPosition(
  clientX: number,
  clientY: number,
): { left: number; top: number } {
  return {
    left: clamp(clientX + 8, 8, Math.max(8, window.innerWidth - 338)),
    top: clamp(clientY + 8, 8, Math.max(8, window.innerHeight - 240)),
  };
}

function createDefinitionBubbleId(
  pageNumber: number,
  rects: Array<{ x: number; y: number; width: number; height: number }>,
): string {
  return `definition:${pageNumber}:${rects
    .map((rectangle) =>
      [rectangle.x, rectangle.y, rectangle.width, rectangle.height]
        .map((value) => value.toFixed(5))
        .join(','),
    )
    .join(';')}`;
}

function rectanglesMatch(
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
