import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import { isDynamicRecord, isString } from "../runtime-values";
import {
  decodeTeamProtocolV1CurrentEvent,
  decodeTeamProtocolV1CurrentHttpRequest,
  decodeTeamProtocolV1CurrentHttpResponse,
  encodeTeamProtocolV1CurrentEvent,
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

export function createTeamProtocolV2Event(sequence: number, event: unknown): TeamProtocolV2EventFrame {
  const current = decodeTeamProtocolV1CurrentEvent(event);
  if (current.kind !== "known") throw new Error("The event is not supported by Team protocol v2.");
  const encoded = encodeTeamProtocolV1CurrentEvent(current.event);
  if (!encoded) throw new Error("The event is not supported by Team protocol v2.");
  return decodeTeamProtocolV2EventFrame({
    version: 2,
    type: "event",
    sequence,
    payload: wireJson(JSON.parse(encoded)),
  });
}

export function encodeTeamProtocolV2CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV2Json {
  return wireJson(decodeTeamProtocolV1CurrentHttpRequest(method, path, value === undefined ? null : value));
}

export function decodeTeamProtocolV2CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV2Json {
  return wireJson(decodeTeamProtocolV1CurrentHttpRequest(method, path, value === undefined ? null : value));
}

export function encodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
  return wireJson(decodeTeamProtocolV1CurrentHttpResponse(method, path, status, value === undefined ? null : value));
}

export function decodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV2Json {
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
