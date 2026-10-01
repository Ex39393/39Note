import {
  decryptRefreshToken,
  encryptRefreshToken,
  randomToken,
  sha256Base64Url,
} from './crypto.ts';
import {
  exchangeGoogleCode,
  getGoogleDriveSubject,
  GoogleServiceError,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from './google.ts';
import {
  ALLOWED_ORIGINS,
  CHALLENGE_PATTERN,
  DEVICE_ID_PATTERN,
  GOOGLE_DRIVE_SCOPE,
  PublicError,
  requireAllowedOrigin,
  validateReturnUrl,
} from './security.ts';
import { D1AuthStore } from './store.ts';
import type {
  AuthStore,
  AuthenticatedSession,
  DeviceSessionMode,
  Env,
  UserRecord,
} from './types.ts';

const OAUTH_STATE_TTL = 10 * 60_000;
const AUTHORIZATION_GRANT_TTL = 3 * 60_000;
const LAST_USED_WRITE_INTERVAL = 15 * 60_000;
export const TEMPORARY_SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60_000;
const MAX_JSON_BYTES = 8_192;
const AUTHENTICATED_API_ROUTES = new Set([
  'POST /api/google/access-token',
  'GET /api/sessions',
  'POST /api/session/disconnect',
  'POST /api/session/disconnect-all',
]);

export interface AppDependencies {
  store?: AuthStore;
  fetcher?: typeof fetch;
  now?: () => number;
}

export function createApp(env: Env, dependencies: AppDependencies = {}) {
  const store = dependencies.store ?? new D1AuthStore(env.DB);
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async (request: Request): Promise<Response> => {
    let corsOrigin: string | undefined;
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const callbackUrl = `${url.origin}/api/oauth/callback`;
      if (request.method === 'OPTIONS') return handleOptions(request);
      if (request.method === 'GET' && url.pathname === '/health') {
        corsOrigin = optionalAllowedOrigin(request);
        return json(
          { status: 'ok', service: '39note-sync-auth', workerSchemaVersion: 2 },
          200,
          corsOrigin,
        );
      }
      if (request.method === 'POST' && path === '/api/oauth/start') {
        corsOrigin = requireAllowedOrigin(request);
        const configuration = oauthConfiguration(env);
        const body = await readJson(request);
        const deviceId = requireDeviceId(body.deviceId);
        const exchangeChallenge = requireChallenge(body.exchangeChallenge);
        const returnUrl = validateReturnUrl(body.returnUrl, corsOrigin);
        const sessionMode = requireSessionMode(body.sessionMode);
        const limiterKey = `oauth-start:${await sha256Base64Url(`${corsOrigin}:${deviceId}`)}`;
        if (!(await store.checkRateLimit(limiterKey, now(), 10 * 60_000, 10))) {
          throw new PublicError('rate_limited', 429);
        }
        await store.deleteExpiredEphemera(now());
        const state = randomToken();
        const stateHash = await sha256Base64Url(state);
        const googleCodeVerifier = randomToken(64);
        const googleCodeChallenge = await sha256Base64Url(googleCodeVerifier);
        const createdAt = now();
        await store.createOAuthState({
          stateHash,
          googleCodeVerifier,
          deviceId,
          exchangeChallenge,
          returnOrigin: corsOrigin,
          returnUrl,
          sessionMode,
          createdAt,
          expiresAt: createdAt + OAUTH_STATE_TTL,
          usedAt: null,
        });
        const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authorization.search = new URLSearchParams({
          client_id: configuration.clientId,
          redirect_uri: callbackUrl,
          response_type: 'code',
          scope: GOOGLE_DRIVE_SCOPE,
          access_type: 'offline',
          include_granted_scopes: 'true',
          state,
          code_challenge: googleCodeChallenge,
          code_challenge_method: 'S256',
          ...(body.forceConsent === true || body.switchAccount === true
            ? {
                prompt:
                  body.switchAccount === true ? 'consent select_account' : 'consent',
              }
            : {}),
        }).toString();
        return json({ authorizationUrl: authorization.toString() }, 200, corsOrigin);
      }
      if (request.method === 'GET' && path === '/api/oauth/callback') {
        return await handleOAuthCallback(url, store, fetcher, env, now, callbackUrl);
      }
      if (request.method === 'POST' && path === '/api/oauth/exchange') {
        corsOrigin = requireAllowedOrigin(request);
        const body = await readJson(request);
        const grant = requireOpaqueToken(body.grant);
        const exchangeVerifier = requireOpaqueToken(body.exchangeVerifier);
        const deviceId = requireDeviceId(body.deviceId);
        const grantHash = await sha256Base64Url(grant);
        const record = await store.getAuthorizationGrant(grantHash);
        const timestamp = now();
        if (!record || record.usedAt !== null || record.expiresAt < timestamp) {
          throw new PublicError('authorization_grant_invalid', 401);
        }
        const grantUser = await store.getUser(record.userId);
        if (!grantUser || grantUser.revokedAt !== null)
          throw new PublicError('authorization_grant_invalid', 401);
        if (record.returnOrigin !== corsOrigin)
          throw new PublicError('authorization_grant_origin_mismatch', 401);
        if (record.deviceId !== deviceId)
          throw new PublicError('authorization_grant_device_mismatch', 401);
        if ((await sha256Base64Url(exchangeVerifier)) !== record.exchangeChallenge) {
          throw new PublicError('authorization_grant_verifier_mismatch', 401);
        }
        if (!(await store.markAuthorizationGrantUsed(grantHash, timestamp))) {
          throw new PublicError('authorization_grant_invalid', 401);
        }
        await store.revokeDeviceSessions(record.userId, deviceId, timestamp);
        const sessionToken = randomToken();
        const session = {
          id: crypto.randomUUID(),
          userId: record.userId,
          deviceId,
          tokenHash: await sha256Base64Url(sessionToken),
          sessionMode: record.sessionMode,
          expiresAt:
            record.sessionMode === 'temporary'
              ? timestamp + TEMPORARY_SESSION_ABSOLUTE_TTL_MS
              : null,
          createdAt: timestamp,
          lastUsedAt: timestamp,
          revokedAt: null,
        };
        await store.createDeviceSession(session);
        const sessions = await store.listDeviceSessions(record.userId, timestamp);
        return json(
          {
            sessionToken,
            session: publicSession(session, session.id),
            sessionCount: sessions.length,
            accountId: record.userId,
            sessionMode: session.sessionMode,
            expiresAt: session.expiresAt,
          },
          200,
          corsOrigin,
        );
      }

      if (AUTHENTICATED_API_ROUTES.has(`${request.method} ${path}`)) {
        corsOrigin = requireAllowedOrigin(request);
        const session = await authenticate(request, store, now());
        const limiterKey = `session:${session.id}`;
        if (!(await store.checkRateLimit(limiterKey, now(), 60_000, 60))) {
          throw new PublicError('rate_limited', 429);
        }
        if (request.method === 'POST' && path === '/api/google/access-token') {
          const configuration = oauthConfiguration(env);
          const refreshToken = await decryptStoredRefreshToken(
            session.user,
            env.TOKEN_ENCRYPTION_KEY,
          );
          let tokenSet;
          try {
            tokenSet = await refreshGoogleAccessToken(fetcher, {
              refreshToken,
              ...configuration,
            });
          } catch (error) {
            if (
              error instanceof GoogleServiceError &&
              error.code === 'refresh_rejected'
            ) {
              await store.revokeUserAndSessions(session.userId, now());
              throw new PublicError('google_reauthorization_required', 401);
            }
            throw mapGoogleError(error);
          }
          if (tokenSet.refreshToken) {
            const encrypted = await encryptRefreshToken(
              tokenSet.refreshToken,
              env.TOKEN_ENCRYPTION_KEY,
            );
            await store.updateUserToken(
              session.userId,
              encrypted.ciphertext,
              encrypted.iv,
              encrypted.keyVersion,
              tokenSet.grantedScopes,
              now(),
            );
          }
          return json(
            {
              accessToken: tokenSet.accessToken,
              expiresAt: now() + tokenSet.expiresIn * 1_000,
            },
            200,
            corsOrigin,
          );
        }
        if (request.method === 'GET' && path === '/api/sessions') {
          const sessions = await store.listDeviceSessions(session.userId, now());
          return json(
            {
              accountId: session.userId,
              sessions: sessions.map((item) => publicSession(item, session.id)),
              sessionCount: sessions.length,
            },
            200,
            corsOrigin,
          );
        }
        if (request.method === 'POST' && path === '/api/session/disconnect') {
          await store.revokeSession(session.id, now());
          return json({ disconnected: true }, 200, corsOrigin);
        }
        if (request.method === 'POST' && path === '/api/session/disconnect-all') {
          const body = await readJson(request);
          if (body.confirm !== 'DISCONNECT_ALL')
            throw new PublicError('confirmation_required', 400);
          const refreshToken = await decryptStoredRefreshToken(
            session.user,
            env.TOKEN_ENCRYPTION_KEY,
          );
          await store.revokeUserAndSessions(session.userId, now());
          const googleRevocationAccepted = await revokeGoogleToken(
            fetcher,
            refreshToken,
          );
          return json(
            { disconnected: true, googleRevocationAccepted },
            200,
            corsOrigin,
          );
        }
      }
      return json({ error: 'not_found' }, 404, corsOrigin);
    } catch (error) {
      if (error instanceof PublicError)
        return json({ error: error.code }, error.status, corsOrigin);
      if (error instanceof GoogleServiceError) {
        const mapped = mapGoogleError(error);
        return json({ error: mapped.code }, mapped.status, corsOrigin);
      }
      return json({ error: 'internal_error' }, 500, corsOrigin);
    }
  };
}

