PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL UNIQUE,
  encrypted_refresh_token TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL,
  granted_scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX device_sessions_user_active
  ON device_sessions(user_id, revoked_at, created_at);
CREATE UNIQUE INDEX device_sessions_one_active_device
  ON device_sessions(user_id, device_id) WHERE revoked_at IS NULL;

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  google_code_verifier TEXT NOT NULL,
  device_id TEXT NOT NULL,
  exchange_challenge TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  return_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

CREATE TABLE authorization_grants (
  grant_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  exchange_challenge TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX authorization_grants_expiry ON authorization_grants(expires_at);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
