import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/u;
const DRAWING_TAGS = new Set(['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp', 'p:cxnSp']);
const NON_VISUAL_TAGS = new Set([
  'p:nvSpPr',
  'p:nvPicPr',
  'p:nvGraphicFramePr',
  'p:nvGrpSpPr',
  'p:nvCxnSpPr',
]);
const XML_OPTIONS = {
  ignoreAttributes: false,
  preserveOrder: true,
  processEntities: false,
} as const;

type OrderedXmlNode = Record<string, unknown>;

export interface PptxHiddenShapeSanitization {
  readonly bytes: Uint8Array;
  readonly removedShapeCount: number;
  readonly affectedSlideCount: number;
}

/**
 * Removes only drawing objects that OOXML explicitly marks non-visible through
 * `p:cNvPr@hidden`. Reamkit 1.29 renders those objects, which exposes the
 * otherwise hidden text layer above full-slide raster imports. No image-size or
 * overlap heuristic is used, so an ordinary background plus visible text stays
 * fully selectable.
 */
export async function sanitizeHiddenPptxShapesForConversion(
  bytes: Uint8Array,
): Promise<PptxHiddenShapeSanitization> {
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: false,
    createFolders: false,
  });
  const parser = new XMLParser(XML_OPTIONS);
  const builder = new XMLBuilder(XML_OPTIONS);
  let removedShapeCount = 0;
  let affectedSlideCount = 0;

  const slideFiles = Object.values(zip.files).filter(
    (entry) => !entry.dir && SLIDE_PART.test(entry.name),
  );
  await Promise.all(
    slideFiles.map(async (entry) => {
      const sourceXml = await entry.async('string');
      const document = parser.parse(sourceXml) as OrderedXmlNode[];
      const result = filterHiddenDrawings(document);
      if (result.removed === 0) return;
      removedShapeCount += result.removed;
      affectedSlideCount += 1;
      zip.file(entry.name, builder.build(result.nodes));
    }),
  );

  if (removedShapeCount === 0) {
    return { bytes, removedShapeCount: 0, affectedSlideCount: 0 };
  }
  return {
    bytes: await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
    }),
    removedShapeCount,
    affectedSlideCount,
  };
}

function filterHiddenDrawings(nodes: OrderedXmlNode[]): {
  nodes: OrderedXmlNode[];
  removed: number;
} {
  let removed = 0;
  const filtered: OrderedXmlNode[] = [];
  for (const node of nodes) {
    const tag = nodeTag(node);
    if (tag && DRAWING_TAGS.has(tag) && isExplicitlyHiddenDrawing(node, tag)) {
      removed += 1;
      continue;
    }
    if (tag && Array.isArray(node[tag])) {
      const childResult = filterHiddenDrawings(node[tag] as OrderedXmlNode[]);
      node[tag] = childResult.nodes;
      removed += childResult.removed;
    }
    filtered.push(node);
  }
  return { nodes: filtered, removed };
}

function isExplicitlyHiddenDrawing(node: OrderedXmlNode, tag: string): boolean {
  const children = node[tag];
  if (!Array.isArray(children)) return false;
  const nonVisual = children.find((candidate) => {
    const childTag = nodeTag(candidate as OrderedXmlNode);
    return childTag !== undefined && NON_VISUAL_TAGS.has(childTag);
  }) as OrderedXmlNode | undefined;
  if (!nonVisual) return false;
  const nonVisualTag = nodeTag(nonVisual);
  if (!nonVisualTag || !Array.isArray(nonVisual[nonVisualTag])) return false;
  const common = (nonVisual[nonVisualTag] as OrderedXmlNode[]).find(
    (candidate) => nodeTag(candidate) === 'p:cNvPr',
  );
  const attributes = common?.[':@'];
  if (!attributes || typeof attributes !== 'object') return false;
  const hidden = (attributes as Record<string, unknown>)['@_hidden'];
  return hidden === '1' || hidden === 'true' || hidden === 'on' || hidden === true;
}

function nodeTag(node: OrderedXmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@' && key !== '#text');
}
