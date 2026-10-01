import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createApp, TEMPORARY_SESSION_ABSOLUTE_TTL_MS } from '../src/app.ts';
import { randomToken, sha256Base64Url } from '../src/crypto.ts';
import { GOOGLE_DRIVE_SCOPE } from '../src/security.ts';
import type { Env } from '../src/types.ts';
import { MemoryAuthStore } from './memoryStore.ts';

const ORIGIN = 'http://127.0.0.1:5173';
const OTHER_ALLOWED_ORIGIN = 'http://localhost:5173';
const WORKER_ORIGIN = 'https://sync.example.test';
const ENCRYPTION_KEY = btoa('K'.repeat(32));

interface GoogleStubOptions {
  codeResponses?: Array<{ status?: number; body?: unknown }>;
  refreshResponses?: Array<{ status?: number; body?: unknown }>;
  aboutResponses?: Array<{ status?: number; body?: unknown }>;
  revokeResponse?: { status?: number; body?: unknown };
}

function harness(options: GoogleStubOptions = {}) {
  const store = new MemoryAuthStore();
  const google = googleStub(options);
  let timestamp = 2_000_000_000_000;
  const env = {
    DB: undefined,
    GOOGLE_CLIENT_ID: '123-example.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
    TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
  } as unknown as Env;
  const app = createApp(env, { store, fetcher: google.fetcher, now: () => timestamp });
  return {
    app,
    store,
    google,
    now: () => timestamp,
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
  };
}

test('health reports the deployed single-realm Worker schema without exposing configuration', async () => {
  const { app } = harness();
  const response = await app(new Request(`${WORKER_ORIGIN}/health`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: '39note-sync-auth',
    workerSchemaVersion: 2,
  });
});

