import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildVite, createServer, preview as previewVite } from 'vite';

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
const artifactDirectory = join(workspace, '.codex-artifacts');
const browserArtifactSuffix = process.env.BROWSER_MATRIX_LABEL
  ? `-${process.env.BROWSER_MATRIX_LABEL.replaceAll(/[^a-z0-9-]/giu, '-').toLowerCase()}`
  : '';
const artifactPath = (name) =>
  join(artifactDirectory, `${name}${browserArtifactSuffix}.png`);
const hiddenScreenshot = artifactPath('targeted-purge-hidden');
const staleRuntimeScreenshot = artifactPath('targeted-purge-stale-runtime');
const visibleScreenshot = artifactPath('targeted-purge-visible');
const blockedScreenshot = artifactPath('targeted-purge-blocked');
const conflictScreenshot = artifactPath('targeted-purge-conflict');
const cutoverScreenshot = artifactPath('targeted-purge-cutover');
const resolverScreenshot = artifactPath('targeted-purge-resolver');
const mobileRecoveryScreenshot = artifactPath('production-forget-recovery-mobile');
const responsiveReaderScreenshot = artifactPath('responsive-reader-tools-mobile');
const responsiveToolbarScreenshot = artifactPath('responsive-toolbar-mobile');
const pdfTextAvailabilityScreenshot = artifactPath('pdf-text-availability');
const profile = await mkdtemp(join(tmpdir(), '39note-targeted-purge-home-'));
const productionFixtureDirectory = await mkdtemp(
  join(tmpdir(), '39note-production-recovery-'),
);
const devToolsPortFile = join(profile, 'DevToolsActivePort');
const browserStartupTimeoutMs = process.env.CI === 'true' ? 60_000 : 15_000;
const port = await reserveLoopbackPort();
const server = await createServer({
  appType: 'spa',
  envFile: false,
  logLevel: 'error',
  root: workspace,
  server: { host: '127.0.0.1', port, strictPort: true },
});

