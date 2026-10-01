import type { NotesPrintLayout } from '../types/glossary.ts';
import type {
  PrintContentMode,
  PrintTemplateId,
  PrintTemplateOverrides,
} from '../types/productivity.ts';
import { getPrintLayoutCss } from '../utils/printSession.ts';

export const PRINT_TEMPLATE_VERSION = 1 as const;

export interface PrintTemplateSettings {
  pageMarginTopMm: number;
  pageMarginRightMm: number;
  pageMarginBottomMm: number;
  pageMarginLeftMm: number;
  contentWidthMm: number;
  bodyFontSizePt: number;
  bodyLineHeight: number;
  titleFontSizePt: number;
  blockSpacingPt: number;
  noteSpacingPt: number;
  glossarySpacingPt: number;
  annotationSpacingPt: number;
}

export interface PrintTemplateDefinition {
  id: PrintTemplateId;
  label: string;
  version: typeof PRINT_TEMPLATE_VERSION;
  settings: Readonly<PrintTemplateSettings>;
}

export interface PrintPresentation {
  contentMode: PrintContentMode;
  baseTemplateId: PrintTemplateId;
  templateVersion: typeof PRINT_TEMPLATE_VERSION;
  overrides: PrintTemplateOverrides;
}

export const BUILT_IN_PRINT_TEMPLATES: readonly PrintTemplateDefinition[] = [
  {
    id: 'normal',
    label: 'Normal',
    version: PRINT_TEMPLATE_VERSION,
    settings: {
      pageMarginTopMm: 17,
      pageMarginRightMm: 18,
      pageMarginBottomMm: 18,
      pageMarginLeftMm: 18,
      contentWidthMm: 176,
      bodyFontSizePt: 12,
      bodyLineHeight: 1.5,
      titleFontSizePt: 26,
      blockSpacingPt: 18,
      noteSpacingPt: 30,
      glossarySpacingPt: 7,
      annotationSpacingPt: 18,
    },
  },
  {
    id: 'space-saving',
    label: 'Space-saving',
    version: PRINT_TEMPLATE_VERSION,
    settings: {
      pageMarginTopMm: 12,
      pageMarginRightMm: 12,
      pageMarginBottomMm: 12,
      pageMarginLeftMm: 12,
      contentWidthMm: 186,
      bodyFontSizePt: 10,
      bodyLineHeight: 1.3,
      titleFontSizePt: 17,
      blockSpacingPt: 10,
      noteSpacingPt: 13,
      glossarySpacingPt: 5,
      annotationSpacingPt: 14,
    },
  },
  {
    id: 'extra-large',
    label: 'Extra Large',
    version: PRINT_TEMPLATE_VERSION,
    settings: {
      pageMarginTopMm: 18,
      pageMarginRightMm: 18,
      pageMarginBottomMm: 18,
      pageMarginLeftMm: 18,
      contentWidthMm: 174,
      bodyFontSizePt: 16,
      bodyLineHeight: 1.55,
      titleFontSizePt: 24,
      blockSpacingPt: 28,
      noteSpacingPt: 36,
      glossarySpacingPt: 12,
      annotationSpacingPt: 20,
    },
  },
] as const;

const TEMPLATE_BY_ID = new Map(
  BUILT_IN_PRINT_TEMPLATES.map((template) => [template.id, template] as const),
);

const OVERRIDE_RANGES = {
  pageMarginTopMm: [5, 50],
  pageMarginRightMm: [5, 50],
  pageMarginBottomMm: [5, 50],
  pageMarginLeftMm: [5, 50],
  contentWidthMm: [80, 210],
  bodyFontSizePt: [8, 30],
  bodyLineHeight: [1, 3],
  titleFontSizePt: [12, 48],
  blockSpacingPt: [0, 72],
  noteSpacingPt: [0, 72],
  glossarySpacingPt: [0, 72],
  annotationSpacingPt: [0, 72],
} as const satisfies Record<keyof PrintTemplateOverrides, readonly [number, number]>;

export function getPrintTemplate(templateId: PrintTemplateId): PrintTemplateDefinition {
  return TEMPLATE_BY_ID.get(templateId) ?? BUILT_IN_PRINT_TEMPLATES[0];
}

export function createDefaultPrintPresentation(): PrintPresentation {
  return {
    contentMode: 'notes-and-glossary',
    baseTemplateId: 'normal',
    templateVersion: PRINT_TEMPLATE_VERSION,
    overrides: {},
  };
}

export function normalizeLegacyPrintLayout(
  layout: NotesPrintLayout,
): PrintPresentation {
  if (layout === 'all-annotations') {
    return {
      ...createDefaultPrintPresentation(),
      contentMode: 'all-annotations',
    };
  }
  return {
    ...createDefaultPrintPresentation(),
    baseTemplateId: layout === 'standard' ? 'normal' : layout,
  };
}

