import { DOCUMENT_MIME_TYPES } from '../../types/document';
import {
  createPptxTextAnchor,
  resolvePptxTextAnchor,
  type PptxSemanticAnchor,
  type PptxAnchorTextContainer,
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
import type { PptxRenderModel, PptxSlide } from './model';
import { flattenShapes, parsePptxPresentation, searchEntriesForSlide } from './parser';

export interface OpenedPptxDocument extends OpenedDocument {
  readonly documentType: 'pptx';
  readonly mimeType: typeof DOCUMENT_MIME_TYPES.pptx;
  readonly renderModel: PptxRenderModel;
}

export class PptxAdapter implements DocumentAdapter<OpenedPptxDocument> {
  readonly documentType = 'pptx' as const;
  readonly mimeType = DOCUMENT_MIME_TYPES.pptx;
  readonly capabilities = Object.freeze({
    layout: 'fixed-slide' as const,
    textSelection: true,
    semanticAnchors: true,
    geometryAnchors: true,
    thumbnails: true,
    outline: true,
    annotatedPdfExport: false,
    printComposer: false,
    nativeLayoutExport: false,
  });

  async open(source: ValidatedDocumentSource): Promise<OpenedPptxDocument> {
    if (source.documentType !== 'pptx') {
      throw new Error('PptxAdapter received a non-PPTX source.');
    }
    const pkg = await OoxmlPackage.open(source.bytes, 'pptx');
    const renderModel = await parsePptxPresentation(pkg);
    return {
      documentId: source.documentId,
      documentType: 'pptx',
      mimeType: DOCUMENT_MIME_TYPES.pptx,
      fileName: source.fileName,
      navigationUnits: renderModel.slides.map((slide) => ({
        id: slide.id,
        index: slide.index,
        label: slide.label,
        target: { kind: 'pptx-slide', slideId: slide.id, slideIndex: slide.index },
      })),
      outline: renderModel.slides.map((slide) => ({
        id: slide.id,
        label: slide.label,
        level: 1,
        target: { kind: 'pptx-slide', slideId: slide.id, slideIndex: slide.index },
      })),
      searchEntries: [],
      renderModel,
    };
  }

  async search(document: OpenedPptxDocument, query: string) {
    const slides = await loadWithConcurrency(document.renderModel.slides, 4);
    return searchDocumentEntries(slides.flatMap(searchEntriesForSlide), query);
  }

  async extractTextUnits(
    document: OpenedPptxDocument,
    options: DocumentTextExtractionOptions = {},
  ): Promise<readonly DocumentTextUnit[]> {
    const slides = await loadWithConcurrency(
      document.renderModel.slides,
      4,
      options.signal,
      options.onProgress,
    );
    return slides.map((slide) => ({
      index: slide.index + 1,
      kind: 'slide' as const,
      label: `Slide ${slide.index + 1}`,
      text: searchEntriesForSlide(slide)
        .map((entry) => entry.text.trim())
        .filter(Boolean)
        .join('\n'),
      target: {
        kind: 'pptx-slide' as const,
        slideId: slide.id,
        slideIndex: slide.index,
      },
    }));
  }

  createAnchor(
    document: OpenedPptxDocument,
    selection: DocumentTextSelection,
  ): PptxSemanticAnchor | null {
    if (selection.target.kind !== 'pptx-slide') return null;
    const slide = document.renderModel.slides[selection.target.slideIndex]?.peek();
    const fragment = selection.fragments[0];
    if (!slide || !fragment) return null;
    const parsed = parsePptxContainerId(fragment.containerId);
    if (!parsed || parsed.slideId !== slide.id) return null;
    const shape = flattenShapes(slide.shapes).find(
      (candidate) => candidate.id === parsed.shapeId,
    );
    const paragraph = shape?.paragraphs[parsed.paragraphIndex];
    if (!shape || !paragraph) return null;
    return createPptxTextAnchor({
      documentId: document.documentId,
      slideId: slide.id,
      slideIndex: slide.index,
      shapeId: shape.id,
      paragraphIndex: paragraph.index,
      containerText: paragraph.text,
      startOffset: fragment.startOffset,
      endOffset: fragment.endOffset,
      rects: selection.fragments.flatMap((candidate) =>
        candidate.rect ? [candidate.rect] : [],
      ),
    });
  }

  async resolveAnchor(
    document: OpenedPptxDocument,
    anchor: Parameters<typeof resolvePptxTextAnchor>[0],
  ) {
    if (anchor.kind !== 'pptx-text' || anchor.documentId !== document.documentId) {
      return { status: 'missing' as const };
    }
    const descriptor = document.renderModel.slides.find(
      (slide) => slide.id === anchor.slideId,
    );
    if (!descriptor) return { status: 'missing' as const };
    const slide = await descriptor.load();
    return resolvePptxTextAnchor(anchor, createAnchorContainers(slide));
  }

  normalizeReadingPosition(
    document: OpenedPptxDocument,
    position: DocumentReadingPosition,
  ): DocumentReadingPosition | null {
    if (position.kind !== 'pptx-position') return null;
    const byId = document.renderModel.slides.find(
      (slide) => slide.id === position.slideId,
    );
    const slide = byId ?? document.renderModel.slides[position.slideIndex];
    return slide
      ? { kind: 'pptx-position', slideId: slide.id, slideIndex: slide.index }
      : null;
  }
}

function createAnchorContainers(slide: PptxSlide): PptxAnchorTextContainer[] {
  return flattenShapes(slide.shapes).flatMap((shape) =>
    shape.paragraphs.map((paragraph) => ({
      slideId: slide.id,
      slideIndex: slide.index,
      shapeId: shape.id,
      paragraphIndex: paragraph.index,
      text: paragraph.text,
      rects: [
        {
          x: clampRatio(shape.bounds.xEmu / slide.size.widthEmu),
          y: clampRatio(shape.bounds.yEmu / slide.size.heightEmu),
          width: clampRatio(shape.bounds.widthEmu / slide.size.widthEmu),
          height: clampRatio(shape.bounds.heightEmu / slide.size.heightEmu),
        },
      ],
    })),
  );
}

function parsePptxContainerId(value: string): {
  slideId: string;
  shapeId: string;
  paragraphIndex: number;
} | null {
  const parts = value.split('/');
  const paragraphIndex = Number(parts.at(-1));
  if (parts.length !== 3 || !Number.isSafeInteger(paragraphIndex) || paragraphIndex < 0)
    return null;
  return { slideId: parts[0], shapeId: parts[1], paragraphIndex };
}

async function loadWithConcurrency(
  descriptors: PptxRenderModel['slides'],
  concurrency: number,
  signal?: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<PptxSlide[]> {
  const results = new Array<PptxSlide>(descriptors.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, descriptors.length) },
    async () => {
      while (nextIndex < descriptors.length) {
        throwIfAborted(signal);
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await descriptors[index].load();
        throwIfAborted(signal);
        completed += 1;
        onProgress?.(completed, descriptors.length);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Text extraction stopped.', 'AbortError');
}

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
