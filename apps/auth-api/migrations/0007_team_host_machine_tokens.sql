ALTER TABLE team_tunnels ADD COLUMN machine_token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS team_tunnels_machine_token_hash_unique
  ON team_tunnels(machine_token_hash)
  WHERE machine_token_hash IS NOT NULL;
