import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview as previewVite } from 'vite';

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveConnection, rejectConnection) => {
      socket.addEventListener('open', resolveConnection, { once: true });
      socket.addEventListener('error', rejectConnection, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('The browser debugging connection closed.'));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveCommand, rejectCommand) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`${method}: browser command timed out.`));
      }, 30_000);
      this.pending.set(id, {
        reject: rejectCommand,
        resolve: resolveCommand,
        timeout,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distDirectory = join(workspace, 'dist');
const manifestPath = join(distDirectory, '.vite', 'manifest.json');
const indexPath = join(distDirectory, 'index.html');
const artifactDirectory = join(workspace, '.codex-artifacts');
const browserLabel = process.env.BROWSER_MATRIX_LABEL?.trim() || 'default';
const safeBrowserLabel = browserLabel.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase();
const screenshotPath = join(
  artifactDirectory,
  `production-app-smoke-${safeBrowserLabel}.png`,
);

assert(existsSync(manifestPath), 'production manifest exists; run npm run build first');
assert(existsSync(indexPath), 'production index exists; run npm run build first');

const [manifestSource, indexHtml] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  readFile(indexPath, 'utf8'),
]);
const manifest = JSON.parse(manifestSource);
const entryKey = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
assert(entryKey, 'production manifest contains an application entry');
const entry = manifest[entryKey];
const viewer = requireManifestRecord('src/components/Viewer.tsx');
const pdfJs = requireManifestRecordByName('pdfjs');
const fontkit = requireManifestRecord(
  'node_modules/@pdf-lib/fontkit/dist/fontkit.es.js',
);
const annotatedExport = requireManifestRecordByName('annotatedPdfExport');
const ocrAssets = requireManifestRecord('src/services/pdfOcrAssets.ts');
const productionBasePath = resolveProductionBasePath(indexHtml, entry.file);
const forbiddenIdleResources = [
  fontkit.file,
  annotatedExport.file,
  ...(annotatedExport.assets ?? []),
  ocrAssets.file,
  ...(ocrAssets.assets ?? []),
];

const profile = await mkdtemp(join(tmpdir(), '39note-production-app-'));
const devToolsPortFile = join(profile, 'DevToolsActivePort');
const previewPort = await reserveLoopbackPort();
let previewServer;
let browser;
let cdp;
let browserStderr = '';
const networkRequests = [];
const runtimeExceptions = [];

