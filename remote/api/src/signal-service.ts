import {
  decodeSignalClientMessage,
  encodeSignalServerMessage,
  type IceServer,
  type RemoteTicketClaims,
  SIGNAL_MESSAGE_BYTES_LIMIT,
  type SignalClientMessage,
  type SignalErrorCode,
  type SignalServerMessage,
} from "./protocol";

export interface RemoteTokenProvider {
  verifyTicket(token: string): Promise<RemoteTicketClaims>;
  verifyResumeToken(token: string): Promise<RemoteTicketClaims>;
  validateClaims(claims: RemoteTicketClaims): Promise<boolean>;
  issueResumeToken(claims: RemoteTicketClaims): Promise<string>;
  iceServers(claims: RemoteTicketClaims): IceServer[];
  revokeHost?(hostId: string, authEpoch: number): void;
  revokeSession?(sessionId: string): void;
}

export interface SignalSocket {
  id: string;
  ip: string;
  send(message: string): void;
  close(code: number, reason: string): void;
}

interface AuthenticatedPeer {
  socket: SignalSocket;
  claims: RemoteTicketClaims;
  peer: "host" | "client";
  connectionId: string | null;
  resumed: boolean;
}

interface ActiveConnection {
  id: string;
  hostId: string;
  sessionId: string;
  client: SignalSocket;
  host: SignalSocket;
}

export interface SignalMetrics {
  acceptedConnections: number;
  authenticationFailures: number;
  protocolFailures: number;
  relayedMessages: number;
  activeSockets: number;
  activePeerConnections: number;
}

const MAXIMUM_RATE_WINDOWS = 100_000;
const RATE_WINDOW_MILLISECONDS = 60_000;
const SIGNAL_RECONNECT_GRACE_MILLISECONDS = 30_000;
const INITIAL_TICKET_TTL_MILLISECONDS = 3 * 60_000;
const MAXIMUM_EXPIRATION_TIMER_MILLISECONDS = 24 * 60 * 60_000;

