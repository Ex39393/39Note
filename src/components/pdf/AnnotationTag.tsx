import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PdfGlossaryEntry } from '../../types/glossary';
import type { Note } from '../../types/note';
import { getDictionarySourceLabel } from '../../utils/dictionary';
import { MAX_DOCUMENT_LINK_NAME_LENGTH } from '../../utils/documentLinks.ts';
import type { AnnotationTagModel } from '../../utils/annotationTags';
import {
  getDocumentLinkDisplayName,
  type DocumentLinkEndpointReference,
} from '../../utils/documentLinkPresentation.ts';
import { formatPdfSourceTextForDisplay } from '../../utils/pdfSourceText';
import {
  getAdjacentReaderContextCandidateKey,
  getReaderContextCandidateKey,
  type ReaderContextCandidateReference,
} from '../../utils/readerContextCandidates';
import {
  clampFloatingSurfaceToViewport,
  getVisualViewportBounds,
} from '../../utils/responsiveLayout';
import { NoteDragHandle, type NoteDragStartHandler } from '../NoteDragHandle';
import type { ConnectableLinkOption } from './SelectionAction.tsx';

interface AnnotationTagPosition {
  left: number;
  top: number;
}

interface AnnotationTagProps {
  tag: AnnotationTagModel | null;
  glossaryEntry: PdfGlossaryEntry | null;
  linkTarget: DocumentLinkEndpointReference | null;
  draggedNoteId: string | null;
  candidates: readonly ReaderContextCandidateReference[];
  activeCandidateKey: string;
  position: AnnotationTagPosition;
  onSelect: (candidateKey: string) => void;
  onAddNote: (annotationId: string) => void;
  onUpdateNote: (noteId: string, content: string) => void;
  onCommitNoteEdit: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onDeleteAnnotation: (annotationId: string, confirmed: boolean) => void;
  onRemoveGlossaryEntry: (glossaryEntryId: string) => void;
  onNavigateLink: (linkId: string, endpointId: string) => void;
  onDeleteLink: (linkId: string, endpointId: string) => void;
  onRenameLink?: (linkId: string, name: string) => boolean | void;
  connectableLinks: readonly ConnectableLinkOption[];
  onCreateLinkFromAnnotation: (annotationId: string) => void;
  onConnectLinkFromAnnotation: (annotationId: string, linkId: string) => void;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
  onClose: () => void;
}

