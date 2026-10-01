import type { DocumentSearchEntry } from '../types';
import { isOfficeImageRelationshipType, type OoxmlPackage } from '../ooxml/package';
import type { OoxmlRelationship } from '../ooxml/relationships';
import {
  childElements,
  descendantElements,
  elementText,
  firstChildElement,
  getXmlAttribute,
  xmlLocalName,
  type XmlElementNode,
} from '../ooxml/xml';
import { OoxmlSecurityError } from '../ooxml/zipPreflight';
import type {
  PptxBounds,
  PptxParagraph,
  PptxRenderModel,
  PptxShape,
  PptxSize,
  PptxSlide,
  PptxSlideDescriptor,
  PptxTextRun,
  PptxTextStyle,
} from './model';

const DEFAULT_SLIDE_SIZE: PptxSize = {
  widthEmu: 12_192_000,
  heightEmu: 6_858_000,
};

export async function parsePptxPresentation(
  pkg: OoxmlPackage,
): Promise<PptxRenderModel> {
  const presentation = await pkg.readXml(pkg.mainPart);
  if (xmlLocalName(presentation) !== 'presentation') {
    throw pptxError(
      'presentation-root',
      'The PowerPoint presentation part has an invalid root.',
    );
  }
  const relationships = await pkg.getRelationships(pkg.mainPart);
  const size = parseSlideSize(presentation);
  const slideIds = descendantElements(presentation, 'sldId');
  if (slideIds.length === 0 || slideIds.length > pkg.limits.maxSlides) {
    throw pptxError(
      'slide-count',
      'The PowerPoint slide count is outside the supported bounds.',
    );
  }
  const seenParts = new Set<string>();
  const descriptors = slideIds.map((slideId, index) => {
    const relationshipId = slideId.attributes['r:id'];
    const stableId = getStableSlideId(slideId, index);
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (
      !relationship ||
      relationship.mode !== 'internal' ||
      !relationship.type.endsWith('/slide')
    ) {
      throw pptxError(
        'slide-relationship',
        'A PowerPoint slide relationship is missing or invalid.',
      );
    }
    if (
      !pkg.hasPart(relationship.targetPart) ||
      seenParts.has(relationship.targetPart)
    ) {
      throw pptxError(
        'slide-relationship',
        'A PowerPoint slide target is missing or duplicated.',
      );
    }
    seenParts.add(relationship.targetPart);
    return createSlideDescriptor(pkg, stableId, index, relationship.targetPart, size);
  });
  return { kind: 'pptx-slides', size, slides: descriptors };
}

export function searchEntriesForSlide(slide: PptxSlide): DocumentSearchEntry[] {
  const entries: DocumentSearchEntry[] = [];
  for (const shape of flattenShapes(slide.shapes)) {
    shape.paragraphs.forEach((paragraph) => {
      if (!paragraph.text.trim()) return;
      entries.push({
        id: `${slide.id}/${shape.id}/${paragraph.index}`,
        text: paragraph.text,
        target: {
          kind: 'pptx-slide',
          slideId: slide.id,
          slideIndex: slide.index,
        },
        containerLabel: slide.label,
      });
    });
  }
  if (slide.speakerNotes.trim()) {
    entries.push({
      id: `${slide.id}/speaker-notes`,
      text: slide.speakerNotes,
      target: {
        kind: 'pptx-slide',
        slideId: slide.id,
        slideIndex: slide.index,
      },
      containerLabel: `${slide.label} notes`,
    });
  }
  return entries;
}

function createSlideDescriptor(
  pkg: OoxmlPackage,
  id: string,
  index: number,
  partName: string,
  size: PptxSize,
): PptxSlideDescriptor {
  let loaded: PptxSlide | null = null;
  let pending: Promise<PptxSlide> | null = null;
  return {
    id,
    index,
    label: `Slide ${index + 1}`,
    partName,
    size,
    isLoaded: () => loaded !== null,
    peek: () => loaded,
    load: () => {
      if (loaded) return Promise.resolve(loaded);
      if (!pending) {
        pending = parseSlide(pkg, id, index, partName, size).then((slide) => {
          loaded = slide;
          return slide;
        });
      }
      return pending;
    },
  };
}

async function parseSlide(
  pkg: OoxmlPackage,
  id: string,
  index: number,
  partName: string,
  size: PptxSize,
): Promise<PptxSlide> {
  const root = await pkg.readXml(partName);
  if (xmlLocalName(root) !== 'sld') {
    throw pptxError('slide-root', 'A PowerPoint slide part has an invalid root.');
  }
  const relationships = await pkg.getRelationships(partName);
  const shapeTree = descendantElements(root, 'spTree')[0];
  if (!shapeTree)
    throw pptxError('slide-shapes', 'A PowerPoint slide has no shape tree.');
  const shapeElements = childElements(shapeTree).filter((element) =>
    ['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'].includes(xmlLocalName(element)),
  );
  const shapes = shapeElements.map((element, order) =>
    parseShape(pkg, element, relationships, order, size),
  );
  const speakerNotes = await readSpeakerNotes(pkg, relationships);
  const extractedText = [
    ...flattenShapes(shapes).flatMap((shape) =>
      shape.paragraphs.map((paragraph) => paragraph.text),
    ),
    speakerNotes,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    id,
    index,
    label: `Slide ${index + 1}`,
    partName,
    size,
    shapes,
    speakerNotes,
    extractedText,
  };
}

