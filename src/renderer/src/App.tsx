import type {
  AccountUsage,
  AgentApproval,
  AgentEvent,
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentReasoningEffort,
  AgentStatus,
  AppInfo,
  AppSetupState,
  AvatarImageInput,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  CentralAuthState,
  ConversationMessage,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingRealtimeEvent,
  HostStatus,
  InviteSummary,
  QueueSnapshot,
  RemoteMacSession,
  ServerSummary,
  TeamInviteSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateBotInput,
  UpdateStatus,
} from "@openbot/contracts/ipc";
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
import { AccountLogin } from "./components/AccountLogin";
import { Conversation } from "./components/Conversation";
import { DirectConversation } from "./components/DirectConversation";
import { HostPanel } from "./components/HostPanel";
import { InitialSetup } from "./components/InitialSetup";
import { JoinServerDialog } from "./components/JoinServerDialog";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./components/PanelResizer";
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
  capabilities: {
    chat: "unavailable",
    browser: "unavailable",
    computerUse: "unavailable",
  },
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
  remoteDesktopCredentialConfigured: false,
  message: null,
};

const EMPTY_TEAM_PRESENCE: TeamPresenceSnapshot = {
  serverId: null,
  members: [],
  updatedAt: "",
};

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;

const LEFT_PANEL_STORAGE_KEY = "openbot:left-panel-width";
const LEFT_PANEL_COLLAPSED_STORAGE_KEY = "openbot:left-panel-collapsed";
const LEFT_PANEL_DEFAULT = 280;
const LEFT_PANEL_MIN = 240;
const LEFT_PANEL_MAX = 400;
const LEFT_PANEL_COMPACT = 88;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 210;
const LEFT_PANEL_EXPAND_THRESHOLD = 220;
const CONVERSATION_MIN_WIDTH = 424;

interface StoredObject {
  [key: string]: unknown;
}

const storeSetters = new WeakMap<object, StoreSetter<StoredObject>>();

function createStored<T extends object>(value: T): T {
  const [store, setStore] = createStore(value as StoredObject);
  storeSetters.set(store, setStore);
  return store as T;
}

