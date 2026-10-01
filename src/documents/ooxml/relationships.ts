import type { OoxmlParserLimits } from './limits';
import {
  childElements,
  getXmlAttribute,
  xmlLocalName,
  type XmlElementNode,
} from './xml';
import { OoxmlSecurityError } from './zipPreflight';

const ACTIVE_RELATIONSHIP_MARKERS = [
  '/vbaproject',
  '/oleobject',
  '/package',
  '/control',
  '/activex',
  '/attachedtemplate',
] as const;

export interface InternalOoxmlRelationship {
  readonly id: string;
  readonly type: string;
  readonly mode: 'internal';
  readonly targetPart: string;
}

export interface ExternalOoxmlRelationship {
  readonly id: string;
  readonly type: string;
  readonly mode: 'external';
  /** Safe for display/navigation only. Parsing never fetches this URL. */
  readonly displayTarget: string | null;
}

export type OoxmlRelationship = InternalOoxmlRelationship | ExternalOoxmlRelationship;

export function parseRelationships(
  root: XmlElementNode,
  sourcePart: string,
  limits: OoxmlParserLimits,
): ReadonlyMap<string, OoxmlRelationship> {
  if (xmlLocalName(root) !== 'Relationships') {
    throw relationshipError(
      'relationships-root',
      'An OOXML relationships part has an invalid root.',
    );
  }
  const elements = childElements(root, 'Relationship');
  if (elements.length > limits.maxRelationshipsPerPart) {
    throw relationshipError(
      'relationship-count',
      'An OOXML part contains too many relationships.',
    );
  }
  const relationships = new Map<string, OoxmlRelationship>();
  for (const element of elements) {
    const id = getXmlAttribute(element, 'Id');
    const type = getXmlAttribute(element, 'Type');
    const target = getXmlAttribute(element, 'Target');
    const targetMode = getXmlAttribute(element, 'TargetMode');
    if (!id || !type || !target || id.length > 256 || type.length > 2_048) {
      throw relationshipError(
        'relationship-fields',
        'An OOXML relationship is incomplete or oversized.',
      );
    }
    if (target.length > limits.maxRelationshipTargetLength || relationships.has(id)) {
      throw relationshipError(
        'relationship-fields',
        'An OOXML relationship is duplicated or oversized.',
      );
    }
    const normalizedType = type.toLocaleLowerCase('en-US');
    if (ACTIVE_RELATIONSHIP_MARKERS.some((marker) => normalizedType.endsWith(marker))) {
      throw relationshipError(
        'active-content',
        'The Office document contains prohibited active or embedded content.',
      );
    }
    if (targetMode?.toLocaleLowerCase() === 'external') {
      relationships.set(id, {
        id,
        type,
        mode: 'external',
        displayTarget: sanitizeExternalLink(target),
      });
      continue;
    }
    if (targetMode !== undefined && targetMode !== 'Internal') {
      throw relationshipError(
        'relationship-mode',
        'An OOXML relationship has an invalid target mode.',
      );
    }
    relationships.set(id, {
      id,
      type,
      mode: 'internal',
      targetPart: resolveRelationshipTarget(sourcePart, target, limits.maxPathLength),
    });
  }
  return relationships;
}

export function relationshipPartName(sourcePart: string): string {
  const slash = sourcePart.lastIndexOf('/');
  const directory = slash < 0 ? '' : sourcePart.slice(0, slash + 1);
  const baseName = slash < 0 ? sourcePart : sourcePart.slice(slash + 1);
  return `${directory}_rels/${baseName}.rels`;
}

export function resolveRelationshipTarget(
  sourcePart: string,
  target: string,
  maxPathLength: number,
): string {
  if (
    !target ||
    target.length > maxPathLength ||
    target.includes('\\') ||
    containsAsciiControlCharacter(target)
  ) {
    throw relationshipError(
      'relationship-target',
      'An OOXML relationship target is unsafe.',
    );
  }
  const withoutFragment = target.split('#', 1)[0];
  if (
    !withoutFragment ||
    withoutFragment.startsWith('//') ||
    withoutFragment.includes('?') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(withoutFragment)
  ) {
    throw relationshipError(
      'relationship-target',
      'An internal OOXML relationship target is not a package path.',
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw relationshipError(
      'relationship-target',
      'An OOXML relationship target has invalid escaping.',
    );
  }
  if (
    /[\\?#]/u.test(decoded) ||
    containsAsciiControlCharacter(decoded) ||
    decoded.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(decoded)
  ) {
    throw relationshipError(
      'relationship-target',
      'An OOXML relationship target is not a safe package path.',
    );
  }
  const baseParts = sourcePart.split('/').slice(0, -1);
  const targetParts = decoded.startsWith('/')
    ? decoded.slice(1).split('/')
    : [...baseParts, ...decoded.split('/')];
  const normalized: string[] = [];
  for (const part of targetParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (normalized.length === 0) {
        throw relationshipError(
          'relationship-target',
          'An OOXML relationship escapes the package root.',
        );
      }
      normalized.pop();
      continue;
    }
    if (part.includes(':')) {
      throw relationshipError(
        'relationship-target',
        'An OOXML relationship target contains a URI scheme.',
      );
    }
    normalized.push(part);
  }
  const resolved = normalized.join('/');
  if (!resolved || resolved.length > maxPathLength) {
    throw relationshipError(
      'relationship-target',
      'An OOXML relationship target is outside the path limits.',
    );
  }
  return resolved;
}

function containsAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function sanitizeExternalLink(target: string): string | null {
  if (/\p{C}/u.test(target)) return null;
  try {
    const url = new URL(target);
    if (url.protocol === 'mailto:') return target;
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
    ) {
      return target;
    }
    return null;
  } catch {
    return null;
  }
}

function relationshipError(code: string, message: string): OoxmlSecurityError {
  return new OoxmlSecurityError(code, message);
}
