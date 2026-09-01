CREATE TABLE remote_hosts (
  host_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_key TEXT,
  device_public_key TEXT,
  machine_token_hash TEXT,
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX remote_hosts_machine_token_hash_unique
  ON remote_hosts(machine_token_hash)
  WHERE machine_token_hash IS NOT NULL;
CREATE INDEX remote_hosts_owner_user_id ON remote_hosts(owner_user_id);

CREATE TABLE remote_memberships (
  membership_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(host_id, user_id)
);

CREATE INDEX remote_memberships_user_status
  ON remote_memberships(user_id, status);

CREATE TABLE remote_invites (
  invite_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX remote_invites_host_id ON remote_invites(host_id);
CREATE INDEX remote_invites_expires_at ON remote_invites(expires_at);

CREATE TABLE remote_sessions (
  session_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES remote_memberships(membership_id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE INDEX remote_sessions_user_id ON remote_sessions(user_id);
CREATE INDEX remote_sessions_host_id ON remote_sessions(host_id);
CREATE INDEX remote_sessions_expires_at ON remote_sessions(expires_at);

INSERT INTO remote_hosts (
  host_id,
  owner_user_id,
  name,
  machine_token_hash,
  auth_epoch,
  created_at,
  updated_at
)
SELECT
  server_id,
  user_id,
  tunnel_name,
  machine_token_hash,
  1,
  created_at,
  updated_at
FROM team_tunnels;

INSERT INTO remote_memberships (
  membership_id,
  host_id,
  user_id,
  role,
  status,
  created_at,
  updated_at
)
SELECT
  server_id || ':owner',
  server_id,
  user_id,
  'owner',
  'active',
  created_at,
  updated_at
FROM team_tunnels;
