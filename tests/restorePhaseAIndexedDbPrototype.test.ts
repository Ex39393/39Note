import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

type StoreContents = Map<string, unknown>;

interface SyntheticDatabaseImage {
  version: number;
  stores: Map<string, StoreContents>;
  schemas: Map<string, SyntheticObjectStoreSchema>;
  connections: Set<SyntheticDatabaseConnection>;
}

interface SyntheticObjectStoreSchema {
  indexes: Map<string, string>;
  keyPath: string;
}

interface VersionChangeNotice {
  oldVersion: number;
  newVersion: number;
}

interface OpenOptions {
  blocked?: (notice: VersionChangeNotice, blockers: number) => void;
  upgrade?: (database: SyntheticUpgradeDatabase, notice: VersionChangeNotice) => void;
  versionchange?: (
    connection: SyntheticDatabaseConnection,
    notice: VersionChangeNotice,
  ) => void;
}

interface SyntheticWriteTransaction {
  delete(storeName: string, key: string): void;
  put(storeName: string, key: string, value: unknown): void;
}

interface WriteOptions {
  committed?: () => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

const DOCUMENT_STORE_NAMES = ['collections', 'document-states', 'pdf-files'] as const;
const DOCUMENT_RESTORE_STORE_NAMES = [
  'restore-operations',
  'restore-snapshots',
] as const;
const PRODUCTIVITY_STORE_NAMES = [
  'ai-conversations',
  'print-drafts',
  'rendered-print-pdfs',
] as const;
const PRODUCTIVITY_RESTORE_STORE_NAMES = ['restore-snapshots'] as const;
const SYNTHETIC_DATABASE_PATTERN =
  /^39note-bkp03-prototype-(?:docs|productivity)-[0-9a-f-]{36}$/u;

class SyntheticUpgradeDatabase {
  readonly stores: Map<string, StoreContents>;
  readonly schemas: Map<string, SyntheticObjectStoreSchema>;

  constructor(
    stores: Map<string, StoreContents>,
    schemas: Map<string, SyntheticObjectStoreSchema>,
  ) {
    this.stores = stores;
    this.schemas = schemas;
  }

  createObjectStore(
    storeName: string,
    options: { keyPath: string },
  ): SyntheticUpgradeObjectStore {
    if (this.stores.has(storeName)) {
      throw idbException(
        'ConstraintError',
        `Object store ${storeName} already exists.`,
      );
    }
    this.stores.set(storeName, new Map());
    const schema = { indexes: new Map<string, string>(), keyPath: options.keyPath };
    this.schemas.set(storeName, schema);
    return new SyntheticUpgradeObjectStore(schema);
  }

  hasObjectStore(storeName: string): boolean {
    return this.stores.has(storeName);
  }

  objectStoreNames(): string[] {
    return [...this.stores.keys()].sort();
  }
}

class SyntheticUpgradeObjectStore {
  private readonly schema: SyntheticObjectStoreSchema;

  constructor(schema: SyntheticObjectStoreSchema) {
    this.schema = schema;
  }

  createIndex(indexName: string, keyPath: string): void {
    if (this.schema.indexes.has(indexName)) {
      throw idbException('ConstraintError', `Index ${indexName} already exists.`);
    }
    this.schema.indexes.set(indexName, keyPath);
  }
}

class SyntheticDatabaseConnection {
  readonly version: number;

  private readonly image: SyntheticDatabaseImage;
  private readonly onVersionChange?: OpenOptions['versionchange'];
  private readonly activeWrites = new Set<Promise<void>>();
  private readonly closed = deferred<void>();
  private closeRequested = false;
  private detached = false;

  constructor(
    image: SyntheticDatabaseImage,
    onVersionChange?: OpenOptions['versionchange'],
  ) {
    this.image = image;
    this.onVersionChange = onVersionChange;
    this.version = image.version;
  }

  close(): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    this.finishCloseWhenIdle();
  }

  dispatchVersionChange(notice: VersionChangeNotice): void {
    this.onVersionChange?.(this, notice);
  }

  get(storeName: string, key: string): unknown {
    this.assertUsable();
    return cloneValue(requiredStore(this.image.stores, storeName).get(key));
  }

  isClosed(): boolean {
    return this.detached;
  }

  objectStoreNames(): string[] {
    this.assertUsable();
    return [...this.image.stores.keys()].sort();
  }

