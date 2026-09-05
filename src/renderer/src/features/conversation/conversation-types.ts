import type {
  AgentEvent,
  AgentModelOption,
  AgentProviderId,
  AgentStatus,
  AttachmentSummary,
  AvatarImageInput,
  BrowserControlState,
  BrowserTab,
  DraftAttachment,
  FilePreview,
  ProviderRuntimeStatus,
  QueueSnapshot,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateAgentInput,
} from "@openbot/contracts/ipc";
import type { AgentMessage, AgentProfile } from "../../data";

/**
 * What a conversation is, as data. These live apart from `ConversationView.tsx`
 * because fifteen of this feature's modules - the scope, the controller, the
 * draft logic and every store - name one of these types and none of them render
 * anything. Reading them from the entry component made `conversation-scope.ts`
 * and `ConversationView.tsx` import each other: a cycle `noImportCycles` lets
 * through only because one direction is `import type`.
 */

export interface ConversationTarget {
  agentId: string;
  serverId: string;
}

export interface ConversationProps {
  agentStatus: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  agent: AgentProfile | undefined;
  agents: AgentProfile[];
  availableRoutineIds?: readonly string[];
  modelOptions: AgentModelOption[];
  messages: AgentMessage[];
  messageReferences?: Record<string, AgentMessage>;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  loaded: boolean;
  hasOlder?: boolean;
  discontinuous?: boolean;
  loadingOlder?: boolean;
  olderError?: string | null;
  activeTurnId: string | null | undefined;
  activityDetail?: string;
  skillsMarketplaceOpen?: boolean;
  globalOverlayOpen: boolean;
  settingsRequest: { agentId: string; nonce: number } | null;
  messageFocusRequest: { agentId: string; messageId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserVisibilitySuspended: boolean;
  browserControlState: BrowserControlState;
  server: ServerSummary | undefined;
  presence: TeamPresenceSnapshot;
  currentUserEmail: string;
  browserEnabled?: boolean;
  remoteDesktopEnabled?: boolean;
  remoteDesktopSessionActive: boolean;
  remoteDesktopVisible: boolean;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  approval: Extract<AgentEvent, { type: "approval" }>["approval"] | undefined;
  browserTakeover: Extract<AgentEvent, { type: "browser-takeover-requested" }>["request"] | undefined;
  onSelectAgent: (agentId: string) => void;
  onUpdateAgent: (agentId: string, updates: Omit<UpdateAgentInput, "agentId">) => Promise<void>;
  onSetAgentAvatar: (agentId: string, image: AvatarImageInput | null) => Promise<void>;
  onSendMessage: (
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
    target?: ConversationTarget,
  ) => Promise<boolean>;
  onMarkRead: () => Promise<void>;
  onLoadOlder?: () => void;
  onLoadLatest?: () => Promise<void>;
  onSearchMessages?: (query: string) => Promise<{ messageIds: string[]; total: number }>;
  onOpenSearchMessage?: (messageId: string) => Promise<void>;
  onTypingChange: (agentId: string, typing: boolean) => void;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onPromptResolutionPresented?: (agentId: string, turnId: string, requestId: string | number) => void;
  onRespondToApproval: (decision: "accept" | "decline") => Promise<boolean>;
  onRespondToBrowserTakeover: (decision: "complete" | "cancel") => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onSteerQueuedMessage: (deliveryId: string) => void;
  onUpdateQueuedMessage: (
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
    target?: ConversationTarget,
  ) => Promise<boolean>;
  onReorderQueue: (deliveryIds: string[]) => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void | Promise<void>;
  onOpenRemoteDesktop: (serverId: string, trigger: HTMLElement) => Promise<void>;
  onOpenAgentSetup: () => Promise<void>;
  onStop: () => void;
}

export interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  replyToMessageId: string | null;
}

export interface MediaPreview {
  attachment: AttachmentSummary;
  text: string | null;
  loading: boolean;
  error: string | null;
}

export interface SidebarFilePreview {
  ownerAgentId: string;
  source: "shared" | "workspace";
  path: string;
  preview: FilePreview;
}

export type RightPanelMode = "none" | "browser" | "browser-pip" | "settings" | "file-preview";
