import { isDynamicRecord, isFunction } from "@openbot/contracts/runtime-values";

export interface WorkerBindings {
  DB: D1Database;
  AVATARS: R2Bucket;
  SKILLS: R2Bucket;
  SITES: R2Bucket;
  MARKETPLACE_INGRESS_RATE_LIMITER: RateLimit;
  MARKETPLACE_MUTATION_RATE_LIMITER: RateLimit;
  MARKETPLACE_UPLOAD_RATE_LIMITER: RateLimit;
  SITE_REPORT_RATE_LIMITER: RateLimit;
  AUTH_EXPOSE_DEVELOPMENT_CODE?: string;
  EMAIL_SMTP_HOST?: string;
  EMAIL_SMTP_PORT?: string;
  EMAIL_SMTP_USERNAME?: string;
  EMAIL_SMTP_PASSWORD?: string;
  EMAIL_FROM?: string;
  EMAIL_DELIVERY_WEBHOOK_URL?: string;
  EMAIL_DELIVERY_WEBHOOK_SECRET?: string;
  SKILLS_ADMIN_TOKEN?: string;
  SITE_OPERATIONS_ADMIN_TOKEN?: string;
  SITE_REPORT_HASH_SECRET?: string;
  SITE_COOKIE_ISOLATION_READY?: string;
  SITE_PUBLISH_ENABLED?: string;
  SITE_LOCAL_ORIGIN?: string;
  REMOTE_TICKET_PRIVATE_JWK?: string;
  REMOTE_TICKET_PUBLIC_JWKS?: string;
  REMOTE_TICKET_KEY_ID?: string;
  REMOTE_SIGNAL_URL?: string;
  REMOTE_AUTH_WEBHOOK_URL?: string;
  REMOTE_AUTH_WEBHOOK_SECRET?: string;
}

export function isWorkerBindings(value: unknown): value is WorkerBindings {
  if (!isDynamicRecord(value)) return false;
  const database = value.DB;
  const avatars = value.AVATARS;
  const skills = value.SKILLS;
  const sites = value.SITES;
  const marketplaceIngressRateLimiter = value.MARKETPLACE_INGRESS_RATE_LIMITER;
  const marketplaceMutationRateLimiter = value.MARKETPLACE_MUTATION_RATE_LIMITER;
  const marketplaceUploadRateLimiter = value.MARKETPLACE_UPLOAD_RATE_LIMITER;
  const siteReportRateLimiter = value.SITE_REPORT_RATE_LIMITER;
  if (
    !isDynamicRecord(database) ||
    !isFunction(database.prepare) ||
    !isDynamicRecord(avatars) ||
    !isFunction(avatars.get) ||
    !isFunction(avatars.put) ||
    !isFunction(avatars.delete) ||
    !isDynamicRecord(skills) ||
    !isFunction(skills.get) ||
    !isFunction(skills.put) ||
    !isFunction(skills.delete) ||
    !isDynamicRecord(sites) ||
    !isFunction(sites.get) ||
    !isFunction(sites.put) ||
    !isFunction(sites.delete) ||
    !isDynamicRecord(marketplaceIngressRateLimiter) ||
    !isFunction(marketplaceIngressRateLimiter.limit) ||
    !isDynamicRecord(marketplaceMutationRateLimiter) ||
    !isFunction(marketplaceMutationRateLimiter.limit) ||
    !isDynamicRecord(marketplaceUploadRateLimiter) ||
    !isFunction(marketplaceUploadRateLimiter.limit) ||
    !isDynamicRecord(siteReportRateLimiter) ||
    !isFunction(siteReportRateLimiter.limit)
  ) {
    return false;
  }
  return true;
}

export function requireWorkerBindings(value: unknown): WorkerBindings {
  if (!isWorkerBindings(value)) {
    throw new Error("Cloudflare worker bindings are unavailable.");
  }
  return value;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface MobileAuthDevice {
  sessionId: string;
  name: string;
  platform: "ios" | "android" | "unknown";
  connectedAt: number;
  lastActiveAt: number;
}

export interface MobileAuthDeviceIdentity {
  id: string;
  name: string;
  platform: MobileAuthDevice["platform"];
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

export type EmailChallengeDeliveryState = "pending" | "sent" | "failed";

export interface EmailChallengeRecord {
  email: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  deliveryState: EmailChallengeDeliveryState;
}

export interface AuthRepository {
  latestEmailChallengeAt(email: string): Promise<number | null>;
  findEmailChallenge(idHash: string): Promise<EmailChallengeRecord | null>;
  createEmailChallenge(input: {
    idHash: string;
    email: string;
    codeHash: string;
    sourceIpHash: string;
    createdAt: number;
    expiresAt: number;
    maxAttempts: number;
  }): Promise<boolean>;
  completeEmailChallengeDelivery(idHash: string, state: "sent" | "failed", now: number): Promise<void>;
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
  authenticateDesktopSession(sessionToken: string, now: number): Promise<AuthUser | null>;
  revokeSession(sessionToken: string, now: number): Promise<void>;
  revokeMobileSession(sessionToken: string, now: number): Promise<boolean>;
  updateUserName(userId: string, name: string, now: number): Promise<AuthUser>;
  updateUserAvatar(
    userId: string,
    avatarUrl: string | null,
    expectedAvatarUrl: string | null,
    now: number,
  ): Promise<AuthUser | null>;
  createTeamAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  replaceMobileAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  redeemTeamAuthTicket(input: { ticketHash: string; serverId: string; now: number }): Promise<AuthUser | null>;
  redeemMobileAuthTicket(input: {
    ticketHash: string;
    serverId: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
    device: MobileAuthDeviceIdentity;
  }): Promise<{ sessionToken: string; user: AuthUser } | null>;
  authenticateMobileSession(sessionToken: string, now: number): Promise<AuthUser | null>;
  listMobileAuthDevices(userId: string, now: number): Promise<MobileAuthDevice[]>;
  revokeMobileAuthDevice(userId: string, sessionId: string, now: number): Promise<boolean>;
}
