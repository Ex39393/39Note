import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconstructPdfSelectionText,
  slicePdfTextFragment,
  type PdfSelectionTextFragment,
  type PdfSelectionTextFragmentRectangle,
} from '../src/utils/textSelection.ts';

test('preserves an existing literal whitespace boundary', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('There was ', rectangle(0, 0, 58, 14), 0),
      fragment('no difference', rectangle(62, 0, 82, 14), 1),
    ]),
    'There was no difference',
  );
});

test('infers missing whitespace from a meaningful same-line visual gap', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('There was', rectangle(0, 0, 58, 14), 0),
      fragment('no difference', rectangle(62, 0, 82, 14), 1),
    ]),
    'There was no difference',
  );
});

test('does not split alphabetic fragments when geometry shows token adjacency', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('note', rectangle(0, 0, 25, 14), 0),
      fragment('book', rectangle(25.4, 0, 28, 14), 1),
    ]),
    'notebook',
  );
});

test('keeps adjacent punctuation attached to the preceding token', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('result', rectangle(0, 0, 38, 14), 0),
      fragment(',', rectangle(42, 0, 3, 14), 1),
    ]),
    'result,',
  );
});

test('keeps a closing parenthesis attached', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('test', rectangle(0, 0, 23, 14), 0),
      fragment(')', rectangle(27, 0, 4, 14), 1),
    ]),
    'test)',
  );
});

test('keeps a percentage sign attached', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('95', rectangle(0, 0, 14, 14), 0),
      fragment('%', rectangle(18, 0, 9, 14), 1),
    ]),
    '95%',
  );
});

test('keeps apostrophe fragments inside contractions', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('don', rectangle(0, 0, 21, 14), 0),
      fragment("'", rectangle(21.3, 0, 3, 14), 1),
      fragment('t', rectangle(24.6, 0, 5, 14), 2),
    ]),
    "don't",
  );
});

test('keeps hyphenated token fragments attached', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('well', rectangle(0, 0, 24, 14), 0),
      fragment('-', rectangle(24.3, 0, 4, 14), 1),
      fragment('being', rectangle(28.6, 0, 31, 14), 2),
    ]),
    'well-being',
  );
});

test('turns an ordinary visual line wrap into one space', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('significant', rectangle(0, 0, 64, 14), 0),
      fragment('difference', rectangle(0, 18, 57, 14), 1),
    ]),
    'significant difference',
  );
});

test('partial first and final fragment slicing does not leak unselected text', () => {
  const sourceFragments = ['There was', 'no difference', 'today.'];
  const selectionStart = 6;
  const selectionEnd = sourceFragments.join('').length - 1;
  let sourceOffset = 0;
  const fragments = sourceFragments.flatMap((text, order) => {
    const slice = slicePdfTextFragment(
      text,
      sourceOffset,
      selectionStart,
      selectionEnd,
    );
    sourceOffset += text.length;
    return slice
      ? [fragment(slice.text, rectangle(order * 80, 0, 60, 14), order)]
      : [];
  });

  assert.equal(reconstructPdfSelectionText(fragments), 'was no difference today');
});

test('reconstructs the reported multi-span and multi-line sentence', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('There was', rectangle(0, 0, 58, 14), 0),
      fragment(
        'no significant difference in performance on factual',
        rectangle(62, 0, 304, 14),
        1,
      ),
      fragment('questions across lectures', rectangle(0, 18, 144, 14), 2),
    ]),
    'There was no significant difference in performance on factual questions across lectures',
  );
});

test('protects scientific, lexical, and punctuation-heavy tokens', () => {
  const cases: Array<[PdfSelectionTextFragment[], string]> = [
    [adjacentFragments(['can', "'", 't']), "can't"],
    [adjacentFragments(['e', '.', 'g', '.']), 'e.g.'],
    [adjacentFragments(['i', '.', 'e', '.']), 'i.e.'],
    [adjacentFragments(['F', '(', '4', ',', ' 4', ')']), 'F(4, 4)'],
    [spacedFragments(['p', '=', '.007']), 'p = .007'],
    [adjacentFragments(['η', '²']), 'η²'],
    [adjacentFragments(['(', 'question', ')']), '(question)'],
    [adjacentFragments(['COVID', '-', '19']), 'COVID-19'],
    [adjacentFragments(['A', '/', 'B']), 'A/B'],
    [adjacentFragments(['3', '.', '14']), '3.14'],
  ];

  for (const [fragments, expected] of cases) {
    assert.equal(reconstructPdfSelectionText(fragments), expected);
  }
});

function adjacentFragments(texts: string[]): PdfSelectionTextFragment[] {
  let left = 0;
  return texts.map((text, order) => {
    const width = Math.max(3, text.length * 7);
    const result = fragment(text, rectangle(left, 0, width, 14), order);
    left += width + 0.25;
    return result;
  });
}

function spacedFragments(texts: string[]): PdfSelectionTextFragment[] {
  let left = 0;
  return texts.map((text, order) => {
    const width = Math.max(3, text.length * 7);
    const result = fragment(text, rectangle(left, 0, width, 14), order);
    left += width + 4;
    return result;
  });
}

function fragment(
  text: string,
  value: PdfSelectionTextFragmentRectangle,
  order: number,
): PdfSelectionTextFragment {
  return { text, rectangle: value, order };
}

function rectangle(
  left: number,
  top: number,
  width: number,
  height: number,
): PdfSelectionTextFragmentRectangle {
  return { left, top, width, height };
}
