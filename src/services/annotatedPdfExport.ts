import {
  PDFDocument,
  PageSizes,
  StandardFonts,
  degrees,
  rgb,
  type PDFPage,
  type PDFFont,
  type RGB,
} from 'pdf-lib';
import notoSansScRegularUrl from '@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf?url';
import { normalizeOpaqueHexColor, type PdfAnnotation } from '../types/highlight';
import type {
  AnnotatedPdfExportRequest,
  AnnotatedPdfExportResult,
  AnnotationExportReference,
  AppendixLayoutItem,
  PdfPageGeometry,
} from '../types/annotatedPdfExport';
import {
  buildAnnotationExportReferences,
  createPdfJsViewport,
  findUnsupportedAppendixCharacters,
  normalizedPointToPdfPoint,
  normalizedRectangleToPdfRectangle,
  normalizedRectangleToPdfUnderline,
  paginateAppendixItems,
  sanitizeAnnotatedPdfFilename,
  sortAnnotationsForExport,
  wrapAppendixText,
} from '../utils/annotatedPdfExportModel';

const HIGHLIGHT_OPACITY = 0.35;
const DEFAULT_HIGHLIGHT_COLOR = rgb(1, 0.9, 0);
const DEFAULT_UNDERLINE_COLOR = rgb(0.12, 0.14, 0.18);
const APPENDIX_MARGIN = 48;
const APPENDIX_BODY_SIZE = 10;
const APPENDIX_LINE_HEIGHT = 13;
const MARKER_FONT_SIZE_POINTS = 7;
const MARKER_HEIGHT_POINTS = 10;
const MARKER_GAP_POINTS = 3;

let bundledAppendixFontBytesPromise: Promise<Uint8Array> | null = null;

const HIGHLIGHT_COLORS: Record<string, RGB> = {
  yellow: rgb(1, 0.9, 0),
  green: rgb(0.35, 0.82, 0.47),
  blue: rgb(0.27, 0.59, 1),
  pink: rgb(1, 0.41, 0.71),
};

const UNDERLINE_COLORS: Record<string, RGB> = {
  red: rgb(1, 0.23, 0.19),
  green: rgb(0.13, 0.78, 0.35),
  blue: rgb(0.09, 0.53, 1),
  black: rgb(0.07, 0.07, 0.07),
};

export class AnnotatedPdfExportError extends Error {
  readonly code:
    | 'encrypted-or-password-protected'
    | 'unsupported-unicode'
    | 'invalid-page-geometry'
    | 'unsupported-pdf'
    | 'generic';

  constructor(
    message: string,
    code:
      | 'encrypted-or-password-protected'
      | 'unsupported-unicode'
      | 'invalid-page-geometry'
      | 'unsupported-pdf'
      | 'generic',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = 'AnnotatedPdfExportError';
  }
}

export interface AnnotatedPdfExportDependencies {
  loadAppendixFontBytes?: () => Promise<Uint8Array>;
}

