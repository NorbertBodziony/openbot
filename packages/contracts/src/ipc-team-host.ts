export type ServerConnectionState = "online" | "connecting" | "offline" | "error";
export type TeamRole = "owner" | "admin" | "member";

export interface ServerSummary {
  id: string;
  name: string;
  kind: "local" | "remote";
  state: ServerConnectionState;
  apiUrl: string | null;
  vncHostname: string | null;
  role: TeamRole | null;
  active: boolean;
}

export interface JoinServerInput {
  inviteUrl: string;
}

export interface LoginServerInput {
  serverId: string;
}

export type HostPhase = "unconfigured" | "idle" | "starting" | "online" | "stopping" | "error";

export interface HostStatus {
  phase: HostPhase;
  configured: boolean;
  enabledOnLaunch: boolean;
  serverId: string | null;
  serverName: string | null;
  apiUrl: string | null;
  vncHostname: string | null;
  apiOnline: boolean;
  vncOnline: boolean;
  remoteDesktopCredentialConfigured: boolean;
  message: string | null;
}

export interface ConfigureHostInput {
  serverName: string;
}

export interface ConfigureRemoteDesktopInput {
  password: string;
}

export interface TeamMemberSummary {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  avatarUrl?: string | null;
  role: TeamRole;
  createdAt: string;
  disabled: boolean;
}

export interface TeamPresenceMember extends TeamMemberSummary {
  online: boolean;
  typingBotId: string | null;
}

export interface TeamPresenceSnapshot {
  serverId: string | null;
  members: TeamPresenceMember[];
  updatedAt: string;
}

export interface SetTeamTypingInput {
  botId: string | null;
  typing: boolean;
}

export interface ScopedTeamPresenceSnapshot {
  serverId: string;
  snapshot: TeamPresenceSnapshot;
}

export interface DirectMessage {
  id: string;
  threadId: string;
  senderMemberId: string;
  recipientMemberId: string;
  text: string;
  createdAt: string;
  sequence: number;
}

export interface DirectThreadSummary {
  threadId: string;
  otherMemberId: string;
  lastMessage: DirectMessage;
  unreadCount: number;
  updatedAt: string;
}

export interface DirectConversationSnapshot {
  threadId: string;
  otherMemberId: string;
  messages: DirectMessage[];
  revision: number;
  readState?: DirectConversationReadState;
}

export interface DirectConversationReadState {
  unreadCount: number;
  firstUnreadMessageId: string | null;
  throughSequence: number;
}

export interface SendDirectMessageInput {
  memberId: string;
  text: string;
  clientMessageId: string;
}

export interface MarkDirectReadInput {
  memberId: string;
  throughSequence: number;
}

export interface DirectTypingInput {
  memberId: string;
  typing: boolean;
}

export type TeamRealtimeEvent =
  | {
      type: "team-presence";
      snapshot: TeamPresenceSnapshot;
    }
  | {
      type: "team-direct-message";
      message: DirectMessage;
      memberIds: [string, string];
    }
  | {
      type: "team-direct-typing";
      senderMemberId: string;
      recipientMemberId: string;
      typing: boolean;
    };

export type DirectMessageRealtimeEvent = Extract<TeamRealtimeEvent, { type: "team-direct-message" }>;

export type DirectTypingRealtimeEvent = Extract<TeamRealtimeEvent, { type: "team-direct-typing" }>;

export function isTeamRealtimeEvent(value: unknown): value is TeamRealtimeEvent {
  if (!isDynamicRecord(value)) return false;
  if (value.type === "team-presence") return isTeamPresenceSnapshot(value.snapshot);
  if (value.type === "team-direct-message") {
    if (!isDirectMessage(value.message) || !Array.isArray(value.memberIds)) return false;
    return (
      value.memberIds.length === 2 &&
      value.memberIds[0] === value.message.senderMemberId &&
      value.memberIds[1] === value.message.recipientMemberId
    );
  }
  return (
    value.type === "team-direct-typing" &&
    isIdentifier(value.senderMemberId) &&
    isIdentifier(value.recipientMemberId) &&
    value.senderMemberId !== value.recipientMemberId &&
    isBoolean(value.typing)
  );
}

