import { useEffect } from 'react';
import type { PdfTextSelection } from '../types/textSelection';
import { getPdfTextSelections } from '../utils/textSelection';

export function usePdfTextSelection(
  viewerElement: HTMLElement | null,
  onSelectionChange: (selection: PdfTextSelection[]) => void,
): void {
  useEffect(() => {
    if (!viewerElement) {
      return;
    }

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      onSelectionChange(
        selection ? getPdfTextSelections(selection, viewerElement) : [],
      );
    };

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [onSelectionChange, viewerElement]);
}
