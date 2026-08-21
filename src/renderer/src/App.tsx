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
  ConversationReadState,
  ConversationSnapshot,
  DirectConversationSnapshot,
  DirectMessage,
  DirectMessageRealtimeEvent,
  DirectThreadSummary,
  DirectTypingRealtimeEvent,
  HostStatus,
  InviteSummary,
  QueueSnapshot,
  RemoteDesktopSession,
  ServerSummary,
  TeamInviteSummary,
  TeamPresenceMember,
  TeamPresenceSnapshot,
  UpdateBotInput,
  UpdateStatus,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, createStore, flush, onSettled, Show } from "solid-js";
import { playCompletionSoundForAgentEvent } from "./completion-sound";
import { AccountDock } from "./components/AccountDock";
import { AccountLogin } from "./components/AccountLogin";
import { Conversation } from "./components/Conversation";
import { DirectConversation } from "./components/DirectConversation";
import { GlobalSearch } from "./components/GlobalSearch";
import { InitialSetup } from "./components/InitialSetup";
import { JoinServerDialog } from "./components/JoinServerDialog";
import { PanelResizer, readPanelWidth, savePanelWidth } from "./components/PanelResizer";
import { RemoteDesktopWorkspace } from "./components/RemoteDesktopWorkspace";
import { ServerRail } from "./components/ServerRail";
import { ServerSettingsModal } from "./components/ServerSettingsModal";
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
  logoUrl: null,
  apiUrl: null,
  apiOnline: false,
  remoteDesktopReady: false,
  remoteDesktopUnattended: false,
  remoteDesktopActiveSessions: 0,
  remoteDesktopMaxSessions: 4,
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
const AUTH_SUCCESS_HOLD_MS = 600;
const LEFT_PANEL_MAX = 400;
const LEFT_PANEL_COMPACT = 88;
const LEFT_PANEL_COLLAPSE_THRESHOLD = 210;
const LEFT_PANEL_EXPAND_THRESHOLD = 220;
const CONVERSATION_MIN_WIDTH = 424;
const MAC_SERVER_RAIL_WIDTH = 72;
const SERVER_RAIL_WIDTH = 64;
const NARROW_SERVER_RAIL_WIDTH = 56;

type StoredValue = BotProfile | BotMessage;
type StoredSetter = (value: StoredValue) => void;

const storeSetters = new WeakMap<object, StoredSetter>();

function isBotProfile(value: StoredValue): value is BotProfile {
  return "avatarSeed" in value;
}

function createStoredProfile(value: BotProfile): BotProfile {
  const initial = Object.assign({}, value);
  const [store, setStore] = createStore(initial);
  storeSetters.set(store, (next) => {
    if (isBotProfile(next)) setStore(() => next);
  });
  return store;
}

function createStoredMessage(value: BotMessage): BotMessage {
  const initial = Object.assign({}, value);
  const [store, setStore] = createStore(initial);
  storeSetters.set(store, (next) => {
    if (!isBotProfile(next)) setStore(() => next);
  });
  return store;
}

function updateStored(store: StoredValue, value: StoredValue): void {
  storeSetters.get(store)?.(value);
}

