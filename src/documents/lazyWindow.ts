export interface LazyWindow {
  readonly start: number;
  readonly end: number;
}

export interface LazyWindowOptions {
  readonly overscanBefore?: number;
  readonly overscanAfter?: number;
}

/**
 * Returns an end-exclusive render window. The helper is deliberately renderer
 * agnostic so slide and reflow views can share the same bounded policy.
 */
export function createLazyWindow(
  itemCount: number,
  visibleStart: number,
  visibleEnd: number,
  options: LazyWindowOptions = {},
): LazyWindow {
  const safeCount = toNonNegativeInteger(itemCount);
  if (safeCount === 0) return { start: 0, end: 0 };

  const firstVisible = clamp(toNonNegativeInteger(visibleStart), 0, safeCount - 1);
  const lastVisibleExclusive = clamp(
    Math.max(firstVisible + 1, toNonNegativeInteger(visibleEnd)),
    firstVisible + 1,
    safeCount,
  );
  const overscanBefore = toNonNegativeInteger(options.overscanBefore ?? 2);
  const overscanAfter = toNonNegativeInteger(options.overscanAfter ?? 3);

  return {
    start: Math.max(0, firstVisible - overscanBefore),
    end: Math.min(safeCount, lastVisibleExclusive + overscanAfter),
  };
}

export function isInLazyWindow(index: number, window: LazyWindow): boolean {
  return Number.isInteger(index) && index >= window.start && index < window.end;
}

export function lazyWindowIndices(window: LazyWindow): number[] {
  const indices: number[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    indices.push(index);
  }
  return indices;
}

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
