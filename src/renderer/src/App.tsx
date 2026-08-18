import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  flush,
  onSettled,
  Show,
  type StoreSetter,
} from "solid-js";
import type {
  AccountUsage,
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentReasoningEffort,
  AgentStatus,
  AppInfo,
  AppSetupState,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  CentralAuthState,
  ConversationMessage,
  ConversationSnapshot,
  HostStatus,
  InviteSummary,
  QueueSnapshot,
  RemoteMacSession,
  ServerSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamSessionSummary,
  UpdateBotInput,
  UpdateStatus,
} from "../../shared/ipc";
import { AccountLogin } from "./components/AccountLogin";
import { Conversation } from "./components/Conversation";
import { HostPanel } from "./components/HostPanel";
import { InitialSetup } from "./components/InitialSetup";
import { JoinServerDialog } from "./components/JoinServerDialog";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./components/PanelResizer";
import { RemoteMacPanel } from "./components/RemoteMacPanel";
import { ServerRail } from "./components/ServerRail";
import { Sidebar, type SidebarAgentState } from "./components/Sidebar";
import type { BotMessage, BotProfile } from "./data";

const FALLBACK_STATUS: AgentStatus = {
  phase: "starting",
  cliVersion: null,
  auth: { kind: "unknown" },
  providers: [
    { id: "codex", state: "not-started", version: null, message: null },
    { id: "claude", state: "not-started", version: null, message: null },
  ],
  capabilities: { chat: "unavailable", browser: "unavailable", computerUse: "unavailable" },
  message: "Starting local agent CLIs…",
  fullAccess: true,
};

const FALLBACK_UPDATE_STATUS: UpdateStatus = {
  phase: "unsupported",
  currentVersion: "",
  availableVersion: null,
  progress: null,
  checkedAt: null,
  message: null,
};

const FALLBACK_HOST_STATUS: HostStatus = {
  phase: "unconfigured",
  configured: false,
  enabledOnLaunch: false,
  serverId: null,
  serverName: null,
  apiUrl: null,
  vncHostname: null,
  apiOnline: false,
  vncOnline: false,
  message: null,
};

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

const LEFT_PANEL_STORAGE_KEY = "openbot:left-panel-width";
const LEFT_PANEL_COLLAPSED_STORAGE_KEY = "openbot:left-panel-collapsed";
const LEFT_PANEL_DEFAULT = 275;
const LEFT_PANEL_MIN = 220;
const LEFT_PANEL_MAX = 360;

const storeSetters = new WeakMap<object, StoreSetter<Record<string, unknown>>>();

function createStored<T extends object>(value: T): T {
  const [store, setStore] = createStore(value as Record<string, unknown>);
  storeSetters.set(store, setStore);
  return store as T;
}

function updateStored<T extends object>(store: T, value: T): void {
  storeSetters.get(store)?.((draft) => {
    Object.assign(draft, value as Record<string, unknown>);
  });
}

const ONBOARDING_PROFILES: Record<
  string,
  { role: string; description: string; firstMessage: string }
> = {
  "Work & projects": {
    role: "Work & projects",
    description:
      "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
    firstMessage:
      "Focus on my work and projects. Help me plan, organize, and execute them proactively.",
  },
  "Research & writing": {
    role: "Research & writing",
    description:
      "Researches topics, synthesizes reliable sources, and helps draft, edit, and refine clear writing.",
    firstMessage:
      "Focus on research and writing. Help me investigate topics and turn the findings into clear, useful writing.",
  },
  "Sales & outreach": {
    role: "Sales & outreach",
    description:
      "Supports prospect research, sales preparation, personalized outreach, and organized follow-up work.",
    firstMessage:
      "Focus on sales and outreach. Help me research prospects, prepare personalized outreach, and manage follow-ups.",
  },
};

