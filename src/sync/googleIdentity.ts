import { scopedLocalStorageKey } from '../services/temporaryWorkspace.ts';

export interface GoogleAccessToken {
  value: string;
  expiresAt: number;
}

export interface GoogleDeviceSessionSummary {
  id: string;
  deviceId: string;
  createdAt: number;
  lastUsedAt: number;
  current: boolean;
  sessionMode: 'personal' | 'temporary';
  expiresAt: number | null;
}

export interface AuthorizationExchange {
  sessionToken: string;
  session: GoogleDeviceSessionSummary;
  sessionCount: number;
  accountId: string;
  sessionMode: 'personal' | 'temporary';
  expiresAt: number | null;
}

interface PendingExchange {
  backendUrl: string;
  deviceId: string;
  verifier: string;
  createdAt: number;
  sessionMode: 'personal' | 'temporary';
}

const EXCHANGE_STORAGE_KEY = '39note.google-drive.pending-exchange';
const TEMPORARY_SESSION_STORAGE_KEY = '39note.google-drive.temporary-session';
const EXCHANGE_MAX_AGE = 15 * 60_000;
const AUTHORIZATION_START_TIMEOUT_MS = 15_000;
const BROKER_REQUEST_TIMEOUT_MS = 30_000;

export type GoogleAuthorizationStartFailure =
  'request-failed' | 'request-timed-out' | 'response-invalid' | 'navigation-failed';

export class SyncBackendUnavailableError extends Error {
  constructor() {
    super(
      'Persistent sync service is temporarily unavailable. Local work remains available and queued.',
    );
    this.name = 'SyncBackendUnavailableError';
  }
}

export class SyncServiceRateLimitedError extends Error {
  constructor() {
    super('Google Drive sign-in service is temporarily rate-limiting requests.');
    this.name = 'SyncServiceRateLimitedError';
  }
}

export class SyncOriginNotAllowedError extends Error {
  constructor() {
    super(
      'This 39Note app address is not configured for Google Drive sign-in. Use an approved 39Note address and try again.',
    );
    this.name = 'SyncOriginNotAllowedError';
  }
}

export class GoogleAuthorizationCancelledError extends Error {
  constructor() {
    super('Google Drive authorization was cancelled.');
    this.name = 'GoogleAuthorizationCancelledError';
  }
}

/**
 * A redacted pre-authorization failure. The reason is intentionally limited to
 * lifecycle phases and never includes a URL, OAuth state, verifier, or provider
 * response.
 */
export class GoogleAuthorizationStartError extends Error {
  readonly reason: GoogleAuthorizationStartFailure;

  constructor(reason: GoogleAuthorizationStartFailure) {
    super('Google Drive sign-in could not be started. Your local data is safe.');
    this.name = 'GoogleAuthorizationStartError';
    this.reason = reason;
  }
}

export class GoogleReauthorizationRequiredError extends Error {
  readonly clearDeviceSession: boolean;

  constructor(
    message = 'Google authorization must be renewed before syncing can continue.',
    clearDeviceSession = false,
  ) {
    super(message);
    this.name = 'GoogleReauthorizationRequiredError';
    this.clearDeviceSession = clearDeviceSession;
  }
}

export class PersistentGoogleAuthSession {
  private backendUrl = '';
  private deviceId = '';
  private deviceSessionToken: string | null = null;
  private accessTokenValue: GoogleAccessToken | null = null;
  private sessionMode: 'personal' | 'temporary' = 'personal';
  private accountIdValue: string | null = null;
  private sessionExpiresAtValue: number | null = null;
  private readonly brokerRequestTimeoutMs: number;

  constructor(options: { brokerRequestTimeoutMs?: number } = {}) {
    const requestedTimeout = options.brokerRequestTimeoutMs;
    this.brokerRequestTimeoutMs =
      typeof requestedTimeout === 'number' &&
      Number.isFinite(requestedTimeout) &&
      requestedTimeout > 0
        ? requestedTimeout
        : BROKER_REQUEST_TIMEOUT_MS;
  }

