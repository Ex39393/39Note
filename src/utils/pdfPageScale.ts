export type PdfFitMode = 'width' | 'page' | null;
export type PdfZoomDirection = 'in' | 'out';

const MANUAL_ZOOM_STEP_FACTOR = 1.2;
const MIN_MANUAL_ZOOM = 0.25;
const MAX_MANUAL_ZOOM = 5;

interface PdfPageScaleInput {
  fitMode: PdfFitMode;
  zoom: number;
  containerWidth: number;
  containerHeight: number;
  pageWidth: number;
  pageHeight: number;
}

export function calculatePdfPageScale({
  fitMode,
  zoom,
  containerWidth,
  containerHeight,
  pageWidth,
  pageHeight,
}: PdfPageScaleInput): number {
  if (fitMode === 'width') {
    // Fit Width is a geometric promise: even a narrow unobscured strip must
    // contain the whole page. Keep one renderable CSS pixel instead of using
    // the manual-zoom floor, which could make the fitted page overflow.
    return Math.max(containerWidth - 64, 1) / pageWidth;
  }
  if (fitMode === 'page') {
    const widthScale = (containerWidth - 64) / pageWidth;
    const heightScale = (containerHeight - 64) / pageHeight;
    return Math.max(Math.min(widthScale, heightScale), 0.25);
  }
  return zoom;
}

export function calculateManualZoomStep(
  effectiveZoom: number,
  direction: PdfZoomDirection,
): number {
  const nextZoom =
    direction === 'in'
      ? effectiveZoom * MANUAL_ZOOM_STEP_FACTOR
      : effectiveZoom / MANUAL_ZOOM_STEP_FACTOR;

  // Preserve the established manual limits without ever making a fit-derived
  // scale outside those limits move in the opposite direction.
  if (direction === 'in') {
    return effectiveZoom <= MAX_MANUAL_ZOOM
      ? Math.min(nextZoom, MAX_MANUAL_ZOOM)
      : nextZoom;
  }
  return effectiveZoom >= MIN_MANUAL_ZOOM
    ? Math.max(nextZoom, MIN_MANUAL_ZOOM)
    : nextZoom;
}
