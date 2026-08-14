import type { GlossaryEntry } from '../types/glossary';

export function formatGlossaryEntryForPrint(entry: GlossaryEntry): string {
  return `<p class="glossary-entry"><strong>${escapePrintHtml(entry.displayedWord)}</strong>: ${escapePrintHtml(entry.definition)}</p>`;
}

function escapePrintHtml(value: string): string {
  return value.replaceAll(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}
