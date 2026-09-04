import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralAuthManager, readCentralAuthApiUrl, readMobileConnectApiUrl } from "./central-auth-manager";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CentralAuthManager", () => {
  it("accepts a private-LAN Signal URL for local Mobile Connect development", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    await writeFile(storagePath, "session-secret");
    const serverId = "00000000-0000-4000-8000-000000000000";
    let signalUrl = "ws://192.168.1.143:3101/v1/signal";
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        if (path === "/v1/me") {
          return Response.json({ id: "user-1", email: "person@example.com", name: null, avatarUrl: null });
        }
        if (path === "/v2/remote/hosts/register") {
          return Response.json({
            hostId: serverId,
            name: "Studio",
            membershipId: "membership-1",
            authEpoch: 1,
            machineToken: "machine-token-1234567890abcdefghijklmnop",
          });
        }
        return Response.json({
          ticket: "remote-ticket",
          expiresAt: Date.now() + 60_000,
          signalUrl,
        });
      }),
    });

    await manager.initialize();
    await manager.registerRemoteHost({
      hostId: serverId,
      name: "Studio",
      ownerMembershipId: "membership-1",
    });

    await expect(manager.issueRemoteHostTicket(serverId)).resolves.toMatchObject({
      signalUrl: "ws://192.168.1.143:3101/v1/signal",
    });
    signalUrl = "ws://signal.example.com/v1/signal";
    await expect(manager.issueRemoteHostTicket(serverId)).rejects.toThrow("Invalid Remote Signal URL.");
  });

  it("requests an email code, verifies it, and restores an encrypted session", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    const requests: Array<{ path: string; body: unknown; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      requests.push({
        path: url.pathname,
        body: isString(init?.body) ? JSON.parse(init.body) : null,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      if (url.pathname.endsWith("/start")) {
        return Response.json({
          challengeId: "challenge-1",
          expiresAt: 10_000,
          developmentCode: "ABCD-EFGH",
        });
      }
      if (url.pathname.endsWith("/verify")) {
        return Response.json({
          sessionToken: "session-secret",
          user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
        });
      }
      if (url.pathname === "/v1/team-invitations/email") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/team-auth/ticket") {
        return Response.json({ ticket: "one-time-ticket", expiresAt: 20_000 });
      }
      if (url.pathname === "/v1/mobile-auth/ticket") {
        return Response.json({
          ticket: "mobile-ticket_1234567890abcdefghijklmnop",
          expiresAt: Date.now() + 120_000,
        });
      }
      if (url.pathname === "/v1/mobile-auth/devices" && init?.method === "GET") {
        if (url.searchParams.get("includeDesktop") === "true")
          return Response.json({
            sessions: [
              {
                sessionId: "11111111-1111-4111-8111-111111111111",
                name: "Desktop",
                kind: "desktop",
                current: false,
                connectedAt: 1000,
                lastActiveAt: 2000,
              },
            ],
          });
        return Response.json({
          devices: [
            {
              sessionId: "11111111-1111-4111-8111-111111111111",
              name: "Norbert’s iPhone",
              platform: "ios",
              connectedAt: 1_000,
              lastActiveAt: 2_000,
            },
          ],
        });
      }
      if (url.pathname === "/v1/mobile-auth/devices/11111111-1111-4111-8111-111111111111") {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        id: "user-1",
        email: "person@example.com",
        name: null,
        avatarUrl: null,
      });
    });
    const options = {
      apiUrl: "http://127.0.0.1:3100",
      mobileConnectApiUrl: "http://192.168.1.143:3100",
      storagePath,
      encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
      decrypt: (value: Buffer) => value.toString().replace("encrypted:", ""),
      fetch: fetchMock,
    };
    const manager = new CentralAuthManager(options);
    expect((await manager.initialize()).status).toBe("signed_out");
    expect(await manager.requestEmailCode("Person@Example.com")).toMatchObject({
      status: "code_sent",
      email: "person@example.com",
      developmentCode: "ABCD-EFGH",
    });
    expect(await manager.verifyEmailCode("challenge-1", "ABCD-EFGH")).toMatchObject({
      status: "signed_in",
    });
    const serverId = "00000000-0000-4000-8000-000000000000";
    expect(await manager.createTeamAuthTicket(serverId)).toBe("one-time-ticket");
    expect(await manager.redeemTeamAuthTicket("one-time-ticket", serverId)).toMatchObject({
      email: "person@example.com",
    });
    expect(await manager.createMobileConnect({ hostId: serverId, fingerprint: "a".repeat(43) })).toMatchObject({
      qrData: expect.stringMatching(
        /^openbot:\/\/mobile-connect\?api=http%3A%2F%2F192\.168\.1\.143%3A3100&ticket=mobile-ticket_1234567890abcdefghijklmnop&host=00000000-0000-4000-8000-000000000000&fingerprint=a{43}$/u,
      ),
    });
    expect(await manager.listMobileConnectedDevices()).toEqual([
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        name: "Norbert’s iPhone",
        platform: "ios",
        connectedAt: 1_000,
        lastActiveAt: 2_000,
      },
    ]);
    await manager.revokeMobileConnectedDevice("11111111-1111-4111-8111-111111111111");
    expect(await manager.listAccountSessions()).toEqual([
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        name: "Desktop",
        kind: "desktop",
        current: false,
        connectedAt: 1000,
        lastActiveAt: 2000,
      },
    ]);
    await manager.revokeAccountSession("11111111-1111-4111-8111-111111111111");
    const [revokeUrl, revokeOptions] = fetchMock.mock.calls.at(-1) ?? [];
    expect(revokeUrl?.toString()).toBe(
      "http://127.0.0.1:3100/v1/mobile-auth/devices/11111111-1111-4111-8111-111111111111?includeDesktop=true",
    );
    expect(revokeOptions?.method).toBe("DELETE");
    expect(new Headers(revokeOptions?.headers).get("Authorization")).toBe("Bearer session-secret");
    await manager.sendTeamInviteEmail({
      email: "alice@example.com",
      serverName: "Studio Mac",
      inviteUrl:
        "https://openbot.run/join?api=https%3A%2F%2Fstudio-mac-k7m4q2pz-host.openbot.run%2F&server=00000000-0000-4000-8000-000000000000&fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&invite=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      role: "member",
    });
    expect(requests[0]).toMatchObject({ path: "/health/live", authorization: null });
    expect(requests[2]?.body).toEqual({ challengeId: "challenge-1", code: "ABCD-EFGH" });
    expect(await readFile(storagePath, "utf8")).not.toContain("session-secret");
    expect(requests[3]).toMatchObject({
      path: "/v1/team-auth/ticket",
      authorization: "Bearer session-secret",
    });
    expect(requests[4]).toMatchObject({
      path: "/v1/team-auth/redeem",
      authorization: null,
    });
    expect(requests[5]).toMatchObject({
      path: "/v1/mobile-auth/ticket",
      authorization: "Bearer session-secret",
    });
    expect(requests[6]).toMatchObject({
      path: "/v1/mobile-auth/devices",
      authorization: "Bearer session-secret",
    });
    expect(requests[7]).toMatchObject({
      path: "/v1/mobile-auth/devices/11111111-1111-4111-8111-111111111111",
      authorization: "Bearer session-secret",
    });
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/team-invitations/email",
      authorization: "Bearer session-secret",
    });
    const restored = new CentralAuthManager(options);
    expect(await restored.initialize()).toMatchObject({ status: "signed_in" });
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/me",
      authorization: "Bearer session-secret",
    });
  });

  it("keeps a verified session only in memory when secure persistence is unavailable", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/start")) {
        return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
      }
      if (path.endsWith("/verify")) {
        return Response.json({
          sessionToken: "memory-session-secret",
          user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
        });
      }
      if (path === "/v1/team-auth/ticket") {
        return Response.json({ ticket: "memory-ticket", expiresAt: 20_000 });
      }
      return Response.json({ service: "openbot-auth-api", status: "ok" });
    });
    const options = {
      apiUrl: "http://127.0.0.1:3100",
      storagePath,
      canPersist: () => false,
      encrypt: vi.fn(() => {
        throw new Error("Encryption must not run without secure storage.");
      }),
      decrypt: vi.fn(() => {
        throw new Error("Decryption must not run without secure storage.");
      }),
      fetch: fetchMock,
    };
    const manager = new CentralAuthManager(options);
    await manager.requestEmailCode("person@example.com");
    await expect(manager.verifyEmailCode("challenge-1", "ABCD-EFGH")).resolves.toMatchObject({
      status: "signed_in",
    });
    await expect(manager.createTeamAuthTicket("00000000-0000-4000-8000-000000000000")).resolves.toBe("memory-ticket");
    await expect(readFile(storagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(options.encrypt).not.toHaveBeenCalled();
    expect(options.decrypt).not.toHaveBeenCalled();

    const restarted = new CentralAuthManager(options);
    await expect(restarted.initialize()).resolves.toMatchObject({ status: "signed_out" });
  });

  it("keeps a verified session in memory when secure persistence fails", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    await writeFile(storagePath, "stale-session");
    const encrypt = vi.fn(() => {
      throw new Error("The keychain denied access.");
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path.endsWith("/start")) {
        return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
      }
      if (path.endsWith("/verify")) {
        return Response.json({
          sessionToken: "memory-session-secret",
          user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
        });
      }
      if (path === "/v1/team-auth/ticket") {
        return Response.json({ ticket: "memory-ticket", expiresAt: 20_000 });
      }
      return Response.json({ service: "openbot-auth-api", status: "ok" });
    });
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath,
      encrypt,
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    await manager.requestEmailCode("person@example.com");
    await expect(manager.verifyEmailCode("challenge-1", "ABCD-EFGH")).resolves.toMatchObject({
      status: "signed_in",
    });
    await expect(manager.createTeamAuthTicket("00000000-0000-4000-8000-000000000000")).resolves.toBe("memory-ticket");
    await expect(readFile(storagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(encrypt).toHaveBeenCalledTimes(1);
  });

  it("keeps the challenge visible after an incorrect code", async () => {
    const root = await createRoot();
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input.toString()).pathname;
        if (path.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        return Response.json(
          { error: { code: "invalid_sign_in_code", message: "The sign-in code is incorrect." } },
          { status: 401 },
        );
      }),
    });
    await manager.requestEmailCode("person@example.com");
    expect(await manager.verifyEmailCode("challenge-1", "AAAA-AAAA")).toMatchObject({
      status: "code_sent",
      challengeId: "challenge-1",
      issue: {
        code: "invalid_sign_in_code",
        message: "The sign-in code is incorrect.",
      },
    });
  });

  it("keeps the active challenge and Retry-After metadata when resend is throttled", async () => {
    const root = await createRoot();
    let startRequests = 0;
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async () => {
        startRequests += 1;
        if (startRequests === 1) {
          return Response.json({
            challengeId: "challenge-1",
            expiresAt: 610_000,
            resendAt: 61_000,
          });
        }
        if (startRequests === 2) {
          return Response.json(
            { error: { code: "code_recently_sent", message: "Wait 42 seconds before requesting another code." } },
            { status: 429, headers: { "Retry-After": "42" } },
          );
        }
        return Response.json({
          challengeId: "challenge-2",
          expiresAt: 1_210_000,
          resendAt: 661_000,
        });
      }),
    });

    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: "challenge-1",
      resendAvailableAt: 61_000,
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: "challenge-1",
      issue: {
        code: "code_recently_sent",
        retryAfterSeconds: 42,
      },
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: "challenge-2",
      resendAvailableAt: 661_000,
    });
  });

  it("uses one in-flight request and one idempotency key for concurrent submits", async () => {
    const root = await createRoot();
    let finishRequest: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) => response);
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    const first = manager.requestEmailCode("person@example.com");
    const second = manager.requestEmailCode(" Person@Example.com ");

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/u);
    finishRequest?.(Response.json({ challengeId: "challenge-1", expiresAt: 610_000 }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("allows 35 seconds for email delivery", async () => {
    const root = await createRoot();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async () => Response.json({ challengeId: "challenge-1", expiresAt: 610_000 })),
    });

    try {
      await manager.requestEmailCode("person@example.com");
      expect(timeout).toHaveBeenCalledWith(35_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("reuses the idempotency key after a timeout and accepts the replay", async () => {
    const root = await createRoot();
    const keys: string[] = [];
    let requests = 0;
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      requests += 1;
      if (requests === 2) {
        return Promise.resolve(Response.json({ challengeId: keys[0], expiresAt: 610_000 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
      emailCodeRequestTimeoutMs: 5,
    });

    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "error",
      issue: { code: "email_delivery_timeout" },
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: keys[0],
    });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("keeps the idempotency key while delivery is pending", async () => {
    const root = await createRoot();
    const keys: string[] = [];
    let requests = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      requests += 1;
      if (requests === 1) {
        return Response.json(
          { error: { code: "email_delivery_pending", message: "Delivery is still pending." } },
          { status: 409, headers: { "Retry-After": "25" } },
        );
      }
      return Response.json({ challengeId: "challenge-1", expiresAt: 610_000 });
    });
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "error",
      issue: { code: "email_delivery_pending", retryAfterSeconds: 25 },
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({ status: "code_sent" });
    expect(keys[1]).toBe(keys[0]);
  });

  it("disables verification of the old challenge while resend delivery is uncertain", async () => {
    const root = await createRoot();
    const keys: string[] = [];
    let requests = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      requests += 1;
      if (requests === 1) {
        return Response.json({ challengeId: "challenge-1", expiresAt: 610_000, resendAt: 1_000 });
      }
      if (requests === 2) {
        return Response.json(
          { error: { code: "email_delivery_pending", message: "Delivery is still pending." } },
          { status: 409 },
        );
      }
      return Response.json({ challengeId: keys[1], expiresAt: 610_000 });
    });
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: "challenge-1",
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "error",
      issue: { code: "email_delivery_pending" },
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "code_sent",
      challengeId: keys[1],
    });
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  it("creates a new idempotency key after a confirmed delivery failure", async () => {
    const root = await createRoot();
    const keys: string[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (keys.length === 1) {
        return Response.json(
          { error: { code: "email_delivery_failed", message: "Delivery failed." } },
          { status: 502 },
        );
      }
      return Response.json({ challengeId: "challenge-2", expiresAt: 610_000 });
    });
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({
      status: "error",
      issue: { code: "email_delivery_failed" },
    });
    await expect(manager.requestEmailCode("person@example.com")).resolves.toMatchObject({ status: "code_sent" });
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("accepts an HTTP-date Retry-After value", async () => {
    const root = await createRoot();
    const retryAt = new Date(Date.now() + 60_000).toUTCString();
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async () =>
        Response.json(
          { error: { code: "rate_limited", message: "Try again later." } },
          { status: 429, headers: { "Retry-After": retryAt } },
        ),
      ),
    });

    const state = await manager.requestEmailCode("person@example.com");
    expect(state).toMatchObject({
      status: "error",
      issue: { code: "rate_limited" },
    });
    if (state.status !== "error") throw new Error("Expected a rate-limited state.");
    expect(state.issue.retryAfterSeconds).toBeGreaterThanOrEqual(59);
    expect(state.issue.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("waits for the health endpoint before showing a signed-out state", async () => {
    const root = await createRoot();
    const startedAt = Date.now();
    const attempts: number[] = [];
    const fetchMock = vi
      .fn(async (input: string | URL | Request) => {
        attempts.push(Date.now() - startedAt);
        expect(new URL(input.toString()).pathname).toBe("/health/live");
        if (attempts.length < 3) throw new TypeError("fetch failed");
        return Response.json({ service: "openbot-auth-api", status: "ok" });
      })
      .mockName("health fetch");
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
      startupRetryWindowMs: 100,
      startupRequestTimeoutMs: 20,
      startupRetryDelaysMs: [10, 20],
    });

    const initialization = manager.initialize();
    expect(manager.getState()).toEqual({ status: "loading" });

    await expect(initialization).resolves.toEqual({ status: "signed_out" });
    expect(attempts).toHaveLength(3);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(8);
    expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(18);
  });

  it("retries session restoration without discarding the stored token", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    await writeFile(storagePath, Buffer.from("session-secret").toString("base64"));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        Response.json({
          id: "user-1",
          email: "person@example.com",
          name: null,
          avatarUrl: null,
        }),
      );
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
      startupRetryWindowMs: 50,
      startupRequestTimeoutMs: 10,
      startupRetryDelaysMs: [1],
    });

    const initialization = manager.initialize();

    await expect(initialization).resolves.toMatchObject({ status: "signed_in" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer session-secret");
    }
    expect(await readFile(storagePath, "utf8")).not.toBe("");
  });

  it("handles an unauthorized stored session without retrying", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    await writeFile(storagePath, Buffer.from("expired-session").toString("base64"));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { code: "unauthorized", message: "The session has expired." } }, { status: 401 }),
      );
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
    });

    await expect(manager.initialize()).resolves.toEqual({ status: "signed_out" });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(readFile(storagePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shows an unavailable error after 30 seconds and supports a shared manual retry", async () => {
    const root = await createRoot();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const manager = new CentralAuthManager({
      apiUrl: "http://127.0.0.1:3100",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: fetchMock,
      startupRetryWindowMs: 25,
      startupRequestTimeoutMs: 5,
      startupRetryDelaysMs: [5, 10],
    });

    const initialization = manager.initialize();
    expect(manager.retry()).toBe(initialization);
    await expect(initialization).resolves.toMatchObject({
      status: "error",
      issue: {
        code: "auth_api_unavailable",
        message: expect.stringContaining("Check that the API is running"),
      },
    });

    fetchMock.mockResolvedValueOnce(Response.json({ service: "openbot-auth-api", status: "ok" }));
    await expect(manager.retry()).resolves.toEqual({ status: "signed_out" });
  });

  it("uploads and removes the signed-in account avatar", async () => {
    const root = await createRoot();
    const requests: Request[] = [];
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        if (new URL(request.url).pathname.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (new URL(request.url).pathname.endsWith("/verify")) {
          return Response.json({
            sessionToken: "session-secret",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          });
        }
        return Response.json({
          id: "user-1",
          email: "person@example.com",
          name: null,
          avatarUrl: request.method === "PUT" ? "/v1/avatars/user-1?v=image-1" : null,
        });
      }),
    });
    await manager.requestEmailCode("person@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    await expect(
      manager.updateAvatar({
        mimeType: "image/png",
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      }),
    ).resolves.toMatchObject({
      status: "signed_in",
      user: { avatarUrl: "https://api.openbot.run/v1/avatars/user-1?v=image-1" },
    });
    expect(requests.at(-1)?.method).toBe("PUT");
    expect(requests.at(-1)?.headers.get("Content-Type")).toBe("image/png");
    expect(requests.at(-1)?.headers.get("Authorization")).toBe("Bearer session-secret");

    await expect(manager.updateAvatar(null)).resolves.toMatchObject({
      status: "signed_in",
      user: { avatarUrl: null },
    });
    expect(requests.at(-1)?.method).toBe("DELETE");
  });

  it("does not file a host credential under the account that signed in while it was issued", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    let releaseRegistration: () => void = () => undefined;
    const registrationHeld = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    let verifications = 0;
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (url.pathname.endsWith("/verify")) {
          verifications += 1;
          return Response.json({
            sessionToken: verifications === 1 ? "session-one" : "session-two",
            user: {
              id: `user-${verifications}`,
              email: `person${verifications}@example.com`,
              name: null,
              avatarUrl: null,
            },
          });
        }
        registrationStarted();
        await registrationHeld;
        return Response.json({
          hostId: "8f1c1f2e-1d9a-4a1a-9d1e-2f7c6b5a4d3c",
          name: "Studio Mac",
          membershipId: "member-1",
          authEpoch: 1,
          machineToken: "machine-token-for-the-first-account-0001",
        });
      }),
    });
    await manager.requestEmailCode("person1@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    const pending = manager.registerRemoteHost({
      hostId: "8f1c1f2e-1d9a-4a1a-9d1e-2f7c6b5a4d3c",
      name: "Studio Mac",
      ownerMembershipId: "member-1",
    });
    // Attach the rejection handler before the switch, so settling it raises no unhandled error.
    const settled = pending.catch(() => undefined);
    await started;
    await manager.requestEmailCode("person2@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");
    releaseRegistration();
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    const stored = await readFile(storagePath, "utf8");
    expect(Buffer.from(stored, "base64").toString()).not.toContain("machine-token-for-the-first-account");
  });

  it("does not keep one account's host credential beside the next account's session", async () => {
    const root = await createRoot();
    const storagePath = join(root, "session.bin");
    let verifications = 0;
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath,
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (url.pathname.endsWith("/verify")) {
          verifications += 1;
          return Response.json({
            sessionToken: verifications === 1 ? "session-one" : "session-two",
            user: {
              id: `user-${verifications}`,
              email: `person${verifications}@example.com`,
              name: null,
              avatarUrl: null,
            },
          });
        }
        return Response.json({
          hostId: "8f1c1f2e-1d9a-4a1a-9d1e-2f7c6b5a4d3c",
          name: "Studio Mac",
          membershipId: "member-1",
          authEpoch: 1,
          machineToken: "machine-token-for-the-first-account-0001",
        });
      }),
    });
    await manager.requestEmailCode("person1@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");
    await manager.registerRemoteHost({
      hostId: "8f1c1f2e-1d9a-4a1a-9d1e-2f7c6b5a4d3c",
      name: "Studio Mac",
      ownerMembershipId: "member-1",
    });

    // Signing in as somebody else without signing out first.
    await manager.requestEmailCode("person2@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    const stored = Buffer.from(await readFile(storagePath, "utf8"), "base64").toString();
    expect(stored).toContain("session-two");
    expect(stored).not.toContain("machine-token-for-the-first-account");
  });

  it("updates the signed-in account name", async () => {
    const root = await createRoot();
    const requests: Request[] = [];
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const path = new URL(request.url).pathname;
        if (path.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (path.endsWith("/verify")) {
          return Response.json({
            sessionToken: "session-secret",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          });
        }
        return Response.json({
          id: "user-1",
          email: "person@example.com",
          name: "Norbert",
          avatarUrl: null,
        });
      }),
    });
    await manager.requestEmailCode("person@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    await expect(manager.updateName("Norbert")).resolves.toMatchObject({
      status: "signed_in",
      user: { name: "Norbert" },
    });
    expect(requests.at(-1)?.method).toBe("PATCH");
    expect(requests.at(-1)?.headers.get("Content-Type")).toBe("application/json");
    expect(requests.at(-1)?.headers.get("Authorization")).toBe("Bearer session-secret");
    await expect(requests.at(-1)?.json()).resolves.toEqual({ name: "Norbert" });
  });

  it("keeps concurrent name and avatar updates in local state", async () => {
    const root = await createRoot();
    let finishAvatar: () => void = () => undefined;
    let finishName: () => void = () => undefined;
    const avatarResponse = new Promise<void>((resolve) => {
      finishAvatar = resolve;
    });
    const nameResponse = new Promise<void>((resolve) => {
      finishName = resolve;
    });
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        if (path.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (path.endsWith("/verify")) {
          return Response.json({
            sessionToken: "session-secret",
            user: {
              id: "user-1",
              email: "person@example.com",
              name: "Old name",
              avatarUrl: "/v1/avatars/user-1?v=old",
            },
          });
        }
        if (path === "/v1/me/avatar" && init?.method === "PUT") {
          await avatarResponse;
          return Response.json({
            id: "user-1",
            email: "person@example.com",
            name: "Old name",
            avatarUrl: "/v1/avatars/user-1?v=new",
          });
        }
        if (path === "/v1/me/profile") {
          await nameResponse;
          return Response.json({
            id: "user-1",
            email: "person@example.com",
            name: "New name",
            avatarUrl: "/v1/avatars/user-1?v=old",
          });
        }
        return new Response(null, { status: 404 });
      }),
    });
    await manager.requestEmailCode("person@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    const nameUpdate = manager.updateName("New name");
    const avatarUpdate = manager.updateAvatar({
      mimeType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    finishAvatar();
    await avatarUpdate;
    finishName();
    await nameUpdate;

    expect(manager.getState()).toMatchObject({
      status: "signed_in",
      user: {
        name: "New name",
        avatarUrl: "https://api.openbot.run/v1/avatars/user-1?v=new",
      },
    });
  });

  it("does not restore a signed-in state when an avatar request finishes after logout", async () => {
    const root = await createRoot();
    let finishAvatar: (() => void) | undefined;
    let finishLogout: (() => void) | undefined;
    const avatarResponse = new Promise<void>((resolve) => {
      finishAvatar = resolve;
    });
    const logoutResponse = new Promise<void>((resolve) => {
      finishLogout = resolve;
    });
    const manager = new CentralAuthManager({
      apiUrl: "https://api.openbot.run",
      storagePath: join(root, "session.bin"),
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(input.toString()).pathname;
        if (path.endsWith("/start")) {
          return Response.json({ challengeId: "challenge-1", expiresAt: 10_000 });
        }
        if (path.endsWith("/verify")) {
          return Response.json({
            sessionToken: "session-secret",
            user: { id: "user-1", email: "person@example.com", name: null, avatarUrl: null },
          });
        }
        if (path === "/v1/auth/logout") {
          await logoutResponse;
          return new Response(null, { status: 204 });
        }
        if (path === "/v1/me/avatar" && init?.method === "PUT") {
          await avatarResponse;
          return Response.json({
            id: "user-1",
            email: "person@example.com",
            name: null,
            avatarUrl: "/v1/avatars/user-1?v=image-late",
          });
        }
        return new Response(null, { status: 404 });
      }),
    });
    await manager.requestEmailCode("person@example.com");
    await manager.verifyEmailCode("challenge-1", "ABCD-EFGH");

    const avatarUpdate = manager.updateAvatar({
      mimeType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    const logout = manager.logout();
    finishLogout?.();
    await logout;
    finishAvatar?.();

    await expect(avatarUpdate).resolves.toMatchObject({ status: "signed_out" });
    expect(manager.getState()).toMatchObject({ status: "signed_out" });
  });

  it("accepts only HTTPS and local HTTP API origins", () => {
    expect(readCentralAuthApiUrl(undefined)).toBe("http://127.0.0.1:3100");
    expect(readCentralAuthApiUrl(undefined, "https://api.openbot.run")).toBe("https://api.openbot.run");
    expect(readCentralAuthApiUrl("https://auth.example.com")).toBe("https://auth.example.com");
    expect(() => readCentralAuthApiUrl("http://auth.example.com")).toThrow("HTTPS");
    expect(readMobileConnectApiUrl("http://192.168.1.143:3100", "https://api.openbot.run")).toBe(
      "http://192.168.1.143:3100",
    );
    expect(() => readMobileConnectApiUrl("http://203.0.113.10:3100", "https://api.openbot.run")).toThrow(
      "Invalid Mobile Connect payload",
    );
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-central-auth-"));
  roots.push(root);
  return root;
}
