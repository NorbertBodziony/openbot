// @vitest-environment node

// The WebSocket side: who receives which realtime event, and what a client on an older protocol
// is sent. This is the half of the server the route modules do not own.

import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { AgentSummary } from "@openbot/contracts/ipc";
import {
  AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
} from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import {
  createAgents,
  createTeamApiFixture,
  jsonRequest,
  nextJsonEvent,
  nextJsonEvents,
  stopTeamApiFixtures,
  type TeamApiAgents,
} from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

describe("TeamApiServer events", () => {
  it("shares sidebar layout mutations with owner, admin, and member clients", async () => {
    const { root, store, start } = await createTeamApiFixture("sidebar-layout", { configure: true });
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
    const getRuntimeSnapshot = vi.fn<TeamApiAgents["getRuntimeSnapshot"]>(() => ({
      agents: [],
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
      listAgents: () => [
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
        } satisfies AgentSummary,
      ],
    });
    let now = 0;
    const { base, port } = await start({
      agents,
      sidebarLayout,
      now: () => now,
    });

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
        agentId: "chief",
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
      latestMessages: [{ agentId: "chief", id: "reply-1", text: "Done", createdAt: "2026-08-29T10:00:00.000Z" }],
    });
    const boundedEvents = nextJsonEvents(socket, 2);
    agentEvents.emit("event", conversation);
    agentEvents.emit("event", {
      type: "turn-completed",
      agentId: "chief",
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
    // Nothing answers the scope message, so the emit below has to be ordered behind it some other
    // way, and a sleep is not that: the client and the server share this event loop, and one
    // macrotask is only usually long enough for the frame to be read. When it is not - a loaded CI
    // runner is enough - the scope is still off when the conversation event is emitted, the event is
    // dropped as out of scope, and the wait below never ends. Typing is answered, and one connection
    // is read in order, so a presence event proves every message sent before it was applied.
    const scopeApplied = nextJsonEvents(socket, 2);
    socket.send(JSON.stringify({ type: "team-typing", botId: "chief", typing: true }));
    socket.send(JSON.stringify({ type: "team-typing", botId: null, typing: false }));
    await scopeApplied;

    const conversationEvent = nextJsonEvent(socket);
    agentEvents.emit("event", conversation);
    await expect(conversationEvent).resolves.toEqual({
      type: "conversation-invalidated",
      botId: "chief",
      revision: 1,
    });
    const queueEvent = nextJsonEvent(socket);
    agentEvents.emit("event", { type: "queue-changed", snapshot: { agentId: "chief", deliveries: [] } });
    await expect(queueEvent).resolves.toEqual({ type: "queue-invalidated", botId: "chief" });

    const eventAfterUnsupportedActivity = nextJsonEvent(socket);
    agentEvents.emit("event", {
      type: "turn-progress",
      agentId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      detail: "Searching for current information…",
    });
    agentEvents.emit("event", { type: "agents-changed", agents: [] });
    await expect(eventAfterUnsupportedActivity).resolves.toMatchObject({ type: "bots-changed" });

    const eventsAfterOversizedConversation = nextJsonEvents(socket, 2);
    agentEvents.emit("event", {
      ...conversation,
      snapshot: {
        ...conversation.snapshot,
        messages: [{ ...conversation.snapshot.messages[0], text: "x".repeat(1024 * 1024) }],
      },
    });
    agentEvents.emit("event", { type: "agents-changed", agents: [] });
    await expect(eventsAfterOversizedConversation).resolves.toEqual([
      expect.objectContaining({ type: "conversation-invalidated" }),
      expect.objectContaining({ type: "bots-changed" }),
    ]);

    const refreshedSnapshot = nextJsonEvent(socket);
    socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
    await expect(refreshedSnapshot).resolves.toMatchObject({ type: "runtime-snapshot" });
    for (let index = 0; index < 20; index += 1) {
      socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
    }
    await vi.waitFor(() => expect(getRuntimeSnapshot).toHaveBeenCalledTimes(3));

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
    // Three request/response round-trips have passed through the same socket
    // since the burst, so the coalescer provably never woke for the other 19.
    expect(getRuntimeSnapshot).toHaveBeenCalledTimes(3);

    await expect(jsonRequest(base, "/v1/sidebar-layout", { token: member.sessionToken })).resolves.toMatchObject({
      revision: 3,
      sections: [{ name: "Shared 1" }, { name: "Shared 2" }, { name: "Shared 3" }],
    });
    const firstSocketClosed = new Promise<CloseEvent>((resolve) =>
      socket.addEventListener("close", resolve, { once: true }),
    );
    socket.close();
    await firstSocketClosed;
    const oversizedSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
      "openbot-events-v2",
      `openbot-token.${member.sessionToken}`,
    ]);
    const oversizedInitialEvents = nextJsonEvents(oversizedSocket, 2);
    await new Promise<void>((resolve, reject) => {
      oversizedSocket.addEventListener("open", () => resolve(), { once: true });
      oversizedSocket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
    });
    await oversizedInitialEvents;
    const closed = new Promise<CloseEvent>((resolve) =>
      oversizedSocket.addEventListener("close", resolve, { once: true }),
    );
    now = 1_000;
    getRuntimeSnapshot.mockImplementation(() => ({
      agents: [],
      activeTurns: [],
      work: [],
      latestMessages: [
        {
          agentId: "chief",
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
    oversizedSocket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
    expect((await closed).code).toBe(1011);
  }, 30_000);

  it("keeps legacy event clients connected without sending runtime snapshots", async () => {
    const { store, start } = await createTeamApiFixture("legacy-events", { configure: true });
    const login = await store.login("owner", "correct horse battery");
    const agentEvents = new EventEmitter();
    const { port } = await start({
      agents: createAgents({}, agentEvents),
    });
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
      agentEvents.emit("event", { type: "agents-changed", agents: [] });
      await expect(supportedEvent).resolves.toMatchObject({ type: "bots-changed" });

      const conversationEvent = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "conversation",
        snapshot: {
          agentId: "chief",
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 2,
          messages: [
            {
              id: "reply-1",
              author: "assistant",
              text: "Done",
              createdAt: "2026-08-29T10:00:00.000Z",
              status: "completed",
            },
            {
              id: "routine-event-1",
              author: "system",
              source: "system",
              text: "Morning brief",
              createdAt: "2026-08-29T10:01:00.000Z",
              status: "completed",
              itemType: routineConversationEventItemType("created", "routine-1"),
            },
            {
              id: "routine-run-event-1",
              author: "system",
              source: "system",
              text: "Morning brief",
              createdAt: "2026-08-29T10:02:00.000Z",
              status: "completed",
              itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
            },
            {
              id: "hosted-site-event-1",
              author: "system",
              source: "system",
              text: hostedSiteConversationEventText({
                siteId: null,
                title: "Launch page",
                hostname: null,
                url: null,
              }),
              createdAt: "2026-08-29T10:03:00.000Z",
              status: "completed",
              itemType: hostedSiteConversationEventItemType("publish", "running", "operation-1"),
            },
          ],
        },
      });
      await expect(conversationEvent).resolves.toMatchObject({
        type: "conversation",
        snapshot: { messages: [expect.objectContaining({ id: "reply-1" })] },
      });
    } finally {
      socket.close();
    }
  });
});
