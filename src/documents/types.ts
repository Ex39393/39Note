import type { DocumentMimeType, DocumentType } from '../types/document';
import type { AnchorResolution, DocumentSemanticAnchor } from './anchors';

export interface DocumentSource {
  readonly documentId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ValidatedDocumentSource extends DocumentSource {
  readonly documentType: DocumentType;
  readonly mimeType: DocumentMimeType;
  readonly validation: {
    readonly signature: 'pdf' | 'ooxml-zip';
    readonly entryNames?: readonly string[];
  };
}

export type DocumentLayout = 'fixed-page' | 'fixed-slide' | 'reflow';

/**
 * Product behavior is gated through these declarations instead of scattered
 * file-extension checks in the application shell.
 */
export interface DocumentCapabilities {
  readonly layout: DocumentLayout;
  readonly textSelection: boolean;
  readonly semanticAnchors: boolean;
  readonly geometryAnchors: boolean;
  readonly thumbnails: boolean;
  readonly outline: boolean;
  readonly annotatedPdfExport: boolean;
  readonly printComposer: boolean;
  readonly nativeLayoutExport: boolean;
}

export type DocumentNavigationTarget =
  | { readonly kind: 'pdf-page'; readonly pageNumber: number }
  | {
      readonly kind: 'pptx-slide';
      readonly slideIndex: number;
      readonly slideId: string;
    }
  | {
      readonly kind: 'docx-block';
      readonly blockIndex: number;
      readonly blockId: string;
    };

export interface DocumentNavigationUnit {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly target: DocumentNavigationTarget;
}

export interface DocumentOutlineItem {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly target: DocumentNavigationTarget;
  readonly children?: readonly DocumentOutlineItem[];
}

export interface DocumentSearchEntry {
  readonly id: string;
  readonly text: string;
  readonly target: DocumentNavigationTarget;
  readonly containerLabel: string;
}

export interface DocumentSearchResult extends DocumentSearchEntry {
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly excerpt: string;
}

export type DocumentTextUnitKind = 'page' | 'slide' | 'block';

/**
 * A format-native, locally extracted unit of text. The one-based index and
 * label are intentionally separate from PDF page terminology so consumers
 * never present Word blocks or PowerPoint slides as pages.
 */
export interface DocumentTextUnit {
  readonly index: number;
  readonly kind: DocumentTextUnitKind;
  readonly label: string;
  readonly text: string;
  readonly target: DocumentNavigationTarget;
}

export interface DocumentTextExtractionOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedUnits: number, totalUnits: number) => void;
}

/** Lazy bridge used by features such as AI. Loading remains local and only
 * begins when the feature explicitly asks for document context. */
export interface DocumentTextSource {
  readonly documentType: DocumentType;
  readonly unitKind: DocumentTextUnitKind;
  readonly totalUnits: number;
  loadUnits(
    options?: DocumentTextExtractionOptions,
  ): Promise<readonly DocumentTextUnit[]>;
}

export interface NormalizedDocumentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DocumentTextFragment {
  readonly containerId: string;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly rect?: NormalizedDocumentRect;
}

export interface DocumentTextSelection {
  readonly text: string;
  readonly target: DocumentNavigationTarget;
  readonly fragments: readonly DocumentTextFragment[];
}

export type DocumentReadingPosition =
  | {
      readonly kind: 'pdf-position';
      readonly pageNumber: number;
      readonly pageOffsetRatio: number;
    }
  | {
      readonly kind: 'pptx-position';
      readonly slideIndex: number;
      readonly slideId: string;
    }
  | {
      readonly kind: 'docx-position';
      readonly blockIndex: number;
      readonly blockId: string;
      readonly blockOffsetRatio: number;
    };

export interface OpenedDocument {
  readonly documentId: string;
  readonly documentType: DocumentType;
  readonly mimeType: DocumentMimeType;
  readonly fileName: string;
  readonly navigationUnits: readonly DocumentNavigationUnit[];
  readonly outline: readonly DocumentOutlineItem[];
  readonly searchEntries: readonly DocumentSearchEntry[];
  /** Adapter-owned, immutable model consumed by the format renderer. */
  readonly renderModel: unknown;
}

export interface DocumentAdapter<TDocument extends OpenedDocument = OpenedDocument> {
  readonly documentType: DocumentType;
  readonly mimeType: DocumentMimeType;
  readonly capabilities: DocumentCapabilities;
  open(source: ValidatedDocumentSource): Promise<TDocument>;
  search(document: TDocument, query: string): Promise<readonly DocumentSearchResult[]>;
  /**
   * Optional because the accepted PDF.js reader keeps its existing extraction
   * pipeline. Office adapters expose their own bounded, format-native source.
   */
  extractTextUnits?(
    document: TDocument,
    options?: DocumentTextExtractionOptions,
  ): Promise<readonly DocumentTextUnit[]>;
  createAnchor(
    document: TDocument,
    selection: DocumentTextSelection,
  ): DocumentSemanticAnchor | null;
  resolveAnchor(
    document: TDocument,
    anchor: DocumentSemanticAnchor,
  ): Promise<AnchorResolution>;
  normalizeReadingPosition(
    document: TDocument,
    position: DocumentReadingPosition,
  ): DocumentReadingPosition | null;
}

export function searchDocumentEntries(
  entries: readonly DocumentSearchEntry[],
  query: string,
): DocumentSearchResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const results: DocumentSearchResult[] = [];
  for (const entry of entries) {
    const searchable = entry.text.toLocaleLowerCase();
    let fromIndex = 0;
    while (fromIndex <= searchable.length) {
      const matchStart = searchable.indexOf(normalizedQuery, fromIndex);
      if (matchStart < 0) break;
      const matchEnd = matchStart + normalizedQuery.length;
      const excerptStart = Math.max(0, matchStart - 48);
      const excerptEnd = Math.min(entry.text.length, matchEnd + 72);
      results.push({
        ...entry,
        matchStart,
        matchEnd,
        excerpt: entry.text.slice(excerptStart, excerptEnd),
      });
      fromIndex = Math.max(matchEnd, matchStart + 1);
    }
  }
  return results;
}
