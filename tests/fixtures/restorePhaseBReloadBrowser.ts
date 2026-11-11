import type { DurableRestoreOperation } from '../../src/services/restoreSafety.ts';

interface ReloadState {
  operation: DurableRestoreOperation;
  workspaceId: string;
}

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const RELOAD_STATE_KEY = '39note.bkp03.phase-b.native-reload.v1';
const summary = document.querySelector<HTMLElement>('#summary')!;
const details = document.querySelector<HTMLElement>('#details')!;

try {
  const existing = readReloadState();
  const workspaceId = existing?.workspaceId ?? crypto.randomUUID();
  sessionStorage.setItem(
    ACTIVE_WORKSPACE_KEY,
    JSON.stringify({ id: workspaceId, version: 1 }),
  );

  const [annotation, productivity, startup, locks] = await Promise.all([
    import('../../src/services/annotationPersistence.ts'),
    import('../../src/services/productivityPersistence.ts'),
    import('../../src/services/restoreSafetyStartup.ts'),
    import('../../src/services/workspaceRestoreLock.ts'),
  ]);

  if (!existing) {
    await startup.verifyRestoreSafetyBeforeAppMount();
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
    await locks.withExclusiveWorkspaceRestoreLease((lease) =>
      annotation.createDurableRestoreOperation(operation, lease),
    );
    await Promise.all([
      annotation.closeAnnotationPersistenceWorkspace(),
      productivity.closeProductivityPersistenceWorkspace(),
    ]);
    sessionStorage.setItem(
      RELOAD_STATE_KEY,
      JSON.stringify({ operation, workspaceId }),
    );
    summary.dataset.phaseBResult = 'RELOADING';
    summary.textContent = 'Reloading with a durable restore barrier…';
    location.reload();
  } else {
    const persisted = await annotation.loadDurableRestoreOperation();
    assertJsonEqual(
      persisted,
      existing.operation,
      'journal changed across page reload',
    );
    await assertRejects(
      startup.verifyRestoreSafetyBeforeAppMount(),
      (error) => error instanceof Error && error.name === 'RestoreStartupRecoveryError',
      'application startup did not fail closed after reload',
    );
    let writerRan = false;
    await assertRejects(
      annotation.withWorkspaceMutation(() => {
        writerRan = true;
      }),
      (error) =>
        error instanceof Error && error.name === 'WorkspaceRestoreBarrierError',
      'normal mutation was not rejected after reload',
    );
    assert(!writerRan, 'normal mutation ran behind the reloaded barrier');
    await Promise.all([
      annotation.closeAnnotationPersistenceWorkspace(),
      productivity.closeProductivityPersistenceWorkspace(),
    ]);
    summary.dataset.phaseBResult = 'PASS';
    summary.textContent = 'PASS — durable barrier survived an actual page reload';
    details.textContent = JSON.stringify(
      {
        origin: location.origin,
        requests: performance.getEntriesByType('resource').map((entry) => entry.name),
        workspaceId,
      },
      null,
      2,
    );
    document.title = 'PASS — BKP-03 Phase B native reload check';
  }
} catch (error) {
  summary.dataset.phaseBResult = 'FAIL';
  summary.textContent = `FAIL — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  document.title = 'FAIL — BKP-03 Phase B native reload check';
}

function readReloadState(): ReloadState | null {
  const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as ReloadState;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.workspaceId !== 'string' ||
    !value.operation ||
    value.operation.workspaceId !== `temporary:${value.workspaceId}`
  ) {
    throw new Error('The synthetic reload state is invalid.');
  }
  return value;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}
