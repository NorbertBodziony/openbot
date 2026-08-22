import {
  attachmentReferenceIds,
  expandAttachmentReferences,
  removeAttachmentReferences,
} from "@openbot/contracts/attachment-references";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentReasoningEffort,
  AgentStatus,
  AttachmentSummary,
  AvatarImageInput,
  BotAvatarHue,
  BrowserControlAction,
  BrowserControlState,
  BrowserTab,
  DraftAttachment,
  MessageReaction,
  QueueDelivery,
  QueueSnapshot,
  ServerSummary,
  TeamPresenceSnapshot,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { isClaudeModel, VOICE_AUDIO_LIMITS } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { desktopAnalytics } from "../analytics";
import { normalizeAvatarFile } from "../avatar-image";
import { AVATAR_HUE_OPTIONS, avatarCandidateSeeds, avatarHueSwatch } from "../bloub-avatar";
import type { BotMessage, BotProfile } from "../data";
import { appendVoiceTranscript, recordingToWav } from "../voice-recording";
import { AgentAvatar } from "./AgentAvatar";
import { ComposerEditor, expandComposerMentions } from "./ComposerEditor";
import { ApprovalCard, ChoiceCard } from "./ConversationPrompts";
import {
  AgentActivityIndicator,
  type AgentActivityPresentation,
  nextAgentActivityPresentation,
  ThinkingDisclosure,
} from "./conversation/AgentActivity";
import { AttachmentCards, fileBadge, formatFileSize } from "./conversation/AttachmentCards";
import { attachmentReferenceTone } from "./conversation/AttachmentReference";
import { ChatSearch } from "./conversation/ChatSearch";
import {
  BackIcon,
  BrowserBackIcon,
  BrowserControlIcon,
  BrowserForwardIcon,
  BrowserReloadIcon,
  CloseIcon,
  ComputerIcon,
  MoreIcon,
  PlusIcon,
  RemoteDesktopIcon,
  SettingsForwardIcon,
  StopIcon,
} from "./conversation/ConversationIcons";
import {
  type ChatSearchMatch,
  clearChatSearchHighlights,
  findChatSearchMatches,
  renderChatSearchHighlights,
} from "./conversation/chat-search";
import { createChatVirtualizer } from "./conversation/createChatVirtualizer";
import { ScrollToLatestButton, scrollToLatestMessage } from "./conversation/MessageNavigation";
import { ExchangeSystemRow, MessageActions, MessageBody } from "./conversation/MessageRendering";
import { QueuePanel } from "./conversation/QueuePanel";
import { MessageSelectionActions } from "./conversation/SelectionActions";
import {
  scrollToUnreadBoundary,
  UnreadMessagesBanner,
  UnreadMessagesDivider,
  unreadMessagesDividerIsVisible,
} from "./conversation/UnreadMessages";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./PanelResizer";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  Button,
  Combobox,
  Dialog,
  DropdownMenu,
  File,
  Image,
  Input,
  LoaderCircle,
  Mic,
  Popover,
  Puzzle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tabs,
  Textarea,
} from "./ui";

const agentActivityPresentationByBot = new Map<
  string,
  { activityId: string; presentation: AgentActivityPresentation }
>();

