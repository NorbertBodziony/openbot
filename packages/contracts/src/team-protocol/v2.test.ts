import { describe, expect, it } from "vitest";
import stopRequestFixture from "./fixtures/v2/client-http-request.json";
import hostCompatibilityFixture from "./fixtures/v2/host-compatibility.json";
import { teamProtocolAdapter, teamProtocolAdapterForWebSocket } from "./registry";
import { decodeTeamProtocolSupportV1, decodeTeamProtocolV1HttpRequest } from "./v1";
import {
  decodeTeamProtocolV2HttpRequest,
  isTeamProtocolV2StopRoute,
  TEAM_PROTOCOL_V2,
  TEAM_PROTOCOL_V2_WEBSOCKET,
} from "./v2";
import { encodeTeamProtocolV2CurrentHttpRequest } from "./v2-adapter";

describe("Team protocol v2", () => {
  it("adds force-stop without changing the frozen v1 route registry", () => {
    const path = "/v1/agents/chief/stop";
    expect(() => decodeTeamProtocolV1HttpRequest("POST", path, stopRequestFixture)).toThrow(
      "Invalid Team protocol v1 HTTP request",
    );
    expect(isTeamProtocolV2StopRoute("POST", path)).toBe(true);
    expect(decodeTeamProtocolV2HttpRequest("POST", path, stopRequestFixture)).toEqual({});
    expect(JSON.parse(encodeTeamProtocolV2CurrentHttpRequest("POST", path, stopRequestFixture))).toEqual({});
  });

  it("registers v2 and advertises the force-stop capability", () => {
    const support = decodeTeamProtocolSupportV1(hostCompatibilityFixture);
    expect(support.protocol).toEqual({ minimum: 1, maximum: 2 });
    expect(support.capabilities).toContain("agent-force-stop");
    expect(teamProtocolAdapter(TEAM_PROTOCOL_V2)?.capabilities).toContain("agent-force-stop");
    expect(teamProtocolAdapterForWebSocket(TEAM_PROTOCOL_V2_WEBSOCKET)?.version).toBe(TEAM_PROTOCOL_V2);
  });
});
