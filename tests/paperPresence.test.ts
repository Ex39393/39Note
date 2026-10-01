import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { ViteDevServer } from 'vite';
import type {
  PaperPresenceGeneration,
  PaperPresenceGenerationBase,
} from '../src/sync/paperPresence.ts';

let server: ViteDevServer;
let PAPER_PRESENCE_PROTOCOL_VERSION: 1;
let SYNC_LAYOUT_VERSION: 3;
let PaperPresenceIntegrityError: typeof import('../src/sync/paperPresence.ts').PaperPresenceIntegrityError;
let createPaperPresenceGeneration: typeof import('../src/sync/paperPresence.ts').createPaperPresenceGeneration;
let parsePaperPresenceGeneration: typeof import('../src/sync/paperPresence.ts').parsePaperPresenceGeneration;
let resolvePaperPresence: typeof import('../src/sync/paperPresence.ts').resolvePaperPresence;
let verifyPaperPresenceGeneration: typeof import('../src/sync/paperPresence.ts').verifyPaperPresenceGeneration;
let stableStringify: typeof import('../src/sync/hash.ts').stableStringify;

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    appType: 'custom',
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true },
  });
  const [presence, hash, paperTypes] = await Promise.all([
    server.ssrLoadModule('/src/sync/paperPresence.ts') as Promise<
      typeof import('../src/sync/paperPresence.ts')
    >,
    server.ssrLoadModule('/src/sync/hash.ts') as Promise<
      typeof import('../src/sync/hash.ts')
    >,
    server.ssrLoadModule('/src/sync/paperTypes.ts') as Promise<
      typeof import('../src/sync/paperTypes.ts')
    >,
  ]);
  PAPER_PRESENCE_PROTOCOL_VERSION = presence.PAPER_PRESENCE_PROTOCOL_VERSION;
  SYNC_LAYOUT_VERSION = paperTypes.SYNC_LAYOUT_VERSION;
  PaperPresenceIntegrityError = presence.PaperPresenceIntegrityError;
  createPaperPresenceGeneration = presence.createPaperPresenceGeneration;
  parsePaperPresenceGeneration = presence.parsePaperPresenceGeneration;
  resolvePaperPresence = presence.resolvePaperPresence;
  verifyPaperPresenceGeneration = presence.verifyPaperPresenceGeneration;
  stableStringify = hash.stableStringify;
});

after(async () => server.close());

const writer = { deviceId: 'device-alpha', deviceLabel: 'Alpha' };

function base(
  overrides: Partial<PaperPresenceGenerationBase> = {},
): PaperPresenceGenerationBase {
  return {
    app: '39Note',
    syncLayoutVersion: SYNC_LAYOUT_VERSION,
    presenceProtocolVersion: PAPER_PRESENCE_PROTOCOL_VERSION,
    rootFolderId: 'root-id',
    controlFolderId: 'control-id',
    documentId: 'pdfjs:paper-a',
    displayName: 'Paper A.pdf',
    state: 'present',
    intent: 'migration',
    paperFolderId: 'paper-folder-a',
    writer,
    ...overrides,
  };
}

async function generation(
  overrides: Partial<PaperPresenceGenerationBase> = {},
  parents: readonly string[] = [],
  createdAt = 1,
): Promise<PaperPresenceGeneration> {
  const value = base(overrides);
  return createPaperPresenceGeneration(value, {
    createdAt,
    createdBy: value.writer.deviceId,
    parents,
  });
}

test('a verified initial present generation resolves an active paper', async () => {
  const present = await generation();
  const resolved = await resolvePaperPresence([present]);
  assert.equal(resolved.state, 'present');
  assert.equal(resolved.paperFolderId, 'paper-folder-a');
  assert.deepEqual(resolved.headIds, [present.generation.id]);
  assert.equal(await verifyPaperPresenceGeneration(present), true);
});

test('removed presence remains authoritative even while its stale physical folder exists', async () => {
  const present = await generation();
  const removed = await generation(
    { state: 'removed', intent: 'remove' },
    [present.generation.id],
    2,
  );
  const resolved = await resolvePaperPresence([present, removed]);
  assert.equal(resolved.state, 'removed');
  assert.equal(resolved.paperFolderId, 'paper-folder-a');
});

