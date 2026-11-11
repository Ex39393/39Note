import { deleteDB, openDB, type DBSchema } from 'idb';

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const STARTUP_HANDOFF_KEY = '39note.workspace.temporary-startup.v1';
const REGISTRY_DATABASE_NAME = '39note-workspace-registry';
const REGISTRY_DATABASE_VERSION = 1;
const REGISTRY_STORE = 'temporary-workspaces';
const TEMPORARY_DATABASE_MARKER = '--temporary--';
const TEMPORARY_STORAGE_MARKER = '.temporary-workspace.';
const LEGACY_TEMPORARY_GOOGLE_SESSION_KEY = '39note.google-drive.temporary-session';
const LEGACY_PENDING_GOOGLE_EXCHANGE_KEY = '39note.google-drive.pending-exchange';

export const PERSONAL_ANNOTATION_DATABASE_NAME = '39note-db';
export const PERSONAL_PRODUCTIVITY_DATABASE_NAME = '39note-productivity-db';
export const PERSONAL_SYNC_DATABASE_NAME = '39note-sync';

export interface TemporaryWorkspaceRecord {
  id: string;
  createdAt: number;
  annotationDatabaseName: string;
  productivityDatabaseName: string;
  syncDatabaseName: string;
  /** Records created by the crash-safe lifecycle can be cleaned automatically. */
  ownershipVersion?: 1;
  /**
   * Short, non-secret lease used only while this tab is away at the OAuth
   * provider. It prevents another tab from mistaking the workspace for an
   * abandoned one after document-scoped Web Locks are released by navigation.
   */
  oauthLease?: TemporaryWorkspaceOAuthLease;
}

interface TemporaryWorkspaceOAuthLease {
  version: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface TemporaryWorkspaceCleanupReport {
  cleanedWorkspaceIds: string[];
  activeWorkspaceIds: string[];
  ambiguousWorkspaceIds: string[];
  failedWorkspaceIds: string[];
}

interface WorkspaceRegistryDatabase extends DBSchema {
  [REGISTRY_STORE]: {
    key: string;
    value: TemporaryWorkspaceRecord;
  };
}

interface ActiveWorkspaceMarker {
  version: 1;
  id: string;
}

interface StartupHandoffMarker extends ActiveWorkspaceMarker {
  purpose: 'workspace-created' | 'oauth-return';
  createdAt: number;
  oauthLeaseId?: string;
}

const WORKSPACE_CREATION_HANDOFF_MAX_AGE = 60_000;
const OAUTH_RETURN_HANDOFF_MAX_AGE = 20 * 60_000;

let registryPromise: ReturnType<typeof openRegistry> | null = null;
let activeWorkspaceLock:
  { workspaceId: string; release(): void; settled: Promise<void> } | undefined;
let startupCleanupReport: TemporaryWorkspaceCleanupReport = emptyCleanupReport();

export function getActiveTemporaryWorkspaceId(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(ACTIVE_WORKSPACE_KEY) ?? 'null',
    ) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isWorkspaceId(value.id))
      return null;
    return value.id;
  } catch {
    return null;
  }
}

export function isTemporaryWorkspaceActive(): boolean {
  return getActiveTemporaryWorkspaceId() !== null;
}

export function scopedDatabaseName(personalDatabaseName: string): string {
  const workspaceId = getActiveTemporaryWorkspaceId();
  return workspaceId
    ? temporaryDatabaseName(personalDatabaseName, workspaceId)
    : personalDatabaseName;
}

export function scopedLocalStorageKey(personalKey: string): string {
  const workspaceId = getActiveTemporaryWorkspaceId();
  return workspaceId
    ? `${personalKey}${TEMPORARY_STORAGE_MARKER}${workspaceId}`
    : personalKey;
}

export function currentTemporaryStorageSuffix(): string | null {
  const workspaceId = getActiveTemporaryWorkspaceId();
  return workspaceId ? `${TEMPORARY_STORAGE_MARKER}${workspaceId}` : null;
}

