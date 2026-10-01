import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function verifyBuiltPdfRuntime(root = projectRoot) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedVersion = manifest.dependencies?.['pdfjs-dist'];
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/u);

  const distDirectory = join(root, 'dist');
  const assetsDirectory = join(distDirectory, 'assets');
  assert.equal(
    existsSync(join(distDirectory, 'index.html')),
    true,
    'production index.html is missing',
  );
  assert.equal(existsSync(assetsDirectory), true, 'production assets are missing');

  const assetNames = readdirSync(assetsDirectory).filter((name) =>
    statSync(join(assetsDirectory, name)).isFile(),
  );
  const apiBundles = assetNames.filter((name) => /^pdfjs-.*\.js$/u.test(name));
  const workerBundles = assetNames.filter((name) =>
    /^pdf\.worker\.min-.*\.mjs$/u.test(name),
  );
  assert.equal(apiBundles.length, 1, 'expected one production PDF.js API chunk');
  assert.ok(workerBundles.length >= 1, 'production PDF.js worker asset is missing');

  for (const name of [...apiBundles, ...workerBundles]) {
    const source = readFileSync(join(assetsDirectory, name), 'utf8');
    assert.match(
      source,
      new RegExp(escapeRegExp(expectedVersion), 'u'),
      `${name} does not embed PDF.js ${expectedVersion}`,
    );
  }

  const referencingSources = assetNames
    .filter((name) => /\.(?:js|mjs)$/u.test(name) && !workerBundles.includes(name))
    .map((name) => readFileSync(join(assetsDirectory, name), 'utf8'));
  for (const workerBundle of workerBundles) {
    assert.equal(
      referencingSources.some((source) => source.includes(workerBundle)),
      true,
      `${workerBundle} is emitted but unreachable from the production graph`,
    );
  }

  const indexHtml = readFileSync(join(distDirectory, 'index.html'), 'utf8');
  const entryMatch = indexHtml.match(
    /<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/u,
  );
  assert.ok(entryMatch, 'production entry script is missing');
  const deploymentBase = entryMatch[1].slice(0, entryMatch[1].lastIndexOf('assets/'));
  const localAssetUrls = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/gu)]
    .map((match) => match[1])
    .filter((url) => url.includes('/assets/'));
  assert.ok(localAssetUrls.length > 0);
  assert.equal(
    localAssetUrls.every((url) => url.startsWith(deploymentBase)),
    true,
    'production entry assets do not share the configured deployment base',
  );

  const installedWasmDirectory = join(root, 'node_modules', 'pdfjs-dist', 'wasm');
  const builtWasmDirectory = join(distDirectory, 'pdfjs-wasm');
  const installedWasmFiles = readdirSync(installedWasmDirectory).sort();
  assert.deepEqual(readdirSync(builtWasmDirectory).sort(), installedWasmFiles);
  for (const name of installedWasmFiles) {
    assert.equal(
      sha256(join(builtWasmDirectory, name)),
      sha256(join(installedWasmDirectory, name)),
      `built ${name} does not match PDF.js ${expectedVersion}`,
    );
  }

  return {
    version: expectedVersion,
    apiBundles,
    workerBundles,
    deploymentBase,
    wasmFiles: installedWasmFiles.length,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = verifyBuiltPdfRuntime();
  console.log(
    `Verified PDF.js ${summary.version}: ${summary.apiBundles.length} API chunk, ${summary.workerBundles.length} worker asset(s), ${summary.wasmFiles} support asset(s), base ${summary.deploymentBase}`,
  );
}
