import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { authRetentionOperations } from "../src/server/auth-data-retention";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("auth data retention", () => {
  it("deletes inactive records and keeps active records", () => {
    const database = createDatabase();
    const now = 2_000_000;
    insertFixtures(database, now);

    runRetention(database, now);

    expect(ids(database, "email_login_challenges", "id_hash")).toEqual(["active"]);
    expect(ids(database, "auth_sessions", "id")).toEqual(["active"]);
    expect(ids(database, "auth_rate_limits", "key_hash")).toEqual(["current"]);
    expect(ids(database, "team_auth_tickets", "ticket_hash")).toEqual(["active"]);
    expect(ids(database, "remote_sessions", "session_id")).toEqual(["active"]);
    expect(ids(database, "users", "id")).toEqual(["user"]);
    expect(ids(database, "team_tunnels", "server_id")).toEqual(["server"]);
  });

  it("deletes records at the expiration boundary", () => {
    const database = createDatabase();
    const now = 2_000_000;
    database.prepare("INSERT INTO users(id) VALUES (?)").run("user");
    database
      .prepare("INSERT INTO email_login_challenges(id_hash, expires_at, consumed_at) VALUES (?, ?, NULL)")
      .run("boundary", now);
    database
      .prepare("INSERT INTO auth_sessions(id, user_id, expires_at, revoked_at) VALUES (?, ?, ?, NULL)")
      .run("boundary", "user", now);
    database
      .prepare("INSERT INTO auth_rate_limits(key_hash, window_start) VALUES (?, ?)")
      .run("boundary", now - 15 * 60_000);
    database
      .prepare("INSERT INTO team_auth_tickets(ticket_hash, user_id, expires_at, consumed_at) VALUES (?, ?, ?, NULL)")
      .run("boundary", "user", now);
    database
      .prepare("INSERT INTO remote_sessions(session_id, user_id, expires_at, ended_at) VALUES (?, ?, ?, NULL)")
      .run("boundary", "user", now - 10 * 60_000);

    runRetention(database, now);

    expect(count(database, "email_login_challenges")).toBe(0);
    expect(count(database, "auth_sessions")).toBe(0);
    expect(count(database, "auth_rate_limits")).toBe(0);
    expect(count(database, "team_auth_tickets")).toBe(0);
    expect(count(database, "remote_sessions")).toBe(0);
  });
});

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE email_login_challenges (
      id_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE auth_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL
    );
    CREATE TABLE team_auth_tickets (
      ticket_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE TABLE team_tunnels (
      server_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE remote_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  return database;
}

function insertFixtures(database: DatabaseSync, now: number): void {
  database.prepare("INSERT INTO users(id) VALUES (?)").run("user");
  database.prepare("INSERT INTO team_tunnels(server_id, user_id) VALUES (?, ?)").run("server", "user");
  const challenge = database.prepare(
    "INSERT INTO email_login_challenges(id_hash, expires_at, consumed_at) VALUES (?, ?, ?)",
  );
  challenge.run("active", now + 1, null);
  challenge.run("expired", now - 1, null);
  challenge.run("consumed", now + 1, now - 1);
  const session = database.prepare(
    "INSERT INTO auth_sessions(id, user_id, expires_at, revoked_at) VALUES (?, ?, ?, ?)",
  );
  session.run("active", "user", now + 1, null);
  session.run("expired", "user", now - 1, null);
  session.run("revoked", "user", now + 1, now - 1);
  const rateLimit = database.prepare("INSERT INTO auth_rate_limits(key_hash, window_start) VALUES (?, ?)");
  rateLimit.run("current", now - 15 * 60_000 + 1);
  rateLimit.run("expired", now - 15 * 60_000 - 1);
  const ticket = database.prepare(
    "INSERT INTO team_auth_tickets(ticket_hash, user_id, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
  );
  ticket.run("active", "user", now + 1, null);
  ticket.run("expired", "user", now - 1, null);
  ticket.run("consumed", "user", now + 1, now - 1);
  const remoteSession = database.prepare(
    "INSERT INTO remote_sessions(session_id, user_id, expires_at, ended_at) VALUES (?, ?, ?, ?)",
  );
  remoteSession.run("active", "user", now + 1, null);
  remoteSession.run("expired", "user", now - 10 * 60_000 - 1, null);
  remoteSession.run("ended", "user", now + 1, now - 10 * 60_000 - 1);
}

function runRetention(database: DatabaseSync, now: number): void {
  for (const operation of authRetentionOperations(now)) {
    database.prepare(operation.sql).run(operation.cutoff);
  }
}

function ids(database: DatabaseSync, table: string, column: string): string[] {
  return database
    .prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
    .all()
    .map((row) => String(row.id));
}

function count(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}
