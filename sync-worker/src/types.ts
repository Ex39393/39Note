export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

export type DeviceSessionMode = 'personal' | 'temporary';

export interface OAuthStateRecord {
  stateHash: string;
  googleCodeVerifier: string;
  deviceId: string;
  exchangeChallenge: string;
  returnOrigin: string;
  returnUrl: string;
  sessionMode: DeviceSessionMode;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface UserRecord {
  id: string;
  googleSubject: string;
  encryptedRefreshToken: string;
  refreshTokenIv: string;
  encryptionKeyVersion: number;
  grantedScopes: string;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface AuthorizationGrantRecord {
  grantHash: string;
  userId: string;
  deviceId: string;
  exchangeChallenge: string;
  returnOrigin: string;
  sessionMode: DeviceSessionMode;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export interface DeviceSessionRecord {
  id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  sessionMode: DeviceSessionMode;
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number;
  revokedAt: number | null;
}

export interface AuthenticatedSession extends DeviceSessionRecord {
  user: UserRecord;
}

export interface AuthStore {
  createOAuthState(record: OAuthStateRecord): Promise<void>;
  getOAuthState(stateHash: string): Promise<OAuthStateRecord | null>;
  markOAuthStateUsed(stateHash: string, now: number): Promise<boolean>;
  deleteExpiredEphemera(now: number): Promise<void>;
  findUserByGoogleSubject(subject: string): Promise<UserRecord | null>;
  getUser(userId: string): Promise<UserRecord | null>;
  createUser(record: UserRecord): Promise<void>;
  updateUserToken(
    userId: string,
    encryptedToken: string,
    iv: string,
    keyVersion: number,
    scopes: string,
    now: number,
  ): Promise<void>;
  revokeUserAndSessions(userId: string, now: number): Promise<void>;
  createAuthorizationGrant(record: AuthorizationGrantRecord): Promise<void>;
  getAuthorizationGrant(grantHash: string): Promise<AuthorizationGrantRecord | null>;
  markAuthorizationGrantUsed(grantHash: string, now: number): Promise<boolean>;
  revokeDeviceSessions(userId: string, deviceId: string, now: number): Promise<void>;
  createDeviceSession(record: DeviceSessionRecord): Promise<void>;
  getAuthenticatedSession(
    tokenHash: string,
    now: number,
  ): Promise<AuthenticatedSession | null>;
  touchSession(sessionId: string, now: number, cutoff: number): Promise<void>;
  listDeviceSessions(userId: string, now: number): Promise<DeviceSessionRecord[]>;
  revokeSession(sessionId: string, now: number): Promise<void>;
  checkRateLimit(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<boolean>;
}
