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
    body.print-layout-space-saving .glossary-entry { margin-bottom: 5pt; font-size: 9.5pt; line-height: 1.35; }
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
    body.print-layout-extra-large .glossary-entry { margin-bottom: 12pt; font-size: 16pt; line-height: 1.5; overflow-wrap: anywhere; }
    body.print-layout-extra-large .dictionary-attribution { font-size: 11pt; line-height: 1.45; }
    `;
  }

  if (layout === 'all-annotations') {
    return `
    @page { size: A4; margin: 14mm 16mm; }
    body.print-layout-all-annotations { font-size: 11pt; line-height: 1.45; }
    body.print-layout-all-annotations main { max-width: 178mm; }
    body.print-layout-all-annotations .export-date { margin-bottom: 18pt; }
    body.print-layout-all-annotations .annotation-entry { margin-bottom: 14pt; padding-bottom: 10pt; }
    body.print-layout-all-annotations .note-entry { margin-bottom: 18pt; padding-bottom: 12pt; }
    `;
  }

  return '';
}