export function AnnotationTag({
  tag,
  glossaryEntry,
  linkTarget,
  draggedNoteId,
  candidates,
  activeCandidateKey,
  position,
  onSelect,
  onAddNote,
  onUpdateNote,
  onCommitNoteEdit,
  onDeleteNote,
  onDeleteAnnotation,
  onRemoveGlossaryEntry,
  onNavigateLink,
  onDeleteLink,
  onRenameLink,
  connectableLinks,
  onCreateLinkFromAnnotation,
  onConnectLinkFromAnnotation,
  onBeginNoteDrag,
  onOpenLargeEditor,
  onClose,
}: AnnotationTagProps) {
  const [isConfirmingDeletion, setIsConfirmingDeletion] = useState(false);
  const [isRenamingLink, setIsRenamingLink] = useState(false);
  const [isLinkChooserOpen, setIsLinkChooserOpen] = useState(false);
  const [linkNameDraft, setLinkNameDraft] = useState('');
  const [resolvedPosition, setResolvedPosition] = useState(position);
  const tagElementRef = useRef<HTMLElement>(null);
  const noteEditorRef = useRef<HTMLTextAreaElement>(null);
  const typeLabel = tag
    ? tag.annotation.type === 'highlight'
      ? 'Highlight'
      : 'Underline'
    : linkTarget
      ? `Link ${linkTarget.link.visibleNumber}`
      : 'Glossary';
  const note = tag?.note ?? null;
  const linkDisplayName = linkTarget ? getDocumentLinkDisplayName(linkTarget.link) : '';
  const linkHasCustomName = Boolean(linkTarget?.link.name?.trim());
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
    setIsRenamingLink(false);
    setIsLinkChooserOpen(false);
    setLinkNameDraft(linkDisplayName);
  }, [activeCandidateKey, linkDisplayName]);

  useEffect(() => {
    if (noteId) {
      noteEditorRef.current?.focus();
    }
  }, [noteId]);

  const positionLeft = position.left;
  const positionTop = position.top;

  useLayoutEffect(() => {
    const element = tagElementRef.current;
    if (!element) return;

    const placeInsideViewport = () => {
      const bounds = element.getBoundingClientRect();
      const nextPosition = clampFloatingSurfaceToViewport(
        { left: positionLeft, top: positionTop },
        { width: bounds.width, height: bounds.height },
        getVisualViewportBounds(),
      );
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
    window.visualViewport?.addEventListener('resize', placeInsideViewport);
    window.visualViewport?.addEventListener('scroll', placeInsideViewport);
    return () => {
      window.removeEventListener('resize', placeInsideViewport);
      window.visualViewport?.removeEventListener('resize', placeInsideViewport);
      window.visualViewport?.removeEventListener('scroll', placeInsideViewport);
      resizeObserver.disconnect();
    };
  }, [activeCandidateKey, positionLeft, positionTop]);

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
      aria-label={
        tag
          ? `${typeLabel} tag`
          : linkTarget
            ? `${typeLabel} context`
            : 'Glossary entry'
      }
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
                data-reader-history-input="note"
                data-reader-history-note-id={note.id}
                value={note.content}
                onBlur={() => onCommitNoteEdit(note.id)}
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
            <div className="annotation-tag-mark-actions">
              <div className="annotation-tag-actions">
                {note ? (
                  <button type="button" onClick={() => onDeleteNote(note.id)}>
                    Delete Note
                  </button>
                ) : null}
                <button
                  aria-expanded={isLinkChooserOpen}
                  className="annotation-tag-link-action"
                  type="button"
                  onClick={() => setIsLinkChooserOpen((current) => !current)}
                >
                  Link
                </button>
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
              {isLinkChooserOpen ? (
                <div className="annotation-tag-link-choices" aria-label="Link choices">
                  <button
                    type="button"
                    onClick={() => onCreateLinkFromAnnotation(tag.annotation.id)}
                  >
                    Create new Link
                  </button>
                  <details>
                    <summary>
                      Connect to existing Link
                      {connectableLinks.length ? ` (${connectableLinks.length})` : ''}
                    </summary>
                    {connectableLinks.length ? (
                      <ul>
                        {connectableLinks.map((link) => (
                          <li key={link.id}>
                            <button
                              type="button"
                              onClick={() =>
                                onConnectLinkFromAnnotation(tag.annotation.id, link.id)
                              }
                            >
                              <strong>Link {link.visibleNumber}</strong>
                              <span>{link.name ?? link.sourceSnippet}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No unpaired Links in this paper.</p>
                    )}
                  </details>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : linkTarget ? (
        <div className="annotation-tag-link">
          {isRenamingLink && onRenameLink ? (
            <form
              className="annotation-tag-link-rename"
              onSubmit={(event) => {
                event.preventDefault();
                const result = onRenameLink(linkTarget.link.id, linkNameDraft.trim());
                if (result !== false) setIsRenamingLink(false);
              }}
            >
              <label>
                <span>Link name</span>
                <input
                  aria-label={`Name for Link ${linkTarget.link.visibleNumber}`}
                  autoFocus
                  maxLength={MAX_DOCUMENT_LINK_NAME_LENGTH}
                  value={linkNameDraft}
                  onChange={(event) => setLinkNameDraft(event.target.value)}
                />
              </label>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    setLinkNameDraft(linkDisplayName);
                    setIsRenamingLink(false);
                  }}
                >
                  Cancel
                </button>
                <button type="submit">Save name</button>
              </div>
            </form>
          ) : (
            <div className="annotation-tag-link-name">
              <span>Name</span>
              <strong>{linkDisplayName}</strong>
            </div>
          )}
          <p className="annotation-tag-source">{linkTarget.endpoint.anchor.quote}</p>
          <p className="annotation-tag-link-status">
            {linkTarget.link.endpointB ? 'Paired' : 'Waiting for second endpoint'}
          </p>
          {isConfirmingDeletion && linkTarget.link.endpointB ? (
            <div className="annotation-tag-confirmation" role="alert">
              <p>
                {linkHasCustomName
                  ? `Delete “${linkDisplayName}”? Both endpoints will be deleted.`
                  : `Delete Link ${linkTarget.link.visibleNumber}? Both endpoints will be deleted.`}
              </p>
              <div>
                <button
                  type="button"
                  autoFocus
                  onClick={() => setIsConfirmingDeletion(false)}
                >
                  Cancel
                </button>
                <button
                  className="annotation-tag-danger-action"
                  type="button"
                  onClick={() =>
                    onDeleteLink(linkTarget.link.id, linkTarget.endpoint.id)
                  }
                >
                  Delete both endpoints
                </button>
              </div>
            </div>
          ) : (
            <div className="annotation-tag-actions">
              {linkTarget.link.endpointB ? (
                <button
                  type="button"
                  onClick={() =>
                    onNavigateLink(linkTarget.link.id, linkTarget.endpoint.id)
                  }
                >
                  Go to other endpoint
                </button>
              ) : null}
              {onRenameLink ? (
                <button
                  type="button"
                  onClick={() => {
                    setLinkNameDraft(linkDisplayName);
                    setIsRenamingLink(true);
                  }}
                >
                  Rename Link
                </button>
              ) : null}
              <button
                className="annotation-tag-danger-action"
                type="button"
                onClick={() => {
                  if (linkTarget.link.endpointB) {
                    setIsConfirmingDeletion(true);
                  } else {
                    onDeleteLink(linkTarget.link.id, linkTarget.endpoint.id);
                  }
                }}
              >
                Delete Link
              </button>
            </div>
          )}
        </div>
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
