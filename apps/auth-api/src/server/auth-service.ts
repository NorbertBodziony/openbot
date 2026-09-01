import {
  isUuidV4,
  normalizeEmailAddress,
  normalizeOneTimeCode as normalizeSharedOneTimeCode,
  ONE_TIME_CODE_ALPHABET,
  ONE_TIME_CODE_LENGTH,
  validateProfileName,
} from "@openbot/contracts/validation";

import { randomToken, sha256 } from "./crypto";
import type {
  AuthRepository,
  AuthUser,
  EmailCodeDelivery,
  EmailVerificationResult,
  MobileAuthDevice,
  MobileAuthDeviceIdentity,
} from "./types";

const CHALLENGE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const TEAM_TICKET_TTL_MS = 2 * 60_000;
const MOBILE_CONNECT_SERVER_ID = "00000000-0000-4000-8000-000000000002";
const RATE_WINDOW_MS = 15 * 60_000;

interface AuthServiceOptions {
  repository: AuthRepository;
  delivery: EmailCodeDelivery | null;
  exposeDevelopmentCode?: boolean;
  now?: () => number;
}

export interface EmailSignInStart {
  challengeId: string;
  expiresAt: number;
  resendAt: number;
  developmentCode?: string;
}

export class AuthService {
  readonly #repository: AuthRepository;
  readonly #delivery: EmailCodeDelivery | null;
  readonly #exposeDevelopmentCode: boolean;
  readonly #now: () => number;

  constructor(options: AuthServiceOptions) {
    this.#repository = options.repository;
    this.#delivery = options.delivery;
    this.#exposeDevelopmentCode = options.exposeDevelopmentCode ?? false;
    this.#now = options.now ?? Date.now;
  }

  get configured(): boolean {
    return this.#delivery !== null || this.#exposeDevelopmentCode;
  }

