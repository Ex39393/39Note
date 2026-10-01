import assert from 'node:assert/strict';
import test from 'node:test';
import { DriveClient, type DriveFileMetadata } from '../src/sync/driveClient.ts';
import {
  DriveRootUnavailableError,
  GoogleDriveSyncRepository,
} from '../src/sync/driveRepository.ts';
import type { SyncDeviceState } from '../src/sync/types.ts';

const ROOT_MIME = 'application/vnd.google-apps.folder';

function deviceState(): SyncDeviceState {
  return {
    id: 'device',
    deviceId: 'device-root-safety',
    autoSync: true,
    dirty: false,
    dirtyGeneration: 0,
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    pdfFingerprints: {},
    driveFiles: { fileIds: {} },
  };
}

function isAppOwnedRootQuery(query: string): boolean {
  return query.includes("role' and value='root");
}

test('root discovery exhausts the confirmation pass before creating a duplicate', async () => {
  const root: DriveFileMetadata = {
    id: 'root-confirmed-on-page-2',
    name: '39Note',
    mimeType: ROOT_MIME,
    trashed: false,
    appProperties: {
      application: '39Note',
      syncSchema: '1',
      role: 'root',
    },
  };
  const rootPageTokens: Array<string | null> = [];
  let rootPass = 0;
  let createCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      createCalls += 1;
      return Response.json(root);
    }

    const query = url.searchParams.get('q') ?? '';
    if (isAppOwnedRootQuery(query)) {
      const pageToken = url.searchParams.get('pageToken');
      rootPageTokens.push(pageToken);
      if (!pageToken) rootPass += 1;
      if (rootPass === 2 && !pageToken) {
        return Response.json({ files: [], nextPageToken: 'root-confirmation-page-2' });
      }
      if (rootPass === 2 && pageToken === 'root-confirmation-page-2') {
        return Response.json({ files: [root] });
      }
      return Response.json({ files: [] });
    }
    return Response.json({ files: [] });
  }) as typeof fetch;

  try {
    const state = deviceState();
    const pulled = await new GoogleDriveSyncRepository(
      new DriveClient(() => 'fake-google-oauth-token'),
    ).pull(state, new AbortController().signal);

    assert.equal(pulled.rootFolderId, root.id);
    assert.equal(state.driveFiles.rootFolderId, root.id);
    assert.equal(createCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(rootPageTokens, [null, null, 'root-confirmation-page-2']);
  assert.equal(rootPass, 2);
});

test('exhaustive absence on both passes still auto-creates the first root', async () => {
  const createdRoot: DriveFileMetadata = {
    id: 'root-first-use',
    name: '39Note',
    mimeType: ROOT_MIME,
    trashed: false,
    appProperties: {
      application: '39Note',
      syncSchema: '1',
      role: 'root',
    },
  };
  let created = false;
  let createCalls = 0;
  let appOwnedRootPasses = 0;
  let exactNamePasses = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      createCalls += 1;
      created = true;
      return Response.json(createdRoot);
    }

    const query = url.searchParams.get('q') ?? '';
    if (isAppOwnedRootQuery(query)) {
      appOwnedRootPasses += 1;
      return Response.json({ files: created ? [createdRoot] : [] });
    }
    if (query.includes("name='39Note'") && query.includes(`mimeType='${ROOT_MIME}'`)) {
      exactNamePasses += 1;
      return Response.json({ files: [] });
    }
    return Response.json({ files: [] });
  }) as typeof fetch;

  try {
    const state = deviceState();
    const pulled = await new GoogleDriveSyncRepository(
      new DriveClient(() => 'fake-google-oauth-token'),
    ).pull(state, new AbortController().signal);

    assert.equal(pulled.rootFolderId, createdRoot.id);
    assert.equal(state.driveFiles.rootFolderId, createdRoot.id);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(createCalls, 1);
  assert.equal(appOwnedRootPasses, 3);
  assert.equal(exactNamePasses, 2);
});

test('a cached root 404 still fails closed without discovery or replacement', async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    return Response.json(
      { error: { message: 'The cached root no longer exists.' } },
      { status: 404 },
    );
  }) as typeof fetch;

  try {
    const state = deviceState();
    state.driveFiles.rootFolderId = 'missing-cached-root';
    const repository = new GoogleDriveSyncRepository(
      new DriveClient(() => 'fake-google-oauth-token'),
    );

    await assert.rejects(
      () => repository.pull(state, new AbortController().signal),
      DriveRootUnavailableError,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.match(requests[0].url, /missing-cached-root/u);
});