let browser;
let cdp;
let productionPreview;
let browserStderr = '';
const allowedNetworkOrigins = new Set();
const externalRequests = [];
const networkRequests = [];
try {
  await mkdir(artifactDirectory, { recursive: true });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    throw new Error('The isolated Vite server did not expose a loopback port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  allowedNetworkOrigins.add(origin);
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
    const networkRequest = {
      method: request.method ?? 'GET',
      origin: requestUrl.origin,
      url: requestUrl.href,
    };
    networkRequests.push(networkRequest);
    if (!allowedNetworkOrigins.has(requestUrl.origin)) {
      externalRequests.push(`${networkRequest.method} ${networkRequest.origin}`);
    }
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__39noteTargetedPurgeNative = {
        uncaught: [],
        blockedFetches: [],
        previewCalls: 0,
        executeCalls: 0,
        previewScenario: 'missing-proof',
      };
      localStorage.setItem('39note.getting-started.v1', 'completed');
      sessionStorage.setItem('39note.reader-tools-open', 'true');
      addEventListener('error', (event) => {
        globalThis.__39noteTargetedPurgeNative.uncaught.push(
          String(event.error?.message ?? event.message ?? 'error'),
        );
      });
      addEventListener('unhandledrejection', (event) => {
        globalThis.__39noteTargetedPurgeNative.uncaught.push(
          String(event.reason?.message ?? event.reason ?? 'rejection'),
        );
      });
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = (input, init) => {
        const raw = input instanceof Request ? input.url : String(input);
        const url = new URL(raw, location.href);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin) {
          globalThis.__39noteTargetedPurgeNative.blockedFetches.push(url.origin);
          return Promise.reject(new Error('External request blocked by isolated targeted-purge verification.'));
        }
        return originalFetch(input, init);
      };
    `,
  });

  const navigation = await cdp.send('Page.navigate', { url: `${origin}/` });
  if (navigation.errorText) {
    throw new Error(`The isolated application could not load: ${navigation.errorText}`);
  }
  const initialReaderState = await waitForRuntimeValue(
    cdp,
    `(() => ({
      mounted: Boolean(document.querySelector('.app-content')) && !document.querySelector('.workspace-security-startup-error'),
      sidebarCollapsed: document.querySelector('.app-layout')?.classList.contains('is-sidebar-collapsed') ?? null,
      startupText: document.querySelector('.workspace-security-startup-error')?.textContent ?? null,
      uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
    }))()`,
    (value) => value?.mounted === true || value?.uncaught?.length > 0,
    60_000,
  );
  assertEqual(
    initialReaderState.sidebarCollapsed,
    true,
    'fresh Reader ignores the stale open-sidebar preference',
  );
  await cdp.send('Page.reload', { ignoreCache: true });
  const reloadedReaderState = await waitForRuntimeValue(
    cdp,
    `(() => ({
      mounted: Boolean(document.querySelector('.app-content')) && !document.querySelector('.workspace-security-startup-error'),
      sidebarCollapsed: document.querySelector('.app-layout')?.classList.contains('is-sidebar-collapsed') ?? null,
      startupText: document.querySelector('.workspace-security-startup-error')?.textContent ?? null,
      uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
    }))()`,
    (value) => value?.mounted === true || value?.uncaught?.length > 0,
    60_000,
  );
  assertEqual(
    reloadedReaderState.sidebarCollapsed,
    true,
    'reloaded Reader starts with Reader Tools closed',
  );

  const injected = await evaluate(
    cdp,
    `(async () => {
      const coordinatorModule = await import('/src/sync/paperCoordinator.ts');
      const repositoryModule = await import('/src/sync/paperDriveRepository.ts');
      const storageModule = await import('/src/sync/storage.ts');
      const coordinator = coordinatorModule.getPaperGoogleDriveSyncCoordinator();
      // Let the isolated profile's real startup settle before installing the
      // synthetic state. Otherwise initializeOnce can legitimately replace the
      // fixture while Home is opening.
      await coordinator.initialize().catch(() => undefined);

      const documentIds = Array.from(
        { length: 23 },
        (_, index) =>
          \`10000000-0000-4000-8000-\${String(index + 1).padStart(12, '0')}\`,
      );
      const affectedDocumentId = documentIds[7];
      const otherDirtyDocumentId = documentIds[18];
      const states = documentIds.map((documentId, index) => {
        const state = storageModule.createDefaultPaperSyncState(
          documentId,
          \`synthetic-device-\${String(index + 1).padStart(2, '0')}\`,
          'local-and-cloud',
        );
        state.status = 'synced';
        state.cloudPresence = 'present';
        state.dirtyGeneration = 0;
        state.dirtyReasons = [];
        state.remoteHeadIds = [\`synthetic-head-\${index + 1}\`];
        state.presenceHeadIds = [\`synthetic-presence-\${index + 1}\`];
        if (documentId === affectedDocumentId) {
          state.status = 'needs-attention';
          state.dirtyGeneration = 1;
          state.dirtyReasons = ['annotations'];
          state.remoteHeadIds = [];
          state.presenceHeadIds = [];
        } else if (documentId === otherDirtyDocumentId) {
          state.status = 'local-changes';
          state.dirtyGeneration = 1;
          state.dirtyReasons = ['notes'];
        }
        return state;
      });
      const papers = states.map((state, index) => ({
        documentId: state.documentId,
        displayName:
          state.documentId === affectedDocumentId
            ? 'Synthetic inaccessible paper'
            : \`Synthetic cloud paper \${index + 1}\`,
        deleted: false,
        paperFolderId: \`synthetic-paper-folder-\${index + 1}\`,
        headIds: [...state.remoteHeadIds],
        headSetId: state.remoteHeadIds.join('|') || 'unavailable',
        presenceState: 'present',
        presenceHeadIds: [...(state.presenceHeadIds ?? [])],
        localAvailability: 'local-and-cloud',
        status: state.status,
        ...(state.documentId === affectedDocumentId
          ? {
              issue: {
                code: 'drive-integrity-mismatch',
                message: 'Drive paper presence data needs verification.',
              },
            }
          : {}),
      }));
      const genericIssue = {
        code: 'drive-integrity-mismatch',
        message: 'Drive paper presence data needs verification.',
        severity: 'error',
        state: 'attention',
        actions: ['retry-now', 'details'],
        retrySafe: true,
        blocksOrdinarySync: true,
        backupRecommended: false,
        diagnostic: {
          source: 'google-drive',
          operation: 'paper-validation',
          documentId: affectedDocumentId,
        },
      };

      coordinator.paperStates.clear();
      for (const state of states) coordinator.paperStates.set(state.documentId, state);
      coordinator.paperRetryIntents.clear();
      coordinator.blockingPaperIssues.clear();
      // This is deliberately the generic persisted block observed after reload.
      // It must not independently satisfy the exact targeted-purge predicate.
      coordinator.blockingPaperIssues.set(affectedDocumentId, { issue: genericIssue });

      globalThis.__39noteTargetedPurgeNative.affectedDocumentId = affectedDocumentId;
      globalThis.__39noteTargetedPurgeNative.otherDirtyDocumentId = otherDirtyDocumentId;
      globalThis.__39noteTargetedPurgeNative.discoverCalls = 0;
      globalThis.__39noteTargetedPurgeNative.inspectionTargets = [];
      globalThis.__39noteTargetedPurgeNative.scanAdmissions = 0;
      globalThis.__39noteTargetedPurgeNative.scanReleases = 0;

      // Configure the already-initialized session for one read-only repository
      // operation. No HTTP client or Drive mutation implementation exists here.
      coordinator.initializationPromise = Promise.resolve();
      coordinator.profile = {};
      coordinator.drive = {};
      coordinator.repository = {
        assertActiveRoot: async () => undefined,
        discoverPapers: async (requestedDocumentIds) => {
          globalThis.__39noteTargetedPurgeNative.discoverCalls += 1;
          globalThis.__39noteTargetedPurgeNative.inspectionTargets = [
            ...requestedDocumentIds,
          ];
          throw new repositoryModule.PaperRepositoryError(
            'paper-presence-invalid',
            'Synthetic presence control resolution failure.',
            {
              diagnosticPhase: 'paper-presence-resolution',
              diagnosticCauseCode: 'presence-control-resolution-failed',
            },
          );
        },
      };
      coordinator.beginOperation = async (operation) => {
        if (operation !== 'scan') {
          throw new Error(\`Unexpected operation admitted: \${operation}\`);
        }
        globalThis.__39noteTargetedPurgeNative.scanAdmissions += 1;
        return new AbortController().signal;
      };
      coordinator.endOperation = () => {
        globalThis.__39noteTargetedPurgeNative.scanReleases += 1;
      };
      coordinator.previewTargetedPaperPurge = async (requestedDocumentId) => {
        globalThis.__39noteTargetedPurgeNative.previewCalls += 1;
        if (requestedDocumentId !== affectedDocumentId) {
          throw new Error('Preview escaped the exact synthetic paper.');
        }
        const scenarios = {
          'missing-proof': {
            validPresenceCount: 2,
            failureCode: 'presence-missing-parent',
            validationStage: 'ancestry',
            topology: {
              status: 'invalid',
              failureCode: 'presence-missing-parent',
              recordCount: 2,
              uniqueGenerationCount: 2,
              rootCount: 1,
              structuralHeadCount: 2,
              weakComponentCount: 2,
              missingParentReferenceCount: 1,
              records: [
                {
                  ordinal: 1,
                  state: 'present',
                  intent: 'migration',
                  parentOrdinals: [],
                  missingParentCount: 0,
                  childCount: 0,
                  root: true,
                  structuralHead: true,
                },
                {
                  ordinal: 2,
                  state: 'removed',
                  intent: 'remove',
                  parentOrdinals: [],
                  missingParentCount: 1,
                  childCount: 0,
                  root: false,
                  structuralHead: true,
                },
              ],
            },
          },
          conflict: {
            validPresenceCount: 2,
            failureCode: 'presence-present-folder-conflict',
            validationStage: 'ancestry',
            topology: {
              status: 'invalid',
              failureCode: 'presence-present-folder-conflict',
              recordCount: 2,
              uniqueGenerationCount: 2,
              rootCount: 2,
              structuralHeadCount: 2,
              weakComponentCount: 2,
              missingParentReferenceCount: 0,
              records: [
                {
                  ordinal: 1,
                  state: 'present',
                  intent: 'migration',
                  parentOrdinals: [],
                  missingParentCount: 0,
                  childCount: 0,
                  root: true,
                  structuralHead: true,
                },
                {
                  ordinal: 2,
                  state: 'present',
                  intent: 'migration',
                  parentOrdinals: [],
                  missingParentCount: 0,
                  childCount: 0,
                  root: true,
                  structuralHead: true,
                },
              ],
            },
          },
          cutover: {
            validPresenceCount: 3,
            failureCode: 'presence-crosses-cutover-boundary',
            validationStage: 'protocol-boundary',
            topology: {
              status: 'valid',
              failureCode: 'none',
              recordCount: 3,
              uniqueGenerationCount: 3,
              rootCount: 1,
              structuralHeadCount: 2,
              weakComponentCount: 1,
              missingParentReferenceCount: 0,
              records: [
                {
                  ordinal: 1,
                  state: 'present',
                  intent: 'migration',
                  parentOrdinals: [],
                  missingParentCount: 0,
                  childCount: 2,
                  root: true,
                  structuralHead: false,
                },
                {
                  ordinal: 2,
                  state: 'removed',
                  intent: 'remove',
                  parentOrdinals: [1],
                  missingParentCount: 0,
                  childCount: 0,
                  root: false,
                  structuralHead: true,
                },
                {
                  ordinal: 3,
                  state: 'removed',
                  intent: 'remove',
                  parentOrdinals: [1],
                  missingParentCount: 0,
                  childCount: 0,
                  root: false,
                  structuralHead: true,
                },
              ],
            },
          },
          resolver: {
            validPresenceCount: 2,
            failureCode: 'presence-unexpected-validation-error',
            validationStage: 'ancestry',
            topology: {
              status: 'invalid',
              failureCode: 'presence-unexpected-validation-error',
              recordCount: 2,
              uniqueGenerationCount: 2,
              rootCount: 1,
              structuralHeadCount: 1,
              weakComponentCount: 1,
              missingParentReferenceCount: 0,
              records: [
                {
                  ordinal: 1,
                  state: 'present',
                  intent: 'migration',
                  parentOrdinals: [],
                  missingParentCount: 0,
                  childCount: 1,
                  root: true,
                  structuralHead: false,
                },
                {
                  ordinal: 2,
                  state: 'removed',
                  intent: 'remove',
                  parentOrdinals: [1],
                  missingParentCount: 0,
                  childCount: 0,
                  root: false,
                  structuralHead: true,
                },
              ],
            },
          },
        };
        const scenario =
          scenarios[globalThis.__39noteTargetedPurgeNative.previewScenario] ??
          scenarios['missing-proof'];
        return {
          eligible: false,
          documentId: affectedDocumentId,
          displayName: 'Synthetic inaccessible paper',
          local: {
            documentRecord: false,
            sourceRecord: false,
            syncStateRecord: true,
            cloudCatalogRecord: true,
            printDraftRecord: false,
            renderedPrintPdfRecord: false,
            aiConversationCount: 0,
          },
          cloud: {
            paperFolderCount: 0,
            paperFileCount: 0,
            validPresenceCount: scenario.validPresenceCount,
            corruptPresenceCount: 0,
            presenceHeadCount: 0,
            preservedPresenceCount: scenario.validPresenceCount,
            ancestryDiagnostic: {
              schemaVersion: 1,
              mode: 'read-only',
              validationStage: scenario.validationStage,
              failureCode: scenario.failureCode,
              ordering: {
                timestamps: 'ignored',
                driveListing: 'ignored',
              },
              topology: scenario.topology,
            },
          },
          preserved: {
            collectionRecords: true,
            sharedRootAndControl: true,
            unrelatedPapers: true,
            removedPresenceTombstone: true,
          },
          blocker: {
            code: 'presence-validation-failed',
            message: 'The verified presence records do not form one complete, valid ancestry graph.',
          },
        };
      };
      coordinator.executeTargetedPaperPurge = async () => {
        globalThis.__39noteTargetedPurgeNative.executeCalls += 1;
        throw new Error('The native visibility verifier must never execute a purge.');
      };

      coordinator.updateView({
        connection: 'attention',
        backendConfigured: true,
        deviceMode: 'personal',
        deviceModeChoiceConfirmed: true,
        autoSync: false,
        papers,
        paperStates: states,
        dirtyPaperIds: [affectedDocumentId, otherDirtyDocumentId],
        issue: genericIssue,
        error: genericIssue.message,
        progress: { phase: 'idle' },
        lastDriveOperationTimeout: {
          operationType: 'scan',
          timedOutFromStage: 'running',
          failureCode: 'drive-request-in-flight-deadline-exceeded',
          timedOutAt: 90_000,
          pendingRequestCount: 1,
          completedRequestCount: 2,
          observedPhases: [{
            phase: 'read-timeout-recovery-root-validation',
            elapsedMs: 90_000,
            requestCount: 1,
            retryCount: 0,
          }],
        },
      }, { notify: true });

      const visibilityBeforeInspection =
        coordinator.getTargetedPaperPurgeVisibilityDiagnostic?.() ?? null;
      const activeRuntimeRevision = coordinator.getRuntimeRevision?.() ?? null;
      globalThis.__39noteTargetedPurgeNative.currentVisibilityMethod =
        coordinator.getTargetedPaperPurgeVisibilityDiagnostic;
      globalThis.__39noteTargetedPurgeNative.currentRuntimeRevisionMethod =
        coordinator.getRuntimeRevision;
      coordinator.getRuntimeRevision = () => 1;
      coordinator.getTargetedPaperPurgeVisibilityDiagnostic = () => ({
        implementationRevision: 1,
        visible: false,
        showRecoveryCard: false,
        candidateSource: 'none',
        hiddenReason: 'no-exact-candidate',
        exactBlockingCandidateCount: 0,
        retryCandidateCount: 1,
        predicates: { candidateResolved: false },
      });

      return {
        affectedDocumentId,
        activeRuntimeRevision,
        cloudPaperCount: coordinator.getSnapshot().papers.length,
        dirtyPaperCount: coordinator.getSnapshot().dirtyPaperIds.length,
        blockingMapSize: coordinator.blockingPaperIssues.size,
        candidateBeforeInspection:
          coordinator.getTargetedPaperPurgeCandidateDocumentId(),
        diagnosticBeforeInspection:
          coordinator.getLastPaperSyncStatusDiagnostic?.() ?? null,
        visibilityBeforeInspection,
        retainedRuntimeRevision: coordinator.getRuntimeRevision(),
      };
    })()`,
  );
  assertEqual(injected.cloudPaperCount, 23, 'synthetic cloud paper count');
  assertEqual(injected.dirtyPaperCount, 2, 'synthetic pending change count');
  assertEqual(injected.blockingMapSize, 1, 'generic blocking-map entry count');
  assertEqual(injected.activeRuntimeRevision, 3, 'active coordinator revision');
  assertEqual(injected.retainedRuntimeRevision, 1, 'retained coordinator revision');
  assertEqual(
    injected.candidateBeforeInspection,
    undefined,
    'candidate before read-only inspection',
  );
  assertEqual(
    injected.diagnosticBeforeInspection,
    null,
    'diagnostic before read-only inspection',
  );
  assertEqual(
    injected.visibilityBeforeInspection?.visible,
    false,
    'visibility before read-only inspection',
  );
  assertEqual(
    injected.visibilityBeforeInspection?.showRecoveryCard,
    false,
    'recovery-card gate before read-only inspection',
  );
  assertEqual(
    injected.visibilityBeforeInspection?.retryCandidateCount,
    1,
    'retry target count before read-only inspection',
  );

  await click(cdp, `button.home-floating-button[aria-label="Home"]`, 'Home');
  await waitForRuntimeValue(
    cdp,
    `(() => Boolean(document.querySelector('.home-workspace.is-open')))()`,
    Boolean,
    10_000,
  );
  await clickButtonByText(cdp, '.home-navigation button', 'Google Drive');
  const hiddenEvidence = await waitForRuntimeValue(
    cdp,
    `(() => {
      const details = document.querySelector('details.sync-details');
      if (details) details.open = true;
      const page = document.querySelector('.paper-sync-home-page');
      return {
        drivePage: Boolean(page),
        card: Boolean(page?.querySelector('.sync-targeted-purge-card')),
        checkButton: Array.from(page?.querySelectorAll('button') ?? []).some(
          (button) => button.textContent?.trim() === 'Check sync status',
        ),
        visibilityText:
          page?.querySelector('[aria-label="Targeted purge predicate matrix"]')
            ?.textContent ?? '',
        timeoutText:
          page?.querySelector('[aria-label="Last Drive timeout"]')?.textContent ?? '',
        activeOperationVisible: Boolean(
          page?.querySelector('[aria-label="Active Drive operation"]'),
        ),
      };
    })()`,
    (value) => value?.drivePage && value?.checkButton && !value?.card,
    20_000,
  );
  assertEqual(hiddenEvidence.card, false, 'recovery card before inspection');
  assert(
    hiddenEvidence.visibilityText.includes('Mounted coordinator revision1'),
    'retained coordinator revision before inspection',
  );
  assert(
    hiddenEvidence.visibilityText.includes('Runtime versions currentFalse'),
    'stale runtime predicate before inspection',
  );
  assertEqual(
    hiddenEvidence.activeOperationVisible,
    false,
    'settled timeout has no active operation card',
  );
  for (const expected of [
    'Last Drive timeout',
    'drive-request-in-flight-deadline-exceeded',
    'Running after admission',
    'Requests in flight1',
    'Requests completed2',
    'read-timeout-recovery-root-validation',
    '90000 ms',
    'remains visible after the operation settles',
  ]) {
    assert(
      hiddenEvidence.timeoutText.includes(expected),
      `settled timeout diagnostic includes ${expected}`,
    );
  }
  assert(
    !hiddenEvidence.timeoutText.includes(injected.affectedDocumentId),
    'settled timeout diagnostic omits the paper identity',
  );
  for (const forbidden of ['https://', 'Bearer ', 'ya29.', 'synthetic-paper-08.pdf']) {
    assert(
      !hiddenEvidence.timeoutText.includes(forbidden),
      `settled timeout diagnostic omits ${forbidden}`,
    );
  }
  await captureFullPage(cdp, hiddenScreenshot);

  await clickButtonByText(cdp, '.sync-details button', 'Check sync status');
  const staleRuntimeEvidence = await waitForRuntimeValue(
    cdp,
    `(async () => {
      const details = document.querySelector('details.sync-details');
      if (details) details.open = true;
      const page = document.querySelector('.paper-sync-home-page');
      const card = page?.querySelector('.sync-targeted-purge-card');
      const diagnostic = page?.querySelector('[aria-label="Sync status diagnostic result"]');
      const visibility = page?.querySelector(
        '[aria-label="Targeted purge predicate matrix"]',
      );
      const buttons = Array.from(card?.querySelectorAll('button') ?? []).map(
        (button) => ({ disabled: button.disabled, text: button.textContent?.trim() ?? '' }),
      );
      const { getPaperGoogleDriveSyncCoordinator } = await import('/src/sync/paperCoordinator.ts');
      const coordinator = getPaperGoogleDriveSyncCoordinator();
      return {
        cardText: card?.textContent ?? '',
        diagnosticText: diagnostic?.textContent ?? '',
        visibilityText: visibility?.textContent ?? '',
        buttons,
        phase: coordinator.getLastPaperSyncStatusDiagnostic?.()?.phase,
        visibilitySnapshot:
          coordinator.getTargetedPaperPurgeVisibilityDiagnostic?.() ?? null,
        runtimeRevision: coordinator.getRuntimeRevision?.() ?? null,
      };
    })()`,
    (value) =>
      value?.phase === 'failed' &&
      value?.cardText.includes('Remove inaccessible paper') &&
      value?.cardText.includes('Purge blocked') &&
      value?.buttons?.some(
        (button) => button.disabled && button.text.includes('Preview unavailable'),
      ) &&
      value?.visibilityText.includes('Failure tuple matchesTrue') &&
      value?.visibilityText.includes('Runtime versions currentFalse'),
    20_000,
  );
  assertEqual(
    staleRuntimeEvidence.runtimeRevision,
    1,
    'mounted retained coordinator revision',
  );
  assertEqual(
    staleRuntimeEvidence.visibilitySnapshot?.implementationRevision,
    1,
    'retained visibility implementation revision',
  );
  assertEqual(
    staleRuntimeEvidence.visibilitySnapshot?.showRecoveryCard,
    false,
    'retained implementation card request',
  );
  assert(
    staleRuntimeEvidence.cardText.includes(
      'runtime-coordinator-implementation-outdated',
    ),
    'exact stale-runtime blocker',
  );
  assert(
    !staleRuntimeEvidence.buttons.some((button) =>
      button.text.includes('Preview targeted purge'),
    ),
    'Preview remains unavailable with stale runtime identity',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Active UI module revision3'),
    'active UI revision',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Active coordinator module revision3'),
    'active coordinator module revision',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Mounted coordinator revision1'),
    'mounted coordinator revision',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Expected visibility revision2'),
    'expected visibility revision',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Implementation revision1'),
    'retained implementation revision in UI',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Component mountedTrue'),
    'component mounted predicate',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Identity correlation existsFalse'),
    'identity correlation fails closed',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Recovery card eligibleTrue'),
    'recognized tuple keeps card eligible',
  );
  assert(
    staleRuntimeEvidence.visibilityText.includes('Preview eligibleFalse'),
    'Preview remains ineligible',
  );
  await captureFullPage(cdp, staleRuntimeScreenshot);

  const restoredRuntime = await evaluate(
    cdp,
    `(async () => {
      const { getPaperGoogleDriveSyncCoordinator } = await import('/src/sync/paperCoordinator.ts');
      const coordinator = getPaperGoogleDriveSyncCoordinator();
      const harness = globalThis.__39noteTargetedPurgeNative;
      coordinator.getTargetedPaperPurgeVisibilityDiagnostic =
        harness.currentVisibilityMethod;
      coordinator.getRuntimeRevision = harness.currentRuntimeRevisionMethod;
      coordinator.updateView({}, { notify: false });
      return {
        runtimeRevision: coordinator.getRuntimeRevision(),
        implementationRevision:
          coordinator.getTargetedPaperPurgeVisibilityDiagnostic()
            .implementationRevision,
      };
    })()`,
  );
  assertEqual(restoredRuntime.runtimeRevision, 3, 'restored coordinator revision');
  assertEqual(
    restoredRuntime.implementationRevision,
    2,
    'restored visibility implementation revision',
  );

  const pageEvidence = await waitForRuntimeValue(
    cdp,
    `(async () => {
      const details = document.querySelector('details.sync-details');
      if (details) details.open = true;
      const page = document.querySelector('.paper-sync-home-page');
      const card = page?.querySelector('.sync-targeted-purge-card');
      const diagnostic = page?.querySelector('[aria-label="Sync status diagnostic result"]');
      const visibility = page?.querySelector(
        '[aria-label="Targeted purge predicate matrix"]',
      );
      const preview = Array.from(card?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent?.includes('Preview targeted purge'),
      );
      const { getPaperGoogleDriveSyncCoordinator } = await import('/src/sync/paperCoordinator.ts');
      const coordinator = getPaperGoogleDriveSyncCoordinator();
      const visibilitySnapshot =
        coordinator.getTargetedPaperPurgeVisibilityDiagnostic?.() ?? null;
      return {
        app: Boolean(document.querySelector('.app-layout')),
        home: Boolean(document.querySelector('.home-workspace.is-open')),
        driveCurrent: document.querySelector('.home-navigation button[aria-current="page"]')?.textContent?.trim(),
        page: Boolean(page),
        cardText: card?.textContent ?? '',
        diagnosticText: diagnostic?.textContent ?? '',
        visibilityText: visibility?.textContent ?? '',
        visibilitySnapshot,
        preview: Boolean(preview),
        candidate: coordinator.getTargetedPaperPurgeCandidateDocumentId(),
        phase: coordinator.getLastPaperSyncStatusDiagnostic?.()?.phase,
        targetCount: coordinator.getLastPaperSyncStatusDiagnostic?.()?.targetCount,
        failure: coordinator.getLastPaperSyncStatusDiagnostic?.()?.failure,
        paperCount: coordinator.getSnapshot().papers.length,
        dirtyPaperCount: coordinator.getSnapshot().dirtyPaperIds.length,
        discoverCalls: globalThis.__39noteTargetedPurgeNative?.discoverCalls ?? -1,
        inspectionTargets:
          globalThis.__39noteTargetedPurgeNative?.inspectionTargets ?? [],
        scanAdmissions:
          globalThis.__39noteTargetedPurgeNative?.scanAdmissions ?? -1,
        scanReleases: globalThis.__39noteTargetedPurgeNative?.scanReleases ?? -1,
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
      };
    })()`,
    (value) =>
      value?.app &&
      value?.home &&
      value?.driveCurrent === 'Google Drive' &&
      value?.page &&
      value?.preview &&
      value?.phase === 'failed' &&
      value?.visibilitySnapshot?.visible === true,
    20_000,
  );
  assert(
    pageEvidence.cardText.includes('Remove inaccessible paper'),
    'recovery heading',
  );
  assert(
    pageEvidence.visibilityText.includes('Targeted purge visibility predicate matrix'),
    'visibility diagnostic heading',
  );
  assert(
    pageEvidence.visibilityText.includes('Active UI module revision3'),
    'current active UI revision',
  );
  assert(
    pageEvidence.visibilityText.includes('Active coordinator module revision3'),
    'current active coordinator module revision',
  );
  assert(
    pageEvidence.visibilityText.includes('Mounted coordinator revision3'),
    'current mounted coordinator revision',
  );
  assert(
    pageEvidence.visibilityText.includes('Expected visibility revision2'),
    'current expected visibility revision',
  );
  assert(
    pageEvidence.visibilityText.includes('Implementation revision2'),
    'current implementation revision',
  );
  assert(
    pageEvidence.visibilityText.includes('Runtime versions currentTrue'),
    'current runtime versions predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Implementation current'),
    'implementation predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Component mountedTrue'),
    'current component mounted predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Failure tuple matchesTrue'),
    'current exact failure tuple predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Identity correlation existsTrue'),
    'current identity correlation predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Recovery card eligibleTrue'),
    'current card eligibility predicate',
  );
  assert(
    pageEvidence.visibilityText.includes('Preview eligibleTrue'),
    'current Preview eligibility predicate',
  );
  assert(pageEvidence.visibilityText.includes('Hidden reason'), 'hidden reason label');
  assert(
    !pageEvidence.visibilityText.includes(injected.affectedDocumentId),
    'visibility diagnostic redacts document identity',
  );
  assert(
    !pageEvidence.visibilityText.includes('synthetic-paper-folder'),
    'visibility diagnostic redacts Drive identity',
  );
  assert(
    !pageEvidence.visibilityText.includes('synthetic-device'),
    'visibility diagnostic redacts device identity',
  );
  assert(pageEvidence.diagnosticText.includes('paper-presence-invalid'), 'operation');
  assert(
    pageEvidence.diagnosticText.includes('paper-presence-resolution'),
    'failure phase',
  );
  assert(
    pageEvidence.diagnosticText.includes('presence-control-resolution-failed'),
    'failure cause',
  );
  assert(
    pageEvidence.diagnosticText.includes('Not recorded'),
    'missing repository result',
  );
  assert(pageEvidence.diagnosticText.includes('present'), 'current presence');
  assert(pageEvidence.diagnosticText.includes('No'), 'upload permission');
  assertEqual(pageEvidence.paperCount, 23, 'paper count after inspection');
  assertEqual(pageEvidence.dirtyPaperCount, 2, 'dirty count after inspection');
  assertEqual(pageEvidence.discoverCalls, 1, 'read-only discovery call count');
  assertEqual(pageEvidence.inspectionTargets.length, 1, 'inspection target count');
  assertEqual(
    pageEvidence.inspectionTargets[0],
    injected.affectedDocumentId,
    'exact correlated inspection target',
  );
  assertEqual(pageEvidence.scanAdmissions, 1, 'scan admission count');
  assertEqual(pageEvidence.scanReleases, 1, 'scan release count');
  assertEqual(pageEvidence.targetCount, 1, 'redacted diagnostic target count');
  assertEqual(
    pageEvidence.failure?.operation,
    'paper-presence-invalid',
    'failure operation',
  );
  assertEqual(
    pageEvidence.failure?.phase,
    'paper-presence-resolution',
    'failure phase',
  );
  assertEqual(
    pageEvidence.failure?.causeCode,
    'presence-control-resolution-failed',
    'failure cause',
  );
  assertEqual(pageEvidence.candidate, injected.affectedDocumentId, 'purge candidate');
  assertEqual(
    pageEvidence.visibilitySnapshot.showRecoveryCard,
    true,
    'card visibility',
  );
  assertEqual(
    pageEvidence.visibilitySnapshot.candidateSource,
    'failed-inspection',
    'candidate evidence source',
  );
  assertEqual(
    pageEvidence.visibilitySnapshot.hiddenReason,
    'not-hidden',
    'hidden reason',
  );
  assertEqual(
    pageEvidence.visibilitySnapshot.predicates.failedInspectionEvidenceComplete,
    true,
    'complete failed-inspection evidence',
  );
  assertEqual(pageEvidence.uncaught.length, 0, 'uncaught error count');

  await captureFullPage(cdp, visibleScreenshot);
  await clickButtonByText(
    cdp,
    '.sync-targeted-purge-card button',
    'Preview targeted purge',
  );
  const blockedEvidence = await waitForBlockedDiagnostic(cdp);
  assert(
    !blockedEvidence.buttons.includes('Purge this paper'),
    'no purge confirmation',
  );
  assertEqual(blockedEvidence.previewCalls, 1, 'preview call count');
  assertEqual(blockedEvidence.executeCalls, 0, 'purge execution count');
  assertEqual(blockedEvidence.blockedFetches.length, 0, 'blocked external fetch count');
  assertEqual(blockedEvidence.uncaught.length, 0, 'uncaught error count after preview');
  assertOnlySameOriginResources(blockedEvidence.resources, origin);
  assertEqual(externalRequests.length, 0, 'cross-origin network request count');
  assertDiagnosticScenario(blockedEvidence, {
    scenario: 'missing proof',
    validationStage: 'ancestry',
    failureCode: 'presence-missing-parent',
    ancestryStatus: 'invalid',
    records: '2 reviewed / 2 unique',
    roots: '1',
    structuralHeads: '2',
    weakComponents: '2',
    missingParents: '1',
    recordLines: [
      'R1: present / migration; parents none; missing parents 0; children 0; root yes; structural head yes',
      'R2: removed / remove; parents none; missing parents 1; children 0; root no; structural head yes',
    ],
  });
  await captureViewport(cdp, blockedScreenshot);

  await closeBlockedDiagnostic(cdp);
  await verifyBlockedDiagnosticScenario(
    cdp,
    'conflict',
    {
      scenario: 'conflicting ancestry',
      validationStage: 'ancestry',
      failureCode: 'presence-present-folder-conflict',
      ancestryStatus: 'invalid',
      records: '2 reviewed / 2 unique',
      roots: '2',
      structuralHeads: '2',
      weakComponents: '2',
      missingParents: '0',
      recordLines: [
        'R1: present / migration; parents none; missing parents 0; children 0; root yes; structural head yes',
        'R2: present / migration; parents none; missing parents 0; children 0; root yes; structural head yes',
      ],
    },
    conflictScreenshot,
  );
  await verifyBlockedDiagnosticScenario(
    cdp,
    'cutover',
    {
      scenario: 'protocol cutover',
      validationStage: 'protocol-boundary',
      failureCode: 'presence-crosses-cutover-boundary',
      ancestryStatus: 'valid',
      records: '3 reviewed / 3 unique',
      roots: '1',
      structuralHeads: '2',
      weakComponents: '1',
      missingParents: '0',
      recordLines: [
        'R1: present / migration; parents none; missing parents 0; children 2; root yes; structural head no',
        'R2: removed / remove; parents R1; missing parents 0; children 0; root no; structural head yes',
        'R3: removed / remove; parents R1; missing parents 0; children 0; root no; structural head yes',
      ],
    },
    cutoverScreenshot,
  );
  await verifyBlockedDiagnosticScenario(
    cdp,
    'resolver',
    {
      scenario: 'resolver failure',
      validationStage: 'ancestry',
      failureCode: 'presence-unexpected-validation-error',
      ancestryStatus: 'invalid',
      records: '2 reviewed / 2 unique',
      roots: '1',
      structuralHeads: '1',
      weakComponents: '1',
      missingParents: '0',
      recordLines: [
        'R1: present / migration; parents none; missing parents 0; children 1; root yes; structural head no',
        'R2: removed / remove; parents R1; missing parents 0; children 0; root no; structural head yes',
      ],
    },
    resolverScreenshot,
  );

  await verifyForgetPaperVisibilityFixture(cdp, origin);
  await verifyModalAccessibilityFixture(cdp, origin);
  await verifyAnnotatedPdfExportFixture(cdp, origin);
  await verifyResponsiveReaderFixture(cdp, origin);
  await verifyPdfTextAvailabilityFixture(cdp, origin);
  const productionEvidence = await verifyProductionForgetPaperFixture(cdp);

  console.log(
    'PASS — fresh app load kept targeted purge hidden until exact read-only inspection settled',
  );
  console.log('PASS — an uncached browser reload remounted the active module graph');
  console.log(
    'PASS — 23 cloud papers and 2 pending changes resolved to exactly 1 failed diagnostic target',
  );
  console.log(
    'PASS — retained revision 1 rendered a disabled card; restored revision 3 enabled exact Preview',
  );
  console.log(
    'PASS — preview failed closed; purge execution count 0; cross-origin requests 0',
  );
  console.log(
    'PASS — typed diagnostics rendered missing proof, conflicting ancestry, protocol cutover, and resolver failure',
  );
  console.log(
    'PASS — Browse Drive papers kept Forget fail-closed until exact read-only identity verification',
  );
  console.log(
    'PASS — Library and Notes destructive/print dialogs contained focus, handled Escape, restored focus, and cleared stale state',
  );
  console.log(
    'PASS — the isolated annotated PDF fixture exported Chinese Notes and rejected unsupported emoji with a typed failure',
  );
  console.log(
    'PASS — the compact Reader exposed its complete toolbar drawer and kept Reader Tools inside the portrait viewport',
  );
  console.log(
    'PASS — local OCR joined annotation lines, followed page zoom, and safely completed a mixed whole document',
  );
  console.log(
    `PASS — production recovery UI admitted exact identity verification with ${productionEvidence.desktopRequestCount} desktop and ${productionEvidence.mobileRequestCount} mobile GET-only requests and 0 Forget calls`,
  );
  console.log(`Screenshot: ${hiddenScreenshot}`);
  console.log(`Screenshot: ${staleRuntimeScreenshot}`);
  console.log(`Screenshot: ${visibleScreenshot}`);
  console.log(`Screenshot: ${blockedScreenshot}`);
  console.log(`Screenshot: ${conflictScreenshot}`);
  console.log(`Screenshot: ${cutoverScreenshot}`);
  console.log(`Screenshot: ${resolverScreenshot}`);
  console.log(`Screenshot: ${responsiveReaderScreenshot}`);
  console.log(`Screenshot: ${responsiveToolbarScreenshot}`);
  console.log(`Screenshot: ${pdfTextAvailabilityScreenshot}`);
  console.log(`Screenshot: ${mobileRecoveryScreenshot}`);
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
  await productionPreview?.close();
  await server.close();
  await removeTemporaryDirectory(profile);
  await removeTemporaryDirectory(productionFixtureDirectory);
}