try {
  await mkdir(artifactDirectory, { recursive: true });
  previewServer = await previewVite({
    base: productionBasePath,
    build: { outDir: distDirectory },
    configFile: false,
    envFile: false,
    logLevel: 'error',
    preview: {
      host: '127.0.0.1',
      port: previewPort,
      strictPort: true,
    },
    root: workspace,
  });
  const previewAddress = previewServer.httpServer.address();
  if (!previewAddress || typeof previewAddress === 'string') {
    throw new Error('The production preview did not expose a loopback port.');
  }
  const origin = `http://127.0.0.1:${previewAddress.port}`;

  browser = spawn(
    chromeExecutable(),
    [
      '--headless=new',
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-features=OptimizationHints,MediaRouter',
      '--disable-gpu',
      '--disable-popup-blocking',
      '--disable-dev-shm-usage',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (chunk) => {
    browserStderr = `${browserStderr}${chunk}`.slice(-16_384);
  });

  const debugPort = Number(
    (await waitForFile(devToolsPortFile, 15_000)).split(/\r?\n/u)[0],
  );
  const target = await waitForPageTarget(debugPort, 'about:blank', 15_000);
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Network.enable'),
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }),
    cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    }),
  ]);
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (!request?.url) return;
    const requestUrl = safeUrl(request.url);
    if (!requestUrl || !['http:', 'https:'].includes(requestUrl.protocol)) return;
    networkRequests.push({
      method: request.method ?? 'GET',
      origin: requestUrl.origin,
      pathname: requestUrl.pathname,
      url: requestUrl.href,
    });
  });
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    runtimeExceptions.push(
      exceptionDetails?.exception?.description ??
        exceptionDetails?.text ??
        'Unknown production exception',
    );
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__39noteProductionSmoke = { uncaught: [] };
      localStorage.setItem('39note.getting-started.v1', 'completed');
      sessionStorage.removeItem('39note.reader-tools-open');
      addEventListener('error', (event) => {
        globalThis.__39noteProductionSmoke.uncaught.push(
          String(event.error?.message ?? event.message ?? 'error'),
        );
      });
      addEventListener('unhandledrejection', (event) => {
        globalThis.__39noteProductionSmoke.uncaught.push(
          String(event.reason?.message ?? event.reason ?? 'rejection'),
        );
      });
    `,
  });

  const navigation = await cdp.send('Page.navigate', {
    url: new URL(productionBasePath, `${origin}/`).href,
  });
  if (navigation.errorText) {
    throw new Error(
      `The production application could not load: ${navigation.errorText}`,
    );
  }

  const readerState = await waitForRuntimeValue(
    cdp,
    `(() => ({
      mounted: Boolean(document.querySelector('.app-content')),
      readerReady:
        Boolean(document.querySelector('.reader-workspace')) &&
        !document.querySelector('.viewer-loading'),
      startupFailure:
        document.querySelector(
          '.workspace-security-startup-error:not(.is-checking)',
        )?.textContent ?? null,
      text: document.body?.textContent ?? '',
      uncaught: globalThis.__39noteProductionSmoke?.uncaught ?? [],
    }))()`,
    (value) =>
      Boolean(value?.startupFailure) ||
      value?.uncaught?.length > 0 ||
      (value?.mounted === true && value?.readerReady === true),
    60_000,
  );
  assertEqual(readerState.startupFailure, null, 'production startup security failure');
  assertEqual(
    readerState.uncaught.length,
    0,
    'production startup uncaught error count',
  );
  assertNoDevelopmentDiagnostics(readerState.text);

  const openedHome = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button.home-floating-button');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  assertEqual(openedHome, true, 'production Home control is interactive');
  const homeState = await waitForRuntimeValue(
    cdp,
    `(() => ({
      open: Boolean(document.querySelector('.home-workspace.is-open')),
      text: document.body?.textContent ?? '',
      uncaught: globalThis.__39noteProductionSmoke?.uncaught ?? [],
    }))()`,
    (value) => value?.open === true || value?.uncaught?.length > 0,
    30_000,
  );
  assertEqual(homeState.uncaught.length, 0, 'production Home uncaught error count');
  assertNoDevelopmentDiagnostics(homeState.text);

  await delay(750);
  const finalState = await evaluate(
    cdp,
    `(() => ({
      text: document.body?.textContent ?? '',
      uncaught: globalThis.__39noteProductionSmoke?.uncaught ?? [],
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    }))()`,
  );
  assertEqual(finalState.uncaught.length, 0, 'production final uncaught error count');
  assertEqual(runtimeExceptions.length, 0, 'production runtime exception count');
  assertNoDevelopmentDiagnostics(finalState.text);

  const crossOriginRequests = networkRequests.filter(
    (request) => request.origin !== origin,
  );
  assertEqual(
    crossOriginRequests.length,
    0,
    `production cross-origin request count (${crossOriginRequests
      .map((request) => `${request.method} ${request.origin}`)
      .join(', ')})`,
  );
  const nonReadRequests = networkRequests.filter(
    (request) => request.origin === origin && request.method !== 'GET',
  );
  assertEqual(
    nonReadRequests.length,
    0,
    `production non-GET request count (${nonReadRequests
      .map((request) => `${request.method} ${request.pathname}`)
      .join(', ')})`,
  );

  assert(
    requestedAsset(networkRequests, viewer.file),
    'default Reader requested its lazy Viewer chunk',
  );
  assert(
    requestedAsset(networkRequests, pdfJs.file),
    'default Reader requested PDF.js through the lazy Viewer boundary',
  );
  for (const resource of forbiddenIdleResources) {
    assert(
      !requestedAsset(networkRequests, resource),
      `idle production shell did not request ${resource}`,
    );
  }

  const screenshot = await cdp.send('Page.captureScreenshot', {
    captureBeyondViewport: false,
    format: 'png',
    fromSurface: true,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  console.log(
    `PASS — ${browserLabel} loaded the real production Reader and Home with ${networkRequests.length} GET-only same-origin requests`,
  );
  console.log(
    'PASS — production diagnostics stayed absent; fontkit, bundled Unicode font, and OCR assets stayed idle',
  );
  console.log(`Screenshot: ${screenshotPath}`);
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
  await stopBrowser(browser);
  browser?.stderr?.destroy();
  await previewServer?.close();
  await removeTemporaryDirectory(profile);
}

function requireManifestRecord(key) {
  const record = manifest[key];
  assert(record, `production manifest contains ${key}`);
  return record;
}

function requireManifestRecordByName(name) {
  const key = Object.keys(manifest).find(
    (candidate) => manifest[candidate]?.name === name,
  );
  assert(key, `production manifest contains the ${name} chunk`);
  return manifest[key];
}

function resolveProductionBasePath(html, entryFile) {
  const assetReferences = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/giu)].map(
    (match) => match[1],
  );
  const entryReference = assetReferences.find((reference) =>
    reference.includes(entryFile),
  );
  assert(entryReference, 'production index references its manifest entry');
  const pathname = new URL(entryReference, 'http://production.invalid/').pathname;
  const entryOffset = pathname.lastIndexOf(entryFile);
  assert(entryOffset >= 0, 'production entry path resolves under a base path');
  const basePath = pathname.slice(0, entryOffset);
  return basePath.endsWith('/') ? basePath : `${basePath}/`;
}

function assertNoDevelopmentDiagnostics(text) {
  for (const diagnostic of [
    'Targeted purge visibility predicate matrix',
    'Failed predicate:',
  ]) {
    assert(!text.includes(diagnostic), `production UI omits ${diagnostic}`);
  }
}

function requestedAsset(requests, assetPath) {
  const normalizedAsset = `/${assetPath.replaceAll('\\', '/')}`;
  return requests.some((request) => request.pathname.endsWith(normalizedAsset));
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH ?? '',
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    process.env['PROGRAMFILES(X86)']
      ? join(
          process.env['PROGRAMFILES(X86)'],
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        )
      : '',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      'No local Chrome, Chromium, or Edge executable was found. Set CHROME_PATH to run the production smoke check.',
    );
  }
  return executable;
}

async function reserveLoopbackPort() {
  const socket = createNetServer();
  await new Promise((resolveListen, rejectListen) => {
    socket.once('error', rejectListen);
    socket.listen(0, '127.0.0.1', resolveListen);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') {
    socket.close();
    throw new Error('Could not reserve an isolated loopback port.');
  }
  await new Promise((resolveClose) => socket.close(resolveClose));
  return address.port;
}

async function waitForFile(path, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForPageTarget(portNumber, url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/json`);
      const targets = await response.json();
      const page = targets.find(
        (candidate) => candidate.type === 'page' && candidate.url === url,
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The isolated browser is still starting.
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for the isolated production browser target.');
}

async function waitForRuntimeValue(cdpClient, expression, predicate, timeoutMs) {
  const started = Date.now();
  let lastValue;
  while (Date.now() - started < timeoutMs) {
    lastValue = await evaluate(cdpClient, expression);
    if (predicate(lastValue)) return lastValue;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for production browser state. Last value: ${JSON.stringify(lastValue)}`,
  );
}

async function evaluate(cdpClient, expression) {
  const result = await cdpClient.send('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'Production browser evaluation failed.',
    );
  }
  return result.result?.value;
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(2_000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      delay(2_000),
    ]);
  }
}

async function removeTemporaryDirectory(path) {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
