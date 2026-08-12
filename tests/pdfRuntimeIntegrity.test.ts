import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const packageManifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };
const installedPdfJsManifest = JSON.parse(
  readFileSync(
    new URL('../node_modules/pdfjs-dist/package.json', import.meta.url),
    'utf8',
  ),
) as { version: string };
const workerSource = readFileSync(
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
  'utf8',
);

test('PDF.js API, worker, and dependency versions stay aligned', () => {
  const declaredVersion = packageManifest.dependencies['pdfjs-dist'];
  assert.match(declaredVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(installedPdfJsManifest.version, declaredVersion);
  assert.match(
    workerSource.slice(0, 2_000),
    new RegExp(`pdfjsVersion = ${escapeRegExp(declaredVersion)}`),
  );
});

test('published PDF.js support assets match the installed runtime', () => {
  const publishedDirectory = new URL('../public/pdfjs-wasm/', import.meta.url);
  const installedDirectory = new URL('../node_modules/pdfjs-dist/wasm/', import.meta.url);
  const publishedFiles = readdirSync(publishedDirectory).sort();
  const installedFiles = readdirSync(installedDirectory).sort();

  assert.deepEqual(publishedFiles, installedFiles);
  for (const fileName of installedFiles) {
    assert.equal(
      sha256(new URL(fileName, publishedDirectory)),
      sha256(new URL(fileName, installedDirectory)),
      `${fileName} does not match pdfjs-dist ${installedPdfJsManifest.version}`,
    );
  }
});

function sha256(url: URL): string {
  return createHash('sha256').update(readFileSync(url)).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
