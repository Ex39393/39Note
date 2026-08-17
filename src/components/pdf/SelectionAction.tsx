import { useState } from 'react';
import {
  highlightColors,
  underlineColors,
  type AnnotationType,
  type HighlightColor,
  type UnderlineColor,
} from '../../types/highlight';

interface FloatingActionPosition {
  left: number;
  top: number;
}

type AnnotationColor = HighlightColor | UnderlineColor;

export interface SelectionDeleteAction {
  id: string;
  label: string;
  detail: string;
  onActivate: () => void;
}

interface SelectionActionProps {
  position: FloatingActionPosition;
  annotationType: AnnotationType | null;
  onAnnotationTypeChange: (type: AnnotationType) => void;
  selectedColor: AnnotationColor;
  onColorChange: (color: AnnotationColor) => void;
  onApply: () => void;
  noteLabel?: 'Add Note' | 'Open Note';
  onNote?: () => void;
  existingAnnotationTypes?: readonly AnnotationType[];
  deleteActions: SelectionDeleteAction[];
  onLookupWord?: () => void;
}

export function SelectionAction({
  position,
  annotationType,
  onAnnotationTypeChange,
  selectedColor,
  onColorChange,
  onApply,
  noteLabel,
  onNote,
  existingAnnotationTypes = [],
  deleteActions,
  onLookupWord,
}: SelectionActionProps) {
  const [isDeleteExpanded, setIsDeleteExpanded] = useState(false);
  const colors = annotationType === 'underline' ? underlineColors : highlightColors;

  return (
    <div
      className="selection-action"
      role="toolbar"
      style={{ left: position.left, top: position.top }}
    >
      <div className="selection-primary-actions">
        {(['highlight', 'underline'] as const).map((type) => (
          <button
            aria-label={existingAnnotationTypes.includes(type)
              ? `${type === 'highlight' ? 'Highlight' : 'Underline'} already present`
              : undefined}
            aria-pressed={annotationType === type}
            className={annotationType === type ? 'is-selected' : ''}
            disabled={existingAnnotationTypes.includes(type)}
            key={type}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setIsDeleteExpanded(false);
              if (!existingAnnotationTypes.includes(type)) {
                onAnnotationTypeChange(type);
              }
            }}
          >
            {existingAnnotationTypes.includes(type)
              ? `${type === 'highlight' ? 'Highlight' : 'Underline'} added`
              : type === 'highlight' ? 'Highlight' : 'Underline'}
          </button>
        ))}
        {noteLabel && onNote ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onNote}
          >
            {noteLabel}
          </button>
        ) : null}
        {deleteActions.length > 0 ? (
          <button
            type="button"
            aria-expanded={deleteActions.length > 1 ? isDeleteExpanded : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (deleteActions.length === 1) deleteActions[0].onActivate();
              else {
                setIsDeleteExpanded((expanded) => !expanded);
              }
            }}
          >
            Delete
          </button>
        ) : null}
        {onLookupWord ? (
          <button
            className="dictionary-lookup-button"
            aria-label="Look up word"
            title="Look up word"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onLookupWord}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m15.3 15.3 5 5" />
            </svg>
          </button>
        ) : null}
      </div>
      {annotationType ? (
        <div className="selection-secondary-actions">
          <div
            className="highlight-colors"
            aria-label={`${annotationType} colour`}
            role="radiogroup"
          >
            {Object.entries(colors).map(([color, option]) => (
              <button
                aria-checked={selectedColor === color}
                aria-label={`${option.label} ${annotationType}`}
                className={`highlight-color-swatch ${selectedColor === color ? 'is-selected' : ''}`}
                key={color}
                role="radio"
                style={{ backgroundColor: option.cssValue }}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onColorChange(color as AnnotationColor)}
              />
            ))}
          </div>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onApply}
          >
            Apply
          </button>
        </div>
      ) : null}
      {deleteActions.length > 1 && isDeleteExpanded ? (
        <div className="selection-delete-actions" aria-label="Choose annotation to delete">
          {deleteActions.map((action) => (
            <button
              key={action.id}
              type="button"
              title={action.detail}
              onMouseDown={(event) => event.preventDefault()}
              onClick={action.onActivate}
            >
              {action.label}
              <span>{action.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
