import { DOCUMENT_MIME_TYPES } from '../../types/document';
import type { PdfSemanticAnchor } from '../anchors';
import type {
  DocumentAdapter,
  DocumentReadingPosition,
  DocumentTextSelection,
  OpenedDocument,
  ValidatedDocumentSource,
} from '../types';
import { searchDocumentEntries } from '../types';

export interface PdfRenderModel {
  readonly kind: 'existing-pdfjs-pipeline';
  readonly bytes: Uint8Array;
}

export interface OpenedPdfDocument extends OpenedDocument {
  readonly documentType: 'pdf';
  readonly mimeType: typeof DOCUMENT_MIME_TYPES.pdf;
  readonly renderModel: PdfRenderModel;
}

/**
 * Boundary wrapper for the accepted PDF.js reader. Rendering, text extraction,
 * search indexing, and legacy PDF annotation resolution remain owned by the
 * existing Viewer pipeline; this adapter intentionally does not duplicate it.
 */
export class PdfAdapter implements DocumentAdapter<OpenedPdfDocument> {
  readonly documentType = 'pdf' as const;
  readonly mimeType = DOCUMENT_MIME_TYPES.pdf;
  readonly capabilities = Object.freeze({
    layout: 'fixed-page' as const,
    textSelection: true,
    semanticAnchors: true,
    geometryAnchors: true,
    thumbnails: true,
    outline: true,
    annotatedPdfExport: true,
    printComposer: true,
    nativeLayoutExport: true,
  });

  async open(source: ValidatedDocumentSource): Promise<OpenedPdfDocument> {
    if (source.documentType !== 'pdf') {
      throw new Error('PdfAdapter received a non-PDF source.');
    }
    return {
      documentId: source.documentId,
      documentType: 'pdf',
      mimeType: DOCUMENT_MIME_TYPES.pdf,
      fileName: source.fileName,
      navigationUnits: [],
      outline: [],
      searchEntries: [],
      renderModel: {
        kind: 'existing-pdfjs-pipeline',
        bytes: source.bytes,
      },
    };
  }

  async search(document: OpenedPdfDocument, query: string) {
    return searchDocumentEntries(document.searchEntries, query);
  }

  createAnchor(
    document: OpenedPdfDocument,
    selection: DocumentTextSelection,
  ): PdfSemanticAnchor | null {
    if (selection.target.kind !== 'pdf-page' || !selection.text) return null;
    const first = selection.fragments[0];
    const rects = selection.fragments.flatMap((fragment) =>
      fragment.rect ? [fragment.rect] : [],
    );
    const startOffset = first?.startOffset ?? 0;
    return {
      version: 1,
      kind: 'pdf-text',
      documentId: document.documentId,
      pageNumber: selection.target.pageNumber,
      quote: selection.text.slice(0, 8_192),
      prefix: '',
      suffix: '',
      startOffset,
      endOffset: startOffset + selection.text.slice(0, 8_192).length,
      rects,
    };
  }

  async resolveAnchor(): Promise<{ status: 'missing' }> {
    // Resolution is delegated to the existing PDF.js text/geometry pipeline.
    return { status: 'missing' };
  }

  normalizeReadingPosition(
    _document: OpenedPdfDocument,
    position: DocumentReadingPosition,
  ): DocumentReadingPosition | null {
    if (position.kind !== 'pdf-position' || position.pageNumber < 1) return null;
    if (position.pageOffsetRatio < 0 || position.pageOffsetRatio > 1) return null;
    return position;
  }
}
