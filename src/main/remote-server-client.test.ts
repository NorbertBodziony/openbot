// @vitest-environment node

// One Team API call: which protocol the two ends agree on, which headers carry that agreement, how a
// host's refusal is classified, and what an ambiguous failure costs on retry. The consequences here
// belong to `remote-server-client.ts` and to `remote-server-connection-status.ts`, which decides what
// a failure means for the user, and they break independently of the live event channel.
//
// Assertions read `stubTeamFetch(...).requests(path)` after the call. An `expect` inside a route body
// reports the mock's source location and, worse, cannot fail at all when the route is never reached.

import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import { TEAM_CAPABILITIES_HEADER } from "@openbot/contracts/team-protocol/v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteServerClient } from "./remote-server-client";
import { RemoteServerConnections } from "./remote-server-connections";
import {
  createRemoteManager,
  stopRemoteFixtures,
  storedHttpsServer,
  stubTeamFetch,
} from "./remote-server-test-harness";
import { TeamWebRtcRequestError } from "./team-webrtc-client-transport";

afterEach(async () => {
  await stopRemoteFixtures();
  vi.unstubAllGlobals();
});

describe("Team API compatibility negotiation", () => {
  it("limits app-version-less connections to v1 capabilities", async () => {
    stubTeamFetch({});
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("assumed")] });

    await fixture.manager.retryConnection("assumed");

    const compatibility = fixture.server()?.compatibility;
    expect(compatibility).toMatchObject({ negotiatedProtocol: 1 });
    expect(compatibility?.capabilities).not.toContain("installed-skills");
  });

  it("fails closed when a binary route returns malformed protocol metadata", async () => {
    stubTeamFetch({
      compatibility: { appVersion: "0.3.0" },
      fallback: () =>
        Response.json(
          {
            error: "Update required.",
            code: "client_update_required",
            host: { appVersion: "0.3.0", protocol: { minimum: 2, maximum: 1 }, capabilities: [] },
          },
          { status: 426 },
        ),
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("binary-protocol")], appVersion: "0.4.0" });

    await expect(fixture.manager.downloadSharedFile("~/OpenBot/Shared/report.csv", "binary-protocol")).rejects.toThrow(
      "could not safely use",
    );
    expect(fixture.server()).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });

  it("treats a non-JSON binary-route failure as a request error", async () => {
    stubTeamFetch({
      compatibility: { appVersion: "0.3.0" },
      fallback: () => new Response("Bad gateway", { status: 502, headers: { "Content-Type": "text/plain" } }),
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("binary-request")], appVersion: "0.4.0" });

    await expect(fixture.manager.downloadSharedFile("~/OpenBot/Shared/report.csv", "binary-request")).rejects.toThrow(
      "Remote server request failed (502).",
    );
    // A gateway that is merely down is not a host the client has to stop talking to.
    expect(fixture.server()).toMatchObject({ state: "offline", issue: null });
  });

  it("leaves connecting state after an unexpected retry failure", async () => {
    stubTeamFetch({
      fallback: () => {
        throw new Error("Unexpected compatibility failure");
      },
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("retry-error")], appVersion: "0.4.0" });

    await expect(fixture.manager.retryConnection("retry-error")).rejects.toThrow("Unexpected compatibility failure");
    expect(fixture.server()?.state).toBe("error");
  });

  it("keeps the compatibility retry path after a timeout", async () => {
    let attempts = 0;
    stubTeamFetch({
      fallback: () => {
        attempts += 1;
        if (attempts === 1) {
          return Response.json({ appVersion: "0.5.0", protocol: { minimum: 4, maximum: 4 }, capabilities: [] });
        }
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("retry-timeout")], appVersion: "0.4.0" });

    await expect(fixture.manager.retryConnection("retry-timeout")).rejects.toThrow();
    await expect(fixture.manager.retryConnection("retry-timeout")).rejects.toThrow("timed out");
    // The timeout replaces neither the verdict nor its retryability: the host is still the one that
    // is too new, and asking again is still worth offering.
    expect(fixture.server()).toMatchObject({
      state: "incompatible",
      issue: { code: "client_update_required", retryable: true },
    });
  });

  it("blocks a host range with no shared protocol", async () => {
    const protocol = { minimum: 4, maximum: 4 };
    const stub = stubTeamFetch({ compatibility: { appVersion: "0.5.0", protocol } });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("range")], appVersion: "0.4.0" });

    await expect(fixture.manager.retryConnection("range")).rejects.toThrow();
    expect(fixture.server()).toMatchObject({
      state: "incompatible",
      issue: { code: "client_update_required" },
      compatibility: { negotiatedProtocol: null, hostProtocol: protocol },
    });

    await expect(fixture.manager.request("range", "/v1/agents", (value) => value)).rejects.toThrow();
    // The blocked verdict is remembered, so the next call never reaches the network.
    expect(stub.calls).toHaveLength(1);
  });

  it("treats a missing handshake as an old host", async () => {
    stubTeamFetch({ fallback: () => new Response(null, { status: 404 }) });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("missing")], appVersion: "0.4.0" });

    await expect(fixture.manager.retryConnection("missing")).rejects.toThrow();
    expect(fixture.server()).toMatchObject({ state: "incompatible", issue: { code: "host_update_required" } });
  });

  it("uses the shared protocol and sends both version headers", async () => {
    const stub = stubTeamFetch({
      compatibility: { appVersion: "0.3.0", protocol: { minimum: 1, maximum: 2 } },
      routes: {
        "/v1/agents/chief/messages": () => Response.json({ messageId: "message-1", deliveries: [] }),
      },
      fallback: () =>
        Response.json({
          phase: "ready",
          cliVersion: "1.0.0",
          auth: { kind: "unknown" },
          capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
          message: null,
          fullAccess: true,
        }),
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("headers")], appVersion: "0.4.0" });

    await expect(fixture.manager.request("headers", "/v1/agents/status", (value) => value)).resolves.toMatchObject({
      phase: "ready",
    });
    await expect(
      fixture.manager.request("headers", "/v1/agents/chief/messages", (value) => value, {
        method: "POST",
        body: {
          text: "Ask @[Research](agent:research) to use @[Sources](skill:sources).",
          attachmentDraftIds: [],
          replyToMessageId: null,
        },
      }),
    ).resolves.toMatchObject({ messageId: "message-1" });

    const status = stub.requests("/v1/agents/status");
    expect(status).toHaveLength(1);
    expect(status[0]?.headers.get("OpenBot-Protocol-Version")).toBe("2");
    expect(status[0]?.headers.get("OpenBot-App-Version")).toBe("0.4.0");
    expect(status[0]?.headers.get(TEAM_CAPABILITIES_HEADER)).toContain("routine-event-markers");
    expect(status[0]?.headers.get(TEAM_CAPABILITIES_HEADER)).toContain("routine-run-event-markers");
    // Semantic tags are for the renderer; a v2 host is sent the plain text they stand for.
    expect(stub.requests("/v1/agents/chief/messages")[0]?.body).toMatchObject({
      text: "Ask @Research to use Sources (skill).",
    });
    expect(fixture.server()?.compatibility).toMatchObject({
      localAppVersion: "0.4.0",
      hostAppVersion: "0.3.0",
      negotiatedProtocol: 2,
    });
  });

  it("reuses the duplication operation id after an ambiguous transport failure", async () => {
    let attempts = 0;
    const stub = stubTeamFetch({
      compatibility: { appVersion: "1.0.0", protocol: { minimum: 3, maximum: 3 }, capabilities: ["agent-duplication"] },
      fallback: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("connection reset after commit");
        if (attempts === 2) return Response.json({ error: "Host response was lost." }, { status: 503 });
        return Response.json(
          {
            bot: {
              id: "bot-copy",
              provider: "codex",
              name: "Research copy",
              title: "Research lead",
              description: "",
              notifications: true,
              model: "gpt-5.6-luna",
              reasoningEffort: "medium",
              threadId: null,
              workspacePath: "/OpenBot/Bots/bot-copy",
              preview: "No messages yet",
              updatedAt: null,
              avatarSeed: "research",
              avatarHue: null,
              avatarUrl: null,
            },
            layout: {
              revision: 1,
              sections: [],
              order: ["people", "unassigned"],
              agentAssignments: {},
              agentOrder: ["bot-source", "bot-copy"],
            },
          },
          { status: 201 },
        );
      },
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("duplicate")], appVersion: "1.0.0" });

    await expect(fixture.manager.duplicateBot("bot-source", "duplicate")).rejects.toThrow("connection reset");
    await expect(fixture.manager.duplicateBot("bot-source", "duplicate")).rejects.toThrow("Host response was lost");
    await expect(fixture.manager.duplicateBot("bot-source", "duplicate")).resolves.toMatchObject({
      bot: { id: "bot-copy" },
    });

    // A failure that may have committed on the host keeps its id, so the third attempt is the same
    // operation rather than a third agent.
    const operationIds = stub.calls
      .filter((call) => call.path !== "/v1/compatibility")
      .map((call) => call.body?.operationId);
    expect(operationIds).toHaveLength(3);
    expect(new Set(operationIds).size).toBe(1);
  });

  it("does not invalidate a healthy connection after a permission denial", async () => {
    stubTeamFetch({
      compatibility: { appVersion: "0.4.0" },
      fallback: () => Response.json({ error: "Administrator access is required." }, { status: 403 }),
    });
    const fixture = await createRemoteManager({ servers: [storedHttpsServer("permission")], appVersion: "0.4.0" });

    await expect(fixture.manager.request("permission", "/v1/admin", (value) => value)).rejects.toThrow(
      "Administrator access is required.",
    );
    expect(fixture.server()).toMatchObject({ state: "offline", issue: null });
  });
});

