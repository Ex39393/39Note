import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path: string) => JSON.parse(source(path)) as Record<string, unknown>;

test('release metadata identifies version 1.0.0 without granting an open-source license', () => {
  const applicationPackage = json('../package.json');
  const applicationLock = json('../package-lock.json');
  const workerPackage = json('../sync-worker/package.json');
  const workerLock = json('../sync-worker/package-lock.json');

  assert.equal(applicationPackage.version, '1.0.0');
  assert.equal(applicationPackage.license, 'UNLICENSED');
  assert.equal(workerPackage.version, '1.0.0');
  assert.equal(workerPackage.license, 'UNLICENSED');
  assert.equal(
    (applicationLock.packages as Record<string, Record<string, unknown>>)[''].version,
    '1.0.0',
  );
  assert.equal(
    (applicationLock.packages as Record<string, Record<string, unknown>>)[''].license,
    'UNLICENSED',
  );
  assert.equal(
    (workerLock.packages as Record<string, Record<string, unknown>>)[''].version,
    '1.0.0',
  );
  assert.equal(
    (workerLock.packages as Record<string, Record<string, unknown>>)[''].license,
    'UNLICENSED',
  );
});

test('rights-reserved notice is explicit and does not override third-party licenses', () => {
  const license = source('../LICENSE');
  const readme = source('../README.md');

  assert.match(license, /Copyright \(c\) 2026 Ex39393\. All rights reserved\./u);
  assert.match(license, /not licensed for public reuse/u);
  assert.match(license, /not open-source software/u);
  assert.match(license, /Third-party software, fonts, data, models/u);
  assert.match(license, /public\/licenses/u);
  assert.match(license, /public\/dictionary\/WORDNET-LICENSE\.txt/u);
  assert.match(license, /public\/pdfjs-wasm/u);
  assert.match(license, /DICTIONARY_SOURCES\.md/u);
  assert.match(readme, /## License/u);
  assert.match(readme, /publicly viewable but\s+are not licensed for reuse/u);
});

test('production deployment workflows fail closed at their release boundaries', () => {
  const pagesWorkflow = source('../.github/workflows/deploy-pages.yml');
  const workerWorkflow = source('../.github/workflows/deploy-sync-worker.yml');

  assert.match(
    pagesWorkflow,
    /permissions:\r?\n {2}contents: read\r?\n\r?\nconcurrency:/u,
  );
  assert.match(
    pagesWorkflow,
    /deploy:\r?\n {4}if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/master' \}\}\r?\n {4}permissions:\r?\n {6}pages: write\r?\n {6}id-token: write/u,
  );
  assert.match(
    pagesWorkflow,
    /if \[\[ "\$SYNC_AUTH_URL" != "https:\/\/39note-sync-auth\.39note\.workers\.dev" \]\]; then/u,
  );
  assert.match(
    workerWorkflow,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/master' && vars\.SYNC_WORKER_DEPLOY_ENABLED == 'true' \}\}/u,
  );
});
