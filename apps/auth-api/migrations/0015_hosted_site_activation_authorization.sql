ALTER TABLE site_deployments ADD COLUMN activation_authorized_at INTEGER;

CREATE INDEX site_deployments_activation_rate
  ON site_deployments(user_id, activation_authorized_at);
