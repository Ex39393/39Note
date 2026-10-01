import { compareCanonicalStrings } from './hash.ts';
import {
  SYNC_SCHEMA_VERSION,
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

  return {
    snapshot: {
      app: '39Note',
      syncSchemaVersion: SYNC_SCHEMA_VERSION,
      generatedAt: Math.max(local.generatedAt, remote.generatedAt, now),
      generatedBy:
        compareText(local.generatedBy, remote.generatedBy) >= 0
          ? local.generatedBy
          : remote.generatedBy,
      entities: liveEntities.sort((first, second) =>
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
  return compareVersions(local.version, remote.version) >= 0 ? local : remote;
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
