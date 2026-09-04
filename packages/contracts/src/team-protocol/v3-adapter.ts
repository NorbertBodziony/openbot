import { isDynamicRecord } from "../runtime-values";
import type { TeamProtocolV1JsonObject, TeamProtocolV1JsonValue } from "./v1";
import {
  decodeTeamProtocolV1CurrentHttpRequest,
  decodeTeamProtocolV1CurrentHttpResponse,
  encodeTeamProtocolV1CurrentHttpRequest,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "./v1-adapter";
import { decodeTeamProtocolV3HttpRequest, decodeTeamProtocolV3HttpResponse } from "./v3";

export function encodeTeamProtocolV3CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): string {
  if (scopedUsageRoute(method, path)) {
    return JSON.stringify(decodeScopedUsageRequest(value));
  }
  if (!duplicateRoute(method, path)) return encodeTeamProtocolV1CurrentHttpRequest(method, path, value, options);
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpRequest(method, path, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV1JsonObject {
  if (scopedUsageRoute(method, path)) {
    return decodeScopedUsageRequest(value);
  }
  if (!duplicateRoute(method, path)) {
    if (options.preserveSemanticTags) return decodeTeamProtocolV1CurrentHttpRequest(method, path, value);
    return JSON.parse(encodeTeamProtocolV1CurrentHttpRequest(method, path, value));
  }
  return structuredClone(decodeTeamProtocolV3HttpRequest(method, path, value));
}

export function encodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): string {
  if (scopedUsageRoute(method, path)) {
    return encodeTeamProtocolV1CurrentHttpResponse(method, "/v1/agents/usage", status, value, options);
  }
  if (!duplicateRoute(method, path)) {
    return encodeTeamProtocolV1CurrentHttpResponse(method, path, status, value, options);
  }
  const wireValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpResponse(method, path, status, wireValue));
}

export function decodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (scopedUsageRoute(method, path)) {
    return decodeTeamProtocolV1CurrentHttpResponse(method, "/v1/agents/usage", status, value);
  }
  if (!duplicateRoute(method, path)) return decodeTeamProtocolV1CurrentHttpResponse(method, path, status, value);
  return structuredClone(decodeTeamProtocolV3HttpResponse(method, path, status, value));
}

function scopedUsageRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return method === "GET" && /^\/v1\/agents\/[^/]+\/usage$/u.test(pathname);
}

function decodeScopedUsageRequest(value: unknown): TeamProtocolV1JsonObject {
  if (!isDynamicRecord(value) || Object.keys(value).length > 0) {
    throw new Error("Invalid model-scoped usage request.");
  }
  return {};
}

function duplicateRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return method === "POST" && /^\/v1\/agents\/[^/]+\/duplicate$/u.test(pathname);
}
