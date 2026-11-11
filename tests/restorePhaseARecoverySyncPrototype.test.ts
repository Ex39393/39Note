import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmbiguousRemoteOutcomeError,
  FaultController,
  MockDriveGateway,
  RestoreFencedError,
  RestorePhaseAPrototypeRuntime,
  SimulatedProcessDeath,
  abortError,
  blobHash,
  createOriginalTarget,
  createPrototypeDisk,
  createReplacementTarget,
  deferred,
  liveFingerprint,
  quotaError,
  targetFingerprint,
  type DriveOperationKind,
  type RestoreCheckpoint,
} from './fixtures/restorePhaseARecoverySyncPrototype.ts';

test('durable barrier survives service re-instantiation and rejects stale ownership', async () => {
  const disk = await createPrototypeDisk();
  const originalFingerprint = await liveFingerprint(disk);
  const firstRuntime = new RestorePhaseAPrototypeRuntime(disk);
  const faults = new FaultController().fail(
    'after-journal-creation',
    new SimulatedProcessDeath('after-journal-creation'),
  );

  await assert.rejects(firstRuntime.restore(createReplacementTarget(), faults), {
    name: 'SimulatedProcessDeath',
  });
  const persisted = firstRuntime.getBarrier();
  assert.equal(persisted?.phase, 'preparing');
  assert.equal(persisted?.workspaceId, disk.workspaceId);
  assert.equal(persisted?.publicationHold, false);

  const restartedRuntime = new RestorePhaseAPrototypeRuntime(disk);
  assert.deepEqual(restartedRuntime.getBarrier(), persisted);
  await assert.rejects(restartedRuntime.restore(createReplacementTarget()), {
    name: 'RestoreFencedError',
  });
  assert.equal(await restartedRuntime.recover(), 'idle');
  assert.equal(await liveFingerprint(disk), originalFingerprint);
  assert.equal(restartedRuntime.getBarrier(), null);

  await assert.rejects(
    restartedRuntime.releasePublicationHold({
      accountId: disk.accountId,
      expectedGeneration: persisted!.generation,
      operationId: persisted!.operationId,
      remoteReconciled: false,
    }),
    RestoreFencedError,
  );
});

test('pre-mutation crash and storage faults preserve the exact old cross-database fingerprint', async (t) => {
  const scenarios: Array<{
    checkpoint: RestoreCheckpoint;
    error: Error;
    expectsDurableRestart: boolean;
  }> = [
    {
      checkpoint: 'before-journal-creation',
      error: new Error('ordinary failure before journal'),
      expectsDurableRestart: false,
    },
    {
      checkpoint: 'after-journal-creation',
      error: new SimulatedProcessDeath('after-journal-creation'),
      expectsDurableRestart: true,
    },
    {
      checkpoint: 'during-document-snapshot',
      error: quotaError(),
      expectsDurableRestart: false,
    },
    {
      checkpoint: 'after-document-snapshot',
      error: new SimulatedProcessDeath('after-document-snapshot'),
      expectsDurableRestart: true,
    },
    {
      checkpoint: 'during-productivity-snapshot',
      error: abortError(),
      expectsDurableRestart: false,
    },
    {
      checkpoint: 'after-productivity-snapshot',
      error: new SimulatedProcessDeath('after-productivity-snapshot'),
      expectsDurableRestart: true,
    },
    {
      checkpoint: 'before-first-live-mutation',
      error: new SimulatedProcessDeath('before-first-live-mutation'),
      expectsDurableRestart: true,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.checkpoint, async () => {
      const disk = await createPrototypeDisk();
      const originalFingerprint = await liveFingerprint(disk);
      const runtime = new RestorePhaseAPrototypeRuntime(disk);
      const faults = new FaultController().fail(scenario.checkpoint, scenario.error);
      await assert.rejects(runtime.restore(createReplacementTarget(), faults), {
        name: scenario.error.name,
      });

      if (scenario.expectsDurableRestart) {
        assert.ok(
          runtime.getBarrier(),
          'a process death must leave durable recovery state',
        );
        const restartedRuntime = new RestorePhaseAPrototypeRuntime(disk);
        assert.equal(await restartedRuntime.recover(), 'idle');
      }

      assert.equal(await liveFingerprint(disk), originalFingerprint);
      assert.equal(new RestorePhaseAPrototypeRuntime(disk).getBarrier(), null);
      assert.equal(disk.documents.state.snapshots.size, 0);
      assert.equal(disk.productivity.state.snapshots.size, 0);
    });
  }
});