  configure(
    backendUrl: string,
    deviceId: string,
    deviceSessionToken?: string,
    sessionMode: 'personal' | 'temporary' = 'personal',
    persistedVerifiedAccountId?: string,
  ): void {
    this.backendUrl = validateSyncAuthUrl(backendUrl);
    this.deviceId = deviceId;
    this.sessionMode = sessionMode;
    const temporary =
      sessionMode === 'temporary'
        ? readTemporarySession(temporarySessionStorageKey())
        : null;
    this.deviceSessionToken =
      sessionMode === 'temporary'
        ? (temporary?.sessionToken ?? null)
        : deviceSessionToken || null;
    this.accountIdValue =
      temporary?.accountId ??
      (this.deviceSessionToken && persistedVerifiedAccountId
        ? persistedVerifiedAccountId
        : null);
    this.sessionExpiresAtValue = temporary?.expiresAt ?? null;
    this.accessTokenValue = null;
  }

  get hasDeviceSession(): boolean {
    return Boolean(this.deviceSessionToken);
  }

  get hasUsableToken(): boolean {
    return Boolean(
      this.accessTokenValue && this.accessTokenValue.expiresAt > Date.now() + 60_000,
    );
  }

  get accessToken(): string | null {
    return this.hasUsableToken ? (this.accessTokenValue?.value ?? null) : null;
  }

  get persistedSessionToken(): string | null {
    return this.sessionMode === 'personal' ? this.deviceSessionToken : null;
  }

  get accountId(): string | null {
    return this.accountIdValue;
  }

  get currentSessionMode(): 'personal' | 'temporary' {
    return this.sessionMode;
  }

  get sessionExpiresAt(): number | null {
    return this.sessionExpiresAtValue;
  }

