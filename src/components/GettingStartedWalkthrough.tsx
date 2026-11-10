import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  TUTORIAL_CHAPTERS,
  getNextTutorialScreen,
  getPreviousTutorialScreen,
  getTutorialChapterNumber,
  getTutorialProgressState,
  isTutorialChapter,
  type TutorialChapterId,
  type TutorialScreenId,
} from '../utils/gettingStartedWalkthrough.ts';

export function GettingStartedWalkthrough({
  focusOnOpen = false,
  initialScreenId = 'cover',
  onClose,
  onDismiss,
  onFinish,
  onOpenLibrary,
}: {
  focusOnOpen?: boolean;
  initialScreenId?: TutorialScreenId;
  onClose(): void;
  onDismiss(): void;
  onFinish(): void;
  onOpenLibrary(): void;
}) {
  const [screenId, setScreenId] = useState<TutorialScreenId>(initialScreenId);
  const regionRef = useRef<HTMLElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusFrameRef = useRef<number | null>(null);
  const shouldFocusScreenRef = useRef(false);
  const chapter = isTutorialChapter(screenId)
    ? (TUTORIAL_CHAPTERS.find((candidate) => candidate.id === screenId) ?? null)
    : null;

  const revealInHomeContent = useCallback(() => {
    const region = regionRef.current;
    const scrollOwner = region?.closest<HTMLElement>('.home-content');
    if (!region || !scrollOwner) return;
    const ownerBounds = scrollOwner.getBoundingClientRect();
    const regionBounds = region.getBoundingClientRect();
    scrollOwner.scrollTo({
      behavior: 'auto',
      left: 0,
      top: scrollOwner.scrollTop + regionBounds.top - ownerBounds.top,
    });
  }, []);

  useEffect(() => {
    focusFrameRef.current = window.requestAnimationFrame(() => {
      revealInHomeContent();
      if (focusOnOpen) regionRef.current?.focus({ preventScroll: true });
      focusFrameRef.current = null;
    });
  }, [focusOnOpen, revealInHomeContent]);

  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!shouldFocusScreenRef.current) return;
    shouldFocusScreenRef.current = false;
    focusFrameRef.current = window.requestAnimationFrame(() => {
      revealInHomeContent();
      contentScrollRef.current?.scrollTo({ behavior: 'auto', left: 0, top: 0 });
      headingRef.current?.focus({ preventScroll: true });
      focusFrameRef.current = null;
    });
  }, [revealInHomeContent, screenId]);

  const navigate = (nextScreenId: TutorialScreenId) => {
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current);
    }
    shouldFocusScreenRef.current = true;
    if (nextScreenId === screenId) {
      shouldFocusScreenRef.current = false;
      focusFrameRef.current = window.requestAnimationFrame(() => {
        revealInHomeContent();
        contentScrollRef.current?.scrollTo({ behavior: 'auto', left: 0, top: 0 });
        headingRef.current?.focus({ preventScroll: true });
        focusFrameRef.current = null;
      });
      return;
    }
    setScreenId(nextScreenId);
  };

  const close = screenId === 'completion' ? onClose : onDismiss;

  return (
    <section
      ref={regionRef}
      aria-labelledby="getting-started-walkthrough-title"
      className="getting-started-walkthrough"
      data-tutorial-screen={screenId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
      }}
    >
      <header className="walkthrough-chrome">
        <div className="walkthrough-brand">
          <span aria-hidden="true">39</span>
          <div>
            <strong>39Note</strong>
            <small>Getting Started</small>
          </div>
        </div>
        <div className="walkthrough-chrome-actions">
          {screenId !== 'completion' ? (
            <button className="walkthrough-skip" type="button" onClick={onDismiss}>
              Skip tutorial
            </button>
          ) : null}
          <button
            aria-label="Close Getting Started"
            className="walkthrough-close"
            title="Close Getting Started"
            type="button"
            onClick={close}
          >
            ×
          </button>
        </div>
      </header>

      <TutorialProgress screenId={screenId} onNavigate={navigate} />

      <div
        ref={contentScrollRef}
        aria-label="Getting Started content"
        className="walkthrough-content-scroll"
        data-tutorial-scroll-owner="chapter-content"
        role="region"
        tabIndex={0}
        onFocus={(event) => {
          if (event.currentTarget === event.target) revealInHomeContent();
        }}
        onKeyDown={(event) => {
          if (
            event.currentTarget !== event.target ||
            (event.key !== 'Home' && event.key !== 'End')
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const scrollOwner = contentScrollRef.current;
          scrollOwner?.scrollTo({
            behavior: 'auto',
            left: 0,
            top: event.key === 'Home' ? 0 : scrollOwner.scrollHeight,
          });
        }}
      >
        <div className="walkthrough-screen" key={screenId}>
          {screenId === 'cover' ? (
            <WalkthroughCover
              headingRef={headingRef}
              onDismiss={onDismiss}
              onStart={() => navigate('import')}
            />
          ) : chapter ? (
            <WalkthroughChapter chapter={chapter} headingRef={headingRef} />
          ) : (
            <WalkthroughCompletion
              headingRef={headingRef}
              onClose={onClose}
              onOpenLibrary={onOpenLibrary}
            />
          )}
        </div>
      </div>
      {chapter ? (
        <WalkthroughNavigation
          chapterId={chapter.id}
          onBack={() => navigate(getPreviousTutorialScreen(screenId))}
          onFinish={() => {
            onFinish();
            navigate('completion');
          }}
          onNext={() => navigate(getNextTutorialScreen(screenId))}
        />
      ) : null}
    </section>
  );
}

