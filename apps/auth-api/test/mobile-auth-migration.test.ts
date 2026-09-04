import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("mobile auth sessions migration", () => {
  it("revokes only the selected phone plus unbound legacy sessions and still accepts old Worker inserts", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations)
      .filter((name) => name.endsWith(".sql") && name < "0018")
      .sort()) {
      database.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    database.exec(`
      INSERT INTO users(id, identity_key, email, created_at, updated_at) VALUES ('owner', 'owner', 'owner@example.com', 1, 1);
      INSERT INTO auth_sessions(id, token_hash, user_id, created_at, last_used_at, expires_at)
        VALUES ('phone-1', 'hash-1', 'owner', 1, 1, 8640000000000000), ('phone-2', 'hash-2', 'owner', 1, 1, 8640000000000000);
      INSERT INTO remote_hosts(host_id, owner_user_id, name, auth_epoch, created_at, updated_at) VALUES ('host', 'owner', 'Desktop', 1, 1, 1);
      INSERT INTO remote_memberships(membership_id, host_id, user_id, role, status, created_at, updated_at) VALUES ('member', 'host', 'owner', 'owner', 'active', 1, 1);
      INSERT INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at) VALUES ('legacy', 'host', 'owner', 'member', 1, 8640000000000000);
    `);
    database.exec(readFileSync(new URL("0018_remote_device_sessions.sql", migrations), "utf8"));
    expect(database.prepare("SELECT ended_at FROM remote_sessions WHERE session_id = 'legacy'").get()).toEqual({
      ended_at: null,
    });
    database.exec(`INSERT INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at, auth_session_hash)
      VALUES ('remote-1', 'host', 'owner', 'member', 1, 8640000000000000, 'hash-1'), ('remote-2', 'host', 'owner', 'member', 1, 8640000000000000, 'hash-2')`);
    database.exec("UPDATE auth_sessions SET revoked_at = 42 WHERE id = 'phone-1'");
    expect(database.prepare("SELECT session_id, ended_at FROM remote_sessions ORDER BY session_id").all()).toEqual([
      { session_id: "legacy", ended_at: 42 },
      { session_id: "remote-1", ended_at: 42 },
      { session_id: "remote-2", ended_at: null },
    ]);
    expect(
      database
        .prepare("SELECT json_extract(payload, '$.sessionId') AS sessionId FROM remote_auth_events ORDER BY sessionId")
        .all(),
    ).toEqual([{ sessionId: "legacy" }, { sessionId: "remote-1" }]);
    // The deployed Worker's unbound INSERT remains valid during the deploy gap.
    database.exec(`INSERT OR IGNORE INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at)
      VALUES ('legacy-after-migration', 'host', 'owner', 'member', 1, 8640000000000000)`);
    expect(
      database
        .prepare("SELECT auth_session_hash FROM remote_sessions WHERE session_id = 'legacy-after-migration'")
        .get(),
    ).toEqual({ auth_session_hash: null });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("keeps live credentials persistent and atomically disconnects revoked users without reviving old credentials", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const future = Date.now() + 60_000;
    database.exec(`
      CREATE TABLE auth_sessions(id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE remote_sessions(session_id TEXT PRIMARY KEY, host_id TEXT, user_id TEXT, expires_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE team_auth_tickets(ticket_hash TEXT PRIMARY KEY);
      CREATE TABLE remote_auth_events(event_id TEXT PRIMARY KEY, payload TEXT, created_at INTEGER, attempts INTEGER, next_attempt_at INTEGER);
      INSERT INTO auth_sessions VALUES ('phone', 'owner', ${future}, NULL), ('expired', 'owner', 1, NULL), ('revoked', 'owner', ${future}, 2);
      INSERT INTO remote_sessions VALUES ('live', 'desktop', 'owner', ${future}, NULL), ('other', 'desktop', 'other-user', ${future}, NULL);
    `);
    database.exec(readFileSync(new URL("../migrations/0017_mobile_session_security.sql", import.meta.url), "utf8"));
    expect(database.prepare("SELECT expires_at FROM auth_sessions WHERE id = 'phone'").get()).toEqual({
      expires_at: 8_640_000_000_000_000,
    });
    expect(database.prepare("SELECT expires_at FROM auth_sessions WHERE id = 'expired'").get()).toEqual({
      expires_at: 1,
    });
    expect(database.prepare("SELECT revoked_at, expires_at FROM auth_sessions WHERE id = 'revoked'").get()).toEqual({
      revoked_at: 2,
      expires_at: future,
    });
    // The old Worker's UPDATE and INSERT statements remain valid after the additive migration.
    database.exec("INSERT INTO team_auth_tickets(ticket_hash) VALUES ('legacy-ticket')");
    database.exec("UPDATE auth_sessions SET revoked_at = 42 WHERE id = 'phone'");
    expect(database.prepare("SELECT session_id, ended_at FROM remote_sessions ORDER BY session_id").all()).toEqual([
      { session_id: "live", ended_at: 42 },
      { session_id: "other", ended_at: null },
    ]);
    expect(database.prepare("SELECT payload FROM remote_auth_events").all()).toEqual([
      { payload: JSON.stringify({ type: "remote-session-ended", hostId: "desktop", sessionId: "live" }) },
    ]);
    database.exec("UPDATE auth_sessions SET revoked_at = 43 WHERE id = 'phone'");
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_auth_events").get()).toEqual({ count: 1 });
  });

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

    const sql = readFileSync(new URL("../migrations/0014_mobile_auth_sessions.sql", import.meta.url), "utf8");
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
