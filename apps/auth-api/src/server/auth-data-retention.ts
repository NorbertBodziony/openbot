const RATE_LIMIT_WINDOW_MS = 15 * 60_000;

export interface AuthRetentionResult {
  challenges: number;
  sessions: number;
  rateLimits: number;
  teamTickets: number;
  remoteSessions: number;
  remoteInvites: number;
}

export interface AuthRetentionOperation {
  name: keyof AuthRetentionResult;
  sql: string;
  cutoff: number;
}

export function authRetentionOperations(now: number): AuthRetentionOperation[] {
  return [
    {
      name: "challenges",
      sql: "DELETE FROM email_login_challenges WHERE expires_at <= ?",
      cutoff: now,
    },
    {
      name: "sessions",
      sql: "DELETE FROM auth_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      cutoff: now,
    },
    {
      name: "rateLimits",
      sql: "DELETE FROM auth_rate_limits WHERE window_start <= ?",
      cutoff: now - RATE_LIMIT_WINDOW_MS,
    },
    {
      name: "teamTickets",
      sql: "DELETE FROM team_auth_tickets WHERE expires_at <= ? OR consumed_at IS NOT NULL",
      cutoff: now,
    },
    {
      name: "remoteSessions",
      sql: "DELETE FROM remote_sessions WHERE expires_at <= ?",
      cutoff: now - 10 * 60_000,
    },
    {
      name: "remoteSessions",
      sql: "DELETE FROM remote_sessions WHERE ended_at IS NOT NULL AND ended_at <= ?",
      cutoff: now - 10 * 60_000,
    },
    {
      name: "remoteInvites",
      sql: "DELETE FROM remote_invites WHERE expires_at <= ?",
      cutoff: now - 24 * 60 * 60_000,
    },
    {
      name: "remoteInvites",
      sql: "DELETE FROM remote_invites WHERE used_at IS NOT NULL AND used_at <= ?",
      cutoff: now - 24 * 60 * 60_000,
    },
    {
      name: "remoteInvites",
      sql: "DELETE FROM remote_invites WHERE revoked_at IS NOT NULL AND revoked_at <= ?",
      cutoff: now - 24 * 60 * 60_000,
    },
  ];
}

export async function pruneExpiredAuthData(database: D1Database, now: number): Promise<AuthRetentionResult> {
  const operations = authRetentionOperations(now);
  const results = await database.batch(
    operations.map((operation) => database.prepare(operation.sql).bind(operation.cutoff)),
  );
  const deleted: AuthRetentionResult = {
    challenges: 0,
    sessions: 0,
    rateLimits: 0,
    teamTickets: 0,
    remoteSessions: 0,
    remoteInvites: 0,
  };
  for (const [index, operation] of operations.entries()) {
    deleted[operation.name] += results[index]?.meta.changes ?? 0;
  }
  return deleted;
}
