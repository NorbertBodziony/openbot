import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import type { AgentService } from "../src/backend/agent-service";
import type { BrowserHost } from "../src/backend/browser-host";
import type { MailboxStore } from "../src/backend/mailbox-store";
import { buildNamedTunnelArgs, waitForNamedTunnelConnection } from "../src/main/host-service";
import { resolveCloudflaredExecutable, stopOwnedProcess } from "../src/main/remote-mac";
import { RemoteServerManager } from "../src/main/remote-server-manager";
import { TeamApiServer } from "../src/main/team-api-server";
import { TeamStore } from "../src/main/team-store";

const AUTH_API_URL = process.env.OPENBOT_AUTH_API_URL ?? "http://127.0.0.1:3100";
const REQUEST_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openbot-team-smoke-"));
  let api: TeamApiServer | null = null;
  let tunnel: ReturnType<typeof spawn> | null = null;
  let remote: RemoteServerManager | null = null;
  let cleanup: { sessionToken: string; serverId: string } | null = null;

  try {
    const executable = await resolveCloudflaredExecutable();
    if (!executable) {
      throw new Error("cloudflared is required for the team connection smoke test.");
    }
    const ownerSession = await createDevelopmentSession(`owner-${Date.now()}@example.com`);
    const memberSession = await createDevelopmentSession(`member-${Date.now()}@example.com`);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configureWithAccount("Smoke Host", ownerSession.user);
    const identity = store.getIdentity();
    if (!identity) throw new Error("The temporary team identity is missing.");
    cleanup = { sessionToken: ownerSession.sessionToken, serverId: identity.serverId };
    await provisionDevelopmentTunnel(ownerSession.sessionToken, identity.serverId, null);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const agentEvents = new EventEmitter();
    const agents = agentEvents as unknown as AgentService;
    api = new TeamApiServer({
      store,
      agents,
      mailbox: {} as MailboxStore,
      browser: {} as BrowserHost,
      getRemoteMac: () => ({ hostname: null, online: false }),
      redeemCentralTicket: redeemDevelopmentTicket,
    });
    const port = await api.start();
    const provisioned = await provisionDevelopmentTunnel(
      ownerSession.sessionToken,
      identity.serverId,
      port,
    );
    tunnel = spawn(executable, buildNamedTunnelArgs(), {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TUNNEL_TOKEN: provisioned.token },
    });
    const connected = await waitForNamedTunnelConnection(tunnel, 30_000);
    if (!connected) throw new Error("The named Cloudflare Tunnel did not connect.");
    const apiUrl = provisioned.apiUrl;
    await waitForPublicTunnel(apiUrl);
    const invite = await store.createInvite("member");
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", identity.serverId);
    inviteUrl.searchParams.set("fingerprint", identity.fingerprint);
    inviteUrl.searchParams.set("invite", invite.token);

    const cipher = createTemporaryCipher();
    const remotePath = join(root, "remote-servers.json");
    const remoteManager = new RemoteServerManager(remotePath, cipher, {
      createTeamAuthTicket: (serverId) =>
        createDevelopmentTeamTicket(memberSession.sessionToken, serverId),
      getEmail: () => memberSession.user.email,
    });
    remote = remoteManager;
    await remoteManager.initialize();
    const remoteEvent = new Promise<void>((resolve) => {
      remoteManager.once("agent", (_serverId, event) => {
        if (event.type === "error" && event.code === "team_smoke_event") resolve();
      });
    });
    const server = await remoteManager.join({ inviteUrl: inviteUrl.toString() });
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
    console.log(
      JSON.stringify({
        status: "passed",
        serverId: server.id,
        memberEmail: memberSession.user.email,
        memberCount: members.length,
        transport: "cloudflare-named-tunnel",
        hostname: new URL(apiUrl).hostname,
        events: "websocket",
      }),
    );
  } finally {
    remote?.stop();
    if (tunnel) await stopOwnedProcess(tunnel);
    if (cleanup) {
      await deprovisionDevelopmentTunnel(cleanup.sessionToken, cleanup.serverId);
    }
    await api?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function deprovisionDevelopmentTunnel(sessionToken: string, serverId: string): Promise<void> {
  const response = await fetch(new URL("/v1/team-tunnels/provision", AUTH_API_URL), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ serverId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Temporary tunnel cleanup returned ${response.status}.`);
  }
}

async function waitForPublicTunnel(apiUrl: string): Promise<void> {
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
  throw new Error(`The named tunnel is not reachable: ${lastError}`);
}

async function provisionDevelopmentTunnel(
  sessionToken: string,
  serverId: string,
  apiPort: number | null,
): Promise<{ apiUrl: string; token: string }> {
  const response = await fetch(new URL("/v1/team-tunnels/provision", AUTH_API_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ serverId, serverName: "Smoke Host", apiPort, vncEnabled: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value = (await response.json()) as {
    apiUrl?: string;
    token?: string;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !value.apiUrl || !value.token) {
    throw new Error(
      value.error
        ? `${value.error.code ?? "tunnel_error"}: ${value.error.message ?? "Tunnel provisioning failed."}`
        : `Tunnel provisioning returned ${response.status}.`,
    );
  }
  return { apiUrl: value.apiUrl, token: value.token };
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
