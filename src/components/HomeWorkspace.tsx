import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type ReactNode,
} from 'react';
import {
  deleteCollection,
  listCollections,
  listLibraryDocuments,
  saveCollectionDraft,
  type LibraryDocument,
} from '../services/annotationPersistence.ts';
import {
  downloadLibraryBackup,
  getBackupCreationErrorMessage,
} from '../services/libraryBackup.ts';
import { isTemporaryWorkspaceActive } from '../services/temporaryWorkspace.ts';
import { readingThemes, themes } from '../themes.ts';
import { useTheme } from '../theme/ThemeContext.ts';
import type { CollectionRecord } from '../types/library.ts';
import { PANEL_MOTION_MS } from '../uiMotion.ts';
import {
  markGettingStartedCompleted,
  markGettingStartedDismissed,
  readGettingStartedPreference,
  shouldAutoOpenGettingStarted,
} from '../utils/gettingStarted.ts';
import type { ReaderStatusIndicatorDisplay } from '../utils/readerPreferences.ts';
import {
  CollectionDraftPaperList,
  CollectionView,
} from './CollectionWorkspaceViews.tsx';
import { FeedbackNotice } from './FeedbackNotice.tsx';
import {
  beginCollectionCreate,
  beginCollectionEdit,
  cancelCollectionEditing,
  completeCollectionEditing,
  createInitialCollectionEditorState,
  filterCollectionAvailablePapers,
  openCollectionEditorView,
  updateCollectionDraftMembership,
} from './collectionEditorModel.ts';

const GettingStartedWalkthrough = lazy(() =>
  import('./GettingStartedWalkthrough.tsx').then((module) => ({
    default: module.GettingStartedWalkthrough,
  })),
);

export type HomeSection =
  'home' | 'library' | 'collections' | 'theme' | 'ai' | 'drive' | 'settings';

const NAVIGATION: readonly { id: HomeSection; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'library', label: 'Library' },
  { id: 'collections', label: 'Collections' },
  { id: 'theme', label: 'Theme' },
  { id: 'ai', label: 'AI' },
  { id: 'drive', label: 'Google Drive' },
  { id: 'settings', label: 'Settings' },
];

function legalDocumentUrl(fileName: 'privacy.html' | 'terms.html'): string {
  return `${import.meta.env.BASE_URL}${fileName}`;
}

function LegalDocumentLinks({ label }: { label: string }) {
  return (
    <nav aria-label={label} className="home-legal-links">
      <a href={legalDocumentUrl('privacy.html')} rel="noreferrer" target="_blank">
        Privacy Policy
      </a>
      <span aria-hidden="true">·</span>
      <a href={legalDocumentUrl('terms.html')} rel="noreferrer" target="_blank">
        Terms of Service
      </a>
    </nav>
  );
}

export function HomeFloatingButton({ onClick }: { onClick(): void }) {
  return (
    <button
      aria-label="Home"
      className="home-floating-button"
      title="Home"
      type="button"
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3.5 10.8 12 3.7l8.5 7.1M5.8 9.2v10.1h12.4V9.2M9.4 19.3v-6.1h5.2v6.1" />
      </svg>
    </button>
  );
}

