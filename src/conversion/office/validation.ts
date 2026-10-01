import {
  DOCUMENT_MIME_TYPES,
  getDocumentTypeForMimeType,
  hasDocumentFileExtension,
} from '../../types/document';
import type { OfficeDocumentType } from './types';

export const OFFICE_CONVERSION_ACCEPT = [
  DOCUMENT_MIME_TYPES.docx,
  DOCUMENT_MIME_TYPES.pptx,
  '.docx',
  '.pptx',
].join(',');

export class OfficeConversionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfficeConversionError';
    this.code = code;
  }
}

export function validateOfficeFileSelection(file: File): OfficeDocumentType {
  const inferred = inferOfficeDocumentType(file.name);
  if (!inferred) {
    throw new OfficeConversionError(
      'unsupported-extension',
      'Choose a modern Word (.docx) or PowerPoint (.pptx) file. Legacy .doc and .ppt files are not supported yet.',
    );
  }

  if (file.size === 0) {
    throw new OfficeConversionError('empty-file', 'The selected Office file is empty.');
  }

  const declared = getDocumentTypeForMimeType(file.type);
  if (declared && declared !== inferred) {
    throw new OfficeConversionError(
      'type-mismatch',
      'The filename and declared Office file type do not match.',
    );
  }
  if (
    file.type &&
    file.type !== 'application/octet-stream' &&
    file.type !== DOCUMENT_MIME_TYPES[inferred]
  ) {
    throw new OfficeConversionError(
      'mime-type',
      'The selected file does not have a supported Word or PowerPoint MIME type.',
    );
  }

  return inferred;
}

export function inferOfficeDocumentType(fileName: string): OfficeDocumentType | null {
  if (hasDocumentFileExtension(fileName, 'docx')) return 'docx';
  if (hasDocumentFileExtension(fileName, 'pptx')) return 'pptx';
  return null;
}

export function createConvertedPdfFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(?:docx|pptx)$/iu, '').trim();
  const baseName = withoutExtension || 'Converted document';
  return `${baseName}.pdf`;
}

export function createConvertedPdfFile(
  sourceFileName: string,
  pdfBytes: ArrayBuffer,
): File {
  const bytes = new Uint8Array(pdfBytes);
  if (!hasPdfSignature(bytes)) {
    throw new OfficeConversionError(
      'invalid-pdf',
      'The converter output failed PDF validation.',
    );
  }
  return new File([pdfBytes], createConvertedPdfFileName(sourceFileName), {
    type: DOCUMENT_MIME_TYPES.pdf,
    lastModified: Date.now(),
  });
}

export function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
