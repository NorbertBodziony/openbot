export const IPC_CHANNELS = {
  getAppInfo: "app:get-info",
  getSetupState: "app:get-setup-state",
  saveSetup: "app:save-setup",
  getMacPermissions: "app:get-mac-permissions",
  requestMacPermission: "app:request-mac-permission",
  openExternal: "app:open-external",
  openUrl: "app:open-url",
  authGetState: "auth:get-state",
  authRequestEmailCode: "auth:request-email-code",
  authVerifyEmailCode: "auth:verify-email-code",
  authLogout: "auth:logout",
  authEvent: "auth:event",
  updateGetStatus: "update:get-status",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  updateEvent: "update:event",
  maintenanceExportData: "maintenance:export-data",
  maintenanceExportDiagnostics: "maintenance:export-diagnostics",
  agentGetStatus: "agent:get-status",
  agentGetUsage: "agent:get-usage",
  agentListModels: "agent:list-models",
  agentListBots: "agent:list-bots",
  agentCreateBot: "agent:create-bot",
  agentUpdateBot: "agent:update-bot",
  agentDeleteBot: "agent:delete-bot",
  agentReadConversation: "agent:read-conversation",
  agentSendMessage: "agent:send-message",
  agentSetMessageReaction: "agent:set-message-reaction",
  agentChooseAttachments: "agent:choose-attachments",
  agentImportAttachments: "agent:import-attachments",
  agentDiscardDraftAttachment: "agent:discard-draft-attachment",
  agentOpenAttachment: "agent:open-attachment",
  agentListQueue: "agent:list-queue",
  agentCancelQueuedMessage: "agent:cancel-queued-message",
  agentSetQueuePaused: "agent:set-queue-paused",
  agentInterrupt: "agent:interrupt",
  agentRespondToPrompt: "agent:respond-to-prompt",
  agentEvent: "agent:event",
  browserOpen: "browser:open",
  browserActivate: "browser:activate",
  browserClose: "browser:close",
  browserListTabs: "browser:list-tabs",
  browserGetControlState: "browser:get-control-state",
  browserSetVisible: "browser:set-visible",
  serversList: "servers:list",
  serversSelect: "servers:select",
  serversJoin: "servers:join",
  serversLogin: "servers:login",
  serversUpdateAddress: "servers:update-address",
  serversRemove: "servers:remove",
  serversEvent: "servers:event",
  serversInvite: "servers:invite",
  hostGetStatus: "host:get-status",
  hostConfigure: "host:configure",
  hostStart: "host:start",
  hostStop: "host:stop",
  hostListMembers: "host:list-members",
  hostCreateInvite: "host:create-invite",
  hostCreateAddressUpdate: "host:create-address-update",
  hostListInvites: "host:list-invites",
  hostRevokeInvite: "host:revoke-invite",
  hostUpdateMember: "host:update-member",
  hostListSessions: "host:list-sessions",
  hostRevokeSession: "host:revoke-session",
  hostEvent: "host:event",
  remoteMacList: "remote-mac:list",
  remoteMacConnect: "remote-mac:connect",
  remoteMacDisconnect: "remote-mac:disconnect",
  remoteMacEvent: "remote-mac:event",
} as const;

export type DesktopPlatform = "darwin" | "win32" | "linux";

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
  username: string;
  password: string;
}

export interface LoginServerInput {
  serverId: string;
  username: string;
  password: string;
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
  message: string | null;
}

export interface ConfigureHostInput {
  serverName: string;
  username: string;
  password: string;
}

export interface TeamMemberSummary {
  id: string;
  username: string;
  role: TeamRole;
  createdAt: string;
  disabled: boolean;
}

export interface InviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
  inviteUrl: string;
}

export interface TeamInviteSummary {
  id: string;
  role: Exclude<TeamRole, "owner">;
  expiresAt: string;
  usedAt: string | null;
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

export type RemoteMacPhase =
  | "idle"
  | "starting_tunnel"
  | "checking_vnc"
  | "connected"
  | "disconnecting";

export type RemoteMacErrorCode =
  | "cloudflared_not_found"
  | "local_port_unavailable"
  | "tunnel_timeout"
  | "tunnel_disconnected"
  | "invalid_vnc_handshake"
  | "viewer_launch_failed";

export interface RemoteMacSession {
  id: string;
  serverId: string | null;
  hostname: string;
  localPort: number | null;
  phase: RemoteMacPhase;
  errorCode: RemoteMacErrorCode | null;
  message: string | null;
  createdAt: string;
}

export interface RemoteMacConnectInput {
  hostname: string;
  serverId?: string | null;
}

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "up-to-date"
  | "error"
  | "unsupported";

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  checkedAt: string | null;
  message: string | null;
}

