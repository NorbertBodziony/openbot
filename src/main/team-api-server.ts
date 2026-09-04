import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { isAvatarMimeType } from "@openbot/contracts/avatar-images";
import { ATTACHMENT_LIMITS, AVATAR_IMAGE_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT,
  type AgentEvent,
  type CentralAuthUser,
  type ConversationPageAnchor,
  type ConversationSnapshot,
  type ConversationWithReadState,
  type CreateBotInput,
  type CreateTeamInviteInput,
  type DirectConversationPage,
  type DirectConversationPageAnchor,
  type DirectConversationSnapshot,
  type DirectMessage,
  type DirectMessageRealtimeEvent,
  type DirectThreadSummary,
  type DirectTypingRealtimeEvent,
  type DuplicateBotResult,
  HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX,
  type InstalledSkill,
  type InviteSummary,
  isAgentModel,
  isAvatarHue,
  isAvatarSeed,
  isMessageReaction,
  isReasoningEffort,
  type ReorderQueueInput,
  type RespondToApprovalInput,
  type RespondToBrowserTakeoverInput,
  ROUTINE_EVENT_ITEM_TYPE_PREFIX,
  ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX,
  type SidebarLayoutSnapshot,
  type SteerQueuedMessageInput,
  type TeamMemberSummary,
  type TeamPresenceSnapshot,
  type TeamRealtimeEvent,
  type UpdateBotInput,
  type UpdateQueuedMessageInput,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
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
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_V1_WEBSOCKET,
  TEAM_PROTOCOL_VERSION_HEADER,
  type TeamProtocolSupportV1,
} from "@openbot/contracts/team-protocol/v1";
import {
  decodeTeamProtocolV1CurrentHttpRequest,
  encodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "@openbot/contracts/team-protocol/v1-adapter";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import {
  decodeTeamProtocolV3CurrentHttpRequest,
  encodeTeamProtocolV3CurrentHttpResponse,
} from "@openbot/contracts/team-protocol/v3-adapter";
import { createOpenBotLogger, toLogValue } from "@openbot/logging";
import type * as Ws from "ws";
import type { AgentService } from "../backend/agent-service";
import type { BrowserHost } from "../backend/browser-host";
import type { MailboxStore } from "../backend/mailbox-store";
import type { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import type { TeamChatStore } from "../backend/team-chat-store";
import {
  parseCreateRoutine,
  parseListRoutineRuns,
  parseSidebarLayoutAction,
  parseUpdateRoutine,
} from "./ipc/agent-inputs";
import { RemoteScreenError, type RemoteScreenGateway } from "./remote-screen-gateway";
import { type TeamStore, TeamStoreError } from "./team-store";

const JSON_LIMIT = 1024 * 1024;
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

type TeamApiAgentMethods = Pick<
  AgentService,
  | "getStatus"
  | "getRuntimeSnapshot"
  | "getUsage"
  | "listModels"
  | "listBots"
  | "listConversationReads"
  | "createBot"
  | "committedBotDuplication"
  | "duplicateBot"
  | "commitBotDuplication"
  | "updateBot"
  | "deleteBot"
  | "listMemories"
  | "createMemory"
  | "updateMemory"
  | "deleteMemory"
  | "clearMemories"
  | "listRoutines"
  | "createRoutine"
  | "updateRoutine"
  | "deleteRoutine"
  | "testRoutine"
  | "listRoutineRuns"
  | "setAvatar"
  | "resolveAvatar"
  | "readConversationFor"
  | "readConversationPageFor"
  | "searchConversationMessages"
  | "markConversationRead"
  | "markConversationUnread"
  | "prepareImportedAttachments"
  | "discardDraftAttachment"
  | "resolveSharedFile"
  | "resolveWorkspaceFile"
  | "sendMessage"
  | "listQueue"
  | "acknowledgeFailedTurn"
  | "setMessageReaction"
  | "cancelQueuedMessage"
  | "steerQueuedMessage"
  | "updateQueuedMessage"
  | "reorderQueue"
  | "interrupt"
  | "respondToPrompt"
  | "respondToApproval"
  | "respondToBrowserTakeover"
>;

type TeamApiAgents = TeamApiAgentMethods & {
  on: (event: "event", listener: (event: AgentEvent) => void) => void;
  off: (event: "event", listener: (event: AgentEvent) => void) => void;
};

type TeamApiMailbox = Pick<MailboxStore, "resolveAttachment">;
type TeamApiSidebarLayout = Pick<
  SidebarLayoutStore,
  "getSnapshot" | "mutate" | "removeAgent" | "placeDuplicateAfter"
> & {
  on: (event: "changed", listener: (layout: SidebarLayoutSnapshot) => void) => void;
  off: (event: "changed", listener: (layout: SidebarLayoutSnapshot) => void) => void;
};
type TeamApiBrowser = Pick<
  BrowserHost,
  | "listTabs"
  | "getControlState"
  | "open"
  | "activate"
  | "navigate"
  | "reload"
  | "close"
  | "capturePreview"
  | "setVisible"
>;
type TeamApiRemoteScreen = Pick<
  RemoteScreenGateway,
  | "handlesUpgrade"
  | "handleUpgrade"
  | "handlesHttp"
  | "handleHttp"
  | "stop"
  | "capabilities"
  | "createSession"
  | "selectDisplay"
  | "closeMemberSession"
  | "revokeTeamSession"
  | "revokeMember"
>;

interface TeamApiOptions {
  appVersion?: string;
  store: TeamStore;
  agents: TeamApiAgents;
  skills?: { listInstalledForChatTags: (botId: string) => Promise<InstalledSkill[]> };
  sidebarLayout?: TeamApiSidebarLayout;
  mailbox: TeamApiMailbox;
  browser: TeamApiBrowser;
  remoteScreen?: TeamApiRemoteScreen;
  redeemCentralTicket?: (ticket: string, serverId: string) => Promise<CentralAuthUser | null>;
  onPresence?: (snapshot: TeamPresenceSnapshot) => void;
  chat?: TeamChatStore;
  onDirectMessage?: (event: DirectMessageRealtimeEvent) => void;
  onDirectTyping?: (event: DirectTypingRealtimeEvent) => void;
  createInvite?: (input: CreateTeamInviteInput) => Promise<InviteSummary>;
  onSessionRevoked?: (sessionId: string) => Promise<void> | void;
  rateLimitCapacity?: number;
  now?: () => number;
}

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

  async #handle(request: import("node:http").IncomingMessage, response: ServerResponse) {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
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
      const member = authenticated?.member ?? null;
      if (!member || !token || !authenticated) {
        return this.#json(response, 401, { error: "Authentication required." });
      }

      if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.logout) {
        await this.#options.store.logout(token);
        await this.#options.remoteScreen?.revokeTeamSession(authenticated.sessionId);
        this.refreshPresence();
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.auth.password) {
        const body = await readJson(request);
        await this.#options.store.changePassword(
          member.id,
          stringField(body, "currentPassword", false, 256),
          stringField(body, "newPassword", false, 256),
        );
        await this.#options.remoteScreen?.revokeMember(member.id);
        this.refreshPresence();
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.me) {
        return this.#json(response, 200, member);
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.presence) {
        return this.#json(response, 200, this.getPresence());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.logo) {
        const logo = this.#options.store.resolveLogo();
        if (!logo || (url.searchParams.get("v") && url.searchParams.get("v") !== logo.version)) {
          return this.#json(response, 404, { error: "Server logo not found." });
        }
        const bytes = await readFile(logo.path);
        response.writeHead(200, {
          "Content-Type": logo.mimeType,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.events) {
        return this.#json(response, 426, { error: "Use WebSocket for remote events." });
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.remoteScreen.capabilities) {
        if (!this.#options.remoteScreen)
          throw new RemoteScreenError(503, "host_unavailable", "Remote control is unavailable.");
        return this.#json(response, 200, this.#options.remoteScreen.capabilities());
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.remoteScreen.sessions) {
        const identity = this.#options.store.getIdentity();
        if (!identity || !this.#options.remoteScreen) {
          throw new RemoteScreenError(503, "host_unavailable", "Remote control is unavailable.");
        }
        return this.#json(
          response,
          201,
          await this.#options.remoteScreen.createSession({
            serverId: identity.serverId,
            memberId: member.id,
            teamSessionId: authenticated.sessionId,
            teamSessionExpiresAt: authenticated.sessionExpiresAt,
            publicHttpBaseUrl: publicHttpBaseUrl(request),
          }),
        );
      }
      if (method === "PUT" && url.pathname === TEAM_API_ROUTES.remoteScreen.display) {
        if (!this.#options.remoteScreen) {
          throw new RemoteScreenError(503, "host_unavailable", "Remote control is unavailable.");
        }
        const body = await readJson(request);
        await this.#options.remoteScreen.selectDisplay(stringField(body, "displayId"));
        return this.#empty(response, 204);
      }
      const remoteScreenSessionMatch = url.pathname.match(/^\/v1\/remote-screen\/sessions\/([^/]+)$/);
      if (method === "DELETE" && remoteScreenSessionMatch) {
        if (!this.#options.remoteScreen) {
          throw new RemoteScreenError(503, "host_unavailable", "Remote control is unavailable.");
        }
        const sessionId = pathIdentifier(remoteScreenSessionMatch[1], "sessionId");
        if (!(await this.#options.remoteScreen.closeMemberSession(sessionId, member.id))) {
          throw new RemoteScreenError(404, "session_expired", "Remote control session not found.");
        }
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.host.remoteMac) {
        return this.#json(response, 426, { error: "Update required.", code: "protocol_mismatch" });
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.host.remoteDesktopAccess) {
        return this.#json(response, 426, { error: "Update required.", code: "protocol_mismatch" });
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.direct.threads) {
        return this.#json(response, 200, this.listDirectThreads(member.id));
      }
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
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.direct.messages) {
        const body = await readJson(request);
        return this.#json(
          response,
          201,
          this.sendDirectMessage(member.id, {
            memberId: stringField(body, "memberId", false, INPUT_LIMITS.identifier),
            text: stringField(body, "text", false, INPUT_LIMITS.directMessageText),
            clientMessageId: stringField(body, "clientMessageId", false, INPUT_LIMITS.identifier),
          }),
        );
      }
      const directConversationMatch = url.pathname.match(/^\/v1\/direct\/conversations\/([^/]+)(?:\/(read|page))?$/);
      if (method === "GET" && directConversationMatch && !directConversationMatch[2]) {
        return this.#json(
          response,
          200,
          this.readDirectConversation(member.id, pathIdentifier(directConversationMatch[1], "memberId")),
        );
      }
      if (method === "POST" && directConversationMatch?.[2] === "read") {
        const body = await readJson(request);
        const throughSequence = body.throughSequence;
        if (!isNumber(throughSequence) || !Number.isSafeInteger(throughSequence)) {
          throw new HttpError(400, "Invalid direct-message read boundary.");
        }
        return this.#json(
          response,
          200,
          this.markDirectRead(member.id, pathIdentifier(directConversationMatch[1], "memberId"), throughSequence),
        );
      }
      if (method === "GET" && directConversationMatch?.[2] === "page") {
        return this.#json(
          response,
          200,
          this.readDirectConversationPage(
            member.id,
            pathIdentifier(directConversationMatch[1], "memberId"),
            pageAnchor(url),
            pageLimit(url),
          ),
        );
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.browser.tabs) {
        return this.#json(response, 200, this.#options.browser.listTabs());
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.browser.control) {
        return this.#json(response, 200, this.#options.browser.getControlState());
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.open) {
        const body = await readJson(request);
        const focus = body.focus ?? false;
        if (!isBoolean(focus)) throw new HttpError(400, "focus must be a boolean.");
        return this.#json(
          response,
          201,
          await this.#options.browser.open(
            stringField(body, "url", false, INPUT_LIMITS.browserUrl),
            nullableString(body, "ownerThreadId"),
            nullableString(body, "ownerBotId"),
            focus,
          ),
        );
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.activate) {
        const body = await readJson(request);
        await this.#options.browser.activate(stringField(body, "tabId"));
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.navigate) {
        const body = await readJson(request);
        const direction = stringField(body, "direction");
        if (direction !== "back" && direction !== "forward") {
          throw new HttpError(400, "Invalid browser navigation direction.");
        }
        await this.#options.browser.navigate(stringField(body, "tabId"), direction);
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.reload) {
        const body = await readJson(request);
        await this.#options.browser.reload(stringField(body, "tabId"));
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.close) {
        const body = await readJson(request);
        await this.#options.browser.close(stringField(body, "tabId"));
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.preview) {
        const body = await readJson(request);
        return this.#json(response, 200, await this.#options.browser.capturePreview(stringField(body, "tabId")));
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.browser.visible) {
        const body = await readJson(request);
        if (!isBoolean(body.visible)) throw new HttpError(400, "visible is required.");
        await this.#options.browser.setVisible({
          visible: body.visible,
          bounds: body.bounds === undefined ? undefined : parseBrowserBounds(body.bounds),
        });
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.attachments) {
        const name = url.searchParams.get("name")?.trim();
        const mimeType = url.searchParams.get("mime") ?? "application/octet-stream";
        if (!name || basename(name) !== name || name.length > INPUT_LIMITS.attachmentName) {
          throw new HttpError(400, "A safe attachment name is required.");
        }
        if (mimeType.length > INPUT_LIMITS.mimeType) {
          throw new HttpError(400, "The attachment MIME type is too long.");
        }
        const bytes = await readBinary(request, ATTACHMENT_LIMITS.fileBytes);
        const attachments = await this.#options.agents.prepareImportedAttachments([], [{ name, mimeType, bytes }]);
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
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.sharedFiles) {
        const sharedPath = url.searchParams.get("path");
        if (!sharedPath || sharedPath.length > INPUT_LIMITS.path) {
          throw new HttpError(400, "A valid shared file path is required.");
        }
        const sharedFile = await this.#options.agents.resolveSharedFile(sharedPath);
        if (sharedFile.size > ATTACHMENT_LIMITS.fileBytes) {
          throw new HttpError(413, "The shared file exceeds the 100 MB limit.");
        }
        const bytes = await readFile(sharedFile.path);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(sharedFile.name)}`,
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.workspaceFiles) {
        const botId = url.searchParams.get("botId");
        const workspacePath = url.searchParams.get("path");
        if (!botId || botId.length > INPUT_LIMITS.identifier) {
          throw new HttpError(400, "A valid agent id is required.");
        }
        if (!workspacePath || workspacePath.length > INPUT_LIMITS.path) {
          throw new HttpError(400, "A valid workspace file path is required.");
        }
        const workspaceFile = await this.#options.agents.resolveWorkspaceFile(botId, workspacePath);
        if (workspaceFile.size > ATTACHMENT_LIMITS.fileBytes) {
          throw new HttpError(413, "The workspace file exceeds the 100 MB limit.");
        }
        const bytes = await readFile(workspaceFile.path);
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.length),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(workspaceFile.name)}`,
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.members) {
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
        if (disabled !== undefined && !isBoolean(disabled)) {
          throw new HttpError(400, "disabled must be a boolean.");
        }
        const updated = await this.#options.store.updateMember(pathIdentifier(memberMatch[1], "memberId"), {
          ...(role ? { role } : {}),
          ...(disabled === undefined ? {} : { disabled }),
        });
        if (updated.disabled) await this.#options.remoteScreen?.revokeMember(updated.id);
        this.refreshPresence();
        return this.#json(response, 200, updated);
      }
      if (method === "DELETE" && memberMatch) {
        requireAdmin(member);
        const removedMemberId = pathIdentifier(memberMatch[1], "memberId");
        await this.#options.store.removeMember(removedMemberId);
        await this.#options.remoteScreen?.revokeMember(removedMemberId);
        this.refreshPresence();
        return this.#empty(response, 204);
      }
      if (method === "POST" && url.pathname === TEAM_API_ROUTES.team.invites) {
        requireAdmin(member);
        const body = await readJson(request);
        const role = stringField(body, "role");
        if (role !== "admin" && role !== "member") throw new HttpError(400, "Invalid role.");
        const email = nullableString(body, "email", INPUT_LIMITS.email) ?? undefined;
        if (!this.#options.createInvite) throw new HttpError(503, "Invitation service is unavailable.");
        return this.#json(response, 201, await this.#options.createInvite({ role, ...(email ? { email } : {}) }));
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.invites) {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listInvites());
      }
      const inviteMatch = url.pathname.match(/^\/v1\/team\/invites\/([^/]+)$/);
      if (method === "DELETE" && inviteMatch) {
        requireAdmin(member);
        await this.#options.store.revokeInvite(pathIdentifier(inviteMatch[1], "inviteId"));
        return this.#empty(response, 204);
      }
      if (method === "GET" && url.pathname === TEAM_API_ROUTES.team.sessions) {
        requireAdmin(member);
        return this.#json(response, 200, this.#options.store.listSessions());
      }
      const sessionMatch = url.pathname.match(/^\/v1\/team\/sessions\/([^/]+)$/);
      if (method === "DELETE" && sessionMatch) {
        requireAdmin(member);
        const revokedSessionId = pathIdentifier(sessionMatch[1], "sessionId");
        await this.#options.store.revokeSession(revokedSessionId);
        await this.#options.onSessionRevoked?.(revokedSessionId);
        await this.#options.remoteScreen?.revokeTeamSession(revokedSessionId);
        this.refreshPresence();
        return this.#empty(response, 204);
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
      if (!expected) logger.error("Team API request failed:", toLogValue(error));
      return this.#json(response, status, { error: message, ...(code ? { code } : {}) });
    }
  }

  #checkRate(request: import("node:http").IncomingMessage, username: string): void {
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

  #json(response: ServerResponse, status: number, value: object | null): void {
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
  }

  #protocolSupport(): TeamProtocolSupportV1 {
    return {
      appVersion: this.#options.appVersion ?? "0.0.0",
      protocol: { minimum: TEAM_PROTOCOL_V1, maximum: TEAM_PROTOCOL_V3 },
      capabilities: [...TEAM_CURRENT_CAPABILITIES],
    };
  }

  #protocolIssue(request: import("node:http").IncomingMessage): TeamProtocolIssue | null {
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

  #empty(response: ServerResponse, status: number): void {
    response.writeHead(status);
    response.end();
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

