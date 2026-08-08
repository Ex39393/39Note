import type { NotesPrintLayout } from '../types/glossary';

export function createIdempotentCleanup(cleanup: () => void): () => void {
  let hasRun = false;
  return () => {
    if (hasRun) return;
    hasRun = true;
    cleanup();
  };
}

export function getPrintLayoutCss(layout: NotesPrintLayout): string {
  if (layout === 'space-saving') {
    return `
    @page { size: A4; margin: 12mm; }
    body.print-layout-space-saving { font-size: 10pt; line-height: 1.3; }
    body.print-layout-space-saving main { max-width: 186mm; }
    body.print-layout-space-saving .document-title { margin-bottom: 4pt; font-size: 17pt; }
    body.print-layout-space-saving .export-date { margin-bottom: 13pt; font-size: 8.5pt; }
    body.print-layout-space-saving .note-entry { margin-bottom: 13pt; padding-bottom: 9pt; border-bottom-width: 0.4pt; }
    body.print-layout-space-saving .source-text { margin-bottom: 6pt; font-size: 9.5pt; line-height: 1.35; }
    body.print-layout-space-saving .note-body { font-size: 10pt; line-height: 1.4; }
    body.print-layout-space-saving .note-page { font-size: 8.5pt; }
    body.print-layout-space-saving .glossary-print-section { margin-top: 17pt; }
    body.print-layout-space-saving .glossary-print-section h2 { margin-bottom: 8pt; font-size: 14pt; }
    body.print-layout-space-saving .glossary-entry { margin-bottom: 9pt; padding-bottom: 7pt; border-bottom-width: 0.4pt; }
    body.print-layout-space-saving .glossary-entry h3 { font-size: 10.5pt; }
    body.print-layout-space-saving .glossary-entry p { font-size: 9.5pt; line-height: 1.35; }
    body.print-layout-space-saving .glossary-page,
    body.print-layout-space-saving .dictionary-attribution { font-size: 8.25pt; }
    `;
  }

  if (layout === 'extra-large') {
    return `
    @page { size: A4; margin: 18mm; }
    body.print-layout-extra-large { font-size: 16pt; line-height: 1.5; }
    body.print-layout-extra-large main { max-width: 174mm; }
    body.print-layout-extra-large .document-title { margin-bottom: 8pt; font-size: 24pt; line-height: 1.25; overflow-wrap: anywhere; }
    body.print-layout-extra-large .export-date { margin-bottom: 30pt; font-size: 12pt; }
    body.print-layout-extra-large .note-entry { margin-bottom: 36pt; padding-bottom: 22pt; border-bottom-width: 0.8pt; }
    body.print-layout-extra-large .source-text { margin-bottom: 16pt; font-size: 15pt; line-height: 1.5; overflow-wrap: anywhere; }
    body.print-layout-extra-large .note-body { font-size: 16pt; line-height: 1.55; overflow-wrap: anywhere; }
    body.print-layout-extra-large .note-label { font-size: 17pt; }
    body.print-layout-extra-large .note-page { font-size: 12pt; }
    body.print-layout-extra-large .glossary-print-section { margin-top: 36pt; }
    body.print-layout-extra-large .glossary-print-section h2 { margin-bottom: 18pt; font-size: 20pt; line-height: 1.3; }
    body.print-layout-extra-large .glossary-entry { margin-bottom: 26pt; padding-bottom: 18pt; border-bottom-width: 0.8pt; }
    body.print-layout-extra-large .glossary-entry h3 { font-size: 18pt; line-height: 1.4; overflow-wrap: anywhere; }
    body.print-layout-extra-large .glossary-entry p { font-size: 16pt; line-height: 1.5; overflow-wrap: anywhere; }
    body.print-layout-extra-large .glossary-page { font-size: 12pt; }
    body.print-layout-extra-large .dictionary-attribution { font-size: 11pt; line-height: 1.45; }
    `;
  }

  return '';
}
