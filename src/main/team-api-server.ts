import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AgentEvent,
  type CentralAuthUser,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type TeamMemberSummary,
  type UpdateBotInput,
} from "@openbot/contracts/ipc";
import type * as Ws from "ws";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { TeamStore } from "./team-store";

const JSON_LIMIT = 1024 * 1024;
const requireModule = createRequire(import.meta.url);
const webSockets = requireModule(
  join(dirname(requireModule.resolve("ws/package.json")), "index.js"),
) as typeof Ws;

interface TeamApiOptions {
  store: TeamStore;
  agents: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  getRemoteMac: () => { hostname: string | null; online: boolean };
  getRemoteDesktopPassword?: () => string | null;
  remoteDesktopPort?: number;
  redeemCentralTicket?: (ticket: string, serverId: string) => Promise<CentralAuthUser | null>;
}

interface RateEntry {
  attempts: number;
  resetAt: number;
}

export class TeamApiServer {
  readonly #options: TeamApiOptions;
  readonly #rateLimits = new Map<string, RateEntry>();
  readonly #eventClients = new Set<Ws.WebSocket>();
  readonly #desktopClients = new Map<Ws.WebSocket, { token: string; target: Socket }>();
  readonly #webSockets = new webSockets.WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("openbot-events") ? "openbot-events" : false),
  });
  readonly #desktopWebSockets = new webSockets.WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("openbot-desktop") ? "openbot-desktop" : false),
  });
  #server: Server | null = null;
  #port: number | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #agentListener: ((event: AgentEvent) => void) | null = null;

  constructor(options: TeamApiOptions) {
    this.#options = options;
  }

  get port(): number | null {
    return this.#port;
  }

  async start(): Promise<number> {
    if (this.#server && this.#port) return this.#port;
    this.#server = createServer((request, response) => void this.#handle(request, response));
    this.#server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
      const encodedToken = protocols.find((value) => value.startsWith("openbot-token."));
      const token = encodedToken?.slice("openbot-token.".length) ?? "";
      const member = token.length <= 512 ? this.#options.store.authenticate(token) : null;
      if (!member) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (url.pathname === "/v1/events" && protocols.includes("openbot-events")) {
        this.#webSockets.handleUpgrade(request, socket, head, (client) => {
          this.#eventClients.add(client);
          client.once("close", () => this.#eventClients.delete(client));
        });
        return;
      }
      if (url.pathname === "/v1/remote-desktop" && protocols.includes("openbot-desktop")) {
        if (!this.#options.getRemoteMac().online || !this.#options.getRemoteDesktopPassword?.()) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.#desktopWebSockets.handleUpgrade(request, socket, head, (client) => {
          this.#connectDesktop(client, token);
        });
        return;
      }
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Could not bind the team API.");
    this.#port = address.port;
    this.#agentListener = (event) => this.#broadcast(event);
    this.#options.agents.on("event", this.#agentListener);
    this.#heartbeat = setInterval(() => {
      for (const client of this.#eventClients) {
        if (client.readyState === webSockets.WebSocket.OPEN) client.ping();
        else this.#eventClients.delete(client);
      }
      for (const [client, connection] of this.#desktopClients) {
        if (!this.#options.store.authenticate(connection.token)) {
          client.close(1008, "Team access was revoked");
          connection.target.destroy();
        } else if (client.readyState === webSockets.WebSocket.OPEN) client.ping();
      }
    }, 15_000);
    this.#heartbeat.unref?.();
    return this.#port;
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#agentListener) this.#options.agents.off("event", this.#agentListener);
    this.#agentListener = null;
    for (const client of this.#eventClients) client.close(1001, "Server stopped");
    this.#eventClients.clear();
    for (const [client, connection] of this.#desktopClients) {
      client.close(1001, "Server stopped");
      connection.target.destroy();
    }
    this.#desktopClients.clear();
    const server = this.#server;
    this.#server = null;
    this.#port = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #handle(request: import("node:http").IncomingMessage, response: ServerResponse) {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/v1/identity") {
        const challenge = url.searchParams.get("challenge");
        return this.#json(
          response,
          200,
          challenge
            ? this.#options.store.getIdentityProof(challenge)
            : this.#options.store.getIdentity(),
        );
      }
      if (method === "POST" && url.pathname === "/v1/join") {
        const body = await readJson(request);
        this.#checkRate(request, stringField(body, "username", false, 64));
        const result = await this.#options.store.acceptInvite(
          stringField(body, "inviteToken", false, INPUT_LIMITS.identifier),
          stringField(body, "username", false, 64),
          stringField(body, "password", false, 256),
        );
        return this.#json(response, 201, result);
      }
      if (method === "POST" && url.pathname === "/v1/join/account") {
        const body = await readJson(request);
        const identity = this.#options.store.getIdentity();
        const user = identity
          ? await this.#options.redeemCentralTicket?.(
              stringField(body, "accountTicket", false, INPUT_LIMITS.identifier),
              identity.serverId,
            )
          : null;
        if (!user) return this.#json(response, 401, { error: "OpenBot sign-in is required." });
        this.#checkRate(request, user.email);
        const result = await this.#options.store.acceptInviteWithAccount(
          stringField(body, "inviteToken", false, INPUT_LIMITS.identifier),
          user,
        );
        return this.#json(response, 201, result);
      }
      if (method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJson(request);
        this.#checkRate(request, stringField(body, "username", false, 64));
        const result = await this.#options.store.login(
          stringField(body, "username", false, 64),
          stringField(body, "password", false, 256),
        );
        return this.#json(response, 200, result);
      }
      if (method === "POST" && url.pathname === "/v1/auth/account") {
        const body = await readJson(request);
        const identity = this.#options.store.getIdentity();
        const user = identity
          ? await this.#options.redeemCentralTicket?.(
              stringField(body, "accountTicket", false, INPUT_LIMITS.identifier),
              identity.serverId,
            )
          : null;
        if (!user) return this.#json(response, 401, { error: "OpenBot sign-in is required." });
        this.#checkRate(request, user.email);
        return this.#json(response, 200, await this.#options.store.loginWithAccount(user));
      }

      const token = bearerToken(request.headers.authorization);
      const member = token ? this.#options.store.authenticate(token) : null;
      if (!member || !token)
        return this.#json(response, 401, { error: "Authentication required." });

      if (method === "POST" && url.pathname === "/v1/auth/logout") {
        await this.#options.store.logout(token);
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === "/v1/auth/password") {
        const body = await readJson(request);
        await this.#options.store.changePassword(
          member.id,
          stringField(body, "currentPassword", false, 256),
          stringField(body, "newPassword", false, 256),
        );
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === "/v1/me") {
        return this.#json(response, 200, member);
      }
      if (method === "GET" && url.pathname === "/v1/events") {
        return this.#json(response, 426, { error: "Use WebSocket for remote events." });
      }
      if (method === "GET" && url.pathname === "/v1/host/remote-mac") {
        return this.#json(response, 200, this.#options.getRemoteMac());
      }
      if (method === "GET" && url.pathname === "/v1/host/remote-desktop-access") {
        const password = this.#options.getRemoteDesktopPassword?.() ?? null;
        return this.#json(response, 200, {
          configured: password !== null,
          password,
        });
      }
      if (method === "GET" && url.pathname === "/v1/browser/tabs") {
        return this.#json(response, 200, this.#options.browser.listTabs());
      }
      if (method === "GET" && url.pathname === "/v1/browser/control") {
        return this.#json(response, 200, this.#options.browser.getControlState());
      }
      if (method === "POST" && url.pathname === "/v1/browser/open") {
        const body = await readJson(request);
        return this.#json(
          response,
          201,
          await this.#options.browser.open(
            stringField(body, "url", false, INPUT_LIMITS.browserUrl),
            nullableString(body, "ownerThreadId"),
            nullableString(body, "ownerBotId"),
          ),
        );
      }
      if (method === "POST" && url.pathname === "/v1/browser/activate") {
        const body = await readJson(request);
        await this.#options.browser.activate(stringField(body, "tabId"));
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === "/v1/browser/close") {
        const body = await readJson(request);
        await this.#options.browser.close(stringField(body, "tabId"));
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === "/v1/browser/visible") {
        const body = await readJson(request);
        if (typeof body.visible !== "boolean") throw new HttpError(400, "visible is required.");
        await this.#options.browser.setVisible({
          visible: body.visible,
          bounds: body.bounds as import("@openbot/contracts/ipc").BrowserBounds | undefined,
        });
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === "/v1/attachments") {
        const name = url.searchParams.get("name")?.trim();
        const mimeType = url.searchParams.get("mime") ?? "application/octet-stream";
        if (!name || basename(name) !== name || name.length > INPUT_LIMITS.attachmentName) {
          throw new HttpError(400, "A safe attachment name is required.");
        }
        if (mimeType.length > INPUT_LIMITS.mimeType) {
          throw new HttpError(400, "The attachment MIME type is too long.");
        }
        const bytes = await readBinary(request, ATTACHMENT_LIMITS.fileBytes);
        const attachments = await this.#options.agents.prepareImportedAttachments(
          [],
          [{ name, mimeType, bytes }],
        );
        return this.#json(response, 201, attachments[0]);
      }
      const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([^/]+)$/);
      if (attachmentMatch) {
        const attachmentId = pathIdentifier(attachmentMatch[1], "attachmentId");
        if (method === "DELETE") {
          await this.#options.agents.discardDraftAttachment(attachmentId);
          return this.#empty(response, 204);
        }
        if (method === "GET") {
          const attachment = await this.#options.mailbox.resolveAttachment(attachmentId);
          if (!attachment) throw new HttpError(404, "Attachment not found.");
          const bytes = await readFile(attachment.path);
          response.writeHead(200, {
            "Content-Type": attachment.mimeType || "application/octet-stream",
            "Content-Length": String(bytes.length),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(attachment.path))}`,
          });
          response.end(bytes);
          return;
        }
      }
      if (method === "GET" && url.pathname === "/v1/team/members") {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listMembers());
      }
      const memberMatch = url.pathname.match(/^\/v1\/team\/members\/([^/]+)$/);
      if (method === "PATCH" && memberMatch) {
        requireAdmin(member);
        const body = await readJson(request);
        const role = body.role;
        const disabled = body.disabled;
        if (role !== undefined && role !== "admin" && role !== "member") {
          throw new HttpError(400, "Invalid role.");
        }
        if (disabled !== undefined && typeof disabled !== "boolean") {
          throw new HttpError(400, "disabled must be a boolean.");
        }
        return this.#json(
          response,
          200,
          await this.#options.store.updateMember(pathIdentifier(memberMatch[1], "memberId"), {
            ...(role ? { role } : {}),
            ...(disabled === undefined ? {} : { disabled }),
          }),
        );
      }
      if (method === "POST" && url.pathname === "/v1/team/invites") {
        requireAdmin(member);
        const body = await readJson(request);
        const role = stringField(body, "role");
        if (role !== "admin" && role !== "member") throw new HttpError(400, "Invalid role.");
        return this.#json(
          response,
          201,
          await this.#options.store.createInvite(
            role,
            nullableString(body, "email", INPUT_LIMITS.email) ?? undefined,
          ),
        );
      }
      if (method === "GET" && url.pathname === "/v1/team/invites") {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listInvites());
      }
      const inviteMatch = url.pathname.match(/^\/v1\/team\/invites\/([^/]+)$/);
      if (method === "DELETE" && inviteMatch) {
        requireAdmin(member);
        await this.#options.store.revokeInvite(pathIdentifier(inviteMatch[1], "inviteId"));
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === "/v1/team/sessions") {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listSessions());
      }
      const sessionMatch = url.pathname.match(/^\/v1\/team\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionMatch) {
        requireAdmin(member);
        await this.#options.store.revokeSession(pathIdentifier(sessionMatch[1], "sessionId"));
        return this.#empty(response, 204);
      }

      if (method === "GET" && url.pathname === "/v1/agents/status") {
        return this.#json(response, 200, this.#options.agents.getStatus());
      }
      if (method === "GET" && url.pathname === "/v1/agents/usage") {
        return this.#json(response, 200, await this.#options.agents.getUsage());
      }
      if (method === "GET" && url.pathname === "/v1/agents/models") {
        return this.#json(response, 200, await this.#options.agents.listModels());
      }
      if (method === "GET" && url.pathname === "/v1/agents") {
        return this.#json(response, 200, this.#options.agents.listBots());
      }
      if (method === "POST" && url.pathname === "/v1/agents") {
        return this.#json(response, 201, await this.#options.agents.createBot());
      }

      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(.*))?$/);
      if (agentMatch) {
        const botId = pathIdentifier(agentMatch[1], "botId");
        const action = agentMatch[2] ?? "";
        if (method === "PATCH" && !action) {
          const body = await readJson(request);
          return this.#json(
            response,
            200,
            await this.#options.agents.updateBot(botUpdate(body, botId)),
          );
        }
        if (method === "DELETE" && !action) {
          if (member.role === "member") throw new HttpError(403, "Members cannot delete agents.");
          await this.#options.agents.deleteBot(botId);
          return this.#empty(response, 204);
        }
        if (method === "GET" && action === "conversation") {
          return this.#json(response, 200, await this.#options.agents.readConversation(botId));
        }
        if (method === "POST" && action === "messages") {
          const body = await readJson(request);
          return this.#json(
            response,
            202,
            await this.#options.agents.sendMessage({
              botId,
              text: stringField(body, "text", true, INPUT_LIMITS.messageText),
              attachmentDraftIds: stringArray(body, "attachmentDraftIds"),
              replyToMessageId: nullableString(body, "replyToMessageId"),
            }),
          );
        }
        if (method === "GET" && action === "queue") {
          return this.#json(response, 200, this.#options.agents.listQueue(botId));
        }
        if (method === "POST" && action === "reactions") {
          const body = await readJson(request);
          const emoji = body.emoji;
          if (emoji !== null && !isMessageReaction(emoji))
            throw new HttpError(400, "Invalid emoji.");
          await this.#options.agents.setMessageReaction({
            botId,
            messageId: stringField(body, "messageId"),
            emoji,
          });
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "queue/cancel") {
          const body = await readJson(request);
          await this.#options.agents.cancelQueuedMessage(botId, stringField(body, "deliveryId"));
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "queue/pause") {
          const body = await readJson(request);
          if (typeof body.paused !== "boolean") throw new HttpError(400, "paused is required.");
          await this.#options.agents.setQueuePaused(botId, body.paused);
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "interrupt") {
          const body = await readJson(request);
          await this.#options.agents.interrupt(botId, stringField(body, "turnId"));
          return this.#empty(response, 204);
        }
      }

      if (method === "POST" && url.pathname === "/v1/prompts/respond") {
        const body = await readJson(request);
        await this.#options.agents.respondToPrompt({
          requestId: promptRequestId(body.requestId),
          answers: promptAnswers(body.answers),
        });
        return this.#empty(response, 204);
      }

      return this.#json(response, 404, { error: "Route not found." });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      const message = error instanceof Error ? error.message : "Request failed.";
      return this.#json(response, status, { error: message });
    }
  }

  #checkRate(request: import("node:http").IncomingMessage, username: string): void {
    const key = `${request.socket.remoteAddress ?? "local"}:${username.toLowerCase()}`;
    const current = this.#rateLimits.get(key);
    const now = Date.now();
    if (!current || current.resetAt <= now) {
      this.#rateLimits.set(key, { attempts: 1, resetAt: now + 15 * 60 * 1_000 });
      return;
    }
    current.attempts += 1;
    if (current.attempts > 5)
      throw new HttpError(429, "Too many sign-in attempts. Try again later.");
  }

  #broadcast(event: AgentEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.#eventClients) {
      if (client.readyState === webSockets.WebSocket.OPEN) client.send(payload);
    }
  }

  #connectDesktop(client: Ws.WebSocket, token: string): void {
    const target = createConnection({
      host: "127.0.0.1",
      port: this.#options.remoteDesktopPort ?? 5900,
    });
    const pending: Buffer[] = [];
    this.#desktopClients.set(client, { token, target });

    client.on("message", (data) => {
      if (!this.#options.store.authenticate(token)) {
        client.close(1008, "Team access was revoked");
        target.destroy();
        return;
      }
      const chunk = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (target.connecting) pending.push(chunk);
      else if (!target.destroyed) target.write(chunk);
    });
    client.on("close", () => target.destroy());
    client.on("error", () => target.destroy());

    target.on("connect", () => {
      for (const chunk of pending.splice(0)) target.write(chunk);
    });
    target.on("data", (chunk) => {
      if (client.readyState === webSockets.WebSocket.OPEN) client.send(chunk);
    });
    target.on("close", () => {
      this.#desktopClients.delete(client);
      if (client.readyState === webSockets.WebSocket.OPEN) client.close();
    });
    target.on("error", () => {
      if (client.readyState === webSockets.WebSocket.OPEN) {
        client.close(1011, "Remote Desktop is unavailable");
      }
    });
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(value)}\n`);
  }

  #empty(response: ServerResponse, status: number): void {
    response.writeHead(status);
    response.end();
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{20,512})$/);
  return match?.[1] ?? null;
}

