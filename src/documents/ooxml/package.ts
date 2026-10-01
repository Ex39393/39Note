import type JSZipType from 'jszip';
import type { DocumentType } from '../../types/document';
import {
  DEFAULT_OOXML_LIMITS,
  mergeOoxmlLimits,
  type OoxmlParserLimits,
} from './limits';
import {
  parseRelationships,
  relationshipPartName,
  type OoxmlRelationship,
} from './relationships';
import {
  getXmlAttribute,
  parseBoundedXml,
  xmlLocalName,
  type XmlElementNode,
} from './xml';
import {
  assertSafeEntryPath,
  OoxmlSecurityError,
  preflightZipArchive,
  type ZipEntryMetadata,
  type ZipPreflightResult,
} from './zipPreflight';

const CONTENT_TYPES_PART = '[Content_Types].xml';
const PPTX_MAIN_PART = 'ppt/presentation.xml';
const DOCX_MAIN_PART = 'word/document.xml';

const PPTX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const PROHIBITED_ENTRY_PATTERNS = [
  /(?:^|\/)vbaProject\.bin$/iu,
  /(?:^|\/)activeX(?:\/|$)/iu,
  /(?:^|\/)embeddings(?:\/|$)/iu,
  /(?:^|\/)customUI(?:\/|$)/iu,
  /(?:^|\/)controls?(?:\/|$)/iu,
] as const;

const PROHIBITED_CONTENT_TYPE_MARKERS = [
  'macroenabled',
  'vbaproject',
  'oleobject',
  'activex',
] as const;

const SAFE_IMAGE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const SAFE_IMAGE_EXTENSION_CONTENT_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
] as const);

const SAFE_NORMALIZABLE_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

const OFFICE_IMAGE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/image',
]);

const SAFE_UNSUPPORTED_IMAGE_CONTENT_TYPES = new Set(['image/svg+xml']);

const SAFE_PASSIVE_SVG_ELEMENTS = new Set([
  'circle',
  'desc',
  'ellipse',
  'g',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'title',
]);

