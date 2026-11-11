import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PdfPage } from '../../src/components/pdf/PdfPage.tsx';
import { ThemeProvider } from '../../src/components/ThemeProvider.tsx';
import { usePdfOcr } from '../../src/hooks/usePdfOcr.ts';
import type { PdfOcrPageResult } from '../../src/types/pdfOcr.ts';
import { createHighlightsFromSelections } from '../../src/utils/highlights.ts';
import { findPdfSearchResults } from '../../src/utils/pdfSearch.ts';
import { getPdfTextSelections } from '../../src/utils/textSelection.ts';
import '../../src/styles/index.css';
import './pdfTextAvailabilityBrowser.css';

GlobalWorkerOptions.workerSrc = pdfWorker;

declare global {
  var __39notePdfTextAvailabilityFixture:
    | {
        failures: string[];
        remoteMutations: number;
      }
    | undefined;
}

globalThis.__39notePdfTextAvailabilityFixture = {
  failures: [],
  remoteMutations: 0,
};

let latestOcrResult: PdfOcrPageResult | null = null;

export function BrowserFixture() {
  const [documents, setDocuments] = useState<{
    imageOnly: PDFDocumentProxy;
    selectable: PDFDocumentProxy;
  } | null>(null);
  const [result, setResult] = useState<'RUNNING' | 'PASS' | 'FAIL'>('RUNNING');
  const [details, setDetails] = useState('Building synthetic PDFs…');

  useEffect(() => {
    let disposed = false;
    let loadedDocuments: PDFDocumentProxy[] = [];
    void createSyntheticDocuments()
      .then((nextDocuments) => {
        loadedDocuments = [nextDocuments.imageOnly, nextDocuments.selectable];
        if (!disposed) setDocuments(nextDocuments);
      })
      .catch((error: unknown) => finishWithError(error, setResult, setDetails));
    return () => {
      disposed = true;
      loadedDocuments.forEach((document) => void document.destroy());
    };
  }, []);

  useEffect(() => {
    if (!documents || result !== 'RUNNING') return;
    let disposed = false;
    void runChecks()
      .then(() => {
        if (disposed) return;
        setResult('PASS');
        setDetails('Image-only and selectable-text pages were distinguished.');
      })
      .catch((error: unknown) => finishWithError(error, setResult, setDetails));
    return () => {
      disposed = true;
    };
  }, [documents, result]);

  return (
    <ThemeProvider>
      <main className="pdf-text-availability-fixture">
        {documents ? (
          <>
            <section data-testid="image-only-page">
              <h1>Image-only synthetic page</h1>
              <SyntheticPdfPage document={documents.imageOnly} />
            </section>
            <section data-testid="selectable-page">
              <h1>Selectable synthetic page</h1>
              <SyntheticPdfPage document={documents.selectable} />
            </section>
          </>
        ) : null}
        <p className="visually-hidden" id="summary" data-text-result={result}>
          {result}
        </p>
        <pre className="visually-hidden" id="details">
          {details}
        </pre>
      </main>
    </ThemeProvider>
  );
}