function requestCapabilities(request: import("node:http").IncomingMessage): Set<string> {
  const header = request.headers[TEAM_CAPABILITIES_HEADER.toLowerCase()];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value || value.length > 4_096) return new Set();
  const capabilities = value.split(",").map((capability) => capability.trim());
  if (capabilities.length > 64) return new Set();
  return new Set(capabilities.filter(isTeamCurrentCapability));
}

function conversationSnapshotForCapabilities(
  snapshot: ConversationSnapshot,
  capabilities: ReadonlySet<string>,
): ConversationSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.filter((message) => markerSupported(message.itemType, capabilities)),
  };
}

function conversationForCapabilities(
  conversation: ConversationWithReadState,
  capabilities: ReadonlySet<string>,
): ConversationWithReadState {
  const messages = conversation.messages.filter((message) => markerSupported(message.itemType, capabilities));
  if (!conversation.readState) return { ...conversation, messages };
  return {
    ...conversation,
    messages,
    readState: {
      ...conversation.readState,
      throughMessageId: supportedConversationCursor(
        conversation.messages,
        conversation.readState.throughMessageId,
        capabilities,
      ),
    },
  };
}

function supportedConversationCursor(
  messages: ConversationSnapshot["messages"],
  throughMessageId: string | null,
  capabilities: ReadonlySet<string>,
): string | null {
  if (!throughMessageId) return null;
  const boundary = messages.findIndex((message) => message.id === throughMessageId);
  for (let index = boundary; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && markerSupported(message.itemType, capabilities)) return message.id;
  }
  return null;
}

