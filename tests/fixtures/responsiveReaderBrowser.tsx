import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sidebar } from '../../src/components/Sidebar.tsx';
import { ThemeProvider } from '../../src/components/ThemeProvider.tsx';
import { Toolbar } from '../../src/components/Toolbar.tsx';
import type { AnnotationFilterState } from '../../src/components/pdf/AnnotationFilterControl.tsx';
import '../../src/styles/index.css';

declare global {
  var __39noteResponsiveReaderFixture:
    | {
        failures: string[];
        exportNotesCalls: number;
        remoteMutations: number;
        searchCalls: number;
      }
    | undefined;
}

const emptyFilter: AnnotationFilterState = {
  colors: [],
  noteStatus: 'all',
  types: ['highlight', 'underline'],
};

globalThis.__39noteResponsiveReaderFixture = {
  failures: [],
  exportNotesCalls: 0,
  remoteMutations: 0,
  searchCalls: 0,
};

export function BrowserFixture() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [result, setResult] = useState<'RUNNING' | 'PASS' | 'FAIL'>('RUNNING');
  const [details, setDetails] = useState('Checking compact Reader controls…');

  useEffect(() => {
    let disposed = false;
    void runResponsiveChecks()
      .then(() => {
        if (disposed) return;
        setResult('PASS');
        setDetails('Compact toolbar and Reader Tools drawer checks passed.');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        globalThis.__39noteResponsiveReaderFixture?.failures.push(message);
        setResult('FAIL');
        setDetails(message);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <ThemeProvider>
      <main
        className={`app-layout is-compact-reader ${sidebarCollapsed ? 'is-sidebar-collapsed' : 'is-reader-tools-open'}`}
        aria-label="Synthetic responsive Reader fixture"
      >
        <div className="reader-workspace">
          <Toolbar
            isCompactReader
            onOpenFile={() => undefined}
            onZoomIn={() => undefined}
            onZoomOut={() => undefined}
            onFitWidth={() => undefined}
            onFitPage={() => undefined}
            onApplyZoom={() => undefined}
            onGoToPage={() => undefined}
            onOpenSearch={() => {
              if (globalThis.__39noteResponsiveReaderFixture) {
                globalThis.__39noteResponsiveReaderFixture.searchCalls += 1;
              }
            }}
            openFileRequestId={0}
            onExportAnnotatedPdf={() => undefined}
            onExportNotes={() => {
              if (globalThis.__39noteResponsiveReaderFixture) {
                globalThis.__39noteResponsiveReaderFixture.exportNotesCalls += 1;
              }
            }}
            isAnnotatedPdfExporting={false}
            canExportNotes
            hasDocument
            documentType="pdf"
            pageCount={12}
            currentPage={3}
            effectiveZoom={1.25}
            documentTitle="Synthetic portrait paper.pdf"
            isAiOpen={false}
            aiStatus="connected"
            onToggleAi={() => undefined}
          />
          <div className="app-content">
            {!sidebarCollapsed ? (
              <button
                aria-label="Close synthetic Reader panel"
                className="reader-mobile-scrim"
                type="button"
                onClick={() => setSidebarCollapsed(true)}
              />
            ) : null}
            <Sidebar
              isCollapsed={sidebarCollapsed}
              isModal
              onToggle={() => setSidebarCollapsed((collapsed) => !collapsed)}
              width={300}
              onWidthChange={() => undefined}
              pdfDocument={null}
              currentPage={3}
              onGoToPage={() => undefined}
              annotations={[]}
              notedAnnotationIds={[]}
              annotationFilter={emptyFilter}
              onAnnotationFilterChange={() => undefined}
            />
            <section className="viewer synthetic-responsive-viewer">
              <button
                className="open-reader-tools"
                type="button"
                onClick={() => setSidebarCollapsed(false)}
              >
                Open synthetic Reader Tools
              </button>
              <div className="synthetic-responsive-page" aria-hidden="true" />
            </section>
          </div>
        </div>
        <p className="visually-hidden" id="summary" data-responsive-result={result}>
          {result}
        </p>
        <pre className="visually-hidden" id="details">
          {details}
        </pre>
      </main>
    </ThemeProvider>
  );
}

async function runResponsiveChecks(): Promise<void> {
  await waitForAnimationFrame();
  const trigger = requiredElement<HTMLButtonElement>(
    '.toolbar-compact-tools-trigger',
    'compact toolbar trigger',
  );
  const actions = requiredElement<HTMLElement>(
    '#toolbar-compact-tools-drawer',
    'compact toolbar drawer',
  );
  assert(getComputedStyle(trigger).display !== 'none', 'toolbar trigger is visible');
  assert(getComputedStyle(actions).display === 'none', 'toolbar drawer starts closed');
  assert(
    trigger.getAttribute('aria-expanded') === 'false',
    'toolbar trigger starts collapsed',
  );
  assert(trigger.getBoundingClientRect().height >= 40, 'toolbar trigger is touchable');

  trigger.click();
  await waitForCondition(() => getComputedStyle(actions).display !== 'none');
  assert(
    trigger.getAttribute('aria-expanded') === 'true',
    'toolbar trigger reports expanded',
  );

  for (const [selector, label] of [
    ['.clock-trigger', 'timer'],
    ['.toolbar-ai-trigger', 'AI'],
    ['.toolbar-button-primary', 'Open'],
    ['.toolbar-zoom-input', 'zoom percentage'],
    ['.toolbar-fit-width', 'Fit Width'],
    ['.toolbar-fit-page', 'Fit Page'],
    ['.toolbar-search-trigger', 'Search'],
    ['.page-number-input', 'page number'],
    ['.toolbar-export-annotated', 'Export Annotated PDF'],
    ['.toolbar-export-notes', 'Export Notes'],
  ] as const) {
    assertVisibleWithinViewport(selector, label);
  }
  const zoomButtons = Array.from(
    document.querySelectorAll<HTMLElement>('.toolbar-zoom-button'),
  );
  assert(zoomButtons.length === 2, 'both zoom buttons are rendered');
  zoomButtons.forEach((button, index) =>
    assertVisibleElement(button, index === 0 ? 'Zoom out' : 'Zoom in'),
  );
  assert(
    document.documentElement.scrollWidth <= window.innerWidth,
    'toolbar does not cause horizontal page overflow',
  );

  trigger.focus();
  window.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }),
  );
  await waitForCondition(() => getComputedStyle(actions).display === 'none');
  await waitForAnimationFrame();
  assert(document.activeElement === trigger, 'Escape restores toolbar-trigger focus');

  trigger.click();
  await waitForCondition(() => getComputedStyle(actions).display !== 'none');
  requiredElement<HTMLButtonElement>(
    '.toolbar-search-trigger',
    'Search button',
  ).click();
  await waitForCondition(() => getComputedStyle(actions).display === 'none');
  assert(
    globalThis.__39noteResponsiveReaderFixture?.searchCalls === 1,
    'Search invokes the same Reader search action',
  );

  trigger.click();
  await waitForCondition(() => getComputedStyle(actions).display !== 'none');
  requiredElement<HTMLButtonElement>(
    '.toolbar-export-notes',
    'Export Notes button',
  ).click();
  await waitForCondition(() => getComputedStyle(actions).display === 'none');
  assert(
    globalThis.__39noteResponsiveReaderFixture?.exportNotesCalls === 1,
    'Export Notes invokes the current-document Markdown export action',
  );

  const sidebar = requiredElement<HTMLElement>('.reader-tools-sidebar', 'Reader Tools');
  const sidebarInner = requiredElement<HTMLElement>(
    '.reader-tools-inner',
    'Reader Tools contents',
  );
  assert(
    sidebar.getAttribute('aria-hidden') === null,
    'Reader Tools shell keeps its opener in the accessibility tree',
  );
  assert(
    sidebarInner.getAttribute('aria-hidden') === 'true',
    'Reader Tools contents start hidden',
  );
  const edgeHandle = requiredElement<HTMLButtonElement>(
    '.reader-tools-sidebar > .drawer-edge-handle',
    'Reader Tools edge handle',
  );
  assert(
    edgeHandle.getAttribute('aria-label') === 'Open navigation and annotations',
    'collapsed Reader Tools exposes an exact accessible opener name',
  );
  const layout = requiredElement<HTMLElement>('.app-layout', 'Reader layout');
  layout.classList.remove('is-compact-reader');
  await waitForAnimationFrame();
  assert(
    getComputedStyle(edgeHandle).display !== 'none',
    'docked Reader Tools opener remains visible',
  );
  edgeHandle.focus();
  assert(
    document.activeElement === edgeHandle,
    'docked Reader Tools opener remains keyboard-focusable',
  );
  edgeHandle.blur();
  layout.classList.add('is-compact-reader');
  requiredElement<HTMLButtonElement>(
    '.open-reader-tools',
    'synthetic Reader Tools trigger',
  ).click();
  await waitForCondition(() => sidebarInner.getAttribute('aria-hidden') === null);
  const sidebarBounds = sidebar.getBoundingClientRect();
  const innerBounds = sidebarInner.getBoundingClientRect();
  assert(sidebarBounds.left === 0, 'Reader Tools is flush with the left edge');
  assert(
    sidebarBounds.width <= window.innerWidth - 44,
    'Reader Tools preserves a dismissible viewport edge',
  );
  assert(
    innerBounds.left >= sidebarBounds.left &&
      innerBounds.right <= sidebarBounds.right + 1,
    'Reader Tools contents stay inside the drawer',
  );
  assert(
    document.documentElement.scrollWidth <= window.innerWidth,
    'Reader Tools does not cause horizontal page overflow',
  );
  assert(
    globalThis.__39noteResponsiveReaderFixture?.remoteMutations === 0,
    'responsive fixture performs no remote mutation',
  );
}

function assertVisibleWithinViewport(selector: string, label: string): void {
  assertVisibleElement(requiredElement<HTMLElement>(selector, label), label);
}

function assertVisibleElement(element: HTMLElement, label: string): void {
  const bounds = element.getBoundingClientRect();
  assert(getComputedStyle(element).display !== 'none', `${label} is displayed`);
  assert(bounds.width > 0 && bounds.height > 0, `${label} has visible geometry`);
  assert(bounds.left >= 0 && bounds.right <= window.innerWidth + 1, `${label} fits`);
}

function requiredElement<T extends Element>(selector: string, label: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`${label} was not rendered.`);
  return element;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Responsive check timed out.');
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

createRoot(document.getElementById('root')!).render(<BrowserFixture />);
