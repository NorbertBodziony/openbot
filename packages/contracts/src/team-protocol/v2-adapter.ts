import type { AgentEvent } from "../ipc-agent-events";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  decodeTeamProtocolV1CurrentEvent,
  decodeTeamProtocolV1CurrentHttpRequest,
  decodeTeamProtocolV1CurrentHttpResponse,
  encodeTeamProtocolV1CurrentEvent,
  encodeTeamProtocolV1CurrentHttpRequest,
  encodeTeamProtocolV1CurrentHttpResponse,
} from "./v1-adapter";
import {
  decodeTeamProtocolV2EventFrame,
  decodeTeamProtocolV2Json,
  decodeTeamProtocolV2RpcFrame,
  type TeamProtocolV2EventFrame,
  type TeamProtocolV2Json,
  type TeamProtocolV2RpcFrame,
} from "./v2";

export function createTeamProtocolV2Request(
  requestId: string,
  operation: string,
  payload: unknown,
): TeamProtocolV2RpcFrame {
  return decodeTeamProtocolV2RpcFrame({
    version: 2,
    type: "request",
    requestId,
    operation,
    payload: wireJson(payload),
  });
}

export function createTeamProtocolV2Response(requestId: string, result: unknown): TeamProtocolV2RpcFrame {
  return decodeTeamProtocolV2RpcFrame({ version: 2, type: "response", requestId, result: wireJson(result) });
}

export function createTeamProtocolV2Event(
  sequence: number,
  event: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2EventFrame {
  const current = decodeTeamProtocolV1CurrentEvent(event);
  if (current.kind !== "known") throw new Error("The event is not supported by Team protocol v2.");
  const encoded = encodeTeamProtocolV1CurrentEvent(current.event, options);
  if (!encoded) throw new Error("The event is not supported by Team protocol v2.");
  return decodeTeamProtocolV2EventFrame({
    version: 2,
    type: "event",
    sequence,
    payload: wireJson(JSON.parse(encoded)),
  });
}

/**
 * Outbound. The result goes on the wire, so it ends in the frozen vocabulary -- `botId`, not `agentId`.
 * This is the half that used to share an implementation with {@link decodeTeamProtocolV2CurrentHttpRequest};
 * once the two vocabularies stopped being the same words, one function could no longer serve both
 * directions, because whichever end it was written for silently broke the other.
 */
export function encodeTeamProtocolV2CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  const normalized = normalizeV2HttpRequest(method, path, value);
  if (normalized.done) return normalized.value;
  return wireJson(JSON.parse(encodeTeamProtocolV1CurrentHttpRequest(method, path, normalized.value, options)));
}

/** Inbound. The result reaches a handler, so it ends in the current vocabulary the handler reads. */
export function decodeTeamProtocolV2CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  const normalized = normalizeV2HttpRequest(method, path, value);
  if (normalized.done) return normalized.value;
  if (options.preserveSemanticTags) {
    return wireJson(decodeTeamProtocolV1CurrentHttpRequest(method, path, normalized.value));
  }
  // The encode call is only here to expand semantic tags, and it leaves the object in wire vocabulary.
  // Decoding its output is what brings the keys back to the current spelling the handlers read.
  const expanded = JSON.parse(encodeTeamProtocolV1CurrentHttpRequest(method, path, normalized.value));
  return wireJson(decodeTeamProtocolV1CurrentHttpRequest(method, path, expanded));
}

/** The route handling both directions share: the two bodies that never reach the v1 codec at all. */
function normalizeV2HttpRequest(
  method: string,
  path: string,
  value: unknown,
): { done: true; value: TeamProtocolV2Json } | { done: false; value: TeamProtocolV2Json } {
  const normalized = value === undefined ? null : wireJson(value);
  if (isRemoteViewerRoute(path)) return { done: true, value: isEmptyRequest(normalized) ? {} : normalized };
  if (isEmptyRequest(normalized) && isTeamProtocolV2NoBodyRoute(method, path)) return { done: true, value: {} };
  return { done: false, value: normalized };
}

