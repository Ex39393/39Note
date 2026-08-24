import { getPdfLexicalConfidence } from './pdfSourceLexicon.ts';

export interface PdfSourceTextFragmentRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfSourceTextItemSignal {
  hasEOL: boolean;
}

export interface PdfSourceTextFragment {
  text: string;
  order: number;
  rectangle: PdfSourceTextFragmentRectangle | null;
  sourceItem?: PdfSourceTextItemSignal;
  startsSourceItem?: boolean;
  endsSourceItem?: boolean;
}

const NO_SPACE_BEFORE = ',;:!?%)]}\u2019\u201d*/-\u2013\u2014';
const NO_SPACE_AFTER = '([{\u2018\u201c*/-\u2013\u2014';
const SCRIPT_WITHOUT_WORD_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ATTACHED_MARK = /[\p{M}\u00b2\u00b3\u00b9\u2070-\u209f]/u;
const ALLOWED_SHORT_PIECES = new Set([
  'a', 'i', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in',
  'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
]);
const PROTECTED_HYPHENATED_WORDS = new Set([
  'evidence-based',
  'long-term',
  'well-being',
]);
const HYPHENATED_WORD_PATTERN = /\b([A-Za-z]{2,})[-\u2010\u2011]([A-Za-z]{2,})\b/gu;
const MERGED_WORD_PATTERN = /[A-Za-z]{5,32}/gu;

/**
 * Canonical reconstruction for newly selected human-readable PDF source text.
 * Geometry remains the primary boundary signal; lexical evidence is used only
 * for a narrow borderline gap, an unrecognized merged token, or a confirmed
 * visual-line hyphen candidate.
 */
export function reconstructPdfSourceText(
  fragments: readonly PdfSourceTextFragment[],
): string {
  const orderedFragments = [...fragments]
    .filter((fragment) => fragment.text.length > 0)
    .sort((first, second) => first.order - second.order);

  const reconstructed = orderedFragments.reduce((text, fragment, index) => {
    const previous = orderedFragments[index - 1];
    if (!previous) return fragment.text;

    if (shouldRemoveLineBreakHyphen(previous, fragment)) {
      return `${text.slice(0, -1)}${fragment.text}`;
    }

    const separator = shouldInsertSyntheticSpace(previous, fragment) ? ' ' : '';
    return `${text}${separator}${fragment.text}`;
  }, '');

  return formatPdfSourceTextForDisplay(reconstructed);
}

/**
 * Presentation-safe cleanup for new and historical PDF source quotations.
 * Historical hyphen repair is deliberately more conservative because geometry
 * and TextContent `hasEOL` signals are no longer available.
 */
export function formatPdfSourceTextForDisplay(value: string): string {
  const normalized = value
    .replaceAll('\u00ad', '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return repairMergedEnglishTokens(
    repairHistoricalHyphenation(normalized),
  );
}

function shouldInsertSyntheticSpace(
  previous: PdfSourceTextFragment,
  next: PdfSourceTextFragment,
): boolean {
  if (/\s$/u.test(previous.text) || /^\s/u.test(next.text)) return false;

  const previousCharacter = previous.text.at(-1);
  const nextCharacter = next.text.at(0);
  if (!previousCharacter || !nextCharacter) return false;
  if (
    preventsSpaceBefore(next.text, nextCharacter) ||
    NO_SPACE_AFTER.includes(previousCharacter) ||
    ATTACHED_MARK.test(nextCharacter) ||
    (
      SCRIPT_WITHOUT_WORD_SPACES.test(previousCharacter) &&
      SCRIPT_WITHOUT_WORD_SPACES.test(nextCharacter)
    )
  ) {
    return false;
  }

  const previousRectangle = previous.rectangle;
  const nextRectangle = next.rectangle;
  if (!previousRectangle || !nextRectangle) return false;
  if (!areOnSameVisualLine(previousRectangle, nextRectangle)) return true;

  const horizontalGap = nextRectangle.left - (
    previousRectangle.left + previousRectangle.width
  );
  const meaningfulGap = getMeaningfulWordGap(
    previous,
    next,
    previousRectangle,
    nextRectangle,
  );
  if (horizontalGap >= meaningfulGap) return true;

  return (
    horizontalGap > 0 &&
    horizontalGap >= meaningfulGap * 0.72 &&
    hasStrongLexicalBoundary(previous.text, next.text)
  );
}