  waitUntilClosed(): Promise<void> {
    return this.closed.promise;
  }

  async waitUntilWritesFinish(): Promise<void> {
    while (this.activeWrites.size > 0) {
      await Promise.allSettled([...this.activeWrites]);
    }
  }

  write(
    work: (transaction: SyntheticWriteTransaction) => void | Promise<void>,
    options: WriteOptions = {},
  ): Promise<void> {
    this.assertUsable();
    const operations: Array<
      | { kind: 'delete'; key: string; storeName: string }
      | { kind: 'put'; key: string; storeName: string; value: unknown }
    > = [];
    const transaction: SyntheticWriteTransaction = {
      delete: (storeName, key) => {
        requiredStore(this.image.stores, storeName);
        operations.push({ kind: 'delete', key, storeName });
      },
      put: (storeName, key, value) => {
        requiredStore(this.image.stores, storeName);
        operations.push({
          kind: 'put',
          key,
          storeName,
          value: cloneValue(value),
        });
      },
    };

    const pendingWrite = Promise.resolve().then(async () => {
      await work(transaction);
      const nextStores = cloneStores(this.image.stores);
      for (const operation of operations) {
        const store = requiredStore(nextStores, operation.storeName);
        if (operation.kind === 'delete') {
          store.delete(operation.key);
        } else {
          store.set(operation.key, cloneValue(operation.value));
        }
      }
      this.image.stores = nextStores;
      options.committed?.();
    });

    this.activeWrites.add(pendingWrite);
    void pendingWrite.finally(() => {
      this.activeWrites.delete(pendingWrite);
      this.finishCloseWhenIdle();
    });
    return pendingWrite;
  }

  private assertUsable(): void {
    if (this.closeRequested || this.detached) {
      throw idbException('InvalidStateError', 'The connection is closed.');
    }
    if (this.version !== this.image.version) {
      throw idbException(
        'VersionError',
        'The connection does not match the authoritative database version.',
      );
    }
  }

  private finishCloseWhenIdle(): void {
    if (!this.closeRequested || this.detached || this.activeWrites.size > 0) {
      return;
    }
    this.detached = true;
    this.image.connections.delete(this);
    this.closed.resolve(undefined);
  }
}

class SyntheticIndexedDbFactory {
  private readonly databases = new Map<string, SyntheticDatabaseImage>();

  inspect(databaseName: string): {
    schemas: Map<string, SyntheticObjectStoreSchema>;
    stores: Map<string, StoreContents>;
    version: number;
  } {
    const image = this.requiredDatabase(databaseName);
    return {
      schemas: cloneSchemas(image.schemas),
      stores: cloneStores(image.stores),
      version: image.version,
    };
  }

  async open(
    databaseName: string,
    requestedVersion: number,
    options: OpenOptions = {},
  ): Promise<SyntheticDatabaseConnection> {
    assertSyntheticDatabaseName(databaseName);
    const image = this.requiredDatabase(databaseName);
    if (requestedVersion < image.version) {
      throw idbException(
        'VersionError',
        `Version ${requestedVersion} is older than ${image.version}.`,
      );
    }
    if (requestedVersion === image.version) {
      return this.connect(image, options.versionchange);
    }

    const notice = {
      oldVersion: image.version,
      newVersion: requestedVersion,
    };
    const legacyConnections = [...image.connections];

    // Native IndexedDB lets an already-running transaction finish before the
    // versionchange request can become authoritative.
    await Promise.all(
      legacyConnections.map((connection) => connection.waitUntilWritesFinish()),
    );
    for (const connection of legacyConnections) {
      connection.dispatchVersionChange(notice);
    }

    const blockers = legacyConnections.filter((connection) => !connection.isClosed());
    if (blockers.length > 0) {
      options.blocked?.(notice, blockers.length);
      await Promise.all(blockers.map((connection) => connection.waitUntilClosed()));
    }

    // The upgrade callback receives a copy. Only a successful callback swaps
    // the entire schema image into place, modeling an atomic versionchange
    // transaction rather than exposing half-created stores.
    const candidateStores = cloneStores(image.stores);
    const candidateSchemas = cloneSchemas(image.schemas);
    options.upgrade?.(
      new SyntheticUpgradeDatabase(candidateStores, candidateSchemas),
      notice,
    );
    image.stores = candidateStores;
    image.schemas = candidateSchemas;
    image.version = requestedVersion;
    return this.connect(image, options.versionchange);
  }

