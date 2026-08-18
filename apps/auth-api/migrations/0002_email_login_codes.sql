CREATE TABLE email_login_challenges (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  source_ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX email_login_challenges_email_created
  ON email_login_challenges(email, created_at DESC);
CREATE INDEX email_login_challenges_expires_at
  ON email_login_challenges(expires_at);

CREATE TABLE auth_rate_limits (
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY(key_hash, window_start)
);

CREATE INDEX auth_rate_limits_window_start ON auth_rate_limits(window_start);