async function waitForBlockedDiagnostic(cdpClient) {
  return waitForRuntimeValue(
    cdpClient,
    `(() => {
      const dialog = document.querySelector('dialog.sync-targeted-purge-dialog');
      const diagnostic = dialog?.querySelector(
        '[aria-labelledby="targeted-purge-ancestry-title"]',
      );
      const buttons = Array.from(dialog?.querySelectorAll('button') ?? []).map(
        (button) => button.textContent?.trim(),
      );
      const pairs = Object.fromEntries(
        Array.from(dialog?.querySelectorAll('dl > div') ?? []).map((row) => [
          row.querySelector('dt')?.textContent?.trim() ?? '',
          row.querySelector('dd')?.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
        ]),
      );
      const recordLines = Array.from(diagnostic?.querySelectorAll('li') ?? []).map(
        (item) => item.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
      );
      return {
        open: Boolean(dialog?.open),
        text: dialog?.textContent ?? '',
        diagnosticText: diagnostic?.textContent ?? '',
        pairs,
        recordLines,
        buttons,
        previewCalls: globalThis.__39noteTargetedPurgeNative?.previewCalls ?? -1,
        executeCalls: globalThis.__39noteTargetedPurgeNative?.executeCalls ?? -1,
        blockedFetches: globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        redactedNeedles: [
          globalThis.__39noteTargetedPurgeNative?.affectedDocumentId,
          'synthetic-paper-folder',
          'synthetic-device',
        ].filter(Boolean),
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
      };
    })()`,
    (value) => value?.open && value?.text?.includes('Purge blocked'),
    10_000,
  );
}