describe("WebRTC request decoding", () => {
  // The HTTPS arm turns a route decoder that throws into a `protocol_error`, and that is what stops
  // the app talking to a host answering with nonsense. The WebRTC arm let the decoder's own error
  // through, where the classifier ignored it: the request failed and the server stayed healthy.
  it("fails a host closed when its framed response does not decode", async () => {
    const server = storedHttpsServer("host", { transport: "webrtc-v2", apiUrl: "webrtc://host" });
    const connections = new RemoteServerConnections({
      appVersion: null,
      onChanged: () => undefined,
      onReconnectSuspended: () => undefined,
    });
    const client = new RemoteServerClient({
      appVersion: null,
      servers: { require: () => server, token: () => "token" },
      connections,
      transport: {
        request: async () => ({ unexpected: true }),
        requestResponse: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(
      client.request("host", "/api/team/agents", () => {
        throw new Error("Unexpected agent payload.");
      }),
    ).rejects.toThrow("could not safely use");

    const status = connections.statusFor("host");
    expect(status.state).toBe("error");
    expect(status.issue?.code).toBe("protocol_error");
  });

  // Compatibility is the first thing a WebRTC request asks for, so a host that answers it with
  // nonsense fails before any route decoder runs. `refreshWebRtcCompatibility` has the same problem
  // and no caller to throw to -- it is driven by the transport's `connected` event -- so it has to
  // record the failure itself or the host stays healthy and reconnectable forever.
  it("fails a host closed when its compatibility answer does not decode", async () => {
    const server = storedHttpsServer("host", { transport: "webrtc-v2", apiUrl: "webrtc://host" });
    const connections = new RemoteServerConnections({
      appVersion: null,
      onChanged: () => undefined,
      onReconnectSuspended: () => undefined,
    });
    const client = new RemoteServerClient({
      appVersion: "0.4.0",
      servers: { require: () => server, token: () => "token" },
      connections,
      transport: {
        request: async () => ({ protocol: "as-new-as-you-like" }),
        requestResponse: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(client.request("host", "/api/team/agents", () => null)).rejects.toThrow(
      "invalid compatibility information",
    );
    expect(connections.statusFor("host")).toMatchObject({ state: "error", issue: { code: "protocol_error" } });

    connections.forget("host");
    await expect(client.refreshWebRtcCompatibility("host")).rejects.toThrow("invalid compatibility information");
    expect(connections.statusFor("host")).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });

  // The transport raises `protocol_error` itself for a frame the released adapter refuses, before
  // anything here decodes a body. It arrives as a `TeamWebRtcRequestError`, which the classifier does
  // not know, so every call that reaches the transport without translating it is a host that keeps
  // looking healthy -- and both of these are driven by the `connected` event, whose caller discards
  // what they throw.
  it("records a protocol failure the transport raised on a route nothing else reports", async () => {
    const server = storedHttpsServer("host", { transport: "webrtc-v2", apiUrl: "webrtc://host" });
    const connections = new RemoteServerConnections({
      appVersion: null,
      onChanged: () => undefined,
      onReconnectSuspended: () => undefined,
    });
    const client = new RemoteServerClient({
      appVersion: "0.4.0",
      servers: { require: () => server, token: () => "token" },
      connections,
      transport: {
        request: async (_hostId, path) => {
          if (path !== TEAM_API_ROUTES.compatibility) {
            throw new TeamWebRtcRequestError(502, "protocol_error", "The host returned an invalid response body.");
          }
          return { appVersion: "0.4.0", protocol: { minimum: 2, maximum: 2 }, capabilities: ["remote-desktop"] };
        },
        requestResponse: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(client.probeRemoteDesktop(server)).rejects.toThrow("invalid response body");
    expect(connections.statusFor("host")).toMatchObject({ state: "error", issue: { code: "protocol_error" } });

    // The same failure on the compatibility route, which `refreshWebRtcCompatibility` asks for before
    // it decodes anything.
    connections.forget("host");
    const unreadableHost = new RemoteServerClient({
      appVersion: "0.4.0",
      servers: { require: () => server, token: () => "token" },
      connections,
      transport: {
        request: async () => {
          throw new TeamWebRtcRequestError(502, "protocol_error", "The host returned an invalid response body.");
        },
        requestResponse: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(unreadableHost.refreshWebRtcCompatibility("host")).rejects.toThrow("invalid response body");
    expect(connections.statusFor("host")).toMatchObject({ state: "error", issue: { code: "protocol_error" } });
  });
});
