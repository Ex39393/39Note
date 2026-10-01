import { DOCUMENT_MIME_TYPES } from '../../types/document';
import {
  createDocxTextAnchor,
  resolveDocxTextAnchor,
  type DocxAnchorTextContainer,
  type DocxSemanticAnchor,
} from '../anchors';
import { OoxmlPackage } from '../ooxml/package';
import type {
  DocumentAdapter,
  DocumentReadingPosition,
  DocumentTextExtractionOptions,
  DocumentTextSelection,
  DocumentTextUnit,
  OpenedDocument,
  ValidatedDocumentSource,
} from '../types';
import { searchDocumentEntries } from '../types';
import type { DocxParagraphBlock, DocxRenderModel } from './model';
import {
  createDocxOutline,
  createDocxSearchEntries,
  flattenDocxBlocks,
  parseDocxDocument,
} from './parser';

export interface OpenedDocxDocument extends OpenedDocument {
  readonly documentType: 'docx';
  readonly mimeType: typeof DOCUMENT_MIME_TYPES.docx;
  readonly renderModel: DocxRenderModel;
}

export class DocxAdapter implements DocumentAdapter<OpenedDocxDocument> {
  readonly documentType = 'docx' as const;
  readonly mimeType = DOCUMENT_MIME_TYPES.docx;
  readonly capabilities = Object.freeze({
    layout: 'reflow' as const,
    textSelection: true,
    semanticAnchors: true,
    geometryAnchors: false,
    thumbnails: false,
    outline: true,
    annotatedPdfExport: false,
    printComposer: false,
    nativeLayoutExport: false,
  });

  async open(source: ValidatedDocumentSource): Promise<OpenedDocxDocument> {
    if (source.documentType !== 'docx') {
      throw new Error('DocxAdapter received a non-DOCX source.');
    }
    const pkg = await OoxmlPackage.open(source.bytes, 'docx');
    const renderModel = await parseDocxDocument(pkg);
    const outline = createDocxOutline(renderModel);
    const searchEntries = createDocxSearchEntries(renderModel);
    const navigationSource =
      outline.length > 0
        ? outline
        : searchEntries.slice(0, 10_000).map((entry, index) => ({
            id: entry.id,
            label: entry.text.trim().slice(0, 80) || `Block ${index + 1}`,
            level: 1,
            target: entry.target,
          }));
    return {
      documentId: source.documentId,
      documentType: 'docx',
      mimeType: DOCUMENT_MIME_TYPES.docx,
      fileName: source.fileName,
      navigationUnits: navigationSource.map((item, index) => ({
        id: item.id,
        index,
        label: item.label,
        target: item.target,
      })),
      outline,
      searchEntries,
      renderModel,
    };
  }

  async search(document: OpenedDocxDocument, query: string) {
    return searchDocumentEntries(document.searchEntries, query);
  }

  async extractTextUnits(
    document: OpenedDocxDocument,
    options: DocumentTextExtractionOptions = {},
  ): Promise<readonly DocumentTextUnit[]> {
    const total = document.searchEntries.length;
    const units: DocumentTextUnit[] = [];
    for (const entry of document.searchEntries) {
      if (options.signal?.aborted) {
        throw new DOMException('Text extraction stopped.', 'AbortError');
      }
      if (entry.target.kind !== 'docx-block') continue;
      units.push({
        index: entry.target.blockIndex + 1,
        kind: 'block',
        label: `Block ${entry.target.blockIndex + 1}`,
        text: entry.text,
        target: entry.target,
      });
      options.onProgress?.(units.length, total);
    }
    return units;
  }

  createAnchor(
    document: OpenedDocxDocument,
    selection: DocumentTextSelection,
  ): DocxSemanticAnchor | null {
    if (selection.target.kind !== 'docx-block') return null;
    const fragment = selection.fragments[0];
    if (!fragment) return null;
    const paragraph = paragraphs(document.renderModel).find(
      (candidate) => candidate.id === fragment.containerId,
    );
    if (!paragraph) return null;
    return createDocxTextAnchor({
      documentId: document.documentId,
      blockId: paragraph.id,
      blockIndex: paragraph.index,
      structuralPath: paragraph.structuralPath,
      containerText: paragraph.text,
      startOffset: fragment.startOffset,
      endOffset: fragment.endOffset,
    });
  }

  async resolveAnchor(
    document: OpenedDocxDocument,
    anchor: Parameters<typeof resolveDocxTextAnchor>[0],
  ) {
    if (anchor.kind !== 'docx-text' || anchor.documentId !== document.documentId) {
      return { status: 'missing' as const };
    }
    return resolveDocxTextAnchor(
      anchor,
      paragraphs(document.renderModel).map(toAnchorContainer),
    );
  }

  normalizeReadingPosition(
    document: OpenedDocxDocument,
    position: DocumentReadingPosition,
  ): DocumentReadingPosition | null {
    if (position.kind !== 'docx-position') return null;
    const allBlocks = flattenDocxBlocks(document.renderModel.blocks);
    const byId = allBlocks.find((block) => block.id === position.blockId);
    const block =
      byId ?? allBlocks.find((candidate) => candidate.index === position.blockIndex);
    if (!block) return null;
    return {
      kind: 'docx-position',
      blockId: block.id,
      blockIndex: block.index,
      blockOffsetRatio: Math.min(1, Math.max(0, position.blockOffsetRatio)),
    };
  }
}

function paragraphs(model: DocxRenderModel): DocxParagraphBlock[] {
  return flattenDocxBlocks(model.blocks).filter(
    (block): block is DocxParagraphBlock => block.kind === 'paragraph',
  );
}

function toAnchorContainer(paragraph: DocxParagraphBlock): DocxAnchorTextContainer {
  return {
    blockId: paragraph.id,
    blockIndex: paragraph.index,
    structuralPath: paragraph.structuralPath,
    text: paragraph.text,
  };
}
