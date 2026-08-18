CREATE TABLE team_auth_tickets (
  ticket_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX team_auth_tickets_expires_at ON team_auth_tickets(expires_at);
CREATE INDEX team_auth_tickets_user_created ON team_auth_tickets(user_id, created_at DESC);
