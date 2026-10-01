import type { DocumentOutlineItem, DocumentSearchEntry } from '../types';
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
  DocxFlowBlock,
  DocxInlineImage,
  DocxParagraphBlock,
  DocxRenderModel,
  DocxTableBlock,
  DocxTextRun,
  DocxTextStyle,
} from './model';

interface ParagraphStyle {
  readonly name: string;
  readonly headingLevel?: number;
}

interface ParseContext {
  readonly pkg: OoxmlPackage;
  readonly relationships: ReadonlyMap<string, OoxmlRelationship>;
  readonly styles: ReadonlyMap<string, ParagraphStyle>;
  nextBlockIndex: number;
}

export async function parseDocxDocument(pkg: OoxmlPackage): Promise<DocxRenderModel> {
  const root = await pkg.readXml(pkg.mainPart);
  if (xmlLocalName(root) !== 'document') {
    throw docxError('document-root', 'The Word document part has an invalid root.');
  }
  const relationships = await pkg.getRelationships(pkg.mainPart);
  const styles = await readStyles(pkg, relationships);
  const body = descendantElements(root, 'body')[0];
  if (!body) throw docxError('document-body', 'The Word document has no body.');
  const context: ParseContext = { pkg, relationships, styles, nextBlockIndex: 0 };
  const blocks = parseBlockChildren(body, [], context);
  if (context.nextBlockIndex > pkg.limits.maxDocumentBlocks) {
    throw docxError(
      'block-count',
      'The Word document exceeds the supported block count.',
    );
  }
  const footnotes = await readNotePart(pkg, relationships, '/footnotes', 'footnote');
  const endnotes = await readNotePart(pkg, relationships, '/endnotes', 'endnote');
  return { kind: 'docx-flow', blocks, footnotes, endnotes };
}

export function createDocxSearchEntries(model: DocxRenderModel): DocumentSearchEntry[] {
  return flattenDocxBlocks(model.blocks)
    .filter(
      (block): block is DocxParagraphBlock | DocxTableBlock =>
        block.kind !== 'section-break',
    )
    .filter((block) => block.text.trim().length > 0)
    .map((block) => ({
      id: block.id,
      text: block.text,
      target: { kind: 'docx-block', blockId: block.id, blockIndex: block.index },
      containerLabel:
        block.kind === 'paragraph' && block.headingLevel
          ? `Heading ${block.headingLevel}`
          : block.kind === 'table'
            ? 'Table'
            : 'Document',
    }));
}

export function createDocxOutline(model: DocxRenderModel): DocumentOutlineItem[] {
  const headings = flattenDocxBlocks(model.blocks).filter(
    (block): block is DocxParagraphBlock =>
      block.kind === 'paragraph' && block.headingLevel !== undefined,
  );
  return headings.map((heading) => ({
    id: heading.id,
    label: heading.text.trim() || 'Untitled heading',
    level: heading.headingLevel ?? 1,
    target: { kind: 'docx-block', blockId: heading.id, blockIndex: heading.index },
  }));
}

export function flattenDocxBlocks(blocks: readonly DocxFlowBlock[]): DocxFlowBlock[] {
  const flattened: DocxFlowBlock[] = [];
  for (const block of blocks) {
    flattened.push(block);
    if (block.kind === 'table') {
      for (const row of block.rows) {
        for (const cell of row.cells) flattened.push(...flattenDocxBlocks(cell.blocks));
      }
    }
  }
  return flattened;
}

function parseBlockChildren(
  parent: XmlElementNode,
  parentPath: readonly number[],
  context: ParseContext,
): DocxFlowBlock[] {
  const blocks: DocxFlowBlock[] = [];
  childElements(parent).forEach((element, childIndex) => {
    const structuralPath = [...parentPath, childIndex];
    const localName = xmlLocalName(element);
    if (localName === 'p') {
      blocks.push(parseParagraph(element, structuralPath, context));
    } else if (localName === 'tbl') {
      blocks.push(parseTable(element, structuralPath, context));
    } else if (localName === 'sectPr') {
      const index = takeBlockIndex(context);
      blocks.push({
        kind: 'section-break',
        id: `section-${structuralPath.join('-')}`,
        index,
        structuralPath,
        text: '',
      });
    }
  });
  return blocks;
}

