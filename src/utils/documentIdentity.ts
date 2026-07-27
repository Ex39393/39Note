import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocumentIdentity } from '../types/persistence';
import { isValidDocumentId } from './documentId';

export function resolveDocumentIdentity(
  file: File,
  document: PDFDocumentProxy,
): DocumentIdentity {
  const fingerprint = document.fingerprints.find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
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
