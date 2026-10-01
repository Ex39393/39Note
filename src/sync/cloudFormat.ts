import { isSha256, sha256Hex, stableStringify } from './hash.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type SyncConflict,
  type SyncEntityRecord,
  type SyncIntegrityLogicalType,
  type SyncPdfDescriptor,
  type SyncSnapshot,
  type SyncTombstone,
} from './types.ts';

export interface CloudPayloadReference {
  fileId: string;
  sha256: string;
}

export interface CloudDocumentManifest {
  documentId: string;
  folderId: string;
  state: CloudPayloadReference;
  productivity?: CloudPayloadReference;
  pdf?: SyncPdfDescriptor & { fileId: string };
}

export const IMMUTABLE_MANIFEST_STORAGE = 'immutable-manifest-v1' as const;

export interface CloudManifestGeneration {
  /** SHA-256 of the canonical manifest with this `id` field omitted. */
  id: string;
  createdAt: number;
  createdBy: string;
  /** Immutable generation IDs incorporated by this publication. */
  parents: string[];
  /** Exact SHA-256 identities of legacy mutable manifests incorporated here. */
  legacySources: string[];
}

export interface CloudManifestRecoveryEvidence {
  sourceManifestId: string;
  logicalType: SyncIntegrityLogicalType;
  documentId?: string;
  expected: CloudPayloadReference;
  observed?: CloudPayloadReference;
  merged: CloudPayloadReference;
}

export interface CloudSyncManifest {
  app: '39Note';
  syncSchemaVersion: typeof SYNC_SCHEMA_VERSION;
  generatedAt: number;
  generatedBy: string;
  /** Absent on the pre-integrity schema-1 format whose referenced JSON files were mutable. */
  payloadStorage?: 'immutable-v1';
  /** Separate coordination capability; semantic sync schema remains version 1. */
  manifestStorage?: typeof IMMUTABLE_MANIFEST_STORAGE;
  generation?: CloudManifestGeneration;
  /** Persisted evidence for concurrent free-text edits; required by new generations. */
  conflicts?: SyncConflict[];
  /** Immutable candidate evidence retained by explicit integrity recovery. */
  recoveryEvidence?: CloudManifestRecoveryEvidence[];
  library: CloudPayloadReference;
  aiSettings: CloudPayloadReference;
  documents: CloudDocumentManifest[];
}

export type ImmutableCloudSyncManifest = CloudSyncManifest & {
  payloadStorage: 'immutable-v1';
  manifestStorage: typeof IMMUTABLE_MANIFEST_STORAGE;
  generation: CloudManifestGeneration;
  conflicts: SyncConflict[];
};

export interface CloudPayloadContext {
  logicalType: SyncIntegrityLogicalType;
  logicalPath: string;
  documentId?: string;
  /** Selects cloud-semantic validation; never a local database/workspace namespace. */
  partitionModel?: 'global-v1' | 'paper-v2';
  sourceProtocolVersion?: number;
  /** True only when obsolete serialized metadata was actually normalized. */
  compatibilityNormalizationAttempted?: boolean;
}

export class CloudPayloadPartitionError extends Error {
  readonly expectedSemanticPartition: string;
  readonly actualSemanticPartitions: string[];
  readonly sourceProtocolVersion?: number;
  readonly compatibilityNormalizationAttempted: boolean;

  constructor(payload: CloudEntityPayload, context: CloudPayloadContext) {
    super('A Google Drive sync payload is in the wrong logical partition.');
    this.name = 'CloudPayloadPartitionError';
    this.expectedSemanticPartition = semanticPartitionForContext(context);
    this.actualSemanticPartitions = actualSemanticPartitions(payload, context);
    this.sourceProtocolVersion = context.sourceProtocolVersion;
    this.compatibilityNormalizationAttempted =
      context.compatibilityNormalizationAttempted === true;
  }
}

