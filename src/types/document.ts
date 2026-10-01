/** File formats that 39Note can persist as first-class source documents. */
export type DocumentType = 'pdf' | 'pptx' | 'docx';

export const DOCUMENT_MIME_TYPES = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const satisfies Record<DocumentType, string>;

export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[DocumentType];

export const DOCUMENT_FILE_EXTENSIONS = {
  pdf: '.pdf',
  pptx: '.pptx',
  docx: '.docx',
} as const satisfies Record<DocumentType, string>;

/** Integrity-bearing metadata shared by local persistence, backup, and sync. */
export interface DocumentSourceDescriptor {
  documentId: string;
  documentType: DocumentType;
  fileName: string;
  mimeType: DocumentMimeType;
  sha256: string;
  size: number;
}

/** A locally available source artifact. The Blob is always the original source. */
export interface StoredDocumentSource extends DocumentSourceDescriptor {
  lastModified: number;
  blob: Blob;
  storedAt: number;
}

export function isDocumentType(value: unknown): value is DocumentType {
  return value === 'pdf' || value === 'pptx' || value === 'docx';
}

export function isDocumentMimeType(value: unknown): value is DocumentMimeType {
  return (
    typeof value === 'string' &&
    Object.values(DOCUMENT_MIME_TYPES).some((mimeType) => mimeType === value)
  );
}

export function getDocumentTypeForMimeType(mimeType: unknown): DocumentType | null {
  if (!isDocumentMimeType(mimeType)) return null;
  return (
    (
      Object.entries(DOCUMENT_MIME_TYPES) as Array<[DocumentType, DocumentMimeType]>
    ).find(([, candidate]) => candidate === mimeType)?.[0] ?? null
  );
}

export function getDocumentMimeType(documentType: DocumentType): DocumentMimeType {
  return DOCUMENT_MIME_TYPES[documentType];
}

export function hasDocumentFileExtension(
  fileName: string,
  documentType: DocumentType,
): boolean {
  return fileName
    .toLocaleLowerCase('en-US')
    .endsWith(DOCUMENT_FILE_EXTENSIONS[documentType]);
}