  async beginAuthorization(
    options: {
      forceConsent?: boolean;
      switchAccount?: boolean;
      /** Focused-test override; production callers use the bounded default. */
      requestTimeoutMs?: number;
      /** Local lifecycle hook invoked only after a valid authorization URL exists. */
      beforeNavigation?: () => void | Promise<void>;
      /** Reverses a local lifecycle handoff if same-tab navigation cannot start. */
      onNavigationFailure?: () => void | Promise<void>;
    } = {},
  ): Promise<never> {
    this.requireConfiguration();
    const verifier = randomBrowserToken();
    const exchangeChallenge = await sha256Base64Url(verifier);
    const pending: PendingExchange = {
      backendUrl: this.backendUrl,
      deviceId: this.deviceId,
      verifier,
      createdAt: Date.now(),
      sessionMode: this.sessionMode,
    };
    const exchangeStorageKey = this.exchangeStorageKey();
    // A new explicit attempt supersedes any abandoned same-tab attempt. Keep
    // the verifier in memory until an authorization URL has been obtained so a
    // rejected pre-auth request cannot leave stale exchange state behind.
    sessionStorage.removeItem(exchangeStorageKey);
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = '';
    const controller = new AbortController();
    let requestTimedOut = false;
    const timeout = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, options.requestTimeoutMs ?? AUTHORIZATION_START_TIMEOUT_MS);
    let body: { authorizationUrl?: unknown };
    try {
      const response = await brokerRequest(
        `${this.backendUrl}/api/oauth/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: this.deviceId,
            exchangeChallenge,
            returnUrl: returnUrl.toString(),
            forceConsent: options.forceConsent === true,
            switchAccount: options.switchAccount === true,
            sessionMode: this.sessionMode,
          }),
          signal: controller.signal,
        },
        false,
        this.brokerRequestTimeoutMs,
      );
      body = await readJson<{ authorizationUrl?: unknown }>(response);
    } catch (error) {
      if (requestTimedOut) {
        throw new GoogleAuthorizationStartError('request-timed-out');
      }
      if (
        error instanceof SyncBackendUnavailableError ||
        error instanceof SyncServiceRateLimitedError ||
        error instanceof SyncOriginNotAllowedError
      ) {
        throw error;
      }
      throw new GoogleAuthorizationStartError('request-failed');
    } finally {
      clearTimeout(timeout);
    }
    const authorizationUrl = validateAuthorizationNavigationUrl(
      body.authorizationUrl,
      this.backendUrl,
    );
    sessionStorage.setItem(exchangeStorageKey, JSON.stringify(pending));
    try {
      await options.beforeNavigation?.();
      // This flow intentionally uses same-tab navigation. It does not use a
      // popup, postMessage, or window.open(), so popup blocking is irrelevant.
      window.location.assign(authorizationUrl);
    } catch {
      sessionStorage.removeItem(exchangeStorageKey);
      try {
        await options.onNavigationFailure?.();
      } catch {
        // The original navigation failure remains authoritative. A failed
        // best-effort lifecycle rollback must not hide it.
      }
      throw new GoogleAuthorizationStartError('navigation-failed');
    }
    return new Promise<never>(() => undefined);
  }

  async completeAuthorizationIfPresent(): Promise<AuthorizationExchange | null> {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
    const grant = fragment.get('sync_auth_grant');
    const error = fragment.get('sync_auth_error');
    if (!grant && !error) return null;
    clearAuthorizationFragment();
    const exchangeStorageKey = this.exchangeStorageKey();
    const pending = readPendingExchange(exchangeStorageKey);
    sessionStorage.removeItem(exchangeStorageKey);
    if (error) {
      throw mapAuthorizationCallbackError(error, fragment.get('sync_auth_action'));
    }
    if (
      !pending ||
      pending.backendUrl !== this.backendUrl ||
      pending.deviceId !== this.deviceId ||
      pending.sessionMode !== this.sessionMode
    ) {
      throw new GoogleReauthorizationRequiredError(
        'The one-time authorization exchange expired. Connect Google Drive again.',
      );
    }
    const response = await brokerRequest(
      `${this.backendUrl}/api/oauth/exchange`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant,
          exchangeVerifier: pending.verifier,
          deviceId: this.deviceId,
        }),
      },
      false,
      this.brokerRequestTimeoutMs,
    );
    if (response.status === 401) {
      throw new GoogleReauthorizationRequiredError(
        'The one-time authorization exchange was rejected. Connect Google Drive again.',
      );
    }
    const body = await readJson<Partial<AuthorizationExchange>>(response);
    if (
      !isSessionToken(body.sessionToken) ||
      !isSessionSummary(body.session) ||
      typeof body.sessionCount !== 'number' ||
      !isAccountId(body.accountId) ||
      (body.sessionMode !== 'personal' && body.sessionMode !== 'temporary') ||
      body.sessionMode !== pending.sessionMode ||
      (body.expiresAt !== null && typeof body.expiresAt !== 'number')
    ) {
      throw new SyncBackendUnavailableError();
    }
    this.deviceSessionToken = body.sessionToken;
    this.sessionMode = body.sessionMode;
    this.accountIdValue = body.accountId;
    this.sessionExpiresAtValue = body.expiresAt;
    if (body.sessionMode === 'temporary') {
      writeTemporarySession(
        {
          sessionToken: body.sessionToken,
          accountId: body.accountId,
          expiresAt: body.expiresAt,
        },
        temporarySessionStorageKey(),
      );
    } else {
      sessionStorage.removeItem(TEMPORARY_SESSION_STORAGE_KEY);
    }
    this.accessTokenValue = null;
    return body as AuthorizationExchange;
  }

  async ensureAccessToken(forceRefresh = false): Promise<GoogleAccessToken> {
    this.requireConfiguration();
    if (!forceRefresh && this.hasUsableToken && this.accessTokenValue)
      return this.accessTokenValue;
    const response = await this.authenticatedRequest(
      '/api/google/access-token',
      { method: 'POST' },
      true,
    );
    const body = await readJson<{
      accessToken?: unknown;
      expiresAt?: unknown;
    }>(response);
    if (
      typeof body.accessToken !== 'string' ||
      typeof body.expiresAt !== 'number' ||
      body.expiresAt <= Date.now()
    ) {
      throw new SyncBackendUnavailableError();
    }
    this.accessTokenValue = { value: body.accessToken, expiresAt: body.expiresAt };
    return this.accessTokenValue;
  }

  async listSessions(): Promise<GoogleDeviceSessionSummary[]> {
    const response = await this.authenticatedRequest(
      '/api/sessions',
      { method: 'GET' },
      true,
    );
    const body = await readJson<{ sessions?: unknown }>(response);
    return Array.isArray(body.sessions) ? body.sessions.filter(isSessionSummary) : [];
  }

  async disconnectCurrent(): Promise<void> {
    await this.authenticatedRequest(
      '/api/session/disconnect',
      { method: 'POST' },
      false,
    );
    this.clearLocalSession();
  }

  async disconnectAll(): Promise<void> {
    await this.authenticatedRequest(
      '/api/session/disconnect-all',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DISCONNECT_ALL' }),
      },
      false,
    );
    this.clearLocalSession();
  }

  clearAccessToken(): void {
    this.accessTokenValue = null;
  }

  clearLocalSession(): void {
    this.accessTokenValue = null;
    this.deviceSessionToken = null;
    this.accountIdValue = null;
    this.sessionExpiresAtValue = null;
    sessionStorage.removeItem(TEMPORARY_SESSION_STORAGE_KEY);
    sessionStorage.removeItem(temporarySessionStorageKey());
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit,
    retry: boolean,
  ): Promise<Response> {
    if (!this.deviceSessionToken)
      throw new GoogleReauthorizationRequiredError(undefined, true);
    const response = await brokerRequest(
      `${this.backendUrl}${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          Authorization: `Bearer ${this.deviceSessionToken}`,
        },
      },
      retry,
      this.brokerRequestTimeoutMs,
    );
    if (response.status === 401) {
      this.accessTokenValue = null;
      throw new GoogleReauthorizationRequiredError(undefined, true);
    }
    return response;
  }

  private requireConfiguration(): void {
    if (!this.backendUrl) throw new Error('Persistent sync backend not configured.');
    if (!this.deviceId) throw new Error('This browser does not have a sync device ID.');
  }

  private exchangeStorageKey(): string {
    return this.sessionMode === 'temporary'
      ? scopedLocalStorageKey(EXCHANGE_STORAGE_KEY)
      : EXCHANGE_STORAGE_KEY;
  }
}