test('Worker exposes only the existing OAuth realm and keeps the callback unchanged', async () => {
  const { app } = harness();
  const v3Start = await app(
    new Request(`${WORKER_ORIGIN}/api/v3/oauth/start`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  const v3Callback = await app(
    new Request(`${WORKER_ORIGIN}/api/v3/oauth/callback?state=unused&code=unused`),
  );
  assert.equal(v3Start.status, 404);
  assert.equal(v3Callback.status, 404);

  const verifier = randomToken();
  const started = await startAuthorization(app, 'device-alpha', verifier);
  assert.equal(
    started.authorization.searchParams.get('redirect_uri'),
    `${WORKER_ORIGIN}/api/oauth/callback`,
  );
  assert.equal(started.authorization.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
});

test('OAuth start uses offline Web Server flow, PKCE S256, state, and only drive.file', async () => {
  const { app, store } = harness();
  const verifier = randomToken();
  const started = await startAuthorization(app, 'device-alpha', verifier);
  assert.equal(started.authorization.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
  assert.equal(started.authorization.searchParams.get('access_type'), 'offline');
  assert.equal(
    started.authorization.searchParams.get('include_granted_scopes'),
    'true',
  );
  assert.equal(started.authorization.searchParams.get('code_challenge_method'), 'S256');
  const storedState = [...store.oauthStates.values()][0];
  assert.equal(
    started.authorization.searchParams.get('code_challenge'),
    await sha256Base64Url(storedState.googleCodeVerifier),
  );
  assert.equal(storedState.exchangeChallenge, await sha256Base64Url(verifier));
  assert.equal(
    started.authorization.searchParams.get('redirect_uri'),
    `${WORKER_ORIGIN}/api/oauth/callback`,
  );
  assert.equal(store.oauthStates.size, 1);
});

test('first authorization creates an encrypted account token, one-time grant, and independent device session', async () => {
  const { app, store, google } = harness({
    codeResponses: [{ body: tokenBody('code-access', 'refresh-one') }],
    refreshResponses: [{ body: tokenBody('fresh-access') }],
  });
  const authorized = await authorizeDevice(app, 'device-alpha');
  assert.match(authorized.sessionToken, /^[A-Za-z0-9_-]{43}$/u);
  const storedSession = [...store.sessions.values()][0];
  assert.deepEqual(authorized, {
    sessionToken: authorized.sessionToken,
    accountId: storedSession.userId,
    session: {
      id: storedSession.id,
      deviceId: storedSession.deviceId,
      createdAt: storedSession.createdAt,
      lastUsedAt: storedSession.lastUsedAt,
      sessionMode: 'personal',
      expiresAt: null,
      current: true,
    },
    sessionCount: 1,
    sessionMode: 'personal',
    expiresAt: null,
  });
  assert.equal([...store.oauthStates.values()][0].sessionMode, 'personal');
  assert.equal([...store.grants.values()][0].sessionMode, 'personal');
  assert.equal(storedSession.sessionMode, 'personal');
  assert.equal(storedSession.expiresAt, null);
  assert.equal(store.users.size, 1);
  const user = [...store.users.values()][0];
  assert.notEqual(user.encryptedRefreshToken, 'refresh-one');
  assert.equal(user.googleSubject, 'opaque-drive-user');
  assert.equal(user.grantedScopes, JSON.stringify([GOOGLE_DRIVE_SCOPE]));
  assert.equal(
    [...store.sessions.values()][0].tokenHash.includes(authorized.sessionToken),
    false,
  );

  const access = await authenticated(
    app,
    '/api/google/access-token',
    authorized.sessionToken,
    { method: 'POST' },
  );
  assert.equal(access.status, 200);
  assert.deepEqual(await access.json(), {
    accessToken: 'fresh-access',
    expiresAt: 2_000_003_600_000,
  });
  assert.equal(google.refreshCalls, 1);

  const sessions = await authenticated(app, '/api/sessions', authorized.sessionToken, {
    method: 'GET',
  });
  const listed = (await sessions.json()) as {
    accountId: string;
    sessionCount: number;
    sessions: Array<{
      current: boolean;
      sessionMode: string;
      expiresAt: number | null;
    }>;
  };
  assert.equal(listed.accountId, storedSession.userId);
  assert.equal(listed.sessionCount, 1);
  assert.equal(listed.sessions[0].current, true);
  assert.equal(listed.sessions[0].sessionMode, 'personal');
  assert.equal(listed.sessions[0].expiresAt, null);
});

test('temporary mode is bound through OAuth and expires at a server-enforced absolute deadline', async () => {
  const { app, store, advance, now } = harness({
    codeResponses: [{ body: tokenBody('temporary-access', 'temporary-refresh') }],
  });
  const verifier = randomToken();
  const started = await startAuthorization(
    app,
    'temporary-device',
    verifier,
    'temporary',
  );
  assert.equal([...store.oauthStates.values()][0].sessionMode, 'temporary');

  const callback = await app(
    new Request(
      `${WORKER_ORIGIN}/api/oauth/callback?state=${encodeURIComponent(started.state)}&code=valid-code`,
    ),
  );
  const grant = redirectFragment(callback).get('sync_auth_grant');
  assert.ok(grant);
  assert.equal([...store.grants.values()][0].sessionMode, 'temporary');

  const createdAt = now();
  const exchange = await api(app, '/api/oauth/exchange', {
    grant,
    exchangeVerifier: verifier,
    deviceId: 'temporary-device',
    // The one-time grant, not this untrusted claim, owns the mode.
    sessionMode: 'personal',
  });
  assert.equal(exchange.status, 200);
  const authorized = (await exchange.json()) as AuthorizedDevice;
  assert.equal(authorized.session.sessionMode, 'temporary');
  assert.equal(authorized.sessionMode, 'temporary');
  assert.equal(
    authorized.session.expiresAt,
    createdAt + TEMPORARY_SESSION_ABSOLUTE_TTL_MS,
  );
  assert.equal(authorized.expiresAt, createdAt + TEMPORARY_SESSION_ABSOLUTE_TTL_MS);
  assert.equal(authorized.accountId, [...store.users.keys()][0]);

  advance(TEMPORARY_SESSION_ABSOLUTE_TTL_MS - 1);
  assert.equal(
    (
      await authenticated(app, '/api/sessions', authorized.sessionToken, {
        method: 'GET',
      })
    ).status,
    200,
  );
  advance(1);
  assert.equal(
    (
      await authenticated(app, '/api/sessions', authorized.sessionToken, {
        method: 'GET',
      })
    ).status,
    401,
  );
});

test('expired temporary sessions are filtered while personal sessions remain active', async () => {
  const { app, advance } = harness({
    codeResponses: [
      { body: tokenBody('personal-access', 'shared-refresh') },
      { body: tokenBody('temporary-access') },
    ],
  });
  const personal = await authorizeDevice(app, 'personal-device');
  const temporary = await authorizeDevice(app, 'temporary-device', 'temporary');

  advance(TEMPORARY_SESSION_ABSOLUTE_TTL_MS);
  const response = await authenticated(app, '/api/sessions', personal.sessionToken, {
    method: 'GET',
  });
  assert.equal(response.status, 200);
  const listed = (await response.json()) as {
    sessionCount: number;
    sessions: Array<{ id: string; sessionMode: string }>;
  };
  assert.equal(listed.sessionCount, 1);
  assert.deepEqual(
    listed.sessions.map(({ id, sessionMode }) => ({ id, sessionMode })),
    [{ id: personal.session.id, sessionMode: 'personal' }],
  );
  assert.equal(
    (
      await authenticated(app, '/api/sessions', temporary.sessionToken, {
        method: 'GET',
      })
    ).status,
    401,
  );
});

test('OAuth start rejects an invalid session mode before creating state', async () => {
  const { app, store } = harness();
  const response = await api(app, '/api/oauth/start', {
    deviceId: 'device-alpha',
    exchangeChallenge: await sha256Base64Url(randomToken()),
    returnUrl: `${ORIGIN}/reader`,
    sessionMode: 'shared-kiosk',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_session_mode' });
  assert.equal(store.oauthStates.size, 0);
});

test('OAuth callback 303 can carry a semantic error instead of an authorization grant', async () => {
  const { app, store } = harness();
  const started = await startAuthorization(app, 'device-alpha', randomToken());
  const callback = await app(
    new Request(
      `${WORKER_ORIGIN}/api/oauth/callback?state=${encodeURIComponent(started.state)}`,
    ),
  );

  assert.equal(callback.status, 303);
  const fragment = redirectFragment(callback);
  assert.equal(fragment.get('sync_auth_error'), 'authorization_response_invalid');
  assert.equal(fragment.get('sync_auth_grant'), null);
  assert.equal(store.grants.size, 0);
  assert.equal(store.sessions.size, 0);
});

test('additional-device authorization for the same Drive user retains an existing refresh token when Google omits it', async () => {
  const { app, store } = harness({
    codeResponses: [
      { body: tokenBody('access-one', 'refresh-one') },
      { body: tokenBody('access-two') },
    ],
  });
  const first = await authorizeDevice(app, 'device-alpha');
  const encryptedBefore = [...store.users.values()][0].encryptedRefreshToken;
  const second = await authorizeDevice(app, 'device-bravo');
  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.equal([...store.users.values()][0].encryptedRefreshToken, encryptedBefore);
  assert.equal((await store.listDeviceSessions([...store.users.keys()][0])).length, 2);
});

test('first authorization without a refresh token returns a clear reconsent action', async () => {
  const { app, store } = harness({
    codeResponses: [{ body: tokenBody('access-only') }],
  });
  const verifier = randomToken();
  const started = await startAuthorization(app, 'device-alpha', verifier);
  const callback = await app(
    new Request(
      `${WORKER_ORIGIN}/api/oauth/callback?state=${encodeURIComponent(started.state)}&code=valid`,
    ),
  );
  const fragment = redirectFragment(callback);
  assert.equal(fragment.get('sync_auth_error'), 'refresh_token_missing');
  assert.equal(fragment.get('sync_auth_action'), 'reconsent');
  assert.equal(store.users.size, 0);
});

test('Google code-exchange and Drive-identity 5xx or malformed responses are safely classified', async () => {
  for (const scenario of [
    {
      options: {
        codeResponses: [
          { status: 503, body: { error: 'server_error', detail: 'private' } },
        ],
      },
      expected: 'google_temporarily_unavailable',
    },
    {
      options: {
        codeResponses: [{ body: { expires_in: 3600, private: 'do not expose' } }],
      },
      expected: 'google_invalid_response',
    },
    {
      options: {
        codeResponses: [{ body: tokenBody('access', 'refresh') }],
        aboutResponses: [{ status: 503, body: { detail: 'private' } }],
      },
      expected: 'google_temporarily_unavailable',
    },
    {
      options: {
        codeResponses: [{ body: tokenBody('access', 'refresh') }],
        aboutResponses: [{ body: { user: {} } }],
      },
      expected: 'google_invalid_response',
    },
  ] satisfies Array<{ options: GoogleStubOptions; expected: string }>) {
    const { app } = harness(scenario.options);
    const started = await startAuthorization(app, 'device-alpha', randomToken());
    const callback = await app(
      new Request(
        `${WORKER_ORIGIN}/api/oauth/callback?state=${started.state}&code=valid`,
      ),
    );
    assert.equal(callback.status, 303);
    const fragment = redirectFragment(callback);
    assert.equal(fragment.get('sync_auth_error'), scenario.expected);
    assert.equal(callback.headers.get('Location')?.includes('private'), false);
  }
});

test('authorization grants reject wrong verifier, device, origin, and double use', async () => {
  const { app } = harness({
    codeResponses: [{ body: tokenBody('access', 'refresh') }],
  });
  const verifier = randomToken();
  const started = await startAuthorization(app, 'device-alpha', verifier);
  const callback = await app(
    new Request(
      `${WORKER_ORIGIN}/api/oauth/callback?state=${encodeURIComponent(started.state)}&code=valid`,
    ),
  );
  const grant = redirectFragment(callback).get('sync_auth_grant');
  assert.ok(grant);

  assert.equal(
    (await exchangeGrant(app, grant, randomToken(), 'device-alpha')).status,
    401,
  );
  assert.equal((await exchangeGrant(app, grant, verifier, 'device-bravo')).status, 401);
  assert.equal(
    (await exchangeGrant(app, grant, verifier, 'device-alpha', OTHER_ALLOWED_ORIGIN))
      .status,
    401,
  );
  const accepted = await exchangeGrant(app, grant, verifier, 'device-alpha');
  assert.equal(accepted.status, 200);
  assert.equal((await exchangeGrant(app, grant, verifier, 'device-alpha')).status, 401);
});

test('OAuth state is single-use, expires, rejects unknown state, and cannot become an open redirect', async () => {
  const unknown = harness();
  const unknownResponse = await unknown.app(
    new Request(`${WORKER_ORIGIN}/api/oauth/callback?state=${randomToken()}&code=x`),
  );
  assert.equal(unknownResponse.status, 400);
  assert.equal(unknownResponse.headers.get('Location'), null);

  const expired = harness();
  const expiredStart = await startAuthorization(
    expired.app,
    'device-alpha',
    randomToken(),
  );
  expired.advance(11 * 60_000);
  assert.equal(
    (
      await expired.app(
        new Request(
          `${WORKER_ORIGIN}/api/oauth/callback?state=${expiredStart.state}&code=x`,
        ),
      )
    ).status,
    400,
  );

  const used = harness({ codeResponses: [{ body: tokenBody('access', 'refresh') }] });
  const usedStart = await startAuthorization(used.app, 'device-alpha', randomToken());
  const callbackUrl = `${WORKER_ORIGIN}/api/oauth/callback?state=${usedStart.state}&code=x`;
  assert.equal((await used.app(new Request(callbackUrl))).status, 303);
  assert.equal((await used.app(new Request(callbackUrl))).status, 400);

  const openRedirect = harness();
  const response = await api(openRedirect.app, '/api/oauth/start', {
    deviceId: 'device-alpha',
    exchangeChallenge: await sha256Base64Url(randomToken()),
    returnUrl: 'https://evil.example/steal',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_return_url' });
});

test('CORS permits only explicit app origins, supports auth headers, and never emits wildcard origin', async () => {
  const { app } = harness();
  const allowed = await app(
    new Request(`${WORKER_ORIGIN}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    }),
  );
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(
    allowed.headers.get('Access-Control-Allow-Headers'),
    'Authorization, Content-Type',
  );
  assert.notEqual(allowed.headers.get('Access-Control-Allow-Origin'), '*');

  const disallowed = await app(
    new Request(`${WORKER_ORIGIN}/api/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    }),
  );
  assert.equal(disallowed.status, 403);
  assert.equal(disallowed.headers.get('Access-Control-Allow-Origin'), null);
});

test('OAuth start applies a bounded per-origin/device rate safeguard', async () => {
  const { app } = harness();
  let last: Response | undefined;
  for (let count = 0; count < 11; count += 1) {
    last = await api(app, '/api/oauth/start', {
      deviceId: 'device-alpha',
      exchangeChallenge: await sha256Base64Url(randomToken()),
      returnUrl: `${ORIGIN}/reader`,
    });
  }
  assert.equal(last?.status, 429);
  assert.deepEqual(await last?.json(), { error: 'rate_limited' });
});

test('random and revoked sessions fail; this-device disconnect revokes only that session', async () => {
  const { app } = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }, { body: tokenBody('two') }],
  });
  const first = await authorizeDevice(app, 'device-alpha');
  const second = await authorizeDevice(app, 'device-bravo');
  assert.equal(
    (await authenticated(app, '/api/sessions', randomToken(), { method: 'GET' }))
      .status,
    401,
  );
  assert.equal(
    (
      await authenticated(app, '/api/session/disconnect', first.sessionToken, {
        method: 'POST',
      })
    ).status,
    200,
  );
  assert.equal(
    (await authenticated(app, '/api/sessions', first.sessionToken, { method: 'GET' }))
      .status,
    401,
  );
  assert.equal(
    (await authenticated(app, '/api/sessions', second.sessionToken, { method: 'GET' }))
      .status,
    200,
  );
});

test('disconnect-all requires explicit confirmation, revokes every session, and calls Google revocation', async () => {
  const { app, google } = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }],
  });
  const session = await authorizeDevice(app, 'device-alpha');
  const missingConfirmation = await authenticated(
    app,
    '/api/session/disconnect-all',
    session.sessionToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: false }),
    },
  );
  assert.equal(missingConfirmation.status, 400);
  const disconnected = await authenticated(
    app,
    '/api/session/disconnect-all',
    session.sessionToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DISCONNECT_ALL' }),
    },
  );
  assert.equal(disconnected.status, 200);
  assert.equal(google.revokeCalls, 1);
  assert.equal(
    (await authenticated(app, '/api/sessions', session.sessionToken, { method: 'GET' }))
      .status,
    401,
  );
});

