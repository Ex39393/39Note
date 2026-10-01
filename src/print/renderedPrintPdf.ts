import { isValidDocumentId } from '../utils/documentId.ts';
import { sha256Hex } from '../sync/hash.ts';
import type {
  PrintDraftRecord,
  RenderedPrintPdfDescriptor,
  RenderedPrintPdfState,
  StoredRenderedPrintPdf,
} from '../types/productivity.ts';
import { createPrintDraftHash } from './printDraftModel.ts';

const PRINT_PDF_MIME_TYPE = 'application/pdf' as const;
const MAX_PRINT_PDF_BYTES = 512 * 1024 * 1024;
const PDF_HEADER_SCAN_BYTES = 1_024;
const PDF_TRAILER_SCAN_BYTES = 65_536;

export interface RenderedPrintPdfReplacementGateway {
  /** Returns a fully validated artifact, including its Blob SHA-256. */
  load(): Promise<StoredRenderedPrintPdf | null>;
  /** Durably stores the already validated candidate. */
  save(artifact: StoredRenderedPrintPdf): Promise<void>;
  remove(): Promise<void>;
}

export async function createStoredRenderedPrintPdf(
  documentId: string,
  documentTitle: string,
  draft: PrintDraftRecord,
  file: Blob,
  now = Date.now(),
  currentSourceFingerprint = draft.sourceFingerprint,
): Promise<StoredRenderedPrintPdf> {
  if (
    !isValidDocumentId(documentId) ||
    draft.documentId !== documentId ||
    !Number.isFinite(now) ||
    now < 0
  ) {
    throw new Error('The saved Print PDF does not match this paper.');
  }
  await assertValidPrintPdfBlob(file);
  const blob =
    file.type === PRINT_PDF_MIME_TYPE
      ? file
      : new Blob([file], { type: PRINT_PDF_MIME_TYPE });
  return {
    kind: 'rendered-print-pdf',
    documentId,
    fileName: createRenderedPrintPdfFileName(documentTitle),
    mimeType: PRINT_PDF_MIME_TYPE,
    size: blob.size,
    sha256: await sha256Hex(blob),
    renderedFromDraftHash: await createPrintDraftHash(draft, currentSourceFingerprint),
    createdAt: now,
    storedAt: now,
    blob,
  };
}

export async function validateStoredRenderedPrintPdf(
  value: unknown,
  expectedDocumentId?: string,
): Promise<StoredRenderedPrintPdf | null> {
  if (!isRecord(value) || !(value.blob instanceof Blob)) return null;
  if (
    value.kind !== 'rendered-print-pdf' ||
    typeof value.documentId !== 'string' ||
    !isValidDocumentId(value.documentId) ||
    (expectedDocumentId !== undefined && value.documentId !== expectedDocumentId) ||
    !isSafePrintFileName(value.fileName) ||
    value.mimeType !== PRINT_PDF_MIME_TYPE ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) <= 0 ||
    value.size !== value.blob.size ||
    !isSha256(value.sha256) ||
    !isSha256(value.renderedFromDraftHash) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.storedAt) ||
    (value.fileId !== undefined && !isSafeDriveId(value.fileId))
  ) {
    return null;
  }
  try {
    await assertValidPrintPdfBlob(value.blob);
    if ((await sha256Hex(value.blob)) !== value.sha256) return null;
  } catch {
    return null;
  }
  return {
    kind: 'rendered-print-pdf',
    documentId: value.documentId,
    fileName: value.fileName,
    mimeType: PRINT_PDF_MIME_TYPE,
    size: value.size,
    sha256: value.sha256,
    renderedFromDraftHash: value.renderedFromDraftHash,
    createdAt: value.createdAt,
    storedAt: value.storedAt,
    blob: value.blob,
    ...(value.fileId ? { fileId: value.fileId } : {}),
  };
}

/**
 * Replaces a saved Print PDF only after the durable read-back proves that the
 * selected bytes and descriptor became authoritative. The prior artifact is
 * restored and verified if any write/read-back step fails.
 */