function parseParagraph(
  element: XmlElementNode,
  structuralPath: readonly number[],
  context: ParseContext,
): DocxParagraphBlock {
  const index = takeBlockIndex(context);
  const properties = firstChildElement(element, 'pPr');
  const styleId = getXmlAttribute(
    firstChildElement(properties ?? element, 'pStyle') ?? element,
    'val',
  );
  const style = styleId ? context.styles.get(styleId) : undefined;
  const runs: DocxTextRun[] = [];
  const images: DocxInlineImage[] = [];

  for (const child of childElements(element)) {
    const localName = xmlLocalName(child);
    if (localName === 'r') {
      runs.push(parseRun(child, runs.length));
      images.push(...parseImages(context.pkg, child, context.relationships));
    } else if (localName === 'hyperlink') {
      const relationshipId = getXmlAttribute(child, 'id');
      const hyperlink = resolveExternalHyperlink(relationshipId, context.relationships);
      for (const runElement of childElements(child, 'r')) {
        const run = parseRun(runElement, runs.length);
        runs.push(hyperlink ? { ...run, hyperlink } : run);
        images.push(...parseImages(context.pkg, runElement, context.relationships));
      }
    } else if (localName === 'oMath' || localName === 'oMathPara') {
      const equationText = descendantElements(child, 't').map(elementText).join('');
      if (equationText)
        runs.push({ index: runs.length, text: equationText, style: {} });
    }
  }
  const listProperties = firstChildElement(properties ?? element, 'numPr');
  const listId = getXmlAttribute(
    firstChildElement(listProperties ?? element, 'numId') ?? element,
    'val',
  );
  const listLevel = parseInteger(
    getXmlAttribute(
      firstChildElement(listProperties ?? element, 'ilvl') ?? element,
      'val',
    ),
  );
  const nativeParagraphId = getXmlAttribute(element, 'paraId');
  const id =
    nativeParagraphId && /^[0-9a-f]{1,16}$/iu.test(nativeParagraphId)
      ? `paragraph-${nativeParagraphId.toLocaleLowerCase()}`
      : `paragraph-${structuralPath.join('-')}`;
  return {
    kind: 'paragraph',
    id,
    index,
    structuralPath,
    text: runs.map((run) => run.text).join(''),
    runs,
    ...(styleId ? { styleId } : {}),
    ...(style?.headingLevel ? { headingLevel: style.headingLevel } : {}),
    ...(listId ? { list: { id: listId, level: listLevel ?? 0 } } : {}),
    images,
  };
}

function parseTable(
  element: XmlElementNode,
  structuralPath: readonly number[],
  context: ParseContext,
): DocxTableBlock {
  const index = takeBlockIndex(context);
  const rows = childElements(element, 'tr').map((row, rowIndex) => ({
    cells: childElements(row, 'tc').map((cell, cellIndex) => {
      const cellPath = [...structuralPath, rowIndex, cellIndex];
      return {
        structuralPath: cellPath,
        blocks: parseBlockChildren(cell, cellPath, context),
      };
    }),
  }));
  const text = rows
    .map((row) =>
      row.cells
        .map((cell) =>
          flattenDocxBlocks(cell.blocks)
            .map((block) => block.text)
            .join('\n'),
        )
        .join('\t'),
    )
    .join('\n');
  return {
    kind: 'table',
    id: `table-${structuralPath.join('-')}`,
    index,
    structuralPath,
    rows,
    text,
  };
}

function parseRun(element: XmlElementNode, index: number): DocxTextRun {
  const properties = firstChildElement(element, 'rPr');
  let text = '';
  for (const child of childElements(element)) {
    const localName = xmlLocalName(child);
    if (localName === 't' || localName === 'instrText') text += elementText(child);
    else if (localName === 'tab') text += '\t';
    else if (localName === 'br' || localName === 'cr') text += '\n';
    else if (localName === 'noBreakHyphen') text += '\u2011';
  }
  return { index, text, style: parseRunStyle(properties) };
}

function parseRunStyle(properties: XmlElementNode | undefined): DocxTextStyle {
  if (!properties) return {};
  const fonts = firstChildElement(properties, 'rFonts');
  const size = parseInteger(
    getXmlAttribute(firstChildElement(properties, 'sz') ?? properties, 'val'),
  );
  return {
    ...(hasEnabledProperty(properties, 'b') ? { bold: true } : {}),
    ...(hasEnabledProperty(properties, 'i') ? { italic: true } : {}),
    ...(hasEnabledProperty(properties, 'u') ? { underline: true } : {}),
    ...(getXmlAttribute(fonts ?? properties, 'ascii')
      ? { fontFamily: getXmlAttribute(fonts ?? properties, 'ascii') }
      : {}),
    ...(size === undefined ? {} : { fontSizePoints: size / 2 }),
  };
}

