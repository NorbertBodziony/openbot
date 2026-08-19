// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { BotSummary, ConversationWithReadState, TeamPresenceSnapshot } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import type * as Ws from "ws";
import { OpenBotDatabase } from "../backend/openbot-database";
import { TeamChatStore } from "../backend/team-chat-store";
import { TeamApiServer } from "./team-api-server";
import { TeamStore } from "./team-store";

const roots: string[] = [];
const tcpServers: ReturnType<typeof createTcpServer>[] = [];
type TeamApiOptions = ConstructorParameters<typeof TeamApiServer>[0];
type TestAgents = TeamApiOptions["agents"];
type TestMailbox = TeamApiOptions["mailbox"];
type TestBrowser = TeamApiOptions["browser"];
const requireModule = createRequire(import.meta.url);
const { WebSocket: NodeWebSocket }: typeof Ws = requireModule(
  join(dirname(requireModule.resolve("ws/package.json")), "index.js"),
);

interface TestRealtimeEvent {
  type: string;
  code?: string;
  snapshot?: unknown;
  message?: unknown;
  senderMemberId?: string;
  recipientMemberId?: string;
  typing?: boolean;
}

function unimplemented(..._arguments_: unknown[]): never {
  throw new Error("This operation is not used by this test.");
}

function createAgents(overrides: Partial<TestAgents> = {}, events = new EventEmitter()): TestAgents {
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
    listConversationReads: unimplemented,
    createBot: unimplemented,
    updateBot: unimplemented,
    deleteBot: unimplemented,
    setAvatar: unimplemented,
    resolveAvatar: unimplemented,
    readConversationFor: unimplemented,
    markConversationRead: unimplemented,
    prepareImportedAttachments: unimplemented,
    discardDraftAttachment: unimplemented,
    sendMessage: unimplemented,
    listQueue: unimplemented,
    setMessageReaction: unimplemented,
    cancelQueuedMessage: unimplemented,
    setQueuePaused: unimplemented,
    steerQueuedMessage: unimplemented,
    updateQueuedMessage: unimplemented,
    reorderQueue: unimplemented,
    interrupt: unimplemented,
    respondToPrompt: unimplemented,
    respondToApproval: unimplemented,
    ...overrides,
  };
}

function createMailbox(): TestMailbox {
  return { resolveAttachment: unimplemented };
}

