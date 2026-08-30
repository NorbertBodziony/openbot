// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  BotMemory,
  BotSummary,
  ConversationWithReadState,
  CreateBotInput,
  Routine,
  RoutineRun,
  TeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import { AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenBotDatabase } from "../backend/openbot-database";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TeamChatStore } from "../backend/team-chat-store";
import { TeamApiServer } from "./team-api-server";
import { TeamStore } from "./team-store";

const roots: string[] = [];
type TeamApiOptions = ConstructorParameters<typeof TeamApiServer>[0];
type TestAgents = TeamApiOptions["agents"];
type TestMailbox = TeamApiOptions["mailbox"];
type TestBrowser = TeamApiOptions["browser"];

interface TestRealtimeEvent {
  type: string;
  code?: string;
  snapshot?: unknown;
  message?: unknown;
  senderMemberId?: string;
  recipientMemberId?: string;
  typing?: boolean;
  layout?: unknown;
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
    getRuntimeSnapshot: () => ({
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }),
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
    readConversationFor: unimplemented,
    readConversationPageFor: unimplemented,
    searchConversationMessages: unimplemented,
    markConversationRead: unimplemented,
    prepareImportedAttachments: unimplemented,
    discardDraftAttachment: unimplemented,
    resolveSharedFile: unimplemented,
    resolveWorkspaceFile: unimplemented,
    sendMessage: unimplemented,
    listQueue: unimplemented,
    acknowledgeFailedTurn: unimplemented,
    setMessageReaction: unimplemented,
    cancelQueuedMessage: unimplemented,
    steerQueuedMessage: unimplemented,
    updateQueuedMessage: unimplemented,
    reorderQueue: unimplemented,
    interrupt: unimplemented,
    respondToPrompt: unimplemented,
    respondToApproval: unimplemented,
    respondToBrowserTakeover: unimplemented,
    ...overrides,
  };
}

function createMailbox(): TestMailbox {
  return { resolveAttachment: unimplemented };
}

