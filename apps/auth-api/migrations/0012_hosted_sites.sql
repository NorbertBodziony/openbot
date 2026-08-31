CREATE TABLE hosted_sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  framework TEXT NOT NULL CHECK (framework IN ('vanilla', 'astro')),
  spa_fallback INTEGER NOT NULL DEFAULT 0 CHECK (spa_fallback IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('uploading', 'active', 'deleted', 'expired', 'blocked')),
  current_deployment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER,
  blocked_at INTEGER,
  route_synced_at INTEGER
);

CREATE INDEX hosted_sites_owner_status ON hosted_sites(user_id, status, expires_at);
CREATE INDEX hosted_sites_expiry ON hosted_sites(status, expires_at);

CREATE TABLE site_deployments (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES hosted_sites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'activating', 'active', 'superseded', 'abandoned')),
  base_deployment_id TEXT,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  site_title TEXT NOT NULL,
  site_description TEXT NOT NULL,
  site_framework TEXT NOT NULL CHECK (site_framework IN ('vanilla', 'astro')),
  site_spa_fallback INTEGER NOT NULL CHECK (site_spa_fallback IN (0, 1)),
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upload_expires_at INTEGER NOT NULL,
  activated_at INTEGER,
  objects_deleted_at INTEGER,
  activation_authorized_at INTEGER,
  in_flight_uploads INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, idempotency_key)
);

CREATE INDEX site_deployments_site ON site_deployments(site_id, created_at);
CREATE INDEX site_deployments_upload_expiry ON site_deployments(status, upload_expires_at);
CREATE INDEX site_deployments_object_cleanup ON site_deployments(status, objects_deleted_at);
CREATE INDEX site_deployments_activation_rate ON site_deployments(user_id, activation_authorized_at);

CREATE TABLE site_upload_files (
  deployment_id TEXT NOT NULL REFERENCES site_deployments(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY(deployment_id, path)
);

CREATE TABLE site_operation_receipts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  resource_id TEXT,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, idempotency_key)
);

CREATE TABLE site_hostname_reservations (
  hostname TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE site_creation_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX site_creation_events_owner_time ON site_creation_events(user_id, created_at);

CREATE TABLE site_audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  site_id TEXT,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX site_audit_created_at ON site_audit_log(created_at);

CREATE TABLE site_reports (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  source_ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'closed'))
);

CREATE INDEX site_reports_status_created_at ON site_reports(status, created_at);