const UNSAFE_SVG_VALUE_PATTERN =
  /(?:url\s*\(|@import|expression\s*\(|(?:data|file|ftp|https?|javascript|vbscript):)/iu;

interface ContentTypeMap {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

export interface OoxmlImageResource {
  readonly path: string;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly byteSize: number;
  load(): Promise<Uint8Array>;
}

export interface OoxmlImageValidation {
  readonly path: string;
  readonly byteSize: number;
  readonly declaredMimeType: string;
  readonly mimeType: string;
  readonly disposition: 'supported' | 'safe-unsupported';
  readonly format: string;
  readonly metadataNormalized: boolean;
}

export interface OoxmlImageValidationOptions {
  /** The caller proved that an internal OOXML relationship declares this part as an image. */
  readonly officeImageRelationship?: boolean;
}

export function isOfficeImageRelationshipType(type: string): boolean {
  return OFFICE_IMAGE_RELATIONSHIP_TYPES.has(type);
}

export class OoxmlPackage {
  readonly documentType: Extract<DocumentType, 'pptx' | 'docx'>;
  readonly limits: Readonly<OoxmlParserLimits>;
  readonly preflight: ZipPreflightResult;
  readonly mainPart: string;

  readonly #zip: JSZipType;
  readonly #contentTypes: ContentTypeMap;
  readonly #xmlCache = new Map<string, Promise<XmlElementNode>>();
  readonly #relationshipCache = new Map<
    string,
    Promise<ReadonlyMap<string, OoxmlRelationship>>
  >();
  readonly #imageResourceCache = new Map<string, OoxmlImageResource>();

  private constructor(
    documentType: Extract<DocumentType, 'pptx' | 'docx'>,
    zip: JSZipType,
    preflight: ZipPreflightResult,
    limits: Readonly<OoxmlParserLimits>,
    contentTypes: ContentTypeMap,
  ) {
    this.documentType = documentType;
    this.#zip = zip;
    this.preflight = preflight;
    this.limits = limits;
    this.#contentTypes = contentTypes;
    this.mainPart = documentType === 'pptx' ? PPTX_MAIN_PART : DOCX_MAIN_PART;
  }

  static async open(
    bytes: Uint8Array,
    expectedType: Extract<DocumentType, 'pptx' | 'docx'>,
    limitOverrides?: Partial<OoxmlParserLimits>,
  ): Promise<OoxmlPackage> {
    const limits = limitOverrides
      ? mergeOoxmlLimits(limitOverrides)
      : DEFAULT_OOXML_LIMITS;
    const preflight = preflightZipArchive(bytes, limits);
    assertNoActiveEntries(preflight.entries);
    if (!preflight.entriesByName.has(CONTENT_TYPES_PART)) {
      throw packageError(
        'content-types',
        'The Office archive has no content-types part.',
      );
    }
    const expectedMainPart = expectedType === 'pptx' ? PPTX_MAIN_PART : DOCX_MAIN_PART;
    if (!preflight.entriesByName.has(expectedMainPart)) {
      throw packageError(
        'container-mismatch',
        `The file is not a valid ${expectedType.toUpperCase()} package.`,
      );
    }
    const otherMainPart = expectedType === 'pptx' ? DOCX_MAIN_PART : PPTX_MAIN_PART;
    if (preflight.entriesByName.has(otherMainPart)) {
      throw packageError(
        'container-ambiguous',
        'The Office archive contains conflicting document roots.',
      );
    }

    const JSZip = (await import('jszip')).default;
    let zip: JSZipType;
    try {
      zip = await JSZip.loadAsync(bytes, {
        checkCRC32: false,
        createFolders: false,
      });
    } catch {
      throw packageError('zip-load', 'The Office ZIP container is malformed.');
    }
    const contentTypeBytes = await readZipEntry(
      zip,
      preflight.entriesByName.get(CONTENT_TYPES_PART),
      CONTENT_TYPES_PART,
      limits.maxXmlBytes,
    );
    const contentTypeRoot = parseBoundedXml(
      contentTypeBytes,
      CONTENT_TYPES_PART,
      limits,
    );
    const contentTypes = parseContentTypes(contentTypeRoot, limits);
    assertMainContentType(contentTypes, expectedType, expectedMainPart);
    return new OoxmlPackage(expectedType, zip, preflight, limits, contentTypes);
  }

  hasPart(partName: string): boolean {
    return this.preflight.entriesByName.has(partName);
  }

  getPartMetadata(partName: string): ZipEntryMetadata | undefined {
    return this.preflight.entriesByName.get(partName);
  }

  async readXml(partName: string): Promise<XmlElementNode> {
    const cached = this.#xmlCache.get(partName);
    if (cached) return cached;
    const pending = this.#readXmlUncached(partName);
    this.#xmlCache.set(partName, pending);
    try {
      return await pending;
    } catch (error) {
      this.#xmlCache.delete(partName);
      throw error;
    }
  }

  async getRelationships(
    sourcePart: string,
  ): Promise<ReadonlyMap<string, OoxmlRelationship>> {
    const cached = this.#relationshipCache.get(sourcePart);
    if (cached) return cached;
    const pending = this.#readRelationships(sourcePart);
    this.#relationshipCache.set(sourcePart, pending);
    try {
      return await pending;
    } catch (error) {
      this.#relationshipCache.delete(sourcePart);
      throw error;
    }
  }

  createImageResource(
    partName: string,
    options: OoxmlImageValidationOptions = {},
  ): OoxmlImageResource {
    const cacheKey = `${options.officeImageRelationship ? 'related' : 'strict'}:${partName}`;
    const cached = this.#imageResourceCache.get(cacheKey);
    if (cached) return cached;
    const metadata = this.preflight.entriesByName.get(partName);
    if (
      !metadata ||
      metadata.isDirectory ||
      metadata.uncompressedSize > this.limits.maxImageBytes
    ) {
      throw packageError(
        'image-size',
        'An Office image is missing or exceeds the image limit.',
      );
    }
    const mimeType = this.#getContentType(partName);
    if (!mimeType || !SAFE_IMAGE_CONTENT_TYPES.has(mimeType)) {
      throw unsupportedImageTypeError(mimeType);
    }
    let loaded: Promise<Uint8Array> | undefined;
    let canonicalMimeType = mimeType as OoxmlImageResource['mimeType'];
    const resource: OoxmlImageResource = {
      path: partName,
      get mimeType() {
        return canonicalMimeType;
      },
      byteSize: metadata.uncompressedSize,
      load: async () => {
        loaded ??= readZipEntry(
          this.#zip,
          metadata,
          partName,
          this.limits.maxImageBytes,
        ).then((bytes) => {
          const resolved = resolveSupportedImageType(
            bytes,
            mimeType,
            partName,
            options.officeImageRelationship === true,
            this.limits,
          );
          canonicalMimeType = resolved.mimeType;
          return bytes;
        });
        return loaded;
      },
    };
    this.#imageResourceCache.set(cacheKey, resource);
    return resource;
  }

  async validateImagePart(
    partName: string,
    options: OoxmlImageValidationOptions = {},
  ): Promise<OoxmlImageValidation> {
    const metadata = this.preflight.entriesByName.get(partName);
    if (
      !metadata ||
      metadata.isDirectory ||
      metadata.uncompressedSize > this.limits.maxImageBytes
    ) {
      throw packageError(
        'image-size',
        'An Office image is missing or exceeds the image limit.',
      );
    }
    const mimeType = this.#getContentType(partName);
    if (mimeType && SAFE_IMAGE_CONTENT_TYPES.has(mimeType)) {
      const resource = this.createImageResource(partName, options);
      await resource.load();
      return {
        path: partName,
        byteSize: metadata.uncompressedSize,
        declaredMimeType: mimeType,
        mimeType: resource.mimeType,
        disposition: 'supported',
        format: imageFormatLabel(resource.mimeType),
        metadataNormalized: resource.mimeType !== mimeType,
      };
    }
    if (mimeType && SAFE_UNSUPPORTED_IMAGE_CONTENT_TYPES.has(mimeType)) {
      if (!partName.toLocaleLowerCase('en-US').endsWith('.svg')) {
        throw packageError(
          'image-signature',
          'An Office SVG image does not match its declared file extension.',
        );
      }
      const bytes = await readZipEntry(
        this.#zip,
        metadata,
        partName,
        this.limits.maxImageBytes,
      );
      assertSafePassiveSvg(bytes, partName, this.limits);
      return {
        path: partName,
        byteSize: metadata.uncompressedSize,
        declaredMimeType: mimeType,
        mimeType,
        disposition: 'safe-unsupported',
        format: imageFormatLabel(mimeType),
        metadataNormalized: false,
      };
    }
    throw unsupportedImageTypeError(mimeType);
  }

  async #readXmlUncached(partName: string): Promise<XmlElementNode> {
    const metadata = this.preflight.entriesByName.get(partName);
    if (
      !metadata ||
      metadata.isDirectory ||
      metadata.uncompressedSize > this.limits.maxXmlBytes
    ) {
      throw packageError(
        'xml-part',
        `Required OOXML part ${partName} is missing or oversized.`,
      );
    }
    const bytes = await readZipEntry(
      this.#zip,
      metadata,
      partName,
      this.limits.maxXmlBytes,
    );
    return parseBoundedXml(bytes, partName, this.limits);
  }

  async #readRelationships(
    sourcePart: string,
  ): Promise<ReadonlyMap<string, OoxmlRelationship>> {
    const relationshipsPart = relationshipPartName(sourcePart);
    if (!this.hasPart(relationshipsPart)) return new Map();
    const root = await this.readXml(relationshipsPart);
    return parseRelationships(root, sourcePart, this.limits);
  }

  #getContentType(partName: string): string | undefined {
    const override = this.#contentTypes.overrides.get(`/${partName}`);
    if (override) return override;
    const extensionIndex = partName.lastIndexOf('.');
    if (extensionIndex < 0) return undefined;
    return this.#contentTypes.defaults.get(
      partName.slice(extensionIndex + 1).toLocaleLowerCase(),
    );
  }
}

