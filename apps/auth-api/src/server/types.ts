export interface WorkerBindings {
  DB: D1Database;
  AUTH_EXPOSE_DEVELOPMENT_CODE?: string;
  EMAIL_SMTP_HOST?: string;
  EMAIL_SMTP_PORT?: string;
  EMAIL_SMTP_USERNAME?: string;
  EMAIL_SMTP_PASSWORD?: string;
  EMAIL_FROM?: string;
  EMAIL_DELIVERY_WEBHOOK_URL?: string;
  EMAIL_DELIVERY_WEBHOOK_SECRET?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface EmailCodeDelivery {
  send(message: { email: string; code: string; expiresAt: number }): Promise<void>;
}

export interface TeamInviteEmailDelivery {
  send(message: {
    email: string;
    inviterEmail: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }): Promise<void>;
}

export type EmailVerificationResult =
  | { status: "verified"; session: { sessionToken: string; user: AuthUser } }
  | { status: "invalid" | "expired" | "too_many_attempts" };

export interface AuthRepository {
  latestEmailChallengeAt(email: string): Promise<number | null>;
  createEmailChallenge(input: {
    idHash: string;
    email: string;
    codeHash: string;
    sourceIpHash: string;
    createdAt: number;
    expiresAt: number;
    maxAttempts: number;
  }): Promise<void>;
  cancelEmailChallenge(idHash: string, now: number): Promise<void>;
  verifyEmailChallenge(input: {
    idHash: string;
    codeHash: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
  }): Promise<EmailVerificationResult>;
  incrementRateLimit(
    keyHash: string,
    windowStart: number,
    limit: number,
  ): Promise<{ allowed: boolean; count: number; windowStart: number }>;
  authenticate(sessionToken: string, now: number): Promise<AuthUser | null>;
  revokeSession(sessionToken: string, now: number): Promise<void>;
  createTeamAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  redeemTeamAuthTicket(input: {
    ticketHash: string;
    serverId: string;
    now: number;
  }): Promise<AuthUser | null>;
}
