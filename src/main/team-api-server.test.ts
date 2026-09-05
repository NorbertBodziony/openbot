// @vitest-environment node

// What is true of the router as a whole, rather than of one domain: that it comes down when it is
// told to, what it publishes about the protocol it speaks, that every path the shared table builds
// is answered, and the status contract the split of `#handle` into `src/main/team-api/` had to
// preserve. The domains themselves are in the `team-api-server.<domain>.test.ts` siblings.

import { join } from "node:path";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_SEMANTIC_TAGS_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import {
  TEAM_APP_VERSION_HEADER,
  TEAM_PROTOCOL_VERSION_HEADER,
  teamProtocolV1HttpRoute,
} from "@openbot/contracts/team-protocol/v1";
import { createOpenBotLogger } from "@openbot/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarLayoutStore } from "../backend/sidebar-layout-store";
import {
  createAgents,
  createTeamApiFixture,
  rawRequest,
  stopTeamApiFixtures,
  type TeamApiOptions,
} from "./team-api-server-test-harness";

// Every file in the split declares this one line: the harness registers no hook of its own, because
// one declared there would run before the ones declared here and take its directories out from under
// a listener that had not finished stopping.
afterEach(stopTeamApiFixtures);

describe("TeamApiServer teardown", () => {
  it("closes its listener when the remote screen cannot be stopped", async () => {
    const { start, stop } = await createTeamApiFixture("teardown");
    const unreachable = () => {
      throw new Error("The remote screen is only asked to stop here.");
    };
    const { port } = await start({
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

    await expect(stop()).rejects.toThrow("would not come down");

    // Its heartbeat and event listeners are already gone, so a listener still answering here
    // is one that no longer notices a revoked session - and the next start would hand it back.
    await expect(fetch(`http://127.0.0.1:${port}/v1/compatibility`)).rejects.toThrow();
  });
});

describe("TeamApiServer compatibility", () => {
  it("publishes protocol support and blocks requests without a compatible handshake", async () => {
    const { start } = await createTeamApiFixture("compatibility");
    const { base } = await start({
      appVersion: "0.4.0",
    });

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
  });

  it("serves installed skill summaries", async () => {
    const { start, signIn } = await createTeamApiFixture("skills", { configure: true });
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
    const { base } = await start({
      skills: { listInstalledForChatTags },
    });

    const token = await signIn();
    const response = await fetch(`${base}/v1/agents/chief/skills`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ skillId: "skill-1", name: "Release Notes", state: "update-available" }),
    ]);
    expect(listInstalledForChatTags).toHaveBeenCalledWith("chief");
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
    const { root, start, signIn } = await createTeamApiFixture("routes", { configure: true });
    const sidebarLayout = new SidebarLayoutStore(join(root, "sidebar-layout.json"));
    await sidebarLayout.initialize();
    const { base } = await start({
      agents: createAgents({ listBots: () => [] }),
      sidebarLayout,
      logger: createOpenBotLogger("test", () => undefined),
    });
    // The point is which paths route, not what the stubs do once reached, so the failures they raise
    // are expected here and their logging would bury the assertion.

    const token = await signIn();
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
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = response.status === 404 ? await response.json() : null;
      if (isDynamicRecord(body) && body.error === "Route not found.") {
        unrouted.push(`${method} ${route.path} (${route.name})`);
      }
    }

    expect(unrouted).toEqual([]);
  });
});

