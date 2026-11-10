import workerPath from 'tesseract.js/dist/worker.min.js?url';
import corePath from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import englishDataPath from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';

export interface LocalPdfOcrAssets {
  workerPath: string;
  corePath: string;
  langPath: string;
}

export function getLocalPdfOcrAssets(): LocalPdfOcrAssets {
  const workerUrl = sameOriginUrl(workerPath, 'worker');
  const coreUrl = sameOriginUrl(corePath, 'core');
  const languageUrl = sameOriginUrl(englishDataPath, 'language');
  if (!languageUrl.pathname.endsWith('/eng.traineddata.gz')) {
    throw new Error('The bundled OCR language asset name is invalid.');
  }
  const languageDirectory = new URL('.', languageUrl);

  return {
    workerPath: workerUrl.href,
    corePath: coreUrl.href.endsWith('.js') ? coreUrl.href : `${coreUrl.href}#js`,
    langPath: languageDirectory.href.replace(/\/$/u, ''),
  };
}

function sameOriginUrl(value: string, label: string): URL {
  const url = new URL(value, window.location.href);
  if (url.origin !== window.location.origin) {
    throw new Error(`The bundled OCR ${label} asset is not same-origin.`);
  }
  return url;
}
