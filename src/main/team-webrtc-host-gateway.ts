import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { encodeTeamProtocolV1ClientEvent, TEAM_PROTOCOL_V1_CAPABILITIES } from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2Json,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  type TeamProtocolV2Json,
  type TeamProtocolV2RpcFrame,
} from "@openbot/contracts/team-protocol/v2";
import type * as Ws from "ws";
import {
  decodeRemoteDesktopSignalBinary,
  decodeRemoteDesktopSignalControl,
  encodeRemoteDesktopSignalBinary,
  encodeRemoteDesktopSignalControl,
} from "./remote-desktop-signal";
import type { TeamStore } from "./team-store";
import type { TeamWebRtcBridge } from "./team-webrtc-bridge";
import { TeamWebRtcFileTransfer } from "./team-webrtc-file-transfer";

const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));
const MAXIMUM_BUFFERED_EVENTS = 2_000;

interface TeamWebRtcHostGatewayOptions {
  bridge: TeamWebRtcBridge;
  store: TeamStore;
  appVersion: string;
  transferDirectory: string;
  renewSignal?: (hostId: string) => Promise<{ signalUrl: string; ticket: string }>;
  onSignalRecoveryFailure?: (error: Error) => void;
  closeSession?: (sessionId: string) => Promise<void>;
}

export class TeamWebRtcHostGateway {
  readonly #bridge: TeamWebRtcBridge;
  readonly #store: TeamStore;
  readonly #appVersion: string;
  readonly #files: TeamWebRtcFileTransfer;
  readonly #renewSignal: ((hostId: string) => Promise<{ signalUrl: string; ticket: string }>) | null;
  readonly #onSignalRecoveryFailure: (error: Error) => void;
  readonly #closeSession: (sessionId: string) => Promise<void>;
  readonly #responses = new Map<string, TeamProtocolV2RpcFrame>();
  readonly #events = new Map<number, string>();
  #peerId: string | null = null;
  #localApiPort: number | null = null;
  #localSessionToken: string | null = null;
  #localSessionId: string | null = null;
  #eventsSocket: Ws.WebSocket | null = null;
  #nextEventSequence = 1;
  #desktopSocket: Ws.WebSocket | null = null;
  #desktopStreamId: string | null = null;
  #sessionExpirationTimer: ReturnType<typeof setTimeout> | null = null;
  #sessionPreparation: Promise<void> | null = null;
  #signalRecovery: Promise<void> | null = null;