function assertDiagnosticScenario(evidence, expected) {
  assert(
    evidence.diagnosticText.includes('Strictly read-only and redacted'),
    `${expected.scenario}: read-only redaction notice`,
  );
  assert(
    evidence.diagnosticText.includes(
      'Resolved presence heads remain 0 while validation is blocked',
    ),
    `${expected.scenario}: resolved/structural head distinction`,
  );
  assertEqual(
    evidence.pairs['Resolved presence heads'],
    '0',
    `${expected.scenario}: unavailable resolved heads`,
  );
  assertEqual(
    evidence.pairs['Validation stage'],
    expected.validationStage,
    `${expected.scenario}: validation stage`,
  );
  assertEqual(
    evidence.pairs['Failure code'],
    expected.failureCode,
    `${expected.scenario}: failure code`,
  );
  assertEqual(
    evidence.pairs['Ancestry status'],
    expected.ancestryStatus,
    `${expected.scenario}: ancestry status`,
  );
  assertEqual(
    evidence.pairs.Records,
    expected.records,
    `${expected.scenario}: records`,
  );
  assertEqual(evidence.pairs.Roots, expected.roots, `${expected.scenario}: roots`);
  assertEqual(
    evidence.pairs['Structural heads'],
    expected.structuralHeads,
    `${expected.scenario}: structural heads`,
  );
  assertEqual(
    evidence.pairs['Weak components'],
    expected.weakComponents,
    `${expected.scenario}: weak components`,
  );
  assertEqual(
    evidence.pairs['Missing parent references'],
    expected.missingParents,
    `${expected.scenario}: missing parent references`,
  );
  assertEqual(
    evidence.pairs['Ordering authority'],
    'Timestamps ignored; Drive listing ignored',
    `${expected.scenario}: ordering authority`,
  );
  assertEqual(
    evidence.recordLines.length,
    expected.recordLines.length,
    `${expected.scenario}: redacted record count`,
  );
  for (const line of expected.recordLines) {
    assert(evidence.recordLines.includes(line), `${expected.scenario}: ${line}`);
  }
  for (const needle of evidence.redactedNeedles) {
    assert(
      !evidence.diagnosticText.includes(needle),
      `${expected.scenario}: diagnostic redacts ${needle}`,
    );
  }
  assert(
    !/[a-f0-9]{64}/iu.test(evidence.diagnosticText),
    `${expected.scenario}: diagnostic redacts generation hashes`,
  );
  assert(
    !evidence.buttons.includes('Purge this paper'),
    `${expected.scenario}: purge action absent`,
  );
  assertEqual(evidence.executeCalls, 0, `${expected.scenario}: purge execution count`);
  assertEqual(
    evidence.blockedFetches.length,
    0,
    `${expected.scenario}: blocked external fetch count`,
  );
  assertEqual(
    evidence.uncaught.length,
    0,
    `${expected.scenario}: uncaught error count`,
  );
}

