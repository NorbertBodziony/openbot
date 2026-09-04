// Team identity, membership and invitations, as a host or the account service sends them.

import type {
  InvitePreview,
  InviteSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamRole,
} from "@openbot/contracts/ipc";
import { isTeamRealtimeEvent } from "@openbot/contracts/ipc";
import { decodeRecord, nullableString, requiredBoolean, requiredString } from "@openbot/contracts/ipc-decoding";
import { isOneOf } from "@openbot/contracts/runtime-values";

export function decodeJoinResult(value: unknown): { member: { role: TeamRole }; sessionToken: string } {
  const record = decodeRecord(value, "join response");
  const member = decodeRecord(record.member, "member");
  const role = member.role;
  if (!isOneOf(["owner", "admin", "member"] as const, role)) {
    throw new Error("Invalid member role.");
  }
  return { member: { role }, sessionToken: requiredString(record, "sessionToken") };
}

export function decodeIdentityProof(value: unknown): {
  serverId: string;
  publicKey: string;
  serverName: string;
  fingerprint: string;
  challenge: string;
  signature: string;
  logoVersion: string | null;
} {
  const record = decodeRecord(value, "server identity");
  return {
    serverId: requiredString(record, "serverId"),
    publicKey: requiredString(record, "publicKey"),
    serverName: requiredString(record, "serverName"),
    fingerprint: requiredString(record, "fingerprint"),
    challenge: requiredString(record, "challenge"),
    signature: requiredString(record, "signature"),
    logoVersion: record.logoVersion === undefined ? null : nullableString(record, "logoVersion"),
  };
}

export function decodeTeamPresenceSnapshot(value: unknown): TeamPresenceSnapshot {
  const event = { type: "team-presence", snapshot: value };
  if (!isTeamRealtimeEvent(event) || event.type !== "team-presence") {
    throw new Error("Invalid team presence response.");
  }
  return event.snapshot;
}

export function decodeTeamMember(value: unknown): TeamMemberSummary {
  const record = decodeRecord(value, "team member");
  const role = requiredString(record, "role");
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Invalid team member role.");
  return {
    id: requiredString(record, "id"),
    username: requiredString(record, "username"),
    email: nullableString(record, "email"),
    name: nullableString(record, "name"),
    avatarUrl: nullableString(record, "avatarUrl"),
    role,
    createdAt: requiredString(record, "createdAt"),
    disabled: requiredBoolean(record, "disabled"),
  };
}

export function decodeTeamMembers(value: unknown): TeamMemberSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid team members response.");
  return value.map(decodeTeamMember);
}

function decodeTeamInvite(value: unknown): TeamInviteSummary {
  const record = decodeRecord(value, "team invitation");
  const role = requiredString(record, "role");
  if (role !== "admin" && role !== "member") throw new Error("Invalid invitation role.");
  return {
    id: requiredString(record, "id"),
    role,
    expiresAt: requiredString(record, "expiresAt"),
    usedAt: nullableString(record, "usedAt"),
    email: nullableString(record, "email"),
  };
}

export function decodeTeamInvites(value: unknown): TeamInviteSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid team invitations response.");
  return value.map(decodeTeamInvite);
}

export function decodeInviteSummary(value: unknown): InviteSummary {
  const record = decodeRecord(value, "invitation");
  return { ...decodeTeamInvite(value), inviteUrl: requiredString(record, "inviteUrl") };
}

export function decodeInvitePreview(value: unknown): Pick<InvitePreview, "role" | "expiresAt" | "emailBound"> {
  const record = decodeRecord(value, "invitation preview");
  const role = requiredString(record, "role");
  if (role !== "admin" && role !== "member") throw new Error("Invalid invitation preview response.");
  return {
    role,
    expiresAt: requiredString(record, "expiresAt"),
    emailBound: requiredBoolean(record, "emailBound"),
  };
}