export function SyntheticPdfPage({ document }: { document: PDFDocumentProxy }) {
  const [zoom, setZoom] = useState(1);
  const ocr = usePdfOcr(document);
  const pageState = ocr.getPageState(1);

  useEffect(() => {
    if (pageState.status === 'ready') latestOcrResult = pageState.result;
  }, [pageState]);

  return (
    <>
      <button
        className="visually-hidden"
        data-testid="zoom-image-page"
        type="button"
        onClick={() => setZoom(1.5)}
      >
        Zoom image page
      </button>
      <output
        className="visually-hidden"
        data-testid="document-ocr-state"
        data-status={ocr.documentState.status}
        data-page-two-status={ocr.getPageState(2).status}
        data-page-three-status={ocr.getPageState(3).status}
        data-completed-pages={
          ocr.documentState.status === 'idle' ? 0 : ocr.documentState.completedPages
        }
        data-eligible-pages={
          ocr.documentState.status === 'idle' ? 0 : ocr.documentState.eligiblePages
        }
        data-failed-pages={
          ocr.documentState.status === 'idle' ? 0 : ocr.documentState.failedPages
        }
      />
      <PdfPage
        document={document}
        pageNumber={1}
        scrollElement={null}
        containerSize={{ width: 560, height: 420 }}
        fitMode={null}
        zoom={zoom}
        annotations={[]}
        documentLinks={[]}
        noteAnchors={[]}
        glossaryEntries={[]}
        definitionBubbles={[]}
        activeAnnotationId={null}
        activeGlossaryEntryId={null}
        activeLinkEndpointId={null}
        onCurrentPageChange={() => undefined}
        onScaleChange={() => undefined}
        onGoToPage={() => undefined}
        onAddBubbleToGlossary={() => undefined}
        onRemoveBubbleFromGlossary={() => undefined}
        onCloseDefinitionBubble={() => undefined}
        onMoveDefinitionUp={() => undefined}
        onToggleDefinitionsExpanded={() => undefined}
        onPageLayoutChange={() => undefined}
        onTextLayerReady={() => undefined}
        ocrState={pageState}
        documentOcrState={ocr.documentState}
        isOcrBusy={ocr.isBusy}
        onRecognizeText={ocr.recognizePage}
        onCancelRecognition={ocr.cancelPage}
        onRecognizeDocument={ocr.recognizeDocument}
        onCancelDocumentRecognition={ocr.cancelDocument}
        onOpenReaderContext={() => undefined}
        onActivateLinkBadge={() => undefined}
        onDismissReaderContext={() => undefined}
        searchResults={[]}
        activeSearchResultId={null}
        onSeaPaperDecision={() => undefined}
      />
    </>
  );
}

async function createSyntheticDocuments(): Promise<{
  imageOnly: PDFDocumentProxy;
  selectable: PDFDocumentProxy;
}> {
  const imagePdf = await PDFDocument.create();
  const imagePage = imagePdf.addPage([480, 320]);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = 480;
  sourceCanvas.height = 320;
  const context = sourceCanvas.getContext('2d');
  if (!context) throw new Error('Synthetic image canvas is unavailable.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  context.fillStyle = '#17202a';
  context.font = 'bold 28px sans-serif';
  context.fillText('Words painted into one bitmap', 34, 92);
  context.font = '24px sans-serif';
  context.fillText('There is deliberately no PDF text layer.', 34, 144);
  const imageBlob = await new Promise<Blob>((resolve, reject) => {
    sourceCanvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Synthetic image could not be encoded.'));
    }, 'image/png');
  });
  const embeddedImage = await imagePdf.embedPng(await imageBlob.arrayBuffer());
  imagePage.drawImage(embeddedImage, { x: 0, y: 0, width: 480, height: 320 });
  const mixedTextPage = imagePdf.addPage([480, 320]);
  const mixedFont = await imagePdf.embedFont(StandardFonts.Helvetica);
  mixedTextPage.drawText('Native PDF text must be skipped by document OCR.', {
    x: 34,
    y: 220,
    size: 20,
    font: mixedFont,
    color: rgb(0.09, 0.13, 0.16),
  });
  const secondImagePage = imagePdf.addPage([480, 320]);
  secondImagePage.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: 480,
    height: 320,
  });

  const textPdf = await PDFDocument.create();
  const textPage = textPdf.addPage([480, 320]);
  const font = await textPdf.embedFont(StandardFonts.Helvetica);
  textPage.drawText('This sentence is embedded PDF text.', {
    x: 34,
    y: 220,
    size: 24,
    font,
    color: rgb(0.09, 0.13, 0.16),
  });

  const [imageOnly, selectable] = await Promise.all([
    getDocument({ data: await imagePdf.save() }).promise,
    getDocument({ data: await textPdf.save() }).promise,
  ]);
  return { imageOnly, selectable };
}