export function detectOoxmlTypeFromEntries(
  entries: ReadonlyMap<string, ZipEntryMetadata>,
): Extract<DocumentType, 'pptx' | 'docx'> | null {
  const hasPptx = entries.has(PPTX_MAIN_PART);
  const hasDocx = entries.has(DOCX_MAIN_PART);
  if (hasPptx === hasDocx) return null;
  return hasPptx ? 'pptx' : 'docx';
}

function parseContentTypes(
  root: XmlElementNode,
  limits: Readonly<OoxmlParserLimits>,
): ContentTypeMap {
  if (xmlLocalName(root) !== 'Types') {
    throw packageError(
      'content-types',
      'The Office content-types part has an invalid root.',
    );
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const foldedOverrideNames = new Set<string>();
  let mappingCount = 0;
  for (const child of root.children) {
    if (child.type !== 'element') continue;
    const localName = xmlLocalName(child);
    const contentType = getXmlAttribute(child, 'ContentType');
    if (
      !contentType ||
      contentType.length > 512 ||
      containsAsciiControlCharacter(contentType) ||
      PROHIBITED_CONTENT_TYPE_MARKERS.some((marker) =>
        contentType.toLocaleLowerCase('en-US').includes(marker),
      )
    ) {
      throw packageError(
        'active-content',
        'The Office document declares active or embedded content.',
      );
    }
    mappingCount += 1;
    if (mappingCount > limits.maxEntries) {
      throw packageError('content-types', 'The Office content-types map is too large.');
    }
    if (localName === 'Default') {
      const extension = getXmlAttribute(child, 'Extension')?.toLocaleLowerCase();
      if (
        !extension ||
        !/^[a-z0-9]{1,32}$/u.test(extension) ||
        defaults.has(extension)
      ) {
        throw packageError(
          'content-types',
          'The Office content-types part repeats a default mapping.',
        );
      }
      defaults.set(extension, contentType);
    } else if (localName === 'Override') {
      const partName = getXmlAttribute(child, 'PartName');
      if (!partName?.startsWith('/') || partName.endsWith('/')) {
        throw packageError(
          'content-types',
          'The Office content-types part has an unsafe override path.',
        );
      }
      const packagePath = partName.slice(1);
      assertSafeEntryPath(packagePath, limits.maxPathLength);
      const foldedName = partName.normalize('NFC').toLocaleLowerCase('en-US');
      if (foldedOverrideNames.has(foldedName)) {
        throw packageError(
          'content-types',
          'The Office content-types part repeats an override mapping.',
        );
      }
      foldedOverrideNames.add(foldedName);
      overrides.set(partName, contentType);
    } else {
      throw packageError(
        'content-types',
        'The Office content-types part contains an unknown mapping.',
      );
    }
  }
  return { defaults, overrides };
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function assertMainContentType(
  contentTypes: ContentTypeMap,
  expectedType: Extract<DocumentType, 'pptx' | 'docx'>,
  mainPart: string,
): void {
  const actual = contentTypes.overrides.get(`/${mainPart}`);
  const expected =
    expectedType === 'pptx' ? PPTX_MAIN_CONTENT_TYPE : DOCX_MAIN_CONTENT_TYPE;
  if (actual !== expected) {
    throw packageError(
      'mime-mismatch',
      `The Office main part does not declare the expected ${expectedType.toUpperCase()} content type.`,
    );
  }
}

function assertNoActiveEntries(entries: readonly ZipEntryMetadata[]): void {
  const prohibited = entries.find((entry) =>
    PROHIBITED_ENTRY_PATTERNS.some((pattern) => pattern.test(entry.name)),
  );
  if (prohibited) {
    throw packageError(
      'active-content',
      'The Office document contains prohibited active or embedded content.',
    );
  }
}

async function readZipEntry(
  zip: JSZipType,
  metadata: ZipEntryMetadata | undefined,
  partName: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!metadata || metadata.isDirectory || metadata.uncompressedSize > maximumBytes) {
    throw packageError('entry-size', `OOXML part ${partName} is missing or oversized.`);
  }
  const entry = zip.file(partName);
  if (!entry) throw packageError('entry-missing', `OOXML part ${partName} is missing.`);
  let bytes: Uint8Array;
  try {
    bytes = await entry.async('uint8array');
  } catch {
    throw packageError(
      'entry-inflate',
      `OOXML part ${partName} could not be decompressed.`,
    );
  }
  if (
    bytes.byteLength !== metadata.uncompressedSize ||
    bytes.byteLength > maximumBytes
  ) {
    throw packageError(
      'entry-size',
      `OOXML part ${partName} has an inconsistent expanded size.`,
    );
  }
  if (crc32(bytes) !== metadata.crc32) {
    throw packageError(
      'entry-crc',
      `OOXML part ${partName} failed its ZIP integrity check.`,
    );
  }
  return bytes;
}

function resolveSupportedImageType(
  bytes: Uint8Array,
  declaredMimeType: string,
  partName: string,
  officeImageRelationship: boolean,
  limits: Readonly<OoxmlParserLimits>,
): {
  readonly mimeType: OoxmlImageResource['mimeType'];
  readonly width: number;
  readonly height: number;
} {
  const declaredDimensions = readImageDimensions(bytes, declaredMimeType);
  let resolvedMimeType = declaredMimeType as OoxmlImageResource['mimeType'];
  let dimensions = declaredDimensions;

  if (!dimensions && officeImageRelationship) {
    const extensionMimeType = safeImageMimeTypeForPartExtension(partName);
    const detected = [...SAFE_NORMALIZABLE_IMAGE_CONTENT_TYPES].flatMap(
      (candidateMimeType) => {
        const candidateDimensions = readImageDimensions(bytes, candidateMimeType);
        return candidateDimensions &&
          hasCompleteNormalizableImageEnvelope(bytes, candidateMimeType)
          ? [{ mimeType: candidateMimeType, dimensions: candidateDimensions }]
          : [];
      },
    );
    // Metadata normalization is deliberately limited to a strong, unique
    // passive-image signature and a safe image extension that agrees with
    // either the declared or detected type. Unknown and polyglot signatures
    // continue to fail closed.
    if (
      detected.length === 1 &&
      extensionMimeType !== undefined &&
      (extensionMimeType === declaredMimeType ||
        extensionMimeType === detected[0].mimeType)
    ) {
      resolvedMimeType = detected[0].mimeType as OoxmlImageResource['mimeType'];
      dimensions = detected[0].dimensions;
    }
  }

  if (!dimensions) {
    throw packageError(
      'image-signature',
      'An Office image does not match its declared media type.',
    );
  }
  if (
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > limits.maxImageDimension ||
    dimensions.height > limits.maxImageDimension ||
    dimensions.width * dimensions.height > limits.maxImagePixels
  ) {
    throw packageError(
      'image-dimensions',
      'An Office image exceeds the safe decoded dimension limit.',
    );
  }
  return {
    mimeType: resolvedMimeType,
    width: dimensions.width,
    height: dimensions.height,
  };
}

function hasCompleteNormalizableImageEnvelope(
  bytes: Uint8Array,
  mimeType: string,
): boolean {
  if (mimeType === 'image/jpeg') {
    return isStructurallyCompleteJpeg(bytes);
  }
  if (mimeType === 'image/png') {
    return (
      bytes.length >= 32 &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        bytes.length - 12,
      ) === 0 &&
      ascii(bytes, bytes.length - 8, 4) === 'IEND'
    );
  }
  return false;
}

