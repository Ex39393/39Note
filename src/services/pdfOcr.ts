import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfOcrPageResult, PdfOcrProgress } from '../types/pdfOcr.ts';
import { PdfOcrError } from '../types/pdfOcr.ts';
import { createPdfOcrPageResult, type RawPdfOcrBlock } from '../utils/pdfOcr.ts';
import {
  classifyPdfTextItems,
  hasRecordedPdfImage,
} from '../utils/pdfTextAvailability.ts';

const MAX_OCR_PIXELS = 4_000_000;
const MAX_OCR_DIMENSION = 2_600;
const DESIRED_OCR_SCALE = 2;
const OCR_HARD_TIMEOUT_MS = 90_000;
const ELIGIBILITY_RENDER_MAX_DIMENSION = 480;

type ProgressListener = (progress: PdfOcrProgress) => void;
type TesseractWorker = Awaited<ReturnType<typeof createTesseractWorker>>;

let workerGeneration = 0;
let workerPromise: Promise<TesseractWorker> | null = null;
let workerInstance: TesseractWorker | null = null;
let activeProgressListener: ProgressListener | null = null;
let activeJobToken: symbol | null = null;

export type PdfOcrPageEligibility = 'image-only' | 'native-text' | 'no-selectable-text';

export async function inspectPdfPageOcrEligibility(
  document: PDFDocumentProxy,
  pageNumber: number,
  signal: AbortSignal,
): Promise<PdfOcrPageEligibility> {
  if (signal.aborted) throw cancelledError();

  let page: PDFPageProxy;
  try {
    page = await raceWithAbort(document.getPage(pageNumber), signal);
    const textContent = await raceWithAbort(
      page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      }),
      signal,
    );
    if (classifyPdfTextItems(textContent.items) === 'selectable') {
      return 'native-text';
    }
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    if (error instanceof PdfOcrError) throw error;
    throw new PdfOcrError(
      'render-failed',
      error instanceof Error
        ? error.message
        : 'This page could not be inspected for local OCR.',
    );
  }

  if (hasRecordedPdfImage(page.imageCoordinates)) return 'image-only';

  const baseViewport = page.getViewport({ scale: 1 });
  const inspectionScale = Math.max(
    0.05,
    Math.min(
      0.5,
      ELIGIBILITY_RENDER_MAX_DIMENSION /
        Math.max(baseViewport.width, baseViewport.height, 1),
    ),
  );
  const viewport = page.getViewport({ scale: inspectionScale });
  const canvas = documentOwnerCanvas();
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new PdfOcrError(
      'render-failed',
      'A local OCR inspection canvas is unavailable.',
    );
  }

  const renderTask = page.render({
    canvas,
    canvasContext: context,
    viewport,
    recordImages: true,
  });
  const cancelRender = () => renderTask.cancel();
  signal.addEventListener('abort', cancelRender, { once: true });
  try {
    await raceWithAbort(renderTask.promise, signal);
    return hasRecordedPdfImage(page.imageCoordinates)
      ? 'image-only'
      : 'no-selectable-text';
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    throw new PdfOcrError(
      'render-failed',
      error instanceof Error
        ? error.message
        : 'This page could not be inspected for local OCR.',
    );
  } finally {
    signal.removeEventListener('abort', cancelRender);
    canvas.width = 1;
    canvas.height = 1;
  }
}

export async function recognizePdfPageLocally(
  document: PDFDocumentProxy,
  pageNumber: number,
  options: { signal: AbortSignal; onProgress?: ProgressListener },
): Promise<PdfOcrPageResult> {
  if (activeJobToken) {
    throw new PdfOcrError('busy', 'Another page is already being recognized.');
  }
  if (options.signal.aborted) throw cancelledError();

  const operationController = new AbortController();
  const forwardCancellation = () => operationController.abort(cancelledError());
  options.signal.addEventListener('abort', forwardCancellation, { once: true });
  const timeoutId = setTimeout(
    () =>
      operationController.abort(
        new PdfOcrError('timeout', 'Local OCR exceeded its safety deadline.'),
      ),
    OCR_HARD_TIMEOUT_MS,
  );
  const operationSignal = operationController.signal;
  const jobToken = Symbol(`pdf-ocr-${pageNumber}`);
  activeJobToken = jobToken;
  activeProgressListener = options.onProgress ?? null;
  const abortWorker = () => void resetPdfOcrWorker();
  operationSignal.addEventListener('abort', abortWorker, { once: true });

  try {
    reportProgress('preparing-page', 0.02);
    const rendered = await raceWithAbort(
      renderPageForOcr(document, pageNumber, operationSignal),
      operationSignal,
    );
    reportProgress('loading-engine', 0.12);
    const worker = await raceWithAbort(getPdfOcrWorker(), operationSignal);
    reportProgress('recognizing-text', 0.35);
    const recognition = await raceWithAbort(
      worker.recognize(rendered.canvas, {}, { text: true, blocks: true }),
      operationSignal,
    );
    reportProgress('recognizing-text', 1);
    return createPdfOcrPageResult({
      pageNumber,
      imageWidth: rendered.canvas.width,
      imageHeight: rendered.canvas.height,
      blocks: recognition.data.blocks as RawPdfOcrBlock[] | null,
    });
  } catch (error) {
    if (operationSignal.aborted) {
      throw operationSignal.reason instanceof PdfOcrError
        ? operationSignal.reason
        : cancelledError();
    }
    if (error instanceof PdfOcrError) {
      if (error.code !== 'cancelled') await resetPdfOcrWorker();
      throw error;
    }
    await resetPdfOcrWorker();
    throw new PdfOcrError(
      'recognition-failed',
      error instanceof Error ? error.message : 'Local OCR failed.',
    );
  } finally {
    clearTimeout(timeoutId);
    options.signal.removeEventListener('abort', forwardCancellation);
    operationSignal.removeEventListener('abort', abortWorker);
    if (activeJobToken === jobToken) {
      activeJobToken = null;
      activeProgressListener = null;
    }
  }
}