export function isStorageKeyOwnedByActiveWorkspace(
  key: string,
  personalPrefix: string,
): boolean {
  if (!key.startsWith(personalPrefix)) return false;
  const suffix = currentTemporaryStorageSuffix();
  return suffix ? key.endsWith(suffix) : !key.includes(TEMPORARY_STORAGE_MARKER);
}

export async function beginTemporaryWorkspace(): Promise<TemporaryWorkspaceRecord> {
  const existingId = getActiveTemporaryWorkspaceId();
  if (existingId) {
    const existing = await requireTemporaryWorkspace(existingId);
    if (existing.ownershipVersion !== 1) {
      throw new Error('Temporary workspace ownership could not be verified.');
    }
    await acquireActiveTemporaryWorkspaceLock(existing.id);
    return existing;
  }
  if (typeof sessionStorage === 'undefined') {
    throw new Error('Temporary workspace storage is unavailable in this browser.');
  }
  const id = crypto.randomUUID();
  const record = createWorkspaceRecord(id);
  const registry = await getRegistry();
  await registry.put(REGISTRY_STORE, record);
  const marker: ActiveWorkspaceMarker = { version: 1, id };
  try {
    sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, JSON.stringify(marker));
    writeStartupHandoff(record.id, 'workspace-created');
    await acquireActiveTemporaryWorkspaceLock(record.id);
  } catch (error) {
    releaseActiveTemporaryWorkspaceLock(record.id);
    sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
    await registry.delete(REGISTRY_STORE, id);
    throw new Error('Temporary workspace storage is unavailable in this browser.', {
      cause: error,
    });
  }
  return record;
}

export async function requireActiveTemporaryWorkspace(): Promise<TemporaryWorkspaceRecord> {
  const workspaceId = getActiveTemporaryWorkspaceId();
  if (!workspaceId) throw new Error('The temporary workspace is not active.');
  const record = await requireTemporaryWorkspace(workspaceId);
  assertActiveTemporaryWorkspaceOwnership(record);
  return record;
}

/**
 * Allows precisely one same-tab application startup after the OAuth provider
 * redirects back. The handoff carries no token, account identifier, or paper
 * data and is accepted only on an actual broker callback fragment.
 */
export async function armTemporaryWorkspaceOAuthReturn(): Promise<void> {
  const record = await requireActiveTemporaryWorkspace();
  if (record.ownershipVersion !== 1 || activeWorkspaceLock?.workspaceId !== record.id) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  const createdAt = Date.now();
  const oauthLease: TemporaryWorkspaceOAuthLease = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt,
    expiresAt: createdAt + OAUTH_RETURN_HANDOFF_MAX_AGE,
  };
  const registry = await getRegistry();
  await registry.put(REGISTRY_STORE, { ...record, oauthLease });
  try {
    writeStartupHandoff(record.id, 'oauth-return', oauthLease.id, createdAt);
  } catch (error) {
    // Navigation has not started. Restore the exact prior record so a failed
    // sessionStorage write cannot strand an otherwise active workspace behind
    // a lease that no tab can present.
    await registry.put(REGISTRY_STORE, record);
    sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
    throw error;
  }
}

/** Clears the cross-navigation lease after callback verification or failure. */
export async function clearTemporaryWorkspaceOAuthReturn(): Promise<void> {
  const record = await requireActiveTemporaryWorkspace();
  if (record.oauthLease) {
    const updated = { ...record };
    delete updated.oauthLease;
    await (await getRegistry()).put(REGISTRY_STORE, updated);
  }
  sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
}

export async function deleteTemporaryWorkspaceDatabases(
  record: TemporaryWorkspaceRecord,
): Promise<void> {
  assertActiveTemporaryWorkspaceOwnership(record);
  await deleteDB(record.annotationDatabaseName);
  await deleteDB(record.productivityDatabaseName);
  await deleteDB(record.syncDatabaseName);
}