function updateStored<T extends object>(store: T, value: T): void {
  storeSetters.get(store)?.((draft) => {
    Object.assign(draft, value as StoredObject);
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
  const [pendingApprovals, setPendingApprovals] = createSignal<
    Record<string, AgentApproval | undefined>
  >({});
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
  const [leftPanelAutoCompact, setLeftPanelAutoCompact] = createSignal(false);
  const [setupState, setSetupState] = createSignal<AppSetupState | null>(null);
  const [setupLoaded, setSetupLoaded] = createSignal(false);
  const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({
    status: "loading",
  });
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [servers, setServers] = createSignal<ServerSummary[]>([]);
  const [joinServerOpen, setJoinServerOpen] = createSignal(false);
  const [pendingInviteUrl, setPendingInviteUrl] = createSignal("");
  const [hostOpen, setHostOpen] = createSignal(false);
  const [hostStatus, setHostStatus] = createSignal<HostStatus>(FALLBACK_HOST_STATUS);
  const [teamMembers, setTeamMembers] = createSignal<TeamMemberSummary[]>([]);
  const [teamInvites, setTeamInvites] = createSignal<TeamInviteSummary[]>([]);
  const [teamSessions, setTeamSessions] = createSignal<TeamSessionSummary[]>([]);
  const [teamPresence, setTeamPresence] = createSignal<TeamPresenceSnapshot>(EMPTY_TEAM_PRESENCE);
  const [directThreads, setDirectThreads] = createSignal<DirectThreadSummary[]>([]);
  const [directConversations, setDirectConversations] = createSignal<
    Record<string, DirectConversationSnapshot>
  >({});
  const [activeDirectMemberId, setActiveDirectMemberId] = createSignal<string | null>(null);
  const [directConversationLoading, setDirectConversationLoading] = createSignal(false);
  const [directConversationError, setDirectConversationError] = createSignal<string | null>(null);
  const [directTypingMemberIds, setDirectTypingMemberIds] = createSignal<Set<string>>(new Set());
  const [remoteDesktopRequest, setRemoteDesktopRequest] = createSignal(0);
  const [remoteMacSessions, setRemoteMacSessions] = createSignal<RemoteMacSession[]>([]);
  const pendingConversationSnapshots = new Map<string, ConversationSnapshot>();
  const recentReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let conversationFrame: number | undefined;
  let directConversationRequest = 0;

  const leftPanelCompact = createMemo(() => leftPanelCollapsed() || leftPanelAutoCompact());

  function shouldAutoCompactSidebar(platform: AppInfo["platform"] | undefined, panelWidth: number) {
    const hasServerRail = platform === "darwin" || platform === "win32";
    const serverRailWidth = hasServerRail ? (window.innerWidth <= 800 ? 56 : 64) : 0;
    return window.innerWidth - serverRailWidth - panelWidth < CONVERSATION_MIN_WIDTH;
  }

  function updateResponsiveSidebar(): void {
    setLeftPanelAutoCompact(shouldAutoCompactSidebar(appInfo()?.platform, leftPanelWidth()));
  }

  createEffect(
    () => ({ platform: appInfo()?.platform, panelWidth: leftPanelWidth() }),
    ({ platform, panelWidth }) => {
      setLeftPanelAutoCompact(shouldAutoCompactSidebar(platform, panelWidth));
    },
  );

  onSettled(() => {
    window.addEventListener("resize", updateResponsiveSidebar);
    return () => window.removeEventListener("resize", updateResponsiveSidebar);
  });

  const currentTeamMember = createMemo(() => {
    const state = centralAuth();
    if (state.status !== "signed_in") return undefined;
    const email = state.user.email.trim().toLowerCase();
    return teamPresence().members.find(
      (member) =>
        member.email?.trim().toLowerCase() === email ||
        member.username.trim().toLowerCase() === email,
    );
  });
  const directPeople = createMemo(() => {
    const currentMemberId = currentTeamMember()?.id;
    if (!currentMemberId) return [];
    return teamPresence().members.filter(
      (member) => member.id !== currentMemberId && !member.disabled,
    );
  });
  const activeDirectMember = createMemo(() =>
    directPeople().find((member) => member.id === activeDirectMemberId()),
  );
  const activeBot = createMemo(() => {
    if (activeDirectMemberId()) return undefined;
    return botList().find((bot) => bot.id === activeBotId()) ?? botList()[0];
  });
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    return bot ? [...(liveMessages()[bot.id] ?? []), ...(uiErrors()[bot.id] ?? [])] : [];
  });

  createEffect(
    () => ({
      memberId: activeDirectMemberId(),
      memberExists: activeDirectMember() !== undefined,
    }),
    ({ memberId, memberExists }) => {
      if (memberId && !memberExists) {
        directConversationRequest += 1;
        setActiveDirectMemberId(null);
        setDirectConversationError(null);
        setDirectConversationLoading(false);
      }
    },
  );

  createEffect(
    () => currentTeamMember()?.id ?? null,
    (memberId) => {
      if (!memberId) {
        setDirectThreads([]);
        return;
      }
      void refreshDirectThreads();
    },
  );

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
    const unsubscribePresence = window.openbot.servers.onPresence((snapshot) =>
      flush(() => setTeamPresence(snapshot)),
    );
    const unsubscribeDirectMessage = window.openbot.servers.onDirectMessage((event) =>
      flush(() => handleDirectMessageEvent(event)),
    );
    const unsubscribeDirectTyping = window.openbot.servers.onDirectTyping((event) =>
      flush(() => handleDirectTypingEvent(event)),
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
      unsubscribePresence();
      unsubscribeDirectMessage();
      unsubscribeDirectTyping();
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
        .catch(() =>
          setAppInfo({
            name: "OpenBot",
            version: "unavailable",
            platform: "darwin",
          }),
        ),
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
    void window.openbot.servers
      .getPresence()
      .then(setTeamPresence)
      .catch(() => undefined);
    void refreshDirectThreads();
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
        setQueues((current) => ({
          ...current,
          [event.snapshot.botId]: event.snapshot,
        }));
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
        setActiveTurns((current) => ({
          ...current,
          [event.botId]: event.turnId,
        }));
        return;
      case "turn-completed":
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        setPendingPrompts((current) => ({ ...current, [event.botId]: undefined }));
        setPendingApprovals((current) => ({ ...current, [event.botId]: undefined }));
        if (event.status === "completed") markReplyCompleted(event.botId);
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        return;
      case "approval":
        setPendingApprovals((current) => ({
          ...current,
          [event.approval.botId]: event.approval,
        }));
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
    setConversationRevisions((current) => ({
      ...current,
      [event.botId]: event.revision,
    }));

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
    setConversationRevisions((current) => ({
      ...current,
      [botId]: snapshot.revision,
    }));
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
    setActiveTurns((current) => ({
      ...current,
      [botId]: snapshot.activeTurnId,
    }));
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
      setActiveDirectMemberId(null);
      setActiveBotId(newAgent.id);
      setOnboardingRequest({ botId: newAgent.id, nonce: Date.now() });
    } catch (error) {
      setAgentPickerOpen(false);
      if (activeBotId()) appendUiError(activeBotId(), error, "Create failed");
    } finally {
      setCreatingAgent(false);
    }
  }

  function openAgentPicker() {
    const directMemberId = activeDirectMemberId();
    if (directMemberId) {
      void window.openbot.servers
        .setDirectTyping({ memberId: directMemberId, typing: false })
        .catch(() => undefined);
    }
    setActiveDirectMemberId(null);
    setDirectConversationError(null);
    setAgentPickerOpen(true);
  }

  function selectBot(botId: string) {
    setAgentPickerOpen(false);
    const directMemberId = activeDirectMemberId();
    if (directMemberId) {
      void window.openbot.servers
        .setDirectTyping({ memberId: directMemberId, typing: false })
        .catch(() => undefined);
    }
    setActiveDirectMemberId(null);
    clearReplyIndicators(botId);
    setActiveBotId(botId);
  }

  async function refreshDirectThreads(): Promise<void> {
    if (!currentTeamMember()) {
      setDirectThreads([]);
      return;
    }
    try {
      setDirectThreads(await window.openbot.servers.listDirectThreads());
    } catch {
      setDirectThreads([]);
    }
  }

  async function selectDirectMember(memberId: string): Promise<void> {
    if (!currentTeamMember() || !directPeople().some((member) => member.id === memberId)) return;
    setAgentPickerOpen(false);
    setSettingsRequest(null);
    const previousMemberId = activeDirectMemberId();
    if (previousMemberId && previousMemberId !== memberId) {
      void window.openbot.servers
        .setDirectTyping({ memberId: previousMemberId, typing: false })
        .catch(() => undefined);
    }
    setActiveDirectMemberId(memberId);
    setDirectConversationLoading(true);
    setDirectConversationError(null);
    const request = ++directConversationRequest;
    try {
      const snapshot = await window.openbot.servers.readDirectConversation(memberId);
      if (request !== directConversationRequest) return;
      setDirectConversations((current) => ({
        ...current,
        [memberId]: snapshot,
      }));
      await window.openbot.servers.markDirectRead(memberId);
      if (request !== directConversationRequest) return;
      await refreshDirectThreads();
    } catch (error) {
      if (request !== directConversationRequest) return;
      setDirectConversationError(
        error instanceof Error ? error.message : "The messages could not load.",
      );
    } finally {
      if (request === directConversationRequest) setDirectConversationLoading(false);
    }
  }

  async function sendDirectMessage(text: string, clientMessageId: string): Promise<DirectMessage> {
    const memberId = activeDirectMemberId();
    if (!memberId) throw new Error("Select a person first.");
    const message = await window.openbot.servers.sendDirectMessage({
      memberId,
      text,
      clientMessageId,
    });
    mergeDirectMessage(memberId, message);
    await refreshDirectThreads();
    return message;
  }

  function setDirectTyping(typing: boolean): void {
    const memberId = activeDirectMemberId();
    if (!memberId) return;
    void window.openbot.servers.setDirectTyping({ memberId, typing }).catch(() => undefined);
  }

  function handleDirectMessageEvent(event: DirectMessageRealtimeEvent): void {
    const currentMemberId = currentTeamMember()?.id;
    if (!currentMemberId || !event.memberIds.includes(currentMemberId)) return;
    const otherMemberId =
      event.message.senderMemberId === currentMemberId
        ? event.message.recipientMemberId
        : event.message.senderMemberId;
    mergeDirectMessage(otherMemberId, event.message);
    void refreshDirectThreads();
    if (activeDirectMemberId() === otherMemberId) {
      void window.openbot.servers
        .markDirectRead(otherMemberId)
        .then(refreshDirectThreads)
        .catch(() => undefined);
    }
  }

  function handleDirectTypingEvent(event: DirectTypingRealtimeEvent): void {
    if (event.recipientMemberId !== currentTeamMember()?.id) return;
    setDirectTypingMemberIds((current) => {
      const next = new Set(current);
      if (event.typing) next.add(event.senderMemberId);
      else next.delete(event.senderMemberId);
      return next;
    });
  }

  function mergeDirectMessage(memberId: string, message: DirectMessage): void {
    setDirectConversations((current) => {
      const snapshot = current[memberId] ?? {
        threadId: message.threadId,
        otherMemberId: memberId,
        messages: [],
        revision: 0,
      };
      if (snapshot.messages.some((candidate) => candidate.id === message.id)) return current;
      return {
        ...current,
        [memberId]: {
          ...snapshot,
          messages: [...snapshot.messages, message].sort(
            (left, right) => left.sequence - right.sequence,
          ),
          revision: Math.max(snapshot.revision, message.sequence),
        },
      };
    });
  }

  function markReplyCompleted(botId: string) {
    if (activeDirectMemberId() || activeBotId() !== botId) {
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
      const stored = await window.openbot.agent.updateBot({
        botId,
        ...updates,
      });
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

  async function setAgentAvatar(botId: string, image: AvatarImageInput | null): Promise<void> {
    try {
      const stored = await window.openbot.agent.setAvatar({ botId, image });
      const next = toBotProfile(stored);
      setBotList((current) => {
        const existing = current.find((bot) => bot.id === botId);
        if (!existing) return [...current, createStored(next)];
        updateStored(existing, next);
        return current;
      });
    } catch (error) {
      appendUiError(botId, error, "Avatar update failed");
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
      await window.openbot.agent.respondToPrompt({
        requestId: prompt.requestId,
        answers,
      });
      setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Answer failed");
      return false;
    }
  }

  async function respondToApproval(decision: "accept" | "decline"): Promise<boolean> {
    const bot = activeBot();
    const approval = bot ? pendingApprovals()[bot.id] : undefined;
    if (!bot || !approval) return false;
    try {
      await window.openbot.agent.respondToApproval({
        requestId: approval.requestId,
        decision,
      });
      setPendingApprovals((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Approval failed");
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

  function steerQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.openbot.agent
      .steerQueuedMessage({ botId: bot.id, deliveryId, expectedTurnId: turnId })
      .catch((error) => appendUiError(bot.id, error, "Steer failed"));
  }

  async function updateQueuedMessage(
    deliveryId: string,
    text: string,
    keepAttachmentIds: string[],
    attachmentDraftIds: string[],
  ): Promise<boolean> {
    const bot = activeBot();
    if (!bot) return false;
    try {
      await window.openbot.agent.updateQueuedMessage({
        botId: bot.id,
        deliveryId,
        text,
        keepAttachmentIds,
        attachmentDraftIds,
      });
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Edit failed");
      return false;
    }
  }

  function reorderQueue(deliveryIds: string[]) {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .reorderQueue({ botId: bot.id, deliveryIds })
      .catch((error) => appendUiError(bot.id, error, "Reorder failed"));
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

  function expandSidebar(): void {
    setSidebarCollapsed(false);
    setLeftPanelAutoCompact(false);
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

  async function retryCentralAccount(): Promise<void> {
    setCentralAuth({ status: "loading" });
    setCentralAuth(await window.openbot.auth.retry());
  }

  async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
    setCentralAuth(await window.openbot.auth.verifyEmailCode(challengeId, code));
  }

  async function logoutCentralAccount(): Promise<void> {
    setCentralAuth(await window.openbot.auth.logout());
  }

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    setCentralAuth(await window.openbot.auth.updateAvatar(image));
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
    directConversationRequest += 1;
    const nextServers = await window.openbot.servers.select(serverId);
    setServers(nextServers);
    setAgentPickerOpen(false);
    setSettingsRequest(null);
    setBotList([]);
    setActiveBotId("");
    setActiveDirectMemberId(null);
    setDirectConversationError(null);
    setDirectThreads([]);
    setDirectConversations({});
    setDirectTypingMemberIds(new Set<string>());
    setLiveMessages({});
    setUiErrors({});
    setConversationLoaded({});
    setConversationRevisions({});
    setQueues({});
    setTeamPresence(EMPTY_TEAM_PRESENCE);
    const [storedBots, status, models, tabs, controlState, presence] = await Promise.all([
      window.openbot.agent.listBots(),
      window.openbot.agent.getStatus(),
      window.openbot.agent.listModels(),
      window.openbot.browser.listTabs(),
      window.openbot.browser.getControlState(),
      window.openbot.servers.getPresence(),
    ]);
    setAgentStatus(status);
    setModelOptions(models);
    setBrowserTabs(tabs);
    setActiveBrowserTabId(tabs[0]?.id ?? null);
    setBrowserControlState(controlState);
    setTeamPresence(presence);
    applyStoredBots(storedBots);
  }

  function setTeamTyping(botId: string, typing: boolean): void {
    void window.openbot.servers.setTyping({ botId: typing ? botId : null, typing }).catch(() => {
      // Typing state is optional and must not interrupt message composition.
    });
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

  async function configureAndPublishHost(input: { serverName: string }): Promise<void> {
    const configured = await window.openbot.host.configure(input);
    setHostStatus(configured);
    const published = await window.openbot.host.start();
    setHostStatus(published);
    await refreshHostManagement();
    if (published.phase !== "online") {
      throw new Error(published.message ?? "This OpenBot could not be published.");
    }
  }

  async function startHost(): Promise<void> {
    setHostStatus(await window.openbot.host.start());
  }

  async function configureRemoteDesktop(password: string): Promise<void> {
    setHostStatus(await window.openbot.host.configureRemoteDesktop({ password }));
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

  async function removeHostMember(memberId: string): Promise<void> {
    await window.openbot.host.removeMember(memberId);
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
    const session = await window.openbot.remoteMac.connect({
      hostname,
      serverId,
    });
    setRemoteMacSessions((current) => [
      ...current.filter((item) => item.id !== session.id),
      session,
    ]);
  }

  async function disconnectRemoteMac(sessionId: string): Promise<void> {
    await window.openbot.remoteMac.disconnect(sessionId);
  }

  const activeServer = createMemo(() => servers().find((server) => server.active));
  const activeRemoteMacSession = createMemo(() => {
    const server = activeServer();
    if (!server) return undefined;
    return [...remoteMacSessions()]
      .filter((session) => session.serverId === server.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  });
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
            onRetry={retryCentralAccount}
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
                  "app-frame-sidebar-compact": leftPanelCompact(),
                  "app-frame-with-server-rail":
                    appInfo()?.platform === "darwin" || appInfo()?.platform === "win32",
                },
              ]}
              style={`--left-panel-width: ${leftPanelCompact() ? LEFT_PANEL_COMPACT : leftPanelWidth()}px`}
            >
              <Show when={appInfo()?.platform === "darwin" || appInfo()?.platform === "win32"}>
                <ServerRail
                  platform={appInfo()?.platform ?? "darwin"}
                  servers={servers()}
                  hostStatus={hostStatus()}
                  onSelect={(serverId) => void selectServer(serverId)}
                  onAdd={() => setJoinServerOpen(true)}
                  onOpenHost={openHostPanel}
                  onOpenRemoteMac={() => setRemoteDesktopRequest((current) => current + 1)}
                />
              </Show>
              <Sidebar
                bots={botList()}
                activeBotId={activeDirectMemberId() ? "" : (activeBot()?.id ?? "")}
                people={directPeople()}
                directThreads={directThreads()}
                activeDirectMemberId={activeDirectMemberId()}
                account={account()}
                appInfo={appInfo()}
                agentStatus={agentStatus()}
                accountUsage={accountUsage()}
                updateStatus={updateStatus()}
                agentStates={sidebarAgentStates()}
                onSelectBot={selectBot}
                onSelectPerson={(memberId) => void selectDirectMember(memberId)}
                onCreateBot={openAgentPicker}
                onEditBot={editBot}
                onDeleteBot={deleteBot}
                onRefreshUsage={refreshAccountUsage}
                onUpdateAction={runUpdateAction}
                onUpdateAccountAvatar={updateAccountAvatar}
                onLogout={logoutCentralAccount}
                onOpenExternal={(destination) => window.openbot.openExternal(destination)}
                onOpenPermissions={() => setPermissionsOpen(true)}
                compact={leftPanelCompact()}
                onCollapse={() => setSidebarCollapsed(true)}
                onExpand={expandSidebar}
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
                snap={{
                  compactValue: LEFT_PANEL_COMPACT,
                  compact: leftPanelCompact(),
                  collapseThreshold: LEFT_PANEL_COLLAPSE_THRESHOLD,
                  expandThreshold: LEFT_PANEL_EXPAND_THRESHOLD,
                  onCompactChange: (compact) => {
                    if (compact) setSidebarCollapsed(true);
                    else expandSidebar();
                  },
                }}
              />
              <Show when={activeDirectMember()} keyed>
                {(member) => (
                  <DirectConversation
                    member={member}
                    currentMemberId={currentTeamMember()?.id ?? ""}
                    snapshot={directConversations()[member.id]}
                    loading={directConversationLoading()}
                    loadError={directConversationError()}
                    typing={directTypingMemberIds().has(member.id)}
                    onSend={sendDirectMessage}
                    onTypingChange={setDirectTyping}
                  />
                )}
              </Show>
              <Show when={!activeDirectMember()}>
                <Conversation
                  agentStatus={agentStatus()}
                  bot={activeBot()}
                  bots={botList()}
                  modelOptions={modelOptions()}
                  messages={activeMessages()}
                  loaded={
                    activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false
                  }
                  queue={activeQueue()}
                  browserTabs={browserTabs()}
                  activeBrowserTabId={activeBrowserTabId()}
                  browserControlState={browserControlState()}
                  server={activeServer()}
                  presence={teamPresence()}
                  currentUserEmail={account().email}
                  remoteMacSession={activeRemoteMacSession()}
                  remoteDesktopRequest={remoteDesktopRequest()}
                  prompt={activeBot() ? pendingPrompts()[activeBot()?.id ?? ""] : undefined}
                  approval={activeBot() ? pendingApprovals()[activeBot()?.id ?? ""] : undefined}
                  activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
                  agentPickerOpen={agentPickerOpen()}
                  creatingAgent={creatingAgent()}
                  settingsRequest={settingsRequest()}
                  onboardingRequest={onboardingRequest()}
                  onCloseAgentPicker={() => setAgentPickerOpen(false)}
                  onCreateAgent={() => void createAgent()}
                  onSelectAgent={selectBot}
                  onUpdateBot={updateBot}
                  onSetAgentAvatar={setAgentAvatar}
                  onSendMessage={sendMessage}
                  onTypingChange={setTeamTyping}
                  onCompleteOnboarding={completeOnboarding}
                  onAnswerPrompt={answerPrompt}
                  onRespondToApproval={respondToApproval}
                  onCancelQueuedMessage={cancelQueuedMessage}
                  onSteerQueuedMessage={steerQueuedMessage}
                  onUpdateQueuedMessage={updateQueuedMessage}
                  onReorderQueue={reorderQueue}
                  onResumeQueue={resumeQueue}
                  onActivateBrowserTab={activateBrowserTab}
                  onCloseBrowserTab={closeBrowserTab}
                  onConnectRemoteMac={connectRemoteMac}
                  onDisconnectRemoteMac={disconnectRemoteMac}
                  onOpenAgentSetup={() => window.openbot.openExternal("agent-setup")}
                  onStop={stopActiveTurn}
                />
              </Show>
              <Show when={permissionsOpen()}>
                <InitialSetup
                  reviewing
                  state={
                    setupState() ?? {
                      completed: true,
                      preferredProvider: "codex",
                    }
                  }
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
                  platform={appInfo()?.platform ?? "darwin"}
                  status={hostStatus()}
                  members={teamMembers()}
                  invites={teamInvites()}
                  sessions={teamSessions()}
                  presence={teamPresence()}
                  accountEmail={account().email}
                  onClose={() => setHostOpen(false)}
                  onConfigure={configureAndPublishHost}
                  onConfigureRemoteDesktop={configureRemoteDesktop}
                  onStart={startHost}
                  onStop={stopHost}
                  onCreateInvite={createHostInvite}
                  onUpdateMember={updateHostMember}
                  onRemoveMember={removeHostMember}
                  onRevokeSession={revokeHostSession}
                  onRevokeInvite={revokeHostInvite}
                  onCopyAddressUpdate={copyHostAddressUpdate}
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
    avatarUrl: stored.avatarUrl,
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
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function withoutBot<T>(values: Record<string, T>, botId: string): Record<string, T> {
  const next = { ...values };
  delete next[botId];
  return next;
}