const ONBOARDING_PROFILES: Record<string, { role: string; description: string; firstMessage: string }> = {
  "Work & projects": {
    role: "Work & projects",
    description:
      "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
    firstMessage: "Focus on my work and projects. Help me plan, organize, and execute them proactively.",
  },
  "Research & writing": {
    role: "Research & writing",
    description: "Researches topics, synthesizes reliable sources, and helps draft, edit, and refine clear writing.",
    firstMessage:
      "Focus on research and writing. Help me investigate topics and turn the findings into clear, useful writing.",
  },
  "Sales & outreach": {
    role: "Sales & outreach",
    description: "Supports prospect research, sales preparation, personalized outreach, and organized follow-up work.",
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
  const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>({});
  const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>({});
  const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
  const [conversationReads, setConversationReads] = createSignal<Record<string, ConversationReadState>>({});
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
  const [pendingPrompts, setPendingPrompts] = createSignal<Record<string, PromptEvent | undefined>>({});
  const [pendingApprovals, setPendingApprovals] = createSignal<Record<string, AgentApproval | undefined>>({});
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
  const [authSuccessVisible, setAuthSuccessVisible] = createSignal(false);
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [servers, setServers] = createSignal<ServerSummary[]>([]);
  const [joinServerOpen, setJoinServerOpen] = createSignal(false);
  const [pendingInviteUrl, setPendingInviteUrl] = createSignal("");
  const [serverSettingsTargetId, setServerSettingsTargetId] = createSignal<string | null>(null);
  const [serverSettingsOpen, setServerSettingsOpen] = createSignal(false);
  const [globalSearchOpen, setGlobalSearchOpen] = createSignal(false);
  const [messageFocusRequest, setMessageFocusRequest] = createSignal<{
    botId: string;
    messageId: string;
    nonce: number;
  } | null>(null);
  const [hostStatus, setHostStatus] = createSignal<HostStatus>(FALLBACK_HOST_STATUS);
  const [serverSettingsMembers, setServerSettingsMembers] = createSignal<TeamPresenceMember[]>([]);
  const [serverSettingsInvites, setServerSettingsInvites] = createSignal<TeamInviteSummary[]>([]);
  const [serverSettingsLoading, setServerSettingsLoading] = createSignal(false);
  const [serverSettingsError, setServerSettingsError] = createSignal<string | null>(null);
  const [teamPresence, setTeamPresence] = createSignal<TeamPresenceSnapshot>(EMPTY_TEAM_PRESENCE);
  const [directThreads, setDirectThreads] = createSignal<DirectThreadSummary[]>([]);
  const [directConversations, setDirectConversations] = createSignal<Record<string, DirectConversationSnapshot>>({});
  const [activeDirectMemberId, setActiveDirectMemberId] = createSignal<string | null>(null);
  const [directConversationLoading, setDirectConversationLoading] = createSignal(false);
  const [directConversationError, setDirectConversationError] = createSignal<string | null>(null);
  const [directTypingMemberIds, setDirectTypingMemberIds] = createSignal<Set<string>>(new Set());
  const [remoteDesktopSessions, setRemoteDesktopSessions] = createSignal<RemoteDesktopSession[]>([]);
  const [remoteDesktopWorkspaceServerId, setRemoteDesktopWorkspaceServerId] = createSignal<string | null>(null);
  const [remoteDesktopWorkspaceVisible, setRemoteDesktopWorkspaceVisible] = createSignal(false);
  const [remoteDesktopConnectingServerId, setRemoteDesktopConnectingServerId] = createSignal<string | null>(null);
  const [remoteDesktopConnectionError, setRemoteDesktopConnectionError] = createSignal<string | null>(null);
  const [remoteDesktopSessionEstablished, setRemoteDesktopSessionEstablished] = createSignal(false);
  const pendingConversationSnapshots = new Map<
    string,
    { snapshot: ConversationSnapshot; markNewMessagesRead: boolean }
  >();
  const agentChatsToMarkRead = new Set<string>();
  const autoReadAgentMessageIds = new Map<string, string>();
  const recentReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let conversationFrame: number | undefined;
  let directConversationRequest = 0;
  let serverSettingsRequest = 0;
  let serverSettingsRestoreTarget: HTMLElement | null = null;
  let appFrameElement: HTMLDivElement | undefined;
  let remoteDesktopRestoreTarget: HTMLElement | null = null;
  let remoteDesktopConnectPromise: Promise<RemoteDesktopSession | undefined> | null = null;
  let remoteDesktopConnectionRequest = 0;
  let authSuccessTimer: ReturnType<typeof setTimeout> | undefined;

  function applyCentralAuthState(state: CentralAuthState): void {
    const completedCodeChallenge = centralAuth().status === "code_sent" && state.status === "signed_in";
    if (state.status !== "signed_in") {
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
      authSuccessTimer = undefined;
      setAuthSuccessVisible(false);
    } else if (completedCodeChallenge) {
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
      setAuthSuccessVisible(true);
      authSuccessTimer = setTimeout(() => {
        authSuccessTimer = undefined;
        setAuthSuccessVisible(false);
      }, AUTH_SUCCESS_HOLD_MS);
    }
    setCentralAuth(state);
  }

  const leftPanelCompact = createMemo(() => leftPanelCollapsed() || leftPanelAutoCompact());

  function shouldAutoCompactSidebar(platform: AppInfo["platform"] | undefined, panelWidth: number) {
    const serverRailWidth =
      platform === "darwin"
        ? MAC_SERVER_RAIL_WIDTH
        : platform === "win32"
          ? window.innerWidth <= 800
            ? NARROW_SERVER_RAIL_WIDTH
            : SERVER_RAIL_WIDTH
          : 0;
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
      (member) => member.email?.trim().toLowerCase() === email || member.username.trim().toLowerCase() === email,
    );
  });
  const directPeople = createMemo(() => {
    const currentMemberId = currentTeamMember()?.id;
    if (!currentMemberId) return [];
    return teamPresence().members.filter((member) => member.id !== currentMemberId && !member.disabled);
  });
  const activeDirectMember = createMemo(() => directPeople().find((member) => member.id === activeDirectMemberId()));
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
      flush(() => applyCentralAuthState(state));
    });
    const unsubscribeServers = window.openbot.servers.onEvent((value) => flush(() => setServers(value)));
    const unsubscribePresence = window.openbot.servers.onPresence((snapshot) => flush(() => setTeamPresence(snapshot)));
    const unsubscribeDirectMessage = window.openbot.servers.onDirectMessage((event) =>
      flush(() => handleDirectMessageEvent(event)),
    );
    const unsubscribeDirectTyping = window.openbot.servers.onDirectTyping((event) =>
      flush(() => handleDirectTypingEvent(event)),
    );
    const receiveInvite = (inviteUrl: string) => {
      flush(() => {
        setPendingInviteUrl(inviteUrl);
        if (setupState()?.completed === true && centralAuth().status === "signed_in") setJoinServerOpen(true);
      });
    };
    const unsubscribeInvite = window.openbot.servers.onInvite((inviteUrl) => {
      receiveInvite(inviteUrl);
    });
    const unsubscribeHost = window.openbot.host.onEvent((status) => flush(() => setHostStatus(status)));
    const unsubscribeRemoteDesktop = window.openbot.remoteDesktop.onEvent((sessions) =>
      flush(() => setRemoteDesktopSessions(sessions)),
    );
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() !== "k" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        centralAuth().status !== "signed_in" ||
        setupState()?.completed !== true
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setGlobalSearchVisibility(!globalSearchOpen());
    };
    window.addEventListener("keydown", handleGlobalSearchShortcut);
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
      unsubscribeRemoteDesktop();
      window.removeEventListener("keydown", handleGlobalSearchShortcut);
      if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame);
      for (const timer of recentReplyTimers.values()) clearTimeout(timer);
      recentReplyTimers.clear();
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
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
          issue: {
            code: "auth_unavailable",
            message: "OpenBot could not load the account service.",
          },
        }),
      );
    void window.openbot
      .getSetupState()
      .then(setSetupState)
      .finally(() => setSetupLoaded(true));
    void window.openbot.servers
      .takePendingInvite()
      .then((inviteUrl) => inviteUrl && receiveInvite(inviteUrl))
      .catch(() => undefined);

    void Promise.all([
      window.openbot
        .getAppInfo()
        .then(setAppInfo)
        .catch(() =>
          setAppInfo({
            name: "OpenBot",
            version: "unavailable",
            platform: "darwin",
            variant: "production",
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
      window.openbot.agent
        .listConversationReads()
        .then(applyConversationReads)
        .catch(() => undefined),
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
    void window.openbot.remoteDesktop
      .list()
      .then(setRemoteDesktopSessions)
      .catch(() => undefined);
    return cleanup;
  });

  createEffect(
    () => ({
      inviteUrl: pendingInviteUrl(),
      setupCompleted: setupState()?.completed === true,
      signedIn: centralAuth().status === "signed_in",
    }),
    ({ inviteUrl, setupCompleted, signedIn }) => {
      if (inviteUrl && setupCompleted && signedIn) {
        setJoinServerOpen(true);
      }
    },
  );

  createEffect(
    () => ({ botId: activeBotId(), agentPhase: agentStatus().phase }),
    ({ botId }) => {
      if (!botId) return;
      const markReadOnOpen = agentChatsToMarkRead.delete(botId);
      void Promise.all([window.openbot.agent.readConversation(botId), window.openbot.agent.listQueue(botId)])
        .then(([snapshot, queue]) => {
          setQueues((current) => ({ ...current, [botId]: queue }));
          if (snapshot.readState) applyConversationReadState(botId, snapshot.readState);
          scheduleConversation(snapshot);
          if (markReadOnOpen && (snapshot.readState?.unreadCount ?? 0) > 0) {
            void markAgentMessagesRead(botId, snapshot.messages.at(-1)?.id ?? null).catch((error) =>
              appendUiError(botId, error, "Read state failed"),
            );
          }
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
        scheduleConversation(event.snapshot, isAgentChatOpen(event.snapshot.botId));
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
        if (event.status === "completed") {
          markReplyCompleted(event.botId);
          playCompletionSoundForAgentEvent(event, botList());
        }
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
      if (!existing) return createStoredProfile(next);
      if (!botProfilesEqual(existing, next)) updateStored(existing, next);
      return existing;
    });
    setBotList(profiles);
    setActiveBotId((current) => (profiles.some((bot) => bot.id === current) ? current : (profiles[0]?.id ?? "")));
    if (profiles.length === 0) setAgentPickerOpen(true);
  }

  function applyConversationReads(reads: Record<string, ConversationReadState>): void {
    setConversationReads(reads);
    setUnreadReplies(Object.fromEntries(Object.entries(reads).map(([botId, state]) => [botId, state.unreadCount])));
  }

  function applyConversationReadState(botId: string, state: ConversationReadState): void {
    setConversationReads((current) => ({ ...current, [botId]: state }));
    setUnreadReplies((current) => ({ ...current, [botId]: state.unreadCount }));
  }

  function scheduleConversation(snapshot: ConversationSnapshot, markNewMessagesRead = false) {
    const botId = snapshot.botId;
    const appliedRevision = conversationRevisions()[botId] ?? -1;
    const pending = pendingConversationSnapshots.get(botId);
    const pendingRevision = pending?.snapshot.revision ?? -1;
    if (snapshot.revision < Math.max(appliedRevision, pendingRevision)) return;
    pendingConversationSnapshots.set(botId, {
      snapshot,
      markNewMessagesRead: markNewMessagesRead || (pending?.markNewMessagesRead ?? false),
    });
    if (conversationFrame !== undefined) return;
    conversationFrame = requestAnimationFrame(() => {
      conversationFrame = undefined;
      const snapshots = [...pendingConversationSnapshots.values()];
      pendingConversationSnapshots.clear();
      for (const pendingSnapshot of snapshots) {
        applyConversation(pendingSnapshot.snapshot, pendingSnapshot.markNewMessagesRead);
      }
    });
  }

  function isAgentChatOpen(botId: string): boolean {
    return !agentPickerOpen() && !activeDirectMemberId() && activeBot()?.id === botId;
  }

  function autoMarkAgentMessageRead(botId: string, messageId: string): void {
    if (autoReadAgentMessageIds.get(botId) === messageId) return;
    const current = conversationReads()[botId];
    if (current && current.unreadCount > 0) return;
    autoReadAgentMessageIds.set(botId, messageId);
    if (current) {
      applyConversationReadState(botId, {
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughMessageId: messageId,
      });
    }
    void markAgentMessagesRead(botId, messageId).catch((error) => appendUiError(botId, error, "Read state failed"));
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
      const message = createStoredMessage({
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
      const readState = conversationReads()[event.botId];
      if (isAgentChatOpen(event.botId)) {
        autoMarkAgentMessageRead(event.botId, event.messageId);
      } else if (readState) {
        applyConversationReadState(event.botId, {
          ...readState,
          unreadCount: readState.unreadCount + 1,
          firstUnreadMessageId: readState.firstUnreadMessageId ?? event.messageId,
        });
      }
    }
    setConversationLoaded((current) => ({ ...current, [event.botId]: true }));
  }

  function applyConversation(snapshot: ConversationSnapshot, markNewMessagesRead = false) {
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
        if (!existing) return createStoredMessage({ ...mapped, animate: !initialLoad });
        if (!botMessagesEqual(existing, mapped)) updateStored(existing, mapped);
        return existing;
      });
      if (previous.length === next.length && previous.every((message, index) => message === next[index])) {
        return current;
      }
      return { ...current, [botId]: next };
    });
    setConversationLoaded((current) => ({ ...current, [botId]: true }));
    setActiveTurns((current) => ({
      ...current,
      [botId]: snapshot.activeTurnId,
    }));
    const readState = conversationReads()[botId];
    const latestIncomingMessage = markNewMessagesRead
      ? [...snapshot.messages]
          .reverse()
          .find((message) => message.author !== "user" && message.itemType !== "commentary")
      : undefined;
    if (latestIncomingMessage) {
      autoMarkAgentMessageRead(botId, latestIncomingMessage.id);
    } else if (readState) {
      applyConversationReadState(botId, readStateForMessages(readState, snapshot.messages));
    }
  }

  async function createAgent() {
    if (creatingAgent()) return;
    setCreatingAgent(true);
    try {
      const stored = await window.openbot.agent.createBot();
      const newAgent = createStoredProfile(toBotProfile(stored));
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
      void window.openbot.servers.setDirectTyping({ memberId: directMemberId, typing: false }).catch(() => undefined);
    }
    setActiveDirectMemberId(null);
    setDirectConversationError(null);
    setAgentPickerOpen(true);
  }

  function selectBot(botId: string) {
    setAgentPickerOpen(false);
    const directMemberId = activeDirectMemberId();
    if (directMemberId) {
      void window.openbot.servers.setDirectTyping({ memberId: directMemberId, typing: false }).catch(() => undefined);
    }
    setActiveDirectMemberId(null);
    clearReplyIndicators(botId);
    agentChatsToMarkRead.add(botId);
    setActiveBotId(botId);
  }

  function setGlobalSearchVisibility(open: boolean): void {
    setGlobalSearchOpen(open);
    if (open) void loadGlobalSearchConversations();
  }

  async function loadGlobalSearchConversations(): Promise<void> {
    const missingBots = botList().filter((bot) => conversationLoaded()[bot.id] !== true);
    const snapshots = await Promise.allSettled(missingBots.map((bot) => window.openbot.agent.readConversation(bot.id)));
    for (const result of snapshots) {
      if (result.status === "fulfilled") scheduleConversation(result.value);
    }
  }

  function selectGlobalSearchMessage(botId: string, messageId: string): void {
    selectBot(botId);
    setMessageFocusRequest({ botId, messageId, nonce: Date.now() });
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
      void window.openbot.servers.setDirectTyping({ memberId: previousMemberId, typing: false }).catch(() => undefined);
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
    } catch (error) {
      if (request !== directConversationRequest) return;
      setDirectConversationError(error instanceof Error ? error.message : "The messages could not load.");
    } finally {
      if (request === directConversationRequest) setDirectConversationLoading(false);
    }
  }

  async function sendDirectMessage(
    text: string,
    clientMessageId: string,
  ): Promise<{ message: DirectMessage; readError?: string }> {
    const memberId = activeDirectMemberId();
    if (!memberId) throw new Error("Select a person first.");
    const message = await window.openbot.servers.sendDirectMessage({
      memberId,
      text,
      clientMessageId,
    });
    mergeDirectMessage(memberId, message);
    let readError: string | undefined;
    try {
      await markDirectMessagesRead(memberId, message.sequence);
    } catch (error) {
      readError = error instanceof Error ? error.message : "Could not mark messages as read.";
    }
    await refreshDirectThreads();
    return { message, ...(readError ? { readError } : {}) };
  }

  async function markDirectMessagesRead(memberId = activeDirectMemberId(), throughSequence?: number): Promise<void> {
    if (!memberId) return;
    const snapshot = directConversations()[memberId];
    const boundary = throughSequence ?? snapshot?.messages.at(-1)?.sequence ?? 0;
    const readState = await window.openbot.servers.markDirectRead({
      memberId,
      throughSequence: boundary,
    });
    setDirectConversations((current) => {
      const currentSnapshot = current[memberId];
      return currentSnapshot ? { ...current, [memberId]: { ...currentSnapshot, readState } } : current;
    });
    await refreshDirectThreads();
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
      event.message.senderMemberId === currentMemberId ? event.message.recipientMemberId : event.message.senderMemberId;
    const markVisibleMessageRead =
      event.message.senderMemberId !== currentMemberId &&
      activeDirectMemberId() === otherMemberId &&
      (directConversations()[otherMemberId]?.readState?.unreadCount ?? 0) === 0;
    mergeDirectMessage(otherMemberId, event.message);
    if (markVisibleMessageRead) {
      void markDirectMessagesRead(otherMemberId, event.message.sequence).catch(() => undefined);
    } else {
      void refreshDirectThreads();
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
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughSequence: 0 },
      };
      if (snapshot.messages.some((candidate) => candidate.id === message.id)) return current;
      const readState = snapshot.readState ?? {
        unreadCount: 0,
        firstUnreadMessageId: null,
        throughSequence: 0,
      };
      const incomingUnread =
        message.senderMemberId !== currentTeamMember()?.id && message.sequence > readState.throughSequence;
      const visibleIncomingMessage = incomingUnread && activeDirectMemberId() === memberId;
      let nextReadState = readState;
      if (visibleIncomingMessage && readState.unreadCount === 0) {
        nextReadState = {
          unreadCount: 0,
          firstUnreadMessageId: null,
          throughSequence: message.sequence,
        };
      } else if (incomingUnread && !visibleIncomingMessage) {
        nextReadState = {
          ...readState,
          unreadCount: readState.unreadCount + 1,
          firstUnreadMessageId: readState.firstUnreadMessageId ?? message.id,
        };
      }
      return {
        ...current,
        [memberId]: {
          ...snapshot,
          messages: [...snapshot.messages, message].sort((left, right) => left.sequence - right.sequence),
          revision: Math.max(snapshot.revision, message.sequence),
          readState: nextReadState,
        },
      };
    });
  }

  function markReplyCompleted(botId: string) {
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
  }

  function activateBrowserTab(tabId: string) {
    void window.openbot.browser.activate(tabId);
  }

  async function closeBrowserTab(tabId: string) {
    await window.openbot.browser.close(tabId);
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
        if (existingIndex === -1) return [...current, createStoredProfile(next)];
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
        if (!existing) return [...current, createStoredProfile(next)];
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
      setConversationReads((current) => withoutBot(current, botId));
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
      const receipt = await window.openbot.agent.sendMessage({
        botId,
        text: body.trim(),
        attachmentDraftIds,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      setUiErrors((current) => ({ ...current, [botId]: [] }));
      try {
        await markAgentMessagesRead(botId, receipt.deliveries[0]?.id ?? receipt.messageId);
      } catch (error) {
        appendUiError(botId, error, "Read state failed");
      }
      return true;
    } catch (error) {
      appendUiError(botId, error, "Send failed");
      return false;
    }
  }

  async function markAgentMessagesRead(botId = activeBot()?.id, throughMessageId?: string | null): Promise<void> {
    if (!botId) return;
    const boundary =
      throughMessageId ??
      liveMessages()
        [botId]?.filter((message) => !message.id.startsWith("thinking:") && !message.id.startsWith("ui-"))
        .at(-1)?.id ??
      null;
    const state = await window.openbot.agent.markConversationRead({
      botId,
      throughMessageId: boundary,
    });
    applyConversationReadState(botId, state);
    clearRecentReply(botId);
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
    applyCentralAuthState(await window.openbot.auth.requestEmailCode(email));
  }

  async function retryCentralAccount(): Promise<void> {
    applyCentralAuthState({ status: "loading" });
    applyCentralAuthState(await window.openbot.auth.retry());
  }

  async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
    applyCentralAuthState(await window.openbot.auth.verifyEmailCode(challengeId, code));
  }

  async function logoutCentralAccount(): Promise<void> {
    applyCentralAuthState(await window.openbot.auth.logout());
  }

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    applyCentralAuthState(await window.openbot.auth.updateAvatar(image));
  }

  async function runUpdateAction(): Promise<void> {
    const phase = updateStatus().phase;
    if (phase === "ready") {
      await window.openbot.update.install();
      return;
    }
    const status = phase === "available" ? await window.openbot.update.download() : await window.openbot.update.check();
    setUpdateStatus(status);
  }

  async function selectServer(serverId: string): Promise<void> {
    const previousServerId = servers().find((server) => server.active)?.id;
    if (previousServerId && previousServerId !== serverId) {
      await disconnectRemoteDesktopWorkspace(false);
    }
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
    setConversationReads({});
    setUnreadReplies({});
    setQueues({});
    setTeamPresence(EMPTY_TEAM_PRESENCE);
    const [storedBots, reads, status, models, tabs, controlState, presence] = await Promise.all([
      window.openbot.agent.listBots(),
      window.openbot.agent.listConversationReads(),
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
    applyConversationReads(reads);
  }

  async function reorderServers(serverIds: string[]): Promise<void> {
    const previous = servers();
    const serversById = new Map(previous.map((server) => [server.id, server]));
    setServers([
      ...previous.filter((server) => server.kind === "local"),
      ...serverIds.flatMap((serverId) => {
        const server = serversById.get(serverId);
        return server?.kind === "remote" ? [server] : [];
      }),
    ]);
    try {
      setServers(await window.openbot.servers.reorder({ serverIds }));
    } catch (error) {
      setServers(previous);
      throw error;
    }
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
      window.openbot ? ((await window.openbot.servers.list()).find((item) => item.active)?.id ?? "local") : "local",
    );
  }

  async function previewInvite(input: { inviteUrl: string }) {
    return window.openbot.servers.previewInvite(input);
  }

  async function joinRemoteDuringSetup(input: { inviteUrl: string }, provider: AgentProviderId): Promise<void> {
    await joinServer(input);
    await saveSetup(provider);
  }

  async function refreshServerSettings(serverId = serverSettingsTargetId()): Promise<void> {
    if (!serverId) return;
    const request = ++serverSettingsRequest;
    setServerSettingsLoading(true);
    setServerSettingsError(null);
    try {
      let server = servers().find((item) => item.id === serverId);
      if (!server) throw new Error("This server is not available.");
      let identityError: string | null = null;
      if (server.kind === "remote") {
        try {
          const refreshed = await window.openbot.servers.refreshIdentity(serverId);
          setServers((current) => current.map((item) => (item.id === serverId ? refreshed : item)));
          server = refreshed;
        } catch (error) {
          identityError = error instanceof Error ? error.message : "The server identity could not refresh.";
        }
      }
      const canManage =
        server.kind === "local" ? hostStatus().configured : server.role === "admin" || server.role === "owner";
      const canUseNetwork = server.kind === "local" || server.state === "online";
      const [presence, members, invites] = await Promise.all([
        server.kind === "local" ? window.openbot.host.getPresence() : window.openbot.servers.getPresenceFor(serverId),
        canManage && canUseNetwork
          ? server.kind === "local"
            ? window.openbot.host.listMembers()
            : window.openbot.servers.listMembers(serverId)
          : Promise.resolve(null),
        canManage && canUseNetwork
          ? server.kind === "local"
            ? window.openbot.host.listInvites()
            : window.openbot.servers.listInvites(serverId)
          : Promise.resolve([]),
      ]);
      if (request !== serverSettingsRequest || serverSettingsTargetId() !== serverId) return;
      const presenceById = new Map(presence.members.map((member) => [member.id, member]));
      setServerSettingsMembers(
        (members ?? presence.members).map((member) => ({
          ...member,
          online: presenceById.get(member.id)?.online ?? false,
          typingBotId: presenceById.get(member.id)?.typingBotId ?? null,
        })),
      );
      setServerSettingsInvites(invites);
      if (identityError) setServerSettingsError(identityError);
    } catch (error) {
      if (request === serverSettingsRequest && serverSettingsTargetId() === serverId) {
        setServerSettingsError(error instanceof Error ? error.message : "The server settings could not load.");
      }
    } finally {
      if (request === serverSettingsRequest) setServerSettingsLoading(false);
    }
  }

  function openServerSettings(serverId: string, trigger: HTMLElement | null): void {
    serverSettingsRequest += 1;
    serverSettingsRestoreTarget = trigger;
    setServerSettingsTargetId(serverId);
    setServerSettingsOpen(true);
    setServerSettingsMembers([]);
    setServerSettingsInvites([]);
    setServerSettingsError(null);
    void refreshServerSettings(serverId);
  }

  async function saveServerIdentity(input: { serverName: string; logo?: AvatarImageInput | null }): Promise<void> {
    const server = serverSettingsTarget();
    if (server?.kind !== "local") throw new Error("Only the local server identity can change here.");
    const status = hostStatus().configured
      ? await window.openbot.host.updateIdentity(input)
      : await window.openbot.host.configure(input);
    setHostStatus(status);
    setServers(await window.openbot.servers.list());
    await refreshServerSettings(server.id);
  }

  async function setServerPublished(published: boolean): Promise<void> {
    const server = serverSettingsTarget();
    if (server?.kind !== "local") throw new Error("Only the local server can change publication.");
    const status = published ? await window.openbot.host.start() : await window.openbot.host.stop();
    setHostStatus(status);
    setServers(await window.openbot.servers.list());
    await refreshServerSettings(server.id);
    if (published && status.phase !== "online") {
      throw new Error(status.message ?? "This server could not be published.");
    }
  }

  async function createServerInvite(input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const invite =
      server.kind === "local"
        ? await window.openbot.host.createInvite(input)
        : await window.openbot.servers.createInvite(server.id, input);
    await refreshServerSettings(server.id);
    return invite;
  }

  async function updateServerMember(input: UpdateTeamMemberInput): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.updateMember(input);
    else await window.openbot.servers.updateMember(server.id, input);
    await refreshServerSettings(server.id);
  }

  async function removeServerMember(memberId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.removeMember(memberId);
    else await window.openbot.servers.removeMember(server.id, memberId);
    await refreshServerSettings(server.id);
  }

  async function revokeServerInvite(inviteId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.revokeInvite(inviteId);
    else await window.openbot.servers.revokeInvite(server.id, inviteId);
    await refreshServerSettings(server.id);
  }

  async function connectRemoteDesktop(serverId: string): Promise<RemoteDesktopSession> {
    const session = await window.openbot.remoteDesktop.connect({ serverId });
    setRemoteDesktopSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
    return session;
  }

  async function disconnectRemoteDesktop(sessionId: string): Promise<void> {
    await window.openbot.remoteDesktop.disconnect(sessionId);
    setRemoteDesktopSessions((current) => current.filter((session) => session.id !== sessionId));
  }

  async function selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
    await window.openbot.remoteDesktop.selectDisplay({ serverId, displayId });
    setRemoteDesktopSessions((current) =>
      current.map((session) =>
        session.serverId === serverId ? { ...session, selectedDisplayId: displayId } : session,
      ),
    );
  }

  function latestRemoteDesktopSession(serverId: string): RemoteDesktopSession | undefined {
    return [...remoteDesktopSessions()]
      .filter((session) => session.serverId === serverId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  function restoreRemoteDesktopFocus(): void {
    const target = remoteDesktopRestoreTarget;
    remoteDesktopRestoreTarget = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }

  function hideRemoteDesktopWorkspace(): void {
    setRemoteDesktopWorkspaceVisible(false);
    restoreRemoteDesktopFocus();
  }

  async function startRemoteDesktopConnection(
    serverId: string,
    request: number,
  ): Promise<RemoteDesktopSession | undefined> {
    try {
      const session = await connectRemoteDesktop(serverId);
      if (request !== remoteDesktopConnectionRequest || remoteDesktopWorkspaceServerId() !== serverId) {
        await disconnectRemoteDesktop(session.id);
        return undefined;
      }
      setRemoteDesktopSessionEstablished(true);
      return session;
    } catch (error) {
      if (request === remoteDesktopConnectionRequest && remoteDesktopWorkspaceServerId() === serverId) {
        setRemoteDesktopConnectionError(error instanceof Error ? error.message : "Could not start remote control.");
      }
      return undefined;
    } finally {
      if (request === remoteDesktopConnectionRequest) setRemoteDesktopConnectingServerId(null);
    }
  }

  async function openRemoteDesktopWorkspace(serverId: string, trigger: HTMLElement): Promise<void> {
    const server = servers().find((item) => item.id === serverId);
    const existingSession = latestRemoteDesktopSession(serverId);
    if (
      server?.kind !== "remote" ||
      (!existingSession && (server.state !== "online" || !server.remoteDesktopAvailable))
    ) {
      return;
    }

    remoteDesktopRestoreTarget = trigger;
    setRemoteDesktopWorkspaceServerId(serverId);
    setRemoteDesktopWorkspaceVisible(true);
    setRemoteDesktopConnectionError(null);
    if (existingSession) {
      setRemoteDesktopSessionEstablished(true);
      return;
    }
    if (remoteDesktopConnectPromise && remoteDesktopConnectingServerId() === serverId) {
      await remoteDesktopConnectPromise;
      return;
    }

    const request = ++remoteDesktopConnectionRequest;
    setRemoteDesktopSessionEstablished(false);
    setRemoteDesktopConnectingServerId(serverId);
    const connection = startRemoteDesktopConnection(serverId, request);
    remoteDesktopConnectPromise = connection;
    await connection;
    if (remoteDesktopConnectPromise === connection) remoteDesktopConnectPromise = null;
  }

  async function retryRemoteDesktopWorkspace(): Promise<void> {
    const serverId = remoteDesktopWorkspaceServerId();
    if (!serverId) return;
    const existingSession = latestRemoteDesktopSession(serverId);
    const request = ++remoteDesktopConnectionRequest;
    setRemoteDesktopConnectionError(null);
    setRemoteDesktopSessionEstablished(false);
    setRemoteDesktopConnectingServerId(serverId);
    if (existingSession) await disconnectRemoteDesktop(existingSession.id);
    const connection = startRemoteDesktopConnection(serverId, request);
    remoteDesktopConnectPromise = connection;
    await connection;
    if (remoteDesktopConnectPromise === connection) remoteDesktopConnectPromise = null;
  }

  async function disconnectRemoteDesktopWorkspace(restoreFocus = true): Promise<void> {
    const serverId = remoteDesktopWorkspaceServerId();
    if (!serverId) return;
    ++remoteDesktopConnectionRequest;
    setRemoteDesktopConnectionError(null);
    setRemoteDesktopSessionEstablished(false);
    const session = latestRemoteDesktopSession(serverId);
    if (session) await disconnectRemoteDesktop(session.id);
    else await remoteDesktopConnectPromise;
    remoteDesktopConnectPromise = null;
    setRemoteDesktopConnectingServerId(null);
    setRemoteDesktopWorkspaceVisible(false);
    setRemoteDesktopWorkspaceServerId(null);
    if (restoreFocus) restoreRemoteDesktopFocus();
    else remoteDesktopRestoreTarget = null;
  }

  const activeServer = createMemo(() => servers().find((server) => server.active));
  const serverSettingsTarget = createMemo(() => servers().find((server) => server.id === serverSettingsTargetId()));
  const activeRemoteDesktopSession = createMemo(() => {
    const server = activeServer();
    return server ? latestRemoteDesktopSession(server.id) : undefined;
  });
  const remoteDesktopWorkspaceServer = createMemo(() => {
    const serverId = remoteDesktopWorkspaceServerId();
    return serverId ? servers().find((server) => server.id === serverId) : undefined;
  });
  const remoteDesktopWorkspaceSession = createMemo(() => {
    const serverId = remoteDesktopWorkspaceServerId();
    return serverId ? latestRemoteDesktopSession(serverId) : undefined;
  });

  createEffect(
    () => remoteDesktopWorkspaceVisible(),
    (visible) => {
      if (appFrameElement) appFrameElement.inert = visible;
    },
  );

  createEffect(
    () => {
      const serverId = remoteDesktopWorkspaceServerId();
      return {
        serverId,
        established: remoteDesktopSessionEstablished(),
        sessionExists: serverId ? Boolean(latestRemoteDesktopSession(serverId)) : false,
        connectingServerId: remoteDesktopConnectingServerId(),
      };
    },
    ({ serverId, established, sessionExists, connectingServerId }) => {
      if (serverId && established && !sessionExists && connectingServerId !== serverId) {
        setRemoteDesktopSessionEstablished(false);
        setRemoteDesktopWorkspaceVisible(false);
        setRemoteDesktopWorkspaceServerId(null);
        restoreRemoteDesktopFocus();
      }
    },
  );
  const signedInAccount = createMemo(() => {
    const state = centralAuth();
    return state.status === "signed_in" ? state.user : null;
  });
  const visibleSignedInAccount = createMemo(() => (authSuccessVisible() ? null : signedInAccount()));

  return (
    <Show
      when={setupLoaded() && appInfo() !== null}
      fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}
    >
      <Show
        when={visibleSignedInAccount()}
        fallback={
          <AccountLogin
            variant={appInfo()?.variant ?? "production"}
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
                inviteUrl={pendingInviteUrl()}
                onSave={saveSetup}
                onPreviewInvite={previewInvite}
                onJoinRemote={joinRemoteDuringSetup}
                onLogout={logoutCentralAccount}
              />
            }
          >
            <div
              ref={(element) => (appFrameElement = element)}
              class={[
                "app-frame",
                {
                  "app-frame-sidebar-compact": leftPanelCompact(),
                  "app-frame-with-server-rail": appInfo()?.platform === "darwin" || appInfo()?.platform === "win32",
                  "app-frame-platform-darwin": appInfo()?.platform === "darwin",
                },
              ]}
              aria-hidden={remoteDesktopWorkspaceVisible() ? "true" : undefined}
              style={`--left-panel-width: ${leftPanelCompact() ? LEFT_PANEL_COMPACT : leftPanelWidth()}px`}
            >
              <Show when={appInfo()?.platform === "darwin" || appInfo()?.platform === "win32"}>
                <ServerRail
                  servers={servers()}
                  onSelect={(serverId) => void selectServer(serverId)}
                  onReorder={(serverIds) => void reorderServers(serverIds)}
                  onAdd={() => setJoinServerOpen(true)}
                  onOpenSettings={openServerSettings}
                />
              </Show>
              <Sidebar
                serverName={activeServer()?.name ?? "Local"}
                bots={botList()}
                activeBotId={activeDirectMemberId() ? "" : (activeBot()?.id ?? "")}
                people={directPeople()}
                directThreads={directThreads()}
                activeDirectMemberId={activeDirectMemberId()}
                agentStates={sidebarAgentStates()}
                onSelectBot={selectBot}
                onSelectPerson={(memberId) => void selectDirectMember(memberId)}
                onCreateBot={openAgentPicker}
                onEditBot={editBot}
                onDeleteBot={deleteBot}
                compact={leftPanelCompact()}
                onCollapse={() => setSidebarCollapsed(true)}
                onExpand={expandSidebar}
              />
              <AccountDock
                account={account()}
                appInfo={appInfo()}
                agentStatus={agentStatus()}
                accountUsage={accountUsage()}
                updateStatus={updateStatus()}
                compact={leftPanelCompact()}
                withServerRail={appInfo()?.platform === "darwin" || appInfo()?.platform === "win32"}
                onRefreshUsage={refreshAccountUsage}
                onUpdateAction={runUpdateAction}
                onUpdateAccountAvatar={updateAccountAvatar}
                onLogout={logoutCentralAccount}
                onOpenExternal={(destination) => window.openbot.openExternal(destination)}
                onOpenPermissions={() => setPermissionsOpen(true)}
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
                    onMarkRead={() => markDirectMessagesRead(member.id)}
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
                  unreadCount={activeBot() ? (conversationReads()[activeBot()?.id ?? ""]?.unreadCount ?? 0) : 0}
                  firstUnreadMessageId={
                    activeBot() ? (conversationReads()[activeBot()?.id ?? ""]?.firstUnreadMessageId ?? null) : null
                  }
                  loaded={activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false}
                  queue={activeQueue()}
                  browserTabs={browserTabs()}
                  activeBrowserTabId={activeBrowserTabId()}
                  browserControlState={browserControlState()}
                  server={activeServer()}
                  presence={teamPresence()}
                  currentUserEmail={account().email}
                  remoteDesktopSessionActive={Boolean(activeRemoteDesktopSession())}
                  remoteDesktopVisible={remoteDesktopWorkspaceVisible()}
                  prompt={activeBot() ? pendingPrompts()[activeBot()?.id ?? ""] : undefined}
                  approval={activeBot() ? pendingApprovals()[activeBot()?.id ?? ""] : undefined}
                  activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
                  agentPickerOpen={agentPickerOpen()}
                  globalOverlayOpen={globalSearchOpen()}
                  creatingAgent={creatingAgent()}
                  settingsRequest={settingsRequest()}
                  onboardingRequest={onboardingRequest()}
                  messageFocusRequest={messageFocusRequest()}
                  onCloseAgentPicker={() => setAgentPickerOpen(false)}
                  onCreateAgent={() => void createAgent()}
                  onSelectAgent={selectBot}
                  onUpdateBot={updateBot}
                  onSetAgentAvatar={setAgentAvatar}
                  onSendMessage={sendMessage}
                  onMarkRead={() => markAgentMessagesRead()}
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
                  onOpenRemoteDesktop={openRemoteDesktopWorkspace}
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
                  onPreviewInvite={previewInvite}
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
                  onPreview={previewInvite}
                  onJoin={joinServer}
                />
              </Show>
              <Show when={serverSettingsTarget()}>
                {(server) => (
                  <ServerSettingsModal
                    open={serverSettingsOpen()}
                    onOpenChange={setServerSettingsOpen}
                    restoreFocusTarget={serverSettingsRestoreTarget}
                    platform={appInfo()?.platform ?? "darwin"}
                    server={server()}
                    hostStatus={server().kind === "local" ? hostStatus() : null}
                    members={serverSettingsMembers()}
                    invites={serverSettingsInvites()}
                    loading={serverSettingsLoading()}
                    loadError={serverSettingsError()}
                    onRetry={() => refreshServerSettings(server().id)}
                    onSaveIdentity={saveServerIdentity}
                    onSetPublished={setServerPublished}
                    onCreateInvite={createServerInvite}
                    onUpdateMember={updateServerMember}
                    onRemoveMember={removeServerMember}
                    onRevokeInvite={revokeServerInvite}
                  />
                )}
              </Show>
              <Show when={globalSearchOpen()}>
                <GlobalSearch
                  open={true}
                  bots={botList()}
                  messagesByBot={liveMessages()}
                  onOpenChange={setGlobalSearchVisibility}
                  onSelectBot={selectBot}
                  onSelectMessage={selectGlobalSearchMessage}
                />
              </Show>
              <Show when={remoteDesktopWorkspaceServer()} keyed>
                {(server) => (
                  <RemoteDesktopWorkspace
                    visible={remoteDesktopWorkspaceVisible()}
                    platform={appInfo()?.platform ?? "darwin"}
                    server={server}
                    session={remoteDesktopWorkspaceSession()}
                    connecting={remoteDesktopConnectingServerId() === server.id}
                    connectionError={remoteDesktopConnectionError()}
                    onHide={hideRemoteDesktopWorkspace}
                    onDisconnect={() => disconnectRemoteDesktopWorkspace()}
                    onRetry={retryRemoteDesktopWorkspace}
                    onSelectDisplay={selectRemoteDesktopDisplay}
                  />
                )}
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
    imageGeneration: message.imageGeneration,
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

function readStateForMessages(state: ConversationReadState, messages: ConversationMessage[]): ConversationReadState {
  const throughIndex = state.throughMessageId
    ? messages.findIndex((message) => message.id === state.throughMessageId)
    : -1;
  const unread = messages
    .slice(throughIndex + 1)
    .filter((message) => message.author !== "user" && message.itemType !== "commentary");
  return {
    ...state,
    unreadCount: unread.length,
    firstUnreadMessageId: unread[0]?.id ?? null,
  };
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
    const sameTurnIndexes = result.flatMap((message, index) => (message.turnId === thinking.turnId ? [index] : []));
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) => message.turnId === thinking.turnId && message.author === "bot" && message.kind !== "thinking",
    );
    const insertionIndex = finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
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