export async function completeTemporaryWorkspace(
  record: TemporaryWorkspaceRecord,
): Promise<void> {
  assertActiveTemporaryWorkspaceOwnership(record);
  await (await getRegistry()).delete(REGISTRY_STORE, record.id);
  sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
  releaseActiveTemporaryWorkspaceLock(record.id);
}

/**
 * Runs before application persistence opens. New lifecycle records are deleted
 * only while this tab owns their exclusive browser lock. Legacy/unclassified
 * registry entries are retained because their active ownership cannot be proven.
 */
export async function prepareTemporaryWorkspaceStartup(): Promise<TemporaryWorkspaceCleanupReport> {
  // Released temporary auth was unscoped. It cannot be attributed safely to a
  // current workspace, so it is never restored after a new application boot.
  sessionStorage.removeItem(LEGACY_TEMPORARY_GOOGLE_SESSION_KEY);
  clearLegacyTemporaryPendingExchange();
  const activeId = getActiveTemporaryWorkspaceId();
  const handoff = getStartupHandoff();
  sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
  if (activeId && handoff?.id === activeId) {
    const record = await requireTemporaryWorkspace(activeId);
    if (record.ownershipVersion !== 1) {
      throw new Error('Temporary workspace ownership could not be verified.');
    }
    if (isValidStartupHandoff(handoff, record)) {
      await acquireActiveTemporaryWorkspaceLock(activeId);
      startupCleanupReport = await cleanupAbandonedTemporaryWorkspaces(activeId);
      return getTemporaryWorkspaceStartupCleanupReport();
    }
  }
  // A temporary workspace may survive a refresh, crash, or restored tab while
  // no JavaScript owner survives. Privacy takes priority over recovering a
  // previous public user's content, so only a one-time creation handoff may
  // reopen it. Every later startup fails closed; exact cleanup occurs as soon
  // as any bounded cross-navigation OAuth lease has expired.
  startupCleanupReport = await cleanupTemporaryWorkspaces(null);
  if (activeId && !startupCleanupReport.cleanedWorkspaceIds.includes(activeId)) {
    throw new Error('The abandoned temporary workspace could not be safely cleared.');
  }
  return getTemporaryWorkspaceStartupCleanupReport();
}

export function getTemporaryWorkspaceStartupCleanupReport(): TemporaryWorkspaceCleanupReport {
  return cloneCleanupReport(startupCleanupReport);
}

export async function cleanupAbandonedTemporaryWorkspaces(
  activeWorkspaceId: string | null = getActiveTemporaryWorkspaceId(),
): Promise<TemporaryWorkspaceCleanupReport> {
  return cleanupTemporaryWorkspaces(activeWorkspaceId);
}

async function cleanupTemporaryWorkspaces(
  activeWorkspaceId: string | null,
): Promise<TemporaryWorkspaceCleanupReport> {
  const report = emptyCleanupReport();
  const registry = await getRegistry();
  const records = await registry.getAll(REGISTRY_STORE);
  for (const rawRecord of records) {
    let record: TemporaryWorkspaceRecord;
    try {
      validateWorkspaceRecord(rawRecord);
      record = rawRecord;
    } catch {
      const candidateId =
        isRecord(rawRecord) && isWorkspaceId(rawRecord.id)
          ? rawRecord.id
          : 'unclassified';
      report.ambiguousWorkspaceIds.push(candidateId);
      continue;
    }
    if (
      record.id === activeWorkspaceId &&
      activeWorkspaceLock?.workspaceId === record.id
    ) {
      report.activeWorkspaceIds.push(record.id);
      continue;
    }
    if (record.ownershipVersion !== 1) {
      report.ambiguousWorkspaceIds.push(record.id);
      continue;
    }
    if (hasUnexpiredOAuthLease(record)) {
      report.activeWorkspaceIds.push(record.id);
      continue;
    }
    const outcome = await withAvailableWorkspaceLock(record.id, async () => {
      const current = await registry.get(REGISTRY_STORE, record.id);
      if (!current) return 'cleaned' as const;
      validateWorkspaceRecord(current);
      if (current.ownershipVersion !== 1) return 'ambiguous' as const;
      if (hasUnexpiredOAuthLease(current)) {
        return 'active' as const;
      }
      await deleteRegisteredWorkspaceDatabases(current);
      clearWorkspaceStorageKeys(current.id);
      clearWorkspaceSessionMarkers(current.id);
      await registry.delete(REGISTRY_STORE, current.id);
      return 'cleaned' as const;
    }).catch(() => 'failed' as const);
    if (outcome === 'unavailable') report.activeWorkspaceIds.push(record.id);
    else if (outcome === 'active') report.activeWorkspaceIds.push(record.id);
    else if (outcome === 'cleaned') report.cleanedWorkspaceIds.push(record.id);
    else if (outcome === 'ambiguous') report.ambiguousWorkspaceIds.push(record.id);
    else report.failedWorkspaceIds.push(record.id);
  }
  return normalizeCleanupReport(report);
}