function isStructurallyCompleteJpeg(bytes: Uint8Array): boolean {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > bytes.length) return false;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      sawFrame = true;
    }
    offset += segmentLength;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerOffset = offset;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerOffset;
      break;
    }
  }
  return false;
}

function safeImageMimeTypeForPartExtension(partName: string): string | undefined {
  const extensionIndex = partName.lastIndexOf('.');
  if (extensionIndex < 0) return undefined;
  return SAFE_IMAGE_EXTENSION_CONTENT_TYPES.get(
    partName.slice(extensionIndex + 1).toLocaleLowerCase('en-US') as
      'png' | 'jpg' | 'jpeg' | 'gif' | 'webp',
  );
}

function assertSafePassiveSvg(
  bytes: Uint8Array,
  partName: string,
  limits: Readonly<OoxmlParserLimits>,
): void {
  let root: XmlElementNode;
  try {
    root = parseBoundedXml(bytes, partName, limits);
  } catch {
    throw packageError(
      'image-signature',
      'An Office SVG image is malformed or does not match its declared media type.',
    );
  }
  if (root.name !== 'svg' || root.attributes.xmlns !== 'http://www.w3.org/2000/svg') {
    throw packageError(
      'image-signature',
      'An Office SVG image is malformed or does not match its declared media type.',
    );
  }

  const dimensions = readSvgDimensions(root);
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > limits.maxImageDimension ||
    dimensions.height > limits.maxImageDimension ||
    dimensions.width * dimensions.height > limits.maxImagePixels
  ) {
    throw packageError(
      'image-dimensions',
      'An Office SVG image exceeds the safe decoded dimension limit.',
    );
  }

  const inspect = (element: XmlElementNode): void => {
    if (element !== root) {
      if (
        element.name.includes(':') ||
        !SAFE_PASSIVE_SVG_ELEMENTS.has(xmlLocalName(element))
      ) {
        throw unsafeSvgError();
      }
    }
    for (const [name, value] of Object.entries(element.attributes)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        if (
          value !== 'http://www.w3.org/2000/svg' &&
          value !== 'http://www.w3.org/1999/xlink'
        ) {
          throw unsafeSvgError();
        }
        continue;
      }
      const localName = xmlLocalName(name).toLocaleLowerCase('en-US');
      if (
        localName.startsWith('on') ||
        localName === 'href' ||
        localName === 'src' ||
        UNSAFE_SVG_VALUE_PATTERN.test(value) ||
        /[{}]/u.test(value)
      ) {
        throw unsafeSvgError();
      }
    }
    for (const child of element.children) {
      if (child.type === 'element') {
        inspect(child);
      } else if (
        child.text.trim() &&
        !['title', 'desc'].includes(xmlLocalName(element))
      ) {
        throw unsafeSvgError();
      }
    }
  };
  inspect(root);
}

