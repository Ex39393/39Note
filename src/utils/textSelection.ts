import type {
  PdfTextSelection,
  PdfTextSelectionRectangle,
} from '../types/textSelection';

export interface PdfSelectionTextFragmentRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfSelectionTextFragment {
  text: string;
  order: number;
  rectangle: PdfSelectionTextFragmentRectangle | null;
}

export interface PdfSelectionTextSlice {
  text: string;
  startOffset: number;
  endOffset: number;
}

const NO_SPACE_BEFORE = ",;:!?%)]}’”'*/-–—";
const NO_SPACE_AFTER = "([{‘“'*/-–—";
const SCRIPT_WITHOUT_WORD_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ATTACHED_MARK = /[\p{M}\u00b2\u00b3\u00b9\u2070-\u209f]/u;

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
  const orderedFragments = [...fragments]
    .filter((fragment) => fragment.text.length > 0)
    .sort((first, second) => first.order - second.order);

  const reconstructed = orderedFragments.reduce((text, fragment, index) => {
    const previous = orderedFragments[index - 1];
    const separator = previous && shouldInsertSyntheticSpace(previous, fragment)
      ? ' '
      : '';
    return `${text}${separator}${fragment.text}`;
  }, '');

  return reconstructed.replaceAll(/\s+/gu, ' ').trim();
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
      fragments.push({
        text: slice.text,
        order,
        rectangle: getSelectedFragmentRectangle(textNode, slice),
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

function shouldInsertSyntheticSpace(
  previous: PdfSelectionTextFragment,
  next: PdfSelectionTextFragment,
): boolean {
  if (/\s$/u.test(previous.text) || /^\s/u.test(next.text)) {
    return false;
  }

  const previousCharacter = previous.text.at(-1);
  const nextCharacter = next.text.at(0);
  if (!previousCharacter || !nextCharacter) {
    return false;
  }
  if (
    preventsSpaceBefore(next.text, nextCharacter) ||
    NO_SPACE_AFTER.includes(previousCharacter) ||
    ATTACHED_MARK.test(nextCharacter) ||
    (
      SCRIPT_WITHOUT_WORD_SPACES.test(previousCharacter) &&
      SCRIPT_WITHOUT_WORD_SPACES.test(nextCharacter)
    )
  ) {
    return false;
  }

  const previousRectangle = previous.rectangle;
  const nextRectangle = next.rectangle;
  if (!previousRectangle || !nextRectangle) {
    return false;
  }

  if (!areOnSameVisualLine(previousRectangle, nextRectangle)) {
    return true;
  }

  const horizontalGap = nextRectangle.left - (
    previousRectangle.left + previousRectangle.width
  );
  return horizontalGap >= getMeaningfulWordGap(
    previous,
    next,
    previousRectangle,
    nextRectangle,
  );
}

function preventsSpaceBefore(text: string, firstCharacter: string): boolean {
  if (firstCharacter === '.' && /^\.\d/u.test(text)) {
    return false;
  }
  return firstCharacter === '.' || NO_SPACE_BEFORE.includes(firstCharacter);
}

function areOnSameVisualLine(
  previous: PdfSelectionTextFragmentRectangle,
  next: PdfSelectionTextFragmentRectangle,
): boolean {
  const previousBottom = previous.top + previous.height;
  const nextBottom = next.top + next.height;
  const overlap = Math.min(previousBottom, nextBottom) - Math.max(previous.top, next.top);
  const minimumHeight = Math.min(previous.height, next.height);
  const previousCenter = previous.top + previous.height / 2;
  const nextCenter = next.top + next.height / 2;

  return (
    overlap >= minimumHeight * 0.2 ||
    Math.abs(previousCenter - nextCenter) <= Math.max(previous.height, next.height) * 0.55
  );
}

function getMeaningfulWordGap(
  previous: PdfSelectionTextFragment,
  next: PdfSelectionTextFragment,
  previousRectangle: PdfSelectionTextFragmentRectangle,
  nextRectangle: PdfSelectionTextFragmentRectangle,
): number {
  const textHeight = Math.min(previousRectangle.height, nextRectangle.height);
  const localCharacterWidth = Math.min(
    getAverageCharacterWidth(previous.text, previousRectangle.width, textHeight),
    getAverageCharacterWidth(next.text, nextRectangle.width, textHeight),
  );

  return Math.max(
    textHeight * 0.08,
    Math.min(textHeight * 0.24, localCharacterWidth * 0.18),
  );
}

function getAverageCharacterWidth(
  text: string,
  width: number,
  fallbackHeight: number,
): number {
  const characterCount = Array.from(text).filter((character) => !/\s/u.test(character)).length;
  return characterCount > 0 && width > 0
    ? width / characterCount
    : fallbackHeight * 0.5;
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
