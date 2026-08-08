import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useElementSize } from '../hooks/useElementSize';
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
import type {
  DefinitionBubble,
  DictionaryDefinition,
  GlossaryEntry,
} from '../types/glossary';
import { resolveDocumentIdentity } from '../utils/documentIdentity';
import { createPdfDocumentInitParameters } from '../utils/pdfJsAssets';
import { PdfPage } from './pdf/PdfPage';
import { PdfSearchBar, type PdfSearchPanelPosition } from './pdf/PdfSearchBar';
import type { AnnotationFilterState } from './pdf/AnnotationFilterControl';
import { matchesAnnotationFilter } from '../utils/annotationFilter';
import { logNavigationDiagnostic } from '../utils/navigationDiagnostics';
import { SelectionAction } from './pdf/SelectionAction';
import { extractEnglishLookupWord, moveDefinitionUp } from '../utils/dictionary';
import { normalizeSelectionRectangles } from '../utils/highlights';

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
  glossaryEntries: GlossaryEntry[];
  onAddGlossaryEntry: (
    bubble: DefinitionBubble,
    preferredDefinition: DictionaryDefinition,
  ) => GlossaryEntry | null;
  onCreateHighlights: (selections: PdfTextSelection[], color: HighlightColor) => void;
  onCreateUnderlines: (selections: PdfTextSelection[], color: UnderlineColor) => void;
  onRemoveAnnotation: (annotationId: string) => void;
  onUpdateAnnotationColor: (annotationId: string, color: HighlightColor | UnderlineColor) => void;
  notedAnnotationIds: string[];
  onAddNote: (annotationId: string) => void;
  zoomOperationId: number;
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
  navigateToAnnotation: (annotationId: string) => boolean;
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

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer({
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
  glossaryEntries,
  onAddGlossaryEntry,
  onCreateHighlights,
  onCreateUnderlines,
  onRemoveAnnotation,
  onUpdateAnnotationColor,
  notedAnnotationIds,
  onAddNote,
  zoomOperationId,
  onSearchStateChange,
  annotationFilter,
  onPdfDocumentChange,
  onExplicitNavigation,
  onAnnotationNavigationApplied,
}, ref) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [viewerShellElement, setViewerShellElement] = useState<HTMLElement | null>(null);
  const [searchPanelPosition, setSearchPanelPosition] = useState<PdfSearchPanelPosition | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textSelectionRef = useRef<PdfTextSelection[]>([]);
  const pendingZoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const restoredZoomOperationRef = useRef<number | null>(null);
  const restoreFrameRef = useRef<number | null>(null);
  const highlightIndicatorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingAnnotationNavigationRef = useRef<string | null>(null);
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
  const [selectionActionPosition, setSelectionActionPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [selectedHighlight, setSelectedHighlight] = useState<{
    id: string;
    left: number;
    top: number;
  } | null>(null);
  const [annotationType, setAnnotationType] = useState<AnnotationType>('highlight');
  const [highlightColor, setHighlightColor] = useState<HighlightColor>('yellow');
  const [underlineColor, setUnderlineColor] = useState<UnderlineColor>('blue');
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [activeGlossaryEntryId, setActiveGlossaryEntryId] = useState<string | null>(null);
  const [definitionBubbles, setDefinitionBubbles] = useState<DefinitionBubble[]>([]);
  const dictionaryGenerationRef = useRef(0);
  const [activePageNumber, setActivePageNumber] = useState(1);
  const search = usePdfSearch(document);
  const activeSearchResultId = search.activeResult?.id ?? null;
  const activeSearchResultPageNumber = search.activeResult?.pageNumber ?? null;
  const containerSize = useElementSize(scrollElement);
  const setScrollContainer = useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScrollElement(element);
  }, []);
  const updateSearchPanelPosition = useCallback((position: PdfSearchPanelPosition) => {
    setSearchPanelPosition((current) => current?.x === position.x && current.y === position.y ? current : position);
  }, []);
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

      const pageCentre = page.getBoundingClientRect().top + page.getBoundingClientRect().height / 2;
      const closestCentre =
        closest.getBoundingClientRect().top + closest.getBoundingClientRect().height / 2;

      return Math.abs(pageCentre - scrollerCentre) < Math.abs(closestCentre - scrollerCentre)
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

  const applyAnnotationNavigation = useCallback((annotationId: string) => {
    const annotation = annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation) {
      return false;
    }

    const scroller = scrollRef.current;
    const page = scroller?.querySelector<HTMLElement>(`#page-${annotation.pageNumber}`);
    const firstRectangle = annotation.rects.find((rectangle) => rectangle.width > 0 && rectangle.height > 0);
    if (!scroller || !page || !firstRectangle || !page.style.height || page.clientHeight === 0) {
      return false;
    }

    const scrollerRectangle = scroller.getBoundingClientRect();
    const pageRectangle = page.getBoundingClientRect();
    const annotationAnchorY =
      pageRectangle.top + (firstRectangle.y + firstRectangle.height / 2) * pageRectangle.height;
    const preferredViewportY = scrollerRectangle.top + scroller.clientHeight * 0.4;
    const maximumScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    navigationEpochRef.current += 1;
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
    return true;
  }, [annotations, onAnnotationNavigationApplied, onExplicitNavigation]);

  const navigateToAnnotation = useCallback((annotationId: string) => {
    pendingAnnotationNavigationRef.current = annotationId;
    return applyAnnotationNavigation(annotationId);
  }, [applyAnnotationNavigation]);

  const navigateToGlossaryEntry = useCallback((glossaryEntryId: string) => {
    const entry = glossaryEntries.find(
      (candidate) => candidate.glossaryEntryId === glossaryEntryId,
    );
    if (!entry) return false;
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
  }, [glossaryEntries, onExplicitNavigation]);

  const goToPage = useCallback((pageNumber: number) => {
    navigationEpochRef.current += 1;
    onExplicitNavigation?.();
    scrollRef.current
      ?.querySelector<HTMLElement>(`#page-${pageNumber}`)
      ?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [onExplicitNavigation]);

  const captureReadingPosition = useCallback((): ReadingPosition | null => {
    const scroller = scrollRef.current;
    const page = scroller?.querySelector<HTMLElement>(`#page-${activePageNumber}`);
    if (!scroller || !page || page.clientHeight === 0) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const pageTop = page.getBoundingClientRect().top;
    return {
      pageNumber: activePageNumber,
      pageOffsetRatio: Math.min(1, Math.max(0, (scrollerTop - pageTop) / page.clientHeight)),
      zoomMode: fitMode === 'width' ? 'fit-width' : fitMode === 'page' ? 'fit-page' : 'custom',
      zoomPercent: zoom,
      updatedAt: Date.now(),
    };
  }, [activePageNumber, fitMode, zoom]);

  const applyPendingReadingPosition = useCallback(() => {
    const pendingRestore = pendingReadingRestoreRef.current;
    if (!pendingRestore || pendingRestore.navigationEpoch !== navigationEpochRef.current) {
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
      page.getBoundingClientRect().top
      - scroller.getBoundingClientRect().top
      + page.clientHeight * pendingRestore.position.pageOffsetRatio;
    pendingReadingRestoreRef.current = null;
    pendingRestore.onApplied?.();
    return true;
  }, []);

  const restoreReadingPosition = useCallback((position: ReadingPosition, onApplied?: () => void) => {
    pendingReadingRestoreRef.current = {
      position,
      navigationEpoch: navigationEpochRef.current,
      onApplied,
    };
    requestAnimationFrame(applyPendingReadingPosition);
  }, [applyPendingReadingPosition]);

  const scrollToExactSearchResult = useCallback((resultId: string, pageNumber: number) => {
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
    const maximumScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = clamp(
      scroller.scrollTop + markerAnchorY - preferredViewportY,
      0,
      maximumScrollTop,
    );
    return true;
  }, []);

  const handleTextLayerReady = useCallback((pageNumber: number) => {
    const pendingTarget = pendingSearchNavigationRef.current;
    if (
      !pendingTarget
      || pendingTarget.pageNumber !== pageNumber
      || pendingTarget.zoomOperationId !== zoomOperationId
      || pendingTarget.navigationEpoch !== navigationEpochRef.current
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
  }, [scrollToExactSearchResult, zoomOperationId]);

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
    [captureReadingPosition, captureZoomAnchor, goToPage, navigateToAnnotation, navigateToGlossaryEntry, restoreReadingPosition, search.close, search.goToNextResult, search.goToPreviousResult, search.open, search.setQuery],
  );

  const lookupWord = useCallback((selection: PdfTextSelection) => {
    const displayedWord = extractEnglishLookupWord(selection.text);
    if (!displayedWord || !documentId || selection.pageWidth <= 0 || selection.pageHeight <= 0) {
      return;
    }
    const rects = normalizeSelectionRectangles(
      selection.boundingRectangles,
      selection.pageWidth,
      selection.pageHeight,
    );
    if (rects.length === 0) return;
    const bubbleId = createDefinitionBubbleId(selection.pageNumber, rects);
    const generation = dictionaryGenerationRef.current;
    const existingGlossaryEntry = glossaryEntries.find(
      (entry) =>
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

    void import('../services/dictionaryService')
      .then(({ lookupLocalDictionary }) => lookupLocalDictionary(displayedWord))
      .then((result) => {
        if (dictionaryGenerationRef.current !== generation) return;
        setDefinitionBubbles((current) =>
          current.map((candidate) =>
            candidate.id === bubbleId
              ? {
                  ...candidate,
                  normalizedLookupWord: result.normalizedWord,
                  definitions: result.definitions,
                  status: result.definitions.length > 0 ? 'ready' : 'not-found',
                }
              : candidate,
          ),
        );
      })
      .catch(() => {
        if (dictionaryGenerationRef.current !== generation) return;
        setDefinitionBubbles((current) =>
          current.map((candidate) =>
            candidate.id === bubbleId ? { ...candidate, status: 'error' } : candidate,
          ),
        );
      });
  }, [documentId, glossaryEntries]);

  const addBubbleToGlossary = useCallback((bubbleId: string) => {
    const bubble = definitionBubbles.find((candidate) => candidate.id === bubbleId);
    const preferredDefinition = bubble?.definitions[0];
    if (!bubble || !preferredDefinition || bubble.glossaryEntryId) return;
    const entry = onAddGlossaryEntry(bubble, preferredDefinition);
    if (!entry) return;
    setDefinitionBubbles((current) =>
      current.map((candidate) =>
        candidate.id === bubbleId
          ? { ...candidate, glossaryEntryId: entry.glossaryEntryId }
          : candidate,
      ),
    );
  }, [definitionBubbles, onAddGlossaryEntry]);

  const closeDefinitionBubble = useCallback((bubbleId: string) => {
    setDefinitionBubbles((current) => current.filter((bubble) => bubble.id !== bubbleId));
  }, []);

  const moveBubbleDefinitionUp = useCallback((bubbleId: string, definitionId: string) => {
    setDefinitionBubbles((current) =>
      current.map((bubble) =>
        bubble.id === bubbleId
          ? { ...bubble, definitions: moveDefinitionUp(bubble.definitions, definitionId) }
          : bubble,
      ),
    );
  }, []);

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
      setSelectionActionPosition(getSelectionActionPosition(selection));
      setSelectedHighlight(null);
    },
    [onTextSelectionChange],
  );

  usePdfTextSelection(scrollElement, handleTextSelectionChange);

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
        const targetPage = scroller.querySelector<HTMLElement>(`#page-${anchor.pageNumber}`);

        if (!targetPage || pendingZoomAnchorRef.current !== anchor) {
          return;
        }

        const scrollerCentre = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
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

  const handlePageLayoutChange = useCallback((pageNumber: number) => {
    restoreZoomAnchor(pageNumber);
    if (pendingReadingRestoreRef.current?.position.pageNumber === pageNumber) {
      applyPendingReadingPosition();
    }
    const annotationId = pendingAnnotationNavigationRef.current;
    const annotation = annotations.find((candidate) => candidate.id === annotationId);
    if (annotation?.pageNumber === pageNumber) {
      applyAnnotationNavigation(annotation.id);
    }
  }, [annotations, applyAnnotationNavigation, applyPendingReadingPosition, restoreZoomAnchor]);

  useEffect(
    () => () => {
      if (restoreFrameRef.current !== null) {
        cancelAnimationFrame(restoreFrameRef.current);
      }
      if (highlightIndicatorTimeoutRef.current !== null) {
        clearTimeout(highlightIndicatorTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const dismissActions = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && document) {
        event.preventDefault();
        search.open();
        return;
      }
      if (event.key !== 'Escape') {
        return;
      }

      if (selectionActionPosition || selectedHighlight) {
        window.getSelection()?.removeAllRanges();
        setSelectionActionPosition(null);
        setSelectedHighlight(null);
      } else if (search.isOpen) {
        search.close();
      }
    };

    window.addEventListener('keydown', dismissActions);
    return () => window.removeEventListener('keydown', dismissActions);
  }, [document, search, selectedHighlight, selectionActionPosition]);

  useEffect(() => {
    if (!file) {
      setDocument(null);
      pendingAnnotationNavigationRef.current = null;
      pendingReadingRestoreRef.current = null;
      onPdfDocumentChange?.(null);
      setError(null);
      return;
    }

    let isDisposed = false;
    const objectUrl = URL.createObjectURL(file);
    const loadingTask = getDocument(createPdfDocumentInitParameters({ url: objectUrl }));

    setDocument(null);
    setError(null);

    void loadingTask.promise
      .then((loadedDocument) => {
        if (isDisposed) {
          void loadedDocument.destroy();
          return;
        }

        setDocument(loadedDocument);
        onPdfDocumentChange?.(loadedDocument);
        onDocumentReady(resolveDocumentIdentity(file, loadedDocument), file);
        onPageCountChange(loadedDocument.numPages);
        onCurrentPageChange(1);
      })
      .catch(() => {
        if (!isDisposed) {
          onPdfDocumentChange?.(null);
          setError('This PDF could not be opened.');
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
  }, [file, onCurrentPageChange, onPageCountChange, onDocumentReady, onPdfDocumentChange]);

  useEffect(() => {
    setSearchPanelPosition(null);
    dictionaryGenerationRef.current += 1;
    setDefinitionBubbles([]);
  }, [file]);

  const visibleAnnotations = annotations.filter((annotation) => matchesAnnotationFilter(annotation, notedAnnotationIds, annotationFilter));
  const annotationsForPage = (pageNumber: number) => {
    const filteredPageAnnotations = visibleAnnotations.filter(
      (annotation) => annotation.pageNumber === pageNumber,
    );
    const activeFilteredAnnotation = annotations.find(
      (annotation) =>
        annotation.id === activeAnnotationId
        && annotation.pageNumber === pageNumber
        && !filteredPageAnnotations.some((candidate) => candidate.id === annotation.id),
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
      const pages = Array.from(scrollElement.querySelectorAll<HTMLElement>('.pdf-page-shell'));
      const closestPage = pages.reduce<HTMLElement | null>((closest, page) => {
        if (!closest) {
          return page;
        }

        const pageCentre = page.getBoundingClientRect().top + page.getBoundingClientRect().height / 2;
        const closestCentre = closest.getBoundingClientRect().top + closest.getBoundingClientRect().height / 2;
        return Math.abs(pageCentre - centre) < Math.abs(closestCentre - centre) ? page : closest;
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

  const createAnnotation = () => {
    if (annotationType === 'highlight') {
      onCreateHighlights(textSelectionRef.current, highlightColor);
    } else {
      onCreateUnderlines(textSelectionRef.current, underlineColor);
    }
    window.getSelection()?.removeAllRanges();
    setSelectionActionPosition(null);
  };

  const selectHighlight = (highlightId: string, left: number, top: number) => {
    setSelectionActionPosition(null);
    setSelectedHighlight({ id: highlightId, left, top });
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
          <span className="viewer-icon" aria-hidden="true">&#128196;</span>
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
        <div className="viewer-error" role="alert">{error}</div>
      ) : (
        <div className="pdf-scroll" ref={setScrollContainer}>
          {document ? (
            <div className="pdf-page-stack">
              {Array.from({ length: document.numPages }, (_, index) => (
                <PdfPage
                  containerSize={containerSize}
                  document={document}
                  fitMode={fitMode}
                  annotations={annotationsForPage(index + 1)}
                  glossaryEntries={glossaryEntries.filter(
                    (entry) => entry.pageNumber === index + 1,
                  )}
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
                  onAnnotationSelect={selectHighlight}
                  onWordLookup={lookupWord}
                  onAddBubbleToGlossary={addBubbleToGlossary}
                  onCloseDefinitionBubble={closeDefinitionBubble}
                  onMoveDefinitionUp={moveBubbleDefinitionUp}
                  onToggleDefinitionsExpanded={toggleDefinitionsExpanded}
                  onPageLayoutChange={handlePageLayoutChange}
                  onTextLayerReady={handleTextLayerReady}
                  searchResults={search.results.filter((result) => result.pageNumber === index + 1)}
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
          onActivate={createAnnotation}
          selectedColor={annotationType === 'highlight' ? highlightColor : underlineColor}
          onColorChange={(color) => {
            if (annotationType === 'highlight') {
              setHighlightColor(color as HighlightColor);
            } else {
              setUnderlineColor(color as UnderlineColor);
            }
          }}
        />
      ) : null}
      {search.isOpen ? (
        <PdfSearchBar
          activeResultIndex={search.activeResult
            ? search.results.findIndex((result) => result.id === search.activeResult?.id)
            : -1}
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
      {selectedHighlight ? (
        <SelectionAction
          position={selectedHighlight}
          annotationType={annotations.find((annotation) => annotation.id === selectedHighlight.id)?.type}
          selectedColor={annotations.find((annotation) => annotation.id === selectedHighlight.id)?.color}
          onColorChange={(color) => onUpdateAnnotationColor(selectedHighlight.id, color)}
          actions={[
            {
              label: 'Delete',
              onActivate: () => {
                onRemoveAnnotation(selectedHighlight.id);
                setSelectedHighlight(null);
              },
            },
            {
              label: notedAnnotationIds.includes(selectedHighlight.id) ? 'Open/Edit Note' : 'Add Note',
              onActivate: () => {
                onAddNote(selectedHighlight.id);
                setSelectedHighlight(null);
              },
            },
          ]}
        />
      ) : null}
    </section>
  );
});

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
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
  const anchor = rectangle.width > 0 && rectangle.height > 0 ? rectangle : firstRectangle;

  if (!anchor) {
    return null;
  }

  return {
    left: Math.min(Math.max(anchor.left, 8), window.innerWidth - 110),
    top: Math.max(anchor.top - 42, 8),
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
