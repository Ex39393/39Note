import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Note } from '../types/note';
import type { GlossaryEntry, NotesPrintLayout } from '../types/glossary';
import { getDefaultPrintLayout } from '../utils/glossary';
import { DrawerEdgeHandle } from './DrawerEdgeHandle';

interface NotesPanelProps {
  notes: Note[];
  glossaryEntries: GlossaryEntry[];
  annotationCount: number;
  isOpen: boolean;
  draggedNoteId: string | null;
  isExporting: boolean;
  onToggle: () => void;
  focusedNoteId: string | null;
  onFocusComplete: () => void;
  onFocusedNoteReady: (noteId: string) => void;
  onNavigate: (note: Note) => void;
  onUpdate: (noteId: string, content: string) => void;
  onUpdateDisplayNumber: (noteId: string, displayNumber: string) => void;
  onDelete: (noteId: string) => void;
  onExportNotes: (layout: NotesPrintLayout) => void;
  onEditBeforePrinting: (layout: NotesPrintLayout) => void;
  onNavigateGlossary: (entry: GlossaryEntry) => void;
  onRemoveGlossary: (glossaryEntryId: string) => void;
  onBeginNoteDrag: (note: Note, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenLargeEditor: (note: Note) => void;
}

export function NotesPanel({
  notes,
  glossaryEntries,
  annotationCount,
  isOpen,
  draggedNoteId,
  isExporting,
  onToggle,
  focusedNoteId,
  onFocusComplete,
  onFocusedNoteReady,
  onNavigate,
  onUpdate,
  onUpdateDisplayNumber,
  onDelete,
  onExportNotes,
  onEditBeforePrinting,
  onNavigateGlossary,
  onRemoveGlossary,
  onBeginNoteDrag,
  onOpenLargeEditor,
}: NotesPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isNotesSectionOpen, setIsNotesSectionOpen] = useState(true);
  const [isGlossarySectionOpen, setIsGlossarySectionOpen] = useState(false);
  const [isPrintDialogOpen, setIsPrintDialogOpen] = useState(false);
  const [printLayout, setPrintLayout] =
    useState<NotesPrintLayout>(getDefaultPrintLayout);
  const [dictionaryCacheStatus, setDictionaryCacheStatus] = useState<
    'idle' | 'clearing' | 'cleared' | 'error'
  >('idle');
  const matchingNotes = useMemo(
    () => notes.filter((note) => noteMatchesSearch(note, searchQuery)),
    [notes, searchQuery],
  );

  if (!isOpen) {
    return (
      <aside className="notes-panel is-closed" aria-label="Notes and Glossary">
        <DrawerEdgeHandle
          accessibleLabel={`Open Notes and Glossary (${notes.length + glossaryEntries.length})`}
          isOpen={false}
          side="right"
          onToggle={onToggle}
        />
      </aside>
    );
  }

