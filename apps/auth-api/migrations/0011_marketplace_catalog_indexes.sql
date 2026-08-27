CREATE INDEX IF NOT EXISTS marketplace_skills_catalog_updated
ON marketplace_skills(featured DESC, updated_at DESC, id DESC)
WHERE approved_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS marketplace_skills_catalog_installs
ON marketplace_skills(installs DESC, updated_at DESC, id DESC)
WHERE approved_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS marketplace_agents_catalog_updated
ON marketplace_agents(featured DESC, updated_at DESC, id DESC)
WHERE approved_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS marketplace_agents_catalog_installs
ON marketplace_agents(installs DESC, updated_at DESC, id DESC)
WHERE approved_version_id IS NOT NULL;
