import type {
  AuthenticatedSession,
  AuthorizationGrantRecord,
  AuthStore,
  DeviceSessionMode,
  DeviceSessionRecord,
  OAuthStateRecord,
  UserRecord,
} from './types.ts';

type DbRow = Record<string, string | number | null>;

export class D1AuthStore implements AuthStore {
  constructor(private readonly database: Pick<D1Database, 'prepare' | 'batch'>) {}

  async createOAuthState(record: OAuthStateRecord): Promise<void> {
    await this.database
      .prepare(
        `
      INSERT INTO oauth_states (
        state_hash, google_code_verifier, device_id, exchange_challenge,
        return_origin, return_url, session_mode, created_at, expires_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .bind(
        record.stateHash,
        record.googleCodeVerifier,
        record.deviceId,
        record.exchangeChallenge,
        record.returnOrigin,
        record.returnUrl,
        record.sessionMode,
        record.createdAt,
        record.expiresAt,
      )
      .run();
  }

  async getOAuthState(stateHash: string): Promise<OAuthStateRecord | null> {
    const row = await this.database
      .prepare('SELECT * FROM oauth_states WHERE state_hash = ?')
      .bind(stateHash)
      .first<DbRow>();
    return row ? mapOAuthState(row) : null;
  }

  async markOAuthStateUsed(stateHash: string, now: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
      UPDATE oauth_states SET used_at = ?
      WHERE state_hash = ? AND used_at IS NULL AND expires_at >= ?
    `,
      )
      .bind(now, stateHash, now)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async deleteExpiredEphemera(now: number): Promise<void> {
    const retentionCutoff = now - 86_400_000;
    await this.database.batch([
      this.database
        .prepare('DELETE FROM oauth_states WHERE expires_at < ?')
        .bind(retentionCutoff),
      this.database
        .prepare('DELETE FROM authorization_grants WHERE expires_at < ?')
        .bind(retentionCutoff),
      this.database
        .prepare('DELETE FROM rate_limits WHERE window_started_at < ?')
        .bind(retentionCutoff),
    ]);
  }

  async findUserByGoogleSubject(subject: string): Promise<UserRecord | null> {
    const row = await this.database
      .prepare('SELECT * FROM users WHERE google_subject = ?')
      .bind(subject)
      .first<DbRow>();
    return row ? mapUser(row) : null;
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const row = await this.database
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<DbRow>();
    return row ? mapUser(row) : null;
  }

  async createUser(record: UserRecord): Promise<void> {
    await this.database
      .prepare(
        `
      INSERT INTO users (
        id, google_subject, encrypted_refresh_token, refresh_token_iv,
        encryption_key_version, granted_scopes, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(google_subject) DO NOTHING
    `,
      )
      .bind(
        record.id,
        record.googleSubject,
        record.encryptedRefreshToken,
        record.refreshTokenIv,
        record.encryptionKeyVersion,
        record.grantedScopes,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async updateUserToken(
    userId: string,
    encryptedToken: string,
    iv: string,
    keyVersion: number,
    scopes: string,
    now: number,
  ): Promise<void> {
    await this.database
      .prepare(
        `
      UPDATE users SET encrypted_refresh_token = ?, refresh_token_iv = ?,
        encryption_key_version = ?, granted_scopes = ?, updated_at = ?, revoked_at = NULL
      WHERE id = ?
    `,
      )
      .bind(encryptedToken, iv, keyVersion, scopes, now, userId)
      .run();
  }

  async revokeUserAndSessions(userId: string, now: number): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          'UPDATE users SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL',
        )
        .bind(now, now, userId),
      this.database
        .prepare(
          'UPDATE device_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        )
        .bind(now, userId),
    ]);
  }