export function reloadForWorkspaceChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('39note:workspace-changing'));
  window.setTimeout(() => window.location.reload(), 0);
}

export function temporaryDatabaseName(
  personalDatabaseName: string,
  workspaceId: string,
): string {
  if (!isWorkspaceId(workspaceId) || !isPersonalDatabaseName(personalDatabaseName)) {
    throw new Error('Invalid temporary workspace database identity.');
  }
  return `${personalDatabaseName}${TEMPORARY_DATABASE_MARKER}${workspaceId}`;
}

function createWorkspaceRecord(id: string): TemporaryWorkspaceRecord {
  return {
    id,
    createdAt: Date.now(),
    annotationDatabaseName: temporaryDatabaseName(
      PERSONAL_ANNOTATION_DATABASE_NAME,
      id,
    ),
    productivityDatabaseName: temporaryDatabaseName(
      PERSONAL_PRODUCTIVITY_DATABASE_NAME,
      id,
    ),
    syncDatabaseName: temporaryDatabaseName(PERSONAL_SYNC_DATABASE_NAME, id),
    ownershipVersion: 1,
  };
}

async function requireTemporaryWorkspace(
  id: string,
): Promise<TemporaryWorkspaceRecord> {
  const record = await (await getRegistry()).get(REGISTRY_STORE, id);
  if (!record) throw new Error('Temporary workspace ownership could not be verified.');
  validateWorkspaceRecord(record);
  return record;
}

function validateWorkspaceRecord(record: TemporaryWorkspaceRecord): void {
  const expected = createWorkspaceRecord(record.id);
  if (
    !Number.isFinite(record.createdAt) ||
    record.createdAt < 0 ||
    record.annotationDatabaseName !== expected.annotationDatabaseName ||
    record.productivityDatabaseName !== expected.productivityDatabaseName ||
    record.syncDatabaseName !== expected.syncDatabaseName ||
    (record.ownershipVersion !== undefined && record.ownershipVersion !== 1) ||
    (record.oauthLease !== undefined && !isValidOAuthLease(record.oauthLease))
  ) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
}

function assertActiveTemporaryWorkspaceOwnership(
  record: TemporaryWorkspaceRecord,
): void {
  validateWorkspaceRecord(record);
  if (
    record.ownershipVersion !== 1 ||
    getActiveTemporaryWorkspaceId() !== record.id ||
    activeWorkspaceLock?.workspaceId !== record.id
  ) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
}

async function deleteRegisteredWorkspaceDatabases(
  record: TemporaryWorkspaceRecord,
): Promise<void> {
  validateWorkspaceRecord(record);
  await deleteDB(record.annotationDatabaseName);
  await deleteDB(record.productivityDatabaseName);
  await deleteDB(record.syncDatabaseName);
}

function clearWorkspaceStorageKeys(workspaceId: string): void {
  if (!isWorkspaceId(workspaceId)) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  const suffix = `${TEMPORARY_STORAGE_MARKER}${workspaceId}`;
  for (const storage of availableBrowserStorages()) {
    for (const key of storageKeys(storage)) {
      if (
        key.endsWith(suffix) &&
        (key.startsWith('39note.ai.') ||
          key === `${LEGACY_TEMPORARY_GOOGLE_SESSION_KEY}${suffix}` ||
          key === `${LEGACY_PENDING_GOOGLE_EXCHANGE_KEY}${suffix}`)
      ) {
        storage.removeItem(key);
      }
    }
  }
}