  seed(
    databaseName: string,
    version: number,
    stores: Map<string, StoreContents>,
  ): void {
    assertSyntheticDatabaseName(databaseName);
    assert.equal(this.databases.has(databaseName), false);
    this.databases.set(databaseName, {
      connections: new Set(),
      schemas: schemasForPreUpgradeStores(stores),
      stores: cloneStores(stores),
      version,
    });
  }

  private connect(
    image: SyntheticDatabaseImage,
    versionchange: OpenOptions['versionchange'],
  ): SyntheticDatabaseConnection {
    const connection = new SyntheticDatabaseConnection(image, versionchange);
    image.connections.add(connection);
    return connection;
  }

  private requiredDatabase(databaseName: string): SyntheticDatabaseImage {
    const database = this.databases.get(databaseName);
    assert.ok(database, `Synthetic database ${databaseName} was not seeded.`);
    return database;
  }
}

test('document database prototype upgrades physical v4 to v5 without changing records or Blob bytes', async () => {
  const factory = new SyntheticIndexedDbFactory();
  const databaseName = syntheticDatabaseName('docs');
  const stores = documentV4Stores();
  factory.seed(databaseName, 4, stores);
  const before = await fingerprintStores(stores);
  const sourceHashBefore = await hashBlob(
    requiredStore(stores, 'pdf-files').get('synthetic-document') as BlobRecord,
  );
  let upgradeCalls = 0;
  let storesCreated = 0;

  const upgraded = await factory.open(databaseName, 5, {
    upgrade(database, notice) {
      upgradeCalls += 1;
      assert.deepEqual(notice, { oldVersion: 4, newVersion: 5 });
      for (const storeName of DOCUMENT_RESTORE_STORE_NAMES) {
        assert.equal(database.hasObjectStore(storeName), false);
        database.createObjectStore(storeName, {
          keyPath: restoreStoreKeyPath(storeName),
        });
        storesCreated += 1;
      }
    },
  });

  const afterUpgrade = factory.inspect(databaseName);
  assert.equal(afterUpgrade.version, 5);
  assert.equal(upgradeCalls, 1);
  assert.equal(storesCreated, DOCUMENT_RESTORE_STORE_NAMES.length);
  assert.deepEqual(
    upgraded.objectStoreNames(),
    [...DOCUMENT_STORE_NAMES, ...DOCUMENT_RESTORE_STORE_NAMES].sort(),
  );
  assert.deepEqual(schemaSnapshot(afterUpgrade.schemas), {
    collections: { indexes: {}, keyPath: 'id' },
    'document-states': { indexes: {}, keyPath: 'documentId' },
    'pdf-files': { indexes: {}, keyPath: 'documentId' },
    'restore-operations': { indexes: {}, keyPath: 'operationId' },
    'restore-snapshots': { indexes: {}, keyPath: 'snapshotId' },
  });
  assert.deepEqual(
    await fingerprintStores(afterUpgrade.stores, DOCUMENT_STORE_NAMES),
    before,
  );
  assert.equal(
    await hashBlob(
      requiredStore(afterUpgrade.stores, 'pdf-files').get(
        'synthetic-document',
      ) as BlobRecord,
    ),
    sourceHashBefore,
  );
  assert.deepEqual(
    requiredStore(afterUpgrade.stores, 'document-states').get('synthetic-document'),
    requiredStore(stores, 'document-states').get('synthetic-document'),
  );
  assert.deepEqual(
    requiredStore(afterUpgrade.stores, 'collections').get('synthetic-collection'),
    requiredStore(stores, 'collections').get('synthetic-collection'),
  );
  upgraded.close();

  const reopened = await factory.open(databaseName, 5, {
    upgrade() {
      upgradeCalls += 1;
    },
  });
  assert.equal(upgradeCalls, 1, 'reopening v5 must not rerun the upgrade');
  assert.deepEqual(
    reopened.objectStoreNames(),
    [...DOCUMENT_STORE_NAMES, ...DOCUMENT_RESTORE_STORE_NAMES].sort(),
  );
  reopened.close();
});

