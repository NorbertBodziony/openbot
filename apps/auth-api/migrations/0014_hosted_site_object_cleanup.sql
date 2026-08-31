ALTER TABLE site_deployments ADD COLUMN objects_deleted_at INTEGER;
ALTER TABLE hosted_sites ADD COLUMN route_synced_at INTEGER;

CREATE INDEX site_deployments_object_cleanup ON site_deployments(status, objects_deleted_at);