function parseImages(
  pkg: OoxmlPackage,
  run: XmlElementNode,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): DocxInlineImage[] {
  const images: DocxInlineImage[] = [];
  for (const blip of descendantElements(run, 'blip')) {
    const relationshipId = getXmlAttribute(blip, 'embed');
    const relationship = relationshipId ? relationships.get(relationshipId) : undefined;
    if (
      !relationshipId ||
      !relationship ||
      relationship.mode !== 'internal' ||
      !isOfficeImageRelationshipType(relationship.type)
    ) {
      continue;
    }
    const docProperties = descendantElements(run, 'docPr')[0];
    const altText = getXmlAttribute(docProperties ?? run, 'descr');
    images.push({
      relationshipId,
      resource: pkg.createImageResource(relationship.targetPart, {
        officeImageRelationship: true,
      }),
      ...(altText ? { altText } : {}),
    });
  }
  return images;
}

async function readStyles(
  pkg: OoxmlPackage,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): Promise<ReadonlyMap<string, ParagraphStyle>> {
  const relationship = [...relationships.values()].find(
    (candidate) => candidate.mode === 'internal' && candidate.type.endsWith('/styles'),
  );
  if (!relationship || relationship.mode !== 'internal') return new Map();
  const root = await pkg.readXml(relationship.targetPart);
  const styles = new Map<string, ParagraphStyle>();
  for (const styleElement of childElements(root, 'style')) {
    if (getXmlAttribute(styleElement, 'type') !== 'paragraph') continue;
    const id = getXmlAttribute(styleElement, 'styleId');
    if (!id || id.length > 256 || styles.has(id)) continue;
    const name =
      getXmlAttribute(firstChildElement(styleElement, 'name') ?? styleElement, 'val') ??
      id;
    const explicitLevel = parseInteger(
      getXmlAttribute(
        descendantElements(styleElement, 'outlineLvl')[0] ?? styleElement,
        'val',
      ),
    );
    const headingMatch = /(?:heading|title)\s*([1-9])?/iu.exec(name);
    const headingLevel =
      explicitLevel !== undefined
        ? explicitLevel + 1
        : headingMatch
          ? Number(headingMatch[1] ?? 1)
          : undefined;
    styles.set(id, { name, ...(headingLevel ? { headingLevel } : {}) });
  }
  return styles;
}

async function readNotePart(
  pkg: OoxmlPackage,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  typeSuffix: string,
  elementName: 'footnote' | 'endnote',
): Promise<ReadonlyMap<string, string>> {
  const relationship = [...relationships.values()].find(
    (candidate) => candidate.mode === 'internal' && candidate.type.endsWith(typeSuffix),
  );
  if (!relationship || relationship.mode !== 'internal') return new Map();
  const root = await pkg.readXml(relationship.targetPart);
  const notes = new Map<string, string>();
  for (const note of childElements(root, elementName)) {
    const id = getXmlAttribute(note, 'id');
    if (!id || notes.has(id)) continue;
    const text = descendantElements(note, 't').map(elementText).join('');
    if (text) notes.set(id, text);
  }
  return notes;
}

function resolveExternalHyperlink(
  relationshipId: string | undefined,
  relationships: ReadonlyMap<string, OoxmlRelationship>,
): string | undefined {
  if (!relationshipId) return undefined;
  const relationship = relationships.get(relationshipId);
  return relationship?.mode === 'external' && relationship.type.endsWith('/hyperlink')
    ? (relationship.displayTarget ?? undefined)
    : undefined;
}

function hasEnabledProperty(parent: XmlElementNode, propertyName: string): boolean {
  const property = firstChildElement(parent, propertyName);
  if (!property) return false;
  const value = getXmlAttribute(property, 'val');
  return (
    value === undefined ||
    !['0', 'false', 'off', 'none'].includes(value.toLocaleLowerCase())
  );
}

function takeBlockIndex(context: ParseContext): number {
  const index = context.nextBlockIndex;
  context.nextBlockIndex += 1;
  if (context.nextBlockIndex > context.pkg.limits.maxDocumentBlocks) {
    throw docxError(
      'block-count',
      'The Word document exceeds the supported block count.',
    );
  }
  return index;
}

function parseInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,9}$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function docxError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
