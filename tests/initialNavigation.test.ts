import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentOpenRequest } from '../src/types/documentOpen.ts';
import type { ReadingPosition } from '../src/types/library.ts';
import { resolveInitialNavigation } from '../src/utils/initialNavigation.ts';

const savedPage23: ReadingPosition = {
  pageNumber: 23,
  pageOffsetRatio: 0.4,
  zoomMode: 'fit-width',
  zoomPercent: 1.25,
  updatedAt: 1,
};

function request(target: DocumentOpenRequest['target']): DocumentOpenRequest {
  return {
    requestId: 'request-active',
    documentId: 'document-1',
    source: target ? 'library-note-result' : 'normal-library-open',
    target,
    createdAt: 1,
    generation: 2,
    navigationEpoch: 3,
  };
}

function resolve(
  openRequest: DocumentOpenRequest,
  overrides: Partial<Parameters<typeof resolveInitialNavigation>[0]> = {},
) {
  return resolveInitialNavigation({
    openRequest,
    activeRequestId: openRequest.requestId,
    activeNavigationEpoch: openRequest.navigationEpoch,
    savedReadingPosition: null,
    annotationLookupState: openRequest.target?.type === 'annotation' ? 'found' : 'not-required',
    documentReadyState: 'hydrated',
    pageCount: 30,
    ...overrides,
  });
}

const annotationTarget = {
  type: 'annotation' as const,
  annotationId: 'annotation-5',
  noteId: 'note-5',
  pageNumber: 5,
};

test('explicit target takes priority over a saved position', () => {
  const openRequest = request(annotationTarget);
  assert.deepEqual(resolve(openRequest, {
    savedReadingPosition: savedPage23,
    annotationLookupState: 'found',
  }), {
    type: 'explicit-annotation-target',
    requestId: openRequest.requestId,
    annotationId: annotationTarget.annotationId,
    noteId: annotationTarget.noteId,
  });
});

test('unhydrated annotation target waits', () => {
  const openRequest = request(annotationTarget);
  assert.equal(resolve(openRequest, {
    savedReadingPosition: savedPage23,
    annotationLookupState: 'pending',
    documentReadyState: 'loading',
  })?.type, 'wait-for-explicit-target');
});

test('valid annotation target resolves after hydration', () => {
  const openRequest = request(annotationTarget);
  assert.equal(resolve(openRequest, {
    annotationLookupState: 'found',
  })?.type, 'explicit-annotation-target');
});

test('invalid target falls back to the valid saved position', () => {
  const openRequest = request(annotationTarget);
  const decision = resolve(openRequest, {
    savedReadingPosition: savedPage23,
    annotationLookupState: 'missing',
  });
  assert.equal(decision?.type, 'invalid-target-fallback');
  assert.equal(decision?.type === 'invalid-target-fallback' ? decision.fallback : null, 'saved-position');
});

test('normal open restores a valid saved position', () => {
  const openRequest = request(null);
  assert.equal(resolve(openRequest, {
    savedReadingPosition: savedPage23,
    annotationLookupState: 'not-required',
  })?.type, 'saved-position');
});

test('normal open without a saved position uses page one', () => {
  const openRequest = request(null);
  assert.equal(resolve(openRequest, {
    annotationLookupState: 'not-required',
  })?.type, 'page-one');
});

test('stale request id produces no decision', () => {
  const openRequest = request(annotationTarget);
  assert.equal(resolveInitialNavigation({
    openRequest,
    activeRequestId: 'request-newer',
    activeNavigationEpoch: openRequest.navigationEpoch,
    savedReadingPosition: savedPage23,
    annotationLookupState: 'found',
    documentReadyState: 'hydrated',
  }), null);
});

test('invalid target without a saved position falls back to page one', () => {
  const openRequest = request(annotationTarget);
  const decision = resolve(openRequest, {
    annotationLookupState: 'missing',
  });
  assert.equal(decision?.type, 'invalid-target-fallback');
  assert.equal(decision?.type === 'invalid-target-fallback' ? decision.fallback : null, 'page-one');
});

test('consumed explicit request never produces saved-position', () => {
  const openRequest = {
    ...request(annotationTarget),
    target: null,
  };
  assert.equal(resolve(openRequest, {
    savedReadingPosition: savedPage23,
    annotationLookupState: 'not-required',
  }), null);
});

test('stale navigation epoch produces no decision', () => {
  const openRequest = request(annotationTarget);
  assert.equal(resolveInitialNavigation({
    openRequest,
    activeRequestId: openRequest.requestId,
    activeNavigationEpoch: openRequest.navigationEpoch + 1,
    savedReadingPosition: savedPage23,
    annotationLookupState: 'found',
    documentReadyState: 'hydrated',
  }), null);
});
