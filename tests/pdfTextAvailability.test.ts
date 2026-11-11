import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyPdfTextItems,
  hasRecordedPdfImage,
  resolvePdfPageTextAvailability,
} from '../src/utils/pdfTextAvailability.ts';

test('selectable PDF text wins even when the page also contains images', () => {
  const textState = classifyPdfTextItems([
    { str: '' },
    { str: '  ' },
    { str: 'Selectable source text' },
  ]);

  assert.equal(textState, 'selectable');
  assert.equal(resolvePdfPageTextAvailability(textState, true), 'selectable');
});

test('a raster page with no embedded text is classified as image-only', () => {
  const textState = classifyPdfTextItems([{ str: '' }, {}]);
  const imageCoordinates = new Float32Array([0, 0, 1, 0, 0, 1]);

  assert.equal(textState, 'empty');
  assert.equal(hasRecordedPdfImage(imageCoordinates), true);
  assert.equal(resolvePdfPageTextAvailability(textState, true), 'image-only');
});

test('empty/vector pages and extraction failures remain distinct from image-only', () => {
  assert.equal(hasRecordedPdfImage(null), false);
  assert.equal(resolvePdfPageTextAvailability('empty', false), 'no-selectable-text');
  assert.equal(
    resolvePdfPageTextAvailability('failed', true),
    'text-extraction-failed',
  );
  assert.equal(resolvePdfPageTextAvailability('pending', true), 'pending');
});
