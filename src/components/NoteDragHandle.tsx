import type { PointerEvent as ReactPointerEvent } from 'react';
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
  return (
    <button
      aria-label="Drag to open large editor"
      className="note-drag-handle"
      type="button"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onBeginNoteDrag(note, event, onDropInTarget);
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
