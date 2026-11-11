import type { DurableRestoreOperation } from '../../src/services/restoreSafety.ts';

interface NativeResult {
  name: string;
  outcome: 'PASS' | 'FAIL';
  detail?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}

const results: NativeResult[] = [];
const databaseNames: string[] = [];
const workspaceId = crypto.randomUUID();
sessionStorage.setItem(
  '39note.workspace.temporary.v1',
  JSON.stringify({ id: workspaceId, version: 1 }),
);

const [
  annotation,
  productivity,
  lifecycle,
  restoreStartup,
  workspaceLocks,
  temporaryWorkspace,
] = await Promise.all([
  import('../../src/services/annotationPersistence.ts'),
  import('../../src/services/productivityPersistence.ts'),
  import('../../src/services/indexedDbLifecycle.ts'),
  import('../../src/services/restoreSafetyStartup.ts'),
  import('../../src/services/workspaceRestoreLock.ts'),
  import('../../src/services/temporaryWorkspace.ts'),
]);

const documentDatabaseName = temporaryWorkspace.temporaryDatabaseName(
  temporaryWorkspace.PERSONAL_ANNOTATION_DATABASE_NAME,
  workspaceId,
);
const productivityDatabaseName = temporaryWorkspace.temporaryDatabaseName(
  temporaryWorkspace.PERSONAL_PRODUCTIVITY_DATABASE_NAME,
  workspaceId,
);
databaseNames.push(documentDatabaseName, productivityDatabaseName);