test('productivity database prototype upgrades physical v2 to v3 exactly once and preserves every record', async () => {
  const factory = new SyntheticIndexedDbFactory();
  const databaseName = syntheticDatabaseName('productivity');
  const stores = productivityV2Stores();
  factory.seed(databaseName, 2, stores);
  const before = await fingerprintStores(stores);
  const printHashBefore = await hashBlob(
    requiredStore(stores, 'rendered-print-pdfs').get(
      'synthetic-document',
    ) as BlobRecord,
  );
  let upgradeCalls = 0;

  const upgraded = await factory.open(databaseName, 3, {
    upgrade(database, notice) {
      upgradeCalls += 1;
      assert.deepEqual(notice, { oldVersion: 2, newVersion: 3 });
      for (const storeName of PRODUCTIVITY_RESTORE_STORE_NAMES) {
        database.createObjectStore(storeName, {
          keyPath: restoreStoreKeyPath(storeName),
        });
      }
    },
  });

  const afterUpgrade = factory.inspect(databaseName);
  assert.equal(afterUpgrade.version, 3);
  assert.equal(upgradeCalls, 1);
  assert.deepEqual(
    upgraded.objectStoreNames(),
    [...PRODUCTIVITY_STORE_NAMES, ...PRODUCTIVITY_RESTORE_STORE_NAMES].sort(),
  );
  assert.deepEqual(schemaSnapshot(afterUpgrade.schemas), {
    'ai-conversations': {
      indexes: { 'by-document': 'documentId' },
      keyPath: 'id',
    },
    'print-drafts': { indexes: {}, keyPath: 'documentId' },
    'rendered-print-pdfs': { indexes: {}, keyPath: 'documentId' },
    'restore-snapshots': { indexes: {}, keyPath: 'snapshotId' },
  });
  assert.deepEqual(
    await fingerprintStores(afterUpgrade.stores, PRODUCTIVITY_STORE_NAMES),
    before,
  );
  assert.equal(
    await hashBlob(
      requiredStore(afterUpgrade.stores, 'rendered-print-pdfs').get(
        'synthetic-document',
      ) as BlobRecord,
    ),
    printHashBefore,
  );
  upgraded.close();

  const reopened = await factory.open(databaseName, 3, {
    upgrade() {
      upgradeCalls += 1;
    },
  });
  assert.equal(upgradeCalls, 1);
  reopened.close();
});

test('failed versionchange callbacks atomically retain the old version, schema, records, and Blob hashes', async (context) => {
  for (const errorName of ['AbortError', 'QuotaExceededError']) {
    await context.test(errorName, async () => {
      const factory = new SyntheticIndexedDbFactory();
      const databaseName = syntheticDatabaseName('docs');
      const stores = documentV4Stores();
      const before = await fingerprintStores(stores);
      const sourceHashBefore = await hashBlob(
        requiredStore(stores, 'pdf-files').get('synthetic-document') as BlobRecord,
      );
      factory.seed(databaseName, 4, stores);
      const schemaBefore = schemaSnapshot(factory.inspect(databaseName).schemas);

      await assert.rejects(
        factory.open(databaseName, 5, {
          upgrade(database) {
            database.createObjectStore('restore-operations', {
              keyPath: restoreStoreKeyPath('restore-operations'),
            });
            throw idbException(errorName, `Injected ${errorName}`);
          },
        }),
        (error: unknown) => error instanceof DOMException && error.name === errorName,
      );

      const unchanged = factory.inspect(databaseName);
      assert.equal(unchanged.version, 4);
      assert.deepEqual(
        [...unchanged.stores.keys()].sort(),
        [...DOCUMENT_STORE_NAMES].sort(),
      );
      assert.deepEqual(schemaSnapshot(unchanged.schemas), schemaBefore);
      assert.deepEqual(await fingerprintStores(unchanged.stores), before);
      assert.equal(
        await hashBlob(
          requiredStore(unchanged.stores, 'pdf-files').get(
            'synthetic-document',
          ) as BlobRecord,
        ),
        sourceHashBefore,
      );
    });
  }
});