test('concurrent remove generations converge to removed without timestamp authority', async () => {
  const present = await generation();
  const [earlyTimestamp, lateTimestamp] = await Promise.all([
    generation(
      {
        state: 'removed',
        intent: 'remove',
        writer: { deviceId: 'device-bravo' },
      },
      [present.generation.id],
      9_999,
    ),
    generation(
      {
        state: 'removed',
        intent: 'remove',
        writer: { deviceId: 'device-charlie' },
      },
      [present.generation.id],
      1,
    ),
  ]);
  const resolved = await resolvePaperPresence([lateTimestamp, present, earlyTimestamp]);
  assert.equal(resolved.state, 'removed');
  assert.deepEqual(
    resolved.headIds,
    [earlyTimestamp.generation.id, lateTimestamp.generation.id].sort(),
  );
});

test('explicit restore must acknowledge a removed head and becomes present', async () => {
  const present = await generation();
  const removed = await generation(
    { state: 'removed', intent: 'remove' },
    [present.generation.id],
    2,
  );
  const restored = await generation(
    {
      state: 'present',
      intent: 'restore',
      paperFolderId: 'paper-folder-restored',
    },
    [removed.generation.id],
    3,
  );
  const resolved = await resolvePaperPresence([present, removed, restored]);
  assert.equal(resolved.state, 'present');
  assert.equal(resolved.paperFolderId, 'paper-folder-restored');
});

test('a stale ordinary upload generation cannot override removed presence', async () => {
  const present = await generation();
  const removed = await generation(
    { state: 'removed', intent: 'remove' },
    [present.generation.id],
    2,
  );
  await assert.rejects(
    () =>
      generation({ state: 'present', intent: 'upload' }, [present.generation.id], 3),
    PaperPresenceIntegrityError,
  );
  assert.equal((await resolvePaperPresence([present, removed])).state, 'removed');
});

test('restore must acknowledge every concurrent removed head to reach one present head', async () => {
  const present = await generation();
  const removeA = await generation(
    {
      state: 'removed',
      intent: 'remove',
      writer: { deviceId: 'device-bravo' },
    },
    [present.generation.id],
    2,
  );
  const removeB = await generation(
    {
      state: 'removed',
      intent: 'remove',
      writer: { deviceId: 'device-charlie' },
    },
    [present.generation.id],
    3,
  );
  const restore = await generation(
    { state: 'present', intent: 'restore', paperFolderId: 'paper-folder-new' },
    [removeA.generation.id, removeB.generation.id],
    4,
  );
  const resolved = await resolvePaperPresence([present, removeA, removeB, restore]);
  assert.equal(resolved.state, 'present');
  assert.deepEqual(resolved.headIds, [restore.generation.id]);
});

test('wrong document, control, or root boundaries fail closed', async () => {
  const present = await generation();
  for (const conflicting of [
    await generation({ documentId: 'pdfjs:paper-b' }),
    await generation({ controlFolderId: 'other-control' }),
    await generation({ rootFolderId: 'other-root' }),
  ]) {
    await assert.rejects(
      () => resolvePaperPresence([present, conflicting]),
      PaperPresenceIntegrityError,
    );
  }
});

test('hash corruption and malformed ancestry fail closed', async () => {
  const present = await generation();
  const corrupt = structuredClone(present);
  corrupt.displayName = 'Tampered name';
  assert.equal(await verifyPaperPresenceGeneration(corrupt), false);
  await assert.rejects(
    () => resolvePaperPresence([corrupt]),
    PaperPresenceIntegrityError,
  );

  const missingParent = await generation(
    { state: 'removed', intent: 'remove' },
    ['0'.repeat(64)],
    2,
  );
  await assert.rejects(
    () => resolvePaperPresence([present, missingParent]),
    PaperPresenceIntegrityError,
  );
});

test('unsupported presence protocol and non-canonical content are rejected', async () => {
  const present = await generation();
  const unsupported = structuredClone(present) as PaperPresenceGeneration & {
    presenceProtocolVersion: number;
  };
  unsupported.presenceProtocolVersion = 2;
  assert.throws(
    () => parsePaperPresenceGeneration(stableStringify(unsupported)),
    PaperPresenceIntegrityError,
  );
  assert.throws(
    () => parsePaperPresenceGeneration(JSON.stringify(present, null, 2)),
    PaperPresenceIntegrityError,
  );
});

test('display names are presentation only and never identity authority', async () => {
  const present = await generation();
  const removed = await generation(
    {
      state: 'removed',
      intent: 'remove',
      displayName: 'Renamed Paper.pdf',
    },
    [present.generation.id],
    2,
  );
  const resolved = await resolvePaperPresence([present, removed]);
  assert.equal(resolved.documentId, 'pdfjs:paper-a');
  assert.equal(resolved.displayName, 'Renamed Paper.pdf');
  assert.equal(resolved.state, 'removed');
});