function shouldRemoveLineBreakHyphen(
  previous: PdfSourceTextFragment,
  next: PdfSourceTextFragment,
): boolean {
  const previousRectangle = previous.rectangle;
  const nextRectangle = next.rectangle;
  if (
    !previousRectangle ||
    !nextRectangle ||
    areOnSameVisualLine(previousRectangle, nextRectangle) ||
    !isConsecutiveVisualLine(previousRectangle, nextRectangle)
  ) {
    return false;
  }

  const previousMatch = /([A-Za-z]{2,})([-\u2010\u2011])$/u.exec(previous.text);
  const nextMatch = /^([A-Za-z]{2,})/u.exec(next.text);
  if (!previousMatch || !nextMatch) return false;

  const metadataConfirmsLineEnd = Boolean(
    previous.sourceItem?.hasEOL && previous.endsSourceItem,
  );
  const geometryConfirmsLineEnd = (
    nextRectangle.top > previousRectangle.top &&
    nextRectangle.top - previousRectangle.top <=
      Math.max(previousRectangle.height, nextRectangle.height) * 2.5
  );
  if (!metadataConfirmsLineEnd && !geometryConfirmsLineEnd) return false;

  return canRemoveHyphen(previousMatch[1], nextMatch[1], previousMatch[2]);
}

function repairHistoricalHyphenation(value: string): string {
  return value.replace(
    HYPHENATED_WORD_PATTERN,
    (hyphenated, first: string, second: string) =>
      canRemoveHyphen(first, second, hyphenated.slice(first.length, first.length + 1))
        ? `${first}${second}`
        : hyphenated,
  );
}

function canRemoveHyphen(first: string, second: string, hyphen: string): boolean {
  if (!'-\u2010\u2011'.includes(hyphen)) return false;
  const joined = `${first}${second}`.toLocaleLowerCase('en-US');
  const hyphenated = `${first}-${second}`.toLocaleLowerCase('en-US');
  if (PROTECTED_HYPHENATED_WORDS.has(hyphenated)) return false;
  if (getPdfLexicalConfidence(joined) < 3) return false;
  if (getPdfLexicalConfidence(hyphenated) > 0) return false;

  const firstConfidence = getPdfLexicalConfidence(first);
  const secondConfidence = getPdfLexicalConfidence(second);
  return firstConfidence === 0 || secondConfidence === 0;
}

function repairMergedEnglishTokens(value: string): string {
  return value.replace(MERGED_WORD_PATTERN, (token, offset: number) => {
    if (!/^[a-z]+$/u.test(token)) return token;
    if (isProtectedTokenContext(value, offset, token.length)) return token;
    if (getPdfLexicalConfidence(token) > 0) return token;

    const candidates = getTwoPieceCandidates(token);
    const best = candidates[0];
    const second = candidates[1];
    if (!best || best.score < 6) return token;
    if (second && best.score - second.score < 2) return token;
    return `${best.first} ${best.second}`;
  });
}

function getTwoPieceCandidates(value: string): Array<{
  first: string;
  second: string;
  score: number;
}> {
  const candidates: Array<{ first: string; second: string; score: number }> = [];
  for (let index = 1; index < value.length; index += 1) {
    const first = value.slice(0, index);
    const second = value.slice(index);
    const score = getSplitCandidateScore(first, second);
    if (score > 0) candidates.push({ first, second, score });
  }
  return candidates.sort((first, second) =>
    second.score - first.score ||
    Math.abs(second.first.length - second.second.length) -
      Math.abs(first.first.length - first.second.length),
  );
}

