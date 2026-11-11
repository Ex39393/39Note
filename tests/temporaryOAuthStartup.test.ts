import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { AuthorizationExchange } from '../src/sync/googleIdentity.ts';
import type { WorkspaceRestoreLease } from '../src/services/workspaceRestoreLock.ts';
import type {
  PaperSyncDeviceProfile,
  TemporarySessionProvenance,
} from '../src/sync/storage.ts';
import {
  runApplicationStartupSecurityGate,
  TemporaryOAuthStartupVerificationError,
  verifyTemporaryOAuthReturnBeforeAppMount,
  type TemporaryOAuthStartupDependencies,
} from '../src/sync/temporaryOAuthStartup.ts';

const WORKSPACE_ID = '7a34d3f1-1d2e-4a5b-8c6d-1234567890ab';

function profile(accountId?: string): PaperSyncDeviceProfile {
  return {
    id: 'paper-device',
    deviceId: 'temporary-device',
    deviceLabel: 'Public device',
    deviceMode: 'temporary',
    deviceModeChoiceConfirmed: true,
    autoSync: false,
    ...(accountId ? { accountId } : {}),
  };
}

function provenance(
  accountId: string,
  temporarySessionId = WORKSPACE_ID,
  finishPhase: TemporarySessionProvenance['finishPhase'] = 'active',
): TemporarySessionProvenance {
  return {
    id: 'temporary',
    temporarySessionId,
    accountId,
    createdAt: 1,
    documentIds: [],
    collectionIds: [],
    finishPhase,
  };
}

function exchange(
  accountId: string,
  sessionMode: 'personal' | 'temporary' = 'temporary',
): AuthorizationExchange {
  return {
    sessionToken: 's'.repeat(43),
    session: {
      id: 'session-id',
      deviceId: 'temporary-device',
      createdAt: 1,
      lastUsedAt: 1,
      current: true,
      sessionMode,
      expiresAt: null,
    },
    sessionCount: 1,
    accountId,
    sessionMode,
    expiresAt: null,
  };
}

function harness(options: {
  active?: boolean;
  callback?: boolean;
  workspaceId?: string | null;
  profile?: PaperSyncDeviceProfile;
  provenance?: TemporarySessionProvenance | null;
  exchange?: AuthorizationExchange | null;
  exchangeFailure?: Error;
  boundProvenance?: TemporarySessionProvenance;
  mutationAdmissionFailure?: Error;
}) {
  const events: string[] = [];
  const operationsOutsideMutationScope: string[] = [];
  const leaseArgumentMismatches: string[] = [];
  const workspaceLease = {} as WorkspaceRestoreLease;
  let mutationScopeDepth = 0;
  let clearLocalSessionCount = 0;
  let savedProfile: PaperSyncDeviceProfile | undefined;
  const currentProfile = options.profile ?? profile('account-a');
  const currentProvenance =
    options.provenance === undefined ? provenance('account-a') : options.provenance;
  const recordOperation = (event: string) => {
    events.push(event);
    if (mutationScopeDepth === 0) operationsOutsideMutationScope.push(event);
  };
  const dependencies: TemporaryOAuthStartupDependencies = {
    isTemporaryWorkspaceActive: () => options.active ?? true,
    getActiveTemporaryWorkspaceId: () => options.workspaceId ?? WORKSPACE_ID,
    hasAuthorizationCallback: () => options.callback ?? true,
    clearAuthorizationCallback: () => {
      recordOperation('clear-callback');
    },
    getSyncAuthUrl: () => 'https://sync.example.test',
    createIdentity: () => ({
      configure: (
        _backendUrl,
        _deviceId,
        _deviceSessionToken,
        sessionMode,
        expectedAccountId,
      ) => {
        recordOperation(`configure:${sessionMode}:${expectedAccountId ?? 'unbound'}`);
      },
      completeAuthorizationIfPresent: async () => {
        recordOperation('exchange');
        if (options.exchangeFailure) throw options.exchangeFailure;
        return options.exchange === undefined
          ? exchange('account-a')
          : options.exchange;
      },
      clearLocalSession: () => {
        clearLocalSessionCount += 1;
        recordOperation('clear-session');
      },
    }),
    runWorkspaceMutation: async (task) => {
      if (options.mutationAdmissionFailure) throw options.mutationAdmissionFailure;
      mutationScopeDepth += 1;
      try {
        return await task(workspaceLease);
      } finally {
        mutationScopeDepth -= 1;
      }
    },
    loadProfile: async (lease) => {
      if (lease !== workspaceLease) leaseArgumentMismatches.push('load-profile');
      recordOperation('load-profile');
      return currentProfile;
    },
    saveProfile: async (value, lease) => {
      if (lease !== workspaceLease) leaseArgumentMismatches.push('save-profile');
      recordOperation('save-profile');
      savedProfile = structuredClone(value);
    },
    loadProvenance: async () => {
      recordOperation('load-provenance');
      return currentProvenance;
    },
    beginProvenance: async (accountId, rootFolderId, lease) => {
      if (lease !== workspaceLease) leaseArgumentMismatches.push('begin-provenance');
      recordOperation(`begin-provenance:${accountId}:${rootFolderId ?? 'no-root'}`);
      return options.boundProvenance ?? provenance(accountId);
    },
    clearOAuthReturn: async () => {
      recordOperation('clear-oauth-return');
    },
  };
  return {
    dependencies,
    events,
    get clearLocalSessionCount() {
      return clearLocalSessionCount;
    },
    get operationsOutsideMutationScope() {
      return operationsOutsideMutationScope;
    },
    get leaseArgumentMismatches() {
      return leaseArgumentMismatches;
    },
    get savedProfile() {
      return savedProfile;
    },
  };
}

