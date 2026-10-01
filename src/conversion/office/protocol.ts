import {
  OFFICE_CONVERSION_WORKER_PROTOCOL,
  type OfficeConversionLossSummary,
  type OfficeConversionWorkerProgress,
  type OfficeConversionWorkerResponse,
  type OfficeConversionWorkerResult,
  type OfficeDocumentType,
} from './types';
import { OfficeConversionError } from './validation';

const UNEXPECTED_CONVERSION_MESSAGE =
  'Conversion failed: the local Office converter stopped unexpectedly. Nothing was added.';

export type DecodedOfficeConversionResponse =
  | { readonly status: 'foreign' }
  | { readonly status: 'malformed' }
  | {
      readonly status: 'message';
      readonly message: OfficeConversionWorkerResponse;
    };

export function decodeOfficeConversionResponse(
  value: unknown,
  expectedRequestId: string,
  expectedType: OfficeDocumentType,
): DecodedOfficeConversionResponse {
  if (!isRecord(value) || value.protocol !== OFFICE_CONVERSION_WORKER_PROTOCOL) {
    return { status: 'foreign' };
  }
  if (value.requestId !== expectedRequestId) return { status: 'malformed' };

  if (value.kind === 'progress') {
    if (!isProgress(value.progress)) return { status: 'malformed' };
    return {
      status: 'message',
      message: value as unknown as OfficeConversionWorkerResponse,
    };
  }

  if (value.kind !== 'result' || typeof value.ok !== 'boolean') {
    return { status: 'malformed' };
  }
  if (!value.ok) {
    if (!isSerializedError(value.error)) return { status: 'malformed' };
    return {
      status: 'message',
      message: value as unknown as OfficeConversionWorkerResponse,
    };
  }

  if (!isWorkerResult(value, expectedType)) return { status: 'malformed' };
  return {
    status: 'message',
    message: value as unknown as OfficeConversionWorkerResponse,
  };
}

export function workerResultFromSuccess(
  message: Extract<OfficeConversionWorkerResponse, { readonly ok: true }>,
): OfficeConversionWorkerResult {
  return {
    pdfBytes: message.pdfBytes,
    sourceType: message.sourceType,
    sourceTextCharacters: message.sourceTextCharacters,
    pdfTextCharacters: message.pdfTextCharacters,
    pageCount: message.pageCount,
    losses: message.losses,
  };
}

export function serializeOfficeConversionError(error: unknown): {
  readonly code: string;
  readonly message: string;
} {
  if (error instanceof OfficeConversionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'conversion-failed',
    message: UNEXPECTED_CONVERSION_MESSAGE,
  };
}

function isWorkerResult(
  value: Record<string, unknown>,
  expectedType: OfficeDocumentType,
): boolean {
  return (
    value.pdfBytes instanceof ArrayBuffer &&
    value.pdfBytes.byteLength > 0 &&
    value.sourceType === expectedType &&
    isNonNegativeInteger(value.sourceTextCharacters) &&
    isNonNegativeInteger(value.pdfTextCharacters) &&
    (value.pageCount === null || isPositiveInteger(value.pageCount)) &&
    isLossSummary(value.losses)
  );
}

function isProgress(value: unknown): value is OfficeConversionWorkerProgress {
  if (!isRecord(value) || typeof value.message !== 'string' || !value.message) {
    return false;
  }
  return (
    value.stage === 'validating' ||
    value.stage === 'converting' ||
    value.stage === 'verifying'
  );
}

function isSerializedError(
  value: unknown,
): value is { readonly code: string; readonly message: string } {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    value.code.length > 0 &&
    value.code.length <= 80 &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= 500
  );
}

function isLossSummary(value: unknown): value is OfficeConversionLossSummary {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.dropped) &&
    isNonNegativeInteger(value.degraded) &&
    isNonNegativeInteger(value.substituted) &&
    isNonNegativeInteger(value.unsupportedImagesOmitted) &&
    isNonNegativeInteger(value.metadataNormalizedImages)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
