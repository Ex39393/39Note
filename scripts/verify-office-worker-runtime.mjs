import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSimpleDocxFixture,
  createSimplePptxFixture,
} from '../tests/fixtures/ooxmlFixtures.ts';

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', rejectOpen, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        if (
          message.method === 'Inspector.targetCrashed' ||
          message.method === 'Inspector.detached' ||
          message.method === 'Target.targetCrashed'
        ) {
          this.rejectPending('The browser test page crashed.');
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeoutId);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      this.rejectPending('The browser debugging connection closed.');
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`${method}: browser command timed out.`));
      }, 30_000);
      this.pending.set(id, {
        method,
        reject: rejectSend,
        resolve: resolveSend,
        timeoutId,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(repoRoot, 'dist');
const temporaryRoot = await mkdtemp(join(tmpdir(), '39note-office-worker-'));
const browserProfile = join(temporaryRoot, 'browser-profile');
const devToolsPortFile = join(browserProfile, 'DevToolsActivePort');
let browserProcess;
let browserStderr = '';
let cdp;
let server;

try {
  const indexHtml = await readFile(join(distRoot, 'index.html'), 'utf8');
  const assets = await readdir(join(distRoot, 'assets'));
  assert.ok(
    assets.some((name) => /^officeConversion\.worker-.+\.js$/u.test(name)),
    'The production build has no hashed Office conversion worker.',
  );

  const basePath = inferBasePath(indexHtml);
  server = await startStaticServer(distRoot, basePath);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const appUrl = `http://127.0.0.1:${address.port}${basePath}`;

  const docxPath = join(temporaryRoot, 'worker-runtime.docx');
  const pptxPath = join(temporaryRoot, 'worker-runtime.pptx');
  const cjkDocxPath = join(temporaryRoot, 'worker-runtime-chinese.docx');
  const cjkPptxPath = join(temporaryRoot, 'worker-runtime-chinese.pptx');
  const invalidDocxPath = join(temporaryRoot, 'invalid-worker-runtime.docx');
  await Promise.all([
    writeFile(docxPath, await createSimpleDocxFixture()),
    writeFile(pptxPath, await createSimplePptxFixture()),
    writeFile(
      cjkDocxPath,
      await createSimpleDocxFixture({
        documentXml: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>简体中文與繁體中文 cognitive neuroscience 2026</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
      }),
    ),
    writeFile(
      cjkPptxPath,
      await createSimplePptxFixture({
        slideCount: 1,
        slideTexts: ['中文認知神經科學 cognitive neuroscience 2026'],
      }),
    ),
    writeFile(invalidDocxPath, new TextEncoder().encode('not an OOXML package')),
    mkdir(browserProfile, { recursive: true }),
  ]);

  const browserPath = await findBrowserExecutable();
  browserProcess = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-dev-shm-usage',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-sandbox',
      '--no-default-browser-check',
      '--no-first-run',
      '--password-store=basic',
      '--remote-debugging-port=0',
      `--user-data-dir=${browserProfile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  browserProcess.stderr?.on('data', (chunk) => {
    browserStderr = `${browserStderr}${String(chunk)}`.slice(-16_384);
  });

  const debugPort = Number(
    (await waitForFile(devToolsPortFile, 15_000)).split(/\r?\n/u)[0],
  );
  assert.ok(Number.isInteger(debugPort) && debugPort > 0);
  const target = await waitForPageTarget(debugPort, 'about:blank', 15_000);
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send('DOM.enable'),
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
  ]);

  const docx = await verifyConversion(
    cdp,
    appUrl,
    docxPath,
    'docx',
    server.requestPaths,
  );
  const pptx = await verifyConversion(
    cdp,
    appUrl,
    pptxPath,
    'pptx',
    server.requestPaths,
  );
  assert.equal(docx.loadedCjkFont, false, 'Latin DOCX eagerly loaded the CJK font.');
  assert.equal(pptx.loadedCjkFont, false, 'Latin PPTX eagerly loaded the CJK font.');
  const cjkDocx = await verifyConversion(
    cdp,
    appUrl,
    cjkDocxPath,
    'docx',
    server.requestPaths,
  );
  const cjkPptx = await verifyConversion(
    cdp,
    appUrl,
    cjkPptxPath,
    'pptx',
    server.requestPaths,
  );
  assert.equal(
    cjkDocx.loadedCjkFont,
    true,
    'Chinese DOCX did not load local CJK font.',
  );
  assert.equal(
    cjkPptx.loadedCjkFont,
    true,
    'Chinese PPTX did not load local CJK font.',
  );
  await verifyCleanFailure(cdp, appUrl, invalidDocxPath);
  console.log(
    `Verified bundled Office worker: DOCX ${docx.elapsedMs} ms; PPTX ${pptx.elapsedMs} ms; Chinese DOCX ${cjkDocx.elapsedMs} ms; Chinese PPTX ${cjkPptx.elapsedMs} ms; CJK font stayed local and lazy; selectable text preserved; failure remained clean.`,
  );
} catch (error) {
  if (browserStderr.trim()) {
    console.error(`Browser diagnostics:\n${browserStderr.trim()}`);
  }
  throw error;
} finally {
  if (cdp) {
    await Promise.race([
      cdp.send('Browser.close').catch(() => undefined),
      delay(2_000),
    ]);
    cdp.close();
  }
  await stopBrowser(browserProcess);
  browserProcess?.stderr?.destroy();
  if (server) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  await removeTemporaryRoot(temporaryRoot);
}

async function verifyConversion(
  client,
  appUrl,
  filePath,
  sourceType,
  serverRequestPaths,
) {
  await client.send('Page.navigate', { url: appUrl });
  await waitForRuntimeValue(
    client,
    `document.readyState === 'complete' && Boolean(document.querySelector('input[type="file"]'))`,
    Boolean,
    15_000,
  );
  const persistenceBefore = await capturePaperPersistence(client);
  assert.equal(persistenceBefore.documentStates, 0);
  assert.equal(persistenceBefore.sourceFiles, 0);

  const document = await client.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  const input = await client.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  });
  assert.ok(input.nodeId, 'The production app has no Office/PDF file input.');
  await client.send('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: input.nodeId,
  });

  const selectedFileName = basename(filePath);
  await waitForRuntimeValue(
    client,
    `document.body.innerText.includes(${JSON.stringify(`Selected: ${selectedFileName}`)})`,
    Boolean,
    10_000,
  );
  const clicked = await evaluateValue(
    client,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Convert locally',
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert.equal(clicked, true, 'The converter action was not available.');

  const expectedPdfName = selectedFileName.replace(/\.(?:docx|pptx)$/iu, '.pdf');
  const startedAt = Date.now();
  const result = await waitForRuntimeValue(
    client,
    `(() => {
      const text = document.body.innerText;
      return {
        ready: text.includes(${JSON.stringify(`${expectedPdfName} is ready`)}),
        selectable: text.includes('Selectable text was preserved.'),
        error: document.querySelector('[role="alert"]')?.textContent ?? null,
      };
    })()`,
    (value) => value?.ready || value?.error,
    30_000,
  );
  assert.equal(result.error, null, `${sourceType.toUpperCase()} conversion failed.`);
  assert.equal(result.ready, true);
  assert.equal(result.selectable, true);
  assert.deepEqual(
    await capturePaperPersistence(client),
    persistenceBefore,
    `${sourceType.toUpperCase()} conversion persisted a paper before Add PDF.`,
  );

  const loadedResources = await evaluateValue(
    client,
    `performance
      .getEntriesByType('resource')
      .map((entry) => ({
        origin: new URL(entry.name).origin,
        path: new URL(entry.name).pathname,
      }))`,
  );
  const workerAssets = loadedResources
    .map((resource) => resource.path)
    .filter((path) => path.includes('officeConversion.worker-'));
  assert.ok(
    workerAssets.some((path) =>
      /\/assets\/officeConversion\.worker-.+\.js$/u.test(path),
    ),
    'The conversion did not load the production Office worker chunk.',
  );
  assert.ok(
    loadedResources.every((resource) => resource.origin === new URL(appUrl).origin),
    'Office conversion loaded a cross-origin runtime asset.',
  );
  return {
    elapsedMs: Date.now() - startedAt,
    loadedCjkFont: serverRequestPaths.some((path) =>
      /\/assets\/NotoSansSC_400Regular-.+\.ttf$/u.test(path),
    ),
  };
}

async function verifyCleanFailure(client, appUrl, filePath) {
  await client.send('Page.navigate', { url: appUrl });
  await waitForRuntimeValue(
    client,
    `document.readyState === 'complete' && Boolean(document.querySelector('input[type="file"]'))`,
    Boolean,
    15_000,
  );
  const persistenceBefore = await capturePaperPersistence(client);
  assert.equal(persistenceBefore.documentStates, 0);
  assert.equal(persistenceBefore.sourceFiles, 0);
  const document = await client.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  });
  const input = await client.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type="file"]',
  });
  assert.ok(input.nodeId, 'The production app has no Office/PDF file input.');
  await client.send('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: input.nodeId,
  });
  await waitForRuntimeValue(
    client,
    `document.body.innerText.includes(${JSON.stringify(`Selected: ${basename(filePath)}`)})`,
    Boolean,
    10_000,
  );
  const clicked = await evaluateValue(
    client,
    `(() => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Convert locally',
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert.equal(clicked, true, 'The converter action was not available.');
  const error = await waitForRuntimeValue(
    client,
    `document.querySelector('[role="alert"]')?.textContent ?? null`,
    (value) => typeof value === 'string' && value.length > 0,
    15_000,
  );
  assert.doesNotMatch(
    error,
    /TypeError|ReferenceError|RangeError|DOMException|DataCloneError|pdfBytes|Cannot read properties|reamkit|(?:\bat\s+\S+\s*\()|(?:[A-Za-z]:\\|\/src\/)/iu,
  );
  const failureUi = await evaluateValue(
    client,
    `(() => {
      const labels = Array.from(document.querySelectorAll('button')).map(
        (button) => button.textContent?.trim(),
      );
      return {
        resultVisible: Boolean(document.querySelector('.office-converter-result')),
        addVisible: labels.includes('Add PDF to 39Note'),
        downloadVisible: labels.includes('Download PDF'),
      };
    })()`,
  );
  assert.deepEqual(failureUi, {
    resultVisible: false,
    addVisible: false,
    downloadVisible: false,
  });
  assert.deepEqual(
    await capturePaperPersistence(client),
    persistenceBefore,
    'Failed conversion persisted a Library record or source file.',
  );
}

async function capturePaperPersistence(client) {
  return evaluateValue(
    client,
    `(async () => {
      const databaseName = '39note-db';
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === databaseName)) {
        return { exists: false, documentStates: 0, sourceFiles: 0 };
      }
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.addEventListener('success', () => resolve(request.result), { once: true });
        request.addEventListener('error', () => reject(request.error), { once: true });
      });
      try {
        const transaction = database.transaction(
          ['document-states', 'pdf-files'],
          'readonly',
        );
        const count = (storeName) => new Promise((resolve, reject) => {
          const request = transaction.objectStore(storeName).count();
          request.addEventListener('success', () => resolve(request.result), { once: true });
          request.addEventListener('error', () => reject(request.error), { once: true });
        });
        const [documentStates, sourceFiles] = await Promise.all([
          count('document-states'),
          count('pdf-files'),
        ]);
        return { exists: true, documentStates, sourceFiles };
      } finally {
        database.close();
      }
    })()`,
  );
}

function inferBasePath(indexHtml) {
  const assetUrl = indexHtml.match(/\b(?:src|href)="([^"]*\/assets\/[^"]+)"/u)?.[1];
  assert.ok(assetUrl, 'Unable to infer the production base path.');
  const pathname = new URL(assetUrl, 'http://39note.invalid/').pathname;
  return pathname.replace(/assets\/.*$/u, '') || '/';
}

async function startStaticServer(root, basePath) {
  const rootPrefix = `${resolve(root)}${sep}`;
  const requestPaths = [];
  const staticServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      requestPaths.push(requestUrl.pathname);
      let relativePath = decodeURIComponent(requestUrl.pathname);
      if (basePath !== '/' && relativePath.startsWith(basePath)) {
        relativePath = relativePath.slice(basePath.length);
      } else {
        relativePath = relativePath.replace(/^\/+/, '');
      }
      if (!relativePath || !extname(relativePath)) relativePath = 'index.html';
      const target = resolve(root, relativePath);
      if (target !== resolve(root) && !target.startsWith(rootPrefix)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(target);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentType(target),
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    staticServer.once('error', rejectListen);
    staticServer.listen(0, '127.0.0.1', resolveListen);
  });
  staticServer.requestPaths = requestPaths;
  return staticServer;
}

function contentType(path) {
  switch (extname(path)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.ttf':
      return 'font/ttf';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome',
    process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/chromium',
    process.platform === 'win32'
      ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      : '/usr/bin/chromium-browser',
    process.platform === 'win32'
      ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next locally installed browser.
    }
  }
  throw new Error(
    'Chrome or Edge is required. Set CHROME_PATH to run the bundled Office worker check.',
  );
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${basename(path)}.`);
}

async function waitForPageTarget(debugPort, appUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find(
        (candidate) => candidate.type === 'page' && candidate.url.startsWith(appUrl),
      );
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Browser startup is still in progress.
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for the browser test page.');
}

async function waitForRuntimeValue(client, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluateValue(client, expression);
    if (predicate(lastValue)) return lastValue;
    await delay(50);
  }
  throw new Error(`Browser condition timed out: ${JSON.stringify(lastValue)}`);
}

async function evaluateValue(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error('The browser runtime check raised an exception.');
  }
  return response.result.value;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  if (await waitForChildExit(child, 5_000)) return;
  child.kill();
  await waitForChildExit(child, 5_000);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeoutId = setTimeout(() => {
      child.removeListener('exit', handleExit);
      resolveExit(false);
    }, timeoutMs);
    const handleExit = () => {
      clearTimeout(timeoutId);
      resolveExit(true);
    };
    child.once('exit', handleExit);
  });
}

async function removeTemporaryRoot(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'EBUSY' && error.code !== 'EPERM') ||
        attempt === 19
      ) {
        throw error;
      }
      await delay(100);
    }
  }
}
