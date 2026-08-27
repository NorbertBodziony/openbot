import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("marketplace catalog indexes migration", () => {
  it("preserves marketplace data and passes integrity checks", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT);");
    database.exec(migration("0009_skills_marketplace.sql"));
    database.exec(migration("0010_agents_marketplace.sql"));
    seedMarketplace(database);

    database.exec("BEGIN");
    database.exec(migration("0011_marketplace_catalog_indexes.sql"));
    database.exec("COMMIT");
    database.exec(migration("0011_marketplace_catalog_indexes.sql"));

    expect(count(database, "marketplace_skills")).toBe(1);
    expect(count(database, "marketplace_skill_versions")).toBe(1);
    expect(count(database, "marketplace_agents")).toBe(1);
    expect(count(database, "marketplace_agent_versions")).toBe(1);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'marketplace_%_catalog_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    ).toEqual([
      "marketplace_agents_catalog_installs",
      "marketplace_agents_catalog_updated",
      "marketplace_skills_catalog_installs",
      "marketplace_skills_catalog_updated",
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

function seedMarketplace(database: DatabaseSync): void {
  database.prepare("INSERT INTO users(id, email, name) VALUES (?, ?, ?)").run("user-1", "owner@example.com", "Owner");
  database
    .prepare("INSERT INTO marketplace_skills(id, slug, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("skill-1", "skill-one", "user-1", 1, 1);
  database
    .prepare(
      `INSERT INTO marketplace_skill_versions(
        id, skill_id, version, name, description, category, status, bundle_key, bundle_sha256, files_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, '[]', ?)`,
    )
    .run("skill-version-1", "skill-1", 1, "Skill", "Description", "productivity", "bundle.zip", "hash", 1);
  database
    .prepare("UPDATE marketplace_skills SET approved_version_id = ? WHERE id = ?")
    .run("skill-version-1", "skill-1");
  database
    .prepare("INSERT INTO marketplace_agents(id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("agent-1", "user-1", 1, 1);
  database
    .prepare(
      `INSERT INTO marketplace_agent_versions(
        id, agent_id, version, name, title, description, avatar_seed, avatar_hue, skills_json, routines_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'approved', ?)`,
    )
    .run("agent-version-1", "agent-1", 1, "Agent", "Title", "Description", "seed", null, 1);
  database
    .prepare("UPDATE marketplace_agents SET approved_version_id = ? WHERE id = ?")
    .run("agent-version-1", "agent-1");
}

function count(database: DatabaseSync, table: string): number {
  return Number(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0);
}
