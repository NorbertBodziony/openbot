import { ATTACHMENT_FILE_ACCEPT, IMAGE_ATTACHMENT_ACCEPT } from "@openbot/contracts/attachment-files";
import {
  attachmentReferenceIds,
  expandAttachmentReferences,
  removeAttachmentReferences,
} from "@openbot/contracts/attachment-references";
import { expandChatTagReferences } from "@openbot/contracts/chat-tag-references";
import type {
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentReasoningEffort,
  AgentStatus,
  AttachmentSummary,
  AvatarImageInput,
  BrowserBounds,
  BrowserControlState,
  BrowserPreview,
  BrowserTab,
  DraftAttachment,
  FilePreview,
  InstalledSkill,
  MessageReaction,
  ProviderRuntimeStatus,
  QueueDelivery,
  QueueSnapshot,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { VOICE_AUDIO_LIMITS } from "@openbot/contracts/ipc";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Loading,
  lazy,
  onCleanup,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js";
import { desktopAnalytics } from "../analytics";
import { agentConversationKey } from "../conversation-keys";
import type { BotMessage, BotProfile, ChatActionMarkerModel } from "../data";
import { activeQueueDeliveries, presentQueueDeliveries, queuedDeliveriesInOrder } from "../queue-reconciliation";
import { createScopeGuard } from "../scope-lifetime";
import { appendVoiceTranscript, recordingToWav } from "../voice-recording";
import { AgentAvatar } from "./AgentAvatar";
import { ComposerEditor, expandComposerMentions } from "./ComposerEditor";
import { BrowserTakeoverCard } from "./ConversationPrompts";
import {
  AgentActivityIndicator,
  type AgentActivityPresentation,
  nextAgentActivityPresentation,
  ThinkingDisclosure,
} from "./conversation/AgentActivity";
import type { AgentRuntimeSettings, AgentRuntimeSettingsPatch } from "./conversation/AgentSettingsPanel";
import { AttachmentCards, fileBadge, formatFileSize } from "./conversation/AttachmentCards";
import { attachmentReferenceTone } from "./conversation/AttachmentReference";
import { ChatActionMarker } from "./conversation/ChatActionMarker";
import { ChatSearch } from "./conversation/ChatSearch";
import {
  CloseIcon,
  ComputerIcon,
  MoreIcon,
  PlusIcon,
  RemoteDesktopIcon,
  StopIcon,
} from "./conversation/ConversationIcons";
import {
  clearChatSearchHighlights,
  findChatSearchMatches,
  renderChatSearchHighlights,
} from "./conversation/chat-search";
import { calculateChatScrollMargin, createChatVirtualizer } from "./conversation/createChatVirtualizer";
import { messageContentBlocks } from "./conversation/DataTable";
import { installedSkillsRequestKey } from "./conversation/installed-skills-source";
import { ScrollToLatestButton, scrollToLatestMessage } from "./conversation/MessageNavigation";
import { MessageActions, MessageBody } from "./conversation/MessageRendering";
import { RichMessageText } from "./conversation/RichMessageText";
import { MessageSelectionActions } from "./conversation/SelectionActions";
import {
  scrollToUnreadBoundary,
  UnreadMessagesBanner,
  UnreadMessagesDivider,
  unreadMessagesDividerIsVisible,
} from "./conversation/UnreadMessages";
import {
  formatVoiceDuration,
  voiceButtonLabel,
  voiceCaptureError,
  voiceTranscriptionError,
} from "./conversation/voice-status";
import { useConversationController } from "./conversation-controller-context";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  Bubble,
  BubbleContent,
  BubbleReactions,
  type BubbleVariant,
  Button,
  Dialog,
  DropdownMenu,
  File,
  Image,
  ImageRemoveButton,
  Input,
  LoaderCircle,
  Message,
  MessageContent,
  Mic,
  Puzzle,
} from "./ui";

const loadAgentSettingsPanel = () => import("./conversation/AgentSettingsPanel");
const AgentSettingsPanel = lazy(loadAgentSettingsPanel);
const BrowserPanel = lazy(() => import("./conversation/BrowserPanel"));
const FilePreviewPanel = lazy(() => import("./conversation/FilePreviewPanel"));
const QueuePanel = lazy(() => import("./conversation/QueuePanel").then((module) => ({ default: module.QueuePanel })));
const ApprovalCard = lazy(() => import("./ConversationPrompts").then((module) => ({ default: module.ApprovalCard })));
const QuestionPromptBubble = lazy(() =>
  import("./QuestionPromptBubble").then((module) => ({ default: module.QuestionPromptBubble })),
);

function conversationBubbleVariant(message: BotMessage): BubbleVariant {
  if (message.author === "you") return "secondary";
  if (message.imageGeneration || (!message.body.trim() && message.attachments?.length)) return "ghost";
  return messageContentBlocks(message.body, message.streaming === true).some((block) => block.type !== "text")
    ? "ghost"
    : "muted";
}

interface RenderedAgentActivity {
  activityId: string;
  bot: BotProfile | undefined;
  detail: string | null;
  phase: "active" | "exiting";
  presentation: AgentActivityPresentation;
}

interface BrowserTakeoverPreviewState {
  status: "idle" | "loading" | "ready" | "failed";
  preview: BrowserPreview | null;
}

interface BrowserTakeoverResolutionState {
  decision: "complete" | "cancel";
  tab: BrowserTab | undefined;
  preview: BrowserPreview | null;
  previewStatus: BrowserTakeoverPreviewState["status"];
  messageMarker: string | null;
}

interface RoutineSettingsRequest {
  botId: string;
  routineId: string;
  routineName: string;
  nonce: number;
}

function runtimeSettingsEqual(left: AgentRuntimeSettings, right: AgentRuntimeSettings): boolean {
  return (
    left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
  );
}

function isCompleteRuntimeSettingsPatch(updates: AgentRuntimeSettingsPatch): updates is AgentRuntimeSettings {
  return "provider" in updates && "model" in updates;
}

function canonicalBrowserUrl(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function rendererDuration(property: string, fallback: number): number {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value) || fallback;
  if (value.endsWith("s")) return (Number.parseFloat(value) || fallback / 1_000) * 1_000;
  return fallback;
}

function agentActivityExitDuration(): number {
  return rendererDuration("--openbot-duration-overlay", 240);
}

function agentActivityShowDelay(): number {
  return rendererDuration("--openbot-duration-fast", 120);
}

function agentActivityExitDelay(): number {
  return rendererDuration("--openbot-agent-activity-exit-delay", 500);
}

function followConversationBottom(element: HTMLDivElement): void {
  element.scrollTop = element.scrollHeight;
}

interface ConversationTarget {
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

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  replyToMessageId: null,
};

function copyComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    text: draft.text,
    attachments: [...draft.attachments],
    replyToMessageId: draft.replyToMessageId,
  };
}

