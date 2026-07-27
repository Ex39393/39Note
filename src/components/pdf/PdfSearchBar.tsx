import { useEffect, useLayoutEffect, useRef } from 'react';

export interface PdfSearchPanelPosition { x: number; y: number; }

interface PdfSearchBarProps {
  query: string;
  resultCount: number;
  activeResultIndex: number;
  isIndexing: boolean;
  indexedPageCount: number;
  position: PdfSearchPanelPosition | null;
  boundsElement: HTMLElement | null;
  onPositionChange: (position: PdfSearchPanelPosition) => void;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClear: () => void;
  onClose: () => void;
}

export function PdfSearchBar({
  query,
  resultCount,
  activeResultIndex,
  isIndexing,
  indexedPageCount,
  position,
  boundsElement,
  onPositionChange,
  onQueryChange,
  onPrevious,
  onNext,
  onClear,
  onClose,
}: PdfSearchBarProps) {
  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panelX: number; panelY: number } | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !boundsElement) return;
    const clampCurrentPosition = () => {
      const defaultPosition = {
        x: Math.max(8, boundsElement.clientWidth - panel.offsetWidth - 18),
        y: 14,
      };
      onPositionChange(clampPosition(position ?? defaultPosition, boundsElement, panel));
    };
    clampCurrentPosition();
    const observer = new ResizeObserver(clampCurrentPosition);
    observer.observe(boundsElement);
    return () => observer.disconnect();
  }, [boundsElement, onPositionChange, position]);

  return (
    <section
      ref={panelRef}
      className="pdf-search-bar"
      aria-label="Search PDF"
      style={position ? { left: position.x, top: position.y } : { visibility: 'hidden' }}
    >
      <div
        className="pdf-search-drag-handle"
        onPointerDown={(event) => {
          if (event.button !== 0 || !position) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panelX: position.x, panelY: position.y };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const panel = panelRef.current;
          if (!drag || drag.pointerId !== event.pointerId || !boundsElement || !panel) return;
          event.preventDefault();
          onPositionChange(clampPosition({ x: drag.panelX + event.clientX - drag.startX, y: drag.panelY + event.clientY - drag.startY }, boundsElement, panel));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <span aria-hidden="true">⋮⋮</span>
        <strong>Search PDF</strong>
      </div>
      <div className="pdf-search-controls">
        <input
          ref={inputRef}
          aria-label="Search PDF text"
          placeholder="Search PDF"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); onNext(); }
            if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          }}
        />
        <span aria-live="polite">{query.length > 0 ? `${resultCount === 0 ? 0 : activeResultIndex + 1} / ${resultCount}` : 'Search'}</span>
        {isIndexing ? <span>Indexing {indexedPageCount}</span> : null}
        <button disabled={resultCount === 0} type="button" onClick={onPrevious}>Previous</button>
        <button disabled={resultCount === 0} type="button" onClick={onNext}>Next</button>
        <button disabled={query.length === 0} type="button" onClick={onClear}>Clear</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </section>
  );
}

function clampPosition(position: PdfSearchPanelPosition, bounds: HTMLElement, panel: HTMLElement): PdfSearchPanelPosition {
  const padding = 8;
  return {
    x: Math.min(Math.max(padding, position.x), Math.max(padding, bounds.clientWidth - panel.offsetWidth - padding)),
    y: Math.min(Math.max(padding, position.y), Math.max(padding, bounds.clientHeight - panel.offsetHeight - padding)),
  };
}
