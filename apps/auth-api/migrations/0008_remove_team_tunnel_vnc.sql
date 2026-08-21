ALTER TABLE team_tunnels RENAME TO team_tunnels_legacy;

CREATE TABLE team_tunnels (
  server_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tunnel_id TEXT UNIQUE,
  tunnel_name TEXT NOT NULL UNIQUE,
  api_hostname TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  machine_token_hash TEXT
);

INSERT INTO team_tunnels (
  server_id,
  user_id,
  tunnel_id,
  tunnel_name,
  api_hostname,
  status,
  created_at,
  updated_at,
  machine_token_hash
)
SELECT
  server_id,
  user_id,
  tunnel_id,
  tunnel_name,
  api_hostname,
  status,
  created_at,
  updated_at,
  machine_token_hash
FROM team_tunnels_legacy;

DROP TABLE team_tunnels_legacy;

CREATE UNIQUE INDEX team_tunnels_user_id ON team_tunnels(user_id);
CREATE INDEX team_tunnels_status ON team_tunnels(status);
CREATE UNIQUE INDEX team_tunnels_machine_token_hash_unique
  ON team_tunnels(machine_token_hash)
  WHERE machine_token_hash IS NOT NULL;