function createBrowser(overrides: Partial<TestBrowser> = {}): TestBrowser {
  return {
    listTabs: unimplemented,
    getControlState: unimplemented,
    open: unimplemented,
    activate: unimplemented,
    navigate: unimplemented,
    reload: unimplemented,
    close: unimplemented,
    capturePreview: unimplemented,
    setVisible: unimplemented,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamApiServer administration", () => {
  it("shares sidebar layout mutations with owner, admin, and member clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-sidebar-layout-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const adminInvite = await store.createInvite("admin");
    const memberInvite = await store.createInvite("member");
    const admin = await store.acceptInviteWithAccount(adminInvite.token, {
      id: "admin-account",
      email: "admin@example.com",
      name: "Admin",
      avatarUrl: null,
    });
    const member = await store.acceptInviteWithAccount(memberInvite.token, {
      id: "member-account",
      email: "member@example.com",
      name: "Member",
      avatarUrl: null,
    });
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const getRuntimeSnapshot = vi.fn<TestAgents["getRuntimeSnapshot"]>(() => ({
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }));
    const agentEvents = new EventEmitter();
    const agents = createAgents({
      on: (event, listener) => agentEvents.on(event, listener),
      off: (event, listener) => agentEvents.off(event, listener),
      getRuntimeSnapshot,
      listBots: () => [
        {
          id: "chief",
          provider: "codex",
          name: "Chief",
          title: "Lead",
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
        } satisfies BotSummary,
      ],
    });
    let now = 0;
    const api = new TeamApiServer({
      store,
      agents,
      sidebarLayout,
      mailbox: createMailbox(),
      browser: createBrowser(),
      now: () => now,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const owner = await store.login("owner", "correct horse battery");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${member.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({
        type: "runtime-snapshot",
        snapshot: { bots: [], activeTurns: [], pendingApprovals: [] },
      });
      expect(initialPresence).toMatchObject({ type: "team-presence" });

      const conversation = {
        type: "conversation",
        snapshot: {
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 1,
          messages: [
            {
              id: "reply-1",
              author: "assistant",
              text: "Done",
              createdAt: "2026-08-29T10:00:00.000Z",
              status: "completed",
            },
          ],
        },
      };
      getRuntimeSnapshot.mockReturnValueOnce({
        ...createAgents().getRuntimeSnapshot(),
        latestMessages: [{ botId: "chief", id: "reply-1", text: "Done", createdAt: "2026-08-29T10:00:00.000Z" }],
      });
      const boundedEvents = nextJsonEvents(socket, 2);
      agentEvents.emit("event", conversation);
      agentEvents.emit("event", {
        type: "turn-completed",
        botId: "chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        status: "completed",
      });
      await expect(boundedEvents).resolves.toEqual([
        expect.objectContaining({ type: "turn-completed" }),
        expect.objectContaining({
          type: "runtime-snapshot",
          snapshot: expect.objectContaining({ latestMessages: [expect.objectContaining({ id: "reply-1" })] }),
        }),
      ]);

      socket.send(JSON.stringify({ type: "agent-event-scope", includeConversations: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const conversationEvent = nextJsonEvent(socket);
      agentEvents.emit("event", conversation);
      await expect(conversationEvent).resolves.toMatchObject({ type: "conversation" });

      const eventAfterOversizedConversation = nextJsonEvent(socket);
      agentEvents.emit("event", {
        ...conversation,
        snapshot: {
          ...conversation.snapshot,
          messages: [{ ...conversation.snapshot.messages[0], text: "x".repeat(1024 * 1024) }],
        },
      });
      agentEvents.emit("event", { type: "bots-changed", bots: [] });
      await expect(eventAfterOversizedConversation).resolves.toMatchObject({ type: "bots-changed" });

      const refreshedSnapshot = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      await expect(refreshedSnapshot).resolves.toMatchObject({ type: "runtime-snapshot" });
      for (let index = 0; index < 20; index += 1) {
        socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(getRuntimeSnapshot).toHaveBeenCalledTimes(3);

      for (const [index, token] of [owner.sessionToken, admin.sessionToken, member.sessionToken].entries()) {
        const event = nextJsonEvent(socket);
        const layout = await jsonRequest<{ sections: Array<{ name: string }>; revision: number }>(
          base,
          "/v1/sidebar-layout/actions",
          { token, body: { type: "create", name: `Shared ${index + 1}` } },
        );
        expect(layout.sections.at(-1)?.name).toBe(`Shared ${index + 1}`);
        await expect(event).resolves.toMatchObject({
          type: "sidebar-layout-changed",
          layout: { revision: index + 1 },
        });
      }

      await expect(jsonRequest(base, "/v1/sidebar-layout", { token: member.sessionToken })).resolves.toMatchObject({
        revision: 3,
        sections: [{ name: "Shared 1" }, { name: "Shared 2" }, { name: "Shared 3" }],
      });
      const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
      now = 1_000;
      getRuntimeSnapshot.mockImplementationOnce(() => ({
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [
          {
            botId: "chief",
            id: "oversized",
            text: "x".repeat(AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT),
            createdAt: "2026-08-29T10:00:00.000Z",
          },
        ],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      }));
      socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      expect((await closed).code).toBe(1011);
    } finally {
      await api.stop();
    }
  });

  it("keeps legacy event clients connected without sending runtime snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-legacy-events-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    const agentEvents = new EventEmitter();
    const api = new TeamApiServer({
      store,
      agents: createAgents({}, agentEvents),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
      "openbot-events",
      `openbot-token.${login.sessionToken}`,
    ]);
    const firstEvent = nextJsonEvent(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      await expect(firstEvent).resolves.toMatchObject({ type: "team-presence" });
      expect(socket.protocol).toBe("openbot-events");
      const supportedEvent = nextJsonEvent(socket);
      agentEvents.emit("event", { type: "runtime-snapshot", snapshot: createAgents().getRuntimeSnapshot() });
      agentEvents.emit("event", { type: "bots-changed", bots: [] });
      await expect(supportedEvent).resolves.toMatchObject({ type: "bots-changed" });
    } finally {
      socket.close();
      await api.stop();
    }
  });

  it("does not expose unexpected internal errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-errors-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const internalError = Object.assign(new Error("EACCES: /Users/private/openbot.db"), { code: "EACCES" });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listBots: () => {
          throw internalError;
        },
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const response = await fetch(`${base}/v1/agents`, {
        headers: { Authorization: `Bearer ${login.sessionToken}` },
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Request failed." });
      expect(errorLog).toHaveBeenCalledWith("Team API request failed:", internalError);

      const invalidLogin = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "wrong password value" }),
      });
      expect(invalidLogin.status).toBe(400);
      await expect(invalidLogin.json()).resolves.toEqual({ error: "The username or password is incorrect." });
    } finally {
      await api.stop();
      errorLog.mockRestore();
    }
  });

  it("bounds and expires unauthenticated rate-limit entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-rate-limit-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    let now = Date.parse("2026-08-22T12:00:00.000Z");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      rateLimitCapacity: 2,
      now: () => now,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;
    const login = (username: string) =>
      fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "wrong password value" }),
      });

    try {
      expect((await login("alice")).status).toBe(400);
      expect((await login("bob")).status).toBe(400);
      expect((await login("carol")).status).toBe(429);

      now += 15 * 60 * 1_000 + 1;
      expect((await login("dave")).status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("rejects WebSocket event frames larger than one KiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-websocket-limit-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
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
      await api.stop();
    }
  });

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
      redeemCentralTicket: async (ticket, serverId) => {
        if (serverId !== store.getIdentity()?.serverId) return null;
        if (ticket === "valid-team-ticket") {
          return {
            id: "alice-account",
            email: "alice@example.com",
            name: "Alice",
            avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
          };
        }
        return ticket === "owner-team-ticket"
          ? {
              id: "owner-account",
              email: "owner@example.com",
              name: "Owner on another Mac",
              avatarUrl: null,
            }
          : null;
      },
      onPresence: (snapshot) => presenceSnapshots.push(snapshot),
      chat,
    });
    const port = await api.start();

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
      await expect(previewResponse.json()).resolves.toEqual({
        role: "member",
        expiresAt: invite.expiresAt,
        emailBound: true,
      });

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

      const usedPreview = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(usedPreview.status).toBe(400);

      const ownerInvite = await store.createInvite("member");
      const ownerResponse = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken: ownerInvite.token,
          accountTicket: "owner-team-ticket",
        }),
      });
      expect(ownerResponse.status).toBe(201);
      const ownerConnection = await ownerResponse.json();
      expect(ownerConnection.member).toMatchObject({
        email: "owner@example.com",
        name: "Owner on another Mac",
        role: "owner",
      });
      expect(store.listMembers()).toHaveLength(2);
      expect(store.authenticate(ownerConnection.sessionToken)?.email).toBe("owner@example.com");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${joined.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), {
          once: true,
        });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({ type: "runtime-snapshot" });
      expect(initialPresence).toMatchObject({
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
      createInvite: async (input) => {
        const created = await store.createInvite(input.role, input.email);
        return {
          id: created.id,
          role: created.role,
          expiresAt: created.expiresAt,
          usedAt: null,
          inviteUrl: `https://openbot.run/join?token=${created.token}`,
          email: created.email,
        };
      },
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const ownerToken = ownerLogin.sessionToken;
      const invite = await jsonRequest<{ id: string; inviteUrl: string }>(base, "/v1/team/invites", {
        token: ownerToken,
        body: { role: "member" },
      });
      const inviteToken = new URL(invite.inviteUrl).searchParams.get("token");
      expect(inviteToken).not.toBeNull();
      const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
        body: {
          inviteToken,
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

  it("supports memory operations through the authenticated team API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-memories-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const memories: BotMemory[] = [];
    const createMemory = vi.fn((input: { botId: string; text: string }) => {
      const memory: BotMemory = {
        id: "memory-1",
        botId: input.botId,
        text: input.text,
        origin: "manual",
        sourceTurnId: null,
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z",
      };
      memories.push(memory);
      return memory;
    });
    const updateMemory = vi.fn((input: { botId: string; memoryId: string; text: string }) => {
      const memory = memories.find((item) => item.id === input.memoryId && item.botId === input.botId);
      if (!memory) throw new Error("Memory not found.");
      memory.text = input.text;
      memory.updatedAt = "2026-08-25T12:01:00.000Z";
      return memory;
    });
    const deleteMemory = vi.fn((input: { botId: string; memoryId: string }) => {
      const index = memories.findIndex((item) => item.id === input.memoryId && item.botId === input.botId);
      if (index >= 0) memories.splice(index, 1);
    });
    const clearMemories = vi.fn((botId: string) => {
      for (let index = memories.length - 1; index >= 0; index -= 1) {
        if (memories[index]?.botId === botId) memories.splice(index, 1);
      }
    });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listMemories: (botId) => memories.filter((memory) => memory.botId === botId),
        createMemory,
        updateMemory,
        deleteMemory,
        clearMemories,
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const token = login.sessionToken;
      await expect(
        jsonRequest<BotMemory>(base, "/v1/agents/chief/memories", {
          token,
          body: { text: "Uses metric units." },
        }),
      ).resolves.toMatchObject({ id: "memory-1", botId: "chief", origin: "manual" });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toHaveLength(1);
      await expect(
        jsonRequest<BotMemory>(base, "/v1/agents/chief/memories/memory-1", {
          method: "PATCH",
          token,
          body: { text: "Uses SI units." },
        }),
      ).resolves.toMatchObject({ text: "Uses SI units." });
      await emptyRequest(base, "/v1/agents/chief/memories/memory-1", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toEqual([]);
      expect(createMemory).toHaveBeenCalledWith({ botId: "chief", text: "Uses metric units." });
      expect(updateMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1", text: "Uses SI units." });
      expect(deleteMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1" });

      await jsonRequest<BotMemory>(base, "/v1/agents/chief/memories", {
        token,
        body: { text: "Clear this memory." },
      });
      await emptyRequest(base, "/v1/agents/chief/memories", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toEqual([]);
      expect(clearMemories).toHaveBeenCalledWith("chief");

      const oversized = await fetch(`${base}/v1/agents/chief/memories`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(INPUT_LIMITS.agentMemoryText + 1) }),
      });
      expect(oversized.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("supports routine operations through the authenticated team API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-routines-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const routines: Routine[] = [];
    const createRoutine = vi.fn((input: Parameters<TestAgents["createRoutine"]>[0]) => {
      const now = "2026-08-25T12:00:00.000Z";
      const routine: Routine = {
        id: "routine-1",
        botId: input.botId,
        name: input.name,
        instruction: input.instruction,
        active: input.active,
        timezone: input.timezone,
        trigger: {
          id: "trigger-1",
          routineId: "routine-1",
          schedule: input.schedule,
          nextRunAt: "2026-08-26T05:00:00.000Z",
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      routines.push(routine);
      return routine;
    });
    const updateRoutine = vi.fn((input: Parameters<TestAgents["updateRoutine"]>[0]) => {
      const routine = routines.find((item) => item.id === input.routineId && item.botId === input.botId);
      if (!routine) throw new Error("Routine not found.");
      if (input.name !== undefined) routine.name = input.name;
      if (input.active !== undefined) routine.active = input.active;
      if (input.schedule !== undefined) routine.trigger.schedule = input.schedule;
      return routine;
    });
    const run: RoutineRun = {
      id: "run-1",
      routineId: "routine-1",
      botId: "chief",
      triggerId: null,
      kind: "manual",
      scheduledFor: "2026-08-25T12:05:00.000Z",
      routineName: "Morning brief",
      instruction: "Prepare the brief.",
      deliveryId: "delivery-1",
      status: "queued",
      error: null,
      createdAt: "2026-08-25T12:05:00.000Z",
      updatedAt: "2026-08-25T12:05:00.000Z",
    };
    const deleteRoutine = vi.fn(async ({ routineId }: { routineId: string }) => {
      const index = routines.findIndex((routine) => routine.id === routineId);
      if (index >= 0) routines.splice(index, 1);
    });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listRoutines: (botId) => routines.filter((routine) => routine.botId === botId),
        createRoutine,
        updateRoutine,
        deleteRoutine,
        testRoutine: vi.fn(async () => run),
        listRoutineRuns: vi.fn(() => [run]),
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const token = login.sessionToken;
      await expect(
        jsonRequest<Routine>(base, "/v1/agents/chief/routines", {
          token,
          body: {
            name: "Morning brief",
            instruction: "Prepare the brief.",
            active: true,
            timezone: "Europe/Warsaw",
            schedule: { kind: "weekdays", time: "07:00" },
          },
        }),
      ).resolves.toMatchObject({ id: "routine-1", botId: "chief" });
      await expect(jsonRequest(base, "/v1/agents/chief/routines", { token })).resolves.toHaveLength(1);
      await expect(
        jsonRequest<Routine>(base, "/v1/agents/chief/routines/routine-1", {
          method: "PATCH",
          token,
          body: { active: false, schedule: { kind: "daily", time: "09:15" } },
        }),
      ).resolves.toMatchObject({ active: false, trigger: { schedule: { kind: "daily", time: "09:15" } } });
      await expect(
        jsonRequest<RoutineRun>(base, "/v1/agents/chief/routines/routine-1/test", { token, body: {} }),
      ).resolves.toMatchObject({ kind: "manual", status: "queued" });
      await expect(jsonRequest(base, "/v1/agents/chief/routines/routine-1/runs?limit=10", { token })).resolves.toEqual([
        run,
      ]);
      await emptyRequest(base, "/v1/agents/chief/routines/routine-1", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/routines", { token })).resolves.toEqual([]);
    } finally {
      await api.stop();
    }
  });

  it("downloads authenticated shared files through the remote API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-shared-file-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const filePath = join(root, "report.csv");
    await writeFile(filePath, "name,value\nOpenBot,1\n");
    const agents = createAgents({
      resolveSharedFile: async (path) => ({
        path: filePath,
        name: path.includes("large") ? "large.csv" : "report.csv",
        size: path.includes("large") ? ATTACHMENT_LIMITS.fileBytes + 1 : 21,
      }),
      resolveWorkspaceFile: async (botId, path) => ({
        path: filePath,
        name: `${botId}-${path.split("/").at(-1)}`,
        size: 21,
      }),
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const response = await fetch(
        `${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/report.csv")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("report.csv");
      expect(await response.text()).toBe("name,value\nOpenBot,1\n");

      const oversized = await fetch(
        `${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/large.csv")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(oversized.status).toBe(413);

      const unauthorized = await fetch(`${base}/v1/shared-files?path=Shared/report.csv`);
      expect(unauthorized.status).toBe(401);

      const workspaceResponse = await fetch(
        `${base}/v1/workspace-files?botId=chief&path=${encodeURIComponent("app/page.tsx")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(workspaceResponse.status).toBe(200);
      expect(workspaceResponse.headers.get("content-disposition")).toContain("chief-page.tsx");
      expect(await workspaceResponse.text()).toBe("name,value\nOpenBot,1\n");

      const unauthorizedWorkspace = await fetch(`${base}/v1/workspace-files?botId=chief&path=app/page.tsx`);
      expect(unauthorizedWorkspace.status).toBe(401);
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
        provider: "codex",
        name: "Chief",
        title: "Lead",
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
    const createBot = vi.fn(
      async (input: CreateBotInput): Promise<BotSummary> => ({
        ...localBots[0],
        id: "trip-planner",
        name: input.name,
        title: "",
        description: input.description,
        avatarSeed: input.avatarSeed,
        avatarHue: input.avatarHue,
      }),
    );
    const agents = createAgents({
      listBots: () => localBots,
      createBot,
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
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const createInput: CreateBotInput = {
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        avatarSeed: "setup:trip",
        avatarHue: 215,
        initialMessage: "Help me plan a trip.",
      };
      await expect(
        jsonRequest(base, "/v1/agents", { token: login.sessionToken, body: createInput }),
      ).resolves.toMatchObject({
        id: "trip-planner",
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        title: "",
      });
      expect(createBot).toHaveBeenCalledWith(createInput);
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

  it("responds to authenticated remote interactive requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-approval-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const approvals: unknown[] = [];
    const failures: unknown[] = [];
    const takeovers: unknown[] = [];
    const prompts: unknown[] = [];
    const agents = createAgents({
      acknowledgeFailedTurn: (botId, turnId) => {
        failures.push({ botId, turnId });
      },
      respondToPrompt: async (input: unknown) => {
        prompts.push(input);
      },
      respondToApproval: async (input: unknown) => {
        approvals.push(input);
      },
      respondToBrowserTakeover: async (input: unknown) => {
        takeovers.push(input);
      },
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
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
      await emptyRequest(base, "/v1/browser-takeovers/respond", {
        token: login.sessionToken,
        body: { requestId: "takeover-17", decision: "complete" },
      });
      expect(takeovers).toEqual([{ requestId: "takeover-17", decision: "complete" }]);
      await emptyRequest(base, "/v1/prompts/respond", {
        token: login.sessionToken,
        body: { requestId: "prompt-17", answers: { scope: ["Small"] } },
      });
      expect(prompts).toEqual([{ requestId: "prompt-17", answers: { scope: ["Small"] } }]);
      await emptyRequest(base, "/v1/agents/chief/failures/acknowledge", {
        token: login.sessionToken,
        body: { turnId: "turn-failed" },
      });
      expect(failures).toEqual([{ botId: "chief", turnId: "turn-failed" }]);

      const oversizedPrompt = await fetch(`${base}/v1/prompts/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "prompt-18",
          answers: {
            first: ["a".repeat(INPUT_LIMITS.promptAnswersTotalText / 2 + 1)],
            second: ["b".repeat(INPUT_LIMITS.promptAnswersTotalText / 2)],
          },
        }),
      });
      expect(oversizedPrompt.status).toBe(400);
      expect(prompts).toHaveLength(1);

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

  it("returns a bounded browser preview to an authenticated client", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-browser-preview-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const capturePreview = vi.fn(async () => ({
      dataUrl: "data:image/jpeg;base64,YWJj",
      width: 960,
      height: 600,
    }));
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser({ capturePreview }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const preview = await jsonRequest<{ dataUrl: string; width: number; height: number }>(
        base,
        "/v1/browser/preview",
        { token: login.sessionToken, body: { tabId: "tab-login" } },
      );

      expect(capturePreview).toHaveBeenCalledWith("tab-login");
      expect(preview).toEqual({ dataUrl: "data:image/jpeg;base64,YWJj", width: 960, height: 600 });
    } finally {
      await api.stop();
    }
  });

  it("requires the WebRTC protocol for legacy Remote Desktop clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-desktop-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const legacy = await fetch(`${base}/v1/host/remote-desktop-access`, {
        headers: { Authorization: `Bearer ${login.sessionToken}` },
      });
      expect(legacy.status).toBe(426);
      await expect(legacy.json()).resolves.toEqual({ error: "Update required.", code: "protocol_mismatch" });

      const unauthorized = await fetch(`${base}/v1/host/remote-desktop-access`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await api.stop();
    }
  });

  it("allows an active member to create remote control and rejects an outsider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-remote-screen-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("member");
    const joined = await store.acceptInvite(invite.token, "alice", "a secure team password");
    const now = "2026-08-20T12:00:00.000Z";
    const createSession = vi.fn(
      async (input: { serverId: string; memberId: string; teamSessionId: string; teamSessionExpiresAt: string }) => ({
        id: "remote-session-1",
        serverId: input.serverId,
        viewerUrl: "https://studio.example/v1/remote-screen/sessions/remote-session-1/viewer",
        viewerGrant: "one-use-viewer-grant",
        displays: [{ id: "primary", label: "Primary display", width: 1920, height: 1080, primary: true }],
        selectedDisplayId: "primary",
        phase: "connecting" as const,
        transport: "unknown" as const,
        errorCode: null,
        message: "Waiting for the WebRTC client…",
        createdAt: now,
        grantExpiresAt: "2026-08-20T12:01:00.000Z",
      }),
    );
    const remoteScreen: NonNullable<TeamApiOptions["remoteScreen"]> = {
      handlesHttp: () => false,
      handleHttp: unimplemented,
      handlesUpgrade: () => false,
      handleUpgrade: unimplemented,
      stop: vi.fn(async () => undefined),
      capabilities: () => ({
        ready: true,
        platform: "darwin" as const,
        unattended: false,
        runtime: "sunshine-moonlight" as const,
        protocolVersion: 2 as const,
        displays: [],
        selectedDisplayId: null,
        activeSessions: 0,
        maxSessions: 4,
      }),
      createSession,
      selectDisplay: vi.fn(async () => undefined),
      closeMemberSession: vi.fn(async () => true),
      revokeTeamSession: vi.fn(async () => undefined),
      revokeMember: vi.fn(async () => undefined),
    };
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      remoteScreen,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const outsider = await fetch(`${base}/v1/remote-screen/sessions`, { method: "POST" });
      expect(outsider.status).toBe(401);
      expect(createSession).not.toHaveBeenCalled();

      const response = await fetch(`${base}/v1/remote-screen/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.sessionToken}` },
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        id: "remote-session-1",
        viewerGrant: "one-use-viewer-grant",
        phase: "connecting",
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: store.getIdentity()?.serverId,
          memberId: joined.member.id,
          teamSessionId: expect.any(String),
          teamSessionExpiresAt: joined.sessionExpiresAt,
        }),
      );

      const owner = await store.login("owner", "correct horse battery");
      const disabled = await fetch(`${base}/v1/team/members/${joined.member.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${owner.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ disabled: true }),
      });
      expect(disabled.status).toBe(200);
      expect(remoteScreen.revokeMember).toHaveBeenCalledWith(joined.member.id);

      const blocked = await fetch(`${base}/v1/remote-screen/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.sessionToken}` },
      });
      expect(blocked.status).toBe(401);
      expect(createSession).toHaveBeenCalledOnce();
    } finally {
      await api.stop();
    }
  });
});

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

function nextJsonEvents(websocket: WebSocket, count: number): Promise<TestRealtimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TestRealtimeEvent[] = [];
    websocket.addEventListener("message", (message) => {
      events.push(decodeTestRealtimeEvent(JSON.parse(String(message.data))));
      if (events.length === count) resolve(events);
    });
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
    ...(value.layout === undefined ? {} : { layout: value.layout }),
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
