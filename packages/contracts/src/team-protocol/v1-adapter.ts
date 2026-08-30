import type { AgentEvent } from "../ipc-conversation";
import type { TeamRealtimeEvent } from "../ipc-team-host";
import { decodeTeamProtocolV1Event, encodeTeamProtocolV1Event, type TeamProtocolV1EventDecodeResult } from "./v1";

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
