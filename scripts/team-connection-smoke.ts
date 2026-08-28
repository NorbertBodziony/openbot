import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInviteUrl } from "@openbot/contracts/invite-links";
import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { TeamChatStore } from "../src/backend/team-chat-store";
import { buildNamedTunnelArgs, waitForNamedTunnelConnection } from "../src/main/host-service";
import { resolveCloudflaredExecutable, stopOwnedProcess } from "../src/main/host-tunnel-runtime";
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
  let database: OpenBotDatabase | null = null;
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
    await provisionDevelopmentTunnel(ownerSession.sessionToken, identity.serverId, null);
    cleanup = { sessionToken: ownerSession.sessionToken, serverId: identity.serverId };
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    database = new OpenBotDatabase(join(root, "user-data"));
    await database.initialize();
    const agentEvents = new EventEmitter();
    const agents = createSmokeAgents(agentEvents);
    const mailbox = { resolveAttachment: unimplemented };
    const browser = {
      onChanged: () => () => undefined,
      onControlChanged: () => () => undefined,
      clearControls: () => undefined,
      endControl: () => undefined,
      handleDynamicTool: async () => ({ success: true as const, contentItems: [] }),
      listTabs: () => [],
      getControlState: () => ({ sessions: [] }),
      open: async () => {
        throw new Error("Browser is unavailable in the team smoke host.");
      },
      activate: async () => undefined,
      navigate: async () => undefined,
      reload: async () => undefined,
      close: async () => undefined,
      capturePreview: async () => {
        throw new Error("Browser preview is unavailable in the team smoke host.");
      },
      setVisible: async () => undefined,
    };
    const chat = new TeamChatStore(database);
    api = new TeamApiServer({
      store,
      agents,
      mailbox,
      browser,
      chat,
      redeemCentralTicket: redeemDevelopmentTicket,
    });
    const port = await api.start();
    const provisioned = await provisionDevelopmentTunnel(ownerSession.sessionToken, identity.serverId, port);
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
    const inviteUrl = createInviteUrl({
      apiUrl,
      serverId: identity.serverId,
      fingerprint: identity.fingerprint,
      token: invite.token,
    });

    const cipher = createTemporaryCipher();
    const remotePath = join(root, "remote-servers.json");
    const remoteManager = new RemoteServerManager(remotePath, cipher, {
      createTeamAuthTicket: (serverId) => createDevelopmentTeamTicket(memberSession.sessionToken, serverId),
      getEmail: () => memberSession.user.email,
    });
    remote = remoteManager;
    await remoteManager.initialize();
    const preview = await remoteManager.previewInvite({ inviteUrl });
    if (
      preview.serverName !== "Smoke Host" ||
      preview.role !== "member" ||
      preview.emailBound ||
      preview.serverId !== identity.serverId
    ) {
      throw new Error("The invitation preview did not match the host invitation.");
    }
    const remoteEvent = new Promise<void>((resolve) => {
      remoteManager.once("agent", (_serverId, event) => {
        if (event.type === "error" && event.code === "team_smoke_event") resolve();
      });
    });
    const server = await remoteManager.join({ inviteUrl });
    let reuseRejected = false;
    try {
      await remoteManager.join({ inviteUrl });
    } catch {
      reuseRejected = true;
    }
    if (!reuseRejected) throw new Error("The host accepted a reused invitation.");
    const eventInterval = setInterval(() => {
      agentEvents.emit("event", {
        type: "error",
        code: "team_smoke_event",
        message: "WebSocket event delivery works.",
      });
    }, 250);
    try {
      await withTimeout(remoteEvent, "The remote WebSocket event did not arrive.");
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
    const owner = members.find((member) => member.role === "owner");
    const member = members.find((candidate) => candidate.email === memberSession.user.email);
    if (!owner || !member) throw new Error("The smoke-test members are incomplete.");

    const ownerMessageEvent = new Promise<void>((resolve) => {
      remoteManager.once("directMessage", (_serverId, event) => {
        if (
          event.message.senderMemberId === owner.id &&
          event.message.recipientMemberId === member.id &&
          event.message.text === "Hello from the host owner."
        ) {
          resolve();
        }
      });
    });
    const ownerMessage = api.sendDirectMessage(owner.id, {
      memberId: member.id,
      text: "Hello from the host owner.",
      clientMessageId: "smoke-owner-message",
    });
    await withTimeout(ownerMessageEvent, "The owner direct message did not reach the member.");
    const unreadThreads = await remoteManager.listDirectThreads();
    if (unreadThreads[0]?.unreadCount !== 1) {
      throw new Error("The member direct-message unread count is invalid.");
    }
    await remoteManager.markDirectRead({
      memberId: owner.id,
      throughSequence: ownerMessage.sequence,
    });
    if ((await remoteManager.listDirectThreads())[0]?.unreadCount !== 0) {
      throw new Error("The member direct-message read state was not stored.");
    }

    const memberMessageEvent = new Promise<void>((resolve) => {
      remoteManager.once("directMessage", (_serverId, event) => {
        if (
          event.message.senderMemberId === member.id &&
          event.message.recipientMemberId === owner.id &&
          event.message.text === "Hello from the remote member."
        ) {
          resolve();
        }
      });
    });
    await remoteManager.sendDirectMessage({
      memberId: owner.id,
      text: "Hello from the remote member.",
      clientMessageId: "smoke-member-message",
    });
    await withTimeout(memberMessageEvent, "The member direct message event did not arrive.");
    const ownerConversation = chat.readConversation(owner.id, member.id);
    if (ownerConversation.messages.length !== 2 || chat.listThreads(owner.id)[0]?.unreadCount !== 1) {
      throw new Error("The host did not persist the complete direct conversation.");
    }

    const typingEvent = new Promise<void>((resolve) => {
      remoteManager.once("directTyping", (_serverId, event) => {
        if (event.senderMemberId === owner.id && event.recipientMemberId === member.id && event.typing) {
          resolve();
        }
      });
    });
    api.setLocalDirectTyping(owner.id, member.id, true);
    await withTimeout(typingEvent, "The direct-message typing event did not arrive.");
    api.setLocalDirectTyping(owner.id, member.id, false);
    console.log(
      JSON.stringify({
        status: "passed",
        serverId: server.id,
        memberEmail: memberSession.user.email,
        memberCount: members.length,
        transport: "cloudflare-named-tunnel",
        hostname: new URL(apiUrl).hostname,
        events: "websocket",
        directMessages: ownerConversation.messages.length,
        directTyping: "websocket",
      }),
    );
  } finally {
    remote?.stop();
    if (tunnel) await stopOwnedProcess(tunnel);
    if (cleanup) {
      await deprovisionDevelopmentTunnel(cleanup.sessionToken, cleanup.serverId);
    }
    await api?.stop();
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
}

