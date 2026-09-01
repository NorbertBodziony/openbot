import { isDynamicRecord, isString } from "../runtime-values";
import { isUuidV4 } from "../validation";
import {
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  type TeamProtocolV1JsonObject,
  type TeamProtocolV1JsonValue,
} from "./v1";
import { TEAM_PROTOCOL_V2_CAPABILITIES } from "./v2";

export const TEAM_PROTOCOL_V3 = 3 as const;
export const TEAM_PROTOCOL_V3_CAPABILITIES = [...TEAM_PROTOCOL_V2_CAPABILITIES, "agent-duplication"] as const;
export type TeamProtocolV3Capability = (typeof TEAM_PROTOCOL_V3_CAPABILITIES)[number];

export function decodeTeamProtocolV3HttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  if (duplicateRoute(method, path)) {
    if (
      !isDynamicRecord(value) ||
      Object.keys(value).length !== 1 ||
      !isString(value.operationId) ||
      !isUuidV4(value.operationId)
    ) {
      throw new Error("Invalid Team protocol v3 duplicate-agent request.");
    }
    return { operationId: value.operationId };
  }
  return decodeTeamProtocolV1HttpRequest(method, path, value);
}

export function decodeTeamProtocolV3HttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (!duplicateRoute(method, path)) return decodeTeamProtocolV1HttpResponse(method, path, status, value);
  if (status !== 201) return decodeTeamProtocolV1HttpResponse("PATCH", agentPath(path), status, value);
  if (!isDynamicRecord(value) || !Object.hasOwn(value, "bot") || !Object.hasOwn(value, "layout")) {
    throw new Error("Invalid Team protocol v3 duplicate-agent response.");
  }
  const bots = decodeTeamProtocolV1HttpResponse("GET", "/v1/agents", 200, [value.bot]);
  const layout = decodeTeamProtocolV1HttpResponse("GET", "/v1/sidebar-layout", 200, value.layout);
  if (!Array.isArray(bots) || bots.length !== 1 || !isDynamicRecord(bots[0]) || !isDynamicRecord(layout)) {
    throw new Error("Invalid Team protocol v3 duplicate-agent response.");
  }
  return { bot: bots[0], layout };
}

function duplicateRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname);
}

function agentPath(path: string): string {
  return new URL(path, "http://openbot.invalid").pathname.replace(/\/duplicate$/u, "");
}
