import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  inspectPdfPageOcrEligibility,
  recognizePdfPageLocally,
  terminateLocalPdfOcrWorker,
} from '../services/pdfOcr.ts';
import {
  IDLE_PDF_OCR_DOCUMENT_STATE,
  IDLE_PDF_OCR_PAGE_STATE,
  PdfOcrError,
  type PdfOcrDocumentRunProgress,
  type PdfOcrDocumentState,
  type PdfOcrFailureCode,
  type PdfOcrPageState,
} from '../types/pdfOcr.ts';
import type { PdfSearchPageIndex } from '../types/pdfSearch.ts';

interface PdfOcrSessionState {
  document: PDFDocumentProxy | null;
  pages: Record<number, PdfOcrPageState>;
  documentRun: PdfOcrDocumentState;
}

interface ActivePdfOcrPage {
  document: PDFDocumentProxy;
  pageNumber: number;
  controller: AbortController;
  generation: number;
}

type PdfOcrPageOutcome =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | {
      status: 'failed';
      code: Exclude<PdfOcrFailureCode, 'cancelled'>;
    };

export interface PdfOcrController {
  isBusy: boolean;
  documentState: PdfOcrDocumentState;
  searchIndexes: PdfSearchPageIndex[];
  getPageState: (pageNumber: number) => PdfOcrPageState;
  recognizePage: (pageNumber: number) => Promise<void>;
  cancelPage: (pageNumber: number) => void;
  recognizeDocument: () => Promise<void>;
  cancelDocument: () => void;
}

