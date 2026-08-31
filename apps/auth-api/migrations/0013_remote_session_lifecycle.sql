CREATE TABLE remote_auth_events (
  event_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);

CREATE INDEX remote_auth_events_pending
  ON remote_auth_events(next_attempt_at, created_at);

CREATE UNIQUE INDEX remote_sessions_one_active_per_user_host
  ON remote_sessions(host_id, user_id)
  WHERE ended_at IS NULL;

CREATE INDEX remote_sessions_ended_at
  ON remote_sessions(ended_at)
  WHERE ended_at IS NOT NULL;
