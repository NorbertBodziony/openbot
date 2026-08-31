import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isString } from "@openbot/contracts/runtime-values";
import type * as Ws from "ws";
import {
  decodeRemoteDesktopSignalBinary,
  decodeRemoteDesktopSignalControl,
  encodeRemoteDesktopSignalBinary,
  encodeRemoteDesktopSignalControl,
} from "./remote-desktop-signal";

const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_SIGNAL_BYTES = 1024 * 1024;

export interface RemoteViewerTransport {
  sendDesktop(serverId: string, data: string | ArrayBuffer): Promise<void>;
  on(event: "desktopData", listener: (serverId: string, data: string | ArrayBuffer) => void): unknown;
  off(event: "desktopData", listener: (serverId: string, data: string | ArrayBuffer) => void): unknown;
}

interface RemoteViewerProxyOptions {
  transport: RemoteViewerTransport;
  fetchResource: (serverId: string, path: string, init: RequestInit) => Promise<Response>;
}

interface ViewerStream {
  serverId: string;
  socket: Ws.WebSocket;
  opened: boolean;
  pending: Array<{ data: Ws.RawData; binary: boolean }>;
  pendingBytes: number;
  forwarding: Promise<void>;
}

export class RemoteViewerProxy {
  readonly #options: RemoteViewerProxyOptions;
  readonly #token = crypto.randomUUID().replaceAll("-", "");
  readonly #webSockets = new webSockets.WebSocketServer({ noServer: true });
  readonly #streams = new Map<string, ViewerStream>();
  #server: Server | null = null;
  #port: number | null = null;
  #starting: Promise<number> | null = null;