async function handleOAuthCallback(
  url: URL,
  store: AuthStore,
  fetcher: typeof fetch,
  env: Env,
  now: () => number,
  callbackUrl: string,
): Promise<Response> {
  const rawState = url.searchParams.get('state');
  if (!rawState || rawState.length > 1_000)
    return callbackFailure('oauth_state_invalid', 400);
  const stateHash = await sha256Base64Url(rawState);
  const state = await store.getOAuthState(stateHash);
  const timestamp = now();
  if (!state || state.usedAt !== null || state.expiresAt < timestamp) {
    return callbackFailure('oauth_state_invalid', 400);
  }
  if (!(await store.markOAuthStateUsed(stateHash, timestamp))) {
    return callbackFailure('oauth_state_invalid', 400);
  }
  if (url.searchParams.has('error')) {
    return redirectWithFragment(state.returnUrl, {
      sync_auth_error: 'authorization_cancelled',
    });
  }
  const code = url.searchParams.get('code');
  if (!code || code.length > 4_096) {
    return redirectWithFragment(state.returnUrl, {
      sync_auth_error: 'authorization_response_invalid',
    });
  }
  try {
    const configuration = oauthConfiguration(env);
    const tokenSet = await exchangeGoogleCode(fetcher, {
      code,
      codeVerifier: state.googleCodeVerifier,
      redirectUri: callbackUrl,
      ...configuration,
    });
    const googleSubject = await getGoogleDriveSubject(fetcher, tokenSet.accessToken);
    let user = await store.findUserByGoogleSubject(googleSubject);
    if (!tokenSet.refreshToken && (!user || user.revokedAt !== null)) {
      return redirectWithFragment(state.returnUrl, {
        sync_auth_error: 'refresh_token_missing',
        sync_auth_action: 'reconsent',
      });
    }
    if (tokenSet.refreshToken) {
      const encrypted = await encryptRefreshToken(
        tokenSet.refreshToken,
        env.TOKEN_ENCRYPTION_KEY,
      );
      if (user) {
        await store.updateUserToken(
          user.id,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.keyVersion,
          tokenSet.grantedScopes,
          timestamp,
        );
        user = { ...user, revokedAt: null };
      } else {
        user = {
          id: crypto.randomUUID(),
          googleSubject,
          encryptedRefreshToken: encrypted.ciphertext,
          refreshTokenIv: encrypted.iv,
          encryptionKeyVersion: encrypted.keyVersion,
          grantedScopes: tokenSet.grantedScopes,
          createdAt: timestamp,
          updatedAt: timestamp,
          revokedAt: null,
        };
        await store.createUser(user);
        user = (await store.findUserByGoogleSubject(googleSubject)) ?? user;
      }
    }
    if (!user) throw new PublicError('refresh_token_missing', 401);
    const grant = randomToken();
    await store.createAuthorizationGrant({
      grantHash: await sha256Base64Url(grant),
      userId: user.id,
      deviceId: state.deviceId,
      exchangeChallenge: state.exchangeChallenge,
      returnOrigin: state.returnOrigin,
      sessionMode: state.sessionMode,
      createdAt: timestamp,
      expiresAt: timestamp + AUTHORIZATION_GRANT_TTL,
      usedAt: null,
    });
    return redirectWithFragment(state.returnUrl, { sync_auth_grant: grant });
  } catch (error) {
    const mapped = error instanceof PublicError ? error : mapGoogleError(error);
    return redirectWithFragment(state.returnUrl, {
      sync_auth_error: mapped.code,
      ...(mapped.code === 'authorization_rejected'
        ? { sync_auth_action: 'reconsent' }
        : {}),
    });
  }
}

