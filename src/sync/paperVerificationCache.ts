import type { DriveFileMetadata } from './driveClient.ts';

export type PaperVerificationCacheKind = 'manifest' | 'presence';

/**
 * Local-only acceleration evidence for one already verified immutable Drive text.
 * The cached body is never authoritative by itself: callers must parse and verify
 * it again, then require freshly listed Drive metadata to match every immutable
 * field before reuse.
 */
export interface PaperVerificationCacheEntry {
  kind: PaperVerificationCacheKind;
  file: DriveFileMetadata;
  text: string;
}

export interface StoredPaperVerificationCacheEntry extends PaperVerificationCacheEntry {
  id: string;
  formatVersion: 1;
  accountId: string;
  rootFolderId: string;
  verifiedAt: number;
}

export function paperVerificationCacheRecordId(
  accountId: string,
  rootFolderId: string,
  kind: PaperVerificationCacheKind,
  fileId: string,
): string {
  // Keep every scope in the key itself. Drive IDs are normally globally unique,
  // but cache isolation must not depend on that external property, and a write
  // for one account/root must never evict another scope's acceleration record.
  return `drive-verification:${JSON.stringify([
    accountId,
    rootFolderId,
    kind,
    fileId,
  ])}`;
}
