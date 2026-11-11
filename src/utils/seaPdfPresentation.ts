export const SEA_PDF_SAMPLE_SIZE = 40;
export const SEA_PDF_MAX_IMAGE_COVERAGE = 0.35;
export const SEA_PDF_MIN_PHOTO_COVERAGE = 0.15;
export const SEA_PDF_MAX_PHOTO_MIDTONE_RATIO = 0.2;
export const SEA_PDF_MAX_COLORFUL_PIXEL_RATIO = 0.055;
export const SEA_PDF_PAGE_BACKGROUND = '#10263F';
export const SEA_PDF_PAGE_FOREGROUND = '#D7E8F5';

export const SEA_PDF_PAGE_COLORS = Object.freeze({
  background: SEA_PDF_PAGE_BACKGROUND,
  foreground: SEA_PDF_PAGE_FOREGROUND,
});

const SEA_PDF_MIN_AVERAGE_LUMINANCE = 180;
const SEA_PDF_MIN_LIGHT_PIXEL_RATIO = 0.5;
const SEA_PDF_MAX_DARK_PIXEL_RATIO = 0.38;
const SEA_PDF_MIN_CONTEXTUAL_AVERAGE_LUMINANCE = 135;
const SEA_PDF_MIN_CONTEXTUAL_LIGHT_PIXEL_RATIO = 0.32;
const SEA_PDF_MAX_CONTEXTUAL_DARK_PIXEL_RATIO = 0.48;
// A few downsampled chromatic fringes can be produced by browser/PDF font
// antialiasing even for black text. Require saturated chroma across a small,
// meaningful region rather than counting raw RGB channel spread.
const SEA_PDF_MIN_COLOR_CHROMA = 70;
const SEA_PDF_MIN_COLOR_SATURATION = 0.35;

export type SeaPdfPresentation = 'dark' | 'preserve';
export type SeaPdfPresentationReason =
  | 'already-dark-or-mixed'
  | 'color-rich'
  | 'document-coherent-academic'
  | 'document-context-required'
  | 'image-rich'
  | 'light-monochrome'
  | 'unavailable';

export interface SeaPdfPresentationDecision {
  presentation: SeaPdfPresentation;
  reason: SeaPdfPresentationReason;
}

export interface SeaPdfSampleSummary {
  averageLuminance: number;
  colorfulPixelRatio: number;
  darkPixelRatio: number;
  lightPixelRatio: number;
}

export interface SeaPdfPresentationInput extends SeaPdfSampleSummary {
  imageCoverage: number;
}

export type SeaPdfPageDecisionRecord = Readonly<
  Record<number, SeaPdfPresentationDecision>
>;

export function getSeaPdfPageColors(
  themeId: string,
  presentation: SeaPdfPresentation | 'pending',
): typeof SEA_PDF_PAGE_COLORS | undefined {
  return themeId === 'sea' && presentation === 'dark' ? SEA_PDF_PAGE_COLORS : undefined;
}

/**
 * PDF.js reports each raster image as three normalized points. Their cross
 * product is the image parallelogram's page-area share. Overlap is clamped;
 * this is a conservative signal, not a page-content reconstruction.
 */
export function estimatePdfImageCoverage(
  coordinates: ArrayLike<number> | null | undefined,
): number {
  if (!coordinates || coordinates.length < 6) return 0;

  let coverage = 0;
  for (let index = 0; index + 5 < coordinates.length; index += 6) {
    const x0 = Number(coordinates[index]);
    const y0 = Number(coordinates[index + 1]);
    const x1 = Number(coordinates[index + 2]);
    const y1 = Number(coordinates[index + 3]);
    const x2 = Number(coordinates[index + 4]);
    const y2 = Number(coordinates[index + 5]);
    const values = [x0, y0, x1, y1, x2, y2];
    if (!values.every(Number.isFinite)) continue;

    coverage += Math.abs((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0));
  }

  return Math.min(1, coverage);
}

export function summarizeSeaPdfPixels(
  pixels: Uint8ClampedArray,
): SeaPdfSampleSummary | null {
  if (pixels.length < 4 || pixels.length % 4 !== 0) return null;

  let luminanceTotal = 0;
  let colorfulPixels = 0;
  let darkPixels = 0;
  let lightPixels = 0;
  const pixelCount = pixels.length / 4;

  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceTotal += luminance;
    if (luminance <= 70) darkPixels += 1;
    if (luminance >= 210) lightPixels += 1;
    const maximumChannel = Math.max(red, green, blue);
    const chroma = maximumChannel - Math.min(red, green, blue);
    if (
      maximumChannel >= 100 &&
      chroma >= SEA_PDF_MIN_COLOR_CHROMA &&
      chroma / maximumChannel >= SEA_PDF_MIN_COLOR_SATURATION
    ) {
      colorfulPixels += 1;
    }
  }

  return {
    averageLuminance: luminanceTotal / pixelCount,
    colorfulPixelRatio: colorfulPixels / pixelCount,
    darkPixelRatio: darkPixels / pixelCount,
    lightPixelRatio: lightPixels / pixelCount,
  };
}

