import { randomBytes, randomUUID, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { createInviteUrl, parseInviteUrl } from "@openbot/contracts/invite-links";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AvatarImageInput,
  BotMemory,
  BotSummary,
  BrowserControlState,
  BrowserPreview,
  BrowserTab,
  ConversationMessage,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  DirectConversationPage,
  DirectConversationPageAnchor,
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingInput,
  DirectTypingRealtimeEvent,
  DraftAttachment,
  InvitePreview,
  InviteSummary,
  JoinServerInput,
  LoginServerInput,
  MarkConversationReadInput,
  MarkDirectReadInput,
  QueuedMessageReceipt,
  QueueSnapshot,
  RemoteDesktopCapabilities,
  RemoteDesktopSession,
  Routine,
  RoutineRun,
  SendDirectMessageInput,
  ServerCompatibility,
  ServerConnectionIssue,
  ServerSummary,
  SetTeamTypingInput,
  SidebarLayoutSnapshot,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRealtimeEvent,
  TeamRole,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import {
  isAgentEvent,
  isAgentModel,
  isAgentProvider,
  isAvatarHue,
  isAvatarSeed,
  isBotMemory,
  isConversationMessage,
  isReasoningEffort,
  isRoutine,
  isRoutineRun,
  isSidebarLayoutSnapshot,
  isTeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import {
  type DynamicRecord,
  isBoolean,
  isDynamicRecord,
  isNumber,
  isOneOf,
  isString,
} from "@openbot/contracts/runtime-values";
import {
  decodeTeamProtocolSupportV1,
  encodeTeamProtocolV1ClientEvent,
  highestCommonTeamProtocol,
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
  type TeamProtocolSupportV1,
  type TeamProtocolV1Capability,
  teamProtocolUpdateDirection,
} from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV1CurrentEvent,
  decodeTeamProtocolV1CurrentHttpResponse,
  encodeTeamProtocolV1CurrentHttpRequest,
} from "@openbot/contracts/team-protocol/v1-adapter";
import { RemoteViewerProxy } from "./remote-viewer-proxy";
import { fingerprint } from "./team-store";
import { type TeamWebRtcClientTransport, TeamWebRtcRequestError } from "./team-webrtc-client-transport";

export { isValidRemoteApiUrl } from "@openbot/contracts/invite-links";

interface StoredRemoteServer {
  id: string;
  name: string;
  apiUrl: string;
  fingerprint: string;
  publicKey?: string;
  username: string;
  encryptedToken: string;
  remoteDesktopAvailable: boolean;
  logoVersion?: string | null;
  role: TeamRole;
  transport?: "webrtc-v2";
}

interface StoredRemoteServers {
  version: 3;
  activeServerId: string;
  servers: StoredRemoteServer[];
}

interface RemoteServerEvents {
  changed: [servers: ServerSummary[]];
  agent: [serverId: string, event: AgentEvent, bufferedLive?: boolean];
  presence: [serverId: string, snapshot: TeamPresenceSnapshot];
  directMessage: [serverId: string, event: DirectMessageRealtimeEvent];
  directTyping: [serverId: string, event: DirectTypingRealtimeEvent];
}

interface TokenCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

interface CentralAccountSession {
  createTeamAuthTicket: (serverId: string) => Promise<string>;
  getEmail: () => string;
  sendTeamInviteEmail?: (input: {
    email: string;
    serverName: string;
    inviteUrl: string;
    role: "admin" | "member";
  }) => Promise<void>;
}

interface RemoteServerManagerOptions {
  allowLocalDevelopmentInvites?: boolean;
  appVersion?: string;
  webrtcTransport?: TeamWebRtcClientTransport;
  getLocalHostId?: () => string | null;
}

export interface DevelopmentRemoteServerConnection {
  serverId: string;
  serverName: string;
  apiUrl: string;
  fingerprint: string;
  publicKey: string;
  username: string;
  sessionToken: string;
}

const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
const REMOTE_EVENT_RECONNECT_BASE_MS = 1_000;
const REMOTE_EVENT_RECONNECT_MAX_MS = 60_000;
const REMOTE_EVENT_RECONNECT_JITTER = 0.2;
const REMOTE_EVENT_HEALTHY_MS = 30_000;
const REMOTE_EVENT_PAYLOAD_LIMIT = 1024 * 1024;
const REMOTE_EVENT_INITIAL_BUFFER_LIMIT = 1_000;
const REMOTE_EVENT_PROTOCOL = "openbot-events";
const REMOTE_EVENT_SNAPSHOT_PROTOCOL = "openbot-events-v2";
const LOCAL_TEAM_PROTOCOL = { minimum: TEAM_PROTOCOL_V1, maximum: 2 } as const;

type ResponseDecoder<T> = (value: unknown) => T;

class RemoteRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "RemoteRequestError";
    this.status = status;
    this.code = code;
  }
}

class RemoteProtocolError extends Error {
  constructor(
    readonly code: "client_update_required" | "host_update_required" | "protocol_error",
    message: string,
    readonly support: TeamProtocolSupportV1 | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteProtocolError";
  }
}

