import {
  DOCUMENT_MIME_TYPES,
  getDocumentTypeForMimeType,
  hasDocumentFileExtension,
  isDocumentType,
  type DocumentType,
  type StoredDocumentSource,
} from '../types/document.ts';
import { isValidDocumentId } from '../utils/documentId.ts';
import { isSha256, sha256Hex } from '../sync/hash.ts';
import { DEFAULT_OOXML_LIMITS } from '../documents/ooxml/limits.ts';

const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

interface LegacyStoredPdfFileShape {
  documentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  blob: Blob;
  storedAt: number;
  documentType?: 'pdf';
  sha256?: string;
}

/**
 * Validates metadata, exact content identity, and the source signature/container.
 * Legacy records may omit only the new PDF type/hash fields; they are filled in
 * from verified bytes in memory and are never used to infer an Office format.
 */
export async function validateStoredDocumentSource(
  value: unknown,
  expectedDocumentId: string,
  options: { allowLegacyPdf?: boolean } = {},
): Promise<StoredDocumentSource | null> {
  if (
    !isRecord(value) ||
    !isValidDocumentId(expectedDocumentId) ||
    value.documentId !== expectedDocumentId ||
    typeof value.fileName !== 'string' ||
    !isSafeOriginalFileName(value.fileName) ||
    typeof value.mimeType !== 'string' ||
    !isPositiveIntegerOrZero(value.size) ||
    !isTimestamp(value.lastModified) ||
    !isTimestamp(value.storedAt) ||
    !(value.blob instanceof Blob) ||
    value.blob.size !== value.size ||
    value.size > MAX_SOURCE_BYTES
  ) {
    return null;
  }

  const legacyPdf =
    options.allowLegacyPdf === true &&
    value.documentType === undefined &&
    (value.sha256 === undefined || isSha256(value.sha256)) &&
    value.mimeType === DOCUMENT_MIME_TYPES.pdf;
  const documentType = legacyPdf
    ? 'pdf'
    : isDocumentType(value.documentType)
      ? value.documentType
      : null;
  if (
    !documentType ||
    getDocumentTypeForMimeType(value.mimeType) !== documentType ||
    !hasDocumentFileExtension(value.fileName, documentType) ||
    (!legacyPdf && !isSha256(value.sha256))
  ) {
    return null;
  }

  const inspected = await inspectDocumentContent(value.blob, documentType);
  if (!inspected.valid) return null;
  const actualSha256 = await sha256Hex(inspected.bytes ?? value.blob);
  if (value.sha256 !== undefined && value.sha256 !== actualSha256) {
    return null;
  }

  return {
    documentId: value.documentId,
    documentType,
    fileName: value.fileName,
    mimeType: DOCUMENT_MIME_TYPES[documentType],
    sha256: actualSha256,
    size: value.size,
    lastModified: value.lastModified,
    blob: value.blob,
    storedAt: value.storedAt,
  };
}

export async function createStoredDocumentSource(
  documentId: string,
  file: File,
  expectedDocumentType?: DocumentType,
): Promise<StoredDocumentSource | null> {
  if (!isValidDocumentId(documentId) || !isSafeOriginalFileName(file.name)) {
    return null;
  }
  const documentType = getDocumentTypeForMimeType(file.type);
  if (
    !documentType ||
    (expectedDocumentType !== undefined && documentType !== expectedDocumentType) ||
    !hasDocumentFileExtension(file.name, documentType) ||
    file.size > MAX_SOURCE_BYTES
  ) {
    return null;
  }
  const inspected = await inspectDocumentContent(file, documentType);
  if (!inspected.valid) return null;
  return {
    documentId,
    documentType,
    fileName: file.name,
    mimeType: DOCUMENT_MIME_TYPES[documentType],
    sha256: await sha256Hex(inspected.bytes ?? file),
    size: file.size,
    lastModified: file.lastModified,
    blob: file,
    storedAt: Date.now(),
  };
}

/** Cheap metadata-only check for Library listing; source reads use the strict validator. */
export function inspectStoredDocumentSourceMetadata(
  value: unknown,
  expectedDocumentId: string,
): Pick<
  StoredDocumentSource,
  'documentId' | 'documentType' | 'mimeType' | 'size'
> | null {
  if (
    !isRecord(value) ||
    value.documentId !== expectedDocumentId ||
    !isValidDocumentId(expectedDocumentId) ||
    typeof value.fileName !== 'string' ||
    !isSafeOriginalFileName(value.fileName) ||
    typeof value.mimeType !== 'string' ||
    !isPositiveIntegerOrZero(value.size) ||
    !(value.blob instanceof Blob) ||
    value.blob.size !== value.size ||
    value.size > MAX_SOURCE_BYTES
  ) {
    return null;
  }
  const documentType =
    value.documentType === undefined && value.mimeType === DOCUMENT_MIME_TYPES.pdf
      ? 'pdf'
      : isDocumentType(value.documentType)
        ? value.documentType
        : null;
  if (
    !documentType ||
    getDocumentTypeForMimeType(value.mimeType) !== documentType ||
    !hasDocumentFileExtension(value.fileName, documentType) ||
    (documentType !== 'pdf' && value.size > DEFAULT_OOXML_LIMITS.maxArchiveBytes)
  ) {
    return null;
  }
  return {
    documentId: expectedDocumentId,
    documentType,
    mimeType: DOCUMENT_MIME_TYPES[documentType],
    size: value.size,
  };
}

export async function hasValidDocumentSignature(
  blob: Blob,
  documentType: DocumentType,
): Promise<boolean> {
  return (await inspectDocumentContent(blob, documentType)).valid;
}

/**
 * Office validation deliberately crosses the JSZip boundary through a dynamic
 * import. PDF-only startup and Library metadata reads therefore do not load the
 * ZIP inflater, while an Office source still receives the exact same bounded
 * package preflight used by the document adapters.
 *
 * Returning the already-read Office bytes also lets callers hash the source
 * without copying the Blob a second time during the same validation operation.
 */
async function inspectDocumentContent(
  blob: Blob,
  documentType: DocumentType,
): Promise<{ readonly valid: boolean; readonly bytes?: ArrayBuffer }> {
  if (blob.size === 0 || blob.size > MAX_SOURCE_BYTES) return { valid: false };
  if (documentType !== 'pdf' && blob.size > DEFAULT_OOXML_LIMITS.maxArchiveBytes) {
    return { valid: false };
  }
  const magic = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
  if (documentType === 'pdf') {
    return {
      valid:
        magic.length >= 5 &&
        magic[0] === 0x25 &&
        magic[1] === 0x50 &&
        magic[2] === 0x44 &&
        magic[3] === 0x46 &&
        magic[4] === 0x2d,
    };
  }
  if (
    magic.length < 4 ||
    magic[0] !== 0x50 ||
    magic[1] !== 0x4b ||
    magic[2] !== 0x03 ||
    magic[3] !== 0x04
  ) {
    return { valid: false };
  }

  try {
    const bytes = await blob.arrayBuffer();
    const { OoxmlPackage } = await import('../documents/ooxml/package.ts');
    await OoxmlPackage.open(new Uint8Array(bytes), documentType);
    return { valid: true, bytes };
  } catch {
    return { valid: false };
  }
}

function isSafeOriginalFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !/\p{C}/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveIntegerOrZero(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export type { LegacyStoredPdfFileShape };
