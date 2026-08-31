import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "./v1";
import { decodeTeamProtocolV1CurrentEvent, encodeTeamProtocolV1CurrentEvent } from "./v1-adapter";
import { decodeTeamProtocolV2HttpRequest, decodeTeamProtocolV2HttpResponse } from "./v2";

export const decodeTeamProtocolV2CurrentEvent = decodeTeamProtocolV1CurrentEvent;
export const encodeTeamProtocolV2CurrentEvent = encodeTeamProtocolV1CurrentEvent;

export function encodeTeamProtocolV2CurrentHttpRequest(method: string, path: string, value: unknown): string {
  const wireValue = JSON.parse(JSON.stringify(value));
  return JSON.stringify(decodeTeamProtocolV2HttpRequest(method, path, wireValue));
}

export function decodeTeamProtocolV2CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  return structuredClone(decodeTeamProtocolV2HttpRequest(method, path, value));
}

export function encodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): string {
  const wireValue = JSON.parse(JSON.stringify(value));
  return JSON.stringify(decodeTeamProtocolV2HttpResponse(method, path, status, wireValue));
}

export function decodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  return structuredClone(decodeTeamProtocolV2HttpResponse(method, path, status, value));
}

export type TeamProtocolV2CurrentEvent = AgentEvent | TeamRealtimeEvent;
