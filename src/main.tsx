import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './components/ThemeProvider';
import { prepareTemporaryWorkspaceStartup } from './services/temporaryWorkspace.ts';
import {
  describeRestoreSafetyStartupFailure,
  verifyRestoreSafetyBeforeAppMount,
} from './services/restoreSafetyStartup.ts';
import {
  runApplicationStartupSecurityGate,
  verifyTemporaryOAuthReturnBeforeAppMount,
} from './sync/temporaryOAuthStartup.ts';
import './styles/index.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('39Note could not find its application root.');
}

const startupStatus = document.createElement('main');
startupStatus.className = 'workspace-security-startup-error is-checking';
startupStatus.setAttribute('aria-live', 'polite');
const startupHeading = document.createElement('h1');
startupHeading.textContent = 'Checking local restore safety…';
const startupDetail = document.createElement('p');
startupDetail.textContent =
  '39Note is verifying any interrupted local restore before opening the Library or Google Drive.';
startupStatus.append(startupHeading, startupDetail);
root.replaceChildren(startupStatus);

void runApplicationStartupSecurityGate({
  prepareTemporaryWorkspace: prepareTemporaryWorkspaceStartup,
  verifyRestoreSafety: verifyRestoreSafetyBeforeAppMount,
  verifyTemporaryOAuthReturn: verifyTemporaryOAuthReturnBeforeAppMount,
  mountApplication: () => {
    createRoot(root).render(
      <StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </StrictMode>,
    );
  },
  showSecurityFailure: (error) => {
    const restoreSafetyFailure = describeRestoreSafetyStartupFailure(error);
    const notice = document.createElement('main');
    notice.className = 'workspace-security-startup-error';
    const heading = document.createElement('h1');
    heading.textContent =
      restoreSafetyFailure?.heading ??
      '39Note could not safely open this temporary workspace.';
    const detail = document.createElement('p');
    detail.textContent =
      restoreSafetyFailure?.detail ??
      'Its ownership or Google authorization could not be verified before opening. No temporary study data was shown. Close other 39Note tabs and try again in a new Private or Incognito window.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry safe startup';
    retry.addEventListener('click', () => window.location.reload());
    notice.append(heading, detail, retry);
    root.replaceChildren(notice);
  },
});