interface RenderedAgentActivity {
  activityId: string;
  bot: BotProfile | undefined;
  phase: "active" | "exiting";
  presentation: AgentActivityPresentation;
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

type AgentPickerOption = { kind: "create" } | { kind: "bot"; bot: BotProfile };

interface ConversationProps {
  agentStatus: AgentStatus;
  bot: BotProfile | undefined;
  bots: BotProfile[];
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
  agentPickerOpen: boolean;
  globalOverlayOpen: boolean;
  creatingAgent: boolean;
  settingsRequest: { botId: string; nonce: number } | null;
  onboardingRequest: { botId: string; nonce: number } | null;
  messageFocusRequest: { botId: string; messageId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserControlState: BrowserControlState;
  server: ServerSummary | undefined;
  presence: TeamPresenceSnapshot;
  currentUserEmail: string;
  remoteDesktopSessionActive: boolean;
  remoteDesktopVisible: boolean;
  prompt: Extract<AgentEvent, { type: "prompt" }> | undefined;
  approval: Extract<AgentEvent, { type: "approval" }>["approval"] | undefined;
  onCloseAgentPicker: () => void;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onUpdateBot: (botId: string, updates: Omit<UpdateBotInput, "botId">) => Promise<void>;
  onSetAgentAvatar: (botId: string, image: AvatarImageInput | null) => Promise<void>;
  onSendMessage: (body: string, attachmentDraftIds: string[], replyToMessageId: string | null) => Promise<boolean>;
  onMarkRead: () => Promise<void>;
  onLoadOlder?: () => void;
  onLoadLatest?: () => Promise<void>;
  onSearchMessages?: (query: string) => Promise<{ messageIds: string[]; total: number }>;
  onOpenSearchMessage?: (messageId: string) => Promise<void>;
  onTypingChange: (botId: string, typing: boolean) => void;
  onCompleteOnboarding: (
    answer: string,
    model: AgentModelId,
    reasoningEffort: AgentReasoningEffort,
  ) => Promise<boolean>;
  onAnswerPrompt: (answers: Record<string, string[]>) => Promise<boolean>;
  onRespondToApproval: (decision: "accept" | "decline") => Promise<boolean>;
  onCancelQueuedMessage: (deliveryId: string) => void;
  onSteerQueuedMessage: (deliveryId: string) => void;
  onUpdateQueuedMessage: (
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
  ) => Promise<boolean>;
  onReorderQueue: (deliveryIds: string[]) => void;
  onActivateBrowserTab: (tabId: string) => void;
  onCloseBrowserTab: (tabId: string) => void | Promise<void>;
  onOpenRemoteDesktop: (serverId: string, trigger: HTMLElement) => Promise<void>;
  onOpenAgentSetup: () => Promise<void>;
  onStop: () => void;
}

interface ComposerDraft {
  text: string;
  attachments: DraftAttachment[];
  replyToMessageId: string | null;
}

interface MediaPreview {
  attachment: AttachmentSummary;
  text: string | null;
  loading: boolean;
  error: string | null;
}

type RightPanelMode = "none" | "browser" | "settings";

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  replyToMessageId: null,
};
const ONBOARDING_CHOICES = ["Work & projects", "Research & writing", "Sales & outreach", "Something else"];
const SETTINGS_PANEL_STORAGE_KEY = "openbot:settings-panel-width";
const SETTINGS_PANEL_DEFAULT = 296;
const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;
const BROWSER_PANEL_STORAGE_KEY = "openbot:browser-panel-width";
const BROWSER_PANEL_DEFAULT = 380;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;

const BROWSER_ACTION_LABELS: Record<BrowserControlAction, string> = {
  open: "Opening a page…",
  "list-tabs": "Checking tabs…",
  snapshot: "Reading the page…",
  click: "Clicking…",
  type: "Typing…",
  key: "Using the keyboard…",
  scroll: "Scrolling…",
  back: "Going back…",
  forward: "Going forward…",
  reload: "Reloading…",
  screenshot: "Taking a screenshot…",
  "close-tab": "Closing a tab…",
};

export function Conversation(props: ConversationProps) {
  const agentReady = () => props.agentStatus.phase === "ready";
  const imageGenerationUnavailable = () => Boolean(props.bot && isClaudeModel(props.bot.model));
  const [drafts, setDrafts] = createSignal<Record<string, ComposerDraft>>({});
  const [editingDeliveryId, setEditingDeliveryId] = createSignal<string | null>(null);
  const [editingDraftBackup, setEditingDraftBackup] = createSignal<ComposerDraft | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = createSignal(0);
  const [showComposerActions, setShowComposerActions] = createSignal(false);
  const [attachmentBusy, setAttachmentBusy] = createSignal(false);
  const [composerError, setComposerError] = createSignal<string | null>(null);
  const [voicePhase, setVoicePhase] = createSignal<"idle" | "requesting" | "recording" | "transcribing">("idle");
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = createSignal(0);
  const [markingRead, setMarkingRead] = createSignal(false);
  const [settingsSaveError, setSettingsSaveError] = createSignal<string | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [selectionSending, setSelectionSending] = createSignal(false);
  const [dropActive, setDropActive] = createSignal(false);
  const [rightPanels, setRightPanels] = createSignal<Record<string, RightPanelMode>>({});
  const [settingsName, setSettingsName] = createSignal("");
  const [settingsTitle, setSettingsTitle] = createSignal("");
  const [settingsDescription, setSettingsDescription] = createSignal("");
  const [settingsDirty, setSettingsDirty] = createSignal({ name: false, title: false, description: false });
  const [settingsNotifications, setSettingsNotifications] = createSignal(true);
  const [settingsModel, setSettingsModel] = createSignal<AgentModelId>("gpt-5.6-luna");
  const [settingsReasoning, setSettingsReasoning] = createSignal<AgentReasoningEffort>("medium");
  const [onboardingBots, setOnboardingBots] = createSignal<Record<string, true>>({});
  const [modelConfirmedBots, setModelConfirmedBots] = createSignal<Record<string, true>>({});
  const [completedOnboardingBots, setCompletedOnboardingBots] = createSignal<Record<string, true>>({});
  const automaticallyOnboardedBots = new Set<string>();
  const [avatarPickerOpen, setAvatarPickerOpen] = createSignal(false);
  const [avatarSeed, setAvatarSeed] = createSignal("agent");
  const [avatarHue, setAvatarHue] = createSignal<BotAvatarHue | null>(null);
  const avatarUrl = () => props.bot?.avatarUrl ?? null;
  const [avatarUploadBusy, setAvatarUploadBusy] = createSignal(false);
  const [avatarCandidateSeed, setAvatarCandidateSeed] = createSignal("agent");
  const [avatarBatch, setAvatarBatch] = createSignal(0);
  const avatarCandidates = createMemo(() => {
    const bot = props.bot;
    return bot ? avatarCandidateSeeds(bot.id, avatarCandidateSeed(), avatarBatch()) : [];
  });
  const [browserAddress, setBrowserAddress] = createSignal("https://www.google.com");
  const [mediaPreview, setMediaPreview] = createSignal<MediaPreview | null>(null);
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
  let typingIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let typingBotId: string | null = null;
  let imageAttachmentPicker: HTMLInputElement | undefined;
  let contextAttachmentPicker: HTMLInputElement | undefined;
  let voiceRecorder: MediaRecorder | undefined;
  let voiceStream: MediaStream | undefined;
  let voiceRecordingTimer: ReturnType<typeof setTimeout> | undefined;
  let voiceElapsedTimer: ReturnType<typeof setInterval> | undefined;
  let voiceChunks: Blob[] = [];
  let voiceBotId: string | undefined;
  let voiceDisposed = false;
  const [settingsPanelWidth, setSettingsPanelWidth] = createSignal(
    readPanelWidth(SETTINGS_PANEL_STORAGE_KEY, SETTINGS_PANEL_DEFAULT, SETTINGS_PANEL_MIN, SETTINGS_PANEL_MAX),
  );
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(
    readPanelWidth(BROWSER_PANEL_STORAGE_KEY, BROWSER_PANEL_DEFAULT, BROWSER_PANEL_MIN, BROWSER_PANEL_MAX),
  );
  const selectedModel = createMemo(() => props.modelOptions.find((option) => option.id === settingsModel()));
  const reasoningOptions = createMemo(() => selectedModel()?.supportedReasoningEfforts ?? ["medium" as const]);
  const onboardingActive = createMemo(() => {
    const botId = props.bot?.id;
    return Boolean(botId && onboardingBots()[botId]);
  });
  const onboardingModelConfirmed = createMemo(() => {
    const botId = props.bot?.id;
    return Boolean(botId && onboardingActive() && modelConfirmedBots()[botId]);
  });
  const onboardingModelRequired = createMemo(() => agentReady() && onboardingActive() && !onboardingModelConfirmed());
  const currentDraft = createMemo(() => {
    const id = props.bot?.id;
    return id ? (drafts()[id] ?? EMPTY_DRAFT) : EMPTY_DRAFT;
  });
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
  const agentPickerOptions = createMemo<AgentPickerOption[]>(() => [
    { kind: "create" },
    ...props.bots.map((bot) => ({ kind: "bot" as const, bot })),
  ]);
  const activeRightPanel = createMemo<RightPanelMode>(() => {
    if (props.agentPickerOpen) return "none";
    const botId = props.bot?.id;
    return botId ? (rightPanels()[botId] ?? "none") : "none";
  });
  const screenOpen = () => activeRightPanel() === "browser";
  const settingsOpen = () => activeRightPanel() === "settings";
  const browserTabs = createMemo(() => {
    const bot = props.bot;
    if (!bot) return [];
    return props.browserTabs.filter((tab) =>
      tab.ownerBotId ? tab.ownerBotId === bot.id : Boolean(bot.threadId && tab.ownerThreadId === bot.threadId),
    );
  });
  const activeBrowserTab = createMemo(
    () => browserTabs().find((tab) => tab.id === props.activeBrowserTabId) ?? browserTabs()[0],
  );
  let previousBrowserTabCount = 0;
  createEffect(
    () => ({ count: browserTabs().length, open: screenOpen() }),
    ({ count, open }) => {
      const browserWasClosed = open && previousBrowserTabCount > 0 && count === 0;
      previousBrowserTabCount = count;
      if (browserWasClosed) hideBrowserPanel();
    },
  );
  const activeBrowserControl = createMemo(() => {
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
  const browserControlBot = createMemo(() => {
    const control = activeBrowserControl();
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  });
  const browserControlForTab = (tab: BrowserTab) => {
    const sessions = props.browserControlState.sessions;
    return (
      sessions.find((session) => session.tabId === tab.id) ??
      sessions.find(
        (session) =>
          session.tabId === null && tab.id === activeBrowserTab()?.id && session.threadId === tab.ownerThreadId,
      )
    );
  };
  const browserControllerForTab = (tab: BrowserTab) => {
    const control = browserControlForTab(tab);
    return control ? props.bots.find((bot) => bot.threadId === control.threadId) : undefined;
  };
  const activeDeliveries = createMemo(() => {
    const deliveries = (props.queue?.deliveries ?? []).filter(
      (delivery) => delivery.status === "starting" || delivery.status === "running",
    );
    const activeTurnId = props.activeTurnId;
    if (!activeTurnId) return deliveries;
    const matching = deliveries.filter((delivery) => delivery.turnId === activeTurnId || delivery.turnId === null);
    return matching.length > 0 ? matching : deliveries;
  });
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
  const agentActivity = createMemo<"Working" | null>(() => (activeActivityId() ? "Working" : null));
  const activityPresentation = createMemo<AgentActivityPresentation | null>(() => {
    const botId = props.bot?.id;
    const activityId = activeActivityId();
    if (!botId || !activityId) return null;
    const previous = agentActivityPresentationByBot.get(botId);
    if (previous?.activityId === activityId) return previous.presentation;
    const presentation = nextAgentActivityPresentation(previous?.presentation);
    agentActivityPresentationByBot.set(botId, { activityId, presentation });
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
        const nextActivity = { activityId, bot, phase: "active" as const, presentation };
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
            setRenderedAgentActivity(nextActivity);
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
  onCleanup(() => {
    clearAgentActivityShowTimer();
    clearAgentActivityExitDelayTimer();
    clearAgentActivityExitTimer();
  });
  const orderedQueuedDeliveries = createMemo(() =>
    [...(props.queue?.deliveries ?? [])]
      .filter((delivery) => delivery.status === "queued")
      .sort((left, right) => {
        const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
        return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt);
      }),
  );
  const presentedQueueDeliveries = createMemo(() => {
    const snapshot = props.queue;
    if (!snapshot) return [];
    const activeTurnId = props.activeTurnId;
    if (activeDeliveries().length === 0) return [];
    const renderedMessageIds = new Set(props.messages.map((message) => message.id));
    const queued = orderedQueuedDeliveries().filter(
      (delivery) => (!activeTurnId || delivery.turnId !== activeTurnId) && !renderedMessageIds.has(delivery.id),
    );
    const steering = snapshot.deliveries.filter(
      (delivery) =>
        delivery.status === "starting" &&
        Boolean(activeTurnId) &&
        delivery.turnId === activeTurnId &&
        !renderedMessageIds.has(delivery.id),
    );
    return [...queued, ...steering];
  });
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
  const seenMessageIds = new Set<string>();
  const [fadeAtTop, setFadeAtTop] = createSignal(false);
  const [fadeAtBottom, setFadeAtBottom] = createSignal(false);
  const [showScrollToLatest, setShowScrollToLatest] = createSignal(false);
  const [unreadDividerVisible, setUnreadDividerVisible] = createSignal(false);
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
  let pickerInput: HTMLInputElement | undefined;
  let chatSearchInput: HTMLInputElement | undefined;
  let chatSearchReturnFocus: HTMLElement | undefined;
  let chatSearchFrame: number | undefined;
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSearchRequest = 0;
  let lastChatSearchQuery = "";
  let avatarPickerRoot: HTMLDivElement | undefined;
  let avatarFileInput: HTMLInputElement | undefined;
  let stickToLatest = true;
  let lastConversationBotId: string | undefined;
  let lastPanelBotId: string | undefined;
  let lastHandledSettingsRequestNonce: number | undefined;
  let lastHandledOnboardingRequestNonce: number | undefined;
  let lastHandledMessageFocusNonce: number | undefined;
  let lastSettingsSignature: string | undefined;
  let lastAvatarSettingsBotId: string | undefined;
  let controlledBrowserBotIds = new Set<string>();
  const importTargetBots = new Map<string, string>();
  const messageVirtualizer = createChatVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: () => props.messages.length,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => 128,
    getItemKey: (index) => props.messages[index]?.id ?? index,
    scrollMargin: () => virtualRoot?.offsetTop ?? 0,
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
    setSettingsSaveError(null);
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : "Could not save agent settings.");
      return false;
    }
  }

  function saveSettingsName(): void {
    const botId = props.bot?.id;
    if (!botId) return;
    const name = settingsName().trim() || "New agent";
    setSettingsName(name);
    void saveBotPatch({ name }, botId).then((saved) => {
      if (saved && props.bot?.id === botId && settingsName() === name) {
        setSettingsDirty((current) => ({ ...current, name: false }));
      }
    });
  }

  function saveSettingsTitle(): void {
    const botId = props.bot?.id;
    if (!botId) return;
    const title = settingsTitle().trim();
    setSettingsTitle(title);
    void saveBotPatch({ title }, botId).then((saved) => {
      if (saved && props.bot?.id === botId && settingsTitle() === title) {
        setSettingsDirty((current) => ({ ...current, title: false }));
      }
    });
  }

  function saveSettingsDescription(): void {
    const botId = props.bot?.id;
    if (!botId) return;
    const description = settingsDescription();
    void saveBotPatch({ description }, botId).then((saved) => {
      if (saved && props.bot?.id === botId && settingsDescription() === description) {
        setSettingsDirty((current) => ({ ...current, description: false }));
      }
    });
  }

  async function setCustomAvatar(image: AvatarImageInput | null): Promise<boolean> {
    const botId = props.bot?.id;
    if (!botId || avatarUploadBusy()) return false;
    setAvatarUploadBusy(true);
    setSettingsSaveError(null);
    try {
      await props.onSetAgentAvatar(botId, image);
      return true;
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : "Could not save the agent avatar.");
      return false;
    } finally {
      setAvatarUploadBusy(false);
    }
  }

