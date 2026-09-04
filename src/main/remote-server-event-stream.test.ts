// @vitest-environment node

// The live event channel: which subprotocol is offered, what the client says once the socket opens,
// how an invalidation becomes a refetch, and when a dead connection comes back. Everything here is a
// consequence of `remote-server-event-stream.ts` and none of it is a consequence of HTTP routing,
// which is why it is no longer in `remote-server-manager.test.ts`.
//
// This is the only part of the family that owns a clock, so it is also the only one that uses fake
// timers, and only where a reconnect delay is the thing under test.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteManager,
  deferredRoute,
  stopRemoteFixtures,
  storedHttpsServer,
  stubEventSockets,
  stubTeamFetch,
  waitForServer,
} from "./remote-server-test-harness";

// One backoff step plus its jitter ceiling.
const REMOTE_EVENT_RECONNECT_TEST_MS = 1_250;

const agentScope = (includeConversations: boolean) => ({ type: "agent-event-scope", includeConversations });

const conversationPage = (revision: number) =>
  Response.json({
    botId: "chief",
    threadId: "thread-chief",
    activeTurnId: null,
    revision,
    messages: [
      {
        id: `reply-${revision}`,
        author: "assistant",
        text: "Fresh remote reply",
        createdAt: "2026-08-30T02:00:00.000Z",
        status: "completed",
      },
    ],
    references: {},
    pageInfo: { hasOlder: true, olderCursor: "older" },
  });

