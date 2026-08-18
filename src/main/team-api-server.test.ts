// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import { TeamApiServer } from "./team-api-server";
import { TeamStore } from "./team-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamApiServer administration", () => {
  it("manages invites, members, sessions, and password changes on loopback", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const agents = new EventEmitter() as unknown as AgentService;
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: {} as MailboxStore,
      browser: {} as BrowserHost,
      getRemoteMac: () => ({ hostname: null, online: false }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const ownerToken = ownerLogin.sessionToken;
      const invite = await jsonRequest<{ id: string; token: string }>(base, "/v1/team/invites", {
        token: ownerToken,
        body: { role: "member" },
      });
      const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(
        base,
        "/v1/join",
        {
          body: {
            inviteToken: invite.token,
            username: "alice",
            password: "a secure team password",
          },
        },
      );
      const updated = await jsonRequest<{ role: string }>(
        base,
        `/v1/team/members/${joined.member.id}`,
        { method: "PATCH", token: ownerToken, body: { role: "admin" } },
      );
      expect(updated.role).toBe("admin");

      const sessions = await jsonRequest<Array<{ id: string; username: string }>>(
        base,
        "/v1/team/sessions",
        { token: ownerToken },
      );
      const aliceSession = sessions.find((session) => session.username === "alice");
      expect(aliceSession).toBeDefined();
      await emptyRequest(base, `/v1/team/sessions/${aliceSession?.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      expect(store.authenticate(joined.sessionToken)).toBeNull();

      await emptyRequest(base, `/v1/team/invites/${invite.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      await emptyRequest(base, "/v1/auth/password", {
        token: ownerToken,
        body: {
          currentPassword: "correct horse battery",
          newPassword: "a newer secure password",
        },
      });
      expect(store.authenticate(ownerToken)).toBeNull();
    } finally {
      await api.stop();
    }
  });
});

async function jsonRequest<T>(
  base: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function emptyRequest(
  base: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown },
): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "POST",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  expect(response.status).toBe(204);
}