export class CloudPayloadIntegrityError extends Error {
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly decodedHash?: string;
  readonly byteLength: number;
  readonly decodedByteLength?: number;
  readonly actualPayloadValid: boolean;
  readonly actualPayload?: CloudEntityPayload;

  constructor(options: {
    expectedHash: string;
    actualHash: string;
    decodedHash?: string;
    byteLength: number;
    decodedByteLength?: number;
    actualPayload?: CloudEntityPayload;
  }) {
    super('A Google Drive sync payload failed its integrity check.');
    this.name = 'CloudPayloadIntegrityError';
    this.expectedHash = options.expectedHash;
    this.actualHash = options.actualHash;
    this.decodedHash = options.decodedHash;
    this.byteLength = options.byteLength;
    this.decodedByteLength = options.decodedByteLength;
    this.actualPayload = options.actualPayload;
    this.actualPayloadValid = Boolean(options.actualPayload);
  }
}

export interface CloudEntityPayload {
  app: '39Note';
  syncSchemaVersion: typeof SYNC_SCHEMA_VERSION;
  entities: SyncEntityRecord[];
  tombstones: SyncTombstone[];
}

export interface PartitionedSnapshot {
  library: CloudEntityPayload;
  aiSettings: CloudEntityPayload;
  documents: Map<
    string,
    { state: CloudEntityPayload; productivity: CloudEntityPayload }
  >;
}

const LIBRARY_KINDS = new Set(['collection', 'tag']);
const AI_KINDS = new Set(['prompt-profile', 'ai-configuration', 'default-prompt']);
const PRODUCTIVITY_KINDS = new Set(['print-draft', 'ai-conversation']);

export function partitionSnapshot(snapshot: SyncSnapshot): PartitionedSnapshot {
  const documents = new Map<
    string,
    { state: CloudEntityPayload; productivity: CloudEntityPayload }
  >();
  for (const entity of snapshot.entities) {
    if (LIBRARY_KINDS.has(entity.kind)) continue;
    if (AI_KINDS.has(entity.kind)) continue;
    const documentId = entity.kind === 'document' ? entity.id : entity.documentId;
    if (!documentId) continue;
    const partition = getDocumentPartition(documents, documentId);
    (PRODUCTIVITY_KINDS.has(entity.kind)
      ? partition.productivity
      : partition.state
    ).entities.push(entity);
  }
  for (const tombstone of snapshot.tombstones) {
    if (LIBRARY_KINDS.has(tombstone.kind) || AI_KINDS.has(tombstone.kind)) continue;
    const documentId =
      tombstone.kind === 'document' ? tombstone.id : tombstone.documentId;
    if (!documentId) continue;
    const partition = getDocumentPartition(documents, documentId);
    (PRODUCTIVITY_KINDS.has(tombstone.kind)
      ? partition.productivity
      : partition.state
    ).tombstones.push(tombstone);
  }
  return {
    library: payload(
      snapshot.entities.filter((entity) => LIBRARY_KINDS.has(entity.kind)),
      snapshot.tombstones.filter((item) => LIBRARY_KINDS.has(item.kind)),
    ),
    aiSettings: payload(
      snapshot.entities.filter((entity) => AI_KINDS.has(entity.kind)),
      snapshot.tombstones.filter((item) => AI_KINDS.has(item.kind)),
    ),
    documents,
  };
}

export function combineCloudPayloads(
  manifest: CloudSyncManifest,
  library: CloudEntityPayload,
  aiSettings: CloudEntityPayload,
  documents: readonly CloudEntityPayload[],
): SyncSnapshot {
  const entities = [library, aiSettings, ...documents].flatMap((item) => item.entities);
  const tombstones = [library, aiSettings, ...documents].flatMap(
    (item) => item.tombstones,
  );
  if (
    new Set(entities.map((entity) => entity.key)).size !== entities.length ||
    new Set(tombstones.map((item) => item.key)).size !== tombstones.length
  ) {
    throw new Error('Google Drive sync payloads contain duplicate entity identifiers.');
  }
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: manifest.generatedAt,
    generatedBy: manifest.generatedBy,
    entities,
    tombstones,
    pdfs: manifest.documents.flatMap((document) =>
      document.pdf ? [document.pdf] : [],
    ),
  };
}

