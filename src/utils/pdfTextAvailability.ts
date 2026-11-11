export type PdfTextExtractionState = 'pending' | 'selectable' | 'empty' | 'failed';

export type PdfPageTextAvailability =
  | 'pending'
  | 'selectable'
  | 'image-only'
  | 'no-selectable-text'
  | 'text-extraction-failed';

export function classifyPdfTextItems(
  items: readonly unknown[],
): PdfTextExtractionState {
  return items.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'str' in item &&
      typeof item.str === 'string' &&
      item.str.trim().length > 0,
  )
    ? 'selectable'
    : 'empty';
}

export function hasRecordedPdfImage(
  imageCoordinates: ArrayLike<number> | null | undefined,
): boolean {
  return Boolean(imageCoordinates && imageCoordinates.length >= 6);
}

export function resolvePdfPageTextAvailability(
  textState: PdfTextExtractionState,
  hasRecordedImage: boolean,
): PdfPageTextAvailability {
  if (textState === 'pending') return 'pending';
  if (textState === 'failed') return 'text-extraction-failed';
  if (textState === 'selectable') return 'selectable';
  return hasRecordedImage ? 'image-only' : 'no-selectable-text';
}