export async function replaceAndVerifyStoredRenderedPrintPdf(
  candidate: StoredRenderedPrintPdf,
  gateway: RenderedPrintPdfReplacementGateway,
): Promise<StoredRenderedPrintPdf> {
  const validatedCandidate = await validateStoredRenderedPrintPdf(
    candidate,
    candidate.documentId,
  );
  if (!validatedCandidate) {
    throw new Error('The selected Print PDF failed integrity validation.');
  }
  const previous = await gateway.load();
  try {
    await gateway.save(validatedCandidate);
    const persisted = await gateway.load();
    if (!persisted || !sameStoredRenderedPrintPdf(persisted, validatedCandidate)) {
      throw new Error('The stored replacement did not match the selected Print PDF.');
    }
    return persisted;
  } catch (replacementError) {
    try {
      if (previous) await gateway.save(previous);
      else await gateway.remove();
      const restored = await gateway.load();
      if (!sameStoredRenderedPrintPdf(restored, previous)) {
        throw new Error('The previous saved Print PDF could not be verified.');
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [replacementError, rollbackError],
        'The Print PDF replacement failed and the previous artifact could not be restored safely.',
      );
    }
    throw new Error(
      previous
        ? 'The replacement could not be verified. The previous saved Print PDF was restored; try again.'
        : 'The selected Print PDF could not be verified after saving; try again.',
      { cause: replacementError },
    );
  }
}

export function sameStoredRenderedPrintPdf(
  first: StoredRenderedPrintPdf | null,
  second: StoredRenderedPrintPdf | null,
): boolean {
  if (!first || !second) return first === second;
  return (
    first.kind === second.kind &&
    first.documentId === second.documentId &&
    first.fileName === second.fileName &&
    first.mimeType === second.mimeType &&
    first.size === second.size &&
    first.sha256 === second.sha256 &&
    first.renderedFromDraftHash === second.renderedFromDraftHash &&
    first.createdAt === second.createdAt &&
    first.storedAt === second.storedAt &&
    first.fileId === second.fileId
  );
}

export async function resolveStoredRenderedPrintPdfForDownload(
  expected: StoredRenderedPrintPdf,
  load: () => Promise<StoredRenderedPrintPdf | null>,
): Promise<StoredRenderedPrintPdf> {
  const persisted = await load();
  if (!persisted || !sameStoredRenderedPrintPdf(persisted, expected)) {
    throw new Error(
      'The saved Print PDF changed in local storage. Review its status and try again.',
    );
  }
  return persisted;
}

export async function classifyRenderedPrintPdf(
  draft: PrintDraftRecord,
  artifact: Pick<RenderedPrintPdfDescriptor, 'renderedFromDraftHash'> | null,
  currentSourceFingerprint = draft.sourceFingerprint,
): Promise<RenderedPrintPdfState> {
  if (!artifact) return 'missing';
  return artifact.renderedFromDraftHash ===
    (await createPrintDraftHash(draft, currentSourceFingerprint))
    ? 'current'
    : 'stale';
}

export function createRenderedPrintPdfFileName(documentTitle: string): string {
  const base = replaceAsciiControlCharacters(documentTitle, ' ')
    .replace(/\.(?:pdf|pptx|docx)$/iu, '')
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 220)
    .trim();
  return `${base || 'Paper'} - Print.pdf`;
}

export async function assertValidPrintPdfBlob(blob: Blob): Promise<void> {
  if (blob.size <= 0 || blob.size > MAX_PRINT_PDF_BYTES) {
    throw new Error('The selected Print PDF is empty or too large.');
  }
  if (blob.type && blob.type.toLowerCase() !== PRINT_PDF_MIME_TYPE) {
    throw new Error('Select the PDF saved by the browser print dialog.');
  }
  const header = new Uint8Array(
    await blob.slice(0, Math.min(blob.size, PDF_HEADER_SCAN_BYTES)).arrayBuffer(),
  );
  if (findAscii(header, '%PDF-') < 0) {
    throw new Error('The selected file is not a valid PDF.');
  }
  const trailer = new Uint8Array(
    await blob
      .slice(Math.max(0, blob.size - PDF_TRAILER_SCAN_BYTES), blob.size)
      .arrayBuffer(),
  );
  if (findAscii(trailer, '%%EOF') < 0) {
    throw new Error('The selected PDF is incomplete.');
  }
}

function findAscii(bytes: Uint8Array, value: string): number {
  const target = new TextEncoder().encode(value);
  outer: for (let offset = 0; offset <= bytes.length - target.length; offset += 1) {
    for (let index = 0; index < target.length; index += 1) {
      if (bytes[offset + index] !== target[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function isSafePrintFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value.endsWith(' - Print.pdf') &&
    !/[\\/]/u.test(value) &&
    !containsAsciiControlCharacter(value)
  );
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f);
}

function replaceAsciiControlCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) =>
    character.charCodeAt(0) <= 0x1f ? replacement : character,
  ).join('');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeDriveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
