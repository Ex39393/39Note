import { isValidDocumentId } from '../utils/documentId.ts';
import {
  parseCloudPayloadBlob,
  type CloudEntityPayload,
  type CloudManifestRecoveryEvidence,
  type CloudPayloadContext,
  type CloudPayloadReference,
} from './cloudFormat.ts';
import { isSha256, sha256Hex, stableStringify } from './hash.ts';
import { assertNoSecretsInSyncPayload } from './secrets.ts';
import {
  LEGACY_PAPER_MANIFEST_STORAGE,
  LEGACY_PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_MANIFEST_STORAGE,
  PAPER_PACKAGE_LAYOUT_VERSION,
  PAPER_PAYLOAD_STORAGE,
  PAPER_SYNC_PROTOCOL_VERSION,
  type PaperCloudManifest,
  type PaperCloudManifestV2,
  type PaperCloudManifestV3,
  type PaperManifestGeneration,
} from './paperTypes.ts';
import {
  SYNC_SCHEMA_VERSION,
  type SyncConflict,
  type SyncEntityKind,
  type SyncSourceArtifactDescriptor,
  type SyncSnapshot,
} from './types.ts';

export type PaperManifestBase =
  Omit<PaperCloudManifestV2, 'generation'> | Omit<PaperCloudManifestV3, 'generation'>;

export interface PaperPayloadPartitions {
  state: CloudEntityPayload;
  productivity: CloudEntityPayload;
}

export interface PaperConflictPayload {
  app: '39Note';
  paperSyncProtocolVersion: typeof PAPER_SYNC_PROTOCOL_VERSION;
  documentId: string;
  conflicts: SyncConflict[];
}