export async function encodeCloudPayload(payloadValue: CloudEntityPayload): Promise<{
  text: string;
  sha256: string;
}> {
  assertNoSecretsInSyncPayload(payloadValue);
  const text = stableStringify(payloadValue);
  return { text, sha256: await sha256Hex(text) };
}

export async function parseCloudPayload(
  text: string,
  expectedHash: string,
): Promise<CloudEntityPayload> {
  const actualHash = await sha256Hex(text);
  if (!isSha256(expectedHash) || actualHash !== expectedHash) {
    throw new CloudPayloadIntegrityError({
      expectedHash,
      actualHash,
      byteLength: new TextEncoder().encode(text).byteLength,
      actualPayload: tryParseSupportedPayload(text),
    });
  }
  return parseSupportedPayload(text);
}

export async function parseCloudPayloadBlob(
  blob: Blob,
  expectedHash: string,
  context: CloudPayloadContext,
): Promise<CloudEntityPayload> {
  const bytes = await blob.arrayBuffer();
  const actualHash = await sha256Hex(bytes);
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 is reported as an integrity failure without retaining its bytes.
  }
  if (!isSha256(expectedHash) || actualHash !== expectedHash) {
    const decodedHash = text ? await sha256Hex(text) : undefined;
    throw new CloudPayloadIntegrityError({
      expectedHash,
      actualHash,
      decodedHash,
      byteLength: bytes.byteLength,
      decodedByteLength: text ? new TextEncoder().encode(text).byteLength : undefined,
      actualPayload: text ? tryParseSupportedPayload(text, context) : undefined,
    });
  }
  if (!text) throw new Error('A Google Drive sync payload contains invalid UTF-8.');
  return parseSupportedPayload(text, context);
}

export function payloadForContext(
  snapshot: SyncSnapshot,
  context: CloudPayloadContext,
): CloudEntityPayload | undefined {
  const partitions = partitionSnapshot(snapshot);
  if (context.logicalType === 'library-metadata') return partitions.library;
  if (context.logicalType === 'ai-settings') return partitions.aiSettings;
  if (!context.documentId) return undefined;
  const document = partitions.documents.get(context.documentId);
  if (!document) return undefined;
  return context.logicalType === 'document-state'
    ? document.state
    : document.productivity;
}

export function replacePayloadForContext(
  snapshot: SyncSnapshot,
  context: CloudPayloadContext,
  replacement: CloudEntityPayload,
): SyncSnapshot | undefined {
  const partitions = partitionSnapshot(snapshot);
  if (context.logicalType === 'library-metadata') {
    partitions.library = replacement;
  } else if (context.logicalType === 'ai-settings') {
    partitions.aiSettings = replacement;
  } else {
    if (!context.documentId) return undefined;
    const document = partitions.documents.get(context.documentId);
    if (!document) return undefined;
    if (context.logicalType === 'document-state') document.state = replacement;
    else document.productivity = replacement;
  }
  const payloads = [
    partitions.library,
    partitions.aiSettings,
    ...[...partitions.documents.values()].flatMap((document) => [
      document.state,
      document.productivity,
    ]),
  ];
  return {
    ...snapshot,
    entities: payloads.flatMap((payloadValue) => payloadValue.entities),
    tombstones: payloads.flatMap((payloadValue) => payloadValue.tombstones),
  };
}