const documentId = '7f86d9fa-ec87-42bc-9ab2-1f5ba4eb36d9';
const sourceBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 66, 10]);
const printBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 80, 10]);
const sourceBlob = new Blob([sourceBytes], { type: 'application/pdf' });
const printBlob = new Blob([printBytes], { type: 'application/pdf' });
const documentState = {
  documentId,
  schemaVersion: 9,
  displayTitle: 'Synthetic Phase B paper',
  annotations: [{ id: 'annotation-a', type: 'highlight', color: 'yellow' }],
  links: [{ id: 'link-a', documentId, name: 'Link 1' }],
  notes: [{ id: 'note-a', content: 'Synthetic note only' }],
  collectionIds: ['collection-a'],
  updatedAt: 1,
};
const collection = {
  id: 'collection-a',
  name: 'Synthetic Collection',
  normalizedName: 'synthetic collection',
  createdAt: 1,
  updatedAt: 1,
};
const sourceRecord = {
  documentId,
  blob: sourceBlob,
  fileName: 'synthetic-phase-b.pdf',
  mimeType: 'application/pdf',
  size: sourceBlob.size,
  lastModified: 1,
  storedAt: 1,
};
const printDraft = { documentId, title: 'Synthetic draft', updatedAt: 1 };
const renderedPrint = {
  documentId,
  blob: printBlob,
  fileName: 'synthetic-print.pdf',
  mimeType: 'application/pdf',
  size: printBlob.size,
  sha256: await sha256(printBlob),
};
const conversation = {
  id: 'conversation-a',
  documentId,
  title: 'Synthetic conversation',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

await runCase(
  'production v4→v5 and v2→v3 upgrades preserve exact records and Blobs',
  async () => {
    const oldDocuments = await openDatabase(documentDatabaseName, 4, (database) => {
      createDocumentV4(database);
    });
    await putRecords(oldDocuments, {
      'document-states': [documentState],
      'pdf-files': [sourceRecord],
      collections: [collection],
      tags: [{ id: 'legacy-tag-a', name: 'Dormant legacy record' }],
    });
    oldDocuments.close();

    const oldProductivity = await openDatabase(
      productivityDatabaseName,
      2,
      (database) => createProductivityV2(database),
    );
    await putRecords(oldProductivity, {
      'print-drafts': [printDraft],
      'rendered-print-pdfs': [renderedPrint],
      'ai-conversations': [conversation],
    });
    oldProductivity.close();

    await restoreStartup.verifyRestoreSafetyBeforeAppMount();
    await Promise.all([
      annotation.closeAnnotationPersistenceWorkspace(),
      productivity.closeProductivityPersistenceWorkspace(),
    ]);

    const documents = await openDatabase(documentDatabaseName, 5);
    const productivityDatabase = await openDatabase(productivityDatabaseName, 3);
    assertEqual(documents.version, 5, 'document physical version');
    assertEqual(productivityDatabase.version, 3, 'productivity physical version');
    assertStoreNames(documents, [
      'collections',
      'document-states',
      'pdf-files',
      'restore-actions',
      'restore-operations',
      'restore-snapshots',
      'tags',
    ]);
    assertStoreNames(productivityDatabase, [
      'ai-conversations',
      'print-drafts',
      'rendered-print-pdfs',
      'restore-actions',
      'restore-snapshots',
    ]);
    assertJsonEqual(
      await getRecord(documents, 'document-states', documentId),
      documentState,
      'document state changed',
    );
    assertJsonEqual(
      await getRecord(documents, 'collections', 'collection-a'),
      collection,
      'Collection changed',
    );
    assertJsonEqual(
      await getRecord(documents, 'tags', 'legacy-tag-a'),
      { id: 'legacy-tag-a', name: 'Dormant legacy record' },
      'dormant legacy store changed',
    );
    assertEqual(
      await sha256(
        (await getRecord<{ blob: Blob }>(documents, 'pdf-files', documentId)).blob,
      ),
      await sha256(sourceBlob),
      'source Blob hash',
    );
    assertJsonEqual(
      await getRecord(productivityDatabase, 'print-drafts', documentId),
      printDraft,
      'Print Draft changed',
    );
    assertJsonEqual(
      await getRecord(productivityDatabase, 'ai-conversations', 'conversation-a'),
      conversation,
      'AI conversation changed',
    );
    assertEqual(
      await sha256(
        (
          await getRecord<{ blob: Blob }>(
            productivityDatabase,
            'rendered-print-pdfs',
            documentId,
          )
        ).blob,
      ),
      await sha256(printBlob),
      'rendered Print PDF Blob hash',
    );
    documents.close();
    productivityDatabase.close();
  },
);

await runCase(
  'aborted production upgrades roll back both database versions, stores, records, and Blob bytes',
  async () => {
    const name = syntheticDatabaseName('abort');
    const old = await openDatabase(name, 4, createDocumentV4);
    await putRecords(old, {
      'document-states': [documentState],
      'pdf-files': [sourceRecord],
    });
    old.close();
    let abortName = '';
    try {
      await openDatabase(name, 5, (database, transaction) => {
        annotation.upgradeAnnotationDatabaseSchema(database as never);
        transaction.abort();
      });
    } catch (error) {
      abortName = error instanceof DOMException ? error.name : String(error);
    }
    assertEqual(abortName, 'AbortError', 'upgrade abort error');
    const reopened = await openDatabase(name, 4);
    assertEqual(reopened.version, 4, 'aborted version');
    assert(
      !reopened.objectStoreNames.contains('restore-operations'),
      'partial store survived abort',
    );
    assertJsonEqual(
      await getRecord(reopened, 'document-states', documentId),
      documentState,
      'record changed after abort',
    );
    assertEqual(
      await sha256(
        (await getRecord<{ blob: Blob }>(reopened, 'pdf-files', documentId)).blob,
      ),
      await sha256(sourceBlob),
      'Blob changed after abort',
    );
    reopened.close();

    const productivityName = syntheticDatabaseName('productivity-abort');
    const oldProductivity = await openDatabase(
      productivityName,
      2,
      createProductivityV2,
    );
    await putRecords(oldProductivity, {
      'print-drafts': [printDraft],
      'rendered-print-pdfs': [renderedPrint],
      'ai-conversations': [conversation],
    });
    oldProductivity.close();
    let productivityAbortName = '';
    try {
      await openDatabase(productivityName, 3, (database, transaction) => {
        productivity.upgradeProductivityDatabaseSchema(database as never);
        transaction.abort();
      });
    } catch (error) {
      productivityAbortName =
        error instanceof DOMException ? error.name : String(error);
    }
    assertEqual(productivityAbortName, 'AbortError', 'productivity abort error');
    const reopenedProductivity = await openDatabase(productivityName, 2);
    assertEqual(reopenedProductivity.version, 2, 'aborted productivity version');
    assert(
      !reopenedProductivity.objectStoreNames.contains('restore-snapshots'),
      'partial productivity restore store survived abort',
    );
    assertJsonEqual(
      await getRecord(reopenedProductivity, 'print-drafts', documentId),
      printDraft,
      'Print Draft changed after abort',
    );
    assertJsonEqual(
      await getRecord(reopenedProductivity, 'ai-conversations', 'conversation-a'),
      conversation,
      'AI conversation changed after abort',
    );
    assertEqual(
      await sha256(
        (
          await getRecord<{ blob: Blob }>(
            reopenedProductivity,
            'rendered-print-pdfs',
            documentId,
          )
        ).blob,
      ),
      await sha256(printBlob),
      'rendered Print PDF changed after abort',
    );
    reopenedProductivity.close();
  },
);

await runCase(
  'cooperative versionchange closes the old connection and old-version reopen fails',
  async () => {
    const name = syntheticDatabaseName('cooperative');
    let versionChangeSeen = false;
    const old = await lifecycle.openDatabaseWithLifecycleSafety(name, 4, {
      upgrade: ((database: IDBDatabase) => createDocumentV4(database)) as never,
      onConnectionClosed: () => {
        versionChangeSeen = true;
      },
    });
    assertEqual(old.version, 4, 'legacy connection version');
    const upgraded = await lifecycle.openDatabaseWithLifecycleSafety(name, 5, {
      upgrade: annotation.upgradeAnnotationDatabaseSchema as never,
    });
    assert(versionChangeSeen, 'legacy connection saw no versionchange');
    assertEqual(upgraded.version, 5, 'cooperative upgrade version');
    upgraded.close();
    let oldVersionError = '';
    try {
      await openDatabase(name, 4);
    } catch (error) {
      oldVersionError = error instanceof DOMException ? error.name : String(error);
    }
    assertEqual(oldVersionError, 'VersionError', 'old-version reopen error');
  },
);

await runCase(
  'uncooperative connection produces an actionable blocked-upgrade failure',
  async () => {
    const name = syntheticDatabaseName('blocked');
    const old = await openDatabase(name, 4, createDocumentV4);
    const opening = lifecycle.openDatabaseWithLifecycleSafety(name, 5, {
      upgrade: annotation.upgradeAnnotationDatabaseSchema as never,
    });
    await assertRejects(
      opening,
      (error) => error instanceof lifecycle.IndexedDbUpgradeBlockedError,
      'blocked upgrade did not reject safely',
    );
    assert(
      !old.objectStoreNames.contains('restore-operations'),
      'restore schema became visible while blocked',
    );
    old.close();
    const upgraded = await openDatabase(name, 5);
    assert(
      upgraded.objectStoreNames.contains('restore-operations'),
      'upgrade did not settle after blocker closed',
    );
    upgraded.close();
  },
);

await runCase('concurrent same-version opens are idempotent', async () => {
  const name = syntheticDatabaseName('concurrent');
  let upgradeCalls = 0;
  const first = openDatabase(name, 5, (database) => {
    upgradeCalls += 1;
    annotation.upgradeAnnotationDatabaseSchema(database as never);
  });
  const second = openDatabase(name, 5, () => {
    upgradeCalls += 1;
  });
  const [firstDatabase, secondDatabase] = await Promise.all([first, second]);
  assertEqual(upgradeCalls, 1, 'concurrent upgrade callback count');
  assertStoreNames(firstDatabase, [
    'collections',
    'document-states',
    'pdf-files',
    'restore-actions',
    'restore-operations',
    'restore-snapshots',
  ]);
  firstDatabase.close();
  secondDatabase.close();
});

await runCase(
  'production locks close the check/write race and queued writers revalidate the barrier',
  async () => {
    const writerEntered = deferred<void>();
    const releaseWriter = deferred<void>();
    const restoreEntered = deferred<void>();
    const releaseRestore = deferred<void>();
    const ordering: string[] = [];
    let writer: Promise<unknown> | undefined;
    let restore: Promise<unknown> | undefined;
    let queuedWriter: Promise<unknown> | undefined;
    try {
      writer = annotation.withWorkspaceMutation(async (lease) => {
        ordering.push('writer-admitted');
        writerEntered.resolve(undefined);
        await releaseWriter.promise;
        const collectionRecord = await annotation.createCollection(
          'Synthetic Phase B lock test',
          lease,
        );
        assert(collectionRecord, 'document-database write failed');
        assert(
          await annotation.saveDocumentState(
            {
              documentId: '6f6c1f45-5368-4f7d-a29f-74bc8fbf71a9',
              documentName: 'synthetic-reader-persistence.pdf',
            },
            [],
            [],
            [],
            [],
            1,
            'Synthetic Reader persistence',
            'pdf',
            [],
            1,
            lease,
          ),
          'normal Reader persistence failed without a barrier',
        );
        assert(
          await productivity.clearPrintDraft(documentId, lease),
          'productivity-database write failed',
        );
        ordering.push('writer-committed');
      });
      await Promise.race([
        writerEntered.promise,
        writer.then(() => {
          throw new Error('The writer exited before acquiring shared ownership.');
        }),
      ]);

      const operation: DurableRestoreOperation = {
        operationId: crypto.randomUUID(),
        workspaceId: `temporary:${workspaceId}`,
        phase: 'preparing',
        generation: 1,
        createdAt: Date.now(),
        recoveryRequired: false,
        publicationHold: false,
        remoteRevalidationRequired: false,
      };
      restore = workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
        ordering.push('restore-admitted');
        await annotation.createDurableRestoreOperation(operation, lease);
        ordering.push('barrier-durable');
        restoreEntered.resolve(undefined);
        await releaseRestore.promise;
      });
      await drainMicrotasks();
      assertEqual(
        ordering.join('|'),
        'writer-admitted',
        'restore bypassed shared writer',
      );
      releaseWriter.resolve(undefined);
      await Promise.race([
        restoreEntered.promise,
        restore.then(() => {
          throw new Error('The restore exited before acquiring exclusive ownership.');
        }),
      ]);
      assertEqual(
        ordering.join('|'),
        'writer-admitted|writer-committed|restore-admitted|barrier-durable',
        'unexpected lock order',
      );
      let queuedWriterCommitted = false;
      queuedWriter = annotation
        .withWorkspaceMutation(() => {
          queuedWriterCommitted = true;
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      releaseRestore.resolve(undefined);
      await Promise.all([writer, restore]);
      const queuedError = await queuedWriter;
      assert(
        queuedError instanceof Error &&
          queuedError.name === 'WorkspaceRestoreBarrierError',
        'queued writer did not fail on the durable barrier',
      );
      assert(!queuedWriterCommitted, 'queued writer committed behind restore');

      await workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
        await assertRejects(
          annotation.createDurableRestoreOperation(
            { ...operation, operationId: crypto.randomUUID() },
            lease,
          ),
          () => true,
          'competing restore actor replaced the barrier',
        );
        await assertRejects(
          annotation.transitionDurableRestoreOperation(
            {
              operationId: crypto.randomUUID(),
              expectedGeneration: 1,
              expectedPhase: 'preparing',
              nextPhase: 'prepared',
            },
            lease,
          ),
          () => true,
          'stale operation ID changed the barrier',
        );
        await assertRejects(
          annotation.transitionDurableRestoreOperation(
            {
              operationId: operation.operationId,
              expectedGeneration: 2,
              expectedPhase: 'preparing',
              nextPhase: 'prepared',
            },
            lease,
          ),
          () => true,
          'stale generation changed the barrier',
        );
      });
    } finally {
      releaseWriter.resolve(undefined);
      releaseRestore.resolve(undefined);
      await Promise.allSettled(
        [writer, restore, queuedWriter].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
    }
  },
);