  async function uploadAgentAvatar(file: File | undefined): Promise<void> {
    if (!file) return;
    setAvatarUploadBusy(true);
    setSettingsSaveError(null);
    try {
      const image = await normalizeAvatarFile(file);
      const botId = props.bot?.id;
      if (!botId) return;
      await props.onSetAgentAvatar(botId, image);
    } catch (error) {
      setSettingsSaveError(error instanceof Error ? error.message : "Could not process the agent avatar.");
    } finally {
      setAvatarUploadBusy(false);
      if (avatarFileInput) avatarFileInput.value = "";
    }
  }

  async function selectGeneratedAvatar(seed: string): Promise<void> {
    if (avatarUrl() && !(await setCustomAvatar(null))) return;
    setAvatarSeed(seed);
    await saveBotPatch({ avatarSeed: seed });
  }

  async function selectModel(model: AgentModelId, persist = true, reportComposerError = false): Promise<boolean> {
    const option = props.modelOptions.find((candidate) => candidate.id === model);
    if (!option) return false;
    const reasoningEffort = option.supportedReasoningEfforts.includes(settingsReasoning())
      ? settingsReasoning()
      : option.defaultReasoningEffort;
    const previousModel = settingsModel();
    const previousReasoning = settingsReasoning();
    setSettingsModel(model);
    setSettingsReasoning(reasoningEffort);
    if (!persist) return true;
    if (reportComposerError) setComposerError(null);
    const saved = await saveBotPatch({ model, reasoningEffort });
    if (saved) return true;
    setSettingsModel(previousModel);
    setSettingsReasoning(previousReasoning);
    if (reportComposerError) setComposerError("Could not change model. Try again.");
    return false;
  }

  async function selectAndConfirmModel(model: AgentModelId): Promise<void> {
    if (!(await selectModel(model, true, true))) return;
    const botId = props.bot?.id;
    if (botId) setModelConfirmedBots((current) => ({ ...current, [botId]: true }));
  }

  function finishOnboarding(botId: string): void {
    automaticallyOnboardedBots.delete(botId);
    setCompletedOnboardingBots((current) => ({ ...current, [botId]: true }));
    setOnboardingBots((current) => {
      if (!current[botId]) return current;
      const next = { ...current };
      delete next[botId];
      return next;
    });
    setModelConfirmedBots((current) => {
      if (!current[botId]) return current;
      const next = { ...current };
      delete next[botId];
      return next;
    });
  }

  function updateScrollFade(element = scrollElement) {
    if (!element) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFadeAtTop(element.scrollTop > 2);
    setFadeAtBottom(remaining > 2);
    setShowScrollToLatest(remaining > 80);
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
    if (seenMessageIds.has(key)) return false;
    seenMessageIds.add(key);
    return true;
  };

