import type {
  AuthenticatedSession,
  AuthorizationGrantRecord,
  AuthStore,
  DeviceSessionRecord,
  OAuthStateRecord,
  UserRecord,
} from '../src/types.ts';

export class MemoryAuthStore implements AuthStore {
  readonly oauthStates = new Map<string, OAuthStateRecord>();
  readonly users = new Map<string, UserRecord>();
  readonly grants = new Map<string, AuthorizationGrantRecord>();
  readonly sessions = new Map<string, DeviceSessionRecord>();
  readonly rateLimits = new Map<string, { windowStartedAt: number; count: number }>();

  async createOAuthState(record: OAuthStateRecord): Promise<void> {
    this.oauthStates.set(record.stateHash, { ...record });
  }

  async getOAuthState(stateHash: string): Promise<OAuthStateRecord | null> {
    return clone(this.oauthStates.get(stateHash));
  }

  async markOAuthStateUsed(stateHash: string, now: number): Promise<boolean> {
    const state = this.oauthStates.get(stateHash);
    if (!state || state.usedAt !== null || state.expiresAt < now) return false;
    state.usedAt = now;
    return true;
  }

  async deleteExpiredEphemera(_now: number): Promise<void> {}

  async findUserByGoogleSubject(subject: string): Promise<UserRecord | null> {
    return clone(
      [...this.users.values()].find((user) => user.googleSubject === subject),
    );
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    return clone(this.users.get(userId));
  }

  async createUser(record: UserRecord): Promise<void> {
    if (
      [...this.users.values()].some(
        (user) => user.googleSubject === record.googleSubject,
      )
    )
      return;
    this.users.set(record.id, { ...record });
  }

  async updateUserToken(
    userId: string,
    encryptedToken: string,
    iv: string,
    keyVersion: number,
    scopes: string,
    now: number,
  ): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('missing user');
    Object.assign(user, {
      encryptedRefreshToken: encryptedToken,
      refreshTokenIv: iv,
      encryptionKeyVersion: keyVersion,
      grantedScopes: scopes,
      updatedAt: now,
      revokedAt: null,
    });
  }

  async revokeUserAndSessions(userId: string, now: number): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.revokedAt = now;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null)
        session.revokedAt = now;
    }
  }

  async createAuthorizationGrant(record: AuthorizationGrantRecord): Promise<void> {
    this.grants.set(record.grantHash, { ...record });
  }

  async getAuthorizationGrant(
    grantHash: string,
  ): Promise<AuthorizationGrantRecord | null> {
    return clone(this.grants.get(grantHash));
  }

  async markAuthorizationGrantUsed(grantHash: string, now: number): Promise<boolean> {
    const grant = this.grants.get(grantHash);
    if (!grant || grant.usedAt !== null || grant.expiresAt < now) return false;
    grant.usedAt = now;
    return true;
  }

  async revokeDeviceSessions(
    userId: string,
    deviceId: string,
    now: number,
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      if (
        session.userId === userId &&
        session.deviceId === deviceId &&
        session.revokedAt === null
      ) {
        session.revokedAt = now;
      }
    }
  }

  async createDeviceSession(record: DeviceSessionRecord): Promise<void> {
    this.sessions.set(record.id, { ...record });
  }

  async getAuthenticatedSession(
    tokenHash: string,
    now: number,
  ): Promise<AuthenticatedSession | null> {
    const session = [...this.sessions.values()].find(
      (item) =>
        item.tokenHash === tokenHash &&
        item.revokedAt === null &&
        ((item.sessionMode === 'personal' && item.expiresAt === null) ||
          (item.sessionMode === 'temporary' &&
            item.expiresAt !== null &&
            item.expiresAt > now)),
    );
    if (!session) return null;
    const user = this.users.get(session.userId);
    if (!user || user.revokedAt !== null) return null;
    return { ...session, user: { ...user } };
  }

  async touchSession(sessionId: string, now: number, cutoff: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null && session.lastUsedAt < cutoff)
      session.lastUsedAt = now;
  }

  async listDeviceSessions(
    userId: string,
    now = Number.NEGATIVE_INFINITY,
  ): Promise<DeviceSessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt === null &&
          ((session.sessionMode === 'personal' && session.expiresAt === null) ||
            (session.sessionMode === 'temporary' &&
              session.expiresAt !== null &&
              session.expiresAt > now)),
      )
      .sort((first, second) => second.createdAt - first.createdAt)
      .map((session) => ({ ...session }));
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) session.revokedAt = now;
  }

  async checkRateLimit(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<boolean> {
    const value = this.rateLimits.get(key);
    if (!value || value.windowStartedAt <= now - windowMs) {
      this.rateLimits.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    value.count += 1;
    return value.count <= limit;
  }
}

function clone<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value);
}