const PRODUCTIVITY_KINDS = new Set<SyncEntityKind>(['print-draft', 'ai-conversation']);
const GLOBAL_KINDS = new Set<SyncEntityKind>([
  'prompt-profile',
  'ai-configuration',
  'default-prompt',
]);
const ENTITY_KINDS = new Set<SyncEntityKind>([
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

export function partitionPaperSnapshot(
  snapshot: SyncSnapshot,
  documentId: string,
): PaperPayloadPartitions {
  assertPaperSnapshot(snapshot, documentId);
  const state = emptyPayload();
  const productivity = emptyPayload();
  for (const entity of snapshot.entities) {
    (PRODUCTIVITY_KINDS.has(entity.kind) ? productivity : state).entities.push(entity);
  }
  for (const tombstone of snapshot.tombstones) {
    (PRODUCTIVITY_KINDS.has(tombstone.kind) ? productivity : state).tombstones.push(
      tombstone,
    );
  }
  return { state, productivity };
}

export function combinePaperPayloads(
  manifest: PaperCloudManifest,
  state: CloudEntityPayload,
  productivity: CloudEntityPayload,
): SyncSnapshot {
  assertPayloadContext(state, paperPayloadContext('document-state', manifest));
  assertPayloadContext(
    productivity,
    paperPayloadContext('productivity-data', manifest),
  );
  const entities = [...state.entities, ...productivity.entities];
  const tombstones = [...state.tombstones, ...productivity.tombstones];
  if (
    new Set(entities.map((record) => record.key)).size !== entities.length ||
    new Set(tombstones.map((record) => record.key)).size !== tombstones.length
  ) {
    throw new Error('A paper package contains duplicate entity identities.');
  }
  const snapshot: SyncSnapshot = {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: manifest.generation.createdAt,
    generatedBy: manifest.writer.deviceId,
    entities,
    tombstones,
    // Layout-2 PDF identity remains readable in its historical snapshot slot.
    // Layout-3 sources travel through `sourceArtifact` and are never disguised
    // as entries in the legacy PDF collection.
    pdfs:
      manifest.syncLayoutVersion === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION &&
      manifest.sourcePdf
        ? [manifest.sourcePdf]
        : [],
  };
  assertPaperSnapshot(snapshot, manifest.documentId);
  return snapshot;
}

export async function createPaperManifestGeneration(
  base: PaperManifestBase,
  options: {
    createdAt: number;
    createdBy: string;
    parents: readonly string[];
  },
): Promise<PaperCloudManifest> {
  const generationWithoutIdentity: Omit<PaperManifestGeneration, 'id'> = {
    createdAt: options.createdAt,
    createdBy: options.createdBy,
    parents: sortedUniqueHashes(options.parents),
  };
  const canonicalBase: PaperManifestBase = {
    ...base,
    conflictIds: [...new Set(base.conflictIds)].sort(compareCanonicalValues),
    ...(base.recoveryEvidence
      ? {
          recoveryEvidence: [
            ...new Map(
              base.recoveryEvidence.map((entry) => [stableStringify(entry), entry]),
            ).values(),
          ].sort(compareCanonicalValues),
        }
      : {}),
  };
  const identityInput = {
    ...canonicalBase,
    generation: generationWithoutIdentity,
  };
  const manifest = {
    ...canonicalBase,
    generation: {
      id: await sha256Hex(stableStringify(identityInput)),
      ...generationWithoutIdentity,
    },
  } as PaperCloudManifest;
  assertPaperManifest(manifest);
  assertNoSecretsInSyncPayload(manifest);
  return manifest;
}

export async function verifyPaperManifestGeneration(
  manifest: PaperCloudManifest,
): Promise<boolean> {
  try {
    assertPaperManifest(manifest);
  } catch {
    return false;
  }
  const { id, ...withoutIdentity } = manifest.generation;
  return (
    (await sha256Hex(stableStringify({ ...manifest, generation: withoutIdentity }))) ===
    id
  );
}

export function parsePaperCloudManifest(text: string): PaperCloudManifest {
  return parsePaperCloudManifestForSupportedLayout(text, PAPER_PACKAGE_LAYOUT_VERSION);
}

/**
 * Compatibility seam used by regression tests to prove an older reader rejects
 * a newer layout before any payload can be combined or applied.
 */
export function parsePaperCloudManifestForSupportedLayout(
  text: string,
  maximumSupportedLayout: number,
): PaperCloudManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('A paper manifest contains malformed JSON.');
  }
  if (isRecord(value)) {
    if (
      typeof value.syncLayoutVersion === 'number' &&
      value.syncLayoutVersion > maximumSupportedLayout
    ) {
      throw new Error('This paper layout was created by a newer 39Note version.');
    }
    if (
      typeof value.paperSyncProtocolVersion === 'number' &&
      value.paperSyncProtocolVersion > PAPER_SYNC_PROTOCOL_VERSION
    ) {
      throw new Error('This paper package was created by a newer 39Note version.');
    }
  }
  assertPaperManifest(value);
  assertNoSecretsInSyncPayload(value);
  return value;
}

/** Maps immutable layout-2 PDF identity into the generic in-memory model. */
export function paperManifestSourceArtifact(manifest: PaperCloudManifest):
  | (SyncSourceArtifactDescriptor & {
      fileId: string;
      driveRole: 'paper-source-pdf' | 'paper-source-document';
    })
  | undefined {
  if (manifest.syncLayoutVersion === PAPER_PACKAGE_LAYOUT_VERSION) {
    return manifest.sourceArtifact;
  }
  const source = manifest.sourcePdf;
  return source
    ? {
        ...source,
        documentType: 'pdf',
        mimeType: 'application/pdf',
        driveRole: 'paper-source-pdf',
      }
    : undefined;
}

export async function parsePaperPayloadBlob(
  blob: Blob,
  expectedHash: string,
  logicalType: 'document-state' | 'productivity-data',
  documentId: string,
): Promise<CloudEntityPayload> {
  return parseCloudPayloadBlob(
    blob,
    expectedHash,
    paperPayloadContext(logicalType, { documentId }),
  );
}