export function HomeWorkspace({
  isOpen,
  activeSection,
  onSectionChange,
  onReturnToReader,
  children,
}: {
  isOpen: boolean;
  activeSection: HomeSection;
  onSectionChange(section: HomeSection): void;
  onReturnToReader(): void;
  children: ReactNode;
}) {
  const [retainedForExit, setRetainedForExit] = useState(isOpen);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      if (!wasOpenRef.current) {
        returnFocusRef.current =
          window.document.activeElement instanceof HTMLElement
            ? window.document.activeElement
            : null;
      }
      wasOpenRef.current = true;
      const focusFrame = window.requestAnimationFrame(() => {
        backButtonRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(focusFrame);
    }
    if (!wasOpenRef.current) return undefined;
    wasOpenRef.current = false;
    const returnFocus = returnFocusRef.current;
    returnFocusRef.current = null;
    const focusFrame = window.requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setRetainedForExit(true);
      return undefined;
    }
    if (!retainedForExit) return undefined;
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setRetainedForExit(false);
      return undefined;
    }

    const timer = window.setTimeout(() => setRetainedForExit(false), PANEL_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, retainedForExit]);

  if (!isOpen && !retainedForExit) return null;

  const motionState = isOpen ? 'open' : 'closing';
  const finishExit = (event: ReactAnimationEvent<HTMLElement>) => {
    if (
      !isOpen &&
      event.currentTarget === event.target &&
      event.animationName === 'home-workspace-exit'
    ) {
      setRetainedForExit(false);
    }
  };

  return (
    <section
      aria-hidden={isOpen ? undefined : true}
      aria-label="39Note Home"
      className={`home-workspace is-${motionState}`}
      data-motion-state={motionState}
      inert={isOpen ? undefined : true}
      onAnimationEnd={finishExit}
    >
      <header className="home-workspace-header">
        <strong>39Note</strong>
        <button
          ref={backButtonRef}
          aria-label="Back to reader"
          className="home-back-button"
          title="Back to reader"
          type="button"
          onClick={onReturnToReader}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m14.5 5-7 7 7 7M8 12h9" />
          </svg>
        </button>
      </header>
      <div className="home-workspace-body">
        <nav aria-label="Home sections" className="home-navigation">
          {NAVIGATION.map((item) => (
            <button
              aria-current={activeSection === item.id ? 'page' : undefined}
              className={activeSection === item.id ? 'is-current' : ''}
              key={item.id}
              type="button"
              onClick={() => onSectionChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div
          className="home-content"
          data-home-section={activeSection}
          key={activeSection}
        >
          {children}
        </div>
      </div>
    </section>
  );
}

export function HomeLandingPage({
  gettingStartedRequestId = 0,
  onGettingStartedRequestHandled,
  onOpenLibrary,
  onOpenCollections,
  onOpenDrive,
  onOpenOfficeConverter,
}: {
  gettingStartedRequestId?: number;
  onGettingStartedRequestHandled?(): void;
  onOpenLibrary(): void;
  onOpenCollections(): void;
  onOpenDrive(): void;
  onOpenOfficeConverter(): void;
}) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [collectionCount, setCollectionCount] = useState(0);
  const [summaryState, setSummaryState] = useState<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  const [summaryReloadToken, setSummaryReloadToken] = useState(0);
  const [isGettingStartedOpen, setIsGettingStartedOpen] = useState(false);
  const [focusGettingStarted, setFocusGettingStarted] = useState(false);
  const handledGettingStartedRequestRef = useRef(0);
  const homeLandingRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let disposed = false;
    setSummaryState('loading');
    void Promise.all([listLibraryDocuments(), listCollections()])
      .then(([nextDocuments, collections]) => {
        if (disposed) return;
        setDocuments(nextDocuments);
        setCollectionCount(collections.length);
        setSummaryState('ready');
      })
      .catch(() => {
        if (!disposed) setSummaryState('failed');
      });
    return () => {
      disposed = true;
    };
  }, [summaryReloadToken]);

  useEffect(() => {
    if (
      shouldAutoOpenGettingStarted({
        documentCount: documents.length,
        libraryState: summaryState,
        preference: readGettingStartedPreference(),
      })
    ) {
      setFocusGettingStarted(false);
      setIsGettingStartedOpen(true);
    }
  }, [documents.length, summaryState]);

  useEffect(() => {
    if (
      gettingStartedRequestId <= 0 ||
      handledGettingStartedRequestRef.current === gettingStartedRequestId
    ) {
      return;
    }
    handledGettingStartedRequestRef.current = gettingStartedRequestId;
    setFocusGettingStarted(true);
    setIsGettingStartedOpen(true);
    onGettingStartedRequestHandled?.();
  }, [gettingStartedRequestId, onGettingStartedRequestHandled]);

  const returnFocusToHome = useCallback(() => {
    window.requestAnimationFrame(() => {
      homeLandingRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const closeGettingStarted = useCallback(() => {
    setIsGettingStartedOpen(false);
    setFocusGettingStarted(false);
    returnFocusToHome();
  }, [returnFocusToHome]);

  const dismissGettingStarted = useCallback(() => {
    markGettingStartedDismissed();
    closeGettingStarted();
  }, [closeGettingStarted]);

  const finishGettingStarted = useCallback(() => {
    markGettingStartedCompleted();
  }, []);

  const openLibraryFromGettingStarted = useCallback(() => {
    markGettingStartedCompleted();
    setIsGettingStartedOpen(false);
    setFocusGettingStarted(false);
    onOpenLibrary();
  }, [onOpenLibrary]);

  const recent = [...documents]
    .sort((first, second) => (second.lastReadAt ?? 0) - (first.lastReadAt ?? 0))
    .slice(0, 3);
  return (
    <section
      ref={homeLandingRef}
      aria-labelledby="home-landing-title"
      className="home-landing"
      tabIndex={-1}
    >
      <header className="home-page-header">
        <div>
          <p>Workspace</p>
          <h2 id="home-landing-title">Home</h2>
        </div>
        <p>
          Manage papers and application settings without leaving your reading state.
        </p>
      </header>
      {summaryState === 'failed' ? (
        <FeedbackNotice
          actions={
            <button
              type="button"
              onClick={() => setSummaryReloadToken((current) => current + 1)}
            >
              Retry
            </button>
          }
          description="39Note could not read the local Library summary. No Library data was changed."
          persistent
          title="Home summary unavailable"
          tone="error"
        />
      ) : null}
      {isGettingStartedOpen ? (
        <>
          <span className="visually-hidden" role="status">
            Getting Started guide opened.
          </span>
          <Suspense
            fallback={
              <div className="getting-started-loading" role="status">
                Opening Getting Started…
              </div>
            }
          >
            <GettingStartedWalkthrough
              focusOnOpen={focusGettingStarted}
              onClose={closeGettingStarted}
              onDismiss={dismissGettingStarted}
              onFinish={finishGettingStarted}
              onOpenLibrary={openLibraryFromGettingStarted}
            />
          </Suspense>
        </>
      ) : null}
      <div className="home-summary-grid">
        <button type="button" onClick={onOpenLibrary}>
          <strong>{documents.length}</strong>
          <span>Local papers</span>
        </button>
        <button type="button" onClick={onOpenCollections}>
          <strong>{collectionCount}</strong>
          <span>Collections</span>
        </button>
        <button type="button" onClick={onOpenDrive}>
          <strong>{isTemporaryWorkspaceActive() ? 'Temporary' : 'Personal'}</strong>
          <span>Device workspace</span>
        </button>
      </div>
      <section className="home-recent" aria-label="Recently opened papers">
        <h3>Recently opened</h3>
        {recent.length ? (
          <ul>
            {recent.map((paper) => (
              <li key={paper.documentId}>{paper.displayTitle}</li>
            ))}
          </ul>
        ) : (
          <p>Your recently opened papers will appear here.</p>
        )}
      </section>
      <aside className="home-office-converter">
        <div>
          <strong>Have a Word or PowerPoint file?</strong>
          <span>Convert it to a normal 39Note PDF locally.</span>
        </div>
        <button type="button" onClick={onOpenOfficeConverter}>
          Convert Word / PowerPoint to PDF
        </button>
      </aside>
      <footer className="home-legal-footer">
        <span>39Note 1.0.0 · Local-first study workspace</span>
        <LegalDocumentLinks label="39Note legal documents" />
      </footer>
    </section>
  );
}

export function ThemeHomePage() {
  const { themeId, setTheme } = useTheme();
  return (
    <section className="home-theme-page" aria-labelledby="home-theme-title">
      <header className="home-page-header">
        <div>
          <p>Appearance</p>
          <h2 id="home-theme-title">Theme</h2>
        </div>
        <p>Choose a reading palette. Changes apply immediately.</p>
      </header>
      <div className="theme-preview-grid">
        {readingThemes.map((id) => {
          const theme = themes[id];
          return (
            <button
              aria-pressed={themeId === id}
              className="theme-preview-card"
              key={id}
              style={{
                background: theme.appBackground,
                borderColor: theme.borderColor,
                color: theme.textColor,
              }}
              type="button"
              onClick={() => setTheme(id)}
            >
              <span
                className="theme-preview-surface"
                style={{ background: theme.shellBackground ?? theme.surfaceBackground }}
              >
                <span style={{ background: theme.accentColor }} />
                <span style={{ background: theme.highlightColor }} />
                <span style={{ background: theme.noteColor }} />
              </span>
              <strong>{theme.label}</strong>
              <small>{themeId === id ? 'Selected' : 'Preview theme'}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function CollectionsHomePage({
  initialCollectionId = null,
  onOpenDocument,
  onOpenLibrary,
}: {
  initialCollectionId?: string | null;
  onOpenDocument(documentId: string, collectionId: string): Promise<boolean>;
  onOpenLibrary(): void;
}) {
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [editor, setEditor] = useState(() => ({
    ...createInitialCollectionEditorState(),
    selectedCollectionId: initialCollectionId,
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [collectionError, setCollectionError] = useState('');
  const [collectionRecovery, setCollectionRecovery] = useState<'retry-load' | null>(
    null,
  );
  const collectionOperationRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const { draft, mode, paperSearch, selectedCollectionId } = editor;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    const [nextCollections, nextDocuments] = await Promise.all([
      listCollections(),
      listLibraryDocuments(),
    ]);
    if (sequence !== refreshSequenceRef.current) return;
    setCollections(nextCollections);
    setDocuments(nextDocuments);
    setCollectionRecovery(null);
    setEditor((current) => {
      if (
        !current.selectedCollectionId ||
        nextCollections.some(
          (collection) => collection.id === current.selectedCollectionId,
        )
      ) {
        return current;
      }
      return {
        ...current,
        selectedCollectionId: null,
        ...(current.mode === 'view' ? { draft: null, paperSearch: '' } : {}),
      };
    });
    return { collections: nextCollections, documents: nextDocuments };
  }, []);

  useEffect(() => {
    void refresh().catch(() => {
      setCollectionError('Collections could not be loaded. Please try again.');
      setCollectionRecovery('retry-load');
    });
  }, [refresh]);

  const selectedCollection =
    collections.find((collection) => collection.id === selectedCollectionId) ?? null;
  const selectedDocuments = useMemo(
    () =>
      documents.filter(
        (paper) =>
          selectedCollectionId && paper.collectionIds.includes(selectedCollectionId),
      ),
    [documents, selectedCollectionId],
  );
  const draftSelectedIds = new Set(draft?.selectedDocumentIds ?? []);
  const draftSelectedDocuments = documents.filter((paper) =>
    draftSelectedIds.has(paper.documentId),
  );
  const availableDocuments = filterCollectionAvailablePapers(
    documents.filter((paper) => !draftSelectedIds.has(paper.documentId)),
    paperSearch,
  );
  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of documents) {
      for (const collectionId of paper.collectionIds) {
        counts.set(collectionId, (counts.get(collectionId) ?? 0) + 1);
      }
    }
    return counts;
  }, [documents]);

  const openCollection = (collection: CollectionRecord) => {
    if (isSaving) return;
    setEditor((current) => openCollectionEditorView(current, collection.id));
    setCollectionError('');
    setCollectionRecovery(null);
  };

  const beginCreate = () => {
    if (isSaving) return;
    setEditor(beginCollectionCreate);
    setCollectionError('');
    setCollectionRecovery(null);
  };

  const beginEdit = () => {
    if (!selectedCollection || isSaving) return;
    setEditor((current) =>
      beginCollectionEdit(
        current,
        selectedCollection,
        selectedDocuments.map((paper) => paper.documentId),
      ),
    );
    setCollectionError('');
    setCollectionRecovery(null);
  };

  const cancelEditing = () => {
    if (isSaving) return;
    setEditor(cancelCollectionEditing);
    setCollectionError('');
    setCollectionRecovery(null);
  };

  const commitDraft = async () => {
    if (!draft || isSaving || collectionOperationRef.current) return;
    collectionOperationRef.current = true;
    setIsSaving(true);
    setCollectionError('');
    setCollectionRecovery(null);
    try {
      const saved = await saveCollectionDraft({
        ...(draft.collectionId ? { collectionId: draft.collectionId } : {}),
        name: draft.name,
        documentIds: draft.selectedDocumentIds,
      });
      if (!saved) {
        setCollectionError('Collection names must be unique and non-empty.');
        return;
      }
      setEditor((current) => completeCollectionEditing(current, saved.id));
      try {
        await refresh();
      } catch {
        setCollectionError(
          'The Collection was saved, but the Collection list could not be refreshed.',
        );
        setCollectionRecovery('retry-load');
      }
    } catch {
      setCollectionError('The Collection could not be saved. Please try again.');
    } finally {
      collectionOperationRef.current = false;
      setIsSaving(false);
    }
  };

  const deleteSelectedCollection = async () => {
    if (!selectedCollection || isSaving || collectionOperationRef.current) return;
    collectionOperationRef.current = true;
    setIsSaving(true);
    setCollectionError('');
    setCollectionRecovery(null);
    try {
      const deleted = await deleteCollection(selectedCollection.id);
      if (!deleted) {
        setCollectionError('The Collection could not be deleted. Please try again.');
        return;
      }
      setEditor((current) =>
        cancelCollectionEditing({ ...current, selectedCollectionId: null }),
      );
      try {
        await refresh();
      } catch {
        setCollectionError(
          'The Collection was deleted, but the Collection list could not be refreshed.',
        );
        setCollectionRecovery('retry-load');
      }
    } catch {
      setCollectionError('The Collection could not be deleted. Please try again.');
    } finally {
      collectionOperationRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <section className="home-collections-page" aria-labelledby="home-collections-title">
      <header className="home-page-header">
        <div>
          <p>Organization</p>
          <h2 id="home-collections-title">Collections</h2>
        </div>
        <p>Arrange papers into structural shelves without changing their contents.</p>
      </header>
      <div className="collections-toolbar">
        <button
          disabled={mode === 'create' || isSaving}
          type="button"
          onClick={beginCreate}
        >
          + Create Collection
        </button>
      </div>
      <div className="collections-workspace">
        <nav aria-label="Collections" className="collections-list">
          {collections.map((collection) => {
            const count = collectionCounts.get(collection.id) ?? 0;
            return (
              <button
                aria-current={
                  selectedCollectionId === collection.id ? 'page' : undefined
                }
                disabled={isSaving}
                key={collection.id}
                type="button"
                onClick={() => openCollection(collection)}
              >
                <span>{collection.name}</span>
                <small>
                  {count} {count === 1 ? 'paper' : 'papers'}
                </small>
              </button>
            );
          })}
          {!collections.length ? <p>No Collections yet.</p> : null}
        </nav>
        <div className="collection-detail">
          {mode === 'view' && selectedCollection ? (
            <CollectionView
              collection={selectedCollection}
              documents={selectedDocuments}
              onEdit={beginEdit}
              onOpenDocument={(documentId) =>
                onOpenDocument(documentId, selectedCollection.id)
              }
              onOpenLibrary={onOpenLibrary}
            />
          ) : null}
          {mode === 'view' && !selectedCollection ? (
            <div className="collections-empty-state">
              <p>
                {collections.length
                  ? 'Select a Collection to view its papers.'
                  : 'No Collections yet.'}
              </p>
              {!collections.length ? (
                <button type="button" onClick={beginCreate}>
                  + Create Collection
                </button>
              ) : null}
            </div>
          ) : null}
          {(mode === 'create' || mode === 'edit') && draft ? (
            <form
              className="collection-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void commitDraft();
              }}
            >
              <header className="collection-editor-header">
                <div className="collection-editor-heading-row">
                  <h3>{mode === 'create' ? 'Create Collection' : 'Edit Collection'}</h3>
                  <div className="collection-editor-header-actions">
                    <button disabled={isSaving} type="button" onClick={cancelEditing}>
                      Cancel
                    </button>
                    <button
                      className="collection-editor-done"
                      disabled={isSaving}
                      type="submit"
                    >
                      {isSaving ? 'Saving…' : 'Done'}
                    </button>
                  </div>
                </div>
                <p>Changes are saved together when you choose Done.</p>
              </header>
              <label>
                Collection name
                <input
                  autoFocus
                  disabled={isSaving}
                  maxLength={80}
                  value={draft.name}
                  onChange={(event) =>
                    setEditor((current) =>
                      current.draft
                        ? {
                            ...current,
                            draft: { ...current.draft, name: event.target.value },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label>
                Search papers
                <input
                  aria-label="Search available papers"
                  disabled={isSaving}
                  placeholder="Search by paper name"
                  type="search"
                  value={paperSearch}
                  onChange={(event) =>
                    setEditor((current) => ({
                      ...current,
                      paperSearch: event.target.value,
                    }))
                  }
                />
              </label>
              <section aria-labelledby="collection-selected-papers">
                <h4 id="collection-selected-papers">Selected</h4>
                <CollectionDraftPaperList
                  action="Remove"
                  disabled={isSaving}
                  documents={draftSelectedDocuments}
                  emptyMessage="No papers selected."
                  onAction={(documentId) =>
                    setEditor((current) =>
                      current.draft
                        ? {
                            ...current,
                            draft: updateCollectionDraftMembership(
                              current.draft,
                              documentId,
                              false,
                            ),
                          }
                        : current,
                    )
                  }
                />
              </section>
              <section aria-labelledby="collection-available-papers">
                <h4 id="collection-available-papers">Available</h4>
                <CollectionDraftPaperList
                  action="Add"
                  disabled={isSaving}
                  documents={availableDocuments}
                  emptyMessage={
                    paperSearch.trim()
                      ? 'No available papers match your search.'
                      : 'No more papers are available.'
                  }
                  onAction={(documentId) =>
                    setEditor((current) =>
                      current.draft
                        ? {
                            ...current,
                            draft: updateCollectionDraftMembership(
                              current.draft,
                              documentId,
                              true,
                            ),
                          }
                        : current,
                    )
                  }
                />
              </section>
              {mode === 'edit' && selectedCollection ? (
                <div className="collection-editor-danger">
                  <button
                    className="is-destructive"
                    disabled={isSaving}
                    type="button"
                    onClick={() => void deleteSelectedCollection()}
                  >
                    Delete Collection
                  </button>
                </div>
              ) : null}
            </form>
          ) : null}
        </div>
      </div>
      {collectionError ? (
        <FeedbackNotice
          actions={
            collectionRecovery === 'retry-load' ? (
              <button
                type="button"
                onClick={() => {
                  setCollectionError('');
                  setCollectionRecovery(null);
                  void refresh().catch(() => {
                    setCollectionError(
                      'Collections could not be loaded. Please try again.',
                    );
                    setCollectionRecovery('retry-load');
                  });
                }}
              >
                Retry
              </button>
            ) : (
              <button type="button" onClick={() => setCollectionError('')}>
                Dismiss
              </button>
            )
          }
          description={collectionError}
          persistent
          title="Collection action not completed"
          tone="error"
        />
      ) : null}
    </section>
  );
}

export function SettingsHomePage({
  readerStatusIndicatorDisplay,
  onReaderStatusIndicatorDisplayChange,
  onOpenGettingStarted,
}: {
  readerStatusIndicatorDisplay: ReaderStatusIndicatorDisplay;
  onReaderStatusIndicatorDisplayChange(display: ReaderStatusIndicatorDisplay): void;
  onOpenGettingStarted(): void;
}) {
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);

  const createBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    setBackupError(null);
    try {
      await downloadLibraryBackup(() => undefined);
    } catch (error) {
      setBackupError(getBackupCreationErrorMessage(error));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <section className="home-settings-page" aria-labelledby="home-settings-title">
      <header className="home-page-header">
        <div>
          <p>Application</p>
          <h2 id="home-settings-title">Settings</h2>
        </div>
        <p>Local safety and application preferences.</p>
      </header>
      <article className="home-settings-card">
        <h3>Local backup</h3>
        <p>Create a complete 39Note package directly on this device.</p>
        <button disabled={backupBusy} type="button" onClick={() => void createBackup()}>
          {backupBusy ? 'Preparing backup…' : 'Download local backup'}
        </button>
        {backupError ? (
          <FeedbackNotice
            actions={
              <>
                <button type="button" onClick={() => void createBackup()}>
                  Retry
                </button>
                <button type="button" onClick={() => setBackupError(null)}>
                  Dismiss
                </button>
              </>
            }
            description={`${backupError} Your Library was not replaced or removed.`}
            persistent
            title="Backup not created"
            tone="error"
          />
        ) : null}
      </article>
      <article className="home-settings-card">
        <h3>Status indicator display</h3>
        <p>Choose how Google Drive connection status appears in the Reader.</p>
        <fieldset className="settings-choice-group">
          <legend className="visually-hidden">Status indicator display</legend>
          {(['full', 'compact', 'hidden'] as const).map((display) => (
            <label key={display}>
              <input
                checked={readerStatusIndicatorDisplay === display}
                name="reader-status-indicator-display"
                type="radio"
                value={display}
                onChange={() => onReaderStatusIndicatorDisplayChange(display)}
              />
              <span>{display[0].toUpperCase() + display.slice(1)}</span>
            </label>
          ))}
        </fieldset>
        <p className="settings-preference-note">
          Hidden changes presentation only. Drive connection, pending work, and
          integrity warnings continue normally.
        </p>
      </article>
      <article className="home-settings-card">
        <h3>Getting Started</h3>
        <p>
          Reopen the visual tour of reading, annotation, organization, backup, and
          optional Drive sync.
        </p>
        <button type="button" onClick={onOpenGettingStarted}>
          Open Getting Started tour
        </button>
      </article>
      <article className="home-settings-card">
        <h3>About 39Note</h3>
        <p>Version 1.0.0. Copyright © 2026 Ex39393. All rights reserved.</p>
        <LegalDocumentLinks label="39Note policies" />
      </article>
    </section>
  );
}
