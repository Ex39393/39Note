export interface OoxmlParserLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryCompressedBytes: number;
  readonly maxEntryUncompressedBytes: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxCompressionRatio: number;
  readonly compressionRatioFloorBytes: number;
  readonly maxPathLength: number;
  readonly maxXmlBytes: number;
  readonly maxXmlNodes: number;
  readonly maxXmlDepth: number;
  readonly maxAttributesPerElement: number;
  readonly maxRelationshipsPerPart: number;
  readonly maxRelationshipTargetLength: number;
  readonly maxImageBytes: number;
  readonly maxImageDimension: number;
  readonly maxImagePixels: number;
  readonly maxSlides: number;
  readonly maxDocumentBlocks: number;
}

export const DEFAULT_OOXML_LIMITS: Readonly<OoxmlParserLimits> = Object.freeze({
  maxArchiveBytes: 100 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryCompressedBytes: 64 * 1024 * 1024,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  compressionRatioFloorBytes: 1024 * 1024,
  maxPathLength: 512,
  maxXmlBytes: 8 * 1024 * 1024,
  maxXmlNodes: 250_000,
  maxXmlDepth: 128,
  maxAttributesPerElement: 128,
  maxRelationshipsPerPart: 4_096,
  maxRelationshipTargetLength: 2_048,
  maxImageBytes: 32 * 1024 * 1024,
  maxImageDimension: 16_384,
  maxImagePixels: 40_000_000,
  maxSlides: 2_000,
  maxDocumentBlocks: 250_000,
});

export function mergeOoxmlLimits(
  overrides?: Partial<OoxmlParserLimits>,
): Readonly<OoxmlParserLimits> {
  if (!overrides) return DEFAULT_OOXML_LIMITS;
  const merged = { ...DEFAULT_OOXML_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid OOXML parser limit: ${key}.`);
    }
  }
  return Object.freeze(merged);
}
