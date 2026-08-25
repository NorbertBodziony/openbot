CREATE TABLE marketplace_skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_version_id TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE marketplace_skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
  rejection_note TEXT,
  bundle_key TEXT NOT NULL UNIQUE,
  bundle_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL CHECK(json_valid(files_json)),
  icon_key TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  UNIQUE(skill_id, version)
);

CREATE TABLE marketplace_skill_install_receipts (
  receipt_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES marketplace_skills(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX marketplace_skills_owner ON marketplace_skills(owner_user_id, updated_at DESC);
CREATE INDEX marketplace_skill_versions_review ON marketplace_skill_versions(status, created_at);
CREATE INDEX marketplace_skill_versions_skill ON marketplace_skill_versions(skill_id, version DESC);
CREATE INDEX marketplace_install_receipts_skill ON marketplace_skill_install_receipts(skill_id);
