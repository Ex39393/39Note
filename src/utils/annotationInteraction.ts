import type { PdfAnnotation } from '../types/highlight';
import type { PdfGlossaryEntry } from '../types/glossary';
import { findAnnotationsAtNormalizedPoint } from './annotationOverlap.ts';

export const ANNOTATION_TAP_MOVEMENT_THRESHOLD = 6;

export interface AnnotationPointerStart {
  pointerId: number;
  clientX: number;
  clientY: number;
}

export function isSimpleAnnotationTap(
  start: AnnotationPointerStart | null,
  end: { pointerId: number; clientX: number; clientY: number },
  hasMeaningfulSelection: boolean,
): boolean {
  if (!start || start.pointerId !== end.pointerId || hasMeaningfulSelection) {
    return false;
  }
  return (
    Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) <=
    ANNOTATION_TAP_MOVEMENT_THRESHOLD
  );
}

export function isAnnotationTapInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        [
          'a',
          'button',
          'input',
          'textarea',
          'select',
          '[contenteditable="true"]',
          '.definition-bubble',
          '.pdf-search-bar',
          '.selection-action',
          '.annotation-tag',
        ].join(','),
      ),
    )
  );
}

export interface AnnotationHitBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function findAnnotationsAtClientPoint(
  pageNumber: number,
  bounds: AnnotationHitBounds,
  point: { clientX: number; clientY: number },
  annotations: readonly PdfAnnotation[],
): PdfAnnotation[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  return findAnnotationsAtNormalizedPoint(
    pageNumber,
    {
      x: (point.clientX - bounds.left) / bounds.width,
      y: (point.clientY - bounds.top) / bounds.height,
    },
    annotations,
  );
}

export function findPdfGlossaryEntriesAtClientPoint(
  pageNumber: number,
  bounds: AnnotationHitBounds,
  point: { clientX: number; clientY: number },
  glossaryEntries: readonly PdfGlossaryEntry[],
): PdfGlossaryEntry[] {
  if (bounds.width <= 0 || bounds.height <= 0) return [];
  const normalizedPoint = {
    x: (point.clientX - bounds.left) / bounds.width,
    y: (point.clientY - bounds.top) / bounds.height,
  };
  return glossaryEntries.filter(
    (entry) =>
      entry.pageNumber === pageNumber &&
      entry.sourceRects.some(
        (rectangle) =>
          normalizedPoint.x >= rectangle.x &&
          normalizedPoint.x <= rectangle.x + rectangle.width &&
          normalizedPoint.y >= rectangle.y &&
          normalizedPoint.y <= rectangle.y + rectangle.height,
      ),
  );
}
