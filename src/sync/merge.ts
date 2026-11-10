import {
  DOCUMENT_LINK_HIGH_WATER_ENTITY_ID,
  DOCUMENT_LINK_PERSISTENCE_SCHEMA_VERSION,
  createDocumentLinkNumberHighWater,
  isValidNextDocumentLinkNumber,
  repairDocumentLinkNumberCollisions,
  sanitizeDocumentLink,
  sanitizeDocumentLinkNumberHighWater,
} from '../utils/documentLinks.ts';
import type { DocumentLink } from '../types/documentLink.ts';
import { compareCanonicalStrings, sha256HexSync, stableStringify } from './hash.ts';
import {
  SYNC_SCHEMA_VERSION,
  createSyncEntityKey,
  type SyncConflict,
  type SyncEntityRecord,
  type SyncEntityVersion,
  type SyncSnapshot,
  type SyncTombstone,
} from './types.ts';

const CONFLICT_PRESERVING_KINDS = new Set([
  'note',
  'print-draft',
  'prompt-profile',
  'ai-conversation',
]);

const LINK_NUMBER_REPAIR_DEVICE_ID = '39note-link-number-repair';

export interface MergeSyncSnapshotsResult {
  snapshot: SyncSnapshot;
  conflicts: SyncConflict[];
}

export function mergeSyncSnapshots(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  baselineHashes: Readonly<Record<string, string>>,
  now = Date.now(),
): MergeSyncSnapshotsResult {
  assertSupportedSnapshot(local);
  assertSupportedSnapshot(remote);
  assertValidDocumentLinkNumberMetadata(local);
  assertValidDocumentLinkNumberMetadata(remote);
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  const tombstonesByKey = new Map(tombstones.map((item) => [item.key, item]));
  const localByKey = new Map(local.entities.map((entity) => [entity.key, entity]));
  const remoteByKey = new Map(remote.entities.map((entity) => [entity.key, entity]));
  const keys = new Set([...localByKey.keys(), ...remoteByKey.keys()]);
  const entities: SyncEntityRecord[] = [];
  const conflicts: SyncConflict[] = [];

  for (const key of [...keys].sort()) {
    const localEntity = localByKey.get(key);
    const remoteEntity = remoteByKey.get(key);
    const winner = chooseEntity(localEntity, remoteEntity);
    if (!winner) continue;
    const tombstone = tombstonesByKey.get(key);
    if (tombstone && compareDeletionToVersion(tombstone, winner.version) >= 0) {
      continue;
    }
    entities.push(winner);

    if (
      localEntity &&
      remoteEntity &&
      localEntity.version.hash !== remoteEntity.version.hash &&
      (baselineHashes[key] === undefined ||
        (baselineHashes[key] !== localEntity.version.hash &&
          baselineHashes[key] !== remoteEntity.version.hash)) &&
      CONFLICT_PRESERVING_KINDS.has(winner.kind)
    ) {
      const alternate = winner === localEntity ? remoteEntity : localEntity;
      conflicts.push({
        id: `${key}:${winner.version.hash.slice(0, 12)}:${alternate.version.hash.slice(0, 12)}`,
        entityKey: key,
        entityKind: winner.kind,
        ...(winner.documentId ? { documentId: winner.documentId } : {}),
        detectedAt: Math.max(winner.version.updatedAt, alternate.version.updatedAt),
        winningVersion: winner.version,
        alternateVersion: alternate.version,
        winningValue: winner.value,
        alternateValue: alternate.value,
      });
    }
  }

  const liveDocumentIds = new Set(
    entities.filter((entity) => entity.kind === 'document').map((entity) => entity.id),
  );
  const deletedDocumentIds = new Set(
    tombstones
      .filter(
        (tombstone) =>
          tombstone.kind === 'document' && !liveDocumentIds.has(tombstone.id),
      )
      .map((tombstone) => tombstone.id),
  );
  const liveEntities = entities.filter(
    (entity) => !entity.documentId || !deletedDocumentIds.has(entity.documentId),
  );
  const reconciledEntities = reconcileDocumentLinkNumbers(liveEntities);

  return {
    snapshot: {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: Math.max(local.generatedAt, remote.generatedAt, now),
      generatedBy:
        compareText(local.generatedBy, remote.generatedBy) >= 0
          ? local.generatedBy
          : remote.generatedBy,
      entities: reconciledEntities.sort((first, second) =>
        compareCanonicalStrings(first.key, second.key),
      ),
      tombstones,
      pdfs: mergePdfDescriptors(local, remote).filter((pdf) =>
        liveDocumentIds.has(pdf.documentId),
      ),
    },
    conflicts,
  };
}