function parseSupportedPayload(
  text: string,
  context?: CloudPayloadContext,
): CloudEntityPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('A Google Drive sync payload contains malformed JSON.');
  }
  if (
    !isRecord(value) ||
    value.app !== '39Note' ||
    value.syncSchemaVersion !== SYNC_SCHEMA_VERSION ||
    !Array.isArray(value.entities) ||
    !Array.isArray(value.tombstones) ||
    value.entities.some((entity) => !isSyncEntity(entity)) ||
    value.tombstones.some((tombstone) => !isSyncTombstone(tombstone)) ||
    new Set(value.entities.map((entity) => (entity as SyncEntityRecord).key)).size !==
      value.entities.length ||
    new Set(value.tombstones.map((item) => (item as SyncTombstone).key)).size !==
      value.tombstones.length
  ) {
    throw new Error('A Google Drive sync payload is not supported.');
  }
  const payloadValue = value as unknown as CloudEntityPayload;
  if (context && !isPayloadCompatibleWithContext(payloadValue, context)) {
    throw new CloudPayloadPartitionError(payloadValue, context);
  }
  assertNoSecretsInSyncPayload(payloadValue);
  return payloadValue;
}

function tryParseSupportedPayload(
  text: string,
  context?: CloudPayloadContext,
): CloudEntityPayload | undefined {
  try {
    return parseSupportedPayload(text, context);
  } catch {
    return undefined;
  }
}

export function parseCloudManifest(text: string): CloudSyncManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The Google Drive sync manifest contains malformed JSON.');
  }
  if (
    !isRecord(value) ||
    value.app !== '39Note' ||
    typeof value.syncSchemaVersion !== 'number'
  ) {
    throw new Error('The Google Drive sync manifest is invalid.');
  }
  if (value.syncSchemaVersion > SYNC_SCHEMA_VERSION) {
    throw new Error('This Google Drive data was created by a newer version of 39Note.');
  }
  if (
    value.syncSchemaVersion !== SYNC_SCHEMA_VERSION ||
    (value.payloadStorage !== undefined && value.payloadStorage !== 'immutable-v1') ||
    (value.manifestStorage !== undefined &&
      value.manifestStorage !== IMMUTABLE_MANIFEST_STORAGE) ||
    (value.manifestStorage === IMMUTABLE_MANIFEST_STORAGE) !==
      (value.generation !== undefined) ||
    (value.manifestStorage === IMMUTABLE_MANIFEST_STORAGE &&
      (value.payloadStorage !== 'immutable-v1' ||
        !isManifestGeneration(value.generation) ||
        !Array.isArray(value.conflicts) ||
        value.conflicts.some((conflict) => !isSyncConflict(conflict)))) ||
    (value.conflicts !== undefined &&
      (!Array.isArray(value.conflicts) ||
        value.conflicts.some((conflict) => !isSyncConflict(conflict)))) ||
    (value.recoveryEvidence !== undefined &&
      (!Array.isArray(value.recoveryEvidence) ||
        value.recoveryEvidence.length > 512 ||
        value.recoveryEvidence.some((item) => !isRecoveryEvidence(item)))) ||
    (value.manifestStorage === undefined && value.generation !== undefined) ||
    !isTimestamp(value.generatedAt) ||
    typeof value.generatedBy !== 'string' ||
    value.generatedBy.length === 0 ||
    value.generatedBy.length > 256 ||
    !isPayloadReference(value.library) ||
    !isPayloadReference(value.aiSettings) ||
    !Array.isArray(value.documents) ||
    value.documents.some((item) => !isDocumentManifest(item)) ||
    new Set(
      value.documents.map((item) =>
        isRecord(item) && typeof item.documentId === 'string' ? item.documentId : '',
      ),
    ).size !== value.documents.length
  ) {
    throw new Error('The Google Drive sync manifest failed validation.');
  }
  const manifest = value as unknown as CloudSyncManifest;
  assertNoSecretsInSyncPayload(manifest);
  return manifest;
}

