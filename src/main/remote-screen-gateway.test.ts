import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Ws from "ws";
import { z } from "zod";
import { RemoteScreenGateway, type RemoteScreenRuntime } from "./remote-screen-gateway";

const displays = [
  { id: "main", label: "Main", width: 1920, height: 1080, primary: true },
  { id: "second", label: "Second", width: 1440, height: 900, primary: false },
];
const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));
const runtimes: FakeRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.stop()));
  runtimes.length = 0;
});

describe("RemoteScreenGateway", () => {
  it("issues and consumes a one-time 60 second viewer grant", async () => {
    const gateway = createGateway();
    const { origin, close } = await serveGateway(gateway);
    const session = await createSession(gateway, origin);
    const viewer = await fetch(`${session.viewerUrl}#${session.viewerGrant}`);
    expect(viewer.status).toBe(200);
    expect(await viewer.text()).toContain("Moonlight");

    const authorize = `${origin}/v1/remote-screen/sessions/${session.id}/authorize`;
    const first = await fetch(authorize, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: session.viewerGrant }),
    });
    expect(first.status).toBe(204);
    expect(first.headers.get("set-cookie")).toContain("openbotRemoteViewer=");
    const viewerCookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
    for (const blockedPath of ["admin.html", "index.html", "api/host/stream"]) {
      const blocked = await fetch(`${origin}/v1/remote-screen/sessions/${session.id}/moonlight/${blockedPath}`, {
        headers: { Cookie: viewerCookie },
      });
      expect(blocked.status).toBe(404);
    }
    const state = await fetch(`${origin}/v1/remote-screen/sessions/${session.id}/viewer-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: viewerCookie },
      body: JSON.stringify({
        source: "openbot-moonlight",
        type: "viewer-state",
        sessionId: session.id,
        state: "connected",
        transport: "p2p",
      }),
    });
    expect(state.status).toBe(204);
    expect(gateway.list()[0]).toMatchObject({ phase: "connected", transport: "p2p" });
    const second = await fetch(authorize, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: session.viewerGrant }),
    });
    expect(second.status).toBe(401);
    await close();
  });

  it("limits the host to four active sessions", async () => {
    const gateway = createGateway();
    for (let index = 0; index < 4; index += 1) await createSession(gateway, "https://remote.example");
    await expect(createSession(gateway, "https://remote.example")).rejects.toMatchObject({
      status: 429,
      code: "session_capacity_reached",
    });
  });

  it("rejects a viewer grant after 60 seconds", async () => {
    let now = Date.parse("2026-08-21T12:00:00.000Z");
    const gateway = createGateway({ now: () => now });
    const { origin, close } = await serveGateway(gateway);
    const session = await createSession(gateway, origin);
    now += 60_001;

    const response = await fetch(`${origin}/v1/remote-screen/sessions/${session.id}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: session.viewerGrant }),
    });

    expect(response.status).toBe(401);
    await close();
  });

  it("releases an unused session when its viewer grant expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const gateway = createGateway();
    try {
      await createSession(gateway, "https://remote.example");

      await vi.advanceTimersByTimeAsync(60_001);

      expect(gateway.list()).toHaveLength(0);
      expect(runtimes[0]?.stop).toHaveBeenCalled();
    } finally {
      await gateway.stop();
      vi.useRealTimers();
    }
  });

  it("closes an active remote stream when its team session expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const gateway = createGateway();
    try {
      await createSession(gateway, "https://remote.example", "member-a", new Date(Date.now() + 5_000).toISOString());

      await vi.advanceTimersByTimeAsync(5_001);

      expect(gateway.list()).toHaveLength(0);
      expect(runtimes[0]?.stop).toHaveBeenCalled();
    } finally {
      await gateway.stop();
      vi.useRealTimers();
    }
  });

  it("forwards the client Init frame after the Moonlight socket finishes opening", async () => {
    const upstreamServer = createServer();
    const upstreamWebSockets = new webSockets.WebSocketServer({ noServer: true });
    upstreamServer.on("upgrade", (request, socket, head) => {
      setTimeout(
        () =>
          upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) =>
            upstreamWebSockets.emit("connection", webSocket, request),
          ),
        50,
      );
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = z.object({ port: z.number().int() }).parse(upstreamServer.address());
    const upstreamMessage = new Promise<string>((resolve) => {
      upstreamWebSockets.once("connection", (socket) => socket.once("message", (data) => resolve(data.toString())));
    });
    const gateway = createGateway({ runtimeBaseUrl: `http://127.0.0.1:${upstreamAddress.port}` });
    const { origin, close } = await serveGateway(gateway);
    const session = await createSession(gateway, origin);
    const client = new webSockets.WebSocket(
      `${origin.replace(/^http/, "ws")}/v1/remote-screen/sessions/${session.id}/stream`,
      { headers: { "X-OpenBot-WebRTC-Session": "team-member-a" } },
    );
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const init = JSON.stringify({ Init: { host_id: 12, app_id: 1 } });
    client.send(init);

    await expect(upstreamMessage).resolves.toBe(init);
    client.close();
    await gateway.stop();
    upstreamWebSockets.close();
    await close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it("serializes concurrent Moonlight Init frames until the previous stream connects", async () => {
    const upstreamServer = createServer();
    const upstreamWebSockets = new webSockets.WebSocketServer({ noServer: true });
    const upstreamMessages: Array<{ user: string; message: string }> = [];
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (data) => {
          upstreamMessages.push({
            user: String(request.headers["x-openbot-remote-user"]),
            message: data.toString(),
          });
        });
      });
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = z.object({ port: z.number().int() }).parse(upstreamServer.address());
    const gateway = createGateway({ runtimeBaseUrl: `http://127.0.0.1:${upstreamAddress.port}` });
    const { origin, close } = await serveGateway(gateway);
    const sessions = [await createSession(gateway, origin), await createSession(gateway, origin, "member-b")];
    const cookies = await Promise.all(
      sessions.map(async (session) => {
        const response = await fetch(`${origin}/v1/remote-screen/sessions/${session.id}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant: session.viewerGrant }),
        });
        return response.headers.get("set-cookie")?.split(";")[0] ?? "";
      }),
    );
    const clients = sessions.map(
      (session, index) =>
        new webSockets.WebSocket(`${origin.replace(/^http/, "ws")}/v1/remote-screen/sessions/${session.id}/stream`, {
          headers: { Cookie: cookies[index] },
        }),
    );
    await Promise.all(
      clients.map(
        (client) =>
          new Promise<void>((resolve, reject) => {
            client.once("open", resolve);
            client.once("error", reject);
          }),
      ),
    );
    clients.forEach((client, index) => {
      client.send(JSON.stringify({ Init: { host_id: 12 + index, app_id: 1 } }));
    });

    await vi.waitFor(() => expect(upstreamMessages).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamMessages).toHaveLength(1);
    const firstSlot = Number(upstreamMessages[0]?.user.match(/(\d+)$/)?.[1]);
    const firstIndex = firstSlot - 1;
    const connected = await fetch(`${origin}/v1/remote-screen/sessions/${sessions[firstIndex]?.id}/viewer-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies[firstIndex] },
      body: JSON.stringify({
        source: "openbot-moonlight",
        type: "viewer-state",
        sessionId: sessions[firstIndex]?.id,
        state: "connected",
        transport: "p2p",
      }),
    });
    expect(connected.status).toBe(204);
    await vi.waitFor(() => expect(upstreamMessages).toHaveLength(2));

    clients.forEach((client) => {
      client.close();
    });
    await gateway.stop();
    upstreamWebSockets.close();
    await close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it("revokes all sessions for a member immediately", async () => {
    const gateway = createGateway();
    await createSession(gateway, "https://remote.example", "member-a");
    await createSession(gateway, "https://remote.example", "member-b");
    await gateway.revokeMember("member-a");
    expect(gateway.list()).toHaveLength(1);
  });

  it("switches the shared Sunshine monitor once", async () => {
    const gateway = createGateway();
    const session = await createSession(gateway, "https://remote.example");
    const secondSession = await createSession(gateway, "https://remote.example", "member-b");
    await gateway.selectDisplay("second");
    expect(runtimes[0]?.selectedDisplays).toEqual(["second"]);
    expect(gateway.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: session.id, selectedDisplayId: "second", phase: "connecting" }),
        expect.objectContaining({ id: secondSession.id, selectedDisplayId: "second", phase: "connecting" }),
      ]),
    );
    await expect(gateway.selectDisplay("missing")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a second display change while Sunshine is restarting", async () => {
    let releaseDisplayChange: (() => void) | undefined;
    const gateway = createGateway({
      selectDisplay: () =>
        new Promise<void>((resolve) => {
          releaseDisplayChange = resolve;
        }),
    });
    await createSession(gateway, "https://remote.example");

    const firstChange = gateway.selectDisplay("second");
    await vi.waitFor(() => expect(runtimes[0]?.selectedDisplays).toEqual(["second"]));

    await expect(gateway.selectDisplay("main")).rejects.toMatchObject({ status: 409 });
    releaseDisplayChange?.();
    await firstChange;
  });
});

