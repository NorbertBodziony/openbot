// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AccountUsage,
  BotMemory,
  BotSummary,
  CentralAuthUser,
  ConversationWithReadState,
  CreateBotInput,
  Routine,
  RoutineRun,
  TeamPresenceSnapshot,
} from "@openbot/contracts/ipc";
import {
  AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT,
  hostedSiteConversationEventItemType,
  hostedSiteConversationEventText,
  routineConversationEventItemType,
  routineRunConversationEventItemType,
} from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CURRENT_CAPABILITIES, TEAM_SEMANTIC_TAGS_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  TEAM_PROTOCOL_VERSION_HEADER,
  teamProtocolV1HttpRoute,
} from "@openbot/contracts/team-protocol/v1";
import { TEAM_PROTOCOL_V3 } from "@openbot/contracts/team-protocol/v3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenBotDatabase } from "../backend/openbot-database";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import { TeamChatStore } from "../backend/team-chat-store";
import { HostService } from "./host-service";
import { TeamApiServer } from "./team-api-server";
import { TeamStore } from "./team-store";

const roots: string[] = [];
type TeamApiOptions = ConstructorParameters<typeof TeamApiServer>[0];
type TestAgents = TeamApiOptions["agents"];
type TestMailbox = TeamApiOptions["mailbox"];
type TestBrowser = TeamApiOptions["browser"];

interface TestRealtimeEvent {
  type: string;
  botId?: string;
  revision?: number;
  code?: string;
  snapshot?: unknown;
  message?: unknown;
  senderMemberId?: string;
  recipientMemberId?: string;
  typing?: boolean;
  layout?: unknown;
}

function unimplemented(..._arguments_: unknown[]): never {
  throw new Error("This operation is not used by this test.");
}

function createAgents(overrides: Partial<TestAgents> = {}, events = new EventEmitter()): TestAgents {
  return {
    on: (event, listener) => {
      events.on(event, listener);
    },
    off: (event, listener) => {
      events.off(event, listener);
    },
    getStatus: unimplemented,
    getRuntimeSnapshot: () => ({
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }),
    getUsage: unimplemented,
    listModels: unimplemented,
    listBots: unimplemented,
    listMemories: unimplemented,
    createMemory: unimplemented,
    updateMemory: unimplemented,
    deleteMemory: unimplemented,
    clearMemories: unimplemented,
    listRoutines: unimplemented,
    createRoutine: unimplemented,
    updateRoutine: unimplemented,
    deleteRoutine: unimplemented,
    testRoutine: unimplemented,
    listRoutineRuns: unimplemented,
    listConversationReads: unimplemented,
    createBot: unimplemented,
    committedBotDuplication: () => null,
    duplicateBot: unimplemented,
    commitBotDuplication: unimplemented,
    updateBot: unimplemented,
    deleteBot: unimplemented,
    setAvatar: unimplemented,
    resolveAvatar: unimplemented,
    readConversationFor: unimplemented,
    readConversationPageFor: unimplemented,
    searchConversationMessages: unimplemented,
    markConversationRead: unimplemented,
    markConversationUnread: unimplemented,
    prepareImportedAttachments: unimplemented,
    discardDraftAttachment: unimplemented,
    resolveSharedFile: unimplemented,
    resolveWorkspaceFile: unimplemented,
    sendMessage: unimplemented,
    listQueue: unimplemented,
    acknowledgeFailedTurn: unimplemented,
    setMessageReaction: unimplemented,
    cancelQueuedMessage: unimplemented,
    steerQueuedMessage: unimplemented,
    updateQueuedMessage: unimplemented,
    reorderQueue: unimplemented,
    interrupt: unimplemented,
    respondToPrompt: unimplemented,
    respondToApproval: unimplemented,
    respondToBrowserTakeover: unimplemented,
    ...overrides,
  };
}

type HostOptions = ConstructorParameters<typeof HostService>[0];

/**
 * `HostService` forwards these straight to the Team API, so the doubles above are the
 * whole harness it needs. No runtime is started here - these cases are about which
 * account's host the service is bound to.
 */
async function createHostService(
  remote: Partial<
    Pick<
      HostOptions,
      | "listRemoteInvites"
      | "registerRemoteHost"
      | "updateRemoteHostLogo"
      | "listRemoteMembers"
      | "updateRemoteMember"
      | "removeRemoteMember"
      | "createRemoteInvite"
      | "revokeRemoteInvite"
      | "remoteControlPlaneUrl"
      | "sendTeamInviteEmail"
    >
  > = {},
): Promise<{
  service: HostService;
  /** Reports an account exactly as `forwardCentralAuth` does, sign-out included. */
  signIn: (user: CentralAuthUser | null) => Promise<void>;
  /** Holds the team file, so a test can make the store's write fail. */
  root: string;
  /** Announces an account the way the renderer is told, before the queued switch is applied. */
  announce: (user: CentralAuthUser) => void;
}> {
  const root = await mkdtemp(join(tmpdir(), "openbot-host-service-"));
  roots.push(root);
  const store = new TeamStore(join(root, "team.json"));
  await store.initialize();
  let signedIn: CentralAuthUser | null = null;
  const options: HostOptions = {
    appVersion: "0.4.0",
    store,
    agents: { ...createAgents(), adoptConversationReads: unimplemented },
    skills: { listInstalledForChatTags: unimplemented },
    sidebarLayout: {
      getSnapshot: unimplemented,
      mutate: unimplemented,
      removeAgent: unimplemented,
      placeDuplicateAfter: unimplemented,
      on: () => undefined,
      off: () => undefined,
    },
    mailbox: createMailbox(),
    browser: createBrowser(),
    getSignedInUser: () => {
      if (!signedIn) throw new Error("No account is signed in.");
      return signedIn;
    },
    redeemCentralTicket: unimplemented,
    sendTeamInviteEmail: unimplemented,
    ...remote,
  };
  const service = new HostService(options);
  return {
    service,
    root,
    announce: (user) => {
      signedIn = user;
    },
    signIn: async (user) => {
      signedIn = user;
      await service.applySignedInAccount(user);
    },
  };
}

function createMailbox(): TestMailbox {
  return { resolveAttachment: unimplemented };
}

function createBrowser(overrides: Partial<TestBrowser> = {}): TestBrowser {
  return {
    listTabs: unimplemented,
    getControlState: unimplemented,
    open: unimplemented,
    activate: unimplemented,
    navigate: unimplemented,
    reload: unimplemented,
    close: unimplemented,
    capturePreview: unimplemented,
    setVisible: unimplemented,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TeamApiServer teardown", () => {
  it("closes its listener when the remote screen cannot be stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-teardown-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    const unreachable = () => {
      throw new Error("The remote screen is only asked to stop here.");
    };
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      remoteScreen: {
        handlesUpgrade: () => false,
        handleUpgrade: unreachable,
        handlesHttp: () => false,
        handleHttp: unreachable,
        capabilities: unreachable,
        createSession: unreachable,
        selectDisplay: unreachable,
        closeMemberSession: unreachable,
        revokeTeamSession: unreachable,
        revokeMember: unreachable,
        stop: () => Promise.reject(new Error("The remote screen would not come down.")),
      },
    });
    const port = await api.start();

    await expect(api.stop()).rejects.toThrow("would not come down");

    // Its heartbeat and event listeners are already gone, so a listener still answering here
    // is one that no longer notices a revoked session - and the next start would hand it back.
    await expect(fetch(`http://127.0.0.1:${port}/v1/compatibility`)).rejects.toThrow();
  });
});

describe("TeamApiServer compatibility", () => {
  it("publishes protocol support and blocks requests without a compatible handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-compatibility-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    const api = new TeamApiServer({
      appVersion: "0.4.0",
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const compatibility = await fetch(`${base}/v1/compatibility`);
      expect(compatibility.status).toBe(200);
      await expect(compatibility.json()).resolves.toMatchObject({
        appVersion: "0.4.0",
        protocol: { minimum: 1, maximum: 3 },
        capabilities: expect.arrayContaining(["browser-control", "remote-desktop", TEAM_SEMANTIC_TAGS_CAPABILITY]),
      });

      const missing = await fetch(`${base}/v1/identity`);
      expect(missing.status).toBe(426);
      await expect(missing.json()).resolves.toMatchObject({ code: "client_update_required" });

      const newerClient = await fetch(`${base}/v1/identity`, {
        headers: { [TEAM_PROTOCOL_VERSION_HEADER]: "4", [TEAM_APP_VERSION_HEADER]: "0.5.0" },
      });
      expect(newerClient.status).toBe(426);
      await expect(newerClient.json()).resolves.toMatchObject({ code: "host_update_required" });

      const compatible = await fetch(`${base}/v1/identity`, {
        headers: { [TEAM_PROTOCOL_VERSION_HEADER]: "1", [TEAM_APP_VERSION_HEADER]: "0.3.9" },
      });
      expect(compatible.status).toBe(200);
    } finally {
      await api.stop();
    }
  });

  it("serves installed skill summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-skills-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const listInstalledForChatTags = vi.fn(async () => [
      {
        skillId: "skill-1",
        slug: "release-notes",
        name: "Release Notes",
        installedVersion: 1,
        availableVersion: 2,
        state: "update-available" as const,
      },
    ]);
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      skills: { listInstalledForChatTags },
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const response = await fetch(`${base}/v1/agents/chief/skills`, {
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
        },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([
        expect.objectContaining({ skillId: "skill-1", name: "Release Notes", state: "update-available" }),
      ]);
      expect(listInstalledForChatTags).toHaveBeenCalledWith("chief");
    } finally {
      await api.stop();
    }
  });
});

