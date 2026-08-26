import type {
  AccountUsage,
  AgentApproval,
  AgentEvent,
  AgentModelOption,
  AgentProviderId,
  AgentStatus,
  AppInfo,
  AppSetupState,
  AvatarImageInput,
  BotSummary,
  BrowserControlState,
  BrowserTab,
  CentralAuthState,
  ConversationPage,
  ConversationPageInfo,
  ConversationReadState,
  ConversationSnapshot,
  DirectConversationPage,
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
  SidebarLayoutAction,
  SidebarLayoutSnapshot,
  TeamInviteSummary,
  TeamPresenceMember,
  TeamPresenceSnapshot,
  UpdateBotInput,
  UpdateStatus,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { isClaudeModel } from "@openbot/contracts/ipc";
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  flush,
  onSettled,
  type ParentProps,
  useContext,
} from "solid-js";
import { AppAccessGate } from "./AppView";
import { desktopAnalytics } from "./analytics";
import {
  botMessagesEqual,
  botProfilesEqual,
  formatTime,
  readStateForMessages,
  retainThinkingMessages,
  toBotMessage,
  toBotMessages,
  toBotProfile,
  withoutBot,
} from "./app-message-projection";
import { playCompletionSoundForAgentEvent } from "./completion-sound";
import { createFirstBotDraft, type FirstBotDraft } from "./components/FirstBotSetup";
import { readPanelWidth } from "./components/PanelResizer";
import type { SidebarAgentState } from "./components/Sidebar";
import { Toaster } from "./components/ui";
import type { BotMessage, BotProfile } from "./data";
import {
  normalizeSidebarPeopleOrder,
  readSidebarPeopleOrder,
  type SidebarPeopleOrderByServer,
  writeSidebarPeopleOrder,
} from "./sidebar-people-order";
import {
  MAX_SIDEBAR_PINNED_ITEMS,
  normalizeSidebarPinnedItems,
  readSidebarPins,
  type SidebarPinnedItem,
  type SidebarPinsByServer,
  sidebarPinnedItemKey,
  writeSidebarPins,
} from "./sidebar-pins";
import {
  defaultSidebarLayout,
  readSidebarCollapsed,
  type SidebarCollapsedByServer,
  writeSidebarCollapsed,
} from "./sidebar-sections";

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

function coarseFailureCode(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .slice(0, 64);
  return normalized || "unknown";
}

function normalizedTurnStatus(value: string): string {
  return ["completed", "failed", "interrupted", "cancelled"].includes(value) ? value : "other";
}

export function createBotInitialMessage(draft: Pick<FirstBotDraft, "purpose">): string {
  return `Your ongoing role is: ${draft.purpose.trim()}`;
}

interface AppProps {
  landingPreview?: boolean;
}

