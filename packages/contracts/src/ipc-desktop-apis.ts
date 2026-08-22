import type {
  AppInfo,
  AppSetupState,
  CentralAuthDesktopApi,
  ExportResult,
  ExternalDestination,
  MacPermissionId,
  MacPermissionsState,
  SaveSetupInput,
  UpdateStatus,
} from "./ipc-app-auth";
import type { BrowserControlState, BrowserOpenInput, BrowserTab, BrowserVisibilityInput } from "./ipc-browser";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelOption,
  AgentStatus,
  AttachmentImportEvent,
  BotSummary,
  CancelQueuedMessageInput,
  ChooseAttachmentsInput,
  ConversationPage,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  DraftAttachment,
  InterruptTurnInput,
  MarkConversationReadInput,
  OpenAttachmentInput,
  OpenSharedFileInput,
  OpenWorkspaceFileInput,
  QueuedMessageReceipt,
  QueueSnapshot,
  ReadConversationPageInput,
  ReorderQueueInput,
  RespondToApprovalInput,
  RespondToPromptInput,
  SearchConversationMessagesInput,
  SendMessageInput,
  SetAgentAvatarInput,
  SetMessageReactionInput,
  SteerQueuedMessageInput,
  UpdateBotInput,
  UpdateQueuedMessageInput,
} from "./ipc-conversation";
import type {
  ConfigureHostInput,
  CreateTeamInviteInput,
  DirectConversationPage,
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingInput,
  DirectTypingRealtimeEvent,
  HostStatus,
  InvitePreview,
  InviteSummary,
  JoinServerInput,
  LoginServerInput,
  MarkDirectReadInput,
  ReadDirectConversationPageInput,
  RemoteDesktopConnectInput,
  RemoteDesktopSelectDisplayInput,
  RemoteDesktopSession,
  ReorderServersInput,
  SendDirectMessageInput,
  ServerSummary,
  SetTeamTypingInput,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateHostIdentityInput,
  UpdateTeamMemberInput,
} from "./ipc-team-host";
import type { VoiceTranscriptionInput, VoiceTranscriptionResult } from "./ipc-voice";

export interface AgentDesktopApi {
  getStatus: () => Promise<AgentStatus>;
  getUsage: () => Promise<AccountUsage>;
  listModels: () => Promise<AgentModelOption[]>;
  listBots: () => Promise<BotSummary[]>;
  createBot: () => Promise<BotSummary>;
  updateBot: (input: UpdateBotInput) => Promise<BotSummary>;
  setAvatar: (input: SetAgentAvatarInput) => Promise<BotSummary>;
  deleteBot: (botId: string) => Promise<void>;
  readConversation: (botId: string) => Promise<ConversationWithReadState>;
  readConversationPage: (input: ReadConversationPageInput) => Promise<ConversationPage>;
  searchConversationMessages: (input: SearchConversationMessagesInput) => Promise<ConversationSearchPage>;
  listConversationReads: () => Promise<Record<string, ConversationReadState>>;
  markConversationRead: (input: MarkConversationReadInput) => Promise<ConversationReadState>;
  chooseAttachments: (input: ChooseAttachmentsInput) => Promise<DraftAttachment[]>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  discardDraftAttachment: (attachmentId: string) => Promise<void>;
  openAttachment: (input: OpenAttachmentInput) => Promise<void>;
  openSharedFile: (input: OpenSharedFileInput) => Promise<void>;
  openWorkspaceFile: (input: OpenWorkspaceFileInput) => Promise<void>;
  sendMessage: (input: SendMessageInput) => Promise<QueuedMessageReceipt>;
  setMessageReaction: (input: SetMessageReactionInput) => Promise<void>;
  listQueue: (botId: string) => Promise<QueueSnapshot>;
  cancelQueuedMessage: (input: CancelQueuedMessageInput) => Promise<void>;
  steerQueuedMessage: (input: SteerQueuedMessageInput) => Promise<void>;
  updateQueuedMessage: (input: UpdateQueuedMessageInput) => Promise<void>;
  reorderQueue: (input: ReorderQueueInput) => Promise<void>;
  interrupt: (input: InterruptTurnInput) => Promise<void>;
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  respondToApproval: (input: RespondToApprovalInput) => Promise<void>;
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
  reorder: (input: ReorderServersInput) => Promise<ServerSummary[]>;
  join: (input: JoinServerInput) => Promise<ServerSummary>;
  previewInvite: (input: JoinServerInput) => Promise<InvitePreview>;
  takePendingInvite: () => Promise<string | null>;
  login: (input: LoginServerInput) => Promise<ServerSummary>;
  remove: (serverId: string) => Promise<void>;
  getPresence: () => Promise<TeamPresenceSnapshot>;
  getPresenceFor: (serverId: string) => Promise<TeamPresenceSnapshot>;
  refreshIdentity: (serverId: string) => Promise<ServerSummary>;
  listMembers: (serverId: string) => Promise<TeamMemberSummary[]>;
  updateMember: (serverId: string, input: UpdateTeamMemberInput) => Promise<TeamMemberSummary>;
  removeMember: (serverId: string, memberId: string) => Promise<void>;
  listInvites: (serverId: string) => Promise<TeamInviteSummary[]>;
  revokeInvite: (serverId: string, inviteId: string) => Promise<void>;
  createInvite: (serverId: string, input: CreateTeamInviteInput) => Promise<InviteSummary>;
  setTyping: (input: SetTeamTypingInput) => Promise<void>;
  onPresence: (listener: (snapshot: TeamPresenceSnapshot) => void) => () => void;
  listDirectThreads: () => Promise<DirectThreadSummary[]>;
  readDirectConversation: (memberId: string) => Promise<DirectConversationSnapshot>;
  readDirectConversationPage: (input: ReadDirectConversationPageInput) => Promise<DirectConversationPage>;
  sendDirectMessage: (input: SendDirectMessageInput) => Promise<DirectMessage>;
  markDirectRead: (input: MarkDirectReadInput) => Promise<DirectConversationReadState>;
  setDirectTyping: (input: DirectTypingInput) => Promise<void>;
  onDirectMessage: (listener: (event: DirectMessageRealtimeEvent) => void) => () => void;
  onDirectTyping: (listener: (event: DirectTypingRealtimeEvent) => void) => () => void;
  onEvent: (listener: (servers: ServerSummary[]) => void) => () => void;
  onInvite: (listener: (inviteUrl: string) => void) => () => void;
}

