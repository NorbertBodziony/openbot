import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  ConfigureHostInput,
  CreateTeamInviteInput,
  DirectTypingInput,
  JoinServerInput,
  LoginServerInput,
  MarkDirectReadInput,
  ReadDirectConversationPageInput,
  ReorderServersInput,
  SendDirectMessageInput,
  SetTeamTypingInput,
  UpdateHostIdentityInput,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { isBoolean, isNumber, isString } from "@openbot/contracts/runtime-values";
import { parseAvatarImage } from "./avatar-inputs";
import { isObject, requireString } from "./validation";

export function parseReadDirectConversationPage(value: unknown): ReadDirectConversationPageInput {
  if (!isObject(value)) throw new Error("Invalid direct-message page request.");
  const anchor = value.anchor;
  let parsedAnchor: ReadDirectConversationPageInput["anchor"] = { type: "latest" };
  if (anchor !== undefined) {
    if (!isObject(anchor) || !isString(anchor.type)) throw new Error("Invalid direct-message page anchor.");
    if (anchor.type === "before") {
      parsedAnchor = { type: "before", cursor: requireString(anchor.cursor, "cursor", 2048) };
    } else if (anchor.type === "around") {
      parsedAnchor = {
        type: "around",
        messageId: requireString(anchor.messageId, "messageId", INPUT_LIMITS.identifier),
      };
    } else if (anchor.type !== "latest") {
      throw new Error("Invalid direct-message page anchor.");
    }
  }
  const limit = value.limit ?? 50;
  if (!isNumber(limit) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("The direct-message page limit must be between 1 and 100.");
  }
  return {
    memberId: requireString(value.memberId, "memberId", INPUT_LIMITS.identifier),
    anchor: parsedAnchor,
    limit,
  };
}

export function parseHostConfig(value: unknown): ConfigureHostInput {
  if (!isObject(value)) throw new Error("Host configuration is required.");
  const serverName = requireString(value.serverName, "serverName", INPUT_LIMITS.serverName);
  if (serverName.trim().length < INPUT_LIMITS.serverNameMin) {
    throw new Error(`Server name must contain at least ${INPUT_LIMITS.serverNameMin} characters.`);
  }
  return {
    serverName,
    ...(value.logo === undefined ? {} : { logo: parseAvatarImage(value.logo) }),
  };
}

export function parseHostIdentity(value: unknown): UpdateHostIdentityInput {
  if (!isObject(value)) throw new Error("Host identity is required.");
  if (value.serverName === undefined && value.logo === undefined) {
    throw new Error("A host identity change is required.");
  }
  const serverName =
    value.serverName === undefined ? undefined : requireString(value.serverName, "serverName", INPUT_LIMITS.serverName);
  if (serverName !== undefined && serverName.trim().length < INPUT_LIMITS.serverNameMin) {
    throw new Error(`Server name must contain at least ${INPUT_LIMITS.serverNameMin} characters.`);
  }
  return {
    ...(serverName === undefined ? {} : { serverName }),
    ...(value.logo === undefined ? {} : { logo: parseAvatarImage(value.logo) }),
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

export function parseReorderServers(value: unknown): ReorderServersInput {
  if (!isObject(value) || !Array.isArray(value.serverIds)) {
    throw new Error("Invalid server order.");
  }
  const serverIds = value.serverIds.map((serverId) => requireString(serverId, "serverId", INPUT_LIMITS.identifier));
  if (new Set(serverIds).size !== serverIds.length) {
    throw new Error("Duplicate server ids.");
  }
  return { serverIds };
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
    botId: value.botId === null ? null : requireString(value.botId, "botId", INPUT_LIMITS.identifier),
    typing: value.typing,
  };
}

export function parseSendDirectMessage(value: unknown): SendDirectMessageInput {
  if (!isObject(value)) throw new Error("Direct message details are required.");
  return {
    memberId: requireString(value.memberId, "memberId", INPUT_LIMITS.identifier),
    text: requireString(value.text, "text", INPUT_LIMITS.directMessageText),
    clientMessageId: requireString(value.clientMessageId, "clientMessageId", INPUT_LIMITS.identifier),
  };
}

export function parseMarkDirectRead(value: unknown): MarkDirectReadInput {
  if (!isObject(value) || !isNumber(value.throughSequence)) {
    throw new Error("Invalid direct-message read request.");
  }
  if (!Number.isSafeInteger(value.throughSequence) || value.throughSequence < 0) {
    throw new Error("Invalid direct-message read boundary.");
  }
  return {
    memberId: requireString(value.memberId, "memberId", INPUT_LIMITS.identifier),
    throughSequence: value.throughSequence,
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

export function parseRemoteDesktopConnect(input: unknown): { serverId: string } {
  if (!isObject(input)) throw new Error("Remote control details are required.");
  return { serverId: requireString(input.serverId, "serverId") };
}

export function parseRemoteDesktopDisplay(input: unknown): { serverId: string; displayId: string } {
  if (!isObject(input)) throw new Error("Remote display details are required.");
  return {
    serverId: requireString(input.serverId, "serverId"),
    displayId: requireString(input.displayId, "displayId"),
  };
}