await runCase(
  'durable journal survives reopen and publication hold requires exact reconciliation evidence',
  async () => {
    const initial = await annotation.loadDurableRestoreOperation();
    assert(initial, 'durable journal disappeared before reload');
    await annotation.closeAnnotationPersistenceWorkspace();
    const reopened = await annotation.loadDurableRestoreOperation();
    assertJsonEqual(reopened, initial, 'durable journal changed after reopen');
    await assertRejects(
      restoreStartup.verifyRestoreSafetyBeforeAppMount(),
      (error) => error instanceof Error && error.name === 'RestoreStartupRecoveryError',
      'startup did not fail closed on an incomplete journal',
    );

    let current = (await annotation.loadDurableRestoreOperation())!;
    assertEqual(
      current.phase,
      'recovery-required',
      'legacy journal was not retained in recovery-required state',
    );
    await workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
      current = await annotation.transitionDurableRestoreOperation(
        {
          operationId: current.operationId,
          expectedGeneration: current.generation,
          expectedPhase: 'recovery-required',
          nextPhase: 'publication-hold',
          publicationHold: {
            accountId: 'synthetic-account',
            remoteRevalidationRequired: true,
          },
        },
        lease,
      );
    });
    await annotation.closeAnnotationPersistenceWorkspace();
    await assertRejects(
      restoreStartup.verifyRestoreSafetyBeforeAppMount(),
      (error) => error instanceof Error && error.name === 'RestoreStartupRecoveryError',
      'startup did not preserve publication hold',
    );
    await workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
      await assertRejects(
        annotation.clearDurablePublicationHold(
          {
            operationId: current.operationId,
            expectedGeneration: current.generation,
            publicationResumeAuthorized: true,
            remoteReconciled: false,
            verifiedAccountId: 'synthetic-account',
          },
          lease,
        ),
        () => true,
        'publication hold cleared without remote reconciliation',
      );
      await assertRejects(
        annotation.clearDurablePublicationHold(
          {
            operationId: current.operationId,
            expectedGeneration: current.generation,
            publicationResumeAuthorized: true,
            remoteReconciled: true,
            verifiedAccountId: 'wrong-account',
          },
          lease,
        ),
        () => true,
        'publication hold cleared for the wrong account',
      );
      await annotation.clearDurablePublicationHold(
        {
          operationId: current.operationId,
          expectedGeneration: current.generation,
          publicationResumeAuthorized: true,
          remoteReconciled: true,
          verifiedAccountId: 'synthetic-account',
        },
        lease,
      );
    });
    await restoreStartup.verifyRestoreSafetyBeforeAppMount();
  },
);

