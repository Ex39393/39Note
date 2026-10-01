import { stableStringify } from './hash.ts';
import type { SyncSnapshot } from './types.ts';

export function haveEquivalentSyncContent(
  left: SyncSnapshot,
  right: SyncSnapshot,
): boolean {
  return syncContent(left) === syncContent(right);
}

function syncContent(snapshot: SyncSnapshot): string {
  return stableStringify({
    entities: snapshot.entities,
    tombstones: snapshot.tombstones,
    pdfs: snapshot.pdfs.map((pdf) => {
      const descriptor: Record<string, unknown> = { ...pdf };
      delete descriptor.blob;
      return descriptor;
    }),
  });
}
