import { useEffect, useRef, useState } from 'react';
import type { Note } from '../types/note';

interface LargeNoteEditorProps {
  note: Note;
  documentTitle: string;
  onClose: () => void;
  onUpdate: (noteId: string, content: string) => void;
  onUpdateDisplayNumber: (noteId: string, displayNumber: string) => void;
}

export function LargeNoteEditor({
  note,
  documentTitle,
  onClose,
  onUpdate,
  onUpdateDisplayNumber,
}: LargeNoteEditorProps) {
  const contentEditorRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  const [displayNumber, setDisplayNumber] = useState(note.displayNumber);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    contentEditorRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    setDisplayNumber(note.displayNumber);
  }, [note.displayNumber]);

  return (
    <div className="large-note-editor-overlay" role="presentation">
      <section className="large-note-editor" aria-label="Large Note editor" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>{documentTitle}</p>
            <h2>Note editor</h2>
          </div>
          <button type="button" onClick={onClose}>Done</button>
        </header>
        <div className="large-note-editor-meta">
          <label>
            <span>Note label</span>
            <input
              value={displayNumber}
              onBlur={() => {
                const normalizedValue = displayNumber.trim();
                if (normalizedValue.length === 0) {
                  setDisplayNumber(note.displayNumber);
                }
              }}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDisplayNumber(nextValue);
                const normalizedValue = nextValue.trim();
                if (normalizedValue.length > 0) {
                  onUpdateDisplayNumber(note.id, normalizedValue);
                }
              }}
            />
          </label>
          <span>Page {note.pageNumber}</span>
        </div>
        <section className="large-note-source" aria-label="Selected source text">
          <h3>Selected source text</h3>
          <blockquote>{note.selectedText.trim() || 'Source text unavailable'}</blockquote>
        </section>
        <label className="large-note-content">
          <span>Your note</span>
          <textarea
            ref={contentEditorRef}
            value={note.content}
            placeholder="Write a note…"
            onChange={(event) => onUpdate(note.id, event.target.value)}
          />
        </label>
      </section>
    </div>
  );
}