function requireAdmin(member: TeamMemberSummary): void {
  if (member.role === "member") throw new HttpError(403, "Administrator access is required.");
}

async function readJson(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > JSON_LIMIT) throw new HttpError(413, "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "A valid JSON object is required.");
  }
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  allowEmpty = false,
  maxLength: number = INPUT_LIMITS.identifier,
): string {
  const item = value[field];
  if (typeof item !== "string" || (!allowEmpty && !item.trim())) {
    throw new HttpError(400, `${field} is required.`);
  }
  if (item.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return item;
}

function nullableString(
  value: Record<string, unknown>,
  field: string,
  maxLength: number = INPUT_LIMITS.identifier,
): string | null {
  const item = value[field];
  if (item === undefined || item === null || item === "") return null;
  if (typeof item !== "string") throw new HttpError(400, `${field} must be a string.`);
  if (item.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return item;
}

function pathIdentifier(value: string | undefined, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value ?? "");
  } catch {
    throw new HttpError(400, `${field} is invalid.`);
  }
  if (!decoded || decoded.length > INPUT_LIMITS.identifier) {
    throw new HttpError(400, `${field} is invalid.`);
  }
  return decoded;
}

function stringArray(
  value: Record<string, unknown>,
  field: string,
  maxItems: number = INPUT_LIMITS.attachments,
  maxLength: number = INPUT_LIMITS.identifier,
): string[] {
  const item = value[field];
  if (item === undefined) return [];
  if (
    !Array.isArray(item) ||
    item.length > maxItems ||
    !item.every((entry) => typeof entry === "string" && entry.length <= maxLength)
  ) {
    throw new HttpError(400, `${field} must be a string array.`);
  }
  return item;
}

