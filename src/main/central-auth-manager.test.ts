import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralAuthManager, readCentralAuthApiUrl } from "./central-auth-manager";

const roots: string[] = [];

afterEach(async () => {
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
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
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
      fetch: fetchMock as typeof fetch,
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
    expect(requests[1]?.body).toEqual({ challengeId: "challenge-1", code: "ABCD-EFGH" });
    expect(await readFile(storagePath, "utf8")).not.toContain("session-secret");

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
      }) as typeof fetch,
    });
    await manager.requestEmailCode("person@example.com");
    expect(await manager.verifyEmailCode("challenge-1", "AAAA-AAAA")).toMatchObject({
      status: "code_sent",
      challengeId: "challenge-1",
      error: "The sign-in code is incorrect.",
    });
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
