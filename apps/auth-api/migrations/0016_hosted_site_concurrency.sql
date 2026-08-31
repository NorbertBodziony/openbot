ALTER TABLE site_deployments ADD COLUMN in_flight_uploads INTEGER NOT NULL DEFAULT 0;

CREATE TABLE site_creation_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX site_creation_events_owner_time ON site_creation_events(user_id, created_at);
