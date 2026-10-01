export type ReaderOcclusionEdge = 'left' | 'right';

export interface ReaderOccluderMeasurement {
  edge: ReaderOcclusionEdge;
  width: number;
  active: boolean;
}

export interface ReaderOcclusionInsets {
  left: number;
  right: number;
}

export interface HorizontalBounds {
  left: number;
  right: number;
}

export const EMPTY_READER_OCCLUSION_INSETS: ReaderOcclusionInsets = {
  left: 0,
  right: 0,
};

/**
 * Returns the portion of the Reader covered from each horizontal edge.
 * Drawers on the same edge overlap one another, so the largest active width is
 * the real occlusion. Opposite-edge drawers can coexist and are both retained.
 */
export function deriveReaderOcclusionInsets(
  measurements: readonly ReaderOccluderMeasurement[],
): ReaderOcclusionInsets {
  return measurements.reduce<ReaderOcclusionInsets>((insets, measurement) => {
    if (!measurement.active || !Number.isFinite(measurement.width)) {
      return insets;
    }

    const width = Math.max(0, measurement.width);
    return measurement.edge === 'left'
      ? { ...insets, left: Math.max(insets.left, width) }
      : { ...insets, right: Math.max(insets.right, width) };
  }, EMPTY_READER_OCCLUSION_INSETS);
}

export function areReaderOcclusionInsetsEqual(
  first: ReaderOcclusionInsets,
  second: ReaderOcclusionInsets,
): boolean {
  return first.left === second.left && first.right === second.right;
}

export function measureReaderEdgeOverlap(
  edge: ReaderOcclusionEdge,
  occluderWidth: number,
  layoutBounds: HorizontalBounds,
  readerBounds: HorizontalBounds,
): number {
  const width = Math.max(0, occluderWidth);
  const occluderLeft = edge === 'left' ? layoutBounds.left : layoutBounds.right - width;
  const occluderRight = occluderLeft + width;
  return Math.max(
    0,
    Math.min(readerBounds.right, occluderRight) -
      Math.max(readerBounds.left, occluderLeft),
  );
}
