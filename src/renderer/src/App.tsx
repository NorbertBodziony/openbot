import type {
  AccountUsage,
  AgentApproval,
  AgentEvent,
  AgentModelOption,
  AgentProviderId,
  AgentRuntimeSnapshot,
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
  DynamicIslandAction,
  HostStatus,
  InviteSummary,
  ProviderRuntimeSnapshot,
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
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettingsValue } from "./app-settings";
import { playCompletionSoundForAgentEvent } from "./completion-sound";
import { createFirstBotDraft, type FirstBotDraft } from "./components/FirstBotSetup";
import { readPanelWidth } from "./components/PanelResizer";
import type { SidebarAgentState } from "./components/Sidebar";
import { Toaster } from "./components/ui";
import type { BotMessage, BotProfile } from "./data";
import { DynamicIslandCoordinator } from "./dynamic-island-coordinator";
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
    { id: "grok", state: "not-started", version: null, message: null },
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
  errorCode: null,
};
const FALLBACK_PROVIDER_RUNTIMES: ProviderRuntimeSnapshot = {
  revision: -1,
  providers: {
    codex: { phase: "not-downloaded", progress: null, message: null, version: null },
    claude: { phase: "not-downloaded", progress: null, message: null, version: null },
    grok: { phase: "not-downloaded", progress: null, message: null, version: null },
  },
};
const ANALYTICS_APP_VERSION_STORAGE_KEY = "openbot:analytics-app-version";

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
type BrowserTakeoverEvent = Extract<AgentEvent, { type: "browser-takeover-requested" }>;

function promptRequestKey(turnId: string | undefined, requestId: string | number | undefined): string | null {
  if (!turnId || requestId === undefined) return null;
  return JSON.stringify([turnId, String(requestId)]);
}

function messagePromptRequestKey(message: {
  turnId?: string;
  questionPrompt?: { requestId: string | number };
}): string | null {
  return promptRequestKey(message.turnId, message.questionPrompt?.requestId);
}

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

function authFailureCode(value: string | undefined): string {
  switch (value) {
    case "auth_api_error":
    case "code_recently_sent":
    case "email_delivery_failed":
    case "email_delivery_not_configured":
    case "email_sign_in_failed":
    case "email_sign_in_start_failed":
    case "invalid_email":
    case "invalid_sign_in_code":
    case "rate_limited":
    case "sign_in_code_expired":
    case "too_many_code_attempts":
    case "unauthorized":
      return value;
    default:
      return "unknown";
  }
}

export function createBotInitialMessage(draft: Pick<FirstBotDraft, "purpose">): string {
  return `Your ongoing role is: ${draft.purpose.trim()}`;
}

interface AppProps {
  landingPreview?: boolean;
  peopleEnabled?: boolean;
}

