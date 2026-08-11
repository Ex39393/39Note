import type { NotesPrintLayout } from '../types/glossary';
import { getPrintLayoutCss } from '../utils/printSession';

const ALLOWED_TAGS = new Set([
  'ARTICLE',
  'P',
  'H1',
  'H2',
  'H3',
  'BLOCKQUOTE',
  'UL',
  'OL',
  'LI',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'S',
  'STRIKE',
  'SUP',
  'SUB',
  'SPAN',
  'A',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'HR',
  'DIV',
  'BR',
]);
const ALLOWED_STYLES = new Set([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'text-align',
  'line-height',
  'margin-top',
  'margin-bottom',
  'text-indent',
  'padding-left',
  'break-after',
  'page-break-after',
]);

export function sanitizeComposerHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(`<main>${html}</main>`, 'text/html');
  const main = parsed.body.firstElementChild;
  if (!main) return '';
  for (const element of Array.from(main.querySelectorAll('*'))) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase();
      if (name === 'style') {
        const style = (element as HTMLElement).style;
        for (const property of Array.from(style)) {
          if (!ALLOWED_STYLES.has(property)) style.removeProperty(property);
        }
      } else if (
        name !== 'href' &&
        name !== 'colspan' &&
        name !== 'rowspan' &&
        name !== 'class' &&
        name !== 'data-source-id' &&
        name !== 'data-block-kind'
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|#)/i.test(href)) element.removeAttribute('href');
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    }
    if (element.hasAttribute('class')) {
      element.className = element.className
        .split(/\s+/)
        .filter((name) => /^print-(?:composer-block|block-|page-break)/.test(name))
        .join(' ');
    }
  }
  return main.innerHTML;
}

export function printComposerHtml(
  html: string,
  documentTitle: string,
  layout: NotesPrintLayout,
  onComplete: () => void,
): (() => void) | null {
  const printWindow = window.open('', '_blank', 'width=980,height=780');
  if (!printWindow) return null;
  let completed = false;
  const cleanup = () => {
    if (completed) return;
    completed = true;
    onComplete();
  };
  const safeTitle = escapeHtml(documentTitle);
  const safeContent = sanitizeComposerHtml(html);
  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
  @page { size: A4; margin: 17mm 18mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #171717; background: #fff; font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.5; }
  main { width: 100%; max-width: 176mm; margin: 0 auto; overflow-wrap: anywhere; }
  h1, h2, h3 { break-after: avoid-page; overflow-wrap: anywhere; }
  p { margin: 0 0 10pt; }
  blockquote { margin: 8pt 0 12pt 18pt; padding-left: 12pt; border-left: 2pt solid #aaa; }
  table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; break-inside: auto; }
  th, td { min-width: 0; padding: 5pt; border: 0.6pt solid #777; overflow-wrap: anywhere; vertical-align: top; }
  tr { break-inside: avoid; }
  img, svg { max-width: 100%; }
  .print-composer-block { break-inside: auto; margin-bottom: 18pt; }
  .print-page-break { display: block; break-before: page; page-break-before: always; height: 0; }
  ${getPrintLayoutCss(layout)}
  body.print-layout-space-saving { font-size: 10pt; line-height: 1.3; }
  body.print-layout-space-saving .print-composer-block { margin-bottom: 10pt; }
  body.print-layout-extra-large { font-size: 16pt; line-height: 1.55; }
  body.print-layout-extra-large .print-composer-block { margin-bottom: 28pt; }
  @media print { a { color: inherit; } }
</style></head><body class="print-layout-${layout}" data-print-layout="${layout}"><main>${safeContent}</main></body></html>`);
  printWindow.document.close();
  const print = () => {
    if (printWindow.closed) {
      cleanup();
      return;
    }
    printWindow.addEventListener('afterprint', cleanup, { once: true });
    printWindow.focus();
    printWindow.print();
  };
  printWindow.addEventListener('load', print, { once: true });
  window.setTimeout(print, 50);
  return () => {
    if (!printWindow.closed) printWindow.close();
    cleanup();
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}