export async function encodePaperConflictPayload(
  documentId: string,
  conflicts: readonly SyncConflict[],
): Promise<{ text: string; sha256: string }> {
  const payload: PaperConflictPayload = {
    app: '39Note',
    paperSyncProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
    documentId,
    conflicts: [
      ...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values(),
    ].sort((first, second) => first.id.localeCompare(second.id)),
  };
  assertPaperConflictPayload(payload, documentId);
  assertNoSecretsInSyncPayload(payload);
  const text = stableStringify(payload);
  return { text, sha256: await sha256Hex(text) };
}

export async function parsePaperConflictPayloadBlob(
  blob: Blob,
  expectedHash: string,
  documentId: string,
): Promise<PaperConflictPayload> {
  if (!isSha256(expectedHash) || (await sha256Hex(blob)) !== expectedHash) {
    throw new Error('A paper conflict journal failed integrity verification.');
  }
  let value: unknown;
  try {
    value = JSON.parse(await blob.text());
  } catch {
    throw new Error('A paper conflict journal contains malformed JSON.');
  }
  assertPaperConflictPayload(value, documentId);
  assertNoSecretsInSyncPayload(value);
  return value;
}

export function assertPaperSnapshot(snapshot: SyncSnapshot, documentId: string): void {
  assertNoSecretsInSyncPayload(snapshot);
  if (
    !isValidDocumentId(documentId) ||
    snapshot.app !== '39Note' ||
    snapshot.syncSchemaVersion !== SYNC_SCHEMA_VERSION
  ) {
    throw new Error('The paper package uses an unsupported sync schema.');
  }
  const keys = new Set<string>();
  for (const record of [...snapshot.entities, ...snapshot.tombstones]) {
    if (!record.key || keys.has(record.key) || GLOBAL_KINDS.has(record.kind)) {
      throw new Error('The paper package contains an invalid entity set.');
    }
    const recordDocumentId = record.kind === 'document' ? record.id : record.documentId;
    if (recordDocumentId !== documentId) {
      throw new Error('The paper package contains data for another paper.');
    }
    keys.add(record.key);
  }
  if (
    snapshot.pdfs.length > 1 ||
    snapshot.pdfs.some((pdf) => pdf.documentId !== documentId)
  ) {
    throw new Error('The paper package contains an invalid source PDF set.');
  }
}

function assertPaperManifest(value: unknown): asserts value is PaperCloudManifest {
  if (!isRecord(value)) throw new Error('The paper manifest is invalid.');
  const isLayout2 =
    value.syncLayoutVersion === LEGACY_PAPER_PACKAGE_LAYOUT_VERSION &&
    value.manifestStorage === LEGACY_PAPER_MANIFEST_STORAGE &&
    value.sourceArtifact === undefined &&
    (value.sourcePdf === undefined ||
      isSourcePdfDescriptor(value.sourcePdf, value.documentId));
  const isLayout3 =
    value.syncLayoutVersion === PAPER_PACKAGE_LAYOUT_VERSION &&
    value.manifestStorage === PAPER_MANIFEST_STORAGE &&
    value.sourcePdf === undefined &&
    (value.sourceArtifact === undefined ||
      isSourceArtifactDescriptor(value.sourceArtifact, value.documentId));
  if (
    value.app !== '39Note' ||
    (!isLayout2 && !isLayout3) ||
    value.paperSyncProtocolVersion !== PAPER_SYNC_PROTOCOL_VERSION ||
    value.payloadStorage !== PAPER_PAYLOAD_STORAGE ||
    !isValidDocumentId(value.documentId) ||
    !isSafeDriveId(value.paperFolderId) ||
    !isSafeDriveId(value.dataFolderId) ||
    !isSafeDisplayName(value.displayName) ||
    typeof value.deleted !== 'boolean' ||
    !isRecord(value.writer) ||
    !isSafeDeviceIdentity(value.writer.deviceId) ||
    !isOptionalDeviceLabel(value.writer.deviceLabel) ||
    !isPayloadReference(value.state) ||
    !isPayloadReference(value.productivity) ||
    !isPayloadReference(value.conflictJournal) ||
    !isSortedUniqueStrings(value.conflictIds) ||
    (value.recoveryEvidence !== undefined &&
      (!Array.isArray(value.recoveryEvidence) ||
        value.recoveryEvidence.some(
          (evidence) => !isRecoveryEvidence(evidence, value.documentId as string),
        ))) ||
    !isRecord(value.generation) ||
    !isSha256(value.generation.id) ||
    !isTimestamp(value.generation.createdAt) ||
    !isSafeDeviceIdentity(value.generation.createdBy) ||
    value.generation.createdBy !== value.writer.deviceId ||
    !isSortedUniqueHashes(value.generation.parents) ||
    (value.renderedPrintPdf !== undefined &&
      !isRenderedPrintPdfDescriptor(value.renderedPrintPdf, value.documentId))
  ) {
    throw new Error('The paper manifest failed validation.');
  }
}

