import type { TeamProtocolV2Json } from "./v2";
import {
  decodeTeamProtocolV2CurrentHttpRequest,
  decodeTeamProtocolV2CurrentHttpResponse,
  encodeTeamProtocolV2CurrentHttpRequest,
  encodeTeamProtocolV2CurrentHttpResponse,
} from "./v2-adapter";
import { decodeTeamProtocolV3HttpRequest, decodeTeamProtocolV3HttpResponse } from "./v3";

export function encodeTeamProtocolV3CurrentHttpRequest(method: string, path: string, value: unknown): string {
  if (!duplicateRoute(method, path)) {
    return JSON.stringify(encodeTeamProtocolV2CurrentHttpRequest(method, path, value));
  }
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpRequest(method, path, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV2Json {
  if (!duplicateRoute(method, path)) {
    return structuredClone(decodeTeamProtocolV2CurrentHttpRequest(method, path, value));
  }
  return structuredClone(decodeTeamProtocolV3HttpRequest(method, path, value));
}

export function encodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): string {
  if (!duplicateRoute(method, path)) {
    return JSON.stringify(encodeTeamProtocolV2CurrentHttpResponse(method, path, status, value));
  }
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpResponse(method, path, status, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
  if (!duplicateRoute(method, path)) {
    return structuredClone(decodeTeamProtocolV2CurrentHttpResponse(method, path, status, value));
  }
  return structuredClone(decodeTeamProtocolV3HttpResponse(method, path, status, value));
}

function duplicateRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname);
}
