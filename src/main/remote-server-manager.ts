import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
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
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { TeamCurrentCapability } from "@openbot/contracts/team-protocol/current";
import { decodeTeamProtocolV1CurrentHttpResponse } from "@openbot/contracts/team-protocol/v1-adapter";
import { decodeBotSummary, decodeDraftAttachment, decodeDuplicateBotResultFromHost } from "./remote-agent-decoding";
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
import { RemoteRequestError } from "./remote-server-errors";
import { RemoteEventRefresh } from "./remote-server-event-refresh";
import { RemoteEventStream } from "./remote-server-event-stream";
import { reconcileWebRtcHosts } from "./remote-server-host-directory";
import { requestJson } from "./remote-server-http";
import { RemotePresenceCache } from "./remote-server-presence";
import { RemoteServerStore, type TokenCipher } from "./remote-server-store";
import type { StoredRemoteServer } from "./remote-server-stored-shape";
import { remoteServerSummaries } from "./remote-server-summaries";
import { addRemotePreviewUrls, isLocalDevelopmentApi, pageQuery } from "./remote-server-urls";
import { decodeInvitePreview, decodeJoinResult, decodeTeamPresenceSnapshot } from "./remote-team-decoding";
import { RemoteTeamDirectory } from "./remote-team-directory";
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
export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #store: RemoteServerStore;
  readonly #connections: RemoteServerConnections;
  readonly #client: RemoteServerClient;
  readonly #refresh: RemoteEventRefresh;
  readonly #events: RemoteEventStream;
  readonly #presence: RemotePresenceCache;
  readonly #team: RemoteTeamDirectory;
  readonly #centralAccount: CentralAccountSession;
  readonly #allowLocalDevelopmentInvites: boolean;
  readonly #appVersion: string | null;
  #duplicateOperationIds = new Map<string, string>();
  readonly #webrtcTransport: TeamWebRtcClientTransport | null;
  readonly #getLocalHostId: () => string | null;
  readonly #remoteViewerProxy: RemoteViewerProxy | null;
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
      onReconnectSuspended: (serverId) => this.#suspendServer(serverId),
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
    this.#refresh = new RemoteEventRefresh({
      request: (serverId, path, decoder, init) => this.#client.request(serverId, path, decoder, init),
      hasServer: (serverId) => this.#store.has(serverId),
      emit: (serverId, event, bufferedLive) =>
        bufferedLive ? this.emit("agent", serverId, event, true) : this.emit("agent", serverId, event),
    });
    this.#presence = new RemotePresenceCache({
      fetchSnapshot: (serverId) => this.request(serverId, TEAM_API_ROUTES.team.presence, decodeTeamPresenceSnapshot),
      onSnapshot: (serverId, snapshot) => this.emit("presence", serverId, snapshot),
    });
    this.#team = new RemoteTeamDirectory({
      servers: this.#store,
      request: (serverId, path, decoder, init) => this.#client.request(serverId, path, decoder, init),
      transport: this.#webrtcTransport,
      sendInviteEmail: (input) => {
        if (!this.#centralAccount.sendTeamInviteEmail) throw new Error("Email delivery is unavailable.");
        return this.#centralAccount.sendTeamInviteEmail(input);
      },
    });
    this.#events = new RemoteEventStream({
      appVersion: this.#appVersion,
      servers: this.#store,
      client: this.#client,
      connections: this.#connections,
      agents: this.#refresh,
      transport: this.#webrtcTransport,
      // The stream reports facts and this is where they become state: an identity is written, a
      // presence snapshot is cached, and the rest are forwarded to the renderer.
      onServerIdentity: (serverId, identity) => this.#applyServerIdentity(serverId, identity),
      onPresence: (serverId, snapshot) => this.#presence.accept(serverId, snapshot),
      onDirectMessage: (serverId, event) => this.emit("directMessage", serverId, event),
      onDirectTyping: (serverId, event) => this.emit("directTyping", serverId, event),
      onOffline: (serverId) => this.#presence.markOffline(serverId),
      onChanged: () => this.#emitChanged(),
    });
    this.#remoteViewerProxy = this.#webrtcTransport
      ? new RemoteViewerProxy({
          transport: this.#webrtcTransport,
          fetchResource: (serverId, path, init) => this.fetchRemoteViewerResource(serverId, path, init),
        })
      : null;
    this.#webrtcTransport?.on("connected", (serverId) => {
      this.#events.clearReconnectBackoff(serverId);
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
      // A host the app has stopped reconnecting to is not merely offline. The recorded failure is
      // the reason it will not come back, and this disconnect is that failure's own tail -- the one
      // `#suspendServer` asked for. Writing "offline" over an "incompatible" would leave the issue
      // sitting behind an ordinary word for it, which is why the HTTPS arm guards the same way.
      if (!this.#events.isReconnectSuspended(serverId)) this.#connections.setState(serverId, "offline");
      this.#presence.markOffline(serverId);
      this.#emitChanged();
      this.#events.scheduleReconnect(serverId);
    });
    this.#webrtcTransport?.on("event", (serverId, event) => this.#handleWebRtcEvent(serverId, event));
    this.#webrtcTransport?.on("error", (serverId, code, message) => {
      if (!this.#connections.reportTransportError(serverId, code, message)) this.#events.scheduleReconnect(serverId);
    });
  }

  /**
   * What "reconnecting is pointless" costs. Suspending the event stream ends an HTTPS server's
   * socket with it, but a WebRTC host has no socket there: its events arrive on a data channel the
   * transport owns, so without this it keeps pushing them from a host the app has just decided it
   * cannot understand. The suspension is recorded first, so the `disconnected` event this raises
   * finds the pause already in place and does not schedule a reconnect around it.
   */
  #suspendServer(serverId: string): void {
    this.#events.suspendReconnect(serverId);
    if (this.#store.find(serverId)?.transport !== "webrtc-v2") return;
    void this.#webrtcTransport?.disconnect(serverId).catch(() => undefined);
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
    if (this.#events.enabled) this.startEventConnections();
    this.#emitChanged();
    return this.list();
  }

  get activeServerId(): string {
    return this.#store.activeServerId;
  }

  // What the host on the other end negotiated it can do. An IPC handler asks before calling a route
  // an older host does not serve, so this answers false until compatibility is known rather than
  // waiting for it -- a capability nobody has confirmed is one you cannot use yet.
  supportsCapability(serverId: string, capability: TeamCurrentCapability): boolean {
    return this.#connections.compatibilityFor(serverId)?.capabilities.includes(capability) ?? false;
  }

  startEventConnections(): void {
    this.#events.start();
  }

  refreshRuntimeSnapshots(): void {
    this.#events.refreshRuntimeSnapshots();
  }

  select(serverId: string): Promise<ServerSummary[]> {
    const operation = this.#selectChain.then(async () => {
      if (serverId !== LOCAL_SERVER_ID && !this.#store.has(serverId)) {
        throw new Error("Remote server not found.");
      }
      const previousSelection = this.#store.selection;
      const selectionRevision = this.#store.setActiveServerId(serverId);
      this.#events.syncScopes();
      try {
        await this.#store.persist();
      } catch (error) {
        if (this.#store.activeServerRevision === selectionRevision) {
          this.#store.restoreSelection(previousSelection);
          this.#events.syncScopes();
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
      // The identity checked out, so an entry for this host that this build could not read is now
      // superseded. `#syncWebRtcHosts` above deliberately kept it -- reconciliation is not a join.
      await this.#store.retireUnreadable(accepted.hostId);
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
    this.#events.syncScopes();
    this.#emitChanged();
    this.#events.restart(stored.id, true);
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
    this.#events.syncScopes();
    this.#emitChanged();
    this.#events.restart(stored.id, true);
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
      // against the stored server rather than the one `login` was handed. It is also the one step
      // here that may not fail the sign-in: the credentials are already on disk and the user is
      // signed in, so letting a screen-sharing probe reject `login` would report a failure that did
      // not happen and leave the server in `error` with a working token. The flag keeps its previous
      // value and `#refreshRemoteDesktop` corrects it later.
      if (signedIn) {
        const remoteDesktopAvailable = await this.#client.probeRemoteDesktop(signedIn).catch(() => null);
        if (remoteDesktopAvailable !== null) await this.#store.update(server.id, { remoteDesktopAvailable });
      }
      this.#events.restart(server.id, true);
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
        // The user retrying is what lifts the suspension a protocol or credential failure left
        // behind. Without this the connection comes up and the next disconnect never reconnects,
        // because `scheduleReconnect` still sees the host paused -- the HTTPS arm below gets the
        // same reset from `restart(serverId, true)`.
        this.#events.resumeReconnect(serverId);
        this.#connections.setState(serverId, "connecting");
        this.#emitChanged();
        await this.#webrtcTransport.connect(serverId);
        return requiredServerSummary(this.list(), serverId);
      }
      await this.#client.ensureCompatibility(server, true);
      this.#connections.setState(serverId, "connecting");
      this.#emitChanged();
      this.#events.restart(serverId, true);
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
    this.#events.forget(serverId);
    this.#refresh.forget(serverId);
    this.#connections.forget(serverId);
    this.#client.forget(serverId);
    this.#presence.forget(serverId);
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
    return this.#presence.get(serverId);
  }

  getPresenceFor(serverId: string): Promise<TeamPresenceSnapshot> {
    return this.#presence.refresh(serverId);
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
    return this.#team.listMembers(serverId);
  }

  updateMember(serverId: string, input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    return this.#team.updateMember(serverId, input);
  }

  removeMember(serverId: string, memberId: string): Promise<void> {
    return this.#team.removeMember(serverId, memberId);
  }

  listInvites(serverId: string): Promise<TeamInviteSummary[]> {
    return this.#team.listInvites(serverId);
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    return this.#team.revokeInvite(serverId, inviteId);
  }

  createInvite(serverId: string, input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    return this.#team.createInvite(serverId, input);
  }

  setTyping(input: SetTeamTypingInput, serverId = this.#store.activeServerId): void {
    const server = this.#store.find(serverId);
    if (server?.transport === "webrtc-v2") {
      void this.#webrtcTransport?.setTyping(serverId, input.botId, input.typing).catch(() => undefined);
      return;
    }
    this.#events.send(serverId, { type: "team-typing", ...input });
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
    this.#events.send(serverId, {
      type: "team-direct-typing",
      recipientMemberId: input.memberId,
      typing: input.typing,
    });
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
    this.#events.stop();
    this.#refresh.clear();
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
      preservedIdentities: this.#store.preservedIdentities,
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
      this.#applyServerIdentity(serverId, event);
    } else if (event.type === "team-presence") {
      this.#presence.accept(serverId, event.snapshot);
    } else if (event.type === "team-direct-message") this.emit("directMessage", serverId, event);
    else if (event.type === "team-direct-typing") this.emit("directTyping", serverId, event);
    else this.#refresh.forward(serverId, event);
  }

  #applyServerIdentity(serverId: string, identity: { serverName: string; logoVersion: string | null }): void {
    void this.#store
      .update(serverId, { name: identity.serverName, logoVersion: identity.logoVersion })
      .then(() => this.#emitChanged());
  }

  #emitChanged(): void {
    this.emit("changed", this.list());
  }
}

function requiredServerSummary(servers: ServerSummary[], serverId: string): ServerSummary {
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Remote server summary is missing.");
  return server;
}
