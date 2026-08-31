import { isDynamicRecord } from "../runtime-values";
import {
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  type TeamProtocolV1JsonObject,
  type TeamProtocolV1JsonValue,
} from "./v1";

export const TEAM_PROTOCOL_V2 = 2;
export const TEAM_PROTOCOL_V2_WEBSOCKET = "openbot-team-v2";
export const TEAM_PROTOCOL_V2_CAPABILITIES = [
  "agent-runtime-snapshots",
  "browser-control",
  "conversation-pagination",
  "direct-messages",
  "remote-desktop",
  "routine-event-markers",
  "sidebar-layout",
  "agent-force-stop",
] as const;

export type TeamProtocolCapability = (typeof TEAM_PROTOCOL_V2_CAPABILITIES)[number];
const TEAM_PROTOCOL_CAPABILITY_SET: ReadonlySet<string> = new Set(TEAM_PROTOCOL_V2_CAPABILITIES);

export function isTeamProtocolCapability(value: string): value is TeamProtocolCapability {
  return TEAM_PROTOCOL_CAPABILITY_SET.has(value);
}

export function isTeamProtocolV2StopRoute(method: string, path: string): boolean {
  return method === "POST" && /^\/v1\/agents\/[^/]+\/stop$/u.test(path);
}

export function decodeTeamProtocolV2HttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  if (isTeamProtocolV2StopRoute(method, path)) {
    if (!isDynamicRecord(value) || Object.keys(value).length > 0) {
      throw new Error("Invalid Team protocol v2 HTTP request.");
    }
    return {};
  }
  return decodeTeamProtocolV1HttpRequest(method, path, value);
}

export function decodeTeamProtocolV2HttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (isTeamProtocolV2StopRoute(method, path) && status === 204 && value === undefined) return null;
  return decodeTeamProtocolV1HttpResponse(method, path, status, value);
}