function createBrowser(): TestBrowser {
  return {
    listTabs: unimplemented,
    getControlState: unimplemented,
    open: unimplemented,
    activate: unimplemented,
    close: unimplemented,
    setVisible: unimplemented,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(
    tcpServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("TeamApiServer administration", () => {
  it("joins an email-bound invitation with a verified OpenBot account", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-account-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const invite = await store.createInvite("member", "alice@example.com");
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const chat = new TeamChatStore(database);
    const agentEvents = new EventEmitter();
    const presenceSnapshots: TeamPresenceSnapshot[] = [];
    const agents = createAgents({}, agentEvents);
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      getRemoteMac: () => ({ hostname: null, online: false }),
      redeemCentralTicket: async (ticket, serverId) =>
        ticket === "valid-team-ticket" && serverId === store.getIdentity()?.serverId
          ? {
              id: "alice-account",
              email: "alice@example.com",
              name: "Alice",
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            }
          : null,
      onPresence: (snapshot) => presenceSnapshots.push(snapshot),
      chat,
    });
    const port = await api.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteToken: invite.token,
          accountTicket: "valid-team-ticket",
        }),
      });
      expect(response.status).toBe(201);
      const joined = await response.json();
      expect(joined.member).toMatchObject({
        email: "alice@example.com",
        role: "member",
        avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
      });
      expect(store.authenticate(joined.sessionToken)?.email).toBe("alice@example.com");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events",
        `openbot-token.${joined.sessionToken}`,
      ]);
      const initialPresence = nextJsonEvent(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), {
          once: true,
        });
      });
      await expect(initialPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            }),
          ]),
        },
      });

      const typingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: "chief", typing: true }));
      await expect(typingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              typingBotId: "chief",
            }),
          ]),
        },
      });

      const stoppedTypingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: null, typing: false }));
      await expect(stoppedTypingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([expect.objectContaining({ email: "alice@example.com", typingBotId: null })]),
        },
      });

      const owner = store.listMembers().find((member) => member.role === "owner");
      expect(owner).toBeDefined();
      const directTypingEvent = nextJsonEvent(socket);
      socket.send(
        JSON.stringify({
          type: "team-direct-typing",
          recipientMemberId: owner?.id,
          typing: true,
        }),
      );
      await expect(directTypingEvent).resolves.toMatchObject({
        type: "team-direct-typing",
        senderMemberId: joined.member.id,
        recipientMemberId: owner?.id,
        typing: true,
      });
      const directMessageEvent = nextJsonEvent(socket);
      const directResponse = await fetch(`http://127.0.0.1:${port}/v1/direct/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${joined.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          memberId: owner?.id,
          clientMessageId: "message-alice-owner",
          text: "Can we review this together?",
        }),
      });
      expect(directResponse.status).toBe(201);
      await expect(directMessageEvent).resolves.toMatchObject({
        type: "team-direct-message",
        message: {
          senderMemberId: joined.member.id,
          recipientMemberId: owner?.id,
          text: "Can we review this together?",
        },
      });
      const threads = await jsonRequest<Array<{ unreadCount: number }>>(
        `http://127.0.0.1:${port}`,
        "/v1/direct/threads",
        { token: joined.sessionToken },
      );
      expect(threads).toMatchObject([{ unreadCount: 0 }]);

      const received = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "error",
        code: "smoke_event",
        message: "WebSocket delivery works.",
      });
      await expect(received).resolves.toMatchObject({ type: "error", code: "smoke_event" });
      socket.close();
      await expect
        .poll(() => presenceSnapshots.at(-1)?.members.find((member) => member.email === "alice@example.com")?.online)
        .toBe(false);
    } finally {
      await api.stop();
      database.close();
    }
  });

  it("manages invites, members, sessions, and password changes on loopback", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const agents = createAgents();
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
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
      const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
        body: {
          inviteToken: invite.token,
          username: "alice",
          password: "a secure team password",
        },
      });
      const updated = await jsonRequest<{ role: string }>(base, `/v1/team/members/${joined.member.id}`, {
        method: "PATCH",
        token: ownerToken,
        body: { role: "admin" },
      });
      expect(updated.role).toBe("admin");

      const sessions = await jsonRequest<Array<{ id: string; username: string }>>(base, "/v1/team/sessions", {
        token: ownerToken,
      });
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
      await emptyRequest(base, `/v1/team/members/${joined.member.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      expect(store.listMembers().map((member) => member.username)).toEqual(["owner"]);
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

  it("rejects oversized agent input before it reaches the agent service", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-limits-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const agents = createAgents();
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      getRemoteMac: () => ({ hostname: null, online: false }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const message = await fetch(`${base}/v1/agents/chief/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "x".repeat(INPUT_LIMITS.messageText + 1) }),
      });
      expect(message.status).toBe(400);

      const update = await fetch(`${base}/v1/agents/chief`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x".repeat(INPUT_LIMITS.agentName + 1) }),
      });
      expect(update.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("publishes agents and conversations from the same local agent service", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-local-instance-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const localBots: BotSummary[] = [
      {
        id: "chief",
        name: "Chief",
        role: "Lead",
        description: "",
        notifications: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        threadId: "thread-chief",
        workspacePath: root,
        preview: "",
        updatedAt: null,
        avatarSeed: "chief",
        avatarHue: null,
        avatarUrl: null,
      },
    ];
    const localConversation: ConversationWithReadState = {
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "message-1",
          author: "assistant",
          text: "Stored locally",
          createdAt: "2026-08-19T10:00:00.000Z",
          status: "completed",
        },
      ],
    };
    const agents = createAgents({
      listBots: () => localBots,
      listConversationReads: () => ({
        chief: { unreadCount: 1, firstUnreadMessageId: "message-1", throughMessageId: null },
      }),
      readConversationFor: async (botId: string, _memberId: string) => ({
        ...localConversation,
        botId,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
      }),
      markConversationRead: async (_botId: string, _memberId: string, throughMessageId: string | null) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId,
      }),
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      getRemoteMac: () => ({ hostname: null, online: false }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      await expect(jsonRequest(base, "/v1/agents", { token: login.sessionToken })).resolves.toEqual(localBots);
      await expect(jsonRequest(base, "/v1/agents/chief/conversation", { token: login.sessionToken })).resolves.toEqual({
        ...localConversation,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
      });
      await expect(jsonRequest(base, "/v1/agents/conversation-reads", { token: login.sessionToken })).resolves.toEqual({
        chief: { unreadCount: 1, firstUnreadMessageId: "message-1", throughMessageId: null },
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation/read", {
          token: login.sessionToken,
          body: { throughMessageId: "message-1" },
        }),
      ).resolves.toEqual({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: "message-1",
      });
    } finally {
      await api.stop();
    }
  });

  it("responds to an authenticated remote approval request", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-approval-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const approvals: unknown[] = [];
    const agents = createAgents({
      respondToApproval: async (input: unknown) => {
        approvals.push(input);
      },
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      getRemoteMac: () => ({ hostname: null, online: false }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      await emptyRequest(base, "/v1/approvals/respond", {
        token: login.sessionToken,
        body: { requestId: 17, decision: "accept" },
      });
      expect(approvals).toEqual([{ requestId: 17, decision: "accept" }]);

      const invalid = await fetch(`${base}/v1/approvals/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: 17, decision: "session" }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("grants Remote Desktop through team membership and closes it after session revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-desktop-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const vnc = createTcpServer((socket) => {
      socket.write("RFB 003.889\n");
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    tcpServers.push(vnc);
    await new Promise<void>((resolve) => vnc.listen(0, "127.0.0.1", resolve));
    const address = vnc.address();
    if (!address || isString(address)) throw new Error("Missing VNC test port");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      getRemoteMac: () => ({ hostname: "desktop.test", online: true }),
      getRemoteDesktopPassword: () => "deskpass",
      remoteDesktopPort: address.port,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const access = await jsonRequest<{ configured: boolean; password: string }>(
        base,
        "/v1/host/remote-desktop-access",
        { token: login.sessionToken },
      );
      expect(access).toEqual({ configured: true, password: "deskpass" });

      const desktop = new NodeWebSocket(`ws://127.0.0.1:${port}/v1/remote-desktop`, [
        "openbot-desktop",
        `openbot-token.${login.sessionToken}`,
      ]);
      await expect(nextWebSocketMessage(desktop)).resolves.toEqual(Buffer.from("RFB 003.889\n"));
      desktop.send(Buffer.from("hello"));
      await expect(nextWebSocketMessage(desktop)).resolves.toEqual(Buffer.from("echo:hello"));

      const ownerSession = store.listSessions().find((session) => session.username === "owner");
      if (!ownerSession) throw new Error("Missing owner session");
      await store.revokeSession(ownerSession.id);
      const closed = new Promise<number>((resolve) => desktop.once("close", (code) => resolve(code)));
      desktop.send(Buffer.from("after-revoke"));
      await expect(closed).resolves.toBe(1008);

      const unauthorized = await fetch(`${base}/v1/host/remote-desktop-access`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await api.stop();
    }
  });
});