export interface HostDesktopApi {
  getStatus: () => Promise<HostStatus>;
  configure: (input: ConfigureHostInput) => Promise<HostStatus>;
  updateIdentity: (input: UpdateHostIdentityInput) => Promise<HostStatus>;
  getPresence: () => Promise<TeamPresenceSnapshot>;
  start: () => Promise<HostStatus>;
  stop: () => Promise<HostStatus>;
  listMembers: () => Promise<TeamMemberSummary[]>;
  updateMember: (input: UpdateTeamMemberInput) => Promise<TeamMemberSummary>;
  removeMember: (memberId: string) => Promise<void>;
  listSessions: () => Promise<TeamSessionSummary[]>;
  revokeSession: (sessionId: string) => Promise<void>;
  listInvites: () => Promise<TeamInviteSummary[]>;
  revokeInvite: (inviteId: string) => Promise<void>;
  createInvite: (input: CreateTeamInviteInput) => Promise<InviteSummary>;
  onEvent: (listener: (status: HostStatus) => void) => () => void;
}

export interface RemoteDesktopDesktopApi {
  list: () => Promise<RemoteDesktopSession[]>;
  connect: (input: RemoteDesktopConnectInput) => Promise<RemoteDesktopSession>;
  selectDisplay: (input: RemoteDesktopSelectDisplayInput) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  onEvent: (listener: (sessions: RemoteDesktopSession[]) => void) => () => void;
}

export interface VoiceDesktopApi {
  transcribe: (input: VoiceTranscriptionInput) => Promise<VoiceTranscriptionResult>;
}

export interface OpenBotDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  getSetupState: () => Promise<AppSetupState>;
  saveSetup: (input: SaveSetupInput) => Promise<AppSetupState>;
  getMacPermissions: () => Promise<MacPermissionsState>;
  requestMacPermission: (permission: MacPermissionId) => Promise<MacPermissionsState>;
  openExternal: (destination: ExternalDestination) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  voice: VoiceDesktopApi;
  auth: CentralAuthDesktopApi;
  agent: AgentDesktopApi;
  browser: BrowserDesktopApi;
  update: UpdateDesktopApi;
  maintenance: MaintenanceDesktopApi;
  servers: ServersDesktopApi;
  host: HostDesktopApi;
  remoteDesktop: RemoteDesktopDesktopApi;
}
