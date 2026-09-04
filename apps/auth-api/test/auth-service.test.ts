import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AccountSession } from "@openbot/contracts/mobile-connect";
import { describe, expect, it, vi } from "vitest";
import { AuthService, generateOneTimeCode, normalizeOneTimeCode } from "../src/server/auth-service";
import type {
  AuthRepository,
  AuthUser,
  EmailChallengeDeliveryState,
  EmailChallengeRecord,
  EmailVerificationResult,
  MobileAuthDevice,
  MobileAuthDeviceIdentity,
} from "../src/server/types";

const MOBILE_CONNECT_SERVER_ID = "00000000-0000-4000-8000-000000000002";

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
      deliveryState: EmailChallengeDeliveryState;
    }
  >();
  readonly limits = new Map<string, number>();
  readonly sessions = new Map<string, { id: string; user: AuthUser; expiresAt: number; revoked: boolean }>();
  readonly teamTickets = new Map<string, { user: AuthUser; serverId: string; expiresAt: number; consumed: boolean }>();
  readonly mobileDevices = new Map<string, MobileAuthDevice & { userId: string; deviceId: string }>();

  async latestEmailChallengeAt(email: string): Promise<number | null> {
    const matches = [...this.challenges.values()].filter(
      (value) => value.email === email && value.deliveryState !== "failed",
    );
    return matches.length ? Math.max(...matches.map((value) => value.createdAt)) : null;
  }

  async findEmailChallenge(idHash: string): Promise<EmailChallengeRecord | null> {
    const challenge = this.challenges.get(idHash);
    return challenge
      ? {
          email: challenge.email,
          createdAt: challenge.createdAt,
          expiresAt: challenge.expiresAt,
          consumedAt: challenge.consumed ? challenge.createdAt : null,
          deliveryState: challenge.deliveryState,
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
    if (this.challenges.has(input.idHash)) return false;
    this.challenges.set(input.idHash, {
      email: input.email,
      codeHash: input.codeHash,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      failures: 0,
      maxAttempts: input.maxAttempts,
      consumed: false,
      deliveryState: "pending",
    });
    return true;
  }

  async completeEmailChallengeDelivery(idHash: string, state: "sent" | "failed", _now: number): Promise<void> {
    const challenge = this.challenges.get(idHash);
    if (challenge?.deliveryState !== "pending") return;
    challenge.deliveryState = state;
    if (state === "failed") challenge.consumed = true;
  }

  async verifyEmailChallenge(input: {
    idHash: string;
    codeHash: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
  }): Promise<EmailVerificationResult> {
    const challenge = this.challenges.get(input.idHash);
    if (!challenge || challenge.consumed || challenge.deliveryState === "failed") return { status: "invalid" };
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
      id: input.session.id,
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

  async authenticateDesktopSession(sessionToken: string, now: number): Promise<AuthUser | null> {
    const session = this.sessions.get(sessionToken);
    return session && !session.revoked && session.expiresAt > now && !this.mobileDevices.has(session.id)
      ? session.user
      : null;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const session = this.sessions.get(sessionToken);
    if (session) session.revoked = true;
  }

  async revokeMobileSession(sessionToken: string): Promise<boolean> {
    const session = this.sessions.get(sessionToken);
    if (!session || session.revoked || !this.mobileDevices.has(session.id)) return false;
    session.revoked = true;
    return true;
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

  async replaceMobileAuthTicket(input: {
    ticketHash: string;
    userId: string;
    serverId: string;
    expiresAt: number;
  }): Promise<void> {
    for (const ticket of this.teamTickets.values()) {
      if (ticket.user.id === input.userId && ticket.serverId === input.serverId && !ticket.consumed) {
        ticket.consumed = true;
      }
    }
    await this.createTeamAuthTicket(input);
  }

  async redeemTeamAuthTicket(input: { ticketHash: string; serverId: string; now: number }): Promise<AuthUser | null> {
    const ticket = this.teamTickets.get(input.ticketHash);
    if (!ticket || ticket.consumed || ticket.serverId !== input.serverId || ticket.expiresAt <= input.now) {
      return null;
    }
    ticket.consumed = true;
    return ticket.user;
  }

  async redeemMobileAuthTicket(input: {
    ticketHash: string;
    serverId: string;
    now: number;
    session: { id: string; token: string; expiresAt: number };
    device: MobileAuthDeviceIdentity;
  }): Promise<{ sessionToken: string; user: AuthUser } | null> {
    const ticket = this.teamTickets.get(input.ticketHash);
    if (!ticket || ticket.consumed || ticket.serverId !== input.serverId || ticket.expiresAt <= input.now) {
      return null;
    }
    ticket.consumed = true;
    for (const [token, session] of this.sessions) {
      const device = this.mobileDevices.get(session.id);
      if (device?.userId === ticket.user.id && device.deviceId === input.device.id) {
        session.revoked = true;
        this.mobileDevices.delete(session.id);
        this.sessions.set(token, session);
      }
    }
    this.sessions.set(input.session.token, {
      id: input.session.id,
      user: ticket.user,
      expiresAt: input.session.expiresAt,
      revoked: false,
    });
    this.mobileDevices.set(input.session.id, {
      sessionId: input.session.id,
      userId: ticket.user.id,
      deviceId: input.device.id,
      name: input.device.name,
      platform: input.device.platform,
      connectedAt: input.now,
      lastActiveAt: input.now,
    });
    return { sessionToken: input.session.token, user: ticket.user };
  }

  async authenticateMobileSession(sessionToken: string, now: number): Promise<AuthUser | null> {
    const session = this.sessions.get(sessionToken);
    return session && !session.revoked && session.expiresAt > now && this.mobileDevices.has(session.id)
      ? session.user
      : null;
  }

  async listMobileAuthDevices(userId: string, now: number): Promise<MobileAuthDevice[]> {
    return [...this.mobileDevices.values()].filter((device) => {
      const session = [...this.sessions.values()].find((candidate) => candidate.id === device.sessionId);
      return device.userId === userId && Boolean(session && !session.revoked && session.expiresAt > now);
    });
  }

  async listAccountSessions(userId: string, currentToken: string, now: number): Promise<AccountSession[]> {
    return [...this.sessions.entries()]
      .filter(([, session]) => session.user.id === userId && !session.revoked && session.expiresAt > now)
      .map(([token, session]) => {
        const device = this.mobileDevices.get(session.id);
        return {
          sessionId: session.id,
          name: device?.name ?? "Desktop",
          kind: device ? "mobile" : "desktop",
          current: token === currentToken,
          connectedAt: device?.connectedAt ?? 0,
          lastActiveAt: device?.lastActiveAt ?? 0,
        };
      });
  }

  async revokeAccountSession(userId: string, sessionId: string): Promise<boolean> {
    const session = [...this.sessions.values()].find(
      (session) => session.id === sessionId && session.user.id === userId,
    );
    if (!session || session.revoked) return false;
    session.revoked = true;
    return true;
  }

  async revokeMobileAuthDevice(userId: string, sessionId: string): Promise<boolean> {
    const device = this.mobileDevices.get(sessionId);
    if (!device || device.userId !== userId) return false;
    const session = [...this.sessions.values()].find((candidate) => candidate.id === sessionId);
    if (!session || session.revoked) return false;
    session.revoked = true;
    return true;
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
    await expect(service.updateName(session.sessionToken, "👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦")).resolves.toMatchObject({
      name: "👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦",
    });
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
    await expect(service.updateName(session.sessionToken, "\u200d\u200d\u200d")).rejects.toMatchObject({
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
    const replacedMobileTicket = await service.issueMobileAuthTicket(session.sessionToken, "203.0.113.4");
    const mobileTicket = await service.issueMobileAuthTicket(session.sessionToken, "203.0.113.4");
    expect(mobileTicket.expiresAt).toBe(121_000);
    const device = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Norbert’s iPhone",
      platform: "ios" as const,
    };
    await expect(
      service.redeemTeamAuthTicket(mobileTicket.ticket, MOBILE_CONNECT_SERVER_ID, "203.0.113.5"),
    ).rejects.toMatchObject({ status: 400, code: "invalid_server_id" });
    const crossPurposeTeamTicket = await service.issueTeamAuthTicket(session.sessionToken, serverId, "203.0.113.4");
    expect(await service.redeemMobileAuthTicket(crossPurposeTeamTicket.ticket, device, "203.0.113.5")).toBeNull();
    expect(await service.redeemMobileAuthTicket(replacedMobileTicket.ticket, device, "203.0.113.5")).toBeNull();
    const mobileSession = await service.redeemMobileAuthTicket(mobileTicket.ticket, device, "203.0.113.5");
    await expect(
      repository.authenticateMobileSession(mobileSession?.sessionToken ?? "missing", 10_000_000_000_000),
    ).resolves.toMatchObject({ id: session.user.id });
    expect(mobileSession).toMatchObject({ user: { id: session.user.id, name: "Nörbert Bot" } });
    expect(await service.authenticateMobileSession(mobileSession?.sessionToken ?? "missing")).toMatchObject({
      id: session.user.id,
    });
    expect(await service.authenticate(mobileSession?.sessionToken ?? "missing")).toMatchObject({ id: session.user.id });
    await expect(
      service.issueMobileAuthTicket(mobileSession?.sessionToken ?? "missing", "203.0.113.4"),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(
      service.issueTeamAuthTicket(mobileSession?.sessionToken ?? "missing", MOBILE_CONNECT_SERVER_ID, "203.0.113.4"),
    ).rejects.toMatchObject({ status: 400, code: "invalid_server_id" });
    expect(await service.listMobileAuthDevices(session.sessionToken)).toMatchObject([
      { name: "Norbert’s iPhone", platform: "ios", connectedAt: 1_000 },
    ]);
    expect(await service.redeemMobileAuthTicket(mobileTicket.ticket, device, "203.0.113.5")).toBeNull();
    const connectedDevice = (await service.listMobileAuthDevices(session.sessionToken))[0];
    expect(connectedDevice).toBeDefined();
    await service.revokeMobileAuthDevice(session.sessionToken, connectedDevice?.sessionId ?? "missing");
    expect(await service.listMobileAuthDevices(session.sessionToken)).toEqual([]);
    expect(await service.authenticateMobileSession(mobileSession?.sessionToken ?? "missing")).toBeNull();
    expect(await service.authenticate(mobileSession?.sessionToken ?? "missing")).toBeNull();
    expect(await service.authenticateDesktopSession(session.sessionToken)).toMatchObject({ id: session.user.id });

    const logoutTicket = await service.issueMobileAuthTicket(session.sessionToken, "203.0.113.4");
    const logoutSession = await service.redeemMobileAuthTicket(logoutTicket.ticket, device, "203.0.113.5");
    await service.logoutMobileSession(logoutSession?.sessionToken ?? "missing");
    expect(await service.authenticateMobileSession(logoutSession?.sessionToken ?? "missing")).toBeNull();
    expect(await service.authenticateDesktopSession(session.sessionToken)).toMatchObject({ id: session.user.id });
    await expect(service.logoutMobileSession(session.sessionToken)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
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
      retryAfterSeconds: 60,
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

  it("keeps a verified challenge in the resend cooldown", async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService({
      repository,
      delivery: null,
      exposeDevelopmentCode: true,
      now: () => 1_000,
    });
    const challenge = await service.startEmailSignIn("person@example.com", "203.0.113.4");
    if (!challenge.developmentCode) throw new Error("Expected a development sign-in code.");

    await service.verifyEmailCode({
      challengeId: challenge.challengeId,
      code: challenge.developmentCode,
      sourceIp: "203.0.113.4",
    });

    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4")).rejects.toMatchObject({
      code: "code_recently_sent",
      status: 429,
    });
  });

  it("replays a completed delivery for the same idempotency key without sending twice", async () => {
    const repository = new MemoryAuthRepository();
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new AuthService({ repository, delivery: { send }, now: () => 1_000 });
    const idempotencyKey = "10000000-0000-4000-8000-000000000001";

    const first = await service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey);
    const replay = await service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey);

    expect(replay).toEqual(first);
    expect(replay.challengeId).toBe(idempotencyKey);
    expect(send).toHaveBeenCalledOnce();
  });

  it("replays the same development code", async () => {
    const service = new AuthService({
      repository: new MemoryAuthRepository(),
      delivery: null,
      exposeDevelopmentCode: true,
      now: () => 1_000,
    });
    const idempotencyKey = "10000000-0000-4000-8000-000000000006";

    const first = await service.startEmailSignIn("dev@example.com", "127.0.0.1", idempotencyKey);
    const replay = await service.startEmailSignIn("dev@example.com", "127.0.0.1", idempotencyKey);

    expect(replay.developmentCode).toBe(first.developmentCode);
    expect(replay.developmentCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  });

  it("keeps an ambiguous delivery usable without sending it again", async () => {
    const repository = new MemoryAuthRepository();
    let now = 1_000;
    let deliveredCode = "";
    const send = vi.fn(async (message: { code: string }) => {
      deliveredCode = message.code;
      throw new Error("smtp_delivery_unknown");
    });
    const service = new AuthService({ repository, delivery: { send }, now: () => now });
    const idempotencyKey = "10000000-0000-4000-8000-000000000007";

    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey)).rejects.toMatchObject({
      status: 409,
      code: "email_delivery_pending",
      retryAfterSeconds: 25,
    });
    now = 27_000;
    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey)).resolves.toMatchObject({
      challengeId: idempotencyKey,
    });
    await expect(
      service.verifyEmailCode({ challengeId: idempotencyKey, code: deliveredCode, sourceIp: "203.0.113.4" }),
    ).resolves.toMatchObject({ user: { email: "person@example.com" } });
    expect(send).toHaveBeenCalledOnce();
  });

  it("keeps one delivery pending for concurrent requests with the same idempotency key", async () => {
    const repository = new MemoryAuthRepository();
    let finishDelivery: (() => void) | undefined;
    const deliveryFinished = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const send = vi.fn(() => deliveryFinished);
    const service = new AuthService({ repository, delivery: { send }, now: () => 1_000 });
    const idempotencyKey = "10000000-0000-4000-8000-000000000002";

    const first = service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey)).rejects.toMatchObject({
      status: 409,
      code: "email_delivery_pending",
      retryAfterSeconds: 25,
    });

    finishDelivery?.();
    await expect(first).resolves.toMatchObject({ challengeId: idempotencyKey });
    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey)).resolves.toMatchObject({
      challengeId: idempotencyKey,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("allows an immediate new attempt after confirmed delivery failure", async () => {
    const repository = new MemoryAuthRepository();
    const send = vi.fn().mockRejectedValueOnce(new Error("SMTP rejected the message")).mockResolvedValue(undefined);
    const service = new AuthService({ repository, delivery: { send }, now: () => 1_000 });
    const failedKey = "10000000-0000-4000-8000-000000000003";

    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", failedKey)).rejects.toMatchObject({
      status: 502,
      code: "email_delivery_failed",
    });
    await expect(service.startEmailSignIn("person@example.com", "203.0.113.4", failedKey)).rejects.toMatchObject({
      status: 502,
      code: "email_delivery_failed",
    });
    await expect(
      service.startEmailSignIn("person@example.com", "203.0.113.4", "10000000-0000-4000-8000-000000000004"),
    ).resolves.toMatchObject({ challengeId: "10000000-0000-4000-8000-000000000004" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse of an idempotency key for a different email", async () => {
    const service = new AuthService({
      repository: new MemoryAuthRepository(),
      delivery: { send: async () => undefined },
      now: () => 1_000,
    });
    const idempotencyKey = "10000000-0000-4000-8000-000000000005";
    await service.startEmailSignIn("person@example.com", "203.0.113.4", idempotencyKey);

    await expect(service.startEmailSignIn("other@example.com", "203.0.113.4", idempotencyKey)).rejects.toMatchObject({
      status: 409,
      code: "idempotency_conflict",
    });
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