function nextWebSocketMessage(websocket: Ws.WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    websocket.once("message", (data) => {
      resolve(Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
    });
    websocket.once("error", reject);
  });
}

function nextJsonEvent(websocket: WebSocket): Promise<TestRealtimeEvent> {
  return new Promise((resolve, reject) => {
    websocket.addEventListener(
      "message",
      (message) => resolve(decodeTestRealtimeEvent(JSON.parse(String(message.data)))),
      { once: true },
    );
    websocket.addEventListener("error", () => reject(new Error("WebSocket event failed.")), {
      once: true,
    });
  });
}

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
  return await response.json();
}

function decodeTestRealtimeEvent(value: unknown): TestRealtimeEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) {
    throw new Error("Invalid test realtime event.");
  }
  const code = value.code;
  if (code !== undefined && !isString(code)) throw new Error("Invalid test event code.");
  const senderMemberId = value.senderMemberId;
  if (senderMemberId !== undefined && !isString(senderMemberId)) {
    throw new Error("Invalid test sender.");
  }
  const recipientMemberId = value.recipientMemberId;
  if (recipientMemberId !== undefined && !isString(recipientMemberId)) {
    throw new Error("Invalid test recipient.");
  }
  const typing = value.typing;
  if (typing !== undefined && !isBoolean(typing)) throw new Error("Invalid test typing state.");
  return {
    type: value.type,
    ...(code === undefined ? {} : { code }),
    ...(value.snapshot === undefined ? {} : { snapshot: value.snapshot }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(senderMemberId === undefined ? {} : { senderMemberId }),
    ...(recipientMemberId === undefined ? {} : { recipientMemberId }),
    ...(typing === undefined ? {} : { typing }),
  };
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