function isTeamPresenceSnapshot(value: unknown): value is TeamPresenceSnapshot {
  if (!isDynamicRecord(value) || !Array.isArray(value.members)) return false;
  return (
    (value.serverId === null || isIdentifier(value.serverId)) &&
    isTimestamp(value.updatedAt) &&
    value.members.length <= INPUT_LIMITS.teamMembers &&
    value.members.every(isTeamPresenceMember)
  );
}

function isTeamPresenceMember(value: unknown): value is TeamPresenceMember {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isLimitedString(value.username, INPUT_LIMITS.email) &&
    (value.email === null || isLimitedString(value.email, INPUT_LIMITS.email)) &&
    (value.name === null || isLimitedString(value.name, INPUT_LIMITS.accountName)) &&
    (value.avatarUrl === undefined || value.avatarUrl === null || isHttpUrl(value.avatarUrl, INPUT_LIMITS.avatarUrl)) &&
    (value.role === "owner" || value.role === "admin" || value.role === "member") &&
    isTimestamp(value.createdAt) &&
    isBoolean(value.disabled) &&
    isBoolean(value.online) &&
    (value.typingBotId === null || isIdentifier(value.typingBotId))
  );
}

function isDirectMessage(value: unknown): value is DirectMessage {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.senderMemberId) &&
    isIdentifier(value.recipientMemberId) &&
    value.senderMemberId !== value.recipientMemberId &&
    isLimitedString(value.text, INPUT_LIMITS.directMessageText) &&
    isTimestamp(value.createdAt) &&
    isNumber(value.sequence) &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  );
}

function isIdentifier(value: unknown): value is string {
  return isLimitedString(value, INPUT_LIMITS.identifier);
}

function isTimestamp(value: unknown): value is string {
  return isLimitedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown, limit: number): value is string {
  if (!isLimitedString(value, limit)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isLimitedString(value: unknown, limit: number): value is string {
  return isString(value) && value.length > 0 && value.length <= limit;
}

export interface ScopedDirectMessageEvent {
  serverId: string;
  event: DirectMessageRealtimeEvent;
}

export interface ScopedDirectTypingEvent {
  serverId: string;
  event: DirectTypingRealtimeEvent;
}

export interface InviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  inviteUrl: string;
  email: string | null;
}

export interface TeamInviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  email: string | null;
}

export interface CreateTeamInviteInput {
  role: Exclude<TeamRole, "owner">;
  email?: string;
}

export interface TeamSessionSummary {
  id: string;
  memberId: string;
  username: string;
  createdAt: string;
  expiresAt: string;
}

export interface UpdateTeamMemberInput {
  memberId: string;
  role?: Exclude<TeamRole, "owner">;
  disabled?: boolean;
}

export type RemoteMacPhase = "idle" | "starting_tunnel" | "checking_vnc" | "connected" | "disconnecting";

export type RemoteMacErrorCode =
  | "cloudflared_not_found"
  | "local_port_unavailable"
  | "tunnel_timeout"
  | "tunnel_disconnected"
  | "invalid_vnc_handshake"
  | "desktop_bridge_unavailable"
  | "desktop_access_not_configured"
  | "desktop_access_denied";

export interface RemoteMacSession {
  id: string;
  serverId: string | null;
  hostname: string;
  localPort: number | null;
  websocketUrl: string | null;
  phase: RemoteMacPhase;
  errorCode: RemoteMacErrorCode | null;
  message: string | null;
  createdAt: string;
}

export interface RemoteMacConnectInput {
  hostname: string;
  serverId?: string | null;
}

export interface RemoteMacCredentials {
  username: string;
  password: string;
  target: string;
}

import { INPUT_LIMITS } from "./input-limits";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";