function readSvgDimensions(
  root: XmlElementNode,
): { readonly width: number; readonly height: number } | null {
  const width = parseSvgLength(getXmlAttribute(root, 'width'));
  const height = parseSvgLength(getXmlAttribute(root, 'height'));
  if (width !== null && height !== null) return { width, height };
  const viewBox = getXmlAttribute(root, 'viewBox')?.trim();
  if (!viewBox) return null;
  const values = viewBox.split(/[\s,]+/u).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return { width: values[2], height: values[3] };
}

function parseSvgLength(value: string | undefined): number | null {
  if (!value || !/^(?:\d+\.?\d*|\.\d+)(?:px)?$/u.test(value.trim())) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unsafeSvgError(): OoxmlSecurityError {
  return packageError(
    'active-content',
    'This Office document contains an active or externally referenced SVG image.',
  );
}

function unsupportedImageTypeError(mimeType: string | undefined): OoxmlSecurityError {
  return packageError(
    'image-type',
    `This Office document contains an unsupported image format (${imageFormatLabel(mimeType)}).`,
  );
}

function imageFormatLabel(mimeType: string | undefined): string {
  if (mimeType === 'image/svg+xml') return 'SVG';
  if (mimeType === 'image/tiff') return 'TIFF';
  if (mimeType === 'image/vnd.ms-photo') return 'JPEG XR';
  if (mimeType === 'image/x-emf') return 'EMF';
  if (mimeType === 'image/x-wmf') return 'WMF';
  if (mimeType === 'image/png') return 'PNG';
  if (mimeType === 'image/jpeg') return 'JPEG';
  if (mimeType === 'image/gif') return 'GIF';
  if (mimeType === 'image/webp') return 'WebP';
  if (mimeType?.startsWith('image/')) {
    const subtype = mimeType.slice('image/'.length);
    if (/^[a-z0-9.+-]{1,40}$/u.test(subtype)) return subtype.toLocaleUpperCase();
  }
  return 'unknown';
}

function readImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { readonly width: number; readonly height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mimeType === 'image/png' &&
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    ascii(bytes, 12, 4) === 'IHDR'
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (
    mimeType === 'image/gif' &&
    bytes.length >= 10 &&
    (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')
  ) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (
    mimeType === 'image/jpeg' &&
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    return readJpegDimensions(bytes, view);
  }
  if (
    mimeType === 'image/webp' &&
    bytes.length >= 30 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 4) === 'WEBP'
  ) {
    const kind = ascii(bytes, 12, 4);
    if (kind === 'VP8X') {
      return {
        width: 1 + readUint24LittleEndian(bytes, 24),
        height: 1 + readUint24LittleEndian(bytes, 27),
      };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height:
          1 +
          ((bytes[22] & 0xc0) >>> 6) +
          (bytes[23] << 2) +
          ((bytes[24] & 0x0f) << 10),
      };
    }
    if (
      kind === 'VP8 ' &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }
  return null;
}

function readJpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { readonly width: number; readonly height: number } | null {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return null;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) &&
      segmentLength >= 7
    ) {
      return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function packageError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
