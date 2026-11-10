import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import type { ElementSize } from '../../hooks/useElementSize';
import { useTheme } from '../../theme/ThemeContext';
import type { PdfSearchResult } from '../../types/pdfSearch';
import type {
  PdfOcrDocumentState,
  PdfOcrFailureCode,
  PdfOcrPageState,
} from '../../types/pdfOcr.ts';
import type { NoteAnchor } from '../../types/noteAnchor';
import type { DocumentLink } from '../../types/documentLink';
import type {
  DefinitionBubble as DefinitionBubbleModel,
  PdfGlossaryEntry,
} from '../../types/glossary';
import {
  getHighlightColorCssValue,
  getUnderlineColorCssValue,
  type PdfAnnotation,
} from '../../types/highlight';
import { correctTextLayerReadingOrder } from '../../utils/textLayerReadingOrder';
import { preloadPdfSourceLexicon } from '../../utils/pdfSourceLexicon';
import {
  attachPdfTextSourceMap,
  detachPdfTextSourceMap,
} from '../../utils/pdfTextSourceMap';
import {
  getHighlightRenderGroups,
  normalizeAnnotationVisualGeometry,
} from '../../utils/highlights';
import {
  findAnnotationsAtClientPoint,
  findPdfGlossaryEntriesAtClientPoint,
  isAnnotationTapInteractiveTarget,
  isSimpleAnnotationTap,
  type AnnotationPointerStart,
} from '../../utils/annotationInteraction';
import { calculatePdfPageScale } from '../../utils/pdfPageScale';
import {
  classifyPdfTextItems,
  hasRecordedPdfImage,
  resolvePdfPageTextAvailability,
  type PdfTextExtractionState,
} from '../../utils/pdfTextAvailability';
import { clearPdfOcrTextLayer, renderPdfOcrTextLayer } from '../../utils/pdfOcr.ts';
import {
  getSeaPdfPageColors,
  inspectSeaPdfCanvas,
  type SeaPdfPresentationDecision,
} from '../../utils/seaPdfPresentation';
import {
  DOCUMENT_LINK_BADGE_VISUAL_DIAMETER,
  DOCUMENT_LINK_UNDERLINE_STROKE_WIDTH,
  findDocumentLinkEndpointsAtClientPoint,
  getDocumentLinkBadgeGeometry,
  getDocumentLinkBadgeVerticalGeometry,
  getDocumentLinkDisplayName,
  getDocumentLinkBadgeGroups,
  getDocumentLinkEndpointsForPage,
  getDocumentLinkFinalRectangle,
  type DocumentLinkEndpointReference,
} from '../../utils/documentLinkPresentation';
import { DefinitionBubble } from './DefinitionBubble';

type FitMode = 'width' | 'page' | null;

interface PageDimensions {
  width: number;
  height: number;
}

interface LinkTarget {
  id: string;
  href: string;
  destination: unknown;
  left: number;
  top: number;
  width: number;
  height: number;
  external: boolean;
}

interface PdfPageProps {
  document: PDFDocumentProxy;
  pageNumber: number;
  scrollElement: HTMLElement | null;
  containerSize: ElementSize;
  fitMode: FitMode;
  zoom: number;
  annotations: PdfAnnotation[];
  documentLinks: DocumentLink[];
  noteAnchors: NoteAnchor[];
  glossaryEntries: PdfGlossaryEntry[];
  definitionBubbles: DefinitionBubbleModel[];
  activeAnnotationId: string | null;
  activeGlossaryEntryId: string | null;
  activeLinkEndpointId: string | null;
  onCurrentPageChange: (pageNumber: number) => void;
  onScaleChange: (pageNumber: number, scale: number) => void;
  onGoToPage: (pageNumber: number) => void;
  onAddBubbleToGlossary: (bubbleId: string) => void;
  onRemoveBubbleFromGlossary: (glossaryEntryId: string) => void;
  onCloseDefinitionBubble: (bubbleId: string) => void;
  onMoveDefinitionUp: (bubbleId: string, definitionId: string) => void;
  onToggleDefinitionsExpanded: (bubbleId: string) => void;
  onPageLayoutChange: (pageNumber: number) => void;
  onTextLayerReady: (pageNumber: number) => void;
  ocrState: PdfOcrPageState;
  documentOcrState: PdfOcrDocumentState;
  isOcrBusy: boolean;
  onRecognizeText: (pageNumber: number) => void | Promise<void>;
  onCancelRecognition: (pageNumber: number) => void;
  onRecognizeDocument: () => void | Promise<void>;
  onCancelDocumentRecognition: () => void;
  onOpenReaderContext: (
    annotations: PdfAnnotation[],
    glossaryEntries: PdfGlossaryEntry[],
    linkEndpoints: DocumentLinkEndpointReference[],
    position: { clientX: number; clientY: number },
  ) => void;
  onActivateLinkBadge: (
    linkId: string,
    endpointId: string,
    position: { clientX: number; clientY: number },
  ) => void;
  onDismissReaderContext: () => void;
  searchResults: PdfSearchResult[];
  activeSearchResultId: string | null;
  seaDocumentDecision?: SeaPdfPresentationDecision;
  onSeaPaperDecision: (
    pageNumber: number,
    decision: SeaPdfPresentationDecision,
  ) => void;
}