test('process death after either physical database mutation rolls both databases back exactly', async (t) => {
  for (const checkpoint of [
    'after-document-mutation',
    'after-productivity-mutation',
    'before-commit-marker',
  ] as const) {
    await t.test(checkpoint, async () => {
      const disk = await createPrototypeDisk();
      const before = await liveFingerprint(disk);
      const originalSourceHash = await blobHash(createOriginalTarget().source);
      const runtime = new RestorePhaseAPrototypeRuntime(disk);
      await assert.rejects(
        runtime.restore(
          createReplacementTarget(),
          new FaultController().fail(checkpoint, new SimulatedProcessDeath(checkpoint)),
        ),
        { name: 'SimulatedProcessDeath' },
      );

      const barrier = runtime.getBarrier();
      assert.ok(barrier);
      if (checkpoint === 'after-document-mutation') {
        assert.equal(runtime.documentSnapshot(barrier.operationId)?.applied, true);
        assert.equal(runtime.productivitySnapshot(barrier.operationId)?.applied, false);
      }

      const restartedRuntime = new RestorePhaseAPrototypeRuntime(disk);
      assert.equal(await restartedRuntime.recover(), 'idle');
      assert.equal(await liveFingerprint(disk), before);
      assert.equal(
        await blobHash(disk.documents.state.sources.get('synthetic-paper-bkp03')!),
        originalSourceHash,
      );
    });
  }
});

test('a Collection fault aborts the co-located document mutation and its applied marker', async () => {
  const disk = await createPrototypeDisk();
  const before = await liveFingerprint(disk);
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const faults = new FaultController().fail(
    'during-collection-mutation',
    abortError('abort the synthetic document transaction'),
  );

  await assert.rejects(runtime.restore(createReplacementTarget(), faults), {
    name: 'AbortError',
  });
  assert.equal(await liveFingerprint(disk), before);
  assert.equal(runtime.getBarrier(), null);
  assert.equal(disk.documents.state.snapshots.size, 0);
  assert.equal(disk.productivity.state.snapshots.size, 0);
});

test('an interrupted rollback retains co-located undo data and resumes idempotently', async () => {
  const disk = await createPrototypeDisk();
  const before = await liveFingerprint(disk);
  const firstRuntime = new RestorePhaseAPrototypeRuntime(disk);
  const faults = new FaultController()
    .fail('after-document-mutation', new Error('force rollback'))
    .fail('during-rollback', new SimulatedProcessDeath('during-rollback'));

  await assert.rejects(firstRuntime.restore(createReplacementTarget(), faults), {
    name: 'SimulatedProcessDeath',
  });
  const interrupted = firstRuntime.getBarrier();
  assert.equal(interrupted?.phase, 'rolling-back');
  assert.equal(firstRuntime.documentSnapshot(interrupted!.operationId)?.applied, true);
  assert.equal(
    firstRuntime.documentSnapshot(interrupted!.operationId)?.rolledBack,
    false,
  );

  const restarted = new RestorePhaseAPrototypeRuntime(disk);
  assert.equal(await restarted.recover(), 'idle');
  assert.equal(await liveFingerprint(disk), before);
  assert.equal(
    await restarted.recover(),
    'idle',
    'repeated recovery must be idempotent',
  );
  assert.equal(await liveFingerprint(disk), before);
});

test('a rollback error enters recovery-required without deleting the only undo copies', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const faults = new FaultController()
    .fail('after-document-mutation', new Error('force rollback'))
    .fail('during-rollback', quotaError('rollback could not commit'));

  await assert.rejects(runtime.restore(createReplacementTarget(), faults), {
    name: 'QuotaExceededError',
  });
  const barrier = runtime.getBarrier();
  assert.equal(barrier?.phase, 'recovery-required');
  assert.equal(barrier?.recoveryRequired, true);
  assert.ok(runtime.documentSnapshot(barrier!.operationId));
  assert.ok(runtime.productivitySnapshot(barrier!.operationId));

  const restarted = new RestorePhaseAPrototypeRuntime(disk);
  assert.equal(await restarted.recover(), 'idle');
  assert.equal(await liveFingerprint(disk), barrier!.beforeFingerprint);
});

