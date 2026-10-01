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

export class GoogleAuthorizationCancelledError extends Error {
  constructor() {
    super('Google Drive authorization was cancelled.');
    this.name = 'GoogleAuthorizationCancelledError';
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

  configure(
    backendUrl: string,
    deviceId: string,
    deviceSessionToken?: string,
    sessionMode: 'personal' | 'temporary' = 'personal',
  ): void {
    this.backendUrl = validateSyncAuthUrl(backendUrl);
    this.deviceId = deviceId;
    this.sessionMode = sessionMode;
    const temporary =
      sessionMode === 'temporary'
        ? readTemporarySession(TEMPORARY_SESSION_STORAGE_KEY)
        : null;
    this.deviceSessionToken =
      sessionMode === 'temporary'
        ? (temporary?.sessionToken ?? null)
        : deviceSessionToken || null;
    this.accountIdValue = temporary?.accountId ?? null;
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
    options: { forceConsent?: boolean; switchAccount?: boolean } = {},
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
    sessionStorage.setItem(EXCHANGE_STORAGE_KEY, JSON.stringify(pending));
    const returnUrl = new URL(window.location.href);
    returnUrl.hash = '';
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
      },
      false,
    );
    const body = await readJson<{ authorizationUrl?: unknown }>(response);
    if (typeof body.authorizationUrl !== 'string') {
      sessionStorage.removeItem(EXCHANGE_STORAGE_KEY);
      throw new SyncBackendUnavailableError();
    }
    window.location.assign(body.authorizationUrl);
    return new Promise<never>(() => undefined);
  }

  async completeAuthorizationIfPresent(): Promise<AuthorizationExchange | null> {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ''));
    const grant = fragment.get('sync_auth_grant');
    const error = fragment.get('sync_auth_error');
    if (!grant && !error) return null;
    clearAuthorizationFragment();
    const pending = readPendingExchange(EXCHANGE_STORAGE_KEY);
    sessionStorage.removeItem(EXCHANGE_STORAGE_KEY);
    if (error) {
      throw mapAuthorizationCallbackError(error, fragment.get('sync_auth_action'));
    }
    if (
      !pending ||
      pending.backendUrl !== this.backendUrl ||
      pending.deviceId !== this.deviceId
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
      typeof body.accountId !== 'string' ||
      (body.sessionMode !== 'personal' && body.sessionMode !== 'temporary') ||
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
        TEMPORARY_SESSION_STORAGE_KEY,
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

async function brokerRequest(
  url: string,
  init: RequestInit,
  retry: boolean,
): Promise<Response> {
  const attempts = retry ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, init);
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
    if (response.status >= 500) throw new SyncBackendUnavailableError();
    throw new Error('Persistent sync service rejected the request.');
  }
  throw new SyncBackendUnavailableError();
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
      typeof value.accountId === 'string' &&
      value.accountId.length > 0 &&
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
