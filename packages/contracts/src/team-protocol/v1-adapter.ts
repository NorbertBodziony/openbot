import { expandChatTagReferences } from "../chat-tag-references";
import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import { isBoolean, isNumber, isString } from "../runtime-values";
import {
  decodeTeamProtocolV1Event,
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  encodeTeamProtocolV1Event,
  type TeamProtocolV1EventDecodeResult,
  type TeamProtocolV1JsonObject,
  type TeamProtocolV1JsonValue,
} from "./v1";

export type TeamProtocolV1CurrentEventDecodeResult =
  | { kind: "known"; event: AgentEvent | TeamRealtimeEvent }
  | Exclude<TeamProtocolV1EventDecodeResult, { kind: "known" }>;

export function decodeTeamProtocolV1CurrentEvent(value: unknown): TeamProtocolV1CurrentEventDecodeResult {
  const decoded = decodeTeamProtocolV1Event(value);
  if (decoded.kind !== "known") return decoded;
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the frozen v1 codec validates the wire value before this versioned boundary clone.
  return { kind: "known", event: structuredClone(decoded.event) as AgentEvent | TeamRealtimeEvent };
}

export function encodeTeamProtocolV1CurrentEvent(event: AgentEvent | TeamRealtimeEvent): string | null {
  const wireValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(event));
  const downconvertedValue = downconvertCurrentTags(wireValue);
  const decoded = decodeTeamProtocolV1Event(downconvertedValue);
  return decoded.kind === "known" ? encodeTeamProtocolV1Event(decoded.event) : null;
}

export function encodeTeamProtocolV1CurrentHttpRequest(method: string, path: string, value: unknown): string {
  const wireValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
  const downconvertedValue = downconvertCurrentTags(wireValue);
  return JSON.stringify(decodeTeamProtocolV1HttpRequest(method, path, downconvertedValue));
}

export function decodeTeamProtocolV1CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  return structuredClone(decodeTeamProtocolV1HttpRequest(method, path, value));
}

export function encodeTeamProtocolV1CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): string {
  const wireValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
  const downconvertedValue = downconvertCurrentTags(wireValue);
  return JSON.stringify(decodeTeamProtocolV1HttpResponse(method, path, status, downconvertedValue));
}

function downconvertCurrentTags(value: TeamProtocolV1JsonValue, key = ""): TeamProtocolV1JsonValue {
  if (isString(value)) return key === "text" || key === "preview" ? expandChatTagReferences(value) : value;
  if (Array.isArray(value)) return value.map((item) => downconvertCurrentTags(item));
  if (value === null || isBoolean(value) || isNumber(value)) return value;
  const result: TeamProtocolV1JsonObject = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = downconvertCurrentTags(entryValue, entryKey);
  }
  return result;
}

export function decodeTeamProtocolV1CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  return structuredClone(decodeTeamProtocolV1HttpResponse(method, path, status, value));
}
