import type { DocumentType } from '../../types/document';

export type OfficeDocumentType = Extract<DocumentType, 'docx' | 'pptx'>;

export type OfficeConversionStage =
  'reading' | 'validating' | 'converting' | 'verifying';

export interface OfficeConversionProgress {
  readonly stage: OfficeConversionStage;
  readonly message: string;
}

export interface OfficeConversionWorkerProgress {
  readonly stage: Exclude<OfficeConversionStage, 'reading'>;
  readonly message: string;
}

export interface OfficeConversionLossSummary {
  readonly dropped: number;
  readonly degraded: number;
  readonly substituted: number;
  readonly unsupportedImagesOmitted: number;
  readonly metadataNormalizedImages: number;
}

export interface OfficeConversionResult {
  readonly file: File;
  readonly sourceType: OfficeDocumentType;
  readonly sourceTextCharacters: number;
  readonly pdfTextCharacters: number;
  readonly pageCount: number | null;
  readonly losses: OfficeConversionLossSummary;
}

export interface OfficeConversionRequest {
  readonly requestId: number;
  readonly file?: File;
}

export interface OfficeConversionWorkerResult {
  readonly pdfBytes: ArrayBuffer;
  readonly sourceType: OfficeDocumentType;
  readonly sourceTextCharacters: number;
  readonly pdfTextCharacters: number;
  readonly pageCount: number | null;
  readonly losses: OfficeConversionLossSummary;
}

export const OFFICE_CONVERSION_WORKER_PROTOCOL = '39note-office-conversion/v1' as const;

export interface OfficeConversionWorkerRequest {
  readonly protocol: typeof OFFICE_CONVERSION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly kind: 'convert';
  readonly bytes: ArrayBuffer;
  readonly expectedType: OfficeDocumentType;
  readonly responsePort: MessagePort;
}

export interface OfficeConversionWorkerProgressMessage {
  readonly protocol: typeof OFFICE_CONVERSION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly kind: 'progress';
  readonly progress: OfficeConversionWorkerProgress;
}

export interface OfficeConversionWorkerSuccessMessage extends OfficeConversionWorkerResult {
  readonly protocol: typeof OFFICE_CONVERSION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly kind: 'result';
  readonly ok: true;
}

export interface OfficeConversionWorkerFailureMessage {
  readonly protocol: typeof OFFICE_CONVERSION_WORKER_PROTOCOL;
  readonly requestId: string;
  readonly kind: 'result';
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type OfficeConversionWorkerResponse =
  | OfficeConversionWorkerProgressMessage
  | OfficeConversionWorkerSuccessMessage
  | OfficeConversionWorkerFailureMessage;
