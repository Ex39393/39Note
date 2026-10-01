import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { ViewerHandle } from './Viewer';
import {
  selectDocumentAdapter,
  type DocumentAdapter,
  type DocumentReadingPosition,
  type DocumentSearchResult,
  type DocumentTextSelection,
  type DocumentTextSource,
} from '../documents';
import type { OpenedPptxDocument } from '../documents/pptx/PptxAdapter';
import type {
  PptxParagraph,
  PptxShape,
  PptxSlide,
  PptxSlideDescriptor,
  PptxTextRun,
} from '../documents/pptx/model';
import type { OpenedDocxDocument } from '../documents/docx/DocxAdapter';
import type {
  DocxFlowBlock,
  DocxParagraphBlock,
  DocxTextRun,
} from '../documents/docx/model';
import type { OoxmlImageResource } from '../documents/ooxml/package';
import {
  loadDocumentState,
  saveDocumentReadingPosition,
  saveOfficeDocumentAnnotations,
} from '../services/annotationPersistence';
import type {
  OfficeDocumentAnnotation,
  OfficeMarkColor,
  OfficeMarkType,
} from '../documents/annotations';
import type { DocumentIdentity } from '../types/persistence';
import type { DocumentType } from '../types/document';
import { sha256Hex } from '../sync/hash';
import { lookupDictionary } from '../services/dictionaryService';
import {
  isSemanticGlossaryEntry,
  type DictionaryDefinition,
  type GlossaryEntry,
  type SemanticGlossaryEntry,
} from '../types/glossary';
import { createSemanticGlossaryEntry } from '../utils/glossaryModel';
import type { DocxSemanticAnchor, PptxSemanticAnchor } from '../documents/anchors';

type OpenedOfficeDocument = OpenedPptxDocument | OpenedDocxDocument;

interface OfficeDocumentViewerProps {
  file: File;
  zoom: number;
  documentIdHint: string | null;
  refreshToken: number;
  onDocumentReady: (
    identity: DocumentIdentity,
    file: File,
    documentType: Extract<DocumentType, 'pptx' | 'docx'>,
  ) => void;
  onNavigationCountChange: (count: number) => void;
  onCurrentNavigationChange: (index: number) => void;
  glossaryEntries: readonly GlossaryEntry[];
  onAddGlossaryEntry: (entry: SemanticGlossaryEntry) => boolean;
  onRemoveGlossaryEntry: (glossaryEntryId: string) => void;
  onDocumentTextSourceChange: (source: DocumentTextSource | null) => void;
  onPersistentChange?: () => void;
}

interface PendingSelection {
  readonly selection: DocumentTextSelection;
  readonly selectedWord: string | null;
}

interface RunLike {
  readonly text: string;
  readonly style: {
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly underline?: boolean;
    readonly fontFamily?: string;
    readonly fontSizePoints?: number;
    readonly color?: string;
  };
  readonly hyperlink?: string;
}

type OfficeSemanticAnchor = PptxSemanticAnchor | DocxSemanticAnchor;

interface OfficeAnnotationResolution {
  readonly stored: OfficeDocumentAnnotation;
  readonly rendered?: OfficeDocumentAnnotation;
  readonly status: 'resolving' | 'exact' | 'relocated' | 'ambiguous' | 'missing';
}

const DOCX_BLOCK_BATCH = 120;