// `TEAM_API_ROUTES` is the client's half of this router's surface, and until this case nothing linked
// the two: a path renamed in the table but not in the branch below would leave every remote server
// asking for a route the host answers "Route not found." to, with no test going red. The table is
// walked rather than listed, so a new entry cannot quietly skip the check - it arrives with no method
// declared and fails on `undeclared` until it is named here.
const ROUTE_METHODS: Record<string, string> = {
  compatibility: "GET",
  identity: "GET",
  events: "GET",
  me: "GET",
  attachments: "POST",
  attachment: "DELETE",
  sharedFiles: "GET",
  workspaceFiles: "GET",
  "join.server": "POST",
  "join.account": "POST",
  "join.invitationPreview": "POST",
  "auth.login": "POST",
  "auth.account": "POST",
  "auth.logout": "POST",
  "auth.password": "POST",
  "host.remoteMac": "GET",
  "host.remoteDesktopAccess": "GET",
  "team.presence": "GET",
  "team.logo": "GET",
  "team.members": "GET",
  "team.member": "PATCH",
  "team.invites": "GET",
  "team.invite": "DELETE",
  "team.sessions": "GET",
  "team.session": "DELETE",
  "direct.threads": "GET",
  "direct.messages": "POST",
  "direct.conversation": "GET",
  "direct.conversationPage": "GET",
  "direct.conversationRead": "POST",
  "messages.search": "GET",
  "browser.open": "POST",
  "browser.activate": "POST",
  "browser.navigate": "POST",
  "browser.reload": "POST",
  "browser.close": "POST",
  "browser.tabs": "GET",
  "browser.control": "GET",
  "browser.preview": "POST",
  "browser.visible": "POST",
  "remoteScreen.capabilities": "GET",
  "remoteScreen.sessions": "POST",
  "remoteScreen.session": "DELETE",
  "remoteScreen.display": "PUT",
  "sidebarLayout.state": "GET",
  "sidebarLayout.actions": "POST",
  "respond.prompt": "POST",
  "respond.approval": "POST",
  "respond.browserTakeover": "POST",
  "agents.all": "GET",
  "agents.status": "GET",
  "agents.usage": "GET",
  "agents.models": "GET",
  "agents.conversationReads": "GET",
  "agent.one": "PATCH",
  "agent.usage": "GET",
  "agent.skills": "GET",
  "agent.duplicate": "POST",
  "agent.avatar": "GET",
  "agent.conversation": "GET",
  "agent.conversationPage": "GET",
  "agent.conversationRead": "POST",
  "agent.messages": "POST",
  "agent.reactions": "POST",
  "agent.interrupt": "POST",
  "agent.failuresAcknowledge": "POST",
  "agent.queue": "GET",
  "agent.queueCancel": "POST",
  "agent.queueSteer": "POST",
  "agent.queueUpdate": "POST",
  "agent.queueReorder": "POST",
  "agent.memories": "GET",
  "agent.memory": "PATCH",
  "agent.routines": "GET",
  "agent.routine": "PATCH",
  "agent.routineTest": "POST",
  "agent.routineRuns": "GET",
};

// Two entries this router deliberately never answers: the WebSocket upgrade path, and the viewer
// family `remote-screen-gateway.ts` owns, which answers 404 for a session that does not exist.
// `remoteScreen.prefix` is a namespace, not an endpoint: nothing is served at it, and it exists so
// `remote-viewer-proxy.ts` rewrites the same string the group's routes are built from.
const ROUTES_NOT_SERVED_OVER_HTTP = new Set(["remoteDesktopUpgrade", "remoteScreen.viewer", "remoteScreen.prefix"]);

// Reaching the router is only half of what a route needs. `#json` encodes every JSON body through
// the negotiated protocol's frozen adapter, and protocol v3 delegates all but agent duplication to
// v1's route list, so a table entry that list cannot name is one the host answers 500 on for every
// client - and the loop below cannot see it, because these stubs drive only ten routes as far as a
// 2xx body. These are the entries whose response never passes through that classification, each for
// a reason that is a property of the route rather than an omission.
const ROUTES_WITHOUT_A_CLASSIFIED_JSON_BODY = new Set([
  // Answered with 204 and no body at all.
  "attachment",
  "auth.logout",
  "team.invite",
  "team.session",
  "remoteScreen.session",
  // Answered with bytes rather than JSON, so `#json` is never the writer.
  "team.logo",
  "sharedFiles",
  "workspaceFiles",
  "agent.avatar",
  // Answered only as a 426, which the codec projects through its error branch, where the route plays
  // no part.
  "events",
  "host.remoteMac",
  "host.remoteDesktopAccess",
  // The v1 codec short-circuits this one ahead of classification, to keep a skill list it has no
  // contract for intact.
  "agent.skills",
  // Protocol v3 only: its own adapter names these routes before delegating the rest to v1. A v1 peer
  // that calls either anyway is answered 500 rather than a protocol error - see the PR body.
  "agent.duplicate",
  "agent.usage",
]);

const ROUTE_SAMPLE_IDS = ["route-sample", "route-sample-other"];

// The table's three shapes: a fixed path, a builder taking one or two ids, and a group of either.
type RouteNode = string | ((...ids: string[]) => string) | { [key: string]: RouteNode };

function collectRoutes(node: { [key: string]: RouteNode }, trail: string[]): { name: string; path: string }[] {
  return Object.entries(node).flatMap(([key, value]) => {
    const name = [...trail, key].join(".");
    if (typeof value === "string") return [{ name, path: value }];
    if (typeof value === "function") {
      return [{ name, path: value(...ROUTE_SAMPLE_IDS.slice(0, value.length)) }];
    }
    return collectRoutes(value, [...trail, key]);
  });
}

describe("TeamApiServer routing", () => {
  it("answers every path the shared route table builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-routes-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const api = new TeamApiServer({
      store,
      agents: createAgents({ listBots: () => [] }),
      sidebarLayout,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;
    // The point is which paths route, not what the stubs do once reached, so the failures they raise
    // are expected here and their logging would bury the assertion.
    const requestFailures = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, TEAM_API_ROUTES.auth.login, {
        body: { username: "owner", password: "correct horse battery" },
      });
      const collected = collectRoutes(TEAM_API_ROUTES, []);
      const routes = collected.filter((route) => !ROUTES_NOT_SERVED_OVER_HTTP.has(route.name));
      // Both directions, because either one alone can pass while saying nothing: a table walk that
      // returned nothing would satisfy the first check, and a method left behind by a deleted route
      // would never be noticed without the second.
      expect(routes.filter((route) => !ROUTE_METHODS[route.name]).map((route) => route.name)).toEqual([]);
      expect(Object.keys(ROUTE_METHODS).filter((name) => !collected.some((route) => route.name === name))).toEqual([]);

      // Every route the codec has to name, it names. Renaming a path in the table moves the host and
      // the client together, so the loop below stays green - this is the half of the surface that
      // notices, because the frozen adapter does not move with them.
      const unclassified = routes
        .filter((route) => !ROUTES_WITHOUT_A_CLASSIFIED_JSON_BODY.has(route.name))
        .filter((route) => !teamProtocolV1HttpRoute(ROUTE_METHODS[route.name], route.path))
        .map((route) => `${ROUTE_METHODS[route.name]} ${route.path} (${route.name})`);
      expect(unclassified).toEqual([]);

      // Signing out invalidates the token every other request needs, so it goes last - otherwise the
      // routes after it would answer 401 and never reach the router's 404.
      const ordered = [
        ...routes.filter((route) => route.name !== "auth.logout"),
        ...routes.filter((route) => route.name === "auth.logout"),
      ];
      const unrouted: string[] = [];
      for (const route of ordered) {
        const method = ROUTE_METHODS[route.name];
        const response = await fetch(`${base}${route.path}`, {
          method,
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        });
        const body = response.status === 404 ? await response.json() : null;
        if (isDynamicRecord(body) && body.error === "Route not found.") {
          unrouted.push(`${method} ${route.path} (${route.name})`);
        }
      }

      expect(unrouted).toEqual([]);
    } finally {
      requestFailures.mockRestore();
      await api.stop();
    }
  });
});