export async function createAnnotatedPdf(
  request: AnnotatedPdfExportRequest,
  dependencies: AnnotatedPdfExportDependencies = {},
): Promise<AnnotatedPdfExportResult> {
  request.onProgress?.({
    stage: 'preparing',
    message: 'Preparing original PDF...',
  });

  let pdfDocument: PDFDocument;
  try {
    const sourceBytes = new Uint8Array(await request.sourceBlob.arrayBuffer());
    pdfDocument = await PDFDocument.load(sourceBytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    if (isEncryptionError(error)) {
      throw new AnnotatedPdfExportError(
        'This PDF is encrypted or password-protected and cannot be exported safely.',
        'encrypted-or-password-protected',
        { cause: error },
      );
    }
    throw new AnnotatedPdfExportError(
      'The original PDF could not be opened for annotation export.',
      'unsupported-pdf',
      { cause: error },
    );
  }

  const pages = pdfDocument.getPages();
  if (pages.length !== request.pageGeometries.length) {
    throw new AnnotatedPdfExportError(
      'The PDF page geometry changed before export. Reopen the document and try again.',
      'invalid-page-geometry',
    );
  }

  const annotations = sortAnnotationsForExport(request.annotations);
  const references =
    request.options.contentMode === 'annotations-and-notes'
      ? buildAnnotationExportReferences(annotations, request.notes, request.noteAnchors)
      : [];
  const referenceByAnnotationId = new Map(
    references.flatMap((reference) =>
      reference.annotation.type === 'note-anchor'
        ? []
        : [[reference.annotation.id, reference] as const],
    ),
  );
  const appendixFont =
    references.length > 0
      ? await embedUnicodeAppendixFont(
          pdfDocument,
          dependencies.loadAppendixFontBytes ?? loadBundledAppendixFontBytes,
        )
      : null;
  const appendixBoldFont =
    references.length > 0
      ? await pdfDocument.embedFont(StandardFonts.HelveticaBold)
      : null;

  if (references.length > 0 && appendixFont) {
    assertAppendixTextIsSupported(
      request.documentTitle,
      references,
      request.options.includeSelectedText,
      appendixFont,
    );
  }

  let completed = 0;
  for (const annotation of annotations) {
    const page = pages[annotation.pageNumber - 1];
    const geometry = request.pageGeometries[annotation.pageNumber - 1];
    if (!page || !geometry) {
      throw new AnnotatedPdfExportError(
        `Annotation ${completed + 1} refers to a page that is not present in the PDF.`,
        'invalid-page-geometry',
      );
    }

    drawAnnotation(page, geometry, annotation, request.options.includeAnnotationColors);
    const reference = referenceByAnnotationId.get(annotation.id);
    if (reference && request.options.includeReferenceMarkers && appendixFont) {
      drawReferenceMarker(page, geometry, annotation, reference, appendixFont);
    }

    completed += 1;
    request.onProgress?.({
      stage: 'annotations',
      message: `Writing annotations: ${completed} / ${annotations.length}`,
      completed,
      total: annotations.length,
    });
    if (completed % 12 === 0) {
      await yieldToBrowser();
    }
  }

  if (references.length > 0 && appendixFont && appendixBoldFont) {
    request.onProgress?.({
      stage: 'appendix',
      message: 'Creating Notes appendix...',
    });
    appendNotesPages(
      pdfDocument,
      request.documentTitle,
      references,
      request.options.includeSelectedText,
      appendixFont,
      appendixBoldFont,
    );
    await yieldToBrowser();
  }

  request.onProgress?.({
    stage: 'download',
    message: 'Preparing download...',
  });

  try {
    const bytes = await pdfDocument.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
      useObjectStreams: true,
    });
    return {
      bytes,
      filename: sanitizeAnnotatedPdfFilename(request.documentTitle),
      exportedAnnotationCount: annotations.length,
      appendixEntryCount: references.length,
    };
  } catch (error) {
    throw new AnnotatedPdfExportError(
      'The annotated PDF could not be finalized. The original PDF was not changed.',
      'generic',
      { cause: error },
    );
  }
}

function drawAnnotation(
  page: PDFPage,
  geometry: PdfPageGeometry,
  annotation: PdfAnnotation,
  includeColors: boolean,
): void {
  if (annotation.type === 'highlight') {
    const color = resolveAnnotationExportColor(annotation, includeColors);
    for (const rectangle of annotation.rects) {
      const pdfRectangle = normalizedRectangleToPdfRectangle(rectangle, geometry);
      page.drawRectangle({
        ...pdfRectangle,
        color,
        opacity: HIGHLIGHT_OPACITY,
        borderWidth: 0,
      });
    }
    return;
  }

  const color = resolveAnnotationExportColor(annotation, includeColors);
  for (const rectangle of annotation.rects) {
    const line = normalizedRectangleToPdfUnderline(rectangle, geometry);
    page.drawLine({
      start: line.start,
      end: line.end,
      thickness: line.thickness,
      color,
      opacity: 1,
    });
  }
}

// Pure export-colour resolution is kept public for deterministic regression tests.
export function resolveAnnotationExportColor(
  annotation: PdfAnnotation,
  includeColors: boolean,
): RGB {
  const fallback =
    annotation.type === 'highlight' ? DEFAULT_HIGHLIGHT_COLOR : DEFAULT_UNDERLINE_COLOR;
  if (!includeColors) return fallback;
  const customColor = normalizeOpaqueHexColor(annotation.color);
  if (customColor) return colorFromHex(customColor);
  return annotation.type === 'highlight'
    ? (HIGHLIGHT_COLORS[annotation.color] ?? fallback)
    : (UNDERLINE_COLORS[annotation.color] ?? fallback);
}

function colorFromHex(color: `#${string}`): RGB {
  return rgb(
    Number.parseInt(color.slice(1, 3), 16) / 255,
    Number.parseInt(color.slice(3, 5), 16) / 255,
    Number.parseInt(color.slice(5, 7), 16) / 255,
  );
}

