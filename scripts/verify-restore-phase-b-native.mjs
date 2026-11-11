import { spawn } from 'node:child_process';
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

const profile = await mkdtemp(join(tmpdir(), '39note-phase-b-native-'));
const devToolsPortFile = join(profile, 'DevToolsActivePort');
const browserStartupTimeoutMs = process.env.CI === 'true' ? 60_000 : 15_000;
const port = await reserveLoopbackPort();
const server = await createServer({
  appType: 'spa',
  configFile: false,
  envFile: false,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
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
  const url = `${origin}/tests/fixtures/restorePhaseBNativeBrowser.html`;
  const executable = chromeExecutable();
  browser = spawn(
    executable,
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
  if (!Number.isInteger(debugPort) || debugPort <= 0) {
    throw new Error('Chromium returned an invalid debugging port.');
  }
  const target = await waitForPageTarget(
    debugPort,
    'about:blank',
    browserStartupTimeoutMs,
    browser,
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  const navigation = await cdp.send('Page.navigate', { url });
  if (navigation.errorText) {
    throw new Error(`The isolated fixture could not load: ${navigation.errorText}`);
  }
  const result = await waitForRuntimeValue(
    cdp,
    `(() => {
      const summary = document.querySelector('#summary');
      return {
        result: summary?.dataset.phaseBResult ?? null,
        text: summary?.textContent ?? null,
        failures: Array.from(document.querySelectorAll('[data-outcome="FAIL"]')).map((item) => item.textContent),
        details: document.querySelector('#details')?.textContent ?? null,
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      };
    })()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    60_000,
  );
  if (result.result !== 'PASS') {
    throw new Error(
      `Native Phase B checks failed: ${result.text ?? 'no result'}\n${result.failures.join('\n')}\n${result.details ?? ''}\n${browserStderr.slice(-2_000)}`,
    );
  }
  assertOnlySameOriginResources(result.resources, origin);

  const reloadNavigation = await cdp.send('Page.navigate', {
    url: `${origin}/tests/fixtures/restorePhaseBReloadBrowser.html`,
  });
  if (reloadNavigation.errorText) {
    throw new Error(
      `The isolated reload fixture could not load: ${reloadNavigation.errorText}`,
    );
  }
  const reloadResult = await waitForRuntimeValue(
    cdp,
    `(() => {
      const summary = document.querySelector('#summary');
      return {
        result: summary?.dataset.phaseBResult ?? null,
        text: summary?.textContent ?? null,
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      };
    })()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    60_000,
  );
  if (reloadResult.result !== 'PASS') {
    throw new Error(
      `Native Phase B reload check failed: ${reloadResult.text ?? 'no result'}\n${browserStderr.slice(-2_000)}`,
    );
  }
  assertOnlySameOriginResources(reloadResult.resources, origin);
  console.log('PASS — 9/9 native production checks');
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
  await removeTemporaryProfile(profile);
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
    process.platform === 'win32'
      ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      : '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (process.getBuiltinModule('node:fs').existsSync(candidate)) return candidate;
    } catch {
      // Continue to the next qualified local browser.
    }
  }
  throw new Error('No local Chrome or Edge executable was found for native checks.');
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
    } catch (error) {
      if (
        !/context.*(?:destroyed|not found)|Cannot find context/iu.test(String(error))
      ) {
        throw error;
      }
      await delay(50);
      continue;
    }
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
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertOnlySameOriginResources(resources, expectedOrigin) {
  const externalResources = resources.filter(
    (resource) => new URL(resource).origin !== expectedOrigin,
  );
  if (externalResources.length > 0) {
    throw new Error(
      `The isolated fixture requested external resources:\n${externalResources.join('\n')}`,
    );
  }
}

async function stopBrowser(child) {
  if (!child || child.exitCode !== null) return;
  if (await waitForChildExit(child, 5_000)) return;
  child.kill();
  await waitForChildExit(child, 5_000);
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

async function removeTemporaryProfile(path) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { force: true, recursive: true });
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

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not reserve an isolated loopback port.'));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}
