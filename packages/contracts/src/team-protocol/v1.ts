import { type AgentEvent, isAgentEvent } from "../ipc-conversation";
import { isTeamRealtimeEvent, type TeamRealtimeEvent } from "../ipc-team-host";
import { isBoolean, isDynamicRecord, isNumber, isString } from "../runtime-values";

export const TEAM_PROTOCOL_V1 = 1;
export const TEAM_PROTOCOL_VERSION_HEADER = "OpenBot-Protocol-Version";
export const TEAM_APP_VERSION_HEADER = "OpenBot-App-Version";
export const TEAM_PROTOCOL_V1_WEBSOCKET = "openbot-team-v1";

export const TEAM_PROTOCOL_V1_CAPABILITIES = [
  "agent-runtime-snapshots",
  "browser-control",
  "conversation-pagination",
  "direct-messages",
  "remote-desktop",
  "sidebar-layout",
] as const;

export type TeamProtocolV1Capability = (typeof TEAM_PROTOCOL_V1_CAPABILITIES)[number];

const TEAM_PROTOCOL_V1_CAPABILITY_SET = new Set<string>(TEAM_PROTOCOL_V1_CAPABILITIES);

export type TeamProtocolV1EventDecodeResult =
  | { kind: "known"; event: AgentEvent | TeamRealtimeEvent }
  | { kind: "unknown"; type: string }
  | { kind: "invalid"; type: string | null };

export type TeamProtocolV1ClientEvent =
  | { type: "runtime-snapshot-request" }
  | { type: "agent-event-scope"; includeConversations: boolean; capabilities?: readonly string[] }
  | { type: "team-typing"; botId: string | null; typing: boolean }
  | { type: "team-direct-typing"; recipientMemberId: string; typing: boolean };

const AGENT_EVENT_TYPES = new Set([
  "status",
  "usage-changed",
  "bots-changed",
  "memories-changed",
  "routines-changed",
  "sidebar-layout-changed",
  "conversation",
  "conversation-invalidated",
  "conversation-page",
  "conversation-delta",
  "queue-invalidated",
  "queue-changed",
  "turn-started",
  "turn-completed",
  "prompt",
  "agent-input-resolved",
  "browser-takeover-requested",
  "browser-takeover-resolved",
  "approval",
  "runtime-snapshot",
  "browser-changed",
  "browser-control-changed",
  "error",
]);

const TEAM_EVENT_TYPES = new Set(["team-identity", "team-presence", "team-direct-message", "team-direct-typing"]);

export function decodeTeamProtocolV1Event(value: unknown): TeamProtocolV1EventDecodeResult {
  if (!isDynamicRecord(value) || !isString(value.type)) return { kind: "invalid", type: null };
  if (!TEAM_EVENT_TYPES.has(value.type) && !AGENT_EVENT_TYPES.has(value.type)) {
    return { kind: "unknown", type: value.type };
  }
  if (isTeamRealtimeEvent(value) || isAgentEvent(value)) return { kind: "known", event: value };
  return { kind: "invalid", type: value.type };
}

export function encodeTeamProtocolV1Event(event: AgentEvent | TeamRealtimeEvent): string | null {
  const decoded = decodeTeamProtocolV1Event(event);
  return decoded.kind === "known" ? JSON.stringify(decoded.event) : null;
}

export function encodeTeamProtocolV1ClientEvent(event: TeamProtocolV1ClientEvent): string {
  return JSON.stringify(event);
}

export function decodeTeamProtocolV1ClientEvent(value: unknown): TeamProtocolV1ClientEvent {
  if (!isDynamicRecord(value) || !isString(value.type)) throw new Error("Invalid Team protocol v1 client event.");
  if (value.type === "runtime-snapshot-request") return { type: value.type };
  if (value.type === "agent-event-scope") {
    if (!isBoolean(value.includeConversations)) throw new Error("Invalid Team protocol v1 client event.");
    if (
      value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability))
    ) {
      throw new Error("Invalid Team protocol v1 client event.");
    }
    const event: Extract<TeamProtocolV1ClientEvent, { type: "agent-event-scope" }> = {
      type: value.type,
      includeConversations: value.includeConversations,
    };
    if (value.capabilities) event.capabilities = [...value.capabilities];
    return event;
  }
  if (value.type === "team-typing") {
    if (!isBoolean(value.typing) || (value.botId !== null && !isString(value.botId))) {
      throw new Error("Invalid Team protocol v1 client event.");
    }
    return { type: value.type, botId: value.botId, typing: value.typing };
  }
  if (value.type === "team-direct-typing" && isString(value.recipientMemberId) && isBoolean(value.typing)) {
    return { type: value.type, recipientMemberId: value.recipientMemberId, typing: value.typing };
  }
  throw new Error("Invalid Team protocol v1 client event.");
}

export function encodeTeamProtocolV1Http(value: object | null): string {
  return JSON.stringify(value);
}

export function isTeamProtocolV1Capability(value: string): value is TeamProtocolV1Capability {
  return TEAM_PROTOCOL_V1_CAPABILITY_SET.has(value);
}

export interface TeamProtocolSupportV1 {
  appVersion: string;
  protocol: {
    minimum: number;
    maximum: number;
  };
  capabilities: string[];
}

export function decodeTeamProtocolSupportV1(value: unknown): TeamProtocolSupportV1 {
  if (!isDynamicRecord(value) || !isString(value.appVersion) || value.appVersion.length > 64) {
    throw new Error("Invalid Team API compatibility response.");
  }
  const protocol = value.protocol;
  if (
    !isDynamicRecord(protocol) ||
    !isProtocolVersion(protocol.minimum) ||
    !isProtocolVersion(protocol.maximum) ||
    protocol.minimum > protocol.maximum ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 64 ||
    !value.capabilities.every(isCapability)
  ) {
    throw new Error("Invalid Team API compatibility response.");
  }
  return {
    appVersion: value.appVersion,
    protocol: { minimum: protocol.minimum, maximum: protocol.maximum },
    capabilities: [...new Set(value.capabilities)],
  };
}

export function highestCommonTeamProtocol(
  local: TeamProtocolSupportV1["protocol"],
  remote: TeamProtocolSupportV1["protocol"],
): number | null {
  const minimum = Math.max(local.minimum, remote.minimum);
  const maximum = Math.min(local.maximum, remote.maximum);
  return minimum <= maximum ? maximum : null;
}

export function teamProtocolUpdateDirection(
  local: TeamProtocolSupportV1["protocol"],
  remote: TeamProtocolSupportV1["protocol"],
): "client_update_required" | "host_update_required" | null {
  if (highestCommonTeamProtocol(local, remote) !== null) return null;
  return local.maximum < remote.minimum ? "client_update_required" : "host_update_required";
}

function isProtocolVersion(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function isCapability(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value);
}