export const OfficeDocumentViewer = forwardRef<ViewerHandle, OfficeDocumentViewerProps>(
  function OfficeDocumentViewer(
    {
      file,
      zoom,
      documentIdHint,
      refreshToken,
      onDocumentReady,
      onNavigationCountChange,
      onCurrentNavigationChange,
      glossaryEntries,
      onAddGlossaryEntry,
      onRemoveGlossaryEntry,
      onDocumentTextSourceChange,
      onPersistentChange,
    },
    ref,
  ) {
    const [opened, setOpened] = useState<OpenedOfficeDocument | null>(null);
    const [adapter, setAdapter] = useState<DocumentAdapter | null>(null);
    const [annotations, setAnnotations] = useState<OfficeDocumentAnnotation[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [isOpening, setIsOpening] = useState(true);
    const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(
      null,
    );
    const [markType, setMarkType] = useState<OfficeMarkType>('highlight');
    const [markColor, setMarkColor] = useState<OfficeMarkColor>('yellow');
    const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(
      null,
    );
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<readonly DocumentSearchResult[]>(
      [],
    );
    const [activeSearchResult, setActiveSearchResult] = useState(0);
    const [isSearching, setIsSearching] = useState(false);
    const [currentNavigation, setCurrentNavigation] = useState(1);
    const [visibleDocxBlocks, setVisibleDocxBlocks] = useState(DOCX_BLOCK_BATCH);
    const [dictionaryDefinitions, setDictionaryDefinitions] = useState<
      readonly DictionaryDefinition[]
    >([]);
    const [dictionaryWord, setDictionaryWord] = useState<string | null>(null);
    const [dictionaryLoading, setDictionaryLoading] = useState(false);
    const [dictionaryAnchor, setDictionaryAnchor] =
      useState<OfficeSemanticAnchor | null>(null);
    const [annotationResolutions, setAnnotationResolutions] = useState<
      readonly OfficeAnnotationResolution[]
    >([]);
    const [glossaryNavigationError, setGlossaryNavigationError] = useState<
      string | null
    >(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const navigationEpochRef = useRef(0);
    const currentNavigationRef = useRef(1);
    const openingSequenceRef = useRef(0);
    const dictionaryAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
      const sequence = openingSequenceRef.current + 1;
      openingSequenceRef.current = sequence;
      let cancelled = false;
      setOpened(null);
      setAdapter(null);
      setAnnotations([]);
      setError(null);
      setIsOpening(true);
      setPendingSelection(null);
      setSearchResults([]);
      setSearchQuery('');
      setDictionaryAnchor(null);
      setAnnotationResolutions([]);
      setGlossaryNavigationError(null);
      setVisibleDocxBlocks(DOCX_BLOCK_BATCH);
      setCurrentNavigation(1);

      void (async () => {
        try {
          const sourceBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(sourceBuffer);
          if (cancelled || openingSequenceRef.current !== sequence) return;
          const selected = await selectDocumentAdapter({
            documentId:
              documentIdHint ?? `source:document:${await sha256Hex(sourceBuffer)}`,
            fileName: file.name,
            mimeType: file.type,
            bytes,
          });
          if (selected.source.documentType === 'pdf') {
            throw new Error('The Office reader received a PDF source.');
          }
          const nextOpened = (await selected.adapter.open(
            selected.source,
          )) as OpenedOfficeDocument;
          if (cancelled || openingSequenceRef.current !== sequence) return;
          const identity = {
            documentId: nextOpened.documentId,
            documentName: file.name,
          };
          setAdapter(selected.adapter);
          setOpened(nextOpened);
          setIsOpening(false);
          onNavigationCountChange(
            nextOpened.documentType === 'pptx'
              ? nextOpened.renderModel.slides.length
              : Math.max(1, maxBlockIndex(nextOpened.renderModel.blocks)),
          );
          onCurrentNavigationChange(1);
          onDocumentReady(identity, file, nextOpened.documentType);

          const persisted = await loadDocumentState(identity.documentId);
          if (cancelled || openingSequenceRef.current !== sequence) return;
          if (persisted?.documentType === nextOpened.documentType) {
            setAnnotations(persisted.officeAnnotations);
            const readingPosition = persisted.documentReadingPosition
              ? selected.adapter.normalizeReadingPosition(
                  nextOpened,
                  persisted.documentReadingPosition,
                )
              : null;
            restoreReadingPosition(
              nextOpened,
              readingPosition ?? undefined,
              false,
              () => scrollRef.current,
              (blockIndex) =>
                setVisibleDocxBlocks((count) =>
                  Math.max(count, blockIndex + DOCX_BLOCK_BATCH),
                ),
            );
          }
        } catch (cause) {
          if (cancelled || openingSequenceRef.current !== sequence) return;
          setIsOpening(false);
          setError(
            cause instanceof Error
              ? cause.message
              : 'This Office document could not be opened safely.',
          );
          onNavigationCountChange(0);
          onCurrentNavigationChange(0);
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [
      documentIdHint,
      file,
      onCurrentNavigationChange,
      onDocumentReady,
      onNavigationCountChange,
    ]);

    useEffect(() => {
      if (!opened) return;
      let cancelled = false;
      void loadDocumentState(opened.documentId).then((persisted) => {
        if (
          !cancelled &&
          persisted?.documentType === opened.documentType &&
          persisted.officeAnnotations
        ) {
          setAnnotations(persisted.officeAnnotations);
        }
      });
      return () => {
        cancelled = true;
      };
    }, [opened, refreshToken]);

    useEffect(() => {
      if (!opened || !adapter?.extractTextUnits) {
        onDocumentTextSourceChange(null);
        return;
      }
      const extractTextUnits = adapter.extractTextUnits.bind(adapter);
      const source: DocumentTextSource = {
        documentType: opened.documentType,
        unitKind: opened.documentType === 'pptx' ? 'slide' : 'block',
        totalUnits:
          opened.documentType === 'pptx'
            ? opened.renderModel.slides.length
            : opened.searchEntries.length,
        loadUnits: (options) => extractTextUnits(opened, options),
      };
      onDocumentTextSourceChange(source);
      return () => onDocumentTextSourceChange(null);
    }, [adapter, onDocumentTextSourceChange, opened]);

    useEffect(() => {
      if (!opened || !adapter || annotations.length === 0) {
        setAnnotationResolutions([]);
        return;
      }
      let cancelled = false;
      setAnnotationResolutions(
        annotations.map((stored) => ({ stored, status: 'resolving' })),
      );
      void Promise.all(
        annotations.map(async (stored): Promise<OfficeAnnotationResolution> => {
          const resolution = await adapter.resolveAnchor(opened, stored.anchor);
          if (
            resolution.status === 'ambiguous' ||
            resolution.status === 'missing' ||
            !resolution.selection
          ) {
            return { stored, status: resolution.status };
          }
          const resolvedAnchor = adapter.createAnchor(opened, resolution.selection);
          if (!resolvedAnchor || resolvedAnchor.kind === 'pdf-text') {
            return { stored, status: 'missing' };
          }
          return {
            stored,
            rendered: { ...stored, anchor: resolvedAnchor },
            status: resolution.status,
          };
        }),
      ).then(
        (resolutions) => {
          if (!cancelled) setAnnotationResolutions(resolutions);
        },
        () => {
          if (!cancelled) {
            setAnnotationResolutions(
              annotations.map((stored) => ({ stored, status: 'missing' })),
            );
          }
        },
      );
      return () => {
        cancelled = true;
      };
    }, [adapter, annotations, opened]);

    const goToNavigation = useCallback(
      (oneBasedIndex: number, explicit = true) => {
        if (!opened) return;
        const zeroBasedIndex = Math.max(0, Math.floor(oneBasedIndex) - 1);
        if (opened.documentType === 'docx') {
          setVisibleDocxBlocks((count) =>
            Math.max(count, zeroBasedIndex + Math.floor(DOCX_BLOCK_BATCH / 2)),
          );
        }
        if (explicit) navigationEpochRef.current += 1;
        requestAnimationFrame(() => {
          const element = scrollRef.current?.querySelector<HTMLElement>(
            `[data-office-navigation-index="${zeroBasedIndex}"]`,
          );
          element?.scrollIntoView({
            behavior: explicit ? 'smooth' : 'auto',
            block: 'start',
          });
        });
      },
      [opened],
    );

    const navigateToSearchResult = useCallback(
      (result: DocumentSearchResult, resultIndex: number) => {
        if (!opened) return;
        setActiveSearchResult(resultIndex);
        if (result.target.kind === 'pptx-slide') {
          goToNavigation(result.target.slideIndex + 1);
          return;
        }
        if (result.target.kind === 'docx-block') {
          const target = result.target;
          setVisibleDocxBlocks((count) =>
            Math.max(count, target.blockIndex + DOCX_BLOCK_BATCH),
          );
          navigationEpochRef.current += 1;
          requestAnimationFrame(() => {
            scrollRef.current
              ?.querySelector<HTMLElement>(
                `[data-office-block-id="${cssEscape(target.blockId)}"]`,
              )
              ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        }
      },
      [goToNavigation, opened],
    );

    useEffect(() => {
      if (!opened || !adapter || !searchQuery.trim()) {
        setSearchResults([]);
        setActiveSearchResult(0);
        setIsSearching(false);
        return;
      }
      let cancelled = false;
      const timer = setTimeout(() => {
        setIsSearching(true);
        void adapter.search(opened, searchQuery).then(
          (results) => {
            if (cancelled) return;
            setSearchResults(results);
            setActiveSearchResult(0);
            setIsSearching(false);
          },
          () => {
            if (cancelled) return;
            setSearchResults([]);
            setIsSearching(false);
          },
        );
      }, 180);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, [adapter, opened, searchQuery]);

    useEffect(() => {
      const scrollElement = scrollRef.current;
      if (!scrollElement || !opened) return;
      let frame: number | null = null;
      const update = () => {
        frame = null;
        const rootTop = scrollElement.getBoundingClientRect().top;
        const units = Array.from(
          scrollElement.querySelectorAll<HTMLElement>('[data-office-navigation-index]'),
        );
        let closest: HTMLElement | null = null;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const unit of units) {
          const distance = Math.abs(unit.getBoundingClientRect().top - rootTop - 24);
          if (distance < closestDistance) {
            closestDistance = distance;
            closest = unit;
          }
        }
        const index = Number(closest?.dataset.officeNavigationIndex);
        if (Number.isSafeInteger(index) && index >= 0) {
          const oneBasedIndex = index + 1;
          if (currentNavigationRef.current !== oneBasedIndex) {
            currentNavigationRef.current = oneBasedIndex;
            setCurrentNavigation(oneBasedIndex);
            onCurrentNavigationChange(oneBasedIndex);
          }
        }
        if (
          opened.documentType === 'docx' &&
          scrollElement.scrollHeight -
            scrollElement.scrollTop -
            scrollElement.clientHeight <
            1_200
        ) {
          setVisibleDocxBlocks((count) => count + DOCX_BLOCK_BATCH);
        }
      };
      const onScroll = () => {
        if (frame === null) frame = requestAnimationFrame(update);
      };
      scrollElement.addEventListener('scroll', onScroll, { passive: true });
      update();
      return () => {
        scrollElement.removeEventListener('scroll', onScroll);
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }, [onCurrentNavigationChange, opened]);

    useEffect(() => {
      if (!opened || currentNavigation < 1) return;
      const timer = setTimeout(() => {
        const position = captureOfficeReadingPosition(opened, currentNavigation);
        if (position) void saveDocumentReadingPosition(opened.documentId, position);
      }, 900);
      return () => clearTimeout(timer);
    }, [currentNavigation, opened]);

    const persistAnnotations = useCallback(
      (next: OfficeDocumentAnnotation[]) => {
        if (!opened) return;
        setAnnotations(next);
        void saveOfficeDocumentAnnotations(opened.documentId, next).then((saved) => {
          if (saved) onPersistentChange?.();
        });
      },
      [onPersistentChange, opened],
    );

    const createMark = useCallback(() => {
      if (!opened || !adapter || !pendingSelection) return;
      const anchor = adapter.createAnchor(opened, pendingSelection.selection);
      if (!anchor || anchor.kind === 'pdf-text') return;
      const now = Date.now();
      const next: OfficeDocumentAnnotation = {
        version: 1,
        id: crypto.randomUUID(),
        documentId: opened.documentId,
        markType,
        color: markType === 'underline' && markColor === 'yellow' ? 'red' : markColor,
        anchor,
        createdAt: now,
        updatedAt: now,
      };
      persistAnnotations([...annotations, next]);
      setPendingSelection(null);
      window.getSelection()?.removeAllRanges();
    }, [
      adapter,
      annotations,
      markColor,
      markType,
      opened,
      pendingSelection,
      persistAnnotations,
    ]);

    const updateNote = useCallback(
      (annotationId: string, content: string) => {
        const now = Date.now();
        persistAnnotations(
          annotations.map((annotation) =>
            annotation.id === annotationId
              ? {
                  ...annotation,
                  note: {
                    id: annotation.note?.id ?? crypto.randomUUID(),
                    displayNumber:
                      annotation.note?.displayNumber ??
                      String(
                        annotations.filter((candidate) => candidate.note).length + 1,
                      ),
                    content,
                    updatedAt: now,
                  },
                  updatedAt: now,
                }
              : annotation,
          ),
        );
      },
      [annotations, persistAnnotations],
    );

    const lookupSelectedWord = useCallback(() => {
      const word = pendingSelection?.selectedWord;
      if (!word || !opened || !adapter || !pendingSelection) return;
      const anchor = adapter.createAnchor(opened, pendingSelection.selection);
      if (!anchor || anchor.kind === 'pdf-text') return;
      dictionaryAbortRef.current?.abort();
      const controller = new AbortController();
      dictionaryAbortRef.current = controller;
      setDictionaryWord(word);
      setDictionaryAnchor(anchor);
      setDictionaryDefinitions([]);
      setDictionaryLoading(true);
      void lookupDictionary(
        word,
        {
          onLocalResult: (result) => setDictionaryDefinitions(result.definitions),
          onRemoteResult: (definitions) =>
            setDictionaryDefinitions((current) =>
              mergeDefinitions(current, definitions),
            ),
          onComplete: () => setDictionaryLoading(false),
        },
        controller.signal,
      );
    }, [adapter, opened, pendingSelection]);

    const captureSelection = useCallback(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        setPendingSelection(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const startContainer = closestTextContainer(range.startContainer);
      const endContainer = closestTextContainer(range.endContainer);
      if (!startContainer || startContainer !== endContainer) {
        setPendingSelection(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) return;
      const startOffset = textOffsetWithin(
        startContainer,
        range.startContainer,
        range.startOffset,
      );
      const endOffset = textOffsetWithin(
        startContainer,
        range.endContainer,
        range.endOffset,
      );
      if (startOffset === null || endOffset === null || endOffset <= startOffset)
        return;
      const target = selectionTargetFromElement(startContainer);
      if (!target) return;
      const fragment: DocumentTextSelection['fragments'][number] = {
        containerId: startContainer.dataset.officeContainer ?? '',
        text,
        startOffset,
        endOffset,
        ...(target.kind === 'pptx-slide'
          ? { rect: normalizedSelectionRect(range, startContainer) }
          : {}),
      };
      setPendingSelection({
        selection: { text, target, fragments: [fragment] },
        selectedWord: /^[A-Za-z]+(?:['’-][A-Za-z]+)?$/u.test(text.trim())
          ? text.trim()
          : null,
      });
    }, []);

    const navigateToSemanticAnchor = useCallback(
      (anchor: OfficeSemanticAnchor): boolean => {
        if (!opened || !adapter || anchor.documentId !== opened.documentId) {
          return false;
        }
        setGlossaryNavigationError(null);
        void adapter.resolveAnchor(opened, anchor).then(
          (resolution) => {
            if (resolution.status === 'ambiguous') {
              setGlossaryNavigationError(
                'This saved location now matches more than one passage, so 39Note did not guess.',
              );
              return;
            }
            if (resolution.status === 'missing' || !resolution.selection) {
              setGlossaryNavigationError(
                'This saved location could not be resolved in the current document.',
              );
              return;
            }
            const target = resolution.selection.target;
            if (target.kind === 'pptx-slide') {
              goToNavigation(target.slideIndex + 1);
              return;
            }
            if (target.kind === 'docx-block') {
              setVisibleDocxBlocks((count) =>
                Math.max(count, target.blockIndex + DOCX_BLOCK_BATCH),
              );
              navigationEpochRef.current += 1;
              requestAnimationFrame(() => {
                scrollRef.current
                  ?.querySelector<HTMLElement>(
                    `[data-office-block-id="${cssEscape(target.blockId)}"]`,
                  )
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              });
            }
          },
          () => {
            setGlossaryNavigationError(
              'This saved location could not be resolved safely.',
            );
          },
        );
        return true;
      },
      [adapter, goToNavigation, opened],
    );

    const navigateToResolvedAnnotation = useCallback(
      (annotationId: string): boolean => {
        const resolution = annotationResolutions.find(
          (candidate) => candidate.stored.id === annotationId,
        );
        const annotation = resolution?.rendered;
        if (!annotation) {
          setSelectedAnnotationId(annotationId);
          return false;
        }
        setSelectedAnnotationId(annotationId);
        return navigateToSemanticAnchor(annotation.anchor);
      },
      [annotationResolutions, navigateToSemanticAnchor],
    );

    useImperativeHandle(
      ref,
      () => ({
        captureZoomAnchor: () => undefined,
        navigateToAnnotation: (annotationId) =>
          navigateToResolvedAnnotation(annotationId),
        navigateToGlossaryEntry: (glossaryEntryId) => {
          const entry = glossaryEntries.find(
            (candidate) =>
              candidate.glossaryEntryId === glossaryEntryId &&
              isSemanticGlossaryEntry(candidate),
          );
          return entry && isSemanticGlossaryEntry(entry)
            ? navigateToSemanticAnchor(entry.anchor)
            : false;
        },
        goToPage: (pageNumber) => goToNavigation(pageNumber),
        openSearch: () => {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.focus());
        },
        closeSearch: () => setSearchOpen(false),
        captureReadingPosition: () => null,
        restoreReadingPosition: (_position, onApplied) => onApplied?.(),
        getNavigationEpoch: () => navigationEpochRef.current,
        setSearchQuery: (query) => {
          setSearchOpen(true);
          setSearchQuery(query);
        },
        goToPreviousSearchResult: () => {
          if (searchResults.length === 0) return;
          const index =
            (activeSearchResult - 1 + searchResults.length) % searchResults.length;
          navigateToSearchResult(searchResults[index], index);
        },
        goToNextSearchResult: () => {
          if (searchResults.length === 0) return;
          const index = (activeSearchResult + 1) % searchResults.length;
          navigateToSearchResult(searchResults[index], index);
        },
      }),
      [
        activeSearchResult,
        goToNavigation,
        glossaryEntries,
        navigateToResolvedAnnotation,
        navigateToSearchResult,
        navigateToSemanticAnchor,
        searchResults,
      ],
    );

    const outline = opened?.outline ?? [];
    const selectedAnnotation = annotations.find(
      (annotation) => annotation.id === selectedAnnotationId,
    );
    const resolvedAnnotations = useMemo(
      () =>
        annotationResolutions.flatMap((resolution) =>
          resolution.rendered ? [resolution.rendered] : [],
        ),
      [annotationResolutions],
    );
    const documentGlossaryEntries = useMemo(
      () =>
        glossaryEntries.filter(
          (entry): entry is SemanticGlossaryEntry =>
            isSemanticGlossaryEntry(entry) &&
            entry.documentId === opened?.documentId &&
            ((opened?.documentType === 'pptx' && entry.anchor.kind === 'pptx-text') ||
              (opened?.documentType === 'docx' && entry.anchor.kind === 'docx-text')),
        ),
      [glossaryEntries, opened],
    );
    const dictionaryGlossaryEntry =
      dictionaryWord && dictionaryAnchor
        ? documentGlossaryEntries.find(
            (entry) =>
              entry.normalizedLookupWord ===
                dictionaryWord.toLocaleLowerCase('en-US') &&
              anchorsShareLocation(entry.anchor, dictionaryAnchor),
          )
        : undefined;
    const content = useMemo(() => {
      if (!opened) return null;
      return opened.documentType === 'pptx' ? (
        <div className="office-pptx-deck">
          {opened.renderModel.slides.map((slide) => (
            <LazyPptxSlide
              annotations={resolvedAnnotations}
              descriptor={slide}
              key={slide.id}
              onSelectAnnotation={setSelectedAnnotationId}
            />
          ))}
        </div>
      ) : (
        <DocxDocument
          annotations={resolvedAnnotations}
          blocks={opened.renderModel.blocks}
          maxBlockIndex={visibleDocxBlocks}
          onSelectAnnotation={setSelectedAnnotationId}
        />
      );
    }, [opened, resolvedAnnotations, visibleDocxBlocks]);

    if (isOpening) {
      return (
        <section className="office-viewer-state" role="status">
          Opening document safely…
        </section>
      );
    }
    if (error || !opened) {
      return (
        <section className="office-viewer-state is-error" role="alert">
          <h2>Couldn’t open this document</h2>
          <p>{error ?? 'The document format could not be verified.'}</p>
        </section>
      );
    }

    return (
      <section
        className={`office-viewer office-viewer-${opened.documentType}`}
        style={{ '--office-zoom': zoom } as CSSProperties}
      >
        <aside
          className="office-outline"
          aria-label={`${opened.documentType.toUpperCase()} navigation`}
        >
          <div className="office-outline-heading">
            <span>{opened.documentType === 'pptx' ? 'Slides' : 'Outline'}</span>
            <small>{opened.documentType.toUpperCase()}</small>
          </div>
          <div className="office-outline-list">
            {(outline.length > 0 ? outline : opened.navigationUnits).map(
              (item, index) => (
                <button
                  className="office-outline-item"
                  key={item.id}
                  style={{
                    paddingInlineStart: `${12 + ('level' in item ? item.level - 1 : 0) * 12}px`,
                  }}
                  type="button"
                  onClick={() => {
                    if (item.target.kind === 'pptx-slide') {
                      goToNavigation(item.target.slideIndex + 1);
                    } else if (item.target.kind === 'docx-block') {
                      const target = item.target;
                      setVisibleDocxBlocks((count) =>
                        Math.max(count, target.blockIndex + DOCX_BLOCK_BATCH),
                      );
                      requestAnimationFrame(() => {
                        scrollRef.current
                          ?.querySelector<HTMLElement>(
                            `[data-office-block-id="${cssEscape(target.blockId)}"]`,
                          )
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      });
                    } else {
                      goToNavigation(index + 1);
                    }
                  }}
                >
                  {opened.documentType === 'pptx' &&
                  item.target.kind === 'pptx-slide' ? (
                    <PptxThumbnail
                      descriptor={opened.renderModel.slides[item.target.slideIndex]}
                    />
                  ) : (
                    item.label
                  )}
                </button>
              ),
            )}
          </div>
          {annotationResolutions.length > 0 ? (
            <div className="office-mark-list">
              <h3>Marks</h3>
              {annotationResolutions.map((resolution) => (
                <button
                  className={
                    resolution.stored.id === selectedAnnotationId ? 'is-selected' : ''
                  }
                  key={resolution.stored.id}
                  type="button"
                  onClick={() => {
                    navigateToResolvedAnnotation(resolution.stored.id);
                  }}
                >
                  <span className={`office-mark-dot is-${resolution.stored.color}`} />
                  <span>{resolution.stored.anchor.quote.slice(0, 48)}</span>
                  {resolution.status === 'resolving' ? (
                    <small>Resolving…</small>
                  ) : resolution.status === 'ambiguous' ? (
                    <small>Ambiguous location</small>
                  ) : resolution.status === 'missing' ? (
                    <small>Location unavailable</small>
                  ) : resolution.status === 'relocated' ? (
                    <small>Resolved by text</small>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {documentGlossaryEntries.length > 0 ? (
            <div className="office-mark-list office-glossary-list">
              <h3>Glossary</h3>
              {documentGlossaryEntries.map((entry) => (
                <div className="office-glossary-item" key={entry.glossaryEntryId}>
                  <button
                    type="button"
                    onClick={() => navigateToSemanticAnchor(entry.anchor)}
                  >
                    <strong>{entry.displayedWord}</strong>
                    <small>{entry.locationLabel}</small>
                  </button>
                  <button
                    aria-label={`Remove ${entry.displayedWord} from Glossary`}
                    type="button"
                    onClick={() => onRemoveGlossaryEntry(entry.glossaryEntryId)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
        <div className="office-reader-column">
          {glossaryNavigationError ? (
            <div className="office-navigation-error" role="status">
              <span>{glossaryNavigationError}</span>
              <button type="button" onClick={() => setGlossaryNavigationError(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {searchOpen ? (
            <div className="office-search" role="search">
              <input
                aria-label={`Search ${opened.documentType.toUpperCase()}`}
                placeholder="Search this document"
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <span>
                {isSearching
                  ? 'Searching…'
                  : searchQuery
                    ? `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`
                    : ''}
              </span>
              <button
                disabled={searchResults.length === 0}
                type="button"
                onClick={() => {
                  if (searchResults.length === 0) return;
                  const index =
                    (activeSearchResult - 1 + searchResults.length) %
                    searchResults.length;
                  navigateToSearchResult(searchResults[index], index);
                }}
              >
                Previous
              </button>
              <button
                disabled={searchResults.length === 0}
                type="button"
                onClick={() => {
                  if (searchResults.length === 0) return;
                  const index = (activeSearchResult + 1) % searchResults.length;
                  navigateToSearchResult(searchResults[index], index);
                }}
              >
                Next
              </button>
              <button type="button" onClick={() => setSearchOpen(false)}>
                Close
              </button>
            </div>
          ) : null}
          {pendingSelection ? (
            <div
              className="office-selection-actions"
              role="toolbar"
              aria-label="Selected text actions"
            >
              <button
                aria-pressed={markType === 'highlight'}
                type="button"
                onClick={() => {
                  setMarkType('highlight');
                  if (markColor === 'red' || markColor === 'black')
                    setMarkColor('yellow');
                }}
              >
                Highlight
              </button>
              <button
                aria-pressed={markType === 'underline'}
                type="button"
                onClick={() => {
                  setMarkType('underline');
                  if (markColor === 'yellow' || markColor === 'pink')
                    setMarkColor('red');
                }}
              >
                Underline
              </button>
              <select
                aria-label="Mark colour"
                value={markColor}
                onChange={(event) =>
                  setMarkColor(event.target.value as OfficeMarkColor)
                }
              >
                {(markType === 'highlight'
                  ? ['yellow', 'green', 'blue', 'pink']
                  : ['red', 'green', 'blue', 'black']
                ).map((color) => (
                  <option key={color}>{color}</option>
                ))}
              </select>
              <button type="button" onClick={createMark}>
                Apply
              </button>
              {pendingSelection.selectedWord ? (
                <button type="button" onClick={lookupSelectedWord}>
                  Look up word
                </button>
              ) : null}
              <button type="button" onClick={() => setPendingSelection(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {dictionaryWord ? (
            <aside className="office-dictionary" aria-live="polite">
              <div>
                <strong>{dictionaryWord}</strong>
                <button
                  type="button"
                  onClick={() => {
                    setDictionaryWord(null);
                    setDictionaryAnchor(null);
                  }}
                >
                  Close
                </button>
              </div>
              {dictionaryLoading && dictionaryDefinitions.length === 0 ? (
                <p>Looking up…</p>
              ) : null}
              {dictionaryDefinitions.slice(0, 8).map((definition) => (
                <p key={definition.id}>{definition.text}</p>
              ))}
              {dictionaryAnchor && dictionaryDefinitions[0] ? (
                dictionaryGlossaryEntry ? (
                  <button
                    type="button"
                    onClick={() =>
                      onRemoveGlossaryEntry(dictionaryGlossaryEntry.glossaryEntryId)
                    }
                  >
                    Remove from Glossary
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const entry = createSemanticGlossaryEntry(
                        opened.documentId,
                        dictionaryWord,
                        dictionaryDefinitions[0],
                        dictionaryAnchor,
                      );
                      onAddGlossaryEntry(entry);
                    }}
                  >
                    Add to Glossary
                  </button>
                )
              ) : null}
              {!dictionaryLoading && dictionaryDefinitions.length === 0 ? (
                <p>No definition found.</p>
              ) : null}
            </aside>
          ) : null}
          <div className="office-scroll" ref={scrollRef} onMouseUp={captureSelection}>
            {content}
            {opened.documentType === 'docx' &&
            visibleDocxBlocks < maxBlockIndex(opened.renderModel.blocks) ? (
              <button
                className="office-load-more"
                type="button"
                onClick={() =>
                  setVisibleDocxBlocks((count) => count + DOCX_BLOCK_BATCH)
                }
              >
                Continue loading document
              </button>
            ) : null}
          </div>
        </div>
        {selectedAnnotation ? (
          <aside className="office-annotation-editor" aria-label="Selected mark">
            <button type="button" onClick={() => setSelectedAnnotationId(null)}>
              Close
            </button>
            <p>{selectedAnnotation.anchor.quote}</p>
            <label>
              Note
              <textarea
                placeholder="Add an optional note"
                value={selectedAnnotation.note?.content ?? ''}
                onChange={(event) =>
                  updateNote(selectedAnnotation.id, event.target.value)
                }
              />
            </label>
            <button
              className="is-danger"
              type="button"
              onClick={() => {
                persistAnnotations(
                  annotations.filter(
                    (annotation) => annotation.id !== selectedAnnotation.id,
                  ),
                );
                setSelectedAnnotationId(null);
              }}
            >
              Delete mark
            </button>
          </aside>
        ) : null}
      </section>
    );
  },
);

function PptxThumbnail({ descriptor }: { descriptor: PptxSlideDescriptor }) {
  const [slide, setSlide] = useState<PptxSlide | null>(() => descriptor.peek());
  const thumbnailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const thumbnail = thumbnailRef.current;
    if (!thumbnail || slide) return;
    let cancelled = false;
    const load = () => {
      void descriptor.load().then(
        (loaded) => {
          if (!cancelled) setSlide(loaded);
        },
        () => undefined,
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(thumbnail);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [descriptor, slide]);

  return (
    <span className="office-slide-thumbnail" ref={thumbnailRef}>
      <span
        aria-hidden="true"
        className="office-slide-thumbnail-surface"
        style={{
          aspectRatio: `${descriptor.size.widthEmu} / ${descriptor.size.heightEmu}`,
        }}
      >
        {slide
          ? flattenPptxShapes(slide.shapes).map((shape) => (
              <PptxThumbnailShape
                key={`${shape.id}-${shape.order}`}
                shape={shape}
                slide={slide}
              />
            ))
          : null}
      </span>
      <span>{descriptor.label}</span>
    </span>
  );
}

function PptxThumbnailShape({ shape, slide }: { shape: PptxShape; slide: PptxSlide }) {
  const style: CSSProperties = {
    left: `${(shape.bounds.xEmu / slide.size.widthEmu) * 100}%`,
    top: `${(shape.bounds.yEmu / slide.size.heightEmu) * 100}%`,
    width: `${(shape.bounds.widthEmu / slide.size.widthEmu) * 100}%`,
    height: `${(shape.bounds.heightEmu / slide.size.heightEmu) * 100}%`,
    transform: shape.rotationDegrees
      ? `rotate(${shape.rotationDegrees}deg)`
      : undefined,
    backgroundColor: shape.style.fill,
    borderColor: shape.style.borderColor,
    borderWidth: shape.style.borderWidthPoints,
    borderStyle: shape.style.borderColor ? 'solid' : undefined,
    zIndex: shape.order + 1,
  };
  return (
    <span className="office-slide-thumbnail-shape" style={style}>
      {shape.image ? <OfficeImage alt="" resource={shape.image} /> : null}
      {shape.paragraphs.map((paragraph) => (
        <span key={paragraph.index}>{paragraph.text}</span>
      ))}
    </span>
  );
}

function LazyPptxSlide({
  descriptor,
  annotations,
  onSelectAnnotation,
}: {
  descriptor: PptxSlideDescriptor;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  const [slide, setSlide] = useState<PptxSlide | null>(() => descriptor.peek());
  const [error, setError] = useState(false);
  const shellRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || slide) return;
    let cancelled = false;
    const load = () => {
      void descriptor.load().then(
        (loaded) => {
          if (!cancelled) setSlide(loaded);
        },
        () => {
          if (!cancelled) setError(true);
        },
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(shell);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [descriptor, slide]);

  return (
    <article
      className="office-slide-shell"
      data-office-navigation-index={descriptor.index}
      ref={shellRef}
    >
      <span className="office-slide-label">{descriptor.label}</span>
      <div
        className="office-slide-surface"
        data-office-slide-surface
        style={{
          aspectRatio: `${descriptor.size.widthEmu} / ${descriptor.size.heightEmu}`,
        }}
      >
        {error ? (
          <p className="office-slide-error">This slide could not be rendered.</p>
        ) : null}
        {!slide && !error ? (
          <div
            className="office-slide-placeholder"
            aria-label={`Loading ${descriptor.label}`}
          />
        ) : null}
        {slide
          ? flattenPptxShapes(slide.shapes).map((shape) => (
              <PptxShapeView
                annotations={annotations}
                key={`${shape.id}-${shape.order}`}
                onSelectAnnotation={onSelectAnnotation}
                shape={shape}
                slide={slide}
              />
            ))
          : null}
      </div>
      {slide?.speakerNotes ? (
        <details>
          <summary>Speaker notes</summary>
          <p>{slide.speakerNotes}</p>
        </details>
      ) : null}
    </article>
  );
}

function PptxShapeView({
  shape,
  slide,
  annotations,
  onSelectAnnotation,
}: {
  shape: PptxShape;
  slide: PptxSlide;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  const style: CSSProperties = {
    left: `${(shape.bounds.xEmu / slide.size.widthEmu) * 100}%`,
    top: `${(shape.bounds.yEmu / slide.size.heightEmu) * 100}%`,
    width: `${(shape.bounds.widthEmu / slide.size.widthEmu) * 100}%`,
    height: `${(shape.bounds.heightEmu / slide.size.heightEmu) * 100}%`,
    transform: shape.rotationDegrees
      ? `rotate(${shape.rotationDegrees}deg)`
      : undefined,
    backgroundColor: shape.style.fill,
    borderColor: shape.style.borderColor,
    borderWidth: shape.style.borderWidthPoints,
    borderStyle: shape.style.borderColor ? 'solid' : undefined,
    zIndex: shape.order + 1,
  };
  return (
    <div className={`office-pptx-shape is-${shape.kind}`} style={style}>
      {shape.image ? <OfficeImage alt={shape.name} resource={shape.image} /> : null}
      {shape.paragraphs.map((paragraph) => (
        <PptxParagraphView
          annotations={annotations}
          key={paragraph.index}
          onSelectAnnotation={onSelectAnnotation}
          paragraph={paragraph}
          shape={shape}
          slide={slide}
        />
      ))}
    </div>
  );
}

function PptxParagraphView({
  paragraph,
  shape,
  slide,
  annotations,
  onSelectAnnotation,
}: {
  paragraph: PptxParagraph;
  shape: PptxShape;
  slide: PptxSlide;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  const matching = annotations.filter(
    (annotation) =>
      annotation.anchor.kind === 'pptx-text' &&
      annotation.anchor.slideId === slide.id &&
      annotation.anchor.shapeId === shape.id &&
      annotation.anchor.paragraphIndex === paragraph.index,
  );
  return (
    <p
      data-office-container={`${slide.id}/${shape.id}/${paragraph.index}`}
      data-office-target-kind="pptx-slide"
      data-office-slide-id={slide.id}
      data-office-slide-index={slide.index}
      style={{ textAlign: paragraph.alignment }}
    >
      {renderMarkedRuns(paragraph.text, paragraph.runs, matching, onSelectAnnotation)}
    </p>
  );
}

function DocxDocument({
  blocks,
  maxBlockIndex,
  annotations,
  onSelectAnnotation,
}: {
  blocks: readonly DocxFlowBlock[];
  maxBlockIndex: number;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  return (
    <article className="office-docx-page">
      {blocks.map((block) =>
        block.index < maxBlockIndex ? (
          <DocxBlockView
            annotations={annotations}
            block={block}
            key={block.id}
            onSelectAnnotation={onSelectAnnotation}
          />
        ) : null,
      )}
    </article>
  );
}

function DocxBlockView({
  block,
  annotations,
  onSelectAnnotation,
}: {
  block: DocxFlowBlock;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  if (block.kind === 'section-break') {
    return <hr className="office-docx-section-break" data-office-block-id={block.id} />;
  }
  if (block.kind === 'table') {
    return (
      <table data-office-block-id={block.id} data-office-navigation-index={block.index}>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex}>
                  {cell.blocks.map((child) => (
                    <DocxBlockView
                      annotations={annotations}
                      block={child}
                      key={child.id}
                      onSelectAnnotation={onSelectAnnotation}
                    />
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <DocxParagraphView
      annotations={annotations}
      block={block}
      onSelectAnnotation={onSelectAnnotation}
    />
  );
}

function DocxParagraphView({
  block,
  annotations,
  onSelectAnnotation,
}: {
  block: DocxParagraphBlock;
  annotations: readonly OfficeDocumentAnnotation[];
  onSelectAnnotation: (annotationId: string) => void;
}) {
  const matching = annotations.filter(
    (annotation) =>
      annotation.anchor.kind === 'docx-text' && annotation.anchor.blockId === block.id,
  );
  const content = renderMarkedRuns(
    block.text,
    block.runs,
    matching,
    onSelectAnnotation,
  );
  const props = {
    'data-office-block-id': block.id,
    'data-office-container': block.id,
    'data-office-navigation-index': block.index,
    'data-office-target-kind': 'docx-block',
    'data-office-block-index': block.index,
  } as const;
  const body = block.list ? <li>{content}</li> : content;
  const textElement = block.headingLevel ? (
    createHeading(Math.min(6, block.headingLevel), props, body)
  ) : block.list ? (
    <ul {...props}>{body}</ul>
  ) : (
    <p {...props}>{body}</p>
  );
  return (
    <>
      {textElement}
      {block.images.map((image) => (
        <OfficeImage
          alt={image.altText ?? ''}
          key={image.relationshipId}
          resource={image.resource}
        />
      ))}
    </>
  );
}

function OfficeImage({ resource, alt }: { resource: OoxmlImageResource; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    const load = () => {
      void resource.load().then(
        (bytes) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: resource.mimeType }),
          );
          setUrl(objectUrl);
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        cancelled = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: '500px' },
    );
    observer.observe(image);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resource]);
  return (
    <img
      alt={failed ? `${alt} (unavailable)` : alt}
      ref={imageRef}
      src={url ?? undefined}
    />
  );
}

function renderMarkedRuns(
  text: string,
  runs: readonly (PptxTextRun | DocxTextRun)[],
  annotations: readonly OfficeDocumentAnnotation[],
  onSelectAnnotation: (annotationId: string) => void,
): ReactNode[] {
  const boundaries = new Set([0, text.length]);
  const runSpans: Array<{ start: number; end: number; run: RunLike }> = [];
  let offset = 0;
  for (const run of runs) {
    const start = offset;
    offset += run.text.length;
    boundaries.add(start);
    boundaries.add(offset);
    runSpans.push({ start, end: offset, run });
  }
  for (const annotation of annotations) {
    boundaries.add(Math.max(0, Math.min(text.length, annotation.anchor.startOffset)));
    boundaries.add(Math.max(0, Math.min(text.length, annotation.anchor.endOffset)));
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  const nodes: ReactNode[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const run = runSpans.find(
      (candidate) => candidate.start <= start && candidate.end >= end,
    )?.run;
    const marks = annotations.filter(
      (annotation) =>
        annotation.anchor.startOffset <= start && annotation.anchor.endOffset >= end,
    );
    const runStyle: CSSProperties = {
      fontWeight: run?.style.bold ? 700 : undefined,
      fontStyle: run?.style.italic ? 'italic' : undefined,
      textDecoration: run?.style.underline ? 'underline' : undefined,
      fontFamily: run?.style.fontFamily,
      fontSize: run?.style.fontSizePoints ? `${run.style.fontSizePoints}pt` : undefined,
      color: run?.style.color,
    };
    const content = <span style={runStyle}>{segment}</span>;
    nodes.push(
      marks.length > 0 ? (
        <mark
          className={marks
            .map((mark) => `office-mark is-${mark.markType} is-${mark.color}`)
            .join(' ')}
          key={`${start}-${end}`}
          onClick={() => onSelectAnnotation(marks[marks.length - 1].id)}
        >
          {content}
        </mark>
      ) : (
        <span key={`${start}-${end}`}>{content}</span>
      ),
    );
  }
  return nodes;
}

function createHeading(
  level: number,
  props: Record<string, string | number>,
  children: ReactNode,
): ReactNode {
  if (level === 1) return <h1 {...props}>{children}</h1>;
  if (level === 2) return <h2 {...props}>{children}</h2>;
  if (level === 3) return <h3 {...props}>{children}</h3>;
  if (level === 4) return <h4 {...props}>{children}</h4>;
  if (level === 5) return <h5 {...props}>{children}</h5>;
  return <h6 {...props}>{children}</h6>;
}

function closestTextContainer(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>('[data-office-container]') ?? null;
}

function textOffsetWithin(
  container: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  try {
    const range = document.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function selectionTargetFromElement(
  element: HTMLElement,
): DocumentTextSelection['target'] | null {
  if (element.dataset.officeTargetKind === 'pptx-slide') {
    const slideIndex = Number(element.dataset.officeSlideIndex);
    const slideId = element.dataset.officeSlideId;
    return slideId && Number.isSafeInteger(slideIndex)
      ? { kind: 'pptx-slide', slideId, slideIndex }
      : null;
  }
  if (element.dataset.officeTargetKind === 'docx-block') {
    const blockIndex = Number(element.dataset.officeBlockIndex);
    const blockId = element.dataset.officeBlockId;
    return blockId && Number.isSafeInteger(blockIndex)
      ? { kind: 'docx-block', blockId, blockIndex }
      : null;
  }
  return null;
}

function normalizedSelectionRect(range: Range, container: HTMLElement) {
  const slide = container.closest<HTMLElement>('[data-office-slide-surface]');
  const slideRect = slide?.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  if (!slideRect || slideRect.width <= 0 || slideRect.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return {
    x: clampRatio((rect.left - slideRect.left) / slideRect.width),
    y: clampRatio((rect.top - slideRect.top) / slideRect.height),
    width: clampRatio(rect.width / slideRect.width),
    height: clampRatio(rect.height / slideRect.height),
  };
}

function captureOfficeReadingPosition(
  opened: OpenedOfficeDocument,
  oneBasedIndex: number,
): DocumentReadingPosition | null {
  const index = Math.max(0, oneBasedIndex - 1);
  if (opened.documentType === 'pptx') {
    const slide = opened.renderModel.slides[index];
    return slide
      ? { kind: 'pptx-position', slideIndex: slide.index, slideId: slide.id }
      : null;
  }
  const block = findBlockByIndex(opened.renderModel.blocks, index);
  return block
    ? {
        kind: 'docx-position',
        blockIndex: block.index,
        blockId: block.id,
        blockOffsetRatio: 0,
      }
    : null;
}

function restoreReadingPosition(
  opened: OpenedOfficeDocument,
  position: DocumentReadingPosition | undefined,
  smooth: boolean,
  getRoot: () => HTMLElement | null,
  revealDocxBlock: (blockIndex: number) => void,
) {
  if (!position) return;
  const adapterPosition =
    opened.documentType === 'pptx'
      ? position.kind === 'pptx-position'
        ? position
        : null
      : position.kind === 'docx-position'
        ? position
        : null;
  if (!adapterPosition) return;
  if (adapterPosition.kind === 'docx-position') {
    revealDocxBlock(adapterPosition.blockIndex);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const selector =
        adapterPosition.kind === 'pptx-position'
          ? `[data-office-navigation-index="${adapterPosition.slideIndex}"]`
          : `[data-office-block-id="${cssEscape(adapterPosition.blockId)}"]`;
      getRoot()
        ?.querySelector<HTMLElement>(selector)
        ?.scrollIntoView({
          behavior: smooth ? 'smooth' : 'auto',
          block: 'start',
        });
    });
  });
}

function maxBlockIndex(blocks: readonly DocxFlowBlock[]): number {
  let maximum = 0;
  for (const block of blocks) {
    maximum = Math.max(maximum, block.index + 1);
    if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells)
          maximum = Math.max(maximum, maxBlockIndex(cell.blocks));
      }
    }
  }
  return maximum;
}

function findBlockByIndex(
  blocks: readonly DocxFlowBlock[],
  index: number,
): DocxFlowBlock | null {
  for (const block of blocks) {
    if (block.index === index) return block;
    if (block.kind !== 'table') continue;
    for (const row of block.rows) {
      for (const cell of row.cells) {
        const nested = findBlockByIndex(cell.blocks, index);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function flattenPptxShapes(shapes: readonly PptxShape[]): PptxShape[] {
  const flattened: PptxShape[] = [];
  for (const shape of shapes) {
    flattened.push(shape);
    if (shape.children) flattened.push(...flattenPptxShapes(shape.children));
  }
  return flattened;
}

function mergeDefinitions(
  current: readonly DictionaryDefinition[],
  incoming: readonly DictionaryDefinition[],
): DictionaryDefinition[] {
  const byId = new Map(current.map((definition) => [definition.id, definition]));
  for (const definition of incoming) byId.set(definition.id, definition);
  return [...byId.values()];
}

function anchorsShareLocation(
  first: OfficeSemanticAnchor,
  second: OfficeSemanticAnchor,
): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'pptx-text' && second.kind === 'pptx-text') {
    return (
      first.slideId === second.slideId &&
      first.shapeId === second.shapeId &&
      first.paragraphIndex === second.paragraphIndex &&
      first.startOffset === second.startOffset &&
      first.endOffset === second.endOffset
    );
  }
  return (
    first.kind === 'docx-text' &&
    second.kind === 'docx-text' &&
    first.blockId === second.blockId &&
    first.startOffset === second.startOffset &&
    first.endOffset === second.endOffset
  );
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replaceAll(/["\\]/gu, '\\$&');
}