test('a crash after the commit marker keeps the new state and resumes cleanup into publication hold', async () => {
  const disk = await createPrototypeDisk();
  const target = createReplacementTarget();
  const expected = await targetFingerprint(target);
  const firstRuntime = new RestorePhaseAPrototypeRuntime(disk);

  await assert.rejects(
    firstRuntime.restore(
      target,
      new FaultController().fail(
        'after-commit-marker',
        new SimulatedProcessDeath('after-commit-marker'),
      ),
    ),
    { name: 'SimulatedProcessDeath' },
  );
  const committed = firstRuntime.getBarrier();
  assert.equal(committed?.phase, 'committed');
  assert.equal(committed?.publicationHold, true);
  assert.equal(await liveFingerprint(disk), expected);
  assert.ok(firstRuntime.documentSnapshot(committed!.operationId));
  assert.ok(firstRuntime.productivitySnapshot(committed!.operationId));

  const restarted = new RestorePhaseAPrototypeRuntime(disk);
  assert.equal(await restarted.recover(), 'publication-hold');
  assert.equal(restarted.getBarrier()?.phase, 'publication-hold');
  assert.equal(await liveFingerprint(disk), expected);
  assert.equal(disk.documents.state.snapshots.size, 0);
  assert.equal(disk.productivity.state.snapshots.size, 0);
  assert.equal(await restarted.recover(), 'publication-hold');
});

test('snapshot-cleanup process death is resumable and cannot revert a committed restore', async () => {
  const disk = await createPrototypeDisk();
  const target = createReplacementTarget();
  const expected = await targetFingerprint(target);
  const runtime = new RestorePhaseAPrototypeRuntime(disk);

  await assert.rejects(
    runtime.restore(
      target,
      new FaultController().fail(
        'during-snapshot-cleanup',
        new SimulatedProcessDeath('during-snapshot-cleanup'),
      ),
    ),
    { name: 'SimulatedProcessDeath' },
  );
  assert.equal(runtime.getBarrier()?.phase, 'committed');
  assert.equal(await liveFingerprint(disk), expected);
  assert.ok(disk.documents.state.snapshots.size > 0);

  const restarted = new RestorePhaseAPrototypeRuntime(disk);
  assert.equal(await restarted.recover(), 'publication-hold');
  assert.equal(await liveFingerprint(disk), expected);
  assert.equal(disk.documents.state.snapshots.size, 0);
  assert.equal(disk.productivity.state.snapshots.size, 0);
});

test('shared write ownership closes the barrier-check/other-database-write race', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const writerAdmitted = deferred<void>();
  const releaseWriter = deferred<void>();
  const restoreJournalCreated = new FaultController();
  const restoreGate = restoreJournalCreated.pause('after-journal-creation');
  const ordering: string[] = [];

  const writer = runtime.guardedNormalWrite(
    () => {
      disk.productivity.transaction((draft) => {
        const record = draft.productivity.get('synthetic-paper-bkp03')!;
        draft.productivity.set(record.documentId, {
          ...record,
          printDraftTitle: 'Writer committed before restore admission',
        });
      });
      ordering.push('writer-committed');
    },
    async () => {
      ordering.push('writer-admitted');
      writerAdmitted.resolve();
      await releaseWriter.promise;
    },
  );
  await writerAdmitted.promise;

  const restore = runtime.restore(createReplacementTarget(), restoreJournalCreated);
  await Promise.resolve();
  assert.equal(
    runtime.getBarrier(),
    null,
    'exclusive restore must wait for the shared writer',
  );
  releaseWriter.resolve();
  await writer;
  await restoreGate.entered;
  ordering.push('restore-journal-created');
  assert.deepEqual(ordering, [
    'writer-admitted',
    'writer-committed',
    'restore-journal-created',
  ]);
  restoreGate.signalRelease();
  await restore;
});

test('queued and delayed Drive commands transmit zero requests during restore and publication hold', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const gateway = new MockDriveGateway(disk);
  const faults = new FaultController();
  const journalGate = faults.pause('after-journal-creation');
  const restore = runtime.restore(createReplacementTarget(), faults);
  await journalGate.entered;

  const delayedToken = deferred<void>();
  const kinds: DriveOperationKind[] = [
    'auto-sync',
    'manual-upload',
    'retry',
    'keep-local',
    'download',
  ];
  const attempts = kinds.map((kind) =>
    gateway.execute(gateway.schedule(kind)).catch((error: unknown) => error),
  );
  const tokenResolvedLate = gateway
    .execute(gateway.schedule('manual-upload'), {
      beforeAdmission: delayedToken.promise,
    })
    .catch((error: unknown) => error);

  assert.equal(gateway.transmittedCount(), 0);
  journalGate.signalRelease();
  await restore;
  delayedToken.resolve();
  const results = await Promise.all([...attempts, tokenResolvedLate]);
  assert.ok(results.every((result) => result instanceof RestoreFencedError));
  assert.equal(gateway.transmittedCount(), 0);
  assert.equal(
    disk.driveEvents.filter((event) => event.status === 'denied').length,
    kinds.length + 1,
  );
  assert.equal(
    disk.autoSyncEnabled,
    true,
    'restore must preserve the saved Auto-sync preference',
  );
});