/**
 * Keep-local intentionally discards remote editable entities. The allocation
 * high-water is different: it records already-consumed display numbers, so it
 * must monotonically acknowledge the larger verified remote value even when
 * the local Link bodies win.
 */
export function preserveLinkNumberHighWaterForKeepLocal(
  local: SyncSnapshot,
  remote: SyncSnapshot,
): SyncSnapshot {
  assertSupportedSnapshot(local);
  assertSupportedSnapshot(remote);
  assertValidDocumentLinkNumberMetadata(local);
  assertValidDocumentLinkNumberMetadata(remote);
  const remoteByKey = new Map(
    remote.entities
      .filter((entity) => entity.kind === 'link-number-high-water')
      .map((entity) => [entity.key, entity]),
  );
  const localKeys = new Set(local.entities.map((entity) => entity.key));
  const entities = local.entities.map((entity) => {
    if (entity.kind !== 'link-number-high-water') return entity;
    const remoteEntity = remoteByKey.get(entity.key);
    return remoteEntity ? chooseEntity(entity, remoteEntity)! : entity;
  });
  for (const entity of remoteByKey.values()) {
    if (!localKeys.has(entity.key)) entities.push(entity);
  }
  return {
    ...local,
    entities: reconcileDocumentLinkNumbers(entities).sort((first, second) =>
      compareCanonicalStrings(first.key, second.key),
    ),
  };
}

export function mergeTombstones(
  first: readonly SyncTombstone[],
  second: readonly SyncTombstone[],
): SyncTombstone[] {
  const byKey = new Map<string, SyncTombstone>();
  for (const tombstone of [...first, ...second]) {
    const existing = byKey.get(tombstone.key);
    if (!existing || compareTombstones(tombstone, existing) > 0) {
      byKey.set(tombstone.key, tombstone);
    }
  }
  return [...byKey.values()].sort((a, b) => compareCanonicalStrings(a.key, b.key));
}

function chooseEntity(
  local: SyncEntityRecord | undefined,
  remote: SyncEntityRecord | undefined,
): SyncEntityRecord | undefined {
  if (!local) return remote;
  if (!remote) return local;
  if (
    local.kind === 'link-number-high-water' ||
    remote.kind === 'link-number-high-water'
  ) {
    const localValue = validatedLinkNumberHighWaterEntity(local);
    const remoteValue = validatedLinkNumberHighWaterEntity(remote);
    if (local.documentId !== remote.documentId) {
      throw new Error('Cloud Link numbering metadata has mismatched documents.');
    }
    if (localValue.nextLinkNumber > remoteValue.nextLinkNumber) return local;
    if (remoteValue.nextLinkNumber > localValue.nextLinkNumber) return remote;
  }
  return compareVersions(local.version, remote.version) >= 0 ? local : remote;
}