async function closeBlockedDiagnostic(cdpClient) {
  await clickButtonByText(
    cdpClient,
    'dialog.sync-targeted-purge-dialog button',
    'Close',
  );
  await waitForRuntimeValue(
    cdpClient,
    `(() => !document.querySelector('dialog.sync-targeted-purge-dialog'))()`,
    Boolean,
    10_000,
  );
}

async function verifyBlockedDiagnosticScenario(
  cdpClient,
  scenario,
  expected,
  screenshotPath,
) {
  await evaluate(
    cdpClient,
    `(() => {
      globalThis.__39noteTargetedPurgeNative.previewScenario = ${JSON.stringify(scenario)};
      return globalThis.__39noteTargetedPurgeNative.previewScenario;
    })()`,
  );
  await clickButtonByText(
    cdpClient,
    '.sync-targeted-purge-card button',
    'Preview targeted purge',
  );
  const evidence = await waitForBlockedDiagnostic(cdpClient);
  assertDiagnosticScenario(evidence, expected);
  await evaluate(
    cdpClient,
    `(() => {
      document.querySelector('#targeted-purge-ancestry-title')?.scrollIntoView({
        block: 'start',
      });
      return true;
    })()`,
  );
  await captureViewport(cdpClient, screenshotPath);
  await closeBlockedDiagnostic(cdpClient);
  return evidence;
}

async function evaluate(cdpClient, expression) {
  const result = await cdpClient.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const description = result.result?.description ?? result.exceptionDetails.text;
    throw new Error(`Browser evaluation failed: ${description}`);
  }
  return result.result?.value;
}

