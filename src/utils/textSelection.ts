import type {
  PdfTextSelection,
  PdfTextSelectionRectangle,
} from '../types/textSelection';

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
    text: pageRange.toString(),
    pageNumber,
    pageWidth: layerRectangle.width,
    pageHeight: layerRectangle.height,
    boundingRectangles: getBoundingRectangles(pageRange, textLayer),
    startOffset: getTextOffset(textLayer, pageRange.startContainer, pageRange.startOffset),
    endOffset: getTextOffset(textLayer, pageRange.endContainer, pageRange.endOffset),
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