  return (
    <aside className="notes-panel" aria-label="Notes and Glossary">
      <DrawerEdgeHandle
        accessibleLabel="Collapse Notes and Glossary"
        isOpen
        side="right"
        onToggle={onToggle}
      />
      <div className="notes-panel-header">
        <div className="notes-panel-heading">
          <h2>Notes &amp; Glossary</h2>
        </div>
        <div className="notes-panel-tools">
          <button
            className="notes-export-button"
            type="button"
            disabled={
              (notes.length === 0 &&
                glossaryEntries.length === 0 &&
                annotationCount === 0) ||
              isExporting
            }
            onClick={() => {
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
          <span>{notes.length + glossaryEntries.length}</span>
        </div>
      </div>
      <div className="notes-panel-content">
        <section className="notes-drawer-section">
          <button
            className="notes-section-toggle"
            aria-controls="notes-section-content"
            aria-expanded={isNotesSectionOpen}
            type="button"
            onClick={() => setIsNotesSectionOpen((open) => !open)}
          >
            <span>Notes</span>
            <span>{notes.length}</span>
          </button>
          {isNotesSectionOpen ? (
            <div id="notes-section-content" className="notes-section-content">
              <div className="notes-search">
                <div className="notes-search-field">
                  <input
                    aria-label="Search notes"
                    placeholder="Search notes"
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                  />
                  {searchQuery ? (
                    <button
                      aria-label="Clear note search"
                      type="button"
                      onClick={() => setSearchQuery('')}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
                <span aria-live="polite">
                  {matchingNotes.length} of {notes.length}
                </span>
              </div>
              <div className="notes-card-list">
                {notes.length === 0 ? (
                  <p className="notes-empty">
                    Select PDF text and choose Add Note to begin.
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
            aria-expanded={isGlossarySectionOpen}
            type="button"
            onClick={() => setIsGlossarySectionOpen((open) => !open)}
          >
            <span>Glossary</span>
            <span>{glossaryEntries.length}</span>
          </button>
          {isGlossarySectionOpen ? (
            <div id="glossary-section-content" className="notes-card-list">
              {glossaryEntries.length === 0 ? (
                <p className="notes-empty">
                  Double-click a PDF word, then add its preferred definition.
                </p>
              ) : (
                glossaryEntries.map((entry) => (
                  <article className="glossary-card" key={entry.glossaryEntryId}>
                    <button
                      className="glossary-card-navigation"
                      aria-label={`Go to ${entry.displayedWord} on page ${entry.pageNumber}`}
                      type="button"
                      onClick={() => onNavigateGlossary(entry)}
                    >
                      <strong>{entry.displayedWord}</strong>
                      <p>{entry.definition}</p>
                    </button>
                    <div>
                      <span>Page {entry.pageNumber}</span>
                      <button
                        aria-label={`Remove ${entry.displayedWord} from Glossary`}
                        type="button"
                        onClick={() => onRemoveGlossary(entry.glossaryEntryId)}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))
              )}
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
                  NLM MeSH 2026 · Courtesy of the U.S. National Library of
                  Medicine · No endorsement implied
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
                  document identifiers are sent. Normal network metadata may still be
                  visible to the provider.
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
            </div>
          ) : null}
        </section>
      </div>
      {isPrintDialogOpen ? (
        <div
          className="notes-print-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notes-print-title"
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
            <button type="button" onClick={() => setIsPrintDialogOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setIsPrintDialogOpen(false);
                onEditBeforePrinting(printLayout);
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

interface NoteCardProps {
  note: Note;
  isDragging: boolean;
  shouldFocus: boolean;
  onFocusComplete: () => void;
  onFocusedNoteReady: (noteId: string) => void;
  onNavigate: (note: Note) => void;
  onUpdate: (noteId: string, content: string) => void;
  onUpdateDisplayNumber: (noteId: string, displayNumber: string) => void;
  onDelete: (noteId: string) => void;
  onBeginNoteDrag: (note: Note, event: ReactPointerEvent<HTMLButtonElement>) => void;
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
      onClick={() => onNavigate(note)}
    >
      <blockquote>{note.selectedText}</blockquote>
      <div className="note-card-meta">
        <div className="note-card-location">
          <button
            aria-label="Drag to open large editor"
            className="note-drag-handle"
            type="button"
            onPointerDown={(event) => {
              if (event.button !== 0) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              onBeginNoteDrag(note, event);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onOpenLargeEditor(note);
              }
            }}
          >
            ⠿
          </button>
          <label>
            <span className="visually-hidden">Note number</span>
            <input
              aria-label="Note number"
              value={displayNumber}
              onBlur={() => {
                const trimmedValue = displayNumber.trim();
                if (trimmedValue.length === 0) {
                  setDisplayNumber(note.displayNumber);
                }
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
          value={note.content}
          placeholder="Write a note…"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onUpdate(note.id, event.target.value)}
        />
      </label>
    </article>
  );
}

function noteMatchesSearch(note: Note, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return [note.content, note.displayNumber].some((value) =>
    value.toLocaleLowerCase().includes(normalizedQuery),
  );
}