function isEmptyRequest(value: unknown): boolean {
  return value === null || (isDynamicRecord(value) && Object.keys(value).length === 0);
}

function isTeamProtocolV2NoBodyRoute(method: string, path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  if (method === "GET") {
    if (
      new Set([
        "/v1/compatibility",
        "/v1/identity",
        "/v1/me",
        "/v1/team/presence",
        "/v1/remote-screen/capabilities",
        "/v1/direct/threads",
        "/v1/messages/search",
        "/v1/browser/tabs",
        "/v1/browser/control",
        "/v1/team/members",
        "/v1/team/invites",
        "/v1/team/sessions",
        "/v1/agents/status",
        "/v1/sidebar-layout",
        "/v1/agents/usage",
        "/v1/agents/models",
        "/v1/agents",
        "/v1/agents/conversation-reads",
      ]).has(pathname)
    ) {
      return true;
    }
    if (
      /^\/v1\/attachments\/[^/]+$/u.test(pathname) ||
      pathname === "/v1/shared-files" ||
      pathname === "/v1/workspace-files" ||
      isRemoteViewerRoute(pathname)
    ) {
      return true;
    }
    if (/^\/v1\/direct\/conversations\/[^/]+(?:\/page)?$/u.test(pathname)) return true;
    return /^\/v1\/agents\/[^/]+\/(?:skills|memories|routines|routines\/[^/]+\/runs|conversation|conversation-page|queue)$/u.test(
      pathname,
    );
  }
  if (method === "POST" && /^\/v1\/agents\/[^/]+\/routines\/[^/]+\/test$/u.test(pathname)) return true;
  if (method !== "DELETE") return false;
  return (
    /^\/v1\/attachments\/[^/]+$/u.test(pathname) ||
    /^\/v1\/remote-screen\/sessions\/[A-Za-z0-9-]+$/u.test(pathname) ||
    /^\/v1\/agents\/[^/]+$/u.test(pathname) ||
    /^\/v1\/agents\/[^/]+\/avatar$/u.test(pathname) ||
    /^\/v1\/agents\/[^/]+\/memories(?:\/[^/]+)?$/u.test(pathname) ||
    /^\/v1\/agents\/[^/]+\/routines\/[^/]+$/u.test(pathname)
  );
}

function isRemoteViewerRoute(path: string): boolean {
  const pathname = new URL(path, "http://openbot.invalid").pathname;
  return /^\/v1\/remote-screen\/sessions\/[A-Za-z0-9-]+\/(?:viewer|authorize|viewer-state|moonlight(?:\/.*)?)$/u.test(
    pathname,
  );
}

export function encodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): TeamProtocolV2Json {
  if (status === 204) return {};
  if (isRemoteViewerRoute(path)) return wireJson(value === undefined ? null : value);
  return wireJson(
    JSON.parse(
      encodeTeamProtocolV1CurrentHttpResponse(method, path, status, value === undefined ? null : value, options),
    ),
  );
}

export function decodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
  if (status === 204) return {};
  if (isRemoteViewerRoute(path)) return wireJson(value === undefined ? null : value);
  return wireJson(decodeTeamProtocolV1CurrentHttpResponse(method, path, status, value === undefined ? null : value));
}

export function decodeTeamProtocolV2CurrentEvent(
  frame: TeamProtocolV2EventFrame,
): { status: "known"; event: AgentEvent | TeamRealtimeEvent } | { status: "unknown" } | { status: "invalid" } {
  const decoded = decodeTeamProtocolV2EventFrame(frame);
  if (decoded.type !== "event") return { status: "invalid" };
  const event = decodeTeamProtocolV1CurrentEvent(decoded.payload);
  if (event.kind === "known") return { status: "known", event: event.event };
  if (event.kind === "invalid" && !(isDynamicRecord(decoded.payload) && isString(decoded.payload.type))) {
    return { status: "unknown" };
  }
  return { status: event.kind };
}

function wireJson(value: unknown): TeamProtocolV2Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The Team protocol value is not serializable.");
  return decodeTeamProtocolV2Json(JSON.parse(encoded));
}