type SmokeAgents = ConstructorParameters<typeof TeamApiServer>[0]["agents"];

function createSmokeAgents(events: EventEmitter): SmokeAgents {
  return {
    on: (event, listener) => {
      events.on(event, listener);
    },
    off: (event, listener) => {
      events.off(event, listener);
    },
    getStatus: unimplemented,
    getUsage: unimplemented,
    listModels: unimplemented,
    listBots: unimplemented,
    listMemories: unimplemented,
    createMemory: unimplemented,
    updateMemory: unimplemented,
    deleteMemory: unimplemented,
    clearMemories: unimplemented,
    listRoutines: unimplemented,
    createRoutine: unimplemented,
    updateRoutine: unimplemented,
    deleteRoutine: unimplemented,
    testRoutine: unimplemented,
    listRoutineRuns: unimplemented,
    listConversationReads: unimplemented,
    createBot: unimplemented,
    updateBot: unimplemented,
    deleteBot: unimplemented,
    setAvatar: unimplemented,
    resolveAvatar: unimplemented,
    resolveSharedFile: unimplemented,
    resolveWorkspaceFile: unimplemented,
    readConversationFor: unimplemented,
    readConversationPageFor: unimplemented,
    searchConversationMessages: unimplemented,
    markConversationRead: unimplemented,
    prepareImportedAttachments: unimplemented,
    discardDraftAttachment: unimplemented,
    sendMessage: unimplemented,
    listQueue: unimplemented,
    setMessageReaction: unimplemented,
    cancelQueuedMessage: unimplemented,
    steerQueuedMessage: unimplemented,
    updateQueuedMessage: unimplemented,
    reorderQueue: unimplemented,
    interrupt: unimplemented,
    respondToPrompt: unimplemented,
    respondToApproval: unimplemented,
    respondToBrowserTakeover: unimplemented,
  };
}

