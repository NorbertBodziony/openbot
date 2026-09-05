import type { AgentEvent, ScopedAgentEvent } from "./ipc-agent-events";
import type { AgentModelOption } from "./ipc-agent-identity";
import type {
  AgentMemory,
  CreateAgentMemoryInput,
  DeleteAgentMemoryInput,
  UpdateAgentMemoryInput,
} from "./ipc-agent-memories";
import type { AccountUsage, AgentProviderId, AgentStatus } from "./ipc-agent-status";
import type {
  AgentSummary,
  CreateAgentInput,
  DuplicateAgentResult,
  SetAgentAvatarInput,
  UpdateAgentInput,
} from "./ipc-agents";
import type {
  AnalyticsPreference,
  AppInfo,
  AppSetupState,
  CentralAuthDesktopApi,
  ComputerUseMacSetupState,
  ExportResult,
  ExternalDestination,
  MacPermissionId,
  ProviderRuntimeSnapshot,
  SaveSetupInput,
  SetAnalyticsPreferenceInput,
  UpdatePreference,
  UpdateStatus,
} from "./ipc-app-auth";
import type { RespondToApprovalInput, RespondToBrowserTakeoverInput } from "./ipc-approvals";
import type {
  AttachmentImportEvent,
  ChooseAttachmentsInput,
  DraftAttachment,
  FilePreview,
  OpenAttachmentInput,
  OpenSharedFileInput,
  OpenWorkspaceFileInput,
} from "./ipc-attachments";
import type {
  BrowserBounds,
  BrowserControlState,
  BrowserDisplayState,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserPictureInPictureEvent,
  BrowserPreview,
  BrowserTab,
  BrowserVisibilityInput,
} from "./ipc-browser";
import type {
  ConversationPage,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  MarkConversationReadInput,
  ReadConversationPageInput,
  RespondToPromptInput,
  SearchConversationMessagesInput,
  SendMessageInput,
  SetMessageReactionInput,
} from "./ipc-conversations";
import type {
  DynamicIslandAction,
  DynamicIslandGeometry,
  DynamicIslandPreference,
  DynamicIslandPresentation,
  SetDynamicIslandInteractiveInput,
  SetDynamicIslandPreferenceInput,
} from "./ipc-dynamic-island";
import type {
  DeleteHostedSiteInput,
  HostedSiteSummary,
  PublishHostedSiteInput,
  ReplaceHostedSiteInput,
} from "./ipc-hosted-sites";
import type {
  AgentPublicationPreview,
  AgentSubmission,
  InstallMarketplaceAgentInput,
  InstallMarketplaceAgentResult,
  MarketplaceAgentDetail,
  MarketplaceAgentPage,
  MarketplaceAgentQuery,
  SubmitMarketplaceAgentInput,
} from "./ipc-marketplace-agents";
import type {
  AcknowledgeFailedTurnInput,
  CancelQueuedMessageInput,
  InterruptTurnInput,
  QueuedMessageReceipt,
  QueueSnapshot,
  ReorderQueueInput,
  SteerQueuedMessageInput,
  UpdateQueuedMessageInput,
} from "./ipc-queue";
import type {
  CreateRoutineInput,
  DeleteRoutineInput,
  ListRoutineRunsInput,
  Routine,
  RoutineRun,
  TestRoutineInput,
  UpdateRoutineInput,
} from "./ipc-routines";
import type { SidebarLayoutAction, SidebarLayoutSnapshot } from "./ipc-sidebar-layout";
import type {
  InstalledSkill,
  InstallSkillInput,
  MarketplaceSkillDetail,
  MarketplaceSkillPage,
  MarketplaceSkillQuery,
  SkillPackagePreview,
  SkillSubmission,
  SubmitSkillInput,
  UninstallSkillInput,
} from "./ipc-skills";
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
import type { VoiceModelStatus, VoiceTranscriptionInput, VoiceTranscriptionResult } from "./ipc-voice";