function drawReferenceMarker(
  page: PDFPage,
  geometry: PdfPageGeometry,
  annotation: PdfAnnotation,
  reference: AnnotationExportReference,
  font: PDFFont,
): void {
  const rectangle = [...annotation.rects].sort(
    (first, second) => first.y - second.y || first.x - second.x,
  )[0];
  if (!rectangle) {
    return;
  }

  const label = `[${reference.referenceNumber}]`;
  const viewport = createPdfJsViewport(geometry);
  const fontSize = MARKER_FONT_SIZE_POINTS / geometry.userUnit;
  const markerWidthPoints =
    font.widthOfTextAtSize(label, fontSize) * geometry.userUnit + 5;
  const width = markerWidthPoints / viewport.width;
  const height = MARKER_HEIGHT_POINTS / viewport.height;
  const gapX = MARKER_GAP_POINTS / viewport.width;
  const gapY = MARKER_GAP_POINTS / viewport.height;

  let x = rectangle.x + rectangle.width + gapX;
  if (x + width > 1) {
    x = Math.max(0, rectangle.x - width - gapX);
  }
  let top = rectangle.y - height - gapY;
  if (top < 0) {
    top = Math.min(1 - height, rectangle.y + rectangle.height + gapY);
  }

  const backgroundRectangle = normalizedRectangleToPdfRectangle(
    { x, y: top, width, height },
    geometry,
  );
  const textOrigin = normalizedPointToPdfPoint(
    x + 2 / viewport.width,
    top + height - 2.2 / viewport.height,
    geometry,
  );
  const rotation = degrees(geometry.rotation);

  page.drawRectangle({
    ...backgroundRectangle,
    color: rgb(1, 1, 1),
    opacity: 0.88,
    borderColor: rgb(0.42, 0.29, 0.18),
    borderWidth: 0.55 / geometry.userUnit,
    borderOpacity: 0.9,
  });
  page.drawText(label, {
    x: textOrigin.x,
    y: textOrigin.y,
    size: fontSize,
    font,
    rotate: rotation,
    color: rgb(0.32, 0.18, 0.11),
  });
}

function appendNotesPages(
  pdfDocument: PDFDocument,
  documentTitle: string,
  references: AnnotationExportReference[],
  includeSelectedText: boolean,
  font: PDFFont,
  boldFont: PDFFont,
): void {
  const [pageWidth, pageHeight] = PageSizes.A4;
  const maxTextWidth = pageWidth - APPENDIX_MARGIN * 2;
  const items = createAppendixItems(
    references,
    includeSelectedText,
    font,
    boldFont,
    maxTextWidth,
  );
  const pages = paginateAppendixItems(
    items,
    pageHeight - 176 - APPENDIX_MARGIN,
    pageHeight - 94 - APPENDIX_MARGIN,
  );

  pages.forEach((pageItems, pageIndex) => {
    const page = pdfDocument.addPage(PageSizes.A4);
    let y: number;
    if (pageIndex === 0) {
      page.drawText('39Note Annotation Notes', {
        x: APPENDIX_MARGIN,
        y: pageHeight - 66,
        size: 18,
        font: boldFont,
        color: rgb(0.12, 0.15, 0.2),
      });
      page.drawText(`Document: ${documentTitle.trim() || '39Note'}`, {
        x: APPENDIX_MARGIN,
        y: pageHeight - 91,
        size: 10,
        font,
        color: rgb(0.25, 0.28, 0.32),
      });
      page.drawText(`Exported: ${formatLocalDateTime(new Date())}`, {
        x: APPENDIX_MARGIN,
        y: pageHeight - 107,
        size: 10,
        font,
        color: rgb(0.25, 0.28, 0.32),
      });
      page.drawLine({
        start: { x: APPENDIX_MARGIN, y: pageHeight - 124 },
        end: { x: pageWidth - APPENDIX_MARGIN, y: pageHeight - 124 },
        thickness: 0.75,
        color: rgb(0.72, 0.73, 0.75),
      });
      y = pageHeight - 148;
    } else {
      page.drawText('39Note Annotation Notes (continued)', {
        x: APPENDIX_MARGIN,
        y: pageHeight - 54,
        size: 13,
        font: boldFont,
        color: rgb(0.12, 0.15, 0.2),
      });
      y = pageHeight - 78;
    }

    for (const item of pageItems) {
      y -= item.height;
      if (item.style === 'spacer' || item.text.length === 0) {
        continue;
      }
      page.drawText(item.text, {
        x: APPENDIX_MARGIN,
        y: y + 2,
        size: item.style === 'entry-heading' ? 11 : APPENDIX_BODY_SIZE,
        font:
          item.style === 'entry-heading' || item.style === 'label' ? boldFont : font,
        color:
          item.style === 'entry-heading' ? rgb(0.16, 0.2, 0.28) : rgb(0.2, 0.22, 0.25),
      });
    }

    page.drawText(`${pageIndex + 1}`, {
      x: pageWidth / 2 - 3,
      y: 24,
      size: 8,
      font,
      color: rgb(0.45, 0.46, 0.49),
    });
  });
}

