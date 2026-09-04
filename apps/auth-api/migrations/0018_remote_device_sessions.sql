-- Nullable for the old Worker during the migration/deploy gap. Legacy sessions
-- cannot be attributed safely, so revoking any account credential still ends them.
ALTER TABLE remote_sessions ADD COLUMN auth_session_hash TEXT;

DROP INDEX remote_sessions_one_active_per_user_host;
CREATE UNIQUE INDEX remote_sessions_one_active_per_device_host
  ON remote_sessions(host_id, user_id, auth_session_hash)
  WHERE ended_at IS NULL AND auth_session_hash IS NOT NULL;
CREATE UNIQUE INDEX remote_sessions_one_active_legacy_user_host
  ON remote_sessions(host_id, user_id)
  WHERE ended_at IS NULL AND auth_session_hash IS NULL;

DROP TRIGGER auth_session_revokes_remote_sessions;
CREATE TRIGGER auth_session_revokes_remote_sessions
AFTER UPDATE OF revoked_at ON auth_sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO remote_auth_events(event_id, payload, created_at, attempts, next_attempt_at)
  SELECT lower(hex(randomblob(16))),
    json_object('type', 'remote-session-ended', 'hostId', host_id, 'sessionId', session_id),
    NEW.revoked_at, 0, NEW.revoked_at
  FROM remote_sessions WHERE user_id = NEW.user_id AND ended_at IS NULL
    AND (auth_session_hash = NEW.token_hash OR auth_session_hash IS NULL);
  UPDATE remote_sessions SET ended_at = NEW.revoked_at
  WHERE user_id = NEW.user_id AND ended_at IS NULL
    AND (auth_session_hash = NEW.token_hash OR auth_session_hash IS NULL);
END;
