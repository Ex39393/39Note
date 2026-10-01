import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { $generateHtmlFromNodes } from '@lexical/html';
import type { LexicalEditor } from 'lexical';
import type { Note } from '../types/note';
import type { NoteAnchor } from '../types/noteAnchor';
import { type GlossaryEntry, type NotesPrintLayout } from '../types/glossary';
import type { PdfAnnotation } from '../types/highlight';
import {
  PRINT_DRAFT_SCHEMA_VERSION,
  type PrintContentMode,
  type PrintDraftRecord,
  type RenderedPrintPdfState,
  type StoredRenderedPrintPdf,
  type PrintTemplateId,
} from '../types/productivity';
import {
  clearPrintDraft,
  loadPrintDraft,
  loadRenderedPrintPdf,
  removeRenderedPrintPdf,
  replaceRenderedPrintPdf,
  savePrintDraft,
} from '../services/productivityPersistence';
import { PrintComposerEditor } from './PrintComposerEditor';
import {
  createPrintSourceFingerprint,
  PRINT_SOURCE_MODEL_VERSION,
} from './printDraftModel';
import { printComposerHtml } from './printComposerOutput';
import { registerPersistenceFlusher } from '../services/persistentChange';
import {
  BUILT_IN_PRINT_TEMPLATES,
  getPrintContentLayout,
  getPrintTemplateClassName,
  normalizeLegacyPrintLayout,
  PRINT_TEMPLATE_VERSION,
  type PrintPresentation,
} from './printTemplates.ts';
import {
  classifyRenderedPrintPdf,
  createStoredRenderedPrintPdf,
  resolveStoredRenderedPrintPdfForDownload,
} from './renderedPrintPdf.ts';
import {
  createSourceChangeNoticeKey,
  INITIAL_PRINT_COMPOSER_UI_STATE,
  reducePrintComposerUiState,
  shouldShowSourceChangeNotice,
} from './printComposerUiState.ts';

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
  const [renderedPrintPdf, setRenderedPrintPdf] =
    useState<StoredRenderedPrintPdf | null>(null);
  const [renderedPrintPdfState, setRenderedPrintPdfState] =
    useState<RenderedPrintPdfState>('missing');
  const [isAttachingPrintPdf, setIsAttachingPrintPdf] = useState(false);
  const [isDownloadingPrintPdf, setIsDownloadingPrintPdf] = useState(false);
  const [uiState, dispatchUiState] = useReducer(
    reducePrintComposerUiState,
    INITIAL_PRINT_COMPOSER_UI_STATE,
  );
  const editorRef = useRef<LexicalEditor | null>(null);
  const printPdfInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const pendingDraftRef = useRef<PrintDraftRecord | null>(null);
  const printCleanupRef = useRef<(() => void) | null>(null);

  const showStatus = useCallback((message: string, transient = false) => {
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
    setStatusMessage(message);
    if (!transient) return;
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage((current) => (current === message ? '' : current));
      statusTimerRef.current = null;
    }, 5_000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void Promise.all([
      loadPrintDraft(documentId),
      loadRenderedPrintPdf(documentId),
    ]).then(([existing, storedPrintPdf]) => {
      if (cancelled) return;
      setRenderedPrintPdf(storedPrintPdf);
      if (existing) {
        setDraft(existing);
        setLastSavedAt(existing.lastSavedAt);
        setDecision('existing');
      } else {
        setDraft(
          createFreshDraft(
            documentId,
            sourceFingerprint,
            normalizeLegacyPrintLayout(initialLayout),
          ),
        );
        setDecision('ready');
      }
      setIsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [documentId, initialLayout, sourceFingerprint]);

  useEffect(() => {
    let cancelled = false;
    if (!draft) {
      setRenderedPrintPdfState(renderedPrintPdf ? 'stale' : 'missing');
      return () => {
        cancelled = true;
      };
    }
    void classifyRenderedPrintPdf(draft, renderedPrintPdf, sourceFingerprint).then(
      (state) => {
        if (!cancelled) setRenderedPrintPdfState(state);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [draft, renderedPrintPdf, sourceFingerprint]);

  const savePendingDraft = useCallback(async () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const nextDraft = pendingDraftRef.current;
    if (!nextDraft) return false;
    pendingDraftRef.current = null;
    const savedAt = Date.now();
    const saved = await savePrintDraft({
      ...nextDraft,
      lastSavedAt: savedAt,
      updatedAt: savedAt,
    });
    if (saved) setLastSavedAt(savedAt);
    else showStatus('Draft could not be saved locally.');
    return saved;
  }, [showStatus]);

  useEffect(
    () => () => {
      void savePendingDraft();
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      printCleanupRef.current?.();
    },
    [savePendingDraft],
  );

  useEffect(
    () => registerPersistenceFlusher(`print-composer:${documentId}`, savePendingDraft),
    [documentId, savePendingDraft],
  );

  useEffect(() => {
    const handleSyncApplied = (event: Event) => {
      const detail = (event as CustomEvent<{ changedDocumentIds?: string[] }>).detail;
      if (!detail?.changedDocumentIds?.includes(documentId)) return;
      void Promise.all([
        loadPrintDraft(documentId),
        loadRenderedPrintPdf(documentId),
      ]).then(([syncedDraft, syncedPrintPdf]) => {
        if (!syncedDraft) return;
        pendingDraftRef.current = null;
        setDraft(syncedDraft);
        setLastSavedAt(syncedDraft.lastSavedAt);
        setDecision('ready');
        setRenderedPrintPdf(syncedPrintPdf);
        setEditorKey((key) => key + 1);
        showStatus('Print draft updated from Google Drive.', true);
      });
    };
    window.addEventListener('39note:sync-applied', handleSyncApplied);
    return () => window.removeEventListener('39note:sync-applied', handleSyncApplied);
  }, [documentId, showStatus]);

  const persistDraft = useCallback(
    (nextDraft: PrintDraftRecord) => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      pendingDraftRef.current = nextDraft;
      saveTimerRef.current = setTimeout(() => {
        void savePendingDraft();
      }, 500);
    },
    [savePendingDraft],
  );

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

  const regenerate = (
    presentation: PrintPresentation = draft ??
      normalizeLegacyPrintLayout(initialLayout),
  ) => {
    const fresh = createFreshDraft(documentId, sourceFingerprint, presentation);
    setDraft(fresh);
    setDecision('ready');
    setEditorKey((key) => key + 1);
    setLastSavedAt(null);
    showStatus('Regenerated from the current print sources.', true);
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

  const selectTemplate = (baseTemplateId: PrintTemplateId) => {
    if (!draft || baseTemplateId === draft.baseTemplateId) return;
    updateDraft({ baseTemplateId, templateVersion: PRINT_TEMPLATE_VERSION });
  };

  const selectContentMode = (contentMode: PrintContentMode) => {
    if (!draft || contentMode === draft.contentMode) return;
    if (
      draft.editorStateJson &&
      !window.confirm(
        'Changing printed content regenerates the source blocks. Continue and discard print-only edits?',
      )
    ) {
      return;
    }
    regenerate({
      contentMode,
      baseTemplateId: draft.baseTemplateId,
      templateVersion: PRINT_TEMPLATE_VERSION,
      overrides: draft.overrides,
    });
  };

  const print = () => {
    if (!editorRef.current || !draft || isPrinting) return;
    let html = '';
    editorRef.current.read(() => {
      html = $generateHtmlFromNodes(editorRef.current!);
    });
    setIsPrinting(true);
    const cleanup = printComposerHtml(html, documentTitle, draft, () => {
      printCleanupRef.current = null;
      setIsPrinting(false);
      showStatus(
        'If you saved a PDF, attach that exact file so 39Note can store and sync it.',
      );
    });
    if (!cleanup) {
      setIsPrinting(false);
      showStatus('The browser blocked the print window. Allow popups and try again.');
      return;
    }
    printCleanupRef.current = cleanup;
  };

  const attachSavedPrintPdf = async (file: File) => {
    if (!draft || isAttachingPrintPdf) return;
    const isReplacement = renderedPrintPdf !== null;
    setIsAttachingPrintPdf(true);
    try {
      const artifact = await createStoredRenderedPrintPdf(
        documentId,
        documentTitle,
        draft,
        file,
        Date.now(),
        sourceFingerprint,
      );
      const persistedArtifact = await replaceRenderedPrintPdf(artifact);
      setRenderedPrintPdf(persistedArtifact);
      showStatus(
        isReplacement ? 'Saved Print PDF replaced.' : 'Saved Print PDF attached.',
        true,
      );
    } catch (error) {
      showStatus(
        error instanceof Error
          ? error.message
          : 'The selected Print PDF could not be attached.',
      );
    } finally {
      setIsAttachingPrintPdf(false);
      if (printPdfInputRef.current) printPdfInputRef.current.value = '';
    }
  };

  const downloadSavedPrintPdf = async () => {
    if (!renderedPrintPdf || isAttachingPrintPdf || isDownloadingPrintPdf) return;
    setIsDownloadingPrintPdf(true);
    try {
      const persistedArtifact = await resolveStoredRenderedPrintPdfForDownload(
        renderedPrintPdf,
        () => loadRenderedPrintPdf(documentId),
      );
      const url = URL.createObjectURL(persistedArtifact.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = persistedArtifact.fileName;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      const persistedArtifact = await loadRenderedPrintPdf(documentId);
      setRenderedPrintPdf(persistedArtifact);
      showStatus(
        error instanceof Error
          ? error.message
          : 'The saved Print PDF could not be prepared for download.',
      );
    } finally {
      setIsDownloadingPrintPdf(false);
    }
  };

  const removeSavedPrintPdf = async () => {
    if (
      !renderedPrintPdf ||
      !window.confirm(
        'Remove the attached Print PDF? The source paper and Print Draft will stay intact.',
      )
    ) {
      return;
    }
    if (!(await removeRenderedPrintPdf(documentId))) {
      showStatus('The attached Print PDF could not be removed.');
      return;
    }
    setRenderedPrintPdf(null);
    setRenderedPrintPdfState('missing');
    showStatus('Attached Print PDF removed. The source paper is unchanged.', true);
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
  const sourceChanged =
    sourceFormatChanged || draft.sourceFingerprint !== sourceFingerprint;
  const sourceChangeKey = createSourceChangeNoticeKey(
    sourceFingerprint,
    PRINT_SOURCE_MODEL_VERSION,
  );
  const showSourceChangeBanner = shouldShowSourceChangeNotice(
    sourceChanged,
    sourceChangeKey,
    uiState.dismissedSourceChangeKey,
  );
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
            Reopen your print-only edits, or regenerate from the current print sources.
          </p>
          {sourceChanged ? (
            <p className="print-source-change-notice" role="status">
              Print-source formatting/order has changed since this draft was created.
            </p>
          ) : null}
          <div>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="button" onClick={() => setDecision('ready')}>
              Keep draft
            </button>
            <button
              type="button"
              onClick={() => regenerate(normalizeLegacyPrintLayout(initialLayout))}
            >
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
      <section className={`print-composer ${getPrintTemplateClassName(draft)}`}>
        <header className="print-composer-header">
          <div className="print-composer-heading">
            <h2 id="print-composer-title">Print Composer</h2>
            <p>{documentTitle}</p>
          </div>
          <div className="print-composer-presets">
            <span>Template</span>
            <div className="print-composer-layouts" aria-label="Print template">
              {BUILT_IN_PRINT_TEMPLATES.map((template) => (
                <button
                  aria-pressed={draft.baseTemplateId === template.id}
                  key={template.id}
                  type="button"
                  onClick={() => selectTemplate(template.id)}
                >
                  {template.label}
                </button>
              ))}
              <button
                aria-pressed={draft.contentMode === 'all-annotations'}
                type="button"
                onClick={() =>
                  selectContentMode(
                    draft.contentMode === 'all-annotations'
                      ? 'notes-and-glossary'
                      : 'all-annotations',
                  )
                }
              >
                All Annotations
              </button>
            </div>
          </div>
          <div className="print-composer-actions">
            <span
              className={`print-pdf-state is-${renderedPrintPdfState}`}
              role="status"
            >
              Print PDF: {printPdfStateLabel(renderedPrintPdfState)}
            </span>
            <input
              ref={printPdfInputRef}
              hidden
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void attachSavedPrintPdf(file);
              }}
            />
            <button
              type="button"
              disabled={isAttachingPrintPdf}
              onClick={() => printPdfInputRef.current?.click()}
            >
              {isAttachingPrintPdf
                ? 'Attaching…'
                : renderedPrintPdf
                  ? 'Replace saved Print PDF'
                  : 'Attach saved Print PDF'}
            </button>
            {renderedPrintPdf ? (
              <button
                type="button"
                disabled={isAttachingPrintPdf || isDownloadingPrintPdf}
                onClick={() => void downloadSavedPrintPdf()}
              >
                {isDownloadingPrintPdf
                  ? 'Preparing download…'
                  : renderedPrintPdfState === 'stale'
                    ? 'Download stale Print PDF'
                    : 'Download Print PDF'}
              </button>
            ) : null}
            <button
              className="print-composer-print"
              type="button"
              disabled={isPrinting}
              onClick={print}
            >
              {isPrinting ? 'Printing…' : 'Print / Save as PDF'}
            </button>
            <button className="print-composer-close" type="button" onClick={onClose}>
              Close
            </button>
            <details className="print-composer-more-actions">
              <summary>More</summary>
              <div>
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
                    if (
                      !window.confirm('Clear the saved print draft from this device?')
                    )
                      return;
                    void clearPrintDraft(documentId).then(onClose);
                  }}
                >
                  Clear draft
                </button>
                {renderedPrintPdf ? (
                  <button
                    className="print-composer-remove-pdf"
                    type="button"
                    onClick={() => void removeSavedPrintPdf()}
                  >
                    Remove Print PDF
                  </button>
                ) : null}
              </div>
            </details>
          </div>
        </header>
        {showSourceChangeBanner ? (
          <div
            className="print-source-change-banner"
            id="print-source-change-banner"
            role="status"
          >
            <span>
              Print-source formatting/order has changed since this draft was created.
            </span>
            <button type="button" onClick={() => regenerate()}>
              Regenerate from sources
            </button>
            <button
              aria-label="Dismiss source-change notice"
              className="print-source-change-dismiss"
              title="Dismiss"
              type="button"
              onClick={() =>
                dispatchUiState({
                  type: 'dismiss-source-change',
                  key: sourceChangeKey,
                })
              }
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ) : null}
        {statusMessage ? (
          <div className="print-composer-notification-region">
            <div className="print-composer-status">
              <p aria-live="polite" role="status">
                {statusMessage}
              </p>
              <button
                aria-label="Dismiss action notification"
                className="print-composer-status-dismiss"
                title="Dismiss"
                type="button"
                onClick={() => showStatus('')}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </div>
        ) : null}
        <PrintComposerEditor
          key={editorKey}
          documentTitle={documentTitle}
          notes={notes}
          annotations={annotations}
          noteAnchors={noteAnchors}
          glossaryEntries={glossaryEntries}
          layout={getPrintContentLayout(draft)}
          initialEditorStateJson={draft.editorStateJson}
          pendingAdditions={draft.pendingAdditions}
          blocksDrawerOpen={uiState.blocksDrawerOpen}
          formattingDrawerOpen={uiState.formattingDrawerOpen}
          onToggleBlocksDrawer={() => dispatchUiState({ type: 'toggle-blocks-drawer' })}
          onToggleFormattingDrawer={() =>
            dispatchUiState({ type: 'toggle-formatting-drawer' })
          }
          onCloseBlocksDrawer={() => dispatchUiState({ type: 'close-blocks-drawer' })}
          onCloseFormattingDrawer={() =>
            dispatchUiState({ type: 'close-formatting-drawer' })
          }
          onCloseDrawers={() => dispatchUiState({ type: 'close-drawers' })}
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

function printPdfStateLabel(state: RenderedPrintPdfState): string {
  if (state === 'current') return 'Current';
  if (state === 'stale') return 'Stale';
  return 'Missing';
}

function createFreshDraft(
  documentId: string,
  sourceFingerprint: string,
  presentation: PrintPresentation,
): PrintDraftRecord {
  const timestamp = Date.now();
  return {
    draftSchemaVersion: PRINT_DRAFT_SCHEMA_VERSION,
    documentId,
    sourceFingerprint,
    sourceModelVersion: PRINT_SOURCE_MODEL_VERSION,
    editorStateJson: '',
    contentMode: presentation.contentMode,
    baseTemplateId: presentation.baseTemplateId,
    templateVersion: presentation.templateVersion,
    overrides: presentation.overrides,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSavedAt: timestamp,
    pendingAdditions: [],
  };
}