test('disconnect-all remains locally effective when Google revocation is temporarily unavailable', async () => {
  const { app } = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }],
    revokeResponse: { status: 503, body: { detail: 'private' } },
  });
  const session = await authorizeDevice(app, 'device-alpha');
  const response = await authenticated(
    app,
    '/api/session/disconnect-all',
    session.sessionToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DISCONNECT_ALL' }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    disconnected: true,
    googleRevocationAccepted: false,
  });
  assert.equal(
    (await authenticated(app, '/api/sessions', session.sessionToken, { method: 'GET' }))
      .status,
    401,
  );
});

test('Google invalid_grant revokes sessions while 5xx and malformed refresh responses stay safely classified', async () => {
  const rejected = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }],
    refreshResponses: [
      {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'do not expose' },
      },
    ],
  });
  const rejectedSession = await authorizeDevice(rejected.app, 'device-alpha');
  const rejectedResponse = await authenticated(
    rejected.app,
    '/api/google/access-token',
    rejectedSession.sessionToken,
    { method: 'POST' },
  );
  assert.equal(rejectedResponse.status, 401);
  assert.deepEqual(await rejectedResponse.json(), {
    error: 'google_reauthorization_required',
  });
  assert.equal(
    (
      await authenticated(rejected.app, '/api/sessions', rejectedSession.sessionToken, {
        method: 'GET',
      })
    ).status,
    401,
  );

  const unavailable = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }],
    refreshResponses: [
      { status: 503, body: { error: 'server_error', detail: 'do not expose' } },
    ],
  });
  const unavailableSession = await authorizeDevice(unavailable.app, 'device-alpha');
  const unavailableResponse = await authenticated(
    unavailable.app,
    '/api/google/access-token',
    unavailableSession.sessionToken,
    { method: 'POST' },
  );
  assert.equal(unavailableResponse.status, 503);
  assert.deepEqual(await unavailableResponse.json(), {
    error: 'google_temporarily_unavailable',
  });

  const malformed = harness({
    codeResponses: [{ body: tokenBody('one', 'refresh') }],
    refreshResponses: [{ body: { expires_in: 3600 } }],
  });
  const malformedSession = await authorizeDevice(malformed.app, 'device-alpha');
  const malformedResponse = await authenticated(
    malformed.app,
    '/api/google/access-token',
    malformedSession.sessionToken,
    { method: 'POST' },
  );
  assert.equal(malformedResponse.status, 502);
  assert.deepEqual(await malformedResponse.json(), {
    error: 'google_invalid_response',
  });
});

