import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { readingThemes, themes } from '../themes';
import { ProductivityTimer } from './ProductivityTimer';

interface ToolbarProps {
  onOpenFile: (file: File) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWidth: () => void;
  onFitPage: () => void;
  onApplyZoom: (zoom: number) => void;
  onGoToPage: (pageNumber: number) => void;
  onOpenSearch: () => void;
  openFileRequestId: number;
  onOpenLibrary: () => void;
  onExportAnnotatedPdf: () => void;
  isAnnotatedPdfExporting: boolean;
  hasDocument: boolean;
  pageCount: number;
  currentPage: number;
  effectiveZoom: number;
  documentTitle: string;
  isAiOpen: boolean;
  aiStatus: 'disconnected' | 'connected' | 'generating';
  onToggleAi: () => void;
}

export function Toolbar({
  onOpenFile,
  onZoomIn,
  onZoomOut,
  onFitWidth,
  onFitPage,
  onApplyZoom,
  onGoToPage,
  onOpenSearch,
  openFileRequestId,
  onOpenLibrary,
  onExportAnnotatedPdf,
  isAnnotatedPdfExporting,
  hasDocument,
  pageCount,
  currentPage,
  effectiveZoom,
  documentTitle,
  isAiOpen,
  aiStatus,
  onToggleAi,
}: ToolbarProps) {
  const { themeId, setTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [zoomDraft, setZoomDraft] = useState(formatZoomPercentage(effectiveZoom));
  const [isZoomEditing, setIsZoomEditing] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const [pageDraft, setPageDraft] = useState('');
  const lastOpenFileRequestRef = useRef(openFileRequestId);

  useEffect(() => {
    if (!isZoomEditing) {
      setZoomDraft(formatZoomPercentage(effectiveZoom));
    }
  }, [effectiveZoom, isZoomEditing]);

  useEffect(() => {
    setPageDraft(currentPage > 0 ? String(currentPage) : '');
  }, [currentPage]);

  useEffect(() => {
    if (openFileRequestId === lastOpenFileRequestRef.current) {
      return;
    }
    lastOpenFileRequestRef.current = openFileRequestId;
    fileInputRef.current?.click();
  }, [openFileRequestId]);

  useEffect(() => {
    if (!isThemeMenuOpen) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsThemeMenuOpen(false);
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isThemeMenuOpen]);

  const applyZoomDraft = () => {
    const parsedZoom = parseZoomPercentage(zoomDraft);
    if (parsedZoom === null) {
      setZoomDraft(formatZoomPercentage(effectiveZoom));
      setIsZoomEditing(false);
      return;
    }

    onApplyZoom(parsedZoom);
    setZoomDraft(formatZoomPercentage(parsedZoom));
    setIsZoomEditing(false);
  };

  const applyPageDraft = () => {
    if (!hasDocument || pageCount === 0 || !/^\d+$/.test(pageDraft.trim())) {
      setPageDraft(currentPage > 0 ? String(currentPage) : '');
      return;
    }

    const pageNumber = Math.min(Math.max(Number(pageDraft.trim()), 1), pageCount);
    setPageDraft(String(pageNumber));
    onGoToPage(pageNumber);
  };

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="wordmark" aria-label="39Note">
          39Note
        </span>
        <span className="document-title">{documentTitle}</span>
      </div>

      <div className="toolbar-actions">
        <ProductivityTimer />
        <button
          aria-expanded={isAiOpen}
          aria-label={`AI Assistant: ${aiStatus}`}
          className={`toolbar-button ai-toolbar-trigger is-${aiStatus}`}
          disabled={!hasDocument}
          title="Open AI Assistant"
          type="button"
          onClick={onToggleAi}
        >
          <span aria-hidden="true">✦</span>
          <span className="ai-toolbar-label">AI</span>
          <span className="ai-status-dot" aria-hidden="true" />
        </button>
        <input
          ref={fileInputRef}
          aria-hidden="true"
          className="visually-hidden"
          tabIndex={-1}
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              onOpenFile(file);
            }
            event.target.value = '';
          }}
        />
        <button
          className="toolbar-button toolbar-button-primary"
          type="button"
          onClick={() => fileInputRef.current?.click()}
        >
          Open PDF
        </button>
        <div className="viewer-controls" aria-label="PDF viewer controls">
          <button
            className="toolbar-button"
            type="button"
            disabled={!hasDocument}
            onClick={onZoomOut}
          >
            Zoom -
          </button>
          <input
            aria-label="Zoom percentage"
            className="zoom-percentage-input"
            disabled={!hasDocument}
            inputMode="decimal"
            value={zoomDraft}
            onBlur={applyZoomDraft}
            onChange={(event) => setZoomDraft(event.target.value)}
            onFocus={() => setIsZoomEditing(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              }
              if (event.key === 'Escape') {
                setZoomDraft(formatZoomPercentage(effectiveZoom));
                setIsZoomEditing(false);
                event.currentTarget.blur();
              }
            }}
          />
          <button
            className="toolbar-button"
            type="button"
            disabled={!hasDocument}
            onClick={onZoomIn}
          >
            Zoom +
          </button>
          <button
            className="toolbar-button"
            type="button"
            disabled={!hasDocument}
            onClick={onFitWidth}
          >
            Fit Width
          </button>
          <button
            className="toolbar-button"
            type="button"
            disabled={!hasDocument}
            onClick={onFitPage}
          >
            Fit Page
          </button>
          <button
            aria-label="Search PDF"
            className="toolbar-button toolbar-search-trigger"
            disabled={!hasDocument}
            title="Search PDF (Ctrl+F)"
            type="button"
            onClick={onOpenSearch}
          >
            Search
          </button>
          <label className="page-indicator">
            <input
              aria-label="Go to page"
              className="page-number-input"
              disabled={!hasDocument}
              inputMode="numeric"
              value={pageDraft}
              onBlur={applyPageDraft}
              onChange={(event) => setPageDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  setPageDraft(currentPage > 0 ? String(currentPage) : '');
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="page-total">/ {pageCount || '—'}</span>
            {currentPage || '—'} / {pageCount || '—'}
          </label>
        </div>
        <div className="theme-menu-wrapper">
          <button
            aria-expanded={isThemeMenuOpen}
            aria-haspopup="menu"
            className="toolbar-button"
            type="button"
            onClick={() => setIsThemeMenuOpen((isOpen) => !isOpen)}
          >
            Theme: {themes[themeId].label}
          </button>
          {isThemeMenuOpen ? (
            <div className="theme-menu" role="menu" aria-label="Reading theme">
              {readingThemes.map((theme) => (
                <button
                  aria-checked={themeId === theme}
                  key={theme}
                  role="menuitemradio"
                  type="button"
                  onClick={() => {
                    setTheme(theme);
                    setIsThemeMenuOpen(false);
                  }}
                >
                  <span>{themes[theme].label}</span>
                  {themeId === theme ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <button
          aria-label="Open Library"
          className="toolbar-button"
          type="button"
          onClick={onOpenLibrary}
        >
          Library
        </button>
        <button
          className="toolbar-button"
          disabled={!hasDocument || isAnnotatedPdfExporting}
          type="button"
          onClick={onExportAnnotatedPdf}
        >
          {isAnnotatedPdfExporting ? 'Exporting PDF...' : 'Export Annotated PDF'}
        </button>
        <button className="toolbar-button" type="button" disabled>
          Export Notes
        </button>
      </div>
    </header>
  );
}

function parseZoomPercentage(value: string): number | null {
  const normalizedValue = value.trim().replace(/%$/, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalizedValue)) {
    return null;
  }

  const percentage = Number(normalizedValue);
  if (!Number.isFinite(percentage)) {
    return null;
  }

  return Math.min(Math.max(percentage, 25), 500) / 100;
}

function formatZoomPercentage(zoom: number): string {
  const percentage = Math.round(zoom * 1000) / 10;
  return `${percentage}%`;
}