export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #path: string;
  readonly #cipher: TokenCipher;
  readonly #centralAccount: CentralAccountSession;
  readonly #allowLocalDevelopmentInvites: boolean;
  readonly #appVersion: string | null;
  #state: StoredRemoteServers = { version: 3, activeServerId: "local", servers: [] };
  #states = new Map<string, ServerSummary["state"]>();
  #compatibility = new Map<string, ServerCompatibility>();
  #issues = new Map<string, ServerConnectionIssue>();
  #compatibilityRequests = new Map<string, Promise<ServerCompatibility>>();
  #connectionSequences = new Map<string, number>();
  #eventControllers = new Map<string, AbortController>();
  #eventSockets = new Map<string, WebSocket>();
  #eventReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #eventReconnectAttempts = new Map<string, number>();
  #webrtcConnectionAttempts = new Set<string>();
  #conversationRefreshRequests = new Map<string, { revision: number }>();
  #queueRefreshRequests = new Map<string, { dirty: boolean }>();
  #eventAuthenticationPaused = new Set<string>();
  #eventGenerations = new Map<string, number>();
  #eventsEnabled = false;
  readonly #webrtcTransport: TeamWebRtcClientTransport | null;
  readonly #getLocalHostId: () => string | null;
  readonly #remoteViewerProxy: RemoteViewerProxy | null;
  #presence = new Map<string, TeamPresenceSnapshot>();
  #writeChain = Promise.resolve();

  constructor(
    path: string,
    cipher: TokenCipher,
    centralAccount: CentralAccountSession,
    options: RemoteServerManagerOptions = {},
  ) {
    super();
    this.#path = path;
    this.#cipher = cipher;
    this.#centralAccount = centralAccount;
    this.#allowLocalDevelopmentInvites = options.allowLocalDevelopmentInvites ?? false;
    this.#appVersion = options.appVersion ?? null;
    this.#webrtcTransport = options.webrtcTransport ?? null;
    this.#getLocalHostId = options.getLocalHostId ?? (() => null);
    this.#remoteViewerProxy = this.#webrtcTransport
      ? new RemoteViewerProxy({
          transport: this.#webrtcTransport,
          fetchResource: (serverId, path, init) => this.fetchRemoteViewerResource(serverId, path, init),
        })
      : null;
    this.#webrtcTransport?.on("connected", (serverId) => {
      const reconnectTimer = this.#eventReconnectTimers.get(serverId);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      this.#eventReconnectTimers.delete(serverId);
      this.#eventReconnectAttempts.delete(serverId);
      this.#states.set(serverId, "online");
      this.#compatibility.set(serverId, this.#webrtcCompatibility());
      this.#issues.delete(serverId);
      this.#connectionSequences.set(serverId, (this.#connectionSequences.get(serverId) ?? 0) + 1);
      this.#emitChanged();
      const server = this.#state.servers.find((candidate) => candidate.id === serverId);
      if (server) {
        void this.#refreshRemoteDesktop(server)
          .catch(() => {
            server.remoteDesktopAvailable = false;
          })
          .then(() => this.#persist())
          .then(() => this.#emitChanged())
          .catch(() => undefined);
      }
    });
    this.#webrtcTransport?.on("disconnected", (serverId) => {
      this.#states.set(serverId, "offline");
      this.#setPresenceOffline(serverId);
      this.#emitChanged();
      this.#scheduleEventReconnect(serverId);
    });
    this.#webrtcTransport?.on("event", (serverId, event) => this.#handleWebRtcEvent(serverId, event));
    this.#webrtcTransport?.on("error", (serverId, code, message) => {
      const authenticationEnded = code === "session_revoked";
      const reconnectPaused = code === "protocol_error" || authenticationEnded;
      if (reconnectPaused) this.#eventAuthenticationPaused.add(serverId);
      this.#states.set(serverId, code === "protocol_error" ? "incompatible" : "error");
      this.#issues.set(serverId, {
        code:
          code === "protocol_error"
            ? "protocol_error"
            : authenticationEnded
              ? "authentication_required"
              : "network_unavailable",
        message,
        retryable: !reconnectPaused,
      });
      this.#emitChanged();
      if (!reconnectPaused) this.#scheduleEventReconnect(serverId);
    });
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      const stored = readStoredRemoteServers(parsed);
      if (stored) this.#state = stored;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (this.#webrtcTransport) await this.#syncWebRtcHosts().catch(() => undefined);
    for (const server of this.#state.servers) {
      this.#states.set(server.id, "offline");
      if (server.transport === "webrtc-v2") this.#compatibility.set(server.id, this.#webrtcCompatibility());
    }
  }

  list(): ServerSummary[] {
    return [
      {
        id: "local",
        name: "Local",
        kind: "local",
        state: "online",
        apiUrl: null,
        remoteDesktopAvailable: false,
        logoUrl: null,
        role: null,
        active: this.#state.activeServerId === "local",
        compatibility: null,
        issue: null,
      },
      ...this.#state.servers.map((server) => ({
        id: server.id,
        name: server.name,
        kind: "remote" as const,
        state: this.#states.get(server.id) ?? "offline",
        apiUrl: server.transport === "webrtc-v2" ? null : server.apiUrl,
        remoteDesktopAvailable: server.remoteDesktopAvailable ?? false,
        logoUrl: server.logoVersion ? remoteServerLogoUrl(server.id, server.logoVersion) : null,
        role: server.role,
        active: this.#state.activeServerId === server.id,
        compatibility: this.#compatibility.get(server.id) ?? this.#checkingCompatibility(),
        issue: this.#issues.get(server.id) ?? null,
        connectionSequence: this.#connectionSequences.get(server.id) ?? 0,
      })),
    ];
  }

  async syncRemoteHosts(): Promise<ServerSummary[]> {
    await this.#syncWebRtcHosts();
    for (const server of this.#state.servers) this.#states.set(server.id, this.#states.get(server.id) ?? "offline");
    if (this.#eventsEnabled) this.startEventConnections();
    this.#emitChanged();
    return this.list();
  }

  get activeServerId(): string {
    return this.#state.activeServerId;
  }

  startEventConnections(): void {
    this.#eventsEnabled = true;
    for (const server of this.#state.servers) this.#ensureEventConnection(server.id);
  }

  refreshRuntimeSnapshots(): void {
    for (const server of this.#state.servers) {
      if (server.transport === "webrtc-v2") {
        void this.#webrtcTransport?.requestRuntimeSnapshot(server.id).catch(() => undefined);
        continue;
      }
      const socket = this.#eventSockets.get(server.id);
      if (socket?.readyState !== WebSocket.OPEN) {
        this.#ensureEventConnection(server.id);
        continue;
      }
      if (this.#supportsRuntimeSnapshots(server.id, socket)) {
        socket.send(encodeTeamProtocolV1ClientEvent({ type: "runtime-snapshot-request" }));
      } else {
        void this.#refreshAgentStateFallback(server.id).catch(() => undefined);
      }
    }
  }

  async select(serverId: string): Promise<ServerSummary[]> {
    if (serverId !== "local" && !this.#state.servers.some((server) => server.id === serverId)) {
      throw new Error("Remote server not found.");
    }
    this.#state.activeServerId = serverId;
    this.#syncEventScopes();
    await this.#persist();
    this.#emitChanged();
    this.startEventConnections();
    return this.list();
  }

  async reorder(serverIds: string[]): Promise<ServerSummary[]> {
    if (serverIds.length !== this.#state.servers.length) {
      throw new Error("The server order is incomplete.");
    }
    const serversById = new Map(this.#state.servers.map((server) => [server.id, server]));
    if (new Set(serverIds).size !== serverIds.length) {
      throw new Error("The server order contains an unknown server.");
    }
    const reordered: StoredRemoteServer[] = [];
    for (const serverId of serverIds) {
      const server = serversById.get(serverId);
      if (!server) throw new Error("The server order contains an unknown server.");
      reordered.push(server);
    }
    if (serverIds.every((serverId, index) => this.#state.servers[index]?.id === serverId)) {
      return this.list();
    }
    this.#state.servers = reordered;
    await this.#persist();
    this.#emitChanged();
    return this.list();
  }

  async join(input: JoinServerInput): Promise<ServerSummary> {
    const invite = parseInviteUrl(input.inviteUrl, {
      allowLocalDevelopmentApiUrl: this.#allowLocalDevelopmentInvites,
    });
    if (this.#webrtcTransport && !isLocalDevelopmentApi(invite.apiUrl)) {
      const preview = await this.#webrtcTransport.previewInvite(invite.token);
      if (preview.hostId !== invite.serverId) throw new Error("The invitation host does not match its token.");
      if (!preview.devicePublicKey || fingerprint(preview.devicePublicKey) !== invite.fingerprint) {
        throw new Error("The invitation host identity does not match its token.");
      }
      const accepted = await this.#webrtcTransport.acceptInvite(invite.token);
      if (accepted.hostId !== invite.serverId) throw new Error("The account service accepted a different host.");
      await this.#syncWebRtcHosts();
      const synchronized = this.#state.servers.find((server) => server.id === accepted.hostId);
      if (!synchronized || synchronized.fingerprint !== invite.fingerprint) {
        throw new Error("The invitation host identity changed while it was accepted.");
      }
      this.#state.activeServerId = accepted.hostId;
      this.#states.set(accepted.hostId, "connecting");
      await this.#persist();
      await this.#webrtcTransport.connect(accepted.hostId);
      this.#emitChanged();
      return requiredServerSummary(this.list(), accepted.hostId);
    }
    const verifiedIdentity = await this.#verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const accountTicket = await this.#centralAccount.createTeamAuthTicket(invite.serverId);
    const result = await requestJson(invite.apiUrl, "/v1/join/account", decodeJoinResult, {
      method: "POST",
      body: {
        inviteToken: invite.token,
        accountTicket,
      },
      ...this.#requestProtocol(verifiedIdentity.compatibility),
    });
    const stored: StoredRemoteServer = {
      id: invite.serverId,
      name: verifiedIdentity.serverName,
      apiUrl: invite.apiUrl,
      fingerprint: invite.fingerprint,
      publicKey: verifiedIdentity.publicKey,
      username: this.#centralAccount.getEmail().trim().toLowerCase(),
      encryptedToken: this.#cipher.encrypt(result.sessionToken).toString("base64"),
      remoteDesktopAvailable: false,
      logoVersion: verifiedIdentity.logoVersion,
      role: result.member.role,
    };
    this.#state.servers = [...this.#state.servers.filter((server) => server.id !== stored.id), stored];
    this.#compatibility.set(stored.id, verifiedIdentity.compatibility);
    this.#issues.delete(stored.id);
    this.#state.activeServerId = stored.id;
    this.#syncEventScopes();
    this.#states.set(stored.id, "online");
    await this.#refreshRemoteDesktop(stored);
    await this.#persist();
    this.#emitChanged();
    this.#restartEventConnection(stored.id, true);
    return requiredServerSummary(this.list(), stored.id);
  }

  async connectDevelopmentServer(input: DevelopmentRemoteServerConnection): Promise<ServerSummary> {
    const verifiedIdentity = await this.#verifyIdentity(input.apiUrl, input.serverId, input.fingerprint);
    if (verifiedIdentity.publicKey !== input.publicKey || verifiedIdentity.serverName !== input.serverName) {
      throw new Error("The local development server identity changed.");
    }
    const stored: StoredRemoteServer = {
      id: input.serverId,
      name: input.serverName,
      apiUrl: input.apiUrl,
      fingerprint: input.fingerprint,
      publicKey: input.publicKey,
      username: input.username,
      encryptedToken: this.#cipher.encrypt(input.sessionToken).toString("base64"),
      remoteDesktopAvailable: false,
      logoVersion: verifiedIdentity.logoVersion,
      role: "member",
    };
    this.#state.servers = [...this.#state.servers.filter((server) => server.id !== stored.id), stored];
    this.#compatibility.set(stored.id, verifiedIdentity.compatibility);
    this.#issues.delete(stored.id);
    this.#state.activeServerId = stored.id;
    this.#syncEventScopes();
    this.#states.set(stored.id, "online");
    await this.#refreshRemoteDesktop(stored);
    await this.#persist();
    this.#emitChanged();
    this.#restartEventConnection(stored.id, true);
    return requiredServerSummary(this.list(), stored.id);
  }

  async previewInvite(input: JoinServerInput): Promise<InvitePreview> {
    const invite = parseInviteUrl(input.inviteUrl, {
      allowLocalDevelopmentApiUrl: this.#allowLocalDevelopmentInvites,
    });
    if (this.#webrtcTransport && !isLocalDevelopmentApi(invite.apiUrl)) {
      const preview = await this.#webrtcTransport.previewInvite(invite.token);
      if (preview.hostId !== invite.serverId) throw new Error("The invitation host does not match its token.");
      if (!preview.devicePublicKey || fingerprint(preview.devicePublicKey) !== invite.fingerprint) {
        throw new Error("The invitation host identity does not match its token.");
      }
      return {
        serverId: preview.hostId,
        serverName: preview.hostName,
        apiHostname: new URL(invite.apiUrl).hostname,
        role: preview.role,
        expiresAt: new Date(preview.expiresAt).toISOString(),
        emailBound: preview.emailBound,
      };
    }
    const identity = await this.#verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const preview = await requestJson(invite.apiUrl, "/v1/invitations/preview", decodeInvitePreview, {
      method: "POST",
      body: { inviteToken: invite.token },
      ...this.#requestProtocol(identity.compatibility),
    });
    return {
      serverId: invite.serverId,
      serverName: identity.serverName,
      apiHostname: new URL(invite.apiUrl).hostname,
      ...preview,
    };
  }

  async login(input: LoginServerInput): Promise<ServerSummary> {
    const server = this.#requireServer(input.serverId);
    this.#states.set(server.id, "connecting");
    this.#emitChanged();
    try {
      const identity = await this.#verifyIdentity(server.apiUrl, server.id, server.fingerprint);
      const accountTicket = await this.#centralAccount.createTeamAuthTicket(server.id);
      const result = await requestJson(server.apiUrl, "/v1/auth/account", decodeJoinResult, {
        method: "POST",
        body: { accountTicket },
        ...this.#requestProtocol(identity.compatibility),
      });
      this.#compatibility.set(server.id, identity.compatibility);
      this.#issues.delete(server.id);
      server.username = this.#centralAccount.getEmail().trim().toLowerCase();
      server.role = result.member.role;
      server.encryptedToken = this.#cipher.encrypt(result.sessionToken).toString("base64");
      server.name = identity.serverName;
      server.logoVersion = identity.logoVersion;
      this.#states.set(server.id, "online");
      await this.#refreshRemoteDesktop(server);
      await this.#persist();
      this.#restartEventConnection(server.id, true);
    } catch (error) {
      this.#applyConnectionError(server.id, error, "error");
      throw error;
    }
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  async retryConnection(serverId: string): Promise<ServerSummary> {
    const server = this.#requireServer(serverId);
    const blockedState = this.#issues.has(serverId) ? (this.#states.get(serverId) ?? "error") : "error";
    try {
      if (server.transport === "webrtc-v2") {
        if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
        this.#states.set(serverId, "connecting");
        this.#emitChanged();
        await this.#webrtcTransport.connect(serverId);
        return requiredServerSummary(this.list(), serverId);
      }
      await this.#ensureCompatibility(server, true);
      this.#states.set(serverId, "connecting");
      this.#emitChanged();
      this.#restartEventConnection(serverId, true);
    } catch (error) {
      this.#applyConnectionError(serverId, error, blockedState);
      throw error;
    }
    return requiredServerSummary(this.list(), serverId);
  }

  async remove(serverId: string): Promise<void> {
    if (serverId === "local") throw new Error("The local server cannot be removed.");
    if (this.#state.servers.find((server) => server.id === serverId)?.transport === "webrtc-v2") {
      if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
      await this.#webrtcTransport.leaveHost(serverId);
      await this.#webrtcTransport.disconnect(serverId).catch(() => undefined);
    }
    this.#clearServerConnectionState(serverId);
    this.#state.servers = this.#state.servers.filter((server) => server.id !== serverId);
    if (this.#state.activeServerId === serverId) this.#state.activeServerId = "local";
    await this.#persist();
    this.#emitChanged();
  }

  #clearServerConnectionState(serverId: string): void {
    this.#eventControllers.get(serverId)?.abort();
    this.#eventControllers.delete(serverId);
    const reconnectTimer = this.#eventReconnectTimers.get(serverId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.#eventReconnectTimers.delete(serverId);
    this.#eventReconnectAttempts.delete(serverId);
    this.#eventAuthenticationPaused.delete(serverId);
    this.#eventGenerations.delete(serverId);
    for (const key of this.#conversationRefreshRequests.keys()) {
      if (key.startsWith(`${serverId}\0`)) this.#conversationRefreshRequests.delete(key);
    }
    for (const key of this.#queueRefreshRequests.keys()) {
      if (key.startsWith(`${serverId}\0`)) this.#queueRefreshRequests.delete(key);
    }
    this.#states.delete(serverId);
    this.#compatibility.delete(serverId);
    this.#issues.delete(serverId);
    this.#compatibilityRequests.delete(serverId);
    this.#connectionSequences.delete(serverId);
    this.#eventSockets.delete(serverId);
    this.#presence.delete(serverId);
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    serverId = this.#state.activeServerId,
    decoder: ResponseDecoder<T>,
  ): Promise<T> {
    const server = this.#requireServer(serverId);
    try {
      if (server.transport === "webrtc-v2") {
        if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
        try {
          const value = await this.#webrtcTransport.request(server.id, path, init);
          return addRemotePreviewUrls(decoder(value), server.id);
        } catch (error) {
          if (error instanceof TeamWebRtcRequestError)
            throw new RemoteRequestError(error.status, error.message, error.code);
          throw error;
        }
      }
      const compatibility = await this.#ensureCompatibility(server);
      const value = await requestJson(server.apiUrl, path, decoder, {
        ...init,
        token: this.#token(server),
        ...this.#requestProtocol(compatibility),
      });
      return addRemotePreviewUrls(value, server.id);
    } catch (error) {
      this.#applyConnectionError(server.id, error);
      throw error;
    }
  }

  listAgentConversationReads(serverId = this.#state.activeServerId): Promise<Record<string, ConversationReadState>> {
    return this.request("/v1/agents/conversation-reads", {}, serverId, decodeConversationReadStates);
  }

  readAgentConversation(botId: string, serverId = this.#state.activeServerId): Promise<ConversationWithReadState> {
    return this.request(
      `/v1/agents/${encodeURIComponent(botId)}/conversation`,
      {},
      serverId,
      decodeConversationWithReadState,
    );
  }

  readAgentConversationPage(
    botId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
    serverId = this.#state.activeServerId,
  ): Promise<ConversationPage> {
    return this.request(
      `/v1/agents/${encodeURIComponent(botId)}/conversation-page${pageQuery(anchor, limit)}`,
      {},
      serverId,
      decodeConversationPage,
    );
  }

  searchAgentConversationMessages(
    query: string,
    botId?: string,
    cursor?: string,
    limit = 100,
    serverId = this.#state.activeServerId,
  ): Promise<ConversationSearchPage> {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    if (botId) parameters.set("botId", botId);
    if (cursor) parameters.set("cursor", cursor);
    return this.request(`/v1/messages/search?${parameters.toString()}`, {}, serverId, decodeConversationSearchPage);
  }

  markAgentConversationRead(
    input: MarkConversationReadInput,
    serverId = this.#state.activeServerId,
  ): Promise<ConversationReadState> {
    return this.request(
      `/v1/agents/${encodeURIComponent(input.botId)}/conversation/read`,
      { method: "POST", body: { throughMessageId: input.throughMessageId } },
      serverId,
      decodeConversationReadState,
    );
  }

  getPresence(serverId = this.#state.activeServerId): TeamPresenceSnapshot {
    const cached = this.#presence.get(serverId);
    if (cached) return structuredClone(cached);
    return { serverId, members: [], updatedAt: new Date().toISOString() };
  }

  async getPresenceFor(serverId: string): Promise<TeamPresenceSnapshot> {
    try {
      const snapshot = await this.request("/v1/team/presence", {}, serverId, decodeTeamPresenceSnapshot);
      this.#presence.set(serverId, snapshot);
      return structuredClone(snapshot);
    } catch (error) {
      const cached = this.#presence.get(serverId);
      if (cached) return structuredClone(cached);
      throw error;
    }
  }

  async refreshIdentity(serverId: string): Promise<ServerSummary> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      await this.#syncWebRtcHosts();
      this.#compatibility.set(serverId, this.#webrtcCompatibility());
      this.#issues.delete(serverId);
      this.#emitChanged();
      return requiredServerSummary(this.list(), serverId);
    }
    const identity = await this.#verifyIdentity(server.apiUrl, server.id, server.fingerprint);
    this.#compatibility.set(server.id, identity.compatibility);
    this.#issues.delete(server.id);
    server.name = identity.serverName;
    server.logoVersion = identity.logoVersion;
    await this.#persist();
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  listMembers(serverId: string): Promise<TeamMemberSummary[]> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      return this.#webrtcTransport.listMembers(serverId).then((members) =>
        members.map((member) => ({
          id: member.membershipId,
          username: member.email,
          email: member.email,
          name: member.name,
          avatarUrl: member.avatarUrl,
          role: member.role,
          createdAt: new Date(member.createdAt).toISOString(),
          disabled: member.status !== "active",
        })),
      );
    }
    return this.request("/v1/team/members", {}, serverId, decodeTeamMembers);
  }

  updateMember(serverId: string, input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      const transport = this.#webrtcTransport;
      return (async () => {
        const members = await this.listMembers(serverId);
        const current = members.find((member) => member.id === input.memberId);
        if (!current || current.role === "owner") throw new Error("The remote member does not exist.");
        if (input.disabled) await transport.removeMember(serverId, input.memberId);
        else
          await transport.updateMember(serverId, input.memberId, input.role ?? current.role, input.disabled === false);
        const updated = (await this.listMembers(serverId)).find((member) => member.id === input.memberId);
        if (!updated) throw new Error("The remote member does not exist.");
        return updated;
      })();
    }
    return this.request(
      `/v1/team/members/${encodeURIComponent(input.memberId)}`,
      { method: "PATCH", body: { role: input.role, disabled: input.disabled } },
      serverId,
      decodeTeamMember,
    );
  }

  removeMember(serverId: string, memberId: string): Promise<void> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport)
      return this.#webrtcTransport.removeMember(serverId, memberId);
    return this.request(`/v1/team/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }, serverId, decodeVoid);
  }

  listInvites(serverId: string): Promise<TeamInviteSummary[]> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      return this.#webrtcTransport.listInvites(serverId).then((invites) =>
        invites
          .filter((invite) => invite.revokedAt === null)
          .map((invite) => ({
            id: invite.inviteId,
            role: invite.role,
            expiresAt: new Date(invite.expiresAt).toISOString(),
            usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
            email: invite.email,
          })),
      );
    }
    return this.request("/v1/team/invites", {}, serverId, decodeTeamInvites);
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) return this.#webrtcTransport.revokeInvite(inviteId);
    return this.request(`/v1/team/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }, serverId, decodeVoid);
  }

  async createInvite(serverId: string, input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      const transport = this.#webrtcTransport;
      if (!server.fingerprint) throw new Error("The host must connect once before it can create invitations.");
      const invite = await transport.createInvite(serverId, input);
      const result: InviteSummary = {
        id: invite.inviteId,
        role: input.role,
        expiresAt: new Date(invite.expiresAt).toISOString(),
        usedAt: null,
        email: input.email ?? null,
        inviteUrl: createInviteUrl({
          apiUrl: transport.controlPlaneUrl,
          serverId,
          fingerprint: server.fingerprint,
          token: invite.token,
        }),
      };
      if (input.email) {
        try {
          if (!this.#centralAccount.sendTeamInviteEmail) throw new Error("Email delivery is unavailable.");
          await this.#centralAccount.sendTeamInviteEmail({
            email: input.email,
            serverName: server.name,
            inviteUrl: result.inviteUrl,
            role: input.role,
          });
        } catch (error) {
          await transport.revokeInvite(invite.inviteId).catch(() => undefined);
          throw error;
        }
      }
      return result;
    }
    return this.request("/v1/team/invites", { method: "POST", body: input }, serverId, decodeInviteSummary);
  }

  setTyping(input: SetTeamTypingInput, serverId = this.#state.activeServerId): void {
    const server = this.#state.servers.find((candidate) => candidate.id === serverId);
    if (server?.transport === "webrtc-v2") {
      void this.#webrtcTransport?.setTyping(serverId, input.botId, input.typing).catch(() => undefined);
      return;
    }
    const socket = this.#eventSockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeTeamProtocolV1ClientEvent({ type: "team-typing", ...input }));
  }

  listDirectThreads(serverId = this.#state.activeServerId): Promise<DirectThreadSummary[]> {
    return this.request("/v1/direct/threads", {}, serverId, decodeDirectThreadSummaries);
  }

  readDirectConversation(memberId: string, serverId = this.#state.activeServerId): Promise<DirectConversationSnapshot> {
    return this.request(
      `/v1/direct/conversations/${encodeURIComponent(memberId)}`,
      {},
      serverId,
      decodeDirectConversationSnapshot,
    );
  }

  readDirectConversationPage(
    memberId: string,
    anchor: DirectConversationPageAnchor = { type: "latest" },
    limit = 50,
    serverId = this.#state.activeServerId,
  ): Promise<DirectConversationPage> {
    return this.request(
      `/v1/direct/conversations/${encodeURIComponent(memberId)}/page${pageQuery(anchor, limit)}`,
      {},
      serverId,
      decodeDirectConversationPage,
    );
  }

  sendDirectMessage(input: SendDirectMessageInput, serverId = this.#state.activeServerId): Promise<DirectMessage> {
    return this.request("/v1/direct/messages", { method: "POST", body: input }, serverId, decodeDirectMessage);
  }

  markDirectRead(
    input: MarkDirectReadInput,
    serverId = this.#state.activeServerId,
  ): Promise<DirectConversationReadState> {
    return this.request(
      `/v1/direct/conversations/${encodeURIComponent(input.memberId)}/read`,
      { method: "POST", body: { throughSequence: input.throughSequence } },
      serverId,
      decodeDirectConversationReadState,
    );
  }

  setDirectTyping(input: DirectTypingInput, serverId = this.#state.activeServerId): void {
    const server = this.#state.servers.find((candidate) => candidate.id === serverId);
    if (server?.transport === "webrtc-v2") {
      void this.#webrtcTransport?.setDirectTyping(serverId, input.memberId, input.typing).catch(() => undefined);
      return;
    }
    const socket = this.#eventSockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      encodeTeamProtocolV1ClientEvent({
        type: "team-direct-typing",
        recipientMemberId: input.memberId,
        typing: input.typing,
      }),
    );
  }

  async createRemoteDesktopSession(serverId: string): Promise<RemoteDesktopSession> {
    const session = await this.request(
      "/v1/remote-screen/sessions",
      { method: "POST", body: {} },
      serverId,
      decodeRemoteDesktopSession,
    );
    if (this.#requireServer(serverId).transport !== "webrtc-v2") return session;
    if (!this.#remoteViewerProxy) throw new Error("The local remote viewer proxy is unavailable.");
    return {
      ...session,
      viewerUrl: await this.#remoteViewerProxy.viewerUrl(
        serverId,
        `/v1/remote-screen/sessions/${encodeURIComponent(session.id)}/viewer`,
      ),
    };
  }

  async fetchRemoteViewerResource(serverId: string, path: string, init: RequestInit): Promise<Response> {
    const server = this.#requireServer(serverId);
    if (server.transport !== "webrtc-v2") throw new Error("The remote viewer transport is invalid.");
    return this.#fetch(server, new URL(path, server.apiUrl), init);
  }

  closeRemoteDesktopSession(serverId: string, sessionId: string): Promise<void> {
    return this.request(
      `/v1/remote-screen/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      serverId,
      decodeVoid,
    );
  }

  selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
    return this.request("/v1/remote-screen/display", { method: "PUT", body: { displayId } }, serverId, decodeVoid);
  }

  async uploadAttachment(
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    serverId = this.#state.activeServerId,
  ): Promise<DraftAttachment> {
    const server = this.#requireServer(serverId);
    const url = new URL("/v1/attachments", server.apiUrl);
    url.searchParams.set("name", name);
    url.searchParams.set("mime", mimeType || "application/octet-stream");
    const response = await this.#fetch(server, url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    const value = decodeTeamProtocolV1CurrentHttpResponse("POST", url.pathname, response.status, await response.json());
    return addRemotePreviewUrls(decodeDraftAttachment(value), server.id);
  }

  async setAgentAvatar(
    botId: string,
    image: AvatarImageInput | null,
    serverId = this.#state.activeServerId,
  ): Promise<BotSummary> {
    const server = this.#requireServer(serverId);
    const url = new URL(`/v1/agents/${encodeURIComponent(botId)}/avatar`, server.apiUrl);
    const headers = new Headers();
    if (image) headers.set("Content-Type", image.mimeType);
    const response = await this.#fetch(server, url, {
      method: image ? "PUT" : "DELETE",
      headers,
      body: image ? Buffer.from(image.bytes) : undefined,
    });
    const value = decodeTeamProtocolV1CurrentHttpResponse(
      image ? "PUT" : "DELETE",
      url.pathname,
      response.status,
      await response.json(),
    );
    return addRemotePreviewUrls(decodeBotSummary(value), server.id);
  }

  async downloadAgentAvatar(
    botId: string,
    serverId = this.#state.activeServerId,
    version?: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const server = this.#requireServer(serverId);
    const url = new URL(`/v1/agents/${encodeURIComponent(botId)}/avatar`, server.apiUrl);
    if (version) url.searchParams.set("v", version);
    const response = await this.#fetch(server, url);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async downloadServerLogo(serverId: string, version: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const server = this.#requireServer(serverId);
    if (server.logoVersion !== version) throw new Error("Server logo version is not current.");
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      const logo = await this.#webrtcTransport.downloadHostLogo(serverId, version);
      if (!isValidAvatarImage(logo.mimeType, logo.bytes)) throw new Error("Server logo response is invalid.");
      return logo;
    }
    const url = new URL("/v1/team/logo", server.apiUrl);
    url.searchParams.set("v", version);
    const response = await this.#fetch(server, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!isValidAvatarImage(mimeType, bytes)) throw new Error("Server logo response is invalid.");
    return { bytes, mimeType };
  }

  async downloadAttachment(
    attachmentId: string,
    serverId = this.#state.activeServerId,
  ): Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }> {
    const server = this.#requireServer(serverId);
    const response = await this.#fetch(server, `${server.apiUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: encodedName ? decodeURIComponent(encodedName) : attachmentId,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async downloadSharedFile(
    sharedPath: string,
    serverId = this.#state.activeServerId,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const server = this.#requireServer(serverId);
    const url = new URL("/v1/shared-files", server.apiUrl);
    url.searchParams.set("path", sharedPath);
    const response = await this.#fetch(server, url);
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: encodedName ? decodeURIComponent(encodedName) : "shared-file",
    };
  }

  async downloadWorkspaceFile(
    botId: string,
    workspacePath: string,
    serverId = this.#state.activeServerId,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const server = this.#requireServer(serverId);
    const url = new URL("/v1/workspace-files", server.apiUrl);
    url.searchParams.set("botId", botId);
    url.searchParams.set("path", workspacePath);
    const response = await this.#fetch(server, url);
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: encodedName ? decodeURIComponent(encodedName) : "workspace-file",
    };
  }

  async stop(): Promise<void> {
    this.#eventsEnabled = false;
    for (const controller of this.#eventControllers.values()) controller.abort();
    this.#eventControllers.clear();
    for (const timer of this.#eventReconnectTimers.values()) clearTimeout(timer);
    this.#eventReconnectTimers.clear();
    this.#eventReconnectAttempts.clear();
    this.#webrtcConnectionAttempts.clear();
    this.#eventAuthenticationPaused.clear();
    this.#eventGenerations.clear();
    this.#conversationRefreshRequests.clear();
    this.#queueRefreshRequests.clear();
    this.#compatibilityRequests.clear();
    await this.#remoteViewerProxy?.stop().catch(() => undefined);
    await this.#webrtcTransport?.stop().catch(() => undefined);
  }

  async disconnectRemoteSessions(): Promise<void> {
    if (!this.#webrtcTransport) return;
    await Promise.all(
      this.#state.servers
        .filter((server) => server.transport === "webrtc-v2")
        .map((server) => this.#webrtcTransport?.disconnect(server.id)),
    );
  }

  async #syncWebRtcHosts(): Promise<void> {
    if (!this.#webrtcTransport) return;
    const hosts = await this.#webrtcTransport.listHosts();
    const synchronizedServers = hosts
      .filter((host) => host.hostId !== this.#getLocalHostId())
      .map<StoredRemoteServer>((host) => {
        const existing = this.#state.servers.find((server) => server.id === host.hostId);
        const advertisedFingerprint = host.devicePublicKey ? fingerprint(host.devicePublicKey) : "";
        const pinnedFingerprint = existing?.transport === "webrtc-v2" ? existing.fingerprint : "";
        const publicKey =
          existing?.transport === "webrtc-v2" && existing.publicKey
            ? existing.publicKey
            : !pinnedFingerprint || pinnedFingerprint === advertisedFingerprint
              ? host.devicePublicKey
              : null;
        if (publicKey) this.#webrtcTransport?.pinHostKey(host.hostId, publicKey);
        return {
          id: host.hostId,
          name: host.name,
          apiUrl: `webrtc://${host.hostId}`,
          fingerprint: pinnedFingerprint || advertisedFingerprint,
          ...(publicKey ? { publicKey } : {}),
          username: this.#centralAccount.getEmail().trim().toLowerCase(),
          encryptedToken: "",
          remoteDesktopAvailable: false,
          logoVersion: host.logoKey,
          role: host.role,
          transport: "webrtc-v2",
        };
      });
    const synchronizedById = new Map(synchronizedServers.map((server) => [server.id, server]));
    const retainedIds = new Set<string>();
    const servers = this.#state.servers.flatMap((server) => {
      if (server.transport !== "webrtc-v2") return this.#allowLocalDevelopmentInvites ? [server] : [];
      const synchronized = synchronizedById.get(server.id);
      if (!synchronized) return [];
      retainedIds.add(server.id);
      return [synchronized];
    });
    for (const server of synchronizedServers) {
      if (retainedIds.has(server.id)) continue;
      retainedIds.add(server.id);
      servers.push(server);
    }
    const currentHostIds = new Set(servers.map((server) => server.id));
    const removedHostIds = this.#state.servers
      .filter((server) => server.transport === "webrtc-v2" && !currentHostIds.has(server.id))
      .map((server) => server.id);
    for (const serverId of removedHostIds) {
      await this.#webrtcTransport.disconnect(serverId).catch(() => undefined);
      this.#clearServerConnectionState(serverId);
    }
    this.#state.servers = servers;
    if (
      this.#state.activeServerId !== "local" &&
      !this.#state.servers.some((server) => server.id === this.#state.activeServerId)
    ) {
      this.#state.activeServerId = "local";
    }
    await this.#persist();
  }

  #webrtcCompatibility(): ServerCompatibility {
    return {
      localAppVersion: this.#appVersion ?? "0.0.0",
      hostAppVersion: null,
      localProtocol: LOCAL_TEAM_PROTOCOL,
      hostProtocol: { minimum: 2, maximum: 2 },
      negotiatedProtocol: 2,
      capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
    };
  }

  #handleWebRtcEvent(serverId: string, event: AgentEvent | TeamRealtimeEvent): void {
    if (event.type === "team-identity") {
      const server = this.#state.servers.find((candidate) => candidate.id === serverId);
      if (server) {
        server.name = event.serverName;
        server.logoVersion = event.logoVersion;
        void this.#persist().then(() => this.#emitChanged());
      }
    } else if (event.type === "team-presence") {
      this.#presence.set(serverId, event.snapshot);
      this.emit("presence", serverId, structuredClone(event.snapshot));
    } else if (event.type === "team-direct-message") this.emit("directMessage", serverId, event);
    else if (event.type === "team-direct-typing") this.emit("directTyping", serverId, event);
    else this.#forwardAgentEvent(serverId, event);
  }

  #checkingCompatibility(): ServerCompatibility {
    return {
      localAppVersion: this.#appVersion ?? "0.0.0",
      hostAppVersion: null,
      localProtocol: LOCAL_TEAM_PROTOCOL,
      hostProtocol: null,
      negotiatedProtocol: null,
      capabilities: [],
    };
  }

  #requestProtocol(compatibility: ServerCompatibility): {
    protocol?: number;
    appVersion?: string;
    capabilities?: readonly TeamProtocolV1Capability[];
  } {
    return {
      protocol: compatibility.negotiatedProtocol ?? undefined,
      appVersion: this.#appVersion ?? undefined,
      capabilities: this.#appVersion ? TEAM_PROTOCOL_V1_CAPABILITIES : undefined,
    };
  }

  async #fetch(server: StoredRemoteServer, input: string | URL, init: RequestInit = {}): Promise<Response> {
    try {
      if (server.transport === "webrtc-v2") {
        if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
        const url = new URL(input);
        try {
          const response = await this.#webrtcTransport.requestResponse(server.id, `${url.pathname}${url.search}`, {
            method: init.method,
            body: init.body,
            contentType: new Headers(init.headers).get("Content-Type") ?? undefined,
          });
          const headers = new Headers();
          if (response.file) {
            headers.set("Content-Type", response.file.mimeType);
            headers.set(
              "Content-Disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(response.file.name)}`,
            );
            return new Response(Buffer.from(response.file.bytes), { status: response.status, headers });
          }
          headers.set("Content-Type", "application/json");
          return new Response(response.status === 204 ? null : JSON.stringify(response.body), {
            status: response.status,
            headers,
          });
        } catch (error) {
          if (error instanceof TeamWebRtcRequestError)
            throw new RemoteRequestError(error.status, error.message, error.code);
          throw error;
        }
      }
      const compatibility = await this.#ensureCompatibility(server);
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.#token(server)}`);
      headers.set(TEAM_PROTOCOL_VERSION_HEADER, String(compatibility.negotiatedProtocol));
      if (this.#appVersion) {
        headers.set(TEAM_APP_VERSION_HEADER, this.#appVersion);
        headers.set(TEAM_CAPABILITIES_HEADER, TEAM_PROTOCOL_V1_CAPABILITIES.join(","));
      }
      const response = await remoteFetch(input, { ...init, headers });
      if (!response.ok) {
        const method = init.method ?? "GET";
        const path = new URL(input).pathname;
        let body: unknown;
        try {
          body = await response.clone().json();
        } catch (error) {
          if (response.headers.get("content-type")?.toLowerCase().includes("json")) {
            throw new RemoteProtocolError(
              "protocol_error",
              "The host returned data that this app could not safely use.",
              null,
              { cause: error },
            );
          }
          throw new RemoteRequestError(response.status, `Remote server request failed (${response.status}).`);
        }
        try {
          const value = decodeTeamProtocolV1CurrentHttpResponse(method, path, response.status, body);
          if (!isDynamicRecord(value) || !isString(value.error)) throw new Error("Invalid error envelope.");
          throw new RemoteRequestError(response.status, value.error, isString(value.code) ? value.code : null);
        } catch (error) {
          if (error instanceof RemoteRequestError) throw error;
          throw new RemoteProtocolError(
            "protocol_error",
            "The host returned data that this app could not safely use.",
            null,
            { cause: error },
          );
        }
      }
      return response;
    } catch (error) {
      this.#applyConnectionError(server.id, error);
      throw error;
    }
  }

  async #ensureCompatibility(server: StoredRemoteServer, refresh = false): Promise<ServerCompatibility> {
    if (server.transport === "webrtc-v2") return this.#webrtcCompatibility();
    const current = this.#compatibility.get(server.id);
    const issue = this.#issues.get(server.id);
    if (
      !refresh &&
      (issue?.code === "client_update_required" ||
        issue?.code === "host_update_required" ||
        issue?.code === "protocol_error")
    ) {
      throw new RemoteProtocolError(
        issue.code,
        issue.message,
        current?.hostAppVersion && current.hostProtocol
          ? {
              appVersion: current.hostAppVersion,
              protocol: current.hostProtocol,
              capabilities: current.capabilities,
            }
          : null,
      );
    }
    if (!this.#appVersion) {
      const compatibility = this.#assumedCompatibility();
      this.#compatibility.set(server.id, compatibility);
      return compatibility;
    }
    if (!refresh && current?.negotiatedProtocol) return current;
    const pending = this.#compatibilityRequests.get(server.id);
    if (pending) return pending;
    const request = this.#negotiateCompatibility(server.apiUrl)
      .then((compatibility) => {
        this.#compatibility.set(server.id, compatibility);
        this.#issues.delete(server.id);
        return compatibility;
      })
      .finally(() => {
        if (this.#compatibilityRequests.get(server.id) === request) this.#compatibilityRequests.delete(server.id);
      });
    this.#compatibilityRequests.set(server.id, request);
    return request;
  }

  async #negotiateCompatibility(apiUrl: string): Promise<ServerCompatibility> {
    if (!this.#appVersion) return this.#assumedCompatibility();
    let host: TeamProtocolSupportV1;
    try {
      host = await requestJson(apiUrl, "/v1/compatibility", decodeTeamProtocolSupportV1);
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status === 404) {
        throw new RemoteProtocolError("host_update_required", "Update OpenBot on the host before connecting.");
      }
      if (error instanceof SyntaxError || (error instanceof RemoteProtocolError && error.code === "protocol_error")) {
        throw new RemoteProtocolError("protocol_error", "The host returned invalid compatibility information.");
      }
      throw error;
    }
    const negotiatedProtocol = highestCommonTeamProtocol(LOCAL_TEAM_PROTOCOL, host.protocol);
    if (negotiatedProtocol === null) {
      if (teamProtocolUpdateDirection(LOCAL_TEAM_PROTOCOL, host.protocol) === "client_update_required") {
        throw new RemoteProtocolError(
          "client_update_required",
          "Update this OpenBot app before connecting to the host.",
          host,
        );
      }
      throw new RemoteProtocolError("host_update_required", "Update OpenBot on the host before connecting.", host);
    }
    return {
      localAppVersion: this.#appVersion ?? "0.0.0",
      hostAppVersion: host.appVersion,
      localProtocol: LOCAL_TEAM_PROTOCOL,
      hostProtocol: host.protocol,
      negotiatedProtocol,
      capabilities: host.capabilities,
    };
  }

  #assumedCompatibility(): ServerCompatibility {
    return {
      ...this.#checkingCompatibility(),
      hostAppVersion: "0.0.0",
      hostProtocol: LOCAL_TEAM_PROTOCOL,
      negotiatedProtocol: TEAM_PROTOCOL_V1,
      capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
    };
  }

  #applyConnectionError(serverId: string, error: unknown, fallbackState: ServerSummary["state"] | null = null): void {
    let issue: ServerConnectionIssue | null = null;
    let state: ServerSummary["state"] | null = null;
    let pauseReconnect = false;
    if (error instanceof RemoteProtocolError) {
      if (error.support) {
        this.#compatibility.set(serverId, {
          ...this.#checkingCompatibility(),
          hostAppVersion: error.support.appVersion,
          hostProtocol: error.support.protocol,
          capabilities: error.support.capabilities,
        });
      }
      issue = { code: error.code, message: error.message, retryable: true };
      state = error.code === "protocol_error" ? "error" : "incompatible";
      pauseReconnect = true;
    } else if (error instanceof RemoteRequestError) {
      if (error.code === "client_update_required" || error.code === "host_update_required") {
        issue = { code: error.code, message: error.message, retryable: true };
        state = "incompatible";
        pauseReconnect = true;
      } else if (error.code === "protocol_error") {
        issue = { code: "protocol_error", message: error.message, retryable: true };
        state = "error";
        pauseReconnect = true;
      } else if (error.status === 401) {
        issue = { code: "authentication_required", message: "Sign in to this host again.", retryable: true };
        state = "error";
        pauseReconnect = true;
      }
    } else if (error instanceof SyntaxError) {
      issue = { code: "protocol_error", message: "The host returned invalid data.", retryable: true };
      state = "error";
      pauseReconnect = true;
    } else if (error instanceof TypeError) {
      issue = { code: "network_unavailable", message: "The host is not reachable.", retryable: true };
      state = "offline";
    }
    state ??= fallbackState;
    if (issue) this.#issues.set(serverId, issue);
    if (state) this.#states.set(serverId, state);
    if (pauseReconnect) {
      this.#eventAuthenticationPaused.add(serverId);
      this.#eventControllers.get(serverId)?.abort();
      this.#eventControllers.delete(serverId);
      this.#eventSockets.delete(serverId);
    }
    this.#emitChanged();
  }

  async #verifyIdentity(
    apiUrl: string,
    serverId: string,
    expectedFingerprint: string,
  ): Promise<{
    publicKey: string;
    serverName: string;
    logoVersion: string | null;
    compatibility: ServerCompatibility;
  }> {
    const compatibility = await this.#negotiateCompatibility(apiUrl);
    const challenge = randomBytes(24).toString("base64url");
    const proof = await requestJson(
      apiUrl,
      `/v1/identity?challenge=${encodeURIComponent(challenge)}`,
      decodeIdentityProof,
      {
        ...this.#requestProtocol(compatibility),
      },
    );
    const valid =
      proof.serverId === serverId &&
      proof.challenge === challenge &&
      proof.fingerprint === expectedFingerprint &&
      fingerprint(proof.publicKey) === expectedFingerprint &&
      verify(null, Buffer.from(challenge), proof.publicKey, Buffer.from(proof.signature, "base64url"));
    if (!valid) throw new Error("The server identity could not be verified.");
    return {
      publicKey: proof.publicKey,
      serverName: proof.serverName,
      logoVersion: proof.logoVersion,
      compatibility,
    };
  }

  async #refreshRemoteDesktop(server: StoredRemoteServer): Promise<void> {
    try {
      const compatibility = await this.#ensureCompatibility(server);
      if (!compatibility.capabilities.includes("remote-desktop")) {
        server.remoteDesktopAvailable = false;
        return;
      }
      let capabilities: RemoteDesktopCapabilities;
      if (server.transport === "webrtc-v2") {
        if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
        capabilities = decodeRemoteDesktopCapabilities(
          await this.#webrtcTransport.request(server.id, "/v1/remote-screen/capabilities", {}),
        );
      } else {
        capabilities = await requestJson(
          server.apiUrl,
          "/v1/remote-screen/capabilities",
          decodeRemoteDesktopCapabilities,
          {
            token: this.#token(server),
            ...this.#requestProtocol(compatibility),
          },
        );
      }
      server.remoteDesktopAvailable = capabilities.ready;
    } catch (error) {
      if (error instanceof RemoteRequestError && [404, 426, 503].includes(error.status)) {
        server.remoteDesktopAvailable = false;
        return;
      }
      throw error;
    }
  }

  async #connectEvents(serverId: string): Promise<void> {
    if (!this.#eventsEnabled || this.#eventControllers.has(serverId)) return;
    const server = this.#requireServer(serverId);
    if (server.transport === "webrtc-v2") return;
    const controller = new AbortController();
    this.#eventControllers.set(serverId, controller);
    let opened = false;
    let openedAt = 0;
    let authenticationFailed = false;
    let protocolFailed = false;
    try {
      const compatibility = await this.#ensureCompatibility(server, true);
      if (
        controller.signal.aborted ||
        !this.#eventsEnabled ||
        !this.#state.servers.some((candidate) => candidate.id === serverId)
      ) {
        if (this.#eventControllers.get(serverId) === controller) this.#eventControllers.delete(serverId);
        return;
      }
      const eventsUrl = new URL("/v1/events", server.apiUrl);
      eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
      const socketProtocols = this.#appVersion
        ? [TEAM_PROTOCOL_V1_WEBSOCKET, `openbot-token.${this.#token(server)}`]
        : [REMOTE_EVENT_SNAPSHOT_PROTOCOL, REMOTE_EVENT_PROTOCOL, `openbot-token.${this.#token(server)}`];
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
            this.#eventSockets.set(serverId, socket);
            this.#sendEventScope(serverId, socket);
            this.#compatibility.set(serverId, compatibility);
            this.#issues.delete(serverId);
            this.#eventAuthenticationPaused.delete(serverId);
            this.#connectionSequences.set(serverId, (this.#connectionSequences.get(serverId) ?? 0) + 1);
            this.#states.set(serverId, "online");
            this.#emitChanged();
            if (this.#supportsRuntimeSnapshots(serverId, socket)) {
              agentEventsReady = true;
            } else {
              void this.#refreshAgentStateFallback(serverId)
                .then(() => {
                  if (this.#eventSockets.get(serverId) !== socket) return;
                  agentEventsReady = true;
                  for (const event of bufferedAgentEvents) this.#forwardAgentEvent(serverId, event, true);
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
            this.#applyConnectionError(
              serverId,
              new RemoteProtocolError("protocol_error", "The host sent a binary event."),
            );
            socket.close(1003, "Text event payloads are required");
            return;
          }
          if (Buffer.byteLength(message.data) > REMOTE_EVENT_PAYLOAD_LIMIT) {
            protocolFailed = true;
            this.#applyConnectionError(
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
              this.#applyConnectionError(
                serverId,
                new RemoteProtocolError("protocol_error", "The host returned an invalid known event."),
              );
              socket.close(1003, "Invalid known event payload");
              return;
            }
            const event = decoded.event;
            if (event.type === "team-identity") {
              server.name = event.serverName;
              server.logoVersion = event.logoVersion;
              void this.#persist().then(() => this.#emitChanged());
            } else if (event.type === "team-presence") {
              this.#presence.set(serverId, event.snapshot);
              this.emit("presence", serverId, structuredClone(event.snapshot));
            } else if (event.type === "team-direct-message") {
              this.emit("directMessage", serverId, event);
            } else if (event.type === "team-direct-typing") {
              this.emit("directTyping", serverId, event);
            } else {
              if (!agentEventsReady) {
                if (bufferedAgentEvents.length >= REMOTE_EVENT_INITIAL_BUFFER_LIMIT) {
                  socket.close(1013, "Initial agent event buffer is full");
                  return;
                }
                bufferedAgentEvents.push(event);
              } else {
                this.#forwardAgentEvent(serverId, event);
              }
            }
          } catch {
            protocolFailed = true;
            this.#applyConnectionError(
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
            if (this.#eventSockets.get(serverId) === socket) {
              this.#eventSockets.delete(serverId);
            }
            resolve();
          },
          { once: true },
        );
      });
      if (!controller.signal.aborted && !protocolFailed) {
        this.#states.set(serverId, "offline");
        this.#setPresenceOffline(serverId);
        this.#emitChanged();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof RemoteProtocolError) {
          protocolFailed = true;
          this.#applyConnectionError(serverId, error);
        } else {
          authenticationFailed = !opened && (await this.#hasRejectedEventCredentials(server));
          if (authenticationFailed) {
            this.#applyConnectionError(serverId, new RemoteRequestError(401, "Sign in again."));
          } else {
            this.#states.set(serverId, "offline");
            this.#issues.set(serverId, {
              code: "network_unavailable",
              message: "The host is not reachable.",
              retryable: true,
            });
            this.#setPresenceOffline(serverId);
            this.#emitChanged();
          }
        }
      }
    }
    if (this.#eventControllers.get(serverId) === controller) this.#eventControllers.delete(serverId);
    if (openedAt > 0 && Date.now() - openedAt >= REMOTE_EVENT_HEALTHY_MS) {
      this.#eventReconnectAttempts.delete(serverId);
    }
    if (!controller.signal.aborted && !authenticationFailed && !protocolFailed) this.#scheduleEventReconnect(serverId);
  }

  #syncEventScopes(): void {
    for (const [serverId, socket] of this.#eventSockets) this.#sendEventScope(serverId, socket);
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
      encodeTeamProtocolV1ClientEvent({
        type: "agent-event-scope",
        includeConversations: this.#state.activeServerId === serverId,
        ...(this.#appVersion ? { capabilities: TEAM_PROTOCOL_V1_CAPABILITIES } : {}),
      }),
    );
  }

  #ensureEventConnection(serverId: string): void {
    const server = this.#state.servers.find((candidate) => candidate.id === serverId);
    if (server?.transport === "webrtc-v2") {
      if (
        !this.#eventsEnabled ||
        this.#eventReconnectTimers.has(serverId) ||
        this.#eventAuthenticationPaused.has(serverId) ||
        this.#webrtcConnectionAttempts.has(serverId)
      )
        return;
      this.#webrtcConnectionAttempts.add(serverId);
      void this.#webrtcTransport
        ?.connect(serverId)
        .catch(() => this.#scheduleEventReconnect(serverId))
        .finally(() => this.#webrtcConnectionAttempts.delete(serverId));
      return;
    }
    if (
      !server ||
      !this.#eventsEnabled ||
      this.#eventControllers.has(serverId) ||
      this.#eventReconnectTimers.has(serverId) ||
      this.#eventAuthenticationPaused.has(serverId)
    ) {
      return;
    }
    void this.#connectEvents(serverId);
  }

  #restartEventConnection(serverId: string, resetBackoff = false): void {
    this.#eventControllers.get(serverId)?.abort();
    this.#eventControllers.delete(serverId);
    const reconnectTimer = this.#eventReconnectTimers.get(serverId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.#eventReconnectTimers.delete(serverId);
    if (resetBackoff) {
      this.#eventReconnectAttempts.delete(serverId);
      this.#eventAuthenticationPaused.delete(serverId);
    }
    this.#ensureEventConnection(serverId);
  }

  #scheduleEventReconnect(serverId: string): void {
    if (!this.#eventsEnabled || this.#eventReconnectTimers.has(serverId)) return;
    if (!this.#state.servers.some((server) => server.id === serverId)) return;
    if (this.#eventAuthenticationPaused.has(serverId)) return;
    const attempt = (this.#eventReconnectAttempts.get(serverId) ?? 0) + 1;
    this.#eventReconnectAttempts.set(serverId, attempt);
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
      this.#eventReconnectTimers.delete(serverId);
      this.#ensureEventConnection(serverId);
    }, delay);
    this.#eventReconnectTimers.set(serverId, timer);
  }

  async #hasRejectedEventCredentials(server: StoredRemoteServer): Promise<boolean> {
    try {
      const compatibility = await this.#ensureCompatibility(server);
      await requestJson(server.apiUrl, "/v1/me", (value) => decodeRecord(value, "team member"), {
        token: this.#token(server),
        ...this.#requestProtocol(compatibility),
      });
      return false;
    } catch (error) {
      return error instanceof RemoteRequestError && (error.status === 401 || error.status === 403);
    }
  }

  #supportsCapability(serverId: string, capability: TeamProtocolV1Capability): boolean {
    return this.#compatibility.get(serverId)?.capabilities.includes(capability) ?? false;
  }

  #supportsRuntimeSnapshots(serverId: string, socket: WebSocket): boolean {
    return this.#appVersion
      ? this.#supportsCapability(serverId, "agent-runtime-snapshots")
      : socket.protocol === REMOTE_EVENT_SNAPSHOT_PROTOCOL;
  }

  async #refreshAgentStateFallback(serverId: string): Promise<void> {
    const generation = this.#advanceEventGeneration(serverId);
    const bots = await this.request("/v1/agents", {}, serverId, decodeBotSummaries);
    if (this.#eventGenerations.get(serverId) !== generation) return;
    this.emit("agent", serverId, { type: "bots-changed", bots });
    await Promise.all(
      bots.map(async (bot) => {
        try {
          const [page, queue] = await Promise.all([
            this.readAgentConversationPage(bot.id, { type: "latest" }, 1, serverId),
            this.request(`/v1/agents/${encodeURIComponent(bot.id)}/queue`, {}, serverId, decodeQueueSnapshot),
          ]);
          if (this.#eventGenerations.get(serverId) !== generation) return;
          const { pageInfo: _, references: __, readState: ___, ...snapshot } = page;
          this.emit("agent", serverId, { type: "conversation", snapshot });
          this.emit("agent", serverId, { type: "queue-changed", snapshot: queue });
        } catch {
          // A failed bot refresh must not discard the server or other bots.
        }
      }),
    );
  }

  #forwardAgentEvent(serverId: string, event: AgentEvent, bufferedLive = false): void {
    this.#advanceEventGeneration(serverId);
    if (event.type === "conversation-invalidated") {
      void this.#refreshConversationPage(serverId, event.botId, event.revision);
    } else if (event.type === "queue-invalidated") {
      void this.#refreshQueue(serverId, event.botId);
    } else {
      const remoteEvent = addRemotePreviewUrls(event, serverId);
      if (bufferedLive) this.emit("agent", serverId, remoteEvent, true);
      else this.emit("agent", serverId, remoteEvent);
    }
  }

  async #refreshConversationPage(serverId: string, botId: string, revision: number): Promise<void> {
    const key = `${serverId}\0${botId}`;
    const pending = this.#conversationRefreshRequests.get(key);
    if (pending) {
      pending.revision = Math.max(pending.revision, revision);
      return;
    }
    const request = { revision };
    this.#conversationRefreshRequests.set(key, request);
    try {
      while (this.#state.servers.some((server) => server.id === serverId)) {
        const requestedRevision = request.revision;
        let page: ConversationPage;
        try {
          page = await this.readAgentConversationPage(botId, { type: "latest" }, 50, serverId);
        } catch {
          if (request.revision !== requestedRevision) continue;
          return;
        }
        if (page.revision >= request.revision) {
          this.emit("agent", serverId, { type: "conversation-page", page });
          return;
        }
        if (request.revision === requestedRevision) return;
      }
    } finally {
      if (this.#conversationRefreshRequests.get(key) === request) this.#conversationRefreshRequests.delete(key);
    }
  }

  async #refreshQueue(serverId: string, botId: string): Promise<void> {
    const key = `${serverId}\0${botId}`;
    const pending = this.#queueRefreshRequests.get(key);
    if (pending) {
      pending.dirty = true;
      return;
    }
    const request = { dirty: false };
    this.#queueRefreshRequests.set(key, request);
    try {
      do {
        request.dirty = false;
        let snapshot: QueueSnapshot;
        try {
          snapshot = await this.request(
            `/v1/agents/${encodeURIComponent(botId)}/queue`,
            {},
            serverId,
            decodeQueueSnapshot,
          );
        } catch {
          if (request.dirty) continue;
          return;
        }
        if (!this.#state.servers.some((server) => server.id === serverId)) return;
        this.emit("agent", serverId, { type: "queue-changed", snapshot });
      } while (request.dirty);
    } finally {
      if (this.#queueRefreshRequests.get(key) === request) this.#queueRefreshRequests.delete(key);
    }
  }

  #advanceEventGeneration(serverId: string): number {
    const generation = (this.#eventGenerations.get(serverId) ?? 0) + 1;
    this.#eventGenerations.set(serverId, generation);
    return generation;
  }

  #token(server: StoredRemoteServer): string {
    return this.#cipher.decrypt(Buffer.from(server.encryptedToken, "base64"));
  }

  #requireServer(serverId: string): StoredRemoteServer {
    const server = this.#state.servers.find((candidate) => candidate.id === serverId);
    if (!server) throw new Error("Remote server not found.");
    return server;
  }

  async #persist(): Promise<void> {
    const snapshot = structuredClone(this.#state);
    const operation = this.#writeChain.then(async () => {
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#writeChain = operation.catch(() => undefined);
    await operation;
  }

  #emitChanged(): void {
    this.emit("changed", this.list());
  }

  #setPresenceOffline(serverId: string): void {
    const current = this.#presence.get(serverId);
    if (!current) return;
    const snapshot: TeamPresenceSnapshot = {
      ...current,
      members: current.members.map((member) => ({
        ...member,
        online: false,
        typingBotId: null,
      })),
      updatedAt: new Date().toISOString(),
    };
    this.#presence.set(serverId, snapshot);
    this.emit("presence", serverId, structuredClone(snapshot));
  }
}

