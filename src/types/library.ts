export type ReadingZoomMode = 'custom' | 'fit-width' | 'fit-page';

export interface ReadingPosition {
  pageNumber: number;
  pageOffsetRatio: number;
  zoomMode: ReadingZoomMode;
  zoomPercent: number;
  updatedAt: number;
}

export interface CollectionRecord {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export interface TagRecord {
  id: string;
  name: string;
  normalizedName: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentLibraryMetadata {
  collectionIds: string[];
  tagIds: string[];
  isPinned: boolean;
  pinnedAt?: number;
  lastReadAt?: number;
  readingPosition?: ReadingPosition;
}