test('startup gate is inert outside a temporary OAuth callback', async () => {
  for (const options of [
    { active: false, callback: true },
    { active: true, callback: false },
  ]) {
    const state = harness(options);
    await verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies);
    assert.deepEqual(state.events, []);
  }
});

test('verified same-account callback establishes provenance before saving profile', async () => {
  const currentProfile = profile('account-a');
  currentProfile.autoSync = true;
  currentProfile.googleDeviceSessionToken = 'p'.repeat(43);
  currentProfile.workspaceAccountId = 'should-not-survive-temporary-mode';
  currentProfile.rootFolderId = 'root-id';
  const state = harness({
    profile: currentProfile,
    provenance: provenance('account-a'),
    exchange: exchange('account-a'),
  });

  await verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies);

  assert.equal(state.clearLocalSessionCount, 0);
  assert.deepEqual(state.operationsOutsideMutationScope, []);
  assert.deepEqual(state.leaseArgumentMismatches, []);
  assert.deepEqual(state.events.slice(-4), [
    'begin-provenance:account-a:root-id',
    'save-profile',
    'clear-callback',
    'clear-oauth-return',
  ]);
  assert.equal(state.savedProfile?.accountId, 'account-a');
  assert.equal(state.savedProfile?.autoSync, false);
  assert.equal(state.savedProfile?.deviceMode, 'temporary');
  assert.equal(state.savedProfile?.deviceModeChoiceConfirmed, true);
  assert.equal(state.savedProfile?.googleDeviceSessionToken, undefined);
  assert.equal(state.savedProfile?.workspaceAccountId, undefined);
});

test('temporary provenance derives the active workspace only inside mutation ownership', () => {
  const temporarySessionSource = readFileSync(
    new URL('../src/sync/temporaryDeviceSession.ts', import.meta.url),
    'utf8',
  );
  const start = temporarySessionSource.indexOf(
    'export async function beginTemporaryProvenance',
  );
  const end = temporarySessionSource.indexOf(
    'export async function recordTemporaryPaperIds',
    start,
  );
  const implementation = temporarySessionSource.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.ok(
    implementation.indexOf('withWorkspaceMutation') <
      implementation.indexOf('requireActiveTemporaryWorkspace'),
  );
});

