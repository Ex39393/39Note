import {
  clearTemporaryWorkspaceOAuthReturn,
  getActiveTemporaryWorkspaceId,
  isTemporaryWorkspaceActive,
} from '../services/temporaryWorkspace.ts';
import type { WorkspaceRestoreLease } from '../services/workspaceRestoreLock.ts';
import {
  getBuildTimeSyncAuthUrl,
  PersistentGoogleAuthSession,
  type AuthorizationExchange,
} from './googleIdentity.ts';
import {
  loadPaperSyncDeviceProfile,
  loadTemporarySessionProvenance,
  savePaperSyncDeviceProfile,
  type PaperSyncDeviceProfile,
  type TemporarySessionProvenance,
} from './storage.ts';

interface TemporaryOAuthStartupIdentity {
  configure(
    backendUrl: string,
    deviceId: string,
    deviceSessionToken?: string,
    sessionMode?: 'personal' | 'temporary',
    persistedVerifiedAccountId?: string,
  ): void;
  completeAuthorizationIfPresent(): Promise<AuthorizationExchange | null>;
  clearLocalSession(): void;
}

export interface TemporaryOAuthStartupDependencies {
  isTemporaryWorkspaceActive(): boolean;
  getActiveTemporaryWorkspaceId(): string | null;
  hasAuthorizationCallback(): boolean;
  clearAuthorizationCallback(): void;
  getSyncAuthUrl(): string;
  createIdentity(): TemporaryOAuthStartupIdentity;
  runWorkspaceMutation<T>(
    task: (lease: WorkspaceRestoreLease) => Promise<T> | T,
  ): Promise<T>;
  loadProfile(workspaceLease?: WorkspaceRestoreLease): Promise<PaperSyncDeviceProfile>;
  saveProfile(
    profile: PaperSyncDeviceProfile,
    workspaceLease: WorkspaceRestoreLease,
  ): Promise<void>;
  loadProvenance(): Promise<TemporarySessionProvenance | null>;
  beginProvenance(
    accountId: string,
    rootFolderId?: string,
    workspaceLease?: WorkspaceRestoreLease,
  ): Promise<TemporarySessionProvenance>;
  clearOAuthReturn(): Promise<void>;
}

/**
 * A deliberately redacted startup failure. OAuth grants, broker responses, and
 * account identifiers must never escape into the pre-render diagnostic UI.
 */
export class TemporaryOAuthStartupVerificationError extends Error {
  constructor() {
    super(
      'The temporary Google authorization could not be verified before opening this workspace.',
    );
    this.name = 'TemporaryOAuthStartupVerificationError';
  }
}

export interface ApplicationStartupSecurityGateDependencies {
  prepareTemporaryWorkspace(): Promise<unknown>;
  verifyRestoreSafety?(): Promise<void>;
  verifyTemporaryOAuthReturn(): Promise<void>;
  mountApplication(): void;
  showSecurityFailure(error: unknown): void;
}

/**
 * Keeps all application content behind the temporary-workspace cleanup and
 * OAuth-return checks. A cleanup or verification failure may render only the
 * static security notice; it can never fall through to the React application.
 */
export async function runApplicationStartupSecurityGate(
  dependencies: ApplicationStartupSecurityGateDependencies,
): Promise<boolean> {
  try {
    await dependencies.prepareTemporaryWorkspace();
    await dependencies.verifyRestoreSafety?.();
    await dependencies.verifyTemporaryOAuthReturn();
    dependencies.mountApplication();
    return true;
  } catch (error) {
    dependencies.showSecurityFailure(error);
    return false;
  }
}

const productionDependencies: TemporaryOAuthStartupDependencies = {
  isTemporaryWorkspaceActive,
  getActiveTemporaryWorkspaceId,
  hasAuthorizationCallback,
  clearAuthorizationCallback,
  getSyncAuthUrl: getBuildTimeSyncAuthUrl,
  createIdentity: () => new PersistentGoogleAuthSession(),
  runWorkspaceMutation: async (task) => {
    const { withWorkspaceMutation } =
      await import('../services/annotationPersistence.ts');
    return withWorkspaceMutation(task);
  },
  loadProfile: loadPaperSyncDeviceProfile,
  saveProfile: (profile, workspaceLease) =>
    savePaperSyncDeviceProfile(profile, {}, workspaceLease),
  loadProvenance: loadTemporarySessionProvenance,
  beginProvenance: async (accountId, rootFolderId, workspaceLease) => {
    const { beginTemporaryProvenance } = await import('./temporaryDeviceSession.ts');
    return beginTemporaryProvenance(accountId, rootFolderId, workspaceLease);
  },
  clearOAuthReturn: clearTemporaryWorkspaceOAuthReturn,
};

/**
 * Completes a temporary-device OAuth return before React (and therefore the
 * Library) mounts. The broker identity must agree with every already-trusted
 * local identity for this exact UUID-scoped workspace. Any uncertainty fails
 * closed and leaves only the static startup diagnostic available.
 */