export function createAppController(props: AppProps = {}) {
  const peopleEnabled = props.peopleEnabled === true;
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
  const [failedTurns, setFailedTurns] = createSignal<Record<string, string | undefined>>({});
  const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
  const [conversationReads, setConversationReads] = createSignal<Record<string, ConversationReadState>>({});
  const [recentReplies, setRecentReplies] = createSignal<Record<string, boolean>>({});
  const [queues, setQueues] = createSignal<Record<string, QueueSnapshot>>({});
  const [browserTabs, setBrowserTabs] = createSignal<BrowserTab[]>([]);
  const [activeBrowserTabId, setActiveBrowserTabId] = createSignal<string | null>(null);
  let browserChangeRevision = 0;
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
  const [pendingPrompts, setPendingPrompts] = createSignal<
    Record<string, PromptEvent | BrowserTakeoverEvent | undefined>
  >({});
  const [presentedPromptResolutions, setPresentedPromptResolutions] = createSignal<Record<string, string | undefined>>(
    {},
  );
  const [submittedPromptRequests, setSubmittedPromptRequests] = createSignal<Record<string, string | undefined>>({});
  const [pendingApprovals, setPendingApprovals] = createSignal<Record<string, AgentApproval | undefined>>({});
  const [appInfo, setAppInfo] = createSignal<AppInfo | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
  const [refreshingProviders, setRefreshingProviders] = createSignal(false);
  const [accountUsage, setAccountUsage] = createSignal<AccountUsage | null>(null);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateStatus>(FALLBACK_UPDATE_STATUS);
  const [providerRuntimeSnapshot, setProviderRuntimeSnapshot] =
    createSignal<ProviderRuntimeSnapshot>(FALLBACK_PROVIDER_RUNTIMES);
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
  const [analyticsPreferenceLoaded, setAnalyticsPreferenceLoaded] = createSignal<boolean | null>(null);
  const [centralAuth, setCentralAuth] = createSignal<CentralAuthState>({
    status: "loading",
  });
  const [authSuccessVisible, setAuthSuccessVisible] = createSignal(false);
  const [permissionsOpen, setPermissionsOpen] = createSignal(false);
  const [skillsMarketplaceOpen, setSkillsMarketplaceOpen] = createSignal(false);
  const [appSettingsOpen, setAppSettingsOpen] = createSignal(false);
  const [generalSettings, setGeneralSettings] = createSignal<GeneralSettingsValue>(DEFAULT_GENERAL_SETTINGS);
  const [servers, setServers] = createSignal<ServerSummary[]>([]);
  const [dynamicIslandLoadedServerId, setDynamicIslandLoadedServerId] = createSignal<string | null>(null);
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
  const queueSnapshotRequests = new Map<string, number>();
  const completedTurnByBot = new Map<string, string>();
  const pendingProviderConnections = new Map<AgentProviderId, ReturnType<typeof desktopAnalytics.scope>>();
  const dynamicIslandCoordinator = new DynamicIslandCoordinator();
  const dynamicIslandConnectedServers = new Set(["local"]);
  let conversationFrame: number | undefined;
  let dynamicIslandPresentationFrame: number | undefined;
  let directConversationRequest = 0;
  let serverSettingsRequest = 0;
  let serverSettingsRestoreTarget: HTMLElement | null = null;
  let appSettingsRestoreTarget: HTMLElement | null = null;
  let appFrameElement: HTMLDivElement | undefined;
  let remoteDesktopRestoreTarget: HTMLElement | null = null;
  let remoteDesktopConnectPromise: Promise<RemoteDesktopSession | undefined> | null = null;
  let remoteDesktopConnectionRequest = 0;
  let authSuccessTimer: ReturnType<typeof setTimeout> | undefined;
  let analyticsOpened = false;
  let analyticsVersionRecorded = false;
  let appInfoLoadedFromHost = false;

  function analyticsAgentProperties(botId: string) {
    const bot = botList().find((candidate) => candidate.id === botId);
    if (!bot) return null;
    const server = servers().find((candidate) => candidate.active);
    return {
      provider: bot.provider,
      model: bot.model,
      reasoning_effort: bot.reasoningEffort,
      server_kind: server?.kind ?? ("unknown" as const),
    };
  }

  createEffect(
    () => ({
      info: appInfo(),
      setup: setupState(),
      auth: centralAuth(),
      analyticsEnabled: analyticsPreferenceLoaded(),
    }),
    ({ info, setup, auth, analyticsEnabled }) => {
      if (analyticsEnabled === null) return;
      desktopAnalytics.setTrackingEnabled(analyticsEnabled);
      desktopAnalytics.setUser(auth.status === "signed_in" ? auth.user : null);
      if (!appInfoLoadedFromHost || !info || !setup || auth.status === "loading") return;
      if (!desktopAnalytics.configure(info)) return;
      if (!analyticsVersionRecorded) {
        analyticsVersionRecorded = true;
        try {
          const previousVersion = window.localStorage.getItem(ANALYTICS_APP_VERSION_STORAGE_KEY);
          if (previousVersion && previousVersion !== info.version) {
            desktopAnalytics.track("app_updated", { from_version: previousVersion, to_version: info.version });
          }
          window.localStorage.setItem(ANALYTICS_APP_VERSION_STORAGE_KEY, info.version);
        } catch {
          // Version attribution is optional and must not block startup.
        }
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
    desktopAnalytics.setUser(state.status === "signed_in" ? state.user : null);
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

  function updateGeneralSettings(value: GeneralSettingsValue): void {
    const previous = generalSettings();
    setGeneralSettings(value);
    if (previous.productAnalytics !== value.productAnalytics) {
      desktopAnalytics.setTrackingEnabled(value.productAnalytics);
      setAnalyticsPreferenceLoaded(value.productAnalytics);
      void window.openbot
        .setAnalyticsPreference({ enabled: value.productAnalytics })
        .then((preference) => {
          desktopAnalytics.setTrackingEnabled(preference.enabled);
          setAnalyticsPreferenceLoaded(preference.enabled);
          setGeneralSettings((current) => ({ ...current, productAnalytics: preference.enabled }));
        })
        .catch(() => {
          desktopAnalytics.setTrackingEnabled(previous.productAnalytics);
          setAnalyticsPreferenceLoaded(previous.productAnalytics);
          setGeneralSettings((current) => ({ ...current, productAnalytics: previous.productAnalytics }));
        });
    }
    if (
      previous.macBookNotch !== value.macBookNotch ||
      previous.macBookNotchHaptics !== value.macBookNotchHaptics ||
      previous.macBookNotchIdle !== value.macBookNotchIdle ||
      previous.macBookNotchAdditionalDisplays !== value.macBookNotchAdditionalDisplays
    ) {
      void window.openbot.dynamicIsland
        .setPreference({
          enabled: value.macBookNotch,
          hapticsEnabled: value.macBookNotchHaptics,
          idleVisible: value.macBookNotchIdle,
          additionalDisplaysEnabled: value.macBookNotchAdditionalDisplays,
        })
        .then((preference) =>
          setGeneralSettings((current) => ({
            ...current,
            macBookNotch: preference.enabled,
            macBookNotchHaptics: preference.hapticsEnabled,
            macBookNotchIdle: preference.idleVisible,
            macBookNotchAdditionalDisplays: preference.additionalDisplaysEnabled,
          })),
        )
        .catch(() =>
          setGeneralSettings((current) => ({
            ...current,
            macBookNotch: previous.macBookNotch,
            macBookNotchHaptics: previous.macBookNotchHaptics,
            macBookNotchIdle: previous.macBookNotchIdle,
            macBookNotchAdditionalDisplays: previous.macBookNotchAdditionalDisplays,
          })),
        );
    }
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
  const activeDirectMember = createMemo(() =>
    peopleEnabled ? directPeople().find((member) => member.id === activeDirectMemberId()) : undefined,
  );
  const activeBot = createMemo(() => {
    if (activeDirectMember()) return undefined;
    return botList().find((bot) => bot.id === activeBotId()) ?? botList()[0];
  });
  const activeMessages = createMemo(() => {
    const bot = activeBot();
    if (!bot) return [];
    const prompt = pendingPrompts()[bot.id];
    const requestKey = prompt?.type === "prompt" ? promptRequestKey(prompt.turnId, prompt.requestId) : null;
    const messages = (liveMessages()[bot.id] ?? []).filter(
      (message) =>
        message.questionPrompt?.resolution !== null && (!requestKey || messagePromptRequestKey(message) !== requestKey),
    );
    return [...messages, ...(uiErrors()[bot.id] ?? [])];
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
      if (!peopleEnabled) return;
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
    const unsubscribeScopedAgent = window.openbot.agent.onScopedEvent((event) => {
      flush(() => {
        const server = servers().find((candidate) => candidate.id === event.serverId);
        if (server?.kind === "remote" && server.state !== "online") return;
        dynamicIslandConnectedServers.add(event.serverId);
        dynamicIslandCoordinator.applyEvent(event, activeServerSidebarKey());
        publishDynamicIslandPresentation();
      });
    });
    const unsubscribeUpdate = window.openbot.update.onEvent((status) => {
      flush(() => setUpdateStatus(status));
    });
    const unsubscribeProviderRuntimes =
      window.openbot.providerRuntimes?.onEvent((snapshot) => {
        flush(() => applyProviderRuntimeSnapshot(snapshot));
      }) ?? (() => undefined);
    const unsubscribeAuth = window.openbot.auth.onEvent((state) => {
      flush(() => applyCentralAuthState(state));
    });
    const unsubscribeServers = window.openbot.servers.onEvent((value) => flush(() => setServers(value)));
    const unsubscribePresence = window.openbot.servers.onPresence((snapshot) => flush(() => setTeamPresence(snapshot)));
    const unsubscribeDirectMessage = peopleEnabled
      ? window.openbot.servers.onDirectMessage((event) => flush(() => handleDirectMessageEvent(event)))
      : () => undefined;
    const unsubscribeDirectTyping = peopleEnabled
      ? window.openbot.servers.onDirectTyping((event) => flush(() => handleDirectTypingEvent(event)))
      : () => undefined;
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
      unsubscribeScopedAgent();
      unsubscribeUpdate();
      unsubscribeProviderRuntimes();
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
      if (dynamicIslandPresentationFrame !== undefined) cancelAnimationFrame(dynamicIslandPresentationFrame);
      for (const timer of recentReplyTimers.values()) clearTimeout(timer);
      recentReplyTimers.clear();
      completedTurnByBot.clear();
      pendingProviderConnections.clear();
      if (authSuccessTimer !== undefined) clearTimeout(authSuccessTimer);
    };
    void window.openbot.update
      .getStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    void window.openbot.providerRuntimes
      ?.getStatus()
      .then(applyProviderRuntimeSnapshot)
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
    void window.openbot
      .getAnalyticsPreference()
      .then((preference) => {
        setAnalyticsPreferenceLoaded(preference.enabled);
        setGeneralSettings((current) => ({ ...current, productAnalytics: preference.enabled }));
      })
      .catch(() => {
        setAnalyticsPreferenceLoaded(false);
        setGeneralSettings((current) => ({ ...current, productAnalytics: false }));
      });
    void window.openbot.dynamicIsland
      .getPreference()
      .then((preference) =>
        setGeneralSettings((current) => ({
          ...current,
          macBookNotch: preference.enabled,
          macBookNotchHaptics: preference.hapticsEnabled,
          macBookNotchIdle: preference.idleVisible,
          macBookNotchAdditionalDisplays: preference.additionalDisplaysEnabled,
        })),
      )
      .catch(() => undefined);
    void window.openbot.servers
      .takePendingInvite()
      .then((inviteUrl) => inviteUrl && receiveInvite(inviteUrl))
      .catch(() => undefined);

    void window.openbot
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
      );
    const initialServerReady = window.openbot.servers
      .list()
      .then(setServers)
      .catch(() => undefined);
    void initialServerReady.then(() => {
      const loadingServerId = activeServerSidebarKey();
      void Promise.all([
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
      ]).finally(() => {
        if (activeServerSidebarKey() === loadingServerId) setDynamicIslandLoadedServerId(loadingServerId);
      });
      if (!props.landingPreview) {
        const requestedAtRevision = browserChangeRevision;
        void window.openbot.browser
          .listTabs()
          .then((tabs) => {
            if (browserChangeRevision !== requestedAtRevision) return;
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
        .getPresence()
        .then(setTeamPresence)
        .catch(() => undefined);
      void refreshDirectThreads();
    });
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
      const queueRequest = (queueSnapshotRequests.get(botId) ?? 0) + 1;
      queueSnapshotRequests.set(botId, queueRequest);
      void Promise.all([
        window.openbot.agent.readConversationPage({ botId, anchor: { type: "latest" }, limit: 50 }),
        window.openbot.agent.listQueue(botId),
      ])
        .then(([page, queue]) => {
          if (conversationPageRequests.get(botId) !== pageRequest) return;
          if (queueSnapshotRequests.get(botId) === queueRequest) {
            setQueues((current) => ({ ...current, [botId]: queue }));
          }
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
        applyAgentStatus(event.status);
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
        queueSnapshotRequests.set(event.snapshot.botId, (queueSnapshotRequests.get(event.snapshot.botId) ?? 0) + 1);
        setQueues((current) => ({
          ...current,
          [event.snapshot.botId]: event.snapshot,
        }));
        return;
      case "browser-changed":
        if (props.landingPreview) return;
        browserChangeRevision += 1;
        setBrowserTabs(event.tabs);
        setActiveBrowserTabId(event.activeTabId);
        return;
      case "browser-control-changed":
        if (props.landingPreview) return;
        setBrowserControlState(event.state);
        return;
      case "turn-started":
        completedTurnByBot.delete(event.botId);
        clearRecentReply(event.botId);
        setFailedTurns((current) => withoutBot(current, event.botId));
        setActiveTurns((current) => ({
          ...current,
          [event.botId]: event.turnId,
        }));
        return;
      case "turn-completed":
        completedTurnByBot.set(event.botId, event.turnId);
        setFailedTurns((current) =>
          event.status === "failed" ? { ...current, [event.botId]: event.turnId } : withoutBot(current, event.botId),
        );
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
        setPendingPrompts((current) => {
          const pending = current[event.botId];
          const submittedRequestKey = submittedPromptRequests()[event.botId];
          if (
            pending?.type === "prompt" &&
            promptRequestKey(pending.turnId, pending.requestId) === submittedRequestKey
          ) {
            return current;
          }
          return { ...current, [event.botId]: undefined };
        });
        setPendingApprovals((current) => ({ ...current, [event.botId]: undefined }));
        if (event.status === "completed") {
          markReplyCompleted(event.botId);
          playCompletionSoundForAgentEvent(event, botList());
        }
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        setPresentedPromptResolutions((current) => ({ ...current, [event.botId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [event.botId]: undefined }));
        return;
      case "approval":
        setPendingApprovals((current) => ({
          ...current,
          [event.approval.botId]: event.approval,
        }));
        return;
      case "runtime-snapshot":
        applyAgentRuntimeSnapshot(event.snapshot);
        return;
      case "browser-takeover-requested":
        setPendingPrompts((current) => ({
          ...current,
          [event.request.botId]: event,
        }));
        return;
      case "browser-takeover-resolved":
        setPendingPrompts((current) => {
          const pending = current[event.botId];
          return pending?.type === "browser-takeover-requested" && pending.request.requestId === event.requestId
            ? { ...current, [event.botId]: undefined }
            : current;
        });
        return;
      case "error":
        if (event.botId) appendUiError(event.botId, event.message, "Error");
    }
  }

  function applyAgentRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): void {
    applyStoredBots(snapshot.bots);
    setActiveTurns(Object.fromEntries(snapshot.activeTurns.map((turn) => [turn.botId, turn.turnId])));
    setQueues(Object.fromEntries(snapshot.queues.map((queue) => [queue.botId, queue])));
    setPendingPrompts({
      ...Object.fromEntries(snapshot.pendingPrompts.map((prompt) => [prompt.botId, { type: "prompt", ...prompt }])),
      ...Object.fromEntries(
        snapshot.pendingBrowserTakeovers.map((request) => [
          request.botId,
          { type: "browser-takeover-requested", request },
        ]),
      ),
    });
    setPendingApprovals(Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.botId, approval])));
    setFailedTurns(Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.botId, turn.turnId])));
    setLiveMessages((current) => {
      const next = { ...current };
      for (const message of snapshot.latestMessages) {
        const messages = next[message.botId] ?? [];
        if (messages.some((candidate) => candidate.id === message.id)) continue;
        next[message.botId] = [
          ...messages,
          {
            id: message.id,
            author: "bot",
            body: message.text,
            time: message.createdAt,
            createdAt: message.createdAt,
          },
        ];
      }
      return next;
    });
  }

  function applyAgentStatus(status: AgentStatus): void {
    for (const provider of status.providers ?? []) {
      const analytics = pendingProviderConnections.get(provider.id);
      if (!analytics) continue;
      if (provider.state === "available") {
        pendingProviderConnections.delete(provider.id);
        analytics.track("provider_action", {
          provider: provider.id,
          action: "connect_completed",
          result: "succeeded",
        });
      } else if (provider.state === "error") {
        pendingProviderConnections.delete(provider.id);
        analytics.track("provider_action", {
          provider: provider.id,
          action: "connect_completed",
          result: "failed",
          failure_code: "connect_failed",
        });
      }
    }
    setAgentStatus(status);
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
        createdAt: event.createdAt,
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
    const presentedRequestKey = presentedPromptResolutions()[botId];
    const pendingPrompt = pendingPrompts()[botId];
    const pendingRequestKey =
      pendingPrompt?.type === "prompt" ? promptRequestKey(pendingPrompt.turnId, pendingPrompt.requestId) : null;
    const submittedRequestKey = submittedPromptRequests()[botId];
    const resolvedPendingPrompt =
      pendingRequestKey !== null &&
      snapshot.messages.some(
        (message) =>
          messagePromptRequestKey(message) === pendingRequestKey && message.questionPrompt?.resolution !== null,
      );
    if (
      presentedRequestKey &&
      snapshot.messages.some(
        (message) =>
          messagePromptRequestKey(message) === presentedRequestKey && message.questionPrompt?.resolution !== null,
      )
    ) {
      setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
      setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
      setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
    } else if (
      resolvedPendingPrompt &&
      (activeBot()?.id !== botId || !submittedRequestKey || submittedRequestKey !== pendingRequestKey)
    ) {
      setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
      setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
      setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
    }
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
    const analytics = desktopAnalytics.scope();
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
      analytics.track("agent_action", { action: "create", result: "succeeded", ...(properties ?? {}) });
    } catch (error) {
      analytics.track("agent_action", { action: "create", result: "failed", failure_code: "create_failed" });
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
    const analytics = desktopAnalytics.scope();
    try {
      const page = await window.openbot.agent.searchConversationMessages({ query, limit: 100 });
      analytics.track("search_action", { scope: "global", result: "succeeded", result_count: page.total });
      return page.results.map((result) => ({ botId: result.botId, message: toBotMessage(result.message) }));
    } catch (error) {
      analytics.track("search_action", { scope: "global", result: "failed", failure_code: "search_failed" });
      throw error;
    }
  }

  async function searchAgentMessages(botId: string, query: string): Promise<{ messageIds: string[]; total: number }> {
    const analytics = desktopAnalytics.scope();
    try {
      const page = await window.openbot.agent.searchConversationMessages({ query, botId, limit: 100 });
      analytics.track("search_action", { scope: "agent", result: "succeeded", result_count: page.total });
      return { messageIds: page.results.map((result) => result.message.id), total: page.total };
    } catch (error) {
      analytics.track("search_action", { scope: "agent", result: "failed", failure_code: "search_failed" });
      throw error;
    }
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
      try {
        let readBoundary = page.messages.at(-1)?.id ?? messageId;
        try {
          const latestPage = await window.openbot.agent.readConversationPage({
            botId,
            anchor: { type: "latest" },
            limit: 1,
          });
          readBoundary = latestPage.messages.at(-1)?.id ?? readBoundary;
        } catch {
          // The focused page still gives us a safe read boundary when the latest-page refresh fails.
        }
        await markAgentMessagesRead(botId, readBoundary);
      } catch (error) {
        appendUiError(botId, error, "Read state failed");
      }
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
    if (!peopleEnabled || !currentTeamMember() || !directPeople().some((member) => member.id === memberId)) return;
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
    const analytics = desktopAnalytics.scope();
    const serverKind = servers().find((server) => server.active)?.kind ?? "unknown";
    let message: DirectMessage;
    try {
      message = await window.openbot.servers.sendDirectMessage({
        memberId,
        text,
        clientMessageId,
      });
    } catch (error) {
      analytics.track("message_send", {
        channel: "direct",
        attachment_count: 0,
        is_reply: false,
        result: "failed",
        failure_code: "send_failed",
        server_kind: serverKind,
      });
      throw error;
    }
    mergeDirectMessage(memberId, message);
    analytics.track("message_send", {
      channel: "direct",
      attachment_count: 0,
      is_reply: false,
      result: "succeeded",
      delivery_count: 1,
      server_kind: serverKind,
    });
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
    const analytics = desktopAnalytics.scope();
    void window.openbot.browser
      .activate(tabId)
      .then(() => analytics.track("browser_action", { action: "activate", result: "succeeded" }))
      .catch(() =>
        analytics.track("browser_action", {
          action: "activate",
          result: "failed",
          failure_code: "browser_activate_failed",
        }),
      );
  }

  async function closeBrowserTab(tabId: string) {
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.browser.close(tabId);
      analytics.track("browser_action", { action: "close", result: "succeeded" });
    } catch (error) {
      analytics.track("browser_action", {
        action: "close",
        result: "failed",
        failure_code: "browser_close_failed",
      });
      throw error;
    }
  }

  async function updateBot(botId: string, updates: Omit<UpdateBotInput, "botId">) {
    const analytics = desktopAnalytics.scope();
    const properties = analyticsAgentProperties(botId);
    const changedFields = Object.keys(updates);
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
      analytics.track("agent_action", {
        action: "update",
        changed_fields: changedFields,
        result: "succeeded",
        ...(properties ?? {}),
      });
    } catch (error) {
      analytics.track("agent_action", {
        action: "update",
        changed_fields: changedFields,
        result: "failed",
        failure_code: "update_failed",
        ...(properties ?? {}),
      });
      appendUiError(botId, error, "Settings failed");
      throw error;
    }
  }

  async function setAgentAvatar(botId: string, image: AvatarImageInput | null): Promise<void> {
    const analytics = desktopAnalytics.scope();
    const properties = analyticsAgentProperties(botId);
    try {
      const stored = await window.openbot.agent.setAvatar({ botId, image });
      const next = toBotProfile(stored);
      setBotList((current) => {
        const existing = current.find((bot) => bot.id === botId);
        if (!existing) return [...current, createStoredProfile(next)];
        updateStored(existing, next);
        return current;
      });
      analytics.track("agent_action", {
        action: "update",
        changed_fields: ["avatar"],
        result: "succeeded",
        ...(properties ?? {}),
      });
    } catch (error) {
      analytics.track("agent_action", {
        action: "update",
        changed_fields: ["avatar"],
        result: "failed",
        failure_code: "avatar_update_failed",
        ...(properties ?? {}),
      });
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
    const analytics = desktopAnalytics.scope();
    const properties = analyticsAgentProperties(botId);
    const marketplaceAgent = Boolean(botList().find((bot) => bot.id === botId)?.marketplaceSource);
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
      setFailedTurns((current) => withoutBot(current, botId));
      setUnreadReplies((current) => withoutBot(current, botId));
      setConversationReads((current) => withoutBot(current, botId));
      setRecentReplies((current) => withoutBot(current, botId));
      setQueues((current) => withoutBot(current, botId));
      setPendingPrompts((current) => withoutBot(current, botId));
      removePinnedSidebarItemEverywhere({ kind: "agent", id: botId });
      const replyTimer = recentReplyTimers.get(botId);
      if (replyTimer) clearTimeout(replyTimer);
      recentReplyTimers.delete(botId);
      analytics.track("agent_action", { action: "delete", result: "succeeded", ...(properties ?? {}) });
      if (marketplaceAgent) {
        analytics.track("marketplace_action", { entity: "agent", action: "uninstall", result: "succeeded" });
      }
    } catch (error) {
      analytics.track("agent_action", {
        action: "delete",
        result: "failed",
        failure_code: "delete_failed",
        ...(properties ?? {}),
      });
      if (marketplaceAgent) {
        analytics.track("marketplace_action", {
          entity: "agent",
          action: "uninstall",
          result: "failed",
          failure_code: "uninstall_failed",
        });
      }
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
    const analytics = desktopAnalytics.scope();
    const properties = analyticsAgentProperties(botId);
    try {
      const receipt = await window.openbot.agent.sendMessage({
        botId,
        text: body.trim(),
        attachmentDraftIds,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      });
      setUiErrors((current) => ({ ...current, [botId]: [] }));
      analytics.track("message_send", {
        ...(properties ?? {}),
        channel: "agent",
        attachment_count: attachmentDraftIds.length,
        is_reply: replyToMessageId !== null,
        result: "succeeded",
        delivery_count: receipt.deliveries.length,
      });
      try {
        await markAgentMessagesRead(botId, receipt.deliveries[0]?.id ?? receipt.messageId);
      } catch (error) {
        appendUiError(botId, error, "Read state failed");
      }
      return true;
    } catch (error) {
      analytics.track("message_send", {
        ...(properties ?? {}),
        channel: "agent",
        attachment_count: attachmentDraftIds.length,
        is_reply: replyToMessageId !== null,
        result: "failed",
        failure_code: "send_failed",
      });
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
    if (!bot || prompt?.type !== "prompt") return false;
    return submitPromptAnswers(bot.id, prompt, answers);
  }

  async function submitPromptAnswers(
    botId: string,
    prompt: PromptEvent,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const analytics = desktopAnalytics.scope();
    setSubmittedPromptRequests((current) => ({
      ...current,
      [botId]: promptRequestKey(prompt.turnId, prompt.requestId) ?? undefined,
    }));
    try {
      await window.openbot.agent.respondToPrompt({
        requestId: prompt.requestId,
        answers,
      });
      analytics.track("agent_input_action", {
        kind: "prompt",
        decision: "answered",
        result: "succeeded",
      });
      return true;
    } catch (error) {
      setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
      analytics.track("agent_input_action", {
        kind: "prompt",
        decision: "answered",
        result: "failed",
        failure_code: "response_failed",
      });
      appendUiError(botId, error, "Answer failed");
      return false;
    }
  }

  function presentPromptResolution(botId: string, turnId: string, requestId: string | number): void {
    const requestKey = promptRequestKey(turnId, requestId);
    if (!requestKey) return;
    const currentPrompt = pendingPrompts()[botId];
    if (
      currentPrompt?.type !== "prompt" ||
      promptRequestKey(currentPrompt.turnId, currentPrompt.requestId) !== requestKey
    ) {
      return;
    }
    const persisted = (liveMessages()[botId] ?? []).some(
      (message) => messagePromptRequestKey(message) === requestKey && message.questionPrompt?.resolution !== null,
    );
    if (persisted) {
      setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
      setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
      setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
      return;
    }
    setPresentedPromptResolutions((current) => ({ ...current, [botId]: requestKey }));
  }

  async function respondToApprovalRequest(
    botId: string,
    requestId: string | number,
    decision: "accept" | "decline",
  ): Promise<boolean> {
    const approval = pendingApprovals()[botId];
    if (!approval || String(approval.requestId) !== String(requestId)) return false;
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.agent.respondToApproval({
        requestId: approval.requestId,
        decision,
      });
      setPendingApprovals((current) => ({ ...current, [botId]: undefined }));
      analytics.track("agent_input_action", { kind: "approval", decision, result: "succeeded" });
      return true;
    } catch (error) {
      analytics.track("agent_input_action", {
        kind: "approval",
        decision,
        result: "failed",
        failure_code: "response_failed",
      });
      appendUiError(botId, error, "Approval failed");
      return false;
    }
  }

  async function respondToApproval(decision: "accept" | "decline"): Promise<boolean> {
    const bot = activeBot();
    const approval = bot ? pendingApprovals()[bot.id] : undefined;
    if (!bot || !approval) return false;
    return respondToApprovalRequest(bot.id, approval.requestId, decision);
  }

  async function respondToBrowserTakeover(decision: "complete" | "cancel"): Promise<boolean> {
    const bot = activeBot();
    const event = bot ? pendingPrompts()[bot.id] : undefined;
    if (!bot || event?.type !== "browser-takeover-requested") return false;
    try {
      await window.openbot.agent.respondToBrowserTakeover({ requestId: event.request.requestId, decision });
      setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
      return true;
    } catch (error) {
      appendUiError(bot.id, error, "Browser takeover failed");
      return false;
    }
  }

  function cancelQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    if (!bot) return;
    const analytics = desktopAnalytics.scope();
    void window.openbot.agent
      .cancelQueuedMessage({ botId: bot.id, deliveryId })
      .then(() => analytics.track("queue_action", { action: "cancel", result: "succeeded" }))
      .catch((error) => {
        analytics.track("queue_action", { action: "cancel", result: "failed", failure_code: "cancel_failed" });
        appendUiError(bot.id, error, "Cancel failed");
      });
  }

  function steerQueuedMessage(deliveryId: string) {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    const analytics = desktopAnalytics.scope();
    void window.openbot.agent
      .steerQueuedMessage({ botId: bot.id, deliveryId, expectedTurnId: turnId })
      .then(() => analytics.track("queue_action", { action: "steer", result: "succeeded" }))
      .catch((error) => {
        analytics.track("queue_action", { action: "steer", result: "failed", failure_code: "steer_failed" });
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
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.agent.updateQueuedMessage({
        botId: bot.id,
        deliveryId,
        text,
        keepAttachmentIds,
        attachmentDraftIds,
      });
      analytics.track("queue_action", { action: "edit", result: "succeeded" });
      return true;
    } catch (error) {
      analytics.track("queue_action", { action: "edit", result: "failed", failure_code: "edit_failed" });
      appendUiError(bot.id, error, "Edit failed");
      return false;
    }
  }

  function reorderQueue(deliveryIds: string[]) {
    const bot = activeBot();
    if (!bot) return;
    const analytics = desktopAnalytics.scope();
    void window.openbot.agent
      .reorderQueue({ botId: bot.id, deliveryIds })
      .then(() => analytics.track("queue_action", { action: "reorder", result: "succeeded" }))
      .catch((error) => {
        analytics.track("queue_action", { action: "reorder", result: "failed", failure_code: "reorder_failed" });
        appendUiError(bot.id, error, "Reorder failed");
      });
  }

  function stopActiveTurn() {
    const bot = activeBot();
    const turnId = bot ? activeTurns()[bot.id] : null;
    if (!bot || !turnId) return;
    const analytics = desktopAnalytics.scope();
    void window.openbot.agent
      .interrupt({ botId: bot.id, turnId })
      .then(() => analytics.track("queue_action", { action: "interrupt", result: "succeeded" }))
      .catch((error) => {
        analytics.track("queue_action", {
          action: "interrupt",
          result: "failed",
          failure_code: "interrupt_failed",
        });
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
    const analytics = desktopAnalytics.scope();
    const state = await window.openbot.saveSetup({ preferredProvider });
    flush(() => {
      setSetupState(state);
      setPermissionsOpen(false);
    });
    if (!wasCompleted && state.completed) {
      analytics.track("onboarding_completed", { preferred_provider: preferredProvider });
    }
  }

  function openProviderInstallGuide(provider: AgentProviderId): Promise<void> {
    if (provider !== "claude")
      return Promise.reject(new Error(`${provider === "codex" ? "ChatGPT" : "Grok"} is included with OpenBot.`));
    return window.openbot.openExternal("claude-install");
  }

  function openProviderSignInGuide(provider: AgentProviderId): Promise<void> {
    if (provider === "codex") return connectChatGPT();
    if (provider === "claude") return window.openbot.openExternal("claude-sign-in");
    return connectGrok();
  }

  function applyProviderRuntimeSnapshot(snapshot: ProviderRuntimeSnapshot): void {
    setProviderRuntimeSnapshot((current) => {
      if (snapshot.revision < current.revision) return current;
      for (const provider of ["codex", "claude", "grok"] as const) {
        const previousPhase = current.providers[provider].phase;
        const nextPhase = snapshot.providers[provider].phase;
        if (previousPhase !== "downloading" && previousPhase !== "finishing") continue;
        if (nextPhase === "ready") {
          desktopAnalytics.scope().track("provider_action", {
            provider,
            action: "download_completed",
            result: "succeeded",
          });
        } else if (nextPhase === "download-error") {
          desktopAnalytics.scope().track("provider_action", {
            provider,
            action: "download_completed",
            result: "failed",
            failure_code: "runtime_download_failed",
          });
        }
      }
      return snapshot;
    });
  }

  async function downloadProviderRuntime(provider: AgentProviderId): Promise<void> {
    if (!window.openbot.providerRuntimes) throw new Error("Provider downloads are unavailable.");
    const analytics = desktopAnalytics.scope();
    analytics.track("provider_action", { provider, action: "download_started", result: "succeeded" });
    try {
      applyProviderRuntimeSnapshot(await window.openbot.providerRuntimes.download(provider));
    } catch (error) {
      analytics.track("provider_action", {
        provider,
        action: "download_completed",
        result: "failed",
        failure_code: "download_failed",
      });
      throw error;
    }
  }

  async function cancelProviderRuntimeDownload(provider: AgentProviderId): Promise<void> {
    if (!window.openbot.providerRuntimes) throw new Error("Provider downloads are unavailable.");
    applyProviderRuntimeSnapshot(await window.openbot.providerRuntimes.cancel(provider));
    desktopAnalytics.scope().track("provider_action", {
      provider,
      action: "download_cancelled",
      result: "succeeded",
    });
  }

  async function connectChatGPT(): Promise<void> {
    return connectProvider("codex", window.openbot.connectChatGPT);
  }

  async function connectClaude(): Promise<void> {
    return connectProvider("claude", window.openbot.connectClaude);
  }

  async function connectGrok(): Promise<void> {
    return connectProvider("grok", window.openbot.connectGrok);
  }

  async function connectProvider(provider: AgentProviderId, connect: () => Promise<AgentStatus>): Promise<void> {
    if (refreshingProviders()) return;
    const analytics = desktopAnalytics.scope();
    pendingProviderConnections.set(provider, analytics);
    analytics.track("provider_action", { provider, action: "connect_started", result: "succeeded" });
    try {
      const status = await connect();
      flush(() => applyAgentStatus(status));
    } catch (error) {
      pendingProviderConnections.delete(provider);
      analytics.track("provider_action", {
        provider,
        action: "connect_completed",
        result: "failed",
        failure_code: "connect_failed",
      });
      throw error;
    }
  }

  async function refreshAgentProviders(): Promise<void> {
    if (refreshingProviders() || agentStatus().phase === "starting" || agentStatus().phase === "restarting") {
      return;
    }
    const analytics = desktopAnalytics.scope();
    setRefreshingProviders(true);
    try {
      const status = await window.openbot.refreshAgentProviders();
      flush(() => applyAgentStatus(status));
      analytics.track("provider_action", { action: "refresh", result: "succeeded" });
    } catch (error) {
      analytics.track("provider_action", {
        action: "refresh",
        result: "failed",
        failure_code: "refresh_failed",
      });
      throw error;
    } finally {
      flush(() => setRefreshingProviders(false));
    }
  }

  async function requestEmailCode(email: string): Promise<void> {
    const analytics = desktopAnalytics.anonymousScope();
    try {
      const state = await window.openbot.auth.requestEmailCode(email);
      analytics.track("account_sign_in_started", {
        result: state.status === "code_sent" ? "code_sent" : "failed",
        ...(state.status === "error" ? { failure_code: authFailureCode(state.issue.code) } : {}),
      });
      applyCentralAuthState(state);
    } catch (error) {
      analytics.track("account_sign_in_started", {
        result: "failed",
        failure_code: "request_failed",
      });
      throw error;
    }
  }

  async function retryCentralAccount(): Promise<void> {
    applyCentralAuthState({ status: "loading" });
    applyCentralAuthState(await window.openbot.auth.retry());
  }

  async function verifyEmailCode(challengeId: string, code: string): Promise<void> {
    const anonymousAnalytics = desktopAnalytics.anonymousScope();
    try {
      const state = await window.openbot.auth.verifyEmailCode(challengeId, code);
      applyCentralAuthState(state);
      desktopAnalytics.track("account_sign_in_completed", {
        result: state.status === "signed_in" ? "succeeded" : "failed",
        ...("issue" in state ? { failure_code: authFailureCode(state.issue?.code) } : {}),
      });
    } catch (error) {
      anonymousAnalytics.track("account_sign_in_completed", {
        result: "failed",
        failure_code: "verification_failed",
      });
      throw error;
    }
  }

  async function logoutCentralAccount(): Promise<void> {
    const analytics = desktopAnalytics.scope();
    try {
      const state = await window.openbot.auth.logout();
      analytics.track("account_sign_out", { result: "succeeded" });
      applyCentralAuthState(state);
    } catch (error) {
      analytics.track("account_sign_out", {
        result: "failed",
        failure_code: "sign_out_failed",
      });
      throw error;
    }
  }

  async function updateAccountAvatar(image: AvatarImageInput | null): Promise<void> {
    applyCentralAuthState(await window.openbot.auth.updateAvatar(image));
  }

  async function runUpdateAction(): Promise<void> {
    const analytics = desktopAnalytics.scope();
    const phase = updateStatus().phase;
    if (phase === "ready") {
      try {
        await window.openbot.update.install();
        analytics.track("update_action", { action: "install", result: "succeeded", phase: "installing" });
      } catch (error) {
        analytics.track("update_action", {
          action: "install",
          result: "failed",
          failure_code: "install_failed",
        });
        throw error;
      }
      return;
    }
    const action = phase === "available" ? ("download" as const) : ("check" as const);
    try {
      const status =
        action === "download" ? await window.openbot.update.download() : await window.openbot.update.check();
      setUpdateStatus(status);
      const succeeded =
        action === "download"
          ? status.phase === "downloading" || status.phase === "ready"
          : status.phase !== "error" && status.phase !== "unsupported";
      analytics.track("update_action", {
        action,
        result: succeeded ? "succeeded" : "failed",
        phase: status.phase,
        ...(succeeded ? {} : { failure_code: action === "download" ? "download_failed" : "check_failed" }),
      });
    } catch (error) {
      analytics.track("update_action", {
        action,
        result: "failed",
        failure_code: action === "download" ? "download_failed" : "check_failed",
      });
      throw error;
    }
  }

  function openAppSettings(trigger: HTMLElement): void {
    appSettingsRestoreTarget = trigger;
    setAppSettingsOpen(true);
  }

  async function selectServer(serverId: string, trackSelection = true): Promise<void> {
    if (botSetupOpen() && creatingAgent()) return;
    const analytics = desktopAnalytics.scope();
    const previousServerId = servers().find((server) => server.active)?.id;
    if (previousServerId && previousServerId !== serverId) {
      await disconnectRemoteDesktopWorkspace(false);
    }
    directConversationRequest += 1;
    const previousDynamicIslandLoadedServerId = dynamicIslandLoadedServerId();
    setDynamicIslandLoadedServerId(null);
    let nextServers: ServerSummary[];
    try {
      nextServers = await window.openbot.servers.select(serverId);
      if (trackSelection) {
        analytics.track("team_action", {
          action: "server_selected",
          result: "succeeded",
          server_kind: nextServers.find((server) => server.active)?.kind ?? "unknown",
        });
      }
    } catch (error) {
      if (trackSelection) {
        analytics.track("team_action", {
          action: "server_selected",
          result: "failed",
          failure_code: "server_select_failed",
        });
      }
      setDynamicIslandLoadedServerId(previousDynamicIslandLoadedServerId);
      throw error;
    }
    const dynamicIslandState = dynamicIslandCoordinator.serverState(serverId);
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
    setActiveTurns(dynamicIslandState?.activeTurns ?? {});
    setQueues(dynamicIslandState?.queues ?? {});
    setPendingPrompts(dynamicIslandState?.pendingPrompts ?? {});
    setPendingApprovals(dynamicIslandState?.pendingApprovals ?? {});
    setFailedTurns(dynamicIslandState?.failedTurns ?? {});
    setTeamPresence(EMPTY_TEAM_PRESENCE);
    const browserRequestedAtRevision = browserChangeRevision;
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
    if (browserChangeRevision === browserRequestedAtRevision) {
      setBrowserTabs(tabs);
      setActiveBrowserTabId(tabs[0]?.id ?? null);
    }
    setBrowserControlState(controlState);
    setTeamPresence(presence);
    setSidebarLayout(layout);
    applyStoredBots(storedBots);
    applyConversationReads(reads);
    setDynamicIslandLoadedServerId(serverId);
  }

  async function openInstalledMarketplaceAgent(bot: BotSummary): Promise<void> {
    await selectServer("local", false);
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
    const analytics = desktopAnalytics.scope();
    const entryPoint = pendingInviteUrl() ? "invite_deep_link" : "in_app";
    try {
      await window.openbot.servers.join(input);
      setPendingInviteUrl("");
      await selectServer(
        window.openbot ? ((await window.openbot.servers.list()).find((item) => item.active)?.id ?? "local") : "local",
        false,
      );
      analytics.track("team_action", { action: "server_joined", result: "succeeded", entry_point: entryPoint });
    } catch (error) {
      analytics.track("team_action", {
        action: "server_joined",
        result: "failed",
        entry_point: entryPoint,
        failure_code: "join_failed",
      });
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
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    try {
      const status = hostStatus().configured
        ? await window.openbot.host.updateIdentity(input)
        : await window.openbot.host.configure(input);
      analytics.track("team_action", {
        action: "identity_saved",
        result: "succeeded",
        server_kind: "local",
      });
      operationSucceeded = true;
      setHostStatus(status);
      setServers(await window.openbot.servers.list());
      await refreshServerSettings(server.id);
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action: "identity_saved",
          result: "failed",
          server_kind: "local",
          failure_code: "identity_save_failed",
        });
      }
      throw error;
    }
  }

  async function setServerPublished(published: boolean): Promise<void> {
    const server = serverSettingsTarget();
    if (server?.kind !== "local") throw new Error("Only the local server can change publication.");
    const analytics = desktopAnalytics.scope();
    const action = published ? ("published" as const) : ("unpublished" as const);
    let operationSucceeded = false;
    try {
      const status = published ? await window.openbot.host.start() : await window.openbot.host.stop();
      if (published && status.phase !== "online") throw new Error("publish_failed");
      analytics.track("team_action", { action, result: "succeeded", server_kind: "local" });
      operationSucceeded = true;
      setHostStatus(status);
      setServers(await window.openbot.servers.list());
      await refreshServerSettings(server.id);
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action,
          result: "failed",
          server_kind: "local",
          failure_code: published ? "publish_failed" : "unpublish_failed",
        });
      }
      throw error;
    }
  }

  async function createServerInvite(input: { role: "admin" | "member"; email?: string }): Promise<InviteSummary> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    try {
      const invite =
        server.kind === "local"
          ? await window.openbot.host.createInvite(input)
          : await window.openbot.servers.createInvite(server.id, input);
      analytics.track("team_action", {
        action: "invite_created",
        result: "succeeded",
        server_kind: server.kind,
        role: input.role,
        email_bound: Boolean(input.email),
      });
      operationSucceeded = true;
      await refreshServerSettings(server.id);
      return invite;
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action: "invite_created",
          result: "failed",
          server_kind: server.kind,
          role: input.role,
          email_bound: Boolean(input.email),
          failure_code: "invite_create_failed",
        });
      }
      throw error;
    }
  }

  async function updateServerMember(input: UpdateTeamMemberInput): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    try {
      if (server.kind === "local") await window.openbot.host.updateMember(input);
      else await window.openbot.servers.updateMember(server.id, input);
      analytics.track("team_action", { action: "member_updated", result: "succeeded", server_kind: server.kind });
      operationSucceeded = true;
      await refreshServerSettings(server.id);
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action: "member_updated",
          result: "failed",
          server_kind: server.kind,
          failure_code: "member_update_failed",
        });
      }
      throw error;
    }
  }

  async function removeServerMember(memberId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    try {
      if (server.kind === "local") await window.openbot.host.removeMember(memberId);
      else await window.openbot.servers.removeMember(server.id, memberId);
      analytics.track("team_action", { action: "member_removed", result: "succeeded", server_kind: server.kind });
      operationSucceeded = true;
      await refreshServerSettings(server.id);
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action: "member_removed",
          result: "failed",
          server_kind: server.kind,
          failure_code: "member_remove_failed",
        });
      }
      throw error;
    }
  }

  async function revokeServerInvite(inviteId: string): Promise<void> {
    const server = serverSettingsTarget();
    if (!server) throw new Error("This server is not available.");
    const analytics = desktopAnalytics.scope();
    let operationSucceeded = false;
    try {
      if (server.kind === "local") await window.openbot.host.revokeInvite(inviteId);
      else await window.openbot.servers.revokeInvite(server.id, inviteId);
      analytics.track("team_action", { action: "invite_revoked", result: "succeeded", server_kind: server.kind });
      operationSucceeded = true;
      await refreshServerSettings(server.id);
    } catch (error) {
      if (!operationSucceeded) {
        analytics.track("team_action", {
          action: "invite_revoked",
          result: "failed",
          server_kind: server.kind,
          failure_code: "invite_revoke_failed",
        });
      }
      throw error;
    }
  }

  async function connectRemoteDesktop(serverId: string): Promise<RemoteDesktopSession> {
    const analytics = desktopAnalytics.scope();
    try {
      const session = await window.openbot.remoteDesktop.connect({ serverId });
      setRemoteDesktopSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      analytics.track("remote_desktop_action", {
        action: "connect",
        result: "succeeded",
        transport: session.transport,
      });
      return session;
    } catch (error) {
      analytics.track("remote_desktop_action", {
        action: "connect",
        result: "failed",
        failure_code: "connection_failed",
      });
      throw error;
    }
  }

  async function disconnectRemoteDesktop(sessionId: string): Promise<void> {
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.remoteDesktop.disconnect(sessionId);
      setRemoteDesktopSessions((current) => current.filter((session) => session.id !== sessionId));
      analytics.track("remote_desktop_action", { action: "disconnect", result: "succeeded" });
    } catch (error) {
      analytics.track("remote_desktop_action", {
        action: "disconnect",
        result: "failed",
        failure_code: "disconnect_failed",
      });
      throw error;
    }
  }

  async function selectRemoteDesktopDisplay(serverId: string, displayId: string): Promise<void> {
    const analytics = desktopAnalytics.scope();
    try {
      await window.openbot.remoteDesktop.selectDisplay({ serverId, displayId });
      setRemoteDesktopSessions((current) =>
        current.map((session) =>
          session.serverId === serverId ? { ...session, selectedDisplayId: displayId } : session,
        ),
      );
      analytics.track("remote_desktop_action", { action: "select_display", result: "succeeded" });
    } catch (error) {
      analytics.track("remote_desktop_action", {
        action: "select_display",
        result: "failed",
        failure_code: "display_select_failed",
      });
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

  function dynamicIslandServerOrder(): string[] {
    const ids = servers()
      .filter(
        (server) =>
          dynamicIslandConnectedServers.has(server.id) && (server.kind === "local" || server.state === "online"),
      )
      .map((server) => server.id);
    return ids.length > 0 ? ids : ["local"];
  }

  function publishDynamicIslandPresentation(): void {
    if (props.landingPreview || dynamicIslandPresentationFrame !== undefined) return;
    dynamicIslandPresentationFrame = requestAnimationFrame(() => {
      dynamicIslandPresentationFrame = undefined;
      const presentation = dynamicIslandCoordinator.presentation(dynamicIslandServerOrder());
      void window.openbot.dynamicIsland.publishPresentation(presentation).catch(() => undefined);
    });
  }

  createEffect(
    () =>
      servers()
        .map((server) => `${server.id}:${server.state}`)
        .join("\u0000"),
    () => {
      const currentServers = servers();
      const configuredServerIds = new Set(currentServers.map((server) => server.id));
      for (const serverId of dynamicIslandConnectedServers) {
        const server = currentServers.find((candidate) => candidate.id === serverId);
        if (!configuredServerIds.has(serverId) || (server?.kind === "remote" && server.state !== "online")) {
          dynamicIslandConnectedServers.delete(serverId);
        }
      }
      dynamicIslandConnectedServers.add("local");
      dynamicIslandCoordinator.retainServers([...dynamicIslandConnectedServers]);
      publishDynamicIslandPresentation();
      for (const server of currentServers) {
        if (server.kind === "remote" && server.state !== "online") continue;
        void window.openbot.agent
          .listBotsForServer(server.id)
          .then((bots) => {
            if (!servers().some((candidate) => candidate.id === server.id)) return;
            dynamicIslandCoordinator.setBots(server.id, bots);
            publishDynamicIslandPresentation();
          })
          .catch(() => undefined);
      }
    },
  );

  createEffect(
    () => {
      if (props.landingPreview) return null;
      const serverId = dynamicIslandLoadedServerId();
      if (!serverId || serverId !== activeServerSidebarKey()) return null;
      return {
        serverId,
        bots: botList(),
        activeTurns: activeTurns(),
        queues: queues(),
        unreadReplies: unreadReplies(),
        unreadMessageIds: Object.fromEntries(
          Object.entries(conversationReads()).map(([botId, state]) => [botId, state.firstUnreadMessageId]),
        ),
        liveMessages: liveMessages(),
        pendingPrompts: pendingPrompts(),
        pendingApprovals: pendingApprovals(),
        failedTurns: failedTurns(),
      };
    },
    (input) => {
      if (!input) return;
      dynamicIslandCoordinator.replaceServer(input);
      publishDynamicIslandPresentation();
    },
  );

  onSettled(() => {
    if (props.landingPreview) return;
    return window.openbot.dynamicIsland.onAction((action) => void handleDynamicIslandAction(action));
  });

  async function handleDynamicIslandAction(action: DynamicIslandAction): Promise<void> {
    if (action.type === "open-app") return;
    if (action.type === "approve-attention") {
      dynamicIslandCoordinator.resolveAction(action);
      publishDynamicIslandPresentation();
      return;
    }
    if (action.type === "answer-prompt") {
      dynamicIslandCoordinator.resolveAction(action);
      publishDynamicIslandPresentation();
      return;
    }
    if (activeServerSidebarKey() !== action.serverId) await selectServer(action.serverId, false);
    selectBot(action.botId);
    if (action.type === "open-message") await openAgentMessage(action.botId, action.messageId);
    if (action.type === "open-failure") {
      dynamicIslandCoordinator.resolveAction(action);
      publishDynamicIslandPresentation();
      setFailedTurns((current) =>
        current[action.botId] === action.turnId ? withoutBot(current, action.botId) : current,
      );
      await window.openbot.agent
        .acknowledgeFailedTurn({ botId: action.botId, turnId: action.turnId })
        .catch(() => undefined);
    }
  }

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
    providerRuntimeStatuses: () => providerRuntimeSnapshot().providers,
    providerRuntimeDownloadsAvailable: () => Boolean(window.openbot.providerRuntimes),
    refreshingProviders,
    connectChatGPT,
    connectClaude,
    connectGrok,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    openProviderInstallGuide,
    openProviderSignInGuide,
    refreshAgentProviders,
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
    peopleEnabled,
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
    appSettingsOpen,
    setAppSettingsOpen,
    generalSettings,
    setGeneralSettings: updateGeneralSettings,
    openAppSettings,
    appSettingsRestoreTarget: () => appSettingsRestoreTarget,
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
    presentPromptResolution,
    respondToApproval,
    respondToBrowserTakeover,
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
