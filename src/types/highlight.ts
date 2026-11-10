export interface NormalizedHighlightRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationType = 'highlight' | 'underline';

export const highlightColors = {
  yellow: { label: 'Yellow', opaqueHex: '#FFE600', cssValue: 'rgb(255 230 0 / 35%)' },
  green: { label: 'Green', opaqueHex: '#5AD278', cssValue: 'rgb(90 210 120 / 32%)' },
  blue: { label: 'Blue', opaqueHex: '#4696FF', cssValue: 'rgb(70 150 255 / 30%)' },
  pink: { label: 'Pink', opaqueHex: '#FF69B4', cssValue: 'rgb(255 105 180 / 30%)' },
} as const;

export type NamedHighlightColor = keyof typeof highlightColors;

export const underlineColors = {
  red: { label: 'Red', opaqueHex: '#FF3B30', cssValue: '#ff3b30' },
  green: { label: 'Green', opaqueHex: '#20C75A', cssValue: '#20c75a' },
  blue: { label: 'Blue', opaqueHex: '#1687FF', cssValue: '#1687ff' },
  black: { label: 'Black', opaqueHex: '#111111', cssValue: '#111111' },
} as const;

export type NamedUnderlineColor = keyof typeof underlineColors;

/** Canonical, opaque custom annotation colour. Runtime validation enforces #RRGGBB. */
export type CanonicalHexColor = `#${string}`;
export type HighlightColor = NamedHighlightColor | CanonicalHexColor;
export type UnderlineColor = NamedUnderlineColor | CanonicalHexColor;

export const defaultHighlightPalette = [
  'yellow',
  'green',
  'blue',
  'pink',
] as const satisfies readonly NamedHighlightColor[];

export const defaultUnderlinePalette = [
  'red',
  'green',
  'blue',
  'black',
] as const satisfies readonly NamedUnderlineColor[];

const OPAQUE_HEX_COLOR = /^#[0-9A-F]{6}$/u;

export function normalizeOpaqueHexColor(value: unknown): CanonicalHexColor | null {
  if (typeof value !== 'string') return null;
  const canonical = value.toUpperCase();
  return OPAQUE_HEX_COLOR.test(canonical) ? (canonical as CanonicalHexColor) : null;
}

export function normalizeHighlightColor(value: unknown): HighlightColor | null {
  if (typeof value === 'string' && Object.hasOwn(highlightColors, value)) {
    return value as NamedHighlightColor;
  }
  return normalizeOpaqueHexColor(value);
}

export function normalizeUnderlineColor(value: unknown): UnderlineColor | null {
  if (typeof value === 'string' && Object.hasOwn(underlineColors, value)) {
    return value as NamedUnderlineColor;
  }
  return normalizeOpaqueHexColor(value);
}

export function isHighlightColor(value: unknown): value is HighlightColor {
  return normalizeHighlightColor(value) !== null;
}

export function isUnderlineColor(value: unknown): value is UnderlineColor {
  return normalizeUnderlineColor(value) !== null;
}

export function getHighlightColorCssValue(color: HighlightColor): string {
  if (Object.hasOwn(highlightColors, color)) {
    return highlightColors[color as NamedHighlightColor].cssValue;
  }
  const canonical = normalizeOpaqueHexColor(color);
  if (!canonical) return highlightColors.yellow.cssValue;
  const [red, green, blue] = hexChannels(canonical);
  return `rgb(${red} ${green} ${blue} / 32%)`;
}

export function getHighlightColorOpaqueHex(color: HighlightColor): CanonicalHexColor {
  if (Object.hasOwn(highlightColors, color)) {
    return highlightColors[color as NamedHighlightColor].opaqueHex;
  }
  return normalizeOpaqueHexColor(color) ?? highlightColors.yellow.opaqueHex;
}

export function getUnderlineColorCssValue(color: UnderlineColor): string {
  if (Object.hasOwn(underlineColors, color)) {
    return underlineColors[color as NamedUnderlineColor].cssValue;
  }
  return normalizeOpaqueHexColor(color) ?? underlineColors.blue.cssValue;
}

export function getUnderlineColorOpaqueHex(color: UnderlineColor): CanonicalHexColor {
  if (Object.hasOwn(underlineColors, color)) {
    return underlineColors[color as NamedUnderlineColor].opaqueHex;
  }
  return normalizeOpaqueHexColor(color) ?? underlineColors.blue.opaqueHex;
}

export function getAnnotationColorLabel(
  type: AnnotationType,
  color: HighlightColor | UnderlineColor,
): string {
  const named = type === 'highlight' ? highlightColors : underlineColors;
  if (Object.hasOwn(named, color)) {
    return named[color as keyof typeof named].label;
  }
  return normalizeOpaqueHexColor(color) ?? 'Custom colour';
}

function hexChannels(color: CanonicalHexColor): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

interface BaseAnnotation<TType extends AnnotationType, TColor extends string> {
  id: string;
  type: TType;
  pageNumber: number;
  text: string;
  rects: NormalizedHighlightRectangle[];
  color: TColor;
  createdAt: number;
  updatedAt: number;
}

export type HighlightAnnotation = BaseAnnotation<'highlight', HighlightColor>;
export type UnderlineAnnotation = BaseAnnotation<'underline', UnderlineColor>;
export type PdfAnnotation = HighlightAnnotation | UnderlineAnnotation;
