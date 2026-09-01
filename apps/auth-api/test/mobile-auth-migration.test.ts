import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("mobile auth sessions migration", () => {
  it("preserves existing sessions, supports retry, and cascades device metadata", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE auth_sessions(
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO users(id) VALUES ('user-1');
      INSERT INTO auth_sessions(id, user_id) VALUES ('session-1', 'user-1');
    `);

    const sql = readFileSync(new URL("../migrations/0012_mobile_auth_sessions.sql", import.meta.url), "utf8");
    database.exec("BEGIN");
    database.exec(sql);
    database.exec("COMMIT");
    database.exec(sql);

    expect(database.prepare("SELECT id, user_id FROM auth_sessions").all()).toEqual([
      { id: "session-1", user_id: "user-1" },
    ]);
    database
      .prepare(
        `INSERT INTO mobile_auth_sessions(session_id, user_id, device_id, device_name, platform, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("session-1", "user-1", "device-1", "iPhone", "ios", 1);
    database.prepare("DELETE FROM auth_sessions WHERE id = ?").run("session-1");

    expect(database.prepare("SELECT * FROM mobile_auth_sessions").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
