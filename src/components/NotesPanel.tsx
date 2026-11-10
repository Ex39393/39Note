import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { Note } from '../types/note';
import type { DocumentLink } from '../types/documentLink';
import {
  isPdfGlossaryEntry,
  type GlossaryEntry,
  type NotesPrintLayout,
} from '../types/glossary';
import { getDefaultPrintLayout } from '../utils/glossary';
import {
  findDocumentLinksBySearchQuery,
  formatDocumentLinkSnippet,
  getDocumentLinkDisplayName,
} from '../utils/documentLinkPresentation';
import { MAX_DOCUMENT_LINK_NAME_LENGTH } from '../utils/documentLinks';
import {
  glossaryEntryMatchesSearch,
  noteMatchesSearch,
} from '../utils/notesPanelSearch';
import { formatPdfSourceTextForDisplay } from '../utils/pdfSourceText';
import { DrawerEdgeHandle } from './DrawerEdgeHandle';
import { NoteDragHandle, type NoteDragStartHandler } from './NoteDragHandle';

function getGlossaryLocationLabel(entry: GlossaryEntry): string {
  return isPdfGlossaryEntry(entry) ? `Page ${entry.pageNumber}` : entry.locationLabel;
}

interface NotesPanelProps {
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  documentLinks?: DocumentLink[];
  annotationCount: number;
  activeDocumentId?: string | null;
  isOpen: boolean;
  isModal?: boolean;
  draggedNoteId: string | null;
  isExporting: boolean;
  onToggle: () => void;
  focusedNoteId: string | null;
  onFocusComplete: () => void;
  onFocusedNoteReady: (noteId: string) => void;
  onNavigate: (note: Note) => void;
  onUpdate: (noteId: string, content: string) => void;
  onUpdateDisplayNumber: (noteId: string, displayNumber: string) => void;
  onCommitNoteEdit: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onExportNotes: (layout: NotesPrintLayout) => void;
  onEditBeforePrinting: (
    layout: NotesPrintLayout,
    returnFocusTarget?: HTMLElement,
  ) => void;
  onNavigateGlossary: (entry: GlossaryEntry) => void;
  onRemoveGlossary: (glossaryEntryId: string) => void;
  onNavigateLink?: (linkId: string, endpointId: string) => void;
  onRenameLink?: (linkId: string, name: string) => boolean | void;
  onDeleteLink?: (linkId: string) => void;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
}