async function verifyForgetPaperVisibilityFixture(cdpClient, origin) {
  const fixtureUrl = `${origin}/tests/fixtures/forgetPaperVisibilityBrowser.html`;
  const navigate = async (mode) => {
    const navigation = await cdpClient.send('Page.navigate', {
      url: `${fixtureUrl}?mode=${encodeURIComponent(mode)}`,
    });
    if (navigation.errorText) {
      throw new Error(
        `The isolated Forget-paper fixture could not load: ${navigation.errorText}`,
      );
    }
    return waitForRuntimeValue(
      cdpClient,
      `(() => ({
        mode: document.body?.dataset.fixtureMode ?? null,
        text: document.body?.textContent ?? '',
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        blockedFetches:
          globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
      }))()`,
      (value) =>
        value?.mode === mode &&
        value?.text?.includes('Synthetic inaccessible paper.pdf'),
      60_000,
    );
  };
  const readControls = () =>
    evaluate(
      cdpClient,
      `(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const byText = (text) =>
          buttons.find((button) => button.textContent?.trim() === text);
        const forget = byText('Forget inaccessible paper');
        const verify = byText('Verify identity (read-only)');
        return {
          loadId: globalThis.__39noteForgetPaperFixture?.loadId ?? null,
          text: document.body?.textContent ?? '',
          forgetPresent: forget instanceof HTMLButtonElement,
          forgetDisabled:
            forget instanceof HTMLButtonElement ? forget.disabled : null,
          verifyPresent: verify instanceof HTMLButtonElement,
          documentIdVisible: (document.body?.textContent ?? '').includes(
            'synthetic-broken-paper-instance-001',
          ),
          uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
          blockedFetches:
            globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
        };
      })()`,
    );

  await navigate('blocked');
  let controls = await readControls();
  assert(controls.documentIdVisible, 'blocked fixture shows the exact Document ID');
  assert(controls.forgetPresent, 'blocked fixture keeps the Forget action visible');
  assertEqual(controls.forgetDisabled, true, 'blocked Forget action is fail-closed');
  assert(
    controls.verifyPresent,
    'blocked fixture exposes read-only identity verification',
  );
  assert(
    controls.text.includes('identity-proof-unavailable'),
    'blocked fixture explains the exact failed predicate',
  );
  const blockedLoadId = controls.loadId;

  await cdpClient.send('Page.reload', { ignoreCache: true });
  controls = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const forget = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Forget inaccessible paper',
      );
      return {
        mode: document.body?.dataset.fixtureMode ?? null,
        loadId: globalThis.__39noteForgetPaperFixture?.loadId ?? null,
        forgetPresent: forget instanceof HTMLButtonElement,
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
      };
    })()`,
    (value) =>
      value?.mode === 'blocked' &&
      typeof value?.loadId === 'string' &&
      value.loadId !== blockedLoadId &&
      value?.forgetPresent === true &&
      value?.forgetDisabled === true,
    60_000,
  );
  assertEqual(
    controls.forgetDisabled,
    true,
    'reload preserves fail-closed identity state',
  );

  await navigate('verify');
  controls = await readControls();
  assertEqual(controls.forgetDisabled, true, 'verification fixture begins fail-closed');
  await clickButtonByText(cdpClient, 'button', 'Verify identity (read-only)');
  controls = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const forget = buttons.find(
        (button) => button.textContent?.trim() === 'Forget inaccessible paper',
      );
      const verify = buttons.find(
        (button) => button.textContent?.trim() === 'Verify identity (read-only)',
      );
      return {
        forgetPresent: forget instanceof HTMLButtonElement,
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
        verifyPresent: verify instanceof HTMLButtonElement,
      };
    })()`,
    (value) =>
      value?.forgetPresent === true &&
      value?.forgetDisabled === false &&
      value?.verifyPresent === false,
    30_000,
  );
  assertEqual(controls.forgetDisabled, false, 'verified Forget action is enabled');

  await clickButtonByText(cdpClient, 'button', 'Forget inaccessible paper');
  const dialog = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const dialog = document.querySelector('dialog[open]');
      const confirm = Array.from(dialog?.querySelectorAll('button') ?? []).find(
        (button) => button.textContent?.trim() === 'Forget and ignore this issue',
      );
      return {
        open: dialog instanceof HTMLDialogElement,
        text: dialog?.textContent ?? '',
        confirmDisabled:
          confirm instanceof HTMLButtonElement ? confirm.disabled : null,
      };
    })()`,
    (value) => value?.open === true,
    30_000,
  );
  assert(
    dialog.text.includes('No Google Drive object will be deleted or changed'),
    'confirmation distinguishes local quarantine from cloud deletion',
  );
  assert(
    dialog.text.includes('synthetic-broken-paper-instance-001'),
    'confirmation retains the exact Document ID',
  );
  assertEqual(
    dialog.confirmDisabled,
    true,
    'confirmation requires explicit acknowledgement',
  );
  await click(
    cdpClient,
    'dialog[open] input[type="checkbox"]',
    'Forget acknowledgement',
  );
  await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const confirm = Array.from(
        document.querySelectorAll('dialog[open] button'),
      ).find(
        (button) => button.textContent?.trim() === 'Forget and ignore this issue',
      );
      return confirm instanceof HTMLButtonElement ? !confirm.disabled : false;
    })()`,
    (value) => value === true,
    30_000,
  );
  await clickButtonByText(cdpClient, 'dialog[open] button', 'Cancel');

  await navigate('eligible');
  controls = await readControls();
  assertEqual(
    controls.forgetDisabled,
    false,
    'persisted reviewed proof keeps exact-paper Forget available',
  );
  assertEqual(
    controls.verifyPresent,
    false,
    'eligible exact-paper proof does not request redundant verification',
  );
  assertEqual(controls.uncaught.length, 0, 'Forget fixture uncaught error count');
  assertEqual(
    controls.blockedFetches.length,
    0,
    'Forget fixture blocked external fetch count',
  );
  assertEqual(externalRequests.length, 0, 'Forget fixture cross-origin request count');
}

async function verifyModalAccessibilityFixture(cdpClient, origin) {
  const externalRequestCount = externalRequests.length;
  const navigation = await cdpClient.send('Page.navigate', {
    url: `${origin}/tests/fixtures/modalAccessibilityBrowser.html`,
  });
  if (navigation.errorText) {
    throw new Error(
      `The isolated modal accessibility fixture could not load: ${navigation.errorText}`,
    );
  }
  const result = await waitForRuntimeValue(
    cdpClient,
    `(() => ({
      result: document.querySelector('#summary')?.dataset.modalResult ?? null,
      details: document.querySelector('#details')?.textContent ?? null,
      fixture: globalThis.__39noteModalAccessibilityFixture ?? null,
      uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
    }))()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    30_000,
  );
  assertEqual(result.result, 'PASS', `modal fixture: ${result.details ?? ''}`);
  assertEqual(result.fixture?.failures?.length, 0, 'modal fixture failure count');
  assertEqual(
    result.fixture?.remoteMutations,
    0,
    'modal fixture remote mutation count',
  );
  assertEqual(result.uncaught.length, 0, 'modal fixture uncaught error count');
  assertEqual(
    externalRequests.length,
    externalRequestCount,
    'modal fixture cross-origin request count',
  );
}

async function verifyAnnotatedPdfExportFixture(cdpClient, origin) {
  const externalRequestCount = externalRequests.length;
  const navigation = await cdpClient.send('Page.navigate', {
    url: `${origin}/tests/fixtures/annotatedPdfExportBrowser.html`,
  });
  if (navigation.errorText) {
    throw new Error(
      `The isolated annotated PDF export fixture could not load: ${navigation.errorText}`,
    );
  }
  const result = await waitForRuntimeValue(
    cdpClient,
    `(() => ({
      result: document.querySelector('#summary')?.dataset.exportResult ?? null,
      details: document.querySelector('#details')?.textContent ?? null,
      fixture: globalThis.__39noteAnnotatedPdfExportFixture ?? null,
      uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
    }))()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    60_000,
  );
  assertEqual(
    result.result,
    'PASS',
    `annotated PDF export fixture: ${result.details ?? ''}`,
  );
  assertEqual(
    result.fixture?.failures?.length,
    0,
    'annotated PDF export fixture failure count',
  );
  assertEqual(
    result.fixture?.unicodeAppendixPages,
    2,
    'annotated PDF export fixture page count',
  );
  assertEqual(
    result.fixture?.unsupportedUnicodeCode,
    'unsupported-unicode',
    'annotated PDF export fixture unsupported Unicode code',
  );
  assertEqual(
    result.fixture?.remoteMutations,
    0,
    'annotated PDF export fixture remote mutation count',
  );
  assertEqual(result.uncaught.length, 0, 'annotated PDF export fixture uncaught count');
  assertEqual(
    externalRequests.length,
    externalRequestCount,
    'annotated PDF export fixture cross-origin request count',
  );
}

