import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  ConfigureHostInput,
  ConfigureRemoteDesktopInput,
  CreateTeamInviteInput,
  JoinServerInput,
  LoginServerInput,
  RemoteMacConnectInput,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { isObject, requireString } from "./validation";

export function parseHostConfig(value: unknown): ConfigureHostInput {
  if (!isObject(value)) throw new Error("Host configuration is required.");
  return {
    serverName: requireString(value.serverName, "serverName", INPUT_LIMITS.serverName),
  };
}

export function parseJoinServer(value: unknown): JoinServerInput {
  if (!isObject(value)) throw new Error("Invitation details are required.");
  return {
    inviteUrl: requireString(value.inviteUrl, "inviteUrl", INPUT_LIMITS.inviteUrl),
  };
}

export function parseLoginServer(value: unknown): LoginServerInput {
  if (!isObject(value)) throw new Error("Login details are required.");
  return {
    serverId: requireString(value.serverId, "serverId"),
  };
}

export function parseCreateTeamInvite(value: unknown): CreateTeamInviteInput {
  if (!isObject(value)) throw new Error("Invitation details are required.");
  if (value.role !== "admin" && value.role !== "member") {
    throw new Error("Unknown team role.");
  }
  if (value.email !== undefined && typeof value.email !== "string") {
    throw new Error("Invalid invitation email.");
  }
  if (typeof value.email === "string" && value.email.length > INPUT_LIMITS.email) {
    throw new Error("Invitation email is too long.");
  }
  return {
    role: value.role,
    ...(value.email?.trim() ? { email: value.email.trim() } : {}),
  };
}

export function parseRemoteMacConnect(value: unknown): RemoteMacConnectInput {
  if (!isObject(value)) throw new Error("Remote Mac details are required.");
  const serverId = value.serverId;
  if (serverId !== undefined && serverId !== null && typeof serverId !== "string") {
    throw new Error("Invalid serverId.");
  }
  return {
    hostname: requireString(value.hostname, "hostname", INPUT_LIMITS.hostname),
    serverId: serverId ?? null,
  };
}

export function parseRemoteDesktopConfig(value: unknown): ConfigureRemoteDesktopInput {
  if (!isObject(value)) throw new Error("Remote Desktop details are required.");
  return {
    password: requireString(value.password, "password", INPUT_LIMITS.remoteDesktopPassword),
  };
}

export function parseUpdateTeamMember(value: unknown): UpdateTeamMemberInput {
  if (!isObject(value)) throw new Error("Invalid team member update.");
  const role = value.role;
  const disabled = value.disabled;
  if (role !== undefined && role !== "admin" && role !== "member") {
    throw new Error("Invalid team member role.");
  }
  if (disabled !== undefined && typeof disabled !== "boolean") {
    throw new Error("Invalid team member state.");
  }
  return {
    memberId: requireString(value.memberId, "memberId"),
    ...(role ? { role } : {}),
    ...(disabled === undefined ? {} : { disabled }),
  };
}