export function NotesPanel({
  notes,
  glossaryEntries,
  documentLinks = [],
  annotationCount,
  activeDocumentId,
  isOpen,
  isModal = false,
  draggedNoteId,
  isExporting,
  onToggle,
  focusedNoteId,
  onFocusComplete,
  onFocusedNoteReady,
  onNavigate,
  onUpdate,
  onUpdateDisplayNumber,
  onCommitNoteEdit,
  onDelete,
  onExportNotes,
  onEditBeforePrinting,
  onNavigateGlossary,
  onRemoveGlossary,
  onNavigateLink,
  onRenameLink,
  onDeleteLink,
  onBeginNoteDrag,
  onOpenLargeEditor,
}: NotesPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isNotesSectionOpen, setIsNotesSectionOpen] = useState(true);
  const [isGlossarySectionOpen, setIsGlossarySectionOpen] = useState(false);
  const [isLinksSectionOpen, setIsLinksSectionOpen] = useState(false);
  const [isPrintDialogOpen, setIsPrintDialogOpen] = useState(false);
  const [printLayout, setPrintLayout] =
    useState<NotesPrintLayout>(getDefaultPrintLayout);
  const printExportButtonRef = useRef<HTMLButtonElement | null>(null);
  const printDialogRef = useRef<HTMLDivElement | null>(null);
  const shouldRestorePrintDialogFocusRef = useRef(true);
  const [dictionaryCacheStatus, setDictionaryCacheStatus] = useState<
    'idle' | 'clearing' | 'cleared' | 'error'
  >('idle');
  const matchingNotes = useMemo(
    () => notes.filter((note) => noteMatchesSearch(note, searchQuery)),
    [notes, searchQuery],
  );
  const matchingGlossaryEntries = useMemo(
    () =>
      glossaryEntries.filter((entry) => glossaryEntryMatchesSearch(entry, searchQuery)),
    [glossaryEntries, searchQuery],
  );
  const matchingDocumentLinks = useMemo(
    () => findDocumentLinksBySearchQuery(documentLinks, searchQuery),
    [documentLinks, searchQuery],
  );
  const hasSearchQuery = searchQuery.trim().length > 0;
  const visibleNotesSection = hasSearchQuery
    ? matchingNotes.length > 0
    : isNotesSectionOpen;
  const visibleGlossarySection = hasSearchQuery
    ? matchingGlossaryEntries.length > 0
    : isGlossarySectionOpen;
  const visibleLinksSection = hasSearchQuery
    ? matchingDocumentLinks.length > 0
    : isLinksSectionOpen;
  const totalSearchableItems =
    notes.length + glossaryEntries.length + documentLinks.length;
  const matchingSearchableItems =
    matchingNotes.length +
    matchingGlossaryEntries.length +
    matchingDocumentLinks.length;

  useEffect(() => {
    setIsPrintDialogOpen(false);
  }, [activeDocumentId, isOpen]);

  useEffect(() => {
    if (!isPrintDialogOpen || !isOpen) return undefined;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = printDialogRef.current;
      const initialFocus = dialog?.querySelector<HTMLElement>(
        '[data-dialog-initial-focus]:not(:disabled)',
      );
      const firstFocusable = dialog?.querySelector<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      );
      (initialFocus ?? firstFocusable ?? dialog)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      const shouldRestoreFocus = shouldRestorePrintDialogFocusRef.current;
      shouldRestorePrintDialogFocusRef.current = true;
      if (!shouldRestoreFocus) return;
      window.requestAnimationFrame(() => {
        if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) {
          returnFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [isPrintDialogOpen, isOpen]);

  const handlePrintDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setIsPrintDialogOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = printDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <aside
      id="reader-mobile-notes-panel"
      className={`notes-panel ${isOpen ? 'is-open' : 'is-closed'}`}
      aria-label="Notes, Glossary, and Links"
      aria-modal={isModal && isOpen ? true : undefined}
      role={isModal && isOpen ? 'dialog' : undefined}
      tabIndex={-1}
      data-reader-occlusion-active={isOpen ? 'true' : 'false'}
      data-reader-occlusion-edge="right"
    >
      <DrawerEdgeHandle
        accessibleLabel={
          isOpen
            ? 'Collapse Notes and Glossary'
            : `Open Notes and Glossary (${totalSearchableItems})`
        }
        isOpen={isOpen}
        disabled={isPrintDialogOpen}
        side="right"
        onToggle={onToggle}
      />
      <div
        className="notes-panel-header"
        aria-hidden={isOpen && !isPrintDialogOpen ? undefined : true}
        inert={isOpen && !isPrintDialogOpen ? undefined : true}
      >
        <div className="notes-panel-heading">
          <h2>Notes &amp; Glossary</h2>
        </div>
        <div className="notes-panel-tools">
          <button
            ref={printExportButtonRef}
            className="notes-export-button"
            type="button"
            disabled={
              (notes.length === 0 &&
                glossaryEntries.length === 0 &&
                annotationCount === 0) ||
              isExporting
            }
            onClick={() => {
              shouldRestorePrintDialogFocusRef.current = true;
              setPrintLayout(
                notes.length === 0 && glossaryEntries.length === 0
                  ? 'all-annotations'
                  : getDefaultPrintLayout(),
              );
              setIsPrintDialogOpen(true);
            }}
          >
            {isExporting ? 'Preparing…' : 'Export PDF'}
          </button>
          <span>{totalSearchableItems}</span>
          <button
            aria-label="Close Notes and Glossary"
            className="notes-panel-mobile-close"
            type="button"
            onClick={onToggle}
          >
            ×
          </button>
        </div>
      </div>
      <div
        className="notes-panel-content"
        aria-hidden={isOpen && !isPrintDialogOpen ? undefined : true}
        inert={isOpen && !isPrintDialogOpen ? undefined : true}
      >
        <div className="notes-search notes-drawer-search">
          <div className="notes-search-field">
            <input
              aria-label="Search Notes, Glossary, and Links"
              placeholder="Search Notes, Glossary, and Links"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
            {searchQuery ? (
              <button
                aria-label="Clear drawer search"
                type="button"
                onClick={() => setSearchQuery('')}
              >
                Clear
              </button>
            ) : null}
          </div>
          <span aria-live="polite">
            {matchingSearchableItems} of {totalSearchableItems}
          </span>
        </div>
        {hasSearchQuery && matchingSearchableItems === 0 ? (
          <p className="notes-empty notes-drawer-search-empty" role="status">
            No Notes, Glossary, or Links match this search.
          </p>
        ) : null}
        <section className="notes-drawer-section">
          <button
            className="notes-section-toggle"
            aria-controls="notes-section-content"
            aria-expanded={visibleNotesSection}
            disabled={hasSearchQuery}
            type="button"
            onClick={() => setIsNotesSectionOpen((open) => !open)}
          >
            <span>Notes</span>
            <span>{hasSearchQuery ? matchingNotes.length : notes.length}</span>
          </button>
          {visibleNotesSection ? (
            <div id="notes-section-content" className="notes-section-content">
              <div className="notes-card-list">
                {notes.length === 0 ? (
                  <p className="notes-empty">
                    Highlight or underline PDF text, then choose Add Note from its Tag.
                  </p>
                ) : matchingNotes.length === 0 ? (
                  <p className="notes-empty">No notes match this search.</p>
                ) : (
                  matchingNotes.map((note) => (
                    <NoteCard
                      key={note.id}
                      note={note}
                      isDragging={draggedNoteId === note.id}
                      shouldFocus={focusedNoteId === note.id}
                      onFocusComplete={onFocusComplete}
                      onFocusedNoteReady={onFocusedNoteReady}
                      onNavigate={onNavigate}
                      onUpdate={onUpdate}
                      onUpdateDisplayNumber={onUpdateDisplayNumber}
                      onCommitNoteEdit={onCommitNoteEdit}
                      onDelete={onDelete}
                      onBeginNoteDrag={onBeginNoteDrag}
                      onOpenLargeEditor={onOpenLargeEditor}
                    />
                  ))
                )}
              </div>
            </div>
          ) : null}
        </section>
        <section className="notes-drawer-section glossary-section">
          <button
            className="notes-section-toggle"
            aria-controls="glossary-section-content"
            aria-expanded={visibleGlossarySection}
            disabled={hasSearchQuery}
            type="button"
            onClick={() => setIsGlossarySectionOpen((open) => !open)}
          >
            <span>Glossary</span>
            <span>
              {hasSearchQuery ? matchingGlossaryEntries.length : glossaryEntries.length}
            </span>
          </button>
          {visibleGlossarySection ? (
            <div id="glossary-section-content" className="notes-card-list">
              {glossaryEntries.length === 0 ? (
                <p className="notes-empty">
                  Double-click a PDF word, then add its preferred definition.
                </p>
              ) : matchingGlossaryEntries.length === 0 ? (
                <p className="notes-empty">No Glossary entries match this search.</p>
              ) : (
                matchingGlossaryEntries.map((entry) => (
                  <article className="glossary-card" key={entry.glossaryEntryId}>
                    <button
                      className="glossary-card-navigation"
                      aria-label={`Go to ${entry.displayedWord} at ${getGlossaryLocationLabel(entry)}`}
                      type="button"
                      onClick={() => onNavigateGlossary(entry)}
                    >
                      <strong>{entry.displayedWord}</strong>
                      <p>{entry.definition}</p>
                    </button>
                    <div>
                      <span>{getGlossaryLocationLabel(entry)}</span>
                      <button
                        aria-label={`Remove ${entry.displayedWord} from Glossary`}
                        type="button"
                        onClick={() => onRemoveGlossary(entry.glossaryEntryId)}
                      >
                        Remove from Glossary
                      </button>
                    </div>
                  </article>
                ))
              )}
              {!hasSearchQuery ? (
                <details className="dictionary-sources">
                  <summary>Dictionary sources</summary>
                  <p>Princeton WordNet 3.1 · Princeton WordNet License</p>
                  <a
                    href="https://wordnet.princeton.edu/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    WordNet source and licence
                  </a>
                  <p>English Wiktionary · CC BY-SA 4.0 / GFDL</p>
                  <a href="https://en.wiktionary.org/" target="_blank" rel="noreferrer">
                    English Wiktionary
                  </a>
                  <p>
                    NLM MeSH 2026 · Courtesy of the U.S. National Library of Medicine ·
                    No endorsement implied
                  </p>
                  <a
                    href="https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html"
                    target="_blank"
                    rel="noreferrer"
                  >
                    MeSH terms and conditions
                  </a>
                  <p>
                    39Note sends only the selected word as dictionary query content. No
                    PDF text, filenames, Notes, annotations, Glossary contents, or
                    document identifiers are sent.
                    {' Normal network metadata may still be visible to the provider.'}
                  </p>
                  <button
                    type="button"
                    disabled={dictionaryCacheStatus === 'clearing'}
                    onClick={() => {
                      setDictionaryCacheStatus('clearing');
                      void import('../services/dictionary/dictionaryCache')
                        .then(({ clearDictionaryCache }) => clearDictionaryCache())
                        .then(() => setDictionaryCacheStatus('cleared'))
                        .catch(() => setDictionaryCacheStatus('error'));
                    }}
                  >
                    {dictionaryCacheStatus === 'clearing'
                      ? 'Clearing…'
                      : 'Clear Dictionary Cache'}
                  </button>
                  {dictionaryCacheStatus === 'cleared' ? (
                    <p role="status">Dictionary cache cleared.</p>
                  ) : null}
                  {dictionaryCacheStatus === 'error' ? (
                    <p role="status">Dictionary cache could not be cleared.</p>
                  ) : null}
                </details>
              ) : null}
            </div>
          ) : null}
        </section>
        <section className="notes-drawer-section document-links-section">
          <button
            className="notes-section-toggle"
            aria-controls="document-links-section-content"
            aria-expanded={visibleLinksSection}
            disabled={hasSearchQuery}
            type="button"
            onClick={() => setIsLinksSectionOpen((open) => !open)}
          >
            <span>Links</span>
            <span>{matchingDocumentLinks.length}</span>
          </button>
          {visibleLinksSection ? (
            <div id="document-links-section-content" className="notes-card-list">
              {documentLinks.length === 0 ? (
                <p className="notes-empty">
                  Select PDF text and choose Link to create a connection.
                </p>
              ) : matchingDocumentLinks.length === 0 ? (
                <p className="notes-empty">No Links match this search.</p>
              ) : (
                matchingDocumentLinks.map((link) => (
                  <DocumentLinkCard
                    key={link.id}
                    link={link}
                    onNavigate={onNavigateLink}
                    onRename={onRenameLink}
                    onDelete={onDeleteLink}
                  />
                ))
              )}
            </div>
          ) : null}
        </section>
      </div>
      {isPrintDialogOpen ? (
        <div
          ref={printDialogRef}
          className="notes-print-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notes-print-title"
          aria-hidden={isOpen ? undefined : true}
          inert={isOpen ? undefined : true}
          tabIndex={-1}
          onKeyDown={handlePrintDialogKeyDown}
        >
          <h3 id="notes-print-title">Print Notes and Glossary</h3>
          <fieldset>
            <legend>Layout</legend>
            <label>
              <input
                type="radio"
                name="notes-print-layout"
                value="standard"
                disabled={notes.length === 0 && glossaryEntries.length === 0}
                checked={printLayout === 'standard'}
                onChange={() => setPrintLayout('standard')}
              />{' '}
              Standard
            </label>
            <label>
              <input
                type="radio"
                name="notes-print-layout"
                value="space-saving"
                disabled={notes.length === 0 && glossaryEntries.length === 0}
                checked={printLayout === 'space-saving'}
                onChange={() => setPrintLayout('space-saving')}
              />{' '}
              Space-saving
            </label>
            <label>
              <input
                type="radio"
                name="notes-print-layout"
                value="extra-large"
                disabled={notes.length === 0 && glossaryEntries.length === 0}
                checked={printLayout === 'extra-large'}
                onChange={() => setPrintLayout('extra-large')}
              />{' '}
              Extra Large
            </label>
            <label>
              <input
                type="radio"
                name="notes-print-layout"
                value="all-annotations"
                checked={printLayout === 'all-annotations'}
                onChange={() => setPrintLayout('all-annotations')}
              />{' '}
              All Annotations
            </label>
          </fieldset>
          <div>
            <button
              data-dialog-initial-focus
              type="button"
              onClick={() => setIsPrintDialogOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                shouldRestorePrintDialogFocusRef.current = false;
                setIsPrintDialogOpen(false);
                onEditBeforePrinting(
                  printLayout,
                  printExportButtonRef.current ?? undefined,
                );
              }}
            >
              Edit before printing
            </button>
            <button
              type="button"
              onClick={() => {
                setIsPrintDialogOpen(false);
                onExportNotes(printLayout);
              }}
            >
              Print
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

interface DocumentLinkCardProps {
  link: DocumentLink;
  onNavigate?: (linkId: string, endpointId: string) => void;
  onRename?: (linkId: string, name: string) => boolean | void;
  onDelete?: (linkId: string) => void;
}

function DocumentLinkCard({
  link,
  onNavigate,
  onRename,
  onDelete,
}: DocumentLinkCardProps) {
  const displayName = getDocumentLinkDisplayName(link);
  const identityLabel = `Link ${link.visibleNumber}`;
  const accessibleName =
    displayName === identityLabel ? identityLabel : `${displayName}, ${identityLabel}`;
  const [isRenaming, setIsRenaming] = useState(false);
  const [isConfirmingDeletion, setIsConfirmingDeletion] = useState(false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const endpoints = [
    { endpoint: link.endpointA, label: 'A' as const },
    ...(link.endpointB ? [{ endpoint: link.endpointB, label: 'B' as const }] : []),
  ];

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  return (
    <article className="document-link-card">
      <div className="document-link-card-heading">
        <div>
          <strong>{displayName}</strong>
          {displayName !== identityLabel ? (
            <span className="document-link-card-identity">{identityLabel}</span>
          ) : null}
        </div>
        <span className="document-link-card-status">
          {link.endpointB ? 'Paired' : 'Waiting for second endpoint'}
        </span>
      </div>
      {isRenaming && onRename ? (
        <form
          className="document-link-card-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const result = onRename(link.id, nameDraft.trim());
            if (result !== false) setIsRenaming(false);
          }}
        >
          <label>
            <span className="visually-hidden">Name for {identityLabel}</span>
            <input
              aria-label={`Name for ${identityLabel}`}
              autoFocus
              maxLength={MAX_DOCUMENT_LINK_NAME_LENGTH}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </label>
          <div>
            <button
              type="button"
              onClick={() => {
                setNameDraft(displayName);
                setIsRenaming(false);
              }}
            >
              Cancel
            </button>
            <button type="submit">Save name</button>
          </div>
        </form>
      ) : isConfirmingDeletion && link.endpointB && onDelete ? (
        <div className="document-link-card-confirmation" role="alert">
          <p>
            Delete {displayName === identityLabel ? identityLabel : `“${displayName}”`}?
            Both endpoints will be deleted.
          </p>
          <div>
            <button
              type="button"
              autoFocus
              aria-label={`Cancel deleting ${accessibleName}`}
              onClick={() => setIsConfirmingDeletion(false)}
            >
              Cancel
            </button>
            <button
              className="document-link-card-danger-action"
              type="button"
              aria-label={`Delete both endpoints of ${accessibleName}`}
              onClick={() => onDelete(link.id)}
            >
              Delete both endpoints
            </button>
          </div>
        </div>
      ) : onRename || onDelete ? (
        <div className="document-link-card-actions">
          {onRename ? (
            <button
              type="button"
              aria-label={`Rename ${accessibleName}`}
              onClick={() => {
                setNameDraft(displayName);
                setIsRenaming(true);
              }}
            >
              Rename Link
            </button>
          ) : null}
          {onDelete ? (
            <button
              className="document-link-card-danger-action"
              type="button"
              aria-label={`Delete ${accessibleName}`}
              onClick={() => {
                if (link.endpointB) setIsConfirmingDeletion(true);
                else onDelete(link.id);
              }}
            >
              Delete Link
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="document-link-card-endpoints">
        {endpoints.map(({ endpoint, label }) => (
          <button
            className="document-link-card-endpoint"
            aria-label={`Open ${accessibleName}, endpoint ${label}, on page ${endpoint.anchor.pageNumber}`}
            disabled={!onNavigate}
            key={endpoint.id}
            type="button"
            onClick={() => onNavigate?.(link.id, endpoint.id)}
          >
            <strong>Endpoint {label}</strong>
            <span>
              Page {endpoint.anchor.pageNumber} ·{' '}
              {formatDocumentLinkSnippet(endpoint.anchor.quote)}
            </span>
          </button>
        ))}
      </div>
    </article>
  );
}

interface NoteCardProps {
  note: Note;
  isDragging: boolean;
  shouldFocus: boolean;
  onFocusComplete: () => void;
  onFocusedNoteReady: (noteId: string) => void;
  onNavigate: (note: Note) => void;
  onUpdate: (noteId: string, content: string) => void;
  onUpdateDisplayNumber: (noteId: string, displayNumber: string) => void;
  onCommitNoteEdit: (noteId: string) => void;
  onDelete: (noteId: string) => void;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
}

function NoteCard({
  note,
  isDragging,
  shouldFocus,
  onFocusComplete,
  onFocusedNoteReady,
  onNavigate,
  onUpdate,
  onUpdateDisplayNumber,
  onCommitNoteEdit,
  onDelete,
  onBeginNoteDrag,
  onOpenLargeEditor,
}: NoteCardProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [displayNumber, setDisplayNumber] = useState(note.displayNumber);

  useEffect(() => {
    if (shouldFocus) {
      editorRef.current?.focus();
      editorRef.current?.scrollIntoView({ block: 'nearest' });
      onFocusedNoteReady(note.id);
      onFocusComplete();
    }
  }, [note.id, onFocusComplete, onFocusedNoteReady, shouldFocus]);

  useEffect(() => {
    setDisplayNumber(note.displayNumber);
  }, [note.displayNumber]);

  return (
    <article
      className={`note-card ${isDragging ? 'is-dragging' : ''}`}
      data-note-drag-source="true"
      onClick={() => onNavigate(note)}
    >
      <blockquote>{formatPdfSourceTextForDisplay(note.selectedText)}</blockquote>
      <div className="note-card-meta">
        <div className="note-card-location">
          <NoteDragHandle
            note={note}
            onBeginNoteDrag={onBeginNoteDrag}
            onOpenLargeEditor={onOpenLargeEditor}
          />
          <label>
            <span className="visually-hidden">Note number</span>
            <input
              aria-label="Note number"
              data-reader-history-input="note"
              data-reader-history-note-id={note.id}
              value={displayNumber}
              onBlur={() => {
                const trimmedValue = displayNumber.trim();
                if (trimmedValue.length === 0) {
                  setDisplayNumber(note.displayNumber);
                }
                onCommitNoteEdit(note.id);
              }}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDisplayNumber(nextValue);
                const trimmedValue = nextValue.trim();
                if (trimmedValue.length > 0) {
                  onUpdateDisplayNumber(note.id, trimmedValue);
                }
              }}
              onClick={(event) => event.stopPropagation()}
            />
          </label>
          <span>Page {note.pageNumber}</span>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(note.id);
          }}
        >
          Delete Note
        </button>
      </div>
      <label>
        <span className="visually-hidden">Note for selected text</span>
        <textarea
          ref={editorRef}
          data-reader-history-input="note"
          data-reader-history-note-id={note.id}
          value={note.content}
          placeholder="Write a note…"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onUpdate(note.id, event.target.value)}
          onBlur={() => onCommitNoteEdit(note.id)}
        />
      </label>
    </article>
  );
}
