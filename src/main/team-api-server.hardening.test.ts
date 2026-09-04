// @vitest-environment node

// What the server refuses: an internal error it will not describe, a rate limit it will not let
// grow without bound, and input sizes it rejects before a service ever sees them.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { createOpenBotLogger } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { createAgents, createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer hardening", () => {
  it("does not expose unexpected internal errors", async () => {
    const { start, signIn } = await createTeamApiFixture("errors", { configure: true });
    const internalError = Object.assign(new Error("EACCES: /Users/private/openbot.db"), { code: "EACCES" });
    const lines: string[] = [];
    const { base } = await start({
      agents: createAgents({
        listBots: () => {
          throw internalError;
        },
      }),
      logger: createOpenBotLogger("test", (line) => lines.push(line)),
    });

    const token = await signIn();
    const response = await fetch(`${base}/v1/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Request failed." });
    expect(lines.some((line) => line.includes("Team API request failed:"))).toBe(true);

    const invalidLogin = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "wrong password value" }),
    });
    expect(invalidLogin.status).toBe(400);
    await expect(invalidLogin.json()).resolves.toEqual({ error: "The username or password is incorrect." });
  });

  it("bounds and expires unauthenticated rate-limit entries", async () => {
    const { start } = await createTeamApiFixture("rate-limit", { configure: true });
    let now = Date.parse("2026-08-22T12:00:00.000Z");
    const { base } = await start({
      rateLimitCapacity: 2,
      now: () => now,
    });
    const login = (username: string) =>
      fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "wrong password value" }),
      });

    expect((await login("alice")).status).toBe(400);
    expect((await login("bob")).status).toBe(400);
    expect((await login("carol")).status).toBe(429);

    now += 15 * 60 * 1_000 + 1;
    expect((await login("dave")).status).toBe(400);
  });

  it("rejects WebSocket event frames larger than one KiB", async () => {
    const { store, start } = await createTeamApiFixture("websocket-limit", { configure: true });
    const login = await store.login("owner", "correct horse battery");
    const { port } = await start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
      "openbot-events",
      `openbot-token.${login.sessionToken}`,
    ]);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event.code), { once: true });
      });
      socket.send("x".repeat(256 * 1_024 + 1));
      await expect(closed).resolves.toBe(1009);
    } finally {
      socket.close();
    }
  });

  it("rejects oversized agent input before it reaches the agent service", async () => {
    const { start, signIn } = await createTeamApiFixture("limits", { configure: true });
    const agents = createAgents();
    const { base } = await start({ agents });

    const token = await signIn();
    const message = await fetch(`${base}/v1/agents/chief/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(INPUT_LIMITS.messageText + 1) }),
    });
    expect(message.status).toBe(400);

    const update = await fetch(`${base}/v1/agents/chief`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "x".repeat(INPUT_LIMITS.agentName + 1) }),
    });
    expect(update.status).toBe(400);
  });
});
