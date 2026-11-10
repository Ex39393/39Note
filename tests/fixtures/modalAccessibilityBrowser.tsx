import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryPanel } from '../../src/components/LibraryPanel.tsx';
import { NotesPanel } from '../../src/components/NotesPanel.tsx';
import { ThemeProvider } from '../../src/components/ThemeProvider.tsx';
import { saveDocumentState } from '../../src/services/annotationPersistence.ts';
import type { Note } from '../../src/types/note.ts';
import '../../src/styles/index.css';

declare global {
  var __39noteModalAccessibilityFixture:
    | {
        failures: string[];
        remoteMutations: number;
      }
    | undefined;
}

const documentId = 'synthetic-modal-accessibility-paper';
const note: Note = {
  id: 'synthetic-note',
  annotationId: 'synthetic-annotation',
  pageNumber: 1,
  displayNumber: '1',
  selectedText: 'synthetic source',
  content: 'Synthetic Note',
  createdAt: 1,
  updatedAt: 1,
};

export function BrowserFixture() {
  const [libraryReady, setLibraryReady] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);
  const [activeDocumentId, setActiveDocumentId] = useState('notes-paper-a');
  const [result, setResult] = useState<'RUNNING' | 'PASS' | 'FAIL'>('RUNNING');
  const [details, setDetails] = useState('Preparing synthetic local state…');

  useEffect(() => {
    let disposed = false;
    void saveDocumentState(
      { documentId, documentName: 'Synthetic modal paper.pdf' },
      [],
      [],
      [],
      [],
      1,
      'Synthetic modal paper',
      'pdf',
    ).then((saved) => {
      if (disposed) return;
      if (!saved) {
        setResult('FAIL');
        setDetails('Synthetic Library state could not be saved.');
        return;
      }
      setLibraryReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const closeOuterNotesPanel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setNotesOpen(false);
    };
    document.addEventListener('keydown', closeOuterNotesPanel);
    return () => document.removeEventListener('keydown', closeOuterNotesPanel);
  }, []);

  useEffect(() => {
    if (!libraryReady || result !== 'RUNNING') return;
    let disposed = false;
    void runModalChecks()
      .then(() => {
        if (disposed) return;
        setResult('PASS');
        setDetails('Library and Notes modal focus checks passed.');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        globalThis.__39noteModalAccessibilityFixture?.failures.push(message);
        setResult('FAIL');
        setDetails(message);
      });
    return () => {
      disposed = true;
    };
  }, [libraryReady, result]);

  return (
    <ThemeProvider>
      <main aria-label="Synthetic modal accessibility fixture">
        <section aria-label="Fixture controls">
          <button
            data-testid="change-document"
            type="button"
            onClick={() => setActiveDocumentId('notes-paper-b')}
          >
            Change synthetic paper
          </button>
          <button
            data-testid="close-notes"
            type="button"
            onClick={() => setNotesOpen(false)}
          >
            Close synthetic Notes
          </button>
          <button
            data-testid="open-notes"
            type="button"
            onClick={() => setNotesOpen(true)}
          >
            Open synthetic Notes
          </button>
        </section>
        {libraryReady ? (
          <LibraryPanel
            focusSearchRequestId={0}
            isOpen
            presentation="embedded"
            refreshToken={0}
            onClose={() => undefined}
            onForget={async () => false}
            onForgetMany={async () => ({ deleted: [], failed: [documentId] })}
            onImportAsNewPaper={() => undefined}
            onOpenFile={() => undefined}
            onOpenLibraryNote={async () => false}
            onOpenStoredDocument={async () => false}
            onPinDocument={async () => false}
            onRemoveSourceCopy={async () => false}
            onRenameDocument={async () => false}
            onSelectSourceForLibraryNote={() => undefined}
          />
        ) : null}
        <NotesPanel
          activeDocumentId={activeDocumentId}
          annotationCount={1}
          documentLinks={[]}
          draggedNoteId={null}
          focusedNoteId={null}
          glossaryEntries={[]}
          isExporting={false}
          isModal
          isOpen={notesOpen}
          notes={[note]}
          onBeginNoteDrag={() => undefined}
          onCommitNoteEdit={() => undefined}
          onDelete={() => undefined}
          onDeleteLink={() => undefined}
          onEditBeforePrinting={() => undefined}
          onExportNotes={() => undefined}
          onFocusComplete={() => undefined}
          onFocusedNoteReady={() => undefined}
          onNavigate={() => undefined}
          onNavigateGlossary={() => undefined}
          onNavigateLink={() => undefined}
          onOpenLargeEditor={() => undefined}
          onRemoveGlossary={() => undefined}
          onRenameLink={() => undefined}
          onToggle={() => setNotesOpen((open) => !open)}
          onUpdate={() => undefined}
          onUpdateDisplayNumber={() => undefined}
        />
        <p id="summary" data-modal-result={result}>
          {result}
        </p>
        <pre id="details">{details}</pre>
      </main>
    </ThemeProvider>
  );
}