export async function verifyTemporaryOAuthReturnBeforeAppMount(
  dependencies: TemporaryOAuthStartupDependencies = productionDependencies,
): Promise<void> {
  if (
    !dependencies.isTemporaryWorkspaceActive() ||
    !dependencies.hasAuthorizationCallback()
  ) {
    return;
  }

  await dependencies.runWorkspaceMutation(async (workspaceLease) => {
    // The early checks above avoid opening persistence for an ordinary startup.
    // Recheck after shared ownership is acquired so an identity transition that
    // won the race cannot make this callback operate on a different workspace.
    if (
      !dependencies.isTemporaryWorkspaceActive() ||
      !dependencies.hasAuthorizationCallback()
    ) {
      return;
    }

    const identity = dependencies.createIdentity();
    try {
      const workspaceId = dependencies.getActiveTemporaryWorkspaceId();
      if (!workspaceId) throw new Error('Temporary workspace identity is unavailable.');

      const [profile, provenance] = await Promise.all([
        dependencies.loadProfile(workspaceLease),
        dependencies.loadProvenance(),
      ]);
      assertTrustedTemporaryState(workspaceId, profile, provenance);
      if (!provenance && profile.accountId) {
        throw new Error(
          'An established temporary account is missing its workspace provenance.',
        );
      }

      const expectedAccountId = trustedAccountId(profile, provenance);
      identity.configure(
        dependencies.getSyncAuthUrl(),
        profile.deviceId,
        undefined,
        'temporary',
        expectedAccountId,
      );
      const exchange = await identity.completeAuthorizationIfPresent();
      if (!exchange || exchange.sessionMode !== 'temporary') {
        throw new Error('Temporary authorization did not return a temporary session.');
      }
      if (expectedAccountId && exchange.accountId !== expectedAccountId) {
        throw new Error('Temporary authorization returned a different account.');
      }
      if (dependencies.getActiveTemporaryWorkspaceId() !== workspaceId) {
        throw new Error('Temporary workspace identity changed during authorization.');
      }

      // Provenance is established or revalidated before the profile is updated,
      // so an existing account association can never be overwritten first.
      const boundProvenance = await dependencies.beginProvenance(
        exchange.accountId,
        profile.rootFolderId,
        workspaceLease,
      );
      if (
        dependencies.getActiveTemporaryWorkspaceId() !== workspaceId ||
        boundProvenance.temporarySessionId !== workspaceId ||
        boundProvenance.accountId !== exchange.accountId ||
        boundProvenance.finishPhase !== 'active'
      ) {
        throw new Error('Temporary workspace provenance changed during authorization.');
      }
      profile.deviceMode = 'temporary';
      profile.deviceModeChoiceConfirmed = true;
      profile.autoSync = false;
      profile.accountId = exchange.accountId;
      delete profile.googleDeviceSessionToken;
      delete profile.workspaceAccountId;
      await dependencies.saveProfile(profile, workspaceLease);
      dependencies.clearAuthorizationCallback();
      await dependencies.clearOAuthReturn();
    } catch {
      identity.clearLocalSession();
      try {
        dependencies.clearAuthorizationCallback();
      } catch {
        // A static, fail-closed startup screen remains authoritative even when
        // browser history APIs are unavailable.
      }
      try {
        await dependencies.clearOAuthReturn();
      } catch {
        // The bounded registry lease remains safer than rendering unverified data.
      }
      throw new TemporaryOAuthStartupVerificationError();
    }
  });
}

function assertTrustedTemporaryState(
  workspaceId: string,
  profile: PaperSyncDeviceProfile,
  provenance: TemporarySessionProvenance | null,
): void {
  if (profile.deviceMode !== 'temporary') {
    throw new Error('The OAuth return does not match the selected device mode.');
  }
  if (provenance && provenance.temporarySessionId !== workspaceId) {
    throw new Error('Temporary workspace provenance does not match this workspace.');
  }
  if (provenance && provenance.finishPhase !== 'active') {
    throw new Error('Temporary workspace is not active for authorization.');
  }
  if (
    provenance?.accountId &&
    profile.accountId &&
    provenance.accountId !== profile.accountId
  ) {
    throw new Error('Temporary workspace identities disagree.');
  }
}

function trustedAccountId(
  profile: PaperSyncDeviceProfile,
  provenance: TemporarySessionProvenance | null,
): string | undefined {
  return provenance?.accountId ?? profile.accountId;
}

function hasAuthorizationCallback(): boolean {
  if (typeof window === 'undefined') return false;
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
  return fragment.has('sync_auth_grant') || fragment.has('sync_auth_error');
}

function clearAuthorizationCallback(): void {
  if (typeof window === 'undefined' || !window.location.hash) return;
  const cleanUrl = new URL(window.location.href);
  cleanUrl.hash = '';
  window.history.replaceState(window.history.state, '', cleanUrl);
}
