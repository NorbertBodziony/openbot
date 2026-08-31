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
  issueResumeToken(claims: RemoteTicketClaims): Promise<string>;
  iceServers(claims: RemoteTicketClaims): IceServer[];
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

export class SignalService {
  readonly #tokens: RemoteTokenProvider;
  readonly #maximumConnectionsPerUser: number;
  readonly #maximumConnectionsPerIp: number;
  readonly #maximumMessagesPerMinute: number;
  readonly #peers = new Map<string, AuthenticatedPeer>();
  readonly #hosts = new Map<string, Set<string>>();
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #usedTicketIds = new Map<string, number>();
  readonly #revokedEpochs = new Map<string, number>();
  readonly #rateWindows = new Map<string, { startedAt: number; count: number }>();
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
      if (!this.#ownsConnection(peer, message.connectionId)) {
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
    const peer = this.#peers.get(socket.id);
    if (!peer) return;
    this.#peers.delete(socket.id);
    if (peer.peer === "host") {
      const hostSockets = this.#hosts.get(peer.claims.hostId);
      hostSockets?.delete(socket.id);
      if (hostSockets?.size === 0) this.#hosts.delete(peer.claims.hostId);
    }
    for (const connection of [...this.#connections.values()]) {
      if (connection.client.id !== socket.id && connection.host.id !== socket.id) continue;
      this.#connections.delete(connection.id);
      const clientPeer = this.#peers.get(connection.client.id);
      if (clientPeer) clientPeer.connectionId = null;
    }
    this.#metrics.activePeerConnections = this.#connections.size;
    this.#metrics.activeSockets = this.#peers.size;
  }

  revoke(hostId: string, authEpoch: number): void {
    const current = this.#revokedEpochs.get(hostId) ?? 0;
    if (authEpoch <= current) return;
    this.#revokedEpochs.set(hostId, authEpoch);
    for (const peer of [...this.#peers.values()]) {
      if (peer.peer === "client" && peer.claims.hostId === hostId && peer.claims.authEpoch < authEpoch) {
        this.#fail(peer.socket, "session_revoked", "Remote access was revoked.", 1008);
      }
    }
  }

  metrics(): SignalMetrics {
    this.#pruneReplayCache();
    return { ...this.#metrics, activeSockets: this.#peers.size, activePeerConnections: this.#connections.size };
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
      } catch {
        usedInitialTicket = false;
        claims = await this.#tokens.verifyResumeToken(message.token);
      }
      if (claims.role !== "host" && (this.#revokedEpochs.get(claims.hostId) ?? 0) > claims.authEpoch) {
        throw new Error("Revoked ticket.");
      }
      if (message.peer === "host" && claims.role !== "host") throw new Error("Host role required.");
      if (message.peer === "client" && claims.role === "host") throw new Error("Member role required.");
      this.#pruneReplayCache();
      if (usedInitialTicket && this.#usedTicketIds.has(claims.jti)) throw new Error("Ticket was already used.");
      if (this.#userConnectionCount(claims.userId) >= this.#maximumConnectionsPerUser) {
        this.#fail(socket, "rate_limited", "Too many active remote connections.", 1008);
        return;
      }
      if (this.#ipConnectionCount(socket.ip) >= this.#maximumConnectionsPerIp) {
        this.#fail(socket, "rate_limited", "Too many remote connections from this address.", 1008);
        return;
      }
    } catch {
      this.#metrics.authenticationFailures += 1;
      this.#fail(socket, "authentication_required", "Remote ticket is invalid or expired.", 1008);
      return;
    }
    if (usedInitialTicket) this.#usedTicketIds.set(claims.jti, claims.exp);
    const peer: AuthenticatedPeer = { socket, claims, peer: message.peer, connectionId: null };
    this.#peers.set(socket.id, peer);
    this.#metrics.acceptedConnections += 1;
    this.#metrics.activeSockets = this.#peers.size;
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
      return;
    }
    const host = this.#firstHost(claims.hostId);
    if (!host) {
      this.#peers.delete(socket.id);
      this.#metrics.activeSockets = this.#peers.size;
      this.#fail(socket, "host_unavailable", "The host is offline.", 1013);
      return;
    }
    const existing = this.#connectionForHost(claims.hostId);
    if (existing && existing.sessionId !== claims.sessionId) {
      this.#peers.delete(socket.id);
      this.#metrics.activeSockets = this.#peers.size;
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

  #replaceClientSignal(connection: ActiveConnection): void {
    this.#connections.delete(connection.id);
    const previous = this.#peers.get(connection.client.id);
    if (previous) {
      this.#peers.delete(connection.client.id);
      previous.socket.close(4000, "Remote session resumed");
    }
  }

  #dropConnection(connectionId: string, sourceSocketId: string): void {
    const connection = this.#connections.get(connectionId);
    if (!connection) return;
    this.#connections.delete(connectionId);
    const target = connection.client.id === sourceSocketId ? connection.host : connection.client;
    this.#send(target, { type: "disconnect", version: 1, connectionId });
    const clientPeer = this.#peers.get(connection.client.id);
    if (clientPeer) clientPeer.connectionId = null;
    this.#metrics.activePeerConnections = this.#connections.size;
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

  #ipConnectionCount(ip: string): number {
    let total = 0;
    for (const peer of this.#peers.values()) if (peer.socket.ip === ip) total += 1;
    return total;
  }

  #acceptMessage(socket: SignalSocket, now = Date.now()): boolean {
    if (!this.#acceptRateKey(`ip:${socket.ip || socket.id}`, now)) return false;
    const peer = this.#peers.get(socket.id);
    return peer ? this.#acceptRateKey(`user:${peer.claims.userId}`, now) : true;
  }

  #acceptRateKey(key: string, now: number): boolean {
    const current = this.#rateWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.#rateWindows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.#maximumMessagesPerMinute;
  }

  #pruneReplayCache(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    for (const [jti, expiresAt] of this.#usedTicketIds) if (expiresAt <= nowSeconds) this.#usedTicketIds.delete(jti);
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
