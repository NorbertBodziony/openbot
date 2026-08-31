import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { describe, expect, it } from "vitest";
import { AuthService, generateOneTimeCode, normalizeOneTimeCode } from "../src/server/auth-service";
import type { AuthRepository, AuthUser, EmailVerificationResult } from "../src/server/types";

class MemoryAuthRepository implements AuthRepository {
  readonly challenges = new Map<
    string,
    {
      email: string;
      codeHash: string;
      createdAt: number;
      expiresAt: number;
      failures: number;
      maxAttempts: number;
      consumed: boolean;
    }
  >();
  readonly limits = new Map<string, number>();
  readonly sessions = new Map<string, { user: AuthUser; expiresAt: number; revoked: boolean }>();
  readonly teamTickets = new Map<string, { user: AuthUser; serverId: string; expiresAt: number; consumed: boolean }>();

  async latestEmailChallengeAt(email: string): Promise<number | null> {
    const matches = [...this.challenges.values()].filter((value) => value.email === email);
    return matches.length ? Math.max(...matches.map((value) => value.createdAt)) : null;
  }

  async createEmailChallenge(input: {
    idHash: string;
    email: string;
    codeHash: string;
    createdAt: number;
    expiresAt: number;
    maxAttempts: number;
  }): Promise<void> {
    this.challenges.set(input.idHash, {
      email: input.email,
      codeHash: input.codeHash,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      failures: 0,
      maxAttempts: input.maxAttempts,
      consumed: false,
    });
  }

  async cancelEmailChallenge(idHash: string): Promise<void> {
    const challenge = this.challenges.get(idHash);
    if (challenge) challenge.consumed = true;
  }

  async verifyEmailChallenge(input: {
    idHash: string;
    codeHash: string;
    now: number;
    session: { token: string; expiresAt: number };
  }): Promise<EmailVerificationResult> {
    const challenge = this.challenges.get(input.idHash);
    if (!challenge || challenge.consumed) return { status: "invalid" };
    if (challenge.expiresAt <= input.now) return { status: "expired" };
    if (challenge.failures >= challenge.maxAttempts) return { status: "too_many_attempts" };
    if (challenge.codeHash !== input.codeHash) {
      challenge.failures += 1;
      return challenge.failures >= challenge.maxAttempts ? { status: "too_many_attempts" } : { status: "invalid" };
    }
    challenge.consumed = true;
    const user = {
      id: `user:${challenge.email}`,
      email: challenge.email,
      name: null,
      avatarUrl: null,
    };
    this.sessions.set(input.session.token, {
      user,
      expiresAt: input.session.expiresAt,
      revoked: false,
    });
    return { status: "verified", session: { sessionToken: input.session.token, user } };
  }

  async incrementRateLimit(
    keyHash: string,
    windowStart: number,
    limit: number,
  ): Promise<{ allowed: boolean; count: number; windowStart: number }> {
    const key = `${keyHash}:${windowStart}`;
    const count = (this.limits.get(key) ?? 0) + 1;
    this.limits.set(key, count);
    return { allowed: count <= limit, count, windowStart };
  }

  async authenticate(sessionToken: string, now: number): Promise<AuthUser | null> {
    const session = this.sessions.get(sessionToken);
    return session && !session.revoked && session.expiresAt > now ? session.user : null;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const session = this.sessions.get(sessionToken);
    if (session) session.revoked = true;
  }

  async updateUserAvatar(
    userId: string,
    avatarUrl: string | null,
    expectedAvatarUrl: string | null,
  ): Promise<AuthUser | null> {
    const session = [...this.sessions.values()].find((item) => item.user.id === userId);
    if (!session) throw new Error("User not found.");
    if (session.user.avatarUrl !== expectedAvatarUrl) return null;
    session.user = { ...session.user, avatarUrl };
    return session.user;
  }

  async updateUserName(userId: string, name: string): Promise<AuthUser> {
    const session = [...this.sessions.values()].find((item) => item.user.id === userId);
    if (!session) throw new Error("User not found.");
    session.user = { ...session.user, name };
    return session.user;
  }

