// @vitest-environment node

// The fixtures the `team-api-server.*` tests share: a temporary team file, a server built over it,
// the three service doubles its constructor demands, and the request helpers that speak to it over
// a real socket.
//
// The suite is split by domain because the server refuses to split: every case drives real HTTP
// against a real listener on a real port, so there is no seam between them other than the route
// they call. That makes one preamble - make a directory, make a `TeamStore`, initialize it,
// configure an owner, fill in `agents` / `mailbox` / `browser` with doubles, start, log in - the
// thing every file would otherwise copy, which is what `createTeamApiFixture` is.
//
// Four things it deliberately does not do for you:
//
//   - It does not default `appVersion`. `#protocolIssue` returns `null` when there is none, and the
//     route round-trip case sends protocol headers on none of its ~75 requests; a helpful default
//     would turn that whole test into 426s.
//   - It does not default `logger`. The routing case silences it on purpose, and the error-path
//     cases need the real call as the observable thing they assert on.
//   - It does not start or configure anything. One case is about `stop()`, and the identity and
//     join routes need a store nobody has configured yet.
//   - It leaves `now` to the caller, because the rate-limit case injects it.
//
// It also registers no hook. A module-level `afterEach` here would be registered when this import
// is evaluated - before the importing file's own hooks - and vitest runs root-level `afterEach` in
// LIFO order, so removing the directory would race ahead of `api.stop()`. Each file declares its
// one `afterEach(stopTeamApiFixtures)` instead; the same trap is written up in
// `remote-server-test-harness.ts:16-19`.

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_CAPABILITIES_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
} from "@openbot/contracts/team-protocol/v1";
import { expect } from "vitest";
import type { TeamApiAgents, TeamApiBrowser, TeamApiMailbox, TeamApiOptions } from "./team-api/dependencies";
import { TeamApiServer } from "./team-api-server";
import { TeamStore } from "./team-store";

export type { TeamApiOptions };

export function unimplemented(..._arguments_: unknown[]): never {
  throw new Error("This operation is not used by this test.");
}

export function createAgents(overrides: Partial<TeamApiAgents> = {}, events = new EventEmitter()): TeamApiAgents {
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

export function createMailbox(): TeamApiMailbox {
  return { resolveAttachment: unimplemented };
}

export function createBrowser(overrides: Partial<TeamApiBrowser> = {}): TeamApiBrowser {
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

/** The owner `configure: true` creates, and the credentials `login()` sends. */
export const FIXTURE_OWNER = {
  team: "Studio Mac",
  username: "owner",
  password: "correct horse battery",
} as const;

export interface StartedTeamApi {
  readonly api: TeamApiServer;
  /** `http://127.0.0.1:<port>`, the origin every request helper here takes first. */
  readonly base: string;
  readonly port: number;
}

export interface TeamApiFixture {
  readonly store: TeamStore;
  /** The temporary directory, for a workspace, a database or a second store beside the team file. */
  readonly root: string;
  /**
   * Builds the server over the store and starts it. It is a second call rather than an argument to
   * the one above because most of what the constructor takes - a `SidebarLayoutStore`, a database,
   * a workspace path, an agent double that closes over one - has to be built inside `root` first.
   */
  start(options?: Partial<TeamApiOptions>): Promise<StartedTeamApi>;
  /** Stops the listener. Idempotent, and safe to leave to `stopTeamApiFixtures`. */
  stop(): Promise<void>;
  /** Signs `FIXTURE_OWNER` in over HTTP and returns the session token. Needs `configure: true`. */
  signIn(options?: { protocol?: number; appVersion?: string }): Promise<string>;
}

const fixtures: { stop: () => Promise<void> }[] = [];
const roots: string[] = [];

/** A temporary directory holding a `team.json`, a `TeamStore` over it, and a server yet to be built. */
export async function createTeamApiFixture(
  slug: string,
  settings: { configure?: boolean } = {},
): Promise<TeamApiFixture> {
  const root = await mkdtemp(join(tmpdir(), `openbot-team-api-${slug}-`));
  roots.push(root);
  const store = new TeamStore(join(root, "team.json"));
  await store.initialize();
  if (settings.configure) {
    await store.configure(FIXTURE_OWNER.team, FIXTURE_OWNER.username, FIXTURE_OWNER.password);
  }
  let started: StartedTeamApi | null = null;
  let stopped = false;
  const fixture: TeamApiFixture = {
    store,
    root,
    start: async (options = {}) => {
      const api = new TeamApiServer({
        store,
        agents: createAgents(),
        mailbox: createMailbox(),
        browser: createBrowser(),
        ...options,
      });
      const port = await api.start();
      started = { api, base: `http://127.0.0.1:${port}`, port };
      return started;
    },
    signIn: async (options = {}) => {
      if (!started) throw new Error("The fixture has to be started before anyone can log in.");
      const session = await jsonRequest<{ sessionToken: string }>(started.base, TEAM_API_ROUTES.auth.login, {
        body: { username: FIXTURE_OWNER.username, password: FIXTURE_OWNER.password },
        ...options,
      });
      return session.sessionToken;
    },
    // The flag moves before the await, so a `stop()` that rejects - the teardown case makes one -
    // is not retried by the hook, where the rejection would fail an unrelated test.
    stop: async () => {
      if (stopped || !started) return;
      stopped = true;
      await started.api.stop();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

/** Every listener down, then every directory gone. One `afterEach` per file calls this. */
export async function stopTeamApiFixtures(): Promise<void> {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function jsonRequest<T>(
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

export async function emptyRequest(
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

/**
 * Writes a request line `fetch` would refuse to send, so a target Node accepts and the WHATWG URL
 * parser rejects can reach the router at all. Returns the status line.
 */
export async function rawRequest(base: string, requestLine: string): Promise<string> {
  const { port } = new URL(base);
  const socket = connect({ host: "127.0.0.1", port: Number(port) });
  return await new Promise<string>((resolve, reject) => {
    socket.on("error", reject);
    socket.once("data", (chunk: Buffer) => {
      socket.destroy();
      resolve(chunk.toString("utf8").split("\r\n", 1)[0] ?? "");
    });
    socket.on("connect", () => socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
  });
}

export interface TestRealtimeEvent {
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

export function nextJsonEvent(websocket: WebSocket): Promise<TestRealtimeEvent> {
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

export function nextJsonEvents(websocket: WebSocket, count: number): Promise<TestRealtimeEvent[]> {
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

export function decodeTestRealtimeEvent(value: unknown): TestRealtimeEvent {
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
