import assert from 'node:assert/strict';

export type RestoreCheckpoint =
  | 'before-journal-creation'
  | 'after-journal-creation'
  | 'during-document-snapshot'
  | 'after-document-snapshot'
  | 'during-productivity-snapshot'
  | 'after-productivity-snapshot'
  | 'before-first-live-mutation'
  | 'during-collection-mutation'
  | 'after-document-mutation'
  | 'after-productivity-mutation'
  | 'before-commit-marker'
  | 'after-commit-marker'
  | 'during-rollback'
  | 'after-document-rollback'
  | 'during-snapshot-cleanup';

export type RestorePhase =
  | 'preparing'
  | 'prepared'
  | 'applying'
  | 'verifying'
  | 'rolling-back'
  | 'recovery-required'
  | 'committed'
  | 'publication-hold';

export interface SyntheticDocument {
  documentId: string;
  title: string;
  annotations: Array<{ id: string; kind: 'highlight'; color: string }>;
  notes: Array<{ id: string; annotationId: string; content: string }>;
  links: Array<{
    id: string;
    documentId: string;
    sourceAnchor: string;
    targetAnchor: string;
  }>;
  collectionIds: string[];
}

export interface SyntheticCollection {
  id: string;
  name: string;
  documentIds: string[];
}

export interface SyntheticProductivity {
  documentId: string;
  printDraftTitle: string;
  conversation: string;
}

export interface SyntheticRestoreTarget {
  document: SyntheticDocument;
  source: Blob;
  collection: SyntheticCollection;
  productivity: SyntheticProductivity;
  printPdf: Blob;
}

interface DocumentUndoSnapshot {
  operationId: string;
  document: SyntheticDocument | null;
  source: Blob | null;
  collection: SyntheticCollection | null;
  applied: boolean;
  rolledBack: boolean;
}

interface ProductivityUndoSnapshot {
  operationId: string;
  productivity: SyntheticProductivity | null;
  printPdf: Blob | null;
  applied: boolean;
  rolledBack: boolean;
}

export interface DurableRestoreBarrier {
  operationId: string;
  ownerToken: string;
  workspaceId: string;
  phase: RestorePhase;
  generation: number;
  createdAt: number;
  recoveryRequired: boolean;
  publicationHold: boolean;
  accountId: string;
  beforeFingerprint: string;
  targetFingerprint: string;
  remoteRevalidationRequired: boolean;
}

interface DocumentPhysicalState {
  documents: Map<string, SyntheticDocument>;
  sources: Map<string, Blob>;
  collections: Map<string, SyntheticCollection>;
  barriers: Map<string, DurableRestoreBarrier>;
  snapshots: Map<string, DocumentUndoSnapshot>;
}

interface ProductivityPhysicalState {
  productivity: Map<string, SyntheticProductivity>;
  printPdfs: Map<string, Blob>;
  snapshots: Map<string, ProductivityUndoSnapshot>;
}

class SyntheticPhysicalDatabase<T> {
  state: T;

  constructor(state: T) {
    this.state = state;
  }

  transaction<R>(callback: (draft: T) => R): R {
    const draft = structuredClone(this.state);
    const result = callback(draft);
    this.state = draft;
    return result;
  }
}

export interface DriveEvent {
  kind: DriveOperationKind;
  accountId: string;
  expectedEpoch: number;
  status: 'requested' | 'denied' | 'transmitted' | 'completed' | 'ambiguous';
  reason?: string;
}

export type DriveOperationKind =
  | 'auto-sync'
  | 'manual-upload'
  | 'retry'
  | 'keep-local'
  | 'download'
  | 'reconcile-read';

export interface DriveTicket {
  kind: DriveOperationKind;
  accountId: string;
  expectedEpoch: number;
}

export interface PrototypeDisk {
  readonly workspaceId: string;
  readonly documentDbName: string;
  readonly productivityDbName: string;
  readonly documents: SyntheticPhysicalDatabase<DocumentPhysicalState>;
  readonly productivity: SyntheticPhysicalDatabase<ProductivityPhysicalState>;
  readonly driveEvents: DriveEvent[];
  readonly accountId: string;
  autoSyncEnabled: boolean;
  driveEpoch: number;
  nextBarrierGeneration: number;
  remoteRevalidationRequired: boolean;
}

