import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type * as Ws from "ws";

const LOOPBACK_HOST = "127.0.0.1";
const requireModule = createRequire(import.meta.url);
const webSockets = requireModule(
  join(dirname(requireModule.resolve("ws/package.json")), "index.js"),
) as typeof Ws;

export interface VncWebSocketBridge {
  url: string;
  close: () => Promise<void>;
}

export interface RemoteDesktopWebSocketTarget {
  url: string;
  protocols: string[];
}

export async function startVncWebSocketBridge(targetPort: number): Promise<VncWebSocketBridge> {
  const token = randomBytes(32).toString("base64url");
  const path = `/vnc/${token}`;
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  const websocketServer = new webSockets.WebSocketServer({ noServer: true });
  const sockets = new Set<Socket>();
  let closing = false;

  server.on("upgrade", (request, socket, head) => {
    if (closing || request.url !== path || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    const target = createConnection({ host: LOOPBACK_HOST, port: targetPort });
    sockets.add(target);
    const pending: Buffer[] = [];

    websocket.on("message", (data) => {
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (target.connecting) pending.push(chunk);
      else if (!target.destroyed) target.write(chunk);
    });
    websocket.on("close", () => target.destroy());
    websocket.on("error", () => target.destroy());

    target.on("connect", () => {
      for (const chunk of pending.splice(0)) target.write(chunk);
    });
    target.on("data", (chunk) => {
      if (websocket.readyState === webSockets.WebSocket.OPEN) websocket.send(chunk);
    });
    target.on("close", () => {
      sockets.delete(target);
      if (websocket.readyState === webSockets.WebSocket.OPEN) websocket.close();
    });
    target.on("error", () => {
      if (websocket.readyState === webSockets.WebSocket.OPEN) {
        websocket.close(1011, "VNC connection failed");
      }
    });
  });

  await listenOnLoopback(server);
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("The VNC WebSocket bridge did not get a local port.");
  }

  return {
    url: `ws://${LOOPBACK_HOST}:${address.port}${path}`,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const client of websocketServer.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      websocketServer.close();
      await closeHttpServer(server);
    },
  };
}

export async function startVncWebSocketRelay(
  target: RemoteDesktopWebSocketTarget,
): Promise<VncWebSocketBridge> {
  const token = randomBytes(32).toString("base64url");
  const path = `/vnc/${token}`;
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  const websocketServer = new webSockets.WebSocketServer({ noServer: true });
  const remoteSockets = new Set<Ws.WebSocket>();
  let closing = false;

  server.on("upgrade", (request, socket, head) => {
    if (closing || request.url !== path || !isAllowedOrigin(request.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (local) => {
    const remote = new webSockets.WebSocket(target.url, target.protocols, {
      handshakeTimeout: 15_000,
    });
    remoteSockets.add(remote);
    const pending: Buffer[] = [];

    local.on("message", (data) => {
      const chunk = websocketMessageBuffer(data);
      if (remote.readyState === webSockets.WebSocket.CONNECTING) pending.push(chunk);
      else if (remote.readyState === webSockets.WebSocket.OPEN) remote.send(chunk);
    });
    local.on("close", () => remote.close());
    local.on("error", () => remote.terminate());

    remote.on("open", () => {
      for (const chunk of pending.splice(0)) remote.send(chunk);
    });
    remote.on("message", (data) => {
      if (local.readyState === webSockets.WebSocket.OPEN) local.send(websocketMessageBuffer(data));
    });
    remote.on("close", () => {
      remoteSockets.delete(remote);
      if (local.readyState === webSockets.WebSocket.OPEN) local.close();
    });
    remote.on("error", () => {
      if (local.readyState === webSockets.WebSocket.OPEN) {
        local.close(1011, "Remote desktop connection failed");
      }
    });
  });

  await listenOnLoopback(server);
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(server);
    throw new Error("The Remote Desktop WebSocket relay did not get a local port.");
  }

  return {
    url: `ws://${LOOPBACK_HOST}:${address.port}${path}`,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const client of websocketServer.clients) client.terminate();
      for (const remote of remoteSockets) remote.terminate();
      remoteSockets.clear();
      websocketServer.close();
      await closeHttpServer(server);
    },
  };
}

function websocketMessageBuffer(data: Ws.RawData): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === "openbot-app://app" || origin === "null") return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === LOOPBACK_HOST)
    );
  } catch {
    return false;
  }
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}