afterEach(async () => {
  await stopRemoteFixtures();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote event connections", () => {
  it("opens a socket only for the host that still exists after negotiation", async () => {
    const removed = deferredRoute();
    const kept = deferredRoute();
    const handshake = () =>
      Response.json({ appVersion: "0.3.0", protocol: { minimum: 1, maximum: 1 }, capabilities: [] });
    stubTeamFetch({
      fallback: (call) => (call.url.hostname.startsWith("removed") ? removed : kept).handler(call),
    });
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer("removed-host"), storedHttpsServer("kept-host")],
      appVersion: "0.4.0",
    });

    fixture.manager.startEventConnections();
    await removed.arrived;
    await kept.arrived;
    await fixture.manager.remove("removed-host");
    // Answering the removed host first puts its connection attempt ahead of the surviving one, so a
    // socket for the survivor is proof the removed host already reached its own decision.
    removed.resolve(handshake());
    kept.resolve(handshake());

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toContain("kept-host");
  });

  it("scopes conversation events to the selected host without reconnecting either", async () => {
    stubTeamFetch({});
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer("server-1"), storedHttpsServer("server-2")],
    });

    fixture.manager.startEventConnections();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(sockets[0]?.sent).toContainEqual(agentScope(true)));
    expect(sockets[1]?.sent).toContainEqual(agentScope(false));

    await fixture.manager.select("server-2");

    expect(sockets).toHaveLength(2);
    expect(sockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
    expect(sockets[0]?.sent.at(-1)).toEqual(agentScope(false));
    expect(sockets[1]?.sent.at(-1)).toEqual(agentScope(true));
  });

  it("answers repeated invalidations with one refetch and retries a refetch that failed", async () => {
    const conversationRequests: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
    let rejectQueue: ((error: Error) => void) | undefined;
    const stub = stubTeamFetch({
      routes: {
        "/v1/agents/chief/queue": async () => {
          if (rejectQueue) return Response.json({ botId: "chief", deliveries: [] });
          return await new Promise<Response>((_resolve, reject) => {
            rejectQueue = reject;
          });
        },
        "/v1/agents/chief/conversation-page": async () =>
          await new Promise<Response>((resolve, reject) => {
            conversationRequests.push({ resolve, reject });
          }),
      },
    });
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("refetch")] });
    const agentEvent = vi.fn();
    fixture.manager.on("agent", agentEvent);

    fixture.manager.startEventConnections();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];

    socket?.emit({ type: "conversation-invalidated", botId: "chief", revision: 1 });
    await vi.waitFor(() => expect(conversationRequests).toHaveLength(1));
    socket?.emit({ type: "conversation-invalidated", botId: "chief", revision: 2 });
    conversationRequests[0]?.resolve(conversationPage(2));
    await vi.waitFor(() =>
      expect(agentEvent).toHaveBeenCalledWith(
        "refetch",
        expect.objectContaining({ type: "conversation-page", page: expect.objectContaining({ revision: 2 }) }),
      ),
    );
    // The second invalidation arrived while the first refetch was in flight and its answer was
    // already newer, so it costs no request.
    expect(stub.requests("/v1/agents/chief/conversation-page")).toHaveLength(1);

    socket?.emit({ type: "conversation-invalidated", botId: "chief", revision: 3 });
    await vi.waitFor(() => expect(conversationRequests).toHaveLength(2));
    socket?.emit({ type: "conversation-invalidated", botId: "chief", revision: 4 });
    conversationRequests[1]?.reject(new Error("Refresh failed"));
    await vi.waitFor(() => expect(conversationRequests).toHaveLength(3));
    conversationRequests[2]?.resolve(conversationPage(4));
    await vi.waitFor(() =>
      expect(agentEvent).toHaveBeenCalledWith(
        "refetch",
        expect.objectContaining({ type: "conversation-page", page: expect.objectContaining({ revision: 4 }) }),
      ),
    );

    socket?.emit({ type: "queue-invalidated", botId: "chief" });
    await vi.waitFor(() => expect(rejectQueue).toBeDefined());
    socket?.emit({ type: "queue-invalidated", botId: "chief" });
    rejectQueue?.(new Error("Refresh failed"));
    await vi.waitFor(() =>
      expect(agentEvent).toHaveBeenCalledWith(
        "refetch",
        expect.objectContaining({ type: "queue-changed", snapshot: { botId: "chief", deliveries: [] } }),
      ),
    );
    expect(stub.requests("/v1/agents/chief/queue")).toHaveLength(2);
  });

  it("reconnects one host without disturbing the other", async () => {
    vi.useFakeTimers();
    stubTeamFetch({});
    const { sockets } = stubEventSockets();
    const fixture = await createRemoteManager({
      servers: [storedHttpsServer("server-1"), storedHttpsServer("server-2")],
    });
    const agentEvent = vi.fn();
    fixture.manager.on("agent", agentEvent);

    fixture.manager.startEventConnections();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(REMOTE_EVENT_RECONNECT_TEST_MS);
    expect(sockets).toHaveLength(3);
    expect(sockets[2]?.url).toContain("server-1.trycloudflare.com");

    sockets[2]?.emit({
      type: "turn-started",
      botId: "research",
      threadId: "thread-research",
      turnId: "turn-research",
    });
    expect(agentEvent).toHaveBeenCalledWith(
      "server-1",
      expect.objectContaining({ type: "turn-started", botId: "research" }),
    );

    fixture.manager.refreshRuntimeSnapshots();
    expect(sockets).toHaveLength(3);
    expect(sockets[1]?.sent).toContainEqual({ type: "runtime-snapshot-request" });
    expect(sockets[2]?.sent).toContainEqual({ type: "runtime-snapshot-request" });
    // The closed socket is gone from the registry, so it is not asked for a snapshot.
    expect(sockets[0]?.sent).not.toContainEqual({ type: "runtime-snapshot-request" });

    sockets[2]?.dispatchEvent(new MessageEvent("message", { data: "x".repeat(1024 * 1024 + 1) }));
    expect(sockets[2]?.close).toHaveBeenCalledWith(1009, "Event payload is too large");
  });

  it("backs off short-lived event connections", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    stubTeamFetch({});
    const { sockets } = stubEventSockets({
      connect: (socket) => {
        socket.dispatchEvent(new Event("open"));
        socket.emit({
          type: "team-presence",
          snapshot: { serverId: "backoff", members: [], updatedAt: "2026-08-30T02:00:00.000Z" },
        });
        socket.close();
      },
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("backoff")] });

    fixture.manager.startEventConnections();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await waitForServer(fixture, { state: "offline" });
    // A snapshot request never revives a connection that is waiting out its backoff.
    fixture.manager.refreshRuntimeSnapshots();
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(3));
    expect((sockets[1]?.openedAt ?? 0) - (sockets[0]?.openedAt ?? 0)).toBeGreaterThanOrEqual(1_000);
    expect((sockets[2]?.openedAt ?? 0) - (sockets[1]?.openedAt ?? 0)).toBeGreaterThanOrEqual(2_000);
  });

  it("pauses event reconnects after credentials are rejected", async () => {
    vi.useFakeTimers();
    stubTeamFetch({
      fallback: () =>
        new Response(JSON.stringify({ error: "Authentication required." }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const { sockets } = stubEventSockets({
      connect: (socket) => socket.dispatchEvent(new Event("error")),
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("auth-paused")] });

    fixture.manager.startEventConnections();
    await waitForServer(fixture, { state: "error" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    fixture.manager.refreshRuntimeSnapshots();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
  });

  it("buffers events while fallback state is loaded", async () => {
    const bot = {
      id: "chief",
      provider: "codex",
      name: "Chief",
      title: "Chief of staff",
      description: "",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: "thread-chief",
      workspacePath: "/OpenBot/Bots/chief",
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: "chief",
      avatarHue: null,
      avatarUrl: null,
    };
    const liveReply = {
      id: "live-reply",
      author: "assistant",
      text: "New live reply",
      createdAt: "2026-08-29T10:01:00.000Z",
      status: "completed",
    };
    const conversation = (revision: number, messages: unknown[]) =>
      Response.json({
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: "turn-1",
        revision,
        messages,
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      });
    const initialConversation = deferredRoute();
    stubTeamFetch({
      routes: {
        "/v1/agents": () => Response.json([bot]),
        "/v1/agents/chief/conversation-page": initialConversation.handler,
      },
      fallback: () => Response.json({ botId: bot.id, deliveries: [] }),
    });
    // The v1 subprotocol has no runtime snapshot, so the client loads the agent state itself and has
    // to hold live events until it lands.
    const { sockets } = stubEventSockets({ protocol: "openbot-events" });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("fallback")] });
    const agentEvent = vi.fn();
    fixture.manager.on("agent", agentEvent);

    fixture.manager.startEventConnections();
    await initialConversation.arrived;
    sockets[0]?.emit({
      type: "conversation",
      snapshot: {
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: null,
        revision: 2,
        messages: [liveReply],
      },
    });
    expect(agentEvent).not.toHaveBeenCalledWith(
      "fallback",
      expect.objectContaining({ type: "conversation", snapshot: expect.objectContaining({ revision: 2 }) }),
    );

    initialConversation.resolve(conversation(2, [liveReply]));
    await vi.waitFor(() =>
      expect(agentEvent).toHaveBeenCalledWith("fallback", expect.objectContaining({ type: "conversation" }), true),
    );
    expect(
      agentEvent.mock.calls
        .map(([, event]) => event)
        .filter((event) => event.type === "conversation")
        .map((event) => event.snapshot.revision),
    ).toEqual([2, 2]);
  });
});