function unimplemented(): never {
  throw new Error("This operation is not used by the team connection smoke test.");
}

async function withTimeout(operation: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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
    body: JSON.stringify({ serverId, serverName: "Smoke Host", apiPort }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value = await readJsonRecord(response);
  const apiUrl = stringField(value, "apiUrl");
  const token = stringField(value, "token");
  const error = recordField(value, "error");
  if (!response.ok || !apiUrl || !token) {
    throw new Error(
      error
        ? `${stringField(error, "code") ?? "tunnel_error"}: ${stringField(error, "message") ?? "Tunnel provisioning failed."}`
        : `Tunnel provisioning returned ${response.status}.`,
    );
  }
  return { apiUrl, token };
}

async function createDevelopmentSession(email: string): Promise<{
  sessionToken: string;
  user: CentralAuthUser;
}> {
  const challenge = await requestJson("/v1/auth/email/start", { email }, decodeChallenge);
  if (!challenge.developmentCode) {
    throw new Error("The local Auth API must expose development OTP codes for this smoke test.");
  }
  return requestJson(
    "/v1/auth/email/verify",
    { challengeId: challenge.challengeId, code: challenge.developmentCode },
    decodeCentralAuthSession,
  );
}

async function createDevelopmentTeamTicket(sessionToken: string, serverId: string): Promise<string> {
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
  const value = await readJsonRecord(response);
  const ticket = stringField(value, "ticket");
  if (!ticket) throw new Error("The Auth API did not return a team ticket.");
  return ticket;
}

async function redeemDevelopmentTicket(ticket: string, serverId: string): Promise<CentralAuthUser | null> {
  const response = await fetch(new URL("/v1/team-auth/redeem", AUTH_API_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, serverId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`The Auth API returned ${response.status}.`);
  return decodeCentralAuthUser(await response.json());
}

async function requestJson<T>(path: string, body: unknown, decode: (value: DynamicRecord) => T): Promise<T> {
  const response = await fetch(new URL(path, AUTH_API_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const value = await readJsonRecord(response);
  if (!response.ok) {
    throw new Error(stringField(recordField(value, "error"), "message") ?? `Request failed with ${response.status}.`);
  }
  return decode(value);
}

async function readJsonRecord(response: Response): Promise<DynamicRecord> {
  const value = await response.json();
  if (!isDynamicRecord(value)) throw new Error("The Auth API returned invalid JSON.");
  return value;
}

function recordField(value: DynamicRecord, key: string): DynamicRecord | null;
function recordField(value: unknown, key: string): DynamicRecord | null;
function recordField(value: unknown, key: string): DynamicRecord | null {
  return isDynamicRecord(value) && isDynamicRecord(value[key]) ? value[key] : null;
}

function stringField(value: unknown, key: string): string | null {
  return isDynamicRecord(value) && isString(value[key]) ? value[key] : null;
}

function nullableStringField(value: DynamicRecord, key: string): string | null {
  return value[key] === null ? null : (stringField(value, key) ?? null);
}

function decodeChallenge(value: DynamicRecord): { challengeId: string; developmentCode?: string } {
  const challengeId = stringField(value, "challengeId");
  if (!challengeId) throw new Error("The Auth API returned an invalid challenge.");
  const developmentCode = stringField(value, "developmentCode");
  return developmentCode ? { challengeId, developmentCode } : { challengeId };
}

function decodeCentralAuthUser(value: unknown): CentralAuthUser {
  if (!isDynamicRecord(value)) throw new Error("The Auth API returned an invalid user.");
  const id = stringField(value, "id");
  const email = stringField(value, "email");
  if (!id || !email) throw new Error("The Auth API returned an invalid user.");
  return {
    id,
    email,
    name: nullableStringField(value, "name"),
    avatarUrl: nullableStringField(value, "avatarUrl"),
  };
}

function decodeCentralAuthSession(value: DynamicRecord): {
  sessionToken: string;
  user: CentralAuthUser;
} {
  const sessionToken = stringField(value, "sessionToken");
  const user = decodeCentralAuthUser(value.user);
  if (!sessionToken) throw new Error("The Auth API returned an invalid session.");
  return { sessionToken, user };
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
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
