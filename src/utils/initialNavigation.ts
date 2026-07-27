import type { DocumentOpenRequest, DocumentOpenTarget } from '../types/documentOpen';
import type { ReadingPosition } from '../types/library';

export type AnnotationLookupState = 'not-required' | 'pending' | 'found' | 'missing';
export type DocumentReadyState = 'loading' | 'hydrated';

export type InitialNavigationDecision =
  | {
      type: 'wait-for-explicit-target';
      requestId: string;
    }
  | {
      type: 'explicit-annotation-target';
      requestId: string;
      annotationId: string;
      noteId?: string;
    }
  | {
      type: 'explicit-target';
      requestId: string;
      target: Exclude<Exclude<DocumentOpenTarget, null>, { type: 'annotation' }>;
    }
  | {
      type: 'saved-position';
      requestId: string;
      position: ReadingPosition;
    }
  | {
      type: 'page-one';
      requestId: string;
    }
  | {
      type: 'invalid-target-fallback';
      requestId: string;
      fallback: 'saved-position' | 'page-one';
      position?: ReadingPosition;
    };

interface ResolveInitialNavigationInput {
  openRequest: DocumentOpenRequest | null;
  activeRequestId: string | null;
  activeNavigationEpoch: number;
  savedReadingPosition: ReadingPosition | null;
  annotationLookupState: AnnotationLookupState;
  documentReadyState: DocumentReadyState;
  pageCount?: number;
}

export function resolveInitialNavigation({
  openRequest,
  activeRequestId,
  activeNavigationEpoch,
  savedReadingPosition,
  annotationLookupState,
  documentReadyState,
  pageCount,
}: ResolveInitialNavigationInput): InitialNavigationDecision | null {
  if (
    !openRequest
    || openRequest.requestId !== activeRequestId
    || openRequest.navigationEpoch !== activeNavigationEpoch
  ) {
    return null;
  }

  const target = openRequest.target;
  if (target) {
    if (documentReadyState !== 'hydrated') {
      return { type: 'wait-for-explicit-target', requestId: openRequest.requestId };
    }

    if (target.type === 'annotation') {
      if (annotationLookupState === 'pending') {
        return { type: 'wait-for-explicit-target', requestId: openRequest.requestId };
      }

      if (annotationLookupState === 'missing') {
        const validSavedPosition = getValidReadingPosition(savedReadingPosition, pageCount);
        return validSavedPosition
          ? {
              type: 'invalid-target-fallback',
              requestId: openRequest.requestId,
              fallback: 'saved-position',
              position: validSavedPosition,
            }
          : {
              type: 'invalid-target-fallback',
              requestId: openRequest.requestId,
              fallback: 'page-one',
            };
      }

      return {
        type: 'explicit-annotation-target',
        requestId: openRequest.requestId,
        annotationId: target.annotationId,
        ...(target.noteId ? { noteId: target.noteId } : {}),
      };
    }

    return {
      type: 'explicit-target',
      requestId: openRequest.requestId,
      target,
    };
  }

  if (openRequest.source !== 'normal-library-open') {
    return null;
  }

  if (documentReadyState !== 'hydrated') {
    return null;
  }

  const validSavedPosition = getValidReadingPosition(savedReadingPosition, pageCount);
  return validSavedPosition
    ? {
        type: 'saved-position',
        requestId: openRequest.requestId,
        position: validSavedPosition,
      }
    : {
        type: 'page-one',
        requestId: openRequest.requestId,
      };
}

export function getValidReadingPosition(
  position: ReadingPosition | null,
  pageCount?: number,
): ReadingPosition | null {
  if (
    !position
    || !Number.isInteger(position.pageNumber)
    || position.pageNumber < 1
    || (pageCount !== undefined && pageCount > 0 && position.pageNumber > pageCount)
    || !Number.isFinite(position.pageOffsetRatio)
    || position.pageOffsetRatio < 0
    || position.pageOffsetRatio > 1
    || !Number.isFinite(position.zoomPercent)
    || position.zoomPercent <= 0
  ) {
    return null;
  }

  return position;
}
