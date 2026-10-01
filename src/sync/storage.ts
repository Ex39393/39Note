import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  SYNC_DATABASE_NAME,
  SYNC_DATABASE_VERSION,
  type SyncDeviceState,
} from './types.ts';
import type {
  PaperCloudSummary,
  PaperDriveFileEvidence,
  PaperDirtyReason,
  PaperSyncState,
} from './paperTypes.ts';
import type { LayoutMigrationFailure } from './layoutMigration.ts';
import { isValidDocumentId } from '../utils/documentId.ts';
import {
  isTemporaryWorkspaceActive,
  scopedDatabaseName,
} from '../services/temporaryWorkspace.ts';

const DEVICE_STORE = 'device-state';
const PAPER_DEVICE_STORE = 'paper-device';
const PAPER_STATE_STORE = 'paper-state';
const CLOUD_PAPER_STORE = 'cloud-paper';
const TEMPORARY_SESSION_STORE = 'temporary-session';
const LAYOUT_MIGRATION_STORE = 'layout-migration';

export type SyncDeviceMode = 'personal' | 'temporary';

export interface PaperDriveChangeCursor {
  version: 1;
  accountId: string;
  rootFolderId: string;
  deviceMode: SyncDeviceMode;
  pageToken: string;
  /** Last completed exhaustive discovery; used only to schedule a safety audit. */
  lastFullAuditAt: number;
}

export interface PaperSyncDeviceProfile {
  id: 'paper-device';
  deviceId: string;
  deviceLabel: string;
  deviceMode: SyncDeviceMode;
  autoSync: boolean;
  /** Persisted only for personal mode. */
  googleDeviceSessionToken?: string;
  accountId?: string;
  rootFolderId?: string;
  driveChangeCursor?: PaperDriveChangeCursor;
  lastDiscoveryAt?: number;
  lastSuccessfulAt?: number;
}

export interface TemporarySessionProvenance {
  id: 'temporary';
  temporarySessionId: string;
  accountId: string;
  rootFolderId?: string;
  createdAt: number;
  documentIds: string[];
  collectionIds: string[];
  tagIds: string[];
  finishPhase: 'active' | 'uploading' | 'revoking' | 'cleaning' | 'cleanup-incomplete';
}

export interface LayoutMigrationRecord {
  id: 'layout';
  formatVersion?: 2;
  rootFolderId: string;
  phase:
    | 'upgrade-required'
    | 'publishing-papers'
    | 'activating-layout'
    | 'cleaning-legacy'
    | 'complete';
  startedAt: number;
  targetDocumentIds: string[];
  publishedDocumentIds: string[];
  publishedGenerationIds: Record<string, string>;
  verifiedLegacyFileIds: string[];
  lastFailure?: LayoutMigrationFailure;
}

export interface PaperV3MigrationSeedCheckpoint {
  generationId: string;
  paperFolderId: string;
  state: 'present' | 'removed';
  /** Exact immutable Paper-v2 heads verified when this presence baseline was seeded. */
  packageHeadIds: string[];
}

/**
 * Durable, local-only checkpoint for the explicit Paper-v2 -> Paper-v3 cutover.
 * It intentionally reuses the existing migration object store, so this protocol
 * change does not alter the IndexedDB schema version.
 */
export interface PaperV3MigrationRecord {
  id: 'paper-v3';
  formatVersion: 1;
  rootFolderId: string;
  phase: 'preparing-control' | 'seeding-presence' | 'activating-layout';
  startedAt: number;
  controlFolderId?: string;
  targetDocumentIds: string[];
  seeds: Record<string, PaperV3MigrationSeedCheckpoint>;
}

interface SyncDatabase extends DBSchema {
  [DEVICE_STORE]: {
    key: 'device';
    value: SyncDeviceState;
  };
  [PAPER_DEVICE_STORE]: {
    key: 'paper-device';
    value: PaperSyncDeviceProfile;
  };
  [PAPER_STATE_STORE]: {
    key: string;
    value: PaperSyncState;
  };
  [CLOUD_PAPER_STORE]: {
    key: string;
    value: PaperCloudSummary;
  };
  [TEMPORARY_SESSION_STORE]: {
    key: 'temporary';
    value: TemporarySessionProvenance;
  };
  [LAYOUT_MIGRATION_STORE]: {
    key: 'layout' | 'paper-v3';
    value: LayoutMigrationRecord | PaperV3MigrationRecord;
  };
}

