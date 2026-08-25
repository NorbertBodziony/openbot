import { randomBytes, randomUUID, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isValidAvatarImage } from "@openbot/contracts/avatar-images";
import { parseInviteUrl } from "@openbot/contracts/invite-links";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AvatarImageInput,
  BotMemory,
  BotSummary,
  BrowserControlState,
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
  ServerSummary,
  SetTeamTypingInput,
  SidebarLayoutSnapshot,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRole,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import {
  isAgentEvent,
  isAgentModel,
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
import { fingerprint } from "./team-store";

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
}

interface StoredRemoteServers {
  version: 2;
  activeServerId: string;
  servers: StoredRemoteServer[];
}

interface RemoteServerEvents {
  changed: [servers: ServerSummary[]];
  agent: [serverId: string, event: AgentEvent];
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

type ResponseDecoder<T> = (value: unknown) => T;

class RemoteRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteRequestError";
    this.status = status;
  }
}

export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #path: string;
  readonly #cipher: TokenCipher;
  readonly #centralAccount: CentralAccountSession;
  #state: StoredRemoteServers = { version: 2, activeServerId: "local", servers: [] };
  #states = new Map<string, ServerSummary["state"]>();
  #eventControllers = new Map<string, AbortController>();
  #eventSockets = new Map<string, WebSocket>();
  #presence = new Map<string, TeamPresenceSnapshot>();
  #writeChain = Promise.resolve();

  constructor(path: string, cipher: TokenCipher, centralAccount: CentralAccountSession) {
    super();
    this.#path = path;
    this.#cipher = cipher;
    this.#centralAccount = centralAccount;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      const stored = readStoredRemoteServers(parsed);
      if (stored) this.#state = stored;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const server of this.#state.servers) this.#states.set(server.id, "offline");
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
      },
      ...this.#state.servers.map((server) => ({
        id: server.id,
        name: server.name,
        kind: "remote" as const,
        state: this.#states.get(server.id) ?? "offline",
        apiUrl: server.apiUrl,
        remoteDesktopAvailable: server.remoteDesktopAvailable ?? false,
        logoUrl: server.logoVersion ? remoteServerLogoUrl(server.id, server.logoVersion) : null,
        role: server.role,
        active: this.#state.activeServerId === server.id,
      })),
    ];
  }

  get activeServerId(): string {
    return this.#state.activeServerId;
  }

  async select(serverId: string): Promise<ServerSummary[]> {
    if (serverId !== "local" && !this.#state.servers.some((server) => server.id === serverId)) {
      throw new Error("Remote server not found.");
    }
    this.#state.activeServerId = serverId;
    for (const [connectedServerId, controller] of this.#eventControllers) {
      if (connectedServerId === serverId) continue;
      controller.abort();
      this.#eventControllers.delete(connectedServerId);
      this.#eventSockets.delete(connectedServerId);
    }
    await this.#persist();
    this.#emitChanged();
    if (serverId !== "local") void this.#connectEvents(serverId);
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
    const invite = parseInviteUrl(input.inviteUrl);
    const verifiedIdentity = await this.#verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const accountTicket = await this.#centralAccount.createTeamAuthTicket(invite.serverId);
    const result = await requestJson(invite.apiUrl, "/v1/join/account", decodeJoinResult, {
      method: "POST",
      body: {
        inviteToken: invite.token,
        accountTicket,
      },
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
    this.#state.activeServerId = stored.id;
    this.#states.set(stored.id, "online");
    await this.#refreshRemoteDesktop(stored);
    await this.#persist();
    this.#emitChanged();
    void this.#connectEvents(stored.id);
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
    this.#state.activeServerId = stored.id;
    this.#states.set(stored.id, "online");
    await this.#refreshRemoteDesktop(stored);
    await this.#persist();
    this.#emitChanged();
    void this.#connectEvents(stored.id);
    return requiredServerSummary(this.list(), stored.id);
  }

  async previewInvite(input: JoinServerInput): Promise<InvitePreview> {
    const invite = parseInviteUrl(input.inviteUrl);
    const identity = await this.#verifyIdentity(invite.apiUrl, invite.serverId, invite.fingerprint);
    const preview = await requestJson(invite.apiUrl, "/v1/invitations/preview", decodeInvitePreview, {
      method: "POST",
      body: { inviteToken: invite.token },
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
      });
      server.username = this.#centralAccount.getEmail().trim().toLowerCase();
      server.role = result.member.role;
      server.encryptedToken = this.#cipher.encrypt(result.sessionToken).toString("base64");
      server.name = identity.serverName;
      server.logoVersion = identity.logoVersion;
      this.#states.set(server.id, "online");
      await this.#refreshRemoteDesktop(server);
      await this.#persist();
      void this.#connectEvents(server.id);
    } catch (error) {
      this.#states.set(server.id, "error");
      this.#emitChanged();
      throw error;
    }
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  async remove(serverId: string): Promise<void> {
    if (serverId === "local") throw new Error("The local server cannot be removed.");
    this.#eventControllers.get(serverId)?.abort();
    this.#eventControllers.delete(serverId);
    this.#states.delete(serverId);
    this.#eventSockets.delete(serverId);
    this.#presence.delete(serverId);
    this.#state.servers = this.#state.servers.filter((server) => server.id !== serverId);
    if (this.#state.activeServerId === serverId) this.#state.activeServerId = "local";
    await this.#persist();
    this.#emitChanged();
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    serverId = this.#state.activeServerId,
    decoder: ResponseDecoder<T>,
  ): Promise<T> {
    const server = this.#requireServer(serverId);
    const value = await requestJson(server.apiUrl, path, decoder, {
      ...init,
      token: this.#token(server),
    });
    return addRemotePreviewUrls(value, server.id);
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
    const identity = await this.#verifyIdentity(server.apiUrl, server.id, server.fingerprint);
    server.name = identity.serverName;
    server.logoVersion = identity.logoVersion;
    await this.#persist();
    this.#emitChanged();
    return requiredServerSummary(this.list(), server.id);
  }

  listMembers(serverId: string): Promise<TeamMemberSummary[]> {
    return this.request("/v1/team/members", {}, serverId, decodeTeamMembers);
  }

  updateMember(serverId: string, input: UpdateTeamMemberInput): Promise<TeamMemberSummary> {
    return this.request(
      `/v1/team/members/${encodeURIComponent(input.memberId)}`,
      { method: "PATCH", body: { role: input.role, disabled: input.disabled } },
      serverId,
      decodeTeamMember,
    );
  }

  removeMember(serverId: string, memberId: string): Promise<void> {
    return this.request(`/v1/team/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }, serverId, decodeVoid);
  }

  listInvites(serverId: string): Promise<TeamInviteSummary[]> {
    return this.request("/v1/team/invites", {}, serverId, decodeTeamInvites);
  }

  revokeInvite(serverId: string, inviteId: string): Promise<void> {
    return this.request(`/v1/team/invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" }, serverId, decodeVoid);
  }

  createInvite(serverId: string, input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    return this.request("/v1/team/invites", { method: "POST", body: input }, serverId, decodeInviteSummary);
  }

  setTyping(input: SetTeamTypingInput, serverId = this.#state.activeServerId): void {
    const socket = this.#eventSockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "team-typing", ...input }));
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
    const socket = this.#eventSockets.get(serverId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "team-direct-typing",
        recipientMemberId: input.memberId,
        typing: input.typing,
      }),
    );
  }

  createRemoteDesktopSession(serverId: string): Promise<RemoteDesktopSession> {
    return this.request(
      "/v1/remote-screen/sessions",
      { method: "POST", body: {} },
      serverId,
      decodeRemoteDesktopSession,
    );
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
    const response = await remoteFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token(server)}`,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(responseError(value, "Attachment upload failed."));
    return addRemotePreviewUrls(decodeDraftAttachment(value), server.id);
  }

  async setAgentAvatar(
    botId: string,
    image: AvatarImageInput | null,
    serverId = this.#state.activeServerId,
  ): Promise<BotSummary> {
    const server = this.#requireServer(serverId);
    const url = new URL(`/v1/agents/${encodeURIComponent(botId)}/avatar`, server.apiUrl);
    const response = await remoteFetch(url, {
      method: image ? "PUT" : "DELETE",
      headers: {
        Authorization: `Bearer ${this.#token(server)}`,
        ...(image ? { "Content-Type": image.mimeType } : {}),
      },
      body: image ? Buffer.from(image.bytes) : undefined,
    });
    const value = await response.json();
    if (!response.ok) {
      throw new Error(responseError(value, "Agent avatar update failed."));
    }
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
    const response = await remoteFetch(url, {
      headers: { Authorization: `Bearer ${this.#token(server)}` },
    });
    if (!response.ok) throw new Error("Agent avatar download failed.");
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async downloadServerLogo(serverId: string, version: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const server = this.#requireServer(serverId);
    if (server.logoVersion !== version) throw new Error("Server logo version is not current.");
    const url = new URL("/v1/team/logo", server.apiUrl);
    url.searchParams.set("v", version);
    const response = await remoteFetch(url, { headers: { Authorization: `Bearer ${this.#token(server)}` } });
    if (!response.ok) throw new Error("Server logo download failed.");
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
    const response = await remoteFetch(`${server.apiUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: { Authorization: `Bearer ${this.#token(server)}` },
    });
    if (!response.ok) {
      throw new Error(responseError(await response.json(), "Attachment download failed."));
    }
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
    const response = await remoteFetch(url, {
      headers: { Authorization: `Bearer ${this.#token(server)}` },
    });
    if (!response.ok) {
      throw new Error(responseError(await response.json(), "Shared file download failed."));
    }
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
    const response = await remoteFetch(url, {
      headers: { Authorization: `Bearer ${this.#token(server)}` },
    });
    if (!response.ok) {
      throw new Error(responseError(await response.json(), "Workspace file download failed."));
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      name: encodedName ? decodeURIComponent(encodedName) : "workspace-file",
    };
  }

  stop(): void {
    for (const controller of this.#eventControllers.values()) controller.abort();
    this.#eventControllers.clear();
  }

  async #verifyIdentity(
    apiUrl: string,
    serverId: string,
    expectedFingerprint: string,
  ): Promise<{ publicKey: string; serverName: string; logoVersion: string | null }> {
    const challenge = randomBytes(24).toString("base64url");
    const proof = await requestJson(
      apiUrl,
      `/v1/identity?challenge=${encodeURIComponent(challenge)}`,
      decodeIdentityProof,
    );
    const valid =
      proof.serverId === serverId &&
      proof.challenge === challenge &&
      proof.fingerprint === expectedFingerprint &&
      fingerprint(proof.publicKey) === expectedFingerprint &&
      verify(null, Buffer.from(challenge), proof.publicKey, Buffer.from(proof.signature, "base64url"));
    if (!valid) throw new Error("The server identity could not be verified.");
    return { publicKey: proof.publicKey, serverName: proof.serverName, logoVersion: proof.logoVersion };
  }

  async #refreshRemoteDesktop(server: StoredRemoteServer): Promise<void> {
    try {
      const capabilities = await requestJson(
        server.apiUrl,
        "/v1/remote-screen/capabilities",
        decodeRemoteDesktopCapabilities,
        {
          token: this.#token(server),
        },
      );
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
    const server = this.#requireServer(serverId);
    this.#eventControllers.get(serverId)?.abort();
    const controller = new AbortController();
    this.#eventControllers.set(serverId, controller);
    try {
      const eventsUrl = new URL("/v1/events", server.apiUrl);
      eventsUrl.protocol = eventsUrl.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(eventsUrl, ["openbot-events", `openbot-token.${this.#token(server)}`]);
      controller.signal.addEventListener("abort", () => socket.close(1000, "Client stopped"), {
        once: true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => {
            this.#eventSockets.set(serverId, socket);
            this.#states.set(serverId, "online");
            this.#emitChanged();
          },
          { once: true },
        );
        socket.addEventListener("message", (message) => {
          if (!isString(message.data)) return;
          try {
            const event = JSON.parse(message.data);
            if (isTeamRealtimeEvent(event)) {
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
              }
            } else if (isAgentEvent(event)) {
              this.emit("agent", serverId, addRemotePreviewUrls(event, serverId));
            } else {
              throw new Error("Invalid agent event payload.");
            }
          } catch {
            socket.close(1003, "Invalid event payload");
          }
        });
        socket.addEventListener("error", () => reject(new Error("Remote events are unavailable.")), {
          once: true,
        });
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
      if (!controller.signal.aborted) {
        this.#states.set(serverId, "offline");
        this.#setPresenceOffline(serverId);
        this.#emitChanged();
      }
    } catch {
      if (!controller.signal.aborted) {
        this.#states.set(serverId, "offline");
        this.#setPresenceOffline(serverId);
        this.#emitChanged();
      }
    }
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
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const response = await remoteFetch(`${apiUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const message =
      isDynamicRecord(value) && isString(value.error)
        ? value.error
        : `Remote server request failed (${response.status}).`;
    throw new RemoteRequestError(response.status, message);
  }
  return decoder(value);
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
  if (!isAgentModel(model) || !isReasoningEffort(reasoningEffort)) {
    throw new Error("Invalid agent model configuration.");
  }
  if (!isAvatarSeed(avatarSeed) || (avatarHue !== null && !isAvatarHue(avatarHue))) {
    throw new Error("Invalid agent avatar configuration.");
  }
  return {
    id: requiredString(record, "id"),
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

function responseError(value: unknown, fallback: string): string {
  if (isDynamicRecord(value) && isString(value.error)) return value.error;
  return fallback;
}

function requiredServerSummary(servers: ServerSummary[], serverId: string): ServerSummary {
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) throw new Error("Remote server summary is missing.");
  return server;
}

function readStoredRemoteServers(value: unknown): StoredRemoteServers | null {
  if (!isDynamicRecord(value) || !isString(value.activeServerId) || !Array.isArray(value.servers)) return null;
  if (value.version !== 1 && value.version !== 2) return null;
  const servers: StoredRemoteServer[] = [];
  for (const serverValue of value.servers) {
    const server = readStoredRemoteServer(serverValue);
    if (!server) return null;
    servers.push(server);
  }
  return { version: 2, activeServerId: value.activeServerId, servers };
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
  };
}

function remoteFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS) });
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
