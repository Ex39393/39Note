import { useEffect, useRef } from 'react';
import type { DefinitionBubble as DefinitionBubbleModel } from '../../types/glossary';
import {
  getDictionarySourceLabel,
  getVisibleDefinitions,
} from '../../utils/dictionary';

interface DefinitionBubbleProps {
  bubble: DefinitionBubbleModel;
  pageWidth: number;
  pageHeight: number;
  onAddToGlossary: (bubbleId: string) => void;
  onClose: (bubbleId: string) => void;
  onMoveDefinitionUp: (bubbleId: string, definitionId: string) => void;
  onToggleExpanded: (bubbleId: string) => void;
}

export function DefinitionBubble({
  bubble,
  pageWidth,
  pageHeight,
  onAddToGlossary,
  onClose,
  onMoveDefinitionUp,
  onToggleExpanded,
}: DefinitionBubbleProps) {
  const bubbleRef = useRef<HTMLElement>(null);
  const anchor = bubble.rects[0];
  const estimatedWidth = Math.min(286, Math.max(220, pageWidth - 20));
  const anchorLeft = (anchor?.x ?? 0.5) * pageWidth;
  const anchorTop = (anchor?.y ?? 0.5) * pageHeight;
  const anchorBottom = ((anchor?.y ?? 0.5) + (anchor?.height ?? 0)) * pageHeight;
  const left = Math.max(10, Math.min(anchorLeft, pageWidth - estimatedWidth - 10));
  const placeAbove = anchorBottom + 210 > pageHeight && anchorTop > 220;
  const top = placeAbove
    ? Math.max(10, anchorTop - 208)
    : Math.min(pageHeight - 50, anchorBottom + 10);
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
    const element = bubbleRef.current;
    if (!element) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && element.contains(document.activeElement)) {
        event.stopPropagation();
        onClose(bubble.id);
      }
    };
    element.addEventListener('keydown', handleKeyDown);
    return () => element.removeEventListener('keydown', handleKeyDown);
  }, [bubble.id, onClose]);

  return (
    <aside
      ref={bubbleRef}
      className="definition-bubble"
      aria-label={`Dictionary definition for ${bubble.displayedWord}`}
      style={{ left, top, width: estimatedWidth }}
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
        <strong>{bubble.displayedWord}</strong>
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