describe("TeamApiServer administration", () => {
  it("duplicates an agent through protocol v3 and places it after the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-duplicate-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const source = {
      id: "chief",
      provider: "codex",
      name: "Chief",
      title: "Lead",
      description: "Coordinates work.",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: "thread-chief",
      workspacePath: join(root, "chief"),
      preview: "Ready",
      updatedAt: null,
      avatarSeed: "chief",
      avatarHue: null,
      avatarUrl: null,
    } satisfies BotSummary;
    const duplicate = {
      ...source,
      id: "chief-copy",
      name: "Chief copy",
      threadId: null,
      workspacePath: join(root, "chief-copy"),
      preview: "No messages yet",
    } satisfies BotSummary;
    let bots: BotSummary[] = [source];
    const duplicateBot = vi.fn(async () => {
      bots = [duplicate, source];
      return duplicate;
    });
    let committedDuplicate: Awaited<ReturnType<TestAgents["commitBotDuplication"]>> | null = null;
    const commitBotDuplication = vi.fn(async (_botId, layout) => {
      committedDuplicate = { bot: duplicate, layout };
      return committedDuplicate;
    });
    const deleteBot = vi.fn(async (botId: string) => {
      bots = bots.filter((bot) => bot.id !== botId);
    });
    const agents = createAgents({
      listBots: () => bots,
      committedBotDuplication: () => committedDuplicate,
      duplicateBot,
      commitBotDuplication,
      deleteBot,
    });
    const section = await sidebarLayout.mutate(
      { type: "create", name: "Core", agentId: source.id },
      new Set([source.id]),
    );
    const api = new TeamApiServer({
      store,
      agents,
      sidebarLayout,
      mailbox: createMailbox(),
      browser: createBrowser(),
      appVersion: "1.0.0",
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
        protocol: TEAM_PROTOCOL_V3,
        appVersion: "1.0.0",
      });
      const response = await fetch(`${base}/v1/agents/${source.id}/duplicate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V3),
          [TEAM_APP_VERSION_HEADER]: "1.0.0",
        },
        body: JSON.stringify({ operationId: "7674b664-cd72-4cf9-88ed-6f2e189d551f" }),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        bot: { id: duplicate.id, threadId: null },
        layout: {
          agentAssignments: { [source.id]: section.sections[0]?.id, [duplicate.id]: section.sections[0]?.id },
          agentOrder: [source.id, duplicate.id],
        },
      });
      expect(duplicateBot).toHaveBeenCalledWith(source.id, "7674b664-cd72-4cf9-88ed-6f2e189d551f");
      expect(commitBotDuplication).toHaveBeenCalledWith(duplicate.id, expect.objectContaining({ revision: 2 }));
      expect(deleteBot).not.toHaveBeenCalled();

      const currentLayout = await sidebarLayout.mutate(
        { type: "create", name: "Later", agentId: duplicate.id },
        new Set([source.id, duplicate.id]),
      );

      const retry = await fetch(`${base}/v1/agents/${source.id}/duplicate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V3),
          [TEAM_APP_VERSION_HEADER]: "1.0.0",
        },
        body: JSON.stringify({ operationId: "7674b664-cd72-4cf9-88ed-6f2e189d551f" }),
      });
      expect(retry.status).toBe(201);
      await expect(retry.json()).resolves.toMatchObject({ layout: { revision: currentLayout.revision } });
      expect(duplicateBot).toHaveBeenCalledTimes(1);
      expect(commitBotDuplication).toHaveBeenCalledTimes(1);
    } finally {
      await api.stop();
    }
  });

  it("attempts layout cleanup when duplicate deletion reports an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-duplicate-rollback-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const duplicate = {
      id: "chief-copy",
      provider: "codex",
      name: "Chief copy",
      title: "Lead",
      description: "",
      notifications: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: join(root, "chief-copy"),
      preview: "No messages yet",
      updatedAt: null,
      avatarSeed: "chief",
      avatarHue: null,
      avatarUrl: null,
    } satisfies BotSummary;
    const deleteBot = vi.fn(async () => {
      throw new Error("agent cleanup failed");
    });
    const agents = createAgents({
      listBots: () => [duplicate],
      duplicateBot: vi.fn(async () => duplicate),
      deleteBot,
    });
    vi.spyOn(sidebarLayout, "placeDuplicateAfter").mockRejectedValueOnce(new Error("layout persistence failed"));
    const removeAgent = vi.spyOn(sidebarLayout, "removeAgent");
    const api = new TeamApiServer({
      store,
      agents,
      sidebarLayout,
      mailbox: createMailbox(),
      browser: createBrowser(),
      appVersion: "1.0.0",
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
        protocol: TEAM_PROTOCOL_V3,
        appVersion: "1.0.0",
      });
      const response = await fetch(`${base}/v1/agents/chief/duplicate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: String(TEAM_PROTOCOL_V3),
          [TEAM_APP_VERSION_HEADER]: "1.0.0",
        },
        body: JSON.stringify({ operationId: "25dc8b8e-a93b-48f5-9e22-d3a7840f5d4d" }),
      });

      expect(response.status).toBe(500);
      expect(deleteBot).toHaveBeenCalledWith(duplicate.id);
      expect(removeAgent).toHaveBeenCalledWith(duplicate.id);
    } finally {
      await api.stop();
    }
  });

  it("shares sidebar layout mutations with owner, admin, and member clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-sidebar-layout-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const adminInvite = await store.createInvite("admin");
    const memberInvite = await store.createInvite("member");
    const admin = await store.acceptInviteWithAccount(adminInvite.token, {
      id: "admin-account",
      email: "admin@example.com",
      name: "Admin",
      avatarUrl: null,
    });
    const member = await store.acceptInviteWithAccount(memberInvite.token, {
      id: "member-account",
      email: "member@example.com",
      name: "Member",
      avatarUrl: null,
    });
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const getRuntimeSnapshot = vi.fn<TestAgents["getRuntimeSnapshot"]>(() => ({
      bots: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }));
    const agentEvents = new EventEmitter();
    const agents = createAgents({
      on: (event, listener) => agentEvents.on(event, listener),
      off: (event, listener) => agentEvents.off(event, listener),
      getRuntimeSnapshot,
      listBots: () => [
        {
          id: "chief",
          provider: "codex",
          name: "Chief",
          title: "Lead",
          description: "",
          notifications: true,
          model: "gpt-5.6-luna",
          reasoningEffort: "medium",
          threadId: "thread-chief",
          workspacePath: root,
          preview: "",
          updatedAt: null,
          avatarSeed: "chief",
          avatarHue: null,
          avatarUrl: null,
        } satisfies BotSummary,
      ],
    });
    let now = 0;
    const api = new TeamApiServer({
      store,
      agents,
      sidebarLayout,
      mailbox: createMailbox(),
      browser: createBrowser(),
      now: () => now,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const owner = await store.login("owner", "correct horse battery");
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${member.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({
        type: "runtime-snapshot",
        snapshot: { bots: [], activeTurns: [], pendingApprovals: [] },
      });
      expect(initialPresence).toMatchObject({ type: "team-presence" });

      const conversation = {
        type: "conversation",
        snapshot: {
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 1,
          messages: [
            {
              id: "reply-1",
              author: "assistant",
              text: "Done",
              createdAt: "2026-08-29T10:00:00.000Z",
              status: "completed",
            },
          ],
        },
      };
      getRuntimeSnapshot.mockReturnValueOnce({
        ...createAgents().getRuntimeSnapshot(),
        latestMessages: [{ botId: "chief", id: "reply-1", text: "Done", createdAt: "2026-08-29T10:00:00.000Z" }],
      });
      const boundedEvents = nextJsonEvents(socket, 2);
      agentEvents.emit("event", conversation);
      agentEvents.emit("event", {
        type: "turn-completed",
        botId: "chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        status: "completed",
      });
      await expect(boundedEvents).resolves.toEqual([
        expect.objectContaining({ type: "turn-completed" }),
        expect.objectContaining({
          type: "runtime-snapshot",
          snapshot: expect.objectContaining({ latestMessages: [expect.objectContaining({ id: "reply-1" })] }),
        }),
      ]);

      socket.send(JSON.stringify({ type: "agent-event-scope", includeConversations: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const conversationEvent = nextJsonEvent(socket);
      agentEvents.emit("event", conversation);
      await expect(conversationEvent).resolves.toEqual({
        type: "conversation-invalidated",
        botId: "chief",
        revision: 1,
      });
      const queueEvent = nextJsonEvent(socket);
      agentEvents.emit("event", { type: "queue-changed", snapshot: { botId: "chief", deliveries: [] } });
      await expect(queueEvent).resolves.toEqual({ type: "queue-invalidated", botId: "chief" });

      const eventAfterUnsupportedActivity = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "turn-progress",
        botId: "chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        detail: "Searching for current information…",
      });
      agentEvents.emit("event", { type: "bots-changed", bots: [] });
      await expect(eventAfterUnsupportedActivity).resolves.toMatchObject({ type: "bots-changed" });

      const eventsAfterOversizedConversation = nextJsonEvents(socket, 2);
      agentEvents.emit("event", {
        ...conversation,
        snapshot: {
          ...conversation.snapshot,
          messages: [{ ...conversation.snapshot.messages[0], text: "x".repeat(1024 * 1024) }],
        },
      });
      agentEvents.emit("event", { type: "bots-changed", bots: [] });
      await expect(eventsAfterOversizedConversation).resolves.toEqual([
        expect.objectContaining({ type: "conversation-invalidated" }),
        expect.objectContaining({ type: "bots-changed" }),
      ]);

      const refreshedSnapshot = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      await expect(refreshedSnapshot).resolves.toMatchObject({ type: "runtime-snapshot" });
      for (let index = 0; index < 20; index += 1) {
        socket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      }
      await vi.waitFor(() => expect(getRuntimeSnapshot).toHaveBeenCalledTimes(3));

      for (const [index, token] of [owner.sessionToken, admin.sessionToken, member.sessionToken].entries()) {
        const event = nextJsonEvent(socket);
        const layout = await jsonRequest<{ sections: Array<{ name: string }>; revision: number }>(
          base,
          "/v1/sidebar-layout/actions",
          { token, body: { type: "create", name: `Shared ${index + 1}` } },
        );
        expect(layout.sections.at(-1)?.name).toBe(`Shared ${index + 1}`);
        await expect(event).resolves.toMatchObject({
          type: "sidebar-layout-changed",
          layout: { revision: index + 1 },
        });
      }
      // Three request/response round-trips have passed through the same socket
      // since the burst, so the coalescer provably never woke for the other 19.
      expect(getRuntimeSnapshot).toHaveBeenCalledTimes(3);

      await expect(jsonRequest(base, "/v1/sidebar-layout", { token: member.sessionToken })).resolves.toMatchObject({
        revision: 3,
        sections: [{ name: "Shared 1" }, { name: "Shared 2" }, { name: "Shared 3" }],
      });
      const firstSocketClosed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener("close", resolve, { once: true }),
      );
      socket.close();
      await firstSocketClosed;
      const oversizedSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${member.sessionToken}`,
      ]);
      const oversizedInitialEvents = nextJsonEvents(oversizedSocket, 2);
      await new Promise<void>((resolve, reject) => {
        oversizedSocket.addEventListener("open", () => resolve(), { once: true });
        oversizedSocket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      await oversizedInitialEvents;
      const closed = new Promise<CloseEvent>((resolve) =>
        oversizedSocket.addEventListener("close", resolve, { once: true }),
      );
      now = 1_000;
      getRuntimeSnapshot.mockImplementation(() => ({
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [
          {
            botId: "chief",
            id: "oversized",
            text: "x".repeat(AGENT_RUNTIME_SNAPSHOT_BYTES_LIMIT),
            createdAt: "2026-08-29T10:00:00.000Z",
          },
        ],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      }));
      oversizedSocket.send(JSON.stringify({ type: "runtime-snapshot-request" }));
      expect((await closed).code).toBe(1011);
    } finally {
      await api.stop();
    }
  }, 30_000);

  it("keeps legacy event clients connected without sending runtime snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-legacy-events-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    const agentEvents = new EventEmitter();
    const api = new TeamApiServer({
      store,
      agents: createAgents({}, agentEvents),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
      "openbot-events",
      `openbot-token.${login.sessionToken}`,
    ]);
    const firstEvent = nextJsonEvent(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      await expect(firstEvent).resolves.toMatchObject({ type: "team-presence" });
      expect(socket.protocol).toBe("openbot-events");
      const supportedEvent = nextJsonEvent(socket);
      agentEvents.emit("event", { type: "runtime-snapshot", snapshot: createAgents().getRuntimeSnapshot() });
      agentEvents.emit("event", { type: "bots-changed", bots: [] });
      await expect(supportedEvent).resolves.toMatchObject({ type: "bots-changed" });

      const conversationEvent = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "conversation",
        snapshot: {
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 2,
          messages: [
            {
              id: "reply-1",
              author: "assistant",
              text: "Done",
              createdAt: "2026-08-29T10:00:00.000Z",
              status: "completed",
            },
            {
              id: "routine-event-1",
              author: "system",
              source: "system",
              text: "Morning brief",
              createdAt: "2026-08-29T10:01:00.000Z",
              status: "completed",
              itemType: routineConversationEventItemType("created", "routine-1"),
            },
            {
              id: "routine-run-event-1",
              author: "system",
              source: "system",
              text: "Morning brief",
              createdAt: "2026-08-29T10:02:00.000Z",
              status: "completed",
              itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
            },
            {
              id: "hosted-site-event-1",
              author: "system",
              source: "system",
              text: hostedSiteConversationEventText({
                siteId: null,
                title: "Launch page",
                hostname: null,
                url: null,
              }),
              createdAt: "2026-08-29T10:03:00.000Z",
              status: "completed",
              itemType: hostedSiteConversationEventItemType("publish", "running", "operation-1"),
            },
          ],
        },
      });
      await expect(conversationEvent).resolves.toMatchObject({
        type: "conversation",
        snapshot: { messages: [expect.objectContaining({ id: "reply-1" })] },
      });
    } finally {
      socket.close();
      await api.stop();
    }
  });

  it("does not expose unexpected internal errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-errors-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const internalError = Object.assign(new Error("EACCES: /Users/private/openbot.db"), { code: "EACCES" });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listBots: () => {
          throw internalError;
        },
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const response = await fetch(`${base}/v1/agents`, {
        headers: { Authorization: `Bearer ${login.sessionToken}` },
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Request failed." });
      expect(errorLog).toHaveBeenCalledWith("Team API request failed:", internalError);

      const invalidLogin = await fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "wrong password value" }),
      });
      expect(invalidLogin.status).toBe(400);
      await expect(invalidLogin.json()).resolves.toEqual({ error: "The username or password is incorrect." });
    } finally {
      await api.stop();
      errorLog.mockRestore();
    }
  });

  it("bounds and expires unauthenticated rate-limit entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-rate-limit-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    let now = Date.parse("2026-08-22T12:00:00.000Z");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      rateLimitCapacity: 2,
      now: () => now,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;
    const login = (username: string) =>
      fetch(`${base}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "wrong password value" }),
      });

    try {
      expect((await login("alice")).status).toBe(400);
      expect((await login("bob")).status).toBe(400);
      expect((await login("carol")).status).toBe(429);

      now += 15 * 60 * 1_000 + 1;
      expect((await login("dave")).status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("rejects WebSocket event frames larger than one KiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-websocket-limit-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const login = await store.login("owner", "correct horse battery");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
      "openbot-events",
      `openbot-token.${login.sessionToken}`,
    ]);

    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), { once: true });
      });
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event.code), { once: true });
      });
      socket.send("x".repeat(256 * 1_024 + 1));
      await expect(closed).resolves.toBe(1009);
    } finally {
      socket.close();
      await api.stop();
    }
  });

  it("joins an email-bound invitation with a verified OpenBot account", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-account-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configureWithAccount("Studio Mac", {
      id: "owner-account",
      email: "owner@example.com",
      name: "Owner",
      avatarUrl: null,
    });
    const invite = await store.createInvite("member", "alice@example.com");
    const database = new OpenBotDatabase(root);
    await database.initialize();
    const chat = new TeamChatStore(database);
    const agentEvents = new EventEmitter();
    const presenceSnapshots: TeamPresenceSnapshot[] = [];
    const agents = createAgents({}, agentEvents);
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      redeemCentralTicket: async (ticket, serverId) => {
        if (serverId !== store.getIdentity()?.serverId) return null;
        if (ticket === "valid-team-ticket") {
          return {
            id: "alice-account",
            email: "alice@example.com",
            name: "Alice",
            avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
          };
        }
        return ticket === "owner-team-ticket"
          ? {
              id: "owner-account",
              email: "owner@example.com",
              name: "Owner on another Mac",
              avatarUrl: null,
            }
          : null;
      },
      onPresence: (snapshot) => presenceSnapshots.push(snapshot),
      chat,
    });
    const port = await api.start();

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
      await expect(previewResponse.json()).resolves.toEqual({
        role: "member",
        expiresAt: invite.expiresAt,
        emailBound: true,
      });

      const response = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inviteToken: invite.token,
          accountTicket: "valid-team-ticket",
        }),
      });
      expect(response.status).toBe(201);
      const joined = await response.json();
      expect(joined.member).toMatchObject({
        email: "alice@example.com",
        role: "member",
        avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
      });
      expect(store.authenticate(joined.sessionToken)?.email).toBe("alice@example.com");

      const usedPreview = await fetch(`http://127.0.0.1:${port}/v1/invitations/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteToken: invite.token }),
      });
      expect(usedPreview.status).toBe(400);

      const ownerInvite = await store.createInvite("member");
      const ownerResponse = await fetch(`http://127.0.0.1:${port}/v1/join/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviteToken: ownerInvite.token,
          accountTicket: "owner-team-ticket",
        }),
      });
      expect(ownerResponse.status).toBe(201);
      const ownerConnection = await ownerResponse.json();
      expect(ownerConnection.member).toMatchObject({
        email: "owner@example.com",
        name: "Owner on another Mac",
        role: "owner",
      });
      expect(store.listMembers()).toHaveLength(2);
      expect(store.authenticate(ownerConnection.sessionToken)?.email).toBe("owner@example.com");

      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, [
        "openbot-events-v2",
        `openbot-token.${joined.sessionToken}`,
      ]);
      const initialEvents = nextJsonEvents(socket, 2);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket did not open.")), {
          once: true,
        });
      });
      const [initialSnapshot, initialPresence] = await initialEvents;
      expect(initialSnapshot).toMatchObject({ type: "runtime-snapshot" });
      expect(initialPresence).toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              avatarUrl: "https://api.openbot.run/v1/avatars/alice-account?v=image-1",
            }),
          ]),
        },
      });

      const typingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: "chief", typing: true }));
      await expect(typingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([
            expect.objectContaining({
              email: "alice@example.com",
              online: true,
              typingBotId: "chief",
            }),
          ]),
        },
      });

      const stoppedTypingPresence = nextJsonEvent(socket);
      socket.send(JSON.stringify({ type: "team-typing", botId: null, typing: false }));
      await expect(stoppedTypingPresence).resolves.toMatchObject({
        type: "team-presence",
        snapshot: {
          members: expect.arrayContaining([expect.objectContaining({ email: "alice@example.com", typingBotId: null })]),
        },
      });

      const owner = store.listMembers().find((member) => member.role === "owner");
      expect(owner).toBeDefined();
      const directTypingEvent = nextJsonEvent(socket);
      socket.send(
        JSON.stringify({
          type: "team-direct-typing",
          recipientMemberId: owner?.id,
          typing: true,
        }),
      );
      await expect(directTypingEvent).resolves.toMatchObject({
        type: "team-direct-typing",
        senderMemberId: joined.member.id,
        recipientMemberId: owner?.id,
        typing: true,
      });
      const directMessageEvent = nextJsonEvent(socket);
      const directResponse = await fetch(`http://127.0.0.1:${port}/v1/direct/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${joined.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          memberId: owner?.id,
          clientMessageId: "message-alice-owner",
          text: "Can we review this together?",
        }),
      });
      expect(directResponse.status).toBe(201);
      await expect(directMessageEvent).resolves.toMatchObject({
        type: "team-direct-message",
        message: {
          senderMemberId: joined.member.id,
          recipientMemberId: owner?.id,
          text: "Can we review this together?",
        },
      });
      const threads = await jsonRequest<Array<{ unreadCount: number }>>(
        `http://127.0.0.1:${port}`,
        "/v1/direct/threads",
        { token: joined.sessionToken },
      );
      expect(threads).toMatchObject([{ unreadCount: 0 }]);

      const received = nextJsonEvent(socket);
      agentEvents.emit("event", {
        type: "error",
        code: "smoke_event",
        message: "WebSocket delivery works.",
      });
      await expect(received).resolves.toMatchObject({ type: "error", code: "smoke_event" });
      socket.close();
      await expect
        .poll(() => presenceSnapshots.at(-1)?.members.find((member) => member.email === "alice@example.com")?.online)
        .toBe(false);
    } finally {
      await api.stop();
      database.close();
    }
  });

  it("manages invites, members, sessions, and password changes on loopback", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const agents = createAgents();
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
      createInvite: async (input) => {
        const created = await store.createInvite(input.role, input.email);
        return {
          id: created.id,
          role: created.role,
          expiresAt: created.expiresAt,
          usedAt: null,
          inviteUrl: `https://openbot.run/join?token=${created.token}`,
          email: created.email,
        };
      },
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const ownerLogin = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const ownerToken = ownerLogin.sessionToken;
      const invite = await jsonRequest<{ id: string; inviteUrl: string }>(base, "/v1/team/invites", {
        token: ownerToken,
        body: { role: "member" },
      });
      const inviteToken = new URL(invite.inviteUrl).searchParams.get("token");
      expect(inviteToken).not.toBeNull();
      const joined = await jsonRequest<{ member: { id: string }; sessionToken: string }>(base, "/v1/join", {
        body: {
          inviteToken,
          username: "alice",
          password: "a secure team password",
        },
      });
      const updated = await jsonRequest<{ role: string }>(base, `/v1/team/members/${joined.member.id}`, {
        method: "PATCH",
        token: ownerToken,
        body: { role: "admin" },
      });
      expect(updated.role).toBe("admin");

      const sessions = await jsonRequest<Array<{ id: string; username: string }>>(base, "/v1/team/sessions", {
        token: ownerToken,
      });
      const aliceSession = sessions.find((session) => session.username === "alice");
      expect(aliceSession).toBeDefined();
      await emptyRequest(base, `/v1/team/sessions/${aliceSession?.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      expect(store.authenticate(joined.sessionToken)).toBeNull();

      await emptyRequest(base, `/v1/team/invites/${invite.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      await emptyRequest(base, `/v1/team/members/${joined.member.id}`, {
        method: "DELETE",
        token: ownerToken,
      });
      expect(store.listMembers().map((member) => member.username)).toEqual(["owner"]);
      await emptyRequest(base, "/v1/auth/password", {
        token: ownerToken,
        body: {
          currentPassword: "correct horse battery",
          newPassword: "a newer secure password",
        },
      });
      expect(store.authenticate(ownerToken)).toBeNull();
    } finally {
      await api.stop();
    }
  });

  it("rejects oversized agent input before it reaches the agent service", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-limits-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const agents = createAgents();
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const message = await fetch(`${base}/v1/agents/chief/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "x".repeat(INPUT_LIMITS.messageText + 1) }),
      });
      expect(message.status).toBe(400);

      const update = await fetch(`${base}/v1/agents/chief`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x".repeat(INPUT_LIMITS.agentName + 1) }),
      });
      expect(update.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("supports memory operations through the authenticated team API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-memories-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const memories: BotMemory[] = [];
    const createMemory = vi.fn((input: { botId: string; text: string }) => {
      const memory: BotMemory = {
        id: "memory-1",
        botId: input.botId,
        text: input.text,
        origin: "manual",
        sourceTurnId: null,
        createdAt: "2026-08-25T12:00:00.000Z",
        updatedAt: "2026-08-25T12:00:00.000Z",
      };
      memories.push(memory);
      return memory;
    });
    const updateMemory = vi.fn((input: { botId: string; memoryId: string; text: string }) => {
      const memory = memories.find((item) => item.id === input.memoryId && item.botId === input.botId);
      if (!memory) throw new Error("Memory not found.");
      memory.text = input.text;
      memory.updatedAt = "2026-08-25T12:01:00.000Z";
      return memory;
    });
    const deleteMemory = vi.fn((input: { botId: string; memoryId: string }) => {
      const index = memories.findIndex((item) => item.id === input.memoryId && item.botId === input.botId);
      if (index >= 0) memories.splice(index, 1);
    });
    const clearMemories = vi.fn((botId: string) => {
      for (let index = memories.length - 1; index >= 0; index -= 1) {
        if (memories[index]?.botId === botId) memories.splice(index, 1);
      }
    });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listMemories: (botId) => memories.filter((memory) => memory.botId === botId),
        createMemory,
        updateMemory,
        deleteMemory,
        clearMemories,
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const token = login.sessionToken;
      await expect(
        jsonRequest<BotMemory>(base, "/v1/agents/chief/memories", {
          token,
          body: { text: "Uses metric units." },
        }),
      ).resolves.toMatchObject({ id: "memory-1", botId: "chief", origin: "manual" });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toHaveLength(1);
      await expect(
        jsonRequest<BotMemory>(base, "/v1/agents/chief/memories/memory-1", {
          method: "PATCH",
          token,
          body: { text: "Uses SI units." },
        }),
      ).resolves.toMatchObject({ text: "Uses SI units." });
      await emptyRequest(base, "/v1/agents/chief/memories/memory-1", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toEqual([]);
      expect(createMemory).toHaveBeenCalledWith({ botId: "chief", text: "Uses metric units." });
      expect(updateMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1", text: "Uses SI units." });
      expect(deleteMemory).toHaveBeenCalledWith({ botId: "chief", memoryId: "memory-1" });

      await jsonRequest<BotMemory>(base, "/v1/agents/chief/memories", {
        token,
        body: { text: "Clear this memory." },
      });
      await emptyRequest(base, "/v1/agents/chief/memories", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/memories", { token })).resolves.toEqual([]);
      expect(clearMemories).toHaveBeenCalledWith("chief");

      const oversized = await fetch(`${base}/v1/agents/chief/memories`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(INPUT_LIMITS.agentMemoryText + 1) }),
      });
      expect(oversized.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("supports routine operations through the authenticated team API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-routines-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const routines: Routine[] = [];
    const createRoutine = vi.fn((input: Parameters<TestAgents["createRoutine"]>[0]) => {
      const now = "2026-08-25T12:00:00.000Z";
      const routine: Routine = {
        id: "routine-1",
        botId: input.botId,
        name: input.name,
        instruction: input.instruction,
        active: input.active,
        timezone: input.timezone,
        trigger: {
          id: "trigger-1",
          routineId: "routine-1",
          schedule: input.schedule,
          nextRunAt: "2026-08-26T05:00:00.000Z",
          createdAt: now,
          updatedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      routines.push(routine);
      return routine;
    });
    const updateRoutine = vi.fn((input: Parameters<TestAgents["updateRoutine"]>[0]) => {
      const routine = routines.find((item) => item.id === input.routineId && item.botId === input.botId);
      if (!routine) throw new Error("Routine not found.");
      if (input.name !== undefined) routine.name = input.name;
      if (input.active !== undefined) routine.active = input.active;
      if (input.schedule !== undefined) routine.trigger.schedule = input.schedule;
      return routine;
    });
    const run: RoutineRun = {
      id: "run-1",
      routineId: "routine-1",
      botId: "chief",
      triggerId: null,
      kind: "manual",
      scheduledFor: "2026-08-25T12:05:00.000Z",
      routineName: "Morning brief",
      instruction: "Prepare the brief.",
      deliveryId: "delivery-1",
      status: "queued",
      error: null,
      createdAt: "2026-08-25T12:05:00.000Z",
      updatedAt: "2026-08-25T12:05:00.000Z",
    };
    const deleteRoutine = vi.fn(async ({ routineId }: { routineId: string }) => {
      const index = routines.findIndex((routine) => routine.id === routineId);
      if (index >= 0) routines.splice(index, 1);
    });
    const api = new TeamApiServer({
      store,
      agents: createAgents({
        listRoutines: (botId) => routines.filter((routine) => routine.botId === botId),
        createRoutine,
        updateRoutine,
        deleteRoutine,
        testRoutine: vi.fn(async () => run),
        listRoutineRuns: vi.fn(() => [run]),
      }),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const token = login.sessionToken;
      await expect(
        jsonRequest<Routine>(base, "/v1/agents/chief/routines", {
          token,
          body: {
            name: "Morning brief",
            instruction: "Prepare the brief.",
            active: true,
            timezone: "Europe/Warsaw",
            schedule: { kind: "weekdays", time: "07:00" },
          },
        }),
      ).resolves.toMatchObject({ id: "routine-1", botId: "chief" });
      await expect(jsonRequest(base, "/v1/agents/chief/routines", { token })).resolves.toHaveLength(1);
      await expect(
        jsonRequest<Routine>(base, "/v1/agents/chief/routines/routine-1", {
          method: "PATCH",
          token,
          body: { active: false, schedule: { kind: "daily", time: "09:15" } },
        }),
      ).resolves.toMatchObject({ active: false, trigger: { schedule: { kind: "daily", time: "09:15" } } });
      await expect(
        jsonRequest<RoutineRun>(base, "/v1/agents/chief/routines/routine-1/test", { token, body: {} }),
      ).resolves.toMatchObject({ kind: "manual", status: "queued" });
      await expect(jsonRequest(base, "/v1/agents/chief/routines/routine-1/runs?limit=10", { token })).resolves.toEqual([
        run,
      ]);
      await emptyRequest(base, "/v1/agents/chief/routines/routine-1", { method: "DELETE", token });
      await expect(jsonRequest(base, "/v1/agents/chief/routines", { token })).resolves.toEqual([]);
    } finally {
      await api.stop();
    }
  });

  it("downloads authenticated shared files through the remote API", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-shared-file-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const filePath = join(root, "report.csv");
    await writeFile(filePath, "name,value\nOpenBot,1\n");
    const agents = createAgents({
      resolveSharedFile: async (path) => ({
        path: filePath,
        name: path.includes("large") ? "large.csv" : "report.csv",
        size: path.includes("large") ? ATTACHMENT_LIMITS.fileBytes + 1 : 21,
      }),
      resolveWorkspaceFile: async (botId, path) => ({
        path: filePath,
        name: `${botId}-${path.split("/").at(-1)}`,
        size: 21,
      }),
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const response = await fetch(
        `${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/report.csv")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("report.csv");
      expect(await response.text()).toBe("name,value\nOpenBot,1\n");

      const oversized = await fetch(
        `${base}/v1/shared-files?path=${encodeURIComponent("~/OpenBot/Shared/large.csv")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(oversized.status).toBe(413);

      const unauthorized = await fetch(`${base}/v1/shared-files?path=Shared/report.csv`);
      expect(unauthorized.status).toBe(401);

      const workspaceResponse = await fetch(
        `${base}/v1/workspace-files?botId=chief&path=${encodeURIComponent("app/page.tsx")}`,
        {
          headers: { Authorization: `Bearer ${login.sessionToken}` },
        },
      );
      expect(workspaceResponse.status).toBe(200);
      expect(workspaceResponse.headers.get("content-disposition")).toContain("chief-page.tsx");
      expect(await workspaceResponse.text()).toBe("name,value\nOpenBot,1\n");

      const unauthorizedWorkspace = await fetch(`${base}/v1/workspace-files?botId=chief&path=app/page.tsx`);
      expect(unauthorizedWorkspace.status).toBe(401);
    } finally {
      await api.stop();
    }
  });

  it("publishes agents and conversations from the same local agent service", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-local-instance-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const localBots: BotSummary[] = [
      {
        id: "chief",
        provider: "codex",
        name: "Chief",
        title: "Lead",
        description: "",
        notifications: true,
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        threadId: "thread-chief",
        workspacePath: root,
        preview: "",
        updatedAt: null,
        avatarSeed: "chief",
        avatarHue: null,
        avatarUrl: null,
      },
    ];
    const localConversation: ConversationWithReadState = {
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "message-1",
          author: "assistant",
          text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
          createdAt: "2026-08-19T10:00:00.000Z",
          status: "completed",
        },
        {
          id: "routine-event-1",
          author: "system",
          source: "system",
          text: "Morning brief",
          createdAt: "2026-08-19T10:01:00.000Z",
          status: "completed",
          itemType: routineConversationEventItemType("created", "routine-1"),
        },
        {
          id: "routine-run-event-1",
          author: "system",
          source: "system",
          text: "Morning brief",
          createdAt: "2026-08-19T10:02:00.000Z",
          status: "completed",
          itemType: routineRunConversationEventItemType("running", "routine-1", "run-1"),
        },
        {
          id: "hosted-site-event-1",
          author: "system",
          source: "system",
          text: hostedSiteConversationEventText({
            siteId: null,
            title: "Launch page",
            hostname: null,
            url: null,
          }),
          createdAt: "2026-08-19T10:03:00.000Z",
          status: "completed",
          itemType: hostedSiteConversationEventItemType("publish", "running", "operation-1"),
        },
      ],
    };
    const createBot = vi.fn(
      async (input: CreateBotInput): Promise<BotSummary> => ({
        ...localBots[0],
        id: "trip-planner",
        name: input.name,
        title: "",
        description: input.description,
        avatarSeed: input.avatarSeed,
        avatarHue: input.avatarHue,
      }),
    );
    const legacyConversation = {
      ...localConversation,
      messages: [
        { ...localConversation.messages[0], text: "Ask @Research to use Sources (skill)." },
        ...localConversation.messages.slice(1),
      ],
    };
    const sendMessage = vi.fn<TestAgents["sendMessage"]>(async () => ({
      messageId: "message-tagged",
      deliveries: [],
    }));
    const usage: AccountUsage = {
      limits: [
        {
          id: "codex",
          primary: null,
          secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_788_825_600 },
        },
      ],
    };
    const getUsage = vi.fn(async () => usage);
    const readConversationPageFor = vi.fn(async (...args: unknown[]) => {
      const options = isDynamicRecord(args[4]) ? args[4] : {};
      const messages = localConversation.messages.filter((message) => {
        if (options.excludeRoutineEvents && message.itemType?.startsWith("routine-event:")) return false;
        if (options.excludeRoutineRunEvents && message.itemType?.startsWith("routine-run-event:")) return false;
        if (options.excludeHostedSiteEvents && message.itemType?.startsWith("hosted-site-event:")) return false;
        return true;
      });
      return {
        ...localConversation,
        messages,
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
        readState: {
          unreadCount: 0,
          firstUnreadMessageId: null,
          throughMessageId: options.excludeHostedSiteEvents ? "message-1" : "hosted-site-event-1",
        },
      };
    });
    const listConversationReads = vi.fn((_memberId: string, options: { excludeHostedSiteEvents?: boolean } = {}) => ({
      chief: {
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: options.excludeHostedSiteEvents ? "message-1" : "hosted-site-event-1",
      },
    }));
    const markConversationUnread = vi.fn(async (_botId: string, _memberId: string) => ({
      unreadCount: 1,
      firstUnreadMessageId: "message-1",
      throughMessageId: null,
    }));
    const agents = createAgents({
      listBots: () => localBots,
      getUsage,
      createBot,
      listConversationReads,
      markConversationUnread,
      readConversationFor: async (botId: string, _memberId: string) => ({
        ...localConversation,
        botId,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
      }),
      readConversationPageFor,
      markConversationRead: async (
        _botId: string,
        _memberId: string,
        throughMessageId: string | null,
        options: { excludeHostedSiteEvents?: boolean } = {},
      ) => ({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: options.excludeHostedSiteEvents ? throughMessageId : "hosted-site-event-1",
      }),
      sendMessage,
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const createInput: CreateBotInput = {
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        avatarSeed: "setup:trip",
        avatarHue: 215,
        initialMessage: "Help me plan a trip.",
      };
      await expect(
        jsonRequest(base, "/v1/agents", { token: login.sessionToken, body: createInput }),
      ).resolves.toMatchObject({
        id: "trip-planner",
        name: "Trip Planner",
        description: "Builds practical itineraries.",
        title: "",
      });
      expect(createBot).toHaveBeenCalledWith(createInput);
      await expect(jsonRequest(base, "/v1/agents", { token: login.sessionToken })).resolves.toEqual(localBots);
      await expect(
        jsonRequest(base, "/v1/agents/chief/usage", {
          token: login.sessionToken,
          capabilities: [...TEAM_CURRENT_CAPABILITIES],
          protocol: TEAM_PROTOCOL_V3,
        }),
      ).resolves.toEqual(usage);
      expect(getUsage).toHaveBeenCalledWith("chief");
      await expect(jsonRequest(base, "/v1/agents/chief/conversation", { token: login.sessionToken })).resolves.toEqual({
        ...legacyConversation,
        messages: [legacyConversation.messages[0]],
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation", {
          token: login.sessionToken,
          capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
        }),
      ).resolves.toEqual({
        ...legacyConversation,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation", {
          token: login.sessionToken,
          capabilities: [...TEAM_CURRENT_CAPABILITIES],
        }),
      ).resolves.toEqual({
        ...localConversation,
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation-page?limit=10", { token: login.sessionToken }),
      ).resolves.toMatchObject({
        messages: [{ id: "message-1" }],
        readState: { throughMessageId: "message-1" },
      });
      expect(readConversationPageFor.mock.calls.at(-1)?.[4]).toEqual({
        excludeRoutineEvents: true,
        excludeRoutineRunEvents: true,
        excludeHostedSiteEvents: true,
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation-page?limit=10", {
          token: login.sessionToken,
          capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
        }),
      ).resolves.toMatchObject({ messages: legacyConversation.messages });
      expect(readConversationPageFor.mock.calls.at(-1)?.[4]).toEqual({
        excludeRoutineEvents: false,
        excludeRoutineRunEvents: false,
        excludeHostedSiteEvents: false,
      });
      await expect(jsonRequest(base, "/v1/agents/conversation-reads", { token: login.sessionToken })).resolves.toEqual({
        chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "message-1" },
      });
      expect(listConversationReads.mock.calls.at(-1)?.[1]).toEqual({
        excludeRoutineEvents: true,
        excludeRoutineRunEvents: true,
        excludeHostedSiteEvents: true,
      });
      await expect(
        jsonRequest(base, "/v1/agents/conversation-reads", {
          token: login.sessionToken,
          capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
        }),
      ).resolves.toEqual({
        chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: "hosted-site-event-1" },
      });
      expect(listConversationReads.mock.calls.at(-1)?.[1]).toEqual({
        excludeRoutineEvents: false,
        excludeRoutineRunEvents: false,
        excludeHostedSiteEvents: false,
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation/read", {
          token: login.sessionToken,
          body: { throughMessageId: "message-1" },
        }),
      ).resolves.toEqual({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: "message-1",
      });
      const taggedMessage = "Ask @[Research](agent:research) to use @[Sources](skill:sources).";
      await jsonRequest(base, "/v1/agents/chief/messages", {
        token: login.sessionToken,
        protocol: TEAM_PROTOCOL_V3,
        capabilities: [...TEAM_CURRENT_CAPABILITIES],
        body: {
          text: taggedMessage,
          attachmentDraftIds: [],
          replyToMessageId: null,
        },
      });
      expect(sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: taggedMessage,
        attachmentDraftIds: [],
        replyToMessageId: null,
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation/read", {
          token: login.sessionToken,
          capabilities: [...TEAM_PROTOCOL_V1_CAPABILITIES],
          body: { throughMessageId: "message-1" },
        }),
      ).resolves.toEqual({
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: "hosted-site-event-1",
      });
      await expect(
        jsonRequest(base, "/v1/agents/chief/conversation/unread", {
          token: login.sessionToken,
          protocol: TEAM_PROTOCOL_V3,
          capabilities: [...TEAM_CURRENT_CAPABILITIES],
          body: {},
        }),
      ).resolves.toEqual({ unreadCount: 1, firstUnreadMessageId: "message-1", throughMessageId: null });
      expect(markConversationUnread).toHaveBeenCalledWith("chief", store.authenticate(login.sessionToken)?.id);
      const unsupported = await fetch(`${base}/v1/agents/chief/conversation/unread`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: "3",
        },
        body: "{}",
      });
      expect(unsupported.status).toBe(400);
      const forgedReader = await fetch(`${base}/v1/agents/chief/conversation/unread`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
          [TEAM_PROTOCOL_VERSION_HEADER]: "3",
          [TEAM_CAPABILITIES_HEADER]: TEAM_CURRENT_CAPABILITIES.join(","),
        },
        body: JSON.stringify({ memberId: "other-reader" }),
      });
      expect(forgedReader.status).toBe(400);
      expect(markConversationUnread).toHaveBeenCalledTimes(1);
    } finally {
      await api.stop();
    }
  });

  it("responds to authenticated remote interactive requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-approval-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const approvals: unknown[] = [];
    const failures: unknown[] = [];
    const takeovers: unknown[] = [];
    const prompts: unknown[] = [];
    const agents = createAgents({
      acknowledgeFailedTurn: (botId, turnId) => {
        failures.push({ botId, turnId });
      },
      respondToPrompt: async (input: unknown) => {
        prompts.push(input);
      },
      respondToApproval: async (input: unknown) => {
        approvals.push(input);
      },
      respondToBrowserTakeover: async (input: unknown) => {
        takeovers.push(input);
      },
    });
    const api = new TeamApiServer({
      store,
      agents,
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      await emptyRequest(base, "/v1/approvals/respond", {
        token: login.sessionToken,
        body: { requestId: 17, decision: "accept" },
      });
      expect(approvals).toEqual([{ requestId: 17, decision: "accept" }]);
      await emptyRequest(base, "/v1/browser-takeovers/respond", {
        token: login.sessionToken,
        body: { requestId: "takeover-17", decision: "complete" },
      });
      expect(takeovers).toEqual([{ requestId: "takeover-17", decision: "complete" }]);
      await emptyRequest(base, "/v1/prompts/respond", {
        token: login.sessionToken,
        body: { requestId: "prompt-17", answers: { scope: ["Small"] } },
      });
      expect(prompts).toEqual([{ requestId: "prompt-17", answers: { scope: ["Small"] } }]);
      await emptyRequest(base, "/v1/agents/chief/failures/acknowledge", {
        token: login.sessionToken,
        body: { turnId: "turn-failed" },
      });
      expect(failures).toEqual([{ botId: "chief", turnId: "turn-failed" }]);

      const oversizedPrompt = await fetch(`${base}/v1/prompts/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: "prompt-18",
          answers: {
            first: ["a".repeat(INPUT_LIMITS.promptAnswersTotalText / 2 + 1)],
            second: ["b".repeat(INPUT_LIMITS.promptAnswersTotalText / 2)],
          },
        }),
      });
      expect(oversizedPrompt.status).toBe(400);
      expect(prompts).toHaveLength(1);

      const invalid = await fetch(`${base}/v1/approvals/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${login.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: 17, decision: "session" }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      await api.stop();
    }
  });

  it("returns a bounded browser preview to an authenticated client", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-browser-preview-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const capturePreview = vi.fn(async () => ({
      dataUrl: "data:image/jpeg;base64,YWJj",
      width: 960,
      height: 600,
    }));
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser({ capturePreview }),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const preview = await jsonRequest<{ dataUrl: string; width: number; height: number }>(
        base,
        "/v1/browser/preview",
        { token: login.sessionToken, body: { tabId: "tab-login" } },
      );

      expect(capturePreview).toHaveBeenCalledWith("tab-login");
      expect(preview).toEqual({ dataUrl: "data:image/jpeg;base64,YWJj", width: 960, height: 600 });
    } finally {
      await api.stop();
    }
  });

  it("requires the WebRTC protocol for legacy Remote Desktop clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-desktop-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const login = await jsonRequest<{ sessionToken: string }>(base, "/v1/auth/login", {
        body: { username: "owner", password: "correct horse battery" },
      });
      const legacy = await fetch(`${base}/v1/host/remote-desktop-access`, {
        headers: { Authorization: `Bearer ${login.sessionToken}` },
      });
      expect(legacy.status).toBe(426);
      await expect(legacy.json()).resolves.toEqual({ error: "Update required.", code: "protocol_mismatch" });

      const unauthorized = await fetch(`${base}/v1/host/remote-desktop-access`);
      expect(unauthorized.status).toBe(401);
    } finally {
      await api.stop();
    }
  });

  it("allows an active member to create remote control and rejects an outsider", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-team-api-remote-screen-"));
    roots.push(root);
    const store = new TeamStore(join(root, "team.json"));
    await store.initialize();
    await store.configure("Studio Mac", "owner", "correct horse battery");
    const invite = await store.createInvite("member");
    const joined = await store.acceptInvite(invite.token, "alice", "a secure team password");
    const now = "2026-08-20T12:00:00.000Z";
    const createSession = vi.fn(
      async (input: { serverId: string; memberId: string; teamSessionId: string; teamSessionExpiresAt: string }) => ({
        id: "remote-session-1",
        serverId: input.serverId,
        viewerUrl: "https://studio.example/v1/remote-screen/sessions/remote-session-1/viewer",
        viewerGrant: "one-use-viewer-grant",
        displays: [{ id: "primary", label: "Primary display", width: 1920, height: 1080, primary: true }],
        selectedDisplayId: "primary",
        phase: "connecting" as const,
        transport: "unknown" as const,
        errorCode: null,
        message: "Waiting for the WebRTC client…",
        createdAt: now,
        grantExpiresAt: "2026-08-20T12:01:00.000Z",
      }),
    );
    const remoteScreen: NonNullable<TeamApiOptions["remoteScreen"]> = {
      handlesHttp: () => false,
      handleHttp: unimplemented,
      handlesUpgrade: () => false,
      handleUpgrade: unimplemented,
      stop: vi.fn(async () => undefined),
      capabilities: () => ({
        ready: true,
        platform: "darwin" as const,
        unattended: false,
        runtime: "sunshine-moonlight" as const,
        protocolVersion: 2 as const,
        displays: [],
        selectedDisplayId: null,
        activeSessions: 0,
        maxSessions: 4,
      }),
      createSession,
      selectDisplay: vi.fn(async () => undefined),
      closeMemberSession: vi.fn(async () => true),
      revokeTeamSession: vi.fn(async () => undefined),
      revokeMember: vi.fn(async () => undefined),
    };
    const api = new TeamApiServer({
      store,
      agents: createAgents(),
      mailbox: createMailbox(),
      browser: createBrowser(),
      remoteScreen,
    });
    const port = await api.start();
    const base = `http://127.0.0.1:${port}`;

    try {
      const outsider = await fetch(`${base}/v1/remote-screen/sessions`, { method: "POST" });
      expect(outsider.status).toBe(401);
      expect(createSession).not.toHaveBeenCalled();

      const response = await fetch(`${base}/v1/remote-screen/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.sessionToken}` },
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        id: "remote-session-1",
        viewerGrant: "one-use-viewer-grant",
        phase: "connecting",
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: store.getIdentity()?.serverId,
          memberId: joined.member.id,
          teamSessionId: expect.any(String),
          teamSessionExpiresAt: joined.sessionExpiresAt,
        }),
      );

      const owner = await store.login("owner", "correct horse battery");
      const disabled = await fetch(`${base}/v1/team/members/${joined.member.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${owner.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ disabled: true }),
      });
      expect(disabled.status).toBe(200);
      expect(remoteScreen.revokeMember).toHaveBeenCalledWith(joined.member.id);

      const blocked = await fetch(`${base}/v1/remote-screen/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${joined.sessionToken}` },
      });
      expect(blocked.status).toBe(401);
      expect(createSession).toHaveBeenCalledOnce();
    } finally {
      await api.stop();
    }
  });
});

function nextJsonEvent(websocket: WebSocket): Promise<TestRealtimeEvent> {
  return new Promise((resolve, reject) => {
    websocket.addEventListener(
      "message",
      (message) => resolve(decodeTestRealtimeEvent(JSON.parse(String(message.data)))),
      { once: true },
    );
    websocket.addEventListener("error", () => reject(new Error("WebSocket event failed.")), {
      once: true,
    });
  });
}

function nextJsonEvents(websocket: WebSocket, count: number): Promise<TestRealtimeEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TestRealtimeEvent[] = [];
    websocket.addEventListener("message", (message) => {
      events.push(decodeTestRealtimeEvent(JSON.parse(String(message.data))));
      if (events.length === count) resolve(events);
    });
    websocket.addEventListener("error", () => reject(new Error("WebSocket event failed.")), {
      once: true,
    });
  });
}

async function jsonRequest<T>(
  base: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    capabilities?: string[];
    protocol?: number;
    appVersion?: string;
  } = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.capabilities ? { [TEAM_CAPABILITIES_HEADER]: options.capabilities.join(",") } : {}),
      ...(options.protocol ? { [TEAM_PROTOCOL_VERSION_HEADER]: String(options.protocol) } : {}),
      ...(options.appVersion ? { [TEAM_APP_VERSION_HEADER]: options.appVersion } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
}

function decodeTestRealtimeEvent(value: unknown): TestRealtimeEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) {
    throw new Error("Invalid test realtime event.");
  }
  const code = value.code;
  if (code !== undefined && !isString(code)) throw new Error("Invalid test event code.");
  const senderMemberId = value.senderMemberId;
  if (senderMemberId !== undefined && !isString(senderMemberId)) {
    throw new Error("Invalid test sender.");
  }
  const recipientMemberId = value.recipientMemberId;
  if (recipientMemberId !== undefined && !isString(recipientMemberId)) {
    throw new Error("Invalid test recipient.");
  }
  const typing = value.typing;
  if (typing !== undefined && !isBoolean(typing)) throw new Error("Invalid test typing state.");
  const botId = value.botId;
  if (botId !== undefined && !isString(botId)) throw new Error("Invalid test bot id.");
  const revision = value.revision;
  if (revision !== undefined && !isNumber(revision)) throw new Error("Invalid test revision.");
  return {
    type: value.type,
    ...(botId === undefined ? {} : { botId }),
    ...(revision === undefined ? {} : { revision }),
    ...(code === undefined ? {} : { code }),
    ...(value.snapshot === undefined ? {} : { snapshot: value.snapshot }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.layout === undefined ? {} : { layout: value.layout }),
    ...(senderMemberId === undefined ? {} : { senderMemberId }),
    ...(recipientMemberId === undefined ? {} : { recipientMemberId }),
    ...(typing === undefined ? {} : { typing }),
  };
}

async function emptyRequest(
  base: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown },
): Promise<void> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "POST",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  expect(response.status).toBe(204);
}

type RemoteInvites = Awaited<ReturnType<NonNullable<HostOptions["listRemoteInvites"]>>>;
type RemoteMembers = Awaited<ReturnType<NonNullable<HostOptions["listRemoteMembers"]>>>;
type RemoteInvite = Awaited<ReturnType<NonNullable<HostOptions["createRemoteInvite"]>>>;

describe("HostService account binding", () => {
  const first = { id: "account-a", email: "a@example.com", name: "A", avatarUrl: null };
  const second = { id: "account-b", email: "b@example.com", name: "B", avatarUrl: null };

  it("stops reporting the previous account's server when the account changes", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    expect(service.getStatus().serverName).toBe("Studio Mac");

    await signIn(second);

    const status = service.getStatus();
    expect(status.configured).toBe(false);
    expect(status.phase).toBe("unconfigured");
    expect(status.serverId).toBeNull();
    expect(status.serverName).toBeNull();
    expect(status.enabledOnLaunch).toBe(false);
  });

  it("stops reporting the previous account's server before the switch is recorded", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    // What `forwardCentralAuth` calls before it tells the renderer the account changed.
    service.unbindChangedAccount(second);

    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();
    expect(service.getStatus().serverName).toBeNull();
  });

  it("puts the account's server back when the same account is reported after the unbind", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await service.configure({ serverName: "Studio Mac" });

    // A sign-out and an immediate sign-in as the same account: the unbind lands first, and
    // the queued switch that follows is the only thing that can bind the host again.
    service.unbindChangedAccount(second);
    await signIn(first);

    expect(service.getStatus().configured).toBe(true);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });

  it("does not bind the previous account's server when its switch is applied too late", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    await signIn(second);

    // A's queued switch, arriving after B is the signed-in account.
    await service.applySignedInAccount(first);

    expect(service.getStatus().configured).toBe(false);
    expect(() => service.listMembers()).toThrow("The team server is not configured.");
  });

  it("answers invitations from the host that is active when the read returns", async () => {
    let deliver: (invites: RemoteInvites) => void = () => undefined;
    const loading = new Promise<RemoteInvites>((resolve) => {
      deliver = resolve;
    });
    const { service, signIn } = await createHostService({ listRemoteInvites: () => loading });
    await signIn(second);
    await service.configure({ serverName: "Studio Air" });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.listInvites();
    await signIn(second);
    deliver([
      {
        inviteId: "invite-1",
        role: "member",
        email: "invited-by-a@example.com",
        expiresAt: Date.now() + 60_000,
        usedAt: null,
        revokedAt: null,
      },
    ]);

    // A's invitation, and the address it was sent to, must not reach B's renderer.
    await expect(pending).resolves.toEqual([]);
  });

  it("does not push a server update to the remote directory once the account has changed", async () => {
    let finishRegistration: () => void = () => undefined;
    const registered = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const logos: string[] = [];
    const { service, signIn } = await createHostService({
      // Naming the server registers it too; only the update's registration is held open.
      registerRemoteHost: (input) => {
        if (input.name !== "Renamed") return Promise.resolve();
        registrationStarted();
        return registered;
      },
      updateRemoteHostLogo: async (hostId) => {
        logos.push(hostId);
        return null;
      },
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.updateIdentity({
      serverName: "Renamed",
      logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
    // The store's own guard covers the window up to here; this is the one after it.
    await started;
    await signIn(second);
    finishRegistration();
    await pending;

    // Uploading it here would send A's image under B's authentication.
    expect(logos).toEqual([]);
  });

  it("does not change a member on the previous account's server once the account has changed", async () => {
    let releaseRead: (members: RemoteMembers) => void = () => undefined;
    const reading = new Promise<RemoteMembers>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let reads = 0;
    const mutations: string[] = [];
    const { service, signIn } = await createHostService({
      listRemoteMembers: () => {
        reads += 1;
        readStarted();
        return reading;
      },
      updateRemoteMember: async (hostId) => {
        mutations.push(hostId);
      },
      removeRemoteMember: async (hostId) => {
        mutations.push(hostId);
      },
      registerRemoteHost: () => Promise.resolve(),
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.updateMember({ memberId: "member-1", role: "admin" });
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseRead([
      {
        membershipId: "member-1",
        email: "person@example.com",
        name: null,
        avatarUrl: null,
        role: "member",
        status: "active",
        createdAt: 1_000,
      },
    ]);
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mutation would have carried B's authorization to A's host.
    expect(mutations).toEqual([]);
    expect(reads).toBe(1);
  });

  it("leaves the new account's status alone when the previous account's registration fails", async () => {
    let failRegistration: (error: Error) => void = () => undefined;
    const registration = new Promise<void>((_resolve, reject) => {
      failRegistration = reject;
    });
    let registrationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const { service, signIn } = await createHostService({
      registerRemoteHost: () => {
        registrationStarted();
        return registration;
      },
    });
    await signIn(first);

    const pending = service.configure({ serverName: "Studio Mac" });
    await started;
    await signIn(second);
    const beforeFailure = service.getStatus();
    failRegistration(new Error("Could not reserve the public address."));
    await pending;

    // B has no server of its own; A's failure must not paint an error over that.
    expect(service.getStatus()).toEqual(beforeFailure);
    expect(service.getStatus().phase).not.toBe("error");
  });

  it("does not email an invitation created for the account that has just been left", async () => {
    let releaseInvite: (invite: RemoteInvite) => void = () => undefined;
    const creating = new Promise<RemoteInvite>((resolve) => {
      releaseInvite = resolve;
    });
    let creationStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    const emails: string[] = [];
    const { service, signIn } = await createHostService({
      registerRemoteHost: () => Promise.resolve(),
      remoteControlPlaneUrl: "https://api.openbot.run",
      createRemoteInvite: () => {
        creationStarted();
        return creating;
      },
      sendTeamInviteEmail: async ({ email }) => {
        emails.push(email);
      },
    });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });

    const pending = service.createInvite({ role: "member", email: "guest@example.com" });
    const settled = pending.catch(() => undefined);
    await started;
    await signIn(second);
    releaseInvite({
      inviteId: "invite-1",
      token: "invite-token-that-is-long-enough-for-a-link",
      expiresAt: Date.now() + 60_000,
    });
    await settled;

    await expect(pending).rejects.toThrow("signed-in account changed");
    // The mail would name A's server and go out under B's authentication.
    expect(emails).toEqual([]);
  });

  it("activates the account again after a failed switch instead of leaving it unconfigured", async () => {
    const { service, signIn, root } = await createHostService({ registerRemoteHost: () => Promise.resolve() });
    await signIn(first);
    await service.configure({ serverName: "Studio Mac" });
    await signIn(second);
    const secondIdentity = await service.configure({ serverName: "Loft Mini" });
    await signIn(first);

    // The team file cannot be written while its directory is gone, so recording the switch fails.
    await rm(root, { recursive: true, force: true });
    await expect(signIn(second)).rejects.toThrow();
    expect(service.getStatus().configured).toBe(false);

    await mkdir(root, { recursive: true });
    await signIn(second);
    expect(service.getStatus().serverId).toBe(secondIdentity.serverId);
    expect(service.getStatus().configured).toBe(true);
  });

  it("does not create the previous account's server once another account has been announced", async () => {
    const registrations: string[] = [];
    const { service, signIn, announce } = await createHostService({
      registerRemoteHost: async ({ hostId }) => {
        registrations.push(hostId);
      },
    });
    await signIn(first);

    const pending = service.configure({
      serverName: "Studio Mac",
      logo: { mimeType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    });
    // Announced while the logo and the host are being written, with the switch itself queued.
    announce(second);

    await expect(pending).rejects.toThrow("signed-in account changed");
    expect(service.getStatus().configured).toBe(false);
    // Registering would have reserved A's server under B's authentication.
    expect(registrations).toEqual([]);
    // Nor may what was created stay readable: the owner's address is in there.
    expect(() => service.listMembers()).toThrow("The team server is not configured.");
  });

  it("reports the account's own server again after signing out and back in", async () => {
    const { service, signIn } = await createHostService();
    await signIn(first);
    const identity = await service.configure({ serverName: "Studio Mac" });

    await signIn(null);
    expect(service.getStatus().configured).toBe(false);
    expect(service.getStatus().serverId).toBeNull();

    await signIn(first);
    expect(service.getStatus().serverId).toBe(identity.serverId);
    expect(identity.serverId).not.toBeNull();
    expect(service.getStatus().serverName).toBe("Studio Mac");
  });
});