test('restore-barrier admission failure prevents OAuth exchange and local callback mutation', async () => {
  const admissionFailure = new Error('synthetic restore barrier');
  const state = harness({ mutationAdmissionFailure: admissionFailure });

  await assert.rejects(
    () => verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies),
    admissionFailure,
  );

  assert.deepEqual(state.events, []);
  assert.deepEqual(state.operationsOutsideMutationScope, []);
  assert.equal(state.clearLocalSessionCount, 0);
  assert.equal(state.savedProfile, undefined);
});

test('first temporary callback binds an unassociated workspace after broker verification', async () => {
  const state = harness({
    profile: profile(),
    provenance: null,
    exchange: exchange('first-account'),
  });

  await verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies);

  assert.ok(state.events.includes('configure:temporary:unbound'));
  assert.ok(state.events.includes('begin-provenance:first-account:no-root'));
  assert.equal(state.savedProfile?.accountId, 'first-account');
});

test('an established temporary profile cannot recreate missing provenance', async () => {
  const state = harness({
    profile: profile('account-a'),
    provenance: null,
    exchange: exchange('account-a'),
  });

  await assert.rejects(
    () => verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies),
    TemporaryOAuthStartupVerificationError,
  );

  assert.equal(state.events.includes('exchange'), false);
  assert.equal(
    state.events.some((event) => event.startsWith('begin-provenance:')),
    false,
  );
  assert.equal(state.savedProfile, undefined);
  assert.equal(state.clearLocalSessionCount, 1);
});

test('different broker account fails closed without overwriting provenance or profile', async () => {
  const state = harness({
    profile: profile('account-a'),
    provenance: provenance('account-a'),
    exchange: exchange('account-b'),
  });

  await assert.rejects(
    () => verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof TemporaryOAuthStartupVerificationError);
      assert.doesNotMatch(error.message, /account-a|account-b/u);
      return true;
    },
  );

  assert.equal(state.clearLocalSessionCount, 1);
  assert.equal(state.savedProfile, undefined);
  assert.equal(
    state.events.some((event) => event.startsWith('begin-provenance:')),
    false,
  );
  assert.deepEqual(state.events.slice(-3), [
    'clear-session',
    'clear-callback',
    'clear-oauth-return',
  ]);
});

test('inconsistent local provenance fails before broker exchange', async () => {
  for (const options of [
    {
      profile: profile('account-a'),
      provenance: provenance('account-b'),
    },
    {
      profile: profile('account-a'),
      provenance: provenance('account-a', 'different-workspace'),
    },
    {
      profile: { ...profile('account-a'), deviceMode: 'personal' as const },
      provenance: provenance('account-a'),
    },
    {
      profile: profile('account-a'),
      provenance: provenance('account-a', WORKSPACE_ID, 'cleanup-incomplete'),
    },
  ]) {
    const state = harness(options);
    await assert.rejects(
      () => verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies),
      TemporaryOAuthStartupVerificationError,
    );
    assert.equal(state.events.includes('exchange'), false);
    assert.equal(state.savedProfile, undefined);
    assert.equal(state.clearLocalSessionCount, 1);
  }
});

test('workspace changes and rebound provenance fail before profile persistence', async () => {
  const changedWorkspace = harness({
    profile: profile('account-a'),
    provenance: provenance('account-a'),
    exchange: exchange('account-a'),
  });
  let workspaceRead = 0;
  changedWorkspace.dependencies.getActiveTemporaryWorkspaceId = () =>
    workspaceRead++ === 0 ? WORKSPACE_ID : '8b45e4a2-2e3f-4b6c-9d7e-2345678901bc';

  await assert.rejects(
    () => verifyTemporaryOAuthReturnBeforeAppMount(changedWorkspace.dependencies),
    TemporaryOAuthStartupVerificationError,
  );
  assert.equal(
    changedWorkspace.events.some((event) => event.startsWith('begin-provenance:')),
    false,
  );
  assert.equal(changedWorkspace.savedProfile, undefined);

  const rebound = harness({
    profile: profile(),
    provenance: null,
    exchange: exchange('account-a'),
    boundProvenance: provenance('account-a', '8b45e4a2-2e3f-4b6c-9d7e-2345678901bc'),
  });
  await assert.rejects(
    () => verifyTemporaryOAuthReturnBeforeAppMount(rebound.dependencies),
    TemporaryOAuthStartupVerificationError,
  );
  assert.equal(rebound.savedProfile, undefined);
  assert.equal(rebound.clearLocalSessionCount, 1);
});

