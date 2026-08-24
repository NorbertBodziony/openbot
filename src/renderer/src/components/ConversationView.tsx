import {
  attachmentReferenceIds,
  expandAttachmentReferences,
  removeAttachmentReferences,
} from "@openbot/contracts/attachment-references";
import type {
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentStatus,
  AttachmentSummary,
  AvatarImageInput,
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
import type { BotMessage, BotProfile } from "../data";
import { appendVoiceTranscript, recordingToWav } from "../voice-recording";
import { AgentAvatar } from "./AgentAvatar";
import { ComposerEditor, expandComposerMentions } from "./ComposerEditor";
import { useConversationController } from "./Conversation";
import {
  AgentActivityIndicator,
  type AgentActivityPresentation,
  nextAgentActivityPresentation,
  ThinkingDisclosure,
} from "./conversation/AgentActivity";
import { AttachmentCards, fileBadge, formatFileSize } from "./conversation/AttachmentCards";
import { attachmentReferenceTone } from "./conversation/AttachmentReference";
import type { BrowserPipBounds } from "./conversation/BrowserPanel";
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
import { createChatVirtualizer } from "./conversation/createChatVirtualizer";
import { ScrollToLatestButton, scrollToLatestMessage } from "./conversation/MessageNavigation";
import { ExchangeSystemRow, MessageActions, MessageBody } from "./conversation/MessageRendering";
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
import { ProviderModelPicker } from "./ProviderModelPicker";
import { Button, Dialog, DropdownMenu, File, Image, Input, LoaderCircle, Mic, Puzzle } from "./ui";

const loadAgentSettingsPanel = () => import("./conversation/AgentSettingsPanel");
const AgentSettingsPanel = lazy(loadAgentSettingsPanel);
const BrowserPanel = lazy(() => import("./conversation/BrowserPanel"));
const QueuePanel = lazy(() => import("./conversation/QueuePanel").then((module) => ({ default: module.QueuePanel })));
const ApprovalCard = lazy(() => import("./ConversationPrompts").then((module) => ({ default: module.ApprovalCard })));

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

export interface ConversationProps {
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
  globalOverlayOpen: boolean;
  settingsRequest: { botId: string; nonce: number } | null;
  messageFocusRequest: { botId: string; messageId: string; nonce: number } | null;
  queue: QueueSnapshot | undefined;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
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

export type RightPanelMode = "none" | "browser" | "browser-pip" | "settings";

const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  replyToMessageId: null,
};
const SETTINGS_PANEL_MIN = 180;
const SETTINGS_PANEL_MAX = 1600;
const BROWSER_PANEL_DEFAULT_RATIO = 0.5;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;
const BROWSER_PIP_STORAGE_KEY = "openbot:browser-pip-bounds";
const BROWSER_PIP_DEFAULT_WIDTH = 420;
const BROWSER_PIP_DEFAULT_HEIGHT = 300;
const BROWSER_PIP_MIN_WIDTH = 300;
const BROWSER_PIP_MIN_HEIGHT = 220;
const BROWSER_PIP_MARGIN = 12;
const BROWSER_PIP_BOTTOM_INSET = 68;

function defaultBrowserPipBounds(containerWidth: number, containerHeight: number): BrowserPipBounds {
  const width = Math.min(BROWSER_PIP_DEFAULT_WIDTH, containerWidth - BROWSER_PIP_MARGIN * 2);
  const height = Math.min(BROWSER_PIP_DEFAULT_HEIGHT, containerHeight - BROWSER_PIP_MARGIN * 2);
  return {
    x: containerWidth - width - 16,
    y: containerHeight - height - BROWSER_PIP_BOTTOM_INSET,
    width,
    height,
  };
}

function bottomRightBrowserPipBounds(
  bounds: BrowserPipBounds,
  containerWidth: number,
  containerHeight: number,
): BrowserPipBounds {
  const constrained = clampBrowserPipBounds(bounds, containerWidth, containerHeight);
  return clampBrowserPipBounds(
    {
      ...constrained,
      x: containerWidth - constrained.width - 16,
      y: containerHeight - constrained.height - BROWSER_PIP_BOTTOM_INSET,
    },
    containerWidth,
    containerHeight,
  );
}

function clampBrowserPipBounds(
  bounds: BrowserPipBounds,
  containerWidth: number,
  containerHeight: number,
): BrowserPipBounds {
  const availableWidth = Math.max(1, containerWidth - BROWSER_PIP_MARGIN * 2);
  const availableHeight = Math.max(1, containerHeight - BROWSER_PIP_MARGIN * 2);
  const width = Math.round(Math.min(availableWidth, Math.max(BROWSER_PIP_MIN_WIDTH, bounds.width)));
  const height = Math.round(Math.min(availableHeight, Math.max(BROWSER_PIP_MIN_HEIGHT, bounds.height)));
  return {
    x: Math.round(Math.min(containerWidth - width - BROWSER_PIP_MARGIN, Math.max(BROWSER_PIP_MARGIN, bounds.x))),
    y: Math.round(Math.min(containerHeight - height - BROWSER_PIP_MARGIN, Math.max(BROWSER_PIP_MARGIN, bounds.y))),
    width,
    height,
  };
}
function createConversationViewScope(props: ConversationProps) {
  const controller = useConversationController();
  const agentReady = () => props.agentStatus.phase === "ready";
  const imageGenerationUnavailable = () => Boolean(props.bot && isClaudeModel(props.bot.model));
  const {
    drafts,
    setDrafts,
    editingDeliveryId,
    setEditingDeliveryId,
    editingDraftBackup,
    setEditingDraftBackup,
    composerFocusRequest,
    setComposerFocusRequest,
    showComposerActions,
    setShowComposerActions,
    attachmentBusy,
    setAttachmentBusy,
    composerError,
    setComposerError,
    voicePhase,
    setVoicePhase,
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
  let imageAttachmentPicker: HTMLInputElement | undefined;
  let contextAttachmentPicker: HTMLInputElement | undefined;
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
  const activeRightPanel = createMemo<RightPanelMode>(() => {
    const botId = props.bot?.id;
    return botId ? (rightPanels()[botId] ?? "none") : "none";
  });
  const browserSidebarOpen = () => props.browserEnabled !== false && activeRightPanel() === "browser";
  const browserPipOpen = () => props.browserEnabled !== false && activeRightPanel() === "browser-pip";
  const screenOpen = () => browserSidebarOpen() || browserPipOpen();
  const settingsOpen = () => activeRightPanel() === "settings";
  const browserTabs = createMemo(() => {
    if (props.browserEnabled === false) return [];
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
  let chatSearchInput: HTMLInputElement | undefined;
  let chatSearchReturnFocus: HTMLElement | undefined;
  let chatSearchFrame: number | undefined;
  let chatSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let chatSearchRequest = 0;
  let lastChatSearchQuery = "";
  let stickToLatest = true;
  let lastConversationBotId: string | undefined;
  let lastPanelBotId: string | undefined;
  let lastHandledSettingsRequestNonce: number | undefined;
  let lastHandledMessageFocusNonce: number | undefined;
  let lastRuntimeSettingsSignature: string | undefined;
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
    try {
      await props.onUpdateBot(botId, updates);
      return true;
    } catch {
      return false;
    }
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
    await selectModel(model, true, true);
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
    if (resources.seenMessageIds.has(key)) return false;
    resources.seenMessageIds.add(key);
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
      if (resources.voiceDisposed || voicePhase() !== "requesting") {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream);
      resources.voiceStream = stream;
      resources.voiceRecorder = recorder;
      resources.voiceBotId = botId;
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
      setVoicePhase("idle");
      setComposerError(voiceCaptureError(error));
    }
  }

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
    const chunks = resources.voiceChunks;
    resources.voiceRecorder = undefined;
    resources.voiceBotId = undefined;
    resources.voiceChunks = [];
    if (!targetBotId || resources.voiceDisposed) return;
    try {
      if (chunks.length === 0) throw new Error("No speech was recorded.");
      const audio = await recordingToWav(new Blob(chunks, { type: mimeType }));
      const result = await window.openbot.voice.transcribe({ audio });
      if (resources.voiceDisposed || !props.bots.some((bot) => bot.id === targetBotId)) return;
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
      if (!resources.voiceDisposed && props.bot?.id === targetBotId) setComposerError(voiceTranscriptionError(error));
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
        const botId = props.bot?.id;
        if (botId) resources.importTargetBots.set(event.requestId, botId);
        setAttachmentBusy(true);
        setComposerError(null);
      } else if (event.type === "error") {
        resources.importTargetBots.delete(event.requestId);
        setAttachmentBusy(false);
        setComposerError(event.message);
      } else {
        setAttachmentBusy(false);
        const botId = resources.importTargetBots.get(event.requestId);
        resources.importTargetBots.delete(event.requestId);
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
    const keyboardTarget = conversationPanel?.ownerDocument ?? document;
    const keyboardWindow = keyboardTarget.defaultView ?? window;
    keyboardTarget.addEventListener("keydown", closeOnEscape);
    keyboardWindow.addEventListener("keydown", closeActiveBrowserTab);
    keyboardTarget.addEventListener("keydown", handleChatSearchShortcut);
    window.addEventListener("pointerdown", closeMessageMenus);
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
    () => {
      const bot = props.bot;
      if (!bot) return null;
      return {
        signature: [bot.id, bot.model, bot.reasoningEffort].join("\u0000"),
        model: bot.model,
        reasoningEffort: bot.reasoningEffort,
      };
    },
    (bot) => {
      if (!bot || bot.signature === lastRuntimeSettingsSignature) return;
      lastRuntimeSettingsSignature = bot.signature;
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
    () => ({
      botId: props.bot?.id,
      activeTab: activeBrowserTab(),
      addressEditing: browserAddressEditing(),
      screenOpen: screenOpen(),
      activeBrowserTabId: props.activeBrowserTabId,
      onActivateBrowserTab: props.onActivateBrowserTab,
    }),
    ({ activeTab, addressEditing, screenOpen, activeBrowserTabId, onActivateBrowserTab }) => {
      if (props.browserEnabled === false) return;
      if (!addressEditing) setBrowserAddress(activeTab?.url ?? "https://www.google.com");
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
      if (props.browserEnabled === false) return;
      const newlyControlledBotIds = [...controlledBotIds].filter(
        (botId) => !resources.controlledBrowserBotIds.has(botId),
      );
      resources.controlledBrowserBotIds = controlledBotIds;
      if (newlyControlledBotIds.length === 0) return;
      setRightPanels((current) => {
        const next = { ...current };
        let changed = false;
        for (const botId of newlyControlledBotIds) {
          if (next[botId] === "browser" || next[botId] === "browser-pip") continue;
          next[botId] = "browser";
          changed = true;
        }
        return changed ? next : current;
      });
    },
  );

  createEffect(
    () => ({
      botId: props.bot?.id,
      visible: screenOpen() && !props.globalOverlayOpen && !props.remoteDesktopVisible && !mediaPreview(),
      pipBounds: browserPipOpen() ? browserPipBounds() : null,
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
            if (browserPipOpen()) {
              const current = browserPipBounds();
              if (current && conversationPanel) {
                const constrained = clampBrowserPipBounds(
                  current,
                  conversationPanel.clientWidth,
                  conversationPanel.clientHeight,
                );
                if (
                  constrained.x !== current.x ||
                  constrained.y !== current.y ||
                  constrained.width !== current.width ||
                  constrained.height !== current.height
                ) {
                  setBrowserPipBounds(constrained);
                  return;
                }
              }
            }
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

  onCleanup(() => {
    browserVisibilityGeneration += 1;
    if (browserVisibilityFrame !== undefined) cancelAnimationFrame(browserVisibilityFrame);
    if (browserBoundsFrame !== undefined) cancelAnimationFrame(browserBoundsFrame);
    browserResizeObserver?.disconnect();
    if (browserWindowResizeHandler) window.removeEventListener("resize", browserWindowResizeHandler);
    if (props.browserEnabled !== false) void window.openbot.browser.setVisible({ visible: false });
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
    if (resources.typingIdleTimer) clearTimeout(resources.typingIdleTimer);
    resources.typingIdleTimer = undefined;
    if (!resources.typingBotId) return;
    props.onTypingChange(resources.typingBotId, false);
    resources.typingBotId = null;
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
    if (!botId || submitting() || (!text.trim() && attachments.length === 0)) return;
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
    }
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
      if (!screenOpen()) setActiveRightPanel("browser");
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
    if (props.browserEnabled === false) return;
    setActiveRightPanel("browser");
    if (browserTabs().length === 0) void openBrowserAddress();
  }

  function constrainBrowserPipBounds(bounds: BrowserPipBounds): BrowserPipBounds {
    const width = conversationPanel?.clientWidth || window.innerWidth;
    const height = conversationPanel?.clientHeight || window.innerHeight;
    return clampBrowserPipBounds(bounds, width, height);
  }

  function showBrowserPip() {
    if (props.browserEnabled === false) return;
    const width = conversationPanel?.clientWidth || window.innerWidth;
    const height = conversationPanel?.clientHeight || window.innerHeight;
    setBrowserPipBounds((current) =>
      bottomRightBrowserPipBounds(current ?? defaultBrowserPipBounds(width, height), width, height),
    );
    setActiveRightPanel("browser-pip");
  }

  function updateBrowserPipBounds(bounds: BrowserPipBounds, commit: boolean) {
    const constrained = constrainBrowserPipBounds(bounds);
    setBrowserPipBounds(constrained);
    if (commit) {
      window.localStorage.setItem(
        BROWSER_PIP_STORAGE_KEY,
        [constrained.x, constrained.y, constrained.width, constrained.height].join(","),
      );
    }
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    if (props.browserEnabled !== false) void window.openbot.browser.setVisible({ visible: false });
  }

  async function closeBrowserTab(tabId: string) {
    const closesLastTab = browserTabs().length === 1 && browserTabs()[0]?.id === tabId;
    try {
      await props.onCloseBrowserTab(tabId);
      if (closesLastTab) hideBrowserPanel();
    } catch {
      setComposerError("Could not close the browser tab.");
    }
  }

  async function reloadBrowserTab(tabId: string) {
    try {
      await window.openbot.browser.reload(tabId);
      desktopAnalytics.track("browser_action", { action: "reload", result: "succeeded" });
    } catch {
      setComposerError("Could not reload the browser tab.");
      desktopAnalytics.track("browser_action", { action: "reload", result: "failed" });
    }
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

  const setConversationPanelElement = (element: HTMLElement) => {
    conversationPanel = element;
  };
  const conversationPanelElement = () => conversationPanel;
  const setChatSearchInputElement = (element: HTMLInputElement) => {
    chatSearchInput = element;
  };
  const setScrollElement = (element: HTMLDivElement) => {
    scrollElement = element;
  };
  const setStickToLatest = (value: boolean) => {
    stickToLatest = value;
  };
  const setVirtualRootElement = (element: HTMLDivElement) => {
    virtualRoot = element;
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
    activeBrowserTab,
    activeChatSearchIndex,
    activeDeliveries,
    activeRightPanel,
    activityPresentation,
    addAttachments,
    agentActivity,
    agentActivityExitDelayTimer,
    agentActivityExitTimer,
    agentActivityShowTimer,
    agentActivitySlot,
    agentActivitySpaceReserved,
    agentReady,
    attachmentAction,
    attachmentBusy,
    browserAddress,
    browserPipBounds,
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
    composerError,
    composerFocusRequest,
    composerHasContent,
    constrainBrowserPipBounds,
    controller,
    copiedMessageId,
    copyMessage,
    currentDraft,
    currentUnreadCount,
    drafts,
    dropActive,
    editQueuedMessage,
    editingDeliveryId,
    editingDraftBackup,
    expandedEmojiMessageId,
    expandedThinkingMessages,
    fadeAtBottom,
    fadeAtTop,
    finishVoiceRecording,
    handleChatSearchShortcut,
    hideBrowserPanel,
    imageGenerationUnavailable,
    jumpToLatestMessage,
    jumpToUnreadMessages,
    lastChatSearchQuery,
    lastConversationBotId,
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
    openSharedFile,
    openWorkspaceFile,
    orderedQueuedDeliveries,
    presentedQueueDeliveries,
    previewAttachment,
    previousBrowserTabCount,
    props,
    queueExitTimer,
    queuePanelVisible,
    reactToMessage,
    reloadBrowserTab,
    removeAttachment,
    renderedAgentActivity,
    renderedQueueDeliveries,
    reorderPresentedQueue,
    replyTarget,
    replyToMessage,
    resources,
    rightPanels,
    saveBotPatch,
    saveQueuedMessageEdit,
    scheduleUnreadDividerVisibilityUpdate,
    screenOpen,
    scrollElement,
    scrollResizeObserver,
    selectAndConfirmModel,
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
    setSelectionSending,
    setSettingsModel,
    setSettingsPanelWidth,
    setSettingsReasoning,
    setShowComposerActions,
    setShowScrollToLatest,
    setSubmitting,
    setUnreadDividerVisible,
    setVoiceElapsedSeconds,
    setVoicePhase,
    settingsModel,
    settingsOpen,
    settingsPanelWidth,
    settingsReasoning,
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
    submitMessage,
    submitting,
    unreadDividerVisible,
    unreadMessagesDivider,
    unreadVisibilityFrame,
    updateBrowserPipBounds,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateScrollFade,
    updateTeamTyping,
    updateUnreadDividerVisibility,
    virtualRoot,
    voiceElapsedSeconds,
    voicePhase,
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
    activeBrowserControl,
    agentActivity,
    agentReady,
    browserControlBot,
    hideBrowserPanel,
    props,
    screenOpen,
    selectAndConfirmModel,
    setActiveRightPanel,
    settingsModel,
    showBrowserPanel,
  } = useConversationViewScope();
  return (
    <header class="window-drag conversation-header">
      <div class="conversation-heading-group">
        <Show when={props.bot}>
          {(bot) => (
            <Button
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
        <Show when={props.remoteDesktopEnabled !== false && props.server?.kind === "remote" ? props.server : undefined}>
          {(server) => {
            const enabled = () =>
              props.remoteDesktopSessionActive || (server().state === "online" && server().remoteDesktopAvailable);
            const label = () => (props.remoteDesktopSessionActive ? "Resume remote control" : "Open remote control");
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
        <Show when={props.browserEnabled !== false}>
          <Button
            type="button"
            class={[
              "header-panel-toggle computer-button",
              { "computer-button-agent-active": Boolean(activeBrowserControl()) },
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
        </Show>
      </div>
    </header>
  );
}

/** @internal Stable HMR boundary for conversation timeline. */
export function ConversationTimeline() {
  const {
    activeChatSearchIndex,
    agentActivitySpaceReserved,
    agentReady,
    attachmentAction,
    chatSearchMatches,
    chatSearchOpen,
    chatSearchQuery,
    chatSearchTotal,
    closeChatSearch,
    copiedMessageId,
    copyMessage,
    expandedEmojiMessageId,
    expandedThinkingMessages,
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
    openSharedFile,
    openWorkspaceFile,
    previewAttachment,
    props,
    reactToMessage,
    renderedAgentActivity,
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
                          setUnreadMessagesDividerElement(element);
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
            ref={setAgentActivitySlotElement}
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
              <Loading>
                <ApprovalCard variant="questions" questions={prompt().questions} onSubmit={props.onAnswerPrompt} />
              </Loading>
            )}
          </Show>
          <Show when={props.approval}>
            {(approval) => (
              <Loading>
                <ApprovalCard
                  variant="approval"
                  approval={approval()}
                  onApprove={() => props.onRespondToApproval("accept")}
                  onReject={() => props.onRespondToApproval("decline")}
                />
              </Loading>
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
    editQueuedMessage,
    editingDeliveryId,
    imageGenerationUnavailable,
    openAttachmentPicker,
    openAttachmentPickerFromKey,
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
    submitMessage,
    submitting,
    unreferencedDraftAttachments,
    updateCurrentDraft,
    updateTeamTyping,
    voiceElapsedSeconds,
    voicePhase,
  } = useConversationViewScope();
  return (
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
              <Loading>
                <QueuePanel
                  deliveries={presentedQueueDeliveries()}
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
              disabled={submitting() || selectionSending() || !agentReady()}
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
              ref={setImageAttachmentPickerElement}
              type="file"
              accept=".png,.jpg,.jpeg,.gif,.webp,.avif"
              multiple
              hidden
              tabindex={-1}
              data-openbot-attachment-picker="true"
            />
            <Input
              ref={setContextAttachmentPickerElement}
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
                disabled={attachmentBusy() || submitting() || selectionSending() || !agentReady()}
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
                      (voicePhase() === "idle" && (!props.bot || !agentReady()))
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
                    disabled={submitting() || selectionSending() || !agentReady()}
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
  );
}

/** @internal Stable HMR boundary for conversation panels. */
export function ConversationPanels() {
  const {
    activeBrowserControl,
    activeBrowserTab,
    agentActivity,
    browserAddress,
    browserControlForTab,
    browserControllerForTab,
    browserPipBounds,
    browserPipOpen,
    browserTabs,
    closeBrowserTab,
    constrainBrowserPipBounds,
    conversationPanelElement,
    openBrowserAddress,
    props,
    reloadBrowserTab,
    screenOpen,
    setActiveRightPanel,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setBrowserSurfaceElement,
    setSettingsPanelWidth,
    showBrowserPip,
    hideBrowserPanel,
    settingsOpen,
    updateBrowserPipBounds,
  } = useConversationViewScope();
  return (
    <>
      <Show when={screenOpen()}>
        <BrowserPanel
          mode={browserPipOpen() ? "pip" : "sidebar"}
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
          onReload={(tabId) => void reloadBrowserTab(tabId)}
          onActivateTab={props.onActivateBrowserTab}
          onCloseTab={(tabId) => void closeBrowserTab(tabId)}
          onSurface={setBrowserSurfaceElement}
          onWidthChange={setBrowserPanelWidth}
          pipBounds={
            browserPipBounds() ??
            defaultBrowserPipBounds(
              conversationPanelElement()?.clientWidth || window.innerWidth,
              conversationPanelElement()?.clientHeight || window.innerHeight,
            )
          }
          constrainPipBounds={constrainBrowserPipBounds}
          onPipBoundsChange={updateBrowserPipBounds}
          onEnterPip={showBrowserPip}
          onDockPip={() => setActiveRightPanel("browser")}
          onHidePip={hideBrowserPanel}
        />
      </Show>

      <Show when={settingsOpen() && props.bot}>
        {(bot) => (
          <Loading>
            <AgentSettingsPanel
              bot={bot()}
              agentStatus={props.agentStatus}
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
              onSetAgentAvatar={props.onSetAgentAvatar}
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
  );
}

export function ConversationView(props: ConversationProps) {
  const scope = createConversationViewScope(props);
  const {
    agentReady,
    browserPanelWidth,
    browserSidebarOpen,
    dropActive,
    handleChatSearchShortcut,
    sendSelectionInstruction,
    setConversationPanelElement,
    setDropActive,
    settingsPanelWidth,
    submitting,
  } = scope;
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
            "browser-panel-active": browserSidebarOpen(),
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
