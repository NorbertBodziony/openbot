import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { createInviteUrl, parseInviteUrl } from "@openbot/contracts/invite-links";
import type {
  AgentEvent,
  AvatarImageInput,
  BotSummary,
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
  DuplicateBotResult,
  InvitePreview,
  InviteSummary,
  JoinServerInput,
  LoginServerInput,
  MarkConversationReadInput,
  MarkDirectReadInput,
  QueueSnapshot,
  RemoteDesktopSession,
  SendDirectMessageInput,
  ServerSummary,
  SetTeamTypingInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRealtimeEvent,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { decodeRecord } from "@openbot/contracts/ipc-decoding";
import { isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES, type TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { encodeTeamProtocolV1ClientEvent, TEAM_PROTOCOL_V1_WEBSOCKET } from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV1CurrentEvent,
  decodeTeamProtocolV1CurrentHttpResponse,
} from "@openbot/contracts/team-protocol/v1-adapter";
import {
  decodeBotSummaries,
  decodeBotSummary,
  decodeDraftAttachment,
  decodeDuplicateBotResultFromHost,
  decodeQueueSnapshot,
} from "./remote-agent-decoding";
import {
  decodeConversationPageFromHost,
  decodeConversationReadState,
  decodeConversationReadStates,
  decodeConversationSearchPageFromHost,
  decodeConversationWithReadState,
  decodeDirectConversationPage,
  decodeDirectConversationReadState,
  decodeDirectConversationSnapshot,
  decodeDirectMessage,
  decodeDirectThreadSummaries,
} from "./remote-conversation-decoding";
import { decodeRemoteDesktopSession } from "./remote-device-decoding";
import { decodeVoid, type ResponseDecoder } from "./remote-host-decoding";
import { type RemoteRequestInit, RemoteServerClient } from "./remote-server-client";
import { RemoteServerConnections } from "./remote-server-connections";
import { RemoteProtocolError, RemoteRequestError } from "./remote-server-errors";
import { reconcileWebRtcHosts } from "./remote-server-host-directory";
import { requestJson } from "./remote-server-http";
import { RemoteServerStore, type StoredRemoteServerView, type TokenCipher } from "./remote-server-store";
import type { StoredRemoteServer } from "./remote-server-stored-shape";
import { remoteServerSummaries } from "./remote-server-summaries";
import { addRemotePreviewUrls, isLocalDevelopmentApi, pageQuery } from "./remote-server-urls";
import {
  decodeInvitePreview,
  decodeInviteSummary,
  decodeJoinResult,
  decodeTeamInvites,
  decodeTeamMember,
  decodeTeamMembers,
  decodeTeamPresenceSnapshot,
} from "./remote-team-decoding";
import { RemoteViewerProxy } from "./remote-viewer-proxy";
import { fingerprint } from "./team-store";
import {
  TEAM_WEBRTC_REMOTE_REQUEST_TIMEOUT_MILLISECONDS,
  type TeamWebRtcClientTransport,
} from "./team-webrtc-client-transport";

interface RemoteServerEvents {
  changed: [servers: ServerSummary[]];
  agent: [serverId: string, event: AgentEvent, bufferedLive?: boolean];
  presence: [serverId: string, snapshot: TeamPresenceSnapshot];
  directMessage: [serverId: string, event: DirectMessageRealtimeEvent];
  directTyping: [serverId: string, event: DirectTypingRealtimeEvent];
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

export const REMOTE_DUPLICATION_TIMEOUT_MS = TEAM_WEBRTC_REMOTE_REQUEST_TIMEOUT_MILLISECONDS;
const REMOTE_EVENT_RECONNECT_BASE_MS = 1_000;
const REMOTE_EVENT_RECONNECT_MAX_MS = 60_000;
const REMOTE_EVENT_RECONNECT_JITTER = 0.2;
const REMOTE_EVENT_HEALTHY_MS = 30_000;
const REMOTE_EVENT_PAYLOAD_LIMIT = 1024 * 1024;
const REMOTE_EVENT_INITIAL_BUFFER_LIMIT = 1_000;
const REMOTE_EVENT_PROTOCOL = "openbot-events";
const REMOTE_EVENT_SNAPSHOT_PROTOCOL = "openbot-events-v2";

export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #store: RemoteServerStore;
  readonly #connections: RemoteServerConnections;
  readonly #client: RemoteServerClient;
  readonly #centralAccount: CentralAccountSession;
  readonly #allowLocalDevelopmentInvites: boolean;
  readonly #appVersion: string | null;
  #eventControllers = new Map<string, AbortController>();
  #eventSockets = new Map<string, WebSocket>();
  #eventReconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #eventReconnectAttempts = new Map<string, number>();
  #webrtcConnectionAttempts = new Set<string>();
  #conversationRefreshRequests = new Map<string, { revision: number }>();
  #queueRefreshRequests = new Map<string, { dirty: boolean }>();
  #duplicateOperationIds = new Map<string, string>();
  #eventAuthenticationPaused = new Set<string>();
  #eventGenerations = new Map<string, number>();
  #eventsEnabled = false;
  readonly #webrtcTransport: TeamWebRtcClientTransport | null;
  readonly #getLocalHostId: () => string | null;
  readonly #remoteViewerProxy: RemoteViewerProxy | null;
  #presence = new Map<string, TeamPresenceSnapshot>();
  #selectChain = Promise.resolve();

  constructor(
    path: string,
    cipher: TokenCipher,
    centralAccount: CentralAccountSession,
    options: RemoteServerManagerOptions = {},
  ) {
    super();
    this.#store = new RemoteServerStore({ path, cipher });
    this.#appVersion = options.appVersion ?? null;
    this.#connections = new RemoteServerConnections({
      appVersion: this.#appVersion,
      onChanged: () => this.#emitChanged(),
      // The registry never names the event stream. It reports that reconnecting is pointless and the
      // manager decides what that costs -- which is what keeps the socket out of the error path.
      onReconnectSuspended: (serverId) => this.#suspendEventReconnect(serverId),
    });
    this.#centralAccount = centralAccount;
    this.#allowLocalDevelopmentInvites = options.allowLocalDevelopmentInvites ?? false;
    this.#webrtcTransport = options.webrtcTransport ?? null;
    this.#getLocalHostId = options.getLocalHostId ?? (() => null);
    this.#client = new RemoteServerClient({
      appVersion: this.#appVersion,
      servers: this.#store,
      connections: this.#connections,
      transport: this.#webrtcTransport,
    });
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
      this.#connections.markConnected(serverId);
      this.#emitChanged();
      void this.#client
        .refreshWebRtcCompatibility(serverId)
        .then(() => this.#emitChanged())
        .catch(() => undefined);
      const server = this.#store.find(serverId);
      if (server) {
        void this.#client
          .probeRemoteDesktop(server)
          .catch(() => false)
          .then((remoteDesktopAvailable) => this.#store.update(serverId, { remoteDesktopAvailable }))
          .then(() => this.#emitChanged())
          .catch(() => undefined);
      }
    });
    this.#webrtcTransport?.on("disconnected", (serverId) => {
      this.#connections.setState(serverId, "offline");
      this.#setPresenceOffline(serverId);
      this.#emitChanged();
      this.#scheduleEventReconnect(serverId);
    });
    this.#webrtcTransport?.on("event", (serverId, event) => this.#handleWebRtcEvent(serverId, event));
    this.#webrtcTransport?.on("error", (serverId, code, message) => {
      if (!this.#connections.reportTransportError(serverId, code, message)) this.#scheduleEventReconnect(serverId);
    });
  }

  async initialize(): Promise<void> {
    await this.#store.load();
    if (this.#webrtcTransport) await this.#syncWebRtcHosts().catch(() => undefined);
    for (const server of this.#store.servers) {
      this.#connections.setState(server.id, "offline");
      if (server.transport === "webrtc-v2") this.#connections.startCheckingCompatibility(server.id);
    }
  }

  list(): ServerSummary[] {
    return remoteServerSummaries(this.#store.servers, this.#store.activeServerId, (serverId) =>
      this.#connections.statusFor(serverId),
    );
  }

  async syncRemoteHosts(): Promise<ServerSummary[]> {
    await this.#syncWebRtcHosts();
    if (this.#eventsEnabled) this.startEventConnections();
    this.#emitChanged();
    return this.list();
  }

  get activeServerId(): string {
    return this.#store.activeServerId;
  }

  startEventConnections(): void {
    this.#eventsEnabled = true;
    for (const server of this.#store.servers) this.#ensureEventConnection(server.id);
  }

  refreshRuntimeSnapshots(): void {
    for (const server of this.#store.servers) {
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

  select(serverId: string): Promise<ServerSummary[]> {
    const operation = this.#selectChain.then(async () => {
      if (serverId !== LOCAL_SERVER_ID && !this.#store.has(serverId)) {
        throw new Error("Remote server not found.");
      }
      const previousServerId = this.#store.activeServerId;
      const selectionRevision = this.#store.setActiveServerId(serverId);
      this.#syncEventScopes();
      try {
        await this.#store.persist();
      } catch (error) {
        if (this.#store.activeServerRevision === selectionRevision) {
          this.#store.setActiveServerId(previousServerId);
          this.#syncEventScopes();
        }
        throw error;
      }
      this.#emitChanged();
      this.startEventConnections();
      return this.list();
    });
    this.#selectChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async reorder(serverIds: string[]): Promise<ServerSummary[]> {
    if (await this.#store.reorder(serverIds)) this.#emitChanged();
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
      await this.#store.unhideHost(accepted.hostId);
      await this.#syncWebRtcHosts();
      const synchronized = this.#store.find(accepted.hostId);
      if (!synchronized || synchronized.fingerprint !== invite.fingerprint) {
        throw new Error("The invitation host identity changed while it was accepted.");
      }
      this.#store.setActiveServerId(accepted.hostId);
      this.#connections.setState(accepted.hostId, "connecting");
      await this.#store.persist();
      await this.#webrtcTransport.connect(accepted.hostId);
      this.#emitChanged();
      return requiredServerSummary(this.list(), accepted.hostId);
    }
    const verifiedIdentity = await this.#client.verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const accountTicket = await this.#centralAccount.createTeamAuthTicket(invite.serverId);
    const result = await requestJson(invite.apiUrl, TEAM_API_ROUTES.join.account, decodeJoinResult, {
      method: "POST",
      body: {
        inviteToken: invite.token,
        accountTicket,
      },
      ...this.#client.requestProtocol(verifiedIdentity.compatibility),
    });
    const stored: StoredRemoteServer = {
      id: invite.serverId,
      name: verifiedIdentity.serverName,
      apiUrl: invite.apiUrl,
      fingerprint: invite.fingerprint,
      publicKey: verifiedIdentity.publicKey,
      username: this.#centralAccount.getEmail().trim().toLowerCase(),
      encryptedToken: this.#store.sealToken(result.sessionToken),
      remoteDesktopAvailable: false,
      logoVersion: verifiedIdentity.logoVersion,
      role: result.member.role,
    };
    this.#connections.setCompatibility(stored.id, verifiedIdentity.compatibility);
    this.#connections.clearIssue(stored.id);
    this.#connections.setState(stored.id, "online");
    // Probed before the server is stored, not after: a probe that fails outright now leaves the list
    // as it was, instead of an entry that is in memory but was never written.
    stored.remoteDesktopAvailable = await this.#client.probeRemoteDesktop(stored);
    await this.#store.adopt(stored);
    this.#syncEventScopes();
    this.#emitChanged();
    this.#restartEventConnection(stored.id, true);
    return requiredServerSummary(this.list(), stored.id);
  }

  async connectDevelopmentServer(input: DevelopmentRemoteServerConnection): Promise<ServerSummary> {
    const verifiedIdentity = await this.#client.verifyIdentity(input.apiUrl, input.serverId, input.fingerprint);
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
      encryptedToken: this.#store.sealToken(input.sessionToken),
      remoteDesktopAvailable: false,
      logoVersion: verifiedIdentity.logoVersion,
      role: "member",
    };
    this.#connections.setCompatibility(stored.id, verifiedIdentity.compatibility);
    this.#connections.clearIssue(stored.id);
    this.#connections.setState(stored.id, "online");
    // Probed before the server is stored, not after: a probe that fails outright now leaves the list
    // as it was, instead of an entry that is in memory but was never written.
    stored.remoteDesktopAvailable = await this.#client.probeRemoteDesktop(stored);
    await this.#store.adopt(stored);
    this.#syncEventScopes();
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
    const identity = await this.#client.verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const preview = await requestJson(invite.apiUrl, TEAM_API_ROUTES.join.invitationPreview, decodeInvitePreview, {
      method: "POST",
      body: { inviteToken: invite.token },
      ...this.#client.requestProtocol(identity.compatibility),
    });
    return {
      serverId: invite.serverId,
      serverName: identity.serverName,
      apiHostname: new URL(invite.apiUrl).hostname,
      ...preview,
    };
  }

  async login(input: LoginServerInput): Promise<ServerSummary> {
    const server = this.#store.require(input.serverId);
    this.#connections.setState(server.id, "connecting");
    this.#emitChanged();
    try {
      const identity = await this.#client.verifyIdentity(server.apiUrl, server.id, server.fingerprint);
      const accountTicket = await this.#centralAccount.createTeamAuthTicket(server.id);
      const result = await requestJson(server.apiUrl, TEAM_API_ROUTES.auth.account, decodeJoinResult, {
        method: "POST",
        body: { accountTicket },
        ...this.#client.requestProtocol(identity.compatibility),
      });
      this.#connections.setCompatibility(server.id, identity.compatibility);
      this.#connections.clearIssue(server.id);
      const signedIn = await this.#store.update(server.id, {
        username: this.#centralAccount.getEmail().trim().toLowerCase(),
        role: result.member.role,
        encryptedToken: this.#store.sealToken(result.sessionToken),
        name: identity.serverName,
        logoVersion: identity.logoVersion,
      });
      this.#connections.setState(server.id, "online");
      // The probe authenticates with the session token this sign-in just replaced, so it has to run
      // against the stored server rather than the one `login` was handed.
      if (signedIn) {
        await this.#store.update(server.id, {
          remoteDesktopAvailable: await this.#client.probeRemoteDesktop(signedIn),
        });
      }
      this.#restartEventConnection(server.id, true);
    } catch (error) {
      this.#connections.reportError(server.id, error, "error");
      throw error;
    }
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  async retryConnection(serverId: string): Promise<ServerSummary> {
    const server = this.#store.require(serverId);
    const blockedState = this.#connections.hasIssue(serverId)
      ? (this.#connections.stateFor(serverId) ?? "error")
      : "error";
    try {
      if (server.transport === "webrtc-v2") {
        if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
        this.#connections.setState(serverId, "connecting");
        this.#emitChanged();
        await this.#webrtcTransport.connect(serverId);
        return requiredServerSummary(this.list(), serverId);
      }
      await this.#client.ensureCompatibility(server, true);
      this.#connections.setState(serverId, "connecting");
      this.#emitChanged();
      this.#restartEventConnection(serverId, true);
    } catch (error) {
      this.#connections.reportError(serverId, error, blockedState);
      throw error;
    }
    return requiredServerSummary(this.list(), serverId);
  }

  async remove(serverId: string): Promise<void> {
    if (serverId === LOCAL_SERVER_ID) throw new Error("The local server cannot be removed.");
    const server = this.#store.find(serverId);
    // An owner cannot leave their own host, so the account service keeps listing it. Hiding it is
    // what makes the removal survive the next directory sync.
    let hideHost = false;
    if (server?.transport === "webrtc-v2") {
      if (!this.#webrtcTransport) throw new Error("The WebRTC transport is unavailable.");
      if (server.role === "owner") hideHost = true;
      else await this.#webrtcTransport.leaveHost(serverId);
      await this.#webrtcTransport.disconnect(serverId).catch(() => undefined);
    }
    this.#clearServerConnectionState(serverId);
    await this.#store.remove(serverId, { hideHost });
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
    this.#connections.forget(serverId);
    this.#client.forget(serverId);
    this.#eventSockets.delete(serverId);
    this.#presence.delete(serverId);
  }

  // The server comes first because every caller knows which one it means, and the decoder sits next
  // to the path it decodes. `init` is last and optional, so a plain GET reads as three arguments.
  async request<T>(
    serverId: string,
    path: string,
    decoder: ResponseDecoder<T>,
    init: RemoteRequestInit = {},
  ): Promise<T> {
    return this.#client.request(serverId, path, decoder, init);
  }

  async duplicateBot(botId: string, serverId = this.#store.activeServerId): Promise<DuplicateBotResult> {
    const key = `${serverId}\0${botId}`;
    const operationId = this.#duplicateOperationIds.get(key) ?? randomUUID();
    this.#duplicateOperationIds.set(key, operationId);
    try {
      const result = await this.request(
        serverId,
        TEAM_API_ROUTES.agent.duplicate(botId),
        decodeDuplicateBotResultFromHost,
        { method: "POST", body: { operationId }, timeoutMs: REMOTE_DUPLICATION_TIMEOUT_MS },
      );
      this.#duplicateOperationIds.delete(key);
      return result;
    } catch (error) {
      if (error instanceof RemoteRequestError && error.status >= 400 && error.status < 500) {
        this.#duplicateOperationIds.delete(key);
      }
      throw error;
    }
  }

  listAgentConversationReads(serverId = this.#store.activeServerId): Promise<Record<string, ConversationReadState>> {
    return this.request(serverId, TEAM_API_ROUTES.agents.conversationReads, decodeConversationReadStates);
  }

  readAgentConversation(botId: string, serverId = this.#store.activeServerId): Promise<ConversationWithReadState> {
    return this.request(serverId, TEAM_API_ROUTES.agent.conversation(botId), decodeConversationWithReadState);
  }

  readAgentConversationPage(
    botId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
    serverId = this.#store.activeServerId,
  ): Promise<ConversationPage> {
    return this.request(
      serverId,
      `${TEAM_API_ROUTES.agent.conversationPage(botId)}${pageQuery(anchor, limit)}`,
      decodeConversationPageFromHost,
    );
  }

  searchAgentConversationMessages(
    query: string,
    botId?: string,
    cursor?: string,
    limit = 100,
    serverId = this.#store.activeServerId,
  ): Promise<ConversationSearchPage> {
    const parameters = new URLSearchParams({ q: query, limit: String(limit) });
    if (botId) parameters.set("botId", botId);
    if (cursor) parameters.set("cursor", cursor);
    return this.request(
      serverId,
      `${TEAM_API_ROUTES.messages.search}?${parameters.toString()}`,
      decodeConversationSearchPageFromHost,
    );
  }

  markAgentConversationRead(
    input: MarkConversationReadInput,
    serverId = this.#store.activeServerId,
  ): Promise<ConversationReadState> {
    return this.request(serverId, TEAM_API_ROUTES.agent.conversationRead(input.botId), decodeConversationReadState, {
      method: "POST",
      body: { throughMessageId: input.throughMessageId },
    });
  }

  getPresence(serverId = this.#store.activeServerId): TeamPresenceSnapshot {
    const cached = this.#presence.get(serverId);
    if (cached) return structuredClone(cached);
    return { serverId, members: [], updatedAt: new Date().toISOString() };
  }

  async getPresenceFor(serverId: string): Promise<TeamPresenceSnapshot> {
    try {
      const snapshot = await this.request(serverId, TEAM_API_ROUTES.team.presence, decodeTeamPresenceSnapshot);
      this.#presence.set(serverId, snapshot);
      return structuredClone(snapshot);
    } catch (error) {
      const cached = this.#presence.get(serverId);
      if (cached) return structuredClone(cached);
      throw error;
    }
  }

  async refreshIdentity(serverId: string): Promise<ServerSummary> {
    const server = this.#store.require(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      await this.#syncWebRtcHosts();
      this.#connections.clearCompatibility(serverId);
      await this.#client.ensureCompatibility(server, true);
      this.#connections.clearIssue(serverId);
      this.#emitChanged();
      return requiredServerSummary(this.list(), serverId);
    }
    const identity = await this.#client.verifyIdentity(server.apiUrl, server.id, server.fingerprint);
    this.#connections.setCompatibility(server.id, identity.compatibility);
    this.#connections.clearIssue(server.id);
    await this.#store.update(server.id, { name: identity.serverName, logoVersion: identity.logoVersion });
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  listMembers(serverId: string): Promise<TeamMemberSummary[]> {
    const server = this.#store.require(serverId);
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
    return this.request(serverId, TEAM_API_ROUTES.team.members, decodeTeamMembers);
  }

  updateMember(serverId: string, input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    const server = this.#store.require(serverId);
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
    return this.request(serverId, TEAM_API_ROUTES.team.member(input.memberId), decodeTeamMember, {
      method: "PATCH",
      body: { role: input.role, disabled: input.disabled },
    });
  }

  removeMember(serverId: string, memberId: string): Promise<void> {
    const server = this.#store.require(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport)
      return this.#webrtcTransport.removeMember(serverId, memberId);
    return this.request(serverId, TEAM_API_ROUTES.team.member(memberId), decodeVoid, { method: "DELETE" });
  }

  listInvites(serverId: string): Promise<TeamInviteSummary[]> {
    const server = this.#store.require(serverId);
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
    return this.request(serverId, TEAM_API_ROUTES.team.invites, decodeTeamInvites);
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    const server = this.#store.require(serverId);
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) return this.#webrtcTransport.revokeInvite(inviteId);
    return this.request(serverId, TEAM_API_ROUTES.team.invite(inviteId), decodeVoid, { method: "DELETE" });
  }

  async createInvite(serverId: string, input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = this.#store.require(serverId);
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
    return this.request(serverId, TEAM_API_ROUTES.team.invites, decodeInviteSummary, { method: "POST", body: input });
  }

  setTyping(input: SetTeamTypingInput, serverId = this.#store.activeServerId): void {
    const server = this.#store.find(serverId);
    if (server?.transport === "webrtc-v2") {
      void this.#webrtcTransport?.setTyping(serverId, input.botId, input.typing).catch(() => undefined);
      return;
    }
    const socket = this.#eventSockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeTeamProtocolV1ClientEvent({ type: "team-typing", ...input }));
  }

  listDirectThreads(serverId = this.#store.activeServerId): Promise<DirectThreadSummary[]> {
    return this.request(serverId, TEAM_API_ROUTES.direct.threads, decodeDirectThreadSummaries);
  }

  readDirectConversation(memberId: string, serverId = this.#store.activeServerId): Promise<DirectConversationSnapshot> {
    return this.request(serverId, TEAM_API_ROUTES.direct.conversation(memberId), decodeDirectConversationSnapshot);
  }

  readDirectConversationPage(
    memberId: string,
    anchor: DirectConversationPageAnchor = { type: "latest" },
    limit = 50,
    serverId = this.#store.activeServerId,
  ): Promise<DirectConversationPage> {
    return this.request(
      serverId,
      `${TEAM_API_ROUTES.direct.conversationPage(memberId)}${pageQuery(anchor, limit)}`,
      decodeDirectConversationPage,
    );
  }

  sendDirectMessage(input: SendDirectMessageInput, serverId = this.#store.activeServerId): Promise<DirectMessage> {
    return this.request(serverId, TEAM_API_ROUTES.direct.messages, decodeDirectMessage, {
      method: "POST",
      body: input,
    });
  }

  markDirectRead(
    input: MarkDirectReadInput,
    serverId = this.#store.activeServerId,
  ): Promise<DirectConversationReadState> {
    return this.request(
      serverId,
      TEAM_API_ROUTES.direct.conversationRead(input.memberId),
      decodeDirectConversationReadState,
      { method: "POST", body: { throughSequence: input.throughSequence } },
    );
  }

  setDirectTyping(input: DirectTypingInput, serverId = this.#store.activeServerId): void {
    const server = this.#store.find(serverId);
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
    const session = await this.request(serverId, TEAM_API_ROUTES.remoteScreen.sessions, decodeRemoteDesktopSession, {
      method: "POST",
      body: {},
    });
    if (this.#store.require(serverId).transport !== "webrtc-v2") return session;
    if (!this.#remoteViewerProxy) throw new Error("The local remote viewer proxy is unavailable.");
    return {
      ...session,
      viewerUrl: await this.#remoteViewerProxy.viewerUrl(serverId, TEAM_API_ROUTES.remoteScreen.viewer(session.id)),
    };
  }

  async fetchRemoteViewerResource(serverId: string, path: string, init: RequestInit): Promise<Response> {
    const server = this.#store.require(serverId);
    if (server.transport !== "webrtc-v2") throw new Error("The remote viewer transport is invalid.");
    return this.#client.fetch(server, new URL(path, server.apiUrl), init, false);
  }

  closeRemoteDesktopSession(serverId: string, sessionId: string): Promise<void> {
    return this.request(serverId, TEAM_API_ROUTES.remoteScreen.session(sessionId), decodeVoid, { method: "DELETE" });
  }

  selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
    return this.request(serverId, TEAM_API_ROUTES.remoteScreen.display, decodeVoid, {
      method: "PUT",
      body: { displayId },
    });
  }

  async uploadAttachment(
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    serverId = this.#store.activeServerId,
  ): Promise<DraftAttachment> {
    const server = this.#store.require(serverId);
    const url = new URL(TEAM_API_ROUTES.attachments, server.apiUrl);
    url.searchParams.set("name", name);
    url.searchParams.set("mime", mimeType || "application/octet-stream");
    const response = await this.#client.fetch(server, url, {
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
    serverId = this.#store.activeServerId,
  ): Promise<BotSummary> {
    const server = this.#store.require(serverId);
    const url = new URL(TEAM_API_ROUTES.agent.avatar(botId), server.apiUrl);
    const headers = new Headers();
    if (image) headers.set("Content-Type", image.mimeType);
    const response = await this.#client.fetch(server, url, {
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
    serverId = this.#store.activeServerId,
    version?: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const server = this.#store.require(serverId);
    const url = new URL(TEAM_API_ROUTES.agent.avatar(botId), server.apiUrl);
    if (version) url.searchParams.set("v", version);
    const response = await this.#client.fetch(server, url);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async downloadServerLogo(serverId: string, version: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const server = this.#store.require(serverId);
    if (server.logoVersion !== version) throw new Error("Server logo version is not current.");
    if (server.transport === "webrtc-v2" && this.#webrtcTransport) {
      const logo = await this.#webrtcTransport.downloadHostLogo(serverId, version);
      if (!isValidAvatarImage(logo.mimeType, logo.bytes)) throw new Error("Server logo response is invalid.");
      return logo;
    }
    const url = new URL(TEAM_API_ROUTES.team.logo, server.apiUrl);
    url.searchParams.set("v", version);
    const response = await this.#client.fetch(server, url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!isValidAvatarImage(mimeType, bytes)) throw new Error("Server logo response is invalid.");
    return { bytes, mimeType };
  }

  async downloadAttachment(
    attachmentId: string,
    serverId = this.#store.activeServerId,
  ): Promise<{
    bytes: Uint8Array;
    name: string;
    mimeType: string;
  }> {
    const server = this.#store.require(serverId);
    const response = await this.#client.fetch(server, new URL(TEAM_API_ROUTES.attachment(attachmentId), server.apiUrl));
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
    serverId = this.#store.activeServerId,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const server = this.#store.require(serverId);
    const url = new URL(TEAM_API_ROUTES.sharedFiles, server.apiUrl);
    url.searchParams.set("path", sharedPath);
    const response = await this.#client.fetch(server, url);
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
    serverId = this.#store.activeServerId,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const server = this.#store.require(serverId);
    const url = new URL(TEAM_API_ROUTES.workspaceFiles, server.apiUrl);
    url.searchParams.set("botId", botId);
    url.searchParams.set("path", workspacePath);
    const response = await this.#client.fetch(server, url);
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
    this.#client.clear();
    await this.#remoteViewerProxy?.stop().catch(() => undefined);
    await this.#webrtcTransport?.stop().catch(() => undefined);
  }

  async disconnectRemoteSessions(): Promise<void> {
    if (!this.#webrtcTransport) return;
    await Promise.all(
      this.#store.servers
        .filter((server) => server.transport === "webrtc-v2")
        .map((server) => this.#webrtcTransport?.disconnect(server.id)),
    );
  }

  async #syncWebRtcHosts(): Promise<void> {
    const transport = this.#webrtcTransport;
    if (!transport) return;
    const { servers, removedHostIds, pinnedKeys } = reconcileWebRtcHosts({
      hosts: await transport.listHosts(),
      servers: this.#store.servers,
      localHostId: this.#getLocalHostId(),
      isHiddenHost: (hostId) => this.#store.isHiddenHost(hostId),
      username: this.#centralAccount.getEmail().trim().toLowerCase(),
      keepOtherTransports: this.#allowLocalDevelopmentInvites,
    });
    for (const { hostId, publicKey } of pinnedKeys) transport.pinHostKey(hostId, publicKey);
    for (const serverId of removedHostIds) {
      await transport.disconnect(serverId).catch(() => undefined);
      this.#clearServerConnectionState(serverId);
    }
    await this.#store.replaceServers(servers);
  }

  #handleWebRtcEvent(serverId: string, event: AgentEvent | TeamRealtimeEvent): void {
    if (event.type === "team-identity") {
      void this.#store
        .update(serverId, { name: event.serverName, logoVersion: event.logoVersion })
        .then(() => this.#emitChanged());
    } else if (event.type === "team-presence") {
      this.#presence.set(serverId, event.snapshot);
      this.emit("presence", serverId, structuredClone(event.snapshot));
    } else if (event.type === "team-direct-message") this.emit("directMessage", serverId, event);
    else if (event.type === "team-direct-typing") this.emit("directTyping", serverId, event);
    else this.#forwardAgentEvent(serverId, event);
  }

  // What a suspended reconnect costs the event stream. The registry decides that a failure is not
  // worth retrying; this is the only place that knows there is a socket to tear down for it.
  #suspendEventReconnect(serverId: string): void {
    this.#eventAuthenticationPaused.add(serverId);
    this.#eventControllers.get(serverId)?.abort();
    this.#eventControllers.delete(serverId);
    this.#eventSockets.delete(serverId);
  }

  async #connectEvents(serverId: string): Promise<void> {
    if (!this.#eventsEnabled || this.#eventControllers.has(serverId)) return;
    const server = this.#store.require(serverId);
    if (server.transport === "webrtc-v2") return;
    const controller = new AbortController();
    this.#eventControllers.set(serverId, controller);
    let opened = false;
    let openedAt = 0;
    let authenticationFailed = false;
    let protocolFailed = false;
    try {
      const compatibility = await this.#client.ensureCompatibility(server, true);
      if (controller.signal.aborted || !this.#eventsEnabled || !this.#store.has(serverId)) {
        if (this.#eventControllers.get(serverId) === controller) this.#eventControllers.delete(serverId);
        return;
      }
      const eventsUrl = new URL(TEAM_API_ROUTES.events, server.apiUrl);
      eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
      const socketProtocols = this.#appVersion
        ? [TEAM_PROTOCOL_V1_WEBSOCKET, `openbot-token.${this.#store.token(server)}`]
        : [REMOTE_EVENT_SNAPSHOT_PROTOCOL, REMOTE_EVENT_PROTOCOL, `openbot-token.${this.#store.token(server)}`];
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
            this.#connections.markConnected(serverId);
            this.#connections.setCompatibility(serverId, compatibility);
            this.#eventAuthenticationPaused.delete(serverId);
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
              void this.#store
                .update(serverId, { name: event.serverName, logoVersion: event.logoVersion })
                .then(() => this.#emitChanged());
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
            if (this.#eventSockets.get(serverId) === socket) {
              this.#eventSockets.delete(serverId);
            }
            resolve();
          },
          { once: true },
        );
      });
      if (!controller.signal.aborted && !protocolFailed) {
        this.#connections.setState(serverId, "offline");
        this.#setPresenceOffline(serverId);
        this.#emitChanged();
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
        includeConversations: this.#store.activeServerId === serverId,
        ...(this.#appVersion ? { capabilities: TEAM_CURRENT_CAPABILITIES } : {}),
      }),
    );
  }

  #ensureEventConnection(serverId: string): void {
    const server = this.#store.find(serverId);
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
    if (!this.#store.has(serverId)) return;
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

  async #hasRejectedEventCredentials(server: StoredRemoteServerView): Promise<boolean> {
    try {
      const compatibility = await this.#client.ensureCompatibility(server);
      await requestJson(server.apiUrl, TEAM_API_ROUTES.me, (value) => decodeRecord(value, "team member"), {
        token: this.#store.token(server),
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

  #supportsRuntimeSnapshots(serverId: string, socket: WebSocket): boolean {
    return this.#appVersion
      ? this.#supportsCapability(serverId, "agent-runtime-snapshots")
      : socket.protocol === REMOTE_EVENT_SNAPSHOT_PROTOCOL;
  }

  async #refreshAgentStateFallback(serverId: string): Promise<void> {
    const generation = this.#advanceEventGeneration(serverId);
    const bots = await this.request(serverId, TEAM_API_ROUTES.agents.all, decodeBotSummaries);
    if (this.#eventGenerations.get(serverId) !== generation) return;
    this.emit("agent", serverId, { type: "bots-changed", bots });
    await Promise.all(
      bots.map(async (bot) => {
        try {
          const [page, queue] = await Promise.all([
            this.readAgentConversationPage(bot.id, { type: "latest" }, 1, serverId),
            this.request(serverId, TEAM_API_ROUTES.agent.queue(bot.id), decodeQueueSnapshot),
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
      while (this.#store.has(serverId)) {
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
          snapshot = await this.request(serverId, TEAM_API_ROUTES.agent.queue(botId), decodeQueueSnapshot);
        } catch {
          if (request.dirty) continue;
          return;
        }
        if (!this.#store.has(serverId)) return;
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

function requiredServerSummary(servers: ServerSummary[], serverId: string): ServerSummary {
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Remote server summary is missing.");
  return server;
}
