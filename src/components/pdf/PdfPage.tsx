import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import type { ElementSize } from '../../hooks/useElementSize';
import type { PdfSearchResult } from '../../types/pdfSearch';
import type { DefinitionBubble as DefinitionBubbleModel, GlossaryEntry } from '../../types/glossary';
import {
  highlightColors,
  underlineColors,
  type PdfAnnotation,
} from '../../types/highlight';
import { correctTextLayerReadingOrder } from '../../utils/textLayerReadingOrder';
import { getHighlightRenderGroups, normalizeAnnotationVisualGeometry } from '../../utils/highlights';
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
  glossaryEntries: GlossaryEntry[];
  definitionBubbles: DefinitionBubbleModel[];
  activeAnnotationId: string | null;
  activeGlossaryEntryId: string | null;
  onCurrentPageChange: (pageNumber: number) => void;
  onScaleChange: (pageNumber: number, scale: number) => void;
  onGoToPage: (pageNumber: number) => void;
  onAnnotationSelect: (annotationId: string, left: number, top: number) => void;
  onAddBubbleToGlossary: (bubbleId: string) => void;
  onCloseDefinitionBubble: (bubbleId: string) => void;
  onMoveDefinitionUp: (bubbleId: string, definitionId: string) => void;
  onToggleDefinitionsExpanded: (bubbleId: string) => void;
  onPageLayoutChange: (pageNumber: number) => void;
  onTextLayerReady: (pageNumber: number) => void;
  searchResults: PdfSearchResult[];
  activeSearchResultId: string | null;
}