function assertPaperConflictPayload(
  value: unknown,
  documentId: string,
): asserts value is PaperConflictPayload {
  if (
    !isRecord(value) ||
    value.app !== '39Note' ||
    value.paperSyncProtocolVersion !== PAPER_SYNC_PROTOCOL_VERSION ||
    value.documentId !== documentId ||
    !Array.isArray(value.conflicts) ||
    value.conflicts.some(
      (conflict) =>
        !isSyncConflict(conflict) ||
        (conflict.documentId !== undefined && conflict.documentId !== documentId),
    ) ||
    !isSortedUniqueStrings(value.conflicts.map((conflict) => conflict.id))
  ) {
    throw new Error('The paper conflict journal is invalid.');
  }
}

function assertPayloadContext(
  payload: CloudEntityPayload,
  context: CloudPayloadContext,
): void {
  const records = [...payload.entities, ...payload.tombstones];
  const productivity = context.logicalType === 'productivity-data';
  if (
    payload.app !== '39Note' ||
    payload.syncSchemaVersion !== SYNC_SCHEMA_VERSION ||
    records.some((record) => {
      const expectedKind = productivity
        ? PRODUCTIVITY_KINDS.has(record.kind)
        : !PRODUCTIVITY_KINDS.has(record.kind) && !GLOBAL_KINDS.has(record.kind);
      const id = record.kind === 'document' ? record.id : record.documentId;
      return !expectedKind || id !== context.documentId;
    })
  ) {
    throw new Error('A paper payload is in the wrong logical partition.');
  }
}

function paperPayloadContext(
  logicalType: 'document-state' | 'productivity-data',
  paper: { documentId: string },
): CloudPayloadContext {
  return {
    logicalType,
    logicalPath:
      logicalType === 'document-state'
        ? `papers/${paper.documentId}/state.json`
        : `papers/${paper.documentId}/productivity.json`,
    documentId: paper.documentId,
    partitionModel: 'paper-v2',
    sourceProtocolVersion: PAPER_SYNC_PROTOCOL_VERSION,
  };
}

function emptyPayload(): CloudEntityPayload {
  return {
    app: '39Note',
    syncSchemaVersion: SYNC_SCHEMA_VERSION,
    entities: [],
    tombstones: [],
  };
}

function sortedUniqueHashes(values: readonly string[]): string[] {
  if (values.some((value) => !isSha256(value))) {
    throw new Error('A paper manifest contains an invalid parent identity.');
  }
  return [...new Set(values)].sort();
}

function isPayloadReference(value: unknown): value is CloudPayloadReference {
  return isRecord(value) && isSafeDriveId(value.fileId) && isSha256(value.sha256);
}

