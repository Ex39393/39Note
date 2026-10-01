import type { OoxmlParserLimits } from './limits';
import { OoxmlSecurityError } from './zipPreflight';

export interface XmlTextNode {
  readonly type: 'text';
  readonly text: string;
}

export interface XmlElementNode {
  readonly type: 'element';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElementNode | XmlTextNode;

interface MutableXmlElement {
  type: 'element';
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

/**
 * Minimal non-validating XML parser for OOXML parts. It never resolves DTDs or
 * general entities and rejects all declarations other than the XML prolog.
 */
export function parseBoundedXml(
  bytes: Uint8Array,
  partName: string,
  limits: OoxmlParserLimits,
): XmlElementNode {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxXmlBytes) {
    throw xmlError('xml-size', `OOXML part ${partName} is outside the XML size limit.`);
  }
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw xmlError('xml-encoding', `OOXML part ${partName} is not valid UTF-8.`);
  }
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  if (/<!\s*(?:DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b/iu.test(xml)) {
    throw xmlError(
      'xml-declaration',
      `OOXML part ${partName} contains a prohibited declaration.`,
    );
  }
  if (xml.includes(String.fromCharCode(0))) {
    throw xmlError('xml-control', `OOXML part ${partName} contains a null character.`);
  }

  const documentRoot: MutableXmlElement = {
    type: 'element',
    name: '#document',
    attributes: {},
    children: [],
  };
  const stack: MutableXmlElement[] = [documentRoot];
  let offset = 0;
  let nodeCount = 0;
  let sawXmlDeclaration = false;

  while (offset < xml.length) {
    if (xml[offset] !== '<') {
      const nextTag = xml.indexOf('<', offset);
      const end = nextTag < 0 ? xml.length : nextTag;
      const text = decodeXmlEntities(xml.slice(offset, end), partName);
      if (text) {
        stack[stack.length - 1].children.push({ type: 'text', text });
        nodeCount += 1;
      }
      offset = end;
      assertNodeCount(nodeCount, limits, partName);
      continue;
    }

    if (xml.startsWith('<!--', offset)) {
      const end = xml.indexOf('-->', offset + 4);
      if (end < 0 || xml.slice(offset + 4, end).includes('--')) {
        throw xmlError('xml-syntax', `OOXML part ${partName} has an invalid comment.`);
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', offset)) {
      const end = xml.indexOf(']]>', offset + 9);
      if (end < 0)
        throw xmlError('xml-syntax', `OOXML part ${partName} has unterminated CDATA.`);
      const text = xml.slice(offset + 9, end);
      if (text) {
        stack[stack.length - 1].children.push({ type: 'text', text });
        nodeCount += 1;
        assertNodeCount(nodeCount, limits, partName);
      }
      offset = end + 3;
      continue;
    }
    if (xml.startsWith('<?', offset)) {
      const end = xml.indexOf('?>', offset + 2);
      if (end < 0)
        throw xmlError(
          'xml-syntax',
          `OOXML part ${partName} has an invalid processing instruction.`,
        );
      const instruction = xml.slice(offset + 2, end).trim();
      if (sawXmlDeclaration || !/^xml(?:\s|$)/iu.test(instruction) || offset > 1) {
        throw xmlError(
          'xml-processing-instruction',
          `OOXML part ${partName} contains a prohibited processing instruction.`,
        );
      }
      sawXmlDeclaration = true;
      offset = end + 2;
      continue;
    }
    if (xml.startsWith('<!', offset)) {
      throw xmlError(
        'xml-declaration',
        `OOXML part ${partName} contains a prohibited declaration.`,
      );
    }

    const tagEnd = findTagEnd(xml, offset + 1, partName);
    const rawTag = xml.slice(offset + 1, tagEnd);
    if (rawTag.startsWith('/')) {
      const closingName = rawTag.slice(1).trim();
      assertXmlName(closingName, partName);
      if (stack.length <= 1 || stack[stack.length - 1].name !== closingName) {
        throw xmlError(
          'xml-syntax',
          `OOXML part ${partName} has mismatched element tags.`,
        );
      }
      stack.pop();
    } else {
      const selfClosing = /\/\s*$/u.test(rawTag);
      const content = selfClosing ? rawTag.replace(/\/\s*$/u, '') : rawTag;
      const { name, attributes } = parseStartTag(content, partName, limits);
      const element: MutableXmlElement = {
        type: 'element',
        name,
        attributes,
        children: [],
      };
      stack[stack.length - 1].children.push(element);
      nodeCount += 1;
      assertNodeCount(nodeCount, limits, partName);
      if (!selfClosing) {
        stack.push(element);
        if (stack.length - 1 > limits.maxXmlDepth) {
          throw xmlError(
            'xml-depth',
            `OOXML part ${partName} exceeds the XML depth limit.`,
          );
        }
      }
    }
    offset = tagEnd + 1;
  }

  if (stack.length !== 1) {
    throw xmlError('xml-syntax', `OOXML part ${partName} has unclosed element tags.`);
  }
  const roots = documentRoot.children.filter(isXmlElement);
  const nonWhitespaceText = documentRoot.children.some(
    (node) => node.type === 'text' && node.text.trim().length > 0,
  );
  if (roots.length !== 1 || nonWhitespaceText) {
    throw xmlError(
      'xml-root',
      `OOXML part ${partName} must contain exactly one root element.`,
    );
  }
  return roots[0];
}

export function xmlLocalName(nodeOrName: XmlElementNode | string): string {
  const name = typeof nodeOrName === 'string' ? nodeOrName : nodeOrName.name;
  const separator = name.indexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

export function childElements(
  node: XmlElementNode,
  localName?: string,
): XmlElementNode[] {
  return node.children.filter(
    (child): child is XmlElementNode =>
      child.type === 'element' &&
      (localName === undefined || xmlLocalName(child) === localName),
  );
}

export function firstChildElement(
  node: XmlElementNode,
  localName: string,
): XmlElementNode | undefined {
  return childElements(node, localName)[0];
}

export function descendantElements(
  node: XmlElementNode,
  localName?: string,
): XmlElementNode[] {
  const matches: XmlElementNode[] = [];
  const visit = (current: XmlElementNode): void => {
    for (const child of childElements(current)) {
      if (localName === undefined || xmlLocalName(child) === localName)
        matches.push(child);
      visit(child);
    }
  };
  visit(node);
  return matches;
}

export function elementText(node: XmlElementNode): string {
  let text = '';
  const visit = (current: XmlNode): void => {
    if (current.type === 'text') {
      text += current.text;
      return;
    }
    current.children.forEach(visit);
  };
  visit(node);
  return text;
}

export function getXmlAttribute(
  node: XmlElementNode,
  localName: string,
): string | undefined {
  for (const [name, value] of Object.entries(node.attributes)) {
    if (xmlLocalName(name) === localName) return value;
  }
  return undefined;
}

function parseStartTag(
  content: string,
  partName: string,
  limits: OoxmlParserLimits,
): { name: string; attributes: Record<string, string> } {
  let offset = 0;
  skipWhitespace();
  const nameStart = offset;
  while (offset < content.length && !/\s/u.test(content[offset])) offset += 1;
  const name = content.slice(nameStart, offset);
  assertXmlName(name, partName);
  const attributes: Record<string, string> = {};

  while (offset < content.length) {
    skipWhitespace();
    if (offset >= content.length) break;
    const attributeStart = offset;
    while (offset < content.length && !/[\s=]/u.test(content[offset])) offset += 1;
    const attributeName = content.slice(attributeStart, offset);
    assertXmlName(attributeName, partName);
    skipWhitespace();
    if (content[offset] !== '=') {
      throw xmlError('xml-syntax', `OOXML part ${partName} has an invalid attribute.`);
    }
    offset += 1;
    skipWhitespace();
    const quote = content[offset];
    if (quote !== '"' && quote !== "'") {
      throw xmlError('xml-syntax', `OOXML part ${partName} has an unquoted attribute.`);
    }
    offset += 1;
    const valueStart = offset;
    const valueEnd = content.indexOf(quote, valueStart);
    if (valueEnd < 0) {
      throw xmlError(
        'xml-syntax',
        `OOXML part ${partName} has an unterminated attribute.`,
      );
    }
    if (Object.hasOwn(attributes, attributeName)) {
      throw xmlError('xml-syntax', `OOXML part ${partName} repeats an attribute.`);
    }
    attributes[attributeName] = decodeXmlEntities(
      content.slice(valueStart, valueEnd),
      partName,
    );
    if (Object.keys(attributes).length > limits.maxAttributesPerElement) {
      throw xmlError(
        'xml-attributes',
        `OOXML part ${partName} exceeds the attribute limit.`,
      );
    }
    offset = valueEnd + 1;
  }
  return { name, attributes };

  function skipWhitespace(): void {
    while (offset < content.length && /\s/u.test(content[offset])) offset += 1;
  }
}

function findTagEnd(xml: string, fromOffset: number, partName: string): number {
  let quote: '"' | "'" | null = null;
  for (let offset = fromOffset; offset < xml.length; offset += 1) {
    const character = xml[offset];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return offset;
    }
  }
  throw xmlError('xml-syntax', `OOXML part ${partName} has an unterminated element.`);
}

function decodeXmlEntities(value: string, partName: string): string {
  return value.replace(/&([^;]{1,32});/gu, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    let codePoint: number;
    if (/^#\d+$/u.test(entity)) {
      codePoint = Number.parseInt(entity.slice(1), 10);
    } else if (/^#x[0-9a-f]+$/iu.test(entity)) {
      codePoint = Number.parseInt(entity.slice(2), 16);
    } else {
      throw xmlError(
        'xml-entity',
        `OOXML part ${partName} contains an unsupported entity.`,
      );
    }
    if (!isSafeXmlCodePoint(codePoint)) {
      throw xmlError(
        'xml-entity',
        `OOXML part ${partName} contains an invalid character entity.`,
      );
    }
    return String.fromCodePoint(codePoint);
  });
}

function isSafeXmlCodePoint(value: number): boolean {
  return (
    value === 0x9 ||
    value === 0xa ||
    value === 0xd ||
    (value >= 0x20 && value <= 0xd7ff) ||
    (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff)
  );
}

function assertXmlName(name: string, partName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(name)) {
    throw xmlError('xml-name', `OOXML part ${partName} contains an invalid XML name.`);
  }
}

function assertNodeCount(
  count: number,
  limits: OoxmlParserLimits,
  partName: string,
): void {
  if (count > limits.maxXmlNodes) {
    throw xmlError('xml-nodes', `OOXML part ${partName} exceeds the XML node limit.`);
  }
}

function isXmlElement(node: XmlNode): node is XmlElementNode {
  return node.type === 'element';
}

function xmlError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