export class SignalService {
  readonly #tokens: RemoteTokenProvider;
  readonly #maximumConnectionsPerUser: number;
  readonly #maximumConnectionsPerIp: number;
  readonly #maximumMessagesPerMinute: number;
  readonly #sockets = new Map<string, SignalSocket>();
  readonly #peers = new Map<string, AuthenticatedPeer>();
  readonly #hosts = new Map<string, Set<string>>();
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #connectionDropTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #peerExpirationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #usedTicketIds = new Map<string, number>();
  readonly #revokedEpochs = new Map<string, number>();
  readonly #revokedSessions = new Map<string, number>();
  readonly #rateWindows = new Map<string, { startedAt: number; count: number }>();
  readonly #validateInitialTicketsUntil = Date.now() + INITIAL_TICKET_TTL_MILLISECONDS;
  #lastRatePruneAt = 0;
  readonly #metrics: SignalMetrics = {
    acceptedConnections: 0,
    authenticationFailures: 0,
    protocolFailures: 0,
    relayedMessages: 0,
    activeSockets: 0,
    activePeerConnections: 0,
  };

  constructor(
    tokens: RemoteTokenProvider,
    maximumConnectionsPerUser: number,
    maximumConnectionsPerIp = 32,
    maximumMessagesPerMinute = 600,
  ) {
    this.#tokens = tokens;
    this.#maximumConnectionsPerUser = maximumConnectionsPerUser;
    this.#maximumConnectionsPerIp = maximumConnectionsPerIp;
    this.#maximumMessagesPerMinute = maximumMessagesPerMinute;
  }

  connect(socket: SignalSocket): boolean {
    if (this.#sockets.has(socket.id)) return true;
    if (this.#socketIpCount(socket.ip) >= this.#maximumConnectionsPerIp) {
      this.#fail(socket, "rate_limited", "Too many remote connections from this address.", 1008);
      return false;
    }
    this.#sockets.set(socket.id, socket);
    this.#metrics.activeSockets = this.#sockets.size;
    return true;
  }

  async receive(socket: SignalSocket, input: string | Uint8Array): Promise<void> {
    if (!this.#acceptMessage(socket)) {
      this.#fail(socket, "rate_limited", "Too many signal messages.", 1008);
      return;
    }
    const text = input instanceof Uint8Array ? new TextDecoder().decode(input) : input;
    if (new TextEncoder().encode(text).byteLength > SIGNAL_MESSAGE_BYTES_LIMIT) {
      this.#fail(socket, "invalid_message", "Signal message is too large.", 1009);
      return;
    }
    let message: SignalClientMessage;
    try {
      message = decodeSignalClientMessage(JSON.parse(text));
    } catch {
      this.#metrics.protocolFailures += 1;
      this.#fail(socket, "invalid_message", "Signal message is invalid.", 1003);
      return;
    }
    if (message.type === "hello") {
      await this.#authenticate(socket, message);
      return;
    }
    const peer = this.#peers.get(socket.id);
    if (!peer) {
      this.#fail(socket, "authentication_required", "Authenticate before sending signal messages.", 1008);
      return;
    }
    if (message.type === "turn-refresh") {
      if (peer.claims.sessionExpiresAt <= Math.floor(Date.now() / 1_000)) {
        this.#fail(socket, "authentication_required", "The remote session expired.", 1008);
        return;
      }
      if (message.connectionId !== null && !this.#ownsConnection(peer, message.connectionId)) {
        this.#fail(socket, "permission_denied", "The connection does not belong to this peer.");
        return;
      }
      this.#send(socket, {
        type: "ready",
        version: 1,
        connectionId: message.connectionId,
        resumeToken: await this.#tokens.issueResumeToken(peer.claims),
        iceServers: this.#tokens.iceServers(peer.claims),
      });
      return;
    }
    if (message.type === "disconnect") {
      if (this.#ownsConnection(peer, message.connectionId)) this.#dropConnection(message.connectionId, socket.id);
      return;
    }
    const connection = this.#connections.get(message.connectionId);
    if (!connection || (connection.client.id !== socket.id && connection.host.id !== socket.id)) {
      this.#fail(socket, "permission_denied", "The connection does not belong to this peer.");
      return;
    }
    const target = connection.client.id === socket.id ? connection.host : connection.client;
    this.#send(target, message);
    this.#metrics.relayedMessages += 1;
  }

  disconnect(socket: SignalSocket): void {
    this.#sockets.delete(socket.id);
    const peer = this.#peers.get(socket.id);
    this.#clearPeerExpiration(socket.id);
    if (!peer) {
      this.#metrics.activeSockets = this.#sockets.size;
      return;
    }
    this.#peers.delete(socket.id);
    if (peer.peer === "host") {
      const hostSockets = this.#hosts.get(peer.claims.hostId);
      hostSockets?.delete(socket.id);
      if (hostSockets?.size === 0) this.#hosts.delete(peer.claims.hostId);
    }
    for (const connection of [...this.#connections.values()]) {
      if (connection.client.id !== socket.id && connection.host.id !== socket.id) continue;
      if (connection.client.id === socket.id) {
        this.#scheduleConnectionDrop(connection);
        continue;
      }
      this.#clearConnectionDrop(connection.id);
      this.#connections.delete(connection.id);
      const clientPeer = this.#peers.get(connection.client.id);
      if (clientPeer) clientPeer.connectionId = null;
    }
    if (peer.peer === "host") {
      const replacement = this.#firstHost(peer.claims.hostId);
      if (replacement) void this.#restoreWaitingClient(replacement);
    }
    this.#metrics.activePeerConnections = this.#connections.size;
    this.#metrics.activeSockets = this.#sockets.size;
  }

  revoke(hostId: string, authEpoch: number): void {
    const current = this.#revokedEpochs.get(hostId) ?? 0;
    if (authEpoch <= current) return;
    this.#revokedEpochs.set(hostId, authEpoch);
    this.#tokens.revokeHost?.(hostId, authEpoch);
    for (const peer of [...this.#peers.values()]) {
      if (peer.claims.hostId !== hostId || peer.claims.authEpoch >= authEpoch) continue;
      if (peer.connectionId) this.#dropConnection(peer.connectionId, peer.socket.id);
      this.#fail(peer.socket, "session_revoked", "Remote access was revoked.", 1008);
    }
  }

  revokeSession(sessionId: string): void {
    this.#revokedSessions.set(sessionId, Math.floor(Date.now() / 1_000) + 24 * 60 * 60);
    this.#tokens.revokeSession?.(sessionId);
    for (const connection of [...this.#connections.values()]) {
      if (connection.sessionId === sessionId) this.#dropConnection(connection.id, connection.client.id);
    }
    for (const peer of [...this.#peers.values()]) {
      if (peer.peer === "client" && peer.claims.sessionId === sessionId) {
        if (peer.connectionId) this.#dropConnection(peer.connectionId, peer.socket.id);
        this.#fail(peer.socket, "session_revoked", "The remote session ended.", 1008);
      }
    }
  }

  metrics(): SignalMetrics {
    this.#pruneReplayCache();
    return { ...this.#metrics, activeSockets: this.#sockets.size, activePeerConnections: this.#connections.size };
  }

  async #authenticate(socket: SignalSocket, message: Extract<SignalClientMessage, { type: "hello" }>): Promise<void> {
    if (this.#peers.has(socket.id)) {
      this.#fail(socket, "protocol_error", "This socket is already authenticated.", 1008);
      return;
    }
    let claims: RemoteTicketClaims;
    let usedInitialTicket = true;
    try {
      try {
        claims = await this.#tokens.verifyTicket(message.token);
        if (Date.now() < this.#validateInitialTicketsUntil && !(await this.#tokens.validateClaims(claims))) {
          throw new Error("The remote session is not active.");
        }
      } catch {
        usedInitialTicket = false;
        claims = await this.#tokens.verifyResumeToken(message.token);
      }
      if ((this.#revokedEpochs.get(claims.hostId) ?? 0) > claims.authEpoch) {
        throw new Error("Revoked ticket.");
      }
      if (claims.role !== "host" && this.#revokedSessions.has(claims.sessionId)) throw new Error("Ended session.");
      if (message.peer === "host" && claims.role !== "host") throw new Error("Host role required.");
      if (message.peer === "client" && claims.role === "host") throw new Error("Member role required.");
      this.#pruneReplayCache();
      if (usedInitialTicket && this.#usedTicketIds.has(claims.jti)) throw new Error("Ticket was already used.");
      if (this.#userConnectionCount(claims.userId) >= this.#maximumConnectionsPerUser) {
        this.#fail(socket, "rate_limited", "Too many active remote connections.", 1008);
        return;
      }
    } catch {
      this.#metrics.authenticationFailures += 1;
      this.#fail(socket, "authentication_required", "Remote ticket is invalid or expired.", 1008);
      return;
    }
    if (usedInitialTicket) this.#usedTicketIds.set(claims.jti, claims.exp);
    const peer: AuthenticatedPeer = {
      socket,
      claims,
      peer: message.peer,
      connectionId: null,
      resumed: !usedInitialTicket,
    };
    this.#peers.set(socket.id, peer);
    this.#schedulePeerExpiration(peer);
    this.#metrics.acceptedConnections += 1;
    this.#metrics.activeSockets = this.#sockets.size;
    const resumeToken = await this.#tokens.issueResumeToken(claims);
    if (message.peer === "host") {
      const hostSockets = this.#hosts.get(claims.hostId) ?? new Set<string>();
      hostSockets.add(socket.id);
      this.#hosts.set(claims.hostId, hostSockets);
      this.#send(socket, {
        type: "ready",
        version: 1,
        connectionId: null,
        resumeToken,
        iceServers: this.#tokens.iceServers(claims),
      });
      await this.#restoreWaitingClient(peer);
      return;
    }
    const host = this.#firstHost(claims.hostId);
    if (!host) {
      this.#peers.delete(socket.id);
      this.#metrics.activeSockets = this.#sockets.size;
      this.#fail(socket, "host_unavailable", "The host is offline.", 1013);
      return;
    }
    const existing = this.#connectionForHost(claims.hostId);
    if (existing && existing.sessionId !== claims.sessionId) {
      this.#peers.delete(socket.id);
      this.#metrics.activeSockets = this.#sockets.size;
      this.#fail(socket, "host_busy", "The host already has an active remote session.", 1013);
      return;
    }
    if (existing) this.#replaceClientSignal(existing);
    const connectionId = randomIdentifier();
    peer.connectionId = connectionId;
    this.#connections.set(connectionId, {
      id: connectionId,
      hostId: claims.hostId,
      sessionId: claims.sessionId,
      client: socket,
      host: host.socket,
    });
    this.#metrics.activePeerConnections = this.#connections.size;
    this.#send(socket, {
      type: "ready",
      version: 1,
      connectionId,
      resumeToken,
      iceServers: this.#tokens.iceServers(claims),
    });
    this.#send(host.socket, {
      type: "peer-ready",
      version: 1,
      connectionId,
      sessionId: claims.sessionId,
      userId: claims.userId,
      membershipId: claims.membershipId,
      role: memberRole(claims.role),
      sessionExpiresAt: claims.sessionExpiresAt,
      resumed: peer.resumed,
    });
  }

  #firstHost(hostId: string): AuthenticatedPeer | null {
    for (const socketId of this.#hosts.get(hostId) ?? []) {
      const peer = this.#peers.get(socketId);
      if (peer) return peer;
    }
    return null;
  }

  #connectionForHost(hostId: string): ActiveConnection | null {
    for (const connection of this.#connections.values()) if (connection.hostId === hostId) return connection;
    return null;
  }

  async #restoreWaitingClient(host: AuthenticatedPeer): Promise<void> {
    const client = [...this.#peers.values()].find(
      (peer) => peer.peer === "client" && peer.claims.hostId === host.claims.hostId && peer.connectionId === null,
    );
    if (!client) return;
    const connectionId = randomIdentifier();
    client.connectionId = connectionId;
    host.connectionId = connectionId;
    this.#connections.set(connectionId, {
      id: connectionId,
      hostId: host.claims.hostId,
      sessionId: client.claims.sessionId,
      client: client.socket,
      host: host.socket,
    });
    this.#metrics.activePeerConnections = this.#connections.size;
    this.#send(client.socket, {
      type: "ready",
      version: 1,
      connectionId,
      resumeToken: await this.#tokens.issueResumeToken(client.claims),
      iceServers: this.#tokens.iceServers(client.claims),
    });
    this.#send(host.socket, {
      type: "peer-ready",
      version: 1,
      connectionId,
      sessionId: client.claims.sessionId,
      userId: client.claims.userId,
      membershipId: client.claims.membershipId,
      role: memberRole(client.claims.role),
      sessionExpiresAt: client.claims.sessionExpiresAt,
      resumed: client.resumed,
    });
  }

  #replaceClientSignal(connection: ActiveConnection): void {
    this.#clearConnectionDrop(connection.id);
    this.#connections.delete(connection.id);
    const previous = this.#peers.get(connection.client.id);
    if (previous) {
      this.#peers.delete(connection.client.id);
      this.#clearPeerExpiration(connection.client.id);
      previous.socket.close(4000, "Remote session resumed");
    }
  }

  #dropConnection(connectionId: string, sourceSocketId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    this.#clearConnectionDrop(connectionId);
    this.#connections.delete(connectionId);
    const target = connection.client.id === sourceSocketId ? connection.host : connection.client;
    this.#send(target, { type: "disconnect", version: 1, connectionId });
    const clientPeer = this.#peers.get(connection.client.id);
    if (clientPeer) clientPeer.connectionId = null;
    this.#metrics.activePeerConnections = this.#connections.size;
  }

  #schedulePeerExpiration(peer: AuthenticatedPeer): void {
    this.#clearPeerExpiration(peer.socket.id);
    const remaining = peer.claims.sessionExpiresAt * 1_000 - Date.now();
    if (remaining <= 0) {
      this.#fail(peer.socket, "authentication_required", "The remote session expired.", 1008);
      return;
    }
    const timer = setTimeout(
      () => {
        this.#peerExpirationTimers.delete(peer.socket.id);
        if (this.#peers.get(peer.socket.id) !== peer) return;
        if (peer.claims.sessionExpiresAt * 1_000 > Date.now()) {
          this.#schedulePeerExpiration(peer);
          return;
        }
        this.#fail(peer.socket, "authentication_required", "The remote session expired.", 1008);
      },
      Math.min(remaining, MAXIMUM_EXPIRATION_TIMER_MILLISECONDS),
    );
    timer.unref?.();
    this.#peerExpirationTimers.set(peer.socket.id, timer);
  }

  #clearPeerExpiration(socketId: string): void {
    const timer = this.#peerExpirationTimers.get(socketId);
    if (timer) clearTimeout(timer);
    this.#peerExpirationTimers.delete(socketId);
  }

  #scheduleConnectionDrop(connection: ActiveConnection): void {
    this.#clearConnectionDrop(connection.id);
    const timer = setTimeout(
      () => this.#dropConnection(connection.id, connection.client.id),
      SIGNAL_RECONNECT_GRACE_MILLISECONDS,
    );
    timer.unref?.();
    this.#connectionDropTimers.set(connection.id, timer);
  }

  #clearConnectionDrop(connectionId: string): void {
    const timer = this.#connectionDropTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.#connectionDropTimers.delete(connectionId);
  }

  #ownsConnection(peer: AuthenticatedPeer, connectionId: string): boolean {
    const connection = this.#connections.get(connectionId);
    return Boolean(connection && (connection.client.id === peer.socket.id || connection.host.id === peer.socket.id));
  }

  #userConnectionCount(userId: string): number {
    let total = 0;
    for (const peer of this.#peers.values()) if (peer.claims.userId === userId) total += 1;
    return total;
  }

  #socketIpCount(ip: string): number {
    let total = 0;
    for (const socket of this.#sockets.values()) if (socket.ip === ip) total += 1;
    return total;
  }

  #acceptMessage(socket: SignalSocket, now = Date.now()): boolean {
    if (!this.#acceptRateKey(`ip:${socket.ip || socket.id}`, now)) return false;
    const peer = this.#peers.get(socket.id);
    return peer ? this.#acceptRateKey(`user:${peer.claims.userId}`, now) : true;
  }

  #acceptRateKey(key: string, now: number): boolean {
    this.#pruneRateWindows(now);
    const current = this.#rateWindows.get(key);
    if (!current || now - current.startedAt >= RATE_WINDOW_MILLISECONDS) {
      if (!current && this.#rateWindows.size >= MAXIMUM_RATE_WINDOWS) {
        const oldestKey = this.#rateWindows.keys().next().value;
        if (oldestKey) this.#rateWindows.delete(oldestKey);
      }
      if (current) this.#rateWindows.delete(key);
      this.#rateWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.#maximumMessagesPerMinute;
  }

  #pruneReplayCache(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    for (const [jti, expiresAt] of this.#usedTicketIds) if (expiresAt <= nowSeconds) this.#usedTicketIds.delete(jti);
    for (const [sessionId, expiresAt] of this.#revokedSessions) {
      if (expiresAt <= nowSeconds) this.#revokedSessions.delete(sessionId);
    }
  }

  #pruneRateWindows(now: number): void {
    if (now - this.#lastRatePruneAt < RATE_WINDOW_MILLISECONDS) return;
    this.#lastRatePruneAt = now;
    for (const [key, window] of this.#rateWindows) {
      if (now - window.startedAt >= RATE_WINDOW_MILLISECONDS) this.#rateWindows.delete(key);
    }
  }

  #send(socket: SignalSocket, message: SignalServerMessage): void {
    socket.send(encodeSignalServerMessage(message));
  }

  #fail(socket: SignalSocket, code: SignalErrorCode, message: string, closeCode?: number): void {
    this.#send(socket, { type: "error", version: 1, code, message });
    if (closeCode) socket.close(closeCode, message);
  }
}

function memberRole(role: RemoteTicketClaims["role"]): "owner" | "admin" | "member" {
  if (role === "host") throw new Error("A host cannot create a client connection.");
  return role;
}

function randomIdentifier(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
