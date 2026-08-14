import type { NormalizedHighlightRectangle } from '../types/highlight';

export interface DefinitionBubblePosition {
  left: number;
  top: number;
}

export interface DefinitionBubbleSize {
  width: number;
  height: number;
}

export interface NormalizedDefinitionBubblePosition {
  x: number;
  y: number;
}

const BUBBLE_MARGIN = 10;
const INITIAL_BUBBLE_HEIGHT = 208;

export function getDefinitionBubbleWidth(pageWidth: number): number {
  const availableWidth = Math.max(0, pageWidth - BUBBLE_MARGIN * 2);
  return Math.min(286, availableWidth);
}

export function getAnchoredDefinitionBubblePosition(
  anchor: NormalizedHighlightRectangle | undefined,
  pageSize: DefinitionBubbleSize,
  bubbleSize: DefinitionBubbleSize,
): DefinitionBubblePosition {
  const anchorLeft = (anchor?.x ?? 0.5) * pageSize.width;
  const anchorTop = (anchor?.y ?? 0.5) * pageSize.height;
  const anchorBottom =
    ((anchor?.y ?? 0.5) + (anchor?.height ?? 0)) * pageSize.height;
  const placeAbove =
    anchorBottom + 210 > pageSize.height && anchorTop > 220;

  return clampDefinitionBubblePosition(
    {
      left: anchorLeft,
      top: placeAbove
        ? anchorTop - INITIAL_BUBBLE_HEIGHT
        : anchorBottom + BUBBLE_MARGIN,
    },
    pageSize,
    bubbleSize,
  );
}

export function clampDefinitionBubblePosition(
  position: DefinitionBubblePosition,
  pageSize: DefinitionBubbleSize,
  bubbleSize: DefinitionBubbleSize,
): DefinitionBubblePosition {
  const maxLeft = Math.max(BUBBLE_MARGIN, pageSize.width - bubbleSize.width - BUBBLE_MARGIN);
  const maxTop = Math.max(BUBBLE_MARGIN, pageSize.height - bubbleSize.height - BUBBLE_MARGIN);
  return {
    left: clamp(position.left, BUBBLE_MARGIN, maxLeft),
    top: clamp(position.top, BUBBLE_MARGIN, maxTop),
  };
}

export function normalizeDefinitionBubblePosition(
  position: DefinitionBubblePosition,
  pageSize: DefinitionBubbleSize,
): NormalizedDefinitionBubblePosition {
  return {
    x: pageSize.width > 0 ? position.left / pageSize.width : 0,
    y: pageSize.height > 0 ? position.top / pageSize.height : 0,
  };
}

export function resolveManualDefinitionBubblePosition(
  position: NormalizedDefinitionBubblePosition,
  pageSize: DefinitionBubbleSize,
  bubbleSize: DefinitionBubbleSize,
): DefinitionBubblePosition {
  return clampDefinitionBubblePosition(
    { left: position.x * pageSize.width, top: position.y * pageSize.height },
    pageSize,
    bubbleSize,
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