export class SimulatedProcessDeath extends Error {
  constructor(checkpoint: RestoreCheckpoint) {
    super(`Simulated process death at ${checkpoint}`);
    this.name = 'SimulatedProcessDeath';
  }
}

export class RestoreFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreFencedError';
  }
}

export class AmbiguousRemoteOutcomeError extends Error {
  constructor() {
    super('The synthetic request was transmitted, but its outcome is ambiguous.');
    this.name = 'AmbiguousRemoteOutcomeError';
  }
}

export function abortError(
  message = 'Synthetic IndexedDB transaction aborted',
): DOMException {
  return new DOMException(message, 'AbortError');
}

export function quotaError(message = 'Synthetic storage quota exceeded'): DOMException {
  return new DOMException(message, 'QuotaExceededError');
}

interface CheckpointGate {
  entered: Promise<void>;
  signalEntered(): void;
  release: Promise<void>;
  signalRelease(): void;
}

export class FaultController {
  private readonly faults = new Map<RestoreCheckpoint, Error>();
  private readonly gates = new Map<RestoreCheckpoint, CheckpointGate>();

  fail(checkpoint: RestoreCheckpoint, error: Error): this {
    this.faults.set(checkpoint, error);
    return this;
  }

  pause(checkpoint: RestoreCheckpoint): CheckpointGate {
    const gate = deferredPair();
    this.gates.set(checkpoint, gate);
    return gate;
  }

  hitSync(checkpoint: RestoreCheckpoint): void {
    const error = this.faults.get(checkpoint);
    if (!error) return;
    this.faults.delete(checkpoint);
    throw error;
  }

  async hit(checkpoint: RestoreCheckpoint): Promise<void> {
    this.hitSync(checkpoint);
    const gate = this.gates.get(checkpoint);
    if (!gate) return;
    gate.signalEntered();
    await gate.release;
    this.gates.delete(checkpoint);
  }
}

let prototypeSequence = 0;

export async function createPrototypeDisk(): Promise<PrototypeDisk> {
  prototypeSequence += 1;
  const suffix = `${process.pid}-${prototypeSequence}`;
  const workspaceId = `prototype-workspace-${suffix}`;
  const original = createOriginalTarget();
  const documents: DocumentPhysicalState = {
    barriers: new Map(),
    collections: new Map([
      [original.collection.id, structuredClone(original.collection)],
    ]),
    documents: new Map([
      [original.document.documentId, structuredClone(original.document)],
    ]),
    snapshots: new Map(),
    sources: new Map([[original.document.documentId, cloneBlob(original.source)]]),
  };
  const productivity: ProductivityPhysicalState = {
    printPdfs: new Map([[original.document.documentId, cloneBlob(original.printPdf)]]),
    productivity: new Map([
      [original.document.documentId, structuredClone(original.productivity)],
    ]),
    snapshots: new Map(),
  };
  return {
    accountId: 'synthetic-account-approved@example.invalid',
    autoSyncEnabled: true,
    documentDbName: `39note-bkp03-prototype-docs-${suffix}`,
    documents: new SyntheticPhysicalDatabase(documents),
    driveEpoch: 0,
    driveEvents: [],
    nextBarrierGeneration: 0,
    productivity: new SyntheticPhysicalDatabase(productivity),
    productivityDbName: `39note-bkp03-prototype-productivity-${suffix}`,
    remoteRevalidationRequired: false,
    workspaceId,
  };
}

export function createOriginalTarget(): SyntheticRestoreTarget {
  const documentId = 'synthetic-paper-bkp03';
  return {
    collection: {
      documentIds: [documentId],
      id: 'synthetic-collection-original',
      name: 'Original synthetic collection',
    },
    document: {
      annotations: [{ color: 'yellow', id: 'annotation-original', kind: 'highlight' }],
      collectionIds: ['synthetic-collection-original'],
      documentId,
      links: [
        {
          documentId,
          id: 'link-original',
          sourceAnchor: 'page-1:10-20',
          targetAnchor: 'page-2:30-40',
        },
      ],
      notes: [
        {
          annotationId: 'annotation-original',
          content: 'Original synthetic Note',
          id: 'note-original',
        },
      ],
      title: 'Original synthetic paper',
    },
    printPdf: syntheticPdf('original-print-pdf'),
    productivity: {
      conversation: 'Original synthetic assistant conversation',
      documentId,
      printDraftTitle: 'Original print draft',
    },
    source: syntheticPdf('original-source-pdf'),
  };
}