async function verifyResponsiveReaderFixture(cdpClient, origin) {
  const externalRequestCount = externalRequests.length;
  await Promise.all([
    cdpClient.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    }),
    cdpClient.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    }),
  ]);
  const navigation = await cdpClient.send('Page.navigate', {
    url: `${origin}/tests/fixtures/responsiveReaderBrowser.html`,
  });
  if (navigation.errorText) {
    throw new Error(
      `The isolated responsive Reader fixture could not load: ${navigation.errorText}`,
    );
  }
  const result = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const sidebar = document.querySelector('.reader-tools-sidebar');
      const inner = document.querySelector('.reader-tools-inner');
      const toolbarDrawer = document.querySelector('#toolbar-compact-tools-drawer');
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
        };
      };
      return {
        result: document.querySelector('#summary')?.dataset.responsiveResult ?? null,
        details: document.querySelector('#details')?.textContent ?? null,
        fixture: globalThis.__39noteResponsiveReaderFixture ?? null,
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        sidebar: rect(sidebar),
        inner: rect(inner),
        toolbarDrawerDisplay:
          toolbarDrawer instanceof HTMLElement
            ? getComputedStyle(toolbarDrawer).display
            : null,
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
      };
    })()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    30_000,
  );
  assertEqual(result.result, 'PASS', `responsive Reader: ${result.details ?? ''}`);
  assertEqual(result.fixture?.failures?.length, 0, 'responsive fixture failure count');
  assertEqual(result.fixture?.searchCalls, 1, 'responsive Search invocation count');
  assertEqual(
    result.fixture?.exportNotesCalls,
    1,
    'responsive Export Notes invocation count',
  );
  assertEqual(result.fixture?.remoteMutations, 0, 'responsive remote mutation count');
  assertEqual(result.viewportWidth, 390, 'responsive CSS viewport width');
  assert(
    result.documentWidth <= result.viewportWidth,
    'responsive Reader has no horizontal document overflow',
  );
  assert(
    result.sidebar?.width <= result.viewportWidth - 44,
    'responsive Reader Tools width leaves a dismissible edge',
  );
  assert(
    result.inner?.left >= result.sidebar?.left &&
      result.inner?.right <= result.sidebar?.right + 1,
    'responsive Reader Tools content remains within its drawer',
  );
  assertEqual(result.toolbarDrawerDisplay, 'none', 'responsive toolbar settled closed');
  assertEqual(result.uncaught.length, 0, 'responsive fixture uncaught error count');
  assertEqual(
    externalRequests.length,
    externalRequestCount,
    'responsive fixture cross-origin request count',
  );
  await captureViewport(cdpClient, responsiveReaderScreenshot);
  await click(cdpClient, '.sidebar-mobile-close', 'responsive Reader Tools close');
  await click(cdpClient, '.toolbar-compact-tools-trigger', 'responsive toolbar drawer');
  await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const drawer = document.querySelector('#toolbar-compact-tools-drawer');
      return drawer instanceof HTMLElement && getComputedStyle(drawer).display !== 'none';
    })()`,
    (value) => value === true,
    5_000,
  );
  await captureViewport(cdpClient, responsiveToolbarScreenshot);
  await Promise.all([
    cdpClient.send('Emulation.setTouchEmulationEnabled', { enabled: false }),
    cdpClient.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }),
  ]);
}

async function verifyPdfTextAvailabilityFixture(cdpClient, origin) {
  const externalRequestCount = externalRequests.length;
  const navigation = await cdpClient.send('Page.navigate', {
    url: `${origin}/tests/fixtures/pdfTextAvailabilityBrowser.html`,
  });
  if (navigation.errorText) {
    throw new Error(
      `The isolated PDF text-availability fixture could not load: ${navigation.errorText}`,
    );
  }
  const result = await waitForRuntimeValue(
    cdpClient,
    `(() => ({
      result: document.querySelector('#summary')?.dataset.textResult ?? null,
      details: document.querySelector('#details')?.textContent ?? null,
      fixture: globalThis.__39notePdfTextAvailabilityFixture ?? null,
      imageOnlyAvailability:
        document.querySelector(
          '[data-testid="image-only-page"] .pdf-page-shell',
        )?.dataset.pdfTextAvailability ?? null,
      selectableAvailability:
        document.querySelector(
          '[data-testid="selectable-page"] .pdf-page-shell',
        )?.dataset.pdfTextAvailability ?? null,
      imageOnlyNotice:
        document.querySelector(
          '[data-testid="image-only-page"] .pdf-page-text-capability-notice',
        )?.textContent ?? '',
      imageOnlyOcrStatus:
        document.querySelector(
          '[data-testid="image-only-page"] .pdf-page-shell',
        )?.dataset.pdfOcrStatus ?? null,
      imageOnlyOcrWordCount: document.querySelectorAll(
        '[data-testid="image-only-page"] .ocr-text-word',
      ).length,
      selectableNoticePresent: Boolean(
        document.querySelector(
          '[data-testid="selectable-page"] .pdf-page-text-capability-notice',
        ),
      ),
      uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
    }))()`,
    (value) => value?.result === 'PASS' || value?.result === 'FAIL',
    180_000,
  );
  assertEqual(result.result, 'PASS', `PDF text availability: ${result.details ?? ''}`);
  assertEqual(
    result.fixture?.failures?.length,
    0,
    'PDF text-availability fixture failure count',
  );
  assertEqual(
    result.fixture?.remoteMutations,
    0,
    'PDF text-availability remote mutation count',
  );
  assertEqual(
    result.imageOnlyAvailability,
    'image-only',
    'synthetic image-only page classification',
  );
  assertEqual(
    result.selectableAvailability,
    'selectable',
    'synthetic selectable page classification',
  );
  assert(
    result.imageOnlyNotice.includes('recognized locally'),
    'image-only page explains the local OCR result',
  );
  assertEqual(result.imageOnlyOcrStatus, 'ready', 'image-only page OCR status');
  assert(
    result.imageOnlyOcrWordCount > 0,
    'image-only page exposes selectable local OCR words',
  );
  assertEqual(
    result.selectableNoticePresent,
    false,
    'selectable page omits the OCR notice',
  );
  assertEqual(result.uncaught.length, 0, 'PDF text fixture uncaught error count');
  assertEqual(
    externalRequests.length,
    externalRequestCount,
    'PDF text fixture cross-origin request count',
  );
  await captureViewport(cdpClient, pdfTextAvailabilityScreenshot);
}

async function verifyProductionForgetPaperFixture(cdpClient) {
  const previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await buildVite({
      base: '/',
      build: {
        emptyOutDir: true,
        outDir: productionFixtureDirectory,
        rollupOptions: {
          input: resolve(workspace, 'tests/fixtures/forgetPaperVisibilityBrowser.html'),
        },
      },
      envFile: false,
      logLevel: 'error',
      mode: 'production',
      root: workspace,
    });
  } finally {
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }

  const fixtureOutput = [
    join(
      productionFixtureDirectory,
      'tests',
      'fixtures',
      'forgetPaperVisibilityBrowser.html',
    ),
    join(productionFixtureDirectory, 'forgetPaperVisibilityBrowser.html'),
  ].find((candidate) => existsSync(candidate));
  assert(fixtureOutput, 'production Forget-paper fixture output exists');

  const productionPort = await reserveLoopbackPort();
  productionPreview = await previewVite({
    base: '/',
    build: { outDir: productionFixtureDirectory },
    configFile: false,
    envFile: false,
    logLevel: 'error',
    preview: {
      host: '127.0.0.1',
      port: productionPort,
      strictPort: true,
    },
    root: workspace,
  });
  const address = productionPreview.httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('The production preview did not expose a loopback port.');
  }
  const productionOrigin = `http://127.0.0.1:${address.port}`;
  allowedNetworkOrigins.add(productionOrigin);
  const fixtureRoute = `/${relative(productionFixtureDirectory, fixtureOutput).replaceAll('\\', '/')}`;
  const requestStart = networkRequests.length;
  const navigation = await cdpClient.send('Page.navigate', {
    url: `${productionOrigin}${fixtureRoute}?mode=verify`,
  });
  if (navigation.errorText) {
    throw new Error(
      `The production Forget-paper fixture could not load: ${navigation.errorText}`,
    );
  }

  const before = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const byText = (text) =>
        buttons.find((button) => button.textContent?.trim() === text);
      const forget = byText('Forget inaccessible paper');
      const verify = byText('Verify identity (read-only)');
      return {
        mode: document.body?.dataset.fixtureMode ?? null,
        text: document.body?.textContent ?? '',
        documentIdVisible: (document.body?.textContent ?? '').includes(
          'synthetic-broken-paper-instance-001',
        ),
        forgetPresent: forget instanceof HTMLButtonElement,
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
        verifyPresent: verify instanceof HTMLButtonElement,
        fixtureState: globalThis.__39noteForgetPaperFixture ?? null,
        resources: performance.getEntriesByType('resource').map((entry) => entry.name),
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        blockedFetches:
          globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
      };
    })()`,
    (value) =>
      value?.mode === 'verify' &&
      value?.documentIdVisible === true &&
      value?.forgetPresent === true &&
      value?.verifyPresent === true,
    60_000,
  );
  assertEqual(before.forgetDisabled, true, 'production Forget starts fail-closed');
  assertEqual(
    before.fixtureState?.verificationCalls,
    0,
    'production verification count before click',
  );
  assertEqual(before.fixtureState?.forgetCalls, 0, 'production Forget count');
  assertEqual(before.fixtureState?.mutationCalls, 0, 'production mutation count');
  for (const technicalText of [
    'Failed predicate',
    'identity-proof-unavailable',
    'Targeted purge visibility predicate matrix',
  ]) {
    assert(
      !before.text.includes(technicalText),
      `production UI hides ${technicalText}`,
    );
  }
  assertOnlySameOriginResources(before.resources, productionOrigin);

  await clickButtonByText(cdpClient, 'button', 'Verify identity (read-only)');
  const after = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const forget = buttons.find(
        (button) => button.textContent?.trim() === 'Forget inaccessible paper',
      );
      const verify = buttons.find(
        (button) => button.textContent?.trim() === 'Verify identity (read-only)',
      );
      return {
        text: document.body?.textContent ?? '',
        forgetPresent: forget instanceof HTMLButtonElement,
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
        verifyPresent: verify instanceof HTMLButtonElement,
        fixtureState: globalThis.__39noteForgetPaperFixture ?? null,
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        blockedFetches:
          globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
      };
    })()`,
    (value) =>
      value?.forgetPresent === true &&
      value?.forgetDisabled === false &&
      value?.verifyPresent === false,
    30_000,
  );
  assertEqual(
    after.fixtureState?.verificationCalls,
    1,
    'production exact verification count',
  );
  assertEqual(
    after.fixtureState?.forgetCalls,
    0,
    'production Forget count after proof',
  );
  assertEqual(
    after.fixtureState?.mutationCalls,
    0,
    'production mutation count after proof',
  );
  assertEqual(after.uncaught.length, 0, 'production fixture uncaught error count');
  assertEqual(
    after.blockedFetches.length,
    0,
    'production fixture blocked external fetch count',
  );
  for (const technicalText of [
    'Failed predicate',
    'identity-proof-unavailable',
    'Targeted purge visibility predicate matrix',
  ]) {
    assert(
      !after.text.includes(technicalText),
      `verified production UI hides ${technicalText}`,
    );
  }

  const productionRequests = networkRequests
    .slice(requestStart)
    .filter((request) => request.origin === productionOrigin);
  assert(productionRequests.length > 0, 'production fixture made local requests');
  for (const request of productionRequests) {
    assertEqual(request.method, 'GET', `production request method for ${request.url}`);
  }
  assertEqual(
    externalRequests.length,
    0,
    'production fixture cross-origin request count',
  );
  const mobileRequestStart = networkRequests.length;
  await Promise.all([
    cdpClient.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    }),
    cdpClient.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    }),
  ]);
  const mobileNavigation = await cdpClient.send('Page.navigate', {
    url: `${productionOrigin}${fixtureRoute}?mode=verify&viewport=phone`,
  });
  if (mobileNavigation.errorText) {
    throw new Error(
      `The mobile production fixture could not load: ${mobileNavigation.errorText}`,
    );
  }
  const mobileBefore = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const byText = (text) =>
        buttons.find((button) => button.textContent?.trim() === text);
      const forget = byText('Forget inaccessible paper');
      const verify = byText('Verify identity (read-only)');
      const row = forget?.closest('li');
      const rect = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      };
      return {
        mode: document.body?.dataset.fixtureMode ?? null,
        text: document.body?.textContent ?? '',
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        visualViewportWidth: visualViewport?.width ?? null,
        documentWidth: document.documentElement?.scrollWidth ?? 0,
        coarsePointer: matchMedia('(pointer: coarse)').matches,
        maxTouchPoints: navigator.maxTouchPoints,
        documentIdVisible: (document.body?.textContent ?? '').includes(
          'synthetic-broken-paper-instance-001',
        ),
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
        verifyPresent: verify instanceof HTMLButtonElement,
        forgetRect: rect(forget),
        verifyRect: rect(verify),
        rowRect: rect(row),
        fixtureState: globalThis.__39noteForgetPaperFixture ?? null,
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        blockedFetches:
          globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
      };
    })()`,
    (value) =>
      value?.mode === 'verify' &&
      value?.documentIdVisible === true &&
      value?.forgetDisabled === true &&
      value?.verifyPresent === true,
    60_000,
  );
  assertEqual(mobileBefore.viewportWidth, 390, 'mobile CSS viewport width');
  assertEqual(mobileBefore.viewportHeight, 844, 'mobile CSS viewport height');
  assertEqual(
    Math.round(mobileBefore.visualViewportWidth),
    390,
    'mobile visual viewport width',
  );
  assert(
    mobileBefore.documentWidth <= mobileBefore.viewportWidth + 1,
    'mobile recovery page has no horizontal overflow',
  );
  assertEqual(mobileBefore.coarsePointer, true, 'mobile coarse-pointer media query');
  assert(
    mobileBefore.maxTouchPoints >= 1,
    'mobile fixture exposes touch input capability',
  );
  for (const [label, rect] of [
    ['Forget', mobileBefore.forgetRect],
    ['Verify', mobileBefore.verifyRect],
  ]) {
    assert(rect, `${label} control has mobile geometry`);
    assert(rect.left >= 0, `${label} control stays inside the mobile left edge`);
    assert(
      rect.right <= mobileBefore.viewportWidth + 1,
      `${label} control stays inside the mobile right edge`,
    );
    assert(rect.height >= 44, `${label} control keeps a 44px touch target`);
  }
  assert(mobileBefore.rowRect, 'mobile paper row has geometry');
  assert(
    mobileBefore.rowRect.right <= mobileBefore.viewportWidth + 1,
    'mobile paper row stays inside the viewport',
  );
  assertEqual(
    mobileBefore.fixtureState?.mutationCalls,
    0,
    'mobile mutation count before proof',
  );
  for (const technicalText of [
    'Failed predicate',
    'identity-proof-unavailable',
    'Targeted purge visibility predicate matrix',
  ]) {
    assert(
      !mobileBefore.text.includes(technicalText),
      `mobile production UI hides ${technicalText}`,
    );
  }

  await clickButtonByText(cdpClient, 'button', 'Verify identity (read-only)');
  const mobileAfter = await waitForRuntimeValue(
    cdpClient,
    `(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const forget = buttons.find(
        (button) => button.textContent?.trim() === 'Forget inaccessible paper',
      );
      const verify = buttons.find(
        (button) => button.textContent?.trim() === 'Verify identity (read-only)',
      );
      return {
        forgetDisabled:
          forget instanceof HTMLButtonElement ? forget.disabled : null,
        verifyPresent: verify instanceof HTMLButtonElement,
        fixtureState: globalThis.__39noteForgetPaperFixture ?? null,
        uncaught: globalThis.__39noteTargetedPurgeNative?.uncaught ?? [],
        blockedFetches:
          globalThis.__39noteTargetedPurgeNative?.blockedFetches ?? [],
      };
    })()`,
    (value) => value?.forgetDisabled === false && value?.verifyPresent === false,
    30_000,
  );
  assertEqual(
    mobileAfter.fixtureState?.verificationCalls,
    1,
    'mobile exact verification count',
  );
  assertEqual(mobileAfter.fixtureState?.forgetCalls, 0, 'mobile Forget count');
  assertEqual(mobileAfter.fixtureState?.mutationCalls, 0, 'mobile mutation count');
  assertEqual(mobileAfter.uncaught.length, 0, 'mobile uncaught error count');
  assertEqual(
    mobileAfter.blockedFetches.length,
    0,
    'mobile blocked external fetch count',
  );
  await captureViewport(cdpClient, mobileRecoveryScreenshot);

  const mobileRequests = networkRequests
    .slice(mobileRequestStart)
    .filter((request) => request.origin === productionOrigin);
  assert(mobileRequests.length > 0, 'mobile fixture made local requests');
  for (const request of mobileRequests) {
    assertEqual(
      request.method,
      'GET',
      `mobile production request method for ${request.url}`,
    );
  }
  assertEqual(externalRequests.length, 0, 'mobile fixture cross-origin request count');
  await Promise.all([
    cdpClient.send('Emulation.setTouchEmulationEnabled', { enabled: false }),
    cdpClient.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }),
  ]);
  return {
    desktopRequestCount: productionRequests.length,
    mobileRequestCount: mobileRequests.length,
  };
}

async function click(cdpClient, selector, label) {
  const clicked = await evaluate(
    cdpClient,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  assert(clicked, `${label} control was not available`);
}

async function clickButtonByText(cdpClient, selector, text) {
  const clicked = await evaluate(
    cdpClient,
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(
        (candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)},
      );
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    })()`,
  );
  assert(clicked, `${text} control was not available`);
}

