import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { RemoteControlPlane, RemoteTicketSigner } from "../src/server/remote-control-plane";

describe("remote control plane migration", () => {
  it("keeps each tunnel owner and does not import other members", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE team_tunnels (
        server_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        tunnel_id TEXT,
        tunnel_name TEXT NOT NULL,
        api_hostname TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        machine_token_hash TEXT
      );
      INSERT INTO users(id) VALUES ('owner'), ('former-member');
      INSERT INTO team_tunnels(
        server_id, user_id, tunnel_name, api_hostname, status, created_at, updated_at, machine_token_hash
      ) VALUES ('host-1', 'owner', 'Studio Mac', 'old.example.test', 'active', 100, 200, 'machine-hash');
    `);

    database.exec(readFileSync(new URL("../migrations/0012_remote_control_plane.sql", import.meta.url), "utf8"));

    expect(database.prepare("SELECT host_id, owner_user_id, auth_epoch FROM remote_hosts").all()).toEqual([
      { host_id: "host-1", owner_user_id: "owner", auth_epoch: 1 },
    ]);
    expect(database.prepare("SELECT membership_id, user_id, role, status FROM remote_memberships").all()).toEqual([
      { membership_id: "host-1:owner", user_id: "owner", role: "owner", status: "active" },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});

describe("RemoteTicketSigner", () => {
  it("issues a short ES256 ticket with the fixed protocol version", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
    const signer = new RemoteTicketSigner({
      privateJwk: JSON.stringify({ ...privateJwk, kid: "test-key", alg: "ES256" }),
      publicJwks: JSON.stringify({ keys: [publicJwk] }),
      keyId: "test-key",
    });

    const result = await signer.issue({
      sessionId: "session-1",
      hostId: "host-1",
      userId: "user-1",
      membershipId: "member-1",
      role: "member",
      authEpoch: 3,
      sessionExpiresAt: 1_900_086_400_000,
      now: 1_900_000_000_000,
    });
    const key = await importJWK(publicJwk, "ES256");
    const verified = await jwtVerify(result.ticket, key, {
      audience: "openbot-remote",
      algorithms: ["ES256"],
      currentDate: new Date(1_900_000_001_000),
    });
    expect(verified.protectedHeader.kid).toBe("test-key");
    expect(verified.payload).toMatchObject({
      sessionId: "session-1",
      hostId: "host-1",
      membershipId: "member-1",
      role: "member",
      authEpoch: 3,
      protocolMinimum: 2,
      protocolMaximum: 2,
      sessionExpiresAt: 1_900_086_400,
    });
    expect(result.expiresAt).toBe(1_900_000_180_000);
  });

  it("does not issue a ticket beyond the logical session expiration", async () => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
    const signer = new RemoteTicketSigner({
      privateJwk: JSON.stringify({ ...privateJwk, kid: "test-key", alg: "ES256" }),
      publicJwks: JSON.stringify({ keys: [publicJwk] }),
      keyId: "test-key",
    });
    const result = await signer.issue({
      sessionId: "session-1",
      hostId: "host-1",
      userId: "user-1",
      membershipId: "member-1",
      role: "member",
      authEpoch: 1,
      sessionExpiresAt: 1_900_000_030_000,
      now: 1_900_000_000_000,
    });
    expect(result.expiresAt).toBe(1_900_000_030_000);
  });
});

describe("RemoteControlPlane", () => {
  it("returns the existing membership ID when a revoked member accepts a new invite", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE team_tunnels (
        server_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        tunnel_id TEXT,
        tunnel_name TEXT NOT NULL,
        api_hostname TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        machine_token_hash TEXT
      );
      INSERT INTO users(id) VALUES ('owner'), ('member');
      INSERT INTO team_tunnels(
        server_id, user_id, tunnel_name, api_hostname, status, created_at, updated_at, machine_token_hash
      ) VALUES ('host-1', 'owner', 'Studio Mac', 'old.example.test', 'active', 100, 200, 'machine-hash');
    `);
    database.exec(readFileSync(new URL("../migrations/0012_remote_control_plane.sql", import.meta.url), "utf8"));
    database
      .prepare(
        `INSERT INTO remote_memberships(
          membership_id, host_id, user_id, role, status, created_at, updated_at
        ) VALUES ('existing-member', 'host-1', 'member', 'member', 'revoked', 100, 100)`,
      )
      .run();
    const token = "invite-token";
    const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString(
      "base64url",
    );
    database
      .prepare(
        `INSERT INTO remote_invites(
          invite_id, host_id, token_hash, role, created_by_user_id, expires_at, created_at
        ) VALUES ('invite-1', 'host-1', ?, 'admin', 'owner', 2000, 100)`,
      )
      .run(tokenHash);
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
    const controlPlane = new RemoteControlPlane(
      {
        DB: sqliteD1(database),
        REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "test-key", alg: "ES256" }),
        REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
        REMOTE_TICKET_KEY_ID: "test-key",
      },
      { now: () => 1_000 },
    );

    await expect(
      controlPlane.acceptInvite({ id: "member", email: "member@example.com", name: null, avatarUrl: null }, token),
    ).resolves.toEqual({ hostId: "host-1", membershipId: "existing-member", role: "admin" });
  });
});

function sqliteD1(database: DatabaseSync): D1Database {
  class Statement {
    readonly sql: string;
    readonly values: SQLInputValue[];

    constructor(sql: string, values: SQLInputValue[] = []) {
      this.sql = sql;
      this.values = values;
    }

    bind(...values: SQLInputValue[]) {
      return new Statement(this.sql, values);
    }

    async first<Value>() {
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: The test adapter must implement D1's generic result contract.
      return (database.prepare(this.sql).get(...this.values) as Value | undefined) ?? null;
    }

    async all<Value>() {
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: The test adapter must implement D1's generic result contract.
      return { success: true, results: database.prepare(this.sql).all(...this.values) as Value[] };
    }

    async run() {
      const result = database.prepare(this.sql).run(...this.values);
      return { success: true, meta: { changes: Number(result.changes) }, results: [] };
    }
  }

  const adapter = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: This focused adapter implements only the D1 methods used by this test.
  return adapter as unknown as D1Database;
}