function isSourcePdfDescriptor(value: unknown, documentId: unknown): boolean {
  return (
    isRecord(value) &&
    value.documentId === documentId &&
    isSafeDriveId(value.fileId) &&
    isSafeFileName(value.fileName) &&
    value.mimeType === 'application/pdf' &&
    isNonNegativeInteger(value.size) &&
    isTimestamp(value.lastModified) &&
    isTimestamp(value.storedAt) &&
    isSha256(value.sha256)
  );
}

function isSourceArtifactDescriptor(value: unknown, documentId: unknown): boolean {
  if (
    !isRecord(value) ||
    value.documentId !== documentId ||
    !isSafeDriveId(value.fileId) ||
    !isSafeFileName(value.fileName) ||
    !isNonNegativeInteger(value.size) ||
    !isTimestamp(value.lastModified) ||
    !isTimestamp(value.storedAt) ||
    !isSha256(value.sha256)
  ) {
    return false;
  }
  const expectedMime =
    value.documentType === 'pdf'
      ? 'application/pdf'
      : value.documentType === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : value.documentType === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : undefined;
  if (!expectedMime || value.mimeType !== expectedMime) return false;
  return (
    value.driveRole === 'paper-source-document' ||
    (value.driveRole === 'paper-source-pdf' && value.documentType === 'pdf')
  );
}

function isRenderedPrintPdfDescriptor(value: unknown, documentId: unknown): boolean {
  return (
    isRecord(value) &&
    value.kind === 'rendered-print-pdf' &&
    value.documentId === documentId &&
    isSafeDriveId(value.fileId) &&
    isSafeFileName(value.fileName) &&
    value.mimeType === 'application/pdf' &&
    isNonNegativeInteger(value.size) &&
    isSha256(value.sha256) &&
    isSha256(value.renderedFromDraftHash) &&
    isTimestamp(value.createdAt)
  );
}

function isRecoveryEvidence(
  value: unknown,
  documentId: string,
): value is CloudManifestRecoveryEvidence {
  return (
    isRecord(value) &&
    isSha256(value.sourceManifestId) &&
    (value.logicalType === 'document-state' ||
      value.logicalType === 'productivity-data') &&
    value.documentId === documentId &&
    isPayloadReference(value.expected) &&
    (value.observed === undefined || isPayloadReference(value.observed)) &&
    isPayloadReference(value.merged)
  );
}

function isSyncConflict(value: unknown): value is SyncConflict {
  if (
    !isRecord(value) ||
    !isRecord(value.winningVersion) ||
    !isRecord(value.alternateVersion)
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 1_024 &&
    typeof value.entityKey === 'string' &&
    value.entityKey.length > 0 &&
    ENTITY_KINDS.has(value.entityKind as SyncEntityKind) &&
    (value.documentId === undefined || isValidDocumentId(value.documentId)) &&
    isTimestamp(value.detectedAt) &&
    isEntityVersion(value.winningVersion) &&
    isEntityVersion(value.alternateVersion) &&
    (value.dismissedAt === undefined || isTimestamp(value.dismissedAt))
  );
}

function isEntityVersion(value: Record<string, unknown>): boolean {
  return (
    isTimestamp(value.updatedAt) &&
    isSafeDeviceIdentity(value.deviceId) &&
    isSha256(value.hash)
  );
}

function isSortedUniqueHashes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isSha256) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

function isSortedUniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= 1_024,
    ) &&
    value.every((item, index) => index === 0 || value[index - 1] < item)
  );
}

function isSafeDisplayName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 240 &&
    !hasAsciiControlCharacter(value)
  );
}

function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !hasAsciiControlCharacter(value)
  );
}

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function isSafeDeviceIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isOptionalDeviceLabel(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.trim() === value &&
      value.length > 0 &&
      value.length <= 80 &&
      !hasAsciiControlCharacter(value))
  );
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint <= 0x1f;
  });
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function compareCanonicalValues(first: unknown, second: unknown): number {
  const a = stableStringify(first);
  const b = stableStringify(second);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