export function isImmutableCloudManifest(
  manifest: CloudSyncManifest,
): manifest is ImmutableCloudSyncManifest {
  return (
    manifest.payloadStorage === 'immutable-v1' &&
    manifest.manifestStorage === IMMUTABLE_MANIFEST_STORAGE &&
    Boolean(manifest.generation) &&
    Array.isArray(manifest.conflicts)
  );
}

export async function createCloudManifestGeneration(
  manifest: CloudSyncManifest,
  options: {
    createdAt: number;
    createdBy: string;
    parents: readonly string[];
    legacySources: readonly string[];
  },
): Promise<ImmutableCloudSyncManifest> {
  const parents = sortedUniqueHashes(options.parents);
  const legacySources = sortedUniqueHashes(options.legacySources);
  const conflicts = [...(manifest.conflicts ?? [])].sort((first, second) =>
    compareText(stableStringify(first), stableStringify(second)),
  );
  const documents = [...manifest.documents].sort((first, second) =>
    compareText(first.documentId, second.documentId),
  );
  const recoveryEvidence = manifest.recoveryEvidence
    ? [
        ...new Map(
          manifest.recoveryEvidence.map((item) => [stableStringify(item), item]),
        ).values(),
      ].sort((first, second) =>
        compareText(stableStringify(first), stableStringify(second)),
      )
    : undefined;
  const withoutIdentity: Omit<ImmutableCloudSyncManifest, 'generation'> & {
    generation: Omit<CloudManifestGeneration, 'id'>;
  } = {
    ...manifest,
    payloadStorage: 'immutable-v1',
    manifestStorage: IMMUTABLE_MANIFEST_STORAGE,
    conflicts,
    documents,
    ...(recoveryEvidence ? { recoveryEvidence } : {}),
    generation: {
      createdAt: options.createdAt,
      createdBy: options.createdBy,
      parents,
      legacySources,
    },
  };
  const id = await sha256Hex(stableStringify(withoutIdentity));
  return {
    ...withoutIdentity,
    generation: { id, ...withoutIdentity.generation },
  };
}

export async function verifyCloudManifestGeneration(
  manifest: CloudSyncManifest,
): Promise<boolean> {
  if (!isImmutableCloudManifest(manifest)) return false;
  const { id, ...generationWithoutIdentity } = manifest.generation;
  const identityInput = { ...manifest, generation: generationWithoutIdentity };
  return (await sha256Hex(stableStringify(identityInput))) === id;
}

function isPayloadCompatibleWithContext(
  value: CloudEntityPayload,
  context: CloudPayloadContext,
): boolean {
  const records = [...value.entities, ...value.tombstones];
  if (context.partitionModel === 'paper-v2') {
    if (
      !context.documentId ||
      (context.logicalType !== 'document-state' &&
        context.logicalType !== 'productivity-data')
    ) {
      return false;
    }
    const productivity = context.logicalType === 'productivity-data';
    return records.every((record) => {
      const expectedKind = productivity
        ? PRODUCTIVITY_KINDS.has(record.kind)
        : !PRODUCTIVITY_KINDS.has(record.kind) && !AI_KINDS.has(record.kind);
      const recordDocumentId =
        record.kind === 'document' ? record.id : record.documentId;
      return expectedKind && recordDocumentId === context.documentId;
    });
  }
  if (context.logicalType === 'library-metadata') {
    return records.every((record) => LIBRARY_KINDS.has(record.kind));
  }
  if (context.logicalType === 'ai-settings') {
    return records.every((record) => AI_KINDS.has(record.kind));
  }
  if (!context.documentId) return false;
  if (context.logicalType === 'productivity-data') {
    return records.every(
      (record) =>
        PRODUCTIVITY_KINDS.has(record.kind) && record.documentId === context.documentId,
    );
  }
  return records.every((record) => {
    if (
      LIBRARY_KINDS.has(record.kind) ||
      AI_KINDS.has(record.kind) ||
      PRODUCTIVITY_KINDS.has(record.kind)
    ) {
      return false;
    }
    return record.kind === 'document'
      ? record.id === context.documentId
      : record.documentId === context.documentId;
  });
}

