import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Note } from '../types/note';
import { DrawerEdgeHandle } from './DrawerEdgeHandle';

interface NotesPanelProps {
  notes: Note[];
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
  onExportNotes: () => void;
  onBeginNoteDrag: (note: Note, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenLargeEditor: (note: Note) => void;
}

export function NotesPanel({
  notes,
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
  onBeginNoteDrag,
  onOpenLargeEditor,
}: NotesPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const matchingNotes = useMemo(
    () => notes.filter((note) => noteMatchesSearch(note, searchQuery)),
    [notes, searchQuery],
  );

  if (!isOpen) {
    return (
      <aside className="notes-panel is-closed" aria-label="Notes">
        <DrawerEdgeHandle
          accessibleLabel={`Open Notes (${notes.length})`}
          isOpen={false}
          side="right"
          onToggle={onToggle}
        />
      </aside>
    );
  }

  return (
    <aside className="notes-panel" aria-label="Notes">
      <DrawerEdgeHandle
        accessibleLabel="Collapse Notes"
        isOpen
        side="right"
        onToggle={onToggle}
      />
      <div className="notes-panel-header">
        <div className="notes-panel-heading">
          <h2>Notes</h2>
        </div>
        <div className="notes-panel-tools">
          <button
            className="notes-export-button"
            type="button"
            disabled={notes.length === 0 || isExporting}
            onClick={onExportNotes}
          >
            {isExporting ? 'Preparing…' : 'Export PDF'}
          </button>
          <span>{notes.length}</span>
        </div>
      </div>
      <div className="notes-search">
        <div className="notes-search-field">
          <input
            aria-label="Search notes"
            placeholder="Search notes"
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchQuery ? <button aria-label="Clear note search" type="button" onClick={() => setSearchQuery('')}>Clear</button> : null}
        </div>
        <span aria-live="polite">{matchingNotes.length} of {notes.length}</span>
      </div>
      <div className="notes-panel-content">
        {notes.length === 0 ? (
          <p className="notes-empty">Select a highlight and choose Add Note to begin.</p>
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
    <article className={`note-card ${isDragging ? 'is-dragging' : ''}`} onClick={() => onNavigate(note)}>
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

  return [
    note.content,
    note.displayNumber,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
