import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isAvatarMimeType } from "@openbot/contracts/avatar-images";
import { AVATAR_IMAGE_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT,
  type AgentEvent,
  type DirectConversationPage,
  type DirectConversationPageAnchor,
  type DirectConversationSnapshot,
  type DirectMessage,
  type DirectMessageRealtimeEvent,
  type DirectThreadSummary,
  type DirectTypingRealtimeEvent,
  type DuplicateBotResult,
  isMessageReaction,
  type ReorderQueueInput,
  type SidebarLayoutSnapshot,
  type SteerQueuedMessageInput,
  type TeamMemberSummary,
  type TeamPresenceSnapshot,
  type TeamRealtimeEvent,
  type UpdateQueuedMessageInput,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  isTeamCurrentCapability,
  supportsTeamSemanticTags,
  TEAM_AGENT_ACTIVITY_CAPABILITY,
  TEAM_CURRENT_CAPABILITIES,
  type TeamCurrentCapability,
} from "@openbot/contracts/team-protocol/current";
import {
  decodeTeamProtocolV1ClientEvent,
  TEAM_APP_VERSION_HEADER,
  TEAM_PROTOCOL_V1,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
  type TeamProtocolSupportV1,
} from "@openbot/contracts/team-protocol/v1";
import {
  encodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "@openbot/contracts/team-protocol/v1-adapter";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import { encodeTeamProtocolV3CurrentHttpResponse } from "@openbot/contracts/team-protocol/v3-adapter";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import type * as Ws from "ws";
import type { TeamChatStore } from "../backend/team-chat-store";
import {
  parseCreateRoutine,
  parseListRoutineRuns,
  parseSidebarLayoutAction,
  parseUpdateRoutine,
} from "./ipc/agent-inputs";
import { RemoteScreenError } from "./remote-screen-gateway";
import type { TeamApiOptions, TeamApiSidebarLayout } from "./team-api/dependencies";
import { HttpError } from "./team-api/http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./team-api/request-context";
import {
  approvalDecision,
  bearerToken,
  botCreate,
  botUpdate,
  browserTakeoverDecision,
  conversationForCapabilities,
  conversationSnapshotForCapabilities,
  firstHeaderValue,
  JSON_LIMIT,
  markerExclusionsForCapabilities,
  nullableString,
  pageAnchor,
  pageLimit,
  pathIdentifier,
  promptAnswers,
  promptRequestId,
  readBinary,
  readJson,
  requestCapabilities,
  requestProtocol,
  stringArray,
  stringField,
} from "./team-api/request-helpers";
import { routeBrowser } from "./team-api/route-browser";
import { routeDirect } from "./team-api/route-direct";
import { routeFiles } from "./team-api/route-files";
import { routeRemoteScreen } from "./team-api/route-remote-screen";
import { routeTeam } from "./team-api/route-team";
import { TeamStoreError } from "./team-store";

const EVENT_PAYLOAD_LIMIT = 256 * 1_024;
const TYPING_TIMEOUT_MS = 5_000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
const RATE_LIMIT_SWEEP_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_CAPACITY = 10_000;
const RUNTIME_SNAPSHOT_REQUEST_INTERVAL_MS = 1_000;
const TEST_LEGACY_EVENT_PROTOCOL = "openbot-events";
const TEST_LEGACY_SNAPSHOT_PROTOCOL = "openbot-events-v2";
const requireModule = createRequire(import.meta.url);
const webSockets: typeof Ws = requireModule(join(dirname(requireModule.resolve("ws/package.json")), "index.js"));

const logger = createOpenBotLogger("team-api-server");

interface EventClientState {
  token: string;
  memberId: string;
  capabilities: Set<string>;
  includeConversationEvents: boolean;
  typingBotId: string | null;
  typingTimer: ReturnType<typeof setTimeout> | null;
  directTypingRecipientId: string | null;
  directTypingTimer: ReturnType<typeof setTimeout> | null;
  snapshotResponsePending: boolean;
  snapshotRequestQueued: boolean;
  nextSnapshotRequestAt: number;
}

interface RateEntry {
  attempts: number;
  resetAt: number;
}

interface TeamProtocolIssue {
  status: 400 | 426;
  body: {
    error: string;
    code: "client_update_required" | "host_update_required" | "protocol_error";
    host: TeamProtocolSupportV1;
    client?: { appVersion: string; protocol: number };
  };
}

export class TeamApiServer {
  readonly #options: Omit<TeamApiOptions, "sidebarLayout"> & { sidebarLayout: TeamApiSidebarLayout };
  readonly #rateLimits = new Map<string, RateEntry>();
  readonly #eventClients = new Map<Ws.WebSocket, EventClientState>();
  readonly #responseRoutes = new WeakMap<
    ServerResponse,
    { method: string; path: string; protocol: number; capabilities: Set<string> }
  >();
  readonly #duplicateRequests = new Map<string, { sourceBotId: string; result: Promise<DuplicateBotResult> }>();
  readonly #webSockets = new webSockets.WebSocketServer({
    noServer: true,
    maxPayload: EVENT_PAYLOAD_LIMIT,
    handleProtocols: (protocols) =>
      protocols.has(TEAM_PROTOCOL_V1_WEBSOCKET)
        ? TEAM_PROTOCOL_V1_WEBSOCKET
        : protocols.has(TEST_LEGACY_SNAPSHOT_PROTOCOL)
          ? TEST_LEGACY_SNAPSHOT_PROTOCOL
          : protocols.has(TEST_LEGACY_EVENT_PROTOCOL)
            ? TEST_LEGACY_EVENT_PROTOCOL
            : false,
  });
  readonly #rateLimitCapacity: number;
  readonly #now: () => number;
  #server: Server | null = null;
  #port: number | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #agentListener: ((event: AgentEvent) => void) | null = null;
  #sidebarLayoutListener: ((layout: SidebarLayoutSnapshot) => void) | null = null;
  #localTypingBotId: string | null = null;
  #nextRateLimitSweepAt = 0;

  constructor(options: TeamApiOptions) {
    this.#options = { ...options, sidebarLayout: options.sidebarLayout ?? unavailableSidebarLayout() };
    this.#rateLimitCapacity = options.rateLimitCapacity ?? RATE_LIMIT_CAPACITY;
    this.#now = options.now ?? Date.now;
  }

  get port(): number | null {
    return this.#port;
  }

  async start(): Promise<number> {
    if (this.#server && this.#port) return this.#port;
    this.#server = createServer((request, response) => void this.#handle(request, response));
    this.#server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (this.#options.remoteScreen?.handlesUpgrade(url)) {
        this.#options.remoteScreen.handleUpgrade(request, socket, head, url);
        return;
      }
      const protocols = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim());
      if (
        this.#options.appVersion &&
        url.pathname === TEAM_API_ROUTES.events &&
        !protocols.includes(TEAM_PROTOCOL_V1_WEBSOCKET)
      ) {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const encodedToken = protocols.find((value) => value.startsWith("openbot-token."));
      const token = encodedToken?.slice("openbot-token.".length) ?? "";
      const member = token.length <= 512 ? this.#options.store.authenticate(token) : null;
      if (!member) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (
        url.pathname === TEAM_API_ROUTES.events &&
        (protocols.includes(TEAM_PROTOCOL_V1_WEBSOCKET) ||
          (!this.#options.appVersion &&
            (protocols.includes(TEST_LEGACY_SNAPSHOT_PROTOCOL) || protocols.includes(TEST_LEGACY_EVENT_PROTOCOL))))
      ) {
        this.#webSockets.handleUpgrade(request, socket, head, (client) => {
          this.#connectEvents(
            client,
            token,
            member.id,
            client.protocol === TEAM_PROTOCOL_V1_WEBSOCKET || client.protocol === TEST_LEGACY_SNAPSHOT_PROTOCOL,
            client.protocol === TEAM_PROTOCOL_V1_WEBSOCKET,
          );
        });
        return;
      }
      if (url.pathname === TEAM_API_ROUTES.remoteDesktopUpgrade) {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
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
    if (!address || isString(address)) throw new Error("Could not bind the team API.");
    this.#port = address.port;
    this.#agentListener = (event) => this.#broadcastAgentEvent(event);
    this.#options.agents.on("event", this.#agentListener);
    this.#sidebarLayoutListener = (layout) => this.#broadcastAgentEvent({ type: "sidebar-layout-changed", layout });
    this.#options.sidebarLayout.on("changed", this.#sidebarLayoutListener);
    this.#heartbeat = setInterval(() => {
      for (const [client, connection] of this.#eventClients) {
        if (!this.#options.store.authenticate(connection.token)) {
          client.close(1008, "Team access was revoked");
        } else if (client.readyState === webSockets.WebSocket.OPEN) client.ping();
      }
    }, 15_000);
    this.#heartbeat.unref?.();
    this.#publishPresence();
    return this.#port;
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#agentListener) this.#options.agents.off("event", this.#agentListener);
    this.#agentListener = null;
    if (this.#sidebarLayoutListener) this.#options.sidebarLayout.off("changed", this.#sidebarLayoutListener);
    this.#sidebarLayoutListener = null;
    for (const [client, connection] of this.#eventClients) {
      if (connection.typingTimer) clearTimeout(connection.typingTimer);
      if (connection.directTypingTimer) clearTimeout(connection.directTypingTimer);
      client.close(1001, "Server stopped");
    }
    this.#eventClients.clear();
    this.#localTypingBotId = null;
    try {
      await this.#options.remoteScreen?.stop();
    } finally {
      // The heartbeat and the event listeners are already gone. Leaving the socket open
      // would let the next `start()` hand back its port unchanged, so the previous account
      // keeps a listener that no longer checks a revoked session or delivers an event.
      const server = this.#server;
      this.#server = null;
      this.#port = null;
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      this.#publishPresence();
    }
  }

  getPresence(): TeamPresenceSnapshot {
    const identity = this.#options.store.getIdentity();
    if (!identity) {
      return { serverId: null, members: [], updatedAt: new Date().toISOString() };
    }
    const connections = [...this.#eventClients.values()];
    const owner = this.#options.store.listMembers().find((member) => member.role === "owner");
    return {
      serverId: identity.serverId,
      members: this.#options.store.listMembers().map((member) => {
        const memberConnections = connections.filter((connection) => connection.memberId === member.id);
        return {
          ...member,
          online: memberConnections.length > 0 || (member.id === owner?.id && this.#server !== null),
          typingBotId:
            (member.id === owner?.id ? this.#localTypingBotId : null) ??
            memberConnections.find((connection) => connection.typingBotId)?.typingBotId ??
            null,
        };
      }),
      updatedAt: new Date().toISOString(),
    };
  }

  setLocalTyping(botId: string | null, typing: boolean): void {
    const next = typing && this.#server ? botId : null;
    if (next === this.#localTypingBotId) return;
    this.#localTypingBotId = next;
    this.#publishPresence();
  }

  refreshPresence(): void {
    for (const [client, connection] of this.#eventClients) {
      if (!this.#options.store.authenticate(connection.token)) {
        client.close(1008, "Team access was revoked");
      }
    }
    this.#publishPresence();
  }

  refreshIdentity(): void {
    const identity = this.#options.store.getIdentity();
    if (!identity) return;
    const event: TeamRealtimeEvent = {
      type: "team-identity",
      serverId: identity.serverId,
      serverName: identity.serverName,
      logoVersion: identity.logoVersion,
    };
    const payload = encodeTeamProtocolV1CurrentEvent(event);
    if (!payload) return;
    for (const client of this.#eventClients.keys()) {
      if (client.readyState === webSockets.WebSocket.OPEN) client.send(payload);
    }
  }

  listDirectThreads(memberId: string): DirectThreadSummary[] {
    return this.#requireChat().listThreads(memberId);
  }

  readDirectConversation(memberId: string, otherMemberId: string): DirectConversationSnapshot {
    this.#requireDirectRecipient(memberId, otherMemberId);
    return this.#requireChat().readConversation(memberId, otherMemberId);
  }

  readDirectConversationPage(
    memberId: string,
    otherMemberId: string,
    anchor: DirectConversationPageAnchor,
    limit: number,
  ): DirectConversationPage {
    this.#requireDirectRecipient(memberId, otherMemberId);
    return this.#requireChat().readConversationPage(memberId, otherMemberId, anchor, limit);
  }

  sendDirectMessage(
    senderMemberId: string,
    input: { memberId: string; text: string; clientMessageId: string },
  ): DirectMessage {
    this.#requireDirectRecipient(senderMemberId, input.memberId);
    const message = this.#requireChat().sendMessage({
      clientMessageId: input.clientMessageId,
      senderMemberId,
      recipientMemberId: input.memberId,
      text: input.text,
    });
    this.#publishDirectMessage(message);
    return message;
  }

  markDirectRead(memberId: string, otherMemberId: string, throughSequence: number) {
    this.#requireDirectRecipient(memberId, otherMemberId);
    return this.#requireChat().markRead(memberId, otherMemberId, throughSequence);
  }

  setLocalDirectTyping(senderMemberId: string, recipientMemberId: string, typing: boolean): void {
    this.#requireDirectRecipient(senderMemberId, recipientMemberId);
    this.#publishDirectTyping(senderMemberId, recipientMemberId, typing);
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method ?? "GET";
    // The route is recorded before the target is parsed, because `#json` cannot answer without it and
    // this is the first thing below that can throw. Node's HTTP parser accepts request targets the
    // WHATWG URL parser rejects - `GET //[ HTTP/1.1` arrives as `//[` - and with the record written
    // afterwards that throw reached the catch below, made `#json` throw "route is unavailable", and
    // surfaced as an unhandled rejection over a socket nothing ever ended. `url.pathname` replaces
    // the raw target once there is one; only the failing path reads the raw value, and the frozen
    // adapters classify it as the unknown route it is.
    this.#responseRoutes.set(response, {
      method,
      path: request.url ?? "/",
      protocol: requestProtocol(request),
      capabilities: requestCapabilities(request),
    });
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const clientCapabilities = requestCapabilities(request);
      this.#responseRoutes.set(response, {
        method,
        path: url.pathname,
        protocol: requestProtocol(request),
        capabilities: clientCapabilities,
      });

      if (method === "GET" && url.pathname === TEAM_API_ROUTES.compatibility) {
        return this.#json(response, 200, this.#protocolSupport());
      }

      if (this.#options.remoteScreen?.handlesHttp(url)) {
        await this.#options.remoteScreen.handleHttp(request, response, url);
        return;
      }

      const protocolIssue = this.#protocolIssue(request);
      if (protocolIssue) return this.#json(response, protocolIssue.status, protocolIssue.body);

      if (method === "GET" && url.pathname === TEAM_API_ROUTES.identity) {
        const challenge = url.searchParams.get("challenge");
        return this.#json(
          response,
          200,
          challenge ? this.#options.store.getIdentityProof(challenge) : this.#options.store.getIdentity(),
        );
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.join.invitationPreview) {
        const body = await readJson(request);
        return this.#json(
          response,
          200,
          this.#options.store.previewInvite(stringField(body, "inviteToken", false, INPUT_LIMITS.identifier)),
        );
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.join.server) {
        const body = await readJson(request);
        this.#checkRate(request, stringField(body, "username", false, 64));
        const result = await this.#options.store.acceptInvite(
          stringField(body, "inviteToken", false, INPUT_LIMITS.identifier),
          stringField(body, "username", false, 64),
          stringField(body, "password", false, 256),
        );
        return this.#json(response, 201, result);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.join.account) {
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
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.login) {
        const body = await readJson(request);
        this.#checkRate(request, stringField(body, "username", false, 64));
        const result = await this.#options.store.login(
          stringField(body, "username", false, 64),
          stringField(body, "password", false, 256),
        );
        return this.#json(response, 200, result);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.account) {
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
      const authenticated = token ? this.#options.store.authenticateSession(token) : null;
      if (!authenticated || !token) {
        return this.#json(response, 401, { error: "Authentication required." });
      }
      const context = this.#requestContext(request, response, url, token, authenticated);
      const member = context.member;

      if ((await this.#routeTeam(context)) === "handled") return;
      if ((await this.#routeRemoteScreen(context)) === "handled") return;
      if ((await this.#routeDirect(context)) === "handled") return;
      if ((await this.#routeBrowser(context)) === "handled") return;
      if ((await this.#routeFiles(context)) === "handled") return;

      if (method === "GET" && url.pathname === TEAM_API_ROUTES.messages.search) {
        const query = url.searchParams.get("q") ?? "";
        if (!query.trim() || query.length > INPUT_LIMITS.messageText) {
          throw new HttpError(400, "A valid search query is required.");
        }
        return this.#json(
          response,
          200,
          this.#options.agents.searchConversationMessages(
            query,
            url.searchParams.get("botId") ?? undefined,
            url.searchParams.get("cursor") ?? undefined,
            pageLimit(url),
          ),
        );
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.status) {
        return this.#json(response, 200, this.#options.agents.getStatus());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.sidebarLayout.state) {
        return this.#json(response, 200, this.#options.sidebarLayout.getSnapshot());
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.sidebarLayout.actions) {
        const action = parseSidebarLayoutAction(await readJson(request));
        const layout = await this.#options.sidebarLayout.mutate(
          action,
          new Set(this.#options.agents.listBots().map((bot) => bot.id)),
        );
        return this.#json(response, 200, layout);
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.usage) {
        return this.#json(response, 200, await this.#options.agents.getUsage());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.models) {
        return this.#json(response, 200, await this.#options.agents.listModels());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.all) {
        return this.#json(response, 200, this.#options.agents.listBots());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.agents.conversationReads) {
        return this.#json(
          response,
          200,
          this.#options.agents.listConversationReads(member.id, markerExclusionsForCapabilities(clientCapabilities)),
        );
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.agents.all) {
        const body = await readJson(request);
        return this.#json(response, 201, await this.#options.agents.createBot(botCreate(body)));
      }

      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)(?:\/(.*))?$/);
      if (agentMatch) {
        const botId = pathIdentifier(agentMatch[1], "botId");
        const action = agentMatch[2] ?? "";
        if (method === "GET" && action === "usage") {
          return this.#json(response, 200, await this.#options.agents.getUsage(botId));
        }
        if (method === "GET" && action === "skills") {
          return this.#json(response, 200, (await this.#options.skills?.listInstalledForChatTags(botId)) ?? []);
        }
        if (method === "PATCH" && !action) {
          const body = await readJson(request);
          return this.#json(response, 200, await this.#options.agents.updateBot(botUpdate(body, botId)));
        }
        if (method === "POST" && action === "duplicate") {
          const body = await readJson(request);
          return this.#json(response, 201, await this.#duplicateAgent(botId, stringField(body, "operationId")));
        }
        if (method === "DELETE" && !action) {
          if (member.role === "member") throw new HttpError(403, "Members cannot delete agents.");
          await this.#options.agents.deleteBot(botId);
          await this.#options.sidebarLayout.removeAgent(botId);
          return this.#empty(response, 204);
        }
        if (action === "memories") {
          if (method === "GET") {
            return this.#json(response, 200, this.#options.agents.listMemories(botId));
          }
          if (method === "POST") {
            const body = await readJson(request);
            return this.#json(
              response,
              201,
              this.#options.agents.createMemory({
                botId,
                text: stringField(body, "text", false, INPUT_LIMITS.agentMemoryText),
              }),
            );
          }
          if (method === "DELETE") {
            this.#options.agents.clearMemories(botId);
            return this.#empty(response, 204);
          }
        }
        const memoryMatch = action.match(/^memories\/([^/]+)$/);
        if (memoryMatch) {
          const memoryId = pathIdentifier(memoryMatch[1], "memoryId");
          if (method === "PATCH") {
            const body = await readJson(request);
            return this.#json(
              response,
              200,
              this.#options.agents.updateMemory({
                botId,
                memoryId,
                text: stringField(body, "text", false, INPUT_LIMITS.agentMemoryText),
              }),
            );
          }
          if (method === "DELETE") {
            this.#options.agents.deleteMemory({ botId, memoryId });
            return this.#empty(response, 204);
          }
        }
        if (action === "routines") {
          if (method === "GET") {
            return this.#json(response, 200, this.#options.agents.listRoutines(botId));
          }
          if (method === "POST") {
            const body = await readJson(request);
            return this.#json(
              response,
              201,
              this.#options.agents.createRoutine(parseCreateRoutine({ ...body, botId })),
            );
          }
        }
        const routineMatch = action.match(/^routines\/([^/]+)(?:\/(test|runs))?$/);
        if (routineMatch) {
          const routineId = pathIdentifier(routineMatch[1], "routineId");
          const routineAction = routineMatch[2] ?? "";
          if (method === "PATCH" && !routineAction) {
            const body = await readJson(request);
            return this.#json(
              response,
              200,
              this.#options.agents.updateRoutine(parseUpdateRoutine({ ...body, botId, routineId })),
            );
          }
          if (method === "DELETE" && !routineAction) {
            await this.#options.agents.deleteRoutine({ botId, routineId });
            return this.#empty(response, 204);
          }
          if (method === "POST" && routineAction === "test") {
            return this.#json(response, 201, await this.#options.agents.testRoutine({ botId, routineId }));
          }
          if (method === "GET" && routineAction === "runs") {
            const rawLimit = url.searchParams.get("limit");
            const limit = rawLimit === null ? 50 : Number(rawLimit);
            return this.#json(
              response,
              200,
              this.#options.agents.listRoutineRuns(parseListRoutineRuns({ botId, routineId, limit })),
            );
          }
        }
        if (action === "avatar") {
          if (method === "PUT") {
            const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim() ?? "";
            if (!isAvatarMimeType(mimeType)) {
              throw new HttpError(415, "Choose a PNG, JPEG, or WebP image.");
            }
            const bytes = await readBinary(request, AVATAR_IMAGE_LIMITS.storedBytes);
            return this.#json(response, 200, await this.#options.agents.setAvatar(botId, { mimeType, bytes }));
          }
          if (method === "DELETE") {
            return this.#json(response, 200, await this.#options.agents.setAvatar(botId, null));
          }
          if (method === "GET") {
            const avatar = this.#options.agents.resolveAvatar(botId);
            if (!avatar || avatar.version !== url.searchParams.get("v")) {
              throw new HttpError(404, "Agent avatar not found.");
            }
            const bytes = await readFile(avatar.path);
            response.writeHead(200, {
              "Content-Type": avatar.mimeType,
              "Content-Length": String(bytes.length),
              "Cache-Control": "private, max-age=31536000, immutable",
              "X-Content-Type-Options": "nosniff",
            });
            response.end(bytes);
            return;
          }
        }
        if (method === "GET" && action === "conversation") {
          const conversation = await this.#options.agents.readConversationFor(botId, member.id);
          return this.#json(response, 200, conversationForCapabilities(conversation, clientCapabilities));
        }
        if (method === "GET" && action === "conversation-page") {
          const page = await this.#options.agents.readConversationPageFor(
            botId,
            member.id,
            pageAnchor(url),
            pageLimit(url),
            markerExclusionsForCapabilities(clientCapabilities),
          );
          return this.#json(response, 200, page);
        }
        if (method === "POST" && action === "conversation/unread") {
          if (requestProtocol(request) !== TEAM_PROTOCOL_V3 || !clientCapabilities.has("conversation-unread")) {
            throw new HttpError(400, "This client does not support marking conversations unread.");
          }
          await readJson(request);
          return this.#json(response, 200, await this.#options.agents.markConversationUnread(botId, member.id));
        }
        if (method === "POST" && action === "conversation/read") {
          const body = await readJson(request);
          return this.#json(
            response,
            200,
            await this.#options.agents.markConversationRead(
              botId,
              member.id,
              nullableString(body, "throughMessageId"),
              markerExclusionsForCapabilities(clientCapabilities),
            ),
          );
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
        if (method === "POST" && action === "failures/acknowledge") {
          const body = await readJson(request);
          this.#options.agents.acknowledgeFailedTurn(botId, stringField(body, "turnId"));
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "reactions") {
          const body = await readJson(request);
          const emoji = body.emoji;
          if (emoji !== null && !isMessageReaction(emoji)) throw new HttpError(400, "Invalid emoji.");
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
        if (method === "POST" && action === "queue/steer") {
          const body = await readJson(request);
          await this.#options.agents.steerQueuedMessage({
            botId,
            deliveryId: stringField(body, "deliveryId"),
            expectedTurnId: stringField(body, "expectedTurnId"),
          } satisfies SteerQueuedMessageInput);
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "queue/update") {
          const body = await readJson(request);
          await this.#options.agents.updateQueuedMessage({
            botId,
            deliveryId: stringField(body, "deliveryId"),
            text: stringField(body, "text", true, INPUT_LIMITS.messageText),
            keepAttachmentIds: stringArray(body, "keepAttachmentIds"),
            attachmentDraftIds: stringArray(body, "attachmentDraftIds"),
          } satisfies UpdateQueuedMessageInput);
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "queue/reorder") {
          const body = await readJson(request);
          await this.#options.agents.reorderQueue({
            botId,
            deliveryIds: stringArray(body, "deliveryIds", INPUT_LIMITS.messageRecipients),
          } satisfies ReorderQueueInput);
          return this.#empty(response, 204);
        }
        if (method === "POST" && action === "interrupt") {
          const body = await readJson(request);
          await this.#options.agents.interrupt(botId, stringField(body, "turnId"));
          return this.#empty(response, 204);
        }
      }

      if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.prompt) {
        const body = await readJson(request);
        await this.#options.agents.respondToPrompt({
          requestId: promptRequestId(body.requestId),
          answers: promptAnswers(body.answers),
        });
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.approval) {
        const body = await readJson(request);
        await this.#options.agents.respondToApproval({
          requestId: promptRequestId(body.requestId),
          decision: approvalDecision(body.decision),
        });
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.respond.browserTakeover) {
        const body = await readJson(request);
        await this.#options.agents.respondToBrowserTakeover({
          requestId: promptRequestId(body.requestId),
          decision: browserTakeoverDecision(body.decision),
        });
        return this.#empty(response, 204);
      }

      return this.#json(response, 404, { error: "Route not found." });
    } catch (error) {
      const expected =
        error instanceof HttpError || error instanceof RemoteScreenError || error instanceof TeamStoreError;
      const status =
        error instanceof HttpError || error instanceof RemoteScreenError ? error.status : expected ? 400 : 500;
      const message = expected ? error.message : "Request failed.";
      const code = error instanceof RemoteScreenError ? error.code : undefined;
      if (!expected) (this.#options.logger ?? logger).error("Team API request failed:", toLogValue(error));
      return this.#json(response, status, { error: message, ...(code ? { code } : {}) });
    }
  }

  // One method per module, so the dispatcher above reads as a list of domains and the wiring of
  // each narrow `*RouteDependencies` sits next to nothing else.
  #routeTeam(context: TeamApiRequestContext): Promise<RouteOutcome> {
    return routeTeam(context, {
      store: this.#options.store,
      remoteScreen: this.#options.remoteScreen,
      createInvite: this.#options.createInvite,
      onSessionRevoked: this.#options.onSessionRevoked,
      getPresence: () => this.getPresence(),
      refreshPresence: () => this.refreshPresence(),
    });
  }

  #routeRemoteScreen(context: TeamApiRequestContext): Promise<RouteOutcome> {
    return routeRemoteScreen(context, {
      store: this.#options.store,
      remoteScreen: this.#options.remoteScreen,
    });
  }

  #routeDirect(context: TeamApiRequestContext): Promise<RouteOutcome> {
    return routeDirect(context, {
      listDirectThreads: (memberId) => this.listDirectThreads(memberId),
      readDirectConversation: (memberId, otherMemberId) => this.readDirectConversation(memberId, otherMemberId),
      readDirectConversationPage: (memberId, otherMemberId, anchor, limit) =>
        this.readDirectConversationPage(memberId, otherMemberId, anchor, limit),
      sendDirectMessage: (senderMemberId, input) => this.sendDirectMessage(senderMemberId, input),
      markDirectRead: (memberId, otherMemberId, throughSequence) =>
        this.markDirectRead(memberId, otherMemberId, throughSequence),
    });
  }

  #routeBrowser(context: TeamApiRequestContext): Promise<RouteOutcome> {
    return routeBrowser(context, { browser: this.#options.browser });
  }

  #routeFiles(context: TeamApiRequestContext): Promise<RouteOutcome> {
    return routeFiles(context, { agents: this.#options.agents, mailbox: this.#options.mailbox });
  }

  #checkRate(request: IncomingMessage, username: string): void {
    const key = `${request.socket.remoteAddress ?? "local"}:${username.toLowerCase()}`;
    const now = this.#now();
    this.#pruneRateLimits(now, this.#rateLimits.size >= this.#rateLimitCapacity);
    const current = this.#rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && this.#rateLimits.size >= this.#rateLimitCapacity) {
        throw new HttpError(429, "Too many sign-in attempts. Try again later.");
      }
      this.#rateLimits.set(key, { attempts: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    current.attempts += 1;
    if (current.attempts > RATE_LIMIT_ATTEMPTS) {
      throw new HttpError(429, "Too many sign-in attempts. Try again later.");
    }
  }

  #pruneRateLimits(now: number, force: boolean): void {
    if (!force && now < this.#nextRateLimitSweepAt) return;
    for (const [key, entry] of this.#rateLimits) {
      if (entry.resetAt <= now) this.#rateLimits.delete(key);
    }
    this.#nextRateLimitSweepAt = now + RATE_LIMIT_SWEEP_MS;
  }

  #broadcastAgentEvent(event: AgentEvent): void {
    const filteredConversationPayloads = new Map<string, string>();
    let conversationInvalidation: string | undefined;
    let queueInvalidation: string | undefined;
    for (const [client, connection] of this.#eventClients) {
      const encodingOptions = { preserveSemanticTags: supportsTeamSemanticTags(connection.capabilities) };
      const supportsRuntimeSnapshots = connection.capabilities.has("agent-runtime-snapshots");
      const requiredCapability = eventCapability(event);
      if (requiredCapability && !connection.capabilities.has(requiredCapability)) continue;
      if (event.type === "conversation" && !connection.includeConversationEvents) continue;
      if (event.type === "queue-changed" && supportsRuntimeSnapshots && !connection.includeConversationEvents) {
        continue;
      }
      let outgoing: string;
      if (event.type === "conversation" && supportsRuntimeSnapshots) {
        conversationInvalidation ??=
          encodeTeamProtocolV1CurrentEvent({
            type: "conversation-invalidated",
            botId: event.snapshot.botId,
            revision: event.snapshot.revision,
          }) ?? undefined;
        if (!conversationInvalidation) continue;
        outgoing = conversationInvalidation;
      } else if (event.type === "queue-changed" && supportsRuntimeSnapshots) {
        queueInvalidation ??=
          encodeTeamProtocolV1CurrentEvent({ type: "queue-invalidated", botId: event.snapshot.botId }) ?? undefined;
        if (!queueInvalidation) continue;
        outgoing = queueInvalidation;
      } else if (
        event.type === "conversation" &&
        (!connection.capabilities.has("routine-event-markers") ||
          !connection.capabilities.has("routine-run-event-markers") ||
          !connection.capabilities.has("hosted-site-event-markers"))
      ) {
        const key = `${connection.capabilities.has("routine-event-markers")}:${connection.capabilities.has("routine-run-event-markers")}:${connection.capabilities.has("hosted-site-event-markers")}:${encodingOptions.preserveSemanticTags}`;
        let filtered = filteredConversationPayloads.get(key);
        if (!filtered) {
          filtered =
            encodeTeamProtocolV1CurrentEvent(
              {
                ...event,
                snapshot: conversationSnapshotForCapabilities(event.snapshot, connection.capabilities),
              },
              encodingOptions,
            ) ?? undefined;
          if (filtered) filteredConversationPayloads.set(key, filtered);
        }
        if (!filtered) continue;
        outgoing = filtered;
      } else {
        const payload = encodeTeamProtocolV1CurrentEvent(event, encodingOptions) ?? undefined;
        if (!payload) continue;
        outgoing = payload;
      }
      const limit = event.type === "runtime-snapshot" ? AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT : JSON_LIMIT;
      if (Buffer.byteLength(outgoing) > limit) continue;
      if (client.readyState !== webSockets.WebSocket.OPEN) continue;
      client.send(outgoing);
      if (event.type !== "turn-completed" || !supportsRuntimeSnapshots || connection.includeConversationEvents) {
        continue;
      }
      const completionSnapshot =
        encodeTeamProtocolV1CurrentEvent(
          {
            type: "runtime-snapshot",
            snapshot: this.#options.agents.getRuntimeSnapshot(),
          },
          encodingOptions,
        ) ?? undefined;
      if (!completionSnapshot) continue;
      if (Buffer.byteLength(completionSnapshot) > AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) return;
      client.send(completionSnapshot);
    }
  }

  #connectEvents(
    client: Ws.WebSocket,
    token: string,
    memberId: string,
    supportsSnapshotTransport: boolean,
    acceptsCapabilityDeclaration: boolean,
  ): void {
    const connection: EventClientState = {
      token,
      memberId,
      capabilities: new Set(
        acceptsCapabilityDeclaration
          ? []
          : TEAM_PROTOCOL_V1_CAPABILITIES.filter(
              (capability) =>
                capability !== "routine-event-markers" &&
                capability !== "routine-run-event-markers" &&
                capability !== "hosted-site-event-markers" &&
                (supportsSnapshotTransport || capability !== "agent-runtime-snapshots"),
            ),
      ),
      includeConversationEvents: !supportsSnapshotTransport,
      typingBotId: null,
      typingTimer: null,
      directTypingRecipientId: null,
      directTypingTimer: null,
      snapshotResponsePending: false,
      snapshotRequestQueued: false,
      nextSnapshotRequestAt: 0,
    };
    this.#eventClients.set(client, connection);
    client.on("error", () => {
      // Protocol errors, including maxPayload violations, also close the socket.
      // Consume the emitted error so malformed input cannot become an uncaught exception.
    });
    if (connection.capabilities.has("agent-runtime-snapshots")) {
      this.#sendRuntimeSnapshot(client, connection, false);
    }
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        client.close(1003, "Text events are required");
        return;
      }
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
        if (text.length > EVENT_PAYLOAD_LIMIT) throw new Error("Event payload is too large.");
        const event = decodeTeamProtocolV1ClientEvent(JSON.parse(text));
        if (event.type === "runtime-snapshot-request" && connection.capabilities.has("agent-runtime-snapshots")) {
          this.#sendRuntimeSnapshot(client, connection, true);
          return;
        }
        if (event.type === "agent-event-scope" && supportsSnapshotTransport) {
          if (acceptsCapabilityDeclaration) {
            if (!event.capabilities) throw new Error("Invalid client capabilities.");
            const snapshotsWereEnabled = connection.capabilities.has("agent-runtime-snapshots");
            connection.capabilities = new Set(event.capabilities.filter(isTeamCurrentCapability));
            if (connection.capabilities.has("agent-runtime-snapshots") && !snapshotsWereEnabled) {
              this.#sendRuntimeSnapshot(client, connection, false);
            }
          }
          connection.includeConversationEvents = event.includeConversations;
          return;
        }
        if (event.type === "team-direct-typing") {
          if (!connection.capabilities.has("direct-messages")) {
            throw new Error("Direct messages are not enabled for this client.");
          }
          const typing = event.typing;
          const recipientMemberId = event.recipientMemberId;
          if (recipientMemberId.length > INPUT_LIMITS.identifier) {
            throw new Error("Invalid direct typing recipient.");
          }
          this.#requireDirectRecipient(memberId, recipientMemberId);
          this.#setClientDirectTyping(connection, typing ? recipientMemberId : null);
          return;
        }
        if (event.type !== "team-typing") throw new Error("Unsupported team event.");
        const typing = event.typing;
        const botId = event.botId;
        if (typing && (!botId || botId.length > INPUT_LIMITS.identifier)) {
          throw new Error("A valid agent is required for typing state.");
        }
        this.#setClientTyping(connection, typing ? botId : null);
      } catch {
        client.close(1003, "Invalid team event payload");
      }
    });
    client.once("close", () => {
      if (connection.typingTimer) clearTimeout(connection.typingTimer);
      if (connection.directTypingTimer) clearTimeout(connection.directTypingTimer);
      const directTypingRecipientId = connection.directTypingRecipientId;
      connection.directTypingRecipientId = null;
      this.#eventClients.delete(client);
      if (directTypingRecipientId && !this.#hasDirectTyping(connection.memberId, directTypingRecipientId)) {
        this.#publishDirectTyping(connection.memberId, directTypingRecipientId, false);
      }
      this.#publishPresence();
    });
    this.#publishPresence();
  }

  #sendRuntimeSnapshot(client: Ws.WebSocket, connection: EventClientState, rateLimited: boolean): void {
    const now = this.#now();
    if (connection.snapshotResponsePending) {
      if (rateLimited) connection.snapshotRequestQueued = true;
      return;
    }
    if (
      client.readyState !== webSockets.WebSocket.OPEN ||
      client.bufferedAmount > EVENT_PAYLOAD_LIMIT ||
      (rateLimited && now < connection.nextSnapshotRequestAt)
    ) {
      return;
    }
    connection.snapshotResponsePending = true;
    if (rateLimited) connection.nextSnapshotRequestAt = now + RUNTIME_SNAPSHOT_REQUEST_INTERVAL_MS;
    try {
      const payload = encodeTeamProtocolV1CurrentEvent({
        type: "runtime-snapshot",
        snapshot: this.#options.agents.getRuntimeSnapshot(),
      });
      if (!payload) throw new Error("Runtime snapshot is not supported by Team protocol v1.");
      if (Buffer.byteLength(payload) > AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT) {
        throw new Error("Runtime snapshot exceeds its transport budget.");
      }
      client.send(payload, (error) => {
        connection.snapshotResponsePending = false;
        if (error && client.readyState === webSockets.WebSocket.OPEN) {
          client.close(1011, "Runtime snapshot could not be sent");
          return;
        }
        if (connection.snapshotRequestQueued) {
          connection.snapshotRequestQueued = false;
          this.#sendRuntimeSnapshot(client, connection, true);
        }
      });
    } catch {
      connection.snapshotResponsePending = false;
      client.close(1011, "Runtime snapshot could not be created");
    }
  }

  #setClientTyping(connection: EventClientState, botId: string | null): void {
    const changed = connection.typingBotId !== botId;
    connection.typingBotId = botId;
    if (connection.typingTimer) clearTimeout(connection.typingTimer);
    connection.typingTimer = botId
      ? setTimeout(() => {
          connection.typingTimer = null;
          if (!connection.typingBotId) return;
          connection.typingBotId = null;
          this.#publishPresence();
        }, TYPING_TIMEOUT_MS)
      : null;
    connection.typingTimer?.unref?.();
    if (changed) this.#publishPresence();
  }

  #setClientDirectTyping(connection: EventClientState, recipientMemberId: string | null): void {
    const previousRecipientId = connection.directTypingRecipientId;
    const changed = previousRecipientId !== recipientMemberId;
    const recipientAlreadyActive = recipientMemberId
      ? this.#hasDirectTyping(connection.memberId, recipientMemberId)
      : false;
    connection.directTypingRecipientId = recipientMemberId;
    if (changed && previousRecipientId && !this.#hasDirectTyping(connection.memberId, previousRecipientId)) {
      this.#publishDirectTyping(connection.memberId, previousRecipientId, false);
    }
    if (connection.directTypingTimer) clearTimeout(connection.directTypingTimer);
    connection.directTypingTimer = recipientMemberId
      ? setTimeout(() => {
          connection.directTypingTimer = null;
          const expiredRecipientId = connection.directTypingRecipientId;
          if (!expiredRecipientId) return;
          connection.directTypingRecipientId = null;
          if (!this.#hasDirectTyping(connection.memberId, expiredRecipientId)) {
            this.#publishDirectTyping(connection.memberId, expiredRecipientId, false);
          }
        }, TYPING_TIMEOUT_MS)
      : null;
    connection.directTypingTimer?.unref?.();
    if (changed && recipientMemberId && !recipientAlreadyActive) {
      this.#publishDirectTyping(connection.memberId, recipientMemberId, true);
    }
  }

  #hasDirectTyping(senderMemberId: string, recipientMemberId: string): boolean {
    return [...this.#eventClients.values()].some(
      (connection) =>
        connection.memberId === senderMemberId && connection.directTypingRecipientId === recipientMemberId,
    );
  }

  #publishPresence(): void {
    const snapshot = this.getPresence();
    this.#options.onPresence?.(snapshot);
    const event: TeamRealtimeEvent = { type: "team-presence", snapshot };
    const payload = encodeTeamProtocolV1CurrentEvent(event);
    if (!payload) return;
    for (const client of this.#eventClients.keys()) {
      if (client.readyState === webSockets.WebSocket.OPEN) client.send(payload);
    }
  }

  #publishDirectMessage(message: DirectMessage): void {
    const memberIds: [string, string] = [message.senderMemberId, message.recipientMemberId];
    const event: DirectMessageRealtimeEvent = {
      type: "team-direct-message",
      message,
      memberIds,
    };
    this.#sendToMembers(memberIds, event);
    const owner = this.#options.store.listMembers().find((member) => member.role === "owner");
    if (owner && memberIds.includes(owner.id)) this.#options.onDirectMessage?.(event);
  }

  #publishDirectTyping(senderMemberId: string, recipientMemberId: string, typing: boolean): void {
    const event: DirectTypingRealtimeEvent = {
      type: "team-direct-typing",
      senderMemberId,
      recipientMemberId,
      typing,
    };
    this.#sendToMembers([senderMemberId, recipientMemberId], event);
    const owner = this.#options.store.listMembers().find((member) => member.role === "owner");
    if (owner && (owner.id === senderMemberId || owner.id === recipientMemberId)) {
      this.#options.onDirectTyping?.(event);
    }
  }

  #sendToMembers(memberIds: string[], event: TeamRealtimeEvent): void {
    const payload = encodeTeamProtocolV1CurrentEvent(event);
    if (!payload) return;
    for (const [client, connection] of this.#eventClients) {
      if (
        connection.capabilities.has("direct-messages") &&
        memberIds.includes(connection.memberId) &&
        client.readyState === webSockets.WebSocket.OPEN
      ) {
        client.send(payload);
      }
    }
  }

  #requireChat(): TeamChatStore {
    if (!this.#options.chat) throw new Error("Direct messages are unavailable.");
    return this.#options.chat;
  }

  #duplicateAgent(sourceBotId: string, operationId: string): Promise<DuplicateBotResult> {
    const committed = this.#options.agents.committedBotDuplication(operationId, sourceBotId);
    if (committed) {
      return Promise.resolve({ bot: committed.bot, layout: this.#options.sidebarLayout.getSnapshot() });
    }
    const pending = this.#duplicateRequests.get(operationId);
    if (pending) {
      if (pending.sourceBotId !== sourceBotId) {
        return Promise.reject(new Error("This agent duplication operation belongs to another source agent."));
      }
      return pending.result;
    }
    const result = this.#performAgentDuplication(sourceBotId, operationId).finally(() => {
      this.#duplicateRequests.delete(operationId);
    });
    this.#duplicateRequests.set(operationId, { sourceBotId, result });
    return result;
  }

  async #performAgentDuplication(sourceBotId: string, operationId: string): Promise<DuplicateBotResult> {
    const bot = await this.#options.agents.duplicateBot(sourceBotId, operationId);
    try {
      const layout = await this.#options.sidebarLayout.placeDuplicateAfter(sourceBotId, bot.id, [
        ...this.#options.agents.listBots().map((candidate) => candidate.id),
        bot.id,
      ]);
      return await this.#options.agents.commitBotDuplication(bot.id, layout);
    } catch (error) {
      const rollbackResults = await Promise.allSettled([
        this.#options.agents.deleteBot(bot.id),
        this.#options.sidebarLayout.removeAgent(bot.id),
      ]);
      const rollbackErrors = rollbackResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          "Agent duplication failed and the incomplete copy could not be removed.",
        );
      }
      throw error;
    }
  }

  #requireDirectRecipient(senderMemberId: string, recipientMemberId: string): TeamMemberSummary {
    if (senderMemberId === recipientMemberId) {
      throw new Error("You cannot open a direct message with yourself.");
    }
    const sender = this.#options.store.getMember(senderMemberId);
    const recipient = this.#options.store.getMember(recipientMemberId);
    if (!sender || sender.disabled) throw new Error("Your team access is unavailable.");
    if (!recipient || recipient.disabled) throw new Error("This team member is unavailable.");
    return recipient;
  }

  #json(response: ServerResponse, status: number, value: object | null): RouteOutcome {
    const route = this.#responseRoutes.get(response);
    if (!route) throw new Error("Team API response route is unavailable.");
    const options = { preserveSemanticTags: supportsTeamSemanticTags(route.capabilities) };
    // The body is encoded before the head is written. A response the negotiated protocol cannot
    // represent - a route its frozen adapter does not classify - makes the encoder throw, and with
    // the headers already sent that throw could neither answer the caller nor end the request: it
    // surfaced as a hung socket and an `ERR_HTTP_HEADERS_SENT` rejection out of `#handle`'s own
    // error path. Encoding first lets that failure become the 500 the caller can read.
    const body =
      route.protocol === TEAM_PROTOCOL_V3
        ? encodeTeamProtocolV3CurrentHttpResponse(route.method, route.path, status, value, options)
        : encodeTeamProtocolV1CurrentHttpResponse(route.method, route.path, status, value, options);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${body}\n`);
    return "handled";
  }

  #protocolSupport(): TeamProtocolSupportV1 {
    return {
      appVersion: this.#options.appVersion ?? "0.0.0",
      protocol: { minimum: TEAM_PROTOCOL_V1, maximum: TEAM_PROTOCOL_V3 },
      capabilities: [...TEAM_CURRENT_CAPABILITIES],
    };
  }

  #protocolIssue(request: IncomingMessage): TeamProtocolIssue | null {
    if (!this.#options.appVersion) return null;
    const rawProtocol = firstHeaderValue(request.headers[TEAM_PROTOCOL_VERSION_HEADER.toLowerCase()]);
    const clientAppVersion = firstHeaderValue(request.headers[TEAM_APP_VERSION_HEADER.toLowerCase()]);
    const protocol = rawProtocol ? Number(rawProtocol) : null;
    const host = this.#protocolSupport();
    if (!rawProtocol || !clientAppVersion) {
      return {
        status: 426,
        body: {
          error: "Update this OpenBot client before connecting to this host.",
          code: "client_update_required",
          host,
        },
      };
    }
    if (
      !Number.isSafeInteger(protocol) ||
      protocol === null ||
      protocol < 1 ||
      protocol > 65_535 ||
      clientAppVersion.length > 64
    ) {
      return {
        status: 400,
        body: { error: "Invalid Team API protocol headers.", code: "protocol_error", host },
      };
    }
    if (protocol >= TEAM_PROTOCOL_V1 && protocol <= TEAM_PROTOCOL_V3) return null;
    const clientIsOlder = protocol < TEAM_PROTOCOL_V1;
    return {
      status: 426,
      body: {
        error: clientIsOlder
          ? "Update this OpenBot client before connecting to this host."
          : "Update OpenBot on the host before connecting.",
        code: clientIsOlder ? "client_update_required" : "host_update_required",
        host,
        client: { appVersion: clientAppVersion, protocol },
      },
    };
  }

  #empty(response: ServerResponse, status: number): RouteOutcome {
    response.writeHead(status);
    response.end();
    return "handled";
  }

  // The context is assembled here rather than in `request-context.ts` because `json` and `empty`
  // have to close over the per-response route record, which only this class holds.
  #requestContext(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    token: string,
    authenticated: { member: TeamMemberSummary; sessionId: string; sessionExpiresAt: string },
  ): TeamApiRequestContext {
    return {
      request,
      response,
      method: request.method ?? "GET",
      url,
      protocol: requestProtocol(request),
      capabilities: requestCapabilities(request),
      member: authenticated.member,
      token,
      sessionId: authenticated.sessionId,
      sessionExpiresAt: authenticated.sessionExpiresAt,
      json: (status, value) => this.#json(response, status, value),
      empty: (status) => this.#empty(response, status),
    };
  }
}

function unavailableSidebarLayout(): TeamApiSidebarLayout {
  return {
    getSnapshot: () => ({
      revision: 0,
      sections: [],
      order: ["people", "unassigned"],
      agentAssignments: {},
      agentOrder: [],
    }),
    mutate: async () => {
      throw new HttpError(503, "Sidebar layout is unavailable.");
    },
    placeDuplicateAfter: async () => {
      throw new HttpError(503, "Sidebar layout is unavailable.");
    },
    removeAgent: async () => ({
      revision: 0,
      sections: [],
      order: ["people", "unassigned"],
      agentAssignments: {},
      agentOrder: [],
    }),
    on: () => undefined,
    off: () => undefined,
  };
}

function eventCapability(event: AgentEvent): TeamCurrentCapability | null {
  if (event.type === "turn-progress") return TEAM_AGENT_ACTIVITY_CAPABILITY;
  if (event.type === "runtime-snapshot") return "agent-runtime-snapshots";
  if (event.type === "sidebar-layout-changed") return "sidebar-layout";
  if (event.type === "browser-changed" || event.type === "browser-control-changed") return "browser-control";
  if (event.type === "conversation-page") return "conversation-pagination";
  return null;
}