function createAppendixItems(
  references: AnnotationExportReference[],
  includeSelectedText: boolean,
  font: PDFFont,
  boldFont: PDFFont,
  maxWidth: number,
): AppendixLayoutItem[] {
  return references.flatMap((reference) => {
    const typeLabel =
      reference.annotation.type === 'note-anchor'
        ? 'Direct Note'
        : reference.annotation.type === 'highlight'
          ? 'Highlight'
          : 'Underline';
    const heading = `[${reference.referenceNumber}] Page ${reference.annotation.pageNumber} - ${typeLabel}`;
    const items: AppendixLayoutItem[] = [
      {
        text: heading,
        style: 'entry-heading',
        height: 18,
        keepWithNext: true,
      },
    ];

    if (includeSelectedText) {
      items.push({
        text: 'Selected text:',
        style: 'label',
        height: APPENDIX_LINE_HEIGHT,
        keepWithNext: true,
      });
      items.push(
        ...wrapAppendixText(reference.annotation.text, maxWidth, (value) =>
          font.widthOfTextAtSize(value, APPENDIX_BODY_SIZE),
        ).map((line) => ({
          text: line,
          style: 'body' as const,
          height: APPENDIX_LINE_HEIGHT,
        })),
      );
      items.push({ text: '', style: 'spacer', height: 6 });
    }

    items.push({
      text: 'Note:',
      style: 'label',
      height: APPENDIX_LINE_HEIGHT,
      keepWithNext: true,
    });
    items.push(
      ...wrapAppendixText(reference.note.content, maxWidth, (value) =>
        font.widthOfTextAtSize(value, APPENDIX_BODY_SIZE),
      ).map((line) => ({
        text: line,
        style: 'body' as const,
        height: APPENDIX_LINE_HEIGHT,
      })),
    );
    items.push({
      text: '',
      style: 'spacer',
      height: 18,
    });

    // Measure the heading with the bold font now so unsupported punctuation is
    // detected by pdf-lib before any pages are serialized.
    boldFont.widthOfTextAtSize(heading, 11);
    return items;
  });
}

function assertAppendixTextIsSupported(
  documentTitle: string,
  references: AnnotationExportReference[],
  includeSelectedText: boolean,
  font: PDFFont,
): void {
  const supportedCodePoints = new Set(font.getCharacterSet());
  const unsupportedLocations: string[] = [];
  const inspect = (label: string, text: string) => {
    if (findUnsupportedAppendixCharacters(text, supportedCodePoints).length > 0) {
      unsupportedLocations.push(label);
    }
  };

  inspect('document title', documentTitle);
  for (const reference of references) {
    inspect(`Note [${reference.referenceNumber}]`, reference.note.content);
    if (includeSelectedText) {
      inspect(
        `selected source text [${reference.referenceNumber}]`,
        reference.annotation.text,
      );
    }
  }

  if (unsupportedLocations.length > 0) {
    throw new AnnotatedPdfExportError(
      `The bundled Unicode PDF font cannot encode characters in: ${unsupportedLocations.join(', ')}. Export annotations without the Notes appendix, or remove those unsupported characters.`,
      'unsupported-unicode',
    );
  }
}

async function embedUnicodeAppendixFont(
  pdfDocument: PDFDocument,
  loadFontBytes: () => Promise<Uint8Array>,
): Promise<PDFFont> {
  try {
    const [fontkitModule, fontBytes] = await Promise.all([
      import('@pdf-lib/fontkit'),
      loadFontBytes(),
    ]);
    if (fontBytes.byteLength === 0) {
      throw new Error('The bundled appendix font was empty.');
    }

    pdfDocument.registerFontkit(fontkitModule.default);
    return await pdfDocument.embedFont(fontBytes, { subset: true });
  } catch (error) {
    throw new AnnotatedPdfExportError(
      'The bundled Unicode PDF font could not be loaded. The original PDF was not changed.',
      'generic',
      { cause: error },
    );
  }
}

async function loadBundledAppendixFontBytes(): Promise<Uint8Array> {
  bundledAppendixFontBytesPromise ??= fetch(notoSansScRegularUrl).then(
    async (response) => {
      if (!response.ok) {
        throw new Error(`Bundled appendix font request failed (${response.status}).`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  );

  try {
    return await bundledAppendixFontBytesPromise;
  } catch (error) {
    bundledAppendixFontBytesPromise = null;
    throw error;
  }
}

function formatLocalDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isEncryptionError(error: unknown): boolean {
  return (
    error instanceof Error && /encrypt|password|security handler/i.test(error.message)
  );
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
