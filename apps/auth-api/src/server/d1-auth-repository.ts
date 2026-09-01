import { sha256 } from "./crypto";
import type {
  AuthRepository,
  AuthUser,
  EmailVerificationResult,
  MobileAuthDevice,
  MobileAuthDeviceIdentity,
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
}

export class D1AuthRepository implements AuthRepository {
  constructor(private readonly database: D1Database) {}

  async latestEmailChallengeAt(email: string): Promise<number | null> {
    const row = await this.database
      .prepare("SELECT created_at FROM email_login_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1")
      .bind(email)
      .first<{ created_at: number }>();
    return row?.created_at ?? null;
  }

  async createEmailChallenge(input: {
    idHash: string;
    email: string;
    codeHash: string;
    sourceIpHash: string;
    createdAt: number;
    expiresAt: number;
    maxAttempts: number;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO email_login_challenges(
          id_hash, email, code_hash, source_ip_hash, created_at, expires_at, max_attempts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
  }

  async cancelEmailChallenge(idHash: string, now: number): Promise<void> {
    await this.database
      .prepare("UPDATE email_login_challenges SET consumed_at = ? WHERE id_hash = ?")
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
        `SELECT email, code_hash, expires_at, failed_attempts, max_attempts, consumed_at
         FROM email_login_challenges WHERE id_hash = ?`,
      )
      .bind(input.idHash)
      .first<ChallengeRow>();
    if (!challenge || challenge.consumed_at !== null) return { status: "invalid" };
    if (challenge.expires_at <= input.now) return { status: "expired" };
    if (challenge.failed_attempts >= challenge.max_attempts) {
      return { status: "too_many_attempts" };
    }
    if (!constantTimeEqual(challenge.code_hash, input.codeHash)) {
      const result = await this.database
        .prepare(
          `UPDATE email_login_challenges
           SET failed_attempts = failed_attempts + 1
           WHERE id_hash = ? AND consumed_at IS NULL AND failed_attempts < max_attempts`,
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
         WHERE id_hash = ? AND consumed_at IS NULL AND expires_at > ? AND failed_attempts < max_attempts`,
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

  async redeemMobileAuthTicket(input: {
    ticketHash: string;
    serverId: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
    device: MobileAuthDeviceIdentity;
  }): Promise<{ sessionToken: string; user: AuthUser } | null> {
    const tokenHash = await sha256(input.session.token);
    const [created, registered, , , consumed] = await this.database.batch([
      this.database
        .prepare(
          `INSERT INTO auth_sessions(id, user_id, token_hash, expires_at, created_at, last_used_at)
           SELECT ?, user_id, ?, ?, ?, ?
           FROM team_auth_tickets
           WHERE ticket_hash = ? AND server_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(
          input.session.id,
          tokenHash,
          input.session.expiresAt,
          input.now,
          input.now,
          input.ticketHash,
          input.serverId,
          input.now,
        ),
      this.database
        .prepare(
          `INSERT INTO mobile_auth_sessions(session_id, user_id, device_id, device_name, platform, created_at)
           SELECT id, user_id, ?, ?, ?, ? FROM auth_sessions WHERE id = ?`,
        )
        .bind(input.device.id, input.device.name, input.device.platform, input.now, input.session.id),
      this.database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ?
           WHERE id <> ? AND revoked_at IS NULL
             AND id IN (
               SELECT session_id FROM mobile_auth_sessions
               WHERE user_id = (SELECT user_id FROM mobile_auth_sessions WHERE session_id = ?)
                 AND device_id = ?
             )`,
        )
        .bind(input.now, input.session.id, input.session.id, input.device.id),
      this.database
        .prepare(
          `DELETE FROM mobile_auth_sessions
           WHERE session_id <> ?
             AND user_id = (SELECT user_id FROM mobile_auth_sessions WHERE session_id = ?)
             AND device_id = ?`,
        )
        .bind(input.session.id, input.session.id, input.device.id),
      this.database
        .prepare(
          `UPDATE team_auth_tickets SET consumed_at = ?
           WHERE ticket_hash = ? AND server_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .bind(input.now, input.ticketHash, input.serverId, input.now),
    ]);
    if (created.meta.changes !== 1 || registered.meta.changes !== 1 || consumed.meta.changes !== 1) return null;
    const user = await this.authenticate(input.session.token, input.now);
    return user ? { sessionToken: input.session.token, user } : null;
  }

  async authenticateMobileSession(sessionToken: string, now: number): Promise<AuthUser | null> {
    const tokenHash = await sha256(sessionToken);
    const row = await this.database
      .prepare(
        `SELECT users.id, users.email, users.name, users.avatar_url
         FROM auth_sessions
         JOIN mobile_auth_sessions ON mobile_auth_sessions.session_id = auth_sessions.id
         JOIN users ON users.id = auth_sessions.user_id
         WHERE auth_sessions.token_hash = ?
           AND auth_sessions.revoked_at IS NULL
           AND auth_sessions.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<UserRow>();
    return row ? mapUser(row) : null;
  }

  async listMobileAuthDevices(userId: string, now: number): Promise<MobileAuthDevice[]> {
    const result = await this.database
      .prepare(
        `SELECT mobile_auth_sessions.session_id, mobile_auth_sessions.device_name,
                mobile_auth_sessions.platform, auth_sessions.created_at, auth_sessions.last_used_at
         FROM mobile_auth_sessions
         JOIN auth_sessions ON auth_sessions.id = mobile_auth_sessions.session_id
         WHERE mobile_auth_sessions.user_id = ?
           AND auth_sessions.revoked_at IS NULL
           AND auth_sessions.expires_at > ?
         ORDER BY auth_sessions.last_used_at DESC, auth_sessions.created_at DESC`,
      )
      .bind(userId, now)
      .all<{
        session_id: string;
        device_name: string;
        platform: MobileAuthDevice["platform"];
        created_at: number;
        last_used_at: number;
      }>();
    return result.results.map((row) => ({
      sessionId: row.session_id,
      name: row.device_name,
      platform: row.platform,
      connectedAt: row.created_at,
      lastActiveAt: row.last_used_at,
    }));
  }

  async revokeMobileAuthDevice(userId: string, sessionId: string, now: number): Promise<boolean> {
    const result = await this.database
      .prepare(
        `UPDATE auth_sessions SET revoked_at = ?
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL
           AND id IN (SELECT session_id FROM mobile_auth_sessions)`,
      )
      .bind(now, sessionId, userId)
      .run();
    return result.meta.changes === 1;
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