async function requestJson<T>(
  apiUrl: string,
  path: string,
  decoder: ResponseDecoder<T>,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    protocol?: number;
    appVersion?: string;
    capabilities?: readonly TeamProtocolV1Capability[];
  } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await remoteFetch(new URL(path, apiUrl), {
    method,
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.protocol ? { [TEAM_PROTOCOL_VERSION_HEADER]: String(options.protocol) } : {}),
      ...(options.appVersion ? { [TEAM_APP_VERSION_HEADER]: options.appVersion } : {}),
      ...(options.capabilities ? { [TEAM_CAPABILITIES_HEADER]: options.capabilities.join(",") } : {}),
    },
    body: options.body === undefined ? undefined : encodeTeamProtocolV1CurrentHttpRequest(method, path, options.body),
  });
  let value: unknown;
  if (response.status !== 204) {
    try {
      value = await response.json();
    } catch (error) {
      if (response.ok) throw error;
    }
  }
  if (value !== undefined) {
    try {
      value = decodeTeamProtocolV1CurrentHttpResponse(method, path, response.status, value);
    } catch (error) {
      throw new RemoteProtocolError(
        "protocol_error",
        "The host returned data that this app could not safely use.",
        null,
        { cause: error },
      );
    }
  }
  if (!response.ok) {
    const message =
      isDynamicRecord(value) && isString(value.error)
        ? value.error
        : `Remote server request failed (${response.status}).`;
    const code = isDynamicRecord(value) && isString(value.code) ? value.code : null;
    throw new RemoteRequestError(response.status, message, code);
  }
  try {
    return decoder(value);
  } catch (error) {
    throw new RemoteProtocolError(
      "protocol_error",
      "The host returned data that this app could not safely use.",
      null,
      {
        cause: error,
      },
    );
  }
}

