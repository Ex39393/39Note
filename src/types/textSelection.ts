export interface PdfTextSelectionRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfTextSelection {
  text: string;
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  boundingRectangles: PdfTextSelectionRectangle[];
  startOffset: number;
  endOffset: number;
}
