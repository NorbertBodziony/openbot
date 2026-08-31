import { sha256 } from "./crypto";
import type {
  AuthRepository,
  AuthUser,
  EmailChallengeDeliveryState,
  EmailChallengeRecord,
  EmailVerificationResult,
} from "./types";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}

interface ChallengeRow {
  email: string;
  code_hash: string;
  expires_at: number;
  failed_attempts: number;
  max_attempts: number;
  consumed_at: number | null;
  delivery_state: EmailChallengeDeliveryState;
}

export class D1AuthRepository implements AuthRepository {
  constructor(private readonly database: D1Database) {}

  async latestEmailChallengeAt(email: string): Promise<number | null> {
    const row = await this.database
      .prepare(
        `SELECT created_at FROM email_login_challenges
         WHERE email = ? AND consumed_at IS NULL AND delivery_state IN ('pending', 'sent')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(email)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }

  async findEmailChallenge(idHash: string): Promise<EmailChallengeRecord | null> {
    const row = await this.database
      .prepare(
        `SELECT email, created_at, expires_at, consumed_at, delivery_state
         FROM email_login_challenges WHERE id_hash = ?`,
      )
      .bind(idHash)
      .first<{
        email: string;
        created_at: number;
        expires_at: number;
        consumed_at: number | null;
        delivery_state: EmailChallengeDeliveryState;
      }>();
    return row
      ? {
          email: row.email,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          consumedAt: row.consumed_at,
          deliveryState: row.delivery_state,
        }
      : null;
  }

  async createEmailChallenge(input: {
    idHash: string;
    email: string;
    codeHash: string;
    sourceIpHash: string;
    createdAt: number;
    expiresAt: number;
    maxAttempts: number;
  }): Promise<boolean> {
    const result = await this.database
      .prepare(
        `INSERT INTO email_login_challenges(
          id_hash, email, code_hash, source_ip_hash, created_at, expires_at, max_attempts, delivery_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(id_hash) DO NOTHING`,
      )
      .bind(
        input.idHash,
        input.email,
        input.codeHash,
        input.sourceIpHash,
        input.createdAt,
        input.expiresAt,
        input.maxAttempts,
      )
      .run();
    return result.meta.changes === 1;
  }

  async completeEmailChallengeDelivery(idHash: string, state: "sent" | "failed", now: number): Promise<void> {
    if (state === "sent") {
      await this.database
        .prepare(
          "UPDATE email_login_challenges SET delivery_state = 'sent' WHERE id_hash = ? AND delivery_state = 'pending'",
        )
        .bind(idHash)
        .run();
      return;
    }
    await this.database
      .prepare(
        `UPDATE email_login_challenges SET delivery_state = 'failed', consumed_at = COALESCE(consumed_at, ?)
         WHERE id_hash = ? AND delivery_state = 'pending'`,
      )
      .bind(now, idHash)
      .run();
  }

  async verifyEmailChallenge(input: {
    idHash: string;
    codeHash: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
  }): Promise<EmailVerificationResult> {
    const challenge = await this.database
      .prepare(
        `SELECT email, code_hash, expires_at, failed_attempts, max_attempts, consumed_at, delivery_state
         FROM email_login_challenges WHERE id_hash = ?`,
      )
      .bind(input.idHash)
      .first<ChallengeRow>();
    if (!challenge || challenge.delivery_state === "failed" || challenge.consumed_at !== null) {
      return { status: "invalid" };
    }
    if (challenge.expires_at <= input.now) return { status: "expired" };
    if (challenge.failed_attempts >= challenge.max_attempts) {
      return { status: "too_many_attempts" };
    }
    if (!constantTimeEqual(challenge.code_hash, input.codeHash)) {
      const result = await this.database
        .prepare(
          `UPDATE email_login_challenges
           SET failed_attempts = failed_attempts + 1
           WHERE id_hash = ? AND delivery_state != 'failed' AND consumed_at IS NULL AND failed_attempts < max_attempts`,
        )
        .bind(input.idHash)
        .run();
      return result.meta.changes > 0 && challenge.failed_attempts + 1 >= challenge.max_attempts
        ? { status: "too_many_attempts" }
        : { status: "invalid" };
    }

    const consumed = await this.database
      .prepare(
        `UPDATE email_login_challenges SET consumed_at = ?
         WHERE id_hash = ? AND delivery_state != 'failed' AND consumed_at IS NULL
           AND expires_at > ? AND failed_attempts < max_attempts`,
      )
      .bind(input.now, input.idHash, input.now)
      .run();
    if (consumed.meta.changes !== 1) return { status: "invalid" };

    const user = await this.upsertEmailUser(challenge.email, input.now);
    await this.database
      .prepare(
        `INSERT INTO auth_sessions(
          id, user_id, token_hash, expires_at, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(input.session.id, user.id, await sha256(input.session.token), input.session.expiresAt, input.now, input.now)
      .run();
    return {
      status: "verified",
      session: { sessionToken: input.session.token, user },
    };
  }

  async incrementRateLimit(
    keyHash: string,
    windowStart: number,
    limit: number,
  ): Promise<{ allowed: boolean; count: number; windowStart: number }> {
    const row = await this.database
      .prepare(
        `INSERT INTO auth_rate_limits(key_hash, window_start, attempts) VALUES (?, ?, 1)
         ON CONFLICT(key_hash, window_start) DO UPDATE SET attempts = attempts + 1
         RETURNING attempts`,
      )
      .bind(keyHash, windowStart)
      .first<{ attempts: number }>();
    const count = row?.attempts ?? limit + 1;
    return { allowed: count <= limit, count, windowStart };
  }

  async authenticate(sessionToken: string, now: number): Promise<AuthUser | null> {
    const tokenHash = await sha256(sessionToken);
    const row = await this.database
      .prepare(
        `SELECT users.id, users.email, users.name, users.avatar_url
         FROM auth_sessions
         JOIN users ON users.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ?
           AND auth_sessions.revoked_at IS NULL
           AND auth_sessions.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<UserRow>();
    if (!row) return null;
    await this.database
      .prepare("UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?")
      .bind(now, tokenHash)
      .run();
    return mapUser(row);
  }

  async revokeSession(sessionToken: string, now: number): Promise<void> {
    await this.database
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?")
      .bind(now, await sha256(sessionToken))
      .run();
  }

  async updateUserName(userId: string, name: string, now: number): Promise<AuthUser> {
    const row = await this.database
      .prepare(
        `UPDATE users SET name = ?, updated_at = ?
         WHERE id = ?
         RETURNING id, email, name, avatar_url`,
      )
      .bind(name, now, userId)
      .first<UserRow>();
    if (!row) throw new Error("User not found.");
    return mapUser(row);
  }

  async updateUserAvatar(
    userId: string,
    avatarUrl: string | null,
    expectedAvatarUrl: string | null,
    now: number,
  ): Promise<AuthUser | null> {
    const row = await this.database
      .prepare(
        `UPDATE users SET avatar_url = ?, updated_at = ?
         WHERE id = ? AND avatar_url IS ?
         RETURNING id, email, name, avatar_url`,
      )
      .bind(avatarUrl, now, userId, expectedAvatarUrl)
      .first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async createTeamAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO team_auth_tickets(
          ticket_hash, user_id, server_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(input.ticketHash, input.userId, input.serverId, input.createdAt, input.expiresAt)
      .run();
  }

  async redeemTeamAuthTicket(input: { ticketHash: string; serverId: string; now: number }): Promise<AuthUser | null> {
    const consumed = await this.database
      .prepare(
        `UPDATE team_auth_tickets SET consumed_at = ?
         WHERE ticket_hash = ? AND server_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .bind(input.now, input.ticketHash, input.serverId, input.now)
      .run();
    if (consumed.meta.changes !== 1) return null;
    const row = await this.database
      .prepare(
        `SELECT users.id, users.email, users.name, users.avatar_url
         FROM team_auth_tickets
         JOIN users ON users.id = team_auth_tickets.user_id
         WHERE team_auth_tickets.ticket_hash = ?`,
      )
      .bind(input.ticketHash)
      .first<UserRow>();
    return row ? mapUser(row) : null;
  }

  private async upsertEmailUser(email: string, now: number): Promise<AuthUser> {
    const existing = await this.database
      .prepare("SELECT id, email, name, avatar_url FROM users WHERE email = ?")
      .bind(email)
      .first<UserRow>();
    if (existing) return mapUser(existing);
    const id = crypto.randomUUID();
    await this.database
      .prepare(
        `INSERT INTO users(
          id, identity_key, email, name, avatar_url, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .bind(id, `email:${email}`, email, now, now)
      .run();
    return { id, email, name: null, avatarUrl: null };
  }
}

function mapUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url };
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
