import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import {
  decodeTeamProtocolV2Event,
  decodeTeamProtocolV2HttpRequest,
  decodeTeamProtocolV2HttpResponse,
  encodeTeamProtocolV2Event,
  type TeamProtocolV2EventDecodeResult,
} from "./v2";

export type TeamProtocolV2CurrentEventDecodeResult =
  | { kind: "known"; event: AgentEvent | TeamRealtimeEvent }
  | Exclude<TeamProtocolV2EventDecodeResult, { kind: "known" }>;

export function decodeTeamProtocolV2CurrentEvent(value: unknown): TeamProtocolV2CurrentEventDecodeResult {
  const decoded = decodeTeamProtocolV2Event(value);
  if (decoded.kind !== "known") return decoded;
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the frozen v2 codec validates the wire value before this versioned boundary clone.
  return { kind: "known", event: structuredClone(decoded.event) as AgentEvent | TeamRealtimeEvent };
}

export function encodeTeamProtocolV2CurrentEvent(event: AgentEvent | TeamRealtimeEvent): string | null {
  const decoded = decodeTeamProtocolV2Event(JSON.parse(JSON.stringify(event)));
  return decoded.kind === "known" ? encodeTeamProtocolV2Event(decoded.event) : null;
}

export function encodeTeamProtocolV2CurrentHttpRequest(method: string, path: string, value: unknown): string {
  return JSON.stringify(decodeTeamProtocolV2HttpRequest(method, path, JSON.parse(JSON.stringify(value))));
}

export function decodeTeamProtocolV2CurrentHttpResponse(method: string, path: string, status: number, value: unknown) {
  return structuredClone(decodeTeamProtocolV2HttpResponse(method, path, status, value));
}

export function encodeTeamProtocolV2CurrentHttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): string {
  return JSON.stringify(decodeTeamProtocolV2HttpResponse(method, path, status, JSON.parse(JSON.stringify(value))));
}
