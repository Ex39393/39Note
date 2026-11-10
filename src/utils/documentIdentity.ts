import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocumentIdentity } from '../types/persistence';
import { isSyncCompatibleDocumentId, isValidDocumentId } from './documentId';

const DOCUMENT_INSTANCE_MARKER = ':instance:';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function resolveDocumentIdentity(
  file: File,
  document: PDFDocumentProxy,
): DocumentIdentity {
  const fingerprint = document.fingerprints.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  );

  const documentId = fingerprint
    ? `pdfjs:${fingerprint}`
    : `file:${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;

  return {
    documentId: isValidDocumentId(documentId)
      ? documentId
      : `file:unnamed:${file.size}:${file.lastModified}`,
    documentName: file.name,
  };
}

/**
 * Creates a second, explicitly user-requested paper identity while retaining
 * the complete fingerprint-derived source identity as its duplicate key.
 * Existing and ordinary imports never call this function.
 */
export function createDocumentInstanceIdentity(
  sourceIdentity: DocumentIdentity,
  instanceId: string,
): DocumentIdentity {
  if (!isValidDocumentId(sourceIdentity.documentId) || !UUID_PATTERN.test(instanceId)) {
    throw new Error('A new paper identity could not be created safely.');
  }
  const documentId = `${sourceIdentity.documentId}${DOCUMENT_INSTANCE_MARKER}${instanceId.toLowerCase()}`;
  if (!isSyncCompatibleDocumentId(documentId)) {
    throw new Error(
      'The source identity is too long to create a separate cloud-compatible paper.',
    );
  }
  return { ...sourceIdentity, documentId };
}

/** Returns the original fingerprint-derived identity used for duplicate checks. */
export function getDocumentSourceIdentityId(documentId: string): string | null {
  if (!isValidDocumentId(documentId)) return null;
  const markerIndex = documentId.lastIndexOf(DOCUMENT_INSTANCE_MARKER);
  if (markerIndex < 0) return documentId;
  const instanceId = documentId.slice(markerIndex + DOCUMENT_INSTANCE_MARKER.length);
  const sourceIdentityId = documentId.slice(0, markerIndex);
  return UUID_PATTERN.test(instanceId) && isValidDocumentId(sourceIdentityId)
    ? sourceIdentityId
    : documentId;
}

/**
 * Reopens an already-persisted instance only when the verified PDF source
 * identity exactly matches the source identity embedded in its opaque key.
 */
export function preserveRequestedDocumentInstanceIdentity(
  sourceIdentity: DocumentIdentity,
  requestedDocumentId?: string,
): DocumentIdentity {
  if (
    !requestedDocumentId ||
    requestedDocumentId === sourceIdentity.documentId ||
    getDocumentSourceIdentityId(requestedDocumentId) !== sourceIdentity.documentId
  ) {
    return sourceIdentity;
  }
  return { ...sourceIdentity, documentId: requestedDocumentId };
}