test('a cooperative legacy connection closes on versionchange and allows an unblocked upgrade', async () => {
  const factory = new SyntheticIndexedDbFactory();
  const databaseName = syntheticDatabaseName('docs');
  factory.seed(databaseName, 4, documentV4Stores());
  const notices: VersionChangeNotice[] = [];
  const legacy = await factory.open(databaseName, 4, {
    versionchange(connection, notice) {
      notices.push(notice);
      connection.close();
    },
  });
  let blockedCalls = 0;

  const upgraded = await factory.open(databaseName, 5, {
    blocked() {
      blockedCalls += 1;
    },
    upgrade(database) {
      for (const storeName of DOCUMENT_RESTORE_STORE_NAMES) {
        database.createObjectStore(storeName, {
          keyPath: restoreStoreKeyPath(storeName),
        });
      }
    },
  });

  assert.deepEqual(notices, [{ oldVersion: 4, newVersion: 5 }]);
  assert.equal(blockedCalls, 0);
  assert.equal(legacy.isClosed(), true);
  assert.equal(factory.inspect(databaseName).version, 5);
  upgraded.close();
});

test('an uncooperative legacy connection blocks upgrade and restoration admission until explicitly closed', async () => {
  const factory = new SyntheticIndexedDbFactory();
  const databaseName = syntheticDatabaseName('docs');
  factory.seed(databaseName, 4, documentV4Stores());
  const legacy = await factory.open(databaseName, 4);
  const upgradeBlocked = deferred<number>();
  let upgradeSettled = false;
  let restorationAdmitted = false;

  const upgradeRequest = factory
    .open(databaseName, 5, {
      blocked(_notice, blockers) {
        upgradeBlocked.resolve(blockers);
      },
      upgrade(database) {
        for (const storeName of DOCUMENT_RESTORE_STORE_NAMES) {
          database.createObjectStore(storeName, {
            keyPath: restoreStoreKeyPath(storeName),
          });
        }
      },
    })
    .then((connection) => {
      upgradeSettled = true;
      restorationAdmitted = true;
      return connection;
    });

  assert.equal(await upgradeBlocked.promise, 1);
  await drainMicrotasks();
  assert.equal(upgradeSettled, false);
  assert.equal(restorationAdmitted, false);
  assert.equal(factory.inspect(databaseName).version, 4);
  assert.equal(
    factory.inspect(databaseName).stores.has(DOCUMENT_RESTORE_STORE_NAMES[0]),
    false,
  );

  await legacy.write((transaction) => {
    transaction.put('document-states', 'late-before-upgrade', {
      documentId: 'late-before-upgrade',
      displayTitle: 'Committed while the upgrade was still blocked',
      schemaVersion: 9,
    });
  });
  legacy.close();
  const upgraded = await upgradeRequest;

  assert.equal(upgradeSettled, true);
  assert.equal(restorationAdmitted, true);
  assert.equal(factory.inspect(databaseName).version, 5);
  assert.deepEqual(upgraded.get('document-states', 'late-before-upgrade'), {
    documentId: 'late-before-upgrade',
    displayTitle: 'Committed while the upgrade was still blocked',
    schemaVersion: 9,
  });
  assert.throws(
    () =>
      legacy.write((transaction) => {
        transaction.put('document-states', 'unsafe-after-upgrade', {});
      }),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'InvalidStateError',
  );
  await assert.rejects(
    factory.open(databaseName, 4),
    (error: unknown) => error instanceof DOMException && error.name === 'VersionError',
  );
  assert.equal(
    requiredStore(factory.inspect(databaseName).stores, 'document-states').has(
      'unsafe-after-upgrade',
    ),
    false,
  );
  upgraded.close();
});

test('a write already active before upgrade commits first and its bytes are included in the authoritative v5 image', async () => {
  const factory = new SyntheticIndexedDbFactory();
  const databaseName = syntheticDatabaseName('docs');
  factory.seed(databaseName, 4, documentV4Stores());
  const events: string[] = [];
  const writeEntered = deferred<void>();
  const releaseWrite = deferred<void>();
  const legacy = await factory.open(databaseName, 4, {
    versionchange(connection) {
      events.push('versionchange');
      connection.close();
    },
  });

  const write = legacy.write(
    async (transaction) => {
      events.push('write-start');
      writeEntered.resolve(undefined);
      await releaseWrite.promise;
      transaction.put('pdf-files', 'pre-upgrade-source', {
        blob: new Blob(['pre-upgrade bytes'], { type: 'application/pdf' }),
        documentId: 'pre-upgrade-source',
        fileName: 'pre-upgrade.pdf',
        mimeType: 'application/pdf',
      });
    },
    { committed: () => events.push('write-commit') },
  );
  await writeEntered.promise;
  events.push('upgrade-request');

  const upgrade = factory.open(databaseName, 5, {
    upgrade(database) {
      events.push('upgrade-callback');
      for (const storeName of DOCUMENT_RESTORE_STORE_NAMES) {
        database.createObjectStore(storeName, {
          keyPath: restoreStoreKeyPath(storeName),
        });
      }
    },
  });
  await drainMicrotasks();
  assert.deepEqual(events, ['write-start', 'upgrade-request']);

  releaseWrite.resolve(undefined);
  await write;
  const upgraded = await upgrade;
  assert.deepEqual(events, [
    'write-start',
    'upgrade-request',
    'write-commit',
    'versionchange',
    'upgrade-callback',
  ]);
  const stored = upgraded.get('pdf-files', 'pre-upgrade-source') as BlobRecord;
  assert.equal(
    await hashBlob(stored),
    createHash('sha256').update('pre-upgrade bytes').digest('hex'),
  );
  upgraded.close();
});