function parseShape(
  pkg: OoxmlPackage,
  element: XmlElementNode,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  order: number,
  slideSize: PptxSize,
): PptxShape {
  const localName = xmlLocalName(element);
  const nonVisual = descendantElements(element, 'cNvPr')[0];
  const id = getXmlAttribute(nonVisual ?? element, 'id') ?? `generated-${order}`;
  const name = getXmlAttribute(nonVisual ?? element, 'name') ?? `Shape ${order + 1}`;
  const bounds = parseBounds(element, slideSize);
  const rotation = parseRotation(element);
  const paragraphs = parseParagraphs(element, relationships);
  const kind = getShapeKind(localName, paragraphs.length > 0);
  const image =
    localName === 'pic' ? resolvePicture(pkg, element, relationships) : undefined;
  const children =
    localName === 'grpSp'
      ? childElements(element)
          .filter((child) =>
            ['sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'].includes(
              xmlLocalName(child),
            ),
          )
          .map((child, childOrder) =>
            parseShape(pkg, child, relationships, childOrder, slideSize),
          )
      : undefined;
  return {
    id,
    name,
    kind: image ? 'image' : kind,
    order,
    bounds,
    ...(rotation === undefined ? {} : { rotationDegrees: rotation }),
    style: parseShapeStyle(element),
    paragraphs,
    ...(image ? { image } : {}),
    ...(children ? { children } : {}),
  };
}

function parseParagraphs(
  shape: XmlElementNode,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): PptxParagraph[] {
  const textBodies = descendantElements(shape, 'txBody');
  if (textBodies.length === 0) return [];
  return childElements(textBodies[0], 'p').map((paragraph, paragraphIndex) => {
    const runs: PptxTextRun[] = [];
    for (const child of childElements(paragraph)) {
      const localName = xmlLocalName(child);
      if (localName === 'br') {
        runs.push({ index: runs.length, text: '\n', style: {} });
      } else if (localName === 'r' || localName === 'fld') {
        const textNode = descendantElements(child, 't')[0];
        if (!textNode) continue;
        const properties = childElements(child, 'rPr')[0];
        const hyperlinkId = properties
          ? getXmlAttribute(
              descendantElements(properties, 'hlinkClick')[0] ?? properties,
              'id',
            )
          : undefined;
        const hyperlink = resolveHyperlink(hyperlinkId, relationships);
        runs.push({
          index: runs.length,
          text: elementText(textNode),
          style: parseTextStyle(properties),
          ...(hyperlink ? { hyperlink } : {}),
        });
      }
    }
    const properties = childElements(paragraph, 'pPr')[0];
    return {
      index: paragraphIndex,
      text: runs.map((run) => run.text).join(''),
      ...(parseAlignment(getXmlAttribute(properties ?? paragraph, 'algn'))
        ? {
            alignment: parseAlignment(getXmlAttribute(properties ?? paragraph, 'algn')),
          }
        : {}),
      runs,
    };
  });
}

function parseTextStyle(properties: XmlElementNode | undefined): PptxTextStyle {
  if (!properties) return {};
  const font = descendantElements(properties, 'latin')[0];
  const colorNode = descendantElements(properties, 'srgbClr')[0];
  const size = parseFiniteNumber(getXmlAttribute(properties, 'sz'));
  return {
    ...(getXmlAttribute(properties, 'b') === '1' ? { bold: true } : {}),
    ...(getXmlAttribute(properties, 'i') === '1' ? { italic: true } : {}),
    ...(getXmlAttribute(properties, 'u') && getXmlAttribute(properties, 'u') !== 'none'
      ? { underline: true }
      : {}),
    ...(getXmlAttribute(font ?? properties, 'typeface')
      ? { fontFamily: getXmlAttribute(font ?? properties, 'typeface') }
      : {}),
    ...(size === undefined ? {} : { fontSizePoints: size / 100 }),
    ...(normalizeHexColor(getXmlAttribute(colorNode ?? properties, 'val'))
      ? { color: normalizeHexColor(getXmlAttribute(colorNode ?? properties, 'val')) }
      : {}),
  };
}

