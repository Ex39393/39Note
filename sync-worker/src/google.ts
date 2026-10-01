import { GOOGLE_DRIVE_SCOPE } from './security.ts';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_DRIVE_ABOUT_URL =
  'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';

export interface GoogleTokenSet {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  grantedScopes: string;
}

export type GoogleFailureCode =
  | 'authorization_rejected'
  | 'refresh_rejected'
  | 'google_temporarily_unavailable'
  | 'google_invalid_response';

export class GoogleServiceError extends Error {
  constructor(
    readonly code: GoogleFailureCode,
    readonly status: number,
  ) {
    super(code);
    this.name = 'GoogleServiceError';
  }
}

interface GoogleTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
  error?: unknown;
}

export async function exchangeGoogleCode(
  fetcher: typeof fetch,
  options: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<GoogleTokenSet> {
  return requestToken(
    fetcher,
    new URLSearchParams({
      code: options.code,
      code_verifier: options.codeVerifier,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
    }),
    'authorization_rejected',
  );
}

export async function refreshGoogleAccessToken(
  fetcher: typeof fetch,
  options: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<GoogleTokenSet> {
  return requestToken(
    fetcher,
    new URLSearchParams({
      refresh_token: options.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      grant_type: 'refresh_token',
    }),
    'refresh_rejected',
  );
}

export async function getGoogleDriveSubject(
  fetcher: typeof fetch,
  accessToken: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_DRIVE_ABOUT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new GoogleServiceError('google_temporarily_unavailable', 503);
  }
  if (response.status >= 500 || response.status === 429) {
    throw new GoogleServiceError('google_temporarily_unavailable', 503);
  }
  if (!response.ok) throw new GoogleServiceError('authorization_rejected', 401);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GoogleServiceError('google_invalid_response', 502);
  }
  const subject = (body as { user?: { permissionId?: unknown } })?.user?.permissionId;
  if (typeof subject !== 'string' || subject.length < 3 || subject.length > 500) {
    throw new GoogleServiceError('google_invalid_response', 502);
  }
  return subject;
}

export async function revokeGoogleToken(
  fetcher: typeof fetch,
  token: string,
): Promise<boolean> {
  try {
    const response = await fetcher(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function requestToken(
  fetcher: typeof fetch,
  body: URLSearchParams,
  rejectionCode: 'authorization_rejected' | 'refresh_rejected',
): Promise<GoogleTokenSet> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new GoogleServiceError('google_temporarily_unavailable', 503);
  }
  let value: GoogleTokenResponse;
  try {
    value = (await response.json()) as GoogleTokenResponse;
  } catch {
    throw new GoogleServiceError(
      response.status >= 500
        ? 'google_temporarily_unavailable'
        : 'google_invalid_response',
      response.status >= 500 ? 503 : 502,
    );
  }
  if (!response.ok) {
    if (response.status >= 500 || response.status === 429) {
      throw new GoogleServiceError('google_temporarily_unavailable', 503);
    }
    throw new GoogleServiceError(rejectionCode, 401);
  }
  if (typeof value.access_token !== 'string' || typeof value.expires_in !== 'number') {
    throw new GoogleServiceError('google_invalid_response', 502);
  }
  const scopes =
    typeof value.scope === 'string'
      ? value.scope.split(/\s+/u).filter(Boolean)
      : [GOOGLE_DRIVE_SCOPE];
  if (!scopes.includes(GOOGLE_DRIVE_SCOPE)) {
    throw new GoogleServiceError('authorization_rejected', 401);
  }
  return {
    accessToken: value.access_token,
    expiresIn: Math.max(60, Math.min(86_400, value.expires_in)),
    ...(typeof value.refresh_token === 'string' && value.refresh_token
      ? { refreshToken: value.refresh_token }
      : {}),
    grantedScopes: JSON.stringify([...new Set(scopes)].sort()),
  };
}