async function captureFullPage(cdpClient, path) {
  const metrics = await cdpClient.send('Page.getLayoutMetrics');
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const screenshot = await cdpClient.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    },
  });
  await writeFile(path, Buffer.from(screenshot.data, 'base64'));
}

async function captureViewport(cdpClient, path) {
  const screenshot = await cdpClient.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(screenshot.data, 'base64'));
}

function assert(condition, label) {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${label}; expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertOnlySameOriginResources(resources, origin) {
  const external = resources.filter((resource) => {
    const url = safeUrl(resource);
    return url && ['http:', 'https:'].includes(url.protocol) && url.origin !== origin;
  });
  assertEqual(external.length, 0, `external resources (${external.join(', ')})`);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
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
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error(
      'No local Chrome, Chromium, or Edge executable was found. Set CHROME_PATH to run native checks.',
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

async function waitForFile(path, timeoutMs, browserProcess) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertBrowserStillRunning(browserProcess, 'debugging startup');
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  assertBrowserStillRunning(browserProcess, 'debugging startup');
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForPageTarget(portNumber, url, timeoutMs, browserProcess) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertBrowserStillRunning(browserProcess, 'page-target startup');
    try {
      const response = await fetch(`http://127.0.0.1:${portNumber}/json`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === 'page' && target.url === url,
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome is still starting.
    }
    await delay(50);
  }
  assertBrowserStillRunning(browserProcess, 'page-target startup');
  throw new Error('Timed out waiting for the isolated browser target.');
}

function assertBrowserStillRunning(child, phase) {
  if (!child || (child.exitCode === null && child.signalCode === null)) return;
  throw new Error(
    `Chromium exited during ${phase} (exit code ${child.exitCode ?? 'none'}, signal ${child.signalCode ?? 'none'}).`,
  );
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
    `Timed out waiting for browser state. Last value: ${JSON.stringify(lastValue)}`,
  );
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