export interface AgentDesktopApi {
  getStatus: () => Promise<AgentStatus>;
  getUsage: (agentId: string) => Promise<AccountUsage>;
  listModels: () => Promise<AgentModelOption[]>;
  listAgents: () => Promise<AgentSummary[]>;
  listInstalledSkills: (agentId: string) => Promise<InstalledSkill[]>;
  getSidebarLayout: () => Promise<SidebarLayoutSnapshot>;
  mutateSidebarLayout: (action: SidebarLayoutAction) => Promise<SidebarLayoutSnapshot>;
  createAgent: (input: CreateAgentInput) => Promise<AgentSummary>;
  duplicateAgent: (agentId: string) => Promise<DuplicateAgentResult>;
  updateAgent: (input: UpdateAgentInput) => Promise<AgentSummary>;
  setAvatar: (input: SetAgentAvatarInput) => Promise<AgentSummary>;
  deleteAgent: (agentId: string) => Promise<void>;
  listMemories: (agentId: string) => Promise<AgentMemory[]>;
  createMemory: (input: CreateAgentMemoryInput) => Promise<AgentMemory>;
  updateMemory: (input: UpdateAgentMemoryInput) => Promise<AgentMemory>;
  deleteMemory: (input: DeleteAgentMemoryInput) => Promise<void>;
  clearMemories: (agentId: string) => Promise<void>;
  listRoutines: (agentId: string) => Promise<Routine[]>;
  createRoutine: (input: CreateRoutineInput) => Promise<Routine>;
  updateRoutine: (input: UpdateRoutineInput) => Promise<Routine>;
  deleteRoutine: (input: DeleteRoutineInput) => Promise<void>;
  testRoutine: (input: TestRoutineInput) => Promise<RoutineRun>;
  listRoutineRuns: (input: ListRoutineRunsInput) => Promise<RoutineRun[]>;
  readConversation: (agentId: string) => Promise<ConversationWithReadState>;
  readConversationPage: (input: ReadConversationPageInput, serverId?: string) => Promise<ConversationPage>;
  searchConversationMessages: (input: SearchConversationMessagesInput) => Promise<ConversationSearchPage>;
  listConversationReads: () => Promise<Record<string, ConversationReadState>>;
  markConversationRead: (input: MarkConversationReadInput, serverId?: string) => Promise<ConversationReadState>;
  chooseAttachments: (input: ChooseAttachmentsInput) => Promise<DraftAttachment[]>;
  onAttachmentImport: (listener: (event: AttachmentImportEvent) => void) => () => void;
  discardDraftAttachment: (attachmentId: string, serverId?: string) => Promise<void>;
  openAttachment: (input: OpenAttachmentInput) => Promise<void>;
  openSharedFile: (input: OpenSharedFileInput) => Promise<void>;
  openWorkspaceFile: (input: OpenWorkspaceFileInput) => Promise<void>;
  previewSharedFile: (input: OpenSharedFileInput) => Promise<FilePreview>;
  previewWorkspaceFile: (input: OpenWorkspaceFileInput) => Promise<FilePreview>;
  sendMessage: (input: SendMessageInput, serverId?: string) => Promise<QueuedMessageReceipt>;
  setMessageReaction: (input: SetMessageReactionInput) => Promise<void>;
  listQueue: (agentId: string) => Promise<QueueSnapshot>;
  acknowledgeFailedTurn: (input: AcknowledgeFailedTurnInput) => Promise<void>;
  cancelQueuedMessage: (input: CancelQueuedMessageInput) => Promise<void>;
  steerQueuedMessage: (input: SteerQueuedMessageInput) => Promise<void>;
  updateQueuedMessage: (input: UpdateQueuedMessageInput, serverId?: string) => Promise<void>;
  reorderQueue: (input: ReorderQueueInput) => Promise<void>;
  interrupt: (input: InterruptTurnInput) => Promise<void>;
  respondToPrompt: (input: RespondToPromptInput) => Promise<void>;
  respondToApproval: (input: RespondToApprovalInput) => Promise<void>;
  respondToBrowserTakeover: (input: RespondToBrowserTakeoverInput) => Promise<void>;
  onEvent: (listener: (event: AgentEvent) => void) => () => void;
  onScopedEvent: (listener: (event: ScopedAgentEvent) => void) => () => void;
}

