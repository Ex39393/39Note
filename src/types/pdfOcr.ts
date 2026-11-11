import type { PdfSearchPageIndex } from './pdfSearch.ts';

export type PdfOcrFailureCode =
  | 'busy'
  | 'cancelled'
  | 'engine-unavailable'
  | 'low-confidence'
  | 'no-text'
  | 'recognition-failed'
  | 'render-failed'
  | 'timeout';

export type PdfOcrProgressPhase =
  'preparing-page' | 'loading-engine' | 'loading-language' | 'recognizing-text';

export interface PdfOcrNormalizedRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfOcrWord {
  text: string;
  confidence: number;
  rect: PdfOcrNormalizedRectangle;
  separator: 'none' | 'space' | 'line';
}

export interface PdfOcrPageResult {
  pageNumber: number;
  language: 'eng';
  confidence: number;
  text: string;
  words: PdfOcrWord[];
  searchIndex: PdfSearchPageIndex;
}

export type PdfOcrPageState =
  | { status: 'idle' }
  | {
      status: 'recognizing';
      phase: PdfOcrProgressPhase;
      progress: number;
    }
  | { status: 'ready'; result: PdfOcrPageResult }
  | { status: 'failed'; code: Exclude<PdfOcrFailureCode, 'cancelled'> };

export interface PdfOcrProgress {
  phase: PdfOcrProgressPhase;
  progress: number;
}

export type PdfOcrDocumentPhase = 'inspecting' | 'recognizing';

export interface PdfOcrDocumentRunProgress {
  currentPage: number;
  totalPages: number;
  inspectedPages: number;
  eligiblePages: number;
  completedPages: number;
  failedPages: number;
  pageProgress: number;
}

export type PdfOcrDocumentState =
  | { status: 'idle' }
  | ({ status: 'running'; phase: PdfOcrDocumentPhase } & PdfOcrDocumentRunProgress)
  | ({ status: 'complete' } & Omit<
      PdfOcrDocumentRunProgress,
      'currentPage' | 'pageProgress'
    >)
  | ({ status: 'cancelled' } & Omit<
      PdfOcrDocumentRunProgress,
      'currentPage' | 'pageProgress'
    >)
  | ({ status: 'stopped'; code: Exclude<PdfOcrFailureCode, 'cancelled'> } & Omit<
      PdfOcrDocumentRunProgress,
      'currentPage' | 'pageProgress'
    >);

export class PdfOcrError extends Error {
  readonly code: PdfOcrFailureCode;

  constructor(code: PdfOcrFailureCode, message: string) {
    super(message);
    this.name = 'PdfOcrError';
    this.code = code;
  }
}

export const IDLE_PDF_OCR_PAGE_STATE: PdfOcrPageState = Object.freeze({
  status: 'idle',
});

export const IDLE_PDF_OCR_DOCUMENT_STATE: PdfOcrDocumentState = Object.freeze({
  status: 'idle',
});