export function createAppController(props: AppProps = {}) {
  const [botList, setBotList] = createSignal<BotProfile[]>([]);
  const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
  const [activeBotId, setActiveBotId] = createSignal("");
  const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
  const [uiErrors, setUiErrors] = createSignal<Record<string, BotMessage[]>>({});
  const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
  const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>({});
  const [conversationPages, setConversationPages] = createSignal<Record<string, ConversationPageInfo>>({});
  const [conversationWindowModes, setConversationWindowModes] = createSignal<Record<string, "latest" | "around">>({});
  const [conversationReferences, setConversationReferences] = createSignal<Record<string, Record<string, BotMessage>>>(
    {},
  );
  const [conversationOlderLoading, setConversationOlderLoading] = createSignal<Record<string, boolean>>({});
  const [conversationOlderErrors, setConversationOlderErrors] = createSignal<Record<string, string | null>>({});
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
  const [botSetupOpen, setBotSetupOpen] = createSignal(false);
  const [botSetupDraft, setBotSetupDraft] = createSignal<FirstBotDraft>(createFirstBotDraft());
  const [botSetupError, setBotSetupError] = createSignal<string | null>(null);
  const [creatingAgent, setCreatingAgent] = createSignal(false);
  const [settingsRequest, setSettingsRequest] = createSignal<{
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
  const [sidebarPinsByServer, setSidebarPinsByServer] = createSignal<SidebarPinsByServer>(readSidebarPins());
  const [sidebarPeopleOrderByServer, setSidebarPeopleOrderByServer] = createSignal<SidebarPeopleOrderByServer>(
    readSidebarPeopleOrder(),
  );
  const [sidebarLayout, setSidebarLayout] = createSignal<SidebarLayoutSnapshot>(defaultSidebarLayout());
  const [sidebarCollapsedByServer, setSidebarCollapsedByServer] = createSignal<SidebarCollapsedByServer>(
    readSidebarCollapsed(),
  );
  const [setupState, setSetupState] = createSignal<AppSetupState | null>(null);
  const [setupLoaded, setSetupLoaded] = createSignal(false);
  const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({
    status: "loading",
  });
  const [authSuccessVisible, setAuthSuccessVisible] = createSignal(false);
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [skillsMarketplaceOpen, setSkillsMarketplaceOpen] = createSignal(false);
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
  const [directConversationPages, setDirectConversationPages] = createSignal<
    Record<string, DirectConversationPage["pageInfo"]>
  >({});
  const [directOlderLoading, setDirectOlderLoading] = createSignal<Record<string, boolean>>({});
  const [directOlderErrors, setDirectOlderErrors] = createSignal<Record<string, string | null>>({});
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
  const conversationPageRequests = new Map<string, number>();
  const turnStartedAt = new Map<string, number>();
  const completedTurnByBot = new Map<string, string>();
  let conversationFrame: number | undefined;
  let directConversationRequest = 0;
  let serverSettingsRequest = 0;
  let serverSettingsRestoreTarget: HTMLElement | null = null;
  let appFrameElement: HTMLDivElement | undefined;
  let remoteDesktopRestoreTarget: HTMLElement | null = null;
  let remoteDesktopConnectPromise: Promise<RemoteDesktopSession | undefined> | null = null;
  let remoteDesktopConnectionRequest = 0;
  let authSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  let analyticsOpened = false;
  let analyticsUserId: string | null = null;
  let appInfoLoadedFromHost = false;

  function analyticsAgentProperties(botId: string) {
    const bot = botList().find((candidate) => candidate.id === botId);
    if (!bot) return null;
    const server = servers().find((candidate) => candidate.active);
    return {
      provider: isClaudeModel(bot.model) ? ("claude" as const) : ("codex" as const),
      model: bot.model,
      reasoning_effort: bot.reasoningEffort,
      server_kind: server?.kind ?? ("unknown" as const),
    };
  }

  createEffect(
    () => ({ info: appInfo(), setup: setupState(), auth: centralAuth() }),
    ({ info, setup, auth }) => {
      if (!appInfoLoadedFromHost || !info || !setup || auth.status === "loading") return;
      if (!desktopAnalytics.configure(info)) return;
      if (auth.status === "signed_in" && analyticsUserId !== auth.user.id) {
        desktopAnalytics.identify(auth.user);
        analyticsUserId = auth.user.id;
      } else if (auth.status === "signed_out" && analyticsUserId) {
        desktopAnalytics.clear();
        analyticsUserId = null;
      }
      if (analyticsOpened) return;
      analyticsOpened = true;
      desktopAnalytics.track("desktop_app_opened", {
        setup_completed: setup.completed,
        signed_in: auth.status === "signed_in",
      });
    },
  );

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
    const unsubscribeRemoteDesktop = props.landingPreview
      ? () => undefined
      : window.openbot.remoteDesktop.onEvent((sessions) => flush(() => setRemoteDesktopSessions(sessions)));
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
      turnStartedAt.clear();
      completedTurnByBot.clear();
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
        .then((info) => {
          appInfoLoadedFromHost = true;
          setAppInfo(info);
        })
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
        .getSidebarLayout()
        .then(setSidebarLayout)
        .catch(() => setSidebarLayout(defaultSidebarLayout())),
      window.openbot.agent
        .listConversationReads()
        .then(applyConversationReads)
        .catch(() => undefined),
    ]);
    if (!props.landingPreview) {
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
    }
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
    if (!props.landingPreview) {
      void window.openbot.remoteDesktop
        .list()
        .then(setRemoteDesktopSessions)
        .catch(() => undefined);
    }
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
      const pageRequest = (conversationPageRequests.get(botId) ?? 0) + 1;
      conversationPageRequests.set(botId, pageRequest);
      void Promise.all([
        window.openbot.agent.readConversationPage({ botId, anchor: { type: "latest" }, limit: 50 }),
        window.openbot.agent.listQueue(botId),
      ])
        .then(([page, queue]) => {
          if (conversationPageRequests.get(botId) !== pageRequest) return;
          setQueues((current) => ({ ...current, [botId]: queue }));
          applyConversationPage(page, true, "latest");
          if (markReadOnOpen && (page.readState?.unreadCount ?? 0) > 0) {
            void markAgentMessagesRead(botId, page.messages.at(-1)?.id ?? null).catch((error) =>
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
      case "sidebar-layout-changed":
        setSidebarLayout(event.layout);
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
        if (props.landingPreview) return;
        setBrowserTabs(event.tabs);
        setActiveBrowserTabId(event.activeTabId);
        return;
      case "browser-control-changed":
        if (props.landingPreview) return;
        setBrowserControlState(event.state);
        return;
      case "turn-started":
        turnStartedAt.set(event.turnId, performance.now());
        completedTurnByBot.delete(event.botId);
        {
          const properties = analyticsAgentProperties(event.botId);
          if (properties) desktopAnalytics.track("turn_started", properties);
        }
        clearRecentReply(event.botId);
        setActiveTurns((current) => ({
          ...current,
          [event.botId]: event.turnId,
        }));
        return;
      case "turn-completed":
        completedTurnByBot.set(event.botId, event.turnId);
        {
          const properties = analyticsAgentProperties(event.botId);
          const startedAt = turnStartedAt.get(event.turnId);
          turnStartedAt.delete(event.turnId);
          if (properties) {
            desktopAnalytics.track("turn_completed", {
              ...properties,
              status: normalizedTurnStatus(event.status),
              ...(startedAt === undefined
                ? {}
                : { duration_ms: Math.max(0, Math.round(performance.now() - startedAt)) }),
            });
          }
        }
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        setQueues((current) => {
          const snapshot = current[event.botId];
          if (!snapshot) return current;
          const deliveries = snapshot.deliveries.filter(
            (delivery) =>
              !(
                (delivery.status === "starting" || delivery.status === "running") &&
                (delivery.turnId === null || delivery.turnId === event.turnId)
              ),
          );
          if (deliveries.length === snapshot.deliveries.length) return current;
          return { ...current, [event.botId]: { ...snapshot, deliveries } };
        });
        setPendingPrompts((current) => ({ ...current, [event.botId]: undefined }));
        setPendingApprovals((current) => ({ ...current, [event.botId]: undefined }));
        if (event.status === "completed") {
          markReplyCompleted(event.botId);
          playCompletionSoundForAgentEvent(event, botList());
        }
        return;
      case "prompt":
        desktopAnalytics.track("agent_input_requested", {
          kind: "prompt",
          prompt_count: event.questions.length,
          has_secret_prompt: event.questions.some((question) => question.isSecret),
        });
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        return;
      case "approval":
        desktopAnalytics.track("agent_input_requested", {
          kind: "approval",
          approval_kind: event.approval.kind,
        });
        setPendingApprovals((current) => ({
          ...current,
          [event.approval.botId]: event.approval,
        }));
        return;
      case "error":
        desktopAnalytics.track("operation_failed", {
          area: "agent",
          failure_code: coarseFailureCode(event.code),
        });
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
    if (profiles.length === 0 && !botSetupOpen()) {
      setBotSetupDraft(createFirstBotDraft());
      setBotSetupError(null);
      setBotSetupOpen(true);
    }
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
    return !botSetupOpen() && !activeDirectMemberId() && activeBot()?.id === botId;
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
    const initialLoad = conversationLoaded()[botId] !== true || (liveMessages()[botId]?.length ?? 0) === 0;
    setConversationRevisions((current) => ({
      ...current,
      [botId]: snapshot.revision,
    }));
    setLiveMessages((current) => {
      const previous = current[botId] ?? [];
      const previousById = new Map(previous.map((message) => [message.id, message]));
      const allMappedMessages = toBotMessages(snapshot.messages);
      const pageInfo = conversationPages()[botId];
      const windowMode = conversationWindowModes()[botId] ?? "latest";
      const mappedMessages = retainThinkingMessages(
        previous,
        pageInfo?.hasOlder
          ? (() => {
              const loadedIds = new Set(previous.map((message) => message.id));
              if (windowMode === "around") {
                return allMappedMessages.filter((message) => loadedIds.has(message.id));
              }
              const lastLoadedIndex = [...allMappedMessages]
                .map((message) => message.id)
                .reduce((last, id, index) => (loadedIds.has(id) ? index : last), -1);
              return allMappedMessages.filter((message, index) => loadedIds.has(message.id) || index > lastLoadedIndex);
            })()
          : allMappedMessages,
      );
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
      [botId]: completedTurnByBot.get(botId) === snapshot.activeTurnId ? null : snapshot.activeTurnId,
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

  function applyConversationPage(page: ConversationPage, replace: boolean, windowMode?: "latest" | "around"): void {
    if (page.revision < (conversationRevisions()[page.botId] ?? -1)) return;
    const mapped = toBotMessages(page.messages);
    setLiveMessages((current) => {
      const currentMessages = current[page.botId] ?? [];
      const currentById = new Map(currentMessages.map((message) => [message.id, message]));
      const pageMessages = mapped.map((message) => {
        const stored = currentById.get(message.id);
        if (!stored) return createStoredMessage({ ...message, animate: false });
        if (!botMessagesEqual(stored, message)) updateStored(stored, { ...message, animate: stored.animate });
        return stored;
      });
      const existing = replace ? [] : currentMessages;
      const ids = new Set(mapped.map((message) => message.id));
      return {
        ...current,
        [page.botId]: replace ? pageMessages : [...pageMessages, ...existing.filter((message) => !ids.has(message.id))],
      };
    });
    setConversationReferences((current) => ({
      ...current,
      [page.botId]: {
        ...(replace ? {} : current[page.botId]),
        ...Object.fromEntries(Object.entries(page.references).map(([id, message]) => [id, toBotMessage(message)])),
      },
    }));
    setConversationPages((current) => ({ ...current, [page.botId]: page.pageInfo }));
    if (windowMode) setConversationWindowModes((current) => ({ ...current, [page.botId]: windowMode }));
    setConversationRevisions((current) => ({ ...current, [page.botId]: page.revision }));
    setConversationLoaded((current) => ({ ...current, [page.botId]: true }));
    setActiveTurns((current) => ({
      ...current,
      [page.botId]: completedTurnByBot.get(page.botId) === page.activeTurnId ? null : page.activeTurnId,
    }));
    if (page.readState) applyConversationReadState(page.botId, page.readState);
  }

  async function loadOlderAgentMessages(botId = activeBot()?.id): Promise<void> {
    if (!botId || conversationOlderLoading()[botId]) return;
    const pageInfo = conversationPages()[botId];
    if (!pageInfo?.hasOlder || !pageInfo.olderCursor) return;
    const cursor = pageInfo.olderCursor;
    const requestVersion = conversationPageRequests.get(botId) ?? 0;
    setConversationOlderLoading((current) => ({ ...current, [botId]: true }));
    setConversationOlderErrors((current) => ({ ...current, [botId]: null }));
    try {
      const page = await window.openbot.agent.readConversationPage({
        botId,
        anchor: { type: "before", cursor },
        limit: 50,
      });
      if (conversationPageRequests.get(botId) !== requestVersion) return;
      if (conversationPages()[botId]?.olderCursor !== cursor) return;
      applyConversationPage(page, false);
    } catch (error) {
      setConversationOlderErrors((current) => ({
        ...current,
        [botId]: error instanceof Error ? error.message : "Older messages could not load.",
      }));
    } finally {
      setConversationOlderLoading((current) => ({ ...current, [botId]: false }));
    }
  }

  async function createAgent(draft: FirstBotDraft = botSetupDraft()) {
    if (creatingAgent()) return;
    const submitted = { ...draft };
    setCreatingAgent(true);
    setBotSetupError(null);
    try {
      const stored = await window.openbot.agent.createBot({
        name: submitted.name.trim(),
        description: submitted.purpose.trim(),
        avatarSeed: submitted.avatarSeed,
        avatarHue: submitted.avatarHue,
        initialMessage: createBotInitialMessage(submitted),
      });
      const newAgent = createStoredProfile(toBotProfile(stored));
      setBotList((current) => [newAgent, ...current.filter((item) => item.id !== newAgent.id)]);
      setLiveMessages((current) => (current[newAgent.id] ? current : { ...current, [newAgent.id]: [] }));
      setConversationLoaded((current) => ({ ...current, [newAgent.id]: true }));
      setBotSetupOpen(false);
      setActiveDirectMemberId(null);
      setActiveBotId(newAgent.id);
      const properties = analyticsAgentProperties(newAgent.id);
      if (properties) desktopAnalytics.track("agent_created", properties);
    } catch (error) {
      setBotSetupError(error instanceof Error ? error.message : "The Bot could not be created.");
    } finally {
      setCreatingAgent(false);
    }
  }

  function openBotSetup() {
    if (botSetupOpen()) return;
    const directMemberId = activeDirectMemberId();
    if (directMemberId) {
      void window.openbot.servers.setDirectTyping({ memberId: directMemberId, typing: false }).catch(() => undefined);
    }
    setBotSetupDraft(createFirstBotDraft());
    setBotSetupError(null);
    setBotSetupOpen(true);
  }

  function cancelBotSetup() {
    if (creatingAgent() || botList().length === 0) return;
    setBotSetupOpen(false);
    setBotSetupError(null);
    setBotSetupDraft(createFirstBotDraft());
  }

  function selectBot(botId: string) {
    if (botSetupOpen() && creatingAgent()) return;
    const previousBotId = activeBotId();
    if (previousBotId && previousBotId !== botId) pruneInactiveAgentHistory(previousBotId);
    setBotSetupOpen(false);
    setBotSetupError(null);
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
  }

  async function searchGlobalMessages(query: string): Promise<Array<{ botId: string; message: BotMessage }>> {
    const page = await window.openbot.agent.searchConversationMessages({ query, limit: 100 });
    desktopAnalytics.track("search_used", { scope: "global", result_count: page.total });
    return page.results.map((result) => ({ botId: result.botId, message: toBotMessage(result.message) }));
  }

  async function searchAgentMessages(botId: string, query: string): Promise<{ messageIds: string[]; total: number }> {
    const page = await window.openbot.agent.searchConversationMessages({ query, botId, limit: 100 });
    desktopAnalytics.track("search_used", { scope: "agent", result_count: page.total });
    return { messageIds: page.results.map((result) => result.message.id), total: page.total };
  }

  function selectGlobalSearchMessage(botId: string, messageId: string): void {
    selectBot(botId);
    void openAgentMessage(botId, messageId);
  }

  async function openAgentMessage(botId: string, messageId: string): Promise<void> {
    await Promise.resolve();
    const request = (conversationPageRequests.get(botId) ?? 0) + 1;
    conversationPageRequests.set(botId, request);
    try {
      const page = await window.openbot.agent.readConversationPage({
        botId,
        anchor: { type: "around", messageId },
        limit: 50,
      });
      if (conversationPageRequests.get(botId) !== request) return;
      if (!page.messages.some((message) => message.id === messageId)) {
        throw new Error("This message is no longer available.");
      }
      applyConversationPage(page, true, "around");
      setMessageFocusRequest({ botId, messageId, nonce: Date.now() });
    } catch (error) {
      appendUiError(botId, error, "Message load failed");
    }
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
    if (botSetupOpen() && creatingAgent()) return;
    if (!currentTeamMember() || !directPeople().some((member) => member.id === memberId)) return;
    const previousBotId = activeBotId();
    if (previousBotId) pruneInactiveAgentHistory(previousBotId);
    setBotSetupOpen(false);
    setBotSetupError(null);
    setSettingsRequest(null);
    const previousMemberId = activeDirectMemberId();
    if (previousMemberId && previousMemberId !== memberId) {
      pruneInactiveDirectHistory(previousMemberId);
      void window.openbot.servers.setDirectTyping({ memberId: previousMemberId, typing: false }).catch(() => undefined);
    }
    setActiveDirectMemberId(memberId);
    setDirectConversationLoading(true);
    setDirectConversationError(null);
    const request = ++directConversationRequest;
    try {
      const snapshot = await window.openbot.servers.readDirectConversationPage({
        memberId,
        anchor: { type: "latest" },
        limit: 50,
      });
      if (request !== directConversationRequest) return;
      setDirectConversations((current) => ({
        ...current,
        [memberId]: snapshot,
      }));
      setDirectConversationPages((current) => ({ ...current, [memberId]: snapshot.pageInfo }));
    } catch (error) {
      if (request !== directConversationRequest) return;
      setDirectConversationError(error instanceof Error ? error.message : "The messages could not load.");
    } finally {
      if (request === directConversationRequest) setDirectConversationLoading(false);
    }
  }

  async function loadOlderDirectMessages(memberId = activeDirectMemberId()): Promise<void> {
    if (!memberId || directOlderLoading()[memberId]) return;
    const pageInfo = directConversationPages()[memberId];
    if (!pageInfo?.hasOlder || !pageInfo.olderCursor) return;
    const cursor = pageInfo.olderCursor;
    const request = directConversationRequest;
    setDirectOlderLoading((current) => ({ ...current, [memberId]: true }));
    setDirectOlderErrors((current) => ({ ...current, [memberId]: null }));
    try {
      const page = await window.openbot.servers.readDirectConversationPage({
        memberId,
        anchor: { type: "before", cursor },
        limit: 50,
      });
      if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
      if (directConversationPages()[memberId]?.olderCursor !== cursor) return;
      setDirectConversations((current) => {
        const existing = current[memberId];
        if (!existing) return current;
        const ids = new Set(page.messages.map((message) => message.id));
        return {
          ...current,
          [memberId]: {
            ...existing,
            messages: [...page.messages, ...existing.messages.filter((message) => !ids.has(message.id))],
            revision: Math.max(existing.revision, page.revision),
            readState: page.readState ?? existing.readState,
          },
        };
      });
      setDirectConversationPages((current) => ({ ...current, [memberId]: page.pageInfo }));
    } catch (error) {
      setDirectOlderErrors((current) => ({
        ...current,
        [memberId]: error instanceof Error ? error.message : "Older messages could not load.",
      }));
    } finally {
      setDirectOlderLoading((current) => ({ ...current, [memberId]: false }));
    }
  }

  async function openDirectMessage(memberId: string, messageId: string): Promise<void> {
    const request = ++directConversationRequest;
    try {
      const page = await window.openbot.servers.readDirectConversationPage({
        memberId,
        anchor: { type: "around", messageId },
        limit: 50,
      });
      if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
      setDirectConversations((current) => ({ ...current, [memberId]: page }));
      setDirectConversationPages((current) => ({ ...current, [memberId]: page.pageInfo }));
    } catch (error) {
      if (request !== directConversationRequest || activeDirectMemberId() !== memberId) return;
      setDirectOlderErrors((current) => ({
        ...current,
        [memberId]: error instanceof Error ? error.message : "The unread message could not load.",
      }));
    }
  }

  function pruneInactiveAgentHistory(botId: string): void {
    const messages = liveMessages()[botId];
    if (!messages || messages.length <= 50) return;
    setLiveMessages((current) => {
      const currentMessages = current[botId];
      if (!currentMessages || currentMessages.length <= 50) return current;
      return { ...current, [botId]: currentMessages.slice(-50) };
    });
    setConversationReferences((current) => ({ ...current, [botId]: {} }));
    setConversationPages((current) => ({
      ...current,
      [botId]: { hasOlder: true, olderCursor: null },
    }));
  }

  function pruneInactiveDirectHistory(memberId: string): void {
    const snapshot = directConversations()[memberId];
    if (!snapshot || snapshot.messages.length <= 50) return;
    setDirectConversations((current) => {
      const conversation = current[memberId];
      if (!conversation || conversation.messages.length <= 50) return current;
      return {
        ...current,
        [memberId]: { ...conversation, messages: conversation.messages.slice(-50) },
      };
    });
    setDirectConversationPages((current) => ({
      ...current,
      [memberId]: { hasOlder: true, olderCursor: null },
    }));
  }

  async function loadLatestAgentMessages(botId: string): Promise<void> {
    const request = (conversationPageRequests.get(botId) ?? 0) + 1;
    conversationPageRequests.set(botId, request);
    const page = await window.openbot.agent.readConversationPage({
      botId,
      anchor: { type: "latest" },
      limit: 50,
    });
    if (conversationPageRequests.get(botId) !== request) return;
    applyConversationPage(page, true, "latest");
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
    desktopAnalytics.track("message_sent", {
      channel: "direct",
      attachment_count: 0,
      is_reply: false,
      delivery_count: 1,
      server_kind: servers().find((server) => server.active)?.kind ?? "unknown",
    });
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
    void window.openbot.browser
      .activate(tabId)
      .then(() => desktopAnalytics.track("browser_action", { action: "activate", result: "succeeded" }))
      .catch(() => desktopAnalytics.track("browser_action", { action: "activate", result: "failed" }));
  }

  async function closeBrowserTab(tabId: string) {
    try {
      await window.openbot.browser.close(tabId);
      desktopAnalytics.track("browser_action", { action: "close", result: "succeeded" });
    } catch (error) {
      desktopAnalytics.track("browser_action", { action: "close", result: "failed" });
      throw error;
    }
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
      desktopAnalytics.track("agent_updated", { changed_fields: Object.keys(updates) });
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
      desktopAnalytics.track("agent_updated", { changed_fields: ["avatar"] });
    } catch (error) {
      appendUiError(botId, error, "Avatar update failed");
      throw error;
    }
  }

  function editBot(botId: string) {
    if (botSetupOpen() && creatingAgent()) return;
    selectBot(botId);
    setSettingsRequest({ botId, nonce: Date.now() });
  }

  async function deleteBot(botId: string) {
    if (botSetupOpen() && creatingAgent()) return;
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
      removePinnedSidebarItemEverywhere({ kind: "agent", id: botId });
      const replyTimer = recentReplyTimers.get(botId);
      if (replyTimer) clearTimeout(replyTimer);
      recentReplyTimers.delete(botId);
      desktopAnalytics.track("agent_deleted", {});
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
      const properties = analyticsAgentProperties(botId);
      desktopAnalytics.track("message_sent", {
        ...(properties ?? {}),
        channel: "agent",
        attachment_count: attachmentDraftIds.length,
        is_reply: replyToMessageId !== null,
        delivery_count: receipt.deliveries.length,
      });
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
      desktopAnalytics.track("agent_input_resolved", { kind: "prompt", decision: "answered" });
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
      desktopAnalytics.track("agent_input_resolved", { kind: "approval", decision });
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
      .then(() => desktopAnalytics.track("queue_action", { action: "cancel", result: "succeeded" }))
      .catch((error) => {
        desktopAnalytics.track("queue_action", { action: "cancel", result: "failed" });
        appendUiError(bot.id, error, "Cancel failed");
      });
  }

  function steerQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.openbot.agent
      .steerQueuedMessage({ botId: bot.id, deliveryId, expectedTurnId: turnId })
      .then(() => desktopAnalytics.track("queue_action", { action: "steer", result: "succeeded" }))
      .catch((error) => {
        desktopAnalytics.track("queue_action", { action: "steer", result: "failed" });
        appendUiError(bot.id, error, "Steer failed");
      });
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
      desktopAnalytics.track("queue_action", { action: "edit", result: "succeeded" });
      return true;
    } catch (error) {
      desktopAnalytics.track("queue_action", { action: "edit", result: "failed" });
      appendUiError(bot.id, error, "Edit failed");
      return false;
    }
  }

  function reorderQueue(deliveryIds: string[]) {
    const bot = activeBot();
    if (!bot) return;
    void window.openbot.agent
      .reorderQueue({ botId: bot.id, deliveryIds })
      .then(() => desktopAnalytics.track("queue_action", { action: "reorder", result: "succeeded" }))
      .catch((error) => {
        desktopAnalytics.track("queue_action", { action: "reorder", result: "failed" });
        appendUiError(bot.id, error, "Reorder failed");
      });
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    void window.openbot.agent
      .interrupt({ botId: bot.id, turnId })
      .then(() => desktopAnalytics.track("queue_action", { action: "interrupt", result: "succeeded" }))
      .catch((error) => {
        desktopAnalytics.track("queue_action", { action: "interrupt", result: "failed" });
        appendUiError(bot.id, error, "Stop failed");
      });
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
    const wasCompleted = setupState()?.completed === true;
    const state = await window.openbot.saveSetup({ preferredProvider });
    flush(() => {
      setSetupState(state);
      setPermissionsOpen(false);
    });
    if (!wasCompleted && state.completed) {
      desktopAnalytics.track("onboarding_completed", { preferred_provider: preferredProvider });
    }
  }

  async function requestEmailCode(email: string): Promise<void> {
    const state = await window.openbot.auth.requestEmailCode(email);
    desktopAnalytics.track("account_sign_in_started", {
      result: state.status === "code_sent" ? "code_sent" : "failed",
      ...(state.status === "error" ? { failure_code: coarseFailureCode(state.issue.code) } : {}),
    });
    applyCentralAuthState(state);
  }

  async function retryCentralAccount(): Promise<void> {
    applyCentralAuthState({ status: "loading" });
    applyCentralAuthState(await window.openbot.auth.retry());
  }

  async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
    const state = await window.openbot.auth.verifyEmailCode(challengeId, code);
    desktopAnalytics.track("account_sign_in_completed", {
      result: state.status === "signed_in" ? "succeeded" : "failed",
      ...("issue" in state ? { failure_code: coarseFailureCode(state.issue?.code) } : {}),
    });
    applyCentralAuthState(state);
  }

  async function logoutCentralAccount(): Promise<void> {
    const state = await window.openbot.auth.logout();
    desktopAnalytics.track("account_signed_out", {});
    desktopAnalytics.clear();
    analyticsUserId = null;
    applyCentralAuthState(state);
  }

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    applyCentralAuthState(await window.openbot.auth.updateAvatar(image));
  }

  async function runUpdateAction(): Promise<void> {
    const phase = updateStatus().phase;
    if (phase === "ready") {
      desktopAnalytics.track("update_action", { action: "install", result: "succeeded", phase: "installing" });
      await window.openbot.update.install();
      return;
    }
    const action = phase === "available" ? ("download" as const) : ("check" as const);
    try {
      const status =
        action === "download" ? await window.openbot.update.download() : await window.openbot.update.check();
      setUpdateStatus(status);
      desktopAnalytics.track("update_action", { action, result: "succeeded", phase: status.phase });
    } catch (error) {
      desktopAnalytics.track("update_action", { action, result: "failed" });
      throw error;
    }
  }

  async function selectServer(serverId: string): Promise<void> {
    if (botSetupOpen() && creatingAgent()) return;
    const previousServerId = servers().find((server) => server.active)?.id;
    if (previousServerId && previousServerId !== serverId) {
      await disconnectRemoteDesktopWorkspace(false);
    }
    directConversationRequest += 1;
    const nextServers = await window.openbot.servers.select(serverId);
    setServers(nextServers);
    setBotSetupOpen(false);
    setBotSetupError(null);
    setSettingsRequest(null);
    setBotList([]);
    setSidebarLayout(defaultSidebarLayout());
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
    setConversationWindowModes({});
    setUnreadReplies({});
    setQueues({});
    setTeamPresence(EMPTY_TEAM_PRESENCE);
    const [storedBots, layout, reads, status, models, tabs, controlState, presence] = await Promise.all([
      window.openbot.agent.listBots(),
      window.openbot.agent.getSidebarLayout(),
      window.openbot.agent.listConversationReads(),
      window.openbot.agent.getStatus(),
      window.openbot.agent.listModels(),
      props.landingPreview ? Promise.resolve([]) : window.openbot.browser.listTabs(),
      props.landingPreview ? Promise.resolve({ sessions: [] }) : window.openbot.browser.getControlState(),
      window.openbot.servers.getPresence(),
    ]);
    setAgentStatus(status);
    setModelOptions(models);
    setBrowserTabs(tabs);
    setActiveBrowserTabId(tabs[0]?.id ?? null);
    setBrowserControlState(controlState);
    setTeamPresence(presence);
    setSidebarLayout(layout);
    applyStoredBots(storedBots);
    applyConversationReads(reads);
    desktopAnalytics.track("team_action", {
      action: "server_selected",
      result: "succeeded",
      server_kind: nextServers.find((server) => server.active)?.kind ?? "unknown",
    });
  }

  async function openInstalledMarketplaceAgent(bot: BotSummary): Promise<void> {
    await selectServer("local");
    selectBot(bot.id);
    setSkillsMarketplaceOpen(false);
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
    try {
      await window.openbot.servers.join(input);
      setPendingInviteUrl("");
      setJoinServerOpen(false);
      await selectServer(
        window.openbot ? ((await window.openbot.servers.list()).find((item) => item.active)?.id ?? "local") : "local",
      );
      desktopAnalytics.track("team_action", { action: "server_joined", result: "succeeded" });
    } catch (error) {
      desktopAnalytics.track("team_action", { action: "server_joined", result: "failed" });
      throw error;
    }
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
    desktopAnalytics.track("team_action", {
      action: "identity_saved",
      result: "succeeded",
      server_kind: "local",
    });
  }

  async function setServerPublished(published: boolean): Promise<void> {
    const server = serverSettingsTarget();
    if (server?.kind !== "local") throw new Error("Only the local server can change publication.");
    const status = published ? await window.openbot.host.start() : await window.openbot.host.stop();
    setHostStatus(status);
    setServers(await window.openbot.servers.list());
    await refreshServerSettings(server.id);
    if (published && status.phase !== "online") {
      desktopAnalytics.track("team_action", {
        action: "published",
        result: "failed",
        server_kind: "local",
      });
      throw new Error(status.message ?? "This server could not be published.");
    }
    desktopAnalytics.track("team_action", {
      action: published ? "published" : "unpublished",
      result: "succeeded",
      server_kind: "local",
    });
  }

  async function createServerInvite(input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const invite =
      server.kind === "local"
        ? await window.openbot.host.createInvite(input)
        : await window.openbot.servers.createInvite(server.id, input);
    await refreshServerSettings(server.id);
    desktopAnalytics.track("team_action", {
      action: "invite_created",
      result: "succeeded",
      server_kind: server.kind,
      role: input.role,
      email_bound: Boolean(input.email),
    });
    return invite;
  }

  async function updateServerMember(input: UpdateTeamMemberInput): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.updateMember(input);
    else await window.openbot.servers.updateMember(server.id, input);
    await refreshServerSettings(server.id);
    desktopAnalytics.track("team_action", {
      action: "member_updated",
      result: "succeeded",
      server_kind: server.kind,
    });
  }

  async function removeServerMember(memberId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.removeMember(memberId);
    else await window.openbot.servers.removeMember(server.id, memberId);
    await refreshServerSettings(server.id);
    desktopAnalytics.track("team_action", {
      action: "member_removed",
      result: "succeeded",
      server_kind: server.kind,
    });
  }

  async function revokeServerInvite(inviteId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    if (server.kind === "local") await window.openbot.host.revokeInvite(inviteId);
    else await window.openbot.servers.revokeInvite(server.id, inviteId);
    await refreshServerSettings(server.id);
    desktopAnalytics.track("team_action", {
      action: "invite_revoked",
      result: "succeeded",
      server_kind: server.kind,
    });
  }

  async function connectRemoteDesktop(serverId: string): Promise<RemoteDesktopSession> {
    try {
      const session = await window.openbot.remoteDesktop.connect({ serverId });
      setRemoteDesktopSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      desktopAnalytics.track("remote_desktop_action", {
        action: "connect",
        result: "succeeded",
        transport: session.transport,
      });
      return session;
    } catch (error) {
      desktopAnalytics.track("remote_desktop_action", {
        action: "connect",
        result: "failed",
        failure_code: "connection_failed",
      });
      throw error;
    }
  }

  async function disconnectRemoteDesktop(sessionId: string): Promise<void> {
    try {
      await window.openbot.remoteDesktop.disconnect(sessionId);
      setRemoteDesktopSessions((current) => current.filter((session) => session.id !== sessionId));
      desktopAnalytics.track("remote_desktop_action", { action: "disconnect", result: "succeeded" });
    } catch (error) {
      desktopAnalytics.track("remote_desktop_action", { action: "disconnect", result: "failed" });
      throw error;
    }
  }

  async function selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
    try {
      await window.openbot.remoteDesktop.selectDisplay({ serverId, displayId });
      setRemoteDesktopSessions((current) =>
        current.map((session) =>
          session.serverId === serverId ? { ...session, selectedDisplayId: displayId } : session,
        ),
      );
      desktopAnalytics.track("remote_desktop_action", { action: "select_display", result: "succeeded" });
    } catch (error) {
      desktopAnalytics.track("remote_desktop_action", { action: "select_display", result: "failed" });
      throw error;
    }
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
  const activeServerSidebarKey = createMemo(() => activeServer()?.id ?? "local");
  const pinnedSidebarItems = createMemo(() => sidebarPinsByServer()[activeServerSidebarKey()] ?? []);
  const sidebarPeopleOrder = createMemo(() => sidebarPeopleOrderByServer()[activeServerSidebarKey()] ?? []);
  const collapsedSidebarSectionIds = createMemo(() => sidebarCollapsedByServer()[activeServerSidebarKey()] ?? []);

  async function mutateSidebarLayout(action: SidebarLayoutAction): Promise<void> {
    const layout = await window.openbot.agent.mutateSidebarLayout(action);
    setSidebarLayout(layout);
  }

  function toggleSidebarSection(sectionId: string): void {
    const serverId = activeServerSidebarKey();
    setSidebarCollapsedByServer((current) => {
      const values = new Set(current[serverId] ?? []);
      if (values.has(sectionId)) values.delete(sectionId);
      else values.add(sectionId);
      const next = { ...current };
      if (values.size > 0) next[serverId] = [...values];
      else delete next[serverId];
      writeSidebarCollapsed(next);
      return next;
    });
  }

  function updateActiveServerPins(update: (items: SidebarPinnedItem[]) => SidebarPinnedItem[]): void {
    const serverId = activeServerSidebarKey();
    setSidebarPinsByServer((current) => {
      const items = normalizeSidebarPinnedItems(update(current[serverId] ?? []));
      const next = { ...current };
      if (items.length > 0) next[serverId] = items;
      else delete next[serverId];
      writeSidebarPins(next);
      return next;
    });
  }

  function pinSidebarItem(item: SidebarPinnedItem): void {
    updateActiveServerPins((items) =>
      items.length >= MAX_SIDEBAR_PINNED_ITEMS ||
      items.some((candidate) => sidebarPinnedItemKey(candidate) === sidebarPinnedItemKey(item))
        ? items
        : [...items, item],
    );
  }

  function unpinSidebarItem(item: SidebarPinnedItem): void {
    const key = sidebarPinnedItemKey(item);
    updateActiveServerPins((items) => items.filter((candidate) => sidebarPinnedItemKey(candidate) !== key));
  }

  function reorderPinnedSidebarItems(items: SidebarPinnedItem[]): void {
    updateActiveServerPins(() => items);
  }

  function reorderSidebarPeople(memberIds: string[]): void {
    const serverId = activeServerSidebarKey();
    setSidebarPeopleOrderByServer((current) => {
      const order = normalizeSidebarPeopleOrder(memberIds);
      const next = { ...current };
      if (order.length > 0) next[serverId] = order;
      else delete next[serverId];
      writeSidebarPeopleOrder(next);
      return next;
    });
  }

  function removePinnedSidebarItemEverywhere(item: SidebarPinnedItem): void {
    const key = sidebarPinnedItemKey(item);
    setSidebarPinsByServer((current) => {
      const next = Object.fromEntries(
        Object.entries(current).flatMap(([serverId, items]) => {
          const filtered = items.filter((candidate) => sidebarPinnedItemKey(candidate) !== key);
          return filtered.length > 0 ? [[serverId, filtered]] : [];
        }),
      );
      writeSidebarPins(next);
      return next;
    });
  }
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

  return {
    props,
    setupLoaded,
    appInfo,
    visibleSignedInAccount,
    signedInAccount,
    centralAuth,
    retryCentralAccount,
    requestEmailCode,
    verifyEmailCode,
    logoutCentralAccount,
    setupState,
    pendingInviteUrl,
    agentStatus,
    saveSetup,
    previewInvite,
    joinRemoteDuringSetup,
    leftPanelCompact,
    remoteDesktopWorkspaceVisible,
    LEFT_PANEL_COMPACT,
    leftPanelWidth,
    servers,
    selectServer,
    reorderServers,
    setJoinServerOpen,
    openServerSettings,
    activeServer,
    botList,
    activeDirectMemberId,
    activeBot,
    directPeople,
    directThreads,
    sidebarAgentStates,
    sidebarLayout,
    collapsedSidebarSectionIds,
    mutateSidebarLayout,
    toggleSidebarSection,
    pinnedSidebarItems,
    sidebarPeopleOrder,
    pinSidebarItem,
    unpinSidebarItem,
    reorderPinnedSidebarItems,
    reorderSidebarPeople,
    selectBot,
    selectDirectMember,
    openBotSetup,
    cancelBotSetup,
    editBot,
    deleteBot,
    setSidebarCollapsed,
    expandSidebar,
    accountUsage,
    updateStatus,
    refreshAccountUsage,
    runUpdateAction,
    updateAccountAvatar,
    setPermissionsOpen,
    skillsMarketplaceOpen,
    setSkillsMarketplaceOpen,
    openInstalledMarketplaceAgent,
    LEFT_PANEL_DEFAULT,
    LEFT_PANEL_MIN,
    LEFT_PANEL_MAX,
    LEFT_PANEL_STORAGE_KEY,
    LEFT_PANEL_COLLAPSE_THRESHOLD,
    LEFT_PANEL_EXPAND_THRESHOLD,
    setLeftPanelWidth,
    activeDirectMember,
    currentTeamMember,
    directConversations,
    directConversationLoading,
    directConversationError,
    directConversationPages,
    directOlderLoading,
    directOlderErrors,
    directTypingMemberIds,
    sendDirectMessage,
    markDirectMessagesRead,
    loadOlderDirectMessages,
    openDirectMessage,
    setDirectTyping,
    modelOptions,
    activeMessages,
    conversationReferences,
    conversationReads,
    conversationLoaded,
    conversationPages,
    conversationWindowModes,
    conversationOlderLoading,
    conversationOlderErrors,
    activeQueue,
    browserTabs,
    activeBrowserTabId,
    browserControlState,
    teamPresence,
    activeRemoteDesktopSession,
    pendingPrompts,
    pendingApprovals,
    activeTurns,
    botSetupOpen,
    botSetupDraft,
    setBotSetupDraft,
    botSetupError,
    globalSearchOpen,
    creatingAgent,
    settingsRequest,
    messageFocusRequest,
    createAgent,
    updateBot,
    setAgentAvatar,
    sendMessage,
    markAgentMessagesRead,
    loadOlderAgentMessages,
    loadLatestAgentMessages,
    searchAgentMessages,
    openAgentMessage,
    setTeamTyping,
    answerPrompt,
    respondToApproval,
    cancelQueuedMessage,
    steerQueuedMessage,
    updateQueuedMessage,
    reorderQueue,
    activateBrowserTab,
    closeBrowserTab,
    openRemoteDesktopWorkspace,
    stopActiveTurn,
    permissionsOpen,
    joinServerOpen,
    setPendingInviteUrl,
    joinServer,
    serverSettingsTarget,
    serverSettingsOpen,
    setServerSettingsOpen,
    serverSettingsRestoreTarget: () => serverSettingsRestoreTarget,
    hostStatus,
    serverSettingsMembers,
    serverSettingsInvites,
    serverSettingsLoading,
    serverSettingsError,
    refreshServerSettings,
    saveServerIdentity,
    setServerPublished,
    createServerInvite,
    updateServerMember,
    removeServerMember,
    revokeServerInvite,
    searchGlobalMessages,
    setGlobalSearchVisibility,
    selectGlobalSearchMessage,
    remoteDesktopWorkspaceServer,
    remoteDesktopWorkspaceSession,
    remoteDesktopConnectingServerId,
    remoteDesktopConnectionError,
    hideRemoteDesktopWorkspace,
    disconnectRemoteDesktopWorkspace,
    retryRemoteDesktopWorkspace,
    selectRemoteDesktopDisplay,
    setAppFrameElement: (element: HTMLDivElement) => {
      appFrameElement = element;
    },
  };
}

export type AppController = ReturnType<typeof createAppController>;

const AppControllerContext = createContext<AppController>();

export function useAppController(): AppController {
  const controller = useContext(AppControllerContext);
  if (!controller) throw new Error("App controller is unavailable outside App.");
  return controller;
}

/** @internal Test seam for remounting shell views without remounting their controller. */
export function AppControllerProvider(props: ParentProps<{ controller: AppController }>) {
  return <AppControllerContext value={props.controller}>{props.children}</AppControllerContext>;
}

export function App(props: AppProps = {}) {
  const controller = createAppController(props);
  return (
    <>
      <AppControllerProvider controller={controller}>
        <AppAccessGate />
      </AppControllerProvider>
      <Toaster />
    </>
  );
}