function semanticPartitionForContext(context: CloudPayloadContext): string {
  if (context.partitionModel === 'paper-v2') {
    return context.logicalType === 'productivity-data'
      ? 'paper-productivity'
      : 'paper-state';
  }
  return context.logicalType;
}

function actualSemanticPartitions(
  value: CloudEntityPayload,
  context: CloudPayloadContext,
): string[] {
  const categories = new Set<string>();
  for (const record of [...value.entities, ...value.tombstones]) {
    const recordDocumentId = record.kind === 'document' ? record.id : record.documentId;
    if (context.documentId && recordDocumentId !== context.documentId) {
      categories.add('different-paper');
      continue;
    }
    if (AI_KINDS.has(record.kind)) categories.add('ai-settings');
    else if (PRODUCTIVITY_KINDS.has(record.kind)) categories.add('paper-productivity');
    else if (LIBRARY_KINDS.has(record.kind)) {
      categories.add(
        context.partitionModel === 'paper-v2' ? 'paper-metadata' : 'library',
      );
    } else
      categories.add(
        context.partitionModel === 'paper-v2' ? 'paper-state' : 'document-state',
      );
  }
  return [...categories].sort();
}

function payload(
  entities: SyncEntityRecord[] = [],
  tombstones: SyncTombstone[] = [],
): CloudEntityPayload {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    entities,
    tombstones,
  };
}

function getDocumentPartition(
  documents: Map<
    string,
    { state: CloudEntityPayload; productivity: CloudEntityPayload }
  >,
  documentId: string,
): { state: CloudEntityPayload; productivity: CloudEntityPayload } {
  const existing = documents.get(documentId);
  if (existing) return existing;
  const created = { state: payload(), productivity: payload() };
  documents.set(documentId, created);
  return created;
}

function isPayloadReference(value: unknown): value is CloudPayloadReference {
  return (
    isRecord(value) &&
    typeof value.fileId === 'string' &&
    value.fileId.length > 0 &&
    value.fileId.length <= 256 &&
    isSha256(value.sha256)
  );
}

function isRecoveryEvidence(value: unknown): value is CloudManifestRecoveryEvidence {
  return Boolean(
    isRecord(value) &&
    isSha256(value.sourceManifestId) &&
    ['library-metadata', 'ai-settings', 'document-state', 'productivity-data'].includes(
      String(value.logicalType),
    ) &&
    (value.documentId === undefined ||
      (typeof value.documentId === 'string' &&
        value.documentId.length > 0 &&
        value.documentId.length <= 256)) &&
    isPayloadReference(value.expected) &&
    (value.observed === undefined || isPayloadReference(value.observed)) &&
    isPayloadReference(value.merged),
  );
}

function isDocumentManifest(value: unknown): value is CloudDocumentManifest {
  return Boolean(
    isRecord(value) &&
    typeof value.documentId === 'string' &&
    value.documentId.length > 0 &&
    value.documentId.length <= 256 &&
    typeof value.folderId === 'string' &&
    value.folderId.length > 0 &&
    value.folderId.length <= 256 &&
    isPayloadReference(value.state) &&
    (value.productivity === undefined || isPayloadReference(value.productivity)) &&
    (value.pdf === undefined ||
      (isRecord(value.pdf) &&
        value.pdf.documentId === value.documentId &&
        typeof value.pdf.fileId === 'string' &&
        value.pdf.fileId.length > 0 &&
        value.pdf.fileId.length <= 256 &&
        isSha256(value.pdf.sha256) &&
        typeof value.pdf.fileName === 'string' &&
        typeof value.pdf.mimeType === 'string' &&
        isNonNegativeInteger(value.pdf.size) &&
        isTimestamp(value.pdf.lastModified) &&
        isTimestamp(value.pdf.storedAt))),
  );
}