function decodeRecord(value: unknown, label: string): DynamicRecord {
  if (!isDynamicRecord(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function requiredString(record: DynamicRecord, field: string): string {
  const value = record[field];
  if (!isString(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function nullableString(record: DynamicRecord, field: string): string | null {
  const value = record[field];
  if (value === null || isString(value)) return value;
  throw new Error(`Invalid ${field}.`);
}

function requiredNumber(record: DynamicRecord, field: string): number {
  const value = record[field];
  if (!isNumber(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function requiredBoolean(record: DynamicRecord, field: string): boolean {
  const value = record[field];
  if (!isBoolean(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function decodeJoinResult(value: unknown): { member: { role: TeamRole }; sessionToken: string } {
  const record = decodeRecord(value, "join response");
  const member = decodeRecord(record.member, "member");
  const role = member.role;
  if (!isOneOf(["owner", "admin", "member"] as const, role)) {
    throw new Error("Invalid member role.");
  }
  return { member: { role }, sessionToken: requiredString(record, "sessionToken") };
}

function decodeDraftAttachment(value: unknown): DraftAttachment {
  const record = decodeRecord(value, "attachment");
  const kind = record.kind;
  const previewKind = record.previewKind;
  const previewUrl = record.previewUrl;
  if (!isOneOf(["image", "file"] as const, kind)) throw new Error("Invalid attachment kind.");
  if (!isOneOf(["image", "pdf", "text", "none"] as const, previewKind)) {
    throw new Error("Invalid attachment preview kind.");
  }
  if (previewUrl !== null && !isString(previewUrl)) {
    throw new Error("Invalid attachment preview URL.");
  }
  return {
    id: requiredString(record, "id"),
    name: requiredString(record, "name"),
    size: requiredNumber(record, "size"),
    kind,
    mimeType: requiredString(record, "mimeType"),
    previewKind,
    previewUrl,
  };
}

export function decodeBotSummary(value: unknown): BotSummary {
  const record = decodeRecord(value, "agent");
  const model = record.model;
  const reasoningEffort = record.reasoningEffort;
  const avatarSeed = record.avatarSeed;
  const avatarHue = record.avatarHue;
  const provider = record.provider;
  if (!isAgentProvider(provider) || !isAgentModel(model) || !isReasoningEffort(reasoningEffort)) {
    throw new Error("Invalid agent model configuration.");
  }
  if (!isAvatarSeed(avatarSeed) || (avatarHue !== null && !isAvatarHue(avatarHue))) {
    throw new Error("Invalid agent avatar configuration.");
  }
  return {
    id: requiredString(record, "id"),
    provider,
    name: requiredString(record, "name"),
    title: requiredString(record, "title"),
    description: requiredString(record, "description"),
    notifications: requiredBoolean(record, "notifications"),
    model,
    reasoningEffort,
    threadId: nullableString(record, "threadId"),
    workspacePath: requiredString(record, "workspacePath"),
    preview: requiredString(record, "preview"),
    updatedAt: nullableString(record, "updatedAt"),
    avatarSeed,
    avatarHue,
    avatarUrl: record.avatarUrl === undefined ? null : nullableString(record, "avatarUrl"),
  };
}

export function decodeVoid(value: unknown): undefined {
  if (value !== undefined && value !== null) throw new Error("The remote server returned data.");
  return undefined;
}

export function decodeAgentStatus(value: unknown): AgentStatus {
  if (!isAgentStatusValue(value)) {
    throw new Error("Invalid remote agent status.");
  }
  return value;
}

function isAgentStatusValue(value: unknown): value is AgentStatus {
  return (
    isDynamicRecord(value) &&
    isOneOf(["idle", "starting", "ready", "restarting", "blocked", "stopped"] as const, value.phase) &&
    isDynamicRecord(value.auth) &&
    isDynamicRecord(value.capabilities) &&
    isOneOf(["ready", "setup-required", "unavailable"] as const, value.capabilities.chat) &&
    isOneOf(["ready", "setup-required", "unavailable"] as const, value.capabilities.browser) &&
    isOneOf(["ready", "setup-required", "unavailable"] as const, value.capabilities.computerUse) &&
    (value.message === null || isString(value.message)) &&
    value.fullAccess === true
  );
}

export function decodeAccountUsage(value: unknown): AccountUsage {
  if (!isAccountUsageValue(value)) {
    throw new Error("Invalid remote account usage.");
  }
  return value;
}

function isAccountUsageValue(value: unknown): value is AccountUsage {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.limits) &&
    value.limits.every(
      (limit) =>
        isDynamicRecord(limit) &&
        isString(limit.id) &&
        (limit.primary === null || isDynamicRecord(limit.primary)) &&
        (limit.secondary === null || isDynamicRecord(limit.secondary)),
    )
  );
}

export function decodeAgentModelOptions(value: unknown): AgentModelOption[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (model) =>
        isDynamicRecord(model) &&
        isAgentModel(model.id) &&
        isString(model.name) &&
        isString(model.description) &&
        isReasoningEffort(model.defaultReasoningEffort) &&
        Array.isArray(model.supportedReasoningEfforts) &&
        model.supportedReasoningEfforts.every(isReasoningEffort),
    )
  ) {
    throw new Error("Invalid remote agent models.");
  }
  return value;
}

export function decodeBotSummaries(value: unknown): BotSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid remote agent list.");
  return value.map(decodeBotSummary);
}

export function decodeBotMemory(value: unknown): BotMemory {
  if (!isBotMemory(value)) throw new Error("Invalid remote agent memory.");
  return value;
}

export function decodeBotMemories(value: unknown): BotMemory[] {
  if (!Array.isArray(value) || !value.every(isBotMemory)) {
    throw new Error("Invalid remote agent memories.");
  }
  return value;
}

export function decodeRoutine(value: unknown): Routine {
  if (!isRoutine(value)) throw new Error("Invalid remote routine.");
  return value;
}

export function decodeRoutines(value: unknown): Routine[] {
  if (!Array.isArray(value) || !value.every(isRoutine)) throw new Error("Invalid remote routine list.");
  return value;
}

export function decodeRoutineRun(value: unknown): RoutineRun {
  if (!isRoutineRun(value)) throw new Error("Invalid remote routine run.");
  return value;
}

export function decodeRoutineRuns(value: unknown): RoutineRun[] {
  if (!Array.isArray(value) || !value.every(isRoutineRun)) throw new Error("Invalid remote routine history.");
  return value;
}

export function decodeSidebarLayoutSnapshot(value: unknown): SidebarLayoutSnapshot {
  if (!isSidebarLayoutSnapshot(value)) throw new Error("Invalid sidebar layout response.");
  return value;
}

export function decodeQueueSnapshot(value: unknown): QueueSnapshot {
  if (!isQueueSnapshotValue(value)) {
    throw new Error("Invalid remote queue.");
  }
  return value;
}

function isQueueSnapshotValue(value: unknown): value is QueueSnapshot {
  return isDynamicRecord(value) && isString(value.botId) && Array.isArray(value.deliveries);
}

export function decodeQueuedMessageReceipt(value: unknown): QueuedMessageReceipt {
  if (!isQueuedMessageReceiptValue(value)) {
    throw new Error("Invalid remote message receipt.");
  }
  return value;
}

function isQueuedMessageReceiptValue(value: unknown): value is QueuedMessageReceipt {
  return isDynamicRecord(value) && isString(value.messageId) && Array.isArray(value.deliveries);
}

export function decodeBrowserTabs(value: unknown): BrowserTab[] {
  if (!Array.isArray(value) || !value.every(isBrowserTabValue)) {
    throw new Error("Invalid remote browser tabs.");
  }
  return value;
}

export function decodeBrowserTab(value: unknown): BrowserTab {
  if (!isBrowserTabValue(value)) throw new Error("Invalid remote browser tab.");
  return value;
}

export function decodeBrowserPreview(value: unknown): BrowserPreview {
  if (!isBrowserPreviewValue(value)) throw new Error("Invalid remote browser preview.");
  return value;
}

function isBrowserPreviewValue(value: unknown): value is BrowserPreview {
  return (
    isDynamicRecord(value) &&
    isString(value.dataUrl) &&
    value.dataUrl.length <= 2_000_000 &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.dataUrl) &&
    isNumber(value.width) &&
    Number.isSafeInteger(value.width) &&
    value.width > 0 &&
    value.width <= 960 &&
    isNumber(value.height) &&
    Number.isSafeInteger(value.height) &&
    value.height > 0 &&
    value.height <= 600
  );
}

function isBrowserTabValue(value: unknown): value is BrowserTab {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.title) &&
    isString(value.url) &&
    isBoolean(value.loading) &&
    (value.ownerThreadId === null || isString(value.ownerThreadId)) &&
    (value.ownerBotId === null || isString(value.ownerBotId))
  );
}

export function decodeBrowserControlState(value: unknown): BrowserControlState {
  if (!isBrowserControlStateValue(value)) {
    throw new Error("Invalid remote browser control state.");
  }
  return value;
}

function isBrowserControlStateValue(value: unknown): value is BrowserControlState {
  return isDynamicRecord(value) && Array.isArray(value.sessions);
}

function decodeDirectMessage(value: unknown): DirectMessage {
  const record = decodeRecord(value, "direct message");
  return {
    id: requiredString(record, "id"),
    threadId: requiredString(record, "threadId"),
    senderMemberId: requiredString(record, "senderMemberId"),
    recipientMemberId: requiredString(record, "recipientMemberId"),
    text: requiredString(record, "text"),
    createdAt: requiredString(record, "createdAt"),
    sequence: requiredNumber(record, "sequence"),
  };
}

function decodeDirectThreadSummary(value: unknown): DirectThreadSummary {
  const record = decodeRecord(value, "direct thread");
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    lastMessage: decodeDirectMessage(record.lastMessage),
    unreadCount: requiredNumber(record, "unreadCount"),
    updatedAt: requiredString(record, "updatedAt"),
  };
}

function decodeDirectThreadSummaries(value: unknown): DirectThreadSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid direct thread response.");
  return value.map(decodeDirectThreadSummary);
}

function decodeDirectConversationSnapshot(value: unknown): DirectConversationSnapshot {
  const record = decodeRecord(value, "direct conversation");
  const readState = record.readState;
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    messages: decodeDirectMessages(record.messages),
    revision: requiredNumber(record, "revision"),
    ...(readState === undefined ? {} : { readState: decodeDirectConversationReadState(readState) }),
  };
}

function decodeDirectConversationPage(value: unknown): DirectConversationPage {
  const record = decodeRecord(value, "direct conversation page");
  const readState = record.readState;
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    messages: decodeDirectMessages(record.messages),
    revision: requiredNumber(record, "revision"),
    pageInfo: decodePageInfo(record.pageInfo),
    ...(readState === undefined ? {} : { readState: decodeDirectConversationReadState(readState) }),
  };
}

