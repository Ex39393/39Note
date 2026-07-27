import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfSearchPageIndex, PdfSearchResult } from '../types/pdfSearch';
import { createPdfSearchPageIndex, findPdfSearchResults } from '../utils/pdfSearch';

export interface PdfSearchController {
  isOpen: boolean;
  isIndexing: boolean;
  indexedPageCount: number;
  query: string;
  results: PdfSearchResult[];
  activeResult: PdfSearchResult | null;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  goToNextResult: () => void;
  goToPreviousResult: () => void;
}

export function usePdfSearch(document: PDFDocumentProxy | null): PdfSearchController {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<PdfSearchPageIndex[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexedPageCount, setIndexedPageCount] = useState(0);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const indexRef = useRef<PdfSearchPageIndex[]>([]);

  useEffect(() => {
    generationRef.current += 1;
    indexRef.current = [];
    setIndex([]);
    setIndexedPageCount(0);
    setIsIndexing(false);
    setQuery('');
    setActiveResultId(null);
    setIsOpen(false);
  }, [document]);

  useEffect(() => {
    generationRef.current += 1;
    if (!document || !isOpen || query.trim().length === 0) {
      setIsIndexing(false);
      return;
    }

    const generation = generationRef.current;
    let isDisposed = false;

    void (async () => {
      const nextIndex = [...indexRef.current];
      const indexedPageNumbers = new Set(nextIndex.map((page) => page.pageNumber));
      setIsIndexing(nextIndex.length < document.numPages);

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        if (indexedPageNumbers.has(pageNumber)) {
          continue;
        }
        try {
          const page = await document.getPage(pageNumber);
          const pageIndex = await createPdfSearchPageIndex(page, pageNumber);
          if (isDisposed || generation !== generationRef.current) {
            return;
          }
          nextIndex.push(pageIndex);
          indexedPageNumbers.add(pageNumber);
        } catch {
          // A page without usable text is simply not searchable.
        }

        if (pageNumber % 4 === 0 || pageNumber === document.numPages) {
          if (isDisposed || generation !== generationRef.current) {
            return;
          }
          const orderedIndex = [...nextIndex].sort((first, second) => first.pageNumber - second.pageNumber);
          indexRef.current = orderedIndex;
          setIndex(orderedIndex);
          setIndexedPageCount(orderedIndex.length);
          await yieldToBrowser();
        }
      }

      if (!isDisposed && generation === generationRef.current) {
        setIsIndexing(false);
      }
    })();

    return () => {
      isDisposed = true;
    };
  }, [document, isOpen, query]);

  const results = useMemo(() => findPdfSearchResults(index, query), [index, query]);
  const activeResult = results.find((result) => result.id === activeResultId) ?? results[0] ?? null;

  useEffect(() => {
    if (activeResult?.id !== activeResultId) {
      setActiveResultId(activeResult?.id ?? null);
    }
  }, [activeResult, activeResultId]);

  const moveResult = useCallback((direction: 1 | -1) => {
    if (results.length === 0) {
      return;
    }
    const currentIndex = activeResult
      ? results.findIndex((result) => result.id === activeResult.id)
      : -1;
    const nextIndex = (currentIndex + direction + results.length) % results.length;
    setActiveResultId(results[nextIndex].id);
  }, [activeResult, results]);

  return {
    isOpen,
    isIndexing,
    indexedPageCount,
    query,
    results,
    activeResult,
    open: () => setIsOpen(true),
    close: () => {
      setIsOpen(false);
      setQuery('');
      setActiveResultId(null);
    },
    setQuery,
    goToNextResult: () => moveResult(1),
    goToPreviousResult: () => moveResult(-1),
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}