export function App() {
  const [botList, setBotList] = createSignal<BotProfile[]>([]);
  const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
  const [activeBotId, setActiveBotId] = createSignal("");
  const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
  const [uiErrors, setUiErrors] = createSignal<Record<string, BotMessage[]>>({});
  const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
  const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>(
    {},
  );
  const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>({});
  const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
  const [recentReplies, setRecentReplies] = createSignal<Record<string, boolean>>({});
  const [queues, setQueues] = createSignal<Record<string, QueueSnapshot>>({});
  const [browserTabs, setBrowserTabs] = createSignal<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = createSignal<string | null>(null);
  const [browserControlState, setBrowserControlState] = createSignal<BrowserControlState>({
    sessions: [],
  });
  const [agentPickerOpen, setAgentPickerOpen] = createSignal(false);
  const [creatingAgent, setCreatingAgent] = createSignal(false);
  const [settingsRequest, setSettingsRequest] = createSignal<{
    botId: string;
    nonce: number;
  } | null>(null);
  const [onboardingRequest, setOnboardingRequest] = createSignal<{
    botId: string;
    nonce: number;
  } | null>(null);
  const [pendingPrompts, setPendingPrompts] = createSignal<Record<string, PromptEvent | undefined>>(
    {},
  );
  const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
  const [accountUsage, setAccountUsage] = createSignal<AccountUsage | null>(null);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(FALLBACK_UPDATE_STATUS);
  const [leftPanelWidth, setLeftPanelWidth] = createSignal(
    readPanelWidth(LEFT_PANEL_STORAGE_KEY, LEFT_PANEL_DEFAULT, LEFT_PANEL_MIN, LEFT_PANEL_MAX),
  );
  const [leftPanelCollapsed, setLeftPanelCollapsed] = createSignal(
    window.localStorage.getItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY) === "true",
  );
  const [setupState, setSetupState] = createSignal<AppSetupState | null>(null);
  const [setupLoaded, setSetupLoaded] = createSignal(false);
  const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({ status: "loading" });
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [servers, setServers] = createSignal<ServerSummary[]>([]);
  const [joinServerOpen, setJoinServerOpen] = createSignal(false);
  const [pendingInviteUrl, setPendingInviteUrl] = createSignal("");
  const [hostOpen, setHostOpen] = createSignal(false);
  const [hostStatus, setHostStatus] = createSignal<HostStatus>(FALLBACK_HOST_STATUS);
  const [teamMembers, setTeamMembers] = createSignal<TeamMemberSummary[]>([]);
  const [teamInvites, setTeamInvites] = createSignal<TeamInviteSummary[]>([]);
  const [teamSessions, setTeamSessions] = createSignal<TeamSessionSummary[]>([]);
  const [remoteMacOpen, setRemoteMacOpen] = createSignal(false);
  const [remoteMacSessions, setRemoteMacSessions] = createSignal<RemoteMacSession[]>([]);
  const pendingConversationSnapshots = new Map<string, ConversationSnapshot>();
  const recentReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let conversationFrame: number | undefined;

  const activeBot = createMemo(
    () => botList().find((bot) => bot.id === activeBotId()) ?? botList()[0],
  );
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    return bot ? [...(liveMessages()[bot.id] ?? []), ...(uiErrors()[bot.id] ?? [])] : [];
  });

  onSettled(() => {
    const unsubscribe = window.openbot.agent.onEvent((event) => {
      flush(() => handleAgentEvent(event));
    });
    const unsubscribeUpdate = window.openbot.update.onEvent((status) => {
      flush(() => setUpdateStatus(status));
    });
    const unsubscribeAuth = window.openbot.auth.onEvent((state) => {
      flush(() => setCentralAuth(state));
    });
    const unsubscribeServers = window.openbot.servers.onEvent((value) =>
      flush(() => setServers(value)),
    );
    const unsubscribeInvite = window.openbot.servers.onInvite((inviteUrl) => {
      flush(() => {
        setPendingInviteUrl(inviteUrl);
        setJoinServerOpen(true);
      });
    });
    const unsubscribeHost = window.openbot.host.onEvent((status) =>
      flush(() => setHostStatus(status)),
    );
    const unsubscribeRemoteMac = window.openbot.remoteMac.onEvent((sessions) =>
      flush(() => setRemoteMacSessions(sessions)),
    );
    const cleanup = () => {
      unsubscribe();
      unsubscribeUpdate();
      unsubscribeAuth();
      unsubscribeServers();
      unsubscribeInvite();
      unsubscribeHost();
      unsubscribeRemoteMac();
      if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame);
      for (const timer of recentReplyTimers.values()) clearTimeout(timer);
      recentReplyTimers.clear();
    };
    void window.openbot.update
      .getStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    void window.openbot.auth
      .getState()
      .then(setCentralAuth)
      .catch(() =>
        setCentralAuth({
          status: "error",
          code: "auth_unavailable",
          message: "OpenBot could not load the account service.",
        }),
      );
    void window.openbot
      .getSetupState()
      .then(setSetupState)
      .finally(() => setSetupLoaded(true));

    void Promise.all([
      window.openbot
        .getAppInfo()
        .then(setAppInfo)
        .catch(() => setAppInfo({ name: "OpenBot", version: "unavailable", platform: "darwin" })),
      window.openbot.agent
        .getStatus()
        .then(setAgentStatus)
        .catch(() => undefined),
      window.openbot.agent
        .listModels()
        .then(setModelOptions)
        .catch(() => undefined),
      window.openbot.agent
        .listBots()
        .then(applyStoredBots)
        .catch((error) => {
          setAgentStatus((current) => ({ ...current, message: String(error) }));
        }),
    ]);
    void window.openbot.browser
      .listTabs()
      .then((tabs) => {
        setBrowserTabs(tabs);
        setActiveBrowserTabId((current) => current ?? tabs[0]?.id ?? null);
      })
      .catch(() => undefined);
    void window.openbot.browser
      .getControlState()
      .then(setBrowserControlState)
      .catch(() => undefined);
    void window.openbot.servers
      .list()
      .then(setServers)
      .catch(() => undefined);
    void window.openbot.host
      .getStatus()
      .then(setHostStatus)
      .catch(() => undefined);
    void window.openbot.remoteMac
      .list()
      .then(setRemoteMacSessions)
      .catch(() => undefined);
    return cleanup;
  });

  createEffect(
    () => ({ botId: activeBotId(), agentPhase: agentStatus().phase }),
    ({ botId }) => {
      if (!botId) return;
      void Promise.all([
        window.openbot.agent.readConversation(botId),
        window.openbot.agent.listQueue(botId),
      ])
        .then(([snapshot, queue]) => {
          setQueues((current) => ({ ...current, [botId]: queue }));
          scheduleConversation(snapshot);
        })
        .catch((error) => appendUiError(botId, error, "Load failed"));
    },
  );

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "status":
        setAgentStatus(event.status);
        if (event.status.phase === "ready") {
          void window.openbot.agent
            .listModels()
            .then(setModelOptions)
            .catch(() => undefined);
        }
        return;
      case "usage-changed":
        setAccountUsage(event.usage);
        return;
      case "bots-changed":
        applyStoredBots(event.bots);
        return;
      case "conversation":
        scheduleConversation(event.snapshot);
        return;
      case "conversation-delta":
        applyConversationDelta(event);
        return;
      case "queue-changed":
        setQueues((current) => ({ ...current, [event.snapshot.botId]: event.snapshot }));
        return;
      case "browser-changed":
        setBrowserTabs(event.tabs);
        setActiveBrowserTabId(event.activeTabId);
        return;
      case "browser-control-changed":
        setBrowserControlState(event.state);
        return;
      case "turn-started":
        clearRecentReply(event.botId);
        setActiveTurns((current) => ({ ...current, [event.botId]: event.turnId }));
        return;
      case "turn-completed":
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        if (event.status === "completed") markReplyCompleted(event.botId);
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        return;
      case "error":
        if (event.botId) appendUiError(event.botId, event.message, "Error");
    }
  }

  function applyStoredBots(storedBots: BotSummary[]) {
    const currentById = new Map(botList().map((bot) => [bot.id, bot]));
    const profiles = storedBots.map((stored) => {
      const next = toBotProfile(stored);
      const existing = currentById.get(next.id);
      if (!existing) return createStored(next);
      if (!botProfilesEqual(existing, next)) updateStored(existing, next);
      return existing;
    });
    setBotList(profiles);
    setActiveBotId((current) =>
      profiles.some((bot) => bot.id === current) ? current : (profiles[0]?.id ?? ""),
    );
    if (profiles.length === 0) setAgentPickerOpen(true);
  }

  function scheduleConversation(snapshot: ConversationSnapshot) {
    const botId = snapshot.botId;
    const appliedRevision = conversationRevisions()[botId] ?? -1;
    const pendingRevision = pendingConversationSnapshots.get(botId)?.revision ?? -1;
    if (snapshot.revision < Math.max(appliedRevision, pendingRevision)) return;
    pendingConversationSnapshots.set(botId, snapshot);
    if (conversationFrame !== undefined) return;
    conversationFrame = requestAnimationFrame(() => {
      conversationFrame = undefined;
      const snapshots = [...pendingConversationSnapshots.values()];
      pendingConversationSnapshots.clear();
      for (const pending of snapshots) applyConversation(pending);
    });
  }

  function applyConversationDelta(event: Extract<AgentEvent, { type: "conversation-delta" }>) {
    if (event.revision <= (conversationRevisions()[event.botId] ?? -1)) return;
    pendingConversationSnapshots.delete(event.botId);
    setConversationRevisions((current) => ({ ...current, [event.botId]: event.revision }));

    const existing = liveMessages()[event.botId]?.find((message) => message.id === event.messageId);
    if (existing) {
      updateStored(existing, {
        ...existing,
        body: existing.body + event.delta,
        streaming: true,
      });
    } else {
      const message = createStored<BotMessage>({
        id: event.messageId,
        turnId: event.turnId,
        author: "bot",
        body: event.delta,
        time: formatTime(event.createdAt),
        streaming: true,
        animate: conversationLoaded()[event.botId] === true,
        kind: "text",
      });
      setLiveMessages((current) => ({
        ...current,
        [event.botId]: [...(current[event.botId] ?? []), message],
      }));
    }
    setConversationLoaded((current) => ({ ...current, [event.botId]: true }));
  }

  function applyConversation(snapshot: ConversationSnapshot) {
    const botId = snapshot.botId;
    if (snapshot.revision < (conversationRevisions()[botId] ?? -1)) return;
    const initialLoad = conversationLoaded()[botId] !== true;
    setConversationRevisions((current) => ({ ...current, [botId]: snapshot.revision }));
    setLiveMessages((current) => {
      const previous = current[botId] ?? [];
      const previousById = new Map(previous.map((message) => [message.id, message]));
      const mappedMessages = retainThinkingMessages(previous, toBotMessages(snapshot.messages));
      const next = mappedMessages.map((mapped) => {
        const existing = previousById.get(mapped.id);
        if (!existing) return createStored({ ...mapped, animate: !initialLoad });
        if (!botMessagesEqual(existing, mapped)) updateStored(existing, mapped);
        return existing;
      });
      if (
        previous.length === next.length &&
        previous.every((message, index) => message === next[index])
      ) {
        return current;
      }
      return { ...current, [botId]: next };
    });
    setConversationLoaded((current) => ({ ...current, [botId]: true }));
    setActiveTurns((current) => ({ ...current, [botId]: snapshot.activeTurnId }));
  }

  async function createAgent() {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.openbot.agent.createBot();
      const newAgent = createStored(toBotProfile(stored));
      setBotList((current) => [newAgent, ...current.filter((item) => item.id !== newAgent.id)]);
      setLiveMessages((current) => ({ ...current, [newAgent.id]: [] }));
      setConversationLoaded((current) => ({ ...current, [newAgent.id]: true }));
      setAgentPickerOpen(false);
      setActiveBotId(newAgent.id);
      setOnboardingRequest({ botId: newAgent.id, nonce: Date.now() });
    } catch (error) {
      setAgentPickerOpen(false);
      if (activeBotId()) appendUiError(activeBotId(), error, "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  function selectBot(botId: string) {
    setAgentPickerOpen(false);
    clearReplyIndicators(botId);
    setActiveBotId(botId);
  }

  function markReplyCompleted(botId: string) {
    if (activeBotId() !== botId) {
      setUnreadReplies((current) => ({
        ...current,
        [botId]: Math.min(99, (current[botId] ?? 0) + 1),
      }));
      return;
    }
    clearRecentReply(botId);
    setRecentReplies((current) => ({ ...current, [botId]: true }));
    recentReplyTimers.set(
      botId,
      setTimeout(() => {
        recentReplyTimers.delete(botId);
        setRecentReplies((current) => ({ ...current, [botId]: false }));
      }, 4000),
    );
  }

  function clearRecentReply(botId: string) {
    const timer = recentReplyTimers.get(botId);
    if (timer) clearTimeout(timer);
    recentReplyTimers.delete(botId);
    setRecentReplies((current) => (current[botId] ? { ...current, [botId]: false } : current));
  }

  function clearReplyIndicators(botId: string) {
    clearRecentReply(botId);
    setUnreadReplies((current) => (current[botId] ? { ...current, [botId]: 0 } : current));
  }

  function activateBrowserTab(tabId: string) {
    void window.openbot.browser.activate(tabId);
  }

  function closeBrowserTab(tabId: string) {
    void window.openbot.browser.close(tabId);
  }

  async function updateBot(botId: string, updates: Omit<UpdateBotInput, "botId">) {
    try {
      const stored = await window.openbot.agent.updateBot({ botId, ...updates });
      const next = toBotProfile(stored);
      setBotList((current) => {
        const existingIndex = current.findIndex((bot) => bot.id === botId);
        if (existingIndex === -1) return [...current, createStored(next)];
        const existing = current[existingIndex];
        if (existing) updateStored(existing, next);
        return current;
      });
    } catch (error) {
      appendUiError(botId, error, "Settings failed");
      throw error;
    }
  }

  function editBot(botId: string) {
    selectBot(botId);
    setSettingsRequest({ botId, nonce: Date.now() });
  }

  async function deleteBot(botId: string) {
    try {
      await window.openbot.agent.deleteBot(botId);
      const remaining = botList().filter((bot) => bot.id !== botId);
      setBotList(remaining);
      setActiveBotId((current) => (current === botId ? (remaining[0]?.id ?? "") : current));
      setSettingsRequest((current) => (current?.botId === botId ? null : current));
      setLiveMessages((current) => withoutBot(current, botId));
      setUiErrors((current) => withoutBot(current, botId));
      setConversationLoaded((current) => withoutBot(current, botId));
      setConversationRevisions((current) => withoutBot(current, botId));
      setActiveTurns((current) => withoutBot(current, botId));
      setUnreadReplies((current) => withoutBot(current, botId));
      setRecentReplies((current) => withoutBot(current, botId));
      setQueues((current) => withoutBot(current, botId));
      setPendingPrompts((current) => withoutBot(current, botId));
      const replyTimer = recentReplyTimers.get(botId);
      if (replyTimer) clearTimeout(replyTimer);
      recentReplyTimers.delete(botId);
    } catch (error) {
      appendUiError(botId, error, "Delete failed");
      throw error;
    }
  }

  async function sendMessage(
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null,
  ): Promise<boolean> {
    const bot = activeBot();
    if (!bot || (!body.trim() && attachmentDraftIds.length === 0)) return false;
    return sendMessageToBot(bot.id, body, attachmentDraftIds, replyToMessageId);
  }

  async function sendMessageToBot(
    botId: string,
    body: string,
    attachmentDraftIds: string[],
    replyToMessageId: string | null = null,
  ): Promise<boolean> {
    try {
      await window.openbot.agent.sendMessage({
        botId,
        text: body.trim(),
        attachmentDraftIds,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      setUiErrors((current) => ({ ...current, [botId]: [] }));
      return true;
    } catch (error) {
      appendUiError(botId, error, "Send failed");
      return false;
    }
  }

  async function completeOnboarding(
    answer: string,
    model: AgentModelId,
    reasoningEffort: AgentReasoningEffort,
  ): Promise<boolean> {
    const bot = activeBot();
    const topic = answer.trim();
    if (!bot || !topic) return false;
    const predefined = ONBOARDING_PROFILES[topic];
    const profile = predefined ?? {
      role: topic.length <= 60 ? topic : "Custom focus",
      description: `Primary focus: ${topic.slice(0, 1_900)}.`,
      firstMessage: `My main focus for you is: ${topic}. Treat this as your ongoing specialty.`,
    };
    try {
      await updateBot(bot.id, {
        role: profile.role,
        description: profile.description,
        model,
        reasoningEffort,
      });
    } catch {
      return false;
    }
    return sendMessageToBot(bot.id, profile.firstMessage, []);
  }

  async function answerPrompt(answers: Record<string, string[]>): Promise<boolean> {
    const bot = activeBot();
    const prompt = bot ? pendingPrompts()[bot.id] : undefined;
    if (!bot || !prompt) return false;
    try {
      await window.openbot.agent.respondToPrompt({ requestId: prompt.requestId, answers });
      setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Answer failed");
      return false;
    }
  }

  function cancelQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .cancelQueuedMessage({ botId: bot.id, deliveryId })
      .catch((error) => appendUiError(bot.id, error, "Cancel failed"));
  }

  function resumeQueue() {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .setQueuePaused({ botId: bot.id, paused: false })
      .catch((error) => appendUiError(bot.id, error, "Resume failed"));
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.openbot.agent
      .interrupt({ botId: bot.id, turnId })
      .catch((error) => appendUiError(bot.id, error, "Stop failed"));
  }

  async function refreshAccountUsage(): Promise<AccountUsage> {
    const usage = await window.openbot.agent.getUsage();
    setAccountUsage(usage);
    return usage;
  }

  function appendUiError(botId: string, error: unknown, status: string) {
    const body = error instanceof Error ? error.message : String(error);
    setUiErrors((current) => ({
      ...current,
      [botId]: [
        ...(current[botId] ?? []),
        {
          id: `ui-${Date.now()}-${Math.random()}`,
          author: "bot",
          body,
          time: formatTime(new Date().toISOString()),
          status,
        },
      ],
    }));
  }

  const activeQueue = createMemo(() => {
    const bot = activeBot();
    return bot ? queues()[bot.id] : undefined;
  });
  const sidebarAgentStates = createMemo<Record<string, SidebarAgentState>>(() => {
    const turns = activeTurns();
    const queueSnapshots = queues();
    const unread = unreadReplies();
    const recent = recentReplies();
    const states: Record<string, SidebarAgentState> = {};
    for (const bot of botList()) {
      const isWorking =
        Boolean(turns[bot.id]) ||
        Boolean(
          queueSnapshots[bot.id]?.deliveries.some(
            (delivery) => delivery.status === "starting" || delivery.status === "running",
          ),
        );
      if (isWorking) states[bot.id] = { kind: "working" };
      else if ((unread[bot.id] ?? 0) > 0) {
        states[bot.id] = { kind: "unread", count: unread[bot.id] ?? 1 };
      } else if (recent[bot.id]) states[bot.id] = { kind: "responded" };
    }
    return states;
  });

  function setSidebarCollapsed(collapsed: boolean) {
    setLeftPanelCollapsed(collapsed);
    window.localStorage.setItem(LEFT_PANEL_COLLAPSED_STORAGE_KEY, String(collapsed));
  }

  async function saveSetup(preferredProvider: AgentProviderId): Promise<void> {
    const state = await window.openbot.saveSetup({ preferredProvider });
    flush(() => {
      setSetupState(state);
      setPermissionsOpen(false);
    });
  }

  async function requestEmailCode(email: string): Promise<void> {
    setCentralAuth(await window.openbot.auth.requestEmailCode(email));
  }

  async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
    setCentralAuth(await window.openbot.auth.verifyEmailCode(challengeId, code));
  }

  async function logoutCentralAccount(): Promise<void> {
    setCentralAuth(await window.openbot.auth.logout());
  }

  async function runUpdateAction(): Promise<void> {
    const phase = updateStatus().phase;
    if (phase === "ready") {
      await window.openbot.update.install();
      return;
    }
    const status =
      phase === "available"
        ? await window.openbot.update.download()
        : await window.openbot.update.check();
    setUpdateStatus(status);
  }

  async function selectServer(serverId: string): Promise<void> {
    const nextServers = await window.openbot.servers.select(serverId);
    setServers(nextServers);
    setAgentPickerOpen(false);
    setSettingsRequest(null);
    setBotList([]);
    setActiveBotId("");
    setLiveMessages({});
    setUiErrors({});
    setConversationLoaded({});
    setConversationRevisions({});
    setQueues({});
    const [storedBots, status, models, tabs, controlState] = await Promise.all([
      window.openbot.agent.listBots(),
      window.openbot.agent.getStatus(),
      window.openbot.agent.listModels(),
      window.openbot.browser.listTabs(),
      window.openbot.browser.getControlState(),
    ]);
    setAgentStatus(status);
    setModelOptions(models);
    setBrowserTabs(tabs);
    setActiveBrowserTabId(tabs[0]?.id ?? null);
    setBrowserControlState(controlState);
    applyStoredBots(storedBots);
  }

  async function joinServer(input: { inviteUrl: string }): Promise<void> {
    await window.openbot.servers.join(input);
    setPendingInviteUrl("");
    setJoinServerOpen(false);
    await selectServer(
      window.openbot
        ? ((await window.openbot.servers.list()).find((item) => item.active)?.id ?? "local")
        : "local",
    );
  }

  async function joinRemoteDuringSetup(
    input: { inviteUrl: string },
    provider: AgentProviderId,
  ): Promise<void> {
    await joinServer(input);
    await saveSetup(provider);
  }

  async function refreshHostManagement(): Promise<void> {
    if (!hostStatus().configured) {
      setTeamMembers([]);
      setTeamInvites([]);
      setTeamSessions([]);
      return;
    }
    try {
      const [members, invites, sessions] = await Promise.all([
        window.openbot.host.listMembers(),
        window.openbot.host.listInvites(),
        window.openbot.host.listSessions(),
      ]);
      setTeamMembers(members);
      setTeamInvites(invites);
      setTeamSessions(sessions);
    } catch {
      setTeamMembers([]);
      setTeamInvites([]);
      setTeamSessions([]);
    }
  }

  function openHostPanel(): void {
    setHostOpen(true);
    void refreshHostManagement();
  }

  async function configureHost(input: { serverName: string }): Promise<void> {
    setHostStatus(await window.openbot.host.configure(input));
    await refreshHostManagement();
  }

  async function startHost(): Promise<void> {
    setHostStatus(await window.openbot.host.start());
  }

  async function stopHost(): Promise<void> {
    setHostStatus(await window.openbot.host.stop());
  }

  async function createHostInvite(input: {
    role: "admin" | "member";
    email?: string;
  }): Promise<InviteSummary> {
    const invite = await window.openbot.host.createInvite(input);
    await refreshHostManagement();
    return invite;
  }

  async function updateHostMember(input: {
    memberId: string;
    role?: "admin" | "member";
    disabled?: boolean;
  }): Promise<void> {
    await window.openbot.host.updateMember(input);
    await refreshHostManagement();
  }

  async function revokeHostSession(sessionId: string): Promise<void> {
    await window.openbot.host.revokeSession(sessionId);
    await refreshHostManagement();
  }

  async function revokeHostInvite(inviteId: string): Promise<void> {
    await window.openbot.host.revokeInvite(inviteId);
    await refreshHostManagement();
  }

  async function copyHostAddressUpdate(): Promise<void> {
    await navigator.clipboard.writeText(await window.openbot.host.createAddressUpdate());
  }

  async function connectRemoteMac(hostname: string, serverId: string | null): Promise<void> {
    await window.openbot.remoteMac.connect({ hostname, serverId });
  }

  async function disconnectRemoteMac(sessionId: string): Promise<void> {
    await window.openbot.remoteMac.disconnect(sessionId);
  }

  const activeServer = createMemo(() => servers().find((server) => server.active));
  const signedInAccount = createMemo(() => {
    const state = centralAuth();
    return state.status === "signed_in" ? state.user : null;
  });

  return (
    <Show
      when={setupLoaded() && appInfo() !== null}
      fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}
    >
      <Show
        when={signedInAccount()}
        fallback={
          <AccountLogin
            state={centralAuth()}
            onRequestEmailCode={requestEmailCode}
            onVerifyEmailCode={verifyEmailCode}
            onReset={logoutCentralAccount}
          />
        }
      >
        {(account) => (
          <Show
            when={setupState()?.completed}
            fallback={
              <InitialSetup
                state={setupState() ?? { completed: false, preferredProvider: null }}
                agentStatus={agentStatus()}
                platform={appInfo()?.platform ?? "darwin"}
                accountEmail={account().email}
                onSave={saveSetup}
                onJoinRemote={joinRemoteDuringSetup}
                onLogout={logoutCentralAccount}
              />
            }
          >
            <div
              class={[
                "app-frame",
                {
                  "app-frame-sidebar-collapsed": leftPanelCollapsed(),
                  "app-frame-with-server-rail": appInfo()?.platform === "darwin",
                },
              ]}
              style={`--left-panel-width: ${leftPanelCollapsed() ? 0 : leftPanelWidth()}px`}
            >
              <Show when={appInfo()?.platform === "darwin"}>
                <ServerRail
                  servers={servers()}
                  hostStatus={hostStatus()}
                  onSelect={(serverId) => void selectServer(serverId)}
                  onAdd={() => setJoinServerOpen(true)}
                  onOpenHost={openHostPanel}
                  onOpenRemoteMac={() => setRemoteMacOpen(true)}
                />
              </Show>
              <Show when={!leftPanelCollapsed()}>
                <Sidebar
                  bots={botList()}
                  activeBotId={activeBot()?.id ?? ""}
                  appInfo={appInfo()}
                  agentStatus={agentStatus()}
                  accountUsage={accountUsage()}
                  updateStatus={updateStatus()}
                  agentStates={sidebarAgentStates()}
                  onSelectBot={selectBot}
                  onCreateBot={() => setAgentPickerOpen(true)}
                  onEditBot={editBot}
                  onDeleteBot={deleteBot}
                  onRefreshUsage={refreshAccountUsage}
                  onUpdateAction={runUpdateAction}
                  onOpenExternal={(destination) => window.openbot.openExternal(destination)}
                  onOpenPermissions={() => setPermissionsOpen(true)}
                  onCollapse={() => setSidebarCollapsed(true)}
                />
                <PanelResizer
                  class="left-panel-resizer"
                  label="Resize left sidebar"
                  controls="bot-sidebar"
                  direction="left"
                  value={leftPanelWidth()}
                  defaultValue={LEFT_PANEL_DEFAULT}
                  min={LEFT_PANEL_MIN}
                  max={LEFT_PANEL_MAX}
                  onResize={setLeftPanelWidth}
                  onResizeEnd={(value) => savePanelWidth(LEFT_PANEL_STORAGE_KEY, value)}
                />
              </Show>
              <Conversation
                agentStatus={agentStatus()}
                bot={activeBot()}
                bots={botList()}
                modelOptions={modelOptions()}
                messages={activeMessages()}
                loaded={activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false}
                queue={activeQueue()}
                browserTabs={browserTabs()}
                activeBrowserTabId={activeBrowserTabId()}
                browserControlState={browserControlState()}
                leftSidebarCollapsed={leftPanelCollapsed()}
                prompt={activeBot() ? pendingPrompts()[activeBot()?.id ?? ""] : undefined}
                activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
                agentPickerOpen={agentPickerOpen()}
                creatingAgent={creatingAgent()}
                settingsRequest={settingsRequest()}
                onboardingRequest={onboardingRequest()}
                onCloseAgentPicker={() => setAgentPickerOpen(false)}
                onCreateAgent={() => void createAgent()}
                onSelectAgent={selectBot}
                onUpdateBot={updateBot}
                onSendMessage={sendMessage}
                onCompleteOnboarding={completeOnboarding}
                onAnswerPrompt={answerPrompt}
                onCancelQueuedMessage={cancelQueuedMessage}
                onResumeQueue={resumeQueue}
                onActivateBrowserTab={activateBrowserTab}
                onCloseBrowserTab={closeBrowserTab}
                onToggleLeftSidebar={() => setSidebarCollapsed(false)}
                onOpenAgentSetup={() => window.openbot.openExternal("agent-setup")}
                onStop={stopActiveTurn}
              />
              <Show when={permissionsOpen()}>
                <InitialSetup
                  reviewing
                  state={setupState() ?? { completed: true, preferredProvider: "codex" }}
                  agentStatus={agentStatus()}
                  platform={appInfo()?.platform ?? "darwin"}
                  accountEmail={account().email}
                  onSave={saveSetup}
                  onJoinRemote={joinRemoteDuringSetup}
                  onLogout={logoutCentralAccount}
                  onClose={() => setPermissionsOpen(false)}
                />
              </Show>
              <Show when={joinServerOpen()}>
                <JoinServerDialog
                  inviteUrl={pendingInviteUrl()}
                  accountEmail={account().email}
                  onClose={() => {
                    setJoinServerOpen(false);
                    setPendingInviteUrl("");
                  }}
                  onJoin={joinServer}
                />
              </Show>
              <Show when={hostOpen()}>
                <HostPanel
                  status={hostStatus()}
                  members={teamMembers()}
                  invites={teamInvites()}
                  sessions={teamSessions()}
                  accountEmail={account().email}
                  onClose={() => setHostOpen(false)}
                  onConfigure={configureHost}
                  onStart={startHost}
                  onStop={stopHost}
                  onCreateInvite={createHostInvite}
                  onUpdateMember={updateHostMember}
                  onRevokeSession={revokeHostSession}
                  onRevokeInvite={revokeHostInvite}
                  onCopyAddressUpdate={copyHostAddressUpdate}
                />
              </Show>
              <Show when={remoteMacOpen()}>
                <RemoteMacPanel
                  server={activeServer()}
                  sessions={remoteMacSessions()}
                  onClose={() => setRemoteMacOpen(false)}
                  onConnect={connectRemoteMac}
                  onDisconnect={disconnectRemoteMac}
                />
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </Show>
  );
}

function toBotProfile(stored: BotSummary): BotProfile {
  return {
    id: stored.id,
    name: stored.name,
    role: stored.role,
    description: stored.description,
    notifications: stored.notifications,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    threadId: stored.threadId,
    avatarSeed: stored.avatarSeed,
    avatarHue: stored.avatarHue,
    time: stored.updatedAt ? formatTime(stored.updatedAt) : "now",
    preview: cleanPreview(stored.preview),
  };
}

function toBotMessage(message: ConversationMessage): BotMessage {
  const exchangeSenderId = message.senderBotId ?? message.exchange?.senderBotId;
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author === "user" ? "you" : "bot",
    body: message.text,
    time: formatTime(message.createdAt),
    streaming: message.status === "streaming",
    itemType: message.itemType,
    kind: message.exchange ? "exchange" : "text",
    senderBotId: exchangeSenderId,
    replyToMessageId: message.replyToMessageId,
    attachments: message.attachments,
    exchange: message.exchange,
    reaction: message.reaction,
    status: message.exchange
      ? undefined
      : message.delivery?.status === "queued"
        ? `Queued #${message.delivery.position}`
        : message.delivery?.status === "cancelled"
          ? "Cancelled"
          : message.status === "failed"
            ? "Failed"
            : message.status === "interrupted"
              ? "Stopped"
              : undefined,
  };
}

