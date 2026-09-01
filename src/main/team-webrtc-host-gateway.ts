import { randomBytes, verify } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { encodeTeamProtocolV1ClientEvent } from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV2AuthFrame,
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2RpcFrame,
  encodeTeamProtocolV2Frame,
  type TeamProtocolV2AuthFrame,
  type TeamProtocolV2Json,
  type TeamProtocolV2RpcFrame,
  teamProtocolV2AuthenticationTranscript,
} from "@openbot/contracts/team-protocol/v2";
import { createTeamProtocolV2Event } from "@openbot/contracts/team-protocol/v2-adapter";
import { TEAM_PROTOCOL_V3_CAPABILITIES } from "@openbot/contracts/team-protocol/v3";
import {
  decodeTeamProtocolV3WebRtcHttpRequest,
  encodeTeamProtocolV3WebRtcHttpResponse,
} from "@openbot/contracts/team-protocol/v3-webrtc-adapter";
import type * as Ws from "ws";
import type { VerifiedRemoteSessionTicket } from "./central-auth-manager";
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
  verifyClientTicket?: (ticket: string) => Promise<VerifiedRemoteSessionTicket>;
}

interface IncomingConnection {
  connectionId: string;
  sessionId: string;
  userId: string;
  membershipId: string;
  role: "owner" | "admin" | "member";
  sessionExpiresAt: number;
}