async function runChecks(): Promise<void> {
  const imagePage = await waitForPageAvailability(
    '[data-testid="image-only-page"] .pdf-page-shell',
    'image-only',
  );
  const textPage = await waitForPageAvailability(
    '[data-testid="selectable-page"] .pdf-page-shell',
    'selectable',
  );
  assert(
    imagePage.parentElement
      ?.querySelector('.pdf-page-text-capability-notice')
      ?.textContent?.includes('need OCR'),
    'image-only page exposes the OCR explanation',
  );
  const imageNotice = imagePage.parentElement?.querySelector<HTMLElement>(
    '.pdf-page-text-capability-notice',
  );
  assert(imageNotice, 'image-only page renders its OCR explanation');
  const imagePageBounds = imagePage.getBoundingClientRect();
  const imageNoticeBounds = imageNotice.getBoundingClientRect();
  assert(
    imageNoticeBounds.top >= imagePageBounds.bottom,
    'image-only explanation is placed below the PDF instead of covering it',
  );
  assert(
    Math.abs(imageNoticeBounds.width - imagePageBounds.width) <= 3,
    'image-only explanation starts at the rendered PDF width',
  );
  const zoomButton = document.querySelector<HTMLButtonElement>(
    '[data-testid="image-only-page"] [data-testid="zoom-image-page"]',
  );
  assert(zoomButton, 'the fixture exposes its deterministic zoom control');
  zoomButton.click();
  await waitForCondition(
    () => imagePage.getBoundingClientRect().width >= imagePageBounds.width * 1.49,
    5_000,
  );
  const zoomedPageBounds = imagePage.getBoundingClientRect();
  const zoomedNoticeBounds = imageNotice.getBoundingClientRect();
  assert(
    Math.abs(zoomedNoticeBounds.width - zoomedPageBounds.width) <= 3,
    'the OCR explanation width follows PDF zoom',
  );
  assert(
    zoomedNoticeBounds.top >= zoomedPageBounds.bottom,
    'the zoomed OCR explanation remains below the PDF',
  );
  const recognizeButton = Array.from(
    imageNotice.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) =>
    button.textContent?.includes('Recognize English text on this page'),
  );
  assert(recognizeButton, 'image-only page exposes an explicit local OCR action');
  recognizeButton.click();
  await waitForCondition(() => imagePage.dataset.pdfOcrStatus === 'recognizing', 5_000);
  const cancelButton = Array.from(
    imageNotice.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.trim() === 'Cancel');
  assert(cancelButton, 'running local OCR exposes an explicit Cancel action');
  cancelButton.click();
  await waitForCondition(() => imagePage.dataset.pdfOcrStatus === 'idle', 5_000);
  const retryRecognition = imageNotice.querySelector<HTMLButtonElement>('button');
  assert(retryRecognition, 'cancelled OCR returns to the explicit recognition action');
  retryRecognition.click();
  await waitForCondition(() => imagePage.dataset.pdfOcrStatus === 'ready', 90_000);
  await waitForCondition(
    () =>
      imagePage.querySelector<HTMLElement>('.textLayer')?.dataset.pdfOcrTextLayer ===
        'true' && latestOcrResult !== null,
    5_000,
    'OCR reached ready state before its rendered text layer became available.',
  );
  const ocrWords = imagePage.querySelectorAll<HTMLElement>('.ocr-text-word');
  assert(ocrWords.length >= 10, 'recognized words render into the existing text layer');
  const firstText = ocrWords[0].firstChild;
  const lastText = ocrWords[ocrWords.length - 1].firstChild;
  assert(firstText instanceof Text && lastText instanceof Text, 'OCR words are text');
  const range = document.createRange();
  range.setStart(firstText, 0);
  range.setEnd(lastText, lastText.data.length);
  const browserSelection = window.getSelection();
  assert(browserSelection, 'browser selection is available');
  browserSelection.removeAllRanges();
  browserSelection.addRange(range);
  const pdfSelections = getPdfTextSelections(
    browserSelection,
    document.querySelector<HTMLElement>('.pdf-text-availability-fixture')!,
  );
  assert(
    /Words\s+painted/iu.test(pdfSelections[0]?.text ?? ''),
    'OCR text uses the existing PDF selection pipeline',
  );
  const selectionHighlights = createHighlightsFromSelections(pdfSelections, 'yellow');
  assert(
    selectionHighlights[0]?.rects.length === 2 &&
      selectionHighlights[0].rects.every(
        (rect) =>
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.width <= 1 &&
          rect.y + rect.height <= 1 &&
          rect.width < 1 &&
          rect.height < 0.25,
      ) &&
      selectionHighlights[0].rects.some((rect) => rect.width > 0.5),
    'OCR selection joins words into one bounded annotation segment per visual line',
  );
  browserSelection.removeAllRanges();
  assert(latestOcrResult, 'the local OCR engine returned a typed page result');
  const recognizedSearchTerm = latestOcrResult.words[0]?.text ?? '';
  assert(
    recognizedSearchTerm.length > 0 &&
      findPdfSearchResults([latestOcrResult.searchIndex], recognizedSearchTerm)
        .length >= 1,
    'recognized text uses the existing PDF search result model',
  );
  const recognizeDocumentButton = Array.from(
    imageNotice.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) =>
    button.textContent?.includes('Recognize remaining image-only pages'),
  );
  assert(
    recognizeDocumentButton,
    'a recognized page exposes explicit whole-document OCR',
  );
  recognizeDocumentButton.click();
  await waitForCondition(() => {
    const documentState = document.querySelector<HTMLElement>(
      '[data-testid="image-only-page"] [data-testid="document-ocr-state"]',
    );
    return documentState?.dataset.status === 'running';
  }, 5_000);
  const stopDocumentOcr = Array.from(
    imageNotice.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.includes('Stop document OCR'));
  assert(stopDocumentOcr, 'whole-document OCR exposes an explicit stop action');
  stopDocumentOcr.click();
  await waitForCondition(() => {
    const documentState = document.querySelector<HTMLElement>(
      '[data-testid="image-only-page"] [data-testid="document-ocr-state"]',
    );
    return documentState?.dataset.status === 'cancelled';
  }, 10_000);
  assert(
    imagePage.dataset.pdfOcrStatus === 'ready',
    'stopping whole-document OCR preserves already completed pages',
  );
  const continueDocumentOcr = Array.from(
    imageNotice.querySelectorAll<HTMLButtonElement>('button'),
  ).find((button) => button.textContent?.includes('Continue document OCR'));
  assert(continueDocumentOcr, 'stopped whole-document OCR can explicitly continue');
  continueDocumentOcr.click();
  await waitForCondition(() => {
    const documentState = document.querySelector<HTMLElement>(
      '[data-testid="image-only-page"] [data-testid="document-ocr-state"]',
    );
    return documentState?.dataset.status === 'complete';
  }, 120_000);
  const documentState = document.querySelector<HTMLElement>(
    '[data-testid="image-only-page"] [data-testid="document-ocr-state"]',
  );
  assert(documentState, 'whole-document OCR exposes typed settled state');
  assert(
    documentState.dataset.pageTwoStatus === 'idle',
    'whole-document OCR skips the native-text page',
  );
  assert(
    documentState.dataset.pageThreeStatus === 'ready',
    'whole-document OCR recognizes the second image-only page',
  );
  assert(
    documentState.dataset.completedPages === '2' &&
      documentState.dataset.eligiblePages === '2' &&
      documentState.dataset.failedPages === '0',
    'whole-document OCR reports exactly two image-only pages and no false failures',
  );
  assert(
    !textPage.parentElement?.querySelector('.pdf-page-text-capability-notice'),
    'selectable page does not show an OCR warning',
  );
  assert(
    textPage.querySelector('.textLayer')?.textContent?.includes('embedded PDF text'),
    'selectable page retains its PDF text layer',
  );
  assert(
    globalThis.__39notePdfTextAvailabilityFixture?.remoteMutations === 0,
    'PDF text fixture performs no remote mutation',
  );
}

async function waitForPageAvailability(
  selector: string,
  expected: string,
): Promise<HTMLElement> {
  let page: HTMLElement | null = null;
  await waitForCondition(() => {
    page = document.querySelector<HTMLElement>(selector);
    return page?.dataset.pdfTextAvailability === expected;
  }, 20_000);
  return page!;
}

function finishWithError(
  error: unknown,
  setResult: (result: 'FAIL') => void,
  setDetails: (details: string) => void,
): void {
  const message = error instanceof Error ? error.message : String(error);
  globalThis.__39notePdfTextAvailabilityFixture?.failures.push(message);
  setResult('FAIL');
  setDetails(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  timeoutMessage = 'PDF text check timed out.',
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
}

createRoot(document.getElementById('root')!).render(<BrowserFixture />);
