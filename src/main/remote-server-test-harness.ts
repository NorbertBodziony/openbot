// @vitest-environment node

// The fixtures the `remote-server-*` tests share: a temporary `servers.json`, a manager built over it,
// a WebSocket that behaves like one, and a `fetch` that records what it was asked for.
//
// It exists because the suite had grown eight hand-written WebSocket fakes, and five of them declared
// `readonly readyState`, so closing them left the socket reading OPEN forever. Both places that guard
// on `readyState !== WebSocket.OPEN` -- the scope send and the runtime-snapshot request in
// `remote-server-event-stream.ts` -- were therefore unreachable from the tests that looked like they
// covered them. `FakeEventSocket.close` always moves `readyState` first, so the ninth copy is not a
// coin flip. It dispatches `close` in a microtask rather than synchronously, for the same reason a
// real socket does: the stream's `error` listener calls `close()` and *then* rejects, and a
// synchronous `close` event would resolve that promise first and silently turn a failed connection
// into a clean one.
//
// `stopRemoteFixtures` is the other repair. `stop()` is async, and every test used to call it bare in
// a `finally` immediately before deleting the directory, so a pending write could land after the
// directory was gone. One `afterEach` awaits it once.
//
// Assert on `stubTeamFetch(...).requests(path)` after the fact, never with an `expect` inside a route
// body: an assertion in the mock reports the mock's source location, and cannot fail at all if the
// route is never reached.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { expect, vi } from "vitest";
import { RemoteServerManager } from "./remote-server-manager";
import type { StoredRemoteServer } from "./remote-server-stored-shape";

