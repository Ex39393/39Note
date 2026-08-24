import type { PdfTextSelection } from '../types/textSelection';
import type { AiRequestContextPreview } from './types';

export interface PreparedAiContext {
  excerpts: string;
  preview: AiRequestContextPreview;
}

export function createSelectedTextContext(
  selectedText: readonly PdfTextSelection[],
  contextCharacterBudget: number,
): PreparedAiContext {
  const text = selectedText
    .map((selection) => selection.text)
    .join('\n')
    .trim();
  if (!text) {
    throw new Error('Select text in the PDF before using Selected text scope.');
  }

  const pages = [
    ...new Set(selectedText.map((selection) => selection.pageNumber)),
  ];
  const bounded = text.slice(0, contextCharacterBudget);
  return {
    excerpts: `--- DOCUMENT EXCERPT | selected text | pages ${pages.join(', ')} ---\n${bounded}`,
    preview: {
      scope: 'selected-text',
      pages,
      characters: bounded.length,
      excerptCount: 1,
    },
  };
}