export interface ExportResult {
  saved: boolean;
}

export type AgentPhase = "idle" | "starting" | "ready" | "restarting" | "blocked" | "stopped";

export type CapabilityState = "ready" | "setup-required" | "unavailable";

export type AgentProviderId = "codex" | "claude";
export type AgentProviderState =
  | "not-started"
  | "checking"
  | "available"
  | "sign-in-required"
  | "not-installed"
  | "outdated"
  | "error";

export interface AgentProviderStatus {
  id: AgentProviderId;
  state: AgentProviderState;
  version: string | null;
  message: string | null;
  email?: string | null;
}

export interface AppSetupState {
  completed: boolean;
  preferredProvider: AgentProviderId | null;
}

export interface SaveSetupInput {
  preferredProvider: AgentProviderId;
}

export interface CentralAuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export type CentralAuthState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "signing_in" }
  | {
      status: "code_sent";
      challengeId: string;
      email: string;
      expiresAt: number;
      developmentCode?: string;
      error?: string;
    }
  | { status: "signed_in"; user: CentralAuthUser }
  | { status: "error"; code: string; message: string };

export interface CentralAuthDesktopApi {
  getState: () => Promise<CentralAuthState>;
  requestEmailCode: (email: string) => Promise<CentralAuthState>;
  verifyEmailCode: (challengeId: string, code: string) => Promise<CentralAuthState>;
  logout: () => Promise<CentralAuthState>;
  onEvent: (listener: (state: CentralAuthState) => void) => () => void;
}

export type MacPermissionId = "screen-recording" | "accessibility";
export type MacPermissionState = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface MacPermissionsState {
  screenRecording: MacPermissionState;
  accessibility: MacPermissionState;
}

export type AgentAuthState =
  | { kind: "unknown" }
  | { kind: "signed-out" }
  | { kind: "unsupported"; accountType: string }
  | { kind: "chatgpt"; email: string | null }
  | { kind: "claude"; email: string | null };

export interface AccountUsageWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountUsageLimit {
  id: string;
  primary: AccountUsageWindow | null;
  secondary: AccountUsageWindow | null;
}

export interface AccountUsage {
  limits: AccountUsageLimit[];
}

export type ExternalDestination = "agent-setup" | "feedback" | "message";

export interface AgentStatus {
  phase: AgentPhase;
  cliVersion: string | null;
  auth: AgentAuthState;
  providers?: AgentProviderStatus[];
  capabilities: {
    chat: CapabilityState;
    browser: CapabilityState;
    computerUse: CapabilityState;
  };
  message: string | null;
  fullAccess: true;
}

export interface BotSummary {
  id: string;
  name: string;
  role: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  workspacePath: string;
  preview: string;
  updatedAt: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
}

export const AGENT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number];

export const AGENT_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelOption {
  id: AgentModelId;
  name: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export const BOT_AVATAR_HUES = [0, 30, 55, 100, 150, 185, 215, 245, 280, 320] as const;
export type BotAvatarHue = (typeof BOT_AVATAR_HUES)[number];

export function isAgentModel(value: unknown): value is AgentModelId {
  return typeof value === "string" && AGENT_MODELS.includes(value as AgentModelId);
}

export function isClaudeModel(model: AgentModelId): boolean {
  return model.startsWith("claude-");
}

export function isReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return (
    typeof value === "string" && AGENT_REASONING_EFFORTS.includes(value as AgentReasoningEffort)
  );
}

export function isAvatarSeed(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9:-]{1,128}$/.test(value);
}

export function isAvatarHue(value: unknown): value is BotAvatarHue {
  return typeof value === "number" && BOT_AVATAR_HUES.includes(value as BotAvatarHue);
}

export interface UpdateBotInput {
  botId: string;
  name?: string;
  role?: string;
  description?: string;
  notifications?: boolean;
  model?: AgentModelId;
  reasoningEffort?: AgentReasoningEffort;
  avatarSeed?: string;
  avatarHue?: BotAvatarHue | null;
}

export type ConversationMessageAuthor = "user" | "assistant" | "agent" | "system";

export type AttachmentKind = "image" | "file";
export type AttachmentPreviewKind = "image" | "pdf" | "text" | "none";

export interface AttachmentSummary {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType: string;
  previewKind: AttachmentPreviewKind;
  previewUrl: string | null;
}

export type DraftAttachment = AttachmentSummary;

export interface AttachmentDataInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ImportAttachmentsInput {
  paths: string[];
  data: AttachmentDataInput[];
}

export type AttachmentImportEvent =
  | { type: "started"; requestId: string }
  | { type: "completed"; requestId: string; attachments: DraftAttachment[] }
  | { type: "error"; requestId: string; message: string };

