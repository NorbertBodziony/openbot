import { type AgentEvent, isAgentEvent } from "../ipc-conversation";
import { isTeamRealtimeEvent, type TeamRealtimeEvent } from "../ipc-team-host";
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
  event: AgentEvent | TeamRealtimeEvent,
): TeamProtocolV2EventFrame {
  return decodeTeamProtocolV2EventFrame({ version: 2, type: "event", sequence, payload: wireJson(event) });
}

export function decodeTeamProtocolV2CurrentEvent(
  frame: TeamProtocolV2EventFrame,
): AgentEvent | TeamRealtimeEvent | null {
  const decoded = decodeTeamProtocolV2EventFrame(frame);
  if (decoded.type !== "event") return null;
  if (isAgentEvent(decoded.payload) || isTeamRealtimeEvent(decoded.payload)) return structuredClone(decoded.payload);
  return null;
}

function wireJson(value: unknown): TeamProtocolV2Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The Team protocol value is not serializable.");
  return decodeTeamProtocolV2Json(JSON.parse(encoded));
}
