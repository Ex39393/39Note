import type { PDFPageProxy } from 'pdfjs-dist';

type PdfJsTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

export interface PdfTextSourceItem {
  index: number;
  str: string;
  hasEOL: boolean;
  width: number;
  height: number;
  transform: readonly number[];
  fontName: string;
}

export interface PdfTextSourceMap {
  pageNumber: number;
  items: readonly PdfTextSourceItem[];
  lineBoundaries: readonly number[];
}

const sourceMaps = new WeakMap<HTMLElement, PdfTextSourceMap>();
const sourceItemsByTextNode = new WeakMap<Text, PdfTextSourceItem>();

export function attachPdfTextSourceMap(
  textLayer: HTMLElement,
  pageNumber: number,
  textContent: PdfJsTextContent,
): PdfTextSourceMap {
  const items = textContent.items.flatMap((item, index) => {
    if (!('str' in item)) return [];
    return [{
      index,
      str: item.str,
      hasEOL: item.hasEOL,
      width: item.width,
      height: item.height,
      transform: [...item.transform],
      fontName: item.fontName,
    } satisfies PdfTextSourceItem];
  });
  const sourceMap: PdfTextSourceMap = {
    pageNumber,
    items,
    lineBoundaries: items.flatMap((item) => item.hasEOL ? [item.index] : []),
  };
  sourceMaps.set(textLayer, sourceMap);
  mapTextLayerNodes(textLayer, items);
  return sourceMap;
}

export function detachPdfTextSourceMap(textLayer: HTMLElement): void {
  sourceMaps.delete(textLayer);
}

export function getPdfTextSourceMap(
  textLayer: HTMLElement,
): PdfTextSourceMap | null {
  return sourceMaps.get(textLayer) ?? null;
}

export function getPdfTextSourceItem(
  textNode: Text,
): PdfTextSourceItem | null {
  return sourceItemsByTextNode.get(textNode) ?? null;
}

function mapTextLayerNodes(
  textLayer: HTMLElement,
  items: readonly PdfTextSourceItem[],
): void {
  const indexesByText = new Map<string, number[]>();
  for (const item of items) {
    const indexes = indexesByText.get(item.str) ?? [];
    indexes.push(item.index);
    indexesByText.set(item.str, indexes);
  }

  const itemsByIndex = new Map(items.map((item) => [item.index, item]));
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const indexes = indexesByText.get(textNode.data);
    const itemIndex = indexes?.shift();
    const item = itemIndex === undefined ? undefined : itemsByIndex.get(itemIndex);
    if (item) {
      sourceItemsByTextNode.set(textNode, item);
      const element = textNode.parentElement;
      if (element) {
        element.dataset.pdfSourceItemIndex = String(item.index);
        element.dataset.pdfHasEol = String(item.hasEOL);
      }
    }
    node = walker.nextNode();
  }
}