export interface OpenAttachmentInput {
  attachmentId: string;
  action: "open" | "reveal";
}

export type QueueDeliveryStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface QueueDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  sender: { kind: "user" } | { kind: "bot"; botId: string };
  text: string;
  attachments: AttachmentSummary[];
  replyToMessageId: string | null;
  status: QueueDeliveryStatus;
  position: number | null;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

export interface QueueSnapshot {
  botId: string;
  paused: boolean;
  deliveries: QueueDelivery[];
}

export interface ConversationMessage {
  id: string;
  turnId?: string;
  author: ConversationMessageAuthor;
  text: string;
  createdAt: string;
  status: "streaming" | "completed" | "failed" | "interrupted";
  itemType?: string;
  source?: "user" | "assistant" | "agent" | "system";
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  delivery?: Pick<QueueDelivery, "id" | "status" | "position">;
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
}

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "😮"] as const;
export const MORE_MESSAGE_REACTIONS = ["🔥", "👏", "🙏", "🤔", "👀", "✅", "🚀", "💯"] as const;
export const ALL_MESSAGE_REACTIONS = [...MESSAGE_REACTIONS, ...MORE_MESSAGE_REACTIONS] as const;
export type MessageReaction =
  | (typeof MESSAGE_REACTIONS)[number]
  | (typeof MORE_MESSAGE_REACTIONS)[number];

export function isMessageReaction(value: unknown): value is MessageReaction {
  return typeof value === "string" && ALL_MESSAGE_REACTIONS.includes(value as MessageReaction);
}

export interface AgentExchangeSummary {
  direction: "incoming" | "outgoing";
  messageId: string;
  senderBotId: string;
  recipientBotIds: string[];
  replyToMessageId: string | null;
  deliveries: Array<Pick<QueueDelivery, "id" | "recipientBotId" | "status" | "position" | "error">>;
}

export interface ConversationSnapshot {
  botId: string;
  threadId: string | null;
  activeTurnId: string | null;
  revision: number;
  messages: ConversationMessage[];
}

export interface SendMessageInput {
  botId: string;
  text: string;
  attachmentDraftIds?: string[];
  replyToMessageId?: string | null;
}

export interface SetMessageReactionInput {
  botId: string;
  messageId: string;
  emoji: MessageReaction | null;
}

export interface QueuedMessageReceipt {
  messageId: string;
  deliveries: Array<{
    id: string;
    recipientBotId: string;
    status: QueueDeliveryStatus;
    position: number | null;
  }>;
}

export interface CancelQueuedMessageInput {
  botId: string;
  deliveryId: string;
}

export interface SetQueuePausedInput {
  botId: string;
  paused: boolean;
}

export interface InterruptTurnInput {
  botId: string;
  turnId: string;
}