function clearLegacyTemporaryPendingExchange(): void {
  const raw = sessionStorage.getItem(LEGACY_PENDING_GOOGLE_EXCHANGE_KEY);
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value) && value.sessionMode === 'temporary') {
      sessionStorage.removeItem(LEGACY_PENDING_GOOGLE_EXCHANGE_KEY);
    }
  } catch {
    // Malformed legacy state is not trusted as temporary ownership. The OAuth
    // reader will reject and remove it if a callback attempts to consume it.
  }
}

function clearWorkspaceSessionMarkers(workspaceId: string): void {
  if (getActiveTemporaryWorkspaceId() === workspaceId) {
    sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
  }
  if (getStartupHandoff()?.id === workspaceId) {
    sessionStorage.removeItem(STARTUP_HANDOFF_KEY);
  }
}

function writeStartupHandoff(
  workspaceId: string,
  purpose: StartupHandoffMarker['purpose'],
  oauthLeaseId?: string,
  createdAt = Date.now(),
): void {
  const marker: StartupHandoffMarker = {
    version: 1,
    id: workspaceId,
    purpose,
    createdAt,
    ...(oauthLeaseId ? { oauthLeaseId } : {}),
  };
  sessionStorage.setItem(STARTUP_HANDOFF_KEY, JSON.stringify(marker));
}

function getStartupHandoff(): StartupHandoffMarker | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(STARTUP_HANDOFF_KEY) ?? 'null',
    ) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isWorkspaceId(value.id) ||
      (value.purpose !== 'workspace-created' && value.purpose !== 'oauth-return') ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      (value.purpose === 'oauth-return' && !isWorkspaceId(value.oauthLeaseId)) ||
      (value.purpose === 'workspace-created' && value.oauthLeaseId !== undefined)
    ) {
      return null;
    }
    return value as unknown as StartupHandoffMarker;
  } catch {
    return null;
  }
}

function isValidStartupHandoff(
  handoff: StartupHandoffMarker,
  record: TemporaryWorkspaceRecord,
): boolean {
  const age = Date.now() - handoff.createdAt;
  if (age < 0) return false;
  if (handoff.purpose === 'workspace-created') {
    return age <= WORKSPACE_CREATION_HANDOFF_MAX_AGE && !record.oauthLease;
  }
  if (
    age > OAUTH_RETURN_HANDOFF_MAX_AGE ||
    typeof window === 'undefined' ||
    !record.oauthLease ||
    record.oauthLease.id !== handoff.oauthLeaseId ||
    record.oauthLease.createdAt !== handoff.createdAt ||
    record.oauthLease.expiresAt < Date.now()
  ) {
    return false;
  }
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
  return fragment.has('sync_auth_grant') || fragment.has('sync_auth_error');
}

function isValidOAuthLease(value: TemporaryWorkspaceOAuthLease): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isWorkspaceId(value.id) &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt >= value.createdAt &&
    value.expiresAt - value.createdAt <= OAUTH_RETURN_HANDOFF_MAX_AGE
  );
}

function hasUnexpiredOAuthLease(record: TemporaryWorkspaceRecord): boolean {
  const now = Date.now();
  // A system-clock rollback can place a valid, bounded lease's creation time
  // in the apparent future. Treat that uncertainty as active until expiresAt;
  // never delete an in-flight OAuth workspace merely because the wall clock
  // moved backwards.
  return Boolean(record.oauthLease && record.oauthLease.expiresAt >= now);
}

function availableBrowserStorages(): Storage[] {
  const storages: Storage[] = [];
  if (typeof localStorage !== 'undefined') storages.push(localStorage);
  if (typeof sessionStorage !== 'undefined') storages.push(sessionStorage);
  return storages;
}

function storageKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter((key): key is string => key !== null);
}

function browserLockManager(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

async function acquireActiveTemporaryWorkspaceLock(workspaceId: string): Promise<void> {
  if (activeWorkspaceLock?.workspaceId === workspaceId) return;
  if (activeWorkspaceLock) {
    throw new Error('Another temporary workspace is active in this tab.');
  }
  const locks = browserLockManager();
  if (!locks) {
    throw new Error(
      'This browser cannot safely isolate a Public / temporary workspace.',
    );
  }
  let settle!: () => void;
  let resolveAcquired!: (acquired: boolean) => void;
  let rejectAcquired!: (error: unknown) => void;
  const held = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const acquired = new Promise<boolean>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const settled = locks
    .request(
      workspaceLockName(workspaceId),
      { ifAvailable: true, mode: 'exclusive' },
      async (lock) => {
        resolveAcquired(Boolean(lock));
        if (lock) await held;
      },
    )
    .then(() => undefined);
  void settled.catch((error) => rejectAcquired(error));
  if (!(await acquired)) {
    await settled;
    throw new Error('This temporary workspace is already active in another tab.');
  }
  activeWorkspaceLock = {
    workspaceId,
    release: settle,
    settled,
  };
}

function releaseActiveTemporaryWorkspaceLock(workspaceId: string): void {
  if (activeWorkspaceLock?.workspaceId !== workspaceId) return;
  activeWorkspaceLock.release();
  activeWorkspaceLock = undefined;
}

async function withAvailableWorkspaceLock<T>(
  workspaceId: string,
  task: () => Promise<T>,
): Promise<T | 'unavailable'> {
  const locks = browserLockManager();
  if (!locks) return 'unavailable';
  let outcome: T | 'unavailable' = 'unavailable';
  await locks.request(
    workspaceLockName(workspaceId),
    { ifAvailable: true, mode: 'exclusive' },
    async (lock) => {
      if (lock) outcome = await task();
    },
  );
  return outcome;
}

function workspaceLockName(workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  return `39note:temporary-workspace:${workspaceId}`;
}

function emptyCleanupReport(): TemporaryWorkspaceCleanupReport {
  return {
    cleanedWorkspaceIds: [],
    activeWorkspaceIds: [],
    ambiguousWorkspaceIds: [],
    failedWorkspaceIds: [],
  };
}

function normalizeCleanupReport(
  report: TemporaryWorkspaceCleanupReport,
): TemporaryWorkspaceCleanupReport {
  return Object.fromEntries(
    Object.entries(report).map(([key, values]) => [key, [...new Set(values)].sort()]),
  ) as unknown as TemporaryWorkspaceCleanupReport;
}

function cloneCleanupReport(
  report: TemporaryWorkspaceCleanupReport,
): TemporaryWorkspaceCleanupReport {
  return {
    cleanedWorkspaceIds: [...report.cleanedWorkspaceIds],
    activeWorkspaceIds: [...report.activeWorkspaceIds],
    ambiguousWorkspaceIds: [...report.ambiguousWorkspaceIds],
    failedWorkspaceIds: [...report.failedWorkspaceIds],
  };
}

function getRegistry() {
  registryPromise ??= openRegistry().catch((error) => {
    registryPromise = null;
    throw error;
  });
  return registryPromise;
}

function openRegistry() {
  return openDB<WorkspaceRegistryDatabase>(
    REGISTRY_DATABASE_NAME,
    REGISTRY_DATABASE_VERSION,
    {
      upgrade(database) {
        if (!database.objectStoreNames.contains(REGISTRY_STORE)) {
          database.createObjectStore(REGISTRY_STORE, { keyPath: 'id' });
        }
      },
    },
  );
}

function isPersonalDatabaseName(value: string): boolean {
  return [
    PERSONAL_ANNOTATION_DATABASE_NAME,
    PERSONAL_PRODUCTIVITY_DATABASE_NAME,
    PERSONAL_SYNC_DATABASE_NAME,
  ].includes(value);
}

function isWorkspaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