export function classifySeaPdfPresentation({
  averageLuminance,
  colorfulPixelRatio,
  darkPixelRatio,
  imageCoverage,
  lightPixelRatio,
}: SeaPdfPresentationInput): SeaPdfPresentation {
  return decideSeaPdfPresentation({
    averageLuminance,
    colorfulPixelRatio,
    darkPixelRatio,
    imageCoverage,
    lightPixelRatio,
  }).presentation;
}

export function decideSeaPdfPresentation({
  averageLuminance,
  colorfulPixelRatio,
  darkPixelRatio,
  imageCoverage,
  lightPixelRatio,
}: SeaPdfPresentationInput): SeaPdfPresentationDecision {
  const midtonePixelRatio = Math.max(0, 1 - darkPixelRatio - lightPixelRatio);
  const hasPhotographicTones =
    imageCoverage >= SEA_PDF_MIN_PHOTO_COVERAGE &&
    midtonePixelRatio > SEA_PDF_MAX_PHOTO_MIDTONE_RATIO;

  if (imageCoverage >= SEA_PDF_MAX_IMAGE_COVERAGE || hasPhotographicTones) {
    return { presentation: 'preserve', reason: 'image-rich' };
  }
  if (colorfulPixelRatio > SEA_PDF_MAX_COLORFUL_PIXEL_RATIO) {
    return { presentation: 'preserve', reason: 'color-rich' };
  }
  if (
    averageLuminance >= SEA_PDF_MIN_AVERAGE_LUMINANCE &&
    lightPixelRatio >= SEA_PDF_MIN_LIGHT_PIXEL_RATIO &&
    darkPixelRatio <= SEA_PDF_MAX_DARK_PIXEL_RATIO
  ) {
    return { presentation: 'dark', reason: 'light-monochrome' };
  }
  if (
    averageLuminance >= SEA_PDF_MIN_CONTEXTUAL_AVERAGE_LUMINANCE &&
    lightPixelRatio >= SEA_PDF_MIN_CONTEXTUAL_LIGHT_PIXEL_RATIO &&
    darkPixelRatio <= SEA_PDF_MAX_CONTEXTUAL_DARK_PIXEL_RATIO
  ) {
    return { presentation: 'preserve', reason: 'document-context-required' };
  }
  return { presentation: 'preserve', reason: 'already-dark-or-mixed' };
}

/**
 * Resolves only borderline academic pages using sibling evidence. Hard safety
 * exclusions (images, meaningful colour, dark sources, or unavailable samples)
 * are never promoted. Two borderline pages (or the only page in a one-page
 * document) are sufficient evidence for a consistently light academic document
 * even when no page clears every conservative page-local threshold.
 */
export function resolveSeaPdfDocumentPresentations(
  decisions: SeaPdfPageDecisionRecord,
  totalPageCount?: number,
): Record<number, SeaPdfPresentationDecision> {
  const entries = Object.entries(decisions);
  const contextualCount = entries.filter(
    ([, decision]) => decision.reason === 'document-context-required',
  ).length;
  const hasOrdinaryAcademicPage = entries.some(
    ([, decision]) => decision.presentation === 'dark',
  );
  const useAcademicDocumentPolicy =
    hasOrdinaryAcademicPage ||
    contextualCount >= 2 ||
    (totalPageCount === 1 && contextualCount === 1);

  return Object.fromEntries(
    entries.map(([pageNumber, decision]) => [
      pageNumber,
      useAcademicDocumentPolicy && decision.reason === 'document-context-required'
        ? {
            presentation: 'dark' as const,
            reason: 'document-coherent-academic' as const,
          }
        : decision,
    ]),
  );
}

/**
 * Samples at most 1,600 pixels once per rendered PDF page. Failure is deliberately
 * fail-closed: source presentation is retained instead of risking distortion.
 */
export function classifySeaPdfCanvas(
  canvas: HTMLCanvasElement,
  imageCoordinates: ArrayLike<number> | null | undefined,
): SeaPdfPresentation {
  return inspectSeaPdfCanvas(canvas, imageCoordinates).presentation;
}

export function inspectSeaPdfCanvas(
  canvas: HTMLCanvasElement,
  imageCoordinates: ArrayLike<number> | null | undefined,
): SeaPdfPresentationDecision {
  try {
    const sampleCanvas = window.document.createElement('canvas');
    sampleCanvas.width = SEA_PDF_SAMPLE_SIZE;
    sampleCanvas.height = SEA_PDF_SAMPLE_SIZE;
    const context = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { presentation: 'preserve', reason: 'unavailable' };
    }

    context.drawImage(canvas, 0, 0, SEA_PDF_SAMPLE_SIZE, SEA_PDF_SAMPLE_SIZE);
    const summary = summarizeSeaPdfPixels(
      context.getImageData(0, 0, SEA_PDF_SAMPLE_SIZE, SEA_PDF_SAMPLE_SIZE).data,
    );
    if (!summary) {
      return { presentation: 'preserve', reason: 'unavailable' };
    }

    const imageCoverage = estimatePdfImageCoverage(imageCoordinates);
    return decideSeaPdfPresentation({ ...summary, imageCoverage });
  } catch {
    return { presentation: 'preserve', reason: 'unavailable' };
  }
}