test('an already-transmitted ambiguous request delays restore and requires explicit reconciliation', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const gateway = new MockDriveGateway(disk);
  const transmitted = deferred<void>();
  const releaseRemote = deferred<void>();
  const remote = gateway.execute(gateway.schedule('manual-upload'), {
    ambiguous: true,
    transmittedGate: {
      entered: () => transmitted.resolve(),
      release: releaseRemote.promise,
    },
  });
  await transmitted.promise;

  const restore = runtime.restore(createReplacementTarget());
  await Promise.resolve();
  assert.equal(
    runtime.getBarrier(),
    null,
    'restore must wait for the in-flight shared owner',
  );
  releaseRemote.resolve();
  await assert.rejects(remote, AmbiguousRemoteOutcomeError);
  const completedRestore = await restore;
  assert.equal(completedRestore.phase, 'publication-hold');
  assert.equal(completedRestore.remoteRevalidationRequired, true);
  assert.equal(
    gateway.transmittedCount(),
    1,
    'only the pre-existing request was transmitted',
  );

  await assert.rejects(
    runtime.releasePublicationHold({
      accountId: disk.accountId,
      expectedGeneration: completedRestore.generation,
      operationId: completedRestore.operationId,
      remoteReconciled: false,
    }),
    /requires reconciliation/,
  );
  assert.equal(runtime.getBarrier()?.phase, 'publication-hold');
  await runtime.releasePublicationHold({
    accountId: disk.accountId,
    expectedGeneration: completedRestore.generation,
    operationId: completedRestore.operationId,
    remoteReconciled: true,
  });
  assert.equal(runtime.getBarrier(), null);
});

test('publication hold survives reload and enforces account, operation, and generation ownership', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const gateway = new MockDriveGateway(disk);
  const barrier = await runtime.restore(createReplacementTarget());
  const restarted = new RestorePhaseAPrototypeRuntime(disk);

  assert.equal(restarted.getBarrier()?.phase, 'publication-hold');
  assert.equal(gateway.observeReconnect(disk.accountId), 'held-correct-account');
  assert.equal(
    gateway.observeReconnect('wrong-account@example.invalid'),
    'held-account-mismatch',
  );
  assert.equal(gateway.transmittedCount(), 0, 'reconnect observation is local-only');

  await assert.rejects(
    restarted.releasePublicationHold({
      accountId: 'wrong-account@example.invalid',
      expectedGeneration: barrier.generation,
      operationId: barrier.operationId,
      remoteReconciled: false,
    }),
    /account does not match/,
  );
  await assert.rejects(
    restarted.releasePublicationHold({
      accountId: disk.accountId,
      expectedGeneration: barrier.generation - 1,
      operationId: barrier.operationId,
      remoteReconciled: false,
    }),
    /generation is stale/,
  );
  await assert.rejects(
    restarted.releasePublicationHold({
      accountId: disk.accountId,
      expectedGeneration: barrier.generation,
      operationId: 'stale-operation-id',
      remoteReconciled: false,
    }),
    RestoreFencedError,
  );
  await restarted.releasePublicationHold({
    accountId: disk.accountId,
    expectedGeneration: barrier.generation,
    operationId: barrier.operationId,
    remoteReconciled: false,
  });
  assert.equal(restarted.getBarrier(), null);

  await assert.rejects(
    restarted.releasePublicationHold({
      accountId: disk.accountId,
      expectedGeneration: barrier.generation,
      operationId: barrier.operationId,
      remoteReconciled: false,
    }),
    RestoreFencedError,
  );
});

test('a pre-restore Drive ticket stays stale even after an authorized hold release', async () => {
  const disk = await createPrototypeDisk();
  const runtime = new RestorePhaseAPrototypeRuntime(disk);
  const gateway = new MockDriveGateway(disk);
  const staleTicket = gateway.schedule('auto-sync');
  const barrier = await runtime.restore(createReplacementTarget());
  await runtime.releasePublicationHold({
    accountId: disk.accountId,
    expectedGeneration: barrier.generation,
    operationId: barrier.operationId,
    remoteReconciled: false,
  });

  await assert.rejects(gateway.execute(staleTicket), /generation is stale/);
  assert.equal(gateway.transmittedCount(), 0);
});
