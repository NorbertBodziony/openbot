import type { AgentModelId, AgentProviderId, AgentReasoningEffort, BrowserBounds } from "@openbot/contracts/ipc";
import { createSignal, onCleanup } from "solid-js";
import type {
  ComposerDraft,
  ConversationProps,
  MediaPreview,
  RightPanelMode,
  SidebarFilePreview,
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
  browserOpenRequests: Map<
    string,
    {
      promise: Promise<void>;
      serverId: string;
      agentId: string | null;
      url: string;
      existingTabIds: Set<string>;
    }
  >;
  importTargetAgents: Map<string, { agentId: string; serverId: string }>;
  seenMessageIds: Set<string>;
  typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  typingAgentId: string | null;
  voiceRecorder: Pick<MediaRecorder, "state" | "stop"> | undefined;
  voiceStream: { getTracks(): Array<Pick<MediaStreamTrack, "stop">> } | undefined;
  voiceRecordingTimer: ReturnType<typeof setTimeout> | undefined;
  voiceElapsedTimer: ReturnType<typeof setInterval> | undefined;
  voiceChunks: Blob[];
  voiceAgentId: string | undefined;
  voiceServerId: string | undefined;
  voiceSubmitRequest:
    | {
        agentId: string;
        serverId: string;
        draft: ComposerDraft;
        queuedEdit: { deliveryId: string; originalAttachmentIds: string[] } | undefined;
      }
    | undefined;
  voiceDisposed: boolean;
  voiceRequestGeneration: number;
  filePreviewRequestGeneration: number;
  runtimeSettingsSaveTails: Map<string, Promise<boolean>>;
  runtimeSettingsAttempts: Map<
    string,
    {
      generation: number;
      pending: boolean;
      settings: {
        provider: AgentProviderId;
        model: AgentModelId;
        reasoningEffort: AgentReasoningEffort;
      };
    }
  >;
}

/**
 * The half of the conversation surface that outlives one server.
 *
 * Everything here is either work the user started and has not finished - a
 * composer draft, a queued-message edit, a pasted attachment - or an async call
 * already in flight against a named server. Discarding any of it on a server
 * switch would throw away typing the user still expects to find, so this owner
 * sits above the keyed scope in `app-providers.tsx` and lives as long as the app.
 *
 * Every signal here is keyed by `serverId:agentId` (`composerDraftKey`) or carries
 * its server in the value, which is what makes the shared lifetime safe.
 */
