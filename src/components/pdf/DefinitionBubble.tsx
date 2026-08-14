import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useElementSize } from '../../hooks/useElementSize';
import type { DefinitionBubble as DefinitionBubbleModel } from '../../types/glossary';
import {
  getDictionarySourceLabel,
  getVisibleDefinitions,
} from '../../utils/dictionary';
import {
  clampDefinitionBubblePosition,
  getAnchoredDefinitionBubblePosition,
  getDefinitionBubbleWidth,
  normalizeDefinitionBubblePosition,
  resolveManualDefinitionBubblePosition,
  type DefinitionBubblePosition,
  type NormalizedDefinitionBubblePosition,
} from '../../utils/definitionBubblePosition';

interface DefinitionBubbleProps {
  bubble: DefinitionBubbleModel;
  pageWidth: number;
  pageHeight: number;
  isActive: boolean;
  onActivate: (bubbleId: string) => void;
  onAddToGlossary: (bubbleId: string) => void;
  onClose: (bubbleId: string) => void;
  onMoveDefinitionUp: (bubbleId: string, definitionId: string) => void;
  onToggleExpanded: (bubbleId: string) => void;
}

export function DefinitionBubble({
  bubble,
  pageWidth,
  pageHeight,
  isActive,
  onActivate,
  onAddToGlossary,
  onClose,
  onMoveDefinitionUp,
  onToggleExpanded,
}: DefinitionBubbleProps) {
  const [bubbleElement, setBubbleElement] = useState<HTMLElement | null>(null);
  const bubbleSize = useElementSize(bubbleElement);
  const [manualPosition, setManualPosition] =
    useState<NormalizedDefinitionBubblePosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    position: DefinitionBubblePosition;
  } | null>(null);
  const pageSize = { width: pageWidth, height: pageHeight };
  const estimatedWidth = getDefinitionBubbleWidth(pageWidth);
  const measuredSize = {
    width: bubbleSize.width || estimatedWidth,
    height: bubbleSize.height || 208,
  };
  const position = manualPosition
    ? resolveManualDefinitionBubblePosition(manualPosition, pageSize, measuredSize)
    : getAnchoredDefinitionBubblePosition(bubble.rects[0], pageSize, measuredSize);
  const visibleDefinitions = getVisibleDefinitions(
    bubble.definitions,
    bubble.isExpanded,
  );
  const hiddenDefinitionCount = bubble.definitions.length - 3;
  const sourceLabels = [
    ...new Set(
      bubble.definitions.map((definition) =>
        getDictionarySourceLabel(definition.source),
      ),
    ),
  ];

  useEffect(() => {
    const element = bubbleElement;
    if (!element) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && element.contains(document.activeElement)) {
        event.stopPropagation();
        onClose(bubble.id);
      }
    };
    element.addEventListener('keydown', handleKeyDown);
    return () => element.removeEventListener('keydown', handleKeyDown);
  }, [bubble.id, bubbleElement, onClose]);

  const moveTo = (nextPosition: DefinitionBubblePosition) => {
    const clamped = clampDefinitionBubblePosition(
      nextPosition,
      pageSize,
      measuredSize,
    );
    setManualPosition(normalizeDefinitionBubblePosition(clamped, pageSize));
  };

  const handleDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onActivate(bubble.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      position,
    };
    setIsDragging(true);
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    moveTo({
      left: drag.position.left + event.clientX - drag.clientX,
      top: drag.position.top + event.clientY - drag.clientY,
    });
  };

  const handleDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsDragging(false);
  };

  const handleHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const movement = event.shiftKey ? 20 : 8;
    const offsets: Partial<Record<string, DefinitionBubblePosition>> = {
      ArrowLeft: { left: -movement, top: 0 },
      ArrowRight: { left: movement, top: 0 },
      ArrowUp: { left: 0, top: -movement },
      ArrowDown: { left: 0, top: movement },
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    onActivate(bubble.id);
    moveTo({ left: position.left + offset.left, top: position.top + offset.top });
  };

  return (
    <aside
      ref={setBubbleElement}
      className={`definition-bubble${isActive ? ' is-active' : ''}`}
      aria-label={`Dictionary definition for ${bubble.displayedWord}`}
      style={{ left: position.left, top: position.top, width: estimatedWidth }}
      onFocusCapture={() => onActivate(bubble.id)}
      onPointerDownCapture={() => onActivate(bubble.id)}
    >
      <header>
        <button
          aria-label="Add to Glossary"
          disabled={
            bubble.status !== 'ready' ||
            bubble.definitions.length === 0 ||
            Boolean(bubble.glossaryEntryId)
          }
          title="Add to Glossary"
          type="button"
          onClick={() => onAddToGlossary(bubble.id)}
        >
          {bubble.glossaryEntryId ? '✓' : '+'}
        </button>
        <button
          aria-label={`Move definition bubble for ${bubble.displayedWord}`}
          className={`definition-bubble-drag-handle${isDragging ? ' is-dragging' : ''}`}
          title="Drag to move definition"
          type="button"
          onKeyDown={handleHandleKeyDown}
          onLostPointerCapture={handleDragEnd}
          onPointerCancel={handleDragEnd}
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
        >
          <span aria-hidden="true" className="definition-bubble-grip">⠿</span>
          <strong>{bubble.displayedWord}</strong>
        </button>
        <button
          aria-label="Close definition"
          title="Close definition"
          type="button"
          onClick={() => onClose(bubble.id)}
        >
          ×
        </button>
      </header>

      <div className="definition-bubble-content" aria-live="polite">
        {bubble.addedConfirmationToken !== undefined ? (
          <p
            className="definition-added-confirmation"
            key={bubble.addedConfirmationToken}
            role="status"
          >
            Added to Glossary
          </p>
        ) : null}
        {bubble.status === 'loading' ? <p>Looking up…</p> : null}
        {bubble.status === 'not-found' ? <p>No definition found</p> : null}
        {bubble.status === 'error' ? <p>Dictionary lookup failed</p> : null}
        {bubble.status === 'ready' ? (
          <ol>
            {visibleDefinitions.map((definition, index) => (
              <li key={definition.id}>
                <span>{definition.text}</span>
                <small>{getDictionarySourceLabel(definition.source)}</small>
                <button
                  aria-label={`Move definition ${index + 1} up`}
                  disabled={index === 0}
                  title="Move definition up"
                  type="button"
                  onClick={() => onMoveDefinitionUp(bubble.id, definition.id)}
                >
                  ↑
                </button>
              </li>
            ))}
          </ol>
        ) : null}
        {hiddenDefinitionCount > 0 && bubble.status === 'ready' ? (
          <button
            className="definition-more-button"
            aria-expanded={bubble.isExpanded}
            type="button"
            onClick={() => onToggleExpanded(bubble.id)}
          >
            {bubble.isExpanded ? 'Show fewer' : `Show ${hiddenDefinitionCount} more`}
          </button>
        ) : null}
        {bubble.status === 'ready' && bubble.isEnriching ? (
          <p className="dictionary-enrichment-status">Checking online sources…</p>
        ) : null}
      </div>
      <footer>{sourceLabels.join(' · ') || 'Local dictionary first'}</footer>
    </aside>
  );
}