  constructor(options: TeamWebRtcHostGatewayOptions) {
    this.#bridge = options.bridge;
    this.#store = options.store;
    this.#appVersion = options.appVersion;
    this.#files = new TeamWebRtcFileTransfer(
      options.bridge,
      options.transferDirectory,
      undefined,
      (peerId) => peerId === this.#peerId,
    );
    this.#renewSignal = options.renewSignal ?? null;
    this.#onSignalRecoveryFailure = options.onSignalRecoveryFailure ?? (() => undefined);
    this.#closeSession = options.closeSession ?? (() => Promise.resolve());
    this.#bridge.on("incoming", this.#onIncoming);
    this.#bridge.on("data", this.#onData);
    this.#bridge.on("disconnected", this.#onDisconnected);
    this.#bridge.on("error", this.#onError);
  }

  async start(input: { hostId: string; signalUrl: string; ticket: string; localApiPort: number }): Promise<void> {
    this.#peerId = input.hostId;
    this.#localApiPort = input.localApiPort;
    try {
      await this.#bridge.connect({
        peerId: input.hostId,
        signalUrl: input.signalUrl,
        token: input.ticket,
        peer: "host",
      });
      await this.#waitForSignal(input.hostId);
    } catch (error) {
      await this.#bridge.disconnect(input.hostId).catch(() => undefined);
      this.#peerId = null;
      this.#localApiPort = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const peerId = this.#peerId;
    this.#peerId = null;
    this.#closeLocalSession();
    await this.#signalRecovery?.catch(() => undefined);
    if (peerId) await this.#bridge.disconnect(peerId);
  }

  dispose(): void {
    this.#bridge.off("incoming", this.#onIncoming);
    this.#bridge.off("data", this.#onData);
    this.#bridge.off("disconnected", this.#onDisconnected);
    this.#bridge.off("error", this.#onError);
    void this.#files.stop().catch(() => undefined);
  }

  #waitForSignal(peerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#bridge.off("signalReady", onReady);
        this.#bridge.off("error", onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("The Remote Signal connection timed out."));
      }, 30_000);
      const onReady = (readyPeerId: string) => {
        if (readyPeerId !== peerId) return;
        cleanup();
        resolve();
      };
      const onError = (failedPeerId: string, _code: string, message: string) => {
        if (failedPeerId !== peerId) return;
        cleanup();
        reject(new Error(message));
      };
      this.#bridge.on("signalReady", onReady);
      this.#bridge.on("error", onError);
    });
  }

  readonly #onIncoming = (
    peerId: string,
    connection: {
      connectionId: string;
      sessionId: string;
      userId: string;
      membershipId: string;
      role: "owner" | "admin" | "member";
      sessionExpiresAt: number;
    },
  ): void => {
    this.#sessionPreparation = this.#openIncomingSession(peerId, connection);
    void this.#sessionPreparation.catch(() => this.#closeLocalSession());
  };

  async #openIncomingSession(
    peerId: string,
    connection: {
      connectionId: string;
      sessionId: string;
      userId: string;
      membershipId: string;
      role: "owner" | "admin" | "member";
      sessionExpiresAt: number;
    },
  ): Promise<void> {
    if (peerId !== this.#peerId) return;
    if (connection.sessionId === this.#localSessionId && this.#localSessionToken) return;
    this.#closeLocalSession();
    this.#events.clear();
    this.#responses.clear();
    this.#nextEventSequence = 1;
    const expiresAt = connection.sessionExpiresAt * 1_000;
    if (expiresAt <= Date.now()) return;
    const session = this.#store.openRemoteSession({ ...connection, expiresAt });
    this.#localSessionToken = session.sessionToken;
    this.#localSessionId = connection.sessionId;
    this.#sessionExpirationTimer = setTimeout(() => this.#closeLocalSession(), expiresAt - Date.now());
    this.#connectLocalEvents(session.sessionToken);
  }

  readonly #onData = (
    peerId: string,
    channel: "rpc" | "events" | "files" | "desktop",
    data: string | ArrayBuffer,
  ): void => {
    if (peerId !== this.#peerId) return;
    if (channel === "desktop") {
      void this.#handleDesktopSignal(data).catch(() => this.#closeDesktopSocket());
      return;
    }
    if (!isString(data)) return;
    if (channel === "rpc") void this.#handleRpc(data).catch(() => this.#closeLocalSession());
    else if (channel === "events") void this.#handleEventControl(data);
  };

  readonly #onDisconnected = (peerId: string): void => {
    if (peerId === this.#peerId) {
      this.#sessionPreparation = null;
      this.#closeLocalSession();
    }
  };

  readonly #onError = (peerId: string, code: string): void => {
    if (
      peerId !== this.#peerId ||
      (code !== "authentication_required" && code !== "session_revoked") ||
      !this.#renewSignal
    )
      return;
    if (this.#signalRecovery) return;
    this.#signalRecovery = this.#recoverSignal(peerId)
      .catch((error) => {
        if (this.#peerId === peerId) {
          this.#onSignalRecoveryFailure(error instanceof Error ? error : new Error("Remote Signal recovery failed."));
        }
      })
      .finally(() => {
        this.#signalRecovery = null;
      });
  };

  async #recoverSignal(peerId: string): Promise<void> {
    const renewSignal = this.#renewSignal;
    if (!renewSignal) return;
    const bootstrap = await renewSignal(peerId);
    if (this.#peerId !== peerId) return;
    await this.#bridge.disconnect(peerId).catch(() => undefined);
    if (this.#peerId !== peerId) return;
    await this.#bridge.connect({ peerId, signalUrl: bootstrap.signalUrl, token: bootstrap.ticket, peer: "host" });
    if (this.#peerId !== peerId) {
      await this.#bridge.disconnect(peerId).catch(() => undefined);
      return;
    }
    await this.#waitForSignal(peerId);
  }

  async #handleRpc(data: string): Promise<void> {
    await this.#sessionPreparation;
    const peerId = this.#peerId;
    if (!peerId) return;
    let request: Extract<TeamProtocolV2RpcFrame, { type: "request" }>;
    try {
      const decoded = decodeTeamProtocolV2RpcFrame(data);
      if (decoded.type !== "request") return;
      request = decoded;
    } catch {
      return;
    }
    const cached = this.#responses.get(request.requestId);
    if (cached) {
      await this.#bridge.send(peerId, "rpc", encodeTeamProtocolV2Frame(cached));
      return;
    }
    let response: TeamProtocolV2RpcFrame;
    try {
      if (request.operation !== "http.request" || !isHttpRequest(request.payload)) {
        throw new GatewayError(400, "unsupported_operation", "The Team API operation is not supported.");
      }
      const result = await this.#dispatchHttp(request.payload);
      response = decodeTeamProtocolV2RpcFrame({ version: 2, type: "response", requestId: request.requestId, result });
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 500;
      response = decodeTeamProtocolV2RpcFrame({
        version: 2,
        type: "response",
        requestId: request.requestId,
        error: {
          code: error instanceof GatewayError ? error.code : "host_error",
          message: error instanceof Error ? error.message : "The host could not complete the request.",
          retryable: status >= 500,
          status,
        },
      });
    }
    this.#responses.set(request.requestId, response);
    while (this.#responses.size > 1_000) deleteOldest(this.#responses);
    await this.#bridge.send(peerId, "rpc", encodeTeamProtocolV2Frame(response));
  }

  async #dispatchHttp(input: HttpRequestPayload): Promise<TeamProtocolV2Json> {
    if (!this.#localApiPort || !this.#localSessionToken)
      throw new GatewayError(401, "remote_session_missing", "The remote session is not ready.");
    const url = new URL(input.path, `http://127.0.0.1:${this.#localApiPort}`);
    if (url.origin !== `http://127.0.0.1:${this.#localApiPort}` || !url.pathname.startsWith("/v1/")) {
      throw new GatewayError(400, "invalid_operation_path", "The Team API path is invalid.");
    }
    const peerId = this.#peerId;
    if (!peerId) throw new GatewayError(503, "remote_disconnected", "The WebRTC peer disconnected.");
    const uploaded = input.bodyTransferId ? await this.#files.consume(peerId, input.bodyTransferId) : null;
    const response = await fetch(url, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${this.#localSessionToken}`,
        "Content-Type": uploaded?.mimeType ?? input.contentType ?? "application/json",
        "OpenBot-Protocol-Version": "1",
        "OpenBot-App-Version": this.#appVersion,
        ...(this.#localSessionId ? { "X-OpenBot-WebRTC-Session": this.#localSessionId } : {}),
      },
      body:
        input.method === "GET"
          ? undefined
          : uploaded
            ? Buffer.from(uploaded.bytes)
            : input.body === null
              ? undefined
              : JSON.stringify(input.body),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = response.status === 204 ? null : contentType.includes("json") ? await response.json() : null;
    if (!response.ok) {
      const record = isDynamicRecord(body) ? body : null;
      throw new GatewayError(
        response.status,
        isString(record?.code) ? record.code : "team_api_error",
        isString(record?.error) ? record.error : `The host returned ${response.status}.`,
      );
    }
    if (response.status !== 204 && !contentType.includes("json")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const disposition = response.headers.get("content-disposition") ?? "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
      const name = encodedName ? decodeURIComponent(encodedName) : "remote-file";
      const transferId = await this.#files.send(peerId, {
        name,
        mimeType: contentType || "application/octet-stream",
        bytes,
      });
      return {
        status: response.status,
        body: null,
        file: { transferId, name, mimeType: contentType || "application/octet-stream", size: bytes.byteLength },
      };
    }
    return { status: response.status, body: asJson(body) };
  }

  #connectLocalEvents(token: string): void {
    if (!this.#localApiPort) return;
    this.#eventsSocket?.close();
    const socket = new webSockets.WebSocket(`ws://127.0.0.1:${this.#localApiPort}/v1/events`, [
      "openbot-team-v1",
      `openbot-token.${token}`,
    ]);
    this.#eventsSocket = socket;
    socket.once("open", () => {
      socket.send(
        encodeTeamProtocolV1ClientEvent({
          type: "agent-event-scope",
          includeConversations: true,
          capabilities: TEAM_PROTOCOL_V1_CAPABILITIES,
        }),
      );
    });
    socket.on("message", (data, binary) => {
      if (binary || !this.#peerId) return;
      let payload: TeamProtocolV2Json;
      try {
        payload = asJson(JSON.parse(data.toString()));
      } catch {
        return;
      }
      const sequence = this.#nextEventSequence++;
      const frame = encodeTeamProtocolV2Frame({ version: 2, type: "event", sequence, payload });
      if (this.#events.size >= MAXIMUM_BUFFERED_EVENTS) {
        this.#events.clear();
        this.#sendRecoverable(
          this.#peerId,
          "events",
          encodeTeamProtocolV2Frame({ version: 2, type: "event-reset", nextSequence: sequence }),
        );
      }
      this.#events.set(sequence, frame);
      this.#sendRecoverable(this.#peerId, "events", frame);
    });
  }

  async #handleEventControl(data: string): Promise<void> {
    try {
      await this.#sessionPreparation;
      const frame = decodeTeamProtocolV2EventFrame(data);
      if (frame.type === "event-control") {
        if (this.#eventsSocket?.readyState === webSockets.WebSocket.OPEN) {
          this.#eventsSocket.send(encodeTeamProtocolV1ClientEvent(frame.control));
        }
        return;
      }
      if (frame.type !== "event-ack") return;
      for (const sequence of this.#events.keys()) if (sequence <= frame.throughSequence) this.#events.delete(sequence);
      const peerId = this.#peerId;
      if (!peerId) return;
      const bufferedEvents = [...this.#events].sort(([left], [right]) => left - right);
      const firstSequence = bufferedEvents[0]?.[0];
      if (firstSequence !== undefined && frame.throughSequence < firstSequence - 1) {
        await this.#bridge.send(
          peerId,
          "events",
          encodeTeamProtocolV2Frame({ version: 2, type: "event-reset", nextSequence: firstSequence }),
        );
      }
    } catch {
      // Invalid optional event control frames do not affect the active peer connection.
    }
  }

  async #handleDesktopSignal(data: string | ArrayBuffer): Promise<void> {
    await this.#sessionPreparation;
    const peerId = this.#peerId;
    if (!peerId || !this.#localApiPort || !this.#localSessionId) return;
    if (!isString(data)) {
      const frame = decodeRemoteDesktopSignalBinary(data);
      if (frame.streamId !== this.#desktopStreamId || this.#desktopSocket?.readyState !== webSockets.WebSocket.OPEN)
        return;
      this.#desktopSocket.send(frame.bytes, { binary: true });
      return;
    }
    const control = decodeRemoteDesktopSignalControl(data);
    if (control.type === "open") {
      const url = new URL(control.path, `ws://127.0.0.1:${this.#localApiPort}`);
      if (
        url.origin !== `ws://127.0.0.1:${this.#localApiPort}` ||
        !/^\/v1\/remote-screen\/sessions\/[A-Za-z0-9-]+\/stream$/u.test(url.pathname)
      ) {
        await this.#bridge.send(
          peerId,
          "desktop",
          encodeRemoteDesktopSignalControl({
            type: "error",
            streamId: control.streamId,
            message: "The remote desktop signal path is invalid.",
          }),
        );
        return;
      }
      this.#closeDesktopSocket();
      const socket = new webSockets.WebSocket(url, {
        headers: { "X-OpenBot-WebRTC-Session": this.#localSessionId },
      });
      this.#desktopSocket = socket;
      this.#desktopStreamId = control.streamId;
      socket.once("open", () => {
        this.#sendRecoverable(
          peerId,
          "desktop",
          encodeRemoteDesktopSignalControl({ type: "opened", streamId: control.streamId }),
        );
      });
      socket.on("message", (message, binary) => {
        if (this.#desktopStreamId !== control.streamId) return;
        if (binary) {
          const bytes = rawDataBytes(message);
          this.#sendRecoverable(peerId, "desktop", encodeRemoteDesktopSignalBinary(control.streamId, bytes));
        } else {
          this.#sendRecoverable(
            peerId,
            "desktop",
            encodeRemoteDesktopSignalControl({
              type: "text",
              streamId: control.streamId,
              data: message.toString(),
            }),
          );
        }
      });
      socket.once("close", (code, reason) => {
        if (this.#desktopStreamId !== control.streamId) return;
        this.#desktopSocket = null;
        this.#desktopStreamId = null;
        this.#sendRecoverable(
          peerId,
          "desktop",
          encodeRemoteDesktopSignalControl({
            type: "close",
            streamId: control.streamId,
            code,
            reason: reason.toString(),
          }),
        );
      });
      socket.once("error", () => {
        this.#sendRecoverable(
          peerId,
          "desktop",
          encodeRemoteDesktopSignalControl({
            type: "error",
            streamId: control.streamId,
            message: "The host Moonlight signal socket failed.",
          }),
        );
      });
      return;
    }
    if (control.streamId !== this.#desktopStreamId) return;
    if (control.type === "text" && this.#desktopSocket?.readyState === webSockets.WebSocket.OPEN) {
      this.#desktopSocket.send(control.data);
    } else if (control.type === "close") {
      this.#desktopSocket?.close(control.code ?? 1000, control.reason);
    }
  }

  #closeLocalSession(): void {
    if (this.#sessionExpirationTimer) clearTimeout(this.#sessionExpirationTimer);
    this.#sessionExpirationTimer = null;
    this.#closeDesktopSocket();
    this.#eventsSocket?.close();
    this.#eventsSocket = null;
    if (this.#localSessionId) {
      void this.#closeSession(this.#localSessionId).catch(() => undefined);
      this.#store.closeRemoteSession(this.#localSessionId);
    }
    this.#localSessionId = null;
    this.#localSessionToken = null;
  }

  #sendRecoverable(peerId: string, channel: "events" | "desktop", data: string | ArrayBuffer): void {
    void this.#bridge.send(peerId, channel, data).catch(() => undefined);
  }

  #closeDesktopSocket(): void {
    const socket = this.#desktopSocket;
    this.#desktopSocket = null;
    this.#desktopStreamId = null;
    socket?.close(1000, "Remote desktop signal stopped");
  }
}

function rawDataBytes(data: Ws.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return new Uint8Array(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

interface HttpRequestPayload {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: TeamProtocolV2Json;
  bodyTransferId?: string;
  contentType?: string;
}

function isHttpRequest(value: TeamProtocolV2Json): value is TeamProtocolV2Json & HttpRequestPayload {
  if (!isDynamicRecord(value)) return false;
  const method = value.method;
  return (
    (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") &&
    isString(value.path) &&
    value.path.length <= 2_048 &&
    Object.hasOwn(value, "body") &&
    (value.bodyTransferId === undefined || isString(value.bodyTransferId)) &&
    (value.contentType === undefined || isString(value.contentType))
  );
}

function asJson(value: unknown): TeamProtocolV2Json {
  if (value === undefined) return null;
  return decodeTeamProtocolV2Json(JSON.parse(JSON.stringify(value)));
}

function deleteOldest<Key, Value>(values: Map<Key, Value>): void {
  const oldest = values.keys().next();
  if (!oldest.done) values.delete(oldest.value);
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
