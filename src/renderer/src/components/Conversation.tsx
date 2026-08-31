import type { AgentModelId, AgentProviderId, AgentReasoningEffort, BrowserBounds } from "@openbot/contracts/ipc";
import { createContext, createSignal, onCleanup, type ParentProps, useContext } from "solid-js";
import {
  type ComposerDraft,
  type ConversationProps,
  ConversationView,
  type MediaPreview,
  type RightPanelMode,
  type SidebarFilePreview,
} from "./ConversationView";
import type { AgentActivityPresentation } from "./conversation/AgentActivity";
import type { ChatSearchMatch } from "./conversation/chat-search";

const SETTINGS_PANEL_DEFAULT = 296;
const BROWSER_PANEL_DEFAULT = 380;
const BROWSER_PIP_STORAGE_KEY = "openbot:browser-pip-native-bounds";

function readBrowserPipBounds(): BrowserBounds | null {
  const values = (window.localStorage.getItem(BROWSER_PIP_STORAGE_KEY) ?? "")
    .split(",")
    .map((value) => Number.parseFloat(value));
  const [x, y, width, height] = values;
  return values.length === 4 && values.every(Number.isFinite) ? { x, y, width, height } : null;
}

interface ConversationResources {
  agentActivityPresentations: Map<string, { activityId: string; presentation: AgentActivityPresentation }>;
  controlledBrowserBotIds: Set<string>;
  importTargetBots: Map<string, { botId: string; serverId: string }>;
  seenMessageIds: Set<string>;
  typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  typingBotId: string | null;
  voiceRecorder: Pick<MediaRecorder, "state" | "stop"> | undefined;
  voiceStream: { getTracks(): Array<Pick<MediaStreamTrack, "stop">> } | undefined;
  voiceRecordingTimer: ReturnType<typeof setTimeout> | undefined;
  voiceElapsedTimer: ReturnType<typeof setInterval> | undefined;
  voiceChunks: Blob[];
  voiceBotId: string | undefined;
  voiceServerId: string | undefined;
  voiceSubmitRequest:
    | {
        botId: string;
        serverId: string;
        draft: ComposerDraft;
        queuedEdit: { deliveryId: string; originalAttachmentIds: string[] } | undefined;
      }
    | undefined;
  voiceDisposed: boolean;
  filePreviewRequestGeneration: number;
}