export function createStableConversationState(props: Pick<ConversationProps, "onTypingChange">) {
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [editingAgentId, setEditingAgentId] = createSignal<string | null>(null);
  const [editingServerId, setEditingServerId] = createSignal<string | null>(null);
  const [editingDeliveryId, setEditingDeliveryId] = createSignal<string | null>(null);
  const [editingDraftBackup, setEditingDraftBackup] = createSignal<ComposerDraft | null>(null);
  const [editingOriginalAttachmentIds, setEditingOriginalAttachmentIds] = createSignal<string[]>([]);
  const [composerFocusRequest, setComposerFocusRequest] = createSignal(0);
  const [conversationErrors, setConversationErrors] = createSignal<Record<string, string>>({});
  const [voicePhase, setVoicePhase] = createSignal<"idle" | "preparing" | "requesting" | "recording" | "transcribing">(
    "idle",
  );
  const [voiceModelProgress, setVoiceModelProgress] = createSignal<number | null>(null);
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = createSignal(0);
  const [browserPipBounds, setBrowserPipBounds] = createSignal<BrowserBounds | null>(readBrowserPipBounds());
  const [settingsPanelWidth, setSettingsPanelWidth] = createSignal(SETTINGS_PANEL_DEFAULT);
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(BROWSER_PANEL_DEFAULT);
  const resources: ConversationResources = {
    agentActivityPresentations: new Map(),
    browserOpenRequests: new Map(),
    importTargetAgents: new Map<string, { agentId: string; serverId: string }>(),
    seenMessageIds: new Set<string>(),
    typingIdleTimer: undefined,
    typingAgentId: null,
    voiceRecorder: undefined,
    voiceStream: undefined,
    voiceRecordingTimer: undefined,
    voiceElapsedTimer: undefined,
    voiceChunks: [],
    voiceAgentId: undefined,
    voiceServerId: undefined,
    voiceSubmitRequest: undefined,
    voiceDisposed: false,
    voiceRequestGeneration: 0,
    filePreviewRequestGeneration: 0,
    runtimeSettingsSaveTails: new Map(),
    runtimeSettingsAttempts: new Map(),
  };

  /**
   * "The user is not composing to that agent any more."
   *
   * It lives on the controller rather than in the view because three owners with
   * three different lifetimes have to be able to say it: the view, on the
   * transitions that unmount it; this controller, when the app goes away; and
   * `server-selection.tsx`, which has to say it *before* `servers.select()` so
   * the message reaches the server the user was typing on rather than the one
   * they are arriving at.
   */
  function stopComposerTyping(): void {
    if (resources.typingIdleTimer) clearTimeout(resources.typingIdleTimer);
    resources.typingIdleTimer = undefined;
    if (!resources.typingAgentId) return;
    props.onTypingChange(resources.typingAgentId, false);
    resources.typingAgentId = null;
  }

  onCleanup(() => {
    resources.voiceDisposed = true;
    if (resources.voiceRecordingTimer) clearTimeout(resources.voiceRecordingTimer);
    if (resources.voiceElapsedTimer) clearInterval(resources.voiceElapsedTimer);
    if (resources.voiceRecorder?.state === "recording") resources.voiceRecorder.stop();
    for (const track of resources.voiceStream?.getTracks() ?? []) track.stop();
    stopComposerTyping();
  });

  return {
    stopComposerTyping,
    drafts,
    setDrafts,
    editingAgentId,
    setEditingAgentId,
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
    conversationErrors,
    setConversationErrors,
    voicePhase,
    setVoicePhase,
    voiceModelProgress,
    setVoiceModelProgress,
    voiceElapsedSeconds,
    setVoiceElapsedSeconds,
    browserPipBounds,
    setBrowserPipBounds,
    settingsPanelWidth,
    setSettingsPanelWidth,
    browserPanelWidth,
    setBrowserPanelWidth,
    resources,
  };
}

/**
 * The half of the conversation surface that belongs to one server.
 *
 * These describe the workspace the user is looking at - which right panel is
 * open, what the browser address bar says, which message has its reaction picker
 * out, what the in-chat search found. `rightPanels` is the reason the split
 * exists: it is keyed by agent id alone, and agent ids repeat across servers, so a
 * shared owner would carry "the computer panel is open for chief" from one
 * server to the next and open the wrong panel on arrival.
 *
 * `attachmentBusy`, `composerError`, `submitting` and `selectionSending` are
 * here for the same reason by a different route: they carry no key at all. Each
 * describes the composer on screen right now - "a send is in flight", "this is
 * what went wrong" - so a shared owner would disable the arriving server's
 * composer for the length of the server it was left on, and show that server's
 * failure underneath it. What has to outlive the conversation goes in
 * `conversationErrors` instead, which is keyed and sits in the stable half.
 *
 * Created inside the keyed scope in `app-providers.tsx`, so a server switch
 * discards all of it by unmounting rather than by a list of setters.
 */
export function createServerConversationState() {
  const [showComposerActions, setShowComposerActions] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [selectionSending, setSelectionSending] = createSignal(false);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const [rightPanels, setRightPanels] = createSignal<Record<string, RightPanelMode>>({});
  const [settingsProvider, setSettingsProvider] = createSignal<AgentProviderId>("codex");
  const [settingsModel, setSettingsModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [settingsReasoning, setSettingsReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [browserAddressEditing, setBrowserAddressEditing] = createSignal(false);
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

  return {
    showComposerActions,
    setShowComposerActions,
    attachmentBusy,
    setAttachmentBusy,
    composerError,
    setComposerError,
    submitting,
    setSubmitting,
    selectionSending,
    setSelectionSending,
    markingRead,
    setMarkingRead,
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
  };
}

/**
 * Both halves under one owner, which is what a single-server caller wants:
 * `Conversation.stories.tsx` and the HMR test have no scope boundary to split
 * across, and `ConversationView` reads one flat object either way.
 */
export function createConversationController(props: Pick<ConversationProps, "onTypingChange">) {
  return { ...createStableConversationState(props), ...createServerConversationState() };
}
