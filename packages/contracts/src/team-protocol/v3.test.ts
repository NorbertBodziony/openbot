import { describe, expect, it } from "vitest";
import { TEAM_AGENT_ACTIVITY_CAPABILITY, TEAM_CURRENT_CAPABILITIES } from "./current";
import requestFixture from "./fixtures/v3/client-http-request.json";
import responseFixture from "./fixtures/v3/host-http-response.json";
import {
  decodeTeamProtocolV1HttpRequest,
  highestCommonTeamProtocol,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  teamProtocolUpdateDirection,
} from "./v1";
import { TEAM_PROTOCOL_V3_CAPABILITIES } from "./v3";
import {
  decodeTeamProtocolV3CurrentHttpRequest,
  decodeTeamProtocolV3CurrentHttpResponse,
  encodeTeamProtocolV3CurrentHttpRequest,
  encodeTeamProtocolV3CurrentHttpResponse,
} from "./v3-adapter";
import { decodeTeamProtocolV3WebRtcHttpResponse, encodeTeamProtocolV3WebRtcHttpRequest } from "./v3-webrtc-adapter";

const duplicatePath = "/v1/agents/bot-source/duplicate";

describe("Team protocol v3", () => {
  it("keeps the duplicate request and response fixtures valid in both adapter directions", () => {
    expect(decodeTeamProtocolV3CurrentHttpRequest("POST", duplicatePath, requestFixture)).toEqual(requestFixture);
    expect(JSON.parse(encodeTeamProtocolV3CurrentHttpRequest("POST", duplicatePath, requestFixture))).toEqual(
      requestFixture,
    );
    expect(decodeTeamProtocolV3CurrentHttpResponse("POST", duplicatePath, 201, responseFixture)).toEqual(
      responseFixture,
    );
    expect(JSON.parse(encodeTeamProtocolV3CurrentHttpResponse("POST", duplicatePath, 201, responseFixture))).toEqual(
      responseFixture,
    );
  });

  it("requires a valid idempotency key for duplicate requests", () => {
    expect(() => decodeTeamProtocolV3CurrentHttpRequest("POST", duplicatePath, {})).toThrow(
      "Invalid Team protocol v3 duplicate-agent request.",
    );
    expect(() => decodeTeamProtocolV3CurrentHttpRequest("POST", duplicatePath, { operationId: "not-a-uuid" })).toThrow(
      "Invalid Team protocol v3 duplicate-agent request.",
    );
  });

  it("keeps old protocols frozen without the duplication route or capability", () => {
    expect(() => decodeTeamProtocolV1HttpRequest("POST", duplicatePath, requestFixture)).toThrow(
      "Invalid Team protocol v1 HTTP request",
    );
    expect(TEAM_PROTOCOL_V1_CAPABILITIES).not.toContain("agent-duplication");
    expect(TEAM_PROTOCOL_V1_CAPABILITIES).toContain("hosted-site-event-markers");
    expect(TEAM_PROTOCOL_V3_CAPABILITIES).toContain("agent-duplication");
    expect(TEAM_PROTOCOL_V3_CAPABILITIES).toContain("hosted-site-event-markers");
    expect(TEAM_PROTOCOL_V1_CAPABILITIES).not.toContain(TEAM_AGENT_ACTIVITY_CAPABILITY);
    expect(TEAM_PROTOCOL_V3_CAPABILITIES).not.toContain(TEAM_AGENT_ACTIVITY_CAPABILITY);
    expect(TEAM_CURRENT_CAPABILITIES).toContain(TEAM_AGENT_ACTIVITY_CAPABILITY);
  });

  it("registers the v3 route on the WebRTC adapter", () => {
    expect(encodeTeamProtocolV3WebRtcHttpRequest("POST", duplicatePath, requestFixture)).toEqual(requestFixture);
    expect(decodeTeamProtocolV3WebRtcHttpResponse("POST", duplicatePath, 201, responseFixture)).toEqual(
      responseFixture,
    );
  });

  it("reports both update directions when no common protocol exists", () => {
    expect(highestCommonTeamProtocol({ minimum: 1, maximum: 2 }, { minimum: 3, maximum: 3 })).toBeNull();
    expect(teamProtocolUpdateDirection({ minimum: 1, maximum: 2 }, { minimum: 3, maximum: 3 })).toBe(
      "client_update_required",
    );
    expect(teamProtocolUpdateDirection({ minimum: 3, maximum: 3 }, { minimum: 1, maximum: 2 })).toBe(
      "host_update_required",
    );
  });
});