export function usePdfOcr(document: PDFDocumentProxy | null): PdfOcrController {
  const [session, setSession] = useState<PdfOcrSessionState>({
    document,
    pages: {},
    documentRun: IDLE_PDF_OCR_DOCUMENT_STATE,
  });
  const sessionRef = useRef(session);
  const generationRef = useRef(0);
  const activeRef = useRef<ActivePdfOcrPage | null>(null);
  const documentRunRef = useRef<{
    document: PDFDocumentProxy;
    controller: AbortController;
    generation: number;
  } | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    generationRef.current += 1;
    activeRef.current?.controller.abort();
    documentRunRef.current?.controller.abort();
    activeRef.current = null;
    documentRunRef.current = null;
    const nextSession = {
      document,
      pages: {},
      documentRun: IDLE_PDF_OCR_DOCUMENT_STATE,
    };
    sessionRef.current = nextSession;
    setSession(nextSession);
    void terminateLocalPdfOcrWorker();
    return () => {
      generationRef.current += 1;
      activeRef.current?.controller.abort();
      documentRunRef.current?.controller.abort();
      activeRef.current = null;
      documentRunRef.current = null;
      void terminateLocalPdfOcrWorker();
    };
  }, [document]);

  const isCurrentPageOperation = useCallback(
    (
      activeDocument: PDFDocumentProxy,
      pageNumber: number,
      controller: AbortController,
      generation: number,
    ): boolean => {
      const active = activeRef.current;
      return (
        generation === generationRef.current &&
        active?.document === activeDocument &&
        active.pageNumber === pageNumber &&
        active.controller === controller &&
        active.generation === generation
      );
    },
    [],
  );

  const runPageRecognition = useCallback(
    async (
      pageNumber: number,
      controller: AbortController,
      generation: number,
    ): Promise<PdfOcrPageOutcome> => {
      if (!document) return { status: 'cancelled' };
      activeRef.current = { document, pageNumber, controller, generation };
      setPageState(setSession, document, pageNumber, {
        status: 'recognizing',
        phase: 'preparing-page',
        progress: 0,
      });

      try {
        const result = await recognizePdfPageLocally(document, pageNumber, {
          signal: controller.signal,
          onProgress(progress) {
            const active = activeRef.current;
            if (
              active?.document !== document ||
              active.pageNumber !== pageNumber ||
              active.generation !== generation ||
              active.controller !== controller
            ) {
              return;
            }
            setPageState(setSession, document, pageNumber, {
              status: 'recognizing',
              ...progress,
            });
            setDocumentPageProgress(
              setSession,
              document,
              pageNumber,
              progress.progress,
            );
          },
        });
        if (!isCurrentPageOperation(document, pageNumber, controller, generation)) {
          return { status: 'cancelled' };
        }
        setPageState(setSession, document, pageNumber, {
          status: 'ready',
          result,
        });
        return { status: 'ready' };
      } catch (error) {
        if (!isCurrentPageOperation(document, pageNumber, controller, generation)) {
          return { status: 'cancelled' };
        }
        if (error instanceof PdfOcrError && error.code === 'cancelled') {
          setPageState(setSession, document, pageNumber, IDLE_PDF_OCR_PAGE_STATE);
          return { status: 'cancelled' };
        }
        const code =
          error instanceof PdfOcrError && error.code !== 'cancelled'
            ? error.code
            : 'recognition-failed';
        setPageState(setSession, document, pageNumber, {
          status: 'failed',
          code,
        });
        return { status: 'failed', code };
      } finally {
        if (
          activeRef.current?.controller === controller &&
          activeRef.current.pageNumber === pageNumber
        ) {
          activeRef.current = null;
        }
      }
    },
    [document, isCurrentPageOperation],
  );

  const recognizePage = useCallback(
    async (pageNumber: number) => {
      if (
        !document ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > document.numPages ||
        activeRef.current ||
        documentRunRef.current
      ) {
        return;
      }
      const controller = new AbortController();
      await runPageRecognition(pageNumber, controller, generationRef.current);
    },
    [document, runPageRecognition],
  );

  const recognizeDocument = useCallback(async () => {
    if (!document || activeRef.current || documentRunRef.current) return;

    const controller = new AbortController();
    const generation = generationRef.current;
    documentRunRef.current = { document, controller, generation };
    const initialPages =
      sessionRef.current.document === document ? sessionRef.current.pages : {};
    const readyAtStart = new Set(
      Object.entries(initialPages).flatMap(([pageNumber, pageState]) =>
        pageState.status === 'ready' ? [Number(pageNumber)] : [],
      ),
    );
    const progress: PdfOcrDocumentRunProgress = {
      currentPage: 1,
      totalPages: document.numPages,
      inspectedPages: 0,
      eligiblePages: 0,
      completedPages: 0,
      failedPages: 0,
      pageProgress: 0,
    };
    let cancelled = false;
    let stoppedCode: Exclude<PdfOcrFailureCode, 'cancelled'> | null = null;

    const publish = (phase: 'inspecting' | 'recognizing') => {
      if (generation !== generationRef.current) return;
      setDocumentState(setSession, document, {
        status: 'running',
        phase,
        ...progress,
      });
    };

    publish('inspecting');
    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        progress.currentPage = pageNumber;
        progress.pageProgress = 0;
        publish('inspecting');

        if (readyAtStart.has(pageNumber)) {
          progress.inspectedPages += 1;
          progress.eligiblePages += 1;
          progress.completedPages += 1;
          publish('inspecting');
          continue;
        }

        let eligibility;
        try {
          eligibility = await inspectPdfPageOcrEligibility(
            document,
            pageNumber,
            controller.signal,
          );
        } catch (error) {
          if (
            controller.signal.aborted ||
            (error instanceof PdfOcrError && error.code === 'cancelled')
          ) {
            cancelled = true;
            break;
          }
          progress.inspectedPages += 1;
          progress.failedPages += 1;
          setPageState(setSession, document, pageNumber, {
            status: 'failed',
            code:
              error instanceof PdfOcrError && error.code !== 'cancelled'
                ? error.code
                : 'render-failed',
          });
          publish('inspecting');
          continue;
        }

        progress.inspectedPages += 1;
        if (eligibility !== 'image-only') {
          publish('inspecting');
          continue;
        }

        progress.eligiblePages += 1;
        publish('recognizing');
        const outcome = await runPageRecognition(pageNumber, controller, generation);
        if (outcome.status === 'ready') {
          progress.completedPages += 1;
        } else if (outcome.status === 'cancelled') {
          cancelled = true;
          break;
        } else {
          progress.failedPages += 1;
          if (outcome.code === 'engine-unavailable') {
            stoppedCode = outcome.code;
            break;
          }
        }
        publish('inspecting');
      }
    } finally {
      if (documentRunRef.current?.controller === controller) {
        documentRunRef.current = null;
      }
    }

    if (generation !== generationRef.current) return;
    const settled = {
      totalPages: progress.totalPages,
      inspectedPages: progress.inspectedPages,
      eligiblePages: progress.eligiblePages,
      completedPages: progress.completedPages,
      failedPages: progress.failedPages,
    };
    setDocumentState(
      setSession,
      document,
      stoppedCode
        ? { status: 'stopped', code: stoppedCode, ...settled }
        : cancelled
          ? { status: 'cancelled', ...settled }
          : { status: 'complete', ...settled },
    );
  }, [document, runPageRecognition]);

  const cancelPage = useCallback((pageNumber: number) => {
    const active = activeRef.current;
    if (active?.pageNumber === pageNumber && !documentRunRef.current) {
      active.controller.abort();
    }
  }, []);

  const cancelDocument = useCallback(() => {
    documentRunRef.current?.controller.abort();
  }, []);

  const visiblePages = useMemo(
    () => (session.document === document ? session.pages : {}),
    [document, session],
  );
  const documentState =
    session.document === document ? session.documentRun : IDLE_PDF_OCR_DOCUMENT_STATE;
  const isBusy =
    documentState.status === 'running' ||
    Object.values(visiblePages).some((page) => page.status === 'recognizing');
  const searchIndexes = useMemo(
    () =>
      Object.values(visiblePages).flatMap((page) =>
        page.status === 'ready' ? [page.result.searchIndex] : [],
      ),
    [visiblePages],
  );
  const getPageState = useCallback(
    (pageNumber: number) => visiblePages[pageNumber] ?? IDLE_PDF_OCR_PAGE_STATE,
    [visiblePages],
  );

  return {
    isBusy,
    documentState,
    searchIndexes,
    getPageState,
    recognizePage,
    cancelPage,
    recognizeDocument,
    cancelDocument,
  };
}

function setPageState(
  setSession: Dispatch<SetStateAction<PdfOcrSessionState>>,
  document: PDFDocumentProxy,
  pageNumber: number,
  pageState: PdfOcrPageState,
): void {
  setSession((current) =>
    current.document !== document
      ? current
      : {
          ...current,
          pages: { ...current.pages, [pageNumber]: pageState },
        },
  );
}

function setDocumentState(
  setSession: Dispatch<SetStateAction<PdfOcrSessionState>>,
  document: PDFDocumentProxy,
  documentRun: PdfOcrDocumentState,
): void {
  setSession((current) =>
    current.document !== document ? current : { ...current, documentRun },
  );
}

function setDocumentPageProgress(
  setSession: Dispatch<SetStateAction<PdfOcrSessionState>>,
  document: PDFDocumentProxy,
  pageNumber: number,
  pageProgress: number,
): void {
  setSession((current) =>
    current.document !== document ||
    current.documentRun.status !== 'running' ||
    current.documentRun.currentPage !== pageNumber
      ? current
      : {
          ...current,
          documentRun: {
            ...current.documentRun,
            pageProgress,
          },
        },
  );
}
