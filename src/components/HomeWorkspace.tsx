import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type ReactNode,
} from 'react';
import {
  createTag,
  deleteCollection,
  deleteTag,
  listCollections,
  listLibraryDocuments,
  listTags,
  renameTag,
  saveCollectionDraft,
  updateDocumentOrganization,
  type LibraryDocument,
} from '../services/annotationPersistence.ts';
import { downloadLibraryBackup } from '../services/libraryBackup.ts';
import { isTemporaryWorkspaceActive } from '../services/temporaryWorkspace.ts';
import { readingThemes, themes } from '../themes.ts';
import { useTheme } from '../theme/ThemeContext.ts';
import type { CollectionRecord, TagRecord } from '../types/library.ts';
import { PANEL_MOTION_MS } from '../uiMotion.ts';
import {
  CollectionDraftPaperList,
  CollectionView,
} from './CollectionWorkspaceViews.tsx';
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

export type HomeSection =
  'home' | 'library' | 'collections' | 'tags' | 'theme' | 'ai' | 'drive' | 'settings';

const NAVIGATION: readonly { id: HomeSection; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'library', label: 'Library' },
  { id: 'collections', label: 'Collections' },
  { id: 'tags', label: 'Tags' },
  { id: 'theme', label: 'Theme' },
  { id: 'ai', label: 'AI' },
  { id: 'drive', label: 'Google Drive' },
  { id: 'settings', label: 'Settings' },
];

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
  onOpenLibrary,
  onOpenCollections,
  onOpenDrive,
  onOpenOfficeConverter,
}: {
  onOpenLibrary(): void;
  onOpenCollections(): void;
  onOpenDrive(): void;
  onOpenOfficeConverter(): void;
}) {
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [collectionCount, setCollectionCount] = useState(0);
  useEffect(() => {
    let disposed = false;
    void Promise.all([listLibraryDocuments(), listCollections()]).then(
      ([nextDocuments, collections]) => {
        if (disposed) return;
        setDocuments(nextDocuments);
        setCollectionCount(collections.length);
      },
    );
    return () => {
      disposed = true;
    };
  }, []);
  const recent = [...documents]
    .sort((first, second) => (second.lastReadAt ?? 0) - (first.lastReadAt ?? 0))
    .slice(0, 3);
  return (
    <section className="home-landing" aria-labelledby="home-landing-title">
      <header className="home-page-header">
        <div>
          <p>Workspace</p>
          <h2 id="home-landing-title">Home</h2>
        </div>
        <p>
          Manage papers and application settings without leaving your reading state.
        </p>
      </header>
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
                style={{ background: theme.surfaceBackground }}
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

export function CollectionsHomePage() {
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [editor, setEditor] = useState(createInitialCollectionEditorState);
  const [isSaving, setIsSaving] = useState(false);
  const [collectionError, setCollectionError] = useState('');
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
  };

  const beginCreate = () => {
    if (isSaving) return;
    setEditor(beginCollectionCreate);
    setCollectionError('');
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
  };

  const cancelEditing = () => {
    if (isSaving) return;
    setEditor(cancelCollectionEditing);
    setCollectionError('');
  };

  const commitDraft = async () => {
    if (!draft || isSaving || collectionOperationRef.current) return;
    collectionOperationRef.current = true;
    setIsSaving(true);
    setCollectionError('');
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
      await refresh();
      setEditor((current) => completeCollectionEditing(current, saved.id));
    } catch {
      setCollectionError(
        'The Collection could not be refreshed after saving. Please reopen Collections.',
      );
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
    try {
      const deleted = await deleteCollection(selectedCollection.id);
      if (!deleted) {
        setCollectionError('The Collection could not be deleted. Please try again.');
        return;
      }
      await refresh();
      setEditor((current) =>
        cancelCollectionEditing({ ...current, selectedCollectionId: null }),
      );
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
        <p>Arrange papers into structural shelves without changing their tags.</p>
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
              <header>
                <h3>{mode === 'create' ? 'Create Collection' : 'Edit Collection'}</h3>
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
              {collectionError ? <p role="alert">{collectionError}</p> : null}
              <div className="collection-editor-actions">
                {mode === 'edit' && selectedCollection ? (
                  <button
                    className="is-destructive"
                    disabled={isSaving}
                    type="button"
                    onClick={() => void deleteSelectedCollection()}
                  >
                    Delete Collection
                  </button>
                ) : null}
                <span />
                <button disabled={isSaving} type="button" onClick={cancelEditing}>
                  Cancel
                </button>
                <button disabled={isSaving} type="submit">
                  {isSaving ? 'Saving…' : 'Done'}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function TagsHomePage() {
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [tagError, setTagError] = useState('');
  const refresh = useCallback(async () => {
    const [nextTags, nextDocuments] = await Promise.all([
      listTags(),
      listLibraryDocuments(),
    ]);
    setTags(nextTags);
    setDocuments(nextDocuments);
    setSelectedTagId((current) =>
      current && nextTags.some((tag) => tag.id === current)
        ? current
        : (nextTags[0]?.id ?? null),
    );
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const selectedTag = tags.find((tag) => tag.id === selectedTagId) ?? null;
  const selectedDocuments = useMemo(
    () =>
      documents.filter(
        (paper) => selectedTagId && paper.tagIds.includes(selectedTagId),
      ),
    [documents, selectedTagId],
  );
  return (
    <section className="home-tags-page" aria-labelledby="home-tags-title">
      <header className="home-page-header">
        <div>
          <p>Organization</p>
          <h2 id="home-tags-title">Tags</h2>
        </div>
        <p>Inspect tags and the papers attached to them.</p>
      </header>
      <form
        className="tag-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          setTagError('');
          void createTag(newTagName).then(async (record) => {
            if (!record) {
              setTagError('Tag names must be unique and non-empty.');
              return;
            }
            setNewTagName('');
            await refresh();
            setSelectedTagId(record.id);
            setRenameDraft(record.name);
          });
        }}
      >
        <label>
          New tag
          <input
            placeholder="Tag name"
            value={newTagName}
            onChange={(event) => setNewTagName(event.target.value)}
          />
        </label>
        <button type="submit">Add tag</button>
        {tagError ? <span role="alert">{tagError}</span> : null}
      </form>
      <div className="tags-workspace">
        <nav aria-label="Tags" className="tags-list">
          {tags.map((tag) => {
            const count = documents.filter((paper) =>
              paper.tagIds.includes(tag.id),
            ).length;
            return (
              <button
                aria-current={selectedTagId === tag.id ? 'page' : undefined}
                key={tag.id}
                type="button"
                onClick={() => {
                  setSelectedTagId(tag.id);
                  setRenameDraft(tag.name);
                }}
              >
                <span>{tag.name}</span>
                <small>
                  {count} {count === 1 ? 'paper' : 'papers'}
                </small>
              </button>
            );
          })}
          {!tags.length ? <p>No tags yet.</p> : null}
        </nav>
        <div className="tag-detail">
          {selectedTag ? (
            <>
              <div className="tag-detail-heading">
                <label>
                  Tag name
                  <input
                    value={renameDraft || selectedTag.name}
                    onChange={(event) => setRenameDraft(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void renameTag(
                      selectedTag.id,
                      renameDraft || selectedTag.name,
                    ).then(refresh)
                  }
                >
                  Rename
                </button>
                <button
                  className="is-destructive"
                  type="button"
                  onClick={() => void deleteTag(selectedTag.id).then(refresh)}
                >
                  Delete tag
                </button>
              </div>
              <h3>Papers</h3>
              <ul>
                {documents.map((paper) => {
                  const tagged = paper.tagIds.includes(selectedTag.id);
                  return (
                    <li key={paper.documentId}>
                      <span>{paper.displayTitle}</span>
                      <button
                        type="button"
                        onClick={() =>
                          void updateDocumentOrganization([paper.documentId], {
                            tagIds: tagged
                              ? paper.tagIds.filter((id) => id !== selectedTag.id)
                              : [...paper.tagIds, selectedTag.id],
                          }).then(refresh)
                        }
                      >
                        {tagged ? 'Remove' : 'Add'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {!selectedDocuments.length ? <p>No papers use this tag yet.</p> : null}
            </>
          ) : (
            <p>Select a tag to inspect its papers.</p>
          )}
        </div>
      </div>
    </section>
  );
}

export function SettingsHomePage() {
  const [backupBusy, setBackupBusy] = useState(false);
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
        <button
          disabled={backupBusy}
          type="button"
          onClick={() => {
            setBackupBusy(true);
            void downloadLibraryBackup(() => undefined).finally(() =>
              setBackupBusy(false),
            );
          }}
        >
          {backupBusy ? 'Preparing backup…' : 'Download local backup'}
        </button>
      </article>
    </section>
  );
}
