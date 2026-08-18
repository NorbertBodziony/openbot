import { randomToken, sha256 } from "./crypto";
import type { AuthRepository, AuthUser, EmailCodeDelivery, EmailVerificationResult } from "./types";

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const CHALLENGE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
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
      throw new AuthServiceError(
        503,
        "email_delivery_not_configured",
        "Email sign-in delivery is not configured.",
      );
    }
    const email = normalizeEmail(emailInput);
    const now = this.#now();
    await this.#enforceRateLimit(`start:email:${email}`, 5, now);
    await this.#enforceRateLimit(`start:ip:${normalizeSourceIp(sourceIp)}`, 20, now);

    const latestChallenge = await this.#repository.latestEmailChallengeAt(email);
    if (latestChallenge !== null && latestChallenge > now - RESEND_COOLDOWN_MS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((latestChallenge + RESEND_COOLDOWN_MS - now) / 1_000),
      );
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
    } catch {
      await this.#repository.cancelEmailChallenge(challengeHash, now);
      throw new AuthServiceError(
        502,
        "email_delivery_failed",
        "OpenBot could not send the sign-in code.",
      );
    }

    return {
      challengeId,
      expiresAt,
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

  logout(sessionToken: string): Promise<void> {
    return this.#repository.revokeSession(sessionToken, this.#now());
  }

  async #enforceRateLimit(key: string, limit: number, now: number): Promise<void> {
    const result = await this.#repository.incrementRateLimit(
      await sha256(key),
      Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS,
      limit,
    );
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.windowStart + RATE_WINDOW_MS - now) / 1_000),
      );
      throw new AuthServiceError(
        429,
        "rate_limited",
        "Too many sign-in attempts. Try again later.",
        retryAfterSeconds,
      );
    }
  }
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
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  const raw = [...bytes].map((byte) => CODE_ALPHABET[byte & 31]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeOneTimeCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  if (
    normalized.length !== CODE_LENGTH ||
    [...normalized].some((character) => !CODE_ALPHABET.includes(character))
  ) {
    throw new AuthServiceError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
  }
  return normalized;
}

export function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  const parts = normalized.split("@");
  if (
    normalized.length > 254 ||
    parts.length !== 2 ||
    !parts[0] ||
    parts[0].length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(parts[0]) ||
    !isValidDomain(parts[1])
  ) {
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

function isValidDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
}

function verificationResult(result: EmailVerificationResult): {
  sessionToken: string;
  user: AuthUser;
} {
  if (result.status === "verified") return result.session;
  if (result.status === "too_many_attempts") {
    throw new AuthServiceError(
      429,
      "too_many_code_attempts",
      "Too many incorrect codes. Request a new code.",
    );
  }
  if (result.status === "expired") {
    throw new AuthServiceError(401, "sign_in_code_expired", "The sign-in code expired.");
  }
  throw new AuthServiceError(401, "invalid_sign_in_code", "The sign-in code is incorrect.");
}