function composerDraftKey(target: ConversationTarget): string {
  return target.serverId === "local" ? target.botId : `${target.serverId}:${target.botId}`;
}
const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;
const BROWSER_PANEL_DEFAULT_RATIO = 0.5;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;
function createConversationViewScope(props: ConversationProps) {
  const controller = useConversationController();
  const agentReady = () => props.agentStatus.phase === "ready";
  const {
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
  } = controller;
  const [routineSettingsRequest, setRoutineSettingsRequest] = createSignal<RoutineSettingsRequest | null>(null);
  const [installedSkills, setInstalledSkills] = createSignal<InstalledSkill[]>([]);
  const [installedSkillsRetry, setInstalledSkillsRetry] = createSignal(0);
  let installedSkillsRequest = 0;
  let installedSkillsSourceId: string | undefined;
  let failedInstalledSkillsAttempt: { serverId: string; sourceId: string; connectionSequence: number } | undefined;
  let routineSettingsRequestNonce = 0;
  let imageAttachmentPicker: HTMLInputElement | undefined;
  let contextAttachmentPicker: HTMLInputElement | undefined;
  const currentTarget = (): ConversationTarget | undefined => {
    const botId = props.bot?.id;
    return botId ? { botId, serverId: props.server?.id ?? "local" } : undefined;
  };
  const currentEditingDeliveryId = createMemo(() => {
    const target = currentTarget();
    return target && editingBotId() === target.botId && editingServerId() === target.serverId
      ? editingDeliveryId()
      : null;
  });
  const currentDraft = createMemo(() => {
    const target = currentTarget();
    return target ? (drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
  const currentConversationError = createMemo(() => {
    const target = currentTarget();
    return target ? (conversationErrors()[composerDraftKey(target)] ?? null) : null;
  });
  const installedSkillsSource = createMemo(() =>
    installedSkillsRequestKey(props.bot?.id, props.server, props.skillsMarketplaceOpen === true),
  );
  createEffect(
    () => `${props.server?.id ?? "local"}\0${props.server?.connectionSequence ?? 0}`,
    (source) => {
      const [serverId, connectionSequenceText] = source.split("\0");
      const failedAttempt = failedInstalledSkillsAttempt;
      if (
        failedAttempt?.serverId === serverId &&
        failedAttempt.sourceId === `${serverId}\0${untrack(() => props.bot?.id) ?? ""}` &&
        failedAttempt.connectionSequence !== Number(connectionSequenceText)
      ) {
        setInstalledSkillsRetry((retry) => retry + 1);
      }
    },
  );
  createEffect(
    () => `${installedSkillsSource()}\0${installedSkillsRetry()}`,
    (source) => {
      const request = ++installedSkillsRequest;
      const [serverId, botId, support, visibility] = source.split("\0");
      if (!botId) {
        installedSkillsSourceId = undefined;
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills([]);
        return;
      }
      if (visibility === "hidden") return;
      const sourceId = `${serverId}\0${botId}`;
      if (installedSkillsSourceId !== sourceId) {
        installedSkillsSourceId = sourceId;
        setInstalledSkills([]);
      }
      if (support === "unsupported") {
        failedInstalledSkillsAttempt = undefined;
        setInstalledSkills([]);
        return;
      }
      const connectionSequence = untrack(() => props.server?.connectionSequence) ?? 0;
      failedInstalledSkillsAttempt = undefined;
      void window.openbot.agent
        .listInstalledSkills(botId)
        .then((skills) => {
          if (request !== installedSkillsRequest) return;
          failedInstalledSkillsAttempt = undefined;
          setInstalledSkills(skills);
        })
        .catch(() => {
          if (request !== installedSkillsRequest) return;
          failedInstalledSkillsAttempt = { serverId, sourceId, connectionSequence };
          // Preserve an already loaded same-agent catalog when a refresh fails.
        });
    },
  );
  const unreferencedDraftAttachments = createMemo(() => {
    const referencedIds = attachmentReferenceIds(currentDraft().text);
    return currentDraft().attachments.filter((attachment) => !referencedIds.has(attachment.id));
  });
  const composerHasContent = createMemo(
    () => Boolean(currentDraft().text.trim()) || currentDraft().attachments.length > 0,
  );
  const replyTarget = createMemo(() => {
    const id = currentDraft().replyToMessageId;
    return id ? props.messages.find((message) => message.id === id) : undefined;
  });
  const activeRightPanel = createMemo<RightPanelMode>(() => {
    const botId = props.bot?.id;
    return botId ? (rightPanels()[botId] ?? "none") : "none";
  });
  const browserInteractionAvailable = () => props.browserEnabled !== false && !props.browserVisibilitySuspended;
  const browserSidebarOpen = () => browserInteractionAvailable() && activeRightPanel() === "browser";
  const browserPipOpen = () => browserInteractionAvailable() && activeRightPanel() === "browser-pip";
  const screenOpen = () => browserSidebarOpen() || browserPipOpen();
  const settingsOpen = () => activeRightPanel() === "settings";
  const filePreviewOpen = () =>
    activeRightPanel() === "file-preview" && sidebarFilePreview()?.ownerBotId === props.bot?.id;
  const browserTabs = createMemo(() => {
    if (props.browserEnabled === false) return [];
    const bot = props.bot;
    if (!bot) return [];
    return props.browserTabs.filter((tab) =>
      tab.ownerBotId ? tab.ownerBotId === bot.id : Boolean(bot.threadId && tab.ownerThreadId === bot.threadId),
    );
  });
  const closingBrowserTabIds = new Set<string>();
  createEffect(
    () => new Set(browserTabs().map((tab) => tab.id)),
    (visibleTabIds) => {
      for (const tabId of closingBrowserTabIds) {
        if (!visibleTabIds.has(tabId)) closingBrowserTabIds.delete(tabId);
      }
    },
  );
  createEffect(
    () => browserTabs().map((tab) => ({ id: tab.id, url: tab.url })),
    (tabs) => {
      const serverId = props.server?.id ?? "local";
      const botId = props.bot?.id ?? null;
      for (const [requestKey, request] of resources.browserOpenRequests) {
        if (request.serverId !== serverId || request.botId !== botId) continue;
        const tabAppeared = tabs.some(
          (tab) => canonicalBrowserUrl(tab.url) === request.url && !request.existingTabIds.has(tab.id),
        );
        if (tabAppeared) resources.browserOpenRequests.delete(requestKey);
      }
    },
  );
  const activeBrowserTab = createMemo(
    () => browserTabs().find((tab) => tab.id === props.activeBrowserTabId) ?? browserTabs()[0],
  );
  const browserTakeoverTab = createMemo(() => {
    const tabId = props.browserTakeover?.tabId;
    return tabId ? browserTabs().find((tab) => tab.id === tabId) : undefined;
  });
  const [browserTakeoverPreview, setBrowserTakeoverPreview] = createSignal<BrowserTakeoverPreviewState>({
    status: "idle",
    preview: null,
  });
  let browserTakeoverPreviewKey: string | null = null;
  let browserTakeoverPreviewGeneration = 0;
  createEffect(
    () => ({ request: props.browserTakeover, tab: browserTakeoverTab(), suspended: props.browserVisibilitySuspended }),
    ({ request, tab, suspended }) => {
      if (!request || suspended) {
        browserTakeoverPreviewKey = null;
        browserTakeoverPreviewGeneration += 1;
        setBrowserTakeoverPreview({ status: "idle", preview: null });
        return;
      }

      const requestKey = String(request.requestId);
      if (!tab) {
        if (browserTakeoverPreviewKey !== requestKey) {
          setBrowserTakeoverPreview({ status: "loading", preview: null });
        }
        return;
      }
      if (browserTakeoverPreviewKey === requestKey) return;

      browserTakeoverPreviewKey = requestKey;
      const generation = ++browserTakeoverPreviewGeneration;
      setBrowserTakeoverPreview({ status: "loading", preview: null });
      void window.openbot.browser
        .capturePreview(tab.id)
        .then((preview) => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "ready", preview });
        })
        .catch(() => {
          if (browserTakeoverPreviewGeneration !== generation) return;
          setBrowserTakeoverPreview({ status: "failed", preview: null });
        });
    },
  );
  const latestMessageMarker = createMemo(() => {
    const message = props.messages.at(-1);
    return message
      ? `${message.id}:${message.body.length}:${message.streaming === true ? "streaming" : "settled"}`
      : null;
  });
  const [browserTakeoverResolution, setBrowserTakeoverResolution] = createSignal<BrowserTakeoverResolutionState | null>(
    null,
  );
  createEffect(
    () => props.browserTakeover?.requestId,
    (requestId) => {
      if (requestId !== undefined) setBrowserTakeoverResolution(null);
    },
  );
  createEffect(latestMessageMarker, (messageMarker) => {
    const resolution = untrack(browserTakeoverResolution);
    if (resolution && resolution.messageMarker !== messageMarker) setBrowserTakeoverResolution(null);
  });
  const respondToBrowserTakeover = async (decision: "complete" | "cancel") => {
    const request = props.browserTakeover;
    if (!request) return false;
    const resolution = {
      decision,
      tab: browserTakeoverTab(),
      preview: browserTakeoverPreview().preview,
      previewStatus: browserTakeoverPreview().status,
      messageMarker: latestMessageMarker(),
    } satisfies BrowserTakeoverResolutionState;
    const completed = await props.onRespondToBrowserTakeover(decision);
    if (completed && latestMessageMarker() === resolution.messageMarker) setBrowserTakeoverResolution(resolution);
    return completed;
  };
  let previousBrowserTabCount = 0;
  createEffect(
    () => ({ count: browserTabs().length, open: screenOpen() }),
    ({ count, open }) => {
      if (props.browserEnabled === false) return;
      const browserWasClosed = open && previousBrowserTabCount > 0 && count === 0;
      previousBrowserTabCount = count;
      if (browserWasClosed) hideBrowserPanel();
    },
  );
  const activeBrowserControl = createMemo(() => {
    if (props.browserEnabled === false) return undefined;
    const sessions = props.browserControlState.sessions;
    const activeTab = activeBrowserTab();
    const forActiveTab = activeTab?.ownerThreadId
      ? sessions.filter((session) => session.threadId === activeTab.ownerThreadId)
      : [];
    const forActiveBot = props.bot?.threadId
      ? sessions.filter((session) => session.threadId === props.bot?.threadId)
      : [];
    const candidates = forActiveTab.length > 0 ? forActiveTab : forActiveBot;
    return (
      [...candidates]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .find((session) => session.phase === "acting") ?? candidates.at(-1)
    );
  });
  const actingBrowserControl = createMemo(() => {
    const control = activeBrowserControl();
    return control?.phase === "acting" ? control : undefined;
  });
  const browserControlBot = createMemo(() => {
    const control = activeBrowserControl();
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = props.browserControlState.sessions.filter(
      (session) =>
        session.tabId === tab.id ||
        (session.tabId === null && tab.id === activeBrowserTab()?.id && session.threadId === tab.ownerThreadId),
    );
    const newestFirst = [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    return newestFirst.find((session) => session.phase === "acting") ?? newestFirst[0];
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  };
  const activeDeliveries = createMemo(() => activeQueueDeliveries(props.queue, props.activeTurnId));
  const [renderedAgentActivity, setRenderedAgentActivity] = createSignal<RenderedAgentActivity | null>(null);
  const [agentActivitySpaceReserved, setAgentActivitySpaceReserved] = createSignal(false);
  const streamingAgentMessage = createMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if (message?.author === "bot" && message.streaming) return message;
    }
    return null;
  });
  const activeActivityId = createMemo(() => {
    const botId = props.bot?.id;
    if (!botId) return null;
    const delivery = activeDeliveries()[0];
    if (delivery) return `${botId}:delivery:${delivery.id}`;
    if (props.activeTurnId) return `${botId}:turn:${props.activeTurnId}`;
    const streamingMessage = streamingAgentMessage();
    if (!streamingMessage) return null;
    const current = untrack(renderedAgentActivity);
    if (current?.bot?.id === botId) return current.activityId;
    return `${botId}:message:${streamingMessage.id}`;
  });
  /* Reasoning belongs in the thinking trace, which shows it in full. The status line carries only
     what the provider reports about the step it is on. */
  const activeActivityDetail = createMemo(() => props.activityDetail?.trim() || null);
  const agentActivity = createMemo<"Working" | null>(() => (activeActivityId() ? "Working" : null));
  const activityPresentation = createMemo<AgentActivityPresentation | null>(() => {
    const botId = props.bot?.id;
    const activityId = activeActivityId();
    if (!botId || !activityId) return null;
    const previous = resources.agentActivityPresentations.get(botId);
    if (previous?.activityId === activityId) return previous.presentation;
    const presentation = nextAgentActivityPresentation(previous?.presentation);
    resources.agentActivityPresentations.set(botId, { activityId, presentation });
    return presentation;
  });
  let agentActivityShowTimer: number | undefined;
  let agentActivityExitDelayTimer: number | undefined;
  let agentActivityExitTimer: number | undefined;
  const clearAgentActivityShowTimer = () => {
    if (agentActivityShowTimer === undefined) return;
    window.clearTimeout(agentActivityShowTimer);
    agentActivityShowTimer = undefined;
  };
  const clearAgentActivityExitTimer = () => {
    if (agentActivityExitTimer === undefined) return;
    window.clearTimeout(agentActivityExitTimer);
    agentActivityExitTimer = undefined;
  };
  const clearAgentActivityExitDelayTimer = () => {
    if (agentActivityExitDelayTimer === undefined) return;
    window.clearTimeout(agentActivityExitDelayTimer);
    agentActivityExitDelayTimer = undefined;
  };
  createEffect(
    () => ({
      activityId: activeActivityId(),
      bot: props.bot,
      presentation: activityPresentation(),
    }),
    ({ activityId, bot, presentation }) => {
      clearAgentActivityShowTimer();
      clearAgentActivityExitDelayTimer();
      clearAgentActivityExitTimer();
      if (activityId && presentation) {
        const nextActivity = {
          activityId,
          bot,
          detail: untrack(activeActivityDetail),
          phase: "active" as const,
          presentation,
        };
        const current = untrack(renderedAgentActivity);
        if (current?.bot?.id === bot?.id) {
          setAgentActivitySpaceReserved(true);
          setRenderedAgentActivity(nextActivity);
          return;
        }
        const showDelay = agentActivityShowDelay();
        agentActivityShowTimer = window.setTimeout(() => {
          agentActivityShowTimer = undefined;
          if (untrack(activeActivityId) === activityId) {
            setAgentActivitySpaceReserved(true);
            setRenderedAgentActivity({ ...nextActivity, detail: untrack(activeActivityDetail) });
          }
        }, showDelay);
        return;
      }

      const current = untrack(renderedAgentActivity);
      if (!current) return;
      if (current.bot?.id !== bot?.id) {
        setRenderedAgentActivity(null);
        return;
      }

      const exitActivityId = current.activityId;
      const beginExit = () => {
        agentActivityExitDelayTimer = undefined;
        if (untrack(activeActivityId)) return;
        setRenderedAgentActivity((latest) =>
          latest?.activityId === exitActivityId ? { ...latest, phase: "exiting" } : latest,
        );
        const exitDuration = agentActivityExitDuration();
        agentActivityExitTimer = window.setTimeout(() => {
          agentActivityExitTimer = undefined;
          setRenderedAgentActivity((latest) =>
            latest?.activityId === exitActivityId && latest.phase === "exiting" ? null : latest,
          );
        }, exitDuration);
      };
      const exitDelay = agentActivityExitDelay();
      if (exitDelay === 0) beginExit();
      else agentActivityExitDelayTimer = window.setTimeout(beginExit, exitDelay);
    },
  );

  createEffect(
    () => ({ activityId: activeActivityId(), detail: activeActivityDetail() }),
    ({ activityId, detail }) => {
      if (!activityId) return;
      setRenderedAgentActivity((current) =>
        current?.activityId === activityId && current.detail !== detail ? { ...current, detail } : current,
      );
    },
  );

  createEffect(
    () => {
      const tabId = props.browserTakeover?.tabId;
      return {
        tabId,
        tabExists: Boolean(tabId && browserTabs().some((tab) => tab.id === tabId)),
        activeTabId: props.activeBrowserTabId,
        activateTab: activateBrowserTab,
      };
    },
    ({ tabId, tabExists, activeTabId, activateTab }) => {
      if (!tabId || !tabExists) return;
      setActiveRightPanel("browser");
      if (activeTabId !== tabId) activateTab(tabId);
    },
  );
  onCleanup(() => {
    clearAgentActivityShowTimer();
    clearAgentActivityExitDelayTimer();
    clearAgentActivityExitTimer();
  });
  const orderedQueuedDeliveries = createMemo(() => queuedDeliveriesInOrder(props.queue));
  const presentedQueueDeliveries = createMemo(() =>
    presentQueueDeliveries({
      snapshot: props.queue,
      activeTurnId: props.activeTurnId,
      renderedMessageIds: new Set(props.messages.map((message) => message.id)),
    }),
  );
  const [renderedQueueDeliveries, setRenderedQueueDeliveries] = createSignal<QueueDelivery[]>([]);
  const queuePanelVisible = createMemo(() => renderedQueueDeliveries().length > 0);
  let queueExitTimer: number | undefined;
  createEffect(
    () => presentedQueueDeliveries(),
    (deliveries) => {
      if (queueExitTimer !== undefined) {
        window.clearTimeout(queueExitTimer);
        queueExitTimer = undefined;
      }
      if (deliveries.length > 0) {
        setRenderedQueueDeliveries(deliveries);
        return;
      }
      if (untrack(renderedQueueDeliveries).length === 0) return;
      queueExitTimer = window.setTimeout(() => {
        queueExitTimer = undefined;
        if (untrack(presentedQueueDeliveries).length === 0) setRenderedQueueDeliveries([]);
      }, agentActivityExitDuration());
    },
  );
  onCleanup(() => {
    if (queueExitTimer !== undefined) window.clearTimeout(queueExitTimer);
  });
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [showScrollToLatest, setShowScrollToLatest] = createSignal(false);
  const [unreadDividerVisible, setUnreadDividerVisible] = createSignal(false);
  const [virtualScrollMargin, setVirtualScrollMargin] = createSignal(0);
  let scrollElement: HTMLDivElement | undefined;
  let virtualRoot: HTMLDivElement | undefined;
  let agentActivitySlot: HTMLDivElement | undefined;
  let scrollResizeObserver: ResizeObserver | undefined;
  let unreadMessagesDivider: HTMLDivElement | undefined;
  let unreadVisibilityFrame: number | undefined;
  let latestScrollFrame: number | undefined;
  let latestScrollSettleFrame: number | undefined;
  let currentUnreadCount = 0;
  let conversationPanel: HTMLElement | undefined;
  let browserSurface: HTMLDivElement | undefined;
  let browserResizeObserver: ResizeObserver | undefined;
  let browserWindowResizeHandler: (() => void) | undefined;
  let browserVisibilityFrame: number | undefined;
  let browserBoundsFrame: number | undefined;
  let browserVisibilityGeneration = 0;
  let chatSearchInput: HTMLInputElement | undefined;
  let chatSearchReturnFocus: HTMLElement | undefined;
  let chatSearchFrame: number | undefined;
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSearchRequest = 0;
  let lastChatSearchQuery = "";
  let stickToLatest = true;
  let lastConversationIdentity: string | undefined;
  let lastPanelBotId: string | undefined;
  let lastHandledSettingsRequestNonce: number | undefined;
  let lastHandledMessageFocusNonce: number | undefined;
  let lastRuntimeSettingsSignature: string | undefined;
  const messageVirtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: () => props.messages.length,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => 128,
    getItemKey: (index) => props.messages[index]?.id ?? index,
    keyVersion: () => `${props.messages[0]?.id ?? ""}:${props.messages.at(-1)?.id ?? ""}`,
    scrollMargin: virtualScrollMargin,
    onChange: (instance) => {
      const first = instance.getVirtualItems()[0];
      if (first && first.index <= 5 && props.hasOlder && !props.loadingOlder) props.onLoadOlder?.();
    },
  });
  function openChatSearch(): void {
    if (!chatSearchOpen() && document.activeElement instanceof HTMLElement) {
      chatSearchReturnFocus = document.activeElement;
    }
    setChatSearchOpen(true);
    requestAnimationFrame(() => {
      chatSearchInput?.focus();
      chatSearchInput?.select();
    });
  }

  function closeChatSearch(restoreFocus = true): void {
    setChatSearchOpen(false);
    setChatSearchQuery("");
    setChatSearchMatches([]);
    setChatSearchMessageIds([]);
    setChatSearchTotal(0);
    setActiveChatSearchIndex(-1);
    clearChatSearchHighlights();
    const returnFocus = chatSearchReturnFocus;
    if (restoreFocus && returnFocus?.isConnected) {
      requestAnimationFrame(() => returnFocus.focus());
    }
    chatSearchReturnFocus = undefined;
  }

  function moveChatSearch(direction: 1 | -1): void {
    const remoteIds = chatSearchMessageIds();
    const total = props.onSearchMessages ? remoteIds.length : chatSearchMatches().length;
    if (total === 0) return;
    setActiveChatSearchIndex((current) => {
      const next = (current + direction + total) % total;
      if (props.onSearchMessages) {
        const messageId = remoteIds[next];
        if (messageId) void props.onOpenSearchMessage?.(messageId);
      }
      return next;
    });
  }

  function handleChatSearchShortcut(event: KeyboardEvent): void {
    const primaryModifier = event.metaKey || event.ctrlKey;
    const key = event.key.toLocaleLowerCase();
    if (primaryModifier && !event.altKey && !event.shiftKey && key === "f") {
      event.preventDefault();
      event.stopPropagation();
      openChatSearch();
      return;
    }
    if (!chatSearchOpen() || !primaryModifier || event.altKey || key !== "g") return;
    event.preventDefault();
    event.stopPropagation();
    moveChatSearch(event.shiftKey ? -1 : 1);
  }

  async function saveBotPatch(updates: Omit<UpdateBotInput, "botId">, targetBotId = props.bot?.id): Promise<boolean> {
    const botId = targetBotId;
    if (!botId) return false;
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch {
      return false;
    }
  }

  async function saveRuntimeSettings(
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
    errorMessage: string | null,
    targetBotId = props.bot?.id,
  ): Promise<boolean> {
    const botId = targetBotId;
    if (!botId) return false;
    // Both maps live on the controller, which outlives one server, so the key
    // has to say which server the settings belong to.
    const settingsKey = agentConversationKey(props.server?.id ?? "local", botId);
    const previousAttempt = resources.runtimeSettingsAttempts.get(settingsKey);
    const generation = (previousAttempt?.generation ?? 0) + 1;
    resources.runtimeSettingsAttempts.set(settingsKey, { generation, pending: true, settings });
    if (errorMessage) setComposerError(null);

    const previousSave = resources.runtimeSettingsSaveTails.get(settingsKey);
    let releaseSave!: (baseValid: boolean) => void;
    const saveTail = new Promise<boolean>((resolve) => {
      releaseSave = resolve;
    });
    resources.runtimeSettingsSaveTails.set(settingsKey, saveTail);
    let saved: boolean;
    let baseValid = true;
    let abandoned = false;
    try {
      if (previousSave) baseValid = await previousSave;
      // `agent.updateBot` is routed by the server main has selected, not by the
      // bot id in its payload, so a save still queued behind an earlier one when
      // the user leaves would be applied to whichever server they arrive at. It
      // belongs to the one it was made on, and that one is gone.
      abandoned = !viewIsMounted();
      const completePatch = isCompleteRuntimeSettingsPatch(updates);
      saved = !abandoned && (baseValid || completePatch) ? await saveBotPatch(updates, botId) : false;
      if (completePatch) baseValid = saved;
    } finally {
      releaseSave(baseValid);
      if (resources.runtimeSettingsSaveTails.get(settingsKey) === saveTail) {
        resources.runtimeSettingsSaveTails.delete(settingsKey);
      }
    }
    const latestAttempt = resources.runtimeSettingsAttempts.get(settingsKey);
    if (latestAttempt?.generation !== generation) return true;
    latestAttempt.pending = false;
    // Nothing left to report to: the pickers, the composer error and the bot
    // this would roll back to all belonged to the conversation that is gone.
    if (abandoned) return false;
    if (saved) {
      const activeBot = props.bot;
      if (activeBot?.id === botId) {
        setSettingsProvider(activeBot.provider);
        setSettingsModel(activeBot.model);
        setSettingsReasoning(activeBot.reasoningEffort);
      }
      return true;
    }

    const activeBot = props.bot;
    const currentSettings = {
      provider: settingsProvider(),
      model: settingsModel(),
      reasoningEffort: settingsReasoning(),
    };
    if (activeBot?.id !== botId || !runtimeSettingsEqual(currentSettings, settings)) return false;
    setSettingsProvider(activeBot.provider);
    setSettingsModel(activeBot.model);
    setSettingsReasoning(activeBot.reasoningEffort);
    if (errorMessage) setComposerError(errorMessage);
    return false;
  }

  async function updateRuntimeSettings(
    botId: string,
    settings: AgentRuntimeSettings,
    updates: AgentRuntimeSettingsPatch,
  ): Promise<boolean> {
    if (props.bot?.id === botId) {
      setSettingsProvider(settings.provider);
      setSettingsModel(settings.model);
      setSettingsReasoning(settings.reasoningEffort);
    }
    return saveRuntimeSettings(settings, updates, null, botId);
  }

  async function selectModel(
    model: AgentModelId,
    provider: AgentProviderId,
    persist = true,
    reportComposerError = false,
  ): Promise<boolean> {
    const option = props.modelOptions.find((candidate) => candidate.provider === provider && candidate.id === model);
    if (!option) return false;
    const reasoningEffort = option.supportedReasoningEfforts.includes(settingsReasoning())
      ? settingsReasoning()
      : option.defaultReasoningEffort;
    setSettingsProvider(provider);
    setSettingsModel(model);
    setSettingsReasoning(reasoningEffort);
    if (!persist) return true;
    return saveRuntimeSettings(
      { provider, model, reasoningEffort },
      { provider, model, reasoningEffort },
      reportComposerError ? "Could not change model. Try again." : null,
    );
  }

  async function selectAndConfirmModel(model: AgentModelId, provider: AgentProviderId): Promise<void> {
    await selectModel(model, provider, true, true);
  }

  async function selectAndConfirmReasoning(effort: AgentReasoningEffort): Promise<void> {
    const option = props.modelOptions.find(
      (candidate) => candidate.provider === settingsProvider() && candidate.id === settingsModel(),
    );
    if (!option?.supportedReasoningEfforts.includes(effort)) return;
    const settings = {
      provider: settingsProvider(),
      model: settingsModel(),
      reasoningEffort: effort,
    };
    setSettingsReasoning(effort);
    await saveRuntimeSettings(settings, { reasoningEffort: effort }, "Could not change effort. Try again.");
  }

  function updateScrollFade(element = scrollElement) {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFadeAtTop(element.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
    setShowScrollToLatest(remaining > 80);
  }

  function updateVirtualScrollMargin(): void {
    setVirtualScrollMargin(calculateChatScrollMargin(scrollElement, virtualRoot));
  }

  function updateUnreadDividerVisibility(): void {
    setUnreadDividerVisible(
      Boolean(
        currentUnreadCount > 0 &&
          scrollElement &&
          unreadMessagesDivider &&
          unreadMessagesDividerIsVisible(scrollElement, unreadMessagesDivider),
      ),
    );
  }

  function scheduleUnreadDividerVisibilityUpdate(): void {
    if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
    unreadVisibilityFrame = requestAnimationFrame(() => {
      unreadVisibilityFrame = undefined;
      updateUnreadDividerVisibility();
    });
  }

  const markMessageSeen = (messageId: string): boolean => {
    const key = `${props.bot?.id ?? "none"}:${messageId}`;
    if (resources.seenMessageIds.has(key)) return false;
    resources.seenMessageIds.add(key);
    return true;
  };

  const updateCurrentDraft = (patch: Partial<ComposerDraft>) => {
    const target = currentTarget();
    if (!target) return;
    clearConversationError(target);
    const key = composerDraftKey(target);
    setDrafts((current) => ({
      ...current,
      [key]: { ...(current[key] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  function clearSubmittedDraft(target: ConversationTarget, submitted: ComposerDraft): void {
    const key = composerDraftKey(target);
    const submittedAttachmentIds = new Set(submitted.attachments.map((attachment) => attachment.id));
    setDrafts((current) => {
      const draft = current[key] ?? EMPTY_DRAFT;
      const next: ComposerDraft = {
        text: draft.text === submitted.text ? "" : draft.text,
        attachments: draft.attachments.filter((attachment) => !submittedAttachmentIds.has(attachment.id)),
        replyToMessageId: draft.replyToMessageId === submitted.replyToMessageId ? null : draft.replyToMessageId,
      };
      return { ...current, [key]: next };
    });
  }

  function clearConversationError(target: ConversationTarget): void {
    const key = composerDraftKey(target);
    setConversationErrors((current) => {
      const { [key]: _removed, ...next } = current;
      return next;
    });
  }

  function setConversationError(target: ConversationTarget, message: string): void {
    setConversationErrors((current) => ({
      ...current,
      [composerDraftKey(target)]: message,
    }));
  }

  function restoreVoiceTranscript(target: ConversationTarget, transcript: string): void {
    const key = composerDraftKey(target);
    setDrafts((current) => {
      const draft = current[key] ?? EMPTY_DRAFT;
      return {
        ...current,
        [key]: { ...draft, text: appendVoiceTranscript(draft.text, transcript) },
      };
    });
  }

  /**
   * "Is the conversation that asked for the microphone still on screen?"
   *
   * The controller outlives this view - drafts and an in-flight voice send are
   * expected to survive leaving the conversation - so `voiceDisposed` no longer
   * answers this. Without it, a model download that finishes after the user has
   * switched servers or opened a direct message goes on to open the microphone
   * with nothing on screen to stop it.
   */
  const viewIsMounted = createScopeGuard();

  async function startVoiceRecording(): Promise<void> {
    const botId = props.bot?.id;
    const serverId = props.server?.id ?? "local";
    if (!botId || voicePhase() !== "idle") return;
    const target = { botId, serverId };
    clearConversationError(target);
    resources.voiceSubmitRequest = undefined;
    setComposerError(null);
    // Which attempt this is. The phase used to carry that on its own, but it no
    // longer can: leaving the conversation now returns the phase to `idle`
    // (see `Conversation.tsx`) so the next conversation is not left with a
    // disabled microphone, and a later attempt can be in the very same phase
    // this one was abandoned in. The counter is what tells the two apart, so an
    // abandoned chain can still report its failure to the conversation that
    // asked for it without moving a phase that now belongs to someone else.
    const generation = ++resources.voiceRequestGeneration;
    setVoicePhase("preparing");
    setVoiceModelProgress(0);
    try {
      const modelStatus = await window.openbot.voice.prepareModel();
      if (resources.voiceDisposed || resources.voiceRequestGeneration !== generation) return;
      if (modelStatus.phase !== "ready") {
        setVoicePhase("idle");
        setVoiceModelProgress(null);
        setConversationError(target, modelStatus.message ?? "Could not prepare the voice model.");
        return;
      }
      if (!viewIsMounted()) {
        // A model *failure* still reports above, because it belongs to the
        // conversation that asked for it whether or not that conversation is
        // still open. Opening the microphone does not: there would be no
        // recording UI, and nothing to stop it before the duration limit.
        setVoicePhase("idle");
        setVoiceModelProgress(null);
        return;
      }
      setVoicePhase("requesting");
      setVoiceModelProgress(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (resources.voiceDisposed || !viewIsMounted() || resources.voiceRequestGeneration !== generation) {
        for (const track of stream.getTracks()) track.stop();
        // Permission can be granted after the conversation is gone. Nothing else
        // has moved the phase on in that case, so this leaves it idle rather than
        // stuck on a request that will never produce a recording - but only while
        // this is still the newest attempt, so a grant the user has stopped
        // waiting for cannot cancel the recording they started instead.
        if (!resources.voiceDisposed && resources.voiceRequestGeneration === generation) setVoicePhase("idle");
        return;
      }
      const recorder = new MediaRecorder(stream);
      resources.voiceStream = stream;
      resources.voiceRecorder = recorder;
      resources.voiceBotId = botId;
      resources.voiceServerId = serverId;
      resources.voiceChunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) resources.voiceChunks.push(event.data);
      });
      recorder.addEventListener("stop", () => void finishVoiceRecording(recorder.mimeType));
      recorder.start();
      startVoiceElapsedTimer();
      setVoicePhase("recording");
      resources.voiceRecordingTimer = setTimeout(stopVoiceRecording, VOICE_AUDIO_LIMITS.maximumSeconds * 1_000);
    } catch (error) {
      // The failure belongs to `target` whether or not that conversation is
      // still open, but the phase belongs to whoever asked last.
      if (resources.voiceRequestGeneration === generation) setVoicePhase("idle");
      setConversationError(target, voiceCaptureError(error));
    }
  }

  const removeVoiceModelListener = window.openbot.voice.onModelStatus((status) => {
    if (voicePhase() !== "preparing") return;
    setVoiceModelProgress(status.progress);
  });
  onCleanup(removeVoiceModelListener);

  function stopVoiceRecording(): void {
    if (voicePhase() !== "recording" || !resources.voiceRecorder) return;
    setVoicePhase("transcribing");
    stopVoiceElapsedTimer();
    if (resources.voiceRecordingTimer) clearTimeout(resources.voiceRecordingTimer);
    resources.voiceRecordingTimer = undefined;
    resources.voiceRecorder.stop();
    stopVoiceStream();
  }

  async function finishVoiceRecording(mimeType: string): Promise<void> {
    const targetBotId = resources.voiceBotId;
    const targetServerId = resources.voiceServerId;
    const chunks = resources.voiceChunks;
    const submitRequest = resources.voiceSubmitRequest;
    resources.voiceRecorder = undefined;
    resources.voiceBotId = undefined;
    resources.voiceServerId = undefined;
    resources.voiceChunks = [];
    resources.voiceSubmitRequest = undefined;
    if (!targetBotId || !targetServerId || resources.voiceDisposed) return;
    const analytics = desktopAnalytics.scope();
    const audioDurationSeconds = voiceElapsedSeconds();
    const startedAt = performance.now();
    try {
      if (chunks.length === 0) throw new Error("No speech was recorded.");
      const audio = await recordingToWav(new Blob(chunks, { type: mimeType }));
      const result = await window.openbot.voice.transcribe({ audio });
      if (!result.text.trim()) throw new Error("No speech was detected.");
      analytics.track("voice_transcription", {
        result: "succeeded",
        audio_duration_seconds: audioDurationSeconds,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      if (resources.voiceDisposed) return;
      const recordingTarget = { botId: targetBotId, serverId: targetServerId };
      clearConversationError(recordingTarget);
      const draft = submitRequest?.draft ?? drafts()[composerDraftKey(recordingTarget)] ?? EMPTY_DRAFT;
      const transcribedDraft = { ...draft, text: appendVoiceTranscript(draft.text, result.text) };
      if (submitRequest) {
        const target = { botId: submitRequest.botId, serverId: submitRequest.serverId };
        let delivered: boolean;
        if (submitRequest.queuedEdit) {
          delivered = await saveQueuedMessageEdit(
            transcribedDraft,
            {
              ...target,
              ...submitRequest.queuedEdit,
            },
            submitRequest.draft,
          );
        } else {
          delivered = await submitMessage(transcribedDraft, target, submitRequest.draft);
        }
        if (!delivered) restoreVoiceTranscript(target, result.text);
      } else {
        const key = composerDraftKey(recordingTarget);
        setDrafts((current) => ({ ...current, [key]: transcribedDraft }));
        if (props.bot?.id === targetBotId && (props.server?.id ?? "local") === targetServerId) {
          setComposerFocusRequest((current) => current + 1);
        }
      }
    } catch (error) {
      analytics.track("voice_transcription", {
        result: "failed",
        audio_duration_seconds: audioDurationSeconds,
        duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        failure_code: "transcription_failed",
      });
      if (!resources.voiceDisposed) {
        const target = { botId: targetBotId, serverId: targetServerId };
        setConversationErrors((current) => ({
          ...current,
          [composerDraftKey(target)]: voiceTranscriptionError(error),
        }));
      }
    } finally {
      if (!resources.voiceDisposed) setVoicePhase("idle");
    }
  }

  function stopVoiceStream(): void {
    for (const track of resources.voiceStream?.getTracks() ?? []) track.stop();
    resources.voiceStream = undefined;
  }

  function startVoiceElapsedTimer(): void {
    stopVoiceElapsedTimer();
    const startedAt = Date.now();
    setVoiceElapsedSeconds(0);
    resources.voiceElapsedTimer = setInterval(() => {
      setVoiceElapsedSeconds(Math.min(VOICE_AUDIO_LIMITS.maximumSeconds, Math.floor((Date.now() - startedAt) / 1_000)));
    }, 250);
  }

  function stopVoiceElapsedTimer(): void {
    if (resources.voiceElapsedTimer) clearInterval(resources.voiceElapsedTimer);
    resources.voiceElapsedTimer = undefined;
  }

  onSettled(() => {
    const unsubscribeImport = window.openbot.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        const target = currentTarget();
        if (target?.serverId === event.serverId) {
          resources.importTargetBots.set(event.requestId, target);
          clearConversationError(target);
        }
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        const target = resources.importTargetBots.get(event.requestId);
        resources.importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        if (target) {
          setConversationErrors((current) => ({
            ...current,
            [composerDraftKey(target)]: event.message,
          }));
        }
      } else {
        setAttachmentBusy(false);
        const target = resources.importTargetBots.get(event.requestId);
        resources.importTargetBots.delete(event.requestId);
        if (target) {
          addAttachments(event.attachments, target);
        } else {
          for (const attachment of event.attachments) {
            void window.openbot.agent.discardDraftAttachment(attachment.id, event.serverId);
          }
        }
      }
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (chatSearchOpen()) {
        event.preventDefault();
        closeChatSearch();
        return;
      }
      if (currentEditingDeliveryId()) {
        cancelQueuedMessageEdit();
        return;
      }
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
      hideBrowserPanel();
      setMediaPreview(null);
    };
    const closeActiveRemoteBrowserTab = (event: KeyboardEvent) => {
      if (
        props.server?.kind !== "remote" ||
        !screenOpen() ||
        props.browserVisibilitySuspended ||
        event.key.toLowerCase() !== "w" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.altKey ||
        event.shiftKey
      ) {
        return;
      }
      const tab = activeBrowserTab();
      if (!tab) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeBrowserTab(tab.id);
    };
    const closeMessageMenus = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".message-actions")) return;
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
    };
    const keyboardTarget = conversationPanel?.ownerDocument ?? document;
    const keyboardWindow = keyboardTarget.defaultView ?? window;
    keyboardTarget.addEventListener("keydown", closeOnEscape);
    keyboardWindow.addEventListener("keydown", closeActiveRemoteBrowserTab);
    keyboardTarget.addEventListener("keydown", handleChatSearchShortcut);
    window.addEventListener("pointerdown", closeMessageMenus);
    scrollResizeObserver = new ResizeObserver(() => {
      updateVirtualScrollMargin();
      if (scrollElement && stickToLatest) followConversationBottom(scrollElement);
      updateScrollFade();
      updateUnreadDividerVisibility();
    });
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    if (virtualRoot) scrollResizeObserver.observe(virtualRoot);
    if (agentActivitySlot) scrollResizeObserver.observe(agentActivitySlot);
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      updateVirtualScrollMargin();
      if (stickToLatest) scrollElement.scrollTop = scrollElement.scrollHeight;
      updateScrollFade(scrollElement);
      updateUnreadDividerVisibility();
    });
    return () => {
      if (unreadVisibilityFrame !== undefined) cancelAnimationFrame(unreadVisibilityFrame);
      scrollResizeObserver?.disconnect();
      scrollResizeObserver = undefined;
      unsubscribeImport();
      keyboardTarget.removeEventListener("keydown", closeOnEscape);
      keyboardWindow.removeEventListener("keydown", closeActiveRemoteBrowserTab);
      keyboardTarget.removeEventListener("keydown", handleChatSearchShortcut);
      window.removeEventListener("pointerdown", closeMessageMenus);
    };
  });

  createEffect(
    () => ({
      open: chatSearchOpen(),
      query: chatSearchQuery(),
      messageSignature: props.messages
        .map((message) => `${message.id}:${message.body}:${message.items?.join("\u0000") ?? ""}`)
        .join("\u0001"),
      remoteMessageIds: chatSearchMessageIds(),
      activeRemoteIndex: activeChatSearchIndex(),
    }),
    ({ open, query, remoteMessageIds, activeRemoteIndex }) => {
      if (chatSearchFrame !== undefined) cancelAnimationFrame(chatSearchFrame);
      if (chatSearchTimer !== undefined) clearTimeout(chatSearchTimer);
      const queryChanged = query !== lastChatSearchQuery;
      lastChatSearchQuery = query;
      if (!open || !query.trim()) {
        setChatSearchMatches([]);
        if (remoteMessageIds.length > 0) setChatSearchMessageIds([]);
        setChatSearchTotal(0);
        setActiveChatSearchIndex(-1);
        clearChatSearchHighlights();
        return;
      }
      if (props.onSearchMessages) {
        if (queryChanged) {
          const request = ++chatSearchRequest;
          chatSearchTimer = setTimeout(() => {
            void props
              .onSearchMessages?.(query)
              .then((result) => {
                if (request !== chatSearchRequest) return;
                setChatSearchMessageIds(result.messageIds);
                setChatSearchTotal(result.total);
                const index = result.messageIds.length > 0 ? 0 : -1;
                setActiveChatSearchIndex(index);
                const messageId = result.messageIds[index];
                if (messageId) void props.onOpenSearchMessage?.(messageId);
              })
              .catch(() => {
                if (request !== chatSearchRequest) return;
                setChatSearchMessageIds([]);
                setChatSearchTotal(0);
                setActiveChatSearchIndex(-1);
              });
          }, 150);
        }
        const activeMessageId = remoteMessageIds[activeRemoteIndex];
        chatSearchFrame = requestAnimationFrame(() => {
          chatSearchFrame = undefined;
          if (!scrollElement || !activeMessageId) return;
          const matches = findChatSearchMatches(scrollElement, query).filter(
            (match) => match.message.dataset.chatSearchMessage === activeMessageId,
          );
          setChatSearchMatches(matches);
        });
        return;
      }
      chatSearchFrame = requestAnimationFrame(() => {
        chatSearchFrame = undefined;
        if (!scrollElement) return;
        const matches = findChatSearchMatches(scrollElement, query);
        setChatSearchMatches(matches);
        setActiveChatSearchIndex((current) => {
          if (matches.length === 0) return -1;
          if (queryChanged || current < 0) return 0;
          return Math.min(current, matches.length - 1);
        });
      });
    },
  );

  createEffect(
    () => ({
      request: props.messageFocusRequest,
      botId: props.bot?.id,
      loaded: props.loaded,
      messageIds: props.messages.map((message) => message.id).join("\u0000"),
    }),
    ({ request, botId, loaded }) => {
      if (!request || request.botId !== botId || !loaded || request.nonce === lastHandledMessageFocusNonce) return;
      requestAnimationFrame(() => {
        const target = scrollElement?.querySelector<HTMLElement>(
          `[data-chat-search-message="${CSS.escape(request.messageId)}"]`,
        );
        if (!target) return;
        lastHandledMessageFocusNonce = request.nonce;
        stickToLatest = false;
        target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
      });
    },
  );

  createEffect(
    () => ({
      open: chatSearchOpen(),
      matches: chatSearchMatches(),
      activeIndex: activeChatSearchIndex(),
    }),
    ({ open, matches, activeIndex }) => {
      if (!open) return;
      const renderedIndex = props.onSearchMessages ? 0 : activeIndex;
      renderChatSearchHighlights(matches, renderedIndex);
      const match = matches[renderedIndex];
      if (!match) return;
      stickToLatest = false;
      match.message.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    },
  );

  onCleanup(() => {
    if (chatSearchFrame !== undefined) cancelAnimationFrame(chatSearchFrame);
    if (chatSearchTimer !== undefined) clearTimeout(chatSearchTimer);
    clearChatSearchHighlights();
  });

  createEffect(
    () => {
      const lastMessage = props.messages[props.messages.length - 1];
      return {
        botId: props.bot?.id,
        serverId: props.server?.id ?? "local",
        activeTurnId: props.activeTurnId,
        queueSignature: props.queue?.deliveries.map((delivery) => `${delivery.id}:${delivery.status}`).join("|"),
        lastMessageBody: lastMessage?.body,
        lastMessageStatus: lastMessage?.status,
        deliverySignature: lastMessage?.exchange?.deliveries
          .map((delivery) => `${delivery.id}:${delivery.status}:${delivery.position}`)
          .join("|"),
        loaded: props.loaded,
        prompt: props.prompt,
        unreadCount: props.unreadCount,
      };
    },
    ({ botId, serverId, unreadCount }) => {
      currentUnreadCount = unreadCount;
      const conversationIdentity = `${serverId}:${botId ?? ""}`;
      if (conversationIdentity !== lastConversationIdentity) {
        if (lastConversationIdentity !== undefined) closeChatSearch(false);
        lastConversationIdentity = conversationIdentity;
        stickToLatest = true;
        setAgentActivitySpaceReserved(false);
      }
      if (latestScrollFrame !== undefined) cancelAnimationFrame(latestScrollFrame);
      if (latestScrollSettleFrame !== undefined) cancelAnimationFrame(latestScrollSettleFrame);
      const followLatest = stickToLatest;
      latestScrollFrame = requestAnimationFrame(() => {
        latestScrollFrame = undefined;
        if (!scrollElement) return;
        updateVirtualScrollMargin();
        if (followLatest) followConversationBottom(scrollElement);
        updateScrollFade(scrollElement);
        updateUnreadDividerVisibility();
        latestScrollSettleFrame = requestAnimationFrame(() => {
          latestScrollSettleFrame = undefined;
          if (!scrollElement) return;
          if (followLatest) {
            stickToLatest = true;
            followConversationBottom(scrollElement);
          }
          updateScrollFade(scrollElement);
          updateUnreadDividerVisibility();
        });
      });
    },
  );

  onCleanup(() => {
    if (latestScrollFrame !== undefined) cancelAnimationFrame(latestScrollFrame);
    if (latestScrollSettleFrame !== undefined) cancelAnimationFrame(latestScrollSettleFrame);
  });

  createEffect(
    () => {
      const bot = props.bot;
      if (!bot) return null;
      return {
        signature: [bot.id, bot.provider, bot.model, bot.reasoningEffort].join("\u0000"),
        provider: bot.provider,
        model: bot.model,
        reasoningEffort: bot.reasoningEffort,
      };
    },
    (bot) => {
      if (!bot) return;
      const pendingSettings = resources.runtimeSettingsAttempts.get(
        agentConversationKey(props.server?.id ?? "local", props.bot?.id ?? ""),
      );
      if (
        pendingSettings?.pending &&
        !runtimeSettingsEqual(pendingSettings.settings, {
          provider: bot.provider,
          model: bot.model,
          reasoningEffort: bot.reasoningEffort,
        })
      ) {
        setSettingsProvider(pendingSettings.settings.provider);
        setSettingsModel(pendingSettings.settings.model);
        setSettingsReasoning(pendingSettings.settings.reasoningEffort);
        return;
      }
      if (bot.signature === lastRuntimeSettingsSignature) return;
      lastRuntimeSettingsSignature = bot.signature;
      setSettingsProvider(bot.provider);
      setSettingsModel(bot.model);
      setSettingsReasoning(bot.reasoningEffort);
    },
  );

  createEffect(
    () => {
      const botId = props.bot?.id;
      return { botId, panel: botId ? rightPanels()[botId] : undefined };
    },
    ({ botId, panel }) => {
      if (botId === lastPanelBotId) return;
      const previousBotId = lastPanelBotId;
      lastPanelBotId = botId;
      setRoutineSettingsRequest(null);
      resources.filePreviewRequestGeneration += 1;
      const preview = sidebarFilePreview();
      if (preview && preview.ownerBotId !== botId) {
        setSidebarFilePreview(null);
        setRightPanels((current) => ({ ...current, [preview.ownerBotId]: "none" }));
      }
      if (!previousBotId || !botId || (panel !== "settings" && panel !== "file-preview")) return;
      setRightPanels((current) => ({ ...current, [botId]: "none" }));
    },
  );

  createEffect(
    () => ({ request: props.settingsRequest, botId: props.bot?.id }),
    ({ request, botId }) => {
      if (!request || botId !== request.botId || request.nonce === lastHandledSettingsRequestNonce) return;
      lastHandledSettingsRequestNonce = request.nonce;
      setActiveRightPanel("settings", botId);
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      activeTab: activeBrowserTab(),
      addressEditing: browserAddressEditing(),
      screenOpen: screenOpen(),
      activeBrowserTabId: props.activeBrowserTabId,
      onActivateBrowserTab: activateBrowserTab,
      suspended: props.browserVisibilitySuspended,
    }),
    ({ activeTab, addressEditing, screenOpen, activeBrowserTabId, onActivateBrowserTab, suspended }) => {
      if (props.browserEnabled === false || suspended) return;
      if (!addressEditing) setBrowserAddress(activeTab?.url ?? "https://www.google.com");
      if (screenOpen && activeTab && activeTab.id !== activeBrowserTabId) {
        onActivateBrowserTab(activeTab.id);
      }
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      visible:
        browserSidebarOpen() &&
        !props.browserVisibilitySuspended &&
        !props.globalOverlayOpen &&
        !props.remoteDesktopVisible &&
        !mediaPreview(),
    }),
    ({ botId, visible }) => {
      if (props.browserEnabled === false) return;
      const generation = ++browserVisibilityGeneration;
      if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
      browserResizeObserver?.disconnect();
      browserResizeObserver = undefined;
      if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
      browserWindowResizeHandler = undefined;
      if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
      browserBoundsFrame = undefined;
      if (!visible) {
        void window.openbot.browser.setVisible({ visible: false });
        return;
      }
      browserVisibilityFrame = requestAnimationFrame(() => {
        browserVisibilityFrame = undefined;
        if (
          generation !== browserVisibilityGeneration ||
          props.bot?.id !== botId ||
          !browserSidebarOpen() ||
          !browserSurface
        ) {
          return;
        }
        const syncBounds = () => {
          if (
            generation !== browserVisibilityGeneration ||
            props.bot?.id !== botId ||
            !browserSidebarOpen() ||
            !browserSurface
          ) {
            return;
          }
          const bounds = browserSurface.getBoundingClientRect();
          void window.openbot.browser.setVisible({
            visible: true,
            target: "main",
            bounds: {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
            },
          });
        };
        syncBounds();
        const scheduleBoundsSync = () => {
          if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
          browserBoundsFrame = requestAnimationFrame(() => {
            browserBoundsFrame = undefined;
            syncBounds();
          });
        };
        browserResizeObserver = new ResizeObserver(scheduleBoundsSync);
        browserResizeObserver.observe(browserSurface);
        if (conversationPanel) browserResizeObserver.observe(conversationPanel);
        browserWindowResizeHandler = scheduleBoundsSync;
        window.addEventListener("resize", browserWindowResizeHandler);
      });
    },
  );

  createEffect(
    () => ({ botId: props.bot?.id, open: browserPipOpen() }),
    ({ open }) => {
      if (props.browserEnabled === false) return;
      if (!open) {
        void window.openbot.browser.closePictureInPicture();
        return;
      }
      void window.openbot.browser
        .openPictureInPicture(untrack(browserPipBounds) ?? undefined)
        .then(saveBrowserPipBounds);
    },
  );

  const removeBrowserPictureInPictureListener = window.openbot.browser.onPictureInPictureEvent((event) => {
    if (event.type === "bounds-changed") {
      saveBrowserPipBounds(event.bounds);
      return;
    }
    setActiveRightPanel(event.type === "dock" ? "browser" : "none");
  });

  onCleanup(() => {
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
    removeBrowserPictureInPictureListener();
    if (props.browserEnabled !== false) {
      void window.openbot.browser.setVisible({ visible: false });
      void window.openbot.browser.closePictureInPicture();
    }
  });

  function updateTeamTyping(text: string): void {
    const botId = props.bot?.id;
    if (resources.typingIdleTimer) clearTimeout(resources.typingIdleTimer);
    if (!botId || !text.trim()) {
      stopTeamTyping();
      return;
    }
    if (resources.typingBotId && resources.typingBotId !== botId) props.onTypingChange(resources.typingBotId, false);
    resources.typingBotId = botId;
    props.onTypingChange(botId, true);
    resources.typingIdleTimer = setTimeout(stopTeamTyping, 3_000);
  }

  function stopTeamTyping(): void {
    controller.stopComposerTyping();
  }

  function addAttachments(selected: DraftAttachment[], target = currentTarget()) {
    if (!target) return;
    clearConversationError(target);
    const key = composerDraftKey(target);
    const draft = drafts()[key] ?? EMPTY_DRAFT;
    const available = Math.max(0, 10 - draft.attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.openbot.agent.discardDraftAttachment(attachment.id, target.serverId);
    }
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? EMPTY_DRAFT),
        attachments: [...draft.attachments, ...accepted],
      },
    }));
    if (selected.length > accepted.length) setComposerError("You can attach at most 10 files.");
    setShowComposerActions(false);
  }

  function openAttachmentPicker(filter: "all" | "images") {
    setShowComposerActions(false);
    setComposerError(null);
    const picker = filter === "images" ? imageAttachmentPicker : contextAttachmentPicker;
    if (!picker) return;
    picker.value = "";
    picker.click();
  }

  function openAttachmentPickerFromKey(event: KeyboardEvent, filter: "all" | "images") {
    if (event.key === "Enter" || event.key === " ") openAttachmentPicker(filter);
  }

  function editQueuedMessage(delivery: QueueDelivery) {
    const botId = props.bot?.id;
    const serverId = props.server?.id ?? "local";
    if (!botId || delivery.status !== "queued") return;
    if (editingDeliveryId()) cancelQueuedMessageEdit();
    clearConversationError({ botId, serverId });
    setEditingBotId(botId);
    setEditingServerId(serverId);
    setEditingDraftBackup({
      text: currentDraft().text,
      attachments: [...currentDraft().attachments],
      replyToMessageId: currentDraft().replyToMessageId,
    });
    setEditingOriginalAttachmentIds(delivery.attachments.map((attachment) => attachment.id));
    setEditingDeliveryId(delivery.id);
    setDrafts((current) => ({
      ...current,
      [composerDraftKey({ botId, serverId })]: {
        text: delivery.text,
        attachments: [...delivery.attachments],
        replyToMessageId: delivery.replyToMessageId,
      },
    }));
    setComposerFocusRequest((current) => current + 1);
    setShowComposerActions(false);
    setComposerError(null);
  }

  function cancelQueuedMessageEdit() {
    const botId = editingBotId() ?? props.bot?.id;
    const serverId = editingServerId() ?? props.server?.id ?? "local";
    const target = botId ? { botId, serverId } : undefined;
    const backup = editingDraftBackup();
    const draft = target ? (drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
    const preservedAttachmentIds = new Set([
      ...(backup?.attachments.map((attachment) => attachment.id) ?? []),
      ...editingOriginalAttachmentIds(),
    ]);
    for (const attachment of draft.attachments) {
      if (!preservedAttachmentIds.has(attachment.id)) {
        void window.openbot.agent.discardDraftAttachment(attachment.id, serverId);
      }
    }
    if (target) {
      setDrafts((current) => ({ ...current, [composerDraftKey(target)]: backup ?? EMPTY_DRAFT }));
    }
    setEditingBotId(null);
    setEditingServerId(null);
    setEditingDeliveryId(null);
    setEditingDraftBackup(null);
    setEditingOriginalAttachmentIds([]);
  }

  async function saveQueuedMessageEdit(
    draftOverride?: ComposerDraft,
    target?: ConversationTarget & { deliveryId: string; originalAttachmentIds: string[] },
    submittedSnapshot?: ComposerDraft,
  ): Promise<boolean> {
    const botId = target?.botId ?? editingBotId() ?? props.bot?.id;
    const serverId = target?.serverId ?? editingServerId() ?? props.server?.id ?? "local";
    const deliveryId = target?.deliveryId ?? editingDeliveryId();
    const draft = draftOverride ?? currentDraft();
    if (!botId || !deliveryId || submitting()) return false;
    const delivery = target ? undefined : props.queue?.deliveries.find((item) => item.id === deliveryId);
    if (!target && delivery?.status !== "queued") {
      setComposerError("This queued message is no longer available.");
      cancelQueuedMessageEdit();
      return false;
    }
    const text = expandComposerMentions(draft.text);
    const originalAttachmentIds = new Set(
      target?.originalAttachmentIds ?? delivery?.attachments.map((attachment) => attachment.id) ?? [],
    );
    const keepAttachmentIds = draft.attachments
      .filter((attachment) => originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    const attachmentDraftIds = draft.attachments
      .filter((attachment) => !originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    if (!text.trim() && keepAttachmentIds.length === 0 && attachmentDraftIds.length === 0) return false;

    stopTeamTyping();
    setSubmitting(true);
    setComposerError(null);
    let saved = false;
    try {
      saved = await props.onUpdateQueuedMessage(
        deliveryId,
        text,
        keepAttachmentIds,
        attachmentDraftIds,
        target ?? (botId ? { botId, serverId } : undefined),
      );
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
    if (!saved) return false;
    const savedTarget = { botId, serverId };
    clearConversationError(savedTarget);
    if (submittedSnapshot) clearSubmittedDraft(savedTarget, submittedSnapshot);
    else setDrafts((current) => ({ ...current, [composerDraftKey(savedTarget)]: EMPTY_DRAFT }));
    if (editingBotId() === botId && editingServerId() === serverId && editingDeliveryId() === deliveryId) {
      setEditingBotId(null);
      setEditingServerId(null);
      setEditingDeliveryId(null);
      setEditingDraftBackup(null);
      setEditingOriginalAttachmentIds([]);
    }
    return true;
  }

  function reorderPresentedQueue(deliveryIds: string[]) {
    const allQueuedIds = orderedQueuedDeliveries().map((delivery) => delivery.id);
    const presentedQueuedIds = presentedQueueDeliveries()
      .filter((delivery) => delivery.status === "queued")
      .map((delivery) => delivery.id);
    if (presentedQueuedIds.length === allQueuedIds.length) {
      props.onReorderQueue(deliveryIds);
      return;
    }

    const presentedIds = new Set(presentedQueuedIds);
    let nextPresentedIndex = 0;
    props.onReorderQueue(
      allQueuedIds.map((deliveryId) =>
        presentedIds.has(deliveryId) ? (deliveryIds[nextPresentedIndex++] ?? deliveryId) : deliveryId,
      ),
    );
  }

  async function submitMessage(
    draftOverride?: ComposerDraft,
    targetOverride?: ConversationTarget,
    submittedSnapshot?: ComposerDraft,
  ): Promise<boolean> {
    if (selectionSending()) return false;
    if (!draftOverride && currentEditingDeliveryId()) {
      return saveQueuedMessageEdit();
    }
    const botId = targetOverride?.botId ?? props.bot?.id;
    const target = targetOverride ?? (botId ? { botId, serverId: props.server?.id ?? "local" } : undefined);
    const draft = draftOverride ?? currentDraft();
    const text = expandComposerMentions(draft.text);
    const attachments = draft.attachments;
    if (!botId || !target || submitting() || (!text.trim() && attachments.length === 0)) return false;
    stopTeamTyping();
    stickToLatest = true;
    setSubmitting(true);
    setComposerError(null);
    const sent = await props.onSendMessage(
      text,
      attachments.map((item) => item.id),
      draft.replyToMessageId,
      target,
    );
    setSubmitting(false);
    if (sent) {
      clearConversationError(target);
      if (submittedSnapshot) clearSubmittedDraft(target, submittedSnapshot);
      else setDrafts((current) => ({ ...current, [composerDraftKey(target)]: EMPTY_DRAFT }));
    }
    return sent;
  }

  function submitComposer(): void {
    const phase = voicePhase();
    if (phase === "recording") {
      const botId = resources.voiceBotId;
      const serverId = resources.voiceServerId;
      if (!botId || !serverId) return;
      const target = { botId, serverId };
      const draft = copyComposerDraft(drafts()[composerDraftKey(target)] ?? EMPTY_DRAFT);
      const deliveryId = editingBotId() === botId && editingServerId() === serverId ? editingDeliveryId() : null;
      const activeTarget = currentTarget();
      const targetIsActive = activeTarget?.botId === target.botId && activeTarget.serverId === target.serverId;
      const delivery =
        deliveryId && targetIsActive ? props.queue?.deliveries.find((item) => item.id === deliveryId) : undefined;
      if (deliveryId && targetIsActive && delivery?.status !== "queued") {
        setComposerError("This queued message is no longer available.");
        cancelQueuedMessageEdit();
        return;
      }
      resources.voiceSubmitRequest = {
        botId,
        serverId,
        draft,
        queuedEdit: deliveryId
          ? {
              deliveryId,
              originalAttachmentIds: delivery
                ? delivery.attachments.map((attachment) => attachment.id)
                : [...editingOriginalAttachmentIds()],
            }
          : undefined,
      };
      stopVoiceRecording();
      return;
    }
    if (phase !== "idle") return;
    void submitMessage();
  }

  async function sendSelectionInstruction(messageId: string, body: string): Promise<boolean> {
    if (!props.bot || submitting() || selectionSending() || !agentReady()) {
      return false;
    }
    setSelectionSending(true);
    try {
      return await props.onSendMessage(body, [], messageId);
    } finally {
      setSelectionSending(false);
    }
  }

  async function markUnreadMessages(): Promise<void> {
    if (markingRead()) return;
    setMarkingRead(true);
    setComposerError(null);
    try {
      await props.onMarkRead();
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Could not mark messages as read.");
    } finally {
      setMarkingRead(false);
    }
  }

  async function jumpToUnreadMessages(): Promise<void> {
    if (!scrollElement) return;
    if (!unreadMessagesDivider && props.firstUnreadMessageId && props.onOpenSearchMessage) {
      await props.onOpenSearchMessage(props.firstUnreadMessageId);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (!unreadMessagesDivider) return;
    const divider = unreadMessagesDivider;
    const firstUnreadMessage = divider.nextElementSibling instanceof HTMLElement ? divider.nextElementSibling : divider;
    stickToLatest = false;
    scrollToUnreadBoundary(scrollElement, firstUnreadMessage);
    await markUnreadMessages();
    requestAnimationFrame(() => {
      if (!scrollElement) return;
      const settledBoundary = divider.isConnected ? divider : firstUnreadMessage;
      if (settledBoundary.isConnected) {
        scrollToUnreadBoundary(scrollElement, settledBoundary);
      }
    });
  }

  async function jumpToLatestMessage(): Promise<void> {
    if (!scrollElement) return;
    stickToLatest = true;
    if (props.discontinuous) {
      await props.onLoadLatest?.();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    scrollToLatestMessage(scrollElement);
  }

  function replyToMessage(message: BotMessage) {
    updateCurrentDraft({ replyToMessageId: message.id });
    setOpenReactionMessageId(null);
    setOpenMoreMessageId(null);
  }

  async function reactToMessage(message: BotMessage, emoji: MessageReaction | null) {
    const botId = props.bot?.id;
    if (!botId) return;
    const analytics = desktopAnalytics.scope();
    setOpenReactionMessageId(null);
    setExpandedEmojiMessageId(null);
    try {
      await window.openbot.agent.setMessageReaction({
        botId,
        messageId: message.id,
        emoji,
      });
      analytics.track("reaction_action", { action: emoji ? "add" : "remove", result: "succeeded" });
    } catch (error) {
      analytics.track("reaction_action", {
        action: emoji ? "add" : "remove",
        result: "failed",
        failure_code: "reaction_failed",
      });
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyMessage(message: BotMessage) {
    const attachmentNames = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment.name]));
    const agentNames = new Map(props.bots.map((bot) => [bot.id, bot.name]));
    const skillNames = new Map(
      installedSkills()
        .filter((skill) => skill.state !== "needs-repair")
        .map((skill) => [skill.skillId, skill.name]),
    );
    const text = expandAttachmentReferences(
      expandChatTagReferences(message.body, (reference) =>
        reference.kind === "agent" ? agentNames.get(reference.id) : skillNames.get(reference.id),
      ),
      (reference) => attachmentNames.get(reference.attachmentId),
    );
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement("textarea");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.append(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        if (copiedMessageId() === message.id) setCopiedMessageId(null);
      }, 1_400);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : "Could not copy the message.");
    }
  }

  function removeAttachment(id: string) {
    const serverId = currentTarget()?.serverId;
    updateCurrentDraft({
      attachments: currentDraft().attachments.filter((attachment) => attachment.id !== id),
      text: removeAttachmentReferences(currentDraft().text, id),
    });
    void window.openbot.agent.discardDraftAttachment(id, serverId);
  }

  async function openBrowserAddress(address = browserAddress()) {
    if (!browserInteractionAvailable()) return;
    const value = address.trim();
    if (!value) return;
    setBrowserAddressEditing(false);
    const analytics = desktopAnalytics.scope();
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const serverId = props.server?.id ?? "local";
    const botId = props.bot?.id ?? null;
    const canonicalUrl = canonicalBrowserUrl(url);
    const requestKey = JSON.stringify([serverId, botId, canonicalUrl]);
    const pendingRequest = resources.browserOpenRequests.get(requestKey);
    if (pendingRequest) return pendingRequest.promise;
    const request = (async () => {
      try {
        const tab = await window.openbot.browser.open({
          url,
          ownerThreadId: props.bot?.threadId ?? null,
          ownerBotId: props.bot?.id ?? null,
          focus: true,
        });
        setBrowserAddress(tab.url);
        analytics.track("browser_action", { action: "open", result: "succeeded" });
      } catch {
        setBrowserAddress(url);
        analytics.track("browser_action", {
          action: "open",
          result: "failed",
          failure_code: "browser_open_failed",
        });
      }
    })();
    const pendingRequestState = {
      promise: request,
      serverId,
      botId,
      url: canonicalUrl,
      existingTabIds: new Set(browserTabs().map((tab) => tab.id)),
    };
    resources.browserOpenRequests.set(requestKey, pendingRequestState);
    try {
      await request;
    } finally {
      if (resources.browserOpenRequests.get(requestKey) === pendingRequestState) {
        resources.browserOpenRequests.delete(requestKey);
      }
    }
  }

  async function openExternalMessageUrl(url: string) {
    try {
      await window.openbot.openUrl(url);
    } catch {
      setComposerError("Could not open the link in the external browser.");
    }
  }

  function showBrowserPanel() {
    if (!browserInteractionAvailable()) return;
    setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }

  function showBrowserPip() {
    if (!browserInteractionAvailable()) return;
    setActiveRightPanel("browser-pip");
  }

  function saveBrowserPipBounds(bounds: BrowserBounds) {
    setBrowserPipBounds(bounds);
    window.localStorage.setItem(
      "openbot:browser-pip-native-bounds",
      [bounds.x, bounds.y, bounds.width, bounds.height].join(","),
    );
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    if (props.browserEnabled !== false) void window.openbot.browser.setVisible({ visible: false });
  }

  async function closeBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    closingBrowserTabIds.add(tabId);
    try {
      await props.onCloseBrowserTab(tabId);
    } catch {
      setComposerError("Could not close the browser tab.");
    } finally {
      closingBrowserTabIds.delete(tabId);
    }
  }

  function activateBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    props.onActivateBrowserTab(tabId);
  }

  async function reloadBrowserTab(tabId: string) {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.browser.reload(tabId);
      analytics.track("browser_action", { action: "reload", result: "succeeded" });
    } catch {
      setComposerError("Could not reload the browser tab.");
      analytics.track("browser_action", {
        action: "reload",
        result: "failed",
        failure_code: "browser_reload_failed",
      });
    }
  }

  async function navigateBrowserTab(tabId: string, direction: "back" | "forward") {
    if (
      !browserInteractionAvailable() ||
      closingBrowserTabIds.has(tabId) ||
      !browserTabs().some((tab) => tab.id === tabId)
    ) {
      return;
    }
    try {
      await window.openbot.browser.navigate({ tabId, direction });
    } catch {
      setComposerError(`Could not navigate ${direction}.`);
    }
  }

  function setActiveRightPanel(mode: RightPanelMode, botId = props.bot?.id) {
    if (!botId) return;
    if (mode !== "settings") {
      setRoutineSettingsRequest((current) => (current?.botId === botId ? null : current));
    }
    setRightPanels((current) => (current[botId] === mode ? current : { ...current, [botId]: mode }));
  }

  function openRoutineSettings(routine: { routineId: string; name: string }): void {
    const botId = props.bot?.id;
    if (!botId) return;
    routineSettingsRequestNonce += 1;
    setRoutineSettingsRequest({
      botId,
      routineId: routine.routineId,
      routineName: routine.name,
      nonce: routineSettingsRequestNonce,
    });
    setActiveRightPanel("settings", botId);
  }

  function handleRoutineSettingsRequest(nonce: number): void {
    setRoutineSettingsRequest((current) => (current?.nonce === nonce ? null : current));
  }

  function openRoutineRunMessage(messageId: string): void {
    setActiveRightPanel("none");
    void props.onOpenSearchMessage?.(messageId);
  }

  async function previewAttachment(attachment: AttachmentSummary) {
    if (!attachment.previewUrl || attachment.previewKind === "none") return;
    setMediaPreview({
      attachment,
      text: null,
      loading: attachment.previewKind === "text",
      error: null,
    });
    if (attachment.previewKind !== "text") return;
    try {
      const response = await fetch(attachment.previewUrl);
      if (!response.ok) throw new Error("Preview is unavailable.");
      const text = await response.text();
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? { ...current, text: text.slice(0, 1_000_000), loading: false }
          : current,
      );
    } catch (error) {
      setMediaPreview((current) =>
        current?.attachment.id === attachment.id
          ? {
              ...current,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
    }
  }

  function attachmentAction(attachment: AttachmentSummary, action: "open" | "reveal" | "download") {
    void window.openbot.agent
      .openAttachment({ attachmentId: attachment.id, action })
      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function openSharedFile(path: string) {
    const ownerBotId = props.bot?.id;
    if (!ownerBotId) return;
    const generation = ++resources.filePreviewRequestGeneration;
    void window.openbot.agent.previewSharedFile({ path }).then(
      (preview) => {
        if (generation !== resources.filePreviewRequestGeneration || props.bot?.id !== ownerBotId) return;
        setSidebarFilePreview({ ownerBotId, source: "shared", path, preview });
        setActiveRightPanel("file-preview", ownerBotId);
      },
      (error) => setComposerError(error instanceof Error ? error.message : String(error)),
    );
  }

  function openWorkspaceFile(path: string) {
    const botId = props.bot?.id;
    if (!botId) return;
    const generation = ++resources.filePreviewRequestGeneration;
    void window.openbot.agent.previewWorkspaceFile({ botId, path }).then(
      (preview) => {
        if (generation !== resources.filePreviewRequestGeneration || props.bot?.id !== botId) return;
        setSidebarFilePreview({ ownerBotId: botId, source: "workspace", path, preview });
        setActiveRightPanel("file-preview", botId);
      },
      (error) => setComposerError(error instanceof Error ? error.message : String(error)),
    );
  }

  function openSidebarFileExternally() {
    const file = sidebarFilePreview();
    if (!file) return;
    const request =
      file.source === "shared"
        ? window.openbot.agent.openSharedFile({ path: file.path })
        : window.openbot.agent.openWorkspaceFile({ botId: file.ownerBotId, path: file.path });
    void request.catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function closeSidebarFilePreview() {
    resources.filePreviewRequestGeneration += 1;
    setSidebarFilePreview(null);
    setActiveRightPanel("none");
  }

  const setConversationPanelElement = (element: HTMLElement) => {
    conversationPanel = element;
  };
  const conversationPanelElement = () => conversationPanel;
  const setChatSearchInputElement = (element: HTMLInputElement) => {
    chatSearchInput = element;
  };
  const setScrollElement = (element: HTMLDivElement) => {
    scrollElement = element;
    updateVirtualScrollMargin();
  };
  const setStickToLatest = (value: boolean) => {
    stickToLatest = value;
  };
  const setVirtualRootElement = (element: HTMLDivElement) => {
    virtualRoot = element;
    updateVirtualScrollMargin();
    scrollResizeObserver?.observe(element);
  };
  const setUnreadMessagesDividerElement = (element: HTMLDivElement) => {
    unreadMessagesDivider = element;
  };
  const setAgentActivitySlotElement = (element: HTMLDivElement) => {
    agentActivitySlot = element;
    scrollResizeObserver?.observe(element);
  };
  const setBrowserSurfaceElement = (element: HTMLDivElement) => {
    browserSurface = element;
  };
  const setImageAttachmentPickerElement = (element: HTMLInputElement) => {
    imageAttachmentPicker = element;
  };
  const setContextAttachmentPickerElement = (element: HTMLInputElement) => {
    contextAttachmentPicker = element;
  };

  return {
    conversationPanelElement,
    setAgentActivitySlotElement,
    setBrowserSurfaceElement,
    setChatSearchInputElement,
    setConversationPanelElement,
    setContextAttachmentPickerElement,
    setImageAttachmentPickerElement,
    setScrollElement,
    setStickToLatest,
    setUnreadMessagesDividerElement,
    setVirtualRootElement,
    activeActivityId,
    activeBrowserControl,
    actingBrowserControl,
    activeBrowserTab,
    browserTakeoverPreview,
    browserTakeoverResolution,
    browserTakeoverTab,
    respondToBrowserTakeover,
    activeChatSearchIndex,
    activeDeliveries,
    activeRightPanel,
    activityPresentation,
    addAttachments,
    agentActivity,
    agentReady,
    agentActivityExitDelayTimer,
    agentActivityExitTimer,
    agentActivityShowTimer,
    agentActivitySlot,
    agentActivitySpaceReserved,
    activateBrowserTab,
    attachmentAction,
    attachmentBusy,
    browserAddress,
    browserPipOpen,
    browserSidebarOpen,
    browserBoundsFrame,
    browserControlBot,
    browserControlForTab,
    browserControllerForTab,
    browserPanelWidth,
    browserResizeObserver,
    browserTabs,
    browserVisibilityFrame,
    browserVisibilityGeneration,
    browserWindowResizeHandler,
    cancelQueuedMessageEdit,
    chatSearchFrame,
    chatSearchInput,
    chatSearchMatches,
    chatSearchMessageIds,
    chatSearchOpen,
    chatSearchQuery,
    chatSearchRequest,
    chatSearchReturnFocus,
    chatSearchTimer,
    chatSearchTotal,
    clearAgentActivityExitDelayTimer,
    clearAgentActivityExitTimer,
    clearAgentActivityShowTimer,
    closeBrowserTab,
    closeChatSearch,
    closeSidebarFilePreview,
    composerError,
    composerFocusRequest,
    composerHasContent,
    controller,
    copiedMessageId,
    copyMessage,
    currentDraft,
    currentConversationError,
    installedSkills,
    currentUnreadCount,
    drafts,
    dropActive,
    editQueuedMessage,
    editingDeliveryId: currentEditingDeliveryId,
    editingDraftBackup,
    expandedEmojiMessageId,
    expandedThinkingMessages,
    fadeAtBottom,
    fadeAtTop,
    filePreviewOpen,
    finishVoiceRecording,
    handleChatSearchShortcut,
    hideBrowserPanel,
    jumpToLatestMessage,
    jumpToUnreadMessages,
    lastChatSearchQuery,
    lastConversationIdentity,
    lastHandledMessageFocusNonce,
    lastHandledSettingsRequestNonce,
    lastPanelBotId,
    lastRuntimeSettingsSignature,
    latestScrollFrame,
    latestScrollSettleFrame,
    markMessageSeen,
    markUnreadMessages,
    markingRead,
    mediaPreview,
    messageVirtualizer,
    moveChatSearch,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openBrowserAddress,
    openChatSearch,
    openExternalMessageUrl,
    openMoreMessageId,
    openReactionMessageId,
    openRoutineSettings,
    openRoutineRunMessage,
    openSharedFile,
    openSidebarFileExternally,
    openWorkspaceFile,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    previewAttachment,
    previousBrowserTabCount,
    props,
    queueExitTimer,
    queuePanelVisible,
    reactToMessage,
    navigateBrowserTab,
    reloadBrowserTab,
    removeAttachment,
    renderedAgentActivity,
    renderedQueueDeliveries,
    reorderPresentedQueue,
    replyTarget,
    replyToMessage,
    resources,
    rightPanels,
    routineSettingsRequest,
    saveBotPatch,
    updateRuntimeSettings,
    saveQueuedMessageEdit,
    scheduleUnreadDividerVisibilityUpdate,
    screenOpen,
    scrollElement,
    scrollResizeObserver,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    selectModel,
    selectionSending,
    sendSelectionInstruction,
    setActiveChatSearchIndex,
    setActiveRightPanel,
    setAgentActivitySpaceReserved,
    setAttachmentBusy,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setChatSearchMatches,
    setChatSearchMessageIds,
    setChatSearchOpen,
    setChatSearchQuery,
    setChatSearchTotal,
    setComposerError,
    setComposerFocusRequest,
    setCopiedMessageId,
    setDrafts,
    setDropActive,
    setEditingDeliveryId,
    setEditingDraftBackup,
    setExpandedEmojiMessageId,
    setExpandedThinkingMessages,
    setFadeAtBottom,
    setFadeAtTop,
    setMarkingRead,
    setMediaPreview,
    setOpenMoreMessageId,
    setOpenReactionMessageId,
    setRenderedAgentActivity,
    setRenderedQueueDeliveries,
    setRightPanels,
    handleRoutineSettingsRequest,
    setSelectionSending,
    setSidebarFilePreview,
    setSettingsModel,
    setSettingsPanelWidth,
    setSettingsProvider,
    setSettingsReasoning,
    setShowComposerActions,
    setShowScrollToLatest,
    setSubmitting,
    setUnreadDividerVisible,
    setVoiceElapsedSeconds,
    setVoicePhase,
    settingsModel,
    settingsProvider,
    settingsOpen,
    settingsPanelWidth,
    settingsReasoning,
    sidebarFilePreview,
    showBrowserPanel,
    showBrowserPip,
    showComposerActions,
    showScrollToLatest,
    startVoiceElapsedTimer,
    startVoiceRecording,
    stickToLatest,
    stopTeamTyping,
    stopVoiceElapsedTimer,
    stopVoiceRecording,
    stopVoiceStream,
    streamingAgentMessage,
    submitComposer,
    submitting,
    unreadDividerVisible,
    unreadMessagesDivider,
    unreadVisibilityFrame,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateScrollFade,
    updateTeamTyping,
    updateUnreadDividerVisibility,
    virtualRoot,
    voiceElapsedSeconds,
    voicePhase,
    voiceModelProgress,
  };
}

export type ConversationViewScope = ReturnType<typeof createConversationViewScope>;

const ConversationViewScopeContext = createContext<ConversationViewScope>();

export function useConversationViewScope(): ConversationViewScope {
  const scope = useContext(ConversationViewScopeContext);
  if (!scope) throw new Error("Conversation view scope is unavailable outside ConversationView.");
  return scope;
}

/** @internal Stable HMR boundary for conversation header. */
export function ConversationHeader() {
  const {
    actingBrowserControl,
    agentActivity,
    browserControlBot,
    hideBrowserPanel,
    props,
    screenOpen,
    selectAndConfirmModel,
    selectAndConfirmReasoning,
    setActiveRightPanel,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    showBrowserPanel,
  } = useConversationViewScope();
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.bot}>
          {(bot) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="conversation-title no-drag"
              aria-label="View agent settings"
              onPointerEnter={() => void loadAgentSettingsPanel()}
              onFocus={() => void loadAgentSettingsPanel()}
              onClick={() => setActiveRightPanel("settings")}
            >
              <AgentAvatar bot={bot()} />
              <h1>{bot().name}</h1>
            </Button>
          )}
        </Show>
      </div>
      <div class="conversation-header-actions no-drag">
        <Show when={props.bot}>
          <ProviderModelPicker
            provider={settingsProvider()}
            value={settingsModel()}
            reasoningEffort={settingsReasoning()}
            modelOptions={props.modelOptions}
            agentStatus={props.agentStatus}
            runtimeStatuses={props.providerRuntimeStatuses}
            onDownloadProvider={props.onDownloadProvider}
            onCancelProviderDownload={props.onCancelProviderDownload}
            onConnectProvider={props.onConnectProvider}
            disabled={agentActivity() === "Working"}
            disabledReason={
              agentActivity() === "Working"
                ? "Wait for the current work to finish before changing models."
                : "Models are available after an agent CLI connects."
            }
            onChange={(model, provider) => void selectAndConfirmModel(model, provider)}
            onReasoningEffortChange={(effort) => void selectAndConfirmReasoning(effort)}
          />
        </Show>
        <Show when={props.remoteDesktopEnabled !== false && props.server?.kind === "remote" ? props.server : undefined}>
          {(server) => {
            const enabled = () =>
              props.remoteDesktopSessionActive || (server().state === "online" && server().remoteDesktopAvailable);
            const label = () => (props.remoteDesktopSessionActive ? "Resume remote control" : "Open remote control");
            return (
              <Button
                variant="ghost"
                type="button"
                class="header-panel-toggle remote-desktop-button"
                aria-label={label()}
                aria-expanded={props.remoteDesktopVisible ? "true" : "false"}
                disabled={!enabled()}
                onClick={(event) => void props.onOpenRemoteDesktop(server().id, event.currentTarget)}
              >
                <RemoteDesktopIcon />
                <Show when={props.remoteDesktopSessionActive}>
                  <span class="remote-desktop-button-dot" aria-hidden="true" />
                </Show>
              </Button>
            );
          }}
        </Show>
        <Show when={props.browserEnabled !== false}>
          <Button
            variant="ghost"
            type="button"
            class={[
              "header-panel-toggle computer-button",
              { "computer-button-agent-active": Boolean(actingBrowserControl()) },
            ]}
            aria-label={
              actingBrowserControl()
                ? `${browserControlBot()?.name ?? "Agent"} is controlling the browser`
                : screenOpen()
                  ? "Hide computer"
                  : "Open computer"
            }
            aria-expanded={screenOpen() ? "true" : "false"}
            disabled={props.browserVisibilitySuspended}
            onClick={() => {
              if (screenOpen()) hideBrowserPanel();
              else showBrowserPanel();
            }}
          >
            <ComputerIcon />
            <Show when={actingBrowserControl()}>
              <span class="computer-control-dot" aria-hidden="true" />
            </Show>
          </Button>
        </Show>
      </div>
    </header>
  );
}

