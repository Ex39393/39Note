import type { NormalizedHighlightRectangle } from './highlight';

/** A non-visual, persisted source location for a Note created from text selection. */
export interface NoteAnchor {
  id: string;
  type: 'note-anchor';
  pageNumber: number;
  text: string;
  rects: NormalizedHighlightRectangle[];
  startOffset: number;
  endOffset: number;
  createdAt: number;
  updatedAt: number;
}