// A socket the event stream can drive: `readyState` tracks `close()`, and `close` is a spy so a test
// can name the code the stream chose to close with.
export class FakeEventSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: readonly string[];
  readonly protocol: string;
  readonly openedAt = Date.now();
  readonly send = vi.fn();
  readonly close = vi.fn((code?: number, reason?: string) => {
    if (this.readyState === FakeEventSocket.CLOSED) return;
    this.readyState = FakeEventSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code, reason })));
  });
  readyState = FakeEventSocket.OPEN;

  constructor(url: string | URL, protocols: readonly string[] = []) {
    super();
    this.url = String(url);
    this.protocols = protocols;
    this.protocol = protocols[0] ?? "";
  }

  // Everything the client sends is JSON on this channel, so tests read intent, not strings.
  get sent(): unknown[] {
    return this.send.mock.calls.map(([message]) => JSON.parse(String(message)));
  }

  emit(event: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

export interface StubEventSocketsOptions {
  // Runs in a microtask after construction, standing in for whatever the host does next. The default
  // opens the socket; pass `() => {}` for a host that never answers.
  readonly connect?: (socket: FakeEventSocket) => void;
  // The subprotocol the host selected. Defaults to the first one the client offered, as a real
  // server negotiating from that list would.
  readonly protocol?: string;
}

export interface EventSocketStub {
  readonly sockets: readonly FakeEventSocket[];
  last(): FakeEventSocket | undefined;
}

export function stubEventSockets(options: StubEventSocketsOptions = {}): EventSocketStub {
  const sockets: FakeEventSocket[] = [];
  const connect = options.connect ?? ((socket: FakeEventSocket) => socket.dispatchEvent(new Event("open")));
  class StubbedEventSocket extends FakeEventSocket {
    constructor(url: string | URL, protocols: readonly string[] = []) {
      super(url, options.protocol === undefined ? protocols : [options.protocol, ...protocols]);
      sockets.push(this);
      queueMicrotask(() => connect(this));
    }
  }
  vi.stubGlobal("WebSocket", StubbedEventSocket);
  return { sockets, last: () => sockets.at(-1) };
}

export function storedHttpsServer(id: string, overrides: Partial<StoredRemoteServer> = {}): StoredRemoteServer {
  return {
    id,
    name: id,
    apiUrl: `https://${id}.trycloudflare.com/`,
    fingerprint: "fingerprint",
    username: "person@example.com",
    encryptedToken: Buffer.from(`token-${id}`).toString("base64"),
    remoteDesktopAvailable: false,
    role: "member",
    ...overrides,
  };
}

export interface RemoteManagerOptions {
  readonly servers?: readonly StoredRemoteServer[];
  readonly activeServerId?: string;
  readonly appVersion?: string;
  // `servers.json` as an older build wrote it. Version 2 is the default because that is what the
  // suite has always written; which stored versions are readable at all is
  // `remote-server-stored-shape.test.ts`'s question, not every fixture's.
  readonly storedVersion?: 1 | 2 | 3;
  readonly account?: Partial<ConstructorParameters<typeof RemoteServerManager>[2]>;
  readonly managerOptions?: ConstructorParameters<typeof RemoteServerManager>[3];
}

export interface RemoteManagerFixture {
  readonly manager: RemoteServerManager;
  readonly statePath: string;
  readonly directory: string;
  // Defaults to the first configured server, which is the only one most tests have.
  server(serverId?: string): ServerSummary | undefined;
}

const openFixtures: RemoteManagerFixture[] = [];

export async function createRemoteManager(options: RemoteManagerOptions = {}): Promise<RemoteManagerFixture> {
  const servers = options.servers ?? [storedHttpsServer("server-1")];
  const directory = await mkdtemp(join(tmpdir(), "openbot-remote-servers-"));
  const statePath = join(directory, "servers.json");
  await writeFile(
    statePath,
    JSON.stringify({
      version: options.storedVersion ?? 2,
      activeServerId: options.activeServerId ?? servers[0]?.id ?? "local",
      servers,
    }),
  );
  const manager = new RemoteServerManager(
    statePath,
    { encrypt: (value) => Buffer.from(value), decrypt: (value) => value.toString() },
    { createTeamAuthTicket: async () => "ticket", getEmail: () => "person@example.com", ...options.account },
    { appVersion: options.appVersion, ...options.managerOptions },
  );
  const fixture: RemoteManagerFixture = {
    manager,
    statePath,
    directory,
    server: (serverId = servers[0]?.id ?? "") => manager.list().find((server) => server.id === serverId),
  };
  openFixtures.push(fixture);
  await manager.initialize();
  return fixture;
}

// One `afterEach(stopRemoteFixtures)` per file. Awaits `stop()` before the directory disappears.
export async function stopRemoteFixtures(): Promise<void> {
  const fixtures = openFixtures.splice(0, openFixtures.length);
  for (const fixture of fixtures) {
    await fixture.manager.stop().catch(() => undefined);
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

// The keys come from `ServerSummary` so a renamed field fails to compile, but the values stay open
// because `toMatchObject` takes a nested subset or an asymmetric matcher in any of these positions.
export type ExpectedServerSummary = { readonly [K in keyof ServerSummary]?: unknown };

// Waits for a summary the renderer would accept, and fails with the diff against the whole summary
// rather than with "expected undefined".
export async function waitForServer(
  fixture: RemoteManagerFixture,
  expected: ExpectedServerSummary,
  serverId?: string,
): Promise<ServerSummary> {
  return await vi.waitFor(() => {
    const server = fixture.server(serverId);
    expect(server).toMatchObject(expected);
    if (!server) throw new Error("The server is missing.");
    return server;
  });
}

export interface TeamFetchCall {
  readonly url: URL;
  readonly path: string;
  readonly headers: Headers;
  readonly init: RequestInit | undefined;
  readonly body: DynamicRecord | undefined;
}

export type TeamFetchHandler = (call: TeamFetchCall) => Response | Promise<Response>;

export interface HostHandshake {
  readonly appVersion?: string;
  readonly protocol?: { minimum: number; maximum: number };
  readonly capabilities?: readonly string[];
}

export interface StubTeamFetchOptions {
  // The `/v1/compatibility` answer, which nearly every route needs before it is reached.
  readonly compatibility?: HostHandshake;
  readonly routes?: Readonly<Record<string, TeamFetchHandler>>;
  readonly fallback?: TeamFetchHandler;
}

export interface TeamFetchStub {
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly calls: readonly TeamFetchCall[];
  requests(path: string): TeamFetchCall[];
}

// Every Team API route this suite drives sends a JSON object; anything else is recorded as undefined
// rather than failing the request that was being observed.
function readJsonBody(body: BodyInit | null | undefined): DynamicRecord | undefined {
  if (body === undefined || body === null) return undefined;
  try {
    const parsed = JSON.parse(String(body));
    return isDynamicRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function stubTeamFetch(options: StubTeamFetchOptions = {}): TeamFetchStub {
  const calls: TeamFetchCall[] = [];
  const handshake = options.compatibility;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^\/+/, "/");
    const call: TeamFetchCall = {
      url,
      path,
      headers: new Headers(init?.headers),
      init,
      body: readJsonBody(init?.body),
    };
    calls.push(call);
    if (handshake && path === "/v1/compatibility") {
      return Response.json({
        appVersion: handshake.appVersion ?? "0.4.0",
        protocol: handshake.protocol ?? { minimum: 1, maximum: 1 },
        capabilities: handshake.capabilities ?? [],
      });
    }
    const route = options.routes?.[path];
    if (route) return await route(call);
    if (options.fallback) return await options.fallback(call);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetch: fetchMock, calls, requests: (path) => calls.filter((call) => call.path === path) };
}

export interface DeferredRoute {
  readonly handler: TeamFetchHandler;
  // Resolves once the route has actually been called, so a test waits on the request instead of on
  // the clock.
  readonly arrived: Promise<TeamFetchCall>;
  resolve(response: Response): void;
  reject(error: Error): void;
}

export function deferredRoute(): DeferredRoute {
  let announce: (call: TeamFetchCall) => void = () => undefined;
  const arrived = new Promise<TeamFetchCall>((resolve) => {
    announce = resolve;
  });
  let settle: { resolve: (response: Response) => void; reject: (error: Error) => void } | undefined;
  const pending = new Promise<Response>((resolve, reject) => {
    settle = { resolve, reject };
  });
  return {
    handler: (call) => {
      announce(call);
      return pending;
    },
    arrived,
    resolve: (response) => settle?.resolve(response),
    reject: (error) => settle?.reject(error),
  };
}
