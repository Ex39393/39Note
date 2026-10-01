import {
  sanitizeDocumentSemanticAnchor,
  type DocxSemanticAnchor,
  type PptxSemanticAnchor,
} from './anchors';

export type OfficeMarkType = 'highlight' | 'underline';
export type OfficeMarkColor = 'yellow' | 'green' | 'blue' | 'pink' | 'red' | 'black';

export interface OfficeAnnotationNote {
  readonly id: string;
  readonly displayNumber: string;
  readonly content: string;
  readonly updatedAt: number;
}

export interface OfficeDocumentAnnotation {
  readonly version: 1;
  readonly id: string;
  readonly documentId: string;
  readonly markType: OfficeMarkType;
  readonly color: OfficeMarkColor;
  readonly anchor: PptxSemanticAnchor | DocxSemanticAnchor;
  /** Notes remain owned by the semantic mark so reflow cannot detach them. */
  readonly note?: OfficeAnnotationNote;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function sanitizeOfficeDocumentAnnotation(
  value: unknown,
): OfficeDocumentAnnotation | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isSafeId(value.id) || !isSafeId(value.documentId)) return null;
  if (value.markType !== 'highlight' && value.markType !== 'underline') return null;
  if (!isValidColor(value.markType, value.color)) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  if (value.updatedAt < value.createdAt) return null;
  const anchor = sanitizeDocumentSemanticAnchor(value.anchor);
  if (!anchor || anchor.kind === 'pdf-text' || anchor.documentId !== value.documentId) {
    return null;
  }
  const note =
    value.note === undefined ? undefined : sanitizeOfficeAnnotationNote(value.note);
  if (value.note !== undefined && !note) return null;
  return {
    version: 1,
    id: value.id,
    documentId: value.documentId,
    markType: value.markType,
    color: value.color,
    anchor,
    ...(note ? { note } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function sanitizeOfficeAnnotationNote(value: unknown): OfficeAnnotationNote | null {
  if (
    !isRecord(value) ||
    !isSafeId(value.id) ||
    typeof value.displayNumber !== 'string' ||
    value.displayNumber.length === 0 ||
    value.displayNumber.length > 32 ||
    typeof value.content !== 'string' ||
    value.content.length > 200_000 ||
    !isTimestamp(value.updatedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    displayNumber: value.displayNumber,
    content: value.content,
    updatedAt: value.updatedAt,
  };
}

export function sanitizeOfficeDocumentAnnotations(
  value: unknown,
): OfficeDocumentAnnotation[] {
  if (!Array.isArray(value) || value.length > 100_000) return [];
  const annotations: OfficeDocumentAnnotation[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const annotation = sanitizeOfficeDocumentAnnotation(candidate);
    if (annotation && !ids.has(annotation.id)) {
      ids.add(annotation.id);
      annotations.push(annotation);
    }
  }
  return annotations;
}

function isValidColor(
  markType: OfficeMarkType,
  value: unknown,
): value is OfficeMarkColor {
  return markType === 'highlight'
    ? value === 'yellow' || value === 'green' || value === 'blue' || value === 'pink'
    : value === 'red' || value === 'green' || value === 'blue' || value === 'black';
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) < 0x20)
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
