import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { AnnotationFilterControl, type AnnotationFilterState } from './pdf/AnnotationFilterControl';
import { PdfNavigationDrawer } from './pdf/PdfNavigationDrawer';
import type { PdfAnnotation } from '../types/highlight';
import { DrawerEdgeHandle } from './DrawerEdgeHandle';

interface SidebarProps {
  isCollapsed: boolean;
  onToggle: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
  onGoToPage: (pageNumber: number) => void;
  annotations: PdfAnnotation[];
  notedAnnotationIds: string[];
  annotationFilter: AnnotationFilterState;
  onAnnotationFilterChange: (filter: AnnotationFilterState) => void;
}

const MIN_PANEL_PERCENT = 30;
const MAX_PANEL_PERCENT = 70;

function readBooleanPreference(key: string, fallback: boolean): boolean {
  const value = sessionStorage.getItem(key);
  return value === null ? fallback : value === 'true';
}

function readSplitPreference(): number {
  const value = Number(sessionStorage.getItem('39note.reader-tools-split'));
  return Number.isFinite(value) && value >= MIN_PANEL_PERCENT && value <= MAX_PANEL_PERCENT ? value : 50;
}

export function Sidebar({
  isCollapsed,
  onToggle,
  width,
  onWidthChange,
  pdfDocument,
  currentPage,
  onGoToPage,
  annotations,
  notedAnnotationIds,
  annotationFilter,
  onAnnotationFilterChange,
}: SidebarProps) {
  const [isNavigationOpen, setIsNavigationOpen] = useState(() => readBooleanPreference('39note.reader-navigation-open', true));
  const [isAnnotationsOpen, setIsAnnotationsOpen] = useState(() => readBooleanPreference('39note.reader-annotations-open', true));
  const [splitPercent, setSplitPercent] = useState(readSplitPreference);
  const [resizeStart, setResizeStart] = useState<{ x: number; width: number } | null>(null);

  useEffect(() => {
    sessionStorage.setItem('39note.reader-navigation-open', String(isNavigationOpen));
  }, [isNavigationOpen]);

  useEffect(() => {
    sessionStorage.setItem('39note.reader-annotations-open', String(isAnnotationsOpen));
  }, [isAnnotationsOpen]);

  useEffect(() => {
    sessionStorage.setItem('39note.reader-tools-split', String(splitPercent));
  }, [splitPercent]);

  useEffect(() => {
    if (!resizeStart) return undefined;
    const resize = (event: PointerEvent) => onWidthChange(Math.min(520, Math.max(240, Math.min(window.innerWidth * 0.42, resizeStart.width + event.clientX - resizeStart.x))));
    const stop = () => setResizeStart(null);
    window.document.body.classList.add('is-resizing-sidebar');
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };
  }, [onWidthChange, resizeStart]);

  const bothToolsOpen = isNavigationOpen && isAnnotationsOpen;
  const beginResizing = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isCollapsed || event.pointerType === 'touch') return;
    event.preventDefault();
    setResizeStart({ x: event.clientX, width });
  };

  return (
    <aside
      className="sidebar reader-tools-sidebar"
      aria-label="Reader Tools"
      aria-hidden={isCollapsed}
      style={{ '--sidebar-width': `${width}px`, '--reader-tools-split': `${splitPercent}%` } as CSSProperties}
    >
      <div className="sidebar-inner reader-tools-inner">
        <section className={`sidebar-section reader-tool-section navigation-tool ${isNavigationOpen ? 'is-open' : ''}`}>
          <header>
            <h2>Navigation</h2>
            <button aria-controls="reader-navigation-content" aria-expanded={isNavigationOpen} type="button" onClick={() => setIsNavigationOpen((open) => !open)}>
              {isNavigationOpen ? 'Collapse' : 'Expand'}
            </button>
          </header>
          {isNavigationOpen ? (
            <div id="reader-navigation-content" className="reader-tool-content">
              {pdfDocument ? <PdfNavigationDrawer document={pdfDocument} currentPage={currentPage} embedded onGoToPage={onGoToPage} /> : <p>Open a PDF to browse its outline and pages.</p>}
            </div>
          ) : null}
        </section>
        {bothToolsOpen ? (
          <input
            aria-label="Resize Navigation and Annotations panels"
            className="reader-tools-splitter"
            max={MAX_PANEL_PERCENT}
            min={MIN_PANEL_PERCENT}
            type="range"
            value={splitPercent}
            onChange={(event) => setSplitPercent(Number(event.target.value))}
            onDoubleClick={() => setSplitPercent(50)}
          />
        ) : null}
        <section className={`sidebar-section reader-tool-section annotations-tool ${isAnnotationsOpen ? 'is-open' : ''}`}>
          <header>
            <h2>Annotations</h2>
            <button aria-controls="reader-annotations-content" aria-expanded={isAnnotationsOpen} type="button" onClick={() => setIsAnnotationsOpen((open) => !open)}>
              {isAnnotationsOpen ? 'Collapse' : 'Expand'}
            </button>
          </header>
          {isAnnotationsOpen ? (
            <div id="reader-annotations-content" className="reader-tool-content">
              <AnnotationFilterControl annotations={annotations} notedIds={notedAnnotationIds} filter={annotationFilter} onChange={onAnnotationFilterChange} />
            </div>
          ) : null}
        </section>
      </div>
      <DrawerEdgeHandle
        accessibleLabel={isCollapsed ? 'Open Reader Tools' : 'Collapse Reader Tools'}
        isOpen={!isCollapsed}
        side="left"
        onToggle={onToggle}
      />
      <button aria-label="Resize Reader Tools panel" className="sidebar-resize-handle" tabIndex={-1} type="button" onPointerDown={beginResizing} />
    </aside>
  );
}
