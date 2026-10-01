import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { haveEquivalentSyncContent } from '../src/sync/syncContent.ts';
import { DriveClient, DriveRequestError } from '../src/sync/driveClient.ts';
import {
  classifySyncError,
  createLocalChangesWaitingIssue,
  createResetIncompleteIssue,
  isTransientConnectivityIssue,
  issueForOfflineTransition,
} from '../src/sync/errorModel.ts';
import {
  GoogleAuthorizationCancelledError,
  PersistentGoogleAuthSession,
  SyncBackendUnavailableError,
  SyncServiceRateLimitedError,
} from '../src/sync/googleIdentity.ts';
import { LocalSyncPersistenceError } from '../src/sync/storage.ts';
import {
  SYNC_SCHEMA_VERSION,
  type LocalSyncSnapshot,
  type SyncSnapshot,
} from '../src/sync/types.ts';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('blocking attention survives offline and online transitions', () => {
  const offline = classifySyncError(undefined, { online: false, area: 'sync' });
  const localFailure = classifySyncError(new LocalSyncPersistenceError('write'), {
    online: true,
    area: 'sync',
  });
  const resetFailure = createResetIncompleteIssue();
  const driveFull = classifySyncError(
    new DriveRequestError(
      'provider text',
      403,
      'storage-full',
      'upload',
      'storageQuotaExceeded',
    ),
    { online: true, area: 'sync' },
  );

  assert.equal(issueForOfflineTransition(localFailure, offline), localFailure);
  assert.equal(issueForOfflineTransition(resetFailure, offline), resetFailure);
  assert.equal(issueForOfflineTransition(driveFull, offline), driveFull);
  assert.equal(isTransientConnectivityIssue(localFailure), false);
  assert.equal(isTransientConnectivityIssue(resetFailure), false);
  assert.equal(isTransientConnectivityIssue(offline), true);

  const waiting = createLocalChangesWaitingIssue();
  assert.equal(issueForOfflineTransition(waiting, offline), offline);

  const coordinator = source('../src/sync/coordinator.ts');
  assert.match(coordinator, /issueForOfflineTransition\(this\.view\.issue, offline\)/u);
  assert.match(
    coordinator,
    /if \(!this\.view\.issue \|\| isTransientConnectivityIssue\(this\.view\.issue\)\)/u,
  );
});

test('sign-in service errors distinguish initial connection from session retry', () => {
  const initial = classifySyncError(new SyncBackendUnavailableError(), {
    online: true,
    area: 'authentication',
    hasDeviceSession: false,
  });
  const existing = classifySyncError(new SyncBackendUnavailableError(), {
    online: true,
    area: 'authentication',
    hasDeviceSession: true,
  });
  const limited = classifySyncError(new SyncServiceRateLimitedError(), {
    online: true,
    area: 'authentication',
    hasDeviceSession: true,
  });

  assert.equal(initial.code, 'sync-service-unavailable');
  assert.equal(initial.state, 'disconnected');
  assert.deepEqual(initial.actions, ['reconnect']);
  assert.equal(existing.state, 'offline');
  assert.deepEqual(existing.actions, ['retry-now']);
  assert.equal(limited.code, 'sync-service-rate-limited');
  assert.notEqual(limited.code, 'google-authorization-required');
});

test('the OAuth broker exposes a stable rate-limit error', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const previousFetch = globalThis.fetch;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'http://127.0.0.1:5173/',
        assign() {},
      },
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      removeItem(key: string) {
        values.delete(key);
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
  });
  globalThis.fetch = (async () =>
    Response.json({ error: 'rate_limited' }, { status: 429 })) as typeof fetch;

  try {
    const identity = new PersistentGoogleAuthSession();
    identity.configure('https://sync.example.test', 'device-rate-limit');
    await assert.rejects(
      () => identity.beginAuthorization(),
      SyncServiceRateLimitedError,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreProperty('window', previousWindow);
    restoreProperty('sessionStorage', previousStorage);
  }
});

