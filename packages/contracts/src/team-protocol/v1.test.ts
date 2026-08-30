import { describe, expect, it } from "vitest";
import clientScopeFixture from "./fixtures/v1/client-scope.json";
import hostCompatibilityFixture from "./fixtures/v1/host-compatibility.json";
import hostEventFixture from "./fixtures/v1/host-event.json";
import {
  decodeTeamProtocolSupportV1,
  decodeTeamProtocolV1ClientEvent,
  decodeTeamProtocolV1Event,
  encodeTeamProtocolV1ClientEvent,
  highestCommonTeamProtocol,
  teamProtocolUpdateDirection,
} from "./v1";
import { decodeTeamProtocolV1CurrentEvent } from "./v1-adapter";

describe("Team protocol v1", () => {
  it("keeps the released host and client fixtures valid", () => {
    expect(decodeTeamProtocolSupportV1(hostCompatibilityFixture)).toEqual(hostCompatibilityFixture);
    expect(decodeTeamProtocolV1CurrentEvent(hostEventFixture)).toEqual({ kind: "known", event: hostEventFixture });
    expect(clientScopeFixture).toMatchObject({
      type: "agent-event-scope",
      includeConversations: true,
    });
    const clientScope = decodeTeamProtocolV1ClientEvent(clientScopeFixture);
    expect(JSON.parse(encodeTeamProtocolV1ClientEvent(clientScope))).toEqual(clientScopeFixture);
  });

  it("decodes bounded compatibility metadata and finds the highest common version", () => {
    const support = decodeTeamProtocolSupportV1({
      appVersion: "0.4.0",
      protocol: { minimum: 1, maximum: 3 },
      capabilities: ["browser-control", "browser-control", "remote-desktop"],
    });

    expect(support.capabilities).toEqual(["browser-control", "remote-desktop"]);
    expect(highestCommonTeamProtocol({ minimum: 1, maximum: 2 }, support.protocol)).toBe(2);
    expect(highestCommonTeamProtocol({ minimum: 4, maximum: 4 }, support.protocol)).toBeNull();
    expect(teamProtocolUpdateDirection({ minimum: 1, maximum: 1 }, { minimum: 2, maximum: 3 })).toBe(
      "client_update_required",
    );
    expect(teamProtocolUpdateDirection({ minimum: 2, maximum: 3 }, { minimum: 1, maximum: 1 })).toBe(
      "host_update_required",
    );
  });

  it("rejects malformed compatibility metadata", () => {
    expect(() =>
      decodeTeamProtocolSupportV1({
        appVersion: "0.4.0",
        protocol: { minimum: 2, maximum: 1 },
        capabilities: [],
      }),
    ).toThrow("Invalid Team API compatibility response");
    expect(() =>
      decodeTeamProtocolSupportV1({
        appVersion: "0.4.0",
        protocol: { minimum: 1, maximum: 1 },
        capabilities: ["INVALID CAPABILITY"],
      }),
    ).toThrow("Invalid Team API compatibility response");
  });

  it("distinguishes unknown events from malformed known events", () => {
    expect(decodeTeamProtocolV1Event({ type: "future-optional-event", payload: true })).toEqual({
      kind: "unknown",
      type: "future-optional-event",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "team-presence", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "team-presence",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "conversation", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "conversation",
    });
    expect(decodeTeamProtocolV1CurrentEvent({ type: "runtime-snapshot", snapshot: {} })).toEqual({
      kind: "invalid",
      type: "runtime-snapshot",
    });
    expect(decodeTeamProtocolV1Event({ payload: true })).toEqual({ kind: "invalid", type: null });
  });

  it("accepts the frozen minimal runtime snapshot", () => {
    const event = {
      type: "runtime-snapshot",
      snapshot: {
        bots: [],
        activeTurns: [],
        work: [],
        latestMessages: [],
        attentionComplete: true,
        pendingPrompts: [],
        pendingApprovals: [],
        pendingBrowserTakeovers: [],
        failedTurns: [],
      },
    };

    expect(decodeTeamProtocolV1CurrentEvent(event)).toEqual({ kind: "known", event });
  });
});
