import { isBoolean, isDynamicRecord, isNumber, isOneOf, isString } from "../runtime-values";
import {
  decodeTeamProtocolV1ClientEvent,
  decodeTeamProtocolV1Event,
  decodeTeamProtocolV1HttpRequest,
  decodeTeamProtocolV1HttpResponse,
  encodeTeamProtocolV1Event,
  TEAM_PROTOCOL_V1_CAPABILITIES,
  type TeamProtocolV1ClientEvent,
  type TeamProtocolV1EventDecodeResult,
  type TeamProtocolV1JsonObject,
  type TeamProtocolV1JsonValue,
} from "./v1";

export const TEAM_PROTOCOL_V2 = 2;
export const TEAM_PROTOCOL_V2_WEBSOCKET = "openbot-team-v2";
export const TEAM_PROTOCOL_V2_CAPABILITIES = [...TEAM_PROTOCOL_V1_CAPABILITIES, "installed-skills"] as const;
export type TeamProtocolV2Capability = (typeof TEAM_PROTOCOL_V2_CAPABILITIES)[number];

export const decodeTeamProtocolV2Event = decodeTeamProtocolV1Event;
export const encodeTeamProtocolV2Event = encodeTeamProtocolV1Event;
export type TeamProtocolV2EventDecodeResult = TeamProtocolV1EventDecodeResult;

export function isTeamProtocolV2Capability(value: unknown): value is TeamProtocolV2Capability {
  return isOneOf(TEAM_PROTOCOL_V2_CAPABILITIES, value);
}

export function decodeTeamProtocolV2ClientEvent(value: unknown): TeamProtocolV1ClientEvent {
  if (isDynamicRecord(value) && value.type === "agent-event-scope" && Array.isArray(value.capabilities)) {
    if (!isBoolean(value.includeConversations) || !value.capabilities.every(isTeamProtocolV2Capability)) {
      throw new Error("Invalid Team protocol v2 client event.");
    }
    return {
      type: "agent-event-scope",
      includeConversations: value.includeConversations,
      capabilities: [...new Set(value.capabilities)],
    };
  }
  return decodeTeamProtocolV1ClientEvent(value);
}

export function encodeTeamProtocolV2ClientEvent(event: TeamProtocolV1ClientEvent): string {
  return JSON.stringify(decodeTeamProtocolV2ClientEvent(event));
}

export function decodeTeamProtocolV2HttpRequest(
  method: string,
  path: string,
  value: unknown,
): TeamProtocolV1JsonObject {
  return decodeTeamProtocolV1HttpRequest(method, path, value);
}

export function decodeTeamProtocolV2HttpResponse(
  method: string,
  path: string,
  status: number,
  value: unknown,
): TeamProtocolV1JsonValue {
  if (status >= 400 || !isInstalledSkillsRoute(method, path)) {
    return decodeTeamProtocolV1HttpResponse(method, path, status, value);
  }
  if (!Array.isArray(value) || !value.every(isInstalledSkill)) {
    throw new Error("Invalid Team protocol v2 installed skills response.");
  }
  return value.map((skill) => ({
    skillId: skill.skillId,
    slug: skill.slug,
    name: skill.name,
    installedVersion: skill.installedVersion,
    availableVersion: skill.availableVersion,
    state: skill.state,
  }));
}

function isInstalledSkillsRoute(method: string, path: string): boolean {
  return method === "GET" && /^\/v1\/agents\/[^/]+\/skills$/u.test(new URL(path, "http://openbot.invalid").pathname);
}

function isInstalledSkill(value: unknown): value is {
  skillId: string;
  slug: string;
  name: string;
  installedVersion: number;
  availableVersion: number;
  state: "installed" | "update-available" | "modified" | "needs-repair";
} {
  return (
    isDynamicRecord(value) &&
    isString(value.skillId) &&
    isString(value.slug) &&
    isString(value.name) &&
    isNumber(value.installedVersion) &&
    isNumber(value.availableVersion) &&
    isOneOf(["installed", "update-available", "modified", "needs-repair"] as const, value.state)
  );
}
