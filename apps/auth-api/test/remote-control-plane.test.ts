import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  deliverPendingRemoteAuthEvents,
  RemoteControlPlane,
  RemoteTicketSigner,
  verifyRemoteServiceSignature,
} from "../src/server/remote-control-plane";

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
      ) VALUES ('host-1', 'owner', 'Studio Mac', 'old.example.test', 'active', 100, 200, '${"a".repeat(64)}');
    `);

    database.exec(readFileSync(new URL("../migrations/0012_remote_control_plane.sql", import.meta.url), "utf8"));
    database.exec(readFileSync(new URL("../migrations/0013_remote_session_lifecycle.sql", import.meta.url), "utf8"));

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
      clientPublicKey: "client-public-key",
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
      clientPublicKey: "client-public-key",
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

describe("Remote service authentication", () => {
  it("accepts only a current request with a valid HMAC", async () => {
    const secret = "s".repeat(32);
    const body = '{"sessionId":"session-1"}';
    const timestamp = "1900000000";
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("base64url");
    await expect(verifyRemoteServiceSignature(secret, body, timestamp, signature, 1_900_000_000_000)).resolves.toBe(
      true,
    );
    await expect(verifyRemoteServiceSignature(secret, body, timestamp, "invalid", 1_900_000_000_000)).resolves.toBe(
      false,
    );
    await expect(verifyRemoteServiceSignature(secret, body, timestamp, signature, 1_900_001_000_000)).resolves.toBe(
      false,
    );
  });
});

describe("RemoteControlPlane", () => {
  it("returns the existing membership ID and ends live sessions when a member accepts a new invite", async () => {
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
    database.exec(readFileSync(new URL("../migrations/0013_remote_session_lifecycle.sql", import.meta.url), "utf8"));
    database
      .prepare(
        `INSERT INTO remote_memberships(
          membership_id, host_id, user_id, role, status, created_at, updated_at
        ) VALUES ('existing-member', 'host-1', 'member', 'admin', 'active', 100, 100)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO remote_sessions(
           session_id, host_id, user_id, membership_id, started_at, expires_at
         ) VALUES ('live-session', 'host-1', 'member', 'existing-member', 100, 5000)`,
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
        ) VALUES ('invite-1', 'host-1', ?, 'member', 'owner', 2000, 100)`,
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
    database.prepare("UPDATE remote_hosts SET device_public_key = 'host-public-key' WHERE host_id = 'host-1'").run();
    await expect(controlPlane.previewInvite(token)).resolves.toMatchObject({
      hostId: "host-1",
      devicePublicKey: "host-public-key",
    });

    await expect(
      controlPlane.acceptInvite({ id: "member", email: "member@example.com", name: null, avatarUrl: null }, token),
    ).resolves.toEqual({ hostId: "host-1", membershipId: "existing-member", role: "member" });
    expect(
      database.prepare("SELECT role FROM remote_memberships WHERE membership_id = 'existing-member'").get(),
    ).toEqual({
      role: "member",
    });
    expect(database.prepare("SELECT ended_at FROM remote_sessions WHERE session_id = 'live-session'").get()).toEqual({
      ended_at: 1_000,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_auth_events").get()).toEqual({ count: 1 });
  });

  it("protects the owner and validates only an active resume session", async () => {
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
      INSERT INTO users(id) VALUES ('owner');
      INSERT INTO team_tunnels(
        server_id, user_id, tunnel_name, api_hostname, status, created_at, updated_at, machine_token_hash
      ) VALUES ('host-1', 'owner', 'Studio Mac', 'old.example.test', 'active', 100, 200, '${"a".repeat(64)}');
    `);
    database.exec(readFileSync(new URL("../migrations/0012_remote_control_plane.sql", import.meta.url), "utf8"));
    database.exec(readFileSync(new URL("../migrations/0013_remote_session_lifecycle.sql", import.meta.url), "utf8"));
    const pair = await generateKeyPair("ES256", { extractable: true });
    const privateJwk = await exportJWK(pair.privateKey);
    const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", use: "sig", alg: "ES256" };
    const webhookBodies: string[] = [];
    let webhookAvailable = true;
    const webhookFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      webhookBodies.push(String(init?.body ?? ""));
      return new Response(null, { status: webhookAvailable ? 204 : 503 });
    };
    const bindings = {
      DB: sqliteD1(database),
      REMOTE_TICKET_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "test-key", alg: "ES256" }),
      REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      REMOTE_TICKET_KEY_ID: "test-key",
      REMOTE_AUTH_WEBHOOK_URL: "https://signal.example.test/internal/auth-events",
      REMOTE_AUTH_WEBHOOK_SECRET: "s".repeat(32),
    };
    const controlPlane = new RemoteControlPlane(bindings, {
      now: () => 1_000,
      fetch: webhookFetch,
    });
    const owner = { id: "owner", email: "owner@example.com", name: null, avatarUrl: null };
    const firstRegistration = await controlPlane.registerHost(owner, {
      hostId: "host-1",
      name: "Studio Mac",
      ownerMembershipId: "local-owner",
      rotateCredential: false,
    });
    const registration = await controlPlane.registerHost(owner, {
      hostId: "host-1",
      name: "Studio Mac",
      ownerMembershipId: "local-owner",
    });
    if (!firstRegistration.machineToken || !registration.machineToken) {
      throw new Error("The rotated host credential is missing.");
    }
    expect(registration.authEpoch).toBe(firstRegistration.authEpoch + 1);
    const metadataUpdate = await controlPlane.registerHost(owner, {
      hostId: "host-1",
      name: "Renamed Studio Mac",
      ownerMembershipId: "local-owner",
      rotateCredential: false,
      machineToken: registration.machineToken,
    });
    expect(metadataUpdate).toMatchObject({ authEpoch: registration.authEpoch, machineToken: null });
    await expect(controlPlane.issueHostTicket("host-1", registration.machineToken)).resolves.toMatchObject({
      ticket: expect.any(String),
    });
    await expect(controlPlane.issueHostTicket("host-1", firstRegistration.machineToken)).rejects.toMatchObject({
      code: "host_unauthorized",
    });
    expect(database.prepare("SELECT membership_id FROM remote_memberships WHERE user_id = 'owner'").get()).toEqual({
      membership_id: "host-1:owner",
    });
    const invite = await controlPlane.createInvite(owner, { hostId: "host-1", role: "member" });
    await expect(controlPlane.acceptInvite(owner, invite.token)).rejects.toMatchObject({
      code: "owner_membership_protected",
    });
    expect(database.prepare("SELECT role FROM remote_memberships WHERE user_id = 'owner'").get()).toEqual({
      role: "owner",
    });

    const session = await controlPlane.startSession(owner.id, "host-1");
    await expect(controlPlane.startSession(owner.id, "host-1")).resolves.toEqual(session);
    const claims = {
      sessionId: session.sessionId,
      hostId: "host-1",
      userId: owner.id,
      membershipId: "host-1:owner",
      role: "owner" as const,
      authEpoch: registration.authEpoch,
      sessionExpiresAt: session.expiresAt / 1_000,
    };
    await expect(controlPlane.validateResumeClaims(claims)).resolves.toBe(true);
    webhookAvailable = false;
    await controlPlane.endSession(owner.id, session.sessionId);
    await expect(controlPlane.validateResumeClaims(claims)).resolves.toBe(false);
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_auth_events").get()).toEqual({ count: 1 });
    webhookAvailable = true;
    await deliverPendingRemoteAuthEvents(bindings, 61_001, webhookFetch);
    expect(database.prepare("SELECT COUNT(*) AS count FROM remote_auth_events").get()).toEqual({ count: 0 });
    expect(webhookBodies).toContain(
      JSON.stringify({ type: "remote-session-ended", hostId: "host-1", sessionId: session.sessionId }),
    );

    database.prepare("INSERT INTO users(id) VALUES ('revoked-member')").run();
    database
      .prepare(
        `INSERT INTO remote_memberships(
           membership_id, host_id, user_id, role, status, created_at, updated_at
         ) VALUES ('revoked-membership', 'host-1', 'revoked-member', 'member', 'revoked', 1, 1)`,
      )
      .run();
    await controlPlane.changeMembership(owner.id, {
      hostId: "host-1",
      membershipId: "revoked-membership",
      role: "admin",
    });
    expect(
      database.prepare("SELECT role, status FROM remote_memberships WHERE membership_id = 'revoked-membership'").get(),
    ).toEqual({ role: "admin", status: "revoked" });
    await controlPlane.changeMembership(owner.id, {
      hostId: "host-1",
      membershipId: "revoked-membership",
      role: "admin",
      reactivate: true,
    });
    expect(
      database.prepare("SELECT status FROM remote_memberships WHERE membership_id = 'revoked-membership'").get(),
    ).toEqual({ status: "active" });
    const memberSession = await controlPlane.startSession("revoked-member", "host-1");
    const hostClaims = {
      sessionId: "host-host-1",
      hostId: "host-1",
      userId: owner.id,
      membershipId: "host-1:host",
      role: "host" as const,
      authEpoch: registration.authEpoch,
      sessionExpiresAt: 100,
    };
    const currentAuthEpoch = registration.authEpoch;
    await expect(controlPlane.validateResumeClaims({ ...hostClaims, authEpoch: currentAuthEpoch - 1 })).resolves.toBe(
      false,
    );
    expect(database.prepare("SELECT auth_epoch FROM remote_hosts WHERE host_id = 'host-1'").get()).toEqual({
      auth_epoch: currentAuthEpoch,
    });
    await expect(controlPlane.validateResumeClaims({ ...hostClaims, authEpoch: currentAuthEpoch })).resolves.toBe(true);

    await Promise.all([
      controlPlane.changeMembership(owner.id, {
        hostId: "host-1",
        membershipId: "revoked-membership",
        role: "member",
      }),
      controlPlane.changeMembership(owner.id, {
        hostId: "host-1",
        membershipId: "revoked-membership",
        role: "admin",
      }),
    ]);
    expect(database.prepare("SELECT auth_epoch FROM remote_hosts WHERE host_id = 'host-1'").get()).toEqual({
      auth_epoch: currentAuthEpoch,
    });
    expect(webhookBodies).toContain(
      JSON.stringify({ type: "remote-session-ended", hostId: "host-1", sessionId: memberSession.sessionId }),
    );

    database.prepare("INSERT INTO users(id) VALUES ('competing-owner')").run();
    const competingOwner = {
      id: "competing-owner",
      email: "competing@example.com",
      name: null,
      avatarUrl: null,
    };
    const registrations = await Promise.allSettled([
      controlPlane.registerHost(owner, {
        hostId: "race-host",
        name: "Owner host",
        ownerMembershipId: "race-owner-membership",
      }),
      controlPlane.registerHost(competingOwner, {
        hostId: "race-host",
        name: "Competing host",
        ownerMembershipId: "race-competing-membership",
      }),
    ]);
    expect(registrations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(registrations.filter((result) => result.status === "rejected")).toHaveLength(1);
    const successfulRegistration = registrations.find((result) => result.status === "fulfilled");
    if (successfulRegistration?.status !== "fulfilled") {
      throw new Error("Concurrent host registration did not produce a winner.");
    }
    if (!successfulRegistration.value.machineToken) throw new Error("The winning host credential is missing.");
    await expect(
      controlPlane.issueHostTicket("race-host", successfulRegistration.value.machineToken),
    ).resolves.toMatchObject({ ticket: expect.any(String) });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM remote_memberships WHERE host_id = 'race-host' AND role = 'owner'")
        .get(),
    ).toEqual({ count: 1 });

    const insertInvite = database.prepare(
      `INSERT INTO remote_invites(
         invite_id, host_id, token_hash, email, role, created_by_user_id, expires_at, created_at
       ) VALUES (?, 'host-1', ?, NULL, 'member', 'owner', 999999999, 1)`,
    );
    for (let index = 0; index < 49; index += 1) insertInvite.run(`limit-${index}`, `limit-hash-${index}`);
    await expect(controlPlane.createInvite(owner, { hostId: "host-1", role: "member" })).rejects.toMatchObject({
      code: "invite_limit_reached",
    });
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

  let batchChain = Promise.resolve();
  const adapter = {
    prepare: (sql: string) => new Statement(sql),
    batch: (statements: Statement[]) => {
      const operation = batchChain.then(async () => {
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
      });
      batchChain = operation.then(() => undefined).catch(() => undefined);
      return operation;
    },
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: This focused adapter implements only the D1 methods used by this test.
  return adapter as unknown as D1Database;
}
