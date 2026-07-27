export interface NormalizedSearchRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfSearchResult {
  id: string;
  pageNumber: number;
  matchIndexOnPage: number;
  matchedText: string;
  contextBefore: string;
  contextAfter: string;
  rects: NormalizedSearchRectangle[];
  firstRect: NormalizedSearchRectangle | null;
  bounds: NormalizedSearchRectangle | null;
}

export interface PdfSearchPageIndex {
  pageNumber: number;
  text: string;
  items: Array<{
    start: number;
    end: number;
    rect: NormalizedSearchRectangle;
    direction: string;
  }>;
}