function TutorialProgress({
  onNavigate,
  screenId,
}: {
  onNavigate(screenId: TutorialChapterId): void;
  screenId: TutorialScreenId;
}) {
  const chapterNumber = getTutorialChapterNumber(screenId);
  return (
    <nav className="walkthrough-progress" aria-label="Getting Started progress">
      <span className="visually-hidden" role="status">
        {chapterNumber
          ? `Step ${chapterNumber} of ${TUTORIAL_CHAPTERS.length}`
          : screenId === 'completion'
            ? 'Tutorial complete'
            : `${TUTORIAL_CHAPTERS.length} chapter introduction`}
      </span>
      <ol>
        {TUTORIAL_CHAPTERS.map((chapter, index) => {
          const state = getTutorialProgressState(screenId, chapter.id);
          return (
            <li key={chapter.id}>
              <button
                aria-current={state === 'current' ? 'step' : undefined}
                aria-label={`Chapter ${index + 1}: ${chapter.shortLabel}`}
                data-progress-state={state}
                type="button"
                onClick={() => onNavigate(chapter.id)}
              >
                <span aria-hidden="true" />
                <small>{chapter.shortLabel}</small>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function WalkthroughCover({
  headingRef,
  onDismiss,
  onStart,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  onDismiss(): void;
  onStart(): void;
}) {
  return (
    <div className="walkthrough-cover">
      <div className="walkthrough-cover-copy">
        <p className="walkthrough-eyebrow">A quick introduction</p>
        <h2 ref={headingRef} id="getting-started-walkthrough-title" tabIndex={-1}>
          Your research, organized.
        </h2>
        <p>
          Read closely, annotate clearly, connect ideas, and keep your work safe—all in
          one local-first workspace.
        </p>
        <div className="walkthrough-cover-meta">
          <span>5 chapters</span>
          <span aria-hidden="true">·</span>
          <span>About 2 minutes</span>
        </div>
        <div className="walkthrough-cover-actions">
          <button className="walkthrough-primary" type="button" onClick={onStart}>
            Get Started <span aria-hidden="true">→</span>
          </button>
          <button className="walkthrough-text-button" type="button" onClick={onDismiss}>
            Skip for now
          </button>
        </div>
      </div>
      <TutorialCoverVisual />
    </div>
  );
}

function WalkthroughChapter({
  chapter,
  headingRef,
}: {
  chapter: (typeof TUTORIAL_CHAPTERS)[number];
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const step = getTutorialChapterNumber(chapter.id) ?? 1;
  return (
    <div className="walkthrough-chapter">
      <ChapterVisual chapterId={chapter.id} label={chapter.visualLabel} />
      <div className="walkthrough-chapter-copy">
        <div>
          <p className="walkthrough-eyebrow">Chapter {step}</p>
          <h2 ref={headingRef} id="getting-started-walkthrough-title" tabIndex={-1}>
            {chapter.title}
          </h2>
          <p className="walkthrough-chapter-summary">{chapter.description}</p>
          <ul>
            {chapter.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          {chapter.id === 'drive' ? <DriveAccessRequest /> : null}
        </div>
      </div>
    </div>
  );
}

function WalkthroughNavigation({
  chapterId,
  onBack,
  onFinish,
  onNext,
}: {
  chapterId: TutorialChapterId;
  onBack(): void;
  onFinish(): void;
  onNext(): void;
}) {
  const step = getTutorialChapterNumber(chapterId) ?? 1;
  const isLast = step === TUTORIAL_CHAPTERS.length;
  return (
    <footer className="walkthrough-navigation" data-tutorial-footer="true">
      <span>
        Step {step} of {TUTORIAL_CHAPTERS.length}
      </span>
      <div>
        <button type="button" onClick={onBack}>
          Back
        </button>
        <button
          className="walkthrough-primary"
          type="button"
          onClick={isLast ? onFinish : onNext}
        >
          {isLast ? 'Finish' : 'Next'} <span aria-hidden="true">→</span>
        </button>
      </div>
    </footer>
  );
}

function DriveAccessRequest() {
  return (
    <aside className="walkthrough-drive-access" aria-label="Google Drive access">
      <strong>Optional Google Drive access</strong>
      <p>
        Connecting opens Google&apos;s permission screen. 39Note requests only access to
        files it creates or that you explicitly open with it. You can cancel before
        granting access.
      </p>
    </aside>
  );
}

function WalkthroughCompletion({
  headingRef,
  onClose,
  onOpenLibrary,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose(): void;
  onOpenLibrary(): void;
}) {
  return (
    <div className="walkthrough-completion">
      <div className="walkthrough-completion-mark" aria-hidden="true">
        <span>✓</span>
      </div>
      <p className="walkthrough-eyebrow">Introduction complete</p>
      <h2 ref={headingRef} id="getting-started-walkthrough-title" tabIndex={-1}>
        You’re ready to use 39Note.
      </h2>
      <p>Import a PDF, start annotating, or return to the papers in your Library.</p>
      <ul aria-label="Completed chapters" className="walkthrough-completion-list">
        {TUTORIAL_CHAPTERS.map((chapter) => (
          <li key={chapter.id}>
            <span aria-hidden="true">✓</span>
            {chapter.shortLabel}
          </li>
        ))}
      </ul>
      <div className="walkthrough-completion-actions">
        <button className="walkthrough-primary" type="button" onClick={onOpenLibrary}>
          Go to Library
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function ChapterVisual({
  chapterId,
  label,
}: {
  chapterId: TutorialChapterId;
  label: string;
}) {
  const visual: Record<TutorialChapterId, ReactNode> = {
    import: <ImportVisual />,
    annotate: <AnnotateVisual />,
    organize: <OrganizeVisual />,
    protect: <ProtectVisual />,
    drive: <DriveVisual />,
  };
  return (
    <div className={`walkthrough-visual is-${chapterId}`} aria-label={label} role="img">
      <div aria-hidden="true">{visual[chapterId]}</div>
    </div>
  );
}

function DemoWindow({ children, section }: { children: ReactNode; section: string }) {
  return (
    <div className="tutorial-demo-window">
      <div className="tutorial-demo-titlebar">
        <div>
          <span />
          <span />
          <span />
        </div>
        <strong>39Note</strong>
        <small>{section}</small>
      </div>
      {children}
    </div>
  );
}

function TutorialCoverVisual() {
  return (
    <div
      aria-label="A synthetic overview of the 39Note Reader with navigation, an annotated PDF, and study tools."
      className="walkthrough-cover-visual"
      role="img"
    >
      <div aria-hidden="true">
        <DemoWindow section="Reader">
          <div className="tutorial-cover-app">
            <aside>
              <strong>Navigation</strong>
              <span className="is-active">1 · Introduction</span>
              <span>2 · Methods</span>
              <span>3 · Findings</span>
            </aside>
            <div className="tutorial-paper">
              <small>FIELD NOTES · 01</small>
              <h3>Ideas become clearer when they are connected.</h3>
              <p />
              <p className="is-short" />
              <mark>Read closely and keep the important passage.</mark>
              <p />
            </div>
            <aside>
              <strong>Notes &amp; Glossary</strong>
              <span className="tutorial-note-preview">
                Notes · 2<br />
                Compare with Methods
              </span>
              <span className="tutorial-demo-chip">Glossary · 4</span>
              <span className="tutorial-demo-chip">Links · 1</span>
            </aside>
          </div>
        </DemoWindow>
        <div className="tutorial-cover-card is-library">
          <span>Library</span>
          <strong>12 papers</strong>
        </div>
        <div className="tutorial-cover-card is-link">
          <span>Linked idea</span>
          <strong>A ↔ B</strong>
        </div>
      </div>
    </div>
  );
}

function ImportVisual() {
  return (
    <DemoWindow section="Library → Reader">
      <div className="tutorial-import-flow">
        <section className="tutorial-import-library">
          <div className="tutorial-demo-heading">
            <span>LIBRARY</span>
            <strong>Saved documents</strong>
          </div>
          <span className="tutorial-demo-primary">Import PDF or convert Office</span>
          <div className="tutorial-file-drop">
            <span className="tutorial-pdf-icon">PDF</span>
            <div>
              <strong>research-starter.pdf</strong>
              <small>Stored source · Fictional tutorial paper</small>
            </div>
            <span className="tutorial-demo-row-action">Read Now</span>
          </div>
        </section>
        <span className="tutorial-flow-arrow">→</span>
        <section className="tutorial-import-reader">
          <div className="tutorial-reader-toolbar">
            <span>−</span>
            <strong>100%</strong>
            <span>＋</span>
            <span>Fit Width</span>
          </div>
          <div className="tutorial-reader-page">
            <small>RESEARCH STARTER</small>
            <h3>A readable PDF, ready for study.</h3>
            <p />
            <p />
            <p className="is-short" />
          </div>
          <span className="tutorial-opened-badge">Reader</span>
        </section>
        <section className="tutorial-converter-strip">
          <div>
            <small>LOCAL UTILITY</small>
            <strong>Convert Word / PowerPoint to PDF</strong>
          </div>
          <span>Choose a .docx or .pptx file</span>
          <b aria-hidden="true">→</b>
          <span>Convert locally</span>
          <b aria-hidden="true">→</b>
          <span>Add PDF to 39Note</span>
        </section>
      </div>
    </DemoWindow>
  );
}

function AnnotateVisual() {
  return (
    <DemoWindow section="Reader">
      <div className="tutorial-annotation-demo">
        <div className="tutorial-reader-mini-rail">
          <strong>Navigation</strong>
          <span>Page 1</span>
          <span className="is-active">Page 2</span>
          <span>Page 3</span>
          <strong>Annotations 2/2</strong>
        </div>
        <div className="tutorial-annotation-paper">
          <small>SYNTHETIC READING · PAGE 2</small>
          <h3>Connect evidence to the question it answers.</h3>
          <p>
            Select <span className="tutorial-live-selection">a useful passage</span> to
            reveal the contextual actions.
          </p>
          <div className="tutorial-selection-toolbar">
            <div>
              <span>Highlight</span>
              <span>Underline</span>
              <span className="is-selected">Link</span>
              <span className="tutorial-selection-lookup" title="Look up word">
                ⌕
              </span>
            </div>
            <div className="tutorial-selection-link-actions">
              <span>Create new Link</span>
              <span>Connect to existing Link</span>
            </div>
          </div>
          <div className="tutorial-context-tag">
            <strong>Highlight</strong>
            <p>Careful reading makes structure visible.</p>
            <span>Add Note</span>
          </div>
          <div className="tutorial-link-endpoint is-first">
            <span>Evidence supports the claim</span>
            <b>1</b>
          </div>
          <div className="tutorial-link-endpoint is-second">
            <span>The question this evidence answers</span>
            <b>1</b>
          </div>
        </div>
        <div className="tutorial-notes-drawer">
          <strong>Notes &amp; Glossary</strong>
          <span className="tutorial-drawer-search">Search this paper</span>
          <div className="tutorial-note-preview">
            <b>Notes · 1</b>
            <span>Why this evidence matters…</span>
          </div>
          <span className="tutorial-drawer-section">Glossary · 1</span>
          <span className="tutorial-drawer-section">Links · 1</span>
        </div>
      </div>
    </DemoWindow>
  );
}

function OrganizeVisual() {
  const papers = [
    ['Cedar Field Notes.pdf', 'Recent'],
    ['Methods Atlas.pdf', 'Pinned'],
    ['Signal and Soil.pdf', 'PDF'],
  ] as const;
  return (
    <DemoWindow section="Library / Collections">
      <div className="tutorial-organize-demo">
        <section className="tutorial-library-demo">
          <div className="tutorial-demo-heading">
            <span>LIBRARY</span>
            <strong>Saved documents</strong>
          </div>
          <div className="tutorial-library-tabs">
            <span className="is-active">All</span>
            <span>Recent</span>
            <span>Pinned</span>
          </div>
          <div className="tutorial-paper-list">
            {papers.map(([title, badge]) => (
              <div key={title}>
                <span className="tutorial-pdf-icon">PDF</span>
                <div>
                  <strong>{title}</strong>
                  <small>Fictional tutorial paper</small>
                </div>
                <span>{badge}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="tutorial-collection-demo">
          <small>ORGANIZATION</small>
          <div className="tutorial-collection-heading">
            <strong>Collections</strong>
            <span>+ Create Collection</span>
          </div>
          <div className="tutorial-collection-name">
            <span>
              <strong>Research questions</strong>
              <small>3 papers</small>
            </span>
            <b>Edit</b>
          </div>
          {papers.map(([title]) => (
            <div className="tutorial-collection-paper" key={title}>
              <span>{title}</span>
              <b>Open</b>
            </div>
          ))}
        </section>
      </div>
    </DemoWindow>
  );
}

function ProtectVisual() {
  return (
    <DemoWindow section="Library">
      <div className="tutorial-protect-demo">
        <section className="tutorial-backup-card">
          <div className="tutorial-backup-icon">
            <span>39</span>
            <i>↓</i>
          </div>
          <div>
            <small>LIBRARY</small>
            <h3>Saved documents</h3>
            <p>
              Your local papers and verified Google Drive papers appear together here.
            </p>
            <div className="tutorial-backup-actions">
              <span className="tutorial-demo-primary">Back up Library</span>
              <span>Restore backup</span>
              <span>Storage</span>
            </div>
          </div>
        </section>
        <section className="tutorial-concept-diagram">
          <strong>HOW BACKUP WORKS · DIAGRAM</strong>
          <div className="tutorial-backup-flow">
            <div>
              <span>✓</span>
              <strong>Local Library</strong>
              <small>Stored on this device</small>
            </div>
            <b>→</b>
            <div>
              <span>✓</span>
              <strong>Portable backup</strong>
              <small>Save somewhere durable</small>
            </div>
            <b>↺</b>
            <div>
              <span>✓</span>
              <strong>Restore preview</strong>
              <small>Keep or replace conflicts</small>
            </div>
          </div>
        </section>
      </div>
    </DemoWindow>
  );
}

function DriveVisual() {
  return (
    <DemoWindow section="Google Drive">
      <div className="tutorial-drive-demo">
        <span className="tutorial-demonstration-label">DEMONSTRATION · SYNTHETIC</span>
        <section className="tutorial-drive-summary">
          <div className="tutorial-drive-heading">
            <span className="tutorial-drive-mark">△</span>
            <div>
              <small>GOOGLE DRIVE</small>
              <strong>Google Drive</strong>
            </div>
            <span className="tutorial-status-dot">Changes waiting</span>
          </div>
          <p className="tutorial-drive-message">1 paper change waiting.</p>
          <div className="tutorial-drive-actions">
            <span>Browse Drive papers</span>
            <span className="is-primary">Upload changes (1)</span>
          </div>
          <div className="tutorial-drive-settings">
            <div>
              <span>Auto sync</span>
              <strong>Off · example setting</strong>
            </div>
            <div>
              <span>Sync sounds</span>
              <strong>On</strong>
            </div>
          </div>
          <div className="tutorial-drive-paper">
            <span className="tutorial-pdf-icon">PDF</span>
            <div>
              <strong>Research Starter</strong>
              <small>Fictional tutorial paper</small>
            </div>
            <span>Local changes</span>
          </div>
          <div className="tutorial-drive-details">
            <span>Cloud papers · 1</span>
            <span>Changes waiting · 1</span>
            <span>Device mode · Personal</span>
            <strong>Open 39Note folder</strong>
          </div>
        </section>
        <div className="tutorial-drive-explainer">
          <div>
            <strong>This device</strong>
            <span>PDF + study data</span>
          </div>
          <div className="tutorial-drive-route">
            <i />
            <span>Upload changes</span>
            <i />
          </div>
          <div>
            <strong>Managed 39Note folder</strong>
            <span>Google Drive</span>
          </div>
        </div>
        <p>Connecting does not mean every pending local change is already uploaded.</p>
      </div>
    </DemoWindow>
  );
}