function toBotMessages(messages: ConversationMessage[]): BotMessage[] {
  const result: BotMessage[] = [];
  const thinkingByTurn = new Map<string, BotMessage>();
  for (const message of messages) {
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(toBotMessage(message));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      if (message.text.trim()) existing.items = [...(existing.items ?? []), message.text];
      existing.streaming = existing.streaming || message.status === "streaming";
      continue;
    }

    const thinking: BotMessage = {
      id: `thinking:${key}`,
      turnId: message.turnId,
      author: "bot",
      body: "",
      time: formatTime(message.createdAt),
      streaming: message.status === "streaming",
      itemType: "commentary",
      kind: "thinking",
      items: message.text.trim() ? [message.text] : [],
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  return result;
}

function cleanPreview(preview: string): string {
  const cleaned = preview
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || "No messages yet";
}

function botProfilesEqual(left: BotProfile, right: BotProfile): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.role === right.role &&
    left.description === right.description &&
    left.notifications === right.notifications &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.threadId === right.threadId &&
    left.avatarSeed === right.avatarSeed &&
    left.avatarHue === right.avatarHue &&
    left.time === right.time &&
    left.preview === right.preview
  );
}

function botMessagesEqual(left: BotMessage, right: BotMessage): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.senderBotId === right.senderBotId &&
    left.replyToMessageId === right.replyToMessageId &&
    left.reaction === right.reaction &&
    JSON.stringify(left.attachments) === JSON.stringify(right.attachments) &&
    JSON.stringify(left.exchange) === JSON.stringify(right.exchange) &&
    JSON.stringify(left.items) === JSON.stringify(right.items)
  );
}

function retainThinkingMessages(previous: BotMessage[], next: BotMessage[]): BotMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) =>
      message.turnId === thinking.turnId ? [index] : [],
    );
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) =>
        message.turnId === thinking.turnId &&
        message.author === "bot" &&
        message.kind !== "thinking",
    );
    const insertionIndex =
      finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, { ...thinking, streaming: false });
    nextIds.add(thinking.id);
  }
  return result;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function withoutBot<T>(values: Record<string, T>, botId: string): Record<string, T> {
  const next = { ...values };
  delete next[botId];
  return next;
}
