const MAXIMUM_DOCUMENT_ID_LENGTH = 512;
/** Existing cloud entity payloads cap both entity and owning-document IDs here. */
export const MAXIMUM_SYNC_DOCUMENT_ID_LENGTH = 256;

/**
 * 39Note document IDs are opaque application keys. Current IDs use either a
 * `pdfjs:` fingerprint or a `file:` fallback containing an encoded filename.
 */
export function isValidDocumentId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAXIMUM_DOCUMENT_ID_LENGTH &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) > 31 && character !== '\u007f',
    )
  );
}

/**
 * A locally valid opaque ID that can round-trip through the released sync
 * payload format. Longer historical local IDs remain valid and accessible,
 * but must fail closed before any remote publication.
 */
export function isSyncCompatibleDocumentId(value: unknown): value is string {
  return isValidDocumentId(value) && value.length <= MAXIMUM_SYNC_DOCUMENT_ID_LENGTH;
}

export function isSafeLegacyDocumentIdForArchive(value: string): boolean {
  return isValidDocumentId(value) && !value.includes('/') && !value.includes('\\');
}

export function getArchiveEntryKey(documentId: string): string {
  return encodeURIComponent(documentId);
}