interface BlobRecord {
  blob: Blob;
}

function documentV4Stores(): Map<string, StoreContents> {
  const documentId = 'synthetic-document';
  return new Map<string, StoreContents>([
    [
      'document-states',
      new Map([
        [
          documentId,
          {
            annotations: [
              {
                color: 'yellow',
                id: 'synthetic-highlight',
                pageNumber: 1,
                selectedText: 'Synthetic highlighted text',
                type: 'highlight',
              },
              {
                color: 'blue',
                id: 'synthetic-underline',
                pageNumber: 2,
                selectedText: 'Synthetic underlined text',
                type: 'underline',
              },
            ],
            collectionIds: ['synthetic-collection'],
            displayTitle: 'BKP-03 Synthetic Paper',
            documentId,
            documentType: 'pdf',
            glossaryEntries: [
              {
                definition: 'A synthetic definition.',
                id: 'synthetic-glossary',
                term: 'Prototype',
              },
            ],
            links: [
              {
                documentId,
                endpoints: [
                  {
                    annotationId: 'synthetic-highlight',
                    documentId,
                    pageNumber: 1,
                  },
                  {
                    annotationId: 'synthetic-underline',
                    documentId,
                    pageNumber: 2,
                  },
                ],
                id: 'synthetic-link',
                number: 1,
              },
            ],
            nextLinkNumber: 2,
            nextNoteNumber: 2,
            noteAnchors: [],
            notes: [
              {
                annotationId: 'synthetic-highlight',
                content: 'Synthetic note content',
                documentId,
                id: 'synthetic-note',
                number: 1,
              },
            ],
            officeAnnotations: [],
            originalFileName: 'bkp03-synthetic.pdf',
            schemaVersion: 9,
            updatedAt: 1_700_000_000_000,
          },
        ],
      ]),
    ],
    [
      'pdf-files',
      new Map([
        [
          documentId,
          {
            blob: new Blob(['%PDF-1.7\n% synthetic BKP-03 source\n%%EOF\n'], {
              type: 'application/pdf',
            }),
            documentId,
            documentType: 'pdf',
            fileName: 'bkp03-synthetic.pdf',
            lastModified: 1_700_000_000_000,
            mimeType: 'application/pdf',
            sha256: 'synthetic-source-hash-metadata',
            size: 45,
            storedAt: 1_700_000_000_100,
          },
        ],
      ]),
    ],
    [
      'collections',
      new Map([
        [
          'synthetic-collection',
          {
            createdAt: 1_700_000_000_000,
            id: 'synthetic-collection',
            name: 'Synthetic Research',
            updatedAt: 1_700_000_000_200,
          },
        ],
      ]),
    ],
  ]);
}

function productivityV2Stores(): Map<string, StoreContents> {
  const documentId = 'synthetic-document';
  return new Map<string, StoreContents>([
    [
      'print-drafts',
      new Map([
        [
          documentId,
          {
            additions: [],
            documentId,
            name: 'Synthetic print draft',
            schemaVersion: 1,
            updatedAt: 1_700_000_000_300,
          },
        ],
      ]),
    ],
    [
      'rendered-print-pdfs',
      new Map([
        [
          documentId,
          {
            blob: new Blob(['%PDF-1.7\n% synthetic BKP-03 print artifact\n%%EOF\n'], {
              type: 'application/pdf',
            }),
            documentId,
            generatedAt: 1_700_000_000_400,
            sha256: 'synthetic-print-hash-metadata',
          },
        ],
      ]),
    ],
    [
      'ai-conversations',
      new Map([
        [
          'synthetic-conversation',
          {
            documentId,
            id: 'synthetic-conversation',
            messages: [
              {
                content: 'Summarize the synthetic test paper.',
                id: 'synthetic-message',
                role: 'user',
              },
            ],
            updatedAt: 1_700_000_000_500,
          },
        ],
      ]),
    ],
  ]);
}