const ENTITY_KINDS = new Set([
  'document',
  'annotation',
  'note-anchor',
  'note',
  'glossary',
  'collection',
  'tag',
  'reading-position',
  'print-draft',
  'ai-conversation',
  'prompt-profile',
  'ai-configuration',
  'default-prompt',
]);

function isSyncEntity(value: unknown): value is SyncEntityRecord {
  if (
    !isRecord(value) ||
    !ENTITY_KINDS.has(String(value.kind)) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    (value.documentId !== undefined &&
      (typeof value.documentId !== 'string' ||
        value.documentId.length === 0 ||
        value.documentId.length > 256)) ||
    !isRecord(value.version) ||
    !isTimestamp(value.version.updatedAt) ||
    typeof value.version.deviceId !== 'string' ||
    value.version.deviceId.length === 0 ||
    value.version.deviceId.length > 256 ||
    !isSha256(value.version.hash)
  ) {
    return false;
  }
  return (
    value.key ===
    createSyncEntityKey(
      value.kind as SyncEntityRecord['kind'],
      value.id,
      typeof value.documentId === 'string' ? value.documentId : undefined,
    )
  );
}

function isSyncTombstone(value: unknown): value is SyncTombstone {
  if (
    !isRecord(value) ||
    !ENTITY_KINDS.has(String(value.kind)) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    (value.documentId !== undefined &&
      (typeof value.documentId !== 'string' ||
        value.documentId.length === 0 ||
        value.documentId.length > 256)) ||
    !isTimestamp(value.deletedAt) ||
    typeof value.deviceId !== 'string' ||
    value.deviceId.length === 0 ||
    value.deviceId.length > 256
  ) {
    return false;
  }
  return (
    value.key ===
    createSyncEntityKey(
      value.kind as SyncTombstone['kind'],
      value.id,
      typeof value.documentId === 'string' ? value.documentId : undefined,
    )
  );
}

function isSyncConflict(value: unknown): value is SyncConflict {
  return Boolean(
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 1024 &&
    typeof value.entityKey === 'string' &&
    value.entityKey.length > 0 &&
    value.entityKey.length <= 1024 &&
    ENTITY_KINDS.has(String(value.entityKind)) &&
    (value.documentId === undefined ||
      (typeof value.documentId === 'string' &&
        value.documentId.length > 0 &&
        value.documentId.length <= 256)) &&
    isTimestamp(value.detectedAt) &&
    isSyncEntityVersion(value.winningVersion) &&
    isSyncEntityVersion(value.alternateVersion) &&
    (value.dismissedAt === undefined || isTimestamp(value.dismissedAt)),
  );
}

function isSyncEntityVersion(value: unknown): boolean {
  return Boolean(
    isRecord(value) &&
    isTimestamp(value.updatedAt) &&
    typeof value.deviceId === 'string' &&
    value.deviceId.length > 0 &&
    value.deviceId.length <= 256 &&
    isSha256(value.hash),
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isManifestGeneration(value: unknown): value is CloudManifestGeneration {
  if (
    !isRecord(value) ||
    !isSha256(value.id) ||
    !isTimestamp(value.createdAt) ||
    typeof value.createdBy !== 'string' ||
    value.createdBy.length === 0 ||
    value.createdBy.length > 256 ||
    !isSortedUniqueHashArray(value.parents) ||
    !isSortedUniqueHashArray(value.legacySources) ||
    value.parents.includes(value.id)
  ) {
    return false;
  }
  return true;
}

function isSortedUniqueHashArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 512 &&
    value.every((item) => isSha256(item)) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

function sortedUniqueHashes(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > 512 || unique.some((value) => !isSha256(value))) {
    throw new Error('The manifest generation ancestry is invalid.');
  }
  return unique.sort(compareText);
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