export function PdfPage({
  document,
  pageNumber,
  scrollElement,
  containerSize,
  fitMode,
  zoom,
  annotations,
  documentLinks,
  noteAnchors,
  glossaryEntries,
  definitionBubbles,
  activeAnnotationId,
  activeGlossaryEntryId,
  activeLinkEndpointId,
  onCurrentPageChange,
  onScaleChange,
  onGoToPage,
  onAddBubbleToGlossary,
  onRemoveBubbleFromGlossary,
  onCloseDefinitionBubble,
  onMoveDefinitionUp,
  onToggleDefinitionsExpanded,
  onPageLayoutChange,
  onTextLayerReady,
  ocrState,
  documentOcrState,
  isOcrBusy,
  onRecognizeText,
  onCancelRecognition,
  onRecognizeDocument,
  onCancelDocumentRecognition,
  onOpenReaderContext,
  onActivateLinkBadge,
  onDismissReaderContext,
  searchResults,
  activeSearchResultId,
  seaDocumentDecision,
  onSeaPaperDecision,
}: PdfPageProps) {
  const { themeId } = useTheme();
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const annotationPointerStartRef = useRef<AnnotationPointerStart | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [baseDimensions, setBaseDimensions] = useState<PageDimensions | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber === 1);
  const [links, setLinks] = useState<LinkTarget[]>([]);
  const [openLinkBadgeGroupKey, setOpenLinkBadgeGroupKey] = useState<string | null>(
    null,
  );
  const [renderWarning, setRenderWarning] = useState<string | null>(null);
  const [textExtractionState, setTextExtractionState] =
    useState<PdfTextExtractionState>('pending');
  const [hasRecordedImage, setHasRecordedImage] = useState(false);
  const classifiedSeaPageRef = useRef<PDFPageProxy | null>(null);
  const [seaPaperDecision, setSeaPaperDecision] = useState<
    SeaPdfPresentationDecision | { presentation: 'pending'; reason: 'pending' }
  >({ presentation: 'pending', reason: 'pending' });
  // The first source-colored render supplies the bounded classifier sample.
  // Eligible pages then use PDF.js's built-in presentation colors; the stable
  // object keeps that second render from becoming a state/render loop.
  const effectiveSeaPaperDecision = seaDocumentDecision ?? seaPaperDecision;
  const seaPageColors = getSeaPdfPageColors(
    themeId,
    effectiveSeaPaperDecision.presentation,
  );
  const [activeDefinitionBubbleId, setActiveDefinitionBubbleId] = useState<
    string | null
  >(null);
  const ocrResult = ocrState.status === 'ready' ? ocrState.result : null;

  useEffect(() => {
    if (!openLinkBadgeGroupKey) return;

    const dismissOutside = (event: PointerEvent) => {
      const openCluster = shellRef.current?.querySelector(
        '.document-link-badge-cluster.is-chooser-open',
      );
      if (event.target instanceof Node && openCluster?.contains(event.target)) return;
      setOpenLinkBadgeGroupKey(null);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpenLinkBadgeGroupKey(null);
      shellRef.current
        ?.querySelector<HTMLButtonElement>(
          '.document-link-badge-cluster.is-chooser-open .document-link-badge',
        )
        ?.focus();
    };

    window.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('keydown', dismissWithEscape, true);
    return () => {
      window.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('keydown', dismissWithEscape, true);
    };
  }, [openLinkBadgeGroupKey]);

  useEffect(() => {
    let isDisposed = false;
    classifiedSeaPageRef.current = null;
    setSeaPaperDecision({ presentation: 'pending', reason: 'pending' });
    setTextExtractionState('pending');
    setHasRecordedImage(false);

    void document.getPage(pageNumber).then((loadedPage) => {
      if (isDisposed) {
        return;
      }

      const viewport = loadedPage.getViewport({ scale: 1 });
      setPage(loadedPage);
      setBaseDimensions({ width: viewport.width, height: viewport.height });
    });

    return () => {
      isDisposed = true;
    };
  }, [document, pageNumber]);

  const scale = useMemo(() => {
    if (!baseDimensions) {
      return 1;
    }
    return calculatePdfPageScale({
      fitMode,
      zoom,
      containerWidth: containerSize.width,
      containerHeight: containerSize.height,
      pageWidth: baseDimensions.width,
      pageHeight: baseDimensions.height,
    });
  }, [baseDimensions, containerSize.height, containerSize.width, fitMode, zoom]);

  const viewport = useMemo(() => page?.getViewport({ scale }), [page, scale]);

  const dimensions = useMemo<PageDimensions | null>(() => {
    if (!viewport) {
      return null;
    }

    return { width: viewport.width, height: viewport.height };
  }, [viewport]);

  useLayoutEffect(() => {
    if (dimensions) {
      onPageLayoutChange(pageNumber);
    }
  }, [dimensions, onPageLayoutChange, pageNumber]);

  useEffect(() => {
    if (viewport) {
      onScaleChange(pageNumber, scale);
    }
  }, [onScaleChange, pageNumber, scale, viewport]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !scrollElement) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsNearViewport(entry.isIntersecting);
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          onCurrentPageChange(pageNumber);
        }
      },
      { root: scrollElement, rootMargin: '900px 0px', threshold: [0, 0.5] },
    );

    observer.observe(shell);
    return () => observer.disconnect();
  }, [onCurrentPageChange, pageNumber, scrollElement]);

  useEffect(() => {
    if (!page || !canvasRef.current || !viewport) {
      return;
    }

    const canvas = canvasRef.current;

    if (!isNearViewport) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    const outputScale = window.devicePixelRatio || 1;
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      return;
    }

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      pageColors: seaPageColors,
      recordImages: classifiedSeaPageRef.current !== page,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    let isDisposed = false;

    void renderTask.promise
      .then(() => {
        if (!isDisposed) {
          setRenderWarning(null);
          if (classifiedSeaPageRef.current !== page) {
            classifiedSeaPageRef.current = page;
            setHasRecordedImage(hasRecordedPdfImage(page.imageCoordinates));
            const decision = inspectSeaPdfCanvas(
              canvas,
              page.imageCoordinates as ArrayLike<number> | null,
            );
            setSeaPaperDecision(decision);
            onSeaPaperDecision(pageNumber, decision);
          }
        }
      })
      .catch((error: unknown) => {
        if (
          !isDisposed &&
          (!(error instanceof Error) || error.name !== 'RenderingCancelledException')
        ) {
          setRenderWarning(
            `Page ${pageNumber} could not render completely. Some images may be missing.`,
          );
        }
      });

    return () => {
      isDisposed = true;
      renderTask.cancel();
    };
  }, [isNearViewport, onSeaPaperDecision, page, pageNumber, seaPageColors, viewport]);

  useEffect(() => {
    if (!page || !textLayerRef.current || !viewport) {
      return;
    }

    const container = textLayerRef.current;

    if (!isNearViewport) {
      clearPdfOcrTextLayer(container);
      return;
    }

    detachPdfTextSourceMap(container);
    clearPdfOcrTextLayer(container);
    if (ocrResult) {
      renderPdfOcrTextLayer(container, ocrResult, viewport.width, viewport.height);
      onTextLayerReady(pageNumber);
      return () => {
        clearPdfOcrTextLayer(container);
      };
    }

    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container,
      viewport,
    });

    let isDisposed = false;
    void preloadPdfSourceLexicon();
    const textContentPromise = page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    });
    const textLayerRenderPromise = textLayer.render();
    void Promise.all([textLayerRenderPromise, textContentPromise])
      .then(([, textContent]) => {
        if (!isDisposed) {
          setTextExtractionState(classifyPdfTextItems(textContent.items));
          attachPdfTextSourceMap(container, pageNumber, textContent);
        }
      })
      .catch(() => {
        if (!isDisposed) setTextExtractionState('failed');
      });

    void textLayerRenderPromise
      .then(() => {
        if (!isDisposed) {
          correctTextLayerReadingOrder(container);
          onTextLayerReady(pageNumber);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== 'AbortException') {
          throw error;
        }
      });

    return () => {
      isDisposed = true;
      textLayer.cancel();
      detachPdfTextSourceMap(container);
      clearPdfOcrTextLayer(container);
    };
  }, [isNearViewport, ocrResult, onTextLayerReady, page, pageNumber, viewport]);

  useEffect(() => {
    if (!page || !isNearViewport || !viewport) {
      return;
    }

    let isDisposed = false;
    void page.getAnnotations({ intent: 'display' }).then((annotations) => {
      if (isDisposed) {
        return;
      }

      const resolvedLinks = annotations.flatMap((annotation) => {
        if (annotation.subtype !== 'Link' || !annotation.rect) {
          return [];
        }

        const [firstX, firstY] = viewport.convertToViewportPoint(
          annotation.rect[0],
          annotation.rect[1],
        );
        const [secondX, secondY] = viewport.convertToViewportPoint(
          annotation.rect[2],
          annotation.rect[3],
        );
        const width = Math.abs(secondX - firstX);
        const height = Math.abs(secondY - firstY);

        if (width === 0 || height === 0) {
          return [];
        }

        const destination = annotation.dest as unknown;
        const isExternal = typeof annotation.url === 'string';

        return [
          {
            id: annotation.id,
            href: isExternal ? annotation.url : `#page-${pageNumber}`,
            left: Math.min(firstX, secondX),
            top: Math.min(firstY, secondY),
            width,
            height,
            external: isExternal,
            destination,
          },
        ];
      });

      setLinks(resolvedLinks);
    });

    return () => {
      isDisposed = true;
    };
  }, [isNearViewport, page, pageNumber, viewport]);

  const handleInternalLink = async (destination: unknown) => {
    const resolvedDestination =
      typeof destination === 'string'
        ? await document.getDestination(destination)
        : destination;

    if (!Array.isArray(resolvedDestination) || !resolvedDestination[0]) {
      return;
    }

    const pageReference = resolvedDestination[0];
    const targetPage =
      typeof pageReference === 'number'
        ? pageReference + 1
        : (await document.getPageIndex(
            pageReference as Parameters<PDFDocumentProxy['getPageIndex']>[0],
          )) + 1;

    onGoToPage(targetPage);
  };

  const shellStyle = dimensions
    ? ({
        width: dimensions.width,
        height: dimensions.height,
        '--total-scale-factor': scale,
      } as CSSProperties)
    : undefined;
  const textCapabilityNoticeStyle = dimensions
    ? ({ width: dimensions.width } as CSSProperties)
    : undefined;
  const textAvailability = resolvePdfPageTextAvailability(
    textExtractionState,
    hasRecordedImage,
  );
  const exposesOcrControls =
    textAvailability === 'image-only' || ocrState.status === 'ready';
  const canRunRemainingDocumentOcr =
    documentOcrState.status === 'idle' ||
    documentOcrState.status === 'cancelled' ||
    documentOcrState.status === 'stopped' ||
    (documentOcrState.status === 'complete' && documentOcrState.failedPages > 0);
  const remainingDocumentOcrLabel =
    documentOcrState.status === 'idle'
      ? 'Recognize remaining image-only pages'
      : documentOcrState.status === 'complete'
        ? 'Retry unavailable image-only pages'
        : 'Continue document OCR';
  const textCapabilityNotice = exposesOcrControls
    ? ocrState.status === 'ready'
      ? 'English text was recognized locally for this session. OCR may contain errors; the original PDF is unchanged.'
      : 'Image-only page: text selection, Search, Highlight, and Underline need OCR. 39Note has not changed this PDF or inferred any text.'
    : textAvailability === 'text-extraction-failed'
      ? 'The selectable text layer for this page could not be read. The page image remains unchanged.'
      : null;
  const textCapabilityNoticeId = `pdf-page-text-capability-${pageNumber}`;
  const highlights = annotations.filter(
    (annotation) => annotation.type === 'highlight',
  );
  const underlines = annotations.filter(
    (annotation) => annotation.type === 'underline',
  );
  const documentLinkEndpoints = getDocumentLinkEndpointsForPage(
    documentLinks,
    pageNumber,
  );
  const documentLinkBadgeGroups = getDocumentLinkBadgeGroups(documentLinkEndpoints);
  const activeLinkEndpoint = documentLinkEndpoints.find(
    ({ endpoint }) => endpoint.id === activeLinkEndpointId,
  );
  const activeAnnotation = [...annotations, ...noteAnchors].find(
    (annotation) => annotation.id === activeAnnotationId,
  );
  const beginAnnotationTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    annotationPointerStartRef.current =
      event.button === 0 && !isAnnotationTapInteractiveTarget(event.target)
        ? {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
          }
        : null;
  };
  const completeAnnotationTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = annotationPointerStartRef.current;
    annotationPointerStartRef.current = null;
    if (isAnnotationTapInteractiveTarget(event.target)) return;
    const hasMeaningfulSelection = Boolean(window.getSelection()?.toString().trim());
    if (!isSimpleAnnotationTap(start, event, hasMeaningfulSelection)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const annotationHits = findAnnotationsAtClientPoint(
      pageNumber,
      bounds,
      event,
      annotations,
    );
    const glossaryHits = findPdfGlossaryEntriesAtClientPoint(
      pageNumber,
      bounds,
      event,
      glossaryEntries,
    );
    const linkHits = findDocumentLinkEndpointsAtClientPoint(
      pageNumber,
      bounds,
      event,
      documentLinks,
    );
    setOpenLinkBadgeGroupKey(null);
    if (annotationHits.length > 0 || glossaryHits.length > 0 || linkHits.length > 0) {
      onOpenReaderContext(annotationHits, glossaryHits, linkHits, event);
    } else {
      onDismissReaderContext();
    }
  };

  return (
    <div className="pdf-page-entry">
      <article
        ref={shellRef}
        id={`page-${pageNumber}`}
        className="pdf-page-shell"
        data-sea-paper-presentation={effectiveSeaPaperDecision.presentation}
        data-sea-paper-reason={effectiveSeaPaperDecision.reason}
        data-sea-paper-page-reason={seaPaperDecision.reason}
        data-sea-paper-render-mode={seaPageColors ? 'pdfjs-page-colors' : 'original'}
        data-pdf-text-availability={textAvailability}
        data-pdf-ocr-status={ocrState.status}
        style={shellStyle}
        aria-describedby={textCapabilityNotice ? textCapabilityNoticeId : undefined}
        aria-label={`Page ${pageNumber}`}
      >
        <div
          className="pdf-page-canvas"
          onPointerCancel={() => {
            annotationPointerStartRef.current = null;
          }}
          onPointerDown={beginAnnotationTap}
          onPointerUp={completeAnnotationTap}
          onContextMenu={(event) => {
            if (isAnnotationTapInteractiveTarget(event.target)) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const annotationHits = findAnnotationsAtClientPoint(
              pageNumber,
              bounds,
              event,
              annotations,
            );
            const glossaryHits = findPdfGlossaryEntriesAtClientPoint(
              pageNumber,
              bounds,
              event,
              glossaryEntries,
            );
            const linkHits = findDocumentLinkEndpointsAtClientPoint(
              pageNumber,
              bounds,
              event,
              documentLinks,
            );
            if (
              annotationHits.length === 0 &&
              glossaryHits.length === 0 &&
              linkHits.length === 0
            ) {
              return;
            }
            event.preventDefault();
            onOpenReaderContext(annotationHits, glossaryHits, linkHits, event);
          }}
        >
          <canvas ref={canvasRef} />
          {renderWarning ? (
            <p className="pdf-page-render-warning" role="status">
              {renderWarning}
            </p>
          ) : null}
          {dimensions ? (
            <svg
              className="highlight-layer"
              aria-hidden="true"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            >
              {getHighlightRenderGroups(
                highlights,
                dimensions.width,
                dimensions.height,
              ).flatMap((group) =>
                group.rects.map((rectangle, index) => {
                  const visualRectangle = getHighlightVisualRectangle(
                    rectangle,
                    dimensions.width,
                    dimensions.height,
                  );
                  return (
                    <rect
                      className="highlight-rectangle"
                      fill={getHighlightColorCssValue(group.color)}
                      key={`${group.color}-${index}`}
                      rx="2"
                      {...visualRectangle}
                    />
                  );
                }),
              )}
              {underlines.flatMap((underline) =>
                normalizeAnnotationVisualGeometry(
                  underline.rects,
                  dimensions.width,
                  dimensions.height,
                ).map((rectangle, index) => {
                  const metrics = getUnderlineMetrics(rectangle, dimensions.height);
                  return (
                    <line
                      className="underline-rectangle"
                      data-underline-color={underline.color}
                      key={`${underline.id}-${index}`}
                      stroke={getUnderlineColorCssValue(underline.color)}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={UNDERLINE_STROKE_WIDTH}
                      vectorEffect="non-scaling-stroke"
                      x1={snapToDevicePixel(rectangle.x * dimensions.width)}
                      x2={snapToDevicePixel(
                        (rectangle.x + rectangle.width) * dimensions.width,
                      )}
                      y1={metrics.y}
                      y2={metrics.y}
                    />
                  );
                }),
              )}
              {documentLinkEndpoints.flatMap(({ link, endpoint }) => {
                const rectangles = normalizeAnnotationVisualGeometry(
                  [...endpoint.anchor.rects],
                  dimensions.width,
                  dimensions.height,
                );
                return rectangles.map((rectangle, index) => {
                  const y = getLinkUnderlineY(rectangle, dimensions.height);
                  const badgeGeometry =
                    index === rectangles.length - 1
                      ? getDocumentLinkBadgeGeometry(
                          rectangle,
                          dimensions.width,
                          window.devicePixelRatio,
                        )
                      : null;
                  return (
                    <line
                      className="document-link-underline"
                      data-document-link-id={link.id}
                      data-link-endpoint-id={endpoint.id}
                      key={`${link.id}-${endpoint.id}-${index}`}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={LINK_UNDERLINE_STROKE_WIDTH}
                      vectorEffect="non-scaling-stroke"
                      x1={
                        badgeGeometry?.underlineStartX ??
                        snapToDevicePixel(rectangle.x * dimensions.width)
                      }
                      x2={
                        badgeGeometry?.underlineEndX ??
                        snapToDevicePixel(
                          (rectangle.x + rectangle.width) * dimensions.width,
                        )
                      }
                      y1={y}
                      y2={y}
                    />
                  );
                });
              })}
              {glossaryEntries.flatMap((entry) =>
                entry.sourceRects.map((rectangle, index) => {
                  const metrics = getUnderlineMetrics(rectangle, dimensions.height);
                  const overlapsOrdinaryUnderline = underlines.some((underline) =>
                    underline.rects.some((candidate) =>
                      rectanglesOverlap(candidate, rectangle),
                    ),
                  );
                  const y = clamp(
                    metrics.y - (overlapsOrdinaryUnderline ? 3 : 0),
                    0,
                    dimensions.height - GLOSSARY_UNDERLINE_STROKE_WIDTH,
                  );
                  return (
                    <line
                      className={`glossary-underline ${entry.glossaryEntryId === activeGlossaryEntryId ? 'is-active' : ''}`}
                      data-glossary-entry-id={entry.glossaryEntryId}
                      key={`${entry.markerAnnotationId}-${index}`}
                      strokeLinecap="round"
                      strokeWidth={GLOSSARY_UNDERLINE_STROKE_WIDTH}
                      vectorEffect="non-scaling-stroke"
                      x1={snapToDevicePixel(rectangle.x * dimensions.width)}
                      x2={snapToDevicePixel(
                        (rectangle.x + rectangle.width) * dimensions.width,
                      )}
                      y1={y}
                      y2={y}
                    />
                  );
                }),
              )}
              {activeAnnotation?.rects.map((rectangle, index) => (
                <rect
                  className="active-highlight-indicator"
                  key={`${activeAnnotation.id}-${index}`}
                  x={rectangle.x * dimensions.width}
                  y={rectangle.y * dimensions.height}
                  width={rectangle.width * dimensions.width}
                  height={rectangle.height * dimensions.height}
                  rx="2"
                />
              ))}
              {activeLinkEndpoint?.endpoint.anchor.rects.map((rectangle, index) => (
                <rect
                  className="active-document-link-indicator"
                  key={`${activeLinkEndpoint.endpoint.id}-${index}`}
                  x={rectangle.x * dimensions.width}
                  y={rectangle.y * dimensions.height}
                  width={rectangle.width * dimensions.width}
                  height={rectangle.height * dimensions.height}
                  rx="2"
                />
              ))}
            </svg>
          ) : null}
          <div className="pdf-search-layer" aria-hidden="true">
            {searchResults.flatMap((result) =>
              result.rects.map((rectangle, index) => (
                <span
                  className={`pdf-search-rectangle ${result.id === activeSearchResultId ? 'is-active' : ''}`}
                  data-search-result-id={result.id}
                  data-search-rect-index={index}
                  key={`${result.id}-${index}`}
                  style={{
                    left: `${rectangle.x * 100}%`,
                    top: `${rectangle.y * 100}%`,
                    width: `${rectangle.width * 100}%`,
                    height: `${rectangle.height * 100}%`,
                  }}
                />
              )),
            )}
          </div>
          <div
            ref={textLayerRef}
            className="textLayer"
            data-pdf-text-layer
            data-page-number={pageNumber}
          />
          <div className="document-link-badge-layer">
            {documentLinkBadgeGroups.map((group, groupIndex) => {
              if (!dimensions) return null;
              const rectangle = getDocumentLinkFinalRectangle({
                ...group.anchor,
                rects: normalizeAnnotationVisualGeometry(
                  [...group.anchor.rects],
                  dimensions.width,
                  dimensions.height,
                ),
              });
              if (!rectangle) return null;
              const isMultiple = group.targets.length > 1;
              const exactLinks = group.visibleNumbers.join(', ');
              const describedLinks = group.targets
                .map(({ link }) =>
                  link.name
                    ? `Link ${link.visibleNumber}: ${getDocumentLinkDisplayName(link)}`
                    : `Link ${link.visibleNumber}`,
                )
                .join(', ');
              const isChooserOpen = openLinkBadgeGroupKey === group.key;
              const badgeGeometry = getDocumentLinkBadgeGeometry(
                rectangle,
                dimensions.width,
                window.devicePixelRatio,
              );
              const anchorY = getLinkUnderlineY(rectangle, dimensions.height);
              const badgeVerticalGeometry = getDocumentLinkBadgeVerticalGeometry(
                anchorY,
                dimensions.height,
              );
              const isNearLeft =
                badgeGeometry.badgeHitTargetCenterX < dimensions.width * 0.16;
              const isNearRight = badgeGeometry.isReversed;
              const isNearTop = anchorY < dimensions.height * 0.16;
              const isNearBottom = anchorY > dimensions.height * 0.78;
              const chooserId = `document-link-chooser-${pageNumber}-${groupIndex}`;
              const summaryId = `document-link-summary-${pageNumber}-${groupIndex}`;
              return (
                <div
                  className={`document-link-badge-cluster${isNearLeft ? ' is-near-left' : ''}${isNearRight ? ' is-near-right' : ''}${isNearTop ? ' is-near-top' : ''}${isNearBottom ? ' is-near-bottom' : ''}${isChooserOpen ? ' is-chooser-open' : ''}`}
                  key={group.key}
                  style={{
                    left: `${badgeGeometry.badgeHitTargetCenterX}px`,
                    top: `${badgeVerticalGeometry.badgeHitTargetCenterY}px`,
                  }}
                >
                  <button
                    className="document-link-badge"
                    type="button"
                    aria-expanded={isMultiple ? isChooserOpen : undefined}
                    aria-controls={isMultiple ? chooserId : undefined}
                    aria-describedby={isMultiple ? summaryId : undefined}
                    aria-label={
                      isMultiple
                        ? `Multiple Links: ${describedLinks}`
                        : group.targets[0].link.endpointB
                          ? `Go to the other endpoint of ${describedLinks}`
                          : `${describedLinks}, waiting for second endpoint`
                    }
                    title={describedLinks}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isMultiple) {
                        setOpenLinkBadgeGroupKey((current) =>
                          current === group.key ? null : group.key,
                        );
                        return;
                      }
                      const bounds = event.currentTarget.getBoundingClientRect();
                      const target = group.targets[0];
                      onActivateLinkBadge(target.link.id, target.endpoint.id, {
                        clientX: bounds.left + bounds.width / 2,
                        clientY: bounds.top + bounds.height / 2,
                      });
                    }}
                  >
                    <span
                      className="document-link-badge-label"
                      style={{
                        transform: `translate(${badgeGeometry.badgeVisualOffsetX}px, ${badgeVerticalGeometry.badgeVisualOffsetY}px)`,
                      }}
                    >
                      {group.label}
                    </span>
                  </button>
                  {isMultiple ? (
                    <span
                      className="document-link-badge-summary"
                      id={summaryId}
                      role="tooltip"
                    >
                      {describedLinks}
                    </span>
                  ) : null}
                  {isMultiple && isChooserOpen ? (
                    <div
                      className="document-link-badge-chooser"
                      id={chooserId}
                      role="group"
                      aria-label={`Choose among Links ${exactLinks}`}
                    >
                      {group.targets.map((target) => (
                        <button
                          key={target.link.id}
                          type="button"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setOpenLinkBadgeGroupKey(null);
                            onActivateLinkBadge(target.link.id, target.endpoint.id, {
                              clientX: bounds.left + bounds.width / 2,
                              clientY: bounds.top + bounds.height / 2,
                            });
                          }}
                        >
                          <span>Link {target.link.visibleNumber}</span>
                          {target.link.name ? (
                            <small>{getDocumentLinkDisplayName(target.link)}</small>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {links.map((link) => (
            <a
              className="pdf-link-hit-area"
              key={link.id}
              aria-label="Open PDF link"
              href={link.href}
              style={{
                left: link.left,
                top: link.top,
                width: link.width,
                height: link.height,
              }}
              target={link.external ? '_blank' : undefined}
              rel={link.external ? 'noreferrer' : undefined}
              onClick={(event) => {
                if (!link.external) {
                  event.preventDefault();
                  void handleInternalLink(link.destination);
                }
              }}
            />
          ))}
          {dimensions
            ? definitionBubbles.map((bubble) => (
                <DefinitionBubble
                  bubble={bubble}
                  isActive={activeDefinitionBubbleId === bubble.id}
                  key={bubble.id}
                  pageHeight={dimensions.height}
                  pageWidth={dimensions.width}
                  onAddToGlossary={onAddBubbleToGlossary}
                  onRemoveFromGlossary={onRemoveBubbleFromGlossary}
                  onActivate={setActiveDefinitionBubbleId}
                  onClose={onCloseDefinitionBubble}
                  onMoveDefinitionUp={onMoveDefinitionUp}
                  onToggleExpanded={onToggleDefinitionsExpanded}
                />
              ))
            : null}
        </div>
      </article>
      {textCapabilityNotice ? (
        <section
          className="pdf-page-text-capability-notice"
          id={textCapabilityNoticeId}
          aria-live="polite"
          style={textCapabilityNoticeStyle}
        >
          <p>{textCapabilityNotice}</p>
          {exposesOcrControls && ocrState.status === 'idle' ? (
            <div className="pdf-page-ocr-actions">
              <button
                type="button"
                disabled={isOcrBusy}
                onClick={() => void onRecognizeText(pageNumber)}
              >
                Recognize English text on this page
              </button>
              {document.numPages > 1 ? (
                <button
                  type="button"
                  disabled={isOcrBusy}
                  onClick={() => void onRecognizeDocument()}
                >
                  Recognize all image-only pages
                </button>
              ) : null}
            </div>
          ) : null}
          {exposesOcrControls &&
          ocrState.status === 'ready' &&
          document.numPages > 1 &&
          canRunRemainingDocumentOcr ? (
            <button
              type="button"
              disabled={isOcrBusy}
              onClick={() => void onRecognizeDocument()}
            >
              {remainingDocumentOcrLabel}
            </button>
          ) : null}
          {exposesOcrControls && ocrState.status === 'idle' && isOcrBusy ? (
            <small>Another page is being recognized locally.</small>
          ) : null}
          {ocrState.status === 'recognizing' &&
          documentOcrState.status !== 'running' ? (
            <div className="pdf-page-ocr-progress" role="status">
              <span>Recognizing locally… {Math.round(ocrState.progress * 100)}%</span>
              <progress max="1" value={ocrState.progress} />
              <button type="button" onClick={() => onCancelRecognition(pageNumber)}>
                Cancel
              </button>
            </div>
          ) : null}
          {ocrState.status === 'failed' ? (
            <div className="pdf-page-ocr-failure" role="alert">
              <span>{getPdfOcrFailureMessage(ocrState.code)}</span>
              <button
                type="button"
                disabled={isOcrBusy}
                onClick={() => void onRecognizeText(pageNumber)}
              >
                Retry local OCR
              </button>
            </div>
          ) : null}
          {documentOcrState.status === 'running' ? (
            <div className="pdf-page-ocr-document-progress" role="status">
              <span>
                {documentOcrState.phase === 'inspecting'
                  ? 'Checking image-only pages'
                  : 'Recognizing image-only pages'}
                … page {documentOcrState.currentPage} of {documentOcrState.totalPages}
              </span>
              <small>
                {documentOcrState.completedPages} recognized ·{' '}
                {documentOcrState.failedPages} unavailable
              </small>
              <progress
                max={documentOcrState.totalPages}
                value={
                  documentOcrState.phase === 'recognizing'
                    ? documentOcrState.inspectedPages -
                      1 +
                      documentOcrState.pageProgress
                    : documentOcrState.inspectedPages
                }
              />
              <button type="button" onClick={onCancelDocumentRecognition}>
                Stop document OCR
              </button>
            </div>
          ) : documentOcrState.status === 'complete' ? (
            <small className="pdf-page-ocr-document-summary" role="status">
              Document OCR finished: {documentOcrState.completedPages} image-only{' '}
              {documentOcrState.completedPages === 1 ? 'page' : 'pages'} recognized
              {documentOcrState.failedPages > 0
                ? `; ${documentOcrState.failedPages} unavailable.`
                : '.'}
            </small>
          ) : documentOcrState.status === 'cancelled' ? (
            <small className="pdf-page-ocr-document-summary" role="status">
              Document OCR stopped. Completed pages remain available for this session.
            </small>
          ) : documentOcrState.status === 'stopped' ? (
            <small className="pdf-page-ocr-document-summary" role="alert">
              Document OCR stopped safely:{' '}
              {getPdfOcrFailureMessage(documentOcrState.code)}
            </small>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

const UNDERLINE_STROKE_WIDTH = 1.85;
const GLOSSARY_UNDERLINE_STROKE_WIDTH = 1.85;
const LINK_UNDERLINE_STROKE_WIDTH = DOCUMENT_LINK_UNDERLINE_STROKE_WIDTH;

function getPdfOcrFailureMessage(code: Exclude<PdfOcrFailureCode, 'cancelled'>) {
  switch (code) {
    case 'low-confidence':
      return 'Recognition confidence was too low, so no selectable text was exposed.';
    case 'no-text':
      return 'No sufficiently reliable English text was found on this page.';
    case 'timeout':
      return 'Local OCR exceeded its safety deadline and stopped.';
    case 'busy':
      return 'Another page is already being recognized.';
    case 'engine-unavailable':
      return 'The bundled local OCR engine is unavailable.';
    case 'render-failed':
      return 'This page could not be prepared for local OCR.';
    case 'recognition-failed':
      return 'Local OCR failed without changing the PDF.';
  }
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function getUnderlineMetrics(
  rectangle: { y: number; height: number },
  pageHeight: number,
): { y: number; thickness: number } {
  const lineHeight = Math.max(rectangle.height * pageHeight, 1);
  const thickness = UNDERLINE_STROKE_WIDTH;
  const downwardOffset = clamp(lineHeight * 0.08, 1.5, 3.5);
  const preferredY = (rectangle.y + rectangle.height) * pageHeight + downwardOffset;

  return {
    y: snapToDevicePixel(clamp(preferredY, 0, Math.max(0, pageHeight - thickness))),
    thickness,
  };
}

function getLinkUnderlineY(
  rectangle: { y: number; height: number },
  pageHeight: number,
): number {
  const ordinaryUnderlineY = getUnderlineMetrics(rectangle, pageHeight).y;
  const lineHeight = Math.max(rectangle.height * pageHeight, 1);
  const separateTrackOffset = clamp(lineHeight * 0.16, 3.25, 5.5);
  const visualRadius = DOCUMENT_LINK_BADGE_VISUAL_DIAMETER / 2;
  return clamp(
    snapToDevicePixel(ordinaryUnderlineY + separateTrackOffset),
    visualRadius,
    Math.max(visualRadius, pageHeight - visualRadius),
  );
}

function getHighlightVisualRectangle(
  rectangle: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const expansion = Math.min(1.5, Math.max(0.75, rectangle.height * pageHeight * 0.06));
  const left = snapToDevicePixel(Math.max(0, rectangle.x * pageWidth - expansion));
  const right = snapToDevicePixel(
    Math.min(pageWidth, (rectangle.x + rectangle.width) * pageWidth + expansion),
  );
  const top = snapToDevicePixel(rectangle.y * pageHeight);
  const bottom = snapToDevicePixel((rectangle.y + rectangle.height) * pageHeight);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function snapToDevicePixel(value: number): number {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  return Math.round(value * ratio) / ratio;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