function parseShapeStyle(element: XmlElementNode): PptxShape['style'] {
  const properties = childElements(element).find((child) =>
    ['spPr', 'grpSpPr'].includes(xmlLocalName(child)),
  );
  if (!properties) return {};
  const fill = normalizeHexColor(
    getXmlAttribute(
      descendantElements(
        firstChildElement(properties, 'solidFill') ?? properties,
        'srgbClr',
      )[0] ?? properties,
      'val',
    ),
  );
  const line = firstChildElement(properties, 'ln');
  const borderColor = line
    ? normalizeHexColor(
        getXmlAttribute(descendantElements(line, 'srgbClr')[0] ?? line, 'val'),
      )
    : undefined;
  const borderWidth = parseFiniteNumber(getXmlAttribute(line ?? properties, 'w'));
  return {
    ...(fill ? { fill } : {}),
    ...(borderColor ? { borderColor } : {}),
    ...(borderWidth === undefined ? {} : { borderWidthPoints: borderWidth / 12_700 }),
  };
}

function resolvePicture(
  pkg: OoxmlPackage,
  element: XmlElementNode,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
) {
  const blip = descendantElements(element, 'blip')[0];
  const relationshipId = blip ? getXmlAttribute(blip, 'embed') : undefined;
  const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
  if (
    !relationship ||
    relationship.mode !== 'internal' ||
    !isOfficeImageRelationshipType(relationship.type)
  ) {
    return undefined;
  }
  return pkg.createImageResource(relationship.targetPart, {
    officeImageRelationship: true,
  });
}

async function readSpeakerNotes(
  pkg: OoxmlPackage,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): Promise<string> {
  const notes = [...relationships.values()].find(
    (relationship) =>
      relationship.mode === 'internal' && relationship.type.endsWith('/notesSlide'),
  );
  if (!notes || notes.mode !== 'internal') return '';
  const root = await pkg.readXml(notes.targetPart);
  if (xmlLocalName(root) !== 'notes') return '';
  return descendantElements(root, 't')
    .map((element) => elementText(element))
    .join(' ')
    .trim();
}

function parseSlideSize(root: XmlElementNode): PptxSize {
  const element = descendantElements(root, 'sldSz')[0];
  const width = parseFiniteNumber(getXmlAttribute(element ?? root, 'cx'));
  const height = parseFiniteNumber(getXmlAttribute(element ?? root, 'cy'));
  if (!width || !height) return DEFAULT_SLIDE_SIZE;
  return { widthEmu: width, heightEmu: height };
}

function parseBounds(element: XmlElementNode, slideSize: PptxSize): PptxBounds {
  const transform = descendantElements(element, 'xfrm')[0];
  const offset = transform ? firstChildElement(transform, 'off') : undefined;
  const extent = transform ? firstChildElement(transform, 'ext') : undefined;
  return {
    xEmu: parseFiniteNumber(getXmlAttribute(offset ?? element, 'x')) ?? 0,
    yEmu: parseFiniteNumber(getXmlAttribute(offset ?? element, 'y')) ?? 0,
    widthEmu:
      parseFiniteNumber(getXmlAttribute(extent ?? element, 'cx')) ?? slideSize.widthEmu,
    heightEmu:
      parseFiniteNumber(getXmlAttribute(extent ?? element, 'cy')) ??
      slideSize.heightEmu,
  };
}

function parseRotation(element: XmlElementNode): number | undefined {
  const transform = descendantElements(element, 'xfrm')[0];
  const rotation = parseFiniteNumber(getXmlAttribute(transform ?? element, 'rot'));
  return rotation === undefined ? undefined : rotation / 60_000;
}

function resolveHyperlink(
  relationshipId: string | undefined,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): string | undefined {
  if (!relationshipId) return undefined;
  const relationship = relationships.get(relationshipId);
  return relationship?.mode === 'external' && relationship.type.endsWith('/hyperlink')
    ? (relationship.displayTarget ?? undefined)
    : undefined;
}

function getStableSlideId(element: XmlElementNode, index: number): string {
  const nativeId = element.attributes.id;
  return nativeId && /^\d{1,20}$/u.test(nativeId) ? nativeId : `slide-${index + 1}`;
}

function getShapeKind(localName: string, hasText: boolean): PptxShape['kind'] {
  if (localName === 'grpSp') return 'group';
  if (localName === 'sp' || localName === 'cxnSp') return hasText ? 'text' : 'shape';
  return 'unsupported';
}

function parseAlignment(
  value: string | undefined,
): PptxParagraph['alignment'] | undefined {
  if (value === 'ctr') return 'center';
  if (value === 'r') return 'right';
  if (value === 'just' || value === 'dist') return 'justify';
  if (value === 'l') return 'left';
  return undefined;
}

function parseFiniteNumber(value: string | undefined): number | undefined {
  if (!value || !/^-?\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 1e15 ? number : undefined;
}

function normalizeHexColor(value: string | undefined): string | undefined {
  return value && /^[0-9a-f]{6}$/iu.test(value)
    ? `#${value.toLocaleUpperCase()}`
    : undefined;
}

export function flattenShapes(shapes: readonly PptxShape[]): PptxShape[] {
  const flattened: PptxShape[] = [];
  for (const shape of shapes) {
    flattened.push(shape);
    if (shape.children) flattened.push(...flattenShapes(shape.children));
  }
  return flattened;
}

function pptxError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
