import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PaperSelectorDialog } from '../../src/sync/PaperSyncControl.tsx';
import type {
  ForgetInaccessiblePaperDiagnostic,
  PaperGoogleDriveSyncCoordinator,
  PaperSyncViewState,
} from '../../src/sync/paperCoordinator.ts';
import type { PaperCloudSummary, PaperSyncState } from '../../src/sync/paperTypes.ts';
import '../../src/styles/index.css';

const documentId = 'synthetic-broken-paper-instance-001';
const paperFolderId = 'synthetic-managed-folder-001';
const paper: PaperCloudSummary = {
  documentId,
  displayName: 'Synthetic inaccessible paper.pdf',
  deleted: false,
  paperFolderId,
  headIds: ['cached-head'],
  headSetId: 'cached-head',
  localAvailability: 'local-and-cloud',
  status: 'needs-attention',
  presenceState: 'present',
  writerLabel: 'Synthetic device',
  publishedAt: 1_793_228_400_000,
};
const paperState: PaperSyncState = {
  documentId,
  displayName: paper.displayName,
  deviceId: 'synthetic-device',
  availability: 'local-and-cloud',
  status: 'synced',
  cloudPresence: 'present',
  dirtyGeneration: 0,
  dirtyReasons: [],
  entityVersions: {},
  baselineHashes: {},
  tombstones: [],
  conflicts: [],
  incorporatedHeadIds: [],
  remoteHeadIds: ['cached-head'],
  pdfFingerprints: {},
  driveFiles: { paperFolderId, fileIds: {} },
};
const state: PaperSyncViewState = {
  connection: 'connected',
  backendConfigured: true,
  deviceMode: 'personal',
  deviceModeChoiceConfirmed: true,
  autoSync: false,
  papers: [paper],
  paperStates: [paperState],
  dirtyPaperIds: [],
  sessions: [],
  rootChoices: [],
  progress: { phase: 'idle' },
  activePaperOperations: [],
  legacyHousekeeping: { status: 'idle' },
  folderNameMaintenance: { status: 'idle' },
};
const mode = new URLSearchParams(window.location.search).get('mode') ?? 'blocked';
let verified = mode === 'eligible';
const fixtureState = {
  loadId: crypto.randomUUID(),
  forgetCalls: 0,
  mutationCalls: 0,
  verificationCalls: 0,
};
Object.assign(globalThis, { __39noteForgetPaperFixture: fixtureState });
const candidate = {
  documentId,
  displayName: paper.displayName,
};
const currentDiagnostic = (): ForgetInaccessiblePaperDiagnostic => ({
  eligible: verified,
  reason: verified ? 'eligible' : 'identity-proof-unavailable',
  evidenceSource: verified
    ? mode === 'eligible'
      ? 'reviewed-quarantine'
      : 'failed-inspection'
    : 'none',
  ...(verified ? { candidate } : {}),
  predicates: {
    profilePresent: true,
    personalDevice: true,
    accountIdentityPresent: true,
    accountScopeMatches: true,
    workspaceScopeMatches: true,
    rootScopePresent: true,
    catalogPaperPresent: true,
    catalogNeedsAttention: true,
    paperNotDeleted: true,
    paperNotRemoved: true,
    paperFolderAvailable: true,
    localStatePresent: true,
    localStateNeedsAttention: false,
    localPresencePresent: true,
    paperFolderMatches: true,
    catalogFailureExact: false,
    reviewedProofPresent: verified && mode === 'eligible',
    sessionProofPresent: verified && mode === 'verify',
    identityProofAvailable: verified,
  },
});
const coordinator = {
  getForgetInaccessiblePaperDiagnostic: () => currentDiagnostic(),
  getForgetInaccessiblePaperCandidate: () => (verified ? candidate : undefined),
  checkSyncStatusReadOnly: async (requestedDocumentId?: string) => {
    fixtureState.verificationCalls += 1;
    if (mode === 'verify' && requestedDocumentId === documentId) verified = true;
  },
  downloadSelected: async () => {
    fixtureState.mutationCalls += 1;
  },
  uploadSelected: async () => {
    fixtureState.mutationCalls += 1;
  },
  keepLocalSelected: async () => {
    fixtureState.mutationCalls += 1;
  },
  finishTemporaryDevice: async () => {
    fixtureState.mutationCalls += 1;
  },
  forgetInaccessiblePaper: async () => {
    fixtureState.forgetCalls += 1;
    fixtureState.mutationCalls += 1;
    return { documentId, alreadyIgnored: false };
  },
} as unknown as PaperGoogleDriveSyncCoordinator;

document.body.className = 'theme-root';
document.body.dataset.fixtureMode = mode;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PaperSelectorDialog
      coordinator={coordinator}
      mode="download"
      state={state}
      onClose={() => undefined}
    />
  </StrictMode>,
);
