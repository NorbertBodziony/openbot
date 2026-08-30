// @vitest-environment node

import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeBrowserPreview,
  decodeBrowserTab,
  isValidRemoteApiUrl,
  RemoteServerManager,
  remoteAttachmentPreviewUrl,
} from "./remote-server-manager";
import { fingerprint } from "./team-store";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("remote browser responses", () => {
  it("decodes an opened browser tab", () => {
    expect(
      decodeBrowserTab({
        id: "tab-1",
        title: "Example",
        url: "https://example.com/",
        loading: false,
        ownerThreadId: "thread-1",
        ownerBotId: "bot-1",
      }),
    ).toMatchObject({ id: "tab-1", url: "https://example.com/" });
    expect(() => decodeBrowserTab(undefined)).toThrowError("Invalid remote browser tab.");
  });

  it("accepts only bounded JPEG browser previews", () => {
    expect(
      decodeBrowserPreview({
        dataUrl: "data:image/jpeg;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toMatchObject({ width: 960, height: 600 });
    expect(() =>
      decodeBrowserPreview({
        dataUrl: "data:image/png;base64,YWJj",
        width: 960,
        height: 600,
      }),
    ).toThrowError("Invalid remote browser preview.");
  });
});

describe("remote server links", () => {
  it("accepts only supported root HTTPS tunnel URLs", () => {
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.openbot.run/")).toBe(true);
    expect(isValidRemoteApiUrl("https://studio-mac-k7m4q2pz-host.teams.openbot.run/")).toBe(false);
    expect(isValidRemoteApiUrl("http://team-host.trycloudflare.com/")).toBe(false);
    expect(isValidRemoteApiUrl("https://team-host.trycloudflare.com/path")).toBe(false);
    expect(isValidRemoteApiUrl("https://example.com/")).toBe(false);
  });

  it("parses an OpenBot invitation", () => {
    const url = new URL("openbot://join");
    url.searchParams.set("api", "https://team-host.trycloudflare.com/");
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseInviteUrl(url.toString())).toMatchObject({
      apiUrl: "https://team-host.trycloudflare.com/",
      serverId: "00000000-0000-4000-8000-000000000000",
      fingerprint: "a".repeat(43),
      token: "b".repeat(43),
    });
  });

  it("parses a stable openbot.run invitation", () => {
    const apiUrl = "https://studio-mac-k7m4q2pz-host.openbot.run/";
    const url = new URL("openbot://join");
    url.searchParams.set("api", apiUrl);
    url.searchParams.set("server", "00000000-0000-4000-8000-000000000000");
    url.searchParams.set("fingerprint", "a".repeat(43));
    url.searchParams.set("invite", "b".repeat(43));
    expect(parseInviteUrl(url.toString())).toMatchObject({ apiUrl });
  });

  it("rejects a link with a non-Cloudflare API URL", () => {
    expect(() => parseInviteUrl("openbot://join?api=https%3A%2F%2Fevil.example&server=x")).toThrow("invalid");
  });

  it("creates token-free preview URLs", () => {
    const preview = remoteAttachmentPreviewUrl("00000000-0000-4000-8000-000000000000", "draft 1");
    expect(preview).toBe("openbot-remote-attachment://00000000-0000-4000-8000-000000000000/draft%201");
    expect(preview).not.toContain("token");
  });
});

describe("remote server order", () => {
  it("recovers the persistence queue after a write failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-persistence-"));
    const unavailableDirectory = `${directory}-unavailable`;
    const statePath = join(directory, "servers.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: "server-1",
        servers: [
          {
            id: "server-1",
            name: "Remote",
            apiUrl: "https://server-1.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: "token",
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );
    const manager = new RemoteServerManager(
      statePath,
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      {
        createTeamAuthTicket: async () => "ticket",
        getEmail: () => "person@example.com",
      },
    );

    try {
      await manager.initialize();
      await rename(directory, unavailableDirectory);
      await expect(manager.select("server-1")).rejects.toThrow();
      await rename(unavailableDirectory, directory);

      await expect(manager.select("local")).resolves.toBeDefined();
      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.activeServerId).toBe("local");
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
      await rm(unavailableDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the local server first and persists the remote server order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-server-order-"));
    const statePath = join(directory, "servers.json");
    const storedServer = (id: string) => ({
      id,
      name: id,
      apiUrl: `https://${id}.trycloudflare.com/`,
      fingerprint: "fingerprint",
      username: "person@example.com",
      encryptedToken: "token",
      role: "member" as const,
    });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        activeServerId: "server-1",
        servers: [storedServer("server-1"), storedServer("server-2")],
      }),
    );

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "ticket",
          getEmail: () => "person@example.com",
        },
      );
      await manager.initialize();

      const reordered = await manager.reorder(["server-2", "server-1"]);
      expect(reordered.map((server) => server.id)).toEqual(["local", "server-2", "server-1"]);
      expect(reordered.find((server) => server.id === "server-1")?.active).toBe(true);

      const persisted = JSON.parse(await readFile(statePath, "utf8"));
      expect(persisted.servers.map((server: { id: string }) => server.id)).toEqual(["server-2", "server-1"]);
      await expect(manager.reorder(["server-1"])).rejects.toThrow("incomplete");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("downloads shared and workspace files with authenticated requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-shared-download-"));
    const statePath = join(directory, "servers.json");
    const serverId = "remote-shared";
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: serverId,
        servers: [
          {
            id: serverId,
            name: "Remote",
            apiUrl: "https://remote-shared.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: Buffer.from("session-token").toString("base64"),
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );

    const bytes = new TextEncoder().encode("name,value\nOpenBot,1\n");
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(init?.headers).toEqual({ Authorization: "Bearer session-token" });
      if (url.pathname === "/v1/shared-files") {
        expect(url.searchParams.get("path")).toBe("~/OpenBot/Shared/report.csv");
      } else {
        expect(url.pathname).toBe("/v1/workspace-files");
        expect(url.searchParams.get("botId")).toBe("chief");
        expect(url.searchParams.get("path")).toBe("app/page.tsx");
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Disposition": `attachment; filename*=UTF-8''${url.pathname.includes("workspace") ? "page.tsx" : "report.csv"}`,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "ticket",
          getEmail: () => "person@example.com",
        },
      );
      await manager.initialize();

      await expect(manager.downloadSharedFile("~/OpenBot/Shared/report.csv", serverId)).resolves.toEqual({
        bytes,
        name: "report.csv",
      });
      await expect(manager.downloadWorkspaceFile("chief", "app/page.tsx", serverId)).resolves.toEqual({
        bytes,
        name: "page.tsx",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      manager.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote event connections", () => {
  it("keeps every configured host connected across selection and reconnects independently", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-events-"));
    const statePath = join(directory, "servers.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: "server-1",
        servers: ["server-1", "server-2"].map((id) => ({
          id,
          name: id,
          apiUrl: `https://${id}.trycloudflare.com/`,
          fingerprint: "fingerprint",
          username: "person@example.com",
          encryptedToken: Buffer.from(`token-${id}`).toString("base64"),
          remoteDesktopAvailable: false,
          role: "member",
        })),
      }),
    );
    const sockets: TestEventSocket[] = [];
    class TestEventSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly close = vi.fn(() => this.dispatchEvent(new Event("close")));
      readonly protocol: string;
      readonly readyState = TestEventSocket.OPEN;
      readonly send = vi.fn();

      constructor(
        readonly url: string | URL,
        protocols: string[] = [],
      ) {
        super();
        this.protocol = protocols[0] ?? "";
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
    }
    vi.stubGlobal("WebSocket", TestEventSocket);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/v1/agents/chief/conversation-page");
      return new Response(
        JSON.stringify({
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 2,
          messages: [
            {
              id: "reply-2",
              author: "assistant",
              text: "Fresh remote reply",
              createdAt: "2026-08-30T02:00:00.000Z",
              status: "completed",
            },
          ],
          references: {},
          pageInfo: { hasOlder: true, olderCursor: "older" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new RemoteServerManager(
      statePath,
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      {
        createTeamAuthTicket: async () => "ticket",
        getEmail: () => "person@example.com",
      },
    );
    const agentEvent = vi.fn();
    manager.on("agent", agentEvent);

    try {
      await manager.initialize();
      manager.startEventConnections();
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      await vi.waitFor(() =>
        expect(sockets[0]?.send).toHaveBeenCalledWith(
          JSON.stringify({ type: "agent-event-scope", includeConversations: true }),
        ),
      );
      expect(sockets[1]?.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "agent-event-scope", includeConversations: false }),
      );

      await manager.select("server-2");
      expect(sockets).toHaveLength(2);
      expect(sockets.every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
      expect(sockets[0]?.send).toHaveBeenLastCalledWith(
        JSON.stringify({ type: "agent-event-scope", includeConversations: false }),
      );
      expect(sockets[1]?.send).toHaveBeenLastCalledWith(
        JSON.stringify({ type: "agent-event-scope", includeConversations: true }),
      );
      sockets[1]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "conversation-invalidated", botId: "chief", revision: 2 }),
        }),
      );
      await vi.waitFor(() =>
        expect(agentEvent).toHaveBeenCalledWith(
          "server-2",
          expect.objectContaining({ type: "conversation-page", page: expect.objectContaining({ revision: 2 }) }),
        ),
      );

      sockets[0]?.close();
      await vi.advanceTimersByTimeAsync(REMOTE_EVENT_RECONNECT_TEST_MS);
      expect(sockets).toHaveLength(3);
      expect(String(sockets[2]?.url)).toContain("server-1.trycloudflare.com");

      sockets[2]?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "turn-started",
            botId: "research",
            threadId: "thread-research",
            turnId: "turn-research",
          }),
        }),
      );
      expect(agentEvent).toHaveBeenCalledWith(
        "server-1",
        expect.objectContaining({ type: "turn-started", botId: "research" }),
      );

      manager.refreshRuntimeSnapshots();
      expect(sockets).toHaveLength(3);
      expect(sockets[1]?.send).toHaveBeenCalledWith(JSON.stringify({ type: "runtime-snapshot-request" }));
      expect(sockets[2]?.send).toHaveBeenCalledWith(JSON.stringify({ type: "runtime-snapshot-request" }));

      sockets[2]?.dispatchEvent(new MessageEvent("message", { data: "x".repeat(1024 * 1024 + 1) }));
      expect(sockets[2]?.close).toHaveBeenCalledWith(1009, "Event payload is too large");
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("backs off short-lived event connections", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-backoff-"));
    const statePath = join(directory, "servers.json");
    await writeRemoteEventState(statePath, "backoff");
    const sockets: TestShortLivedEventSocket[] = [];
    const connectionTimes: number[] = [];
    class TestShortLivedEventSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly close = vi.fn(() => this.dispatchEvent(new Event("close")));
      readonly protocol = "openbot-events-v2";
      readonly readyState = TestShortLivedEventSocket.OPEN;
      readonly send = vi.fn();

      constructor() {
        super();
        sockets.push(this);
        connectionTimes.push(Date.now());
        queueMicrotask(() => {
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "team-presence",
                snapshot: { serverId: "backoff", members: [], updatedAt: "2026-08-30T02:00:00.000Z" },
              }),
            }),
          );
          this.dispatchEvent(new Event("close"));
        });
      }
    }
    vi.stubGlobal("WebSocket", TestShortLivedEventSocket);
    const manager = remoteEventManager(statePath);

    try {
      await manager.initialize();
      manager.startEventConnections();
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      await vi.waitFor(() => expect(manager.list().find((server) => server.id === "backoff")?.state).toBe("offline"));
      manager.refreshRuntimeSnapshots();
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(sockets).toHaveLength(3));
      expect(connectionTimes[1] - connectionTimes[0]).toBeGreaterThanOrEqual(1_000);
      expect(connectionTimes[2] - connectionTimes[1]).toBeGreaterThanOrEqual(2_000);
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pauses event reconnects after credentials are rejected", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-auth-pause-"));
    const statePath = join(directory, "servers.json");
    await writeRemoteEventState(statePath, "auth-paused");
    const sockets: EventTarget[] = [];
    class TestRejectedEventSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly close = vi.fn();
      readonly protocol = "";
      readonly readyState = 0;
      readonly send = vi.fn();

      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
      }
    }
    vi.stubGlobal("WebSocket", TestRejectedEventSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Authentication required." }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const manager = remoteEventManager(statePath);

    try {
      await manager.initialize();
      manager.startEventConnections();
      await vi.waitFor(() => expect(manager.list().find((server) => server.id === "auth-paused")?.state).toBe("error"));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      manager.refreshRuntimeSnapshots();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to explicit state reads when an older host selects the legacy protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-legacy-remote-events-"));
    const statePath = join(directory, "servers.json");
    await writeFile(
      statePath,
      JSON.stringify({
        version: 2,
        activeServerId: "legacy",
        servers: [
          {
            id: "legacy",
            name: "Legacy",
            apiUrl: "https://legacy.trycloudflare.com/",
            fingerprint: "fingerprint",
            username: "person@example.com",
            encryptedToken: Buffer.from("token-legacy").toString("base64"),
            remoteDesktopAvailable: false,
            role: "member",
          },
        ],
      }),
    );
    const bot = {
      id: "research",
      name: "Research",
      title: "Researcher",
      description: "Researches topics.",
      notifications: true,
      provider: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: "thread-research",
      workspacePath: "/workspace/research",
      preview: "Ready",
      updatedAt: "2026-08-29T10:00:00.000Z",
      avatarSeed: "research",
      avatarHue: null,
      avatarUrl: null,
    };
    let deferConversation = false;
    let resolveConversation: ((response: Response) => void) | undefined;
    const conversationResponse = () =>
      Response.json({
        botId: bot.id,
        threadId: bot.threadId,
        activeTurnId: "turn-1",
        revision: 1,
        messages: [],
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/v1/agents") return Response.json([bot]);
        if (path.endsWith("/conversation-page")) {
          if (deferConversation) {
            return new Promise<Response>((resolve) => {
              resolveConversation = resolve;
            });
          }
          return conversationResponse();
        }
        return Response.json({ botId: bot.id, deliveries: [] });
      }),
    );
    let legacySocket: LegacyEventSocket | undefined;
    class LegacyEventSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly protocol = "openbot-events";
      readonly readyState = LegacyEventSocket.OPEN;
      readonly send = vi.fn();
      readonly close = vi.fn(() => this.dispatchEvent(new Event("close")));

      constructor() {
        super();
        legacySocket = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
    }
    vi.stubGlobal("WebSocket", LegacyEventSocket);
    const manager = new RemoteServerManager(
      statePath,
      {
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      {
        createTeamAuthTicket: async () => "ticket",
        getEmail: () => "person@example.com",
      },
    );
    const agentEvent = vi.fn();
    manager.on("agent", agentEvent);

    try {
      await manager.initialize();
      manager.startEventConnections();
      await vi.waitFor(() => {
        expect(agentEvent).toHaveBeenCalledWith("legacy", expect.objectContaining({ type: "bots-changed" }));
        expect(agentEvent).toHaveBeenCalledWith("legacy", expect.objectContaining({ type: "conversation" }));
        expect(agentEvent).toHaveBeenCalledWith("legacy", expect.objectContaining({ type: "queue-changed" }));
      });

      deferConversation = true;
      manager.refreshRuntimeSnapshots();
      await vi.waitFor(() => expect(resolveConversation).toBeTypeOf("function"));
      legacySocket?.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "conversation",
            snapshot: {
              botId: bot.id,
              threadId: bot.threadId,
              activeTurnId: null,
              revision: 2,
              messages: [
                {
                  id: "live-reply",
                  author: "assistant",
                  text: "New live reply",
                  createdAt: "2026-08-29T10:01:00.000Z",
                  status: "completed",
                },
              ],
            },
          }),
        }),
      );
      await vi.waitFor(() =>
        expect(agentEvent).toHaveBeenCalledWith(
          "legacy",
          expect.objectContaining({ type: "conversation", snapshot: expect.objectContaining({ revision: 2 }) }),
        ),
      );
      resolveConversation?.(conversationResponse());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        agentEvent.mock.calls
          .map(([, event]) => event)
          .filter((event) => event.type === "conversation")
          .map((event) => event.snapshot.revision),
      ).toEqual([1, 2]);
    } finally {
      manager.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const REMOTE_EVENT_RECONNECT_TEST_MS = 1_250;

async function writeRemoteEventState(path: string, serverId: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      activeServerId: serverId,
      servers: [
        {
          id: serverId,
          name: serverId,
          apiUrl: `https://${serverId}.trycloudflare.com/`,
          fingerprint: "fingerprint",
          username: "person@example.com",
          encryptedToken: Buffer.from(`token-${serverId}`).toString("base64"),
          remoteDesktopAvailable: false,
          role: "member",
        },
      ],
    }),
  );
}