  async startEmailSignIn(emailInput: string, sourceIp: string): Promise<EmailSignInStart> {
    if (!this.configured) {
      throw new AuthServiceError(503, "email_delivery_not_configured", "Email sign-in delivery is not configured.");
    }
    const email = normalizeEmail(emailInput);
    const now = this.#now();
    await this.#enforceRateLimit(`start:email:${email}`, 5, now);
    await this.#enforceRateLimit(`start:ip:${normalizeSourceIp(sourceIp)}`, 20, now);

    const latestChallenge = await this.#repository.latestEmailChallengeAt(email);
    if (latestChallenge !== null && latestChallenge > now - RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(1, Math.ceil((latestChallenge + RESEND_COOLDOWN_MS - now) / 1_000));
      throw new AuthServiceError(
        429,
        "code_recently_sent",
        `Wait ${retryAfterSeconds} seconds before requesting another code.`,
        retryAfterSeconds,
      );
    }

    const challengeId = randomToken();
    const code = generateOneTimeCode();
    const expiresAt = now + CHALLENGE_TTL_MS;
    const challengeHash = await sha256(challengeId);
    await this.#repository.createEmailChallenge({
      idHash: challengeHash,
      email,
      codeHash: await sha256(normalizeOneTimeCode(code)),
      sourceIpHash: await sha256(normalizeSourceIp(sourceIp)),
      createdAt: now,
      expiresAt,
      maxAttempts: 5,
    });
    try {
      if (this.#delivery) await this.#delivery.send({ email, code, expiresAt });
    } catch (error) {
      console.error("Email code delivery failed:", safeDeliveryError(error));
      await this.#repository.cancelEmailChallenge(challengeHash, now);
      throw new AuthServiceError(502, "email_delivery_failed", "OpenBot could not send the sign-in code.");
    }

    return {
      challengeId,
      expiresAt,
      resendAt: now + RESEND_COOLDOWN_MS,
      ...(this.#exposeDevelopmentCode ? { developmentCode: code } : {}),
    };
  }

  async verifyEmailCode(input: {
    challengeId: string;
    code: string;
    sourceIp: string;
  }): Promise<{ sessionToken: string; user: AuthUser }> {
    const now = this.#now();
    await this.#enforceRateLimit(`verify:ip:${normalizeSourceIp(input.sourceIp)}`, 30, now);
    if (!input.challengeId || input.challengeId.length > 128 || input.code.length > 32) {
      throw new AuthServiceError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
    }
    const result = await this.#repository.verifyEmailChallenge({
      idHash: await sha256(input.challengeId),
      codeHash: await sha256(safeNormalizeCode(input.code)),
      now,
      session: {
        id: crypto.randomUUID(),
        token: randomToken(),
        expiresAt: now + SESSION_TTL_MS,
      },
    });
    return verificationResult(result);
  }

  authenticate(sessionToken: string): Promise<AuthUser | null> {
    return this.#repository.authenticate(sessionToken, this.#now());
  }

  authenticateDesktopSession(sessionToken: string): Promise<AuthUser | null> {
    return this.#repository.authenticateDesktopSession(sessionToken, this.#now());
  }

  async updateName(sessionToken: string, nameInput: string): Promise<AuthUser> {
    const user = await this.authenticate(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    const validation = validateProfileName(nameInput);
    if (validation.error) {
      throw new AuthServiceError(400, "invalid_profile_name", "Enter a valid display name.");
    }
    const now = this.#now();
    await this.#enforceRateLimit(`profile:user:${user.id}`, 20, now);
    return this.#repository.updateUserName(user.id, validation.name, now);
  }

  async updateAvatar(
    sessionToken: string,
    avatarUrl: string | null,
    expectedAvatarUrl: string | null,
  ): Promise<AuthUser> {
    const user = await this.authenticate(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    const now = this.#now();
    await this.#enforceRateLimit(`avatar:user:${user.id}`, 20, now);
    const updated = await this.#repository.updateUserAvatar(user.id, avatarUrl, expectedAvatarUrl, now);
    if (!updated) {
      throw new AuthServiceError(409, "avatar_conflict", "The account avatar changed during this request. Try again.");
    }
    return updated;
  }

  async enforceTeamInviteRateLimit(userId: string, recipientEmail: string, sourceIp: string): Promise<void> {
    const now = this.#now();
    const email = normalizeEmail(recipientEmail);
    await this.#enforceRateLimit(`invite:user:${userId}`, 20, now);
    await this.#enforceRateLimit(`invite:email:${email}`, 5, now);
    await this.#enforceRateLimit(`invite:ip:${normalizeSourceIp(sourceIp)}`, 30, now);
  }

  async enforceTeamTunnelRateLimit(userId: string, sourceIp: string): Promise<void> {
    const now = this.#now();
    await this.#enforceRateLimit(`team-tunnel:user:${userId}`, 20, now);
    await this.#enforceRateLimit(`team-tunnel:ip:${normalizeSourceIp(sourceIp)}`, 60, now);
  }

  async issueTeamAuthTicket(
    sessionToken: string,
    serverId: string,
    sourceIp: string,
  ): Promise<{ ticket: string; expiresAt: number }> {
    validateServerId(serverId);
    const user = await this.authenticate(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    const now = this.#now();
    await this.#enforceRateLimit(`team-ticket:user:${user.id}`, 30, now);
    await this.#enforceRateLimit(`team-ticket:ip:${normalizeSourceIp(sourceIp)}`, 60, now);
    const ticket = randomToken();
    const expiresAt = now + TEAM_TICKET_TTL_MS;
    await this.#repository.createTeamAuthTicket({
      ticketHash: await sha256(ticket),
      userId: user.id,
      serverId,
      createdAt: now,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  async redeemTeamAuthTicket(ticket: string, serverId: string, sourceIp: string): Promise<AuthUser | null> {
    validateServerId(serverId);
    if (!ticket || ticket.length > 128) return null;
    const now = this.#now();
    await this.#enforceRateLimit(`team-ticket-redeem:ip:${normalizeSourceIp(sourceIp)}`, 120, now);
    return this.#repository.redeemTeamAuthTicket({
      ticketHash: await sha256(ticket),
      serverId,
      now,
    });
  }

  async issueMobileAuthTicket(sessionToken: string, sourceIp: string): Promise<{ ticket: string; expiresAt: number }> {
    const user = await this.authenticateDesktopSession(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    const now = this.#now();
    await this.#enforceRateLimit(`mobile-ticket:user:${user.id}`, 30, now);
    await this.#enforceRateLimit(`mobile-ticket:ip:${normalizeSourceIp(sourceIp)}`, 60, now);
    const ticket = randomToken();
    const expiresAt = now + TEAM_TICKET_TTL_MS;
    await this.#repository.replaceMobileAuthTicket({
      ticketHash: await sha256(ticket),
      userId: user.id,
      serverId: MOBILE_CONNECT_SERVER_ID,
      createdAt: now,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  async redeemMobileAuthTicket(
    ticket: string,
    deviceInput: MobileAuthDeviceIdentity,
    sourceIp: string,
  ): Promise<{ sessionToken: string; user: AuthUser } | null> {
    if (!ticket || ticket.length > 128) return null;
    const device = normalizeMobileDevice(deviceInput);
    const now = this.#now();
    await this.#enforceRateLimit(`mobile-ticket-redeem:ip:${normalizeSourceIp(sourceIp)}`, 60, now);
    return this.#repository.redeemMobileAuthTicket({
      ticketHash: await sha256(ticket),
      serverId: MOBILE_CONNECT_SERVER_ID,
      now,
      session: {
        id: crypto.randomUUID(),
        token: randomToken(),
        expiresAt: now + SESSION_TTL_MS,
      },
      device,
    });
  }

  async listMobileAuthDevices(sessionToken: string): Promise<MobileAuthDevice[]> {
    const user = await this.authenticate(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    return this.#repository.listMobileAuthDevices(user.id, this.#now());
  }

  authenticateMobileSession(sessionToken: string): Promise<AuthUser | null> {
    return this.#repository.authenticateMobileSession(sessionToken, this.#now());
  }

  async revokeMobileAuthDevice(sessionToken: string, sessionId: string): Promise<void> {
    if (!isUuidV4(sessionId)) {
      throw new AuthServiceError(400, "invalid_mobile_session", "The mobile session ID is invalid.");
    }
    const user = await this.authenticate(sessionToken);
    if (!user) throw new AuthServiceError(401, "unauthorized", "The session is invalid.");
    await this.#repository.revokeMobileAuthDevice(user.id, sessionId, this.#now());
  }

  logout(sessionToken: string): Promise<void> {
    return this.#repository.revokeSession(sessionToken, this.#now());
  }

  async logoutMobileSession(sessionToken: string): Promise<void> {
    const revoked = await this.#repository.revokeMobileSession(sessionToken, this.#now());
    if (!revoked) throw new AuthServiceError(401, "unauthorized", "The mobile session is invalid.");
  }

  async #enforceRateLimit(key: string, limit: number, now: number): Promise<void> {
    const result = await this.#repository.incrementRateLimit(
      await sha256(key),
      Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS,
      limit,
    );
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.windowStart + RATE_WINDOW_MS - now) / 1_000));
      throw new AuthServiceError(429, "rate_limited", "Too many sign-in attempts. Try again later.", retryAfterSeconds);
    }
  }
}

