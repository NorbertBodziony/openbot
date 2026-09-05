import type { AvatarImageInput } from "./ipc-agents";

// The id every IPC payload carries for "this computer" rather than a remote team server. It is a
// wire value the main process, the preload bridge and the renderer all compare against, so it lives
// beside the types they share instead of being retyped at each comparison.
export const LOCAL_SERVER_ID = "local";

export type ServerConnectionState = "online" | "connecting" | "offline" | "error" | "incompatible";
export type TeamRole = "owner" | "admin" | "member";

export type ServerConnectionIssueCode =
  | "client_update_required"
  | "host_update_required"
  | "protocol_error"
  | "authentication_required"
  | "network_unavailable";

export interface ServerConnectionIssue {
  code: ServerConnectionIssueCode;
  message: string;
  retryable: boolean;
}

export interface ServerCompatibility {
  localAppVersion: string;
  hostAppVersion: string | null;
  localProtocol: { minimum: number; maximum: number };
  hostProtocol: { minimum: number; maximum: number } | null;
  negotiatedProtocol: number | null;
  capabilities: string[];
}

export interface ServerSummary {
  id: string;
  name: string;
  kind: "local" | "remote";
  state: ServerConnectionState;
  apiUrl: string | null;
  remoteDesktopAvailable: boolean;
  logoUrl: string | null;
  role: TeamRole | null;
  active: boolean;
  compatibility?: ServerCompatibility | null;
  issue?: ServerConnectionIssue | null;
  connectionSequence?: number;
}

export interface JoinServerInput {
  inviteUrl: string;
}

export interface InvitePreview {
  serverId: string;
  serverName: string;
  apiHostname: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  emailBound: boolean;
}

export interface LoginServerInput {
  serverId: string;
}

export interface ReorderServersInput {
  serverIds: string[];
}

export type HostPhase = "unconfigured" | "idle" | "starting" | "online" | "stopping" | "error";

export interface HostStatus {
  phase: HostPhase;
  configured: boolean;
  enabledOnLaunch: boolean;
  serverId: string | null;
  serverName: string | null;
  apiUrl: string | null;
  logoUrl: string | null;
  apiOnline: boolean;
  remoteDesktopReady: boolean;
  remoteDesktopUnattended: boolean;
  remoteDesktopActiveSessions: number;
  remoteDesktopMaxSessions: number;
  message: string | null;
}

export interface ConfigureHostInput {
  serverName: string;
  logo?: AvatarImageInput | null;
}

export interface UpdateHostIdentityInput {
  serverName?: string;
  logo?: AvatarImageInput | null;
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
  typingAgentId: string | null;
}

export interface TeamPresenceSnapshot {
  serverId: string | null;
  members: TeamPresenceMember[];
  updatedAt: string;
}

export interface SetTeamTypingInput {
  agentId: string | null;
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

export type DirectConversationPageAnchor =
  | { type: "latest" }
  | { type: "before"; cursor: string }
  | { type: "around"; messageId: string };

export interface ReadDirectConversationPageInput {
  memberId: string;
  anchor?: DirectConversationPageAnchor;
  limit?: number;
}

export interface DirectConversationPage {
  threadId: string;
  otherMemberId: string;
  messages: DirectMessage[];
  revision: number;
  pageInfo: {
    hasOlder: boolean;
    olderCursor: string | null;
  };
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
      type: "team-identity";
      serverId: string;
      serverName: string;
      logoVersion: string | null;
    }
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
  if (value.type === "team-identity") {
    return (
      isIdentifier(value.serverId) &&
      isLimitedString(value.serverName, INPUT_LIMITS.serverName) &&
      (value.logoVersion === null || isIdentifier(value.logoVersion))
    );
  }
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
    (value.typingAgentId === null || isIdentifier(value.typingAgentId))
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

export interface RemoteDesktopDisplay {
  id: string;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface RemoteDesktopIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RemoteDesktopCapabilities {
  ready: boolean;
  platform: "darwin" | "win32" | "linux";
  unattended: boolean;
  runtime: "sunshine-moonlight";
  protocolVersion: 2;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId: string | null;
  activeSessions: number;
  maxSessions: number;
}

export type RemoteDesktopPhase = "starting_host" | "connecting" | "connected" | "disconnecting" | "error";
export type RemoteDesktopTransport = "unknown" | "p2p" | "relay";

export type RemoteDesktopErrorCode =
  | "host_unavailable"
  | "host_permissions_required"
  | "session_capacity_reached"
  | "session_expired"
  | "session_revoked"
  | "protocol_mismatch"
  | "connection_failed";

export interface RemoteDesktopSession {
  id: string;
  serverId: string;
  viewerUrl: string;
  viewerGrant: string;
  displays: RemoteDesktopDisplay[];
  selectedDisplayId: string | null;
  phase: RemoteDesktopPhase;
  transport: RemoteDesktopTransport;
  errorCode: RemoteDesktopErrorCode | null;
  message: string | null;
  createdAt: string;
  grantExpiresAt: string;
}

export interface RemoteDesktopConnectInput {
  serverId: string;
}

export interface RemoteDesktopSelectDisplayInput {
  serverId: string;
  displayId: string;
}

import { INPUT_LIMITS } from "./input-limits";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";
