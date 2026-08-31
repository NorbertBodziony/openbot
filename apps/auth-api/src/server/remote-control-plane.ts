import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { importJWK, type JWK, SignJWT } from "jose";
import type { AuthUser, WorkerBindings } from "./types";

const TICKET_AUDIENCE = "openbot-remote";
const TICKET_TTL_SECONDS = 180;
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const HOST_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_EVENT_RETRY_MS = 60_000;
const MAX_OUTSTANDING_INVITES_PER_HOST = 50;

export type RemoteMemberRole = "owner" | "admin" | "member";

export class RemoteControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RemoteHostRow {
  host_id: string;
  owner_user_id: string;
  name: string;
  logo_key: string | null;
  auth_epoch: number;
  machine_token_hash: string | null;
}

interface RemoteMembershipRow {
  membership_id: string;
  host_id: string;
  user_id: string;
  role: RemoteMemberRole;
  status: "active" | "revoked";
}

interface RemoteSessionRow extends RemoteMembershipRow {
  session_id: string;
  expires_at: number;
  ended_at: number | null;
  auth_epoch: number;
}

export interface RemoteResumeClaims {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: "host" | RemoteMemberRole;
  authEpoch: number;
  sessionExpiresAt: number;
}

interface RemoteInviteRow {
  invite_id: string;
  host_id: string;
  email: string | null;
  role: Exclude<RemoteMemberRole, "owner">;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}

interface TicketSignerConfig {
  privateJwk: string;
  publicJwks: string;
  keyId: string;
}

type RemoteFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type RemoteAuthEvent =
  | { type: "remote-auth-changed"; hostId: string; authEpoch: number }
  | { type: "remote-session-ended"; hostId: string; sessionId: string };

interface RemoteAuthEventRow {
  event_id: string;
  payload: string;
  attempts: number;
}

interface RemotePublicJwk extends DynamicRecord {
  kid: string;
  kty: string;
}

interface RemotePublicJwks {
  keys: RemotePublicJwk[];
}

export class RemoteTicketSigner {
  readonly #keyId: string;
  readonly #publicJwks: RemotePublicJwks;
  readonly #key: ReturnType<typeof importJWK>;

  constructor(config: TicketSignerConfig) {
    this.#keyId = requiredIdentifier(config.keyId, "ticket key ID");
    this.#publicJwks = parseJwks(config.publicJwks, this.#keyId);
    this.#key = importJWK(parseJwk(config.privateJwk), "ES256");
  }

  publicJwks(): RemotePublicJwks {
    return this.#publicJwks;
  }

  async issue(input: {
    sessionId: string;
    hostId: string;
    userId: string;
    membershipId: string;
    role: RemoteMemberRole | "host";
    authEpoch: number;
    sessionExpiresAt: number;
    now: number;
  }): Promise<{ ticket: string; expiresAt: number }> {
    const issuedAt = Math.floor(input.now / 1_000);
    const expiresAt = Math.min(issuedAt + TICKET_TTL_SECONDS, Math.floor(input.sessionExpiresAt / 1_000));
    const ticket = await new SignJWT({
      sessionId: input.sessionId,
      hostId: input.hostId,
      userId: input.userId,
      membershipId: input.membershipId,
      role: input.role,
      authEpoch: input.authEpoch,
      protocolMinimum: 2,
      protocolMaximum: 2,
      sessionExpiresAt: Math.floor(input.sessionExpiresAt / 1_000),
    })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.#keyId })
      .setJti(crypto.randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setAudience(TICKET_AUDIENCE)
      .sign(await this.#key);
    return { ticket, expiresAt: expiresAt * 1_000 };
  }
}

export class RemoteControlPlane {
  readonly #database: D1Database;
  readonly #signer: RemoteTicketSigner;
  readonly #webhookUrl: string | null;
  readonly #webhookSecret: string | null;
  readonly #fetch: RemoteFetch;
  readonly #now: () => number;

  constructor(
    bindings: Pick<
      WorkerBindings,
      | "DB"
      | "REMOTE_TICKET_PRIVATE_JWK"
      | "REMOTE_TICKET_PUBLIC_JWKS"
      | "REMOTE_TICKET_KEY_ID"
      | "REMOTE_AUTH_WEBHOOK_URL"
      | "REMOTE_AUTH_WEBHOOK_SECRET"
    >,
    options: { fetch?: RemoteFetch; now?: () => number } = {},
  ) {
    if (!bindings.REMOTE_TICKET_PRIVATE_JWK || !bindings.REMOTE_TICKET_PUBLIC_JWKS || !bindings.REMOTE_TICKET_KEY_ID) {
      throw new RemoteControlPlaneError(503, "remote_not_configured", "Remote ticket signing is not configured.");
    }
    this.#database = bindings.DB;
    this.#signer = new RemoteTicketSigner({
      privateJwk: bindings.REMOTE_TICKET_PRIVATE_JWK,
      publicJwks: bindings.REMOTE_TICKET_PUBLIC_JWKS,
      keyId: bindings.REMOTE_TICKET_KEY_ID,
    });
    this.#webhookUrl = bindings.REMOTE_AUTH_WEBHOOK_URL?.trim() || null;
    this.#webhookSecret = bindings.REMOTE_AUTH_WEBHOOK_SECRET?.trim() || null;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  publicJwks(): RemotePublicJwks {
    return this.#signer.publicJwks();
  }