await runCase(
  'two concurrent production restore actors serialize and only the first creates the barrier',
  async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const firstOperation: DurableRestoreOperation = {
      operationId: crypto.randomUUID(),
      workspaceId: `temporary:${workspaceId}`,
      phase: 'preparing',
      generation: 1,
      createdAt: Date.now(),
      recoveryRequired: false,
      publicationHold: false,
      remoteRevalidationRequired: false,
    };
    const competingOperation: DurableRestoreOperation = {
      ...firstOperation,
      operationId: crypto.randomUUID(),
      createdAt: firstOperation.createdAt + 1,
    };
    let secondEntered = false;
    const first = workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
      await annotation.createDurableRestoreOperation(firstOperation, lease);
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = workspaceLocks
      .withExclusiveWorkspaceRestoreLease(async (lease) => {
        secondEntered = true;
        await annotation.createDurableRestoreOperation(competingOperation, lease);
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await drainMicrotasks();
    assert(!secondEntered, 'the competing restore bypassed exclusive ownership');
    releaseFirst.resolve(undefined);
    await first;
    const secondError = await second;
    assert(
      secondError instanceof Error &&
        secondError.name === 'WorkspaceRestoreBarrierError',
      "the competing restore did not fail on the first actor's durable barrier",
    );
    assertJsonEqual(
      await annotation.loadDurableRestoreOperation(),
      firstOperation,
      "the competing restore replaced the first actor's barrier",
    );

    let current = firstOperation;
    await workspaceLocks.withExclusiveWorkspaceRestoreLease(async (lease) => {
      for (const nextPhase of [
        'prepared',
        'applying',
        'verifying',
        'committed',
      ] as const) {
        current = await annotation.transitionDurableRestoreOperation(
          {
            operationId: current.operationId,
            expectedGeneration: current.generation,
            expectedPhase: current.phase,
            nextPhase,
          },
          lease,
        );
      }
      current = await annotation.transitionDurableRestoreOperation(
        {
          operationId: current.operationId,
          expectedGeneration: current.generation,
          expectedPhase: 'committed',
          nextPhase: 'publication-hold',
          publicationHold: { remoteRevalidationRequired: false },
        },
        lease,
      );
      await annotation.clearDurablePublicationHold(
        {
          operationId: current.operationId,
          expectedGeneration: current.generation,
          publicationResumeAuthorized: true,
          remoteReconciled: false,
        },
        lease,
      );
    });
  },
);

await Promise.all([
  annotation.closeAnnotationPersistenceWorkspace(),
  productivity.closeProductivityPersistenceWorkspace(),
]);

const failures = results.filter(({ outcome }) => outcome === 'FAIL');
const summary = document.querySelector<HTMLElement>('#summary')!;
const list = document.querySelector<HTMLOListElement>('#results')!;
for (const result of results) {
  const item = document.createElement('li');
  item.dataset.outcome = result.outcome;
  item.textContent = `${result.outcome}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`;
  list.append(item);
}
summary.dataset.phaseBResult = failures.length === 0 ? 'PASS' : 'FAIL';
summary.textContent =
  failures.length === 0
    ? `PASS — ${results.length}/${results.length} native production checks`
    : `FAIL — ${results.length - failures.length}/${results.length} native production checks`;
document.querySelector<HTMLElement>('#details')!.textContent = JSON.stringify(
  {
    databaseNames,
    origin: location.origin,
    requests: performance.getEntriesByType('resource').map((entry) => entry.name),
    workspaceId,
  },
  null,
  2,
);
document.title = `${failures.length === 0 ? 'PASS' : 'FAIL'} — BKP-03 Phase B native production checks`;

async function runCase(name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    results.push({ name, outcome: 'PASS' });
  } catch (error) {
    results.push({
      name,
      outcome: 'FAIL',
      detail:
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}

function syntheticDatabaseName(kind: string): string {
  const name = `39note-bkp03-phase-b-${kind}-${crypto.randomUUID()}`;
  databaseNames.push(name);
  return name;
}

function createDocumentV4(database: IDBDatabase): void {
  database.createObjectStore('document-states', { keyPath: 'documentId' });
  database.createObjectStore('pdf-files', { keyPath: 'documentId' });
  database.createObjectStore('collections', { keyPath: 'id' });
  database.createObjectStore('tags', { keyPath: 'id' });
}

function createProductivityV2(database: IDBDatabase): void {
  database.createObjectStore('print-drafts', { keyPath: 'documentId' });
  database.createObjectStore('rendered-print-pdfs', { keyPath: 'documentId' });
  const conversations = database.createObjectStore('ai-conversations', {
    keyPath: 'id',
  });
  conversations.createIndex('by-document', 'documentId');
}

function openDatabase(
  name: string,
  version: number,
  upgrade?: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction!);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function putRecords(
  database: IDBDatabase,
  records: Record<string, unknown[]>,
): Promise<void> {
  const transaction = database.transaction(Object.keys(records), 'readwrite');
  for (const [storeName, values] of Object.entries(records)) {
    for (const value of values) transaction.objectStore(storeName).put(value);
  }
  await transactionDone(transaction);
}

async function getRecord<T = unknown>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T> {
  const transaction = database.transaction(storeName, 'readonly');
  const value = await requestResult(
    transaction.objectStore(storeName).get(key) as IDBRequest<T>,
  );
  await transactionDone(transaction);
  return value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('Aborted', 'AbortError'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function assertStoreNames(database: IDBDatabase, expected: string[]): void {
  const actual = [...database.objectStoreNames].sort();
  const normalizedExpected = [...expected].sort();
  assertJsonEqual(
    actual,
    normalizedExpected,
    `unexpected stores: ${actual.join(', ')}`,
  );
}

async function assertRejects(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean,
  message: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (predicate(error)) return;
    throw error;
  }
  throw new Error(message);
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
