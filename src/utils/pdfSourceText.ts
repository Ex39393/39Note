/**
 * Presentation-safe cleanup for PDF source quotations.
 *
 * This intentionally does not attempt to guess missing historical word spaces or
 * rewrite visible hyphens. U+00AD is a discretionary layout character and is the
 * only hyphen-like code point removed here; U+002D, U+2010, U+2011, U+2013 and
 * U+2014 remain untouched.
 */
export function formatPdfSourceTextForDisplay(value: string): string {
  return value
    .replaceAll('\u00ad', '')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}
