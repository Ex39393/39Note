import { getActiveTemporaryWorkspaceId } from './temporaryWorkspace.ts';

export type WorkspaceLeaseMode = 'shared' | 'exclusive';

declare const WORKSPACE_LEASE_BRAND: unique symbol;

/**
 * An opaque, runtime-validated capability proving that this logical operation
 * owns the current workspace's restore-safety Web Lock.
 */
export interface WorkspaceRestoreLease {
  readonly [WORKSPACE_LEASE_BRAND]: true;
  readonly mode: WorkspaceLeaseMode;
  readonly workspaceId: string;
}

export interface HeldWorkspaceRestoreLease {
  readonly lease: WorkspaceRestoreLease;
  release(): void;
  readonly settled: Promise<void>;
}

interface LeaseState {
  active: boolean;
  mode: WorkspaceLeaseMode;
  workspaceId: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T | PromiseLike<T>): void;
}

const leaseStates = new WeakMap<object, LeaseState>();
const WORKSPACE_IDENTITY_TRANSITION_LOCK =
  '39note:workspace-restore-safety:v1:workspace-identity';

export class WorkspaceLocksUnavailableError extends Error {
  constructor() {
    super(
      'This browser does not provide the workspace locking required for safe persistence.',
    );
    this.name = 'WorkspaceLocksUnavailableError';
  }
}

export class InvalidWorkspaceRestoreLeaseError extends Error {
  constructor(message = 'The workspace persistence lease is invalid or stale.') {
    super(message);
    this.name = 'InvalidWorkspaceRestoreLeaseError';
  }
}

export function currentWorkspaceRestoreIdentity(): string {
  const temporaryWorkspaceId = getActiveTemporaryWorkspaceId();
  return temporaryWorkspaceId ? `temporary:${temporaryWorkspaceId}` : 'personal';
}

export function workspaceRestoreLockName(workspaceId: string): string {
  if (!isWorkspaceRestoreIdentity(workspaceId)) {
    throw new InvalidWorkspaceRestoreLeaseError(
      'The workspace lock identity is invalid.',
    );
  }
  return `39note:workspace-restore-safety:v1:${workspaceId}`;
}

export function browserSupportsWorkspaceRestoreLocks(): boolean {
  return Boolean(browserLockManager());
}

export function assertWorkspaceRestoreLease(
  lease: WorkspaceRestoreLease,
  options: { allowExclusive?: boolean; requireExclusive?: boolean } = {},
): void {
  const state = leaseStates.get(lease as object);
  if (!state?.active) throw new InvalidWorkspaceRestoreLeaseError();
  if (state.workspaceId !== currentWorkspaceRestoreIdentity()) {
    throw new InvalidWorkspaceRestoreLeaseError(
      'The persistence lease belongs to a different workspace.',
    );
  }
  if (options.requireExclusive && state.mode !== 'exclusive') {
    throw new InvalidWorkspaceRestoreLeaseError(
      'Exclusive workspace ownership is required.',
    );
  }
  if (!options.allowExclusive && !options.requireExclusive && state.mode !== 'shared') {
    throw new InvalidWorkspaceRestoreLeaseError(
      'Shared workspace ownership is required.',
    );
  }
}

export async function withSharedWorkspaceRestoreLease<T>(
  task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
  existingLease?: WorkspaceRestoreLease,
): Promise<T> {
  if (existingLease) {
    assertWorkspaceRestoreLease(existingLease, { allowExclusive: true });
    return task(existingLease);
  }
  return withNewWorkspaceRestoreLease('shared', task);
}

export async function withExclusiveWorkspaceRestoreLease<T>(
  task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  return withNewWorkspaceRestoreLease('exclusive', task, signal);
}

/**
 * Serializes creation, departure, and destruction of a UUID-scoped workspace.
 * Normal operations hold the identity lock in shared mode, so supported
 * workspace changes cannot occur midway through an admitted mutation.
 */
export async function withWorkspaceIdentityTransition<T>(
  task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
): Promise<T> {
  const locks = requireBrowserLockManager();
  return locks.request(
    WORKSPACE_IDENTITY_TRANSITION_LOCK,
    { mode: 'exclusive' },
    async () => {
      const workspaceId = currentWorkspaceRestoreIdentity();
      return locks.request(
        workspaceRestoreLockName(workspaceId),
        { mode: 'exclusive' },
        async () => runWithLease(workspaceId, 'exclusive', task),
      );
    },
  );
}

/**
 * Acquires shared ownership that a long-lived coordinator can explicitly
 * release after its entire remote/local operation settles.
 */
export async function acquireSharedWorkspaceRestoreLease(
  signal?: AbortSignal,
): Promise<HeldWorkspaceRestoreLease> {
  const locks = requireBrowserLockManager();
  signal?.throwIfAborted();
  const ready = deferred<HeldWorkspaceRestoreLease>();
  const release = deferred<void>();
  let released = false;
  let state: LeaseState | undefined;

  const settled = locks
    .request(WORKSPACE_IDENTITY_TRANSITION_LOCK, { mode: 'shared', signal }, () => {
      const workspaceId = currentWorkspaceRestoreIdentity();
      return locks.request(
        workspaceRestoreLockName(workspaceId),
        { mode: 'shared', signal },
        async () => {
          signal?.throwIfAborted();
          const lease = createLease(workspaceId, 'shared');
          state = leaseStates.get(lease as object);
          ready.resolve({
            lease,
            release: () => {
              if (released) return;
              released = true;
              release.resolve(undefined);
            },
            settled: Promise.resolve(),
          });
          try {
            await release.promise;
          } finally {
            if (state) state.active = false;
          }
        },
      );
    })
    .then(() => undefined);

  void settled.catch((error) => ready.reject(error));
  const acquired = await ready.promise;
  return {
    lease: acquired.lease,
    release: acquired.release,
    settled,
  };
}

async function withNewWorkspaceRestoreLease<T>(
  mode: WorkspaceLeaseMode,
  task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  const locks = requireBrowserLockManager();
  signal?.throwIfAborted();
  return locks.request(
    WORKSPACE_IDENTITY_TRANSITION_LOCK,
    { mode: 'shared', signal },
    async () => {
      signal?.throwIfAborted();
      const workspaceId = currentWorkspaceRestoreIdentity();
      return locks.request(
        workspaceRestoreLockName(workspaceId),
        { mode, signal },
        async () => runWithLease(workspaceId, mode, task),
      );
    },
  );
}

async function runWithLease<T>(
  workspaceId: string,
  mode: WorkspaceLeaseMode,
  task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
): Promise<T> {
  const lease = createLease(workspaceId, mode);
  const state = leaseStates.get(lease as object)!;
  try {
    return await task(lease);
  } finally {
    state.active = false;
  }
}

function createLease(
  workspaceId: string,
  mode: WorkspaceLeaseMode,
): WorkspaceRestoreLease {
  const lease = Object.freeze({
    mode,
    workspaceId,
  }) as WorkspaceRestoreLease;
  leaseStates.set(lease as object, { active: true, mode, workspaceId });
  return lease;
}

function requireBrowserLockManager(): LockManager {
  const locks = browserLockManager();
  if (!locks) throw new WorkspaceLocksUnavailableError();
  return locks;
}

function browserLockManager(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

function isWorkspaceRestoreIdentity(value: string): boolean {
  return (
    value === 'personal' ||
    /^temporary:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