async function authenticate(
  request: Request,
  store: AuthStore,
  timestamp: number,
): Promise<AuthenticatedSession> {
  const authorization = request.headers.get('Authorization');
  const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u);
  if (!match) throw new PublicError('session_invalid', 401);
  const session = await store.getAuthenticatedSession(
    await sha256Base64Url(match[1]),
    timestamp,
  );
  if (!session) throw new PublicError('session_invalid', 401);
  await store.touchSession(session.id, timestamp, timestamp - LAST_USED_WRITE_INTERVAL);
  return session;
}

async function decryptStoredRefreshToken(
  user: UserRecord,
  key: string,
): Promise<string> {
  if (user.encryptionKeyVersion !== 1)
    throw new PublicError('encryption_key_version_unsupported', 500);
  try {
    return await decryptRefreshToken(
      user.encryptedRefreshToken,
      user.refreshTokenIv,
      requireSecret(key, 'TOKEN_ENCRYPTION_KEY'),
    );
  } catch {
    throw new PublicError('refresh_token_unavailable', 500);
  }
}

function handleOptions(request: Request): Response {
  const origin = requireAllowedOrigin(request);
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers') ?? '';
  const headers = requestedHeaders
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (headers.some((header) => !['authorization', 'content-type'].includes(header))) {
    throw new PublicError('cors_headers_not_allowed', 403);
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    }),
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? 0);
  if (contentLength > MAX_JSON_BYTES) throw new PublicError('request_too_large', 413);
  if (
    !(request.headers.get('Content-Type') ?? '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    throw new PublicError('content_type_required', 415);
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new PublicError('request_too_large', 413);
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch {
    throw new PublicError('invalid_json', 400);
  }
}

function requireDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value))
    throw new PublicError('invalid_device_id', 400);
  return value;
}

