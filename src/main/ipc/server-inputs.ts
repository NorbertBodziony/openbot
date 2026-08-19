import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  ConfigureHostInput,
  ConfigureRemoteDesktopInput,
  CreateTeamInviteInput,
  DirectTypingInput,
  JoinServerInput,
  LoginServerInput,
  RemoteMacConnectInput,
  SendDirectMessageInput,
  SetTeamTypingInput,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isString } from "@openbot/contracts/runtime-values";
import { isObject, requireString } from "./validation";

export function parseHostConfig(value: unknown): ConfigureHostInput {
  if (!isObject(value)) throw new Error("Host configuration is required.");
  const serverName = requireString(value.serverName, "serverName", INPUT_LIMITS.serverName);
  if (serverName.trim().length < INPUT_LIMITS.serverNameMin) {
    throw new Error(`Server name must contain at least ${INPUT_LIMITS.serverNameMin} characters.`);
  }
  return {
    serverName,
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
  if (value.email !== undefined && !isString(value.email)) {
    throw new Error("Invalid invitation email.");
  }
  if (isString(value.email) && value.email.length > INPUT_LIMITS.email) {
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
  if (serverId !== undefined && serverId !== null && !isString(serverId)) {
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
  if (disabled !== undefined && !isBoolean(disabled)) {
    throw new Error("Invalid team member state.");
  }
  return {
    memberId: requireString(value.memberId, "memberId"),
    ...(role ? { role } : {}),
    ...(disabled === undefined ? {} : { disabled }),
  };
}

export function parseSetTeamTyping(value: unknown): SetTeamTypingInput {
  if (!isObject(value) || !isBoolean(value.typing)) {
    throw new Error("Invalid typing state.");
  }
  if (value.botId !== null && !isString(value.botId)) {
    throw new Error("Invalid typing agent.");
  }
  if (value.typing && !value.botId) throw new Error("A typing agent is required.");
  return {
    botId:
      value.botId === null ? null : requireString(value.botId, "botId", INPUT_LIMITS.identifier),
    typing: value.typing,
  };
}

export function parseSendDirectMessage(value: unknown): SendDirectMessageInput {
  if (!isObject(value)) throw new Error("Direct message details are required.");
  return {
    memberId: requireString(value.memberId, "memberId", INPUT_LIMITS.identifier),
    text: requireString(value.text, "text", INPUT_LIMITS.directMessageText),
    clientMessageId: requireString(
      value.clientMessageId,
      "clientMessageId",
      INPUT_LIMITS.identifier,
    ),
  };
}

export function parseDirectTyping(value: unknown): DirectTypingInput {
  if (!isObject(value) || !isBoolean(value.typing)) {
    throw new Error("Invalid direct typing state.");
  }
  return {
    memberId: requireString(value.memberId, "memberId", INPUT_LIMITS.identifier),
    typing: value.typing,
  };
}
