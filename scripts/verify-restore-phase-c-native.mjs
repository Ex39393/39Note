import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
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

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: browser command timed out.`));
      }, 30_000);
      this.pending.set(id, { reject, resolve, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const profile = await mkdtemp(join(tmpdir(), '39note-phase-c-native-'));
const devToolsPortFile = join(profile, 'DevToolsActivePort');
const browserStartupTimeoutMs = process.env.CI === 'true' ? 60_000 : 15_000;
const port = await reserveLoopbackPort();
const server = await createServer({
  appType: 'spa',
  envFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port, strictPort: true },
});

let browser;
let cdp;
let browserStderr = '';
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('The isolated Vite server did not expose a loopback port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/tests/fixtures/restorePhaseCNativeBrowser.html`;
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
    (await waitForFile(devToolsPortFile, browserStartupTimeoutMs, browser)).split(
      /\r?\n/u,
    )[0],
  );
  const target = await waitForPageTarget(
    debugPort,
    'about:blank',
    browserStartupTimeoutMs,
    browser,
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__39noteNativeUncaught = [];
      addEventListener('error', (event) => {
        globalThis.__39noteNativeUncaught.push(String(event.error?.message ?? event.message ?? 'error'));
      });
      addEventListener('unhandledrejection', (event) => {
        globalThis.__39noteNativeUncaught.push(String(event.reason?.message ?? event.reason ?? 'rejection'));
      });
    `,
  });
  const navigation = await cdp.send('Page.navigate', { url });
  if (navigation.errorText) {
    throw new Error(`The isolated fixture could not load: ${navigation.errorText}`);
  }
  const result = await waitForRuntimeValue(
    cdp,
    `(() => {
      const summary = document.querySelector('#summary');
      return {
        result: summary?.dataset.phaseCResult ?? null,
        text: summary?.textContent ?? null,
        details: document.querySelector('#details')?.textContent ?? null,
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      };
    })()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    120_000,
  );
  if (result.result !== 'PASS') {
    throw new Error(
      `Native Phase C checks failed: ${result.text ?? 'no result'}\n${result.details ?? ''}\n${browserStderr.slice(-2_000)}`,
    );
  }
  assertOnlySameOriginResources(result.resources, origin);

  const appNavigation = await cdp.send('Page.navigate', { url: `${origin}/` });
  if (appNavigation.errorText) {
    throw new Error(
      `The isolated production application could not load: ${appNavigation.errorText}`,
    );
  }
  const appResult = await waitForRuntimeValue(
    cdp,
    `(() => ({
      mounted: Boolean(document.querySelector('.app-content')) && !document.querySelector('.workspace-security-startup-error'),
      startupText: document.querySelector('.workspace-security-startup-error')?.textContent ?? null,
      uncaught: globalThis.__39noteNativeUncaught ?? [],
      resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    }))()`,
    (value) => value?.mounted === true || value?.uncaught?.length > 0,
    60_000,
  );
  if (!appResult.mounted || appResult.uncaught.length > 0) {
    throw new Error(
      `Isolated production startup failed: ${appResult.startupText ?? 'application did not mount'}; uncaught=${JSON.stringify(appResult.uncaught)}`,
    );
  }
  assertOnlySameOriginResources(appResult.resources, origin);
  console.log(result.text);
  console.log(result.details);
  console.log('PASS — isolated production startup mounted after restore safety checks');
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
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH ?? '',
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
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : '',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('No local Chrome or Edge executable was found.');
  return executable;
}

async function waitForFile(path, timeoutMs, browserProcess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertBrowserStillRunning(browserProcess, 'debugging startup');
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  assertBrowserStillRunning(browserProcess, 'debugging startup');
  throw new Error('Timed out waiting for Chromium debugging startup.');
}

async function waitForPageTarget(debugPort, expectedUrl, timeoutMs, browserProcess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertBrowserStillRunning(browserProcess, 'page-target startup');
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const target = targets.find(
        (candidate) =>
          candidate.type === 'page' && candidate.url.startsWith(expectedUrl),
      );
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Browser startup is still in progress.
    }
    await delay(50);
  }
  assertBrowserStillRunning(browserProcess, 'page-target startup');
  throw new Error('Timed out waiting for the isolated browser page.');
}

function assertBrowserStillRunning(child, phase) {
  if (!child || (child.exitCode === null && child.signalCode === null)) return;
  throw new Error(
    `Chromium exited during ${phase} (exit code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'}).`,
  );
}

async function waitForRuntimeValue(client, expression, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await evaluateValue(client, expression);
      if (predicate(lastValue)) return lastValue;
    } catch {
      // Navigation/module evaluation is still settling.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for Phase C result: ${JSON.stringify(lastValue)}`);
}

async function evaluateValue(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return response.result?.value;
}

function assertOnlySameOriginResources(resources, origin) {
  const external = resources.filter((resource) => {
    const url = new URL(resource, origin);
    return url.origin !== origin;
  });
  if (external.length > 0) {
    throw new Error(`Unexpected external resources: ${external.join(', ')}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopBrowser(process) {
  if (!process || process.exitCode !== null) return;
  process.kill();
  await Promise.race([
    new Promise((resolve) => process.once('exit', resolve)),
    delay(2_000),
  ]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