  async registerHost(
    user: AuthUser,
    input: { hostId: string; name: string; ownerMembershipId: string; devicePublicKey?: string | null },
  ) {
    const hostId = requiredIdentifier(input.hostId, "host ID");
    const name = requiredText(input.name, 120, "host name");
    const ownerMembershipId = requiredIdentifier(input.ownerMembershipId, "owner membership ID");
    const existing = await this.#host(hostId);
    if (existing && existing.owner_user_id !== user.id) {
      throw new RemoteControlPlaneError(403, "host_owner_mismatch", "This host belongs to another account.");
    }
    const now = this.#now();
    const machineToken = randomToken();
    const machineTokenHash = await sha256(machineToken);
    const membershipId = ownerMembershipId;
    const registration = await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO remote_hosts(
             host_id, owner_user_id, name, device_public_key, machine_token_hash, auth_epoch, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(host_id) DO UPDATE SET
             name = excluded.name,
             device_public_key = excluded.device_public_key,
             machine_token_hash = excluded.machine_token_hash,
             auth_epoch = remote_hosts.auth_epoch + 1,
             updated_at = excluded.updated_at
           WHERE remote_hosts.owner_user_id = excluded.owner_user_id`,
        )
        .bind(hostId, user.id, name, input.devicePublicKey ?? null, machineTokenHash, now, now),
      this.#database
        .prepare(
          `INSERT INTO remote_memberships(
             membership_id, host_id, user_id, role, status, created_at, updated_at
           )
           SELECT ?, host_id, ?, 'owner', 'active', ?, ?
           FROM remote_hosts WHERE host_id = ? AND owner_user_id = ?
           ON CONFLICT(host_id, user_id) DO UPDATE SET
             membership_id = excluded.membership_id,
             role = 'owner', status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(membershipId, user.id, now, now, hostId, user.id),
      this.#authEpochEventStatement(hostId, now, user.id),
    ]);
    if (registration.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new RemoteControlPlaneError(403, "host_owner_mismatch", "This host belongs to another account.");
    }
    await this.#flushAuthEvents();
    const registered = await this.#host(hostId);
    if (!registered || registered.owner_user_id !== user.id || registered.machine_token_hash !== machineTokenHash) {
      throw new RemoteControlPlaneError(
        409,
        "host_registration_superseded",
        "A newer host registration replaced this one.",
      );
    }
    return { hostId, name, membershipId, authEpoch: registered.auth_epoch, machineToken };
  }

  async listHosts(userId: string) {
    const result = await this.#database
      .prepare(
        `SELECT h.host_id, h.name, h.logo_key, h.device_public_key, h.auth_epoch, m.membership_id, m.role
         FROM remote_memberships m
         JOIN remote_hosts h ON h.host_id = m.host_id
         WHERE m.user_id = ? AND m.status = 'active'
         ORDER BY h.name, h.host_id`,
      )
      .bind(userId)
      .all<{
        host_id: string;
        name: string;
        logo_key: string | null;
        device_public_key: string | null;
        auth_epoch: number;
        membership_id: string;
        role: RemoteMemberRole;
      }>();
    return (result.results ?? []).map((row) => ({
      hostId: row.host_id,
      name: row.name,
      logoKey: row.logo_key,
      devicePublicKey: row.device_public_key,
      authEpoch: row.auth_epoch,
      membershipId: row.membership_id,
      role: row.role,
    }));
  }

  async createInvite(
    user: AuthUser,
    input: {
      hostId: string;
      role: Exclude<RemoteMemberRole, "owner">;
      email?: string | null;
      expiresInSeconds?: number;
    },
  ) {
    await this.#requireRole(input.hostId, user.id, ["owner", "admin"]);
    if (input.role !== "admin" && input.role !== "member") throw invalid("invite role");
    const now = this.#now();
    const outstanding = await this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM remote_invites
         WHERE host_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
      )
      .bind(input.hostId, now)
      .first<{ count: number }>();
    if ((outstanding?.count ?? 0) >= MAX_OUTSTANDING_INVITES_PER_HOST) {
      throw new RemoteControlPlaneError(
        429,
        "invite_limit_reached",
        "Revoke or use an active invitation before creating another one.",
      );
    }
    const ttl = input.expiresInSeconds ?? 7 * 24 * 60 * 60;
    if (!Number.isSafeInteger(ttl) || ttl < 300 || ttl > 30 * 24 * 60 * 60) throw invalid("invite lifetime");
    const email = input.email?.trim().toLowerCase() || null;
    const inviteId = crypto.randomUUID();
    const token = randomToken();
    await this.#database
      .prepare(
        `INSERT INTO remote_invites(
           invite_id, host_id, token_hash, email, role, created_by_user_id, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(inviteId, input.hostId, await sha256(token), email, input.role, user.id, now + ttl * 1_000, now)
      .run();
    return { inviteId, token, expiresAt: now + ttl * 1_000 };
  }

  async listInvites(userId: string, hostId: string) {
    await this.#requireRole(hostId, userId, ["owner", "admin"]);
    const result = await this.#database
      .prepare(
        `SELECT invite_id, email, role, expires_at, used_at, revoked_at
         FROM remote_invites WHERE host_id = ? ORDER BY created_at DESC`,
      )
      .bind(hostId)
      .all<{
        invite_id: string;
        email: string | null;
        role: "admin" | "member";
        expires_at: number;
        used_at: number | null;
        revoked_at: number | null;
      }>();
    return (result.results ?? []).map((invite) => ({
      inviteId: invite.invite_id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
      usedAt: invite.used_at,
      revokedAt: invite.revoked_at,
    }));
  }

  async listMembers(userId: string, hostId: string) {
    await this.#requireRole(hostId, userId, ["owner", "admin", "member"]);
    const result = await this.#database
      .prepare(
        `SELECT m.membership_id, m.role, m.status, m.created_at,
                u.email, u.name, u.avatar_url
         FROM remote_memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.host_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at`,
      )
      .bind(hostId)
      .all<{
        membership_id: string;
        role: RemoteMemberRole;
        status: "active" | "revoked";
        created_at: number;
        email: string;
        name: string | null;
        avatar_url: string | null;
      }>();
    return (result.results ?? []).map((member) => ({
      membershipId: member.membership_id,
      role: member.role,
      status: member.status,
      createdAt: member.created_at,
      email: member.email,
      name: member.name,
      avatarUrl: member.avatar_url,
    }));
  }

  async hostAsset(userId: string, hostId: string): Promise<{ logoKey: string | null }> {
    await this.#requireRole(hostId, userId, ["owner", "admin", "member"]);
    const host = await this.#host(hostId);
    if (!host) throw new RemoteControlPlaneError(404, "host_not_found", "The remote host does not exist.");
    return { logoKey: host.logo_key };
  }

  async assertHostOwner(userId: string, hostId: string): Promise<void> {
    await this.#requireRole(hostId, userId, ["owner"]);
  }

  async setHostLogo(userId: string, hostId: string, logoKey: string | null): Promise<string | null> {
    await this.#requireRole(hostId, userId, ["owner"]);
    const host = await this.#host(hostId);
    if (!host) throw new RemoteControlPlaneError(404, "host_not_found", "The remote host does not exist.");
    await this.#database
      .prepare("UPDATE remote_hosts SET logo_key = ?, updated_at = ? WHERE host_id = ?")
      .bind(logoKey, this.#now(), hostId)
      .run();
    return host.logo_key;
  }

  async previewInvite(token: string) {
    const now = this.#now();
    const invite = await this.#database
      .prepare(
        `SELECT i.invite_id, i.host_id, i.email, i.role, i.expires_at, i.used_at, i.revoked_at,
                h.name, h.device_public_key
         FROM remote_invites i JOIN remote_hosts h ON h.host_id = i.host_id
         WHERE i.token_hash = ? LIMIT 1`,
      )
      .bind(await sha256(requiredText(token, 512, "invite token")))
      .first<RemoteInviteRow & { name: string; device_public_key: string | null }>();
    if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= now) {
      throw new RemoteControlPlaneError(404, "invite_invalid", "The invitation is invalid or expired.");
    }
    return {
      inviteId: invite.invite_id,
      hostId: invite.host_id,
      hostName: invite.name,
      role: invite.role,
      expiresAt: invite.expires_at,
      emailBound: Boolean(invite.email),
      devicePublicKey: invite.device_public_key,
    };
  }

  async acceptInvite(user: AuthUser, token: string) {
    const now = this.#now();
    const tokenHash = await sha256(requiredText(token, 512, "invite token"));
    const invite = await this.#database
      .prepare(
        `SELECT invite_id, host_id, email, role, expires_at, used_at, revoked_at
         FROM remote_invites WHERE token_hash = ? LIMIT 1`,
      )
      .bind(tokenHash)
      .first<RemoteInviteRow>();
    if (!invite || invite.used_at || invite.revoked_at || invite.expires_at <= now) {
      throw new RemoteControlPlaneError(404, "invite_invalid", "The invitation is invalid or expired.");
    }
    if (invite.email && invite.email !== user.email.trim().toLowerCase()) {
      throw new RemoteControlPlaneError(403, "invite_email_mismatch", "The invitation is for another account.");
    }
    const existingMembership = await this.#database
      .prepare("SELECT role FROM remote_memberships WHERE host_id = ? AND user_id = ? LIMIT 1")
      .bind(invite.host_id, user.id)
      .first<{ role: RemoteMemberRole }>();
    if (existingMembership?.role === "owner") {
      throw new RemoteControlPlaneError(
        409,
        "owner_membership_protected",
        "The owner cannot accept a member invitation.",
      );
    }
    const membershipId = crypto.randomUUID();
    const accepted = await this.#database.batch([
      this.#database
        .prepare(
          `INSERT INTO remote_memberships(
             membership_id, host_id, user_id, role, status, created_at, updated_at
           ) SELECT ?, ?, ?, ?, 'active', ?, ?
             FROM remote_invites
            WHERE invite_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           ON CONFLICT(host_id, user_id) DO UPDATE SET
             role = CASE WHEN remote_memberships.role = 'owner' THEN 'owner' ELSE excluded.role END,
             status = 'active', updated_at = excluded.updated_at`,
        )
        .bind(membershipId, invite.host_id, user.id, invite.role, now, now, invite.invite_id, now),
      this.#database
        .prepare(
          "UPDATE remote_invites SET used_at = ? WHERE invite_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
        )
        .bind(now, invite.invite_id, now),
    ]);
    if ((accepted[0].meta.changes ?? 0) !== 1 || (accepted[1].meta.changes ?? 0) !== 1) {
      throw new RemoteControlPlaneError(409, "invite_already_used", "The invitation was already used.");
    }
    const membership = await this.#database
      .prepare(
        "SELECT membership_id FROM remote_memberships WHERE host_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
      )
      .bind(invite.host_id, user.id)
      .first<{ membership_id: string }>();
    if (!membership) {
      throw new RemoteControlPlaneError(500, "membership_missing", "The accepted membership could not be loaded.");
    }
    return { hostId: invite.host_id, membershipId: membership.membership_id, role: invite.role };
  }

  async revokeInvite(userId: string, inviteId: string): Promise<void> {
    const invite = await this.#database
      .prepare("SELECT host_id FROM remote_invites WHERE invite_id = ? LIMIT 1")
      .bind(inviteId)
      .first<{ host_id: string }>();
    if (!invite) throw new RemoteControlPlaneError(404, "invite_not_found", "The invitation does not exist.");
    await this.#requireRole(invite.host_id, userId, ["owner", "admin"]);
    await this.#database
      .prepare("UPDATE remote_invites SET revoked_at = ? WHERE invite_id = ? AND used_at IS NULL")
      .bind(this.#now(), inviteId)
      .run();
  }

  async changeMembership(
    actorUserId: string,
    input: {
      hostId: string;
      membershipId: string;
      role?: Exclude<RemoteMemberRole, "owner">;
      revoke?: boolean;
      reactivate?: boolean;
    },
  ): Promise<void> {
    await this.#requireRole(input.hostId, actorUserId, ["owner"]);
    const membership = await this.#database
      .prepare("SELECT membership_id, host_id, user_id, role, status FROM remote_memberships WHERE membership_id = ?")
      .bind(input.membershipId)
      .first<RemoteMembershipRow>();
    if (!membership || membership.host_id !== input.hostId) {
      throw new RemoteControlPlaneError(404, "membership_not_found", "The membership does not exist.");
    }
    if (membership.role === "owner") {
      throw new RemoteControlPlaneError(409, "owner_membership_protected", "The owner membership cannot be changed.");
    }
    const role = input.role ?? membership.role;
    if (role !== "admin" && role !== "member") throw invalid("member role");
    if (input.revoke && input.reactivate) throw invalid("member status");
    const now = this.#now();
    await this.#database.batch([
      this.#database
        .prepare("UPDATE remote_memberships SET role = ?, status = ?, updated_at = ? WHERE membership_id = ?")
        .bind(
          role,
          input.revoke ? "revoked" : input.reactivate ? "active" : membership.status,
          now,
          input.membershipId,
        ),
      this.#database
        .prepare("UPDATE remote_hosts SET auth_epoch = auth_epoch + 1, updated_at = ? WHERE host_id = ?")
        .bind(now, input.hostId),
      this.#database
        .prepare("UPDATE remote_sessions SET ended_at = ? WHERE host_id = ? AND user_id = ? AND ended_at IS NULL")
        .bind(now, input.hostId, membership.user_id),
      this.#authEpochEventStatement(input.hostId, now),
    ]);
    await this.#flushAuthEvents();
  }

  async startSession(userId: string, hostId: string) {
    const membership = await this.#requireRole(hostId, userId, ["owner", "admin", "member"]);
    const now = this.#now();
    await this.#database
      .prepare(
        "UPDATE remote_sessions SET ended_at = ? WHERE host_id = ? AND user_id = ? AND ended_at IS NULL AND expires_at <= ?",
      )
      .bind(now, hostId, userId, now)
      .run();
    const existing = await this.#database
      .prepare(
        `SELECT session_id, expires_at FROM remote_sessions
         WHERE host_id = ? AND user_id = ? AND membership_id = ? AND ended_at IS NULL AND expires_at > ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .bind(hostId, userId, membership.membership_id, now)
      .first<{ session_id: string; expires_at: number }>();
    if (existing) return { sessionId: existing.session_id, hostId, expiresAt: existing.expires_at };
    const sessionId = crypto.randomUUID();
    const expiresAt = now + SESSION_TTL_SECONDS * 1_000;
    await this.#database
      .prepare(
        `INSERT OR IGNORE INTO remote_sessions(session_id, host_id, user_id, membership_id, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(sessionId, hostId, userId, membership.membership_id, now, expiresAt)
      .run();
    const active = await this.#database
      .prepare(
        `SELECT session_id, expires_at FROM remote_sessions
         WHERE host_id = ? AND user_id = ? AND ended_at IS NULL AND expires_at > ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .bind(hostId, userId, now)
      .first<{ session_id: string; expires_at: number }>();
    if (!active) throw new RemoteControlPlaneError(503, "session_unavailable", "The remote session could not start.");
    return { sessionId: active.session_id, hostId, expiresAt: active.expires_at };
  }

  async endSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.#database
      .prepare("SELECT host_id FROM remote_sessions WHERE session_id = ? AND user_id = ? AND ended_at IS NULL LIMIT 1")
      .bind(sessionId, userId)
      .first<{ host_id: string }>();
    if (!session) return;
    const now = this.#now();
    const event = { type: "remote-session-ended" as const, hostId: session.host_id, sessionId };
    await this.#database.batch([
      this.#database
        .prepare("UPDATE remote_sessions SET ended_at = ? WHERE session_id = ? AND user_id = ? AND ended_at IS NULL")
        .bind(now, sessionId, userId),
      this.#authEventStatement(event, now),
    ]);
    await this.#flushAuthEvents();
  }

  async validateResumeClaims(claims: RemoteResumeClaims): Promise<boolean> {
    const now = this.#now();
    if (claims.sessionExpiresAt * 1_000 <= now || !Number.isSafeInteger(claims.authEpoch)) return false;
    if (claims.role === "host") {
      const host = await this.#host(claims.hostId);
      return Boolean(
        host &&
          claims.sessionId === `host-${host.host_id}` &&
          claims.userId === host.owner_user_id &&
          claims.membershipId === `${host.host_id}:host` &&
          claims.authEpoch === host.auth_epoch,
      );
    }
    const session = await this.#database
      .prepare(
        `SELECT s.session_id, s.expires_at, s.ended_at, m.membership_id, m.host_id, m.user_id, m.role, m.status,
                h.auth_epoch
           FROM remote_sessions s
           JOIN remote_memberships m ON m.membership_id = s.membership_id
           JOIN remote_hosts h ON h.host_id = s.host_id
          WHERE s.session_id = ? LIMIT 1`,
      )
      .bind(claims.sessionId)
      .first<RemoteSessionRow>();
    return Boolean(
      session &&
        !session.ended_at &&
        session.expires_at > now &&
        session.status === "active" &&
        session.host_id === claims.hostId &&
        session.user_id === claims.userId &&
        session.membership_id === claims.membershipId &&
        session.role === claims.role &&
        session.auth_epoch === claims.authEpoch &&
        Math.floor(session.expires_at / 1_000) === claims.sessionExpiresAt,
    );
  }

  async issueSessionTicket(userId: string, sessionId: string) {
    const now = this.#now();
    const session = await this.#database
      .prepare(
        `SELECT s.session_id, s.expires_at, s.ended_at, m.membership_id, m.host_id, m.user_id, m.role, m.status,
                h.auth_epoch
         FROM remote_sessions s
         JOIN remote_memberships m ON m.membership_id = s.membership_id
         JOIN remote_hosts h ON h.host_id = s.host_id
         WHERE s.session_id = ? AND s.user_id = ? LIMIT 1`,
      )
      .bind(sessionId, userId)
      .first<RemoteSessionRow>();
    if (!session || session.ended_at || session.expires_at <= now || session.status !== "active") {
      throw new RemoteControlPlaneError(403, "session_inactive", "The remote session is not active.");
    }
    return this.#signer.issue({
      sessionId,
      hostId: session.host_id,
      userId,
      membershipId: session.membership_id,
      role: session.role,
      authEpoch: session.auth_epoch,
      sessionExpiresAt: session.expires_at,
      now,
    });
  }

  async issueHostTicket(hostId: string, machineToken: string) {
    const host = await this.#host(hostId);
    if (!host?.machine_token_hash || host.machine_token_hash !== (await sha256(machineToken))) {
      throw new RemoteControlPlaneError(401, "host_unauthorized", "The host credential is invalid.");
    }
    return this.#signer.issue({
      sessionId: `host-${hostId}`,
      hostId,
      userId: host.owner_user_id,
      membershipId: `${hostId}:host`,
      role: "host",
      authEpoch: host.auth_epoch,
      sessionExpiresAt: this.#now() + HOST_SESSION_TTL_SECONDS * 1_000,
      now: this.#now(),
    });
  }

  async #requireRole(hostId: string, userId: string, roles: RemoteMemberRole[]): Promise<RemoteMembershipRow> {
    const membership = await this.#database
      .prepare(
        `SELECT membership_id, host_id, user_id, role, status
         FROM remote_memberships WHERE host_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      )
      .bind(hostId, userId)
      .first<RemoteMembershipRow>();
    if (!membership || !roles.includes(membership.role)) {
      throw new RemoteControlPlaneError(
        403,
        "remote_permission_denied",
        "The account cannot perform this remote operation.",
      );
    }
    return membership;
  }

  #host(hostId: string): Promise<RemoteHostRow | null> {
    return this.#database
      .prepare(
        `SELECT host_id, owner_user_id, name, logo_key, auth_epoch, machine_token_hash
         FROM remote_hosts WHERE host_id = ? LIMIT 1`,
      )
      .bind(hostId)
      .first<RemoteHostRow>();
  }

  #authEventStatement(event: RemoteAuthEvent, now: number): D1PreparedStatement {
    return this.#database
      .prepare(
        "INSERT INTO remote_auth_events(event_id, payload, created_at, attempts, next_attempt_at) VALUES (?, ?, ?, 0, ?)",
      )
      .bind(crypto.randomUUID(), JSON.stringify(event), now, now);
  }

  #authEpochEventStatement(hostId: string, now: number, ownerUserId?: string): D1PreparedStatement {
    return this.#database
      .prepare(
        `INSERT INTO remote_auth_events(event_id, payload, created_at, attempts, next_attempt_at)
         SELECT ?, json_object('type', 'remote-auth-changed', 'hostId', host_id, 'authEpoch', auth_epoch), ?, 0, ?
         FROM remote_hosts WHERE host_id = ? AND (? IS NULL OR owner_user_id = ?)`,
      )
      .bind(crypto.randomUUID(), now, now, hostId, ownerUserId ?? null, ownerUserId ?? null);
  }

  async #flushAuthEvents(): Promise<void> {
    await deliverRemoteAuthEvents({
      database: this.#database,
      webhookUrl: this.#webhookUrl,
      webhookSecret: this.#webhookSecret,
      fetch: this.#fetch,
      now: this.#now(),
    });
  }
}

export async function deliverPendingRemoteAuthEvents(
  bindings: Pick<WorkerBindings, "DB" | "REMOTE_AUTH_WEBHOOK_URL" | "REMOTE_AUTH_WEBHOOK_SECRET">,
  now: number,
  fetcher: RemoteFetch = fetch,
): Promise<void> {
  await deliverRemoteAuthEvents({
    database: bindings.DB,
    webhookUrl: bindings.REMOTE_AUTH_WEBHOOK_URL?.trim() || null,
    webhookSecret: bindings.REMOTE_AUTH_WEBHOOK_SECRET?.trim() || null,
    fetch: fetcher,
    now,
  });
}

async function deliverRemoteAuthEvents(input: {
  database: D1Database;
  webhookUrl: string | null;
  webhookSecret: string | null;
  fetch: RemoteFetch;
  now: number;
}): Promise<void> {
  if (!input.webhookUrl || !input.webhookSecret) return;
  const result = await input.database
    .prepare(
      "SELECT event_id, payload, attempts FROM remote_auth_events WHERE next_attempt_at <= ? ORDER BY created_at LIMIT 50",
    )
    .bind(input.now)
    .all<RemoteAuthEventRow>();
  for (const event of result.results ?? []) {
    try {
      const timestamp = Math.floor(input.now / 1_000).toString();
      const signature = await hmacSha256(input.webhookSecret, `${timestamp}.${event.payload}`);
      const response = await input.fetch(input.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OpenBot-Timestamp": timestamp,
          "OpenBot-Signature": signature,
        },
        body: event.payload,
      });
      if (!response.ok) throw new Error("Remote Signal rejected the authorization event.");
      await input.database.prepare("DELETE FROM remote_auth_events WHERE event_id = ?").bind(event.event_id).run();
    } catch {
      const delay = Math.min(AUTH_EVENT_RETRY_MS * 2 ** Math.min(event.attempts, 6), 60 * 60_000);
      await input.database
        .prepare("UPDATE remote_auth_events SET attempts = attempts + 1, next_attempt_at = ? WHERE event_id = ?")
        .bind(input.now + delay, event.event_id)
        .run();
    }
  }
}

function requiredIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(value)) throw invalid(name);
  return value;
}

function requiredText(value: string, maximum: number, name: string): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw invalid(name);
  return text;
}

function invalid(name: string): RemoteControlPlaneError {
  return new RemoteControlPlaneError(400, "invalid_remote_request", `The ${name} is invalid.`);
}

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

export async function verifyRemoteServiceSignature(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(now - timestampSeconds * 1_000) > 5 * 60_000) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)).buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function parseJwk(value: string): JWK {
  const parsed = JSON.parse(value);
  if (!isDynamicRecord(parsed) || parsed.kty !== "EC") {
    throw new Error("REMOTE_TICKET_PRIVATE_JWK is invalid.");
  }
  return { ...parsed, kty: "EC" };
}

function parseJwks(value: string, keyId: string): RemotePublicJwks {
  const parsed = JSON.parse(value);
  if (!isDynamicRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error("REMOTE_TICKET_PUBLIC_JWKS is invalid.");
  }
  const keys = parsed.keys.map(parsePublicJwk);
  if (!keys.some((key) => key.kid === keyId && key.kty === "EC"))
    throw new Error("The public JWKS does not contain the active key.");
  return { keys };
}

function parsePublicJwk(value: unknown): RemotePublicJwk {
  if (!isDynamicRecord(value) || !isString(value.kid) || !isString(value.kty)) {
    throw new Error("REMOTE_TICKET_PUBLIC_JWKS is invalid.");
  }
  return { ...value, kid: value.kid, kty: value.kty };
}