export class TeamWebRtcHostGateway {
  readonly #bridge: TeamWebRtcBridge;
  readonly #store: TeamStore;
  readonly #appVersion: string;
  readonly #files: TeamWebRtcFileTransfer;
  readonly #renewSignal: ((hostId: string) => Promise<{ signalUrl: string; ticket: string }>) | null;
  readonly #onSignalRecoveryFailure: (error: Error) => void;
  readonly #closeSession: (sessionId: string) => Promise<void>;
  readonly #verifyClientTicket: ((ticket: string) => Promise<VerifiedRemoteSessionTicket>) | null;
  readonly #responses = new Map<string, TeamProtocolV2RpcFrame>();
  readonly #responsesInFlight = new Map<string, Promise<TeamProtocolV2RpcFrame>>();
  readonly #events = new Map<number, string>();
  #peerId: string | null = null;
  #localApiPort: number | null = null;
  #localSessionToken: string | null = null;
  #localSessionId: string | null = null;
  #eventsSocket: Ws.WebSocket | null = null;
  #eventsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #eventsReconnectAttempts = 0;
  #nextEventSequence = 1;
  #desktopSocket: Ws.WebSocket | null = null;
  #desktopStreamId: string | null = null;
  #sessionExpirationTimer: ReturnType<typeof setTimeout> | null = null;
  #sessionPreparation: Promise<void> | null = null;
  #signalRecovery: Promise<void> | null = null;
  #pendingConnection: IncomingConnection | null = null;
  #peerBinding: { localFingerprint: string; remoteFingerprint: string } | null = null;
  #sessionBinding: { localFingerprint: string; remoteFingerprint: string } | null = null;
  #authenticationCompletion: {
    claims: VerifiedRemoteSessionTicket;
    clientNonce: string;
    hostNonce: string;
  } | null = null;

  constructor(options: TeamWebRtcHostGatewayOptions) {
    this.#bridge = options.bridge;
    this.#store = options.store;
    this.#appVersion = options.appVersion;
    this.#files = new TeamWebRtcFileTransfer(
      options.bridge,
      options.transferDirectory,
      undefined,
      (peerId) => peerId === this.#peerId && this.#localSessionToken !== null,
    );
    this.#renewSignal = options.renewSignal ?? null;
    this.#onSignalRecoveryFailure = options.onSignalRecoveryFailure ?? (() => undefined);
    this.#closeSession = options.closeSession ?? (() => Promise.resolve());
    this.#verifyClientTicket = options.verifyClientTicket ?? null;
    this.#bridge.on("incoming", this.#onIncoming);
    this.#bridge.on("connected", this.#onConnected);
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

  async revokeSession(sessionId: string): Promise<void> {
    if (sessionId !== this.#localSessionId) return;
    const peerId = this.#peerId;
    this.#closeLocalSession();
    if (peerId) await this.#bridge.disconnectPeer(peerId).catch(() => undefined);
  }

  dispose(): void {
    this.#bridge.off("incoming", this.#onIncoming);
    this.#bridge.off("connected", this.#onConnected);
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

  readonly #onIncoming = (peerId: string, connection: IncomingConnection): void => {
    if (peerId !== this.#peerId) return;
    if (connection.sessionId === this.#localSessionId && this.#localSessionToken) {
      this.#pendingConnection = connection;
      return;
    }
    this.#closeLocalSession();
    this.#pendingConnection = connection;
  };

  readonly #onConnected = (peerId: string, binding?: { localFingerprint: string; remoteFingerprint: string }): void => {
    if (peerId !== this.#peerId) return;
    this.#peerBinding = binding ?? null;
    if (
      !this.#pendingConnection ||
      this.#pendingConnection.sessionId !== this.#localSessionId ||
      !this.#localSessionToken
    )
      return;
    if (
      this.#sessionBinding &&
      binding &&
      this.#sessionBinding.localFingerprint === binding.localFingerprint &&
      this.#sessionBinding.remoteFingerprint === binding.remoteFingerprint
    ) {
      this.#pendingConnection = null;
      this.#files.setPeerAuthenticated(peerId, true);
      return;
    }
    this.#closeLocalSession(false);
  };

  async #openIncomingSession(peerId: string, connection: Omit<IncomingConnection, "connectionId">): Promise<void> {
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
  }

  readonly #onData = (
    peerId: string,
    channel: "rpc" | "events" | "files" | "desktop",
    data: string | ArrayBuffer,
  ): void => {
    if (peerId !== this.#peerId) return;
    const authFrame = channel === "rpc" && isString(data) ? authenticationFrame(data) : null;
    if (authFrame?.type === "auth-init") {
      void this.#handleAuthentication(peerId, authFrame).catch(() => this.#failProtocol(peerId));
      return;
    }
    if (authFrame?.type === "auth-complete") {
      void this.#completeAuthentication(peerId, authFrame).catch(() => this.#failProtocol(peerId));
      return;
    }
    if (!this.#localSessionToken) {
      this.#failProtocol(peerId);
      return;
    }
    if (channel === "desktop") {
      void this.#handleDesktopSignal(data).catch(() => this.#closeDesktopSocket());
      return;
    }
    if (!isString(data)) {
      if (channel === "rpc" || channel === "events") this.#failProtocol(peerId);
      return;
    }
    if (channel === "rpc") void this.#handleRpc(data).catch(() => this.#failProtocol(peerId));
    else if (channel === "events") void this.#handleEventControl(data).catch(() => this.#failProtocol(peerId));
  };

  readonly #onDisconnected = (peerId: string): void => {
    if (peerId === this.#peerId) {
      this.#files.setPeerAuthenticated(peerId, false);
      this.#sessionPreparation = null;
      this.#pendingConnection = null;
      this.#peerBinding = null;
      this.#authenticationCompletion = null;
      this.#closeLocalSession();
    }
  };

  async #handleAuthentication(
    peerId: string,
    frame: Extract<TeamProtocolV2AuthFrame, { type: "auth-init" }>,
  ): Promise<void> {
    const pending = this.#pendingConnection;
    const binding = this.#peerBinding;
    const verifyClientTicket = this.#verifyClientTicket;
    if (!pending || !binding || !verifyClientTicket || this.#authenticationCompletion || this.#sessionPreparation) {
      throw new Error("Remote authentication is not ready.");
    }
    const claims = await verifyClientTicket(frame.ticket);
    if (
      claims.hostId !== peerId ||
      claims.sessionId !== pending.sessionId ||
      claims.userId !== pending.userId ||
      claims.membershipId !== pending.membershipId ||
      claims.role !== pending.role ||
      claims.clientPublicKey !== frame.clientPublicKey ||
      claims.sessionExpiresAt !== pending.sessionExpiresAt
    ) {
      throw new Error("The client ticket does not match the Signal connection.");
    }
    const transcript = teamProtocolV2AuthenticationTranscript({
      hostId: peerId,
      sessionId: claims.sessionId,
      ticket: frame.ticket,
      clientPublicKey: frame.clientPublicKey,
      clientNonce: frame.clientNonce,
      clientFingerprint: binding.remoteFingerprint,
      hostFingerprint: binding.localFingerprint,
    });
    if (!verify(null, Buffer.from(transcript), frame.clientPublicKey, Buffer.from(frame.signature, "base64url"))) {
      throw new Error("The client proof of possession is invalid.");
    }
    const hostNonce = randomBytes(32).toString("base64url");
    const responseTranscript = teamProtocolV2AuthenticationTranscript({
      hostId: peerId,
      sessionId: claims.sessionId,
      ticket: frame.ticket,
      clientPublicKey: frame.clientPublicKey,
      clientNonce: frame.clientNonce,
      hostNonce,
      clientFingerprint: binding.remoteFingerprint,
      hostFingerprint: binding.localFingerprint,
    });
    this.#authenticationCompletion = { claims, clientNonce: frame.clientNonce, hostNonce };
    await this.#bridge.send(
      peerId,
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "auth-ready",
        clientNonce: frame.clientNonce,
        hostNonce,
        signature: this.#store.signRemoteAuthentication(responseTranscript),
      }),
    );
  }

  async #completeAuthentication(
    peerId: string,
    frame: Extract<TeamProtocolV2AuthFrame, { type: "auth-complete" }>,
  ): Promise<void> {
    const completion = this.#authenticationCompletion;
    if (
      !completion ||
      frame.clientNonce !== completion.clientNonce ||
      frame.hostNonce !== completion.hostNonce ||
      this.#sessionPreparation
    ) {
      throw new Error("The authentication completion is invalid.");
    }
    this.#authenticationCompletion = null;
    this.#sessionPreparation = this.#openIncomingSession(peerId, completion.claims);
    await this.#sessionPreparation;
    this.#sessionPreparation = null;
    if (!this.#localSessionToken) throw new Error("The remote session did not open.");
    if (!this.#peerBinding) throw new Error("The WebRTC fingerprint binding is unavailable.");
    this.#sessionBinding = { ...this.#peerBinding };
    this.#files.setPeerAuthenticated(peerId, true);
    await this.#bridge.send(
      peerId,
      "rpc",
      encodeTeamProtocolV2Frame({
        version: 2,
        type: "auth-confirmed",
        clientNonce: frame.clientNonce,
        hostNonce: frame.hostNonce,
      }),
    );
    this.#pendingConnection = null;
  }

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
      if (decoded.type !== "request") throw new Error("The RPC frame is not a request.");
      request = decoded;
    } catch (error) {
      throw new Error("The client sent an invalid RPC frame.", { cause: error });
    }
    const cached = this.#responses.get(request.requestId);
    if (cached) {
      await this.#bridge.send(peerId, "rpc", encodeTeamProtocolV2Frame(cached));
      return;
    }
    const sessionId = this.#localSessionId;
    const inFlightKey = `${sessionId}\0${request.requestId}`;
    let responseOperation = this.#responsesInFlight.get(inFlightKey);
    if (!responseOperation) {
      responseOperation = this.#createRpcResponse(request).then((response) => {
        if (this.#localSessionId === sessionId) {
          this.#responses.set(request.requestId, response);
          while (this.#responses.size > 1_000) deleteOldest(this.#responses);
        }
        return response;
      });
      this.#responsesInFlight.set(inFlightKey, responseOperation);
      void responseOperation.finally(() => {
        if (this.#responsesInFlight.get(inFlightKey) === responseOperation) this.#responsesInFlight.delete(inFlightKey);
      });
    }
    const response = await responseOperation;
    if (this.#peerId !== peerId || this.#localSessionId !== sessionId) return;
    await this.#bridge.send(peerId, "rpc", encodeTeamProtocolV2Frame(response));
  }

  async #createRpcResponse(
    request: Extract<TeamProtocolV2RpcFrame, { type: "request" }>,
  ): Promise<TeamProtocolV2RpcFrame> {
    try {
      if (request.operation !== "http.request" || !isHttpRequest(request.payload)) {
        throw new GatewayError(400, "unsupported_operation", "The Team API operation is not supported.");
      }
      const result = await this.#dispatchHttp(request.payload);
      return decodeTeamProtocolV2RpcFrame({ version: 2, type: "response", requestId: request.requestId, result });
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 500;
      return decodeTeamProtocolV2RpcFrame({
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
        "OpenBot-Protocol-Version": /^\/v1\/agents\/[^/]+\/duplicate$/u.test(url.pathname) ? "3" : "1",
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
              : JSON.stringify(decodeTeamProtocolV3WebRtcHttpRequest(input.method, input.path, input.body)),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = response.status === 204 ? {} : contentType.includes("json") ? await response.json() : null;
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
    return {
      status: response.status,
      body: encodeTeamProtocolV3WebRtcHttpResponse(input.method, input.path, response.status, body),
    };
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
      this.#eventsReconnectAttempts = 0;
      socket.send(
        encodeTeamProtocolV1ClientEvent({
          type: "agent-event-scope",
          includeConversations: true,
          capabilities: TEAM_PROTOCOL_V3_CAPABILITIES,
        }),
      );
    });
    socket.on("message", (data, binary) => {
      if (binary || !this.#peerId) return;
      let frame: string;
      try {
        frame = encodeTeamProtocolV2Frame(
          createTeamProtocolV2Event(this.#nextEventSequence, JSON.parse(data.toString())),
        );
      } catch {
        return;
      }
      const sequence = this.#nextEventSequence++;
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
    socket.once("error", () => socket.close());
    socket.once("close", () => {
      if (this.#eventsSocket !== socket) return;
      this.#eventsSocket = null;
      this.#scheduleLocalEventsReconnect();
    });
  }

  #scheduleLocalEventsReconnect(): void {
    if (this.#eventsReconnectTimer || !this.#localSessionToken || !this.#localSessionId || !this.#peerId) return;
    const delay = Math.min(10_000, 250 * 2 ** this.#eventsReconnectAttempts++);
    this.#eventsReconnectTimer = setTimeout(() => {
      this.#eventsReconnectTimer = null;
      const token = this.#localSessionToken;
      if (token) this.#connectLocalEvents(token);
    }, delay);
  }

  async #handleEventControl(data: string): Promise<void> {
    await this.#sessionPreparation;
    const frame = decodeTeamProtocolV2EventFrame(data);
    if (!this.#eventsSocket && this.#localSessionToken) this.#connectLocalEvents(this.#localSessionToken);
    if (frame.type === "event-control") {
      if (this.#eventsSocket?.readyState === webSockets.WebSocket.OPEN) {
        this.#eventsSocket.send(encodeTeamProtocolV1ClientEvent(frame.control));
      }
      return;
    }
    if (frame.type !== "event-ack") throw new Error("The event frame is not client control data.");
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
  }

  #failProtocol(peerId: string): void {
    if (peerId !== this.#peerId) return;
    this.#files.setPeerAuthenticated(peerId, false);
    this.#closeLocalSession();
    void this.#bridge.disconnectPeer(peerId).catch(() => undefined);
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

  #closeLocalSession(endLogicalSession = true): void {
    if (this.#peerId) this.#files.setPeerAuthenticated(this.#peerId, false);
    if (this.#sessionExpirationTimer) clearTimeout(this.#sessionExpirationTimer);
    this.#sessionExpirationTimer = null;
    this.#closeDesktopSocket();
    if (this.#eventsReconnectTimer) clearTimeout(this.#eventsReconnectTimer);
    this.#eventsReconnectTimer = null;
    this.#eventsReconnectAttempts = 0;
    this.#eventsSocket?.close();
    this.#eventsSocket = null;
    if (this.#localSessionId) {
      if (endLogicalSession) void this.#closeSession(this.#localSessionId).catch(() => undefined);
      this.#store.closeRemoteSession(this.#localSessionId);
    }
    this.#localSessionId = null;
    this.#localSessionToken = null;
    this.#sessionBinding = null;
    this.#sessionPreparation = null;
    this.#authenticationCompletion = null;
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

function deleteOldest<Key, Value>(values: Map<Key, Value>): void {
  const oldest = values.keys().next();
  if (!oldest.done) values.delete(oldest.value);
}

function authenticationFrame(data: string): TeamProtocolV2AuthFrame | null {
  try {
    return decodeTeamProtocolV2AuthFrame(data);
  } catch {
    return null;
  }
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
