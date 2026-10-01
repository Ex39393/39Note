import type { OoxmlParserLimits } from './limits';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const MAX_EOCD_SEARCH = 65_535 + 22;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const SUPPORTED_GENERAL_PURPOSE_FLAGS = 0x080e;

export interface ZipEntryMetadata {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressionMethod: 0 | 8;
  readonly crc32: number;
  readonly isDirectory: boolean;
  readonly localHeaderOffset: number;
  readonly dataOffset: number;
}

export interface ZipPreflightResult {
  readonly entries: readonly ZipEntryMetadata[];
  readonly entriesByName: ReadonlyMap<string, ZipEntryMetadata>;
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
}

export class OoxmlSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OoxmlSecurityError';
    this.code = code;
  }
}

/** Reads ZIP metadata only; no archive entry is decompressed during preflight. */
export function preflightZipArchive(
  bytes: Uint8Array,
  limits: OoxmlParserLimits,
): ZipPreflightResult {
  if (bytes.byteLength < 22 || bytes.byteLength > limits.maxArchiveBytes) {
    throw securityError(
      'archive-size',
      'The Office archive size is outside the supported bounds.',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw securityError(
      'zip-structure',
      'The Office file has no valid ZIP central directory.',
    );
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntryCount = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || diskEntryCount !== entryCount) {
    throw securityError('multi-disk', 'Multi-disk Office archives are not supported.');
  }
  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw securityError(
      'zip64',
      'ZIP64 Office archives are outside the local reader limits.',
    );
  }
  if (entryCount === 0 || entryCount > limits.maxEntries) {
    throw securityError('entry-count', 'The Office archive contains too many entries.');
  }
  if (eocdOffset + 22 + commentLength !== bytes.byteLength) {
    throw securityError(
      'zip-trailing-data',
      'The Office archive contains unexpected trailing data.',
    );
  }
  if (
    centralDirectoryOffset + centralDirectorySize > eocdOffset ||
    centralDirectoryOffset < 0
  ) {
    throw securityError(
      'zip-structure',
      'The Office archive central directory is invalid.',
    );
  }

  const entries: ZipEntryMetadata[] = [];
  const entriesByName = new Map<string, ZipEntryMetadata>();
  const caseFoldedNames = new Set<string>();
  const localRanges: Array<{ readonly start: number; readonly end: number }> = [];
  let offset = centralDirectoryOffset;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    ensureReadable(view, offset, 46);
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) {
      throw securityError(
        'zip-structure',
        'The Office archive central directory is malformed.',
      );
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const recordLength = 46 + fileNameLength + extraLength + entryCommentLength;
    ensureReadable(view, offset, recordLength);

    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw securityError(
        'encrypted-entry',
        'Encrypted Office archive entries are not supported.',
      );
    }
    if ((flags & ~SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0) {
      throw securityError(
        'zip-flags',
        'The Office archive uses unsupported ZIP entry flags.',
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw securityError(
        'compression-method',
        'The Office archive uses an unsupported compression method.',
      );
    }
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw securityError(
        'zip64',
        'ZIP64 Office entries are outside the local reader limits.',
      );
    }
    if (
      compressedSize > limits.maxEntryCompressedBytes ||
      uncompressedSize > limits.maxEntryUncompressedBytes
    ) {
      throw securityError(
        'entry-size',
        'An Office archive entry exceeds the supported size.',
      );
    }
    if (
      uncompressedSize >= limits.compressionRatioFloorBytes &&
      uncompressedSize / Math.max(1, compressedSize) > limits.maxCompressionRatio
    ) {
      throw securityError(
        'compression-ratio',
        'An Office archive entry has an unsafe compression ratio.',
      );
    }

    const nameBytes = bytes.subarray(offset + 46, offset + 46 + fileNameLength);
    const name = decodeEntryName(nameBytes, (flags & FLAG_UTF8) !== 0);
    assertSafeEntryPath(name, limits.maxPathLength);
    const foldedName = name.normalize('NFC').toLocaleLowerCase('en-US');
    if (entriesByName.has(name) || caseFoldedNames.has(foldedName)) {
      throw securityError(
        'duplicate-entry',
        'The Office archive contains duplicate entry names.',
      );
    }
    caseFoldedNames.add(foldedName);
    assertNotSymbolicLink(view.getUint16(offset + 4, true), externalAttributes);

    const local = validateLocalEntry(bytes, view, centralDirectoryOffset, {
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    localRanges.push({ start: localHeaderOffset, end: local.endOffset });

    totalCompressedBytes += compressedSize;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      throw securityError(
        'expanded-size',
        'The Office archive expands beyond the supported total size.',
      );
    }

    const metadata: ZipEntryMetadata = {
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc32,
      isDirectory: name.endsWith('/'),
      localHeaderOffset,
      dataOffset: local.dataOffset,
    };
    entries.push(metadata);
    entriesByName.set(name, metadata);
    offset += recordLength;
  }

  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw securityError(
      'zip-structure',
      'The Office archive central directory length is inconsistent.',
    );
  }
  localRanges.sort((first, second) => first.start - second.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw securityError(
        'overlapping-entry',
        'The Office archive contains overlapping ZIP entries.',
      );
    }
  }

  return {
    entries,
    entriesByName,
    totalCompressedBytes,
    totalUncompressedBytes,
  };
}

