CREATE TABLE IF NOT EXISTS mobile_auth_sessions (
  session_id TEXT PRIMARY KEY REFERENCES auth_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'unknown')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mobile_auth_sessions_user_id ON mobile_auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS mobile_auth_sessions_user_device ON mobile_auth_sessions(user_id, device_id);
