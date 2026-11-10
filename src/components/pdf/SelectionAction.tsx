import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getAnnotationColorLabel,
  getHighlightColorCssValue,
  getUnderlineColorCssValue,
  normalizeOpaqueHexColor,
  type AnnotationType,
  type HighlightColor,
  type UnderlineColor,
} from '../../types/highlight';
import {
  clampFloatingSurfaceToViewport,
  getVisualViewportBounds,
} from '../../utils/responsiveLayout';

interface FloatingActionPosition {
  left: number;
  top: number;
}

type AnnotationColor = HighlightColor | UnderlineColor;
export type SelectionActionMode = AnnotationType | 'link';

export interface ConnectableLinkOption {
  id: string;
  visibleNumber: number;
  name?: string;
  sourceSnippet: string;
}

interface SelectionActionProps {
  position: FloatingActionPosition;
  annotationType: SelectionActionMode | null;
  onAnnotationTypeChange: (type: SelectionActionMode) => void;
  selectedColor: AnnotationColor;
  colorPalette: readonly AnnotationColor[];
  onColorChange: (color: AnnotationColor) => void;
  onCustomColor: (color: string) => void;
  onResetPalette: () => void;
  onApply: () => void;
  existingAnnotationTypes?: readonly AnnotationType[];
  onLookupWord?: () => void;
  connectableLinks?: readonly ConnectableLinkOption[];
  onCreateLink?: () => void;
  onConnectLink?: (linkId: string) => void;
  linkDisabledReason?: string;
}

export function SelectionAction({
  position,
  annotationType,
  onAnnotationTypeChange,
  selectedColor,
  colorPalette,
  onColorChange,
  onCustomColor,
  onResetPalette,
  onApply,
  existingAnnotationTypes = [],
  onLookupWord,
  connectableLinks = [],
  onCreateLink,
  onConnectLink,
  linkDisabledReason,
}: SelectionActionProps) {
  const [isConnectChooserOpen, setIsConnectChooserOpen] = useState(false);
  const [resolvedPosition, setResolvedPosition] = useState(position);
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (annotationType !== 'link') setIsConnectChooserOpen(false);
  }, [annotationType]);

  const positionLeft = position.left;
  const positionTop = position.top;

  useLayoutEffect(() => {
    const element = actionRef.current;
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
      resizeObserver.disconnect();
      window.removeEventListener('resize', placeInsideViewport);
      window.visualViewport?.removeEventListener('resize', placeInsideViewport);
      window.visualViewport?.removeEventListener('scroll', placeInsideViewport);
    };
  }, [positionLeft, positionTop]);

  return (
    <div
      ref={actionRef}
      className="selection-action"
      role="toolbar"
      style={{ left: resolvedPosition.left, top: resolvedPosition.top }}
    >
      <div className="selection-primary-actions">
        {(['highlight', 'underline'] as const).map((type) => (
          <button
            aria-label={
              existingAnnotationTypes.includes(type)
                ? `${type === 'highlight' ? 'Highlight' : 'Underline'} already present`
                : undefined
            }
            aria-pressed={annotationType === type}
            className={annotationType === type ? 'is-selected' : ''}
            disabled={existingAnnotationTypes.includes(type)}
            key={type}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!existingAnnotationTypes.includes(type)) {
                onAnnotationTypeChange(type);
              }
            }}
          >
            {existingAnnotationTypes.includes(type)
              ? `${type === 'highlight' ? 'Highlight' : 'Underline'} added`
              : type === 'highlight'
                ? 'Highlight'
                : 'Underline'}
          </button>
        ))}
        {(onCreateLink && onConnectLink) || linkDisabledReason ? (
          <button
            aria-label={linkDisabledReason ?? undefined}
            aria-pressed={annotationType === 'link'}
            className={annotationType === 'link' ? 'is-selected' : ''}
            disabled={Boolean(linkDisabledReason)}
            title={linkDisabledReason}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!linkDisabledReason) {
                setIsConnectChooserOpen(false);
                onAnnotationTypeChange('link');
              }
            }}
          >
            Link
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
      {annotationType === 'link' ? (
        <div className="selection-link-actions" aria-label="Link choices">
          <div className="selection-link-choice-row">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onCreateLink}
            >
              Create new Link
            </button>
            <button
              aria-expanded={isConnectChooserOpen}
              disabled={connectableLinks.length === 0}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setIsConnectChooserOpen((current) => !current)}
            >
              Connect to existing Link
            </button>
          </div>
          {connectableLinks.length === 0 ? (
            <small>No unpaired Links in this paper.</small>
          ) : isConnectChooserOpen ? (
            <ul className="selection-link-chooser" aria-label="Unpaired Links">
              {connectableLinks.map((link) => (
                <li key={link.id}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onConnectLink?.(link.id)}
                  >
                    <strong>Link {link.visibleNumber}</strong>
                    {link.name?.trim() &&
                    link.name.trim() !== `Link ${link.visibleNumber}` ? (
                      <span className="selection-link-name">{link.name.trim()}</span>
                    ) : null}
                    <span>{link.sourceSnippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : annotationType ? (
        <div className="selection-secondary-actions">
          <div
            className="highlight-colors"
            aria-label={`${annotationType} colour`}
            role="radiogroup"
          >
            {colorPalette.map((color) => (
              <button
                aria-checked={selectedColor === color}
                aria-label={`${getAnnotationColorLabel(annotationType, color)} ${annotationType}`}
                className={`highlight-color-swatch ${selectedColor === color ? 'is-selected' : ''}`}
                key={color}
                role="radio"
                style={{
                  backgroundColor:
                    annotationType === 'highlight'
                      ? getHighlightColorCssValue(color as HighlightColor)
                      : getUnderlineColorCssValue(color as UnderlineColor),
                }}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onColorChange(color)}
              />
            ))}
            <label
              aria-label={`Choose custom ${annotationType} colour`}
              className="highlight-color-picker"
              title={`Choose custom ${annotationType} colour`}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span aria-hidden="true" />
              <input
                aria-label={`Custom ${annotationType} colour`}
                type="color"
                value={
                  normalizeOpaqueHexColor(selectedColor) ??
                  (annotationType === 'highlight' ? '#FFE600' : '#1687FF')
                }
                onChange={(event) => onCustomColor(event.target.value)}
              />
            </label>
          </div>
          <button
            className="selection-reset-colours"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onResetPalette}
          >
            Reset default colours
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onApply}
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
