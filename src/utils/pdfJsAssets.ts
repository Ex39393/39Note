const normalizedBaseUrl = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export const resolvedPdfJsWasmUrl = `${normalizedBaseUrl}pdfjs-wasm/`;

export function createPdfDocumentInitParameters<T extends Record<string, unknown>>(
  parameters: T,
): T & { wasmUrl: string } {
  return {
    ...parameters,
    wasmUrl: resolvedPdfJsWasmUrl,
  };
}
