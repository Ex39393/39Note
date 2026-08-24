import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import test, { before } from 'node:test';
import {
  reconstructPdfSelectionText,
  slicePdfTextFragment,
  type PdfSelectionTextFragment,
  type PdfSelectionTextFragmentRectangle,
} from '../src/utils/textSelection.ts';
import { formatPdfSourceTextForDisplay } from '../src/utils/pdfSourceText.ts';
import {
  getPdfSourceLexiconEntryCount,
  installPdfSourceLexicon,
  isPdfSourceLexiconReady,
} from '../src/utils/pdfSourceLexicon.ts';
import { createSelectedTextContext } from '../src/ai/selectedTextContext.ts';
import type { PdfTextSelection } from '../src/types/textSelection.ts';

before(async () => {
  const bytes = await readFile(new URL(
    '../public/dictionary/pdf-source-lexicon.bin',
    import.meta.url,
  ));
  installPdfSourceLexicon(bytes);
});

test('loads a compact local WordNet membership asset', async () => {
  const bytes = await readFile(new URL(
    '../public/dictionary/pdf-source-lexicon.bin',
    import.meta.url,
  ));
  assert.equal(isPdfSourceLexiconReady(), true);
  assert.equal(getPdfSourceLexiconEntryCount(), 82_537);
  assert.ok(bytes.byteLength <= 300 * 1024);
  assert.ok(gzipSync(bytes).byteLength <= 300 * 1024);
});

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

test('infers the second reported factual/questions word boundary', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('factual', rectangle(0, 0, 42, 14), 0),
      fragment('questions', rectangle(46, 0, 58, 14), 1),
    ]),
    'factual questions',
  );
});

test('repairs the reported missing boundaries inside one fragment', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('There wasno significant difference', rectangle(0, 0, 210, 14), 0),
    ]),
    'There was no significant difference',
  );
  assert.equal(
    reconstructPdfSelectionText([
      fragment(
        'performance on factualquestions across lectures',
        rectangle(0, 0, 280, 14),
        0,
      ),
    ]),
    'performance on factual questions across lectures',
  );
});

test('preserves recognized unsplit English words', () => {
  for (const word of ['notebook', 'background', 'cannot', 'something', 'psychology']) {
    assert.equal(
      reconstructPdfSelectionText([
        fragment(word, rectangle(0, 0, word.length * 7, 14), 0),
      ]),
      word,
    );
  }
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

test('preserves legitimate compounds and COVID-19 exactly', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('well-being COVID-19', rectangle(0, 0, 132, 14), 0),
    ]),
    'well-being COVID-19',
  );
});

test('removes only genuine U+00AD soft hyphens from source presentation', () => {
  const source = 'signifi\u00adcant - ‐ ‑ – — evidence-based';
  const displayed = formatPdfSourceTextForDisplay(source);
  assert.equal(displayed, 'significant - ‐ ‑ – — evidence-based');
  assert.equal([...displayed].some((character) => character.codePointAt(0) === 0x00ad), false);
  assert.equal(
    reconstructPdfSelectionText([
      fragment('signifi\u00adcant', rectangle(0, 0, 70, 14), 0),
    ]),
    'significant',
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

test('dehyphenates only a strong lexical line-break candidate', () => {
  assert.equal(
    reconstructPdfSelectionText([
      fragment('cond-', rectangle(0, 0, 32, 14), 0, true),
      fragment('ition', rectangle(0, 18, 28, 14), 1),
    ]),
    'condition',
  );
  assert.equal(
    reconstructPdfSelectionText([
      fragment('evidence-', rectangle(0, 0, 58, 14), 0, true),
      fragment('based', rectangle(0, 18, 32, 14), 1),
    ]),
    'evidence-based',
  );
  assert.equal(
    reconstructPdfSelectionText([
      fragment('well-', rectangle(0, 0, 30, 14), 0, true),
      fragment('being', rectangle(0, 18, 30, 14), 1),
    ]),
    'well-being',
  );
  assert.equal(
    reconstructPdfSelectionText([
      fragment('COVID-', rectangle(0, 0, 42, 14), 0, true),
      fragment('19', rectangle(0, 18, 14, 14), 1),
    ]),
    'COVID-19',
  );
});

test('uses lexical evidence only inside the narrow borderline-gap band', () => {
  const textHeight = 14;
  const borderlineGap = textHeight * 0.078;
  assert.equal(
    reconstructPdfSelectionText([
      fragment('was', rectangle(0, 0, 21, textHeight), 0),
      fragment('no', rectangle(21 + borderlineGap, 0, 14, textHeight), 1),
    ]),
    'was no',
  );
  assert.equal(
    reconstructPdfSelectionText([
      fragment('p', rectangle(0, 0, 7, textHeight), 0),
      fragment('value', rectangle(7 + borderlineGap, 0, 35, textHeight), 1),
    ]),
    'pvalue',
  );
});

test('repairs historical source display without rewriting ambiguous compounds', () => {
  assert.equal(formatPdfSourceTextForDisplay('There wasno'), 'There was no');
  assert.equal(formatPdfSourceTextForDisplay('cond-ition'), 'condition');
  assert.equal(formatPdfSourceTextForDisplay('evidence-based'), 'evidence-based');
  assert.equal(formatPdfSourceTextForDisplay('well-being'), 'well-being');
  assert.equal(formatPdfSourceTextForDisplay('long-term'), 'long-term');
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

test('passes canonical reconstructed selections into AI Selected text context', () => {
  const selectedText = [
    pdfSelection('There was no significant difference', 2),
    pdfSelection('condition', 6),
  ];
  const context = createSelectedTextContext(selectedText, 1_000);

  assert.equal(
    context.excerpts,
    '--- DOCUMENT EXCERPT | selected text | pages 2, 6 ---\n' +
      'There was no significant difference\ncondition',
  );
  assert.deepEqual(context.preview, {
    scope: 'selected-text',
    pages: [2, 6],
    characters: 45,
    excerptCount: 1,
  });
  assert.doesNotMatch(context.excerpts, /wasno|cond-ition/);
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

test('preserves exact academic and statistical source strings', () => {
  const cases = [
    'There was no significant difference, F(4, 4) = 1.57, p = .33.',
    '\u03b7\u00b2 = .95',
    'R\u00b2',
    '95% confidence interval',
    'COVID-19',
    'evidence-based',
    '2\u00d72 ANOVA',
    'GLMM CS+ CS- N=4 A/B',
    'https://example.org/wasno',
    'person@example.org',
    'variable_names camelCase v1.2.3',
  ];

  for (const value of cases) {
    assert.equal(
      reconstructPdfSelectionText([
        fragment(value, rectangle(0, 0, value.length * 7, 14), 0),
      ]),
      value,
    );
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

function pdfSelection(text: string, pageNumber: number): PdfTextSelection {
  return {
    text,
    pageNumber,
    pageWidth: 612,
    pageHeight: 792,
    boundingRectangles: [{ left: 10, top: 10, width: 100, height: 14 }],
    startOffset: 0,
    endOffset: text.length,
  };
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
  hasEOL = false,
): PdfSelectionTextFragment {
  return {
    text,
    rectangle: value,
    order,
    ...(hasEOL ? {
      sourceItem: { hasEOL: true },
      startsSourceItem: true,
      endsSourceItem: true,
    } : {}),
  };
}

function rectangle(
  left: number,
  top: number,
  width: number,
  height: number,
): PdfSelectionTextFragmentRectangle {
  return { left, top, width, height };
}