/** A message that renders only an action marker, with no bubble of its own. */
function markerOnlyMessage(message: BotMessage): boolean {
  const marker = message.actionMarker;
  if (!marker) return false;
  return (
    Boolean(message.exchange) ||
    !message.routine ||
    marker.kind === "routine-lifecycle" ||
    marker.kind === "unavailable"
  );
}

/** Marker-only rows that render attachment cards below the marker do not end with one. */
function markerRowEndsWithMarker(message: BotMessage): boolean {
  if (!markerOnlyMessage(message)) return false;
  return !(message.exchange?.direction === "incoming" && (message.attachments?.length ?? 0) > 0);
}

function routineMarkerAvailable(
  marker: ChatActionMarkerModel,
  availableRoutineIds: readonly string[] | undefined,
): boolean {
  if (!("routineId" in marker)) return true;
  if (marker.kind === "routine-lifecycle" && marker.action === "deleted") return false;
  return availableRoutineIds?.includes(marker.routineId) === true;
}

/** @internal Stable HMR boundary for conversation timeline. */
export function ConversationTimeline() {
  const {
    activeChatSearchIndex,
    agentActivitySpaceReserved,
    agentReady,
    attachmentAction,
    browserTakeoverPreview,
    browserTakeoverResolution,
    browserTakeoverTab,
    chatSearchMatches,
    chatSearchOpen,
    chatSearchQuery,
    chatSearchTotal,
    closeChatSearch,
    copiedMessageId,
    copyMessage,
    expandedEmojiMessageId,
    expandedThinkingMessages,
    installedSkills,
    fadeAtBottom,
    fadeAtTop,
    jumpToLatestMessage,
    jumpToUnreadMessages,
    markMessageSeen,
    markUnreadMessages,
    markingRead,
    messageVirtualizer,
    moveChatSearch,
    openExternalMessageUrl,
    openMoreMessageId,
    openReactionMessageId,
    openRoutineSettings,
    openSharedFile,
    openWorkspaceFile,
    previewAttachment,
    props,
    reactToMessage,
    renderedAgentActivity,
    respondToBrowserTakeover,
    replyToMessage,
    scheduleUnreadDividerVisibilityUpdate,
    setChatSearchQuery,
    setComposerError,
    setExpandedEmojiMessageId,
    setExpandedThinkingMessages,
    setOpenMoreMessageId,
    setOpenReactionMessageId,
    showScrollToLatest,
    unreadDividerVisible,
    updateScrollFade,
    updateUnreadDividerVisibility,
    setAgentActivitySlotElement,
    setChatSearchInputElement,
    setScrollElement,
    setStickToLatest,
    setUnreadMessagesDividerElement,
    setVirtualRootElement,
  } = useConversationViewScope();
  const virtualMessageRows = createMemo(() => messageVirtualizer.getVirtualItems());
  let cachedPrompt: { key: string; prompt: NonNullable<ConversationProps["prompt"]> } | null = null;
  const keyedPrompt = createMemo(() => {
    const prompt = props.prompt;
    if (!prompt) {
      cachedPrompt = null;
      return null;
    }
    const key = JSON.stringify([prompt.turnId, String(prompt.requestId)]);
    if (cachedPrompt?.key === key) return cachedPrompt;
    cachedPrompt = { key, prompt };
    return cachedPrompt;
  });
  return (
    <>
      <Show when={chatSearchOpen()}>
        <ChatSearch
          query={chatSearchQuery()}
          current={activeChatSearchIndex()}
          total={props.onSearchMessages ? chatSearchTotal() : chatSearchMatches().length}
          inputRef={setChatSearchInputElement}
          onQueryChange={setChatSearchQuery}
          onPrevious={() => moveChatSearch(-1)}
          onNext={() => moveChatSearch(1)}
          onClose={closeChatSearch}
        />
      </Show>

      <Show when={props.unreadCount > 0 && !unreadDividerVisible()}>
        <UnreadMessagesBanner
          count={props.unreadCount}
          busy={markingRead()}
          onJumpToUnread={jumpToUnreadMessages}
          onMarkRead={() => void markUnreadMessages()}
        />
      </Show>

      <div
        class={[
          "conversation-scroll",
          {
            "scroll-fade-top": fadeAtTop(),
            "scroll-fade-bottom": fadeAtBottom(),
          },
        ]}
        ref={setScrollElement}
        onScroll={(event) => {
          const element = event.currentTarget;
          setStickToLatest(element.scrollHeight - element.scrollTop - element.clientHeight <= 80);
          updateScrollFade(element);
          updateUnreadDividerVisibility();
        }}
      >
        <Show when={showScrollToLatest() || props.discontinuous}>
          <ScrollToLatestButton onClick={() => void jumpToLatestMessage()} />
        </Show>
        <Show when={props.loaded}>
          <Show when={!agentReady()}>
            <section class="agent-setup-card" role="status">
              <div>
                <strong>
                  {props.agentStatus.phase === "starting" || props.agentStatus.phase === "restarting"
                    ? "Connecting to agent CLIs…"
                    : "Agent CLI setup required"}
                </strong>
                <p>
                  {props.agentStatus.message ??
                    "Install and sign in to Codex CLI, Claude CLI, or Grok CLI, then restart OpenBot."}
                </p>
              </div>
              <Show when={props.agentStatus.phase !== "starting" && props.agentStatus.phase !== "restarting"}>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() =>
                    void props
                      .onOpenAgentSetup()
                      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)))
                  }
                >
                  Setup guide
                </Button>
              </Show>
            </section>
          </Show>
          <Show when={props.messages.length > 0}>
            <div class="time-marker">
              <span>{props.messages[0]?.time ?? "now"}</span>
            </div>
          </Show>
          <Show when={props.loadingOlder || props.olderError}>
            <div class="conversation-history-status" role={props.olderError ? "alert" : "status"}>
              <Show when={props.olderError} fallback="Loading older messages…">
                <span>{props.olderError}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => props.onLoadOlder?.()}>
                  Retry
                </Button>
              </Show>
            </div>
          </Show>
          <div
            ref={setVirtualRootElement}
            class={["virtual-chat-list", { "virtual-chat-list-static": !messageVirtualizer.isVirtualized() }]}
            style={{ height: messageVirtualizer.isVirtualized() ? `${messageVirtualizer.getTotalSize()}px` : "auto" }}
          >
            <For each={virtualMessageRows()}>
              {(virtualRow) => {
                const message = createMemo(() => props.messages[virtualRow.index]);
                const initialMessage = untrack(message);
                if (!initialMessage) return null;
                const animateEntrance = initialMessage.animate === true && markMessageSeen(initialMessage.id);
                const initialActionMarker = initialMessage.actionMarker;
                const markerOnly = markerOnlyMessage(initialMessage);
                // Consecutive markers keep the tighter marker gap so they read as one group.
                const groupedWithMarker = createMemo(() => {
                  const current = message();
                  if (!current?.actionMarker) return false;
                  if (current.id === props.firstUnreadMessageId) return false;
                  const previous = props.messages[virtualRow.index - 1];
                  return previous !== undefined && markerRowEndsWithMarker(previous);
                });
                if (markerOnly) {
                  return (
                    <div
                      data-index={virtualRow.index}
                      data-grouped={groupedWithMarker() ? "marker" : undefined}
                      ref={messageVirtualizer.measureElement}
                      class="virtual-chat-row"
                      style={{
                        transform: messageVirtualizer.isVirtualized()
                          ? `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)`
                          : "none",
                      }}
                    >
                      <Show when={message()?.id === props.firstUnreadMessageId}>
                        <UnreadMessagesDivider
                          elementRef={(element) => {
                            setUnreadMessagesDividerElement(element);
                            scheduleUnreadDividerVisibilityUpdate();
                          }}
                        />
                      </Show>
                      <article
                        data-chat-search-message={message()?.id}
                        class={{ "chat-action-entry-animated": animateEntrance }}
                      >
                        <Show when={message()?.actionMarker ?? initialActionMarker}>
                          {(marker) => (
                            <ChatActionMarker
                              marker={marker()}
                              bots={props.bots}
                              announce={animateEntrance}
                              routineAvailable={routineMarkerAvailable(marker(), props.availableRoutineIds)}
                              onSelectAgent={props.onSelectAgent}
                              onOpenRoutine={openRoutineSettings}
                              onOpenHostedSite={(url) => void openExternalMessageUrl(url)}
                            />
                          )}
                        </Show>
                        <Show
                          when={
                            initialMessage.exchange?.direction === "incoming" &&
                            (message()?.attachments?.length ?? 0) > 0
                          }
                        >
                          <div class="chat-action-attachments">
                            <AttachmentCards
                              attachments={message()?.attachments ?? []}
                              onPreview={(attachment) => void previewAttachment(attachment)}
                              onAction={attachmentAction}
                            />
                          </div>
                        </Show>
                      </article>
                    </div>
                  );
                }
                const displayedReactions = createMemo(() => {
                  const currentMessage = message();
                  if (currentMessage?.reactions?.length) return currentMessage.reactions;
                  if (currentMessage?.reaction) {
                    return [{ emoji: currentMessage.reaction, actor: { kind: "user" as const } }];
                  }
                  return (currentMessage?.reactionSummary?.emojis ?? []).map((emoji) => ({
                    emoji,
                    actor: { kind: "user" as const },
                  }));
                });
                return (
                  <div
                    data-index={virtualRow.index}
                    data-grouped={groupedWithMarker() ? "marker" : undefined}
                    ref={messageVirtualizer.measureElement}
                    class="virtual-chat-row"
                    style={{
                      transform: messageVirtualizer.isVirtualized()
                        ? `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)`
                        : "none",
                    }}
                  >
                    <Show when={message()?.id === props.firstUnreadMessageId}>
                      <UnreadMessagesDivider
                        elementRef={(element) => {
                          setUnreadMessagesDividerElement(element);
                          scheduleUnreadDividerVisibilityUpdate();
                        }}
                      />
                    </Show>
                    <Show
                      when={message()?.questionPrompt}
                      fallback={
                        <Show
                          when={message()?.kind === "thinking"}
                          fallback={
                            <>
                              <Show when={message()?.routine && message()?.actionMarker}>
                                {(marker) => (
                                  <ChatActionMarker
                                    marker={marker()}
                                    bots={props.bots}
                                    announce={animateEntrance}
                                    routineAvailable={routineMarkerAvailable(marker(), props.availableRoutineIds)}
                                    onSelectAgent={props.onSelectAgent}
                                    onOpenRoutine={openRoutineSettings}
                                    onOpenHostedSite={(url) => void openExternalMessageUrl(url)}
                                  />
                                )}
                              </Show>
                              <Message
                                role="article"
                                align={message()?.author === "you" ? "end" : "start"}
                                data-chat-search-message={message()?.id}
                                data-author={message()?.author === "you" ? "user" : "assistant"}
                                class={[
                                  "message-entry",
                                  {
                                    "message-entry-animated": animateEntrance,
                                    "message-entry-user": message()?.author === "you",
                                    "message-entry-bot": message()?.author === "bot",
                                  },
                                ]}
                              >
                                <MessageContent>
                                  <div class="message-shell">
                                    <Bubble
                                      align={message()?.author === "you" ? "end" : "start"}
                                      variant={conversationBubbleVariant(message() ?? initialMessage)}
                                      data-author={message()?.author === "you" ? "user" : "assistant"}
                                      data-streaming={message()?.streaming === true ? "" : undefined}
                                    >
                                      <BubbleContent>
                                        <MessageBody
                                          message={message() ?? initialMessage}
                                          referencedMessage={
                                            props.messages.find(
                                              (candidate) => candidate.id === message()?.replyToMessageId,
                                            ) ??
                                            (message()?.replyToMessageId
                                              ? props.messageReferences?.[message()?.replyToMessageId ?? ""]
                                              : undefined)
                                          }
                                          bots={props.bots}
                                          skills={installedSkills()}
                                          onSelectAgent={props.onSelectAgent}
                                          onOpenLink={(url) => void openExternalMessageUrl(url)}
                                          onPreview={(attachment) => void previewAttachment(attachment)}
                                          onAttachmentAction={attachmentAction}
                                          onOpenSharedFile={openSharedFile}
                                          onOpenWorkspaceFile={openWorkspaceFile}
                                          onDownload={(attachment) => attachmentAction(attachment, "download")}
                                        />
                                      </BubbleContent>
                                      <Show when={displayedReactions().length > 0}>
                                        <BubbleReactions
                                          class="message-reaction-anchor"
                                          align={message()?.author === "you" ? "start" : "end"}
                                          overflowCount={message()?.reactionSummary?.overflowCount}
                                          role="group"
                                          aria-label={`Reactions: ${displayedReactions()
                                            .map((reaction) => reaction.emoji)
                                            .join(", ")}`}
                                        >
                                          <For each={displayedReactions()}>
                                            {(reaction) => (
                                              <Show
                                                when={reaction.actor.kind === "user"}
                                                fallback={
                                                  <span
                                                    class="message-reaction-pill message-reaction-pill-readonly"
                                                    role="img"
                                                    aria-label={`${
                                                      props.bots.find(
                                                        (bot) =>
                                                          reaction.actor.kind === "bot" &&
                                                          bot.id === reaction.actor.botId,
                                                      )?.name ?? "Agent"
                                                    } reacted with ${reaction.emoji}`}
                                                  >
                                                    <span aria-hidden="true">{reaction.emoji}</span>
                                                  </span>
                                                }
                                              >
                                                <Button
                                                  variant="ghost"
                                                  type="button"
                                                  class="message-reaction-pill"
                                                  aria-label={`Remove your reaction ${reaction.emoji}`}
                                                  onClick={() => {
                                                    const currentMessage = message();
                                                    if (currentMessage) void reactToMessage(currentMessage, null);
                                                  }}
                                                >
                                                  <span aria-hidden="true">{reaction.emoji}</span>
                                                </Button>
                                              </Show>
                                            )}
                                          </For>
                                        </BubbleReactions>
                                      </Show>
                                    </Bubble>
                                    <MessageActions
                                      message={message() ?? initialMessage}
                                      pickerOpen={openReactionMessageId() === message()?.id}
                                      moreOpen={openMoreMessageId() === message()?.id}
                                      expandedEmoji={expandedEmojiMessageId() === message()?.id}
                                      copied={copiedMessageId() === message()?.id}
                                      onTogglePicker={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setOpenReactionMessageId((current) =>
                                          current === messageId ? null : messageId,
                                        );
                                        setOpenMoreMessageId(null);
                                        setExpandedEmojiMessageId(null);
                                      }}
                                      onToggleMore={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setOpenMoreMessageId((current) => (current === messageId ? null : messageId));
                                        setOpenReactionMessageId(null);
                                        setExpandedEmojiMessageId(null);
                                      }}
                                      onExpandEmoji={() => {
                                        const messageId = message()?.id;
                                        if (!messageId) return;
                                        setExpandedEmojiMessageId((current) =>
                                          current === messageId ? null : messageId,
                                        );
                                      }}
                                      onReact={(emoji) => {
                                        const currentMessage = message();
                                        if (currentMessage) void reactToMessage(currentMessage, emoji);
                                      }}
                                      onReply={() => {
                                        const currentMessage = message();
                                        if (currentMessage) replyToMessage(currentMessage);
                                      }}
                                      onCopy={() => {
                                        const currentMessage = message();
                                        if (currentMessage) void copyMessage(currentMessage);
                                      }}
                                    />
                                  </div>
                                </MessageContent>
                              </Message>
                            </>
                          }
                        >
                          <div
                            data-chat-search-message={message()?.id}
                            class={{ "thinking-entry-animated": animateEntrance }}
                          >
                            <ThinkingDisclosure
                              message={message() ?? initialMessage}
                              open={expandedThinkingMessages()[`${props.bot?.id ?? ""}:${message()?.id ?? ""}`]}
                              onOpenChange={(open) => {
                                const key = `${props.bot?.id ?? ""}:${message()?.id ?? ""}`;
                                setExpandedThinkingMessages((current) =>
                                  current[key] === open ? current : { ...current, [key]: open },
                                );
                              }}
                            />
                          </div>
                        </Show>
                      }
                    >
                      {(questionPrompt) => (
                        <Show when={questionPrompt().resolution}>
                          {(resolution) => (
                            <article data-chat-search-message={message()?.id} class="question-prompt-history-entry">
                              <QuestionPromptBubble
                                questions={questionPrompt().questions}
                                resolution={resolution()}
                                onSubmit={async () => false}
                              />
                            </article>
                          )}
                        </Show>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <div
            class="agent-activity-slot"
            data-reserved={agentActivitySpaceReserved() ? "true" : "false"}
            ref={setAgentActivitySlotElement}
          >
            <Show when={renderedAgentActivity()}>
              {(activity) => (
                <AgentActivityIndicator
                  bot={activity().bot}
                  detail={activity().detail}
                  presentation={activity().presentation}
                  phase={activity().phase}
                />
              )}
            </Show>
          </div>
          <Show when={keyedPrompt()} keyed>
            {(entry) => (
              <Loading>
                <QuestionPromptBubble
                  questions={entry.prompt.questions}
                  onSubmit={props.onAnswerPrompt}
                  onResolutionPresented={() =>
                    props.onPromptResolutionPresented?.(entry.prompt.botId, entry.prompt.turnId, entry.prompt.requestId)
                  }
                />
              </Loading>
            )}
          </Show>
          <Show when={props.approval}>
            {(approval) => (
              <Loading>
                <ApprovalCard
                  approval={approval()}
                  onApprove={() => props.onRespondToApproval("accept")}
                  onReject={() => props.onRespondToApproval("decline")}
                />
              </Loading>
            )}
          </Show>
          <Show when={props.browserTakeover}>
            <Loading>
              <BrowserTakeoverCard
                botName={props.bot?.name ?? "the agent"}
                tab={browserTakeoverTab()}
                preview={browserTakeoverPreview().preview}
                previewStatus={browserTakeoverPreview().status}
                onComplete={() => respondToBrowserTakeover("complete")}
                onCancel={() => respondToBrowserTakeover("cancel")}
              />
            </Loading>
          </Show>
          <Show when={!props.browserTakeover && browserTakeoverResolution()}>
            {(resolution) => (
              <BrowserTakeoverCard
                botName={props.bot?.name ?? "the agent"}
                tab={resolution().tab}
                preview={resolution().preview}
                previewStatus={resolution().previewStatus}
                decision={resolution().decision}
                onComplete={async () => false}
                onCancel={async () => false}
              />
            )}
          </Show>
        </Show>
      </div>
    </>
  );
}

/** @internal Stable HMR boundary for conversation composer. */
export function ConversationComposer() {
  const {
    agentReady,
    attachmentAction,
    attachmentBusy,
    composerError,
    composerFocusRequest,
    composerHasContent,
    currentDraft,
    currentConversationError,
    installedSkills,
    editQueuedMessage,
    editingDeliveryId,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
    openExternalMessageUrl,
    presentedQueueDeliveries,
    previewAttachment,
    props,
    queuePanelVisible,
    removeAttachment,
    reorderPresentedQueue,
    replyTarget,
    selectionSending,
    setComposerFocusRequest,
    setContextAttachmentPickerElement,
    setImageAttachmentPickerElement,
    setShowComposerActions,
    showComposerActions,
    startVoiceRecording,
    stopVoiceRecording,
    submitComposer,
    submitting,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateTeamTyping,
    voiceElapsedSeconds,
    voicePhase,
    voiceModelProgress,
  } = useConversationViewScope();
  return (
    <Show when={!props.prompt && !props.approval && !props.browserTakeover}>
      <div class="composer-wrap">
        <div
          class="agent-queue-slot"
          data-open={queuePanelVisible() ? "true" : "false"}
          aria-hidden={queuePanelVisible() ? undefined : "true"}
          inert={queuePanelVisible() ? undefined : true}
        >
          <div class="agent-queue-slot-inner">
            <Show when={queuePanelVisible()}>
              <Loading>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
                  bots={props.bots}
                  skills={installedSkills()}
                  editingDeliveryId={editingDeliveryId()}
                  canSteer={Boolean(props.activeTurnId)}
                  onSteer={props.onSteerQueuedMessage}
                  onCancel={props.onCancelQueuedMessage}
                  onEdit={editQueuedMessage}
                  onReorder={reorderPresentedQueue}
                />
              </Loading>
            </Show>
          </div>
        </div>
        <Show when={replyTarget()}>
          {(message) => (
            <div class="composer-reply-preview">
              <div>
                <span>Replying to {message().author === "you" ? "your message" : "Agent"}</span>
                <p>
                  <RichMessageText
                    body={message().body || "Attachment"}
                    bots={props.bots}
                    skills={installedSkills()}
                    attachments={message().attachments}
                    onSelectAgent={props.onSelectAgent}
                    onOpenLink={(url) => void openExternalMessageUrl(url)}
                    onOpenAttachment={(attachment) => void previewAttachment(attachment)}
                  />
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label="Cancel reply"
                disabled={voicePhase() === "transcribing"}
                onClick={() => updateCurrentDraft({ replyToMessageId: null })}
              >
                <CloseIcon />
              </Button>
            </div>
          )}
        </Show>
        <Show when={composerError() ?? currentConversationError()}>
          <div class="composer-error" role="alert">
            {composerError() ?? currentConversationError()}
          </div>
        </Show>
        <div
          class={`composer${voicePhase() === "recording" ? " composer-recording" : ""}`}
          data-compact={
            currentDraft().text.includes("\n") || unreferencedDraftAttachments().length > 0 ? undefined : ""
          }
          data-has-attachments={unreferencedDraftAttachments().length > 0 ? "" : undefined}
          onPointerDown={(event) => {
            if (!(event.target instanceof Element)) return;
            if (event.target.closest("button, .composer-editor-surface")) return;
            event.preventDefault();
            setComposerFocusRequest((current) => current + 1);
          }}
        >
          <Show when={unreferencedDraftAttachments().length > 0}>
            <div class="composer-attachments">
              <For each={unreferencedDraftAttachments()}>
                {(attachment) => (
                  <div class="composer-attachment ui-removable-image" data-kind={attachment.kind}>
                    <span
                      class="composer-attachment-preview"
                      data-file-tone={attachment.kind === "file" ? attachmentReferenceTone(attachment.name) : undefined}
                    >
                      <Show when={attachment.kind === "image"} fallback={fileBadge(attachment)}>
                        <img src={attachment.previewUrl ?? ""} alt="" />
                      </Show>
                    </span>
                    <Show when={attachment.kind === "file"}>
                      <span class="composer-attachment-copy">
                        <strong title={attachment.name}>{attachment.name}</strong>
                        <small>{formatFileSize(attachment.size)}</small>
                      </span>
                    </Show>
                    <ImageRemoveButton
                      label={`Remove ${attachment.name}`}
                      disabled={voicePhase() === "transcribing"}
                      onClick={() => removeAttachment(attachment.id)}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="composer-input-label">
            <ComposerEditor
              botId={props.bot?.id}
              bots={props.bots}
              skills={installedSkills()}
              attachments={currentDraft().attachments}
              value={currentDraft().text}
              disabled={submitting() || selectionSending() || voicePhase() === "transcribing" || !agentReady()}
              placeholder={
                !agentReady()
                  ? "Complete agent CLI setup to start"
                  : replyTarget()
                    ? "Reply…"
                    : `Message ${props.bot?.name ?? "agent"}`
              }
              ariaLabel={`Message ${props.bot?.name ?? "agent"}`}
              focusRequest={composerFocusRequest()}
              onValueChange={(text) => {
                updateCurrentDraft({ text });
                updateTeamTyping(text);
              }}
              onSubmit={submitComposer}
              onOpenAttachment={(attachment) =>
                attachment.previewKind === "none"
                  ? attachmentAction(attachment, "open")
                  : void previewAttachment(attachment)
              }
            />
          </div>
          <div class="composer-toolbar">
            <Input
              ref={setImageAttachmentPickerElement}
              type="file"
              accept={IMAGE_ATTACHMENT_ACCEPT}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker="true"
            />
            <Input
              ref={setContextAttachmentPickerElement}
              type="file"
              accept={ATTACHMENT_FILE_ACCEPT}
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker="true"
            />
            <DropdownMenu.Root
              open={showComposerActions()}
              onOpenChange={setShowComposerActions}
              placement="top-start"
              gutter={8}
              modal={false}
            >
              <DropdownMenu.Trigger
                class="composer-button"
                aria-label="Add to prompt"
                disabled={
                  attachmentBusy() ||
                  submitting() ||
                  selectionSending() ||
                  voicePhase() === "transcribing" ||
                  !agentReady()
                }
              >
                <PlusIcon />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content aria-label="Add to prompt">
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker("images");
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event, "images")}
                  >
                    <Image aria-hidden="true" />
                    <span>Attach image</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item disabled title="Skill selection is not available yet.">
                    <Puzzle aria-hidden="true" />
                    <span>Use a skill</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={attachmentBusy()}
                    onPointerDown={(event) => {
                      if (event.button === 0) openAttachmentPicker("all");
                    }}
                    onKeyDown={(event) => openAttachmentPickerFromKey(event, "all")}
                  >
                    <File aria-hidden="true" />
                    <span>Add context</span>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <div class="composer-primary-actions">
              <Show when={voicePhase() === "preparing"}>
                <span class="voice-model-progress" role="status">
                  Downloading voice model {voiceModelProgress() ?? 0}%
                </span>
              </Show>
              <Show
                when={voicePhase() === "recording"}
                fallback={
                  <Button
                    variant="ghost"
                    type="button"
                    class="dictation-button"
                    aria-label={voiceButtonLabel(voicePhase())}
                    disabled={
                      voicePhase() === "requesting" ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "transcribing" ||
                      (voicePhase() === "idle" && (!props.bot || !agentReady()))
                    }
                    onClick={() => void startVoiceRecording()}
                  >
                    <Show
                      when={
                        voicePhase() === "preparing" || voicePhase() === "requesting" || voicePhase() === "transcribing"
                      }
                      fallback={<Mic aria-hidden="true" />}
                    >
                      <LoaderCircle class="dictation-spinner" aria-hidden="true" />
                    </Show>
                  </Button>
                }
              >
                <fieldset class="voice-recording-status" aria-label="Voice recording">
                  <Button
                    variant="ghost"
                    type="button"
                    class="voice-recording-stop"
                    aria-label="Stop voice recording"
                    onClick={stopVoiceRecording}
                  >
                    <StopIcon />
                  </Button>
                  <time class="voice-recording-duration" datetime={`PT${voiceElapsedSeconds()}S`}>
                    {formatVoiceDuration(voiceElapsedSeconds())}
                  </time>
                  <MoreIcon />
                </fieldset>
              </Show>
              <Show
                when={
                  props.activeTurnId && !editingDeliveryId() && !composerHasContent() && voicePhase() !== "recording"
                }
                fallback={
                  <Button
                    variant="ghost"
                    type="button"
                    class="voice-button"
                    aria-label={
                      editingDeliveryId()
                        ? "Save queued message"
                        : voicePhase() === "recording"
                          ? "Send voice message"
                          : "Send message"
                    }
                    disabled={
                      submitting() ||
                      selectionSending() ||
                      !agentReady() ||
                      voicePhase() === "preparing" ||
                      voicePhase() === "requesting" ||
                      voicePhase() === "transcribing"
                    }
                    onClick={submitComposer}
                  >
                    {submitting() ? "…" : "↑"}
                  </Button>
                }
              >
                <Button
                  variant="ghost"
                  type="button"
                  class="voice-button voice-button-active"
                  aria-label="Stop agent"
                  onClick={props.onStop}
                >
                  <StopIcon />
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}

/** @internal Stable HMR boundary for conversation panels. */
export function ConversationPanels() {
  const {
    activateBrowserTab,
    activeBrowserControl,
    activeBrowserTab,
    agentActivity,
    browserAddress,
    browserControlForTab,
    browserControllerForTab,
    browserSidebarOpen,
    browserTabs,
    closeSidebarFilePreview,
    closeBrowserTab,
    conversationPanelElement,
    filePreviewOpen,
    openBrowserAddress,
    openExternalMessageUrl,
    openRoutineRunMessage,
    openSharedFile,
    openSidebarFileExternally,
    openWorkspaceFile,
    navigateBrowserTab,
    props,
    reloadBrowserTab,
    setActiveRightPanel,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setBrowserSurfaceElement,
    setSettingsPanelWidth,
    showBrowserPip,
    handleRoutineSettingsRequest,
    sidebarFilePreview,
    settingsOpen,
    routineSettingsRequest,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    updateRuntimeSettings,
  } = useConversationViewScope();
  return (
    <>
      <Show when={filePreviewOpen() && sidebarFilePreview()}>
        {(file) => (
          <Loading>
            <FilePreviewPanel
              preview={file().preview}
              bots={props.bots}
              defaultWidth={() =>
                (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
              }
              maxWidth={() =>
                Math.min(
                  BROWSER_PANEL_MAX,
                  Math.max(
                    BROWSER_PANEL_MIN,
                    (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                  ),
                )
              }
              onWidthChange={setBrowserPanelWidth}
              onOpenLink={(url) => void openExternalMessageUrl(url)}
              onOpenSharedFile={openSharedFile}
              onOpenWorkspaceFile={openWorkspaceFile}
              onOpenExternally={openSidebarFileExternally}
              onClose={closeSidebarFilePreview}
            />
          </Loading>
        )}
      </Show>

      <Show when={browserSidebarOpen()}>
        <BrowserPanel
          tabs={browserTabs()}
          activeTab={activeBrowserTab()}
          activeControl={activeBrowserControl()}
          address={browserAddress()}
          defaultWidth={() =>
            (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
          }
          maxWidth={() =>
            Math.min(
              BROWSER_PANEL_MAX,
              Math.max(
                BROWSER_PANEL_MIN,
                (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
              ),
            )
          }
          controlForTab={browserControlForTab}
          controllerForTab={browserControllerForTab}
          onAddressChange={setBrowserAddress}
          onAddressEditingChange={setBrowserAddressEditing}
          onOpenAddress={(address) => void openBrowserAddress(address)}
          onNavigate={(tabId, direction) => void navigateBrowserTab(tabId, direction)}
          onReload={(tabId) => void reloadBrowserTab(tabId)}
          onActivateTab={activateBrowserTab}
          onCloseTab={(tabId) => void closeBrowserTab(tabId)}
          onSurface={setBrowserSurfaceElement}
          onWidthChange={setBrowserPanelWidth}
          onEnterPip={showBrowserPip}
        />
      </Show>

      <Show when={settingsOpen() && props.bot}>
        {(bot) => (
          <Loading>
            <AgentSettingsPanel
              bot={bot()}
              runtimeSettings={{
                provider: settingsProvider(),
                model: settingsModel(),
                reasoningEffort: settingsReasoning(),
              }}
              agentStatus={props.agentStatus}
              providerRuntimeStatuses={props.providerRuntimeStatuses}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
              modelOptions={props.modelOptions}
              working={agentActivity() === "Working"}
              maxWidth={() =>
                Math.min(
                  SETTINGS_PANEL_MAX,
                  Math.max(
                    SETTINGS_PANEL_MIN,
                    (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                  ),
                )
              }
              onClose={() => setActiveRightPanel("none")}
              onWidthChange={setSettingsPanelWidth}
              onUpdateBot={props.onUpdateBot}
              onUpdateRuntimeSettings={updateRuntimeSettings}
              onSetAgentAvatar={props.onSetAgentAvatar}
              routineSelectionRequest={routineSettingsRequest()?.botId === bot().id ? routineSettingsRequest() : null}
              onRoutineSelectionRequestHandled={handleRoutineSettingsRequest}
              onOpenRoutineRun={props.onOpenSearchMessage ? openRoutineRunMessage : undefined}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}

/** @internal Stable HMR boundary for conversation overlays. */
export function ConversationOverlays() {
  const { attachmentAction, mediaPreview, setMediaPreview } = useConversationViewScope();
  return (
    <Dialog.Root open={Boolean(mediaPreview())} onOpenChange={(open) => !open && setMediaPreview(null)}>
      <Show when={mediaPreview()}>
        {(preview) => (
          <Dialog.Portal>
            <Dialog.Overlay class="media-backdrop">
              <Dialog.Content as="section" class="media-modal" data-dialog-surface="unstyled">
                <Dialog.Title class="sr-only">{preview().attachment.name}</Dialog.Title>
                <Button
                  variant="ghost"
                  type="button"
                  class="media-close"
                  aria-label="Close media preview"
                  onClick={() => setMediaPreview(null)}
                >
                  <CloseIcon />
                </Button>
                <Show when={preview().attachment.previewKind === "image"}>
                  <img
                    class="media-image"
                    src={preview().attachment.previewUrl ?? ""}
                    alt={preview().attachment.name}
                  />
                </Show>
                <Show when={preview().attachment.previewKind === "pdf"}>
                  <iframe
                    class="media-document"
                    title={preview().attachment.name}
                    src={preview().attachment.previewUrl ?? ""}
                  />
                </Show>
                <Show when={preview().attachment.previewKind === "text"}>
                  <pre class="media-text">{preview().loading ? "Loading…" : (preview().error ?? preview().text)}</pre>
                </Show>
                <div class="media-caption">
                  <span>{preview().attachment.name}</span>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "open")}
                  >
                    Open
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "download")}
                  >
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => attachmentAction(preview().attachment, "reveal")}
                  >
                    Show in Finder
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </Show>
    </Dialog.Root>
  );
}

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
