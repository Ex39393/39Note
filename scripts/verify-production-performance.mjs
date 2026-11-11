import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIST_DIRECTORY = resolve('dist');
const MANIFEST_PATH = resolve(DIST_DIRECTORY, '.vite', 'manifest.json');
const KIB = 1024;
const BUDGETS = Object.freeze({
  entryChunk: 400 * KIB,
  startupJavaScript: 600 * KIB,
  startupCss: 300 * KIB,
  lazyViewer: 130 * KIB,
  lazyPdfJs: 500 * KIB,
  lazyFontkit: 750 * KIB,
});

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
if (!entryKey) throw new Error('The production manifest has no application entry.');

const entry = manifest[entryKey];
const staticKeys = collectStaticImports(entryKey, manifest);
const startupJavaScriptFiles = [...staticKeys].map((key) => manifest[key].file);
const startupCssFiles = [
  ...new Set([...staticKeys].flatMap((key) => manifest[key].css ?? [])),
];
const startupJavaScriptBytes = await totalBytes(startupJavaScriptFiles);
const startupCssBytes = await totalBytes(startupCssFiles);
const entryBytes = await fileBytes(entry.file);

assertBudget('application entry', entryBytes, BUDGETS.entryChunk);
assertBudget(
  'startup JavaScript graph',
  startupJavaScriptBytes,
  BUDGETS.startupJavaScript,
);
assertBudget('startup CSS graph', startupCssBytes, BUDGETS.startupCss);

const viewerKey = requireManifestKey('src/components/Viewer.tsx');
const pdfJsKey = requireManifestKeyByName('pdfjs');
const fontkitKey = requireManifestKey(
  'node_modules/@pdf-lib/fontkit/dist/fontkit.es.js',
);
const annotatedExportKey = requireManifestKeyByName('annotatedPdfExport');
const ocrAssetsKey = requireManifestKey('src/services/pdfOcrAssets.ts');

for (const [label, key] of [
  ['Viewer', viewerKey],
  ['PDF.js', pdfJsKey],
  ['fontkit', fontkitKey],
  ['annotated PDF export', annotatedExportKey],
  ['OCR assets', ocrAssetsKey],
]) {
  if (staticKeys.has(key)) {
    throw new Error(`${label} unexpectedly entered the production startup graph.`);
  }
}

if (!(entry.dynamicImports ?? []).includes(viewerKey)) {
  throw new Error('Viewer is no longer an explicit lazy application boundary.');
}
if (!(manifest[viewerKey].imports ?? []).includes(pdfJsKey)) {
  throw new Error('The lazy Viewer no longer owns the PDF.js runtime dependency.');
}
if (!(manifest[annotatedExportKey].dynamicImports ?? []).includes(fontkitKey)) {
  throw new Error('fontkit is no longer lazy behind annotated PDF export.');
}
if (
  !(manifest[ocrAssetsKey].assets ?? []).some((file) =>
    file.endsWith('eng.traineddata.gz'),
  )
) {
  throw new Error('The lazy OCR boundary is missing its English model.');
}

assertBudget(
  'lazy Viewer chunk',
  await fileBytes(manifest[viewerKey].file),
  BUDGETS.lazyViewer,
);
assertBudget(
  'lazy PDF.js chunk',
  await fileBytes(manifest[pdfJsKey].file),
  BUDGETS.lazyPdfJs,
);
assertBudget(
  'lazy fontkit chunk',
  await fileBytes(manifest[fontkitKey].file),
  BUDGETS.lazyFontkit,
);

const indexHtml = await readFile(resolve(DIST_DIRECTORY, 'index.html'), 'utf8');
for (const forbidden of [
  manifest[viewerKey].file,
  manifest[pdfJsKey].file,
  manifest[fontkitKey].file,
  ...(manifest[annotatedExportKey].assets ?? []),
  ...(manifest[ocrAssetsKey].assets ?? []),
]) {
  if (indexHtml.includes(forbidden)) {
    throw new Error(
      `Lazy production resource was preloaded by index.html: ${forbidden}`,
    );
  }
}

console.log(
  [
    'Verified production performance budgets:',
    `${formatKib(startupJavaScriptBytes)} KiB startup JS`,
    `${formatKib(startupCssBytes)} KiB startup CSS`,
    'Viewer/PDF.js, fontkit/font, and OCR remain lazy.',
  ].join(' '),
);

function collectStaticImports(rootKey, records) {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const record = records[key];
    if (!record) throw new Error(`Manifest import is missing: ${key}`);
    visited.add(key);
    for (const importedKey of record.imports ?? []) visit(importedKey);
  };
  visit(rootKey);
  return visited;
}

function requireManifestKey(key) {
  if (!manifest[key]) throw new Error(`Required manifest entry is missing: ${key}`);
  return key;
}

function requireManifestKeyByName(name) {
  const key = Object.keys(manifest).find(
    (candidate) => manifest[candidate]?.name === name,
  );
  if (!key) throw new Error(`Required manifest chunk is missing: ${name}`);
  return key;
}

async function totalBytes(files) {
  const sizes = await Promise.all(files.map(fileBytes));
  return sizes.reduce((total, size) => total + size, 0);
}

async function fileBytes(file) {
  return (await stat(resolve(DIST_DIRECTORY, file))).size;
}

function assertBudget(label, bytes, maximum) {
  if (bytes > maximum) {
    throw new Error(
      `${label} exceeded its production budget: ${formatKib(bytes)} KiB > ${formatKib(maximum)} KiB.`,
    );
  }
}

function formatKib(bytes) {
  return (bytes / KIB).toFixed(1);
}
