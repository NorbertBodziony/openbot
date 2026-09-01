import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "./v1";
import { decodeTeamProtocolV3HttpRequest, decodeTeamProtocolV3HttpResponse } from "./v3";

export function encodeTeamProtocolV3CurrentHttpRequest(method: string, path: string, value: unknown): string {
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpRequest(method, path, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  return structuredClone(decodeTeamProtocolV3HttpRequest(method, path, value));
}

export function encodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): string {
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpResponse(method, path, status, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  return structuredClone(decodeTeamProtocolV3HttpResponse(method, path, status, value));
}
