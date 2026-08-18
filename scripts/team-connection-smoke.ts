import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentService } from "../src/backend/agent-service";
import type { BrowserHost } from "../src/backend/browser-host";
import type { MailboxStore } from "../src/backend/mailbox-store";
import { parseQuickTunnelHostname } from "../src/main/host-service";
import { resolveCloudflaredExecutable, stopOwnedProcess } from "../src/main/remote-mac";
import { RemoteServerManager } from "../src/main/remote-server-manager";
import { TeamApiServer } from "../src/main/team-api-server";
import { TeamStore } from "../src/main/team-store";
import type { CentralAuthUser } from "../src/shared/ipc";

const AUTH_API_URL = process.env.OPENBOT_AUTH_API_URL ?? "http://127.0.0.1:3100";
const REQUEST_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openbot-team-smoke-"));
  const executable = await resolveCloudflaredExecutable();
  if (!executable) throw new Error("cloudflared is required for the team connection smoke test.");

  const ownerSession = await createDevelopmentSession(`owner-${Date.now()}@example.com`);
  const memberSession = await createDevelopmentSession(`member-${Date.now()}@example.com`);
  const store = new TeamStore(join(root, "team.json"));
  await store.initialize();
  await store.configureWithAccount("Smoke Host", ownerSession.user);
  const agentEvents = new EventEmitter();
  const agents = agentEvents as unknown as AgentService;
  const api = new TeamApiServer({
    store,
    agents,
    mailbox: {} as MailboxStore,
    browser: {} as BrowserHost,
    getRemoteMac: () => ({ hostname: null, online: false }),
    redeemCentralTicket: redeemDevelopmentTicket,
  });
  const port = await api.start();
  const tunnel = spawn(
    executable,
    ["tunnel", "--protocol", "quic", "--url", `http://127.0.0.1:${port}`],
    { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const tunnelState = await waitForTunnel(tunnel);
    const hostname = tunnelState.hostname;
    const apiUrl = `https://${hostname}`;
    await waitForPublicTunnel(apiUrl, tunnelState.output);
    const identity = store.getIdentity();
    if (!identity) throw new Error("The temporary team identity is missing.");
    const invite = await store.createInvite("member");
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", identity.serverId);
    inviteUrl.searchParams.set("fingerprint", identity.fingerprint);
    inviteUrl.searchParams.set("invite", invite.token);

    const cipher = createTemporaryCipher();
    const remotePath = join(root, "remote-servers.json");
    const remote = new RemoteServerManager(remotePath, cipher, {
      createTeamAuthTicket: (serverId) =>
        createDevelopmentTeamTicket(memberSession.sessionToken, serverId),
      getEmail: () => memberSession.user.email,
    });
    await remote.initialize();
    const remoteEvent = new Promise<void>((resolve) => {
      remote.once("agent", (_serverId, event) => {
        if (event.type === "error" && event.code === "team_smoke_event") resolve();
      });
    });
    const server = await remote.join({ inviteUrl: inviteUrl.toString() });
    const eventInterval = setInterval(() => {
      agentEvents.emit("event", {
        type: "error",
        code: "team_smoke_event",
        message: "WebSocket event delivery works.",
      });
    }, 250);
    try {
      await Promise.race([
        remoteEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("The remote WebSocket event did not arrive.")), 10_000),
        ),
      ]);
    } finally {
      clearInterval(eventInterval);
    }
    const members = store.listMembers();
    const storedRemote = await readFile(remotePath, "utf8");

    if (server.state !== "online" || server.role !== "member") {
      throw new Error("The remote server did not become online with the member role.");
    }
    if (!members.some((member) => member.email === memberSession.user.email)) {
      throw new Error("The verified member was not added to the host.");
    }
    if (storedRemote.includes(memberSession.sessionToken)) {
      throw new Error("The host session token was stored without encryption.");
    }
    remote.stop();
    console.log(
      JSON.stringify({
        status: "passed",
        serverId: server.id,
        memberEmail: memberSession.user.email,
        memberCount: members.length,
        transport: "cloudflare-quick-tunnel",
        events: "websocket",
      }),
    );
  } finally {
    await stopOwnedProcess(tunnel);
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForPublicTunnel(apiUrl: string, tunnelOutput: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/v1/identity", apiUrl), {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `The Quick Tunnel is not reachable: ${lastError}\n${tunnelOutput().slice(-4_000)}`,
  );
}

async function createDevelopmentSession(email: string): Promise<{
  sessionToken: string;
  user: CentralAuthUser;
}> {
  const challenge = await requestJson<{
    challengeId: string;
    developmentCode?: string;
  }>("/v1/auth/email/start", { email });
  if (!challenge.developmentCode) {
    throw new Error("The local Auth API must expose development OTP codes for this smoke test.");
  }
  return requestJson("/v1/auth/email/verify", {
    challengeId: challenge.challengeId,
    code: challenge.developmentCode,
  });
}

async function createDevelopmentTeamTicket(
  sessionToken: string,
  serverId: string,
): Promise<string> {
  const response = await fetch(new URL("/v1/team-auth/ticket", AUTH_API_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ serverId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The Auth API returned ${response.status}.`);
  const value = (await response.json()) as { ticket?: string };
  if (!value.ticket) throw new Error("The Auth API did not return a team ticket.");
  return value.ticket;
}

async function redeemDevelopmentTicket(
  ticket: string,
  serverId: string,
): Promise<CentralAuthUser | null> {
  const response = await fetch(new URL("/v1/team-auth/redeem", AUTH_API_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, serverId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`The Auth API returned ${response.status}.`);
  return (await response.json()) as CentralAuthUser;
}

async function requestJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(new URL(path, AUTH_API_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok)
    throw new Error(value.error?.message ?? `Request failed with ${response.status}.`);
  return value;
}

function waitForTunnel(child: ReturnType<typeof spawn>): Promise<{
  hostname: string;
  output: () => string;
}> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("The Quick Tunnel did not start.")), 30_000);
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-32_000);
      const hostname = parseQuickTunnelHostname(output);
      if (hostname) finish(null, hostname);
    };
    const finish = (error: Error | null, hostname?: string) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ hostname: hostname as string, output: () => output });
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error(`cloudflared stopped with code ${code}.`)));
  });
}

function createTemporaryCipher(): {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
} {
  const key = randomBytes(32);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decrypt(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
