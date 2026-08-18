CREATE TABLE team_tunnels (
  server_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tunnel_id TEXT UNIQUE,
  tunnel_name TEXT NOT NULL UNIQUE,
  api_hostname TEXT NOT NULL UNIQUE,
  vnc_hostname TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX team_tunnels_user_id ON team_tunnels(user_id);
CREATE INDEX team_tunnels_status ON team_tunnels(status);