function temporarySessionStorageKey(): string {
  return scopedLocalStorageKey(TEMPORARY_SESSION_STORAGE_KEY);
}

export function getBuildTimeSyncAuthUrl(): string {
  const value = (import.meta.env?.VITE_39NOTE_SYNC_AUTH_URL ?? '').trim();
  return value ? validateSyncAuthUrl(value) : '';
}

export function validateSyncAuthUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Persistent sync backend URL is invalid.');
  }
  const local =
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    url.protocol === 'http:';
  if (
    (!local && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Persistent sync backend URL must be HTTPS (or local HTTP) without credentials, query, or fragment.',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

/**
 * Fail closed if a broker response tries to navigate anywhere except Google's
 * OAuth endpoint. A loopback broker may keep navigation on its exact loopback
 * origin so disconnected development acceptance can use a local provider stub.
 */
export function validateAuthorizationNavigationUrl(
  value: unknown,
  backendUrl: string,
): string {
  if (typeof value !== 'string') {
    throw new GoogleAuthorizationStartError('response-invalid');
  }
  let authorization: URL;
  let backend: URL;
  try {
    authorization = new URL(value);
    backend = new URL(backendUrl);
  } catch {
    throw new GoogleAuthorizationStartError('response-invalid');
  }
  if (authorization.username || authorization.password || authorization.hash) {
    throw new GoogleAuthorizationStartError('response-invalid');
  }
  const googleOAuth =
    authorization.protocol === 'https:' &&
    authorization.origin === 'https://accounts.google.com' &&
    authorization.pathname === '/o/oauth2/v2/auth';
  const loopbackBroker =
    backend.protocol === 'http:' &&
    (backend.hostname === '127.0.0.1' || backend.hostname === 'localhost');
  const sameLoopbackOrigin =
    loopbackBroker &&
    authorization.protocol === 'http:' &&
    authorization.origin === backend.origin;
  if (!googleOAuth && !sameLoopbackOrigin) {
    throw new GoogleAuthorizationStartError('response-invalid');
  }
  return authorization.toString();
}

async function brokerRequest(
  url: string,
  init: RequestInit,
  retry: boolean,
  timeoutMs: number,
): Promise<Response> {
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchBrokerResponse(url, init, timeoutMs);
    } catch {
      if (attempt + 1 === attempts) throw new SyncBackendUnavailableError();
      await delay(300);
      continue;
    }
    if (response.ok) return response;
    if (response.status >= 500 && attempt + 1 < attempts) {
      await delay(300);
      continue;
    }
    if (response.status === 401) return response;
    const body: { error?: unknown } = await readJson<{ error?: unknown }>(
      response,
    ).catch(() => ({}));
    if (response.status === 429 || body.error === 'rate_limited') {
      throw new SyncServiceRateLimitedError();
    }
    if (response.status === 403 && body.error === 'origin_not_allowed') {
      throw new SyncOriginNotAllowedError();
    }
    if (response.status >= 500) throw new SyncBackendUnavailableError();
    throw new Error('Persistent sync service rejected the request.');
  }
  throw new SyncBackendUnavailableError();
}

