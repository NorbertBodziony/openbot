import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { AgentEvent, TeamMemberSummary, UpdateBotInput } from "../shared/ipc";
import type { TeamStore } from "./team-store";

const JSON_LIMIT = 1024 * 1024;

interface TeamApiOptions {
  store: TeamStore;
  agents: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  getRemoteMac: () => { hostname: string | null; online: boolean };
}

interface RateEntry {
  attempts: number;
  resetAt: number;
}

export class TeamApiServer {
  readonly #options: TeamApiOptions;
  readonly #rateLimits = new Map<string, RateEntry>();
  readonly #eventClients = new Set<ServerResponse>();
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
      for (const client of this.#eventClients) client.write(": heartbeat\n\n");
    }, 15_000);
    this.#heartbeat.unref?.();
    return this.#port;
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#agentListener) this.#options.agents.off("event", this.#agentListener);
    this.#agentListener = null;
    for (const client of this.#eventClients) client.end();
    this.#eventClients.clear();
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
        this.#checkRate(request, stringField(body, "username"));
        const result = await this.#options.store.acceptInvite(
          stringField(body, "inviteToken"),
          stringField(body, "username"),
          stringField(body, "password"),
        );
        return this.#json(response, 201, result);
      }
      if (method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJson(request);
        this.#checkRate(request, stringField(body, "username"));
        const result = await this.#options.store.login(
          stringField(body, "username"),
          stringField(body, "password"),
        );
        return this.#json(response, 200, result);
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
          stringField(body, "currentPassword"),
          stringField(body, "newPassword"),
        );
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === "/v1/me") {
        return this.#json(response, 200, member);
      }
      if (method === "GET" && url.pathname === "/v1/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
          "Cache-Control": "no-store",
        });
        response.write(": connected\n\n");
        this.#eventClients.add(response);
        request.once("close", () => this.#eventClients.delete(response));
        return;
      }
      if (method === "GET" && url.pathname === "/v1/host/remote-mac") {
        return this.#json(response, 200, this.#options.getRemoteMac());
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
            stringField(body, "url"),
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
          bounds: body.bounds as import("../shared/ipc").BrowserBounds | undefined,
        });
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === "/v1/attachments") {
        const name = url.searchParams.get("name")?.trim();
        const mimeType = url.searchParams.get("mime") ?? "application/octet-stream";
        if (!name || basename(name) !== name || name.length > 255) {
          throw new HttpError(400, "A safe attachment name is required.");
        }
        const bytes = await readBinary(request, 100 * 1024 * 1024);
        const attachments = await this.#options.agents.prepareImportedAttachments(
          [],
          [{ name, mimeType, bytes }],
        );
        return this.#json(response, 201, attachments[0]);
      }
      const attachmentMatch = url.pathname.match(/^\/v1\/attachments\/([^/]+)$/);
      if (attachmentMatch) {
        const attachmentId = decodeURIComponent(attachmentMatch[1] ?? "");
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
          await this.#options.store.updateMember(decodeURIComponent(memberMatch[1] ?? ""), {
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
        return this.#json(response, 201, await this.#options.store.createInvite(role));
      }
      if (method === "GET" && url.pathname === "/v1/team/invites") {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listInvites());
      }
      const inviteMatch = url.pathname.match(/^\/v1\/team\/invites\/([^/]+)$/);
      if (method === "DELETE" && inviteMatch) {
        requireAdmin(member);
        await this.#options.store.revokeInvite(decodeURIComponent(inviteMatch[1] ?? ""));
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === "/v1/team/sessions") {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listSessions());
      }
      const sessionMatch = url.pathname.match(/^\/v1\/team\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionMatch) {
        requireAdmin(member);
        await this.#options.store.revokeSession(decodeURIComponent(sessionMatch[1] ?? ""));
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
        const botId = decodeURIComponent(agentMatch[1] ?? "");
        const action = agentMatch[2] ?? "";
        if (method === "PATCH" && !action) {
          const body = (await readJson(request)) as unknown as UpdateBotInput;
          return this.#json(
            response,
            200,
            await this.#options.agents.updateBot({ ...body, botId }),
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
              text: stringField(body, "text", true),
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
          if (emoji !== null && typeof emoji !== "string")
            throw new HttpError(400, "Invalid emoji.");
          await this.#options.agents.setMessageReaction({
            botId,
            messageId: stringField(body, "messageId"),
            emoji: emoji as import("../shared/ipc").MessageReaction | null,
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
        const answers = body.answers;
        if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
          throw new HttpError(400, "answers is required.");
        }
        await this.#options.agents.respondToPrompt({
          requestId: body.requestId as string | number,
          answers: answers as Record<string, string[]>,
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
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#eventClients) client.write(payload);
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
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{20,})$/);
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

function stringField(value: Record<string, unknown>, field: string, allowEmpty = false): string {
  const item = value[field];
  if (typeof item !== "string" || (!allowEmpty && !item.trim())) {
    throw new HttpError(400, `${field} is required.`);
  }
  return item;
}

function nullableString(value: Record<string, unknown>, field: string): string | null {
  const item = value[field];
  if (item === undefined || item === null || item === "") return null;
  if (typeof item !== "string") throw new HttpError(400, `${field} must be a string.`);
  return item;
}

function stringArray(value: Record<string, unknown>, field: string): string[] {
  const item = value[field];
  if (item === undefined) return [];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string")) {
    throw new HttpError(400, `${field} must be a string array.`);
  }
  return item;
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