export function PdfPage({
  document,
  pageNumber,
  scrollElement,
  containerSize,
  fitMode,
  zoom,
  annotations,
  glossaryEntries,
  definitionBubbles,
  activeAnnotationId,
  activeGlossaryEntryId,
  onCurrentPageChange,
  onScaleChange,
  onGoToPage,
  onAnnotationSelect,
  onAddBubbleToGlossary,
  onCloseDefinitionBubble,
  onMoveDefinitionUp,
  onToggleDefinitionsExpanded,
  onPageLayoutChange,
  onTextLayerReady,
  searchResults,
  activeSearchResultId,
}: PdfPageProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [baseDimensions, setBaseDimensions] = useState<PageDimensions | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(pageNumber === 1);
  const [links, setLinks] = useState<LinkTarget[]>([]);
  const [renderWarning, setRenderWarning] = useState<string | null>(null);

  useEffect(() => {
    let isDisposed = false;

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

    if (fitMode === 'width') {
      return Math.max((containerSize.width - 64) / baseDimensions.width, 0.25);
    }

    if (fitMode === 'page') {
      const widthScale = (containerSize.width - 64) / baseDimensions.width;
      const heightScale = (containerSize.height - 64) / baseDimensions.height;
      return Math.max(Math.min(widthScale, heightScale), 0.25);
    }

    return zoom;
  }, [baseDimensions, containerSize.height, containerSize.width, fitMode, zoom]);

  const viewport = useMemo(
    () => page?.getViewport({ scale }),
    [page, scale],
  );

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
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    let isDisposed = false;

    void renderTask.promise
      .then(() => {
        if (!isDisposed) {
          setRenderWarning(null);
        }
      })
      .catch((error: unknown) => {
        if (
          !isDisposed
          && (!(error instanceof Error) || error.name !== 'RenderingCancelledException')
        ) {
          setRenderWarning(`Page ${pageNumber} could not render completely. Some images may be missing.`);
        }
      });

    return () => {
      isDisposed = true;
      renderTask.cancel();
    };
  }, [isNearViewport, page, pageNumber, viewport]);

  useEffect(() => {
    if (!page || !textLayerRef.current || !viewport) {
      return;
    }

    const container = textLayerRef.current;

    if (!isNearViewport) {
      container.replaceChildren();
      return;
    }

    container.replaceChildren();
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      container,
      viewport,
    });

    let isDisposed = false;

    void textLayer.render()
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
      container.replaceChildren();
    };
  }, [isNearViewport, onTextLayerReady, page, pageNumber, viewport]);

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

        const [firstX, firstY, secondX, secondY] = viewport.convertToViewportRectangle(
          annotation.rect,
        );
        const width = Math.abs(secondX - firstX);
        const height = Math.abs(secondY - firstY);

        if (width === 0 || height === 0) {
          return [];
        }

        const destination = annotation.dest as unknown;
        const isExternal = typeof annotation.url === 'string';

        return [{
          id: annotation.id,
          href: isExternal ? annotation.url : `#page-${pageNumber}`,
          left: Math.min(firstX, secondX),
          top: Math.min(firstY, secondY),
          width,
          height,
          external: isExternal,
          destination,
        }];
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
        :
            (await document.getPageIndex(
              pageReference as Parameters<PDFDocumentProxy['getPageIndex']>[0],
            )) + 1;

    onGoToPage(targetPage);
  };

  const handleTextLayerClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection();

    if (selection && !selection.isCollapsed) {
      return;
    }

    const textLayer = textLayerRef.current;
    if (!textLayer || textLayer.clientWidth === 0 || textLayer.clientHeight === 0) {
      return;
    }

    const layerRectangle = textLayer.getBoundingClientRect();
    const x = (event.clientX - layerRectangle.left) / textLayer.clientWidth;
    const y = (event.clientY - layerRectangle.top) / textLayer.clientHeight;
    const annotation = annotations.find((candidate) =>
      candidate.rects.some((rectangle) => {
        if (candidate.type === 'underline') {
          const underline = getUnderlineMetrics(rectangle, textLayer.clientHeight);
          const hitPadding = Math.min(4, Math.max(2, underline.thickness * 1.25));
          return (
            x >= rectangle.x &&
            x <= rectangle.x + rectangle.width &&
            event.clientY >= layerRectangle.top + underline.y - hitPadding &&
            event.clientY <= layerRectangle.top + underline.y + underline.thickness + hitPadding
          );
        }

        return (
          x >= rectangle.x &&
          x <= rectangle.x + rectangle.width &&
          y >= rectangle.y &&
          y <= rectangle.y + rectangle.height
        );
      }),
    );

    if (annotation) {
      onAnnotationSelect(annotation.id, event.clientX, event.clientY - 40);
    }
  };

  const shellStyle = dimensions
    ? ({
        width: dimensions.width,
        height: dimensions.height,
        '--total-scale-factor': scale,
      } as CSSProperties)
    : undefined;
  const highlights = annotations.filter((annotation) => annotation.type === 'highlight');
  const underlines = annotations.filter((annotation) => annotation.type === 'underline');
  const activeAnnotation = annotations.find((annotation) => annotation.id === activeAnnotationId);

  return (
    <article
      ref={shellRef}
      id={`page-${pageNumber}`}
      className="pdf-page-shell"
      style={shellStyle}
      aria-label={`Page ${pageNumber}`}
    >
      <div className="pdf-page-canvas">
        <canvas ref={canvasRef} />
        {renderWarning ? (
          <p className="pdf-page-render-warning" role="status">
            {renderWarning}
          </p>
        ) : null}
        {dimensions ? (
          <svg className="highlight-layer" aria-hidden="true" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}>
            {getHighlightRenderGroups(highlights, dimensions.width, dimensions.height).flatMap((group) =>
              group.rects.map((rectangle, index) => {
                const visualRectangle = getHighlightVisualRectangle(rectangle, dimensions.width, dimensions.height);
                return <rect className="highlight-rectangle" fill={highlightColors[group.color].cssValue} key={`${group.color}-${index}`} rx="2" {...visualRectangle} />;
              }),
            )}
            {underlines.flatMap((underline) => normalizeAnnotationVisualGeometry(underline.rects, dimensions.width, dimensions.height).map((rectangle, index) => {
              const metrics = getUnderlineMetrics(rectangle, dimensions.height);
              return (
                <line
                  className="underline-rectangle"
                  data-underline-color={underline.color}
                  key={`${underline.id}-${index}`}
                  stroke={underlineColors[underline.color].cssValue}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={UNDERLINE_STROKE_WIDTH}
                  vectorEffect="non-scaling-stroke"
                  x1={snapToDevicePixel(rectangle.x * dimensions.width)}
                  x2={snapToDevicePixel((rectangle.x + rectangle.width) * dimensions.width)}
                  y1={metrics.y}
                  y2={metrics.y}
                />
              );
            }))}
            {glossaryEntries.flatMap((entry) => entry.sourceRects.map((rectangle, index) => {
              const metrics = getUnderlineMetrics(rectangle, dimensions.height);
              const overlapsOrdinaryUnderline = underlines.some((underline) =>
                underline.rects.some((candidate) => rectanglesOverlap(candidate, rectangle)),
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
                  x2={snapToDevicePixel((rectangle.x + rectangle.width) * dimensions.width)}
                  y1={y}
                  y2={y}
                />
              );
            }))}
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
          </svg>
        ) : null}
        <div className="pdf-search-layer" aria-hidden="true">
          {searchResults.flatMap((result) => result.rects.map((rectangle, index) => (
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
          )))}
        </div>
        <div
          ref={textLayerRef}
          className="textLayer"
          data-pdf-text-layer
          data-page-number={pageNumber}
          onClick={handleTextLayerClick}
        />
        {links.map((link) => (
          <a
            className="pdf-link-hit-area"
            key={link.id}
            aria-label="Open PDF link"
            href={link.href}
            style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
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
                key={bubble.id}
                pageHeight={dimensions.height}
                pageWidth={dimensions.width}
                onAddToGlossary={onAddBubbleToGlossary}
                onClose={onCloseDefinitionBubble}
                onMoveDefinitionUp={onMoveDefinitionUp}
                onToggleExpanded={onToggleDefinitionsExpanded}
              />
            ))
          : null}
      </div>
    </article>
  );
}

const UNDERLINE_STROKE_WIDTH = 1.85;
const GLOSSARY_UNDERLINE_STROKE_WIDTH = 1.85;

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

function getHighlightVisualRectangle(
  rectangle: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const expansion = Math.min(1.5, Math.max(0.75, rectangle.height * pageHeight * 0.06));
  const left = snapToDevicePixel(Math.max(0, rectangle.x * pageWidth - expansion));
  const right = snapToDevicePixel(Math.min(pageWidth, (rectangle.x + rectangle.width) * pageWidth + expansion));
  const top = snapToDevicePixel(rectangle.y * pageHeight);
  const bottom = snapToDevicePixel((rectangle.y + rectangle.height) * pageHeight);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function snapToDevicePixel(value: number): number {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  return Math.round(value * ratio) / ratio;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
