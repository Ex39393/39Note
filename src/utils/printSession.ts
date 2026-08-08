import type { NotesPrintLayout } from '../types/glossary';

export function createIdempotentCleanup(cleanup: () => void): () => void {
  let hasRun = false;
  return () => {
    if (hasRun) return;
    hasRun = true;
    cleanup();
  };
}

export function getSpaceSavingPrintCss(layout: NotesPrintLayout): string {
  return layout === 'space-saving'
    ? `
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
    `
    : '';
}