function createGateway(
  options: { now?: () => number; runtimeBaseUrl?: string; selectDisplay?: (displayId: string) => Promise<void> } = {},
): RemoteScreenGateway {
  return new RemoteScreenGateway({
    platform: "darwin",
    unattended: true,
    runtimePaths: { sunshine: "/sunshine", moonlightWebServer: "/web-server", moonlightStreamer: "/streamer" },
    runtimeStateDirectory: "/tmp/openbot-test-runtime",
    getRuntimeCredentials: async () => ({ username: "openbot", password: "secret" }),
    getDisplays: () => displays,
    getIceServers: async () => [{ urls: "stun:127.0.0.1:3478" }],
    ...(options.now ? { now: options.now } : {}),
    createRuntime: () => {
      const runtime = new FakeRuntime(options.runtimeBaseUrl, options.selectDisplay);
      runtimes.push(runtime);
      return runtime;
    },
  });
}

function createSession(
  gateway: RemoteScreenGateway,
  publicHttpBaseUrl: string,
  memberId = "member-a",
  teamSessionExpiresAt = new Date(Date.now() + 86_400_000).toISOString(),
) {
  return gateway.createSession({
    serverId: "server-a",
    memberId,
    teamSessionId: `team-${memberId}`,
    teamSessionExpiresAt,
    publicHttpBaseUrl,
  });
}

class FakeRuntime implements RemoteScreenRuntime {
  selectedDisplays: string[] = [];
  readonly stop = vi.fn(async () => undefined);

  constructor(
    private readonly baseUrl = "http://127.0.0.1:9",
    private readonly selectDisplayHandler?: (displayId: string) => Promise<void>,
  ) {}

  async start() {
    return {
      baseUrl: this.baseUrl,
      hostId: 12,
      hostIds: [12, 13, 14, 15],
      desktopAppId: 1,
      displays,
      selectedDisplayId: "main",
    };
  }

  async selectDisplay(displayId: string) {
    this.selectedDisplays.push(displayId);
    await this.selectDisplayHandler?.(displayId);
  }
}

async function serveGateway(gateway: RemoteScreenGateway) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    void gateway.handleHttp(request, response, url);
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    gateway.handleUpgrade(request, socket, head, url);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = z.object({ port: z.number().int() }).parse(server.address());
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
