import assert from 'node:assert/strict';
import test from 'node:test';
import { describePdfOpenFailure } from '../src/utils/pdfOpenError.ts';

test('PDF.js API/worker mismatches surface a precise recoverable message', () => {
  const result = describePdfOpenFailure(
    new Error('The API version "5.7.284" does not match the Worker version "6.3.289".'),
  );

  assert.deepEqual(result, {
    kind: 'runtime-version-mismatch',
    message:
      'The PDF reader was updated while 39Note was open. Reload 39Note, then try again.',
    reloadRecommended: true,
  });
  assert.doesNotMatch(result.message, /5\.7\.284|6\.3\.289|stack/iu);
});

test('ordinary PDF failures do not falsely recommend a reload', () => {
  assert.deepEqual(describePdfOpenFailure(new Error('network failed')), {
    kind: 'unknown',
    message: 'This PDF could not be opened. Return to Library and try again.',
    reloadRecommended: false,
  });
});
