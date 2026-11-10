import {
  defaultHighlightPalette,
  defaultUnderlinePalette,
  getHighlightColorOpaqueHex,
  getUnderlineColorOpaqueHex,
  normalizeHighlightColor,
  normalizeOpaqueHexColor,
  normalizeUnderlineColor,
  type CanonicalHexColor,
  type HighlightColor,
  type UnderlineColor,
} from '../types/highlight.ts';

export type ReaderStatusIndicatorDisplay = 'full' | 'compact' | 'hidden';

export interface ReaderAnnotationPalettes {
  highlight: HighlightColor[];
  underline: UnderlineColor[];
}

const STATUS_DISPLAY_KEY = '39note.reader-status-indicator.v1';
const ANNOTATION_PALETTES_KEY = '39note.annotation-palettes.v1';
export const REUSABLE_ANNOTATION_COLOR_COUNT = 4;

export function readReaderStatusIndicatorDisplay(
  storage = getLocalStorage(),
): ReaderStatusIndicatorDisplay {
  try {
    const value = storage?.getItem(STATUS_DISPLAY_KEY);
    return value === 'compact' || value === 'hidden' ? value : 'full';
  } catch {
    return 'full';
  }
}

export function writeReaderStatusIndicatorDisplay(
  display: ReaderStatusIndicatorDisplay,
  storage = getLocalStorage(),
): void {
  try {
    storage?.setItem(STATUS_DISPLAY_KEY, display);
  } catch {
    // A blocked preference store must not interrupt Reader interaction.
  }
}

export function resolveReaderStatusIndicatorDisplay(
  preference: ReaderStatusIndicatorDisplay,
  isCompactReader: boolean,
): ReaderStatusIndicatorDisplay {
  return isCompactReader && preference === 'full' ? 'compact' : preference;
}

export function resolveReaderWarning(
  storageWarning: string | null,
  exportWarning: string | null,
): string | null {
  return storageWarning ?? exportWarning;
}

export function readReaderAnnotationPalettes(
  storage = getLocalStorage(),
): ReaderAnnotationPalettes {
  if (!storage) return defaultReaderAnnotationPalettes();
  try {
    const value = JSON.parse(storage.getItem(ANNOTATION_PALETTES_KEY) ?? 'null') as {
      highlight?: unknown;
      underline?: unknown;
    } | null;
    return {
      highlight: normalizePalette(
        value?.highlight,
        defaultHighlightPalette,
        normalizeHighlightColor,
      ),
      underline: normalizePalette(
        value?.underline,
        defaultUnderlinePalette,
        normalizeUnderlineColor,
      ),
    };
  } catch {
    return defaultReaderAnnotationPalettes();
  }
}

export function writeReaderAnnotationPalettes(
  palettes: ReaderAnnotationPalettes,
  storage = getLocalStorage(),
): void {
  try {
    storage?.setItem(
      ANNOTATION_PALETTES_KEY,
      JSON.stringify({
        highlight: normalizePalette(
          palettes.highlight,
          defaultHighlightPalette,
          normalizeHighlightColor,
        ),
        underline: normalizePalette(
          palettes.underline,
          defaultUnderlinePalette,
          normalizeUnderlineColor,
        ),
      }),
    );
  } catch {
    // Palette preferences are optional and never paper content.
  }
}

export function addCustomAnnotationColor<TColor extends string>(
  current: readonly TColor[],
  requestedColor: unknown,
  defaults: readonly TColor[],
  toOpaqueHex: (color: TColor) => CanonicalHexColor,
): TColor[] {
  const custom = normalizeOpaqueHexColor(requestedColor) as TColor | null;
  const palette = uniquePalette(current, defaults);
  if (!custom || palette.some((color) => toOpaqueHex(color) === custom)) {
    return palette;
  }

  const defaultSet = new Set(defaults);
  let rightmostDefault = -1;
  for (let index = palette.length - 1; index >= 0; index -= 1) {
    if (defaultSet.has(palette[index])) {
      rightmostDefault = index;
      break;
    }
  }
  if (rightmostDefault >= 0) {
    return [
      ...palette.slice(0, rightmostDefault),
      ...palette.slice(rightmostDefault + 1),
      custom,
    ];
  }
  return [...palette.slice(1), custom];
}

export function findEquivalentAnnotationPaletteColor(
  type: 'highlight',
  palette: readonly HighlightColor[],
  requestedColor: unknown,
): HighlightColor | null;
export function findEquivalentAnnotationPaletteColor(
  type: 'underline',
  palette: readonly UnderlineColor[],
  requestedColor: unknown,
): UnderlineColor | null;
export function findEquivalentAnnotationPaletteColor(
  type: 'highlight' | 'underline',
  palette: readonly (HighlightColor | UnderlineColor)[],
  requestedColor: unknown,
): HighlightColor | UnderlineColor | null {
  const custom = normalizeOpaqueHexColor(requestedColor);
  if (!custom) return null;
  return (
    palette.find((color) =>
      type === 'highlight'
        ? getHighlightColorOpaqueHex(color as HighlightColor) === custom
        : getUnderlineColorOpaqueHex(color as UnderlineColor) === custom,
    ) ?? null
  );
}

export function resetReaderAnnotationPalette(
  type: 'highlight' | 'underline',
  palettes: ReaderAnnotationPalettes,
): ReaderAnnotationPalettes {
  return type === 'highlight'
    ? { ...palettes, highlight: [...defaultHighlightPalette] }
    : { ...palettes, underline: [...defaultUnderlinePalette] };
}

export function defaultReaderAnnotationPalettes(): ReaderAnnotationPalettes {
  return {
    highlight: [...defaultHighlightPalette],
    underline: [...defaultUnderlinePalette],
  };
}

function normalizePalette<TColor extends string>(
  value: unknown,
  defaults: readonly TColor[],
  normalize: (candidate: unknown) => TColor | null,
): TColor[] {
  if (!Array.isArray(value)) return [...defaults];
  const normalized = value.flatMap((candidate) => {
    const color = normalize(candidate);
    return color ? [color] : [];
  });
  return uniquePalette(normalized, defaults);
}

function uniquePalette<TColor extends string>(
  value: readonly TColor[],
  defaults: readonly TColor[],
): TColor[] {
  const unique = [...new Set(value)].slice(0, REUSABLE_ANNOTATION_COLOR_COUNT);
  for (const color of defaults) {
    if (unique.length >= REUSABLE_ANNOTATION_COLOR_COUNT) break;
    if (!unique.includes(color)) unique.push(color);
  }
  return unique;
}

function getLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isCanonicalCustomColor(value: unknown): value is CanonicalHexColor {
  return normalizeOpaqueHexColor(value) !== null;
}