function syntheticDatabaseName(kind: 'docs' | 'productivity'): string {
  return `39note-bkp03-prototype-${kind}-${randomUUID()}`;
}

function assertSyntheticDatabaseName(databaseName: string): void {
  assert.match(databaseName, SYNTHETIC_DATABASE_PATTERN);
  assert.notEqual(databaseName, '39note-db');
  assert.notEqual(databaseName, '39note-productivity-db');
}

function cloneSchemas(
  schemas: Map<string, SyntheticObjectStoreSchema>,
): Map<string, SyntheticObjectStoreSchema> {
  return new Map(
    [...schemas].map(([storeName, schema]) => [
      storeName,
      {
        indexes: new Map(schema.indexes),
        keyPath: schema.keyPath,
      },
    ]),
  );
}

function schemasForPreUpgradeStores(
  stores: Map<string, StoreContents>,
): Map<string, SyntheticObjectStoreSchema> {
  return new Map(
    [...stores.keys()].map((storeName) => {
      const keyPath =
        storeName === 'collections'
          ? 'id'
          : storeName === 'ai-conversations'
            ? 'id'
            : 'documentId';
      const indexes =
        storeName === 'ai-conversations'
          ? new Map([['by-document', 'documentId']])
          : new Map<string, string>();
      return [storeName, { indexes, keyPath }];
    }),
  );
}

function schemaSnapshot(
  schemas: Map<string, SyntheticObjectStoreSchema>,
): Record<string, { indexes: Record<string, string>; keyPath: string }> {
  return Object.fromEntries(
    [...schemas]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([storeName, schema]) => [
        storeName,
        {
          indexes: Object.fromEntries([...schema.indexes].sort()),
          keyPath: schema.keyPath,
        },
      ]),
  );
}

function restoreStoreKeyPath(
  storeName: (typeof DOCUMENT_RESTORE_STORE_NAMES)[number],
): string {
  return storeName === 'restore-operations' ? 'operationId' : 'snapshotId';
}

function cloneStores(stores: Map<string, StoreContents>): Map<string, StoreContents> {
  return new Map(
    [...stores].map(([storeName, records]) => [
      storeName,
      new Map([...records].map(([key, value]) => [key, cloneValue(value)])),
    ]),
  );
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function deferred<T>(): Deferred<T> {
  let reject!: Deferred<T>['reject'];
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function fingerprintStores(
  stores: Map<string, StoreContents>,
  selectedStoreNames: readonly string[] = [...stores.keys()],
): Promise<Record<string, Record<string, string>>> {
  const fingerprint: Record<string, Record<string, string>> = {};
  for (const storeName of [...selectedStoreNames].sort()) {
    const records = requiredStore(stores, storeName);
    fingerprint[storeName] = {};
    for (const [key, value] of [...records].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      fingerprint[storeName][key] = createHash('sha256')
        .update(JSON.stringify(await canonicalValue(value)))
        .digest('hex');
    }
  }
  return fingerprint;
}

async function canonicalValue(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return {
      $blob: true,
      bytes: await hashRawBlob(value),
      size: value.size,
      type: value.type,
    };
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => canonicalValue(item)));
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, entryValue]) => [key, await canonicalValue(entryValue)] as const,
      ),
    );
    return Object.fromEntries(
      entries.sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

async function hashBlob(record: BlobRecord): Promise<string> {
  assert.ok(record.blob instanceof Blob);
  return hashRawBlob(record.blob);
}

async function hashRawBlob(blob: Blob): Promise<string> {
  return createHash('sha256')
    .update(new Uint8Array(await blob.arrayBuffer()))
    .digest('hex');
}

function idbException(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

function requiredStore(
  stores: Map<string, StoreContents>,
  storeName: string,
): StoreContents {
  const store = stores.get(storeName);
  assert.ok(store, `Missing synthetic object store ${storeName}.`);
  return store;
}
