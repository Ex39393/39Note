import { Ream, type ReamConvertOptions } from 'reamkit';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {
  detectOoxmlTypeFromEntries,
  isOfficeImageRelationshipType,
  OoxmlPackage,
} from '../../documents/ooxml/package';
import { DEFAULT_OOXML_LIMITS } from '../../documents/ooxml/limits';
import { preflightZipArchive } from '../../documents/ooxml/zipPreflight';
import type {
  OfficeConversionLossSummary,
  OfficeConversionWorkerProgress,
  OfficeConversionWorkerResult,
  OfficeDocumentType,
} from './types';
import { preferUnifiedCjkUnicodeMappings } from './cjkFont';
import { sanitizeHiddenPptxShapesForConversion } from './pptxSanitizer';
import { hasPdfSignature, OfficeConversionError } from './validation';

const MAX_PDF_OUTPUT_BYTES = 256 * 1024 * 1024;
const textDecoder = new TextDecoder('utf-8', { fatal: false });

if (typeof Worker !== 'undefined') {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export interface OfficeConversionFontSet {
  readonly regular: Uint8Array;
  readonly bold?: Uint8Array;
  readonly italic?: Uint8Array;
  readonly boldItalic?: Uint8Array;
}

export interface ConvertOfficeBytesOptions {
  readonly bytes: Uint8Array;
  readonly expectedType: OfficeDocumentType;
  readonly fonts: OfficeConversionFontSet;
  /** Loaded only after parsed document text proves that a Han face is needed. */
  readonly loadCjkFont?: () => Promise<Uint8Array>;
  readonly onProgress?: (progress: OfficeConversionWorkerProgress) => void;
}

interface OfficePackageValidationResult {
  readonly unsupportedImagesOmitted: number;
  readonly metadataNormalizedImages: number;
}

export async function convertOfficeBytesToPdf({
  bytes,
  expectedType,
  fonts,
  loadCjkFont,
  onProgress,
}: ConvertOfficeBytesOptions): Promise<OfficeConversionWorkerResult> {
  onProgress?.({
    stage: 'validating',
    message: 'Checking the Office package on this device…',
  });
  const packageValidation = await validateOfficePackage(bytes, expectedType);
  const conversionBytes =
    expectedType === 'pptx'
      ? (await sanitizeHiddenPptxShapesForConversion(bytes)).bytes
      : bytes;

  onProgress?.({ stage: 'converting', message: 'Creating a local PDF…' });
  let parsed: Ream;
  try {
    parsed = Ream.parse(conversionBytes);
  } catch {
    throw new OfficeConversionError(
      'parse-failed',
      `The ${expectedType.toUpperCase()} document could not be parsed safely.`,
    );
  }
  if (parsed.format !== expectedType) {
    throw new OfficeConversionError(
      'container-mismatch',
      'The Office package contents do not match the selected filename.',
    );
  }

  const sourceText = await inspectDocumentText(parsed);
  const cjkFont = sourceText.hasHan
    ? preferUnifiedCjkUnicodeMappings(await loadRequiredCjkFont(loadCjkFont))
    : undefined;
  let converted: Awaited<ReturnType<Ream['convertWithReport']>>;
  try {
    converted = await parsed.convertWithReport('pdf', {
      // Supplying `fonts` directly disables Reamkit's per-script registry. A
      // closed local fetch adapter keeps family/script selection enabled while
      // making every possible request resolve from bundled bytes or fail shut.
      fontFetch: createBundledFontFetch(fonts, cjkFont),
      embedSource: false,
    } satisfies ReamConvertOptions);
  } catch {
    throw new OfficeConversionError(
      'conversion-failed',
      'This Office document could not be converted to PDF on this device.',
    );
  }

  onProgress?.({
    stage: 'verifying',
    message: 'Verifying the PDF and selectable text…',
  });
  const pdfBytes = converted.bytes;
  assertValidPdfEnvelope(pdfBytes);

  const verifiedPdf = await inspectPdfText(pdfBytes);
  const pdfTextCharacters = verifiedPdf.textCharacters;
  if (sourceText.characters >= 8 && pdfTextCharacters === 0) {
    throw new OfficeConversionError(
      'selectable-text-lost',
      'The source contains ordinary text, but the converted PDF has no selectable text. Nothing was added to 39Note.',
    );
  }

  return {
    pdfBytes: toTransferableArrayBuffer(pdfBytes),
    sourceType: expectedType,
    sourceTextCharacters: sourceText.characters,
    pdfTextCharacters,
    pageCount: verifiedPdf.pageCount,
    losses: summarizeLosses(
      converted.losses,
      packageValidation.unsupportedImagesOmitted,
      packageValidation.metadataNormalizedImages,
    ),
  };
}

async function validateOfficePackage(
  bytes: Uint8Array,
  expectedType: OfficeDocumentType,
): Promise<OfficePackageValidationResult> {
  let preflight;
  try {
    preflight = preflightZipArchive(bytes, DEFAULT_OOXML_LIMITS);
  } catch (error) {
    throw normalizeSecurityError(error);
  }
  if (detectOoxmlTypeFromEntries(preflight.entriesByName) !== expectedType) {
    throw new OfficeConversionError(
      'container-mismatch',
      `The file is not a valid ${expectedType.toUpperCase()} package.`,
    );
  }

  let pkg: OoxmlPackage;
  try {
    pkg = await OoxmlPackage.open(bytes, expectedType);
    const xmlParts = pkg.preflight.entries
      .filter(
        (entry) =>
          !entry.isDirectory &&
          (entry.name.toLocaleLowerCase('en-US').endsWith('.xml') ||
            entry.name.toLocaleLowerCase('en-US').endsWith('.rels')),
      )
      .map((entry) => pkg.readXml(entry.name));
    await Promise.all(xmlParts);

    const relationshipSources = pkg.preflight.entries
      .map((entry) => relationshipSourceForPart(entry.name))
      .filter((part): part is string => part !== null);
    const relationshipSets = await Promise.all(
      relationshipSources.map(async (sourcePart) => ({
        sourcePart,
        relationships: await pkg.getRelationships(sourcePart),
      })),
    );

    const internalImageParts = new Set<string>();
    const internalRelationshipTypesByPart = new Map<string, Set<string>>();
    for (const { relationships } of relationshipSets) {
      for (const relationship of relationships.values()) {
        if (relationship.mode === 'internal') {
          const types =
            internalRelationshipTypesByPart.get(relationship.targetPart) ??
            new Set<string>();
          types.add(relationship.type);
          internalRelationshipTypesByPart.set(relationship.targetPart, types);
        }
        if (!relationship.type.toLocaleLowerCase('en-US').endsWith('/image')) {
          continue;
        }
        if (relationship.mode === 'internal') {
          internalImageParts.add(relationship.targetPart);
        } else {
          throw new OfficeConversionError(
            'external-image',
            'This Office document contains an externally referenced image and cannot be converted safely.',
          );
        }
      }
    }
    const safelyNormalizableImageParts = new Set(
      [...internalImageParts].filter((partName) => {
        const relationshipTypes = internalRelationshipTypesByPart.get(partName);
        return (
          relationshipTypes !== undefined &&
          relationshipTypes.size > 0 &&
          [...relationshipTypes].every(isOfficeImageRelationshipType)
        );
      }),
    );
    // Retain the existing fail-closed sweep over Office media entries while
    // also resolving exact image relationships. Relationship resolution keeps
    // the omission count truthful; the broader sweep prevents an ambiguous,
    // unreferenced media payload from bypassing package validation.
    const mediaParts = pkg.preflight.entries
      .filter((entry) => {
        const normalized = entry.name.toLocaleLowerCase('en-US');
        return (
          !entry.isDirectory &&
          (normalized.startsWith('word/media/') || normalized.startsWith('ppt/media/'))
        );
      })
      .map((entry) => entry.name);
    const partsToValidate = new Set([...mediaParts, ...internalImageParts]);
    const validatedImages = await Promise.all(
      [...partsToValidate].map((partName) =>
        pkg.validateImagePart(partName, {
          officeImageRelationship: safelyNormalizableImageParts.has(partName),
        }),
      ),
    );
    return {
      unsupportedImagesOmitted: validatedImages.filter(
        (image) =>
          image.disposition === 'safe-unsupported' &&
          internalImageParts.has(image.path),
      ).length,
      metadataNormalizedImages: validatedImages.filter(
        (image) => image.metadataNormalized && internalImageParts.has(image.path),
      ).length,
    };
  } catch (error) {
    throw normalizeSecurityError(error);
  }
}

function relationshipSourceForPart(partName: string): string | null {
  if (partName === '_rels/.rels') return '';
  const marker = '/_rels/';
  const markerIndex = partName.lastIndexOf(marker);
  if (markerIndex < 0 || !partName.endsWith('.rels')) return null;
  const directory = partName.slice(0, markerIndex);
  const fileName = partName.slice(markerIndex + marker.length, -'.rels'.length);
  return directory ? `${directory}/${fileName}` : fileName;
}

function normalizeSecurityError(error: unknown): OfficeConversionError {
  if (error instanceof OfficeConversionError) return error;
  if (error instanceof Error) {
    return new OfficeConversionError(
      'unsafe-office-package',
      error.message || 'The Office package failed security validation.',
    );
  }
  return new OfficeConversionError(
    'unsafe-office-package',
    'The Office package failed security validation.',
  );
}

async function inspectDocumentText(
  document: Ream,
): Promise<{ characters: number; hasHan: boolean }> {
  try {
    const markdown = await document.convert('md', {
      images: 'drop',
      pageBreaks: 'drop',
    });
    const text = textDecoder.decode(markdown);
    return {
      characters: (text.match(/[\p{L}\p{N}]/gu) ?? []).length,
      hasHan: /\p{Script=Han}/u.test(text),
    };
  } catch {
    return { characters: 0, hasHan: false };
  }
}

async function loadRequiredCjkFont(
  loadCjkFont: ConvertOfficeBytesOptions['loadCjkFont'],
): Promise<Uint8Array> {
  if (!loadCjkFont) {
    throw new OfficeConversionError(
      'cjk-font-unavailable',
      'This document needs the bundled Chinese font, but it is unavailable.',
    );
  }
  const bytes = await loadCjkFont();
  if (bytes.byteLength === 0) {
    throw new OfficeConversionError(
      'cjk-font-unavailable',
      'The bundled Chinese font could not be loaded safely.',
    );
  }
  return bytes;
}

function createBundledFontFetch(
  latin: OfficeConversionFontSet,
  cjk: Uint8Array | undefined,
): NonNullable<ReamConvertOptions['fontFetch']> {
  return async (url) => {
    const normalized = url.toLocaleLowerCase('en-US');
    const selected = normalized.includes('/noto-sans-sc/')
      ? cjk
      : normalized.includes('/@expo-google-fonts/')
        ? selectLatinVariant(normalized, latin)
        : undefined;
    if (!selected) {
      return {
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      ok: true,
      arrayBuffer: async () => toTransferableArrayBuffer(selected),
    };
  };
}

function selectLatinVariant(url: string, fonts: OfficeConversionFontSet): Uint8Array {
  if (url.includes('_700bold_italic.')) {
    return fonts.boldItalic ?? fonts.bold ?? fonts.italic ?? fonts.regular;
  }
  if (url.includes('_700bold.')) return fonts.bold ?? fonts.regular;
  if (url.includes('_400regular_italic.')) return fonts.italic ?? fonts.regular;
  return fonts.regular;
}

function assertValidPdfEnvelope(bytes: Uint8Array): void {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_PDF_OUTPUT_BYTES ||
    !hasPdfSignature(bytes)
  ) {
    throw new OfficeConversionError(
      'invalid-pdf',
      'The converter output failed PDF validation.',
    );
  }
  const tail = textDecoder.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes('%%EOF')) {
    throw new OfficeConversionError(
      'invalid-pdf',
      'The converter output is incomplete.',
    );
  }
}