function markerExclusionsForCapabilities(capabilities: ReadonlySet<string>): {
  excludeRoutineEvents: boolean;
  excludeRoutineRunEvents: boolean;
  excludeHostedSiteEvents: boolean;
} {
  return {
    excludeRoutineEvents: !capabilities.has("routine-event-markers"),
    excludeRoutineRunEvents: !capabilities.has("routine-run-event-markers"),
    excludeHostedSiteEvents: !capabilities.has("hosted-site-event-markers"),
  };
}

function markerSupported(itemType: string | undefined, capabilities: ReadonlySet<string>): boolean {
  if (itemType?.startsWith(ROUTINE_EVENT_ITEM_TYPE_PREFIX)) return capabilities.has("routine-event-markers");
  if (itemType?.startsWith(ROUTINE_RUN_EVENT_ITEM_TYPE_PREFIX)) {
    return capabilities.has("routine-run-event-markers");
  }
  if (itemType?.startsWith(HOSTED_SITE_EVENT_ITEM_TYPE_PREFIX)) {
    return capabilities.has("hosted-site-event-markers");
  }
  return true;
}

function eventCapability(event: AgentEvent): TeamCurrentCapability | null {
  if (event.type === "turn-progress") return TEAM_AGENT_ACTIVITY_CAPABILITY;
  if (event.type === "runtime-snapshot") return "agent-runtime-snapshots";
  if (event.type === "sidebar-layout-changed") return "sidebar-layout";
  if (event.type === "browser-changed" || event.type === "browser-control-changed") return "browser-control";
  if (event.type === "conversation-page") return "conversation-pagination";
  return null;
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

function publicHttpBaseUrl(request: import("node:http").IncomingMessage): string {
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost || request.headers.host;
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
    throw new HttpError(400, "A valid public host is required.");
  }
  const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  return `${protocol}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value?.split(",", 1)[0];
  return first?.trim();
}

function requireAdmin(member: TeamMemberSummary): void {
  if (member.role === "member") throw new HttpError(403, "Administrator access is required.");
}

function parseBrowserBounds(value: unknown): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (!isDynamicRecord(value)) throw new HttpError(400, "Invalid browser bounds.");
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  if (
    !isNumber(x) ||
    !isNumber(y) ||
    !isNumber(width) ||
    !isNumber(height) ||
    ![x, y, width, height].every(Number.isFinite)
  ) {
    throw new HttpError(400, "Invalid browser bounds.");
  }
  return { x, y, width, height };
}

async function readJson(request: import("node:http").IncomingMessage): Promise<DynamicRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > JSON_LIMIT) throw new HttpError(413, "Request body is too large.");
    chunks.push(bytes);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return requestProtocol(request) === TEAM_PROTOCOL_V3
      ? decodeTeamProtocolV3CurrentHttpRequest(request.method ?? "GET", request.url ?? "/", value, {
          preserveSemanticTags: supportsTeamSemanticTags(requestCapabilities(request)),
        })
      : decodeTeamProtocolV1CurrentHttpRequest(request.method ?? "GET", request.url ?? "/", value);
  } catch {
    throw new HttpError(400, "A valid JSON object is required.");
  }
}

function requestProtocol(request: import("node:http").IncomingMessage): number {
  const raw = firstHeaderValue(request.headers[TEAM_PROTOCOL_VERSION_HEADER.toLowerCase()]);
  const protocol = raw ? Number(raw) : TEAM_PROTOCOL_V1;
  return Number.isSafeInteger(protocol) ? protocol : TEAM_PROTOCOL_V1;
}

function stringField(
  value: DynamicRecord,
  field: string,
  allowEmpty = false,
  maxLength: number = INPUT_LIMITS.identifier,
): string {
  const item = value[field];
  if (!isString(item) || (!allowEmpty && !item.trim())) {
    throw new HttpError(400, `${field} is required.`);
  }
  if (item.length > maxLength) throw new HttpError(400, `${field} is too long.`);
  return item;
}

function nullableString(
  value: DynamicRecord,
  field: string,
  maxLength: number = INPUT_LIMITS.identifier,
): string | null {
  const item = value[field];
  if (item === undefined || item === null || item === "") return null;
  if (!isString(item)) throw new HttpError(400, `${field} must be a string.`);
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
  value: DynamicRecord,
  field: string,
  maxItems: number = INPUT_LIMITS.attachments,
  maxLength: number = INPUT_LIMITS.identifier,
): string[] {
  const item = value[field];
  if (item === undefined) return [];
  if (
    !Array.isArray(item) ||
    item.length > maxItems ||
    !item.every((entry) => isString(entry) && entry.length <= maxLength)
  ) {
    throw new HttpError(400, `${field} must be a string array.`);
  }
  return item;
}

function promptRequestId(value: unknown): string | number {
  if (isNumber(value) && Number.isSafeInteger(value)) return value;
  if (isString(value) && value.length > 0 && value.length <= INPUT_LIMITS.identifier) {
    return value;
  }
  throw new HttpError(400, "requestId is invalid.");
}

function promptAnswers(value: unknown): Record<string, string[]> {
  if (!isDynamicRecord(value)) {
    throw new HttpError(400, "answers is required.");
  }
  const entries = Object.entries(value);
  if (entries.length > INPUT_LIMITS.promptQuestions) {
    throw new HttpError(400, "Too many prompt answers.");
  }
  const answers: Record<string, string[]> = {};
  let totalTextLength = 0;
  for (const [key, answer] of entries) {
    if (
      key.length > INPUT_LIMITS.identifier ||
      !Array.isArray(answer) ||
      answer.length > INPUT_LIMITS.promptAnswersPerQuestion ||
      !answer.every((item) => isString(item) && item.length <= INPUT_LIMITS.promptAnswerText)
    ) {
      throw new HttpError(400, "A prompt answer is invalid.");
    }
    totalTextLength += answer.reduce((length, item) => length + item.length, 0);
    if (totalTextLength > INPUT_LIMITS.promptAnswersTotalText) {
      throw new HttpError(400, "Prompt answers are too long.");
    }
    answers[key] = answer;
  }
  return answers;
}

function approvalDecision(value: unknown): RespondToApprovalInput["decision"] {
  if (value === "accept" || value === "decline") return value;
  throw new HttpError(400, "approval decision is invalid.");
}

function browserTakeoverDecision(value: unknown): RespondToBrowserTakeoverInput["decision"] {
  if (value === "complete" || value === "cancel") return value;
  throw new HttpError(400, "browser takeover decision is invalid.");
}

function botUpdate(value: DynamicRecord, botId: string): UpdateBotInput {
  if (value.role !== undefined) throw new HttpError(400, "role is invalid.");
  const result: UpdateBotInput = { botId };
  const textFields = {
    name: INPUT_LIMITS.agentName,
    title: INPUT_LIMITS.agentTitle,
    description: INPUT_LIMITS.agentDescription,
  } as const;
  for (const [field, maxLength] of Object.entries(textFields)) {
    const item = value[field];
    if (item === undefined) continue;
    if (!isString(item) || item.length > maxLength) {
      throw new HttpError(400, `${field} is invalid.`);
    }
    if (field === "name") result.name = item;
    else if (field === "title") result.title = item;
    else result.description = item;
  }
  if (value.notifications !== undefined) {
    if (!isBoolean(value.notifications)) {
      throw new HttpError(400, "notifications is invalid.");
    }
    result.notifications = value.notifications;
  }
  if (value.provider !== undefined) {
    if (value.provider !== "codex" && value.provider !== "claude" && value.provider !== "grok") {
      throw new HttpError(400, "provider is invalid.");
    }
    result.provider = value.provider;
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

function botCreate(value: DynamicRecord): CreateBotInput {
  const avatarHue = value.avatarHue;
  if (!isAvatarSeed(value.avatarSeed)) throw new HttpError(400, "avatarSeed is invalid.");
  if (avatarHue !== null && !isAvatarHue(avatarHue)) throw new HttpError(400, "avatarHue is invalid.");
  return {
    name: requiredCreateText(value.name, "name", INPUT_LIMITS.agentName),
    description: requiredCreateText(value.description, "description", INPUT_LIMITS.agentDescription),
    avatarSeed: value.avatarSeed,
    avatarHue,
    initialMessage: requiredCreateText(value.initialMessage, "initialMessage", INPUT_LIMITS.messageText),
  };
}

function requiredCreateText(value: unknown, field: string, maximum: number): string {
  if (!isString(value) || !value.trim() || value.length > maximum) {
    throw new HttpError(400, `${field} is invalid.`);
  }
  return value;
}

async function readBinary(request: import("node:http").IncomingMessage, limit: number): Promise<Uint8Array> {
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

function pageAnchor(url: URL): ConversationPageAnchor {
  const before = url.searchParams.get("before");
  const around = url.searchParams.get("around");
  if (before && around) throw new HttpError(400, "Choose one conversation page anchor.");
  if (before) return { type: "before", cursor: before };
  if (around) return { type: "around", messageId: around };
  return { type: "latest" };
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new HttpError(400, "The conversation page limit must be between 1 and 100.");
  }
  return value;
}