test('the OAuth broker treats a malformed HTTP 429 as rate limiting', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: 'http://127.0.0.1:5173/',
        assign() {},
      },
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem() {
        return null;
      },
      removeItem() {},
      setItem() {},
    },
  });
  globalThis.fetch = (async () =>
    new Response('not-json', { status: 429 })) as typeof fetch;

  try {
    const identity = new PersistentGoogleAuthSession();
    identity.configure('https://sync.example.test', 'device-rate-limit');
    await assert.rejects(
      () => identity.beginAuthorization(),
      SyncServiceRateLimitedError,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreProperty('window', previousWindow);
    restoreProperty('sessionStorage', previousStorage);
  }
});

test('authorization cancellation uses a stable class and reconnect action', () => {
  const issue = classifySyncError(new GoogleAuthorizationCancelledError(), {
    online: true,
    area: 'authentication',
    hasDeviceSession: false,
  });
  assert.equal(issue.code, 'authorization-cancelled');
  assert.deepEqual(issue.actions, ['reconnect']);
});

test('malformed Drive list and metadata responses are typed and sanitized', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.includes('/files?')
      ? Response.json({ nextPageToken: 7, files: [] })
      : Response.json({ id: 'missing-name-and-type' });
  }) as typeof fetch;

  try {
    const client = new DriveClient(() => 'test-token');
    await assert.rejects(
      () => client.listFiles('trashed=false', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError &&
        error.code === 'invalid-response' &&
        error.operation === 'list',
    );
    await assert.rejects(
      () => client.getMetadata('file-id', new AbortController().signal),
      (error: unknown) =>
        error instanceof DriveRequestError &&
        error.code === 'invalid-response' &&
        error.operation === 'metadata',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the UI diagnostic boundary rejects arbitrary provider reasons', () => {
  const issue = classifySyncError(
    new DriveRequestError(
      'raw provider object',
      403,
      'permission-denied',
      'metadata',
      'secret-provider-detail',
    ),
    { online: true, area: 'sync' },
  );
  assert.equal(issue.code, 'drive-access-denied');
  assert.equal(issue.diagnostic.reason, undefined);
  assert.doesNotMatch(issue.message, /raw provider|secret-provider/iu);
});

test('PDF blobs do not make an otherwise identical no-op sync look like work', () => {
  const descriptor = {
    documentId: 'doc-1',
    fileName: 'paper.pdf',
    mimeType: 'application/pdf',
    size: 3,
    lastModified: 10,
    storedAt: 11,
    sha256: 'abc123',
    fileId: 'drive-pdf-1',
  };
  const remote: SyncSnapshot = {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: 100,
    generatedBy: 'device-a',
    entities: [],
    tombstones: [],
    pdfs: [descriptor],
  };
  const local: LocalSyncSnapshot = {
    ...remote,
    pdfs: [{ ...descriptor, blob: new Blob(['pdf']) }],
  };

  assert.equal(haveEquivalentSyncContent(local, remote), true);
  assert.equal(
    haveEquivalentSyncContent(
      {
        ...local,
        entities: [
          {
            key: 'document::doc-1',
            kind: 'document',
            id: 'doc-1',
            value: { title: 'Changed' },
            version: { updatedAt: 12, deviceId: 'device-a', hash: 'changed' },
          },
        ],
      },
      remote,
    ),
    false,
  );
});

test('dirty notifications consume reported persistence failures', () => {
  const coordinator = source('../src/sync/coordinator.ts');
  assert.match(
    coordinator,
    /subscribeToPersistentChanges\(\s*\(\) => void this\.markDirty\(\)\.catch\(\(\) => undefined\)/u,
  );
  assert.match(coordinator, /async retryNow\(\): Promise<void>/u);
  assert.doesNotMatch(
    source('../src/sync/errorModel.ts'),
    /Your local data is unchanged/u,
  );
});

function restoreProperty(
  key: 'window' | 'sessionStorage',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}