export function createReplacementTarget(): SyntheticRestoreTarget {
  const documentId = 'synthetic-paper-bkp03';
  return {
    collection: {
      documentIds: [documentId],
      id: 'synthetic-collection-restored',
      name: 'Restored synthetic collection',
    },
    document: {
      annotations: [{ color: '#2A7FFF', id: 'annotation-restored', kind: 'highlight' }],
      collectionIds: ['synthetic-collection-restored'],
      documentId,
      links: [
        {
          documentId,
          id: 'link-restored',
          sourceAnchor: 'page-3:50-60',
          targetAnchor: 'page-4:70-80',
        },
      ],
      notes: [
        {
          annotationId: 'annotation-restored',
          content: 'Restored synthetic Note',
          id: 'note-restored',
        },
      ],
      title: 'Restored synthetic paper',
    },
    printPdf: syntheticPdf('restored-print-pdf'),
    productivity: {
      conversation: 'Restored synthetic assistant conversation',
      documentId,
      printDraftTitle: 'Restored print draft',
    },
    source: syntheticPdf('restored-source-pdf'),
  };
}

function syntheticPdf(label: string): Blob {
  return new Blob([`%PDF-1.7\n% 39Note BKP-03 ${label}\n%%EOF\n`], {
    type: 'application/pdf',
  });
}

export async function liveFingerprint(disk: PrototypeDisk): Promise<string> {
  const documentState = disk.documents.state;
  const productivityState = disk.productivity.state;
  return hashText(
    canonicalJson({
      collections: sortedMapValues(documentState.collections),
      documents: sortedMapValues(documentState.documents),
      printPdfs: await blobMapFingerprints(productivityState.printPdfs),
      productivity: sortedMapValues(productivityState.productivity),
      sources: await blobMapFingerprints(documentState.sources),
    }),
  );
}

export async function targetFingerprint(
  target: SyntheticRestoreTarget,
): Promise<string> {
  return hashText(
    canonicalJson({
      collections: [target.collection],
      documents: [target.document],
      printPdfs: [
        {
          hash: await blobHash(target.printPdf),
          key: target.document.documentId,
          size: target.printPdf.size,
          type: target.printPdf.type,
        },
      ],
      productivity: [target.productivity],
      sources: [
        {
          hash: await blobHash(target.source),
          key: target.document.documentId,
          size: target.source.size,
          type: target.source.type,
        },
      ],
    }),
  );
}

