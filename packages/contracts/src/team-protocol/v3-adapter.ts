import { isDynamicRecord } from "../runtime-values";
import { isConversationUnreadRoute } from "./current";
import { toCurrentAgentKeys, toCurrentAgentKeysObjectForPath, toWireAgentKeys } from "./current-agent-keys";
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
  if (isConversationUnreadRoute(method, path)) return JSON.stringify(decodeUnreadRequest(value));
  if (scopedUsageRoute(method, path)) {
    return JSON.stringify(decodeScopedUsageRequest(value));
  }
  if (!duplicateRoute(method, path)) return encodeTeamProtocolV1CurrentHttpRequest(method, path, value, options);
  // The duplicate route reaches the frozen v3 codec directly, so the vocabulary swap happens here.
  const currentValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpRequest(method, path, toWireAgentKeys(currentValue)));
}

export function decodeTeamProtocolV3CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV1JsonObject {
  if (isConversationUnreadRoute(method, path)) return decodeUnreadRequest(value);
  if (scopedUsageRoute(method, path)) {
    return decodeScopedUsageRequest(value);
  }
  if (!duplicateRoute(method, path)) {
    if (options.preserveSemanticTags) return decodeTeamProtocolV1CurrentHttpRequest(method, path, value);
    return JSON.parse(encodeTeamProtocolV1CurrentHttpRequest(method, path, value));
  }
  return toCurrentAgentKeysObjectForPath(path, structuredClone(decodeTeamProtocolV3HttpRequest(method, path, value)));
}

export function encodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): string {
  if (isConversationUnreadRoute(method, path))
    return encodeTeamProtocolV1CurrentHttpResponse(method, readPath(path), status, value, options);
  if (scopedUsageRoute(method, path)) {
    return encodeTeamProtocolV1CurrentHttpResponse(method, "/v1/agents/usage", status, value, options);
  }
  if (!duplicateRoute(method, path)) {
    return encodeTeamProtocolV1CurrentHttpResponse(method, path, status, value, options);
  }
  // The duplicate route reaches the frozen v3 codec directly, so the vocabulary swap happens here.
  const currentValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(decodeTeamProtocolV3HttpResponse(method, path, status, toWireAgentKeys(currentValue)));
}

export function decodeTeamProtocolV3CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (isConversationUnreadRoute(method, path))
    return decodeTeamProtocolV1CurrentHttpResponse(method, readPath(path), status, value);
  if (scopedUsageRoute(method, path)) {
    return decodeTeamProtocolV1CurrentHttpResponse(method, "/v1/agents/usage", status, value);
  }
  if (!duplicateRoute(method, path)) return decodeTeamProtocolV1CurrentHttpResponse(method, path, status, value);
  return toCurrentAgentKeys(structuredClone(decodeTeamProtocolV3HttpResponse(method, path, status, value)));
}

function decodeUnreadRequest(value: unknown): TeamProtocolV1JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw new Error("Invalid conversation-unread request.");
  }
  return {};
}

function readPath(path: string): string {
  return new URL(path, "http://openbot.invalid").pathname.replace(/\/unread$/u, "/read");
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