  async createTeamAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    expiresAt: number;
  }): Promise<void> {
    const user = [...this.sessions.values()].find((session) => session.user.id === input.userId)?.user;
    if (!user) throw new Error("User not found.");
    this.teamTickets.set(input.ticketHash, {
      user,
      serverId: input.serverId,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  async redeemTeamAuthTicket(input: { ticketHash: string; serverId: string; now: number }): Promise<AuthUser | null> {
    const ticket = this.teamTickets.get(input.ticketHash);
    if (!ticket || ticket.consumed || ticket.serverId !== input.serverId || ticket.expiresAt <= input.now) {
      return null;
    }
    ticket.consumed = true;
    return ticket.user;
  }
}

describe("email one-time codes", () => {
  it("creates an eight-character code from the safe alphabet", () => {
    for (let index = 0; index < 100; index += 1) {
      const code = generateOneTimeCode();
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u);
      expect(normalizeOneTimeCode(code.toLowerCase())).toHaveLength(8);
    }
  });

  it("signs in once and stores an OpenBot session", async () => {
    const repository = new MemoryAuthRepository();
    let deliveredCode = "";
    const service = new AuthService({
      repository,
      delivery: {
        async send(message) {
          deliveredCode = message.code;
        },
      },
      now: () => 1_000,
    });

    const challenge = await service.startEmailSignIn(" Person@Example.com ", "203.0.113.4");
    expect(challenge.developmentCode).toBeUndefined();
    expect(challenge.resendAt).toBe(61_000);
    const session = await service.verifyEmailCode({
      challengeId: challenge.challengeId,
      code: deliveredCode,
      sourceIp: "203.0.113.4",
    });
    expect(session.user.email).toBe("person@example.com");
    expect(await service.authenticate(session.sessionToken)).toEqual(session.user);
    await expect(service.updateName(session.sessionToken, "  No\u0308rbert\u00a0\u00a0Bot  ")).resolves.toMatchObject({
      name: "Nörbert Bot",
    });
    await expect(service.updateName(session.sessionToken, "   ")).rejects.toMatchObject({
      status: 400,
      code: "invalid_profile_name",
    });
    await expect(
      service.updateName(session.sessionToken, "x".repeat(INPUT_LIMITS.profileNameMin - 1)),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_profile_name",
    });
    await expect(
      service.updateName(session.sessionToken, "x".repeat(INPUT_LIMITS.profileName + 1)),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_profile_name",
    });
    await expect(service.updateName(session.sessionToken, "Nor\nbert")).rejects.toMatchObject({
      status: 400,
      code: "invalid_profile_name",
    });
    await expect(service.updateName("missing-session", "Norbert")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
    const serverId = "00000000-0000-4000-8000-000000000000";
    const ticket = await service.issueTeamAuthTicket(session.sessionToken, serverId, "203.0.113.4");
    expect(
      await service.redeemTeamAuthTicket(ticket.ticket, "00000000-0000-4000-8000-000000000001", "203.0.113.5"),
    ).toBeNull();
    expect(await service.redeemTeamAuthTicket(ticket.ticket, serverId, "203.0.113.5")).toMatchObject({
      id: session.user.id,
      name: "Nörbert Bot",
    });
    expect(await service.redeemTeamAuthTicket(ticket.ticket, serverId, "203.0.113.5")).toBeNull();
    await expect(service.updateAvatar(session.sessionToken, "/v1/avatars/user?v=avatar", null)).resolves.toMatchObject({
      avatarUrl: "/v1/avatars/user?v=avatar",
    });
    await expect(service.updateAvatar(session.sessionToken, null, "/v1/avatars/user?v=avatar")).resolves.toMatchObject({
      avatarUrl: null,
    });
    await expect(
      service.updateAvatar(session.sessionToken, "/v1/avatars/user?v=stale", "/v1/avatars/user?v=old"),
    ).rejects.toMatchObject({ status: 409, code: "avatar_conflict" });
    await expect(service.authenticate(session.sessionToken)).resolves.toMatchObject({
      avatarUrl: null,
    });
    await expect(
      service.verifyEmailCode({
        challengeId: challenge.challengeId,
        code: deliveredCode,
        sourceIp: "203.0.113.4",
      }),
    ).rejects.toMatchObject({ code: "invalid_sign_in_code" });
  });

  it("exposes a code only in explicit development mode", async () => {
    const service = new AuthService({
      repository: new MemoryAuthRepository(),
      delivery: null,
      exposeDevelopmentCode: true,
      now: () => 1_000,
    });
    const challenge = await service.startEmailSignIn("dev@example.com", "127.0.0.1");
    expect(challenge.developmentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  });

  it("enforces resend and failed-code limits", async () => {
    const repository = new MemoryAuthRepository();
    let now = 1_000;
    const service = new AuthService({
      repository,
      delivery: { send: async () => undefined },
      now: () => now,
    });
    const challenge = await service.startEmailSignIn("person@example.com", "203.0.113.4");
    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4")).rejects.toMatchObject({
      code: "code_recently_sent",
      status: 429,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.verifyEmailCode({
          challengeId: challenge.challengeId,
          code: "AAAA-AAAA",
          sourceIp: "203.0.113.4",
        }),
      ).rejects.toMatchObject({ code: "invalid_sign_in_code" });
    }
    await expect(
      service.verifyEmailCode({
        challengeId: challenge.challengeId,
        code: "AAAA-AAAA",
        sourceIp: "203.0.113.4",
      }),
    ).rejects.toMatchObject({ code: "too_many_code_attempts", status: 429 });

    now += 61_000;
    await service.startEmailSignIn("person@example.com", "203.0.113.4");
  });

  it("enforces rolling-window limits for email and IP", async () => {
    let now = 1_000;
    const emailService = new AuthService({
      repository: new MemoryAuthRepository(),
      delivery: { send: async () => undefined },
      now: () => now,
    });
    for (let request = 0; request < 5; request += 1) {
      await emailService.startEmailSignIn("limited@example.com", "203.0.113.4");
      now += 61_000;
    }
    await expect(emailService.startEmailSignIn("limited@example.com", "203.0.113.4")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });

    const ipService = new AuthService({
      repository: new MemoryAuthRepository(),
      delivery: { send: async () => undefined },
      now: () => 1_000,
    });
    for (let request = 0; request < 20; request += 1) {
      await ipService.startEmailSignIn(`person-${request}@example.com`, "198.51.100.8");
    }
    await expect(ipService.startEmailSignIn("blocked@example.com", "198.51.100.8")).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
    });
  });
});