function decodeDirectMessages(value: unknown): DirectMessage[] {
  if (!Array.isArray(value)) throw new Error("Invalid direct-message list.");
  return value.map(decodeDirectMessage);
}

function decodeDirectConversationReadState(value: unknown): DirectConversationReadState {
  const record = decodeRecord(value, "direct read state");
  const firstUnreadMessageId = record.firstUnreadMessageId;
  if (firstUnreadMessageId !== null && !isString(firstUnreadMessageId)) {
    throw new Error("Invalid first unread message.");
  }
  return {
    unreadCount: requiredNumber(record, "unreadCount"),
    firstUnreadMessageId,
    throughSequence: requiredNumber(record, "throughSequence"),
  };
}

export function decodeConversationReadState(value: unknown): ConversationReadState {
  const record = decodeRecord(value, "conversation read state");
  const firstUnreadMessageId = record.firstUnreadMessageId;
  const throughMessageId = record.throughMessageId;
  if (firstUnreadMessageId !== null && !isString(firstUnreadMessageId)) {
    throw new Error("Invalid first unread message.");
  }
  if (throughMessageId !== null && !isString(throughMessageId)) {
    throw new Error("Invalid conversation read boundary.");
  }
  return {
    unreadCount: requiredNumber(record, "unreadCount"),
    firstUnreadMessageId,
    throughMessageId,
  };
}

