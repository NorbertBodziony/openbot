import { randomBytes, verify } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename, writeFile } from "node:fs/promises";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  DraftAttachment,
  JoinServerInput,
  LoginServerInput,
  ServerSummary,
  TeamRole,
} from "@openbot/contracts/ipc";
import { isDynamicRecord, isObjectValue, isString } from "@openbot/contracts/runtime-values";
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
}

interface TokenCipher {
  encrypt: (value: string) => Buffer;
  decrypt: (value: Buffer) => string;
}

interface CentralAccountSession {
  createTeamAuthTicket: (serverId: string) => Promise<string>;
  getEmail: () => string;
}

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

  constructor(path: string, cipher: TokenCipher, centralAccount: CentralAccountSession) {
    super();
    this.#path = path;
    this.#cipher = cipher;
    this.#centralAccount = centralAccount;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as StoredRemoteServers;
      if (parsed.version === 1 && Array.isArray(parsed.servers)) this.#state = parsed;
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
    await this.#persist();
    this.#emitChanged();
    if (serverId !== "local") void this.#connectEvents(serverId);
    return this.list();
  }

  async join(input: JoinServerInput): Promise<ServerSummary> {
    const invite = parseJoinUrl(input.inviteUrl);
    const verifiedIdentity = await this.#verifyIdentity(
      invite.apiUrl,
      invite.serverId,
      invite.fingerprint,
    );
    const accountTicket = await this.#centralAccount.createTeamAuthTicket(invite.serverId);
    const result = await requestJson<{
      member: { role: TeamRole };
      sessionToken: string;
    }>(invite.apiUrl, "/v1/join/account", {
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
    this.#state.servers = [
      ...this.#state.servers.filter((server) => server.id !== stored.id),
      stored,
    ];
    this.#state.activeServerId = stored.id;
    this.#states.set(stored.id, "online");
    await this.#refreshVnc(stored);
    await this.#persist();
    this.#emitChanged();
    void this.#connectEvents(stored.id);
    return this.list().find((server) => server.id === stored.id) as ServerSummary;
  }

  async login(input: LoginServerInput): Promise<ServerSummary> {
    const server = this.#requireServer(input.serverId);
    this.#states.set(server.id, "connecting");
    this.#emitChanged();
    try {
      await this.#verifyIdentity(server.apiUrl, server.id, server.fingerprint);
      const accountTicket = await this.#centralAccount.createTeamAuthTicket(server.id);
      const result = await requestJson<{ member: { role: TeamRole }; sessionToken: string }>(
        server.apiUrl,
        "/v1/auth/account",
        { method: "POST", body: { accountTicket } },
      );
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
    return this.list().find((candidate) => candidate.id === server.id) as ServerSummary;
  }

  async remove(serverId: string): Promise<void> {
    if (serverId === "local") throw new Error("The local server cannot be removed.");
    this.#eventControllers.get(serverId)?.abort();
    this.#eventControllers.delete(serverId);
    this.#states.delete(serverId);
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
    return this.list().find((candidate) => candidate.id === server.id) as ServerSummary;
  }

  async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
    serverId = this.#state.activeServerId,
  ): Promise<T> {
    const server = this.#requireServer(serverId);
    const value = await requestJson<T>(server.apiUrl, path, {
      ...init,
      token: this.#token(server),
    });
    return addRemotePreviewUrls(value, server.id);
  }

  async getRemoteDesktopAccess(serverId: string): Promise<RemoteDesktopAccess> {
    const server = this.#requireServer(serverId);
    const token = this.#token(server);
    const access = await requestJson<{ configured: boolean; password: string | null }>(
      server.apiUrl,
      "/v1/host/remote-desktop-access",
      { token },
    );
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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token(server)}`,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    const value = (await response.json()) as DraftAttachment | { error?: string };
    if (!response.ok) throw new Error("error" in value ? value.error : "Attachment upload failed.");
    return addRemotePreviewUrls(value as DraftAttachment, server.id);
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
    const response = await fetch(
      `${server.apiUrl}/v1/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${this.#token(server)}` } },
    );
    if (!response.ok) {
      const value = (await response.json()) as { error?: string };
      throw new Error(value.error ?? "Attachment download failed.");
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
    const proof = await requestJson<{
      serverId: string;
      publicKey: string;
      serverName: string;
      fingerprint: string;
      challenge: string;
      signature: string;
    }>(apiUrl, `/v1/identity?challenge=${encodeURIComponent(challenge)}`);
    const valid =
      proof.serverId === serverId &&
      proof.challenge === challenge &&
      proof.fingerprint === expectedFingerprint &&
      fingerprint(proof.publicKey) === expectedFingerprint &&
      verify(
        null,
        Buffer.from(challenge),
        proof.publicKey,
        Buffer.from(proof.signature, "base64url"),
      );
    if (!valid) throw new Error("The server identity could not be verified.");
    return { publicKey: proof.publicKey, serverName: proof.serverName };
  }

  async #refreshVnc(server: StoredRemoteServer): Promise<void> {
    const remote = await requestJson<{ hostname: string | null; online: boolean }>(
      server.apiUrl,
      "/v1/host/remote-mac",
      { token: this.#token(server) },
    );
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
      const socket = new WebSocket(eventsUrl, [
        "openbot-events",
        `openbot-token.${this.#token(server)}`,
      ]);
      controller.signal.addEventListener("abort", () => socket.close(1000, "Client stopped"), {
        once: true,
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => {
            this.#states.set(serverId, "online");
            this.#emitChanged();
          },
          { once: true },
        );
        socket.addEventListener("message", (message) => {
          if (!isString(message.data)) return;
          try {
            this.emit("agent", serverId, JSON.parse(message.data) as AgentEvent);
          } catch {
            socket.close(1003, "Invalid event payload");
          }
        });
        socket.addEventListener(
          "error",
          () => reject(new Error("Remote events are unavailable.")),
          {
            once: true,
          },
        );
        socket.addEventListener("close", () => resolve(), { once: true });
      });
      if (!controller.signal.aborted) {
        this.#states.set(serverId, "offline");
        this.#emitChanged();
      }
    } catch {
      if (!controller.signal.aborted) {
        this.#states.set(serverId, "offline");
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
        /^h-[0-9a-f]{32}\.openbot\.run$/u.test(url.hostname))
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
  return (
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com$/.test(value) ||
    /^vnc-h-[0-9a-f]{32}\.openbot\.run$/u.test(value)
  );
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
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = response.status === 204 ? undefined : ((await response.json()) as unknown);
  if (!response.ok) {
    const message =
      value && isObjectValue(value) && "error" in value && isString(value.error)
        ? value.error
        : `Remote server request failed (${response.status}).`;
    throw new Error(message);
  }
  return value as T;
}

function addRemotePreviewUrls<T>(value: T, serverId: string): T {
  if (Array.isArray(value)) {
    for (const item of value) addRemotePreviewUrls(item, serverId);
    return value;
  }
  if (!isDynamicRecord(value)) return value;
  const record = value as { [key: string]: unknown };
  if ("previewUrl" in record && isString(record.id)) {
    record.previewUrl = remoteAttachmentPreviewUrl(serverId, record.id);
  }
  for (const item of Object.values(record)) addRemotePreviewUrls(item, serverId);
  return value;
}

export function remoteAttachmentPreviewUrl(serverId: string, attachmentId: string): string {
  return `openbot-remote-attachment://${encodeURIComponent(serverId)}/${encodeURIComponent(attachmentId)}`;
}