  constructor(options: RemoteViewerProxyOptions) {
    this.#options = options;
    options.transport.on("desktopData", this.#onDesktopData);
  }

  async viewerUrl(serverId: string, upstreamPath: string): Promise<string> {
    const port = await this.#start();
    return `http://127.0.0.1:${port}${this.#basePath(serverId)}${upstreamPath}`;
  }

  async stop(): Promise<void> {
    this.#options.transport.off("desktopData", this.#onDesktopData);
    const streams = [...this.#streams.values()];
    for (const stream of streams) stream.socket.close(1001, "Remote viewer stopped");
    this.#streams.clear();
    await Promise.allSettled(streams.map((stream) => stream.forwarding));
    this.#webSockets.close();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #start(): Promise<number> {
    if (this.#port) return this.#port;
    if (this.#starting) return this.#starting;
    this.#starting = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => void this.#handleHttp(request, response));
      server.on("upgrade", (request, socket, head) => {
        const route = this.#route(request.url ?? "/");
        if (!route || !/^\/v1\/remote-screen\/sessions\/[A-Za-z0-9-]+\/stream$/u.test(route.upstreamPath)) {
          socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.#webSockets.handleUpgrade(request, socket, head, (webSocket) =>
          this.#openStream(route.serverId, route.upstreamPath, webSocket),
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || isString(address))
          return reject(new Error("The local remote viewer proxy did not get a port."));
        this.#server = server;
        this.#port = address.port;
        resolve(address.port);
      });
    }).finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = this.#route(request.url ?? "/");
    if (!route) return sendText(response, 404, "Not found");
    try {
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
      const upstream = await this.#options.fetchResource(route.serverId, route.upstreamPath, {
        method: request.method === "HEAD" ? "GET" : request.method,
        headers: { "Content-Type": request.headers["content-type"] ?? "application/octet-stream" },
        body: body ? Uint8Array.from(body).buffer : undefined,
      });
      if (upstream.status === 204) {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      let bytes = new Uint8Array(await upstream.arrayBuffer());
      if (contentType.includes("text/html") || contentType.includes("javascript")) {
        const prefix = this.#basePath(route.serverId);
        const text = new TextDecoder().decode(bytes).replaceAll("/v1/remote-screen", `${prefix}/v1/remote-screen`);
        bytes = new TextEncoder().encode(text);
      }
      const responseHeaders: OutgoingHttpHeaders = {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (contentType.includes("text/html")) {
        responseHeaders["Content-Security-Policy"] =
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:";
      }
      response.writeHead(upstream.status, responseHeaders);
      response.end(request.method === "HEAD" ? undefined : Buffer.from(bytes));
    } catch {
      sendText(response, 502, "Remote viewer resource unavailable");
    }
  }

  #openStream(serverId: string, upstreamPath: string, socket: Ws.WebSocket): void {
    const streamId = crypto.randomUUID();
    const stream: ViewerStream = {
      serverId,
      socket,
      opened: false,
      pending: [],
      pendingBytes: 0,
      forwarding: Promise.resolve(),
    };
    this.#streams.set(streamId, stream);
    socket.on("message", (data, binary) => {
      if (!stream.opened) {
        stream.pendingBytes += rawDataSize(data);
        if (stream.pendingBytes > MAX_PENDING_SIGNAL_BYTES) {
          socket.close(1009, "Remote desktop signal initialization is too large");
          return;
        }
        stream.pending.push({ data, binary });
        return;
      }
      this.#queueFrame(streamId, stream, data, binary);
    });
    socket.once("close", (code, reason) => {
      this.#streams.delete(streamId);
      void this.#options.transport
        .sendDesktop(
          serverId,
          encodeRemoteDesktopSignalControl({
            type: "close",
            streamId,
            code,
            reason: reason.toString(),
          }),
        )
        .catch(() => undefined);
    });
    void this.#options.transport
      .sendDesktop(
        serverId,
        encodeRemoteDesktopSignalControl({
          type: "open",
          streamId,
          path: upstreamPath,
        }),
      )
      .catch(() => socket.close(1011, "Remote desktop signal failed"));
  }

  async #sendFrame(streamId: string, stream: ViewerStream, data: Ws.RawData, binary: boolean): Promise<void> {
    if (binary) {
      await this.#options.transport.sendDesktop(
        stream.serverId,
        encodeRemoteDesktopSignalBinary(streamId, rawDataBytes(data)),
      );
    } else {
      await this.#options.transport.sendDesktop(
        stream.serverId,
        encodeRemoteDesktopSignalControl({
          type: "text",
          streamId,
          data: rawDataText(data),
        }),
      );
    }
  }

  #queueFrame(streamId: string, stream: ViewerStream, data: Ws.RawData, binary: boolean): void {
    stream.forwarding = stream.forwarding
      .then(async () => {
        if (this.#streams.get(streamId) !== stream || stream.socket.readyState !== webSockets.WebSocket.OPEN) return;
        await this.#sendFrame(streamId, stream, data, binary);
      })
      .catch(() => {
        if (this.#streams.get(streamId) === stream) {
          this.#streams.delete(streamId);
          stream.socket.close(1011, "Remote desktop signal failed");
        }
      });
  }

  readonly #onDesktopData = (serverId: string, data: string | ArrayBuffer): void => {
    try {
      if (!isString(data)) {
        const frame = decodeRemoteDesktopSignalBinary(data);
        const stream = this.#streams.get(frame.streamId);
        if (stream?.serverId === serverId && stream.socket.readyState === webSockets.WebSocket.OPEN) {
          stream.socket.send(frame.bytes, { binary: true });
        }
        return;
      }
      const control = decodeRemoteDesktopSignalControl(data);
      const stream = this.#streams.get(control.streamId);
      if (!stream || stream.serverId !== serverId) return;
      if (control.type === "opened") {
        stream.opened = true;
        for (const frame of stream.pending.splice(0))
          this.#queueFrame(control.streamId, stream, frame.data, frame.binary);
        stream.pendingBytes = 0;
      } else if (control.type === "text" && stream.socket.readyState === webSockets.WebSocket.OPEN) {
        stream.socket.send(control.data);
      } else if (control.type === "close") {
        stream.socket.close(control.code ?? 1000, control.reason);
      } else if (control.type === "error") {
        stream.socket.close(1011, control.message);
      }
    } catch {
      // A malformed optional desktop signal cannot affect Team API channels.
    }
  };

  #route(value: string): { serverId: string; upstreamPath: string } | null {
    const url = new URL(value, "http://127.0.0.1");
    const match = new RegExp(`^/${this.#token}/([^/]+)(/.*)$`, "u").exec(url.pathname);
    if (!match) return null;
    const serverId = decodeURIComponent(match[1] ?? "");
    if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(serverId)) return null;
    return { serverId, upstreamPath: `${match[2]}${url.search}` };
  }

  #basePath(serverId: string): string {
    return `/${this.#token}/${encodeURIComponent(serverId)}`;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("Remote viewer request is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function rawDataSize(data: Ws.RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  return data.byteLength;
}

function rawDataBytes(data: Ws.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

function rawDataText(data: Ws.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}
