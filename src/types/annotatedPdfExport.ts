import type { PdfAnnotation } from './highlight';
import type { Note } from './note';
import type { NoteAnchor } from './noteAnchor';

export type AnnotatedPdfContentMode = 'annotations' | 'annotations-and-notes';

export interface AnnotatedPdfExportOptions {
  contentMode: AnnotatedPdfContentMode;
  includeAnnotationColors: boolean;
  includeSelectedText: boolean;
  includeHiddenAnnotations: boolean;
  includeReferenceMarkers: boolean;
}

export interface PdfPageGeometry {
  viewBox: [number, number, number, number];
  userUnit: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PdfCoordinateRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfCoordinatePoint {
  x: number;
  y: number;
}

export interface PdfCoordinateLine {
  start: PdfCoordinatePoint;
  end: PdfCoordinatePoint;
  thickness: number;
}

export interface AnnotationExportReference {
  annotation: PdfAnnotation | NoteAnchor;
  note: Note;
  referenceNumber: number;
}

export interface AnnotatedPdfExportProgress {
  stage: 'preparing' | 'annotations' | 'appendix' | 'download';
  message: string;
  completed?: number;
  total?: number;
}

export interface AnnotatedPdfExportRequest {
  sourceBlob: Blob;
  documentTitle: string;
  annotations: PdfAnnotation[];
  notes: Note[];
  noteAnchors: NoteAnchor[];
  pageGeometries: PdfPageGeometry[];
  options: AnnotatedPdfExportOptions;
  onProgress?: (progress: AnnotatedPdfExportProgress) => void;
}

export interface AnnotatedPdfExportResult {
  bytes: Uint8Array;
  filename: string;
  exportedAnnotationCount: number;
  appendixEntryCount: number;
}

export interface AppendixLayoutItem {
  text: string;
  style: 'entry-heading' | 'label' | 'body' | 'spacer';
  height: number;
  keepWithNext?: boolean;
}