export interface MarketplaceAgentsDesktopApi {
  list: (query?: MarketplaceAgentQuery) => Promise<MarketplaceAgentPage>;
  get: (agentId: string) => Promise<MarketplaceAgentDetail>;
  listMine: () => Promise<AgentSubmission[]>;
  preview: (agentId: string) => Promise<AgentPublicationPreview>;
  submit: (input: SubmitMarketplaceAgentInput) => Promise<AgentSubmission>;
  install: (input: InstallMarketplaceAgentInput) => Promise<InstallMarketplaceAgentResult>;
}

export interface BrowserDesktopApi {
  open: (input: BrowserOpenInput) => Promise<BrowserTab>;
  activate: (tabId: string) => Promise<void>;
  navigate: (input: BrowserNavigateInput) => Promise<void>;
  reload: (tabId: string) => Promise<void>;
  close: (tabId: string) => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  getDisplayState: () => Promise<BrowserDisplayState>;
  getControlState: () => Promise<BrowserControlState>;
  capturePreview: (tabId: string) => Promise<BrowserPreview>;
  setVisible: (input: BrowserVisibilityInput) => Promise<void>;
  onDisplayState: (listener: (state: BrowserDisplayState) => void) => () => void;
  openPictureInPicture: (bounds?: BrowserBounds) => Promise<BrowserBounds>;
  closePictureInPicture: () => Promise<void>;
  dockPictureInPicture: () => Promise<void>;
  hidePictureInPicture: () => Promise<void>;
  onPictureInPictureEvent: (listener: (event: BrowserPictureInPictureEvent) => void) => () => void;
}

export interface UpdateDesktopApi {
  getStatus: () => Promise<UpdateStatus>;
  check: () => Promise<UpdateStatus>;
  download: () => Promise<UpdateStatus>;
  install: () => Promise<void>;
  getPreference: () => Promise<UpdatePreference>;
  setPreference: (input: UpdatePreference) => Promise<UpdatePreference>;
  onEvent: (listener: (status: UpdateStatus) => void) => () => void;
}

export interface ProviderRuntimesDesktopApi {
  getStatus: () => Promise<ProviderRuntimeSnapshot>;
  download: (provider: AgentProviderId) => Promise<ProviderRuntimeSnapshot>;
  cancel: (provider: AgentProviderId) => Promise<ProviderRuntimeSnapshot>;
  onEvent: (listener: (snapshot: ProviderRuntimeSnapshot) => void) => () => void;
}

export interface MaintenanceDesktopApi {
  exportData: () => Promise<ExportResult>;
  exportDiagnostics: () => Promise<ExportResult>;
}

export interface DynamicIslandDesktopApi {
  getPreference: () => Promise<DynamicIslandPreference>;
  setPreference: (input: SetDynamicIslandPreferenceInput) => Promise<DynamicIslandPreference>;
  publishPresentation: (presentation: DynamicIslandPresentation) => Promise<void>;
  getPresentation: () => Promise<DynamicIslandPresentation>;
  onPreference: (listener: (preference: DynamicIslandPreference) => void) => () => void;
  onPresentation: (listener: (presentation: DynamicIslandPresentation) => void) => () => void;
  onGeometry: (listener: (geometry: DynamicIslandGeometry) => void) => () => void;
  performAction: (action: DynamicIslandAction) => Promise<void>;
  performHaptic: () => Promise<void>;
  onAction: (listener: (action: DynamicIslandAction) => void) => () => void;
  setInteractive: (input: SetDynamicIslandInteractiveInput) => Promise<void>;
}