async function fetchBrokerResponse(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  if (parentSignal?.aborted) {
    throw parentSignal.reason ?? new DOMException('Aborted', 'AbortError');
  }
  const relayParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  parentSignal?.addEventListener('abort', relayParentAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new SyncBackendUnavailableError());
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (parentSignal?.aborted) throw parentSignal.reason ?? error;
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', relayParentAbort);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new SyncBackendUnavailableError();
  }
}

function readPendingExchange(key: string): PendingExchange | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? '',
    ) as Partial<PendingExchange>;
    if (
      typeof value.backendUrl === 'string' &&
      typeof value.deviceId === 'string' &&
      typeof value.verifier === 'string' &&
      typeof value.createdAt === 'number' &&
      (value.sessionMode === 'personal' || value.sessionMode === 'temporary') &&
      value.createdAt >= Date.now() - EXCHANGE_MAX_AGE
    )
      return value as PendingExchange;
  } catch {
    return null;
  }
  return null;
}

function clearAuthorizationFragment(): void {
  const url = new URL(window.location.href);
  url.hash = '';
  history.replaceState(history.state, '', url.toString());
}

function randomBrowserToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function isSessionSummary(value: unknown): value is GoogleDeviceSessionSummary {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<GoogleDeviceSessionSummary>;
  return (
    typeof session.id === 'string' &&
    typeof session.deviceId === 'string' &&
    typeof session.createdAt === 'number' &&
    typeof session.lastUsedAt === 'number' &&
    typeof session.current === 'boolean' &&
    (session.sessionMode === 'personal' || session.sessionMode === 'temporary') &&
    (session.expiresAt === null || typeof session.expiresAt === 'number')
  );
}

interface TemporaryBrowserSession {
  sessionToken: string;
  accountId: string;
  expiresAt: number | null;
}

function readTemporarySession(key: string): TemporaryBrowserSession | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(key) ?? '',
    ) as Partial<TemporaryBrowserSession>;
    if (
      isSessionToken(value.sessionToken) &&
      isAccountId(value.accountId) &&
      (value.expiresAt === null ||
        (typeof value.expiresAt === 'number' && value.expiresAt > Date.now()))
    ) {
      return value as TemporaryBrowserSession;
    }
  } catch {
    // Malformed temporary material is ignored and removed below.
  }
  sessionStorage.removeItem(key);
  return null;
}

function writeTemporarySession(value: TemporaryBrowserSession, key: string): void {
  sessionStorage.setItem(key, JSON.stringify(value));
}

function mapAuthorizationCallbackError(error: string, action: string | null): Error {
  switch (error) {
    case 'authorization_cancelled':
      return new GoogleAuthorizationCancelledError();
    case 'google_temporarily_unavailable':
      return new SyncBackendUnavailableError();
    case 'refresh_token_missing':
      return new GoogleReauthorizationRequiredError(
        'Google did not return persistent permission. Choose Reauthorize Google Drive and approve access again.',
      );
    case 'authorization_rejected':
      return new GoogleReauthorizationRequiredError(
        'Google rejected the authorization exchange. Verify the OAuth client configuration, then choose Reauthorize Google Drive.',
      );
    case 'authorization_response_invalid':
      return new Error(
        'Google returned an incomplete authorization response. Connect Google Drive again.',
      );
    case 'google_invalid_response':
      return new Error(
        'Google returned an unexpected response during authorization. Verify that the Google Drive API is enabled, then connect again.',
      );
    default:
      if (action === 'reconsent') {
        return new GoogleReauthorizationRequiredError(
          'Google authorization must be renewed. Choose Reauthorize Google Drive and approve access again.',
        );
      }
      return new Error('Google Drive authorization could not be completed.');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