test('D1 migration contains only authentication/session metadata and no study or Drive content model', () => {
  const migration = readFileSync(
    new URL('../migrations/0001_auth.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /encrypted_refresh_token/u);
  assert.match(migration, /token_hash/u);
  assert.match(migration, /authorization_grants/u);
  assert.doesNotMatch(
    migration,
    /\b(?:pdf|annotation|note|document_content|drive_file_id|folder_id)\b/iu,
  );

  const temporarySessionMigration = readFileSync(
    new URL('../migrations/0002_temporary_sessions.sql', import.meta.url),
    'utf8',
  );
  assert.match(temporarySessionMigration, /session_mode/u);
  assert.match(temporarySessionMigration, /expires_at/u);
  assert.match(
    temporarySessionMigration,
    /DEFAULT\s+'personal'/u,
    'existing device sessions must remain personal sessions',
  );
  assert.doesNotMatch(
    temporarySessionMigration,
    /\b(?:pdf|annotation|note|document_content|drive_file_id|folder_id)\b/iu,
  );
  assert.throws(
    () => readFileSync(new URL('../migrations/0003_oauth_realms.sql', import.meta.url)),
    /ENOENT/u,
  );
});

test('single-realm Worker source has no abandoned OAuth realm configuration', () => {
  const source = [
    '../src/app.ts',
    '../src/store.ts',
    '../src/types.ts',
    '../src/crypto.ts',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /GOOGLE_V3_CLIENT|OAuthRealm|oauthRealmConfiguration/u);
  assert.doesNotMatch(source, /\/api\/v3\/oauth\/(?:start|callback|exchange)/u);
});

test('temporary-session Worker changes remain authentication-only', () => {
  const source = [
    '../src/app.ts',
    '../src/security.ts',
    '../src/store.ts',
    '../src/types.ts',
    '../migrations/0002_temporary_sessions.sql',
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    source,
    /\b(?:pdf|annotation|note_body|document_content|print_draft|ai_api_key)\b/iu,
  );
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/drive\.file/u);
});

type DeviceSessionMode = 'personal' | 'temporary';

interface AuthorizedDevice {
  sessionToken: string;
  accountId: string;
  session: {
    id: string;
    deviceId: string;
    createdAt: number;
    lastUsedAt: number;
    sessionMode: DeviceSessionMode;
    expiresAt: number | null;
    current: boolean;
  };
  sessionCount: number;
  sessionMode: DeviceSessionMode;
  expiresAt: number | null;
}

async function startAuthorization(
  app: (request: Request) => Promise<Response>,
  deviceId: string,
  verifier: string,
  sessionMode?: DeviceSessionMode,
) {
  const response = await api(app, '/api/oauth/start', {
    deviceId,
    exchangeChallenge: await sha256Base64Url(verifier),
    returnUrl: `${ORIGIN}/reader`,
    ...(sessionMode ? { sessionMode } : {}),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { authorizationUrl: string };
  const authorization = new URL(body.authorizationUrl);
  return { authorization, state: authorization.searchParams.get('state') ?? '' };
}

async function authorizeDevice(
  app: (request: Request) => Promise<Response>,
  deviceId: string,
  sessionMode?: DeviceSessionMode,
): Promise<AuthorizedDevice> {
  const verifier = randomToken();
  const started = await startAuthorization(app, deviceId, verifier, sessionMode);
  const callback = await app(
    new Request(
      `${WORKER_ORIGIN}/api/oauth/callback?state=${encodeURIComponent(started.state)}&code=valid-code`,
    ),
  );
  assert.equal(callback.status, 303);
  const grant = redirectFragment(callback).get('sync_auth_grant');
  assert.ok(grant);
  const exchange = await exchangeGrant(app, grant, verifier, deviceId);
  assert.equal(exchange.status, 200);
  return (await exchange.json()) as AuthorizedDevice;
}

function exchangeGrant(
  app: (request: Request) => Promise<Response>,
  grant: string,
  verifier: string,
  deviceId: string,
  origin = ORIGIN,
) {
  return api(
    app,
    '/api/oauth/exchange',
    { grant, exchangeVerifier: verifier, deviceId },
    origin,
  );
}

function api(
  app: (request: Request) => Promise<Response>,
  path: string,
  body: unknown,
  origin = ORIGIN,
) {
  return app(
    new Request(`${WORKER_ORIGIN}${path}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function authenticated(
  app: (request: Request) => Promise<Response>,
  path: string,
  token: string,
  init: RequestInit,
) {
  return app(
    new Request(`${WORKER_ORIGIN}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Origin: ORIGIN,
        Authorization: `Bearer ${token}`,
      },
    }),
  );
}

function redirectFragment(response: Response): URLSearchParams {
  const location = response.headers.get('Location');
  assert.ok(location);
  return new URLSearchParams(new URL(location).hash.replace(/^#/u, ''));
}

function tokenBody(accessToken: string, refreshToken?: string) {
  return {
    access_token: accessToken,
    expires_in: 3600,
    scope: GOOGLE_DRIVE_SCOPE,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

function googleStub(options: GoogleStubOptions) {
  const codeResponses = [...(options.codeResponses ?? [])];
  const refreshResponses = [...(options.refreshResponses ?? [])];
  const aboutResponses = [...(options.aboutResponses ?? [])];
  const counters = { refreshCalls: 0, revokeCalls: 0 };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (body.get('grant_type') === 'refresh_token') {
        counters.refreshCalls += 1;
        return stubResponse(
          refreshResponses.shift() ?? { body: tokenBody('refreshed-access') },
        );
      }
      return stubResponse(
        codeResponses.shift() ?? { body: tokenBody('code-access', 'refresh-token') },
      );
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/about') {
      return stubResponse(
        aboutResponses.shift() ?? {
          body: { user: { permissionId: 'opaque-drive-user' } },
        },
      );
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      counters.revokeCalls += 1;
      return stubResponse(options.revokeResponse ?? { status: 200, body: {} });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  return {
    fetcher: fetcher as typeof fetch,
    get refreshCalls() {
      return counters.refreshCalls;
    },
    get revokeCalls() {
      return counters.revokeCalls;
    },
  };
}

function stubResponse(value: { status?: number; body?: unknown }): Response {
  return Response.json(value.body ?? {}, { status: value.status ?? 200 });
}
