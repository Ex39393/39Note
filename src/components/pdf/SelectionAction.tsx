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

interface SelectionActionProps {
  position: FloatingActionPosition;
  annotationType?: AnnotationType;
  onAnnotationTypeChange?: (type: AnnotationType) => void;
  selectedColor?: AnnotationColor;
  onColorChange?: (color: AnnotationColor) => void;
  onActivate?: () => void;
  onLookupWord?: () => void;
  actions?: Array<{ label: string; onActivate: () => void }>;
}

export function SelectionAction({
  position,
  annotationType = 'highlight',
  onAnnotationTypeChange,
  selectedColor,
  onColorChange,
  onActivate,
  onLookupWord,
  actions,
}: SelectionActionProps) {
  const colors = annotationType === 'highlight' ? highlightColors : underlineColors;

  return (
    <div
      className="selection-action"
      role="toolbar"
      style={{ left: position.left, top: position.top }}
    >
      {onAnnotationTypeChange ? (
        <div className="annotation-type-actions" aria-label="Annotation type">
          {(['highlight', 'underline'] as const).map((type) => (
            <button
              aria-pressed={annotationType === type}
              className={annotationType === type ? 'is-selected' : ''}
              key={type}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAnnotationTypeChange(type)}
            >
              {type === 'highlight' ? 'Highlight' : 'Underline'}
            </button>
          ))}
        </div>
      ) : null}
      {selectedColor && onColorChange ? (
        <>
          {actions && !onAnnotationTypeChange ? <span className="annotation-colour-label">Change colour</span> : null}
          <div className="highlight-colors" aria-label={`${annotationType} colour`} role="radiogroup">
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
        </>
      ) : null}
      {actions ? (
        actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={action.onActivate}
          >
            {action.label}
          </button>
        ))
      ) : (
        <>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onActivate}>
            Apply
          </button>
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
        </>
      )}
    </div>
  );
}
