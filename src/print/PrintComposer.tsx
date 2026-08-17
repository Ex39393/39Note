import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { $generateHtmlFromNodes } from '@lexical/html';
import type { LexicalEditor } from 'lexical';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import {
  notesPrintLayouts,
  type GlossaryEntry,
  type NotesPrintLayout,
} from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';
import type { PrintDraftRecord } from '../types/productivity';
import {
  clearPrintDraft,
  loadPrintDraft,
  savePrintDraft,
} from '../services/productivityPersistence';
import { PrintComposerEditor } from './PrintComposerEditor';
import {
  createPrintSourceFingerprint,
  PRINT_SOURCE_MODEL_VERSION,
} from './printDraftModel';
import { printComposerHtml } from './printComposerOutput';

interface PrintComposerProps {
  documentId: string;
  documentTitle: string;
  notes: readonly Note[];
  annotations: readonly PdfAnnotation[];
  noteAnchors: readonly NoteAnchor[];
  glossaryEntries: readonly GlossaryEntry[];
  initialLayout: NotesPrintLayout;
  onClose: () => void;
}

export function PrintComposer({
  documentId,
  documentTitle,
  notes,
  annotations,
  noteAnchors,
  glossaryEntries,
  initialLayout,
  onClose,
}: PrintComposerProps) {
  const sourceFingerprint = useMemo(
    () =>
      createPrintSourceFingerprint(
        documentTitle,
        notes,
        glossaryEntries,
        annotations,
        noteAnchors,
      ),
    [annotations, documentTitle, glossaryEntries, noteAnchors, notes],
  );
  const [draft, setDraft] = useState<PrintDraftRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [decision, setDecision] = useState<'ready' | 'existing'>('ready');
  const [editorKey, setEditorKey] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const editorRef = useRef<LexicalEditor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const printCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void loadPrintDraft(documentId).then((existing) => {
      if (cancelled) return;
      if (existing) {
        setDraft(existing);
        setLastSavedAt(existing.lastSavedAt);
        setDecision('existing');
      } else {
        setDraft(createFreshDraft(documentId, sourceFingerprint, initialLayout));
        setDecision('ready');
      }
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [documentId, initialLayout, sourceFingerprint]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      printCleanupRef.current?.();
    },
    [],
  );

  const persistDraft = useCallback((nextDraft: PrintDraftRecord) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const savedAt = Date.now();
      void savePrintDraft({
        ...nextDraft,
        lastSavedAt: savedAt,
        updatedAt: savedAt,
      }).then((saved) => {
        if (saved) setLastSavedAt(savedAt);
        else setStatusMessage('Draft could not be saved locally.');
      });
      saveTimerRef.current = null;
    }, 500);
  }, []);

  const updateDraft = useCallback(
    (change: Partial<PrintDraftRecord>) => {
      setDraft((current) => {
        if (!current) return current;
        const next = { ...current, ...change, updatedAt: Date.now() };
        persistDraft(next);
        return next;
      });
    },
    [persistDraft],
  );

  const regenerate = (layout = draft?.layout ?? initialLayout) => {
    const fresh = createFreshDraft(
      documentId,
      sourceFingerprint,
      layout,
    );
    setDraft(fresh);
    setDecision('ready');
    setEditorKey((key) => key + 1);
    setLastSavedAt(null);
    setStatusMessage('Regenerated from the current print sources.');
    persistDraft(fresh);
  };

  const resetDraft = () => {
    if (
      draft?.editorStateJson &&
      !window.confirm(
        'Reset this print draft to the current Notes, annotations, and Glossary? Your print-only edits will be lost.',
      )
    ) {
      return;
    }
    regenerate();
  };

  const selectLayout = (layout: NotesPrintLayout) => {
    if (!draft || layout === draft.layout) return;
    const changesPrintedSources =
      layout === 'all-annotations' || draft.layout === 'all-annotations';
    if (!changesPrintedSources) {
      updateDraft({ layout });
      return;
    }
    if (
      draft.editorStateJson &&
      !window.confirm(
        'Changing to or from All Annotations regenerates the source blocks. Continue and discard print-only edits?',
      )
    ) {
      return;
    }
    regenerate(layout);
  };

  const print = () => {
    if (!editorRef.current || !draft || isPrinting) return;
    let html = '';
    editorRef.current.read(() => {
      html = $generateHtmlFromNodes(editorRef.current!);
    });
    setIsPrinting(true);
    const cleanup = printComposerHtml(html, documentTitle, draft.layout, () => {
      printCleanupRef.current = null;
      setIsPrinting(false);
    });
    if (!cleanup) {
      setIsPrinting(false);
      setStatusMessage(
        'The browser blocked the print window. Allow popups and try again.',
      );
      return;
    }
    printCleanupRef.current = cleanup;
  };

  if (isLoading || !draft) {
    return (
      <div
        className="print-composer-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Print Composer"
      >
        <p className="print-composer-loading" role="status">
          Opening Print Composer…
        </p>
      </div>
    );
  }

  const sourceFormatChanged = draft.sourceModelVersion < PRINT_SOURCE_MODEL_VERSION;
  const sourceChanged = sourceFormatChanged || draft.sourceFingerprint !== sourceFingerprint;
  if (decision === 'existing') {
    return (
      <div
        className="print-composer-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="print-draft-found-title"
      >
        <section className="print-draft-decision">
          <h2 id="print-draft-found-title">Saved print draft found</h2>
          <p>
            Reopen your print-only edits, or regenerate from the current print
            sources.
          </p>
          {sourceChanged ? (
            <p className="print-source-change-notice" role="status">
              {sourceFormatChanged
                ? 'Print-source formatting/order has changed since this draft was created.'
                : 'Print sources have changed since this draft was created.'}
            </p>
          ) : null}
          <div>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" onClick={() => setDecision('ready')}>
              Keep draft
            </button>
            <button type="button" onClick={() => regenerate(initialLayout)}>
              Regenerate from sources
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className="print-composer-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="print-composer-title"
    >
      <section className={`print-composer print-layout-${draft.layout}`}>
        <header className="print-composer-header">
          <div>
            <h2 id="print-composer-title">Print Composer</h2>
            <p>{documentTitle}</p>
          </div>
          <div className="print-composer-layouts" aria-label="Print layout">
            {notesPrintLayouts.map((layout) => (
              <button
                aria-pressed={draft.layout === layout}
                key={layout}
                type="button"
                onClick={() => selectLayout(layout)}
              >
                {getPrintLayoutLabel(layout)}
              </button>
            ))}
          </div>
          <div className="print-composer-actions">
            <span className="print-draft-save-status" role="status">
              {lastSavedAt
                ? `Last saved ${new Date(lastSavedAt).toLocaleTimeString()}`
                : 'Not saved yet'}
            </span>
            <button type="button" onClick={resetDraft}>
              Reset to current sources
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm('Clear the saved print draft from this device?'))
                  return;
                void clearPrintDraft(documentId).then(onClose);
              }}
            >
              Clear draft
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button
              className="print-composer-print"
              type="button"
              disabled={isPrinting}
              onClick={print}
            >
              {isPrinting ? 'Printing…' : 'Print / Save as PDF'}
            </button>
          </div>
        </header>
        {sourceChanged ? (
          <div className="print-source-change-banner" role="status">
            <span>{sourceFormatChanged
              ? 'Print-source formatting/order has changed since this draft was created.'
              : 'Print sources have changed since this draft was created.'}</span>
            <button type="button" onClick={() => regenerate()}>
              Regenerate from sources
            </button>
          </div>
        ) : null}
        {statusMessage ? (
          <p className="print-composer-status" role="status">
            {statusMessage}
          </p>
        ) : null}
        <PrintComposerEditor
          key={editorKey}
          documentTitle={documentTitle}
          notes={notes}
          annotations={annotations}
          noteAnchors={noteAnchors}
          glossaryEntries={glossaryEntries}
          layout={draft.layout}
          initialEditorStateJson={draft.editorStateJson}
          pendingAdditions={draft.pendingAdditions}
          onPendingAdditionsConsumed={() => updateDraft({ pendingAdditions: [] })}
          onReady={(editor) => {
            editorRef.current = editor;
          }}
          onChange={(editorStateJson) => updateDraft({ editorStateJson })}
        />
      </section>
    </div>
  );
}

function getPrintLayoutLabel(layout: NotesPrintLayout): string {
  if (layout === 'space-saving') return 'Space-saving';
  if (layout === 'extra-large') return 'Extra Large';
  if (layout === 'all-annotations') return 'All Annotations';
  return 'Standard';
}

function createFreshDraft(
  documentId: string,
  sourceFingerprint: string,
  layout: NotesPrintLayout,
): PrintDraftRecord {
  const timestamp = Date.now();
  return {
    documentId,
    sourceFingerprint,
    sourceModelVersion: PRINT_SOURCE_MODEL_VERSION,
    editorStateJson: '',
    layout,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSavedAt: timestamp,
    pendingAdditions: [],
  };
}