export function decodeConversationReadStates(value: unknown): Record<string, ConversationReadState> {
  const record = decodeRecord(value, "conversation read states");
  return Object.fromEntries(
    Object.entries(record).map(([botId, state]) => [botId, decodeConversationReadState(state)]),
  );
}

function decodeConversationWithReadState(value: unknown): ConversationWithReadState {
  const event = { type: "conversation", snapshot: value };
  if (!isAgentEvent(event) || event.type !== "conversation") {
    throw new Error("Invalid agent conversation response.");
  }
  const record = decodeRecord(value, "agent conversation");
  return {
    ...event.snapshot,
    readState: decodeConversationReadState(record.readState),
  };
}

function decodeConversationPage(value: unknown): ConversationPage {
  const record = decodeRecord(value, "agent conversation page");
  return {
    botId: requiredString(record, "botId"),
    threadId: nullableString(record, "threadId"),
    activeTurnId: nullableString(record, "activeTurnId"),
    revision: requiredNumber(record, "revision"),
    messages: decodeConversationMessages(record.messages),
    references: decodeConversationReferences(record.references),
    pageInfo: decodePageInfo(record.pageInfo),
    ...(record.readState === undefined ? {} : { readState: decodeConversationReadState(record.readState) }),
  };
}

function decodeConversationSearchPage(value: unknown): ConversationSearchPage {
  const record = decodeRecord(value, "conversation search page");
  if (!Array.isArray(record.results)) throw new Error("Invalid conversation search results.");
  return {
    results: record.results.map((value) => {
      const result = decodeRecord(value, "conversation search result");
      return {
        botId: requiredString(result, "botId"),
        message: decodeConversationMessage(result.message, "conversation search message"),
      };
    }),
    total: requiredNumber(record, "total"),
    nextCursor: nullableString(record, "nextCursor"),
  };
}