function safeDeliveryError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_delivery_error";
  return /^smtp_[a-z_]+$/u.test(error.message) || error.message === "email_delivery_webhook_failed"
    ? error.message
    : "unknown_delivery_error";
}

export class AuthServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function generateOneTimeCode(): string {
  const bytes = new Uint8Array(ONE_TIME_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  const raw = [...bytes].map((byte) => ONE_TIME_CODE_ALPHABET[byte & 31]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeOneTimeCode(value: string): string {
  const normalized = normalizeSharedOneTimeCode(value);
  if (!normalized) {
    throw new AuthServiceError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
  }
  return normalized;
}

export function normalizeEmail(value: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) {
    throw new AuthServiceError(400, "invalid_email", "Enter a valid email address.");
  }
  return normalized;
}

function safeNormalizeCode(value: string): string {
  try {
    return normalizeOneTimeCode(value);
  } catch {
    return "INVALIDCODE";
  }
}

function normalizeSourceIp(value: string): string {
  const normalized = value.trim();
  return normalized && normalized.length <= 64 ? normalized : "unknown";
}

function validateServerId(value: string): void {
  if (!isUuidV4(value)) {
    throw new AuthServiceError(400, "invalid_server_id", "The team server ID is invalid.");
  }
}

function normalizeMobileDevice(input: MobileAuthDeviceIdentity): MobileAuthDeviceIdentity {
  if (!isUuidV4(input.id)) {
    throw new AuthServiceError(400, "invalid_mobile_device", "The mobile device ID is invalid.");
  }
  const name = input.name.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new AuthServiceError(400, "invalid_mobile_device", "The mobile device name is invalid.");
  }
  if (input.platform !== "ios" && input.platform !== "android" && input.platform !== "unknown") {
    throw new AuthServiceError(400, "invalid_mobile_device", "The mobile device platform is invalid.");
  }
  return { id: input.id, name, platform: input.platform };
}

function verificationResult(result: EmailVerificationResult): {
  sessionToken: string;
  user: AuthUser;
} {
  if (result.status === "verified") return result.session;
  if (result.status === "too_many_attempts") {
    throw new AuthServiceError(429, "too_many_code_attempts", "Too many incorrect codes. Request a new code.");
  }
  if (result.status === "expired") {
    throw new AuthServiceError(401, "sign_in_code_expired", "The sign-in code expired.");
  }
  throw new AuthServiceError(401, "invalid_sign_in_code", "The sign-in code is incorrect.");
}
