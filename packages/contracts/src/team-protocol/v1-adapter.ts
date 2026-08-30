import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
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
  const wireValue = JSON.parse(JSON.stringify(event));
  const decoded = decodeTeamProtocolV1Event(wireValue);
  return decoded.kind === "known" ? encodeTeamProtocolV1Event(decoded.event) : null;
}

export function encodeTeamProtocolV1CurrentHttpRequest(method: string, path: string, value: unknown): string {
  const wireValue = JSON.parse(JSON.stringify(value));
  return JSON.stringify(decodeTeamProtocolV1HttpRequest(method, path, wireValue));
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
  const wireValue = JSON.parse(JSON.stringify(value));
  return JSON.stringify(decodeTeamProtocolV1HttpResponse(method, path, status, wireValue));
}

export function decodeTeamProtocolV1CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  return structuredClone(decodeTeamProtocolV1HttpResponse(method, path, status, value));
}