  const updateCurrentDraft = (patch: Partial<ComposerDraft>) => {
    const id = props.bot?.id;
    if (!id) return;
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  async function startVoiceRecording(): Promise<void> {
    const botId = props.bot?.id;
    if (!botId || voicePhase() !== "idle") return;
    setComposerError(null);
    setVoicePhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (voiceDisposed || voicePhase() !== "requesting") {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream);
      voiceStream = stream;
      voiceRecorder = recorder;
      voiceBotId = botId;
      voiceChunks = [];
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) voiceChunks.push(event.data);
      });
      recorder.addEventListener("stop", () => void finishVoiceRecording(recorder.mimeType));
      recorder.start();
      startVoiceElapsedTimer();
      setVoicePhase("recording");
      voiceRecordingTimer = setTimeout(stopVoiceRecording, VOICE_AUDIO_LIMITS.maximumSeconds * 1_000);
    } catch (error) {
      setVoicePhase("idle");
      setComposerError(voiceCaptureError(error));
    }
  }

  function stopVoiceRecording(): void {
    if (voicePhase() !== "recording" || !voiceRecorder) return;
    setVoicePhase("transcribing");
    stopVoiceElapsedTimer();
    if (voiceRecordingTimer) clearTimeout(voiceRecordingTimer);
    voiceRecordingTimer = undefined;
    voiceRecorder.stop();
    stopVoiceStream();
  }

  async function finishVoiceRecording(mimeType: string): Promise<void> {
    const targetBotId = voiceBotId;
    const chunks = voiceChunks;
    voiceRecorder = undefined;
    voiceBotId = undefined;
    voiceChunks = [];
    if (!targetBotId || voiceDisposed) return;
    try {
      if (chunks.length === 0) throw new Error("No speech was recorded.");
      const audio = await recordingToWav(new Blob(chunks, { type: mimeType }));
      const result = await window.openbot.voice.transcribe({ audio });
      if (voiceDisposed || !props.bots.some((bot) => bot.id === targetBotId)) return;
      if (!result.text.trim()) throw new Error("No speech was detected.");
      setDrafts((current) => {
        const draft = current[targetBotId] ?? EMPTY_DRAFT;
        return {
          ...current,
          [targetBotId]: { ...draft, text: appendVoiceTranscript(draft.text, result.text) },
        };
      });
      if (props.bot?.id === targetBotId) setComposerFocusRequest((current) => current + 1);
    } catch (error) {
      if (!voiceDisposed && props.bot?.id === targetBotId) setComposerError(voiceTranscriptionError(error));
    } finally {
      if (!voiceDisposed) setVoicePhase("idle");
    }
  }

  function stopVoiceStream(): void {
    for (const track of voiceStream?.getTracks() ?? []) track.stop();
    voiceStream = undefined;
  }

  function startVoiceElapsedTimer(): void {
    stopVoiceElapsedTimer();
    const startedAt = Date.now();
    setVoiceElapsedSeconds(0);
    voiceElapsedTimer = setInterval(() => {
      setVoiceElapsedSeconds(Math.min(VOICE_AUDIO_LIMITS.maximumSeconds, Math.floor((Date.now() - startedAt) / 1_000)));
    }, 250);
  }

  function stopVoiceElapsedTimer(): void {
    if (voiceElapsedTimer) clearInterval(voiceElapsedTimer);
    voiceElapsedTimer = undefined;
  }

  onSettled(() => {
    const unsubscribeImport = window.openbot.agent.onAttachmentImport((event) => {
      if (event.type === "started") {
        const botId = props.bot?.id;
        if (botId) importTargetBots.set(event.requestId, botId);
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        setComposerError(event.message);
      } else {
        setAttachmentBusy(false);
        const botId = importTargetBots.get(event.requestId);
        importTargetBots.delete(event.requestId);
        if (botId && props.bots.some((bot) => bot.id === botId)) {
          addAttachments(event.attachments, botId);
        } else {
          for (const attachment of event.attachments) {
            void window.openbot.agent.discardDraftAttachment(attachment.id);
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
      if (editingDeliveryId()) {
        cancelQueuedMessageEdit();
        return;
      }
      setOpenReactionMessageId(null);
      setOpenMoreMessageId(null);
      setExpandedEmojiMessageId(null);
      hideBrowserPanel();
      setMediaPreview(null);
      setAvatarPickerOpen(false);
      props.onCloseAgentPicker();
    };
    const closeActiveBrowserTab = (event: KeyboardEvent) => {
      if (
        !screenOpen() ||
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
    const closeAvatarPicker = (event: PointerEvent) => {
      if (!avatarPickerOpen()) return;
      if (event.target instanceof Node && avatarPickerRoot?.contains(event.target)) return;
      setAvatarPickerOpen(false);
    };
    const keyboardTarget = conversationPanel?.ownerDocument ?? document;
    const keyboardWindow = keyboardTarget.defaultView ?? window;
    keyboardTarget.addEventListener("keydown", closeOnEscape);
    keyboardWindow.addEventListener("keydown", closeActiveBrowserTab);
    keyboardTarget.addEventListener("keydown", handleChatSearchShortcut);
    window.addEventListener("pointerdown", closeMessageMenus);
    window.addEventListener("pointerdown", closeAvatarPicker);
    scrollResizeObserver = new ResizeObserver(() => {
      if (scrollElement && stickToLatest) followConversationBottom(scrollElement);
      updateScrollFade();
      updateUnreadDividerVisibility();
    });
    if (scrollElement) scrollResizeObserver.observe(scrollElement);
    if (virtualRoot) scrollResizeObserver.observe(virtualRoot);
    if (agentActivitySlot) scrollResizeObserver.observe(agentActivitySlot);
    requestAnimationFrame(() => {
      if (!scrollElement) return;
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
      keyboardWindow.removeEventListener("keydown", closeActiveBrowserTab);
      keyboardTarget.removeEventListener("keydown", handleChatSearchShortcut);
      window.removeEventListener("pointerdown", closeMessageMenus);
      window.removeEventListener("pointerdown", closeAvatarPicker);
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
    () => ({ request: props.onboardingRequest, botId: props.bot?.id }),
    ({ request, botId }) => {
      if (!request || botId !== request.botId || request.nonce === lastHandledOnboardingRequestNonce) return;
      lastHandledOnboardingRequestNonce = request.nonce;
      automaticallyOnboardedBots.delete(request.botId);
      setOnboardingBots((current) => ({ ...current, [request.botId]: true }));
      setModelConfirmedBots((current) => ({
        ...current,
        [request.botId]: true,
      }));
      setActiveRightPanel("none", botId);
    },
  );

  createEffect(
    () => {
      const lastMessage = props.messages[props.messages.length - 1];
      return {
        botId: props.bot?.id,
        activeTurnId: props.activeTurnId,
        queueSignature: props.queue?.deliveries.map((delivery) => `${delivery.id}:${delivery.status}`).join("|"),
        lastMessageBody: lastMessage?.body,
        lastMessageStatus: lastMessage?.status,
        deliverySignature: lastMessage?.exchange?.deliveries
          .map((delivery) => `${delivery.id}:${delivery.status}:${delivery.position}`)
          .join("|"),
        loaded: props.loaded,
        agentPickerOpen: props.agentPickerOpen,
        prompt: props.prompt,
        unreadCount: props.unreadCount,
      };
    },
    ({ botId, unreadCount }) => {
      currentUnreadCount = unreadCount;
      if (botId !== lastConversationBotId) {
        if (lastConversationBotId !== undefined) closeChatSearch(false);
        lastConversationBotId = botId;
        stickToLatest = true;
        setAgentActivitySpaceReserved(false);
        setEditingDeliveryId(null);
        setEditingDraftBackup(null);
      }
      if (latestScrollFrame !== undefined) cancelAnimationFrame(latestScrollFrame);
      if (latestScrollSettleFrame !== undefined) cancelAnimationFrame(latestScrollSettleFrame);
      const followLatest = stickToLatest;
      latestScrollFrame = requestAnimationFrame(() => {
        latestScrollFrame = undefined;
        if (!scrollElement) return;
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
    () => ({
      botId: props.bot?.id,
      hasConversationMessage: props.messages.some((message) => !message.id.startsWith("ui-")),
    }),
    ({ botId, hasConversationMessage }) => {
      if (!botId || !hasConversationMessage || !automaticallyOnboardedBots.delete(botId)) return;
      setOnboardingBots((current) => {
        if (!current[botId]) return current;
        const next = { ...current };
        delete next[botId];
        return next;
      });
    },
  );

  createEffect(
    () => {
      const bot = props.bot;
      if (!bot) return null;
      return {
        id: bot.id,
        signature: [
          bot.id,
          bot.name,
          bot.title,
          bot.description,
          String(bot.notifications),
          bot.model,
          bot.reasoningEffort,
          bot.avatarSeed,
          String(bot.avatarHue),
        ].join("\u0000"),
        name: bot.name,
        title: bot.title,
        description: bot.description,
        notifications: bot.notifications,
        model: bot.model,
        reasoningEffort: bot.reasoningEffort,
        avatarSeed: bot.avatarSeed,
        avatarHue: bot.avatarHue,
      };
    },
    (bot) => {
      if (!bot || bot.signature === lastSettingsSignature) return;
      const botChanged = bot.id !== lastAvatarSettingsBotId;
      const dirty = botChanged ? { name: false, title: false, description: false } : settingsDirty();
      lastSettingsSignature = bot.signature;
      lastAvatarSettingsBotId = bot.id;
      if (botChanged) setSettingsDirty(dirty);
      if (!dirty.name) {
        setSettingsName(bot.name);
      }
      if (!dirty.title) {
        setSettingsTitle(bot.title);
      }
      if (!dirty.description) {
        setSettingsDescription(bot.description);
      }
      setSettingsNotifications(bot.notifications);
      setSettingsModel(bot.model);
      setSettingsReasoning(bot.reasoningEffort);
      setAvatarSeed(bot.avatarSeed);
      setAvatarHue(bot.avatarHue);
      if (botChanged) {
        setAvatarCandidateSeed(bot.avatarSeed);
        setAvatarBatch(0);
        setAvatarPickerOpen(false);
      }
    },
  );

  createEffect(
    () => {
      const botId = props.bot?.id;
      if (
        !botId ||
        !props.loaded ||
        !agentReady() ||
        props.activeTurnId ||
        props.messages.length > 0 ||
        props.onboardingRequest?.botId === botId ||
        completedOnboardingBots()[botId] ||
        onboardingBots()[botId]
      )
        return null;
      return botId;
    },
    (botId) => {
      if (botId) {
        automaticallyOnboardedBots.add(botId);
        setOnboardingBots((current) => ({ ...current, [botId]: true }));
      }
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
      if (!previousBotId || !botId || panel !== "settings") return;
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
    () => props.agentPickerOpen,
    (open) => {
      if (!open) return;
      requestAnimationFrame(() => pickerInput?.focus());
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      activeTab: activeBrowserTab(),
      screenOpen: screenOpen(),
      activeBrowserTabId: props.activeBrowserTabId,
      onActivateBrowserTab: props.onActivateBrowserTab,
    }),
    ({ activeTab, screenOpen, activeBrowserTabId, onActivateBrowserTab }) => {
      setBrowserAddress(activeTab?.url ?? "https://www.google.com");
      if (screenOpen && activeTab && activeTab.id !== activeBrowserTabId) {
        onActivateBrowserTab(activeTab.id);
      }
    },
  );

  createEffect(
    () =>
      new Set(
        props.browserControlState.sessions
          .map((session) => props.bots.find((bot) => bot.threadId === session.threadId)?.id)
          .filter((botId): botId is string => Boolean(botId)),
      ),
    (controlledBotIds) => {
      const newlyControlledBotIds = [...controlledBotIds].filter((botId) => !controlledBrowserBotIds.has(botId));
      controlledBrowserBotIds = controlledBotIds;
      if (newlyControlledBotIds.length === 0) return;
      setRightPanels((current) => {
        const next = { ...current };
        let changed = false;
        for (const botId of newlyControlledBotIds) {
          if (next[botId] === "browser") continue;
          next[botId] = "browser";
          changed = true;
        }
        return changed ? next : current;
      });
    },
  );

  createEffect(
    () => ({ botId: props.bot?.id, visible: screenOpen() && !props.globalOverlayOpen }),
    ({ botId, visible }) => {
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
        if (generation !== browserVisibilityGeneration || props.bot?.id !== botId || !screenOpen() || !browserSurface) {
          return;
        }
        const syncBounds = () => {
          if (
            generation !== browserVisibilityGeneration ||
            props.bot?.id !== botId ||
            !screenOpen() ||
            !browserSurface
          ) {
            return;
          }
          const bounds = browserSurface.getBoundingClientRect();
          void window.openbot.browser.setVisible({
            visible: true,
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
        browserWindowResizeHandler = scheduleBoundsSync;
        window.addEventListener("resize", browserWindowResizeHandler);
      });
    },
  );

  onCleanup(() => {
    voiceDisposed = true;
    if (voiceRecordingTimer) clearTimeout(voiceRecordingTimer);
    stopVoiceElapsedTimer();
    if (voiceRecorder?.state === "recording") voiceRecorder.stop();
    stopVoiceStream();
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (typingBotId) props.onTypingChange(typingBotId, false);
    void window.openbot.browser.setVisible({ visible: false });
  });

  function updateTeamTyping(text: string): void {
    const botId = props.bot?.id;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (!botId || !text.trim()) {
      stopTeamTyping();
      return;
    }
    if (typingBotId && typingBotId !== botId) props.onTypingChange(typingBotId, false);
    typingBotId = botId;
    props.onTypingChange(botId, true);
    typingIdleTimer = setTimeout(stopTeamTyping, 3_000);
  }

  function stopTeamTyping(): void {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = undefined;
    if (!typingBotId) return;
    props.onTypingChange(typingBotId, false);
    typingBotId = null;
  }

  function addAttachments(selected: DraftAttachment[], botId = props.bot?.id) {
    if (!botId) return;
    const draft = drafts()[botId] ?? EMPTY_DRAFT;
    const available = Math.max(0, 10 - draft.attachments.length);
    const accepted = selected.slice(0, available);
    for (const attachment of selected.slice(available)) {
      void window.openbot.agent.discardDraftAttachment(attachment.id);
    }
    setDrafts((current) => ({
      ...current,
      [botId]: {
        ...(current[botId] ?? EMPTY_DRAFT),
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
    if (!botId || delivery.status !== "queued") return;
    setEditingDraftBackup({
      text: currentDraft().text,
      attachments: [...currentDraft().attachments],
      replyToMessageId: currentDraft().replyToMessageId,
    });
    setEditingDeliveryId(delivery.id);
    setDrafts((current) => ({
      ...current,
      [botId]: {
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
    const botId = props.bot?.id;
    const backup = editingDraftBackup();
    const editedDelivery = props.queue?.deliveries.find((delivery) => delivery.id === editingDeliveryId());
    const preservedAttachmentIds = new Set([
      ...(backup?.attachments.map((attachment) => attachment.id) ?? []),
      ...(editedDelivery?.attachments.map((attachment) => attachment.id) ?? []),
    ]);
    for (const attachment of currentDraft().attachments) {
      if (!preservedAttachmentIds.has(attachment.id)) {
        void window.openbot.agent.discardDraftAttachment(attachment.id);
      }
    }
    if (botId) {
      setDrafts((current) => ({ ...current, [botId]: backup ?? EMPTY_DRAFT }));
    }
    setEditingDeliveryId(null);
    setEditingDraftBackup(null);
  }

  async function saveQueuedMessageEdit(): Promise<void> {
    const botId = props.bot?.id;
    const deliveryId = editingDeliveryId();
    const draft = currentDraft();
    if (!botId || !deliveryId || submitting()) return;
    const delivery = props.queue?.deliveries.find((item) => item.id === deliveryId);
    if (delivery?.status !== "queued") {
      setComposerError("This queued message is no longer available.");
      cancelQueuedMessageEdit();
      return;
    }
    const text = expandComposerMentions(draft.text);
    const originalAttachmentIds = new Set(delivery.attachments.map((attachment) => attachment.id));
    const keepAttachmentIds = draft.attachments
      .filter((attachment) => originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    const attachmentDraftIds = draft.attachments
      .filter((attachment) => !originalAttachmentIds.has(attachment.id))
      .map((attachment) => attachment.id);
    if (!text.trim() && keepAttachmentIds.length === 0 && attachmentDraftIds.length === 0) return;

    stopTeamTyping();
    setSubmitting(true);
    setComposerError(null);
    let saved = false;
    try {
      saved = await props.onUpdateQueuedMessage(deliveryId, text, keepAttachmentIds, attachmentDraftIds);
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
    if (!saved) return;
    setDrafts((current) => ({ ...current, [botId]: EMPTY_DRAFT }));
    setEditingDeliveryId(null);
    setEditingDraftBackup(null);
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

  async function submitMessage(override?: string) {
    if (selectionSending()) return;
    if (!override && editingDeliveryId()) {
      await saveQueuedMessageEdit();
      return;
    }
    const botId = props.bot?.id;
    const draft = currentDraft();
    const text = override ?? expandComposerMentions(draft.text);
    const attachments = override ? [] : draft.attachments;
    if (!botId || submitting() || onboardingModelRequired() || (!text.trim() && attachments.length === 0)) return;
    stopTeamTyping();
    stickToLatest = true;
    setSubmitting(true);
    setComposerError(null);
    const sent = await props.onSendMessage(
      text,
      attachments.map((item) => item.id),
      override ? null : draft.replyToMessageId,
    );
    setSubmitting(false);
    if (sent) {
      setDrafts((current) => ({ ...current, [botId]: EMPTY_DRAFT }));
      finishOnboarding(botId);
    }
  }

  async function sendSelectionInstruction(messageId: string, body: string): Promise<boolean> {
    if (!props.bot || submitting() || selectionSending() || !agentReady() || onboardingModelRequired()) {
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
    setOpenReactionMessageId(null);
    setExpandedEmojiMessageId(null);
    try {
      await window.openbot.agent.setMessageReaction({
        botId,
        messageId: message.id,
        emoji,
      });
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  async function copyMessage(message: BotMessage) {
    const attachmentNames = new Map((message.attachments ?? []).map((attachment) => [attachment.id, attachment.name]));
    const text = expandAttachmentReferences(message.body, (reference) => attachmentNames.get(reference.attachmentId));
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
    updateCurrentDraft({
      attachments: currentDraft().attachments.filter((attachment) => attachment.id !== id),
      text: removeAttachmentReferences(currentDraft().text, id),
    });
    void window.openbot.agent.discardDraftAttachment(id);
  }

  async function openBrowserAddress(address = browserAddress()) {
    const value = address.trim();
    if (!value) return;
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    try {
      const tab = await window.openbot.browser.open({
        url,
        ownerThreadId: props.bot?.threadId ?? null,
        ownerBotId: props.bot?.id ?? null,
      });
      setBrowserAddress(tab.url);
      setActiveRightPanel("browser");
      desktopAnalytics.track("browser_action", { action: "open", result: "succeeded" });
    } catch {
      setBrowserAddress(url);
      desktopAnalytics.track("browser_action", { action: "open", result: "failed" });
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
    setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    void window.openbot.browser.setVisible({ visible: false });
  }

  async function closeBrowserTab(tabId: string) {
    const closesLastTab = browserTabs().length === 1 && browserTabs()[0]?.id === tabId;
    await props.onCloseBrowserTab(tabId);
    if (closesLastTab) hideBrowserPanel();
  }

  function setActiveRightPanel(mode: RightPanelMode, botId = props.bot?.id) {
    if (!botId) return;
    setRightPanels((current) => (current[botId] === mode ? current : { ...current, [botId]: mode }));
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
    void window.openbot.agent
      .openSharedFile({ path })
      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
  }

  function openWorkspaceFile(path: string) {
    const botId = props.bot?.id;
    if (!botId) return;
    void window.openbot.agent
      .openWorkspaceFile({ botId, path })
      .catch((error) => setComposerError(error instanceof Error ? error.message : String(error)));
  }

  return (
    <main
      ref={(element) => (conversationPanel = element)}
      aria-label="Conversation"
      onKeyDown={handleChatSearchShortcut}
      class={[
        "conversation-panel",
        {
          "conversation-drop-active": dropActive(),
          "browser-panel-active": screenOpen(),
        },
      ]}
      style={`--settings-panel-width: ${settingsPanelWidth()}px; --browser-panel-width: ${browserPanelWidth()}px`}
      onDragEnter={(event) => {
        if (event.dataTransfer?.types.includes("Files")) setDropActive(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDropActive(false);
      }}
    >
      <MessageSelectionActions
        contextKey={props.bot?.id}
        disabled={!props.bot || !agentReady() || onboardingModelRequired() || submitting()}
        onSend={sendSelectionInstruction}
      />
      <Show when={dropActive()}>
        <div class="attachment-drop-overlay">Drop files to attach</div>
      </Show>
      <header class="window-drag conversation-header">
        <Show
          when={props.agentPickerOpen}
          fallback={
            <>
              <div class="conversation-heading-group">
                <Show when={props.bot}>
                  {(bot) => (
                    <Button
                      type="button"
                      class="conversation-title no-drag"
                      aria-label="View agent settings"
                      onClick={() => {
                        setActiveRightPanel("settings");
                      }}
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
                    value={settingsModel()}
                    modelOptions={props.modelOptions}
                    agentStatus={props.agentStatus}
                    disabled={!agentReady() || agentActivity() === "Working"}
                    disabledReason={
                      agentActivity() === "Working"
                        ? "Wait for the current work to finish before changing models."
                        : "Models are available after an agent CLI connects."
                    }
                    onChange={(model) => void selectAndConfirmModel(model)}
                  />
                </Show>
                <Show when={props.server?.kind === "remote" ? props.server : undefined}>
                  {(server) => {
                    const enabled = () =>
                      props.remoteDesktopSessionActive ||
                      (server().state === "online" && server().remoteDesktopAvailable);
                    const label = () =>
                      props.remoteDesktopSessionActive ? "Resume remote control" : "Open remote control";
                    return (
                      <Button
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
                <Button
                  type="button"
                  class={[
                    "header-panel-toggle computer-button",
                    {
                      "computer-button-agent-active": Boolean(activeBrowserControl()),
                    },
                  ]}
                  aria-label={
                    activeBrowserControl()
                      ? `${browserControlBot()?.name ?? "Agent"} is controlling the browser`
                      : screenOpen()
                        ? "Hide computer"
                        : "Open computer"
                  }
                  aria-expanded={screenOpen() ? "true" : "false"}
                  onClick={() => {
                    if (screenOpen()) hideBrowserPanel();
                    else showBrowserPanel();
                  }}
                >
                  <ComputerIcon />
                  <Show when={activeBrowserControl()}>
                    <span class="computer-control-dot" aria-hidden="true" />
                  </Show>
                </Button>
              </div>
            </>
          }
        >
          <div class="agent-picker-root no-drag">
            <Combobox.Root<AgentPickerOption>
              options={agentPickerOptions()}
              open={true}
              modal={false}
              triggerMode="input"
              closeOnSelection={false}
              shouldFocusWrap={true}
              defaultFilter={(option, inputValue) =>
                option.kind === "create" ||
                `${option.bot.name} ${option.bot.title} ${option.bot.description}`
                  .toLocaleLowerCase()
                  .includes(inputValue.toLocaleLowerCase())
              }
              optionValue={(option) => (option.kind === "create" ? "create" : option.bot.id)}
              optionTextValue={(option) =>
                option.kind === "create"
                  ? "Create new agent"
                  : `${option.bot.name} ${option.bot.title} ${option.bot.description}`
              }
              optionLabel={(option) => (option.kind === "create" ? "Create new agent" : option.bot.name)}
              optionDisabled={(option) => option.kind === "create" && props.creatingAgent}
              onChange={(option) => {
                if (!option) return;
                if (option.kind === "create") props.onCreateAgent();
                else props.onSelectAgent(option.bot.id);
              }}
              itemComponent={(itemProps) => {
                const option = itemProps.item.rawValue;
                return (
                  <Combobox.Item
                    item={itemProps.item}
                    class={["agent-picker-option", { "agent-picker-create": option.kind === "create" }]}
                  >
                    <Show
                      when={option.kind === "bot" ? option.bot : undefined}
                      fallback={
                        <span class="agent-picker-plus">
                          <PlusIcon />
                        </span>
                      }
                    >
                      {(bot) => <AgentAvatar bot={bot()} />}
                    </Show>
                    <Combobox.ItemLabel>
                      {option.kind === "create"
                        ? props.creatingAgent
                          ? "Creating agent…"
                          : "Create new agent"
                        : option.bot.name}
                    </Combobox.ItemLabel>
                  </Combobox.Item>
                );
              }}
            >
              <Combobox.Control class="agent-recipient-field">
                <Combobox.Label>To:</Combobox.Label>
                <Combobox.Input
                  as={Input}
                  ref={(element) => (pickerInput = element)}
                  aria-label="To:"
                  placeholder="Search or create agents"
                  maxlength={INPUT_LIMITS.agentName}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") props.onCloseAgentPicker();
                  }}
                />
              </Combobox.Control>
              <Combobox.Content class="agent-picker-menu" aria-hidden={props.agentPickerOpen ? undefined : "true"}>
                <Combobox.Listbox />
              </Combobox.Content>
            </Combobox.Root>
          </div>
        </Show>
      </header>

      <Show when={chatSearchOpen()}>
        <ChatSearch
          query={chatSearchQuery()}
          current={activeChatSearchIndex()}
          total={props.onSearchMessages ? chatSearchTotal() : chatSearchMatches().length}
          inputRef={(element) => (chatSearchInput = element)}
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
        ref={(element) => (scrollElement = element)}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToLatest = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
          updateScrollFade(element);
          updateUnreadDividerVisibility();
        }}
      >
        <Show when={showScrollToLatest() || props.discontinuous}>
          <ScrollToLatestButton onClick={() => void jumpToLatestMessage()} />
        </Show>
        <Show when={!props.agentPickerOpen && props.loaded}>
          <Show when={!agentReady()}>
            <section class="agent-setup-card" role="status">
              <div>
                <strong>
                  {props.agentStatus.phase === "starting" || props.agentStatus.phase === "restarting"
                    ? "Connecting to agent CLIs…"
                    : "Agent CLI setup required"}
                </strong>
                <p>
                  {props.agentStatus.message ?? "Install and sign in to Codex CLI or Claude CLI, then restart OpenBot."}
                </p>
              </div>
              <Show when={props.agentStatus.phase !== "starting" && props.agentStatus.phase !== "restarting"}>
                <Button
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
          <Show when={agentReady() && onboardingActive() && !props.activeTurnId}>
            <article class="message-entry message-entry-animated message-entry-bot onboarding-message">
              <div class="bot-bubble">
                <p class="message-copy">Choose a model to get started.</p>
              </div>
              <div class="onboarding-model-picker">
                <ProviderModelPicker
                  ariaLabel="Onboarding model"
                  value={settingsModel()}
                  agentStatus={props.agentStatus}
                  modelOptions={props.modelOptions}
                  onChange={(model) => void selectAndConfirmModel(model)}
                />
              </div>
              <Show when={onboardingModelConfirmed()}>
                <div class="onboarding-specialty-step message-entry-animated">
                  <ChoiceCard
                    title="What do you want me helping with most?"
                    hint="This becomes my ongoing specialty. You can change it later in Settings."
                    choices={ONBOARDING_CHOICES}
                    customChoice="Something else"
                    pending={submitting()}
                    onSubmit={async (answer) => {
                      if (submitting()) return false;
                      setSubmitting(true);
                      setComposerError(null);
                      const completed = await props.onCompleteOnboarding(answer, settingsModel(), settingsReasoning());
                      if (completed) {
                        const botId = props.bot?.id;
                        if (botId) finishOnboarding(botId);
                      }
                      setSubmitting(false);
                      return completed;
                    }}
                  />
                </div>
              </Show>
            </article>
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
            ref={(element) => {
              virtualRoot = element;
              scrollResizeObserver?.observe(element);
            }}
            class="virtual-chat-list"
            style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
          >
            <For each={messageVirtualizer.getVirtualItems()}>
              {(virtualRow) => {
                const message = createMemo(() => props.messages[virtualRow.index]);
                const initialMessage = untrack(message);
                if (!initialMessage) return null;
                const animateEntrance = initialMessage.animate === true && markMessageSeen(initialMessage.id);
                return (
                  <div
                    data-index={virtualRow.index}
                    ref={messageVirtualizer.measureElement}
                    class="virtual-chat-row"
                    style={{ transform: `translateY(${virtualRow.start - messageVirtualizer.scrollMargin()}px)` }}
                  >
                    <Show when={message()?.id === props.firstUnreadMessageId}>
                      <UnreadMessagesDivider
                        elementRef={(element) => {
                          unreadMessagesDivider = element;
                          scheduleUnreadDividerVisibilityUpdate();
                        }}
                      />
                    </Show>
                    <Show
                      when={message()?.exchange}
                      fallback={
                        <Show
                          when={message()?.kind === "thinking"}
                          fallback={
                            <article
                              data-chat-search-message={message()?.id}
                              class={[
                                "message-entry",
                                {
                                  "message-entry-animated": animateEntrance,
                                  "message-entry-user": message()?.author === "you",
                                  "message-entry-bot": message()?.author === "bot",
                                },
                              ]}
                            >
                              <div class="message-shell">
                                <div
                                  class={[
                                    message()?.author === "you" ? "user-bubble" : "bot-bubble",
                                    {
                                      "bot-bubble-streaming": message()?.streaming === true,
                                    },
                                  ]}
                                >
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
                                    onSelectAgent={props.onSelectAgent}
                                    onOpenLink={(url) => void openExternalMessageUrl(url)}
                                    onPreview={(attachment) => void previewAttachment(attachment)}
                                    onAttachmentAction={attachmentAction}
                                    onOpenSharedFile={openSharedFile}
                                    onOpenWorkspaceFile={openWorkspaceFile}
                                    onDownload={(attachment) => attachmentAction(attachment, "download")}
                                  />
                                </div>
                                <MessageActions
                                  message={message() ?? initialMessage}
                                  pickerOpen={openReactionMessageId() === message()?.id}
                                  moreOpen={openMoreMessageId() === message()?.id}
                                  expandedEmoji={expandedEmojiMessageId() === message()?.id}
                                  copied={copiedMessageId() === message()?.id}
                                  onTogglePicker={() => {
                                    const messageId = message()?.id;
                                    if (!messageId) return;
                                    setOpenReactionMessageId((current) => (current === messageId ? null : messageId));
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
                                    setExpandedEmojiMessageId((current) => (current === messageId ? null : messageId));
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
                              <Show when={message()?.reaction}>
                                {(reaction) => (
                                  <Button
                                    type="button"
                                    class="message-reaction-pill"
                                    aria-label={`Remove reaction ${reaction()}`}
                                    onClick={() => {
                                      const currentMessage = message();
                                      if (currentMessage) void reactToMessage(currentMessage, null);
                                    }}
                                  >
                                    {reaction()}
                                  </Button>
                                )}
                              </Show>
                            </article>
                          }
                        >
                          <div
                            data-chat-search-message={message()?.id}
                            class={{ "thinking-entry-animated": animateEntrance }}
                          >
                            <ThinkingDisclosure
                              message={message() ?? initialMessage}
                              open={
                                expandedThinkingMessages()[`${props.bot?.id ?? ""}:${message()?.id ?? ""}`] === true
                              }
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
                      {(exchange) => (
                        <article
                          data-chat-search-message={message()?.id}
                          class={["exchange-message-entry", { "exchange-message-entry-animated": animateEntrance }]}
                        >
                          <ExchangeSystemRow
                            message={message() ?? initialMessage}
                            bots={props.bots}
                            onSelectAgent={props.onSelectAgent}
                          />
                          <Show when={exchange().direction === "incoming" && (message()?.attachments?.length ?? 0) > 0}>
                            <div class="exchange-agent-attachments">
                              <AttachmentCards
                                attachments={message()?.attachments ?? []}
                                onPreview={(attachment) => void previewAttachment(attachment)}
                                onAction={attachmentAction}
                              />
                            </div>
                          </Show>
                        </article>
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
            ref={(element) => {
              agentActivitySlot = element;
              scrollResizeObserver?.observe(element);
            }}
          >
            <Show when={renderedAgentActivity()}>
              {(activity) => (
                <AgentActivityIndicator
                  bot={activity().bot}
                  presentation={activity().presentation}
                  phase={activity().phase}
                />
              )}
            </Show>
          </div>
          <Show when={props.prompt}>
            {(prompt) => (
              <ApprovalCard variant="questions" questions={prompt().questions} onSubmit={props.onAnswerPrompt} />
            )}
          </Show>
          <Show when={props.approval}>
            {(approval) => (
              <ApprovalCard
                variant="approval"
                approval={approval()}
                onApprove={() => props.onRespondToApproval("accept")}
                onReject={() => props.onRespondToApproval("decline")}
              />
            )}
          </Show>
        </Show>
      </div>

      <Show when={!props.prompt && !props.approval}>
        <div class="composer-wrap">
          <div
            class="agent-queue-slot"
            data-open={queuePanelVisible() ? "true" : "false"}
            aria-hidden={queuePanelVisible() ? undefined : "true"}
            inert={queuePanelVisible() ? undefined : true}
          >
            <div class="agent-queue-slot-inner">
              <Show when={queuePanelVisible()}>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
                  editingDeliveryId={editingDeliveryId()}
                  canSteer={Boolean(props.activeTurnId)}
                  onSteer={props.onSteerQueuedMessage}
                  onCancel={props.onCancelQueuedMessage}
                  onEdit={editQueuedMessage}
                  onReorder={reorderPresentedQueue}
                />
              </Show>
            </div>
          </div>
          <Show when={unreferencedDraftAttachments().length > 0}>
            <div class="composer-attachments">
              <For each={unreferencedDraftAttachments()}>
                {(attachment) => (
                  <div class="composer-attachment" data-kind={attachment.kind}>
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
                    <Button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => removeAttachment(attachment.id)}
                    >
                      <CloseIcon />
                    </Button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={replyTarget()}>
            {(message) => (
              <div class="composer-reply-preview">
                <div>
                  <span>Replying to {message().author === "you" ? "your message" : "Agent"}</span>
                  <p>{message().body || "Attachment"}</p>
                </div>
                <Button
                  type="button"
                  aria-label="Cancel reply"
                  onClick={() => updateCurrentDraft({ replyToMessageId: null })}
                >
                  <CloseIcon />
                </Button>
              </div>
            )}
          </Show>
          <Show when={composerError()}>
            <div class="composer-error" role="alert">
              {composerError()}
            </div>
          </Show>
          <Show when={agentReady() && imageGenerationUnavailable()}>
            <aside class="image-generation-capability-note" role="note">
              <strong>Image generation is currently available with Codex.</strong>
              <span>Switch this agent to a Codex model in Settings to generate images.</span>
            </aside>
          </Show>
          <div
            class={`composer${voicePhase() === "recording" ? " composer-recording" : ""}`}
            data-compact={currentDraft().text.includes("\n") ? undefined : ""}
            onPointerDown={(event) => {
              if (!(event.target instanceof Element)) return;
              if (event.target.closest("button, .composer-editor-surface")) return;
              event.preventDefault();
              setComposerFocusRequest((current) => current + 1);
            }}
          >
            <div class="composer-input-label">
              <ComposerEditor
                botId={props.bot?.id}
                bots={props.bots}
                attachments={currentDraft().attachments}
                value={currentDraft().text}
                disabled={
                  props.agentPickerOpen ||
                  submitting() ||
                  selectionSending() ||
                  !agentReady() ||
                  onboardingModelRequired()
                }
                placeholder={
                  !agentReady()
                    ? "Complete agent CLI setup to start"
                    : onboardingModelRequired()
                      ? "Choose a model to continue"
                      : replyTarget()
                        ? "Reply…"
                        : `Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`
                }
                ariaLabel={`Message ${props.agentPickerOpen ? "agent" : (props.bot?.name ?? "agent")}`}
                focusRequest={composerFocusRequest()}
                onValueChange={(text) => {
                  updateCurrentDraft({ text });
                  updateTeamTyping(text);
                }}
                onSubmit={() => void submitMessage()}
                onOpenAttachment={(attachment) =>
                  attachment.previewKind === "none"
                    ? attachmentAction(attachment, "open")
                    : void previewAttachment(attachment)
                }
              />
            </div>
            <div class="composer-toolbar">
              <Input
                ref={imageAttachmentPicker}
                type="file"
                accept=".png,.jpg,.jpeg,.gif,.webp,.avif"
                multiple
                hidden
                tabindex={-1}
                data-openbot-attachment-picker="true"
              />
              <Input
                ref={contextAttachmentPicker}
                type="file"
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
                    props.agentPickerOpen ||
                    attachmentBusy() ||
                    submitting() ||
                    selectionSending() ||
                    !agentReady() ||
                    onboardingModelRequired()
                  }
                >
                  <PlusIcon />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content class="attachment-menu composer-action-menu" aria-label="Add to prompt">
                    <DropdownMenu.Item
                      class="composer-action-item"
                      disabled={attachmentBusy()}
                      onPointerDown={(event) => {
                        if (event.button === 0) openAttachmentPicker("images");
                      }}
                      onKeyDown={(event) => openAttachmentPickerFromKey(event, "images")}
                    >
                      <Image aria-hidden="true" />
                      <span>
                        <strong>Attach image</strong>
                        <small>Add a screenshot or visual reference.</small>
                      </span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="composer-action-item"
                      disabled
                      title="Skill selection is not available yet."
                    >
                      <Puzzle aria-hidden="true" />
                      <span>
                        <strong>Use a skill</strong>
                        <small>Skill selection is not available yet.</small>
                      </span>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="composer-action-item"
                      disabled={attachmentBusy()}
                      onPointerDown={(event) => {
                        if (event.button === 0) openAttachmentPicker("all");
                      }}
                      onKeyDown={(event) => openAttachmentPickerFromKey(event, "all")}
                    >
                      <File aria-hidden="true" />
                      <span>
                        <strong>Add context</strong>
                        <small>Include a file with supporting details.</small>
                      </span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <div class="composer-primary-actions">
                <Show
                  when={voicePhase() === "recording"}
                  fallback={
                    <Button
                      type="button"
                      class="dictation-button"
                      aria-label={voiceButtonLabel(voicePhase())}
                      disabled={
                        voicePhase() === "requesting" ||
                        voicePhase() === "transcribing" ||
                        (voicePhase() === "idle" &&
                          (props.agentPickerOpen || !props.bot || !agentReady() || onboardingModelRequired()))
                      }
                      onClick={() => void startVoiceRecording()}
                    >
                      <Show
                        when={voicePhase() === "requesting" || voicePhase() === "transcribing"}
                        fallback={<Mic aria-hidden="true" />}
                      >
                        <LoaderCircle class="dictation-spinner" aria-hidden="true" />
                      </Show>
                    </Button>
                  }
                >
                  <fieldset class="voice-recording-status" aria-label="Voice recording">
                    <Button
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
                  when={props.activeTurnId && !editingDeliveryId() && !composerHasContent()}
                  fallback={
                    <Button
                      type="button"
                      class="voice-button"
                      aria-label={editingDeliveryId() ? "Save queued message" : "Send message"}
                      disabled={submitting() || selectionSending() || !agentReady() || onboardingModelRequired()}
                      onClick={() => void submitMessage()}
                    >
                      {submitting() ? "…" : "↑"}
                    </Button>
                  }
                >
                  <Button
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

      <Dialog.Root open={Boolean(mediaPreview())} onOpenChange={(open) => !open && setMediaPreview(null)}>
        <Show when={mediaPreview()}>
          {(preview) => (
            <Dialog.Portal>
              <Dialog.Overlay class="media-backdrop">
                <Dialog.Content as="section" class="media-modal">
                  <Dialog.Title class="sr-only">{preview().attachment.name}</Dialog.Title>
                  <Button
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
                    <Button type="button" onClick={() => attachmentAction(preview().attachment, "open")}>
                      Open
                    </Button>
                    <Button type="button" onClick={() => attachmentAction(preview().attachment, "download")}>
                      Download
                    </Button>
                    <Button type="button" onClick={() => attachmentAction(preview().attachment, "reveal")}>
                      Show in Finder
                    </Button>
                  </div>
                </Dialog.Content>
              </Dialog.Overlay>
            </Dialog.Portal>
          )}
        </Show>
      </Dialog.Root>

      <Show when={screenOpen()}>
        <Tabs.Root
          as="aside"
          id="browser-side-panel"
          class={["browser-panel", { "browser-panel-controlled": Boolean(activeBrowserControl()) }]}
          aria-label="Browser"
          value={activeBrowserTab()?.id ?? "__empty"}
          onChange={props.onActivateBrowserTab}
          activationMode="automatic"
        >
          <PanelResizer
            class="right-panel-resizer"
            label="Resize right panel"
            controls="browser-side-panel"
            direction="right"
            value={browserPanelWidth()}
            defaultValue={BROWSER_PANEL_DEFAULT}
            min={BROWSER_PANEL_MIN}
            max={() =>
              Math.min(
                BROWSER_PANEL_MAX,
                Math.max(
                  BROWSER_PANEL_MIN,
                  (conversationPanel?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                ),
              )
            }
            onResize={setBrowserPanelWidth}
            onResizeEnd={(value) => savePanelWidth(BROWSER_PANEL_STORAGE_KEY, value)}
          />
          <header class="browser-panel-header">
            <div class="browser-tabs">
              <Tabs.List class="browser-tab-strip" aria-label="Browser tabs">
                <For each={browserTabs()}>
                  {(tab) => {
                    const control = () => browserControlForTab(tab);
                    const controller = () => browserControllerForTab(tab);
                    const title = () => (tab.loading ? "Loading…" : tab.title || tab.url);
                    return (
                      <div
                        role="presentation"
                        class={["browser-tab-wrap", { "browser-tab-controlled": Boolean(control()) }]}
                      >
                        <Tabs.Trigger
                          as={Button}
                          value={tab.id}
                          aria-label={
                            control() ? `${title()}, controlled by ${controller()?.name ?? "agent"}` : title()
                          }
                          aria-description="Press Delete or Control/Command W to close"
                          class="browser-tab"
                          onPointerDown={(event) => {
                            if (event.button !== 1) return;
                            event.preventDefault();
                            event.stopPropagation();
                            void closeBrowserTab(tab.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Delete") return;
                            event.preventDefault();
                            void closeBrowserTab(tab.id);
                          }}
                        >
                          <Show when={control()}>
                            {(session) => (
                              <span
                                class={[
                                  "browser-tab-control",
                                  {
                                    "browser-tab-control-acting": session().phase === "acting",
                                  },
                                ]}
                                title={`${controller()?.name ?? "Agent"}: ${BROWSER_ACTION_LABELS[session().action]}`}
                              >
                                <BrowserControlIcon />
                              </span>
                            )}
                          </Show>
                          <span class="browser-tab-title">{title()}</span>
                          <span
                            class="browser-tab-close"
                            aria-hidden="true"
                            title={`Close ${tab.title || "browser tab"}`}
                            onPointerDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (event.button === 1) void closeBrowserTab(tab.id);
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void closeBrowserTab(tab.id);
                            }}
                          >
                            <CloseIcon />
                          </span>
                        </Tabs.Trigger>
                      </div>
                    );
                  }}
                </For>
              </Tabs.List>
              <Button
                type="button"
                class="browser-new-tab"
                aria-label="New browser tab"
                onClick={() => {
                  setBrowserAddress("https://www.google.com");
                  void openBrowserAddress("https://www.google.com");
                }}
              >
                <PlusIcon />
              </Button>
            </div>
          </header>
          <Tabs.Content forceMount value={activeBrowserTab()?.id ?? "__empty"} class="browser-tab-panel">
            <div class="browser-toolbar">
              <Button type="button" aria-label="Go back" class="browser-toolbar-button" disabled>
                <BrowserBackIcon />
              </Button>
              <Button type="button" aria-label="Go forward" class="browser-toolbar-button" disabled>
                <BrowserForwardIcon />
              </Button>
              <Button
                type="button"
                aria-label="Reload page"
                class="browser-toolbar-button"
                onClick={() => void openBrowserAddress()}
              >
                <BrowserReloadIcon />
              </Button>
              <form
                class="browser-address-bar"
                onSubmit={(event) => {
                  event.preventDefault();
                  void openBrowserAddress();
                }}
              >
                <Input
                  value={browserAddress()}
                  aria-label="Browser address"
                  maxlength={INPUT_LIMITS.browserUrl}
                  onValueChange={setBrowserAddress}
                />
              </form>
              <Button type="button" class="browser-toolbar-button" aria-label="Browser menu">
                <span class="browser-menu-dots">•••</span>
              </Button>
            </div>
            <div class="browser-surface" ref={(element) => (browserSurface = element)}>
              <Show when={browserTabs().length === 0}>
                <div class="browser-empty-state">
                  <strong>Open a page</strong>
                  <span>The agent can browse here while it works.</span>
                </div>
              </Show>
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </Show>

      <Show when={settingsOpen() && props.bot}>
        <aside id="settings-side-panel" class="agent-settings-panel" aria-label="Agent settings">
          <PanelResizer
            class="right-panel-resizer"
            label="Resize right panel"
            controls="settings-side-panel"
            direction="right"
            value={settingsPanelWidth()}
            defaultValue={SETTINGS_PANEL_DEFAULT}
            min={SETTINGS_PANEL_MIN}
            max={() =>
              Math.min(
                SETTINGS_PANEL_MAX,
                Math.max(
                  SETTINGS_PANEL_MIN,
                  (conversationPanel?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                ),
              )
            }
            onResize={setSettingsPanelWidth}
            onResizeEnd={(value) => savePanelWidth(SETTINGS_PANEL_STORAGE_KEY, value)}
          />
          <header class="agent-settings-header">
            <Button
              type="button"
              class="agent-settings-nav-button"
              aria-label="Back to details"
              onClick={() => setActiveRightPanel("none")}
            >
              <BackIcon />
            </Button>
            <h2>Settings</h2>
            <Button
              type="button"
              class="agent-settings-nav-button"
              aria-label="Close details"
              onClick={() => setActiveRightPanel("none")}
            >
              <SettingsForwardIcon />
            </Button>
          </header>
          <div class="agent-settings-content">
            <div ref={(element) => (avatarPickerRoot = element)} class="agent-settings-avatar-picker">
              <Popover.Root
                open={avatarPickerOpen()}
                placement="bottom"
                gutter={11}
                onOpenChange={(open) => {
                  if (open) {
                    setAvatarCandidateSeed(avatarSeed());
                    setAvatarBatch(0);
                  }
                  setAvatarPickerOpen(open);
                }}
              >
                <Popover.Trigger class="agent-settings-avatar" aria-label="Edit agent avatar">
                  <AgentAvatar seed={avatarSeed()} hue={avatarHue()} url={avatarUrl()} motion="always" />
                </Popover.Trigger>
                <Popover.Content class="avatar-editor" aria-hidden={avatarPickerOpen() ? undefined : "true"}>
                  <Popover.Title class="sr-only">Avatar editor</Popover.Title>
                  <Input
                    ref={(element) => (avatarFileInput = element)}
                    class="sr-only"
                    type="file"
                    aria-label="Attach files"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => void uploadAgentAvatar(event.currentTarget.files?.[0])}
                  />
                  <div class="avatar-editor-heading">
                    <span>Image</span>
                    <div class="avatar-editor-actions">
                      <Show when={avatarUrl()}>
                        <Button type="button" disabled={avatarUploadBusy()} onClick={() => void setCustomAvatar(null)}>
                          Remove
                        </Button>
                      </Show>
                    </div>
                  </div>
                  <Button
                    type="button"
                    class={["avatar-image-upload", { "avatar-image-upload-active": Boolean(avatarUrl()) }]}
                    disabled={avatarUploadBusy()}
                    onClick={() => avatarFileInput?.click()}
                  >
                    <span class="avatar-image-upload-preview">
                      <Show
                        when={avatarUrl()}
                        fallback={
                          <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                        }
                      >
                        <AgentAvatar seed={avatarSeed()} hue={avatarHue()} url={avatarUrl()} />
                      </Show>
                    </span>
                    <span>
                      <strong>{avatarUrl() ? "Replace image" : "Upload image"}</strong>
                      <small>PNG, JPEG or WebP · square crop</small>
                    </span>
                  </Button>
                  <div class="avatar-editor-divider" />
                  <div class="avatar-editor-heading">
                    <span>Generated face</span>
                    <div class="avatar-editor-actions">
                      <Show when={props.bot?.id && avatarSeed() !== props.bot?.id}>
                        <Button
                          type="button"
                          onClick={() => {
                            const botId = props.bot?.id;
                            if (!botId) return;
                            setAvatarCandidateSeed(botId);
                            setAvatarBatch(0);
                            void selectGeneratedAvatar(botId);
                          }}
                        >
                          Reset to ID
                        </Button>
                      </Show>
                      <Button
                        type="button"
                        onClick={() => {
                          setAvatarCandidateSeed(avatarSeed());
                          setAvatarBatch((batch) => batch + 1);
                        }}
                      >
                        New set
                      </Button>
                    </div>
                  </div>
                  <fieldset class="avatar-face-grid" aria-label="Generated avatar faces">
                    <For each={avatarCandidates()}>
                      {(seed, index) => (
                        <Button
                          type="button"
                          class={[
                            "avatar-face-choice",
                            {
                              "avatar-choice-selected": !avatarUrl() && avatarSeed() === seed,
                            },
                          ]}
                          aria-label={
                            !avatarUrl() && avatarSeed() === seed ? "Selected avatar" : `Avatar option ${index() + 1}`
                          }
                          aria-pressed={!avatarUrl() && avatarSeed() === seed ? "true" : "false"}
                          onClick={() => void selectGeneratedAvatar(seed)}
                        >
                          <AgentAvatar seed={seed} hue={avatarHue()} />
                        </Button>
                      )}
                    </For>
                  </fieldset>
                  <div class="avatar-editor-divider" />
                  <div class="avatar-editor-heading">
                    <span>Color</span>
                  </div>
                  <fieldset class="avatar-color-grid" aria-label="Avatar color">
                    <Button
                      type="button"
                      class={["avatar-color-choice", { "avatar-choice-selected": avatarHue() === null }]}
                      aria-label="Automatic avatar color"
                      aria-pressed={avatarHue() === null ? "true" : "false"}
                      onClick={() => {
                        setAvatarHue(null);
                        void saveBotPatch({ avatarHue: null });
                      }}
                    >
                      <span class="avatar-color-swatch avatar-color-swatch-auto">A</span>
                    </Button>
                    <For each={AVATAR_HUE_OPTIONS}>
                      {(option) => (
                        <Button
                          type="button"
                          class={[
                            "avatar-color-choice",
                            {
                              "avatar-choice-selected": avatarHue() === option.hue,
                            },
                          ]}
                          aria-label={`${option.label} avatar color`}
                          aria-pressed={avatarHue() === option.hue ? "true" : "false"}
                          onClick={() => {
                            setAvatarHue(option.hue);
                            void saveBotPatch({ avatarHue: option.hue });
                          }}
                        >
                          <span class="avatar-color-swatch" style={{ background: avatarHueSwatch(option.hue) }} />
                        </Button>
                      )}
                    </For>
                  </fieldset>
                </Popover.Content>
              </Popover.Root>
            </div>
            <label class="agent-settings-field">
              <span>Name</span>
              <Input
                value={settingsName()}
                aria-label="Agent name"
                maxlength={INPUT_LIMITS.agentName}
                onValueChange={(value) => {
                  setSettingsName(value);
                  setSettingsDirty((current) => ({ ...current, name: true }));
                }}
                onBlur={saveSettingsName}
              />
            </label>
            <label class="agent-settings-field">
              <span>Title</span>
              <Input
                value={settingsTitle()}
                aria-label="Agent title"
                placeholder="Describe what your agent does"
                maxlength={INPUT_LIMITS.agentTitle}
                onValueChange={(value) => {
                  setSettingsTitle(value);
                  setSettingsDirty((current) => ({ ...current, title: true }));
                }}
                onBlur={saveSettingsTitle}
              />
            </label>
            <label class="agent-settings-field agent-settings-description">
              <span>Description</span>
              <Textarea
                rows="4"
                value={settingsDescription()}
                aria-label="Agent description"
                placeholder="What this agent is for"
                maxlength={INPUT_LIMITS.agentDescription}
                onValueChange={(value) => {
                  setSettingsDescription(value);
                  setSettingsDirty((current) => ({ ...current, description: true }));
                }}
                onBlur={saveSettingsDescription}
              />
            </label>
            <section class="agent-settings-model" aria-labelledby="agent-model-heading">
              <div class="agent-settings-section-heading">
                <strong id="agent-model-heading">Runtime</strong>
                <span>Choose how this agent runs</span>
              </div>
              <div class="agent-settings-model-controls">
                <div class="agent-settings-model-option">
                  <ProviderModelPicker
                    variant="field"
                    ariaLabel="Agent model"
                    value={settingsModel()}
                    agentStatus={props.agentStatus}
                    modelOptions={props.modelOptions}
                    disabled={!agentReady() || agentActivity() === "Working"}
                    disabledReason={
                      agentActivity() === "Working"
                        ? "Wait for the current work to finish before changing models."
                        : "Models are available after an agent CLI connects."
                    }
                    onChange={(model) => void selectAndConfirmModel(model)}
                  />
                </div>
                <div class="agent-settings-model-row agent-settings-thinking-row">
                  <span>Reasoning</span>
                  <Select<AgentReasoningEffort>
                    class="agent-settings-reasoning-control"
                    options={reasoningOptions()}
                    value={settingsReasoning()}
                    onChange={(reasoningEffort) => {
                      if (!reasoningEffort) return;
                      setSettingsReasoning(reasoningEffort);
                      saveBotPatch({ reasoningEffort });
                    }}
                    itemComponent={(item) => (
                      <SelectItem item={item.item}>{reasoningLabel(item.item.rawValue)}</SelectItem>
                    )}
                  >
                    <SelectTrigger size="sm" class="agent-settings-reasoning-select" aria-label="Agent reasoning level">
                      <SelectValue<AgentReasoningEffort>>
                        {(state) => {
                          const effort = state.selectedOption();
                          return effort ? reasoningLabel(effort) : "Select reasoning";
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              </div>
            </section>
            <Show when={settingsSaveError()}>
              {(message) => (
                <p class="agent-settings-save-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <div class="agent-settings-notifications">
              <div>
                <strong>Notifications</strong>
                <span>Get notified when this agent finishes or needs input</span>
              </div>
              <Switch
                size="sm"
                aria-label="Notifications"
                checked={settingsNotifications()}
                onChange={(next) => {
                  setSettingsNotifications(next);
                  saveBotPatch({ notifications: next });
                }}
              />
            </div>
          </div>
        </aside>
      </Show>
    </main>
  );
}

function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function voiceButtonLabel(phase: "idle" | "requesting" | "recording" | "transcribing") {
  if (phase === "recording") return "Stop voice recording";
  if (phase === "requesting") return "Requesting microphone access";
  if (phase === "transcribing") return "Transcribing voice prompt";
  return "Create prompt with voice";
}

function formatVoiceDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function voiceCaptureError(error: unknown) {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "Microphone access is blocked. Allow OpenBot to use the microphone in system settings.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone is available.";
  return "OpenBot could not start voice recording.";
}

function voiceTranscriptionError(error: unknown): string {
  return error instanceof Error ? error.message : "OpenBot could not transcribe this recording.";
}
