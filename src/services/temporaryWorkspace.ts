import { deleteDB, openDB, type DBSchema } from 'idb';

const ACTIVE_WORKSPACE_KEY = '39note.workspace.temporary.v1';
const REGISTRY_DATABASE_NAME = '39note-workspace-registry';
const REGISTRY_DATABASE_VERSION = 1;
const REGISTRY_STORE = 'temporary-workspaces';
const TEMPORARY_DATABASE_MARKER = '--temporary--';
const TEMPORARY_STORAGE_MARKER = '.temporary-workspace.';

export const PERSONAL_ANNOTATION_DATABASE_NAME = '39note-db';
export const PERSONAL_PRODUCTIVITY_DATABASE_NAME = '39note-productivity-db';
export const PERSONAL_SYNC_DATABASE_NAME = '39note-sync';

export interface TemporaryWorkspaceRecord {
  id: string;
  createdAt: number;
  annotationDatabaseName: string;
  productivityDatabaseName: string;
  syncDatabaseName: string;
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

let registryPromise: ReturnType<typeof openRegistry> | null = null;

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
  if (existingId) return requireTemporaryWorkspace(existingId);
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
  } catch (error) {
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
  return requireTemporaryWorkspace(workspaceId);
}

export async function deleteTemporaryWorkspaceDatabases(
  record: TemporaryWorkspaceRecord,
): Promise<void> {
  validateWorkspaceRecord(record);
  const activeId = getActiveTemporaryWorkspaceId();
  if (activeId !== record.id) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  await deleteDB(record.annotationDatabaseName);
  await deleteDB(record.productivityDatabaseName);
  await deleteDB(record.syncDatabaseName);
}

export async function completeTemporaryWorkspace(
  record: TemporaryWorkspaceRecord,
): Promise<void> {
  validateWorkspaceRecord(record);
  if (getActiveTemporaryWorkspaceId() !== record.id) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
  await (await getRegistry()).delete(REGISTRY_STORE, record.id);
  sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
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
    record.syncDatabaseName !== expected.syncDatabaseName
  ) {
    throw new Error('Temporary workspace ownership could not be verified.');
  }
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