function assertValidDocumentLinkNumberMetadata(snapshot: SyncSnapshot): void {
  const documentEntities = snapshot.entities.filter(
    (entity) => entity.kind === 'document',
  );
  const documentIds = new Set(documentEntities.map((entity) => entity.id));
  const highWaterByDocument = new Map<string, SyncEntityRecord[]>();
  for (const entity of snapshot.entities) {
    if (entity.kind !== 'link-number-high-water') continue;
    validatedLinkNumberHighWaterEntity(entity);
    if (!documentIds.has(entity.documentId!)) {
      throw new Error('Cloud Link numbering metadata has no owning document.');
    }
    highWaterByDocument.set(entity.documentId!, [
      ...(highWaterByDocument.get(entity.documentId!) ?? []),
      entity,
    ]);
  }

  for (const documentEntity of documentEntities) {
    if (!isRecord(documentEntity.value)) {
      throw new Error(`Cloud document ${documentEntity.id} failed validation.`);
    }
    const highWaterEntities = highWaterByDocument.get(documentEntity.id) ?? [];
    const isCurrentSchema =
      documentEntity.value.schemaVersion === DOCUMENT_LINK_PERSISTENCE_SCHEMA_VERSION;
    if (
      (isCurrentSchema && highWaterEntities.length !== 1) ||
      (!isCurrentSchema && highWaterEntities.length !== 0)
    ) {
      throw new Error(
        `Cloud document ${documentEntity.id} has invalid Link numbering.`,
      );
    }

    const links = snapshot.entities.flatMap((entity) => {
      if (
        entity.kind !== 'annotation' ||
        entity.documentId !== documentEntity.id ||
        !isRecord(entity.value) ||
        entity.value.type !== 'link'
      ) {
        return [];
      }
      const link = sanitizeDocumentLink(entity.value, documentEntity.id);
      if (!link || link.id !== entity.id) {
        throw new Error(`Cloud document ${documentEntity.id} has an invalid Link.`);
      }
      return [link];
    });
    if (!isCurrentSchema && links.length > 0) {
      throw new Error(`Cloud document ${documentEntity.id} has invalid Link metadata.`);
    }
    if (
      isCurrentSchema &&
      !isValidNextDocumentLinkNumber(
        validatedLinkNumberHighWaterEntity(highWaterEntities[0]).nextLinkNumber,
        links,
      )
    ) {
      throw new Error(
        `Cloud document ${documentEntity.id} has regressed Link numbering.`,
      );
    }
  }
}

function validatedLinkNumberHighWaterEntity(
  entity: SyncEntityRecord,
): NonNullable<ReturnType<typeof sanitizeDocumentLinkNumberHighWater>> {
  if (
    entity.kind !== 'link-number-high-water' ||
    entity.id !== DOCUMENT_LINK_HIGH_WATER_ENTITY_ID ||
    !entity.documentId ||
    entity.key !==
      createSyncEntityKey(
        'link-number-high-water',
        DOCUMENT_LINK_HIGH_WATER_ENTITY_ID,
        entity.documentId,
      )
  ) {
    throw new Error('Cloud Link numbering metadata has an invalid identity.');
  }
  const value = sanitizeDocumentLinkNumberHighWater(entity.value, entity.documentId);
  if (!value) {
    throw new Error('Cloud Link numbering metadata failed validation.');
  }
  return value;
}

function reconcileDocumentLinkNumbers(
  entities: readonly SyncEntityRecord[],
): SyncEntityRecord[] {
  const output = [...entities];
  const documents = new Set(
    output.filter((entity) => entity.kind === 'document').map((entity) => entity.id),
  );
  for (const documentId of documents) {
    const documentEntity = output.find(
      (entity) => entity.kind === 'document' && entity.id === documentId,
    );
    if (!documentEntity || !isRecord(documentEntity.value)) {
      throw new Error(`Cloud document ${documentId} failed validation.`);
    }
    const highWaterIndexes = output.flatMap((entity, index) =>
      entity.kind === 'link-number-high-water' && entity.documentId === documentId
        ? [index]
        : [],
    );
    const isCurrentSchema =
      documentEntity.value.schemaVersion === DOCUMENT_LINK_PERSISTENCE_SCHEMA_VERSION;
    // Released schema-8 snapshots have neither Links nor a high-water record.
    // Current snapshots require exactly one even after tombstone filtering so
    // a stale deletion cannot be published as an apparently complete package.
    if (
      (isCurrentSchema && highWaterIndexes.length !== 1) ||
      (!isCurrentSchema && highWaterIndexes.length !== 0)
    ) {
      throw new Error(`Cloud document ${documentId} has invalid Link numbering.`);
    }
    if (!isCurrentSchema) continue;
    const highWaterIndex = highWaterIndexes[0];
    const highWaterEntity = output[highWaterIndex];
    const highWater = validatedLinkNumberHighWaterEntity(highWaterEntity);

    const linkEntities = output.flatMap((entity, index) => {
      if (
        entity.kind !== 'annotation' ||
        entity.documentId !== documentId ||
        !isRecord(entity.value) ||
        entity.value.type !== 'link'
      ) {
        return [];
      }
      const link = sanitizeDocumentLink(entity.value, documentId);
      if (!link || link.id !== entity.id) {
        throw new Error(`Cloud document ${documentId} has an invalid Link.`);
      }
      return [{ entity, index, link }];
    });
    if (
      !isValidNextDocumentLinkNumber(
        highWater.nextLinkNumber,
        linkEntities.map(({ link }) => link),
      )
    ) {
      throw new Error(`Cloud document ${documentId} has regressed Link numbering.`);
    }
    const repaired = repairDocumentLinkNumberCollisions(
      linkEntities.map(({ link }) => link),
      highWater.nextLinkNumber,
    );
    const repairedById = new Map(repaired.links.map((link) => [link.id, link]));
    const changedLinks = linkEntities.filter(
      ({ link }) => repairedById.get(link.id)?.visibleNumber !== link.visibleNumber,
    );
    const highWaterChanged = repaired.nextLinkNumber !== highWater.nextLinkNumber;
    if (!changedLinks.length && !highWaterChanged) continue;

    const repairVersionTime = nextDeterministicRepairVersion(
      linkEntities.map(({ entity }) => entity.version.updatedAt),
      highWaterEntity.version.updatedAt,
    );
    for (const { entity, index, link } of changedLinks) {
      const value = repairedById.get(link.id)!;
      output[index] = repairedEntity(entity, value, repairVersionTime);
    }
    if (highWaterChanged || changedLinks.length > 0) {
      const value = createDocumentLinkNumberHighWater(
        documentId,
        repaired.nextLinkNumber,
      );
      if (!value) {
        throw new Error(`Cloud document ${documentId} exhausted Link numbering.`);
      }
      output[highWaterIndex] = repairedEntity(
        highWaterEntity,
        value,
        repairVersionTime,
      );
    }
  }
  return output;
}