// The status contract this router answers with, pinned before its 760-line `#handle` was split into
// per-domain modules. The route round-trip case above looks like the safety net for that move and is
// not one: it holds a single method per route name and fails only on the literal body
// `"Route not found."`, so a 200 that becomes a 401, a 400 that becomes a 404, or a wrong-method
// branch that starts answering 405 all stay green there. Those are exactly the properties a
// dispatcher rewrite puts at risk, and this table is where they are written down.
//
// Every row is a status and, where the router names a reason, the message the caller reads. The
// authenticated rows go through one signed-in server so a 401 here means the route, not the setup.
describe("TeamApiServer status contract", () => {
  // Status plus the message the caller reads, as one comparable line, so a failing row names the
  // request that regressed instead of reporting a bare number.
  async function answer(base: string, method: string, path: string, token?: string): Promise<string> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await response.json();
    const error = isDynamicRecord(body) && isString(body.error) ? body.error : "";
    return `${method} ${path} ${response.status} ${error}`;
  }

  async function statusFixture(slug: string, options: Partial<TeamApiOptions> = {}) {
    const fixture = await createTeamApiFixture(slug, { configure: true });
    // The stubs are here so that a route can be reached at all and then raise, and the silenced
    // logger keeps what they raise from burying the row that failed.
    const { base } = await fixture.start({
      agents: createAgents({ listBots: () => [] }),
      logger: createOpenBotLogger("test", () => undefined),
      ...options,
    });
    return { base, signIn: fixture.signIn };
  }

  // A path the router matches with a regex, reached with a method that branch does not name, falls
  // out of the chain and lands on the one 404. There is no 405 anywhere in this server, and adding
  // one would change the meaning of a released wire protocol.
  it("answers 404 for a matched path reached with an unhandled method", async () => {
    const { base, signIn } = await statusFixture("wrong-method");
    const token = await signIn();
    const cases = [
      ["PUT", TEAM_API_ROUTES.attachment("a")],
      ["POST", TEAM_API_ROUTES.direct.conversation("m")],
      ["PUT", TEAM_API_ROUTES.team.member("m")],
      ["GET", TEAM_API_ROUTES.team.invite("i")],
      ["GET", TEAM_API_ROUTES.team.session("s")],
      ["PUT", TEAM_API_ROUTES.agent.memories("a")],
      ["DELETE", TEAM_API_ROUTES.agent.routines("a")],
      ["POST", TEAM_API_ROUTES.agent.avatar("a")],
    ] as const;
    const answers: string[] = [];
    for (const [method, path] of cases) answers.push(await answer(base, method, path, token));
    expect(answers).toEqual(cases.map(([method, path]) => `${method} ${path} 404 Route not found.`));
  });

  // The per-agent block decodes its identifiers above the switch that dispatches on the action, so a
  // malformed id is a 400 even when no action would have matched. Moving either decode below its
  // switch turns that into the 404 the row above expects, which is why the two are asserted apart.
  it("answers 400 for a malformed path identifier before any action matches", async () => {
    const { base, signIn } = await statusFixture("bad-identifier");
    const token = await signIn();
    const cases = [
      ["GET", "/v1/agents/%ZZ/bogus", "botId is invalid."],
      ["PUT", "/v1/agents/a/memories/%ZZ", "memoryId is invalid."],
      ["PATCH", "/v1/agents/a/routines/%ZZ", "routineId is invalid."],
    ] as const;
    const answers: string[] = [];
    for (const [method, path] of cases) answers.push(await answer(base, method, path, token));
    expect(answers).toEqual(cases.map(([method, path, message]) => `${method} ${path} 400 ${message}`));
  });

  // The bearer check does not consult the path, so an unknown route without a token is 401 rather
  // than 404. A dispatcher that runs its route modules first and answers 404 when none match would
  // leak the existence of every path it does serve.
  it("answers 401 rather than 404 for an unknown path without a token", async () => {
    const { base } = await statusFixture("unauthenticated");
    const response = await fetch(`${base}/v1/nope`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required." });
  });

  // Three gates in a fixed order: `compatibility` answers before the protocol gate, and the protocol
  // gate answers before the bearer check. A client too old to send the protocol headers has to be
  // able to read the endpoint that tells it to update, so `compatibility` below the gate would be an
  // unbreakable 426 loop.
  it("answers compatibility ahead of the protocol gate, and the protocol gate ahead of the bearer check", async () => {
    const { base } = await statusFixture("gate-order", { appVersion: "0.4.0" });
    const compatibility = await fetch(`${base}${TEAM_API_ROUTES.compatibility}`);
    expect(compatibility.status).toBe(200);

    const gated = await fetch(`${base}${TEAM_API_ROUTES.me}`);
    expect(gated.status).toBe(426);
    expect(await gated.json()).toMatchObject({ code: "client_update_required" });
  });

  // Node's HTTP parser accepts request targets the WHATWG URL parser rejects, so the prologue records
  // the response's route before it parses the URL. Recording it after left the throw with no entry to
  // read, and because `#handle` is invoked as a discarded promise that surfaced as an unhandled
  // rejection over a socket that was never ended - a hung request rather than an answer.
  it("answers a request target the URL parser rejects instead of hanging", async () => {
    const { base } = await statusFixture("unparsable-target");
    const response = await fetch(`${base}/`, { headers: { Authorization: "Bearer x" } });
    expect(response.status).toBe(401);
    const raw = await rawRequest(base, "GET //[ HTTP/1.1");
    expect(raw).toMatch(/^HTTP\/1\.1 \d{3} /);

    // Recording the raw target instead only moved the throw. Every adapter above v1 classifies the
    // route by parsing that string again, and it does so while encoding the answer the catch is
    // already writing - so on protocol 3 the same invalid target threw out of `#json`, past the only
    // catch there is, and hung the socket exactly as before. The record starts at a path that
    // parses, and the raw target is never handed to an adapter.
    const negotiated = await rawRequest(base, "GET //[ HTTP/1.1", [`${TEAM_PROTOCOL_VERSION_HEADER}: 3`]);
    expect(negotiated).toMatch(/^HTTP\/1\.1 \d{3} /);
  });
});

// Writes a request line `fetch` would refuse to send, so a target Node accepts and the WHATWG URL
