// @vitest-environment node

import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import type * as Ws from "ws";
import {
  startVncWebSocketBridge,
  startVncWebSocketRelay,
  type VncWebSocketBridge,
} from "./vnc-websocket-bridge";

const requireModule = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = requireModule(
  join(dirname(requireModule.resolve("ws/package.json")), "index.js"),
) as typeof Ws;

const servers: ReturnType<typeof createServer>[] = [];
const bridges: VncWebSocketBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("VNC WebSocket bridge", () => {
  it("forwards binary data between a token-protected WebSocket and VNC TCP", async () => {
    const vnc = createServer((socket) => {
      socket.write("RFB 003.889\n");
      socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
    });
    servers.push(vnc);
    await new Promise<void>((resolve) => vnc.listen(0, "127.0.0.1", resolve));
    const address = vnc.address();
    if (!address || isString(address)) throw new Error("Missing VNC test port");

    const bridge = await startVncWebSocketBridge(address.port);
    bridges.push(bridge);
    expect(bridge.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[A-Za-z0-9_-]+$/);

    const websocket = new WebSocket(bridge.url, { origin: "openbot-app://app" });
    const handshake = await nextMessage(websocket);
    expect(handshake.toString("ascii")).toBe("RFB 003.889\n");
    websocket.send(Buffer.from("hello"));
    await expect(nextMessage(websocket)).resolves.toEqual(Buffer.from("echo:hello"));
    websocket.close();
  });

  it("rejects a wrong token and a foreign browser origin", async () => {
    const vnc = createServer();
    servers.push(vnc);
    await new Promise<void>((resolve) => vnc.listen(0, "127.0.0.1", resolve));
    const address = vnc.address();
    if (!address || isString(address)) throw new Error("Missing VNC test port");
    const bridge = await startVncWebSocketBridge(address.port);
    bridges.push(bridge);

    await expectRejected(`${bridge.url}-wrong`, "openbot-app://app");
    await expectRejected(bridge.url, "https://example.com");
  });

  it("relays noVNC through an authenticated remote WebSocket", async () => {
    const remoteServer = createHttpServer();
    const remoteWebSockets = new WebSocketServer({
      server: remoteServer,
      handleProtocols: (protocols) =>
        protocols.has("openbot-desktop") ? "openbot-desktop" : false,
    });
    remoteWebSockets.on("connection", (socket, request) => {
      expect(request.headers["sec-websocket-protocol"]).toContain("openbot-token.team-token");
      socket.send(Buffer.from("RFB 003.889\n"));
      socket.on("message", (data) =>
        socket.send(Buffer.concat([Buffer.from("echo:"), data as Buffer])),
      );
    });
    await new Promise<void>((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
    const address = remoteServer.address();
    if (!address || isString(address)) throw new Error("Missing relay test port");

    try {
      const bridge = await startVncWebSocketRelay({
        url: `ws://127.0.0.1:${address.port}/v1/remote-desktop`,
        protocols: ["openbot-desktop", "openbot-token.team-token"],
      });
      bridges.push(bridge);
      const local = new WebSocket(bridge.url, { origin: "openbot-app://app" });
      await expect(nextMessage(local)).resolves.toEqual(Buffer.from("RFB 003.889\n"));
      local.send(Buffer.from("hello"));
      await expect(nextMessage(local)).resolves.toEqual(Buffer.from("echo:hello"));
      local.close();
    } finally {
      for (const client of remoteWebSockets.clients) client.terminate();
      await new Promise<void>((resolve) => remoteWebSockets.close(() => resolve()));
      await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
    }
  });
});

function nextMessage(websocket: Ws.WebSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    websocket.once("message", (data) => {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      resolve(chunk);
    });
    websocket.once("error", reject);
  });
}

function expectRejected(url: string, origin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(url, { origin });
    websocket.once("unexpected-response", (_request, response) => {
      try {
        expect(response.statusCode).toBe(403);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    websocket.once("open", () => reject(new Error("The protected bridge accepted the request.")));
    websocket.once("error", () => undefined);
  });
}
