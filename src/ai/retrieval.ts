import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface DocumentPageText {
  pageNumber: number;
  text: string;
}

export interface DocumentChunk {
  id: string;
  pageNumbers: number[];
  text: string;
}

export interface RetrievedContext {
  chunks: DocumentChunk[];
  pages: number[];
  characters: number;
}

const CHUNK_SIZE = 3_600;
const CHUNK_OVERLAP = 280;

export async function extractDocumentText(
  document: PDFDocumentProxy,
  onProgress?: (completedPages: number, totalPages: number) => void,
  signal?: AbortSignal,
): Promise<DocumentPageText[]> {
  const pages: DocumentPageText[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines: string[] = [];
    let line = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const text = item.str.trim();
      if (text) line += `${line ? ' ' : ''}${text}`;
      if ('hasEOL' in item && item.hasEOL) {
        if (line) lines.push(line);
        line = '';
      }
    }
    if (line) lines.push(line);
    pages.push({ pageNumber, text: cleanPageText(lines.join('\n')) });
    onProgress?.(pageNumber, document.numPages);
    if (pageNumber % 4 === 0) await yieldToBrowser();
  }
  return removeRepeatedMargins(pages);
}

export function chunkDocumentPages(
  pages: readonly DocumentPageText[],
): DocumentChunk[] {
  return pages.flatMap((page) => {
    if (!page.text) return [];
    const chunks: DocumentChunk[] = [];
    let offset = 0;
    let index = 0;
    while (offset < page.text.length) {
      const desiredEnd = Math.min(page.text.length, offset + CHUNK_SIZE);
      const end = findSentenceBoundary(page.text, offset, desiredEnd);
      const text = page.text.slice(offset, end).trim();
      if (text) {
        chunks.push({
          id: `p${page.pageNumber}-c${index}`,
          pageNumbers: [page.pageNumber],
          text,
        });
      }
      if (end >= page.text.length) break;
      offset = Math.max(offset + 1, end - CHUNK_OVERLAP);
      index += 1;
    }
    return chunks;
  });
}

export function retrieveRelevantChunks(
  chunks: readonly DocumentChunk[],
  query: string,
  characterBudget: number,
): RetrievedContext {
  const terms = tokenize(query);
  const documentFrequency = new Map<string, number>();
  const tokenizedChunks = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    for (const term of new Set(tokens)) {
      if (terms.includes(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }
    return { chunk, tokens };
  });
  const ranked = tokenizedChunks
    .map(({ chunk, tokens }) => {
      const frequencies = countTerms(tokens);
      const score = terms.reduce((total, term) => {
        const frequency = frequencies.get(term) ?? 0;
        if (!frequency) return total;
        const idf = Math.log(
          1 + chunks.length / (1 + (documentFrequency.get(term) ?? 0)),
        );
        return total + (frequency / (frequency + 1.2)) * idf;
      }, 0);
      return { chunk, score };
    })
    .sort(
      (first, second) =>
        second.score - first.score || first.chunk.id.localeCompare(second.chunk.id),
    );

  const selected: DocumentChunk[] = [];
  let characters = 0;
  const fallbackCount = Math.min(3, ranked.length);
  for (const { chunk, score } of ranked) {
    if (score <= 0 && selected.length >= fallbackCount) break;
    if (selected.length >= 10) break;
    if (characters + chunk.text.length > characterBudget && selected.length > 0)
      continue;
    const remaining = characterBudget - characters;
    if (remaining <= 200) break;
    selected.push(
      chunk.text.length <= remaining
        ? chunk
        : { ...chunk, text: chunk.text.slice(0, remaining) },
    );
    characters += Math.min(chunk.text.length, remaining);
  }
  selected.sort((first, second) => first.pageNumbers[0] - second.pageNumbers[0]);
  return {
    chunks: selected,
    pages: [...new Set(selected.flatMap((chunk) => chunk.pageNumbers))],
    characters,
  };
}

export function formatDocumentExcerpts(chunks: readonly DocumentChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `--- DOCUMENT EXCERPT | pages ${chunk.pageNumbers.join(', ')} | chunk ${chunk.id} ---\n${chunk.text}`,
    )
    .join('\n\n');
}

function cleanPageText(text: string): string {
  return text
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/([a-z,;:])\n(?=[a-z])/g, '$1 ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function removeRepeatedMargins(pages: readonly DocumentPageText[]): DocumentPageText[] {
  if (pages.length < 4) return [...pages];
  const threshold = Math.ceil(pages.length * 0.7);
  const firstCounts = new Map<string, number>();
  const lastCounts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.text.split('\n').filter(Boolean);
    const first = normalizeMarginLine(lines[0]);
    const last = normalizeMarginLine(lines.at(-1));
    if (first) firstCounts.set(first, (firstCounts.get(first) ?? 0) + 1);
    if (last) lastCounts.set(last, (lastCounts.get(last) ?? 0) + 1);
  }
  const repeatedFirst = new Set(
    [...firstCounts].filter(([, count]) => count >= threshold).map(([line]) => line),
  );
  const repeatedLast = new Set(
    [...lastCounts].filter(([, count]) => count >= threshold).map(([line]) => line),
  );
  return pages.map((page) => {
    const lines = page.text.split('\n');
    if (repeatedFirst.has(normalizeMarginLine(lines[0]))) lines.shift();
    if (repeatedLast.has(normalizeMarginLine(lines.at(-1)))) lines.pop();
    return { ...page, text: lines.join('\n').trim() };
  });
}

function normalizeMarginLine(value: string | undefined): string {
  if (!value || value.length > 120) return '';
  return value.toLocaleLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function findSentenceBoundary(text: string, start: number, desiredEnd: number): number {
  if (desiredEnd >= text.length) return text.length;
  const windowStart = Math.max(start + Math.floor(CHUNK_SIZE * 0.65), desiredEnd - 700);
  const portion = text.slice(windowStart, desiredEnd);
  const matches = [...portion.matchAll(/[.!?](?:["')\]]*)\s+/g)];
  const last = matches.at(-1);
  return last?.index === undefined
    ? desiredEnd
    : windowStart + last.index + last[0].length;
}

function tokenize(value: string): string[] {
  return (
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.filter((term) => !STOP_WORDS.has(term)) ?? []
  );
}

function countTerms(terms: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return frequencies;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Indexing stopped.', 'AbortError');
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'can',
  'will',
  'into',
  'about',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'why',
  'does',
  'did',
  'their',
  'there',
  'than',
  'then',
  'also',
]);
