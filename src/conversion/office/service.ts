import {
  OFFICE_CONVERSION_WORKER_PROTOCOL,
  type OfficeConversionWorkerRequest,
  type OfficeConversionProgress,
  type OfficeConversionResult,
  type OfficeConversionWorkerResult,
} from './types';
import { decodeOfficeConversionResponse, workerResultFromSuccess } from './protocol';
import {
  createConvertedPdfFile,
  OfficeConversionError,
  validateOfficeFileSelection,
} from './validation';

const DEFAULT_CONVERSION_TIMEOUT_MS = 120_000;

export interface OfficeConversionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: OfficeConversionProgress) => void;
}

export async function convertOfficeFileToPdf(
  file: File,
  options: OfficeConversionOptions = {},
): Promise<OfficeConversionResult> {
  const sourceType = validateOfficeFileSelection(file);
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: 'reading', message: 'Reading the local file…' });
  const sourceBytes = await file.arrayBuffer();
  throwIfAborted(options.signal);

  const worker = new Worker(new URL('./officeConversion.worker.ts', import.meta.url), {
    name: '39note-office-to-pdf',
    type: 'module',
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONVERSION_TIMEOUT_MS;
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();

  debugOfficeConversion('request-started', {
    requestId,
    inputKind: sourceType,
    inputBytes: sourceBytes.byteLength,
  });

  try {
    const result = await new Promise<OfficeConversionWorkerResult>(
      (resolve, reject) => {
        const responseChannel = new MessageChannel();
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timeoutId);
          options.signal?.removeEventListener('abort', handleAbort);
          responseChannel.port1.close();
          callback();
        };
        const handleAbort = () =>
          finish(() =>
            reject(new DOMException('Office conversion was cancelled.', 'AbortError')),
          );
        const timeoutId = globalThis.setTimeout(
          () =>
            finish(() =>
              reject(
                new OfficeConversionError(
                  'timeout',
                  'Office conversion took too long and was stopped safely.',
                ),
              ),
            ),
          timeoutMs,
        );
        const rejectProtocolFailure = () =>
          finish(() =>
            reject(
              new OfficeConversionError(
                'worker-protocol',
                'The local Office converter returned an invalid result. Nothing was added.',
              ),
            ),
          );
        options.signal?.addEventListener('abort', handleAbort, { once: true });
        if (options.signal?.aborted) {
          responseChannel.port2.close();
          handleAbort();
          return;
        }
        worker.addEventListener('error', () => {
          finish(() =>
            reject(
              new OfficeConversionError(
                'worker-failed',
                'Conversion failed: the local Office converter stopped unexpectedly. Nothing was added.',
              ),
            ),
          );
        });
        worker.addEventListener('messageerror', rejectProtocolFailure);
        worker.addEventListener('message', (event: MessageEvent) => {
          debugOfficeConversion('outer-worker-message-ignored', {
            requestId,
            keys: recordKeys(event.data),
          });
        });
        responseChannel.port1.addEventListener('messageerror', rejectProtocolFailure);
        responseChannel.port1.addEventListener('message', (event: MessageEvent) => {
          const decoded = decodeOfficeConversionResponse(
            event.data,
            requestId,
            sourceType,
          );
          debugOfficeConversion('response-received', {
            requestId,
            classification: decoded.status,
            keys: recordKeys(event.data),
            elapsedMs: Math.round(performance.now() - startedAt),
            pdfByteLength: responsePdfByteLength(event.data),
          });
          if (decoded.status === 'foreign' || decoded.status === 'malformed') {
            rejectProtocolFailure();
            return;
          }
          const message = decoded.message;
          if (message.kind === 'progress') {
            options.onProgress?.(message.progress);
            return;
          }
          if (!message.ok) {
            finish(() =>
              reject(
                new OfficeConversionError(message.error.code, message.error.message),
              ),
            );
            return;
          }
          finish(() => resolve(workerResultFromSuccess(message)));
        });
        responseChannel.port1.start();

        const request: OfficeConversionWorkerRequest = {
          protocol: OFFICE_CONVERSION_WORKER_PROTOCOL,
          requestId,
          kind: 'convert',
          bytes: sourceBytes,
          expectedType: sourceType,
          responsePort: responseChannel.port2,
        };
        try {
          worker.postMessage(request, [sourceBytes, responseChannel.port2]);
        } catch {
          responseChannel.port2.close();
          rejectProtocolFailure();
        }
      },
    );

    const pdfFile = createConvertedPdfFile(file.name, result.pdfBytes);
    debugOfficeConversion('request-succeeded', {
      requestId,
      inputKind: sourceType,
      pdfByteLength: result.pdfBytes.byteLength,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return {
      file: pdfFile,
      sourceType: result.sourceType,
      sourceTextCharacters: result.sourceTextCharacters,
      pdfTextCharacters: result.pdfTextCharacters,
      pageCount: result.pageCount,
      losses: result.losses,
    };
  } finally {
    worker.terminate();
  }
}

function recordKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object'
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function responsePdfByteLength(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const pdfBytes = (value as Record<string, unknown>).pdfBytes;
  return pdfBytes instanceof ArrayBuffer ? pdfBytes.byteLength : null;
}

function debugOfficeConversion(
  phase: string,
  details: Readonly<Record<string, unknown>>,
): void {
  if (!import.meta.env.DEV) return;
  console.debug('[office-conversion]', JSON.stringify({ phase, ...details }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Office conversion was cancelled.', 'AbortError');
  }
}
