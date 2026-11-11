import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the native matrix runs UI and restore checks in both Chrome and Edge', () => {
  const matrix = source('../scripts/verify-browser-matrix-native.mjs');

  assert.match(matrix, /id: 'targeted-purge'/u);
  assert.match(matrix, /id: 'restore-phase-b'/u);
  assert.match(matrix, /id: 'restore-phase-c'/u);
  assert.match(
    matrix,
    /for \(const browser of browsers\)[\s\S]*for \(const verifier of verifiers\)/u,
  );
  assert.match(matrix, /CHROME_PATH: executable/u);
});

test('both restore verifiers honor the matrix browser before local fallbacks', () => {
  for (const path of [
    '../scripts/verify-restore-phase-b-native.mjs',
    '../scripts/verify-restore-phase-c-native.mjs',
  ]) {
    const verifier = source(path);
    assert.match(
      verifier,
      /const candidates = \[\s*process\.env\.CHROME_PATH \?\? ''/u,
      `${path} must prefer the browser selected by the matrix`,
    );
  }
});

test('all native verifiers tolerate CI browser cold starts and diagnose early exits', () => {
  for (const path of [
    '../scripts/verify-targeted-purge-home-native.mjs',
    '../scripts/verify-restore-phase-b-native.mjs',
    '../scripts/verify-restore-phase-c-native.mjs',
  ]) {
    const verifier = source(path);
    assert.match(
      verifier,
      /const browserStartupTimeoutMs = process\.env\.CI === 'true' \? 60_000 : 15_000/u,
      `${path} must allow a bounded hosted-runner cold start`,
    );
    assert.match(
      verifier,
      /waitForFile\(devToolsPortFile, browserStartupTimeoutMs, browser\)/u,
      `${path} must observe the browser while waiting for its debugging port`,
    );
    assert.match(
      verifier,
      /waitForPageTarget\([\s\S]*?browserStartupTimeoutMs,[\s\S]*?browser,[\s\S]*?\)/u,
      `${path} must retain the same bounded startup contract for its page target`,
    );
    assert.match(verifier, /function assertBrowserStillRunning\(child, phase\)/u);
    assert.match(verifier, /child\.exitCode[\s\S]*child\.signalCode/u);
  }
});

test('the UI verifier covers compact controls, stale state, and explicit local OCR', () => {
  const verifier = source('../scripts/verify-targeted-purge-home-native.mjs');

  assert.match(verifier, /39note\.reader-tools-open', 'true'/u);
  assert.match(verifier, /reloaded Reader starts with Reader Tools closed/u);
  assert.match(verifier, /responsiveReaderBrowser\.html/u);
  assert.match(verifier, /responsive-toolbar-mobile/u);
  assert.match(verifier, /pdfTextAvailabilityBrowser\.html/u);
  assert.match(verifier, /synthetic image-only page classification/u);
  assert.match(verifier, /imageOnlyOcrStatus/u);
  assert.match(verifier, /selectable local OCR words/u);
  assert.match(verifier, /PDF text fixture cross-origin request count/u);
  assert.match(verifier, /joined annotation lines/u);
  assert.match(verifier, /safely completed a mixed whole document/u);
  assert.match(verifier, /width: 390,[\s\S]*height: 844/u);
});

test('the PDF OCR fixture waits for its rendered text layer after ready state', () => {
  const fixture = source('./fixtures/pdfTextAvailabilityBrowser.tsx');
  const readyStateWait = fixture.indexOf("imagePage.dataset.pdfOcrStatus === 'ready'");
  const renderedLayerWait = fixture.indexOf('dataset.pdfOcrTextLayer');
  const wordCountAssertion = fixture.indexOf('ocrWords.length >= 10');

  assert.ok(readyStateWait >= 0, 'the fixture must wait for the typed OCR ready state');
  assert.ok(
    renderedLayerWait > readyStateWait,
    'the fixture must then wait for the passive text-layer render',
  );
  assert.ok(
    wordCountAssertion > renderedLayerWait,
    'the strict recognized-word assertion must run after DOM readiness',
  );
  assert.match(fixture, /latestOcrResult !== null/u);
  assert.match(
    fixture,
    /OCR reached ready state before its rendered text layer became available\./u,
  );
});

test('CI relies on the complete matrix without duplicate default-browser restore runs', () => {
  for (const path of [
    '../.github/workflows/validate-pull-request.yml',
    '../.github/workflows/deploy-pages.yml',
  ]) {
    const workflow = source(path);
    assert.match(workflow, /Run Chrome and Edge recovery\/browser matrix/u);
    assert.equal(
      workflow.includes('npm run restore-phase-b:native'),
      false,
      `${path} must not rerun Phase B in only the default browser`,
    );
    assert.equal(
      workflow.includes('npm run restore-phase-c:native'),
      false,
      `${path} must not rerun Phase C in only the default browser`,
    );
  }
});

test('the production smoke loads the real build and keeps optional heavy assets idle', () => {
  const verifier = source('../scripts/verify-production-app-native.mjs');
  const packageJson = source('../package.json');

  assert.match(verifier, /distDirectory/u);
  assert.match(verifier, /button\.home-floating-button/u);
  assert.match(verifier, /default Reader requested its lazy Viewer chunk/u);
  assert.match(verifier, /default Reader requested PDF\.js/u);
  assert.match(verifier, /production cross-origin request count/u);
  assert.match(verifier, /production non-GET request count/u);
  assert.match(verifier, /Targeted purge visibility predicate matrix/u);
  assert.match(verifier, /forbiddenIdleResources/u);
  assert.match(packageJson, /"production-app:native"/u);

  for (const path of [
    '../.github/workflows/validate-pull-request.yml',
    '../.github/workflows/deploy-pages.yml',
  ]) {
    const workflow = source(path);
    assert.match(
      workflow,
      /Build static application[\s\S]*Smoke-test the production application/u,
    );
    assert.match(workflow, /run: npm run production-app:native/u);
  }
});

test('production build budgets preserve the lazy Reader, export, and OCR boundaries', () => {
  const appLayout = source('../src/components/AppLayout.tsx');
  const viteConfig = source('../vite.config.ts');
  const verifier = source('../scripts/verify-production-performance.mjs');
  const packageJson = source('../package.json');

  assert.match(appLayout, /const Viewer = lazy\(\(\) =>[\s\S]*import\('\.\/Viewer'\)/u);
  assert.match(appLayout, /<Suspense[\s\S]*Opening Reader…[\s\S]*<Viewer/u);
  assert.match(viteConfig, /chunkSizeWarningLimit: 750/u);
  assert.match(viteConfig, /manifest: true/u);
  assert.match(verifier, /startupJavaScript: 600 \* KIB/u);
  assert.match(verifier, /lazyViewer: 130 \* KIB/u);
  assert.match(verifier, /lazyPdfJs: 500 \* KIB/u);
  assert.match(verifier, /lazyFontkit: 750 \* KIB/u);
  assert.match(verifier, /unexpectedly entered the production startup graph/u);
  assert.match(verifier, /Lazy production resource was preloaded by index\.html/u);
  assert.match(packageJson, /verify-production-performance\.mjs/u);
});
