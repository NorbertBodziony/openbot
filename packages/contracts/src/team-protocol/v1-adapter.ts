import { expandChatTagReferences } from "../chat-tag-references";
import { type AgentEvent, isAgentEvent } from "../ipc-agent-events";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import { isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";
import {
  toCurrentAgentKeys,
  toCurrentAgentKeysObjectForPath,
  toWireAgentKeys,
  toWireAgentKeysObjectForPath,
} from "./current-agent-keys";
import {
  decodeTeamProtocolV1ClientEvent,
  decodeTeamProtocolV1Event,
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  encodeTeamProtocolV1ClientEvent,
  encodeTeamProtocolV1Event,
  type TeamProtocolV1ClientEvent,
  type TeamProtocolV1EventDecodeResult,
  type TeamProtocolV1JsonObject,
  type TeamProtocolV1JsonValue,
} from "./v1";

export type TeamProtocolV1CurrentEventDecodeResult =
  | { kind: "known"; event: AgentEvent | TeamRealtimeEvent }
  | Exclude<TeamProtocolV1EventDecodeResult, { kind: "known" }>;

export function decodeTeamProtocolV1CurrentEvent(value: unknown): TeamProtocolV1CurrentEventDecodeResult {
  if (isDynamicRecord(value) && value.type === "turn-progress") {
    // `turn-progress` bypasses the frozen codec, so it needs the vocabulary swap applied by hand.
    const wireValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
    const current = toCurrentAgentKeys(wireValue);
    return isAgentEvent(current) ? { kind: "known", event: current } : { kind: "invalid", type: value.type };
  }
  const decoded = decodeTeamProtocolV1Event(value);
  if (decoded.kind !== "known") return decoded;
  const decodedValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(decoded.event));
  const current = toCurrentAgentKeys(decodedValue);
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the frozen v1 codec validates the wire value before this versioned boundary clone.
  return { kind: "known", event: current as AgentEvent | TeamRealtimeEvent };
}

export function encodeTeamProtocolV1CurrentEvent(
  event: AgentEvent | TeamRealtimeEvent,
  options: { preserveSemanticTags?: boolean } = {},
): string | null {
  // `turn-progress` bypasses the frozen codec, so it needs the vocabulary swap applied by hand.
  if (event.type === "turn-progress") return JSON.stringify(toWireAgentKeys(JSON.parse(JSON.stringify(event))));
  const currentValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(event));
  const wireValue = toWireAgentKeys(currentValue);
  const downconvertedValue = options.preserveSemanticTags ? wireValue : downconvertCurrentTags(wireValue);
  const decoded = decodeTeamProtocolV1Event(downconvertedValue);
  return decoded.kind === "known" ? encodeTeamProtocolV1Event(decoded.event) : null;
}

export function encodeTeamProtocolV1CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): string {
  const currentValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
  const wireValue = toWireAgentKeysForRequestPath(path, currentValue);
  const downconvertedValue = options.preserveSemanticTags ? wireValue : downconvertCurrentTags(wireValue);
  return JSON.stringify(decodeTeamProtocolV1HttpRequest(method, path, downconvertedValue));
}

export function decodeTeamProtocolV1CurrentHttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  return toCurrentAgentKeysObjectForPath(path, structuredClone(decodeTeamProtocolV1HttpRequest(method, path, value)));
}

export function encodeTeamProtocolV1CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
  options: { preserveSemanticTags?: boolean } = {},
): string {
  const currentValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
  // The installed-skills route bypasses the frozen codec, so it needs the vocabulary swap by hand.
  const wireValue = toWireAgentKeysForRequestPath(path, currentValue);
  if (status < 400 && isInstalledSkillsRoute(method, path)) return JSON.stringify(wireValue);
  const downconvertedValue = options.preserveSemanticTags ? wireValue : downconvertCurrentTags(wireValue);
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
  if (status < 400 && isInstalledSkillsRoute(method, path)) {
    const wireValue: TeamProtocolV1JsonValue = JSON.parse(JSON.stringify(value));
    return toCurrentAgentKeysForResponsePath(path, structuredClone(wireValue));
  }
  return toCurrentAgentKeysForResponsePath(
    path,
    structuredClone(decodeTeamProtocolV1HttpResponse(method, path, status, value)),
  );
}

function isInstalledSkillsRoute(method: string, path: string): boolean {
  return method === "GET" && /^\/v1\/agents\/[^/]+\/skills$/u.test(new URL(path, "http://openbot.invalid").pathname);
}

function toWireAgentKeysForRequestPath(path: string, value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return isDynamicRecord(value) ? toWireAgentKeysObjectForPath(path, value) : toWireAgentKeys(value);
}

function toCurrentAgentKeysForResponsePath(path: string, value: TeamProtocolV1JsonValue): TeamProtocolV1JsonValue {
  return isDynamicRecord(value) ? toCurrentAgentKeysObjectForPath(path, value) : toCurrentAgentKeys(value);
}

/**
 * The client control channel is the one frozen payload a caller builds by hand rather than handing to
 * the key walk, so its single agent field is converted field by field. Widening it to the walk would
 * mean asserting the result back into the union; naming the one member keeps `tsc` doing the checking.
 */
export type TeamProtocolV1CurrentClientEvent =
  | Exclude<TeamProtocolV1ClientEvent, { type: "team-typing" }>
  | { type: "team-typing"; agentId: string | null; typing: boolean };

/** The subset a v2 event-control frame carries: everything except the scope declaration. */
export type TeamProtocolV1CurrentEventControl = Exclude<
  TeamProtocolV1CurrentClientEvent,
  { type: "agent-event-scope" }
>;

export function toWireTeamProtocolV1ClientEvent(
  event: TeamProtocolV1CurrentEventControl,
): Exclude<TeamProtocolV1ClientEvent, { type: "agent-event-scope" }>;
export function toWireTeamProtocolV1ClientEvent(event: TeamProtocolV1CurrentClientEvent): TeamProtocolV1ClientEvent;
export function toWireTeamProtocolV1ClientEvent(event: TeamProtocolV1CurrentClientEvent): TeamProtocolV1ClientEvent {
  return event.type === "team-typing" ? { type: event.type, botId: event.agentId, typing: event.typing } : event;
}

export function encodeTeamProtocolV1CurrentClientEvent(event: TeamProtocolV1CurrentClientEvent): string {
  return encodeTeamProtocolV1ClientEvent(toWireTeamProtocolV1ClientEvent(event));
}

export function decodeTeamProtocolV1CurrentClientEvent(value: unknown): TeamProtocolV1CurrentClientEvent {
  const event = decodeTeamProtocolV1ClientEvent(value);
  return event.type === "team-typing" ? { type: event.type, agentId: event.botId, typing: event.typing } : event;
}
