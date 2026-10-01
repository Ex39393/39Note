import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PdfGlossaryEntry } from '../../types/glossary';
import type { Note } from '../../types/note';
import { getDictionarySourceLabel } from '../../utils/dictionary';
import type { AnnotationTagModel } from '../../utils/annotationTags';
import { formatPdfSourceTextForDisplay } from '../../utils/pdfSourceText';
import {
  getAdjacentReaderContextCandidateKey,
  getReaderContextCandidateKey,
  type ReaderContextCandidateReference,
} from '../../utils/readerContextCandidates';
import { NoteDragHandle, type NoteDragStartHandler } from '../NoteDragHandle';

interface AnnotationTagPosition {
  left: number;
  top: number;
}

interface AnnotationTagProps {
  tag: AnnotationTagModel | null;
  glossaryEntry: PdfGlossaryEntry | null;
  draggedNoteId: string | null;
  candidates: readonly ReaderContextCandidateReference[];
  activeCandidateKey: string;
  position: AnnotationTagPosition;
  onSelect: (candidateKey: string) => void;
  onAddNote: (annotationId: string) => void;
  onUpdateNote: (noteId: string, content: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteAnnotation: (annotationId: string, confirmed: boolean) => void;
  onRemoveGlossaryEntry: (glossaryEntryId: string) => void;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
  onClose: () => void;
}

export function AnnotationTag({
  tag,
  glossaryEntry,
  draggedNoteId,
  candidates,
  activeCandidateKey,
  position,
  onSelect,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onDeleteAnnotation,
  onRemoveGlossaryEntry,
  onBeginNoteDrag,
  onOpenLargeEditor,
  onClose,
}: AnnotationTagProps) {
  const [isConfirmingDeletion, setIsConfirmingDeletion] = useState(false);
  const [resolvedPosition, setResolvedPosition] = useState(position);
  const tagElementRef = useRef<HTMLElement>(null);
  const noteEditorRef = useRef<HTMLTextAreaElement>(null);
  const typeLabel = tag
    ? tag.annotation.type === 'highlight'
      ? 'Highlight'
      : 'Underline'
    : 'Glossary';
  const note = tag?.note ?? null;
  const isNoteDragging = note?.id === draggedNoteId;
  const noteId = note?.id;
  const activeCandidateIndex = Math.max(
    0,
    candidates.findIndex(
      (candidate) => getReaderContextCandidateKey(candidate) === activeCandidateKey,
    ),
  );

  useEffect(() => {
    setIsConfirmingDeletion(false);
  }, [activeCandidateKey]);

  useEffect(() => {
    if (noteId) {
      noteEditorRef.current?.focus();
    }
  }, [noteId]);

  useLayoutEffect(() => {
    const element = tagElementRef.current;
    if (!element) return;

    const placeInsideViewport = () => {
      const bounds = element.getBoundingClientRect();
      const nextPosition = {
        left: clamp(
          position.left,
          8,
          Math.max(8, window.innerWidth - bounds.width - 8),
        ),
        top: clamp(
          position.top,
          8,
          Math.max(8, window.innerHeight - bounds.height - 8),
        ),
      };
      setResolvedPosition((current) =>
        current.left === nextPosition.left && current.top === nextPosition.top
          ? current
          : nextPosition,
      );
    };

    placeInsideViewport();
    const resizeObserver = new ResizeObserver(placeInsideViewport);
    resizeObserver.observe(element);
    window.addEventListener('resize', placeInsideViewport);
    return () => {
      window.removeEventListener('resize', placeInsideViewport);
      resizeObserver.disconnect();
    };
  }, [activeCandidateKey, position.left, position.top]);

  const selectAdjacentCandidate = (direction: -1 | 1) => {
    const candidateKey = getAdjacentReaderContextCandidateKey(
      candidates,
      activeCandidateKey,
      direction,
    );
    if (candidateKey) onSelect(candidateKey);
  };

  return (
    <section
      ref={tagElementRef}
      className={`annotation-tag${isNoteDragging ? ' is-dragging' : ''}`}
      data-note-drag-source={note ? 'true' : undefined}
      inert={isNoteDragging ? true : undefined}
      role="dialog"
      aria-label={tag ? `${typeLabel} tag` : 'Glossary entry'}
      style={{ left: resolvedPosition.left, top: resolvedPosition.top }}
    >
      <header className="annotation-tag-header">
        <strong className="annotation-tag-title">{typeLabel}</strong>
        <div className="annotation-tag-header-controls">
          {candidates.length > 1 ? (
            <nav
              className="annotation-tag-context-navigation"
              aria-label="Context items"
            >
              <button
                type="button"
                aria-label="Previous contextual item"
                onClick={() => selectAdjacentCandidate(-1)}
              >
                ←
              </button>
              <span aria-live="polite">
                {activeCandidateIndex + 1} / {candidates.length}
              </span>
              <button
                type="button"
                aria-label="Next contextual item"
                onClick={() => selectAdjacentCandidate(1)}
              >
                →
              </button>
            </nav>
          ) : null}
          <button
            className="annotation-tag-close"
            type="button"
            aria-label="Close context"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      {tag ? (
        <>
          <p className="annotation-tag-source">
            {formatPdfSourceTextForDisplay(tag.annotation.text)}
          </p>
          {note ? (
            <div className="annotation-tag-note">
              <div className="annotation-tag-note-header">
                <span>Note</span>
                <NoteDragHandle
                  note={note}
                  onBeginNoteDrag={onBeginNoteDrag}
                  onDropInTarget={onClose}
                  onOpenLargeEditor={(selectedNote) => {
                    onOpenLargeEditor(selectedNote);
                    onClose();
                  }}
                />
              </div>
              <textarea
                ref={noteEditorRef}
                aria-label={`Note for ${typeLabel.toLowerCase()}`}
                value={note.content}
                onChange={(event) => onUpdateNote(note.id, event.target.value)}
              />
            </div>
          ) : (
            <button
              className="annotation-tag-primary-action"
              type="button"
              onClick={() => onAddNote(tag.annotation.id)}
            >
              Add Note
            </button>
          )}
          {isConfirmingDeletion && note ? (
            <div className="annotation-tag-confirmation" role="alert">
              <p>Delete this {typeLabel.toLowerCase()} and its note?</p>
              <div>
                <button type="button" onClick={() => setIsConfirmingDeletion(false)}>
                  Cancel
                </button>
                <button
                  className="annotation-tag-danger-action"
                  type="button"
                  onClick={() => onDeleteAnnotation(tag.annotation.id, true)}
                >
                  Delete {typeLabel} and Note
                </button>
              </div>
            </div>
          ) : (
            <div className="annotation-tag-actions">
              {note ? (
                <button type="button" onClick={() => onDeleteNote(note.id)}>
                  Delete Note
                </button>
              ) : null}
              <button
                className="annotation-tag-danger-action"
                type="button"
                onClick={() => {
                  if (note) {
                    setIsConfirmingDeletion(true);
                  } else {
                    onDeleteAnnotation(tag.annotation.id, false);
                  }
                }}
              >
                Delete {typeLabel}
              </button>
            </div>
          )}
        </>
      ) : glossaryEntry ? (
        <div className="annotation-tag-glossary">
          <strong>{glossaryEntry.displayedWord}</strong>
          <p>{glossaryEntry.definition}</p>
          <small>
            Page {glossaryEntry.pageNumber} ·{' '}
            {getDictionarySourceLabel(glossaryEntry.source)}
          </small>
          <button
            className="annotation-tag-danger-action annotation-tag-glossary-action"
            type="button"
            onClick={() => onRemoveGlossaryEntry(glossaryEntry.glossaryEntryId)}
          >
            Remove from Glossary
          </button>
        </div>
      ) : (
        <p className="annotation-tag-source">This context is no longer available.</p>
      )}
    </section>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
