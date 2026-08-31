import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("email challenge delivery state migration", () => {
  it("preserves existing challenges as sent and enforces valid delivery states", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(migration("0002_email_login_codes.sql"));
    database
      .prepare(
        `INSERT INTO email_login_challenges(
          id_hash, email, code_hash, source_ip_hash, created_at, expires_at, max_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("challenge-1", "person@example.com", "code", "ip", 1_000, 601_000, 5);

    database.exec("BEGIN");
    database.exec(migration("0012_email_challenge_delivery_state.sql"));
    database.exec("COMMIT");

    expect(
      database.prepare("SELECT email, delivery_state FROM email_login_challenges WHERE id_hash = ?").get("challenge-1"),
    ).toEqual({ email: "person@example.com", delivery_state: "sent" });
    expect(() =>
      database
        .prepare(
          `INSERT INTO email_login_challenges(
            id_hash, email, code_hash, source_ip_hash, created_at, expires_at, max_attempts, delivery_state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("challenge-2", "person@example.com", "code", "ip", 2_000, 602_000, 5, "unknown"),
    ).toThrow();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}
