import { type AgentEvent, isAgentEvent } from "../ipc-conversation";
import { isTeamRealtimeEvent, type TeamRealtimeEvent } from "../ipc-team-host";
import { decodeTeamProtocolV1Event, encodeTeamProtocolV1Event, type TeamProtocolV1EventDecodeResult } from "./v1";

export type TeamProtocolV1CurrentEventDecodeResult =
  | { kind: "known"; event: AgentEvent | TeamRealtimeEvent }
  | Exclude<TeamProtocolV1EventDecodeResult, { kind: "known" }>;

export function decodeTeamProtocolV1CurrentEvent(value: unknown): TeamProtocolV1CurrentEventDecodeResult {
  const decoded = decodeTeamProtocolV1Event(value);
  if (decoded.kind !== "known") return decoded;
  if (isAgentEvent(decoded.event) || isTeamRealtimeEvent(decoded.event)) {
    return { kind: "known", event: decoded.event };
  }
  return { kind: "invalid", type: decoded.event.type };
}

export function encodeTeamProtocolV1CurrentEvent(event: AgentEvent | TeamRealtimeEvent): string | null {
  const decoded = decodeTeamProtocolV1Event(event);
  return decoded.kind === "known" ? encodeTeamProtocolV1Event(decoded.event) : null;
}