test('broker failure and wrong-mode responses remain fail-closed and redacted', async () => {
  for (const options of [
    { exchangeFailure: new Error('secret broker detail') },
    { exchange: exchange('account-a', 'personal') },
    { exchange: null },
  ]) {
    const state = harness(options);
    await assert.rejects(
      () => verifyTemporaryOAuthReturnBeforeAppMount(state.dependencies),
      (error: unknown) => {
        assert.ok(error instanceof TemporaryOAuthStartupVerificationError);
        assert.doesNotMatch(error.message, /secret|account-a/u);
        return true;
      },
    );
    assert.equal(state.clearLocalSessionCount, 1);
    assert.equal(state.savedProfile, undefined);
    assert.ok(state.events.includes('clear-oauth-return'));
    assert.deepEqual(state.operationsOutsideMutationScope, []);
  }
});

test('application mount is sequenced after workspace cleanup and callback verification', () => {
  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const gateIndex = mainSource.indexOf('runApplicationStartupSecurityGate({');
  const cleanupIndex = mainSource.indexOf(
    'prepareTemporaryWorkspace: prepareTemporaryWorkspaceStartup',
  );
  const restoreSafetyIndex = mainSource.indexOf(
    'verifyRestoreSafety: verifyRestoreSafetyBeforeAppMount',
  );
  const verificationIndex = mainSource.indexOf(
    'verifyTemporaryOAuthReturn: verifyTemporaryOAuthReturnBeforeAppMount',
  );
  const mountIndex = mainSource.indexOf('mountApplication: () => {');

  assert.ok(gateIndex >= 0);
  assert.ok(cleanupIndex > gateIndex);
  assert.ok(restoreSafetyIndex > cleanupIndex);
  assert.ok(verificationIndex > restoreSafetyIndex);
  assert.ok(mountIndex > verificationIndex);
  assert.match(mainSource, /No temporary study data was shown/u);
});

test('cleanup, restore-safety, or verification failure prevents application mount', async () => {
  for (const failurePhase of ['cleanup', 'restore-safety', 'verification'] as const) {
    const events: string[] = [];
    const mounted = await runApplicationStartupSecurityGate({
      prepareTemporaryWorkspace: async () => {
        events.push('cleanup');
        if (failurePhase === 'cleanup') throw new Error('synthetic cleanup failure');
      },
      verifyRestoreSafety: async () => {
        events.push('restore-safety');
        if (failurePhase === 'restore-safety') {
          throw new Error('synthetic restore-safety failure');
        }
      },
      verifyTemporaryOAuthReturn: async () => {
        events.push('verification');
        if (failurePhase === 'verification') {
          throw new Error('synthetic verification failure');
        }
      },
      mountApplication: () => {
        events.push('mount');
      },
      showSecurityFailure: () => {
        events.push('security-failure');
      },
    });

    assert.equal(mounted, false);
    assert.equal(events.includes('mount'), false);
    assert.equal(events.at(-1), 'security-failure');
    if (failurePhase === 'cleanup') {
      assert.equal(events.includes('restore-safety'), false);
      assert.equal(events.includes('verification'), false);
    } else if (failurePhase === 'restore-safety') {
      assert.equal(events.includes('verification'), false);
    }
  }

  const events: string[] = [];
  assert.equal(
    await runApplicationStartupSecurityGate({
      prepareTemporaryWorkspace: async () => {
        events.push('cleanup');
      },
      verifyRestoreSafety: async () => {
        events.push('restore-safety');
      },
      verifyTemporaryOAuthReturn: async () => {
        events.push('verification');
      },
      mountApplication: () => {
        events.push('mount');
      },
      showSecurityFailure: () => {
        events.push('security-failure');
      },
    }),
    true,
  );
  assert.deepEqual(events, ['cleanup', 'restore-safety', 'verification', 'mount']);
});