function remoteEventManager(statePath: string): RemoteServerManager {
  return new RemoteServerManager(
    statePath,
    {
      encrypt: (value) => Buffer.from(value),
      decrypt: (value) => value.toString(),
    },
    {
      createTeamAuthTicket: async () => "ticket",
      getEmail: () => "person@example.com",
    },
  );
}

describe("remote control capability discovery", () => {
  it("joins a server when remote control is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-remote-capability-"));
    const statePath = join(directory, "servers.json");
    const serverId = "00000000-0000-4000-8000-000000000000";
    const apiUrl = "https://remote-capability.trycloudflare.com/";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const expectedFingerprint = fingerprint(publicKeyPem);
    const inviteUrl = new URL("openbot://join");
    inviteUrl.searchParams.set("api", apiUrl);
    inviteUrl.searchParams.set("server", serverId);
    inviteUrl.searchParams.set("fingerprint", expectedFingerprint);
    inviteUrl.searchParams.set("invite", "b".repeat(43));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const pathname = url.pathname.replace(/^\/+/, "/");
        if (pathname === "/v1/identity") {
          const challenge = url.searchParams.get("challenge");
          if (!challenge) throw new Error("The identity challenge is missing.");
          return Response.json({
            serverId,
            publicKey: publicKeyPem,
            serverName: "Capability Host",
            fingerprint: expectedFingerprint,
            challenge,
            signature: sign(null, Buffer.from(challenge), privateKey).toString("base64url"),
            logoVersion: null,
          });
        }
        if (pathname === "/v1/join/account") {
          return Response.json({ member: { role: "member" }, sessionToken: "session-token" });
        }
        if (pathname === "/v1/remote-screen/capabilities") {
          return Response.json({ error: "Remote control is unavailable.", code: "host_unavailable" }, { status: 503 });
        }
        throw new Error(`Unexpected request: ${pathname}`);
      }),
    );

    class ClosedWebSocket extends EventTarget {
      close(): void {
        this.dispatchEvent(new Event("close"));
      }
    }
    vi.stubGlobal("WebSocket", ClosedWebSocket);

    try {
      const manager = new RemoteServerManager(
        statePath,
        {
          encrypt: (value) => Buffer.from(value),
          decrypt: (value) => value.toString(),
        },
        {
          createTeamAuthTicket: async () => "account-ticket",
          getEmail: () => "member@example.com",
        },
      );
      await manager.initialize();

      await expect(manager.join({ inviteUrl: inviteUrl.toString() })).resolves.toMatchObject({
        id: serverId,
        remoteDesktopAvailable: false,
        state: "online",
      });
      manager.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