export interface AgentPromptQuestion {
  id: string;
  header: string;
  question: string;
  isSecret: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export interface RespondToPromptInput {
  requestId: string | number;
  answers: Record<string, string[]>;
}

export type AgentEvent =
  | { type: "status"; status: AgentStatus }
  | { type: "usage-changed"; usage: AccountUsage }
  | { type: "bots-changed"; bots: BotSummary[] }
  | { type: "conversation"; snapshot: ConversationSnapshot }
  | {
      type: "conversation-delta";
      botId: string;
      threadId: string;
      turnId: string;
      messageId: string;
      delta: string;
      createdAt: string;
      revision: number;
    }
  | { type: "queue-changed"; snapshot: QueueSnapshot }
  | { type: "turn-started"; botId: string; threadId: string; turnId: string }
  | {
      type: "turn-completed";
      botId: string;
      threadId: string;
      turnId: string;
      status: string;
    }
  | {
      type: "prompt";
      requestId: string | number;
      botId: string;
      threadId: string;
      turnId: string;
      questions: AgentPromptQuestion[];
    }
  | { type: "browser-changed"; tabs: BrowserTab[]; activeTabId: string | null }
  | { type: "browser-control-changed"; state: BrowserControlState }
  | { type: "error"; botId?: string; code: string; message: string };

export interface ScopedAgentEvent {
  serverId: string;
  event: AgentEvent;
}

export interface AgentIpcRequest<T = unknown> {
  serverId: string;
  payload: T;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  ownerThreadId: string | null;
  ownerBotId: string | null;
}

export type BrowserControlPhase = "acting" | "waiting";

export type BrowserControlAction =
  | "open"
  | "list-tabs"
  | "snapshot"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "back"
  | "forward"
  | "reload"
  | "screenshot"
  | "close-tab";

export interface BrowserControlSession {
  id: string;
  threadId: string;
  turnId: string;
  callId: string;
  tabId: string | null;
  action: BrowserControlAction;
  phase: BrowserControlPhase;
  startedAt: string;
}

export interface BrowserControlState {
  sessions: BrowserControlSession[];
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserOpenInput {
  url: string;
  ownerThreadId?: string | null;
  ownerBotId?: string | null;
}

export interface BrowserVisibilityInput {
  visible: boolean;
  bounds?: BrowserBounds;
}

export interface AgentDesktopApi {
  getStatus: () => Promise<AgentStatus>;
  getUsage: () => Promise<AccountUsage>;
  listModels: () => Promise<AgentModelOption[]>;
  listBots: () => Promise<BotSummary[]>;
  createBot: () => Promise<BotSummary>;
  updateBot: (input: UpdateBotInput) => Promise<BotSummary>;
  deleteBot: (botId: string) => Promise<void>;
  readConversation: (botId: string) => Promise<ConversationSnapshot>;
  chooseAttachments: () => Promise<DraftAttachment[]>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  discardDraftAttachment: (attachmentId: string) => Promise<void>;
  openAttachment: (input: OpenAttachmentInput) => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<QueuedMessageReceipt>;
  setMessageReaction: (input: SetMessageReactionInput) => Promise<void>;
  listQueue: (botId: string) => Promise<QueueSnapshot>;
  cancelQueuedMessage: (input: CancelQueuedMessageInput) => Promise<void>;
  setQueuePaused: (input: SetQueuePausedInput) => Promise<void>;
  interrupt: (input: InterruptTurnInput) => Promise<void>;
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
}

export interface BrowserDesktopApi {
  open: (input: BrowserOpenInput) => Promise<BrowserTab>;
  activate: (tabId: string) => Promise<void>;
  close: (tabId: string) => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  getControlState: () => Promise<BrowserControlState>;
  setVisible: (input: BrowserVisibilityInput) => Promise<void>;
}

export interface UpdateDesktopApi {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<UpdateStatus>;
  download: () => Promise<UpdateStatus>;
  install: () => Promise<void>;
  onEvent: (listener: (status: UpdateStatus) => void) => () => void;
}

export interface MaintenanceDesktopApi {
  exportData: () => Promise<ExportResult>;
  exportDiagnostics: () => Promise<ExportResult>;
}

export interface ServersDesktopApi {
  list: () => Promise<ServerSummary[]>;
  select: (serverId: string) => Promise<ServerSummary[]>;
  join: (input: JoinServerInput) => Promise<ServerSummary>;
  login: (input: LoginServerInput) => Promise<ServerSummary>;
  updateAddress: (updateUrl: string) => Promise<ServerSummary>;
  remove: (serverId: string) => Promise<void>;
  onEvent: (listener: (servers: ServerSummary[]) => void) => () => void;
  onInvite: (listener: (inviteUrl: string) => void) => () => void;
}

export interface HostDesktopApi {
  getStatus: () => Promise<HostStatus>;
  configure: (input: ConfigureHostInput) => Promise<HostStatus>;
  start: () => Promise<HostStatus>;
  stop: () => Promise<HostStatus>;
  listMembers: () => Promise<TeamMemberSummary[]>;
  updateMember: (input: UpdateTeamMemberInput) => Promise<TeamMemberSummary>;
  listSessions: () => Promise<TeamSessionSummary[]>;
  revokeSession: (sessionId: string) => Promise<void>;
  listInvites: () => Promise<TeamInviteSummary[]>;
  revokeInvite: (inviteId: string) => Promise<void>;
  createInvite: (role: Exclude<TeamRole, "owner">) => Promise<InviteSummary>;
  createAddressUpdate: () => Promise<string>;
  onEvent: (listener: (status: HostStatus) => void) => () => void;
}

export interface RemoteMacDesktopApi {
  list: () => Promise<RemoteMacSession[]>;
  connect: (input: RemoteMacConnectInput) => Promise<RemoteMacSession>;
  disconnect: (sessionId: string) => Promise<void>;
  onEvent: (listener: (sessions: RemoteMacSession[]) => void) => () => void;
}

export interface OpenBotDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  getSetupState: () => Promise<AppSetupState>;
  saveSetup: (input: SaveSetupInput) => Promise<AppSetupState>;
  getMacPermissions: () => Promise<MacPermissionsState>;
  requestMacPermission: (permission: MacPermissionId) => Promise<MacPermissionsState>;
  openExternal: (destination: ExternalDestination) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  auth: CentralAuthDesktopApi;
  agent: AgentDesktopApi;
  browser: BrowserDesktopApi;
  update: UpdateDesktopApi;
  maintenance: MaintenanceDesktopApi;
  servers: ServersDesktopApi;
  host: HostDesktopApi;
  remoteMac: RemoteMacDesktopApi;
}