async function runModalChecks(): Promise<void> {
  const libraryTrigger = await waitForElement<HTMLButtonElement>(() =>
    findButton('Remove from this device'),
  );
  libraryTrigger.focus();
  libraryTrigger.click();
  let libraryDialog = await waitForElement<HTMLElement>(() =>
    document.querySelector('[role="dialog"][aria-label="Forget document"]'),
  );
  await waitForAnimationFrame();
  assertActiveButton('Cancel', 'Library single-paper initial focus');
  assertFocusWraps(libraryDialog, 'Library single-paper focus loop');
  dispatchKey(libraryDialog, 'Escape');
  await waitForMissing('[role="dialog"][aria-label="Forget document"]');
  await waitForAnimationFrame();
  assert(
    document.activeElement === libraryTrigger,
    'Library trigger focus was restored',
  );

  findButton('Select')?.click();
  const checkbox = await waitForElement<HTMLInputElement>(() =>
    document.querySelector('input[aria-label="Select Synthetic modal paper"]'),
  );
  checkbox.click();
  const batchTrigger = await waitForElement<HTMLButtonElement>(() =>
    findButton('Remove 1 from this device'),
  );
  batchTrigger.focus();
  batchTrigger.click();
  libraryDialog = await waitForElement<HTMLElement>(() =>
    document.querySelector('[role="dialog"][aria-label="Forget selected documents"]'),
  );
  await waitForAnimationFrame();
  assertActiveButton('Cancel', 'Library batch initial focus');
  assertFocusWraps(libraryDialog, 'Library batch focus loop');
  dispatchKey(libraryDialog, 'Escape');
  await waitForMissing('[role="dialog"][aria-label="Forget selected documents"]');
  await waitForAnimationFrame();
  assert(document.activeElement === batchTrigger, 'Library batch focus was restored');

  const exportButton = await waitForElement<HTMLButtonElement>(() =>
    findButton('Export PDF'),
  );
  exportButton.focus();
  exportButton.click();
  let notesDialog = await waitForElement<HTMLElement>(() =>
    document.querySelector('[role="dialog"][aria-labelledby="notes-print-title"]'),
  );
  await waitForAnimationFrame();
  assertActiveButton('Cancel', 'Notes initial focus');
  assertFocusWraps(notesDialog, 'Notes focus loop');
  dispatchKey(notesDialog, 'Escape');
  await waitForMissing('[role="dialog"][aria-labelledby="notes-print-title"]');
  await waitForAnimationFrame();
  assert(
    document.querySelector('.notes-panel')?.classList.contains('is-open') === true,
    'Notes Escape closed the outer drawer',
  );
  assert(document.activeElement === exportButton, 'Notes trigger focus was restored');

  exportButton.click();
  notesDialog = await waitForElement<HTMLElement>(() =>
    document.querySelector('[role="dialog"][aria-labelledby="notes-print-title"]'),
  );
  assert(notesDialog, 'Notes dialog reopened before document transition');
  findButton('Change synthetic paper')?.click();
  await waitForMissing('[role="dialog"][aria-labelledby="notes-print-title"]');

  exportButton.click();
  await waitForElement<HTMLElement>(() =>
    document.querySelector('[role="dialog"][aria-labelledby="notes-print-title"]'),
  );
  findButton('Close synthetic Notes')?.click();
  await waitForMissing('[role="dialog"][aria-labelledby="notes-print-title"]');
  findButton('Open synthetic Notes')?.click();
  await waitForCondition(
    () =>
      document.querySelector('.notes-panel')?.classList.contains('is-open') === true,
  );
  assert(
    !document.querySelector('[role="dialog"][aria-labelledby="notes-print-title"]'),
    'Notes dialog reappeared after the drawer reopened',
  );
  assertEqual(
    globalThis.__39noteModalAccessibilityFixture?.remoteMutations ?? -1,
    0,
    'remote mutation count',
  );
}

function assertFocusWraps(dialog: HTMLElement, label: string): void {
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  assert(focusable.length > 1, `${label} has fewer than two focus targets`);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  last.focus();
  dispatchKey(last, 'Tab');
  assert(document.activeElement === first, `${label} did not wrap forward`);
  first.focus();
  dispatchKey(first, 'Tab', true);
  assert(document.activeElement === last, `${label} did not wrap backward`);
}

function assertActiveButton(text: string, label: string): void {
  assert(
    document.activeElement instanceof HTMLButtonElement &&
      document.activeElement.textContent?.trim() === text,
    `${label} was not ${text}`,
  );
}

function findButton(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

function dispatchKey(target: HTMLElement, key: string, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }),
  );
}

async function waitForElement<T extends Element>(
  resolve: () => T | null,
  timeoutMs = 5_000,
): Promise<T> {
  let value: T | null = null;
  await waitForCondition(() => {
    value = resolve();
    return value !== null;
  }, timeoutMs);
  return value!;
}

async function waitForMissing(selector: string): Promise<void> {
  await waitForCondition(() => !document.querySelector(selector));
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Browser fixture timed out.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

globalThis.__39noteModalAccessibilityFixture = {
  failures: [],
  remoteMutations: 0,
};

createRoot(document.getElementById('root')!).render(<BrowserFixture />);
