PRAGMA foreign_keys = ON;

-- Existing sessions remain persistent personal-device sessions.
ALTER TABLE oauth_states
  ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'personal'
  CHECK (session_mode IN ('personal', 'temporary'));

ALTER TABLE authorization_grants
  ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'personal'
  CHECK (session_mode IN ('personal', 'temporary'));

ALTER TABLE device_sessions
  ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'personal'
  CHECK (session_mode IN ('personal', 'temporary'));

ALTER TABLE device_sessions
  ADD COLUMN expires_at INTEGER;

CREATE INDEX device_sessions_user_expiry
  ON device_sessions(user_id, revoked_at, expires_at, created_at);
