import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createPublicationSql, type Publication } from "./publish-production-catalog";

describe("production catalog publication", () => {
  it("creates approved marketplace records owned by OpenBot without resetting marketplace counters", () => {
    const publication: Publication = {
      catalogVersion: "v1",
      skills: [
        {
          id: "openbot-curated-skill-example",
          versionId: "openbot-curated-version-example-v1-deadbeefdeadbeef",
          slug: "example",
          name: "Example",
          description: "An example skill.",
          category: "productivity",
          version: 1,
          bundle: "skills/example.zip",
          bundleSha256: "a".repeat(64),
          files: ["LICENSE.txt", "NOTICE.txt", "SKILL.md"],
        },
      ],
      agents: [
        {
          id: "openbot-curated-agent-example",
          versionId: "openbot-curated-agent-version-example-v1-deadbeefdeadbeef",
          name: "Example Agent",
          title: "Example",
          description: "An example agent.",
          avatarSeed: "openbot-curated-agent-example",
          avatarHue: 120,
          version: 1,
          skills: [],
          routines: [],
        },
      ],
    };

    const sql = createPublicationSql(publication, 1234);

    expect(sql).toContain("'openbot-production-catalog'");
    expect(sql).toContain("'OpenBot'");
    expect(sql.match(/'approved'/gu)).toHaveLength(2);
    expect(sql).toContain("ON CONFLICT(id) DO NOTHING");
    expect(sql).not.toMatch(/DO UPDATE SET[^;]*(?:installs|featured)/u);
    expect(sql).toContain(
      "skills/openbot-curated-skill-example/versions/openbot-curated-version-example-v1-deadbeefdeadbeef.zip",
    );

    const verification = spawnSync("/usr/bin/sqlite3", [":memory:"], {
      encoding: "utf8",
      input: `${schema}\n${sql}\nUPDATE marketplace_skills SET installs = 8, featured = 1;\nUPDATE marketplace_agents SET installs = 5, featured = 1;\n${createPublicationSql(publication, 5678)}\n.mode json\nSELECT (SELECT name FROM users WHERE id = 'openbot-production-catalog') AS owner, (SELECT installs FROM marketplace_skills) AS skill_installs, (SELECT featured FROM marketplace_skills) AS skill_featured, (SELECT installs FROM marketplace_agents) AS agent_installs, (SELECT featured FROM marketplace_agents) AS agent_featured, (SELECT status FROM marketplace_skill_versions) AS skill_status, (SELECT status FROM marketplace_agent_versions) AS agent_status;\n`,
    });
    expect(verification.status).toBe(0);
    expect(JSON.parse(verification.stdout)).toEqual([
      {
        owner: "OpenBot",
        skill_installs: 8,
        skill_featured: 1,
        agent_installs: 5,
        agent_featured: 1,
        skill_status: "approved",
        agent_status: "approved",
      },
    ]);
  });
});

const schema = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, name TEXT,
  avatar_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE marketplace_skills (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id),
  approved_version_id TEXT, installs INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE marketplace_skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES marketplace_skills(id), version INTEGER NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL,
  rejection_note TEXT, bundle_key TEXT NOT NULL UNIQUE, bundle_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL CHECK(json_valid(files_json)), icon_key TEXT, created_at INTEGER NOT NULL,
  reviewed_at INTEGER, UNIQUE(skill_id, version)
);
CREATE TABLE marketplace_agents (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id), approved_version_id TEXT,
  installs INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE marketplace_agent_versions (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES marketplace_agents(id), version INTEGER NOT NULL,
  name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, avatar_seed TEXT NOT NULL,
  avatar_hue INTEGER, avatar_key TEXT, skills_json TEXT NOT NULL CHECK(json_valid(skills_json)),
  routines_json TEXT NOT NULL CHECK(json_valid(routines_json)), status TEXT NOT NULL, rejection_note TEXT,
  created_at INTEGER NOT NULL, reviewed_at INTEGER, UNIQUE(agent_id, version)
);
`;
