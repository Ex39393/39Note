export type DocumentOpenSource =
  | 'normal-library-open'
  | 'library-note-result'
  | 'document-note'
  | 'pdf-search-result'
  | 'page-input'
  | 'outline'
  | 'thumbnail';

export type DocumentOpenTarget =
  | {
      type: 'annotation';
      annotationId: string;
      pageNumber: number;
      noteId?: string;
    }
  | {
      type: 'pdf-search';
      resultId: string;
      pageNumber: number;
    }
  | {
      type: 'page';
      pageNumber: number;
      pageOffsetRatio?: number;
    }
  | null;

export interface DocumentOpenRequest {
  requestId: string;
  documentId: string;
  source: DocumentOpenSource;
  target: DocumentOpenTarget;
  createdAt: number;
  generation: number;
  navigationEpoch: number;
}
