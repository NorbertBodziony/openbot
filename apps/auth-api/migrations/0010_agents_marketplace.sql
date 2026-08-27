CREATE TABLE marketplace_agents (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_version_id TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE marketplace_agent_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES marketplace_agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  avatar_seed TEXT NOT NULL,
  avatar_hue INTEGER,
  avatar_key TEXT,
  skills_json TEXT NOT NULL CHECK(json_valid(skills_json)),
  routines_json TEXT NOT NULL CHECK(json_valid(routines_json)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  rejection_note TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(agent_id, version)
);

CREATE TABLE marketplace_agent_install_receipts (
  receipt_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES marketplace_agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX marketplace_agents_owner ON marketplace_agents(owner_user_id, updated_at DESC);
CREATE INDEX marketplace_agent_versions_review ON marketplace_agent_versions(status, created_at);
CREATE INDEX marketplace_agent_versions_agent ON marketplace_agent_versions(agent_id, version DESC);
CREATE INDEX marketplace_agent_install_receipts_agent ON marketplace_agent_install_receipts(agent_id);
