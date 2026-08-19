import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralAuthManager, readCentralAuthApiUrl } from "./central-auth-manager";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CentralAuthManager", () => {
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
      if (url.pathname === "/v1/team-tunnels/provision") {
        return Response.json({
          tunnelId: "11111111-1111-4111-8111-111111111111",
          tunnelName: "openbot-00000000000040008000000000000000",
          apiUrl: "https://studio-mac-k7m4q2pz-host.openbot.run",
          vncHostname: "vnc-studio-mac-k7m4q2pz-host.openbot.run",
          token: "x".repeat(40),
        });
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
    await manager.sendTeamInviteEmail({
      email: "alice@example.com",
      serverName: "Studio Mac",
      inviteUrl: "openbot://join?invite=token",
      role: "member",
    });
    await expect(
      manager.provisionTeamTunnel({
        serverId,
        serverName: "Studio Mac",
        apiPort: 43_123,
        vncEnabled: true,
      }),
    ).resolves.toMatchObject({
      apiUrl: "https://studio-mac-k7m4q2pz-host.openbot.run",
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
      path: "/v1/team-invitations/email",
      authorization: "Bearer session-secret",
    });
    expect(requests[6]).toMatchObject({
      path: "/v1/team-tunnels/provision",
      authorization: "Bearer session-secret",
      body: { serverId, serverName: "Studio Mac", apiPort: 43_123, vncEnabled: true },
    });

    const restored = new CentralAuthManager(options);
    expect(await restored.initialize()).toMatchObject({ status: "signed_in" });
    expect(requests.at(-1)).toMatchObject({
      path: "/v1/me",
      authorization: "Bearer session-secret",
    });
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
      error: "The sign-in code is incorrect.",
    });
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
      code: "auth_api_unavailable",
      message: expect.stringContaining("Check that the API is running"),
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
    expect(readCentralAuthApiUrl("https://auth.example.com")).toBe("https://auth.example.com");
    expect(() => readCentralAuthApiUrl("http://auth.example.com")).toThrow("HTTPS");
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openbot-central-auth-"));
  roots.push(root);
  return root;
}