export async function terminateLocalPdfOcrWorker(): Promise<void> {
  await resetPdfOcrWorker();
}

async function renderPageForOcr(
  document: PDFDocumentProxy,
  pageNumber: number,
  signal: AbortSignal,
): Promise<{ canvas: HTMLCanvasElement }> {
  let page: PDFPageProxy;
  try {
    page = await document.getPage(pageNumber);
  } catch {
    throw new PdfOcrError('render-failed', 'The PDF page could not be prepared.');
  }
  if (signal.aborted) throw cancelledError();

  const baseViewport = page.getViewport({ scale: 1 });
  const pixelScale = Math.sqrt(
    MAX_OCR_PIXELS / Math.max(1, baseViewport.width * baseViewport.height),
  );
  const dimensionScale = Math.min(
    MAX_OCR_DIMENSION / Math.max(1, baseViewport.width),
    MAX_OCR_DIMENSION / Math.max(1, baseViewport.height),
  );
  const scale = Math.max(0.1, Math.min(DESIRED_OCR_SCALE, pixelScale, dimensionScale));
  const viewport = page.getViewport({ scale });
  const canvas = documentOwnerCanvas();
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new PdfOcrError('render-failed', 'A local OCR canvas is unavailable.');
  }
  context.imageSmoothingEnabled = true;
  const renderTask = page.render({ canvas, canvasContext: context, viewport });
  const cancelRender = () => renderTask.cancel();
  signal.addEventListener('abort', cancelRender, { once: true });
  try {
    await renderTask.promise;
    return { canvas };
  } catch (error) {
    if (signal.aborted) throw cancelledError();
    throw new PdfOcrError(
      'render-failed',
      error instanceof Error ? error.message : 'The PDF page could not render for OCR.',
    );
  } finally {
    signal.removeEventListener('abort', cancelRender);
  }
}

async function getPdfOcrWorker(): Promise<TesseractWorker> {
  if (workerInstance) return workerInstance;
  if (!workerPromise) {
    const generation = workerGeneration;
    workerPromise = createTesseractWorker()
      .then(async (worker) => {
        if (generation !== workerGeneration) {
          await worker.terminate();
          throw cancelledError();
        }
        workerInstance = worker;
        return worker;
      })
      .catch((error: unknown) => {
        if (error instanceof PdfOcrError) throw error;
        throw new PdfOcrError(
          'engine-unavailable',
          error instanceof Error ? error.message : 'The local OCR engine failed.',
        );
      });
  }
  return workerPromise;
}

async function createTesseractWorker() {
  const [{ createWorker, OEM }, { getLocalPdfOcrAssets }] = await Promise.all([
    import('tesseract.js'),
    import('./pdfOcrAssets.ts'),
  ]);
  const assets = getLocalPdfOcrAssets();
  return createWorker('eng', OEM.LSTM_ONLY, {
    ...assets,
    cacheMethod: 'none',
    workerBlobURL: false,
    gzip: true,
    logger(message) {
      const status = message.status.toLocaleLowerCase();
      if (status.includes('language')) {
        reportProgress('loading-language', 0.16 + message.progress * 0.14);
      } else if (status.includes('recogn')) {
        reportProgress('recognizing-text', 0.35 + message.progress * 0.65);
      } else {
        reportProgress('loading-engine', 0.12 + message.progress * 0.12);
      }
    },
    errorHandler() {
      // The rejected worker promise is normalized at the operation boundary.
    },
  });
}

async function resetPdfOcrWorker(): Promise<void> {
  workerGeneration += 1;
  const pendingWorker = workerPromise;
  const liveWorker = workerInstance;
  workerPromise = null;
  workerInstance = null;
  if (liveWorker) {
    await liveWorker.terminate().catch(() => undefined);
  } else if (pendingWorker) {
    void pendingWorker.then((worker) => worker.terminate()).catch(() => undefined);
  }
}

function reportProgress(phase: PdfOcrProgress['phase'], progress: number): void {
  activeProgressListener?.({ phase, progress: clamp(progress, 0, 1) });
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abortListener: (() => void) | null = null;
  const boundary = new Promise<never>((_, reject) => {
    abortListener = () =>
      reject(signal.reason instanceof PdfOcrError ? signal.reason : cancelledError());
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    if (signal.aborted) {
      throw signal.reason instanceof PdfOcrError ? signal.reason : cancelledError();
    }
    return await Promise.race([operation, boundary]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    void operation.catch(() => undefined);
  }
}

function documentOwnerCanvas(): HTMLCanvasElement {
  if (typeof document === 'undefined') {
    throw new PdfOcrError('engine-unavailable', 'Local OCR requires a browser.');
  }
  return document.createElement('canvas');
}

function cancelledError(): PdfOcrError {
  return new PdfOcrError('cancelled', 'Local OCR was cancelled.');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
