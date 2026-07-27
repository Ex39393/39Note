import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface PdfOutlineItem {
  title: string;
  dest: unknown;
  url?: string | null;
  items: PdfOutlineItem[];
}

interface PdfNavigationDrawerProps {
  document: PDFDocumentProxy;
  currentPage: number;
  onGoToPage: (pageNumber: number) => void;
  embedded?: boolean;
}

type NavigationTab = 'outline' | 'pages';

export function PdfNavigationDrawer({ document, currentPage, onGoToPage, embedded = false }: PdfNavigationDrawerProps) {
  const [isOpen, setIsOpen] = useState(embedded);
  const [tab, setTab] = useState<NavigationTab>('outline');
  const [outline, setOutline] = useState<PdfOutlineItem[] | null>(null);
  const [selectedOutlineTitle, setSelectedOutlineTitle] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void document.getOutline().then((nextOutline) => {
      if (!disposed) setOutline(nextOutline);
    }).catch(() => {
      if (!disposed) setOutline([]);
    });
    return () => { disposed = true; };
  }, [document]);

  useEffect(() => {
    if (!isOpen || embedded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isEditableTarget(event.target)) setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [embedded, isOpen]);

  const navigationContent = (
    <div className="pdf-navigation-content">
      <div className="pdf-navigation-tabs" role="tablist" aria-label="PDF navigation sections">
        <button aria-selected={tab === 'outline'} role="tab" type="button" onClick={() => setTab('outline')}>Outline</button>
        <button aria-selected={tab === 'pages'} role="tab" type="button" onClick={() => setTab('pages')}>Pages</button>
      </div>
      {tab === 'outline' ? (
        <OutlineTree
          document={document}
          items={outline}
          selectedTitle={selectedOutlineTitle}
          onSelect={(title, pageNumber) => {
            setSelectedOutlineTitle(title);
            onGoToPage(pageNumber);
          }}
        />
      ) : (
        <ThumbnailList document={document} currentPage={currentPage} onGoToPage={onGoToPage} />
      )}
    </div>
  );

  if (embedded) {
    return <section className="pdf-navigation-embedded" aria-label="Document navigation">{navigationContent}</section>;
  }

  return (
    <aside className={`pdf-navigation-drawer ${isOpen ? 'is-open' : ''}`} aria-label="PDF navigation">
      <button
        aria-expanded={isOpen}
        className="pdf-navigation-toggle"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
      >
        {isOpen ? '<' : '>'}
        <span className="visually-hidden">{isOpen ? 'Collapse PDF navigation' : 'Open PDF navigation'}</span>
      </button>
      {isOpen ? navigationContent : null}
    </aside>
  );
}

function OutlineTree({ document, items, selectedTitle, onSelect }: {
  document: PDFDocumentProxy;
  items: PdfOutlineItem[] | null;
  selectedTitle: string | null;
  onSelect: (title: string, pageNumber: number) => void;
}) {
  if (items === null) return <p className="pdf-navigation-empty">Loading outline…</p>;
  if (items.length === 0) return <p className="pdf-navigation-empty">This document has no outline.</p>;
  return <ul className="pdf-outline-list">{items.map((item, index) => (
    <OutlineItem key={`${item.title}-${index}`} document={document} item={item} selectedTitle={selectedTitle} onSelect={onSelect} />
  ))}</ul>;
}

function OutlineItem({ document, item, selectedTitle, onSelect }: {
  document: PDFDocumentProxy;
  item: PdfOutlineItem;
  selectedTitle: string | null;
  onSelect: (title: string, pageNumber: number) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isResolving, setIsResolving] = useState(false);
  const hasChildren = item.items.length > 0;
  const navigate = async () => {
    if (typeof item.url === 'string' && item.url.length > 0) {
      if (/^https?:/i.test(item.url)) window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    setIsResolving(true);
    try {
      const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest;
      if (!Array.isArray(destination) || !destination[0]) return;
      const reference = destination[0];
      const pageNumber = typeof reference === 'number'
        ? reference + 1
        : (await document.getPageIndex(reference as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1;
      onSelect(item.title, pageNumber);
    } finally { setIsResolving(false); }
  };
  return <li>
    <div className="pdf-outline-row">
      {hasChildren ? <button aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${item.title}`} type="button" onClick={() => setIsExpanded((expanded) => !expanded)}>{isExpanded ? '−' : '+'}</button> : <span />}
      <button className={selectedTitle === item.title ? 'is-selected' : ''} disabled={isResolving} type="button" onClick={() => void navigate()}>{item.title || 'Untitled section'}</button>
    </div>
    {hasChildren && isExpanded ? <ul>{item.items.map((child, index) => <OutlineItem key={`${child.title}-${index}`} document={document} item={child} selectedTitle={selectedTitle} onSelect={onSelect} />)}</ul> : null}
  </li>;
}

function ThumbnailList({ document, currentPage, onGoToPage }: { document: PDFDocumentProxy; currentPage: number; onGoToPage: (page: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-page-number="${currentPage}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [currentPage]);
  return <div ref={listRef} className="pdf-thumbnail-list">{Array.from({ length: document.numPages }, (_, index) => <Thumbnail key={index + 1} document={document} pageNumber={index + 1} current={currentPage === index + 1} onGoToPage={onGoToPage} />)}</div>;
}

function Thumbnail({ document, pageNumber, current, onGoToPage }: { document: PDFDocumentProxy; pageNumber: number; current: boolean; onGoToPage: (page: number) => void }) {
  const hostRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || !canvasRef.current) return;
      observer.disconnect();
      void document.getPage(pageNumber).then((page) => {
        if (disposed || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 0.2 });
        const canvas = canvasRef.current;
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport });
        return task.promise.catch(() => undefined);
      });
    }, { root: host.parentElement, rootMargin: '360px 0px' });
    observer.observe(host);
    return () => { disposed = true; observer.disconnect(); task?.cancel(); };
  }, [document, pageNumber]);
  return <button ref={hostRef} data-page-number={pageNumber} className={`pdf-thumbnail ${current ? 'is-current' : ''}`} type="button" onClick={() => onGoToPage(pageNumber)}><canvas ref={canvasRef} /><span>Page {pageNumber}</span></button>;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'));
}
