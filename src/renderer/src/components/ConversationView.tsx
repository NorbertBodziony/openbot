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
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { createEffect, Show } from "solid-js";
import type { BotMessage, BotProfile } from "../data";
import { ConversationComposer } from "./conversation/ConversationComposer";
import { ConversationHeader } from "./conversation/ConversationHeader";
import { ConversationOverlays } from "./conversation/ConversationOverlays";
import { ConversationPanels } from "./conversation/ConversationPanels";
import { ConversationTimeline } from "./conversation/ConversationTimeline";
import { ConversationViewScopeContext, createConversationViewScope } from "./conversation/conversation-scope";
import { MessageSelectionActions } from "./conversation/SelectionActions";

export interface ConversationTarget {
  botId: string;
  serverId: string;
}

export interface ConversationProps {
  agentStatus: AgentStatus;
  providerRuntimeStatuses?: Partial<Record<AgentProviderId, ProviderRuntimeStatus>>;
  onDownloadProvider?: (provider: AgentProviderId) => void | Promise<void>;
  onCancelProviderDownload?: (provider: AgentProviderId) => void | Promise<void>;
  onConnectProvider?: (provider: AgentProviderId) => void | Promise<void>;
  bot: BotProfile | undefined;
  bots: BotProfile[];
  availableRoutineIds?: readonly string[];
  modelOptions: AgentModelOption[];
  messages: BotMessage[];
  messageReferences?: Record<string, BotMessage>;
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
  settingsRequest: { botId: string; nonce: number } | null;
  messageFocusRequest: { botId: string; messageId: string; nonce: number } | null;
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
  onSelectAgent: (botId: string) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSetAgentAvatar: (botId: string, image: AvatarImageInput | null) => Promise<void>;
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
  onTypingChange: (botId: string, typing: boolean) => void;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onPromptResolutionPresented?: (botId: string, turnId: string, requestId: string | number) => void;
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
  ownerBotId: string;
  source: "shared" | "workspace";
  path: string;
  preview: FilePreview;
}

/** @internal Keeps file-drag state active while the pointer moves between conversation descendants. */
export function isDragLeavingConversation(currentTarget: HTMLElement, relatedTarget: EventTarget | null): boolean {
  return !(relatedTarget instanceof Node && currentTarget.contains(relatedTarget));
}

export type RightPanelMode = "none" | "browser" | "browser-pip" | "settings" | "file-preview";

export function ConversationView(props: ConversationProps) {
  const scope = createConversationViewScope(props);
  const {
    agentReady,
    browserPanelWidth,
    browserSidebarOpen,
    dropActive,
    filePreviewOpen,
    handleChatSearchShortcut,
    sendSelectionInstruction,
    setConversationPanelElement,
    setDropActive,
    settingsPanelWidth,
    submitting,
  } = scope;
  createEffect(
    () => props.globalOverlayOpen,
    (open) => {
      if (open) setDropActive(false);
    },
  );
  return (
    <ConversationViewScopeContext value={scope}>
      <main
        ref={setConversationPanelElement}
        aria-label="Conversation"
        onKeyDown={handleChatSearchShortcut}
        class={[
          "conversation-panel",
          {
            "conversation-drop-active": dropActive(),
            "browser-panel-active": browserSidebarOpen() || filePreviewOpen(),
          },
        ]}
        style={`--settings-panel-width: ${settingsPanelWidth()}px; --browser-panel-width: ${browserPanelWidth()}px`}
        onDragEnter={(event) => {
          if (!props.globalOverlayOpen && event.dataTransfer?.types.includes("Files")) setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!props.globalOverlayOpen && event.dataTransfer?.types.includes("Files")) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (isDragLeavingConversation(event.currentTarget, event.relatedTarget)) setDropActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropActive(false);
        }}
      >
        <MessageSelectionActions
          contextKey={props.bot?.id}
          disabled={!props.bot || !agentReady() || submitting()}
          onSend={sendSelectionInstruction}
        />
        <Show when={dropActive()}>
          <div class="attachment-drop-overlay">Drop files to attach</div>
        </Show>
        <ConversationHeader />

        <ConversationTimeline />

        <ConversationComposer />

        <ConversationOverlays />

        <ConversationPanels />
      </main>
    </ConversationViewScopeContext>
  );
}