  async createAuthorizationGrant(record: AuthorizationGrantRecord): Promise<void> {
    await this.database
      .prepare(
        `
      INSERT INTO authorization_grants (
        grant_hash, user_id, device_id, exchange_challenge, return_origin,
        session_mode, created_at, expires_at, used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .bind(
        record.grantHash,
        record.userId,
        record.deviceId,
        record.exchangeChallenge,
        record.returnOrigin,
        record.sessionMode,
        record.createdAt,
        record.expiresAt,
      )
      .run();
  }

  async getAuthorizationGrant(
    grantHash: string,
  ): Promise<AuthorizationGrantRecord | null> {
    const row = await this.database
      .prepare('SELECT * FROM authorization_grants WHERE grant_hash = ?')
      .bind(grantHash)
      .first<DbRow>();
    return row ? mapGrant(row) : null;
  }

  async markAuthorizationGrantUsed(grantHash: string, now: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `
      UPDATE authorization_grants SET used_at = ?
      WHERE grant_hash = ? AND used_at IS NULL AND expires_at >= ?
    `,
      )
      .bind(now, grantHash, now)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async revokeDeviceSessions(
    userId: string,
    deviceId: string,
    now: number,
  ): Promise<void> {
    await this.database
      .prepare(
        `
      UPDATE device_sessions SET revoked_at = ?
      WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL
    `,
      )
      .bind(now, userId, deviceId)
      .run();
  }

  async createDeviceSession(record: DeviceSessionRecord): Promise<void> {
    await this.database
      .prepare(
        `
      INSERT INTO device_sessions (
        id, user_id, device_id, token_hash, session_mode, expires_at,
        created_at, last_used_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
      )
      .bind(
        record.id,
        record.userId,
        record.deviceId,
        record.tokenHash,
        record.sessionMode,
        record.expiresAt,
        record.createdAt,
        record.lastUsedAt,
      )
      .run();
  }

  async getAuthenticatedSession(
    tokenHash: string,
    now: number,
  ): Promise<AuthenticatedSession | null> {
    const row = await this.database
      .prepare(
        `
      SELECT
        s.id AS session_id, s.user_id AS session_user_id, s.device_id AS session_device_id,
        s.token_hash AS session_token_hash, s.created_at AS session_created_at,
        s.session_mode AS session_mode, s.expires_at AS session_expires_at,
        s.last_used_at AS session_last_used_at, s.revoked_at AS session_revoked_at,
        u.id AS user_id, u.google_subject, u.encrypted_refresh_token, u.refresh_token_iv,
        u.encryption_key_version, u.granted_scopes, u.created_at AS user_created_at,
        u.updated_at AS user_updated_at, u.revoked_at AS user_revoked_at
      FROM device_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND u.revoked_at IS NULL
        AND (
          (s.session_mode = 'personal' AND s.expires_at IS NULL)
          OR (s.session_mode = 'temporary' AND s.expires_at > ?)
        )
    `,
      )
      .bind(tokenHash, now)
      .first<DbRow>();
    if (!row) return null;
    return {
      id: String(row.session_id),
      userId: String(row.session_user_id),
      deviceId: String(row.session_device_id),
      tokenHash: String(row.session_token_hash),
      sessionMode: mapSessionMode(row.session_mode),
      expiresAt: nullableNumber(row.session_expires_at),
      createdAt: Number(row.session_created_at),
      lastUsedAt: Number(row.session_last_used_at),
      revokedAt: nullableNumber(row.session_revoked_at),
      user: {
        id: String(row.user_id),
        googleSubject: String(row.google_subject),
        encryptedRefreshToken: String(row.encrypted_refresh_token),
        refreshTokenIv: String(row.refresh_token_iv),
        encryptionKeyVersion: Number(row.encryption_key_version),
        grantedScopes: String(row.granted_scopes),
        createdAt: Number(row.user_created_at),
        updatedAt: Number(row.user_updated_at),
        revokedAt: nullableNumber(row.user_revoked_at),
      },
    };
  }

  async touchSession(sessionId: string, now: number, cutoff: number): Promise<void> {
    await this.database
      .prepare(
        `
      UPDATE device_sessions SET last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL AND last_used_at < ?
    `,
      )
      .bind(now, sessionId, cutoff)
      .run();
  }

  async listDeviceSessions(
    userId: string,
    now: number,
  ): Promise<DeviceSessionRecord[]> {
    const result = await this.database
      .prepare(
        `
      SELECT * FROM device_sessions
      WHERE user_id = ? AND revoked_at IS NULL
        AND (
          (session_mode = 'personal' AND expires_at IS NULL)
          OR (session_mode = 'temporary' AND expires_at > ?)
        )
      ORDER BY created_at DESC
    `,
      )
      .bind(userId, now)
      .all<DbRow>();
    return (result.results ?? []).map(mapDeviceSession);
  }

  async revokeSession(sessionId: string, now: number): Promise<void> {
    await this.database
      .prepare(
        'UPDATE device_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      )
      .bind(now, sessionId)
      .run();
  }

  async checkRateLimit(
    key: string,
    now: number,
    windowMs: number,
    limit: number,
  ): Promise<boolean> {
    const cutoff = now - windowMs;
    await this.database
      .prepare(
        `
      INSERT INTO rate_limits (key, window_started_at, request_count) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        request_count = CASE WHEN window_started_at <= ? THEN 1 ELSE request_count + 1 END,
        window_started_at = CASE WHEN window_started_at <= ? THEN ? ELSE window_started_at END
    `,
      )
      .bind(key, now, cutoff, cutoff, now)
      .run();
    const row = await this.database
      .prepare('SELECT request_count FROM rate_limits WHERE key = ?')
      .bind(key)
      .first<{ request_count: number }>();
    return Boolean(row && row.request_count <= limit);
  }
}

function mapOAuthState(row: DbRow): OAuthStateRecord {
  return {
    stateHash: String(row.state_hash),
    googleCodeVerifier: String(row.google_code_verifier),
    deviceId: String(row.device_id),
    exchangeChallenge: String(row.exchange_challenge),
    returnOrigin: String(row.return_origin),
    returnUrl: String(row.return_url),
    sessionMode: mapSessionMode(row.session_mode),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    usedAt: nullableNumber(row.used_at),
  };
}

function mapUser(row: DbRow): UserRecord {
  return {
    id: String(row.id),
    googleSubject: String(row.google_subject),
    encryptedRefreshToken: String(row.encrypted_refresh_token),
    refreshTokenIv: String(row.refresh_token_iv),
    encryptionKeyVersion: Number(row.encryption_key_version),
    grantedScopes: String(row.granted_scopes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revokedAt: nullableNumber(row.revoked_at),
  };
}

function mapGrant(row: DbRow): AuthorizationGrantRecord {
  return {
    grantHash: String(row.grant_hash),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    exchangeChallenge: String(row.exchange_challenge),
    returnOrigin: String(row.return_origin),
    sessionMode: mapSessionMode(row.session_mode),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    usedAt: nullableNumber(row.used_at),
  };
}

function mapDeviceSession(row: DbRow): DeviceSessionRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    deviceId: String(row.device_id),
    tokenHash: String(row.token_hash),
    sessionMode: mapSessionMode(row.session_mode),
    expiresAt: nullableNumber(row.expires_at),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    revokedAt: nullableNumber(row.revoked_at),
  };
}

function nullableNumber(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function mapSessionMode(value: string | number | null | undefined): DeviceSessionMode {
  if (value === 'personal' || value === 'temporary') return value;
  throw new Error('Invalid device session mode in authentication storage.');
}
