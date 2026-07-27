const MAXIMUM_DOCUMENT_ID_LENGTH = 512;

/**
 * 39Note document IDs are opaque application keys. Current IDs use either a
 * `pdfjs:` fingerprint or a `file:` fallback containing an encoded filename.
 */
export function isValidDocumentId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAXIMUM_DOCUMENT_ID_LENGTH &&
    Array.from(value).every((character) => character.charCodeAt(0) > 31 && character !== '\u007f');
}

export function isSafeLegacyDocumentIdForArchive(value: string): boolean {
  return isValidDocumentId(value) &&
    !value.includes('/') &&
    !value.includes('\\');
}

export function getArchiveEntryKey(documentId: string): string {
  return encodeURIComponent(documentId);
}