function getSplitCandidateScore(first: string, second: string): number {
  if (!isAllowedPiece(first) || !isAllowedPiece(second)) return 0;
  const firstConfidence = getPdfLexicalConfidence(first);
  const secondConfidence = getPdfLexicalConfidence(second);
  if (firstConfidence === 0 || secondConfidence === 0) return 0;
  if (getPdfLexicalConfidence(`${first}${second}`) > 0) return 0;
  return firstConfidence + secondConfidence + (
    first.length >= 3 && second.length >= 3 ? 1 : 0
  );
}

function hasStrongLexicalBoundary(previous: string, next: string): boolean {
  const previousMatch = /([A-Za-z]+)$/u.exec(previous);
  const nextMatch = /^([A-Za-z]+)/u.exec(next);
  if (!previousMatch || !nextMatch) return false;
  return getSplitCandidateScore(
    previousMatch[1].toLocaleLowerCase('en-US'),
    nextMatch[1].toLocaleLowerCase('en-US'),
  ) >= 6;
}

function isAllowedPiece(value: string): boolean {
  return value.length >= 3 || ALLOWED_SHORT_PIECES.has(value);
}

function isProtectedTokenContext(value: string, offset: number, length: number): boolean {
  const previous = value.at(offset - 1) ?? '';
  const next = value.at(offset + length) ?? '';
  return /[A-Za-z0-9_@/.\\]/u.test(previous) || /[A-Za-z0-9_@/.\\]/u.test(next);
}

function preventsSpaceBefore(text: string, firstCharacter: string): boolean {
  if (firstCharacter === '.' && /^\.\d/u.test(text)) return false;
  return firstCharacter === '.' || NO_SPACE_BEFORE.includes(firstCharacter);
}

function areOnSameVisualLine(
  previous: PdfSourceTextFragmentRectangle,
  next: PdfSourceTextFragmentRectangle,
): boolean {
  const previousBottom = previous.top + previous.height;
  const nextBottom = next.top + next.height;
  const overlap = Math.min(previousBottom, nextBottom) - Math.max(previous.top, next.top);
  const minimumHeight = Math.min(previous.height, next.height);
  const previousCenter = previous.top + previous.height / 2;
  const nextCenter = next.top + next.height / 2;

  return (
    overlap >= minimumHeight * 0.2 ||
    Math.abs(previousCenter - nextCenter) <= Math.max(previous.height, next.height) * 0.55
  );
}

function isConsecutiveVisualLine(
  previous: PdfSourceTextFragmentRectangle,
  next: PdfSourceTextFragmentRectangle,
): boolean {
  const previousCenter = previous.top + previous.height / 2;
  const nextCenter = next.top + next.height / 2;
  const distance = nextCenter - previousCenter;
  return distance > 0 && distance <= Math.max(previous.height, next.height) * 2.5;
}

function getMeaningfulWordGap(
  previous: PdfSourceTextFragment,
  next: PdfSourceTextFragment,
  previousRectangle: PdfSourceTextFragmentRectangle,
  nextRectangle: PdfSourceTextFragmentRectangle,
): number {
  const textHeight = Math.min(previousRectangle.height, nextRectangle.height);
  const localCharacterWidth = Math.min(
    getAverageCharacterWidth(previous.text, previousRectangle.width, textHeight),
    getAverageCharacterWidth(next.text, nextRectangle.width, textHeight),
  );

  return Math.max(
    textHeight * 0.08,
    Math.min(textHeight * 0.24, localCharacterWidth * 0.18),
  );
}

function getAverageCharacterWidth(
  text: string,
  width: number,
  fallbackHeight: number,
): number {
  const characterCount = Array.from(text).filter((character) => !/\s/u.test(character)).length;
  return characterCount > 0 && width > 0
    ? width / characterCount
    : fallbackHeight * 0.5;
}
