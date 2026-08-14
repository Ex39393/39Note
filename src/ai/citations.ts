export function isValidPageCitation(
  pageNumber: number,
  pageCount: number,
): boolean {
  return (
    Number.isInteger(pageNumber) &&
    Number.isInteger(pageCount) &&
    pageNumber >= 1 &&
    pageNumber <= pageCount
  );
}
