import type { Note } from '../types/note';
import { underlineColors, type PdfAnnotation } from '../types/highlight';
import type { GlossaryEntry, NotesPrintLayout } from '../types/glossary';
import { getPrintContentItems, getPrintLayoutClass } from './glossary';
import { createIdempotentCleanup, getPrintLayoutCss } from './printSession';
import { getDictionaryAttributionText } from './dictionary';

export function exportNotesAsMarkdown(notes: Note[], documentTitle: string): boolean {
  if (notes.length === 0) {
    return false;
  }

  const markdown = notes.map(formatNoteForMarkdown).join('\n\n\n');
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `${sanitizeExportFileName(documentTitle)}-notes.md`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  return true;
}

export function exportNotesAsPdf(
  notes: Note[],
  documentTitle: string,
  annotations: PdfAnnotation[],
  glossaryEntries: GlossaryEntry[],
  layout: NotesPrintLayout,
  onComplete: () => void,
): (() => void) | null {
  if (notes.length === 0 && glossaryEntries.length === 0) {
    return null;
  }

  const printWindow = window.open('', '_blank', 'width=900,height=760');
  if (!printWindow) {
    return null;
  }

  let hasPrinted = false;
  let hasCleanedUp = false;
  let cleanupTimer: number | null = null;
  const cleanup = createIdempotentCleanup(() => {
    if (hasCleanedUp) {
      return;
    }

    hasCleanedUp = true;
    if (cleanupTimer !== null) {
      window.clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    window.removeEventListener('pagehide', cleanup);
    if (!printWindow.closed) {
      printWindow.close();
    }
    onComplete();
  });
  const printWhenReady = () => {
    if (hasPrinted || printWindow.closed) {
      return;
    }

    hasPrinted = true;
    const beginPrint = () => {
      if (printWindow.closed) {
        return;
      }

      printWindow.addEventListener('afterprint', cleanup, { once: true });
      cleanupTimer = window.setTimeout(cleanup, 120_000);
      printWindow.focus();
      printWindow.print();
    };

    const fontsReady = printWindow.document.fonts?.ready;
    if (fontsReady) {
      void fontsReady.finally(beginPrint);
    } else {
      window.setTimeout(beginPrint, 0);
    }
  };

  window.addEventListener('pagehide', cleanup, { once: true });
  printWindow.document.open();
  printWindow.document.write(
    createNotesPrintDocument(notes, documentTitle, annotations, glossaryEntries, layout),
  );
  printWindow.document.close();
  printWindow.addEventListener('load', printWhenReady, { once: true });
  window.setTimeout(printWhenReady, 0);
  return cleanup;
}

function formatNoteForMarkdown(note: Note): string {
  const sourceText = normalizeWhitespace(note.selectedText) || 'Source text unavailable.';
  const noteContent = note.content.replaceAll('\r\n', '\n').trimEnd();
  const noteHeading = formatNoteLabel(note.displayNumber);

  return `*${escapeItalicMarkdown(sourceText)}*\n\n${noteContent.length > 0 ? `${noteHeading} ${noteContent}` : noteHeading}`;
}

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function escapeItalicMarkdown(value: string): string {
  return value.replaceAll(/([\\*_])/g, '\\$1');
}

function formatNoteLabel(value: string): string {
  const label = value.trim() || 'Note';
  return /[.!?:]$/.test(label) ? label : `${label}.`;
}

function sanitizeExportFileName(value: string): string {
  const safeCharacters = Array.from(value, (character) =>
    isInvalidFileNameCharacter(character) ? '-' : character,
  ).join('');
  const normalizedValue = safeCharacters
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replaceAll(/[. ]+$/g, '');

  return normalizedValue || '39Note';
}

function isInvalidFileNameCharacter(character: string): boolean {
  return '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) <= 31;
}

export function createNotesPrintDocument(
  notes: Note[],
  documentTitle: string,
  annotations: PdfAnnotation[],
  glossaryEntries: GlossaryEntry[],
  layout: NotesPrintLayout,
): string {
  const title = escapeHtml(documentTitle.trim() || '39Note');
  const exportDate = escapeHtml(new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
  }).format(new Date()));
  const annotationsById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
  const printContent = getPrintContentItems(notes, glossaryEntries);
  const noteEntries = printContent.notes.map((note) => formatNoteForPrint(note, annotationsById.get(note.annotationId))).join('\n');
  const glossary = printContent.glossaryEntries;
  const dictionaryAttribution = getDictionaryAttributionText(
    glossary.map((entry) => entry.source),
  );
  const glossarySection = glossary.length > 0
    ? `<section class="glossary-print-section">
      <h2>Glossary</h2>
      ${glossary.map(formatGlossaryForPrint).join('\n')}
      <p class="dictionary-attribution">${escapeHtml(dictionaryAttribution)}</p>
    </section>`
    : '';
  const layoutCss = getPrintLayoutCss(layout);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Notes</title>
  <style>
    @page { size: A4; margin: 18mm 20mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #1f1f1f; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Microsoft YaHei", Arial, sans-serif; font-size: 12pt; line-height: 1.6; }
    main { max-width: 170mm; margin: 0 auto; }
    .document-title { margin: 0 0 6pt; font-size: 20pt; font-weight: 650; line-height: 1.25; }
    .export-date { margin: 0 0 24pt; color: #666; font-size: 9.5pt; }
    .note-entry { margin-bottom: 30pt; padding-bottom: 18pt; border-bottom: 0.5pt solid #ccc; break-inside: avoid-page; }
    .source-text { margin: 0 0 12pt; color: #4c4c4c; font-size: 10.5pt; font-style: italic; font-weight: 400; line-height: 1.65; }
    .source-text em { font-style: inherit; font-weight: inherit; }
    .source-underlined { text-decoration-line: underline; text-decoration-thickness: 1.5px; text-underline-offset: 0.18em; }
    .note-body { margin: 0; font-size: 12.5pt; font-style: normal; font-weight: 400; line-height: 1.7; }
    .note-label { margin-right: 0.35rem; font-weight: 650; }
    .note-page { margin-left: 0.5rem; color: #777; font-size: 9.5pt; }
    .note-empty { color: #777; font-style: italic; }
    .glossary-print-section { margin-top: 30pt; }
    .glossary-print-section h2 { margin: 0 0 14pt; font-size: 16pt; line-height: 1.3; break-after: avoid-page; }
    .glossary-entry { margin-bottom: 18pt; padding-bottom: 12pt; border-bottom: 0.5pt solid #ccc; break-inside: avoid-page; }
    .glossary-entry h3 { margin: 0 0 5pt; font-size: 12.5pt; line-height: 1.3; }
    .glossary-entry p { margin: 0 0 5pt; font-size: 11pt; line-height: 1.5; }
    .glossary-page { color: #777; font-size: 9.5pt; }
    .dictionary-attribution { margin: 16pt 0 0; color: #777; font-size: 8.5pt; line-height: 1.4; }
    ${layoutCss}
    @media screen { body { background: #f5f5f3; } main { max-width: 820px; margin: 30px auto; padding: 44px; background: #fff; box-shadow: 0 3px 18px rgba(0, 0, 0, 0.12); } }
  </style>
</head>
<body class="${getPrintLayoutClass(layout)}" data-print-layout="${layout}">
  <main>
    <h1 class="document-title">${title}</h1>
    <p class="export-date">Exported ${exportDate}</p>
    ${noteEntries}
    ${glossarySection}
  </main>
</body>
</html>`;
}

function formatGlossaryForPrint(entry: GlossaryEntry): string {
  return `      <article class="glossary-entry">
        <h3>${escapeHtml(entry.displayedWord)}</h3>
        <p>${escapeHtml(entry.definition)}</p>
        <span class="glossary-page">Page ${entry.pageNumber}</span>
      </article>`;
}

function formatNoteForPrint(note: Note, annotation: PdfAnnotation | undefined): string {
  const sourceText = normalizeWhitespace(note.selectedText) || 'Source text unavailable.';
  const noteHeading = formatNoteLabel(note.displayNumber);
  const content = formatNoteContentForHtml(note.content);

  const underlineStyle = annotation?.type === 'underline'
    ? ` style="text-decoration-color: ${underlineColors[annotation.color].cssValue};"`
    : '';
  const sourceClass = annotation?.type === 'underline' ? 'source-text source-underlined' : 'source-text';

  return `    <article class="note-entry">
      <div class="${sourceClass}"${underlineStyle}><em>${escapeHtml(sourceText)}</em></div>
      <p class="note-body"><span class="note-label">${escapeHtml(noteHeading)}</span><span class="note-page">Page ${note.pageNumber}</span><br>${content}</p>
    </article>`;
}

function formatNoteContentForHtml(content: string): string {
  const normalizedContent = content.replaceAll('\r\n', '\n').trimEnd();
  if (normalizedContent.length === 0) {
    return '<span class="note-empty">No note content.</span>';
  }

  return escapeHtml(normalizedContent).replaceAll('\n', '<br>');
}

function escapeHtml(value: string): string {
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
