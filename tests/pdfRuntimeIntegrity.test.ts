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
const apiSource = readFileSync(
  new URL('../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url),
  'utf8',
);
const workerSource = readFileSync(
  new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
  'utf8',
);
const viewerSource = readFileSync(
  new URL('../src/components/Viewer.tsx', import.meta.url),
  'utf8',
);
const pdfJsAssetsSource = readFileSync(
  new URL('../src/utils/pdfJsAssets.ts', import.meta.url),
  'utf8',
);
const viteConfigSource = readFileSync(
  new URL('../vite.config.ts', import.meta.url),
  'utf8',
);

test('PDF.js API, worker, and dependency versions stay aligned', () => {
  const declaredVersion = packageManifest.dependencies['pdfjs-dist'];
  assert.match(declaredVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(
    isVersionAtLeast(declaredVersion, '6.2.108'),
    true,
    'PDF.js must include the CVE-2026-16633 scripting fix',
  );
  assert.equal(installedPdfJsManifest.version, declaredVersion);
  assert.match(
    apiSource,
    new RegExp(`apiVersion: "${escapeRegExp(declaredVersion)}"`),
    'the installed display API must embed the declared package version',
  );
  assert.match(
    workerSource.slice(0, 2_000),
    new RegExp(`pdfjsVersion = ${escapeRegExp(declaredVersion)}`),
  );
});

test('reader loads the PDF.js API and worker from one unoptimized package graph', () => {
  assert.match(
    viewerSource,
    /from 'pdfjs-dist\/build\/pdf\.mjs';/,
    'the reader must use the explicit display API entry point',
  );
  assert.match(
    viewerSource,
    /from 'pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url';/,
    'the reader worker must be emitted by Vite from the matching package',
  );
  assert.doesNotMatch(
    viewerSource,
    /from 'pdfjs-dist';/,
    'a bare optimized API can remain stale while the direct worker is upgraded',
  );
  assert.match(
    viteConfigSource,
    /optimizeDeps:\s*{[\s\S]*?exclude:\s*\[['"]pdfjs-dist['"]\][\s\S]*?}/,
    'Vite must not retain a separately optimized PDF.js display API in dev',
  );
  assert.match(
    viteConfigSource,
    /resolve:\s*{[\s\S]*?dedupe:\s*\[['"]pdfjs-dist['"]\][\s\S]*?}/,
    'all PDF.js imports must resolve to one installed package',
  );
});

test('reader worker and WASM URLs remain deployment-base safe', () => {
  assert.match(viewerSource, /GlobalWorkerOptions\.workerSrc\s*=\s*pdfWorker;/);
  assert.doesNotMatch(
    viewerSource,
    /workerSrc\s*=\s*['"]\//,
    'the worker URL must not be hard-coded to the host root',
  );
  assert.match(pdfJsAssetsSource, /import\.meta\.env\.BASE_URL/);
  assert.match(pdfJsAssetsSource, /`\$\{normalizedBaseUrl}pdfjs-wasm\/`/);
  assert.doesNotMatch(
    pdfJsAssetsSource,
    /['"]\/pdfjs-wasm\/['"]/,
    'the WASM directory must inherit the Vite deployment base',
  );
});

test('published PDF.js support assets match the installed runtime', () => {
  const publishedDirectory = new URL('../public/pdfjs-wasm/', import.meta.url);
  const installedDirectory = new URL(
    '../node_modules/pdfjs-dist/wasm/',
    import.meta.url,
  );
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

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index];
    }
  }
  return true;
}
