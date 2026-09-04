// The live event channel for HTTPS servers, and the reconnect policy both transports share.
//
// This is the only part of the remote-server family that owns a clock. Everything it does -- the
// exponential backoff with jitter, the thirty seconds of health that forgive the backoff, the pause
// that stops retrying credentials the host already rejected, and the abort/generation races between
// a socket that is closing and a connect that is still negotiating -- is timing, and timing is why
// it lives alone. It was moved here verbatim: a rewrite of any of it is a separate change with its
// own reasoning, not a tidy-up.
//
// It depends on exactly what `RemoteEventStreamOptions` lists: a server directory, a compatibility
// source, a connection registry, an agent-state refresher, an optional live transport, and six
// callbacks that hand facts back rather than writing anywhere. If that interface grows beyond these
// items, the state machine has absorbed the manager again -- that is the signal to stop and split,
// not to add a seventh dependency.
//
// Two things it deliberately does not do. It never writes persisted state: a `team-identity` event
// is reported through `onServerIdentity` and the manager decides to store it, which is what keeps
// the socket layer out of `servers.json`. And it never classifies a failure: it hands the error to
// the registry, which owns the single error-to-issue table, and hears back through
// `suspendReconnect` when retrying is pointless.

import type {
  AgentEvent,
  DirectMessageRealtimeEvent,
  DirectTypingRealtimeEvent,
  ServerCompatibility,
  ServerSummary,
  TeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import { decodeRecord } from "@openbot/contracts/ipc-decoding";
import { isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES, type TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { TEAM_PROTOCOL_V1_WEBSOCKET } from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentClientEvent,
  type TeamProtocolV1CurrentClientEvent,
} from "@openbot/contracts/team-protocol/v1-adapter";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { requestJson } from "./remote-server-http";
import type { RemoteServerDirectory, StoredRemoteServerView } from "./remote-server-store";

const REMOTE_EVENT_RECONNECT_BASE_MS = 1_000;
const REMOTE_EVENT_RECONNECT_MAX_MS = 60_000;
const REMOTE_EVENT_RECONNECT_JITTER = 0.2;
const REMOTE_EVENT_HEALTHY_MS = 30_000;
const REMOTE_EVENT_PAYLOAD_LIMIT = 1024 * 1024;
const REMOTE_EVENT_INITIAL_BUFFER_LIMIT = 1_000;
const REMOTE_EVENT_PROTOCOL = "openbot-events";
const REMOTE_EVENT_SNAPSHOT_PROTOCOL = "openbot-events-v2";

// What the stream needs of the request client: the negotiated range, and the headers that carry it.
export interface RemoteEventCompatibilitySource {
  ensureCompatibility(server: StoredRemoteServerView, refresh?: boolean): Promise<ServerCompatibility>;
  requestProtocol(compatibility: ServerCompatibility): {
    protocol?: number;
    appVersion?: string;
    capabilities?: readonly TeamCurrentCapability[];
    preserveSemanticTags?: boolean;
  };
}

// Reporting only. The stream records what happened and never decides what it means.
export interface RemoteEventConnectionSink {
  markConnected(serverId: string): void;
  setState(serverId: string, state: ServerSummary["state"]): void;
  setCompatibility(serverId: string, compatibility: ServerCompatibility): void;
  compatibilityFor(serverId: string): ServerCompatibility | null;
  reportError(serverId: string, error: unknown): void;
  reportUnreachable(serverId: string): void;
}

export interface RemoteEventAgentState {
  refreshAgentState(serverId: string): Promise<void>;
  forward(serverId: string, event: AgentEvent, bufferedLive?: boolean): void;
}

// The WebRTC half of the same channel. Hosts on that transport have no socket of their own, so the
// stream only starts them and asks for snapshots; their events arrive through the manager.
export interface RemoteEventLiveTransport {
  connect(hostId: string): Promise<void>;
  requestRuntimeSnapshot(hostId: string): Promise<void>;
}

export interface RemoteEventStreamOptions {
  appVersion: string | null;
  servers: RemoteServerDirectory;
  client: RemoteEventCompatibilitySource;
  connections: RemoteEventConnectionSink;
  agents: RemoteEventAgentState;
  transport: RemoteEventLiveTransport | null;
  onServerIdentity: (serverId: string, identity: { serverName: string; logoVersion: string | null }) => void;
  onPresence: (serverId: string, snapshot: TeamPresenceSnapshot) => void;
  onDirectMessage: (serverId: string, event: DirectMessageRealtimeEvent) => void;
  onDirectTyping: (serverId: string, event: DirectTypingRealtimeEvent) => void;
  onOffline: (serverId: string) => void;
  onChanged: () => void;
}

export class RemoteEventStream {
  readonly #appVersion: string | null;
  readonly #servers: RemoteServerDirectory;
  readonly #client: RemoteEventCompatibilitySource;
  readonly #connections: RemoteEventConnectionSink;
  readonly #agents: RemoteEventAgentState;
  readonly #transport: RemoteEventLiveTransport | null;
  readonly #onServerIdentity: RemoteEventStreamOptions["onServerIdentity"];
  readonly #onPresence: RemoteEventStreamOptions["onPresence"];
  readonly #onDirectMessage: RemoteEventStreamOptions["onDirectMessage"];
  readonly #onDirectTyping: RemoteEventStreamOptions["onDirectTyping"];
  readonly #onOffline: RemoteEventStreamOptions["onOffline"];
  readonly #onChanged: RemoteEventStreamOptions["onChanged"];
  readonly #controllers = new Map<string, AbortController>();
  readonly #sockets = new Map<string, WebSocket>();
  readonly #reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #reconnectAttempts = new Map<string, number>();
  readonly #transportAttempts = new Set<string>();
  readonly #authenticationPaused = new Set<string>();
  #enabled = false;

  constructor(options: RemoteEventStreamOptions) {
    this.#appVersion = options.appVersion;
    this.#servers = options.servers;
    this.#client = options.client;
    this.#connections = options.connections;
    this.#agents = options.agents;
    this.#transport = options.transport;
    this.#onServerIdentity = options.onServerIdentity;
    this.#onPresence = options.onPresence;
    this.#onDirectMessage = options.onDirectMessage;
    this.#onDirectTyping = options.onDirectTyping;
    this.#onOffline = options.onOffline;
    this.#onChanged = options.onChanged;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  start(): void {
    this.#enabled = true;
    for (const server of this.#servers.servers) this.ensure(server.id);
  }

  stop(): void {
    this.#enabled = false;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    for (const timer of this.#reconnectTimers.values()) clearTimeout(timer);
    this.#reconnectTimers.clear();
    this.#reconnectAttempts.clear();
    this.#transportAttempts.clear();
    this.#authenticationPaused.clear();
  }

  refreshRuntimeSnapshots(): void {
    for (const server of this.#servers.servers) {
      if (server.transport === "webrtc-v2") {
        void this.#transport?.requestRuntimeSnapshot(server.id).catch(() => undefined);
        continue;
      }
      const socket = this.#sockets.get(server.id);
      if (socket?.readyState !== WebSocket.OPEN) {
        this.ensure(server.id);
        continue;
      }
      if (this.#supportsRuntimeSnapshots(server.id, socket)) {
        socket.send(encodeTeamProtocolV1CurrentClientEvent({ type: "runtime-snapshot-request" }));
      } else {
        void this.#agents.refreshAgentState(server.id).catch(() => undefined);
      }
    }
  }

  // A client event only reaches a host over an open socket. WebRTC hosts are the caller's problem:
  // they have their own transport method, and no socket here to hold.
  send(serverId: string, event: TeamProtocolV1CurrentClientEvent): void {
    const socket = this.#sockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeTeamProtocolV1CurrentClientEvent(event));
  }

  syncScopes(): void {
    for (const [serverId, socket] of this.#sockets) this.#sendEventScope(serverId, socket);
  }

  // The transport reconnected on its own, so the backoff it earned no longer applies.
  clearReconnectBackoff(serverId: string): void {
    const reconnectTimer = this.#reconnectTimers.get(serverId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.#reconnectTimers.delete(serverId);
    this.#reconnectAttempts.delete(serverId);
  }

  // Whether this server's retries are suspended. The manager asks before it records a WebRTC
  // disconnect as a plain "offline": the HTTPS arm has the same guard inline (`!protocolFailed`
  // above the `setState` in `#connect`), and the two must agree or the same failure reads as two
  // different things depending on which transport carried it.
  isReconnectSuspended(serverId: string): boolean {
    return this.#authenticationPaused.has(serverId);
  }

  // The user asked for this server again, which is the act the suspension was waiting for. `restart`
  // does this for an HTTPS server on its way to reopening the socket; a WebRTC server has no socket
  // here, so its manual retry calls this on its own and the two must not drift.
  resumeReconnect(serverId: string): void {
    this.#authenticationPaused.delete(serverId);
    this.clearReconnectBackoff(serverId);
  }

  // What a suspended reconnect costs the event stream. The registry decides that a failure is not
  // worth retrying; this is the only place that knows there is a socket to tear down for it.
  suspendReconnect(serverId: string): void {
    this.#authenticationPaused.add(serverId);
    this.#controllers.get(serverId)?.abort();
    this.#controllers.delete(serverId);
    this.#sockets.delete(serverId);
  }

  forget(serverId: string): void {
    this.#controllers.get(serverId)?.abort();
    this.#controllers.delete(serverId);
    const reconnectTimer = this.#reconnectTimers.get(serverId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.#reconnectTimers.delete(serverId);
    this.#reconnectAttempts.delete(serverId);
    this.#authenticationPaused.delete(serverId);
    this.#sockets.delete(serverId);
  }

  ensure(serverId: string): void {
    const server = this.#servers.find(serverId);
    if (server?.transport === "webrtc-v2") {
      if (
        !this.#enabled ||
        this.#reconnectTimers.has(serverId) ||
        this.#authenticationPaused.has(serverId) ||
        this.#transportAttempts.has(serverId)
      )
        return;
      this.#transportAttempts.add(serverId);
      void this.#transport
        ?.connect(serverId)
        .catch(() => this.scheduleReconnect(serverId))
        .finally(() => this.#transportAttempts.delete(serverId));
      return;
    }
    if (
      !server ||
      !this.#enabled ||
      this.#controllers.has(serverId) ||
      this.#reconnectTimers.has(serverId) ||
      this.#authenticationPaused.has(serverId)
    ) {
      return;
    }
    void this.#connectEvents(serverId);
  }

  restart(serverId: string, resetBackoff = false): void {
    this.#controllers.get(serverId)?.abort();
    this.#controllers.delete(serverId);
    const reconnectTimer = this.#reconnectTimers.get(serverId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.#reconnectTimers.delete(serverId);
    if (resetBackoff) this.resumeReconnect(serverId);
    this.ensure(serverId);
  }

  scheduleReconnect(serverId: string): void {
    if (!this.#enabled || this.#reconnectTimers.has(serverId)) return;
    if (!this.#servers.has(serverId)) return;
    if (this.#authenticationPaused.has(serverId)) return;
    const attempt = (this.#reconnectAttempts.get(serverId) ?? 0) + 1;
    this.#reconnectAttempts.set(serverId, attempt);
    const exponentialDelay = Math.min(
      REMOTE_EVENT_RECONNECT_MAX_MS,
      REMOTE_EVENT_RECONNECT_BASE_MS * 2 ** (attempt - 1),
    );
    const jitter = exponentialDelay * REMOTE_EVENT_RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.min(
      REMOTE_EVENT_RECONNECT_MAX_MS,
      Math.max(REMOTE_EVENT_RECONNECT_BASE_MS, Math.round(exponentialDelay + jitter)),
    );
    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(serverId);
      this.ensure(serverId);
    }, delay);
    this.#reconnectTimers.set(serverId, timer);
  }

  async #connectEvents(serverId: string): Promise<void> {
    if (!this.#enabled || this.#controllers.has(serverId)) return;
    const server = this.#servers.require(serverId);
    if (server.transport === "webrtc-v2") return;
    const controller = new AbortController();
    this.#controllers.set(serverId, controller);
    let opened = false;
    let openedAt = 0;
    let authenticationFailed = false;
    let protocolFailed = false;
    try {
      const compatibility = await this.#client.ensureCompatibility(server, true);
      if (controller.signal.aborted || !this.#enabled || !this.#servers.has(serverId)) {
        if (this.#controllers.get(serverId) === controller) this.#controllers.delete(serverId);
        return;
      }
      const eventsUrl = new URL(TEAM_API_ROUTES.events, server.apiUrl);
      eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
      const socketProtocols = this.#appVersion
        ? [TEAM_PROTOCOL_V1_WEBSOCKET, `openbot-token.${this.#servers.token(server)}`]
        : [REMOTE_EVENT_SNAPSHOT_PROTOCOL, REMOTE_EVENT_PROTOCOL, `openbot-token.${this.#servers.token(server)}`];
      const socket = new WebSocket(eventsUrl, socketProtocols);
      let agentEventsReady = false;
      const bufferedAgentEvents: AgentEvent[] = [];
      controller.signal.addEventListener("abort", () => socket.close(1000, "Client stopped"), {
        once: true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => {
            opened = true;
            openedAt = Date.now();
            this.#sockets.set(serverId, socket);
            this.#sendEventScope(serverId, socket);
            this.#connections.markConnected(serverId);
            this.#connections.setCompatibility(serverId, compatibility);
            this.#authenticationPaused.delete(serverId);
            this.#onChanged();
            if (this.#supportsRuntimeSnapshots(serverId, socket)) {
              agentEventsReady = true;
            } else {
              void this.#agents
                .refreshAgentState(serverId)
                .then(() => {
                  if (this.#sockets.get(serverId) !== socket) return;
                  agentEventsReady = true;
                  for (const event of bufferedAgentEvents) this.#agents.forward(serverId, event, true);
                  bufferedAgentEvents.length = 0;
                })
                .catch(() => socket.close(1011, "Initial agent state is unavailable"));
            }
          },
          { once: true },
        );
        socket.addEventListener("message", (message) => {
          if (!isString(message.data)) {
            protocolFailed = true;
            this.#connections.reportError(
              serverId,
              new RemoteProtocolError("protocol_error", "The host sent a binary event."),
            );
            socket.close(1003, "Text event payloads are required");
            return;
          }
          if (Buffer.byteLength(message.data) > REMOTE_EVENT_PAYLOAD_LIMIT) {
            protocolFailed = true;
            this.#connections.reportError(
              serverId,
              new RemoteProtocolError("protocol_error", "The host event was too large."),
            );
            socket.close(1009, "Event payload is too large");
            return;
          }
          try {
            const decoded = decodeTeamProtocolV1CurrentEvent(JSON.parse(message.data));
            if (decoded.kind === "unknown") return;
            if (decoded.kind === "invalid") {
              protocolFailed = true;
              this.#connections.reportError(
                serverId,
                new RemoteProtocolError("protocol_error", "The host returned an invalid known event."),
              );
              socket.close(1003, "Invalid known event payload");
              return;
            }
            const event = decoded.event;
            if (event.type === "team-identity") {
              this.#onServerIdentity(serverId, { serverName: event.serverName, logoVersion: event.logoVersion });
            } else if (event.type === "team-presence") {
              this.#onPresence(serverId, event.snapshot);
            } else if (event.type === "team-direct-message") {
              this.#onDirectMessage(serverId, event);
            } else if (event.type === "team-direct-typing") {
              this.#onDirectTyping(serverId, event);
            } else {
              if (!agentEventsReady) {
                if (bufferedAgentEvents.length >= REMOTE_EVENT_INITIAL_BUFFER_LIMIT) {
                  socket.close(1013, "Initial agent event buffer is full");
                  return;
                }
                bufferedAgentEvents.push(event);
              } else {
                this.#agents.forward(serverId, event);
              }
            }
          } catch {
            protocolFailed = true;
            this.#connections.reportError(
              serverId,
              new RemoteProtocolError("protocol_error", "The host returned invalid JSON."),
            );
            socket.close(1003, "Invalid event payload");
          }
        });
        socket.addEventListener(
          "error",
          () => {
            socket.close(1011, "Remote events are unavailable");
            reject(new Error("Remote events are unavailable."));
          },
          { once: true },
        );
        socket.addEventListener(
          "close",
          () => {
            if (this.#sockets.get(serverId) === socket) {
              this.#sockets.delete(serverId);
            }
            resolve();
          },
          { once: true },
        );
      });
      if (!controller.signal.aborted && !protocolFailed) {
        this.#connections.setState(serverId, "offline");
        this.#onOffline(serverId);
        this.#onChanged();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof RemoteProtocolError) {
          protocolFailed = true;
          this.#connections.reportError(serverId, error);
        } else {
          authenticationFailed = !opened && (await this.#hasRejectedEventCredentials(server));
          if (authenticationFailed) {
            this.#connections.reportError(serverId, new RemoteRequestError(401, "Sign in again."));
          } else {
            this.#connections.reportUnreachable(serverId);
            this.#onOffline(serverId);
            this.#onChanged();
          }
        }
      }
    }
    if (this.#controllers.get(serverId) === controller) this.#controllers.delete(serverId);
    if (openedAt > 0 && Date.now() - openedAt >= REMOTE_EVENT_HEALTHY_MS) {
      this.#reconnectAttempts.delete(serverId);
    }
    if (!controller.signal.aborted && !authenticationFailed && !protocolFailed) this.scheduleReconnect(serverId);
  }

  #sendEventScope(serverId: string, socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (
      this.#appVersion
        ? socket.protocol !== TEAM_PROTOCOL_V1_WEBSOCKET
        : !this.#supportsRuntimeSnapshots(serverId, socket)
    ) {
      return;
    }
    socket.send(
      encodeTeamProtocolV1CurrentClientEvent({
        type: "agent-event-scope",
        includeConversations: this.#servers.activeServerId === serverId,
        ...(this.#appVersion ? { capabilities: TEAM_CURRENT_CAPABILITIES } : {}),
      }),
    );
  }

  // Whether the socket died because the host rejected these credentials, which is the one failure a
  // reconnect cannot fix. Asked over HTTP because a closed socket carries no status.
  async #hasRejectedEventCredentials(server: StoredRemoteServerView): Promise<boolean> {
    try {
      const compatibility = await this.#client.ensureCompatibility(server);
      await requestJson(server.apiUrl, TEAM_API_ROUTES.me, (value) => decodeRecord(value, "team member"), {
        token: this.#servers.token(server),
        ...this.#client.requestProtocol(compatibility),
      });
      return false;
    } catch (error) {
      return error instanceof RemoteRequestError && (error.status === 401 || error.status === 403);
    }
  }

  #supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean {
    return this.#connections.compatibilityFor(serverId)?.capabilities.includes(capability) ?? false;
  }

  // The pre-`appVersion` hosts predate capability negotiation, so the subprotocol they accepted is
  // the only thing that says whether they can replay a snapshot. Kept as it shipped.
  #supportsRuntimeSnapshots(serverId: string, socket: WebSocket): boolean {
    return this.#appVersion
      ? this.#supportsCapability(serverId, "agent-runtime-snapshots")
      : socket.protocol === REMOTE_EVENT_SNAPSHOT_PROTOCOL;
  }
}