export function normalizePrintPresentation(
  value: Record<string, unknown>,
): PrintPresentation | null {
  if (
    value.contentMode === 'notes-and-glossary' ||
    value.contentMode === 'all-annotations'
  ) {
    if (!isPrintTemplateId(value.baseTemplateId)) return null;
    const template = getPrintTemplate(value.baseTemplateId);
    if (value.templateVersion !== template.version) return null;
    const overrides = sanitizePrintTemplateOverrides(value.overrides);
    if (!overrides) return null;
    return {
      contentMode: value.contentMode,
      baseTemplateId: value.baseTemplateId,
      templateVersion: template.version,
      overrides,
    };
  }

  if (isLegacyPrintLayout(value.layout)) {
    return normalizeLegacyPrintLayout(value.layout);
  }
  return null;
}

export function sanitizePrintTemplateOverrides(
  value: unknown,
): PrintTemplateOverrides | null {
  if (!isRecord(value) || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !(key in OVERRIDE_RANGES))) return null;
  const overrides: PrintTemplateOverrides = {};
  for (const key of Object.keys(OVERRIDE_RANGES) as Array<
    keyof PrintTemplateOverrides
  >) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    const [minimum, maximum] = OVERRIDE_RANGES[key];
    if (
      typeof candidate !== 'number' ||
      !Number.isFinite(candidate) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      return null;
    }
    overrides[key] = candidate;
  }
  return overrides;
}

export function resolvePrintTemplateSettings(
  presentation: Pick<
    PrintPresentation,
    'baseTemplateId' | 'templateVersion' | 'overrides'
  >,
): PrintTemplateSettings {
  const template = getPrintTemplate(presentation.baseTemplateId);
  const overrides = sanitizePrintTemplateOverrides(presentation.overrides) ?? {};
  return { ...template.settings, ...overrides };
}

export function getPrintTemplateClassName(
  presentation: Pick<PrintPresentation, 'baseTemplateId' | 'contentMode'>,
): string {
  if (
    presentation.baseTemplateId === 'normal' &&
    presentation.contentMode === 'all-annotations'
  ) {
    return 'print-layout-all-annotations';
  }
  return presentation.baseTemplateId === 'normal'
    ? 'print-layout-standard'
    : `print-layout-${presentation.baseTemplateId}`;
}

export function getPrintTemplateCss(presentation: PrintPresentation): string {
  const legacyLayout = getPrintContentLayout(presentation);
  const settings = resolvePrintTemplateSettings(presentation);
  const className = getPrintTemplateClassName(presentation);
  return `${getPrintLayoutCss(legacyLayout)}
    @page { size: A4; margin: ${formatNumber(settings.pageMarginTopMm)}mm ${formatNumber(settings.pageMarginRightMm)}mm ${formatNumber(settings.pageMarginBottomMm)}mm ${formatNumber(settings.pageMarginLeftMm)}mm; }
    body.${className} { font-size: ${formatNumber(settings.bodyFontSizePt)}pt; line-height: ${formatNumber(settings.bodyLineHeight)}; }
    body.${className} main { max-width: ${formatNumber(settings.contentWidthMm)}mm; }
    body.${className} h1 { font-size: ${formatNumber(settings.titleFontSizePt)}pt; }
    body.${className} .print-composer-block { margin-bottom: ${formatNumber(settings.blockSpacingPt)}pt; }
    body.${className} .note-entry { margin-bottom: ${formatNumber(settings.noteSpacingPt)}pt; }
    body.${className} .glossary-entry { margin-bottom: ${formatNumber(settings.glossarySpacingPt)}pt; }
    body.${className} .annotation-entry { margin-bottom: ${formatNumber(settings.annotationSpacingPt)}pt; }`;
}

export function getPrintContentLayout(
  presentation: Pick<PrintPresentation, 'baseTemplateId' | 'contentMode'>,
): NotesPrintLayout {
  if (
    presentation.baseTemplateId === 'normal' &&
    presentation.contentMode === 'all-annotations'
  ) {
    return 'all-annotations';
  }
  return presentation.baseTemplateId === 'normal'
    ? 'standard'
    : presentation.baseTemplateId;
}

function isPrintTemplateId(value: unknown): value is PrintTemplateId {
  return value === 'normal' || value === 'space-saving' || value === 'extra-large';
}

function isLegacyPrintLayout(value: unknown): value is NotesPrintLayout {
  return (
    value === 'standard' ||
    value === 'space-saving' ||
    value === 'extra-large' ||
    value === 'all-annotations'
  );
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
