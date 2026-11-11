import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const assetsDirectory = resolve('dist', 'assets');
const entries = (await readdir(assetsDirectory, { recursive: true })).map((entry) =>
  entry.replaceAll('\\', '/'),
);

await verifyExactAsset('ocr/eng.traineddata.gz', 2_000_000);
await verifyMatchedAsset(/^worker\.min-[a-zA-Z0-9_-]+\.js$/u, 90_000);
await verifyMatchedAsset(/^tesseract-core-lstm\.wasm-[a-zA-Z0-9_-]+\.js$/u, 3_000_000);

console.log(
  'Verified local OCR runtime: same-origin English model, worker, and LSTM WASM core.',
);

async function verifyExactAsset(relativePath, minimumBytes) {
  if (!entries.includes(relativePath)) {
    throw new Error(`Missing required OCR asset: dist/assets/${relativePath}`);
  }
  await verifySize(relativePath, minimumBytes);
}

async function verifyMatchedAsset(pattern, minimumBytes) {
  const matches = entries.filter((entry) => pattern.test(entry));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one OCR asset matching ${pattern}, found ${matches.length}.`,
    );
  }
  await verifySize(matches[0], minimumBytes);
}

async function verifySize(relativePath, minimumBytes) {
  const details = await stat(resolve(assetsDirectory, relativePath));
  if (!details.isFile() || details.size < minimumBytes) {
    throw new Error(
      `OCR asset dist/assets/${relativePath} is incomplete (${details.size} bytes).`,
    );
  }
}