let databasePromise: Promise<IDBPDatabase<SyncDatabase>> | null = null;
let openedDatabaseName: string | null = null;

export class LocalSyncPersistenceError extends Error {
  readonly operation: 'read' | 'write' | 'flush';

  constructor(operation: 'read' | 'write' | 'flush', cause?: unknown) {
    super('39Note could not save changes locally.', { cause });
    this.name = 'LocalSyncPersistenceError';
    this.operation = operation;
  }
}

export async function loadSyncDeviceState(): Promise<SyncDeviceState> {
  try {
    const database = await getDatabase();
    const value = await database.get(DEVICE_STORE, 'device');
    if (value?.id === 'device' && typeof value.deviceId === 'string') {
      return normalizeState(value);
    }
    const created = createDefaultState();
    await database.put(DEVICE_STORE, created);
    return created;
  } catch (error) {
    if (error instanceof LocalSyncPersistenceError) throw error;
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function saveSyncDeviceState(state: SyncDeviceState): Promise<void> {
  try {
    const database = await getDatabase();
    await database.put(DEVICE_STORE, normalizeState(state));
  } catch (error) {
    if (error instanceof LocalSyncPersistenceError) throw error;
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function loadPaperSyncDeviceProfile(): Promise<PaperSyncDeviceProfile> {
  try {
    const database = await getDatabase();
    const existing = await database.get(PAPER_DEVICE_STORE, 'paper-device');
    if (existing) return normalizePaperDeviceProfile(existing);
    const legacy = await database.get(DEVICE_STORE, 'device');
    const created: PaperSyncDeviceProfile = {
      id: 'paper-device',
      deviceId: legacy?.deviceId ?? crypto.randomUUID(),
      deviceLabel: 'This device',
      deviceMode: isTemporaryWorkspaceActive() ? 'temporary' : 'personal',
      autoSync: isTemporaryWorkspaceActive() ? false : (legacy?.autoSync ?? true),
      ...(legacy?.googleDeviceSessionToken
        ? { googleDeviceSessionToken: legacy.googleDeviceSessionToken }
        : {}),
      ...(legacy?.driveFiles.rootFolderId
        ? { rootFolderId: legacy.driveFiles.rootFolderId }
        : {}),
      ...(legacy?.lastSuccessfulAt
        ? { lastSuccessfulAt: legacy.lastSuccessfulAt }
        : {}),
    };
    await database.put(PAPER_DEVICE_STORE, created);
    return created;
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function savePaperSyncDeviceProfile(
  profile: PaperSyncDeviceProfile,
): Promise<void> {
  try {
    const normalized = normalizePaperDeviceProfile(profile);
    normalized.deviceMode = isTemporaryWorkspaceActive() ? 'temporary' : 'personal';
    if (normalized.deviceMode === 'temporary') {
      normalized.autoSync = false;
      delete normalized.googleDeviceSessionToken;
    }
    await (await getDatabase()).put(PAPER_DEVICE_STORE, normalized);
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export function createDefaultPaperSyncState(
  documentId: string,
  deviceId: string,
  availability: PaperSyncState['availability'] = 'local-only',
): PaperSyncState {
  return {
    documentId,
    deviceId,
    availability,
    status: availability === 'cloud-only' ? 'cloud-only' : 'local-only',
    dirtyGeneration: availability === 'local-only' ? 1 : 0,
    dirtyReasons: availability === 'local-only' ? ['metadata', 'source-pdf'] : [],
    entityVersions: {},
    baselineHashes: {},
    tombstones: [],
    conflicts: [],
    incorporatedHeadIds: [],
    remoteHeadIds: [],
    pdfFingerprints: {},
    driveFiles: { fileIds: {} },
  };
}

export async function loadPaperSyncStates(): Promise<PaperSyncState[]> {
  try {
    const records = await (await getDatabase()).getAll(PAPER_STATE_STORE);
    return records.map(normalizePaperSyncState);
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function loadPaperSyncState(
  documentId: string,
): Promise<PaperSyncState | null> {
  try {
    const value = await (await getDatabase()).get(PAPER_STATE_STORE, documentId);
    return value ? normalizePaperSyncState(value) : null;
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function savePaperSyncState(state: PaperSyncState): Promise<void> {
  try {
    await (await getDatabase()).put(PAPER_STATE_STORE, normalizePaperSyncState(state));
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function savePaperSyncStates(
  states: readonly PaperSyncState[],
): Promise<void> {
  try {
    const database = await getDatabase();
    const transaction = database.transaction(PAPER_STATE_STORE, 'readwrite');
    for (const state of states)
      await transaction.store.put(normalizePaperSyncState(state));
    await transaction.done;
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function saveCloudPaperCatalog(
  papers: readonly PaperCloudSummary[],
): Promise<void> {
  try {
    const database = await getDatabase();
    const transaction = database.transaction(CLOUD_PAPER_STORE, 'readwrite');
    await transaction.store.clear();
    for (const paper of papers) await transaction.store.put(paper);
    await transaction.done;
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function loadCloudPaperCatalog(): Promise<PaperCloudSummary[]> {
  try {
    return await (await getDatabase()).getAll(CLOUD_PAPER_STORE);
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function loadTemporarySessionProvenance(): Promise<TemporarySessionProvenance | null> {
  try {
    return (
      (await (await getDatabase()).get(TEMPORARY_SESSION_STORE, 'temporary')) ?? null
    );
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export async function saveTemporarySessionProvenance(
  provenance: TemporarySessionProvenance,
): Promise<void> {
  try {
    await (await getDatabase()).put(TEMPORARY_SESSION_STORE, provenance);
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function clearTemporarySessionProvenance(): Promise<void> {
  try {
    await (await getDatabase()).delete(TEMPORARY_SESSION_STORE, 'temporary');
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function loadLayoutMigrationRecord(): Promise<LayoutMigrationRecord | null> {
  try {
    const record = await (await getDatabase()).get(LAYOUT_MIGRATION_STORE, 'layout');
    return record ? normalizeLayoutMigrationRecord(record) : null;
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export function normalizeLayoutMigrationRecord(value: unknown): LayoutMigrationRecord {
  if (!isRecord(value)) throw new Error('Invalid Drive layout migration record.');
  const phase = value.phase;
  if (
    value.id !== 'layout' ||
    (value.formatVersion !== undefined && value.formatVersion !== 2) ||
    typeof value.rootFolderId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(value.rootFolderId) ||
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    ![
      'upgrade-required',
      'publishing-papers',
      'activating-layout',
      'cleaning-legacy',
      'complete',
    ].includes(typeof phase === 'string' ? phase : '')
  ) {
    throw new Error('Invalid Drive layout migration record.');
  }
  const targetDocumentIds = normalizeMigrationIdentities(value.targetDocumentIds, true);
  const publishedDocumentIds = normalizeMigrationIdentities(
    value.publishedDocumentIds,
    false,
  );
  const verifiedLegacyFileIds = normalizeMigrationIdentities(
    value.verifiedLegacyFileIds,
    false,
  );
  const publishedGenerationIds = normalizePublishedGenerationIds(
    value.publishedGenerationIds,
  );
  const generationDocumentIds = Object.keys(publishedGenerationIds).sort();
  if (
    generationDocumentIds.some(
      (documentId) => !publishedDocumentIds.includes(documentId),
    ) ||
    (value.formatVersion === 2 &&
      JSON.stringify(generationDocumentIds) !== JSON.stringify(publishedDocumentIds))
  ) {
    throw new Error('Invalid Drive layout migration publication checkpoint.');
  }
  const lastFailure = normalizeStoredMigrationFailure(value.lastFailure);
  return {
    id: 'layout',
    ...(value.formatVersion === 2 ? { formatVersion: 2 as const } : {}),
    rootFolderId: value.rootFolderId,
    phase: phase as LayoutMigrationRecord['phase'],
    startedAt: value.startedAt,
    targetDocumentIds,
    publishedDocumentIds,
    publishedGenerationIds,
    verifiedLegacyFileIds,
    ...(lastFailure ? { lastFailure } : {}),
  };
}

export async function saveLayoutMigrationRecord(
  record: LayoutMigrationRecord,
): Promise<void> {
  try {
    await (
      await getDatabase()
    ).put(LAYOUT_MIGRATION_STORE, normalizeLayoutMigrationRecord(record));
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function clearLayoutMigrationRecord(): Promise<void> {
  try {
    await (await getDatabase()).delete(LAYOUT_MIGRATION_STORE, 'layout');
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function loadPaperV3MigrationRecord(): Promise<PaperV3MigrationRecord | null> {
  try {
    const record = await (await getDatabase()).get(LAYOUT_MIGRATION_STORE, 'paper-v3');
    return record ? normalizePaperV3MigrationRecord(record) : null;
  } catch (error) {
    throw new LocalSyncPersistenceError('read', error);
  }
}

export function normalizePaperV3MigrationRecord(
  value: unknown,
): PaperV3MigrationRecord {
  if (!isRecord(value)) throw new Error('Invalid Paper-v3 migration record.');
  const phase = value.phase;
  const rootFolderId = safeOpaqueToken(value.rootFolderId, 256);
  const controlFolderId = safeOpaqueToken(value.controlFolderId, 256);
  if (
    value.id !== 'paper-v3' ||
    value.formatVersion !== 1 ||
    !rootFolderId ||
    !validTimestamp(value.startedAt) ||
    !['preparing-control', 'seeding-presence', 'activating-layout'].includes(
      typeof phase === 'string' ? phase : '',
    ) ||
    (phase !== 'preparing-control' && !controlFolderId)
  ) {
    throw new Error('Invalid Paper-v3 migration record.');
  }
  const targetDocumentIds = normalizeMigrationIdentities(
    value.targetDocumentIds,
    phase === 'preparing-control',
  );
  if (targetDocumentIds.some((documentId) => !isValidDocumentId(documentId))) {
    throw new Error('Invalid Paper-v3 migration document identity.');
  }
  if (!isRecord(value.seeds) || Array.isArray(value.seeds)) {
    throw new Error('Invalid Paper-v3 migration seed checkpoint.');
  }
  const seeds: Record<string, PaperV3MigrationSeedCheckpoint> = {};
  for (const [documentId, rawSeed] of Object.entries(value.seeds)) {
    if (!targetDocumentIds.includes(documentId) || !isRecord(rawSeed)) {
      throw new Error('Invalid Paper-v3 migration seed checkpoint.');
    }
    const generationId = safeText(rawSeed.generationId, 64);
    const paperFolderId = safeOpaqueToken(rawSeed.paperFolderId, 256);
    const packageHeadIds = normalizeMigrationIdentities(rawSeed.packageHeadIds, false);
    if (
      !generationId ||
      !/^[a-f0-9]{64}$/u.test(generationId) ||
      !paperFolderId ||
      (rawSeed.state !== 'present' && rawSeed.state !== 'removed') ||
      packageHeadIds.length === 0 ||
      packageHeadIds.some((id) => !/^[a-f0-9]{64}$/u.test(id))
    ) {
      throw new Error('Invalid Paper-v3 migration seed checkpoint.');
    }
    seeds[documentId] = {
      generationId,
      paperFolderId,
      state: rawSeed.state,
      packageHeadIds,
    };
  }
  if (
    phase === 'activating-layout' &&
    Object.keys(seeds).length !== targetDocumentIds.length
  ) {
    throw new Error('Paper-v3 migration activation evidence is incomplete.');
  }
  return {
    id: 'paper-v3',
    formatVersion: 1,
    rootFolderId,
    phase: phase as PaperV3MigrationRecord['phase'],
    startedAt: value.startedAt,
    ...(controlFolderId ? { controlFolderId } : {}),
    targetDocumentIds,
    seeds: Object.fromEntries(
      Object.entries(seeds).sort(([first], [second]) => first.localeCompare(second)),
    ),
  };
}

export async function savePaperV3MigrationRecord(
  record: PaperV3MigrationRecord,
): Promise<void> {
  try {
    await (
      await getDatabase()
    ).put(LAYOUT_MIGRATION_STORE, normalizePaperV3MigrationRecord(record));
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function clearPaperV3MigrationRecord(): Promise<void> {
  try {
    await (await getDatabase()).delete(LAYOUT_MIGRATION_STORE, 'paper-v3');
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export async function deletePaperSyncRecords(
  documentIds: readonly string[],
): Promise<void> {
  try {
    const database = await getDatabase();
    const transaction = database.transaction(
      [PAPER_STATE_STORE, CLOUD_PAPER_STORE],
      'readwrite',
    );
    for (const documentId of new Set(documentIds)) {
      await transaction.objectStore(PAPER_STATE_STORE).delete(documentId);
      await transaction.objectStore(CLOUD_PAPER_STORE).delete(documentId);
    }
    await transaction.done;
  } catch (error) {
    throw new LocalSyncPersistenceError('write', error);
  }
}

export function createDefaultState(
  deviceId: string = crypto.randomUUID(),
): SyncDeviceState {
  return {
    id: 'device',
    deviceId,
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

function normalizeState(value: SyncDeviceState): SyncDeviceState {
  const fallback = createDefaultState(value.deviceId);
  return {
    ...fallback,
    ...value,
    id: 'device',
    deviceId: value.deviceId,
    googleDeviceSessionToken:
      typeof value.googleDeviceSessionToken === 'string' &&
      /^[a-zA-Z0-9_-]{43}$/u.test(value.googleDeviceSessionToken)
        ? value.googleDeviceSessionToken
        : undefined,
    autoSyncBeforeReset:
      typeof value.autoSyncBeforeReset === 'boolean'
        ? value.autoSyncBeforeReset
        : undefined,
    resetIncomplete: value.resetIncomplete === true,
    entityVersions: value.entityVersions ?? {},
    baselineHashes: value.baselineHashes ?? {},
    tombstones: Array.isArray(value.tombstones) ? value.tombstones : [],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
    pdfFingerprints: value.pdfFingerprints ?? {},
    driveFiles: {
      ...(value.driveFiles ?? {}),
      fileIds: value.driveFiles?.fileIds ?? {},
    },
  };
}

function normalizePaperDeviceProfile(
  value: PaperSyncDeviceProfile,
): PaperSyncDeviceProfile {
  const temporaryWorkspace = isTemporaryWorkspaceActive();
  const deviceMode: SyncDeviceMode = temporaryWorkspace ? 'temporary' : 'personal';
  const accountId = safeText(value.accountId, 256);
  const rootFolderId = safeText(value.rootFolderId, 256);
  const cursor = normalizeDriveChangeCursor(value.driveChangeCursor);
  return {
    id: 'paper-device',
    deviceId: safeText(value.deviceId, 256) ?? crypto.randomUUID(),
    deviceLabel: safeText(value.deviceLabel, 80) ?? 'This device',
    deviceMode,
    autoSync: temporaryWorkspace ? false : value.autoSync !== false,
    ...(isSessionToken(value.googleDeviceSessionToken) && !temporaryWorkspace
      ? { googleDeviceSessionToken: value.googleDeviceSessionToken }
      : {}),
    ...(accountId ? { accountId } : {}),
    ...(rootFolderId ? { rootFolderId } : {}),
    ...(cursor &&
    cursor.deviceMode === deviceMode &&
    cursor.accountId === accountId &&
    cursor.rootFolderId === rootFolderId
      ? { driveChangeCursor: cursor }
      : {}),
    ...(validTimestamp(value.lastDiscoveryAt)
      ? { lastDiscoveryAt: value.lastDiscoveryAt }
      : {}),
    ...(validTimestamp(value.lastSuccessfulAt)
      ? { lastSuccessfulAt: value.lastSuccessfulAt }
      : {}),
  };
}

function normalizeDriveChangeCursor(
  value: unknown,
): PaperDriveChangeCursor | undefined {
  if (!isRecord(value)) return undefined;
  const accountId = safeText(value.accountId, 256);
  const rootFolderId = safeText(value.rootFolderId, 256);
  const pageToken = safeOpaqueToken(value.pageToken, 4096);
  if (
    value.version !== 1 ||
    !accountId ||
    !rootFolderId ||
    (value.deviceMode !== 'personal' && value.deviceMode !== 'temporary') ||
    !pageToken ||
    !validTimestamp(value.lastFullAuditAt)
  ) {
    return undefined;
  }
  return {
    version: 1,
    accountId,
    rootFolderId,
    deviceMode: value.deviceMode,
    pageToken,
    lastFullAuditAt: value.lastFullAuditAt,
  };
}

const DIRTY_REASONS = new Set<PaperDirtyReason>([
  'metadata',
  'source-pdf',
  'source-document',
  'notes',
  'annotations',
  'glossary',
  'reading-state',
  'print-draft',
  'rendered-print-pdf',
  'ai-conversation',
  'deleted',
]);

export function normalizePaperSyncState(value: PaperSyncState): PaperSyncState {
  const fallback = createDefaultPaperSyncState(
    value.documentId,
    value.deviceId || crypto.randomUUID(),
    value.availability,
  );
  const dirtyReasons = Array.isArray(value.dirtyReasons)
    ? [...new Set(value.dirtyReasons.filter((reason) => DIRTY_REASONS.has(reason)))]
    : fallback.dirtyReasons;
  const driveFiles = {
    ...(value.driveFiles ?? {}),
    fileIds: value.driveFiles?.fileIds ?? {},
  };
  const sourcePdfEvidence = normalizePaperDriveFileEvidence(
    value.driveFiles?.sourcePdfEvidence,
  );
  const sourceArtifactEvidence = normalizePaperDriveFileEvidence(
    value.driveFiles?.sourceArtifactEvidence,
  );
  const cloudPresence =
    value.cloudPresence === 'present' || value.cloudPresence === 'removed'
      ? value.cloudPresence
      : undefined;
  const presenceHeadIds = Array.isArray(value.presenceHeadIds)
    ? [
        ...new Set(value.presenceHeadIds.filter((id) => /^[a-f0-9]{64}$/u.test(id))),
      ].sort()
    : [];
  const dismissedRemoteHeadIds = Array.isArray(value.dismissedRemoteHeadIds)
    ? [
        ...new Set(
          value.dismissedRemoteHeadIds.filter(
            (id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id),
          ),
        ),
      ].sort()
    : [];
  if (sourcePdfEvidence) driveFiles.sourcePdfEvidence = sourcePdfEvidence;
  else delete driveFiles.sourcePdfEvidence;
  if (sourceArtifactEvidence) {
    driveFiles.sourceArtifactEvidence = sourceArtifactEvidence;
  } else {
    delete driveFiles.sourceArtifactEvidence;
  }
  const normalized: PaperSyncState = {
    ...fallback,
    ...value,
    documentId: value.documentId,
    deviceId: value.deviceId || fallback.deviceId,
    dirtyGeneration: Number.isInteger(value.dirtyGeneration)
      ? Math.max(0, value.dirtyGeneration)
      : fallback.dirtyGeneration,
    dirtyReasons,
    entityVersions: value.entityVersions ?? {},
    baselineHashes: value.baselineHashes ?? {},
    tombstones: Array.isArray(value.tombstones) ? value.tombstones : [],
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
    incorporatedHeadIds: Array.isArray(value.incorporatedHeadIds)
      ? [...new Set(value.incorporatedHeadIds)]
      : [],
    remoteHeadIds: Array.isArray(value.remoteHeadIds)
      ? [...new Set(value.remoteHeadIds)]
      : [],
    pdfFingerprints: value.pdfFingerprints ?? {},
    sourceFingerprints: value.sourceFingerprints ?? {},
    driveFiles,
    ...(cloudPresence ? { cloudPresence } : {}),
    ...(presenceHeadIds.length ? { presenceHeadIds } : {}),
    ...(cloudPresence === 'removed' && value.cloudCleanupPending === true
      ? { cloudCleanupPending: true }
      : {}),
  };
  if (dismissedRemoteHeadIds.length) {
    normalized.dismissedRemoteHeadIds = dismissedRemoteHeadIds;
  } else {
    delete normalized.dismissedRemoteHeadIds;
  }
  return normalized;
}

function normalizePaperDriveFileEvidence(
  value: unknown,
): PaperDriveFileEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const fileId = safeOpaqueToken(value.fileId, 256);
  const version = safeOpaqueToken(value.version, 256);
  const md5Checksum = safeText(value.md5Checksum, 64);
  const size = safeText(value.size, 32);
  if (
    !fileId ||
    !version ||
    !md5Checksum ||
    !/^[a-f\d]{32}$/iu.test(md5Checksum) ||
    !size ||
    !/^\d+$/u.test(size)
  ) {
    return undefined;
  }
  return { fileId, version, md5Checksum: md5Checksum.toLowerCase(), size };
}

function normalizeMigrationIdentities(value: unknown, allowMissing: boolean): string[] {
  if (value === undefined && allowMissing) return [];
  if (
    !Array.isArray(value) ||
    value.some(
      (identity) =>
        typeof identity !== 'string' ||
        identity.length === 0 ||
        identity.length > 512 ||
        hasControlCharacters(identity),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Invalid Drive layout migration identities.');
  }
  return [...value].sort();
}

function normalizePublishedGenerationIds(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error('Invalid Drive layout migration generation checkpoint.');
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([documentId, generationId]) =>
        documentId.length === 0 ||
        documentId.length > 512 ||
        hasControlCharacters(documentId) ||
        typeof generationId !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(generationId),
    )
  ) {
    throw new Error('Invalid Drive layout migration generation checkpoint.');
  }
  return Object.fromEntries(
    entries
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([documentId, generationId]) => [documentId, generationId as string]),
  );
}

function normalizeStoredMigrationFailure(
  value: unknown,
): LayoutMigrationFailure | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.code !== 'layout-upgrade-failed' ||
    value.message !== 'Drive layout upgrade failed.' ||
    typeof value.phase !== 'string' ||
    ![
      'initialize',
      'ensure-repository',
      'detect-layout',
      'reconcile-local-state',
      'list-local-papers',
      'load-migration-record',
      'begin-operation',
      'save-migration-record',
      'create-paper-package',
      'publish-paper',
      'save-paper-state',
      'verify-publications',
      'activate-layout',
      'clear-migration-record',
      'post-migration-scan',
    ].includes(value.phase) ||
    typeof value.causeCode !== 'string' ||
    !/^[a-z0-9-]{1,80}$/u.test(value.causeCode) ||
    !['retry-layout-upgrade', 'retry-now', 'reconnect', 'details'].includes(
      typeof value.recommendedAction === 'string' ? value.recommendedAction : '',
    ) ||
    typeof value.retrySafe !== 'boolean' ||
    value.blocksOrdinarySync !== true
  ) {
    throw new Error('Invalid Drive layout migration failure.');
  }
  const documentId = safeText(value.documentId, 512);
  const paperName = safeText(value.paperName, 180);
  return {
    code: 'layout-upgrade-failed',
    message: 'Drive layout upgrade failed.',
    phase: value.phase as LayoutMigrationFailure['phase'],
    causeCode: value.causeCode,
    recommendedAction:
      value.recommendedAction as LayoutMigrationFailure['recommendedAction'],
    retrySafe: value.retrySafe,
    blocksOrdinarySync: true,
    ...(documentId ? { documentId } : {}),
    ...(paperName ? { paperName } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}

function safeText(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maximum
    ? value
    : undefined;
}

function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function safeOpaqueToken(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
    ? value
    : undefined;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function getDatabase(): Promise<IDBPDatabase<SyncDatabase>> {
  const databaseName = scopedDatabaseName(SYNC_DATABASE_NAME);
  if (databasePromise && openedDatabaseName !== databaseName) {
    const previous = databasePromise;
    databasePromise = null;
    openedDatabaseName = null;
    void previous.then((database) => database.close());
  }
  if (!databasePromise) {
    openedDatabaseName = databaseName;
    const opening = openDB<SyncDatabase>(databaseName, SYNC_DATABASE_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(DEVICE_STORE)) {
          database.createObjectStore(DEVICE_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(PAPER_DEVICE_STORE)) {
          database.createObjectStore(PAPER_DEVICE_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(PAPER_STATE_STORE)) {
          database.createObjectStore(PAPER_STATE_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(CLOUD_PAPER_STORE)) {
          database.createObjectStore(CLOUD_PAPER_STORE, { keyPath: 'documentId' });
        }
        if (!database.objectStoreNames.contains(TEMPORARY_SESSION_STORE)) {
          database.createObjectStore(TEMPORARY_SESSION_STORE, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(LAYOUT_MIGRATION_STORE)) {
          database.createObjectStore(LAYOUT_MIGRATION_STORE, { keyPath: 'id' });
        }
      },
    });
    databasePromise = opening.catch((error) => {
      databasePromise = null;
      openedDatabaseName = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function closeSyncPersistenceWorkspace(): Promise<void> {
  const database = databasePromise ? await databasePromise : null;
  database?.close();
  databasePromise = null;
  openedDatabaseName = null;
}