function requireChallenge(value: unknown): string {
  if (typeof value !== 'string' || !CHALLENGE_PATTERN.test(value))
    throw new PublicError('invalid_exchange_challenge', 400);
  return value;
}

function requireSessionMode(value: unknown): DeviceSessionMode {
  if (value === undefined || value === 'personal') return 'personal';
  if (value === 'temporary') return 'temporary';
  throw new PublicError('invalid_session_mode', 400);
}

function requireOpaqueToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/u.test(value)) {
    throw new PublicError('invalid_request', 400);
  }
  return value;
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new PublicError(`missing_${name.toLowerCase()}`, 500);
  return value.trim();
}

function oauthConfiguration(env: Env) {
  return {
    clientId: requireSecret(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'),
    clientSecret: requireSecret(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET'),
  };
}

function publicSession(
  session: {
    id: string;
    deviceId: string;
    createdAt: number;
    lastUsedAt: number;
    sessionMode: DeviceSessionMode;
    expiresAt: number | null;
  },
  currentSessionId: string,
) {
  return {
    id: session.id,
    deviceId: session.deviceId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    sessionMode: session.sessionMode,
    expiresAt: session.expiresAt,
    current: session.id === currentSessionId,
  };
}

function optionalAllowedOrigin(request: Request): string | undefined {
  const origin = request.headers.get('Origin');
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : undefined;
}

function json(value: unknown, status: number, origin?: string): Response {
  return Response.json(value, {
    status,
    headers: corsHeaders(origin, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}

function corsHeaders(
  origin?: string,
  additional: Record<string, string> = {},
): Headers {
  const headers = new Headers(additional);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function redirectWithFragment(
  returnUrl: string,
  values: Record<string, string>,
): Response {
  const url = new URL(returnUrl);
  url.hash = new URLSearchParams(values).toString();
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function callbackFailure(code: string, status: number): Response {
  return new Response(`39Note Google Drive authorization failed: ${code}`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function mapGoogleError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;
  if (error instanceof GoogleServiceError)
    return new PublicError(error.code, error.status);
  return new PublicError('google_temporarily_unavailable', 503);
}
