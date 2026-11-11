import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/components/ThemeProvider.tsx';
import { useTheme } from '../../src/theme/ThemeContext.ts';
import { isReadingTheme } from '../../src/themes.ts';
import {
  initialPaperSyncViewState,
  PaperSyncDrawer,
} from '../../src/sync/PaperSyncControl.tsx';
import {
  classifyPaperCoordinatorError,
  WorkspaceAccountMismatchError,
  type PaperGoogleDriveSyncCoordinator,
  type PaperSyncViewState,
} from '../../src/sync/paperCoordinator.ts';
import '../../src/styles/index.css';

const mismatch = new WorkspaceAccountMismatchError();
const mismatchState: PaperSyncViewState = {
  ...initialPaperSyncViewState,
  connection: 'attention' as const,
  backendConfigured: true,
  deviceMode: 'personal' as const,
  deviceModeChoiceConfirmed: true,
  autoSync: false,
  dirtyPaperIds: ['synthetic-local-paper'],
  securityState: { kind: 'account-mismatch' as const },
  issue: classifyPaperCoordinatorError(mismatch),
  error: mismatch.message,
};

export function ThemeFromQuery({ children }: PropsWithChildren) {
  const { setTheme } = useTheme();
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('theme');
    if (isReadingTheme(requested)) setTheme(requested);
  }, [setTheme]);
  return children;
}

export function BrowserFixture() {
  const [action, setAction] = useState('No recovery action has run.');
  const [syncState, setSyncState] = useState<PaperSyncViewState>(mismatchState);
  const reconnectAttempts = useRef(0);
  const coordinator = {
    reconnectOriginalAccount: async () => {
      reconnectAttempts.current += 1;
      setSyncState({
        ...mismatchState,
        connection: 'connected',
        securityState: undefined,
        issue: undefined,
        error: undefined,
      });
      setAction(
        `Original account verified. Recovery attempts: ${reconnectAttempts.current}.`,
      );
    },
    disconnect: async () => {
      setSyncState({
        ...mismatchState,
        connection: 'disconnected',
        securityState: undefined,
        issue: undefined,
        error: undefined,
      });
      setAction('Disconnected safely.');
    },
  } as unknown as PaperGoogleDriveSyncCoordinator;

  return (
    <ThemeProvider>
      <ThemeFromQuery>
        <main aria-label="Account mismatch browser fixture" className="home-workspace">
          <PaperSyncDrawer
            embedded
            coordinator={coordinator}
            soundEnabled={false}
            state={syncState}
            onDownloadBackup={() => undefined}
            onOpenSelector={() => undefined}
            onSoundEnabledChange={() => undefined}
          />
          <p aria-live="polite" data-testid="fixture-action">
            {action}
          </p>
          <dl aria-label="Synthetic recovery audit">
            <dt>Local papers</dt>
            <dd data-testid="fixture-local-papers">1 retained</dd>
            <dt>Queued changes</dt>
            <dd data-testid="fixture-queued-changes">1 retained</dd>
            <dt>Drive writes</dt>
            <dd data-testid="fixture-drive-writes">0</dd>
          </dl>
        </main>
      </ThemeFromQuery>
    </ThemeProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root.');
createRoot(root).render(<BrowserFixture />);
