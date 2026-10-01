import {
  getDocumentTypeForMimeType,
  getDocumentMimeType,
  hasDocumentFileExtension,
  type DocumentType,
} from '../types/document';
import { DocxAdapter } from './docx/DocxAdapter';
import { DEFAULT_OOXML_LIMITS } from './ooxml/limits';
import { detectOoxmlTypeFromEntries } from './ooxml/package';
import { preflightZipArchive } from './ooxml/zipPreflight';
import { PdfAdapter } from './pdf/PdfAdapter';
import { PptxAdapter } from './pptx/PptxAdapter';
import type { DocumentAdapter, DocumentSource, ValidatedDocumentSource } from './types';

export class DocumentFormatError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentFormatError';
    this.code = code;
  }
}

export const documentAdapterRegistry = Object.freeze({
  pdf: new PdfAdapter(),
  pptx: new PptxAdapter(),
  docx: new DocxAdapter(),
}) satisfies Readonly<Record<DocumentType, DocumentAdapter>>;

export function getDocumentAdapter(documentType: DocumentType): DocumentAdapter {
  return documentAdapterRegistry[documentType];
}

export function validateDocumentSource(
  source: DocumentSource,
): ValidatedDocumentSource {
  if (!source.documentId.trim() || source.documentId.length > 512) {
    throw formatError('document-id', 'The document identity is missing or invalid.');
  }
  if (!source.fileName.trim() || source.fileName.length > 1_024) {
    throw formatError('file-name', 'The document filename is missing or invalid.');
  }
  if (!(source.bytes instanceof Uint8Array) || source.bytes.byteLength === 0) {
    throw formatError('empty-source', 'The document source is empty.');
  }
  const claimedType = getDocumentTypeForMimeType(source.mimeType);
  if (!claimedType) {
    throw formatError('mime-type', 'The document MIME type is not supported.');
  }
  if (!hasDocumentFileExtension(source.fileName, claimedType)) {
    throw formatError(
      'extension-mismatch',
      'The filename extension does not match the claimed document type.',
    );
  }

  if (hasPdfSignature(source.bytes)) {
    if (claimedType !== 'pdf') {
      throw formatError(
        'signature-mismatch',
        'The PDF signature does not match the claimed document type.',
      );
    }
    return {
      ...source,
      documentType: 'pdf',
      mimeType: getDocumentMimeType('pdf'),
      validation: { signature: 'pdf' },
    };
  }
  if (claimedType === 'pdf') {
    throw formatError(
      'signature-mismatch',
      'The claimed PDF does not have a PDF signature.',
    );
  }

  const preflight = preflightZipArchive(source.bytes, DEFAULT_OOXML_LIMITS);
  const detectedType = detectOoxmlTypeFromEntries(preflight.entriesByName);
  if (!detectedType || detectedType !== claimedType) {
    throw formatError(
      'container-mismatch',
      'The OOXML container does not match its MIME type and filename.',
    );
  }
  return {
    ...source,
    documentType: detectedType,
    mimeType: getDocumentMimeType(detectedType),
    validation: {
      signature: 'ooxml-zip',
      entryNames: preflight.entries.map((entry) => entry.name),
    },
  };
}

export async function selectDocumentAdapter(source: DocumentSource): Promise<{
  readonly adapter: DocumentAdapter;
  readonly source: ValidatedDocumentSource;
}> {
  const validated = validateDocumentSource(source);
  return {
    adapter: documentAdapterRegistry[validated.documentType],
    source: validated,
  };
}

export async function openDocumentSource(source: DocumentSource) {
  const selected = await selectDocumentAdapter(source);
  return selected.adapter.open(selected.source);
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function formatError(code: string, message: string): DocumentFormatError {
  return new DocumentFormatError(code, message);
}