export interface ServersDesktopApi {
  list: () => Promise<ServerSummary[]>;
  select: (serverId: string) => Promise<ServerSummary[]>;
  reorder: (input: ReorderServersInput) => Promise<ServerSummary[]>;
  join: (input: JoinServerInput) => Promise<ServerSummary>;
  previewInvite: (input: JoinServerInput) => Promise<InvitePreview>;
  takePendingInvite: () => Promise<string | null>;
  login: (input: LoginServerInput) => Promise<ServerSummary>;
  retryConnection: (serverId: string) => Promise<ServerSummary>;
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
  getModelStatus: () => Promise<VoiceModelStatus>;
  prepareModel: () => Promise<VoiceModelStatus>;
  transcribe: (input: VoiceTranscriptionInput) => Promise<VoiceTranscriptionResult>;
  onModelStatus: (listener: (status: VoiceModelStatus) => void) => () => void;
}

export interface SkillsDesktopApi {
  list: (query?: MarketplaceSkillQuery) => Promise<MarketplaceSkillPage>;
  get: (skillId: string) => Promise<MarketplaceSkillDetail>;
  listMine: () => Promise<SkillSubmission[]>;
  choosePackage: () => Promise<SkillPackagePreview | null>;
  submit: (input: SubmitSkillInput) => Promise<SkillSubmission>;
  listInstalled: (agentId: string) => Promise<InstalledSkill[]>;
  install: (input: InstallSkillInput) => Promise<InstalledSkill>;
  uninstall: (input: UninstallSkillInput) => Promise<void>;
}

export interface HostedSitesDesktopApi {
  list: () => Promise<HostedSiteSummary[]>;
  chooseDirectory: () => Promise<string | null>;
  publish: (input: PublishHostedSiteInput) => Promise<HostedSiteSummary>;
  replace: (input: ReplaceHostedSiteInput) => Promise<HostedSiteSummary>;
  delete: (input: DeleteHostedSiteInput) => Promise<void>;
}

export interface OpenBotDesktopApi {
  getAppInfo: () => Promise<AppInfo>;
  getSetupState: () => Promise<AppSetupState>;
  saveSetup: (input: SaveSetupInput) => Promise<AppSetupState>;
  getAnalyticsPreference: () => Promise<AnalyticsPreference>;
  setAnalyticsPreference: (input: SetAnalyticsPreferenceInput) => Promise<AnalyticsPreference>;
  dynamicIsland: DynamicIslandDesktopApi;
  getComputerUseMacSetupState: () => Promise<ComputerUseMacSetupState>;
  openComputerUsePermissionSetup: (permission: MacPermissionId) => Promise<ComputerUseMacSetupState>;
  startComputerUseHelperDrag: () => Promise<void>;
  revealComputerUseHelper: () => Promise<void>;
  closeComputerUsePermissionSetup: () => Promise<void>;
  openExternal: (destination: ExternalDestination) => Promise<void>;
  connectChatGPT: () => Promise<AgentStatus>;
  connectClaude: () => Promise<AgentStatus>;
  connectGrok: () => Promise<AgentStatus>;
  refreshAgentProviders: () => Promise<AgentStatus>;
  providerRuntimes: ProviderRuntimesDesktopApi;
  openUrl: (url: string) => Promise<void>;
  voice: VoiceDesktopApi;
  skills: SkillsDesktopApi;
  hostedSites: HostedSitesDesktopApi;
  marketplaceAgents: MarketplaceAgentsDesktopApi;
  auth: CentralAuthDesktopApi;
  agent: AgentDesktopApi;
  browser: BrowserDesktopApi;
  update: UpdateDesktopApi;
  maintenance: MaintenanceDesktopApi;
  servers: ServersDesktopApi;
  host: HostDesktopApi;
  remoteDesktop: RemoteDesktopDesktopApi;
}