/** @internal Stable owner for renderer state that must survive Conversation view HMR. */
export function createConversationController(props: Pick<ConversationProps, "onTypingChange">) {
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [editingBotId, setEditingBotId] = createSignal<string | null>(null);
  const [editingServerId, setEditingServerId] = createSignal<string | null>(null);
  const [editingDeliveryId, setEditingDeliveryId] = createSignal<string | null>(null);
  const [editingDraftBackup, setEditingDraftBackup] = createSignal<ComposerDraft | null>(null);
  const [editingOriginalAttachmentIds, setEditingOriginalAttachmentIds] = createSignal<string[]>([]);
  const [composerFocusRequest, setComposerFocusRequest] = createSignal(0);
  const [showComposerActions, setShowComposerActions] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const [conversationErrors, setConversationErrors] = createSignal<Record<string, string>>({});
  const [voicePhase, setVoicePhase] = createSignal<"idle" | "preparing" | "requesting" | "recording" | "transcribing">(
    "idle",
  );
  const [voiceModelProgress, setVoiceModelProgress] = createSignal<number | null>(null);
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = createSignal(0);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [selectionSending, setSelectionSending] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const [rightPanels, setRightPanels] = createSignal<Record<string, RightPanelMode>>({});
  const [settingsProvider, setSettingsProvider] = createSignal<AgentProviderId>("codex");
  const [settingsModel, setSettingsModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [settingsReasoning, setSettingsReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [browserAddressEditing, setBrowserAddressEditing] = createSignal(false);
  const [browserPipBounds, setBrowserPipBounds] = createSignal<BrowserBounds | null>(readBrowserPipBounds());
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);
  const [sidebarFilePreview, setSidebarFilePreview] = createSignal<SidebarFilePreview | null>(null);
  const [openReactionMessageId, setOpenReactionMessageId] = createSignal<string | null>(null);
  const [openMoreMessageId, setOpenMoreMessageId] = createSignal<string | null>(null);
  const [expandedEmojiMessageId, setExpandedEmojiMessageId] = createSignal<string | null>(null);
  const [expandedThinkingMessages, setExpandedThinkingMessages] = createSignal<Record<string, boolean>>({});
  const [copiedMessageId, setCopiedMessageId] = createSignal<string | null>(null);
  const [chatSearchOpen, setChatSearchOpen] = createSignal(false);
  const [chatSearchQuery, setChatSearchQuery] = createSignal("");
  const [chatSearchMatches, setChatSearchMatches] = createSignal<ChatSearchMatch[]>([]);
  const [activeChatSearchIndex, setActiveChatSearchIndex] = createSignal(-1);
  const [chatSearchMessageIds, setChatSearchMessageIds] = createSignal<string[]>([]);
  const [chatSearchTotal, setChatSearchTotal] = createSignal(0);
  const [settingsPanelWidth, setSettingsPanelWidth] = createSignal(SETTINGS_PANEL_DEFAULT);
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(BROWSER_PANEL_DEFAULT);
  const resources: ConversationResources = {
    agentActivityPresentations: new Map(),
    controlledBrowserBotIds: new Set<string>(),
    importTargetBots: new Map<string, { botId: string; serverId: string }>(),
    seenMessageIds: new Set<string>(),
    typingIdleTimer: undefined,
    typingBotId: null,
    voiceRecorder: undefined,
    voiceStream: undefined,
    voiceRecordingTimer: undefined,
    voiceElapsedTimer: undefined,
    voiceChunks: [],
    voiceBotId: undefined,
    voiceServerId: undefined,
    voiceSubmitRequest: undefined,
    voiceDisposed: false,
    filePreviewRequestGeneration: 0,
  };

  onCleanup(() => {
    resources.voiceDisposed = true;
    if (resources.voiceRecordingTimer) clearTimeout(resources.voiceRecordingTimer);
    if (resources.voiceElapsedTimer) clearInterval(resources.voiceElapsedTimer);
    if (resources.voiceRecorder?.state === "recording") resources.voiceRecorder.stop();
    for (const track of resources.voiceStream?.getTracks() ?? []) track.stop();
    if (resources.typingIdleTimer) clearTimeout(resources.typingIdleTimer);
    if (resources.typingBotId) props.onTypingChange(resources.typingBotId, false);
  });

  return {
    drafts,
    setDrafts,
    editingBotId,
    setEditingBotId,
    editingServerId,
    setEditingServerId,
    editingDeliveryId,
    setEditingDeliveryId,
    editingDraftBackup,
    setEditingDraftBackup,
    editingOriginalAttachmentIds,
    setEditingOriginalAttachmentIds,
    composerFocusRequest,
    setComposerFocusRequest,
    showComposerActions,
    setShowComposerActions,
    attachmentBusy,
    setAttachmentBusy,
    composerError,
    setComposerError,
    conversationErrors,
    setConversationErrors,
    voicePhase,
    setVoicePhase,
    voiceModelProgress,
    setVoiceModelProgress,
    voiceElapsedSeconds,
    setVoiceElapsedSeconds,
    markingRead,
    setMarkingRead,
    submitting,
    setSubmitting,
    selectionSending,
    setSelectionSending,
    dropActive,
    setDropActive,
    rightPanels,
    setRightPanels,
    settingsProvider,
    setSettingsProvider,
    settingsModel,
    setSettingsModel,
    settingsReasoning,
    setSettingsReasoning,
    browserAddress,
    setBrowserAddress,
    browserAddressEditing,
    setBrowserAddressEditing,
    browserPipBounds,
    setBrowserPipBounds,
    mediaPreview,
    setMediaPreview,
    sidebarFilePreview,
    setSidebarFilePreview,
    openReactionMessageId,
    setOpenReactionMessageId,
    openMoreMessageId,
    setOpenMoreMessageId,
    expandedEmojiMessageId,
    setExpandedEmojiMessageId,
    expandedThinkingMessages,
    setExpandedThinkingMessages,
    copiedMessageId,
    setCopiedMessageId,
    chatSearchOpen,
    setChatSearchOpen,
    chatSearchQuery,
    setChatSearchQuery,
    chatSearchMatches,
    setChatSearchMatches,
    activeChatSearchIndex,
    setActiveChatSearchIndex,
    chatSearchMessageIds,
    setChatSearchMessageIds,
    chatSearchTotal,
    setChatSearchTotal,
    settingsPanelWidth,
    setSettingsPanelWidth,
    browserPanelWidth,
    setBrowserPanelWidth,
    resources,
  };
}

export type ConversationController = ReturnType<typeof createConversationController>;
export type { ConversationProps } from "./ConversationView";

const ConversationControllerContext = createContext<ConversationController>();

/** @internal Access to the stable controller for Conversation view components. */
export function useConversationController(): ConversationController {
  const controller = useContext(ConversationControllerContext);
  if (!controller) throw new Error("Conversation controller is unavailable outside Conversation.");
  return controller;
}

/** @internal Test seam for remounting view boundaries without remounting their controller. */
export function ConversationControllerProvider(props: ParentProps<{ controller: ConversationController }>) {
  return <ConversationControllerContext value={props.controller}>{props.children}</ConversationControllerContext>;
}

export function Conversation(props: ConversationProps) {
  const controller = createConversationController(props);
  return (
    <ConversationControllerProvider controller={controller}>
      <ConversationView {...props} />
    </ConversationControllerProvider>
  );
}