export function assertSafeEntryPath(name: string, maxLength: number): void {
  if (
    !name ||
    name.length > maxLength ||
    name.includes('\\') ||
    containsAsciiControlCharacter(name)
  ) {
    throw securityError(
      'entry-path',
      'The Office archive contains an unsafe entry path.',
    );
  }
  if (
    name.startsWith('/') ||
    name.includes(':') ||
    name.includes('?') ||
    name.includes('#')
  ) {
    throw securityError(
      'entry-path',
      'The Office archive contains an absolute entry path.',
    );
  }
  const parts = name.split('/');
  const effectiveParts = name.endsWith('/') ? parts.slice(0, -1) : parts;
  if (
    effectiveParts.length === 0 ||
    effectiveParts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw securityError(
      'entry-path',
      'The Office archive contains a traversing entry path.',
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    throw securityError(
      'entry-path',
      'The Office archive contains an invalid escaped entry path.',
    );
  }
  const decodedParts = decoded.endsWith('/')
    ? decoded.slice(0, -1).split('/')
    : decoded.split('/');
  if (
    decoded.length > maxLength ||
    /[\\?#:]/u.test(decoded) ||
    containsAsciiControlCharacter(decoded) ||
    decoded.startsWith('/') ||
    decodedParts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw securityError(
      'entry-path',
      'The Office archive contains an unsafe escaped entry path.',
    );
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function findEndOfCentralDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (
      view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY &&
      offset + 22 + view.getUint16(offset + 20, true) === view.byteLength
    ) {
      return offset;
    }
  }
  return -1;
}

function validateLocalEntry(
  bytes: Uint8Array,
  view: DataView,
  centralDirectoryOffset: number,
  expected: {
    readonly name: string;
    readonly flags: number;
    readonly compressionMethod: number;
    readonly crc32: number;
    readonly compressedSize: number;
    readonly uncompressedSize: number;
    readonly localHeaderOffset: number;
  },
): { readonly dataOffset: number; readonly endOffset: number } {
  ensureReadable(view, expected.localHeaderOffset, 30);
  if (
    expected.localHeaderOffset >= centralDirectoryOffset ||
    view.getUint32(expected.localHeaderOffset, true) !== LOCAL_FILE_HEADER
  ) {
    throw securityError(
      'local-header',
      'The Office archive contains an invalid local ZIP header.',
    );
  }
  const flags = view.getUint16(expected.localHeaderOffset + 6, true);
  const compressionMethod = view.getUint16(expected.localHeaderOffset + 8, true);
  const crc32 = view.getUint32(expected.localHeaderOffset + 14, true);
  const compressedSize = view.getUint32(expected.localHeaderOffset + 18, true);
  const uncompressedSize = view.getUint32(expected.localHeaderOffset + 22, true);
  const fileNameLength = view.getUint16(expected.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(expected.localHeaderOffset + 28, true);
  const headerLength = 30 + fileNameLength + extraLength;
  ensureReadable(view, expected.localHeaderOffset, headerLength);
  if (flags !== expected.flags || compressionMethod !== expected.compressionMethod) {
    throw securityError(
      'local-header',
      'The ZIP local header disagrees with the central directory.',
    );
  }
  const localName = decodeEntryName(
    bytes.subarray(
      expected.localHeaderOffset + 30,
      expected.localHeaderOffset + 30 + fileNameLength,
    ),
    (flags & FLAG_UTF8) !== 0,
  );
  if (localName !== expected.name) {
    throw securityError(
      'local-header',
      'The ZIP local filename disagrees with the central directory.',
    );
  }
  const usesDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (
    (!usesDescriptor &&
      (crc32 !== expected.crc32 ||
        compressedSize !== expected.compressedSize ||
        uncompressedSize !== expected.uncompressedSize)) ||
    (usesDescriptor &&
      ((crc32 !== 0 && crc32 !== expected.crc32) ||
        (compressedSize !== 0 && compressedSize !== expected.compressedSize) ||
        (uncompressedSize !== 0 && uncompressedSize !== expected.uncompressedSize)))
  ) {
    throw securityError(
      'local-header',
      'The ZIP local sizes disagree with the central directory.',
    );
  }

  const dataOffset = expected.localHeaderOffset + headerLength;
  let endOffset = dataOffset + expected.compressedSize;
  if (!Number.isSafeInteger(endOffset) || endOffset > centralDirectoryOffset) {
    throw securityError(
      'zip-structure',
      'An Office archive entry overlaps the central directory.',
    );
  }
  if (usesDescriptor) {
    ensureReadable(view, endOffset, 12);
    const hasSignature = view.getUint32(endOffset, true) === DATA_DESCRIPTOR;
    const descriptorOffset = endOffset + (hasSignature ? 4 : 0);
    ensureReadable(view, descriptorOffset, 12);
    if (
      view.getUint32(descriptorOffset, true) !== expected.crc32 ||
      view.getUint32(descriptorOffset + 4, true) !== expected.compressedSize ||
      view.getUint32(descriptorOffset + 8, true) !== expected.uncompressedSize
    ) {
      throw securityError(
        'data-descriptor',
        'The ZIP data descriptor is inconsistent.',
      );
    }
    endOffset = descriptorOffset + 12;
    if (endOffset > centralDirectoryOffset) {
      throw securityError(
        'zip-structure',
        'An Office archive descriptor overlaps the central directory.',
      );
    }
  }
  return { dataOffset, endOffset };
}

function assertNotSymbolicLink(
  versionMadeBy: number,
  externalAttributes: number,
): void {
  const hostSystem = versionMadeBy >>> 8;
  if (hostSystem !== 3) return;
  const unixFileType = (externalAttributes >>> 16) & 0xf000;
  if (unixFileType === 0xa000) {
    throw securityError(
      'symbolic-link',
      'Symbolic links are not valid Office package parts.',
    );
  }
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((value) => value > 0x7f)) {
    throw securityError(
      'entry-encoding',
      'Non-UTF-8 Office entry names are not supported.',
    );
  }
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'ascii', { fatal: true }).decode(bytes);
  } catch {
    throw securityError(
      'entry-encoding',
      'An Office archive entry name is not valid text.',
    );
  }
}

function ensureReadable(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw securityError(
      'zip-structure',
      'The Office archive contains an invalid ZIP offset.',
    );
  }
  if (offset + length > view.byteLength) {
    throw securityError(
      'zip-structure',
      'The Office archive ends inside a central-directory record.',
    );
  }
}

function securityError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