function repairedEntity(
  source: SyncEntityRecord,
  value:
    DocumentLink | NonNullable<ReturnType<typeof createDocumentLinkNumberHighWater>>,
  updatedAt: number,
): SyncEntityRecord {
  return {
    ...source,
    value,
    version: {
      updatedAt,
      deviceId: LINK_NUMBER_REPAIR_DEVICE_ID,
      hash: sha256HexSync(stableStringify(value)),
    },
  };
}

function nextDeterministicRepairVersion(
  linkVersions: readonly number[],
  highWaterVersion: number,
): number {
  const latest = Math.max(highWaterVersion, ...linkVersions);
  if (!Number.isSafeInteger(latest) || latest >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Link numbering repair exhausted its logical clock.');
  }
  return latest + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function compareVersions(
  first: SyncEntityVersion,
  second: SyncEntityVersion,
): number {
  return (
    first.updatedAt - second.updatedAt ||
    compareText(first.deviceId, second.deviceId) ||
    compareText(first.hash, second.hash)
  );
}

function compareTombstones(first: SyncTombstone, second: SyncTombstone): number {
  return (
    first.deletedAt - second.deletedAt ||
    compareText(first.deviceId, second.deviceId) ||
    compareText(first.key, second.key)
  );
}

function compareDeletionToVersion(
  tombstone: SyncTombstone,
  version: SyncEntityVersion,
): number {
  return (
    tombstone.deletedAt - version.updatedAt ||
    compareText(tombstone.deviceId, version.deviceId)
  );
}

function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function mergePdfDescriptors(
  local: SyncSnapshot,
  remote: SyncSnapshot,
): SyncSnapshot['pdfs'] {
  const byDocument = new Map(local.pdfs.map((pdf) => [pdf.documentId, pdf]));
  for (const pdf of remote.pdfs) {
    const existing = byDocument.get(pdf.documentId);
    if (!existing) {
      byDocument.set(pdf.documentId, pdf);
      continue;
    }
    if (existing.sha256 !== pdf.sha256) {
      throw new Error(`Original PDF conflict for document ${pdf.documentId}.`);
    }
    byDocument.set(pdf.documentId, existing.fileId ? existing : pdf);
  }
  return [...byDocument.values()].sort((a, b) =>
    compareCanonicalStrings(a.documentId, b.documentId),
  );
}

function assertSupportedSnapshot(snapshot: SyncSnapshot): void {
  if (snapshot.syncSchemaVersion > SYNC_SCHEMA_VERSION) {
    throw new Error('This 39Note sync data was created by a newer version.');
  }
}
