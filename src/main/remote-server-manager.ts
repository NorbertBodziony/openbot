import { randomBytes, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AvatarImageInput,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  ConversationReadState,
  ConversationWithReadState,
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingInput,
  DirectTypingRealtimeEvent,
  DraftAttachment,
  JoinServerInput,
  LoginServerInput,
  MarkConversationReadInput,
  MarkDirectReadInput,
  QueuedMessageReceipt,
  QueueSnapshot,
  SendDirectMessageInput,
  ServerSummary,
  SetTeamTypingInput,
  TeamPresenceSnapshot,
  TeamRole,
} from "@openbot/contracts/ipc";
import {
  isAgentEvent,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isReasoningEffort,
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
import { isOpenBotTeamApiHostname, isOpenBotTeamVncHostname } from "@openbot/contracts/validation";
import { addressUpdatePayload, fingerprint } from "./team-store";

interface StoredRemoteServer {
  id: string;
  name: string;
  apiUrl: string;
  fingerprint: string;
  publicKey?: string;
  username: string;
  encryptedToken: string;
  vncHostname: string | null;
  role: TeamRole;
}

interface StoredRemoteServers {
  version: 1;
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

const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

type ResponseDecoder<T> = (value: unknown) => T;

export interface RemoteDesktopAccess {
  url: string;
  protocols: string[];
  password: string;
}

export class RemoteServerManager extends EventEmitter<RemoteServerEvents> {
  readonly #path: string;
  readonly #cipher: TokenCipher;
  readonly #centralAccount: CentralAccountSession;
  #state: StoredRemoteServers = { version: 1, activeServerId: "local", servers: [] };
  #states = new Map<string, ServerSummary["state"]>();
  #eventControllers = new Map<string, AbortController>();
  #eventSockets = new Map<string, WebSocket>();
  #presence = new Map<string, TeamPresenceSnapshot>();

  constructor(path: string, cipher: TokenCipher, centralAccount: CentralAccountSession) {
    super();
    this.#path = path;
    this.#cipher = cipher;
    this.#centralAccount = centralAccount;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"));
      if (isStoredRemoteServers(parsed)) this.#state = parsed;
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
        vncHostname: null,
        role: null,
        active: this.#state.activeServerId === "local",
      },
      ...this.#state.servers.map((server) => ({
        id: server.id,
        name: server.name,
        kind: "remote" as const,
        state: this.#states.get(server.id) ?? "offline",
        apiUrl: server.apiUrl,
        vncHostname: server.vncHostname,
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

  async join(input: JoinServerInput): Promise<ServerSummary> {
    const invite = parseJoinUrl(input.inviteUrl);
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
      vncHostname: null,
      role: result.member.role,
    };
    this.#state.servers = [...this.#state.servers.filter((server) => server.id !== stored.id), stored];
    this.#state.activeServerId = stored.id;
    this.#states.set(stored.id, "online");
    await this.#refreshVnc(stored);
    await this.#persist();
    this.#emitChanged();
    void this.#connectEvents(stored.id);
    return requiredServerSummary(this.list(), stored.id);
  }

  async login(input: LoginServerInput): Promise<ServerSummary> {
    const server = this.#requireServer(input.serverId);
    this.#states.set(server.id, "connecting");
    this.#emitChanged();
    try {
      await this.#verifyIdentity(server.apiUrl, server.id, server.fingerprint);
      const accountTicket = await this.#centralAccount.createTeamAuthTicket(server.id);
      const result = await requestJson(server.apiUrl, "/v1/auth/account", decodeJoinResult, {
        method: "POST",
        body: { accountTicket },
      });
      server.username = this.#centralAccount.getEmail().trim().toLowerCase();
      server.role = result.member.role;
      server.encryptedToken = this.#cipher.encrypt(result.sessionToken).toString("base64");
      this.#states.set(server.id, "online");
      await this.#refreshVnc(server);
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

  async updateAddress(updateUrl: string): Promise<ServerSummary> {
    const update = parseAddressUpdateUrl(updateUrl);
    const server = this.#requireServer(update.serverId);
    verifyAddressUpdate(update, server.fingerprint);
    const identity = await this.#verifyIdentity(update.apiUrl, server.id, server.fingerprint);
    server.apiUrl = update.apiUrl;
    server.vncHostname = update.vncHostname;
    server.publicKey = identity.publicKey;
    server.name = identity.serverName;
    this.#states.set(server.id, "online");
    await this.#persist();
    this.#emitChanged();
    void this.#connectEvents(server.id);
    return requiredServerSummary(this.list(), server.id);
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

  async getRemoteDesktopAccess(serverId: string): Promise<RemoteDesktopAccess> {
    const server = this.#requireServer(serverId);
    const token = this.#token(server);
    const access = await requestJson(server.apiUrl, "/v1/host/remote-desktop-access", decodeRemoteDesktopAccess, {
      token,
    });
    if (!access.configured || !access.password) {
      throw new Error("The host owner must configure Remote Desktop access.");
    }
    if (
      access.password.length > INPUT_LIMITS.remoteDesktopPassword ||
      [...access.password].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
      })
    ) {
      throw new Error("The host returned invalid Remote Desktop credentials.");
    }
    const url = new URL("/v1/remote-desktop", server.apiUrl);
    url.protocol = "wss:";
    return {
      url: url.toString(),
      protocols: ["openbot-desktop", `openbot-token.${token}`],
      password: access.password,
    };
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

  stop(): void {
    for (const controller of this.#eventControllers.values()) controller.abort();
    this.#eventControllers.clear();
  }

  async #verifyIdentity(
    apiUrl: string,
    serverId: string,
    expectedFingerprint: string,
  ): Promise<{ publicKey: string; serverName: string }> {
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
    return { publicKey: proof.publicKey, serverName: proof.serverName };
  }

  async #refreshVnc(server: StoredRemoteServer): Promise<void> {
    const remote = await requestJson(server.apiUrl, "/v1/host/remote-mac", decodeRemoteMac, {
      token: this.#token(server),
    });
    server.vncHostname = remote.online ? remote.hostname : null;
  }

  async #connectEvents(serverId: string): Promise<void> {
    const server = this.#requireServer(serverId);
    this.#eventControllers.get(serverId)?.abort();
    const controller = new AbortController();
    this.#eventControllers.set(serverId, controller);
    try {
      const eventsUrl = new URL("/v1/events", server.apiUrl);
      eventsUrl.protocol = "wss:";
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
              if (event.type === "team-presence") {
                this.#presence.set(serverId, event.snapshot);
                this.emit("presence", serverId, structuredClone(event.snapshot));
              } else if (event.type === "team-direct-message") {
                this.emit("directMessage", serverId, event);
              } else {
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
    const temporary = `${this.#path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#path);
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

export function isValidRemoteApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(url.hostname) ||
        isOpenBotTeamApiHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

export function parseJoinUrl(value: string): {
  apiUrl: string;
  serverId: string;
  fingerprint: string;
  token: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid OpenBot invitation link.");
  }
  const apiUrl = url.searchParams.get("api") ?? "";
  const serverId = url.searchParams.get("server") ?? "";
  const expectedFingerprint = url.searchParams.get("fingerprint") ?? "";
  const token = url.searchParams.get("invite") ?? "";
  if (
    url.protocol !== "openbot:" ||
    url.hostname !== "join" ||
    !isValidRemoteApiUrl(apiUrl) ||
    !/^[0-9a-f-]{36}$/i.test(serverId) ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(expectedFingerprint) ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(token)
  ) {
    throw new Error("The OpenBot invitation link is invalid.");
  }
  return { apiUrl, serverId, fingerprint: expectedFingerprint, token };
}

export function parseAddressUpdateUrl(value: string): {
  apiUrl: string;
  serverId: string;
  vncHostname: string | null;
  publicKey: string;
  signature: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid OpenBot address update link.");
  }
  const apiUrl = url.searchParams.get("api") ?? "";
  const serverId = url.searchParams.get("server") ?? "";
  const vncHostname = url.searchParams.get("vnc");
  const publicKey = url.searchParams.get("key") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  if (
    url.protocol !== "openbot:" ||
    url.hostname !== "update" ||
    !isValidRemoteApiUrl(apiUrl) ||
    !/^[0-9a-f-]{36}$/i.test(serverId) ||
    (vncHostname !== null && !isValidRemoteVncHostname(vncHostname)) ||
    !/^[A-Za-z0-9_-]{64,2048}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{64,128}$/.test(signature)
  ) {
    throw new Error("The OpenBot address update link is invalid.");
  }
  return { apiUrl, serverId, vncHostname, publicKey, signature };
}

function isValidRemoteVncHostname(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(value) || isOpenBotTeamVncHostname(value);
}

export function verifyAddressUpdate(
  update: ReturnType<typeof parseAddressUpdateUrl>,
  expectedFingerprint: string,
): string {
  const publicKey = Buffer.from(update.publicKey, "base64url").toString("utf8");
  const valid =
    fingerprint(publicKey) === expectedFingerprint &&
    verify(
      null,
      Buffer.from(addressUpdatePayload(update.serverId, update.apiUrl, update.vncHostname)),
      publicKey,
      Buffer.from(update.signature, "base64url"),
    );
  if (!valid) throw new Error("The address update signature is invalid.");
  return publicKey;
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
    throw new Error(message);
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

function decodeRemoteDesktopAccess(value: unknown): {
  configured: boolean;
  password: string | null;
} {
  const record = decodeRecord(value, "Remote Desktop access");
  return {
    configured: requiredBoolean(record, "configured"),
    password: nullableString(record, "password"),
  };
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
    role: requiredString(record, "role"),
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
    avatarUrl: nullableString(record, "avatarUrl"),
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

export function decodeQueueSnapshot(value: unknown): QueueSnapshot {
  if (!isQueueSnapshotValue(value)) {
    throw new Error("Invalid remote queue.");
  }
  return value;
}

function isQueueSnapshotValue(value: unknown): value is QueueSnapshot {
  return (
    !isDynamicRecord(value) || !isString(value.botId) || !isBoolean(value.paused) || !Array.isArray(value.deliveries)
  );
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
  if (
    !Array.isArray(value) ||
    !value.every(
      (tab) =>
        isDynamicRecord(tab) &&
        isString(tab.id) &&
        isString(tab.title) &&
        isString(tab.url) &&
        isBoolean(tab.loading) &&
        (tab.ownerThreadId === null || isString(tab.ownerThreadId)) &&
        (tab.ownerBotId === null || isString(tab.ownerBotId)),
    )
  ) {
    throw new Error("Invalid remote browser tabs.");
  }
  return value;
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

function decodeIdentityProof(value: unknown): {
  serverId: string;
  publicKey: string;
  serverName: string;
  fingerprint: string;
  challenge: string;
  signature: string;
} {
  const record = decodeRecord(value, "server identity");
  return {
    serverId: requiredString(record, "serverId"),
    publicKey: requiredString(record, "publicKey"),
    serverName: requiredString(record, "serverName"),
    fingerprint: requiredString(record, "fingerprint"),
    challenge: requiredString(record, "challenge"),
    signature: requiredString(record, "signature"),
  };
}

function decodeRemoteMac(value: unknown): { hostname: string | null; online: boolean } {
  const record = decodeRecord(value, "Remote Mac status");
  return {
    hostname: nullableString(record, "hostname"),
    online: requiredBoolean(record, "online"),
  };
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

function isStoredRemoteServers(value: unknown): value is StoredRemoteServers {
  if (!isDynamicRecord(value) || value.version !== 1 || !isString(value.activeServerId)) {
    return false;
  }
  return Array.isArray(value.servers) && value.servers.every(isStoredRemoteServer);
}

function isStoredRemoteServer(value: unknown): value is StoredRemoteServer {
  if (!isDynamicRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.name) &&
    isString(value.apiUrl) &&
    isString(value.fingerprint) &&
    (value.publicKey === undefined || isString(value.publicKey)) &&
    isString(value.username) &&
    isString(value.encryptedToken) &&
    (value.vncHostname === null || isString(value.vncHostname)) &&
    isOneOf(["owner", "admin", "member"] as const, value.role)
  );
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