function summarizeLosses(
  losses: ReadonlyArray<{ readonly severity: string }>,
  unsupportedImagesOmitted: number,
  metadataNormalizedImages: number,
): OfficeConversionLossSummary {
  return {
    dropped: losses.filter((loss) => loss.severity === 'dropped').length,
    degraded: losses.filter((loss) => loss.severity === 'degraded').length,
    substituted: losses.filter((loss) => loss.severity === 'substituted').length,
    unsupportedImagesOmitted,
    metadataNormalizedImages,
  };
}

async function inspectPdfText(
  bytes: Uint8Array,
): Promise<{ pageCount: number; textCharacters: number }> {
  const loadingTask = getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
  });
  try {
    const document = await loadingTask.promise;
    let textCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      textCharacters += content.items.reduce((count, item) => {
        if (!('str' in item)) return count;
        return (
          count +
          ((item as { readonly str: string }).str.match(/[\p{L}\p{N}]/gu) ?? []).length
        );
      }, 0);
      page.cleanup();
    }
    return { pageCount: document.numPages, textCharacters };
  } catch {
    throw new OfficeConversionError(
      'invalid-pdf',
      'The converter did not produce a PDF that the 39Note reader can open.',
    );
  } finally {
    await loadingTask.destroy();
  }
}

function toTransferableArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}
