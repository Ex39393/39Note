import type {
  PdfTextSelection,
  PdfTextSelectionRectangle,
} from '../types/textSelection';
import {
  reconstructPdfSourceText,
  type PdfSourceTextFragment,
  type PdfSourceTextFragmentRectangle,
} from './pdfSourceText.ts';
import { getPdfTextSourceItem } from './pdfTextSourceMap.ts';

export type PdfSelectionTextFragmentRectangle = PdfSourceTextFragmentRectangle;
export type PdfSelectionTextFragment = PdfSourceTextFragment;

export interface PdfSelectionTextSlice {
  text: string;
  startOffset: number;
  endOffset: number;
}

export function getPdfTextSelections(
  selection: Selection,
  viewerElement: HTMLElement,
): PdfTextSelection[] {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return [];
  }

  const selectionRange = selection.getRangeAt(0);

  return Array.from(
    viewerElement.querySelectorAll<HTMLElement>('[data-pdf-text-layer]'),
  ).flatMap((textLayer) => {
    const pageNumber = Number(textLayer.dataset.pageNumber);
    const pageSelection = getPageTextSelection(selectionRange, textLayer, pageNumber);
    return pageSelection ? [pageSelection] : [];
  });
}

function getPageTextSelection(
  selectionRange: Range,
  textLayer: HTMLElement,
  pageNumber: number,
): PdfTextSelection | null {
  if (!Number.isInteger(pageNumber) || !selectionRange.intersectsNode(textLayer)) {
    return null;
  }

  const layerRange = document.createRange();
  layerRange.selectNodeContents(textLayer);

  const pageRange = selectionRange.cloneRange();

  if (pageRange.compareBoundaryPoints(Range.START_TO_START, layerRange) < 0) {
    pageRange.setStart(textLayer, 0);
  }

  if (pageRange.compareBoundaryPoints(Range.END_TO_END, layerRange) > 0) {
    pageRange.setEnd(textLayer, textLayer.childNodes.length);
  }

  if (pageRange.collapsed) {
    return null;
  }

  const layerRectangle = textLayer.getBoundingClientRect();

  return {
    text: reconstructPdfSelectionText(
      getSelectedTextFragments(pageRange, textLayer),
    ),
    pageNumber,
    pageWidth: layerRectangle.width,
    pageHeight: layerRectangle.height,
    boundingRectangles: getBoundingRectangles(pageRange, textLayer),
    startOffset: getTextOffset(textLayer, pageRange.startContainer, pageRange.startOffset),
    endOffset: getTextOffset(textLayer, pageRange.endContainer, pageRange.endOffset),
  };
}

export function reconstructPdfSelectionText(
  fragments: readonly PdfSelectionTextFragment[],
): string {
  return reconstructPdfSourceText(fragments);
}

export function slicePdfTextFragment(
  text: string,
  fragmentStartOffset: number,
  selectionStartOffset: number,
  selectionEndOffset: number,
): PdfSelectionTextSlice | null {
  const startOffset = Math.max(
    0,
    Math.min(text.length, selectionStartOffset - fragmentStartOffset),
  );
  const endOffset = Math.max(
    0,
    Math.min(text.length, selectionEndOffset - fragmentStartOffset),
  );

  if (endOffset <= startOffset) {
    return null;
  }

  return {
    text: text.slice(startOffset, endOffset),
    startOffset,
    endOffset,
  };
}

function getSelectedTextFragments(
  range: Range,
  textLayer: HTMLElement,
): PdfSelectionTextFragment[] {
  const selectionStartOffset = getTextOffset(
    textLayer,
    range.startContainer,
    range.startOffset,
  );
  const selectionEndOffset = getTextOffset(
    textLayer,
    range.endContainer,
    range.endOffset,
  );
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  const fragments: PdfSelectionTextFragment[] = [];
  let fragmentStartOffset = 0;
  let order = 0;
  let node = walker.nextNode();

  while (node) {
    const textNode = node as Text;
    const sourceText = textNode.data;
    const slice = slicePdfTextFragment(
      sourceText,
      fragmentStartOffset,
      selectionStartOffset,
      selectionEndOffset,
    );

    if (slice) {
      const sourceItem = getPdfTextSourceItem(textNode);
      fragments.push({
        text: slice.text,
        order,
        rectangle: getSelectedFragmentRectangle(textNode, slice),
        ...(sourceItem ? { sourceItem } : {}),
        startsSourceItem: slice.startOffset === 0,
        endsSourceItem: slice.endOffset === sourceText.length,
      });
    }

    fragmentStartOffset += sourceText.length;
    order += 1;
    node = walker.nextNode();
  }

  return fragments;
}

function getSelectedFragmentRectangle(
  textNode: Text,
  slice: PdfSelectionTextSlice,
): PdfSelectionTextFragmentRectangle | null {
  const range = document.createRange();
  range.setStart(textNode, slice.startOffset);
  range.setEnd(textNode, slice.endOffset);
  const rectangles = Array.from(range.getClientRects()).filter(
    (rectangle) => rectangle.width > 0 && rectangle.height > 0,
  );

  if (rectangles.length === 0) {
    return null;
  }

  const left = Math.min(...rectangles.map((rectangle) => rectangle.left));
  const top = Math.min(...rectangles.map((rectangle) => rectangle.top));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.right));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.bottom));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function getBoundingRectangles(
  range: Range,
  textLayer: HTMLElement,
): PdfTextSelectionRectangle[] {
  const layerRectangle = textLayer.getBoundingClientRect();

  return Array.from(range.getClientRects())
    .filter((rectangle) => rectangle.width > 0 && rectangle.height > 0)
    .map((rectangle) => ({
      left: rectangle.left - layerRectangle.left,
      top: rectangle.top - layerRectangle.top,
      width: rectangle.width,
      height: rectangle.height,
    }));
}

function getTextOffset(
  textLayer: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = document.createRange();
  range.selectNodeContents(textLayer);
  range.setEnd(node, offset);
  return range.toString().length;
}
