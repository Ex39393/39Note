export const COMPACT_READER_MEDIA_QUERY =
  '(max-width: 900px), (pointer: coarse) and (max-width: 1180px)';

export type ReaderLayoutMode = 'compact' | 'docked';

export interface ReaderLayoutEnvironment {
  width: number;
  coarsePointer: boolean;
}

export interface ViewportBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FloatingSurfaceSize {
  width: number;
  height: number;
}

export interface FloatingSurfacePosition {
  left: number;
  top: number;
}

export function getReaderLayoutMode({
  width,
  coarsePointer,
}: ReaderLayoutEnvironment): ReaderLayoutMode {
  return width <= 900 || (coarsePointer && width <= 1180) ? 'compact' : 'docked';
}

export function getVisualViewportBounds(targetWindow: Window = window): ViewportBounds {
  const viewport = targetWindow.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? targetWindow.innerWidth;
  const height = viewport?.height ?? targetWindow.innerHeight;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

export function clampFloatingSurfaceToViewport(
  position: FloatingSurfacePosition,
  size: FloatingSurfaceSize,
  viewport: ViewportBounds,
  margin = 8,
): FloatingSurfacePosition {
  const minimumLeft = viewport.left + margin;
  const minimumTop = viewport.top + margin;
  const maximumLeft = Math.max(minimumLeft, viewport.right - size.width - margin);
  const maximumTop = Math.max(minimumTop, viewport.bottom - size.height - margin);
  return {
    left: clamp(position.left, minimumLeft, maximumLeft),
    top: clamp(position.top, minimumTop, maximumTop),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
