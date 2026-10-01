/// <reference lib="webworker" />

import arimoBoldUrl from '@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf?url';
import arimoBoldItalicUrl from '@expo-google-fonts/arimo/700Bold_Italic/Arimo_700Bold_Italic.ttf?url';
import arimoItalicUrl from '@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf?url';
import arimoRegularUrl from '@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf?url';
import notoSansScRegularUrl from '@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf?url';
import { convertOfficeBytesToPdf, type OfficeConversionFontSet } from './engine';
import {
  OFFICE_CONVERSION_WORKER_PROTOCOL,
  type OfficeConversionWorkerFailureMessage,
  type OfficeConversionWorkerProgressMessage,
  type OfficeConversionWorkerRequest,
  type OfficeConversionWorkerSuccessMessage,
} from './types';
import { serializeOfficeConversionError } from './protocol';

const workerScope = self as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (!isOfficeConversionRequest(event.data)) return;
  void runConversion(event.data);
});

async function runConversion(message: OfficeConversionWorkerRequest): Promise<void> {
  const { responsePort } = message;
  try {
    const fonts = await loadBundledFonts();
    const result = await convertOfficeBytesToPdf({
      bytes: new Uint8Array(message.bytes),
      expectedType: message.expectedType,
      fonts,
      loadCjkFont: () => loadBundledFont(notoSansScRegularUrl),
      onProgress: (progress) => {
        const response: OfficeConversionWorkerProgressMessage = {
          protocol: OFFICE_CONVERSION_WORKER_PROTOCOL,
          requestId: message.requestId,
          kind: 'progress',
          progress,
        };
        responsePort.postMessage(response);
      },
    });
    const response: OfficeConversionWorkerSuccessMessage = {
      ...result,
      protocol: OFFICE_CONVERSION_WORKER_PROTOCOL,
      requestId: message.requestId,
      kind: 'result',
      ok: true,
    };
    responsePort.postMessage(response, [response.pdfBytes]);
  } catch (error) {
    diagnoseConversionError(error);
    const response: OfficeConversionWorkerFailureMessage = {
      protocol: OFFICE_CONVERSION_WORKER_PROTOCOL,
      requestId: message.requestId,
      kind: 'result',
      ok: false,
      error: serializeOfficeConversionError(error),
    };
    responsePort.postMessage(response);
  } finally {
    responsePort.close();
  }
}

function isOfficeConversionRequest(
  value: unknown,
): value is OfficeConversionWorkerRequest {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return (
    message.protocol === OFFICE_CONVERSION_WORKER_PROTOCOL &&
    message.kind === 'convert' &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0 &&
    message.bytes instanceof ArrayBuffer &&
    (message.expectedType === 'docx' || message.expectedType === 'pptx') &&
    message.responsePort instanceof MessagePort
  );
}

function diagnoseConversionError(error: unknown): void {
  if (import.meta.env.DEV) {
    console.debug(
      '[office-conversion]',
      JSON.stringify({
        phase: 'worker-failed',
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}

async function loadBundledFonts(): Promise<OfficeConversionFontSet> {
  const [regular, bold, italic, boldItalic] = await Promise.all([
    loadBundledFont(arimoRegularUrl),
    loadBundledFont(arimoBoldUrl),
    loadBundledFont(arimoItalicUrl),
    loadBundledFont(arimoBoldItalicUrl),
  ]);
  return { regular, bold, italic, boldItalic };
}

async function loadBundledFont(url: string): Promise<Uint8Array> {
  const resolved = new URL(url, workerScope.location.href);
  if (resolved.origin !== workerScope.location.origin) {
    throw new Error('The bundled conversion font resolved outside 39Note.');
  }
  const response = await fetch(resolved, {
    cache: 'force-cache',
    credentials: 'same-origin',
    mode: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('A bundled conversion font could not be loaded.');
  }
  return new Uint8Array(await response.arrayBuffer());
}

export {};