export async function blobHash(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export class RestorePhaseAPrototypeRuntime {
  readonly disk: PrototypeDisk;
  private readonly lockName: string;
  private runtimeSequence = 0;

  constructor(disk: PrototypeDisk) {
    this.disk = disk;
    this.lockName = `39note:bkp03:prototype:${disk.workspaceId}`;
  }

  getBarrier(): DurableRestoreBarrier | null {
    const barrier = this.disk.documents.state.barriers.get(this.disk.workspaceId);
    return barrier ? structuredClone(barrier) : null;
  }

  documentSnapshot(operationId: string): DocumentUndoSnapshot | null {
    const snapshot = this.disk.documents.state.snapshots.get(operationId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  productivitySnapshot(operationId: string): ProductivityUndoSnapshot | null {
    const snapshot = this.disk.productivity.state.snapshots.get(operationId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async restore(
    target: SyntheticRestoreTarget,
    faults = new FaultController(),
  ): Promise<DurableRestoreBarrier> {
    const operationId = `${this.disk.workspaceId}:restore:${++this.runtimeSequence}:${crypto.randomUUID()}`;
    const ownerToken = `${operationId}:owner`;
    return navigator.locks.request(this.lockName, { mode: 'exclusive' }, async () => {
      try {
        await faults.hit('before-journal-creation');
        const beforeFingerprint = await liveFingerprint(this.disk);
        const expectedTargetFingerprint = await targetFingerprint(target);
        this.createBarrier({
          accountId: this.disk.accountId,
          beforeFingerprint,
          createdAt: 1_700_000_000_000 + this.disk.nextBarrierGeneration,
          generation: this.nextGeneration(),
          operationId,
          ownerToken,
          phase: 'preparing',
          publicationHold: false,
          recoveryRequired: false,
          remoteRevalidationRequired: this.disk.remoteRevalidationRequired,
          targetFingerprint: expectedTargetFingerprint,
          workspaceId: this.disk.workspaceId,
        });
        this.disk.driveEpoch += 1;
        await faults.hit('after-journal-creation');

        this.captureDocumentSnapshot(operationId, faults);
        await faults.hit('after-document-snapshot');
        this.captureProductivitySnapshot(operationId, faults);
        await faults.hit('after-productivity-snapshot');
        this.transition(operationId, 'preparing', { phase: 'prepared' });

        await faults.hit('before-first-live-mutation');
        this.transition(operationId, 'prepared', { phase: 'applying' });
        this.applyDocumentTarget(operationId, target, faults);
        await faults.hit('after-document-mutation');
        this.applyProductivityTarget(operationId, target);
        await faults.hit('after-productivity-mutation');
        this.transition(operationId, 'applying', { phase: 'verifying' });

        const actualTargetFingerprint = await liveFingerprint(this.disk);
        assert.equal(
          actualTargetFingerprint,
          expectedTargetFingerprint,
          'cross-database restore verification must match the planned target fingerprint',
        );
        await faults.hit('before-commit-marker');
        this.transition(operationId, 'verifying', {
          phase: 'committed',
          publicationHold: true,
        });
        await faults.hit('after-commit-marker');
        await this.finalizeCommitted(operationId, faults);
        const barrier = this.requireBarrier(operationId);
        assert.equal(barrier.phase, 'publication-hold');
        return barrier;
      } catch (error) {
        if (error instanceof SimulatedProcessDeath) throw error;
        const barrier = this.getBarrier();
        if (!barrier || barrier.operationId !== operationId) throw error;
        if (barrier.phase === 'committed' || barrier.phase === 'publication-hold') {
          try {
            await this.finalizeCommitted(operationId, faults);
          } catch (cleanupError) {
            this.markRecoveryRequired(operationId);
            throw cleanupError;
          }
          throw error;
        }
        try {
          await this.rollback(operationId, faults);
        } catch (rollbackError) {
          if (rollbackError instanceof SimulatedProcessDeath) throw rollbackError;
          this.markRecoveryRequired(operationId);
          throw rollbackError;
        }
        throw error;
      }
    });
  }

  async recover(faults = new FaultController()): Promise<'idle' | 'publication-hold'> {
    return navigator.locks.request(this.lockName, { mode: 'exclusive' }, async () => {
      const barrier = this.getBarrier();
      if (!barrier) return 'idle';
      if (barrier.phase === 'committed' || barrier.phase === 'publication-hold') {
        await this.finalizeCommitted(barrier.operationId, faults);
        return 'publication-hold';
      }
      try {
        await this.rollback(barrier.operationId, faults);
        return 'idle';
      } catch (error) {
        if (!(error instanceof SimulatedProcessDeath)) {
          this.markRecoveryRequired(barrier.operationId);
        }
        throw error;
      }
    });
  }

  async guardedNormalWrite(
    write: () => void | Promise<void>,
    onAdmitted?: () => void | Promise<void>,
  ): Promise<void> {
    await navigator.locks.request(this.lockName, { mode: 'shared' }, async () => {
      if (this.getBarrier()) {
        throw new RestoreFencedError('A durable restore barrier blocks normal writes.');
      }
      await onAdmitted?.();
      if (this.getBarrier()) {
        throw new RestoreFencedError('The restore barrier changed before the write.');
      }
      await write();
    });
  }

  async releasePublicationHold(input: {
    operationId: string;
    expectedGeneration: number;
    accountId: string;
    remoteReconciled: boolean;
  }): Promise<void> {
    await navigator.locks.request(this.lockName, { mode: 'exclusive' }, async () => {
      const barrier = this.requireBarrier(input.operationId);
      if (barrier.phase !== 'publication-hold' || !barrier.publicationHold) {
        throw new RestoreFencedError(
          'The operation is not waiting in publication hold.',
        );
      }
      if (barrier.generation !== input.expectedGeneration) {
        throw new RestoreFencedError('The publication-hold generation is stale.');
      }
      if (
        barrier.accountId !== input.accountId ||
        this.disk.accountId !== input.accountId
      ) {
        throw new RestoreFencedError('The immutable workspace account does not match.');
      }
      if (barrier.remoteRevalidationRequired && !input.remoteReconciled) {
        throw new RestoreFencedError(
          'An ambiguous remote outcome requires reconciliation.',
        );
      }
      this.disk.documents.transaction((draft) => {
        const current = draft.barriers.get(this.disk.workspaceId);
        if (
          !current ||
          current.operationId !== input.operationId ||
          current.generation !== input.expectedGeneration
        ) {
          throw new RestoreFencedError('Publication hold ownership changed.');
        }
        draft.barriers.delete(this.disk.workspaceId);
      });
      this.disk.remoteRevalidationRequired = false;
      this.disk.driveEpoch += 1;
    });
  }

  private createBarrier(barrier: DurableRestoreBarrier): void {
    this.disk.documents.transaction((draft) => {
      if (draft.barriers.has(this.disk.workspaceId)) {
        throw new RestoreFencedError(
          'Another restore operation already owns this workspace.',
        );
      }
      draft.barriers.set(this.disk.workspaceId, structuredClone(barrier));
    });
  }

  private captureDocumentSnapshot(operationId: string, faults: FaultController): void {
    const documentId = 'synthetic-paper-bkp03';
    this.disk.documents.transaction((draft) => {
      if (draft.snapshots.has(operationId)) return;
      draft.snapshots.set(operationId, {
        applied: false,
        collection: cloneOrNull(draft.collections.get('synthetic-collection-original')),
        document: cloneOrNull(draft.documents.get(documentId)),
        operationId,
        rolledBack: false,
        source: cloneBlobOrNull(draft.sources.get(documentId)),
      });
      faults.hitSync('during-document-snapshot');
    });
  }

  private captureProductivitySnapshot(
    operationId: string,
    faults: FaultController,
  ): void {
    const documentId = 'synthetic-paper-bkp03';
    this.disk.productivity.transaction((draft) => {
      if (draft.snapshots.has(operationId)) return;
      draft.snapshots.set(operationId, {
        applied: false,
        operationId,
        printPdf: cloneBlobOrNull(draft.printPdfs.get(documentId)),
        productivity: cloneOrNull(draft.productivity.get(documentId)),
        rolledBack: false,
      });
      faults.hitSync('during-productivity-snapshot');
    });
  }

  private applyDocumentTarget(
    operationId: string,
    target: SyntheticRestoreTarget,
    faults: FaultController,
  ): void {
    this.disk.documents.transaction((draft) => {
      const snapshot = draft.snapshots.get(operationId);
      if (!snapshot) throw new Error('The co-located document preimage is missing.');
      draft.documents.set(target.document.documentId, structuredClone(target.document));
      draft.sources.set(target.document.documentId, cloneBlob(target.source));
      faults.hitSync('during-collection-mutation');
      draft.collections.delete('synthetic-collection-original');
      draft.collections.set(target.collection.id, structuredClone(target.collection));
      snapshot.applied = true;
      snapshot.rolledBack = false;
    });
  }

  private applyProductivityTarget(
    operationId: string,
    target: SyntheticRestoreTarget,
  ): void {
    this.disk.productivity.transaction((draft) => {
      const snapshot = draft.snapshots.get(operationId);
      if (!snapshot)
        throw new Error('The co-located productivity preimage is missing.');
      draft.productivity.set(
        target.document.documentId,
        structuredClone(target.productivity),
      );
      draft.printPdfs.set(target.document.documentId, cloneBlob(target.printPdf));
      snapshot.applied = true;
      snapshot.rolledBack = false;
    });
  }

  private async rollback(operationId: string, faults: FaultController): Promise<void> {
    const current = this.requireBarrier(operationId);
    if (current.phase !== 'rolling-back' && current.phase !== 'recovery-required') {
      this.transition(operationId, current.phase, {
        phase: 'rolling-back',
        recoveryRequired: false,
      });
    } else if (current.phase === 'recovery-required') {
      this.transition(operationId, 'recovery-required', {
        phase: 'rolling-back',
        recoveryRequired: false,
      });
    }

    this.disk.documents.transaction((draft) => {
      const snapshot = draft.snapshots.get(operationId);
      if (!snapshot || !snapshot.applied || snapshot.rolledBack) return;
      restoreMapEntry(draft.documents, 'synthetic-paper-bkp03', snapshot.document);
      restoreMapEntry(draft.sources, 'synthetic-paper-bkp03', snapshot.source);
      draft.collections.delete('synthetic-collection-restored');
      restoreMapEntry(
        draft.collections,
        'synthetic-collection-original',
        snapshot.collection,
      );
      faults.hitSync('during-rollback');
      snapshot.rolledBack = true;
    });
    await faults.hit('after-document-rollback');

    this.disk.productivity.transaction((draft) => {
      const snapshot = draft.snapshots.get(operationId);
      if (!snapshot || !snapshot.applied || snapshot.rolledBack) return;
      restoreMapEntry(
        draft.productivity,
        'synthetic-paper-bkp03',
        snapshot.productivity,
      );
      restoreMapEntry(draft.printPdfs, 'synthetic-paper-bkp03', snapshot.printPdf);
      snapshot.rolledBack = true;
    });

    const barrier = this.requireBarrier(operationId);
    assert.equal(
      await liveFingerprint(this.disk),
      barrier.beforeFingerprint,
      'rollback must reproduce the exact pre-restore cross-database fingerprint',
    );
    this.deleteSnapshots(operationId, faults);
    this.clearBarrier(operationId, this.requireBarrier(operationId).generation);
  }

  private async finalizeCommitted(
    operationId: string,
    faults: FaultController,
  ): Promise<void> {
    const barrier = this.requireBarrier(operationId);
    assert.ok(
      barrier.phase === 'committed' || barrier.phase === 'publication-hold',
      `cannot finalize the ${barrier.phase} phase`,
    );
    assert.equal(
      await liveFingerprint(this.disk),
      barrier.targetFingerprint,
      'a committed restore must retain the exact planned target fingerprint',
    );
    this.deleteSnapshots(operationId, faults);
    const refreshed = this.requireBarrier(operationId);
    if (refreshed.phase === 'committed') {
      this.transition(operationId, 'committed', {
        phase: 'publication-hold',
        publicationHold: true,
      });
    }
  }

  private deleteSnapshots(operationId: string, faults: FaultController): void {
    this.disk.documents.transaction((draft) => {
      draft.snapshots.delete(operationId);
      faults.hitSync('during-snapshot-cleanup');
    });
    this.disk.productivity.transaction((draft) => {
      draft.snapshots.delete(operationId);
    });
  }

  private transition(
    operationId: string,
    expectedPhase: RestorePhase,
    patch: Partial<
      Pick<DurableRestoreBarrier, 'phase' | 'publicationHold' | 'recoveryRequired'>
    >,
  ): DurableRestoreBarrier {
    return this.disk.documents.transaction((draft) => {
      const current = draft.barriers.get(this.disk.workspaceId);
      if (!current || current.operationId !== operationId) {
        throw new RestoreFencedError('Restore operation ownership changed.');
      }
      if (current.phase !== expectedPhase) {
        throw new RestoreFencedError(
          `Expected phase ${expectedPhase}, found ${current.phase}.`,
        );
      }
      const next: DurableRestoreBarrier = {
        ...current,
        ...patch,
        generation: this.nextGeneration(),
      };
      draft.barriers.set(this.disk.workspaceId, next);
      return structuredClone(next);
    });
  }

  private markRecoveryRequired(operationId: string): void {
    this.disk.documents.transaction((draft) => {
      const current = draft.barriers.get(this.disk.workspaceId);
      if (!current || current.operationId !== operationId) return;
      draft.barriers.set(this.disk.workspaceId, {
        ...current,
        generation: this.nextGeneration(),
        phase: 'recovery-required',
        recoveryRequired: true,
      });
    });
  }

  private clearBarrier(operationId: string, expectedGeneration: number): void {
    this.disk.documents.transaction((draft) => {
      const current = draft.barriers.get(this.disk.workspaceId);
      if (
        !current ||
        current.operationId !== operationId ||
        current.generation !== expectedGeneration
      ) {
        throw new RestoreFencedError('A stale restore actor cannot clear the barrier.');
      }
      draft.barriers.delete(this.disk.workspaceId);
    });
    this.disk.driveEpoch += 1;
  }

  private requireBarrier(operationId: string): DurableRestoreBarrier {
    const barrier = this.getBarrier();
    if (!barrier || barrier.operationId !== operationId) {
      throw new RestoreFencedError(
        'The durable restore operation is not owned by this actor.',
      );
    }
    return barrier;
  }

  private nextGeneration(): number {
    this.disk.nextBarrierGeneration += 1;
    return this.disk.nextBarrierGeneration;
  }
}

export class MockDriveGateway {
  private readonly disk: PrototypeDisk;
  private readonly lockName: string;

  constructor(disk: PrototypeDisk) {
    this.disk = disk;
    this.lockName = `39note:bkp03:prototype:${disk.workspaceId}`;
  }

  schedule(kind: DriveOperationKind, accountId = this.disk.accountId): DriveTicket {
    return {
      accountId,
      expectedEpoch: this.disk.driveEpoch,
      kind,
    };
  }

  async execute(
    ticket: DriveTicket,
    options: {
      beforeAdmission?: Promise<void>;
      transmittedGate?: { entered(): void; release: Promise<void> };
      ambiguous?: boolean;
    } = {},
  ): Promise<void> {
    this.disk.driveEvents.push({ ...ticket, status: 'requested' });
    await options.beforeAdmission;
    await navigator.locks.request(this.lockName, { mode: 'shared' }, async () => {
      const barrier = this.disk.documents.state.barriers.get(this.disk.workspaceId);
      if (barrier) {
        this.disk.driveEvents.push({
          ...ticket,
          reason: `restore-${barrier.phase}`,
          status: 'denied',
        });
        throw new RestoreFencedError(
          'Drive operation denied by the durable restore barrier.',
        );
      }
      if (ticket.accountId !== this.disk.accountId) {
        this.disk.driveEvents.push({
          ...ticket,
          reason: 'account-mismatch',
          status: 'denied',
        });
        throw new RestoreFencedError(
          'Drive operation account does not match the workspace.',
        );
      }
      if (ticket.expectedEpoch !== this.disk.driveEpoch) {
        this.disk.driveEvents.push({
          ...ticket,
          reason: 'stale-operation-generation',
          status: 'denied',
        });
        throw new RestoreFencedError('Drive operation generation is stale.');
      }
      this.disk.driveEvents.push({ ...ticket, status: 'transmitted' });
      options.transmittedGate?.entered();
      await options.transmittedGate?.release;
      if (options.ambiguous) {
        this.disk.remoteRevalidationRequired = true;
        this.disk.driveEvents.push({ ...ticket, status: 'ambiguous' });
        throw new AmbiguousRemoteOutcomeError();
      }
      this.disk.driveEvents.push({ ...ticket, status: 'completed' });
    });
  }

  observeReconnect(
    accountId: string,
  ): 'held-correct-account' | 'held-account-mismatch' {
    const barrier = this.disk.documents.state.barriers.get(this.disk.workspaceId);
    if (!barrier?.publicationHold) {
      throw new RestoreFencedError('Reconnect observation requires publication hold.');
    }
    return accountId === this.disk.accountId
      ? 'held-correct-account'
      : 'held-account-mismatch';
  }

  transmittedCount(): number {
    return this.disk.driveEvents.filter((event) => event.status === 'transmitted')
      .length;
  }
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deferredPair(): CheckpointGate {
  const entered = deferred<void>();
  const release = deferred<void>();
  return {
    entered: entered.promise,
    release: release.promise,
    signalEntered: () => entered.resolve(),
    signalRelease: () => release.resolve(),
  };
}

function restoreMapEntry<K, V>(map: Map<K, V>, key: K, value: V | null): void {
  if (value === null) {
    map.delete(key);
  } else {
    map.set(key, structuredClone(value));
  }
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}

function cloneBlob(blob: Blob): Blob {
  return blob.slice(0, blob.size, blob.type);
}

function cloneBlobOrNull(blob: Blob | undefined): Blob | null {
  return blob ? cloneBlob(blob) : null;
}

function sortedMapValues<T>(map: Map<string, T>): T[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

async function blobMapFingerprints(
  map: Map<string, Blob>,
): Promise<Array<{ key: string; hash: string; size: number; type: string }>> {
  return Promise.all(
    [...map.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([key, blob]) => ({
        hash: await blobHash(blob),
        key,
        size: blob.size,
        type: blob.type,
      })),
  );
}

async function hashText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]),
  );
}