function promptRequestId(value: unknown): string | number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.length > 0 && value.length <= INPUT_LIMITS.identifier) {
    return value;
  }
  throw new HttpError(400, "requestId is invalid.");
}

function promptAnswers(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "answers is required.");
  }
  const entries = Object.entries(value);
  if (entries.length > INPUT_LIMITS.promptQuestions) {
    throw new HttpError(400, "Too many prompt answers.");
  }
  const answers: Record<string, string[]> = {};
  for (const [key, answer] of entries) {
    if (
      key.length > INPUT_LIMITS.identifier ||
      !Array.isArray(answer) ||
      answer.length > INPUT_LIMITS.promptAnswersPerQuestion ||
      !answer.every(
        (item) => typeof item === "string" && item.length <= INPUT_LIMITS.promptAnswerText,
      )
    ) {
      throw new HttpError(400, "A prompt answer is invalid.");
    }
    answers[key] = answer;
  }
  return answers;
}

function botUpdate(value: Record<string, unknown>, botId: string): UpdateBotInput {
  const result: UpdateBotInput = { botId };
  const textFields = {
    name: INPUT_LIMITS.agentName,
    role: INPUT_LIMITS.agentTitle,
    description: INPUT_LIMITS.agentDescription,
  } as const;
  for (const [field, maxLength] of Object.entries(textFields)) {
    const item = value[field];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.length > maxLength) {
      throw new HttpError(400, `${field} is invalid.`);
    }
    result[field as keyof typeof textFields] = item;
  }
  if (value.notifications !== undefined) {
    if (typeof value.notifications !== "boolean") {
      throw new HttpError(400, "notifications is invalid.");
    }
    result.notifications = value.notifications;
  }
  if (value.model !== undefined) {
    if (!isAgentModel(value.model)) throw new HttpError(400, "model is invalid.");
    result.model = value.model;
  }
  if (value.reasoningEffort !== undefined) {
    if (!isReasoningEffort(value.reasoningEffort)) {
      throw new HttpError(400, "reasoningEffort is invalid.");
    }
    result.reasoningEffort = value.reasoningEffort;
  }
  if (value.avatarSeed !== undefined) {
    if (!isAvatarSeed(value.avatarSeed)) throw new HttpError(400, "avatarSeed is invalid.");
    result.avatarSeed = value.avatarSeed;
  }
  if (value.avatarHue !== undefined) {
    if (value.avatarHue !== null && !isAvatarHue(value.avatarHue)) {
      throw new HttpError(400, "avatarHue is invalid.");
    }
    result.avatarHue = value.avatarHue;
  }
  return result;
}

async function readBinary(
  request: import("node:http").IncomingMessage,
  limit: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new HttpError(413, "Attachment exceeds the 100 MB limit.");
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