function decodeConversationMessages(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value) || !value.every(isConversationMessage)) {
    throw new Error("Invalid conversation page messages.");
  }
  return value;
}

function decodeConversationReferences(value: unknown): Record<string, ConversationMessage> {
  const references = decodeRecord(value, "conversation references");
  const decoded: Record<string, ConversationMessage> = {};
  for (const [messageId, message] of Object.entries(references)) {
    decoded[messageId] = decodeConversationMessage(message, "conversation reference");
  }
  return decoded;
}

function decodeConversationMessage(value: unknown, label: string): ConversationMessage {
  if (!isConversationMessage(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function decodePageInfo(value: unknown): { hasOlder: boolean; olderCursor: string | null } {
  const record = decodeRecord(value, "conversation page info");
  return {
    hasOlder: requiredBoolean(record, "hasOlder"),
    olderCursor: nullableString(record, "olderCursor"),
  };
}

function pageQuery(anchor: ConversationPageAnchor | DirectConversationPageAnchor, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (anchor.type === "before") query.set("before", anchor.cursor);
  if (anchor.type === "around") query.set("around", anchor.messageId);
  return `?${query.toString()}`;
}

function decodeIdentityProof(value: unknown): {
  serverId: string;
  publicKey: string;
  serverName: string;
  fingerprint: string;
  challenge: string;
  signature: string;
  logoVersion: string | null;
} {
  const record = decodeRecord(value, "server identity");
  return {
    serverId: requiredString(record, "serverId"),
    publicKey: requiredString(record, "publicKey"),
    serverName: requiredString(record, "serverName"),
    fingerprint: requiredString(record, "fingerprint"),
    challenge: requiredString(record, "challenge"),
    signature: requiredString(record, "signature"),
    logoVersion: record.logoVersion === undefined ? null : nullableString(record, "logoVersion"),
  };
}

function decodeTeamPresenceSnapshot(value: unknown): TeamPresenceSnapshot {
  const event = { type: "team-presence", snapshot: value };
  if (!isTeamRealtimeEvent(event) || event.type !== "team-presence") {
    throw new Error("Invalid team presence response.");
  }
  return event.snapshot;
}

function decodeTeamMember(value: unknown): TeamMemberSummary {
  const record = decodeRecord(value, "team member");
  const role = requiredString(record, "role");
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Invalid team member role.");
  return {
    id: requiredString(record, "id"),
    username: requiredString(record, "username"),
    email: nullableString(record, "email"),
    name: nullableString(record, "name"),
    avatarUrl: nullableString(record, "avatarUrl"),
    role,
    createdAt: requiredString(record, "createdAt"),
    disabled: requiredBoolean(record, "disabled"),
  };
}

function decodeTeamMembers(value: unknown): TeamMemberSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid team members response.");
  return value.map(decodeTeamMember);
}

function decodeTeamInvite(value: unknown): TeamInviteSummary {
  const record = decodeRecord(value, "team invitation");
  const role = requiredString(record, "role");
  if (role !== "admin" && role !== "member") throw new Error("Invalid invitation role.");
  return {
    id: requiredString(record, "id"),
    role,
    expiresAt: requiredString(record, "expiresAt"),
    usedAt: nullableString(record, "usedAt"),
    email: nullableString(record, "email"),
  };
}

function decodeTeamInvites(value: unknown): TeamInviteSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid team invitations response.");
  return value.map(decodeTeamInvite);
}

function decodeInviteSummary(value: unknown): InviteSummary {
  const record = decodeRecord(value, "invitation");
  return { ...decodeTeamInvite(value), inviteUrl: requiredString(record, "inviteUrl") };
}

function decodeInvitePreview(value: unknown): Pick<InvitePreview, "role" | "expiresAt" | "emailBound"> {
  const record = decodeRecord(value, "invitation preview");
  const role = requiredString(record, "role");
  if (role !== "admin" && role !== "member") throw new Error("Invalid invitation preview response.");
  return {
    role,
    expiresAt: requiredString(record, "expiresAt"),
    emailBound: requiredBoolean(record, "emailBound"),
  };
}

function decodeRemoteDesktopCapabilities(value: unknown): RemoteDesktopCapabilities {
  const record = decodeRecord(value, "remote control capabilities");
  const platform = requiredString(record, "platform");
  if (!isOneOf(["darwin", "win32", "linux"] as const, platform)) throw new Error("Invalid remote platform.");
  return {
    ready: requiredBoolean(record, "ready"),
    platform,
    unattended: requiredBoolean(record, "unattended"),
    runtime: requiredString(record, "runtime") === "sunshine-moonlight" ? "sunshine-moonlight" : invalidRuntime(),
    protocolVersion: requiredNumber(record, "protocolVersion") === 2 ? 2 : invalidProtocolVersion(),
    displays: decodeRemoteDesktopDisplays(record.displays),
    selectedDisplayId: nullableString(record, "selectedDisplayId"),
    activeSessions: requiredNumber(record, "activeSessions"),
    maxSessions: requiredNumber(record, "maxSessions"),
  };
}

function invalidRuntime(): never {
  throw new Error("Invalid remote desktop runtime.");
}

function invalidProtocolVersion(): never {
  throw new Error("Remote desktop update required.");
}

function decodeRemoteDesktopSession(value: unknown): RemoteDesktopSession {
  const record = decodeRecord(value, "remote control session");
  const phase = requiredString(record, "phase");
  const transport = requiredString(record, "transport");
  const errorCode = nullableString(record, "errorCode");
  if (!isOneOf(["starting_host", "connecting", "connected", "disconnecting", "error"] as const, phase)) {
    throw new Error("Invalid remote control phase.");
  }
  if (!isOneOf(["unknown", "p2p", "relay"] as const, transport)) throw new Error("Invalid remote transport.");
  if (
    errorCode !== null &&
    !isOneOf(
      [
        "host_unavailable",
        "host_permissions_required",
        "session_capacity_reached",
        "session_expired",
        "session_revoked",
        "protocol_mismatch",
        "connection_failed",
      ] as const,
      errorCode,
    )
  ) {
    throw new Error("Invalid remote control error.");
  }
  return {
    id: requiredString(record, "id"),
    serverId: requiredString(record, "serverId"),
    viewerUrl: requiredString(record, "viewerUrl"),
    viewerGrant: requiredString(record, "viewerGrant"),
    displays: decodeRemoteDesktopDisplays(record.displays),
    selectedDisplayId: nullableString(record, "selectedDisplayId"),
    phase,
    transport,
    errorCode,
    message: nullableString(record, "message"),
    createdAt: requiredString(record, "createdAt"),
    grantExpiresAt: requiredString(record, "grantExpiresAt"),
  };
}

function decodeRemoteDesktopDisplays(value: unknown): RemoteDesktopCapabilities["displays"] {
  if (!Array.isArray(value)) throw new Error("Invalid remote display list.");
  return value.map((item) => {
    const display = decodeRecord(item, "remote display");
    return {
      id: requiredString(display, "id"),
      label: requiredString(display, "label"),
      width: requiredNumber(display, "width"),
      height: requiredNumber(display, "height"),
      primary: requiredBoolean(display, "primary"),
    };
  });
}

function requiredServerSummary(servers: ServerSummary[], serverId: string): ServerSummary {
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Remote server summary is missing.");
  return server;
}

function readStoredRemoteServers(value: unknown): StoredRemoteServers | null {
  if (!isDynamicRecord(value) || !isString(value.activeServerId) || !Array.isArray(value.servers)) return null;
  if (value.version !== 1 && value.version !== 2 && value.version !== 3) return null;
  const servers: StoredRemoteServer[] = [];
  for (const serverValue of value.servers) {
    const server = readStoredRemoteServer(serverValue);
    if (!server) return null;
    servers.push(server);
  }
  return { version: 3, activeServerId: value.activeServerId, servers };
}

function readStoredRemoteServer(value: unknown): StoredRemoteServer | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.name) ||
    !isString(value.apiUrl) ||
    !isString(value.fingerprint) ||
    !(value.publicKey === undefined || isString(value.publicKey)) ||
    !isString(value.username) ||
    !isString(value.encryptedToken) ||
    !(value.remoteDesktopAvailable === undefined || isBoolean(value.remoteDesktopAvailable)) ||
    !(value.logoVersion === undefined || value.logoVersion === null || isString(value.logoVersion)) ||
    !(value.transport === undefined || value.transport === "webrtc-v2") ||
    !isOneOf(["owner", "admin", "member"] as const, value.role)
  ) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    apiUrl: value.apiUrl,
    fingerprint: value.fingerprint,
    ...(value.publicKey === undefined ? {} : { publicKey: value.publicKey }),
    username: value.username,
    encryptedToken: value.encryptedToken,
    remoteDesktopAvailable: value.remoteDesktopAvailable ?? false,
    ...(value.logoVersion === undefined ? {} : { logoVersion: value.logoVersion }),
    role: value.role,
    ...(value.transport === undefined ? {} : { transport: value.transport }),
  };
}

function remoteFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS) });
}

function isLocalDevelopmentApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function addRemotePreviewUrls<T>(value: T, serverId: string): T {
  if (Array.isArray(value)) {
    for (const item of value) addRemotePreviewUrls(item, serverId);
    return value;
  }
  if (!isDynamicRecord(value)) return value;
  const record = value;
  if ("previewUrl" in record && isString(record.id)) {
    Reflect.set(record, "previewUrl", remoteAttachmentPreviewUrl(serverId, record.id));
  }
  if (isString(record.avatarUrl) && record.avatarUrl.startsWith("openbot-avatar:") && isString(record.id)) {
    Reflect.set(record, "avatarUrl", remoteAgentAvatarUrl(serverId, record.id, record.avatarUrl));
  }
  for (const item of Object.values(record)) addRemotePreviewUrls(item, serverId);
  return value;
}

export function remoteAttachmentPreviewUrl(serverId: string, attachmentId: string): string {
  return `openbot-remote-attachment://${encodeURIComponent(serverId)}/${encodeURIComponent(attachmentId)}`;
}

export function remoteAgentAvatarUrl(serverId: string, botId: string, sourceUrl: string): string {
  const source = new URL(sourceUrl);
  const target = new URL(`openbot-remote-avatar://${encodeURIComponent(serverId)}/${encodeURIComponent(botId)}`);
  target.search = source.search;
  return target.toString();
}

export function remoteServerLogoUrl(serverId: string, version: string): string {
  const target = new URL(`openbot-remote-server-logo://${encodeURIComponent(serverId)}/logo`);
  target.searchParams.set("v", version);
  return target.toString();
}
