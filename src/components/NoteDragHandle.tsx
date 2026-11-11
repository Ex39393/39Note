import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Note } from '../types/note';

export type NoteDragStartHandler = (
  note: Note,
  event: ReactPointerEvent<HTMLButtonElement>,
  onDropInTarget?: () => void,
) => void;

interface NoteDragHandleProps {
  note: Note;
  onBeginNoteDrag: NoteDragStartHandler;
  onOpenLargeEditor: (note: Note) => void;
  onDropInTarget?: () => void;
}

export function NoteDragHandle({
  note,
  onBeginNoteDrag,
  onOpenLargeEditor,
  onDropInTarget,
}: NoteDragHandleProps) {
  const lastPointerTypeRef = useRef<string | null>(null);

  return (
    <button
      aria-label="Open large Note editor; drag on desktop"
      className="note-drag-handle"
      title="Tap to open; drag to the centre on desktop"
      type="button"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        lastPointerTypeRef.current = event.pointerType;
        if (event.pointerType === 'touch') {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onBeginNoteDrag(note, event, onDropInTarget);
      }}
      onClick={(event) => {
        if (lastPointerTypeRef.current !== 'touch') return;
        event.stopPropagation();
        lastPointerTypeRef.current = null;
        onOpenLargeEditor(note);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onOpenLargeEditor(note);
      }}
    >
      ⠿
    </button>
  );
}
