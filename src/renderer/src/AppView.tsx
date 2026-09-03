import type { ServerSummary } from "@openbot/contracts/ipc";
import { createMemo, For, Loading, lazy, Show } from "solid-js";
import { useAgentActions } from "./agent-actions";
import { useAgents } from "./agents";
import { useAuth } from "./auth";
import { useBrowserTabs } from "./browser-tabs";
import { Conversation } from "./components/Conversation";
import { FIRST_BOT_SUGGESTIONS, FirstBotSetup } from "./components/FirstBotSetup";
import { PanelResizer, savePanelWidth } from "./components/PanelResizer";
import { ServerRail } from "./components/ServerRail";
import { Sidebar } from "./components/Sidebar";
import { StaticAccountDock } from "./components/StaticAccountDock";
import { Alert, AlertContent, AlertDescription, Button, toast } from "./components/ui";
import { useConversation } from "./conversation";
import { useDirectMessages } from "./direct-messages";
import { useLayout } from "./layout";
import {
  LEFT_PANEL_COLLAPSE_THRESHOLD,
  LEFT_PANEL_COMPACT,
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_EXPAND_THRESHOLD,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_STORAGE_KEY,
} from "./layout-constants";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { usePresence } from "./presence";
import { useProviders } from "./providers";
import { useRemoteDesktop } from "./remote-desktop";
import { useServerSelection } from "./server-selection";
import { useServerSettings } from "./server-settings";
import { useServers } from "./servers";
import { useSettings } from "./settings";
import { useSetup } from "./setup";
import { useSidebar } from "./sidebar";
import { computeSidebarAgentStates } from "./sidebar-agent-states";
import { useTurns } from "./turns";
import { useUpdates } from "./updates";

const AccountDock = lazy(() => import("./components/AccountDock").then((module) => ({ default: module.AccountDock })));
const AccountLogin = lazy(() =>
  import("./components/AccountLogin").then((module) => ({ default: module.AccountLogin })),
);
const DirectConversation = lazy(() =>
  import("./components/DirectConversation").then((module) => ({ default: module.DirectConversation })),
);
const GlobalSearch = lazy(() =>
  import("./components/GlobalSearch").then((module) => ({ default: module.GlobalSearch })),
);
const InitialSetup = lazy(() =>
  import("./components/InitialSetup").then((module) => ({ default: module.InitialSetup })),
);
const JoinServerDialog = lazy(() =>
  import("./components/JoinServerDialog").then((module) => ({ default: module.JoinServerDialog })),
);
const OnboardingFlow = lazy(() =>
  import("./components/OnboardingFlow").then((module) => ({ default: module.OnboardingFlow })),
);
const RemoteDesktopWorkspace = lazy(() =>
  import("./components/RemoteDesktopWorkspace").then((module) => ({ default: module.RemoteDesktopWorkspace })),
);
const ServerSettingsModal = lazy(() =>
  import("./components/ServerSettingsModal").then((module) => ({ default: module.ServerSettingsModal })),
);
const SettingsModal = lazy(() =>
  import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })),
);
const SkillsMarketplaceModal = lazy(() =>
  import("./components/SkillsMarketplaceModal").then((module) => ({ default: module.SkillsMarketplaceModal })),
);
export function AppAccessGate() {
  const platform = usePlatform();
  const auth = useAuth();
  const setup = useSetup();
  const { agentStatus } = useAgents();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    refreshingProviders,
    connectChatGPT,
    connectClaude,
    connectGrok,
    openProviderInstallGuide,
    openProviderSignInGuide,
    refreshAgentProviders,
  } = useProviders();
  const { joinRemoteDuringSetup } = useServerSelection();

  return (
    <Show
      when={setup.setupLoaded() && platform.appInfo() !== null}
      fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}
    >
      <Show
        when={auth.visibleSignedInAccount()}
        fallback={
          <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
            <AccountLogin
              variant={platform.appInfo()?.variant ?? "production"}
              state={auth.centralAuth()}
              onRetry={auth.retryCentralAccount}
              onRequestEmailCode={auth.requestEmailCode}
              onVerifyEmailCode={auth.verifyEmailCode}
              onReset={auth.logoutCentralAccount}
            />
          </Loading>
        }
      >
        {(account) => (
          <Show
            when={setup.setupState()?.completed}
            fallback={
              <Show
                when={setup.pendingInviteUrl().trim()}
                fallback={
                  <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
                    <OnboardingFlow
                      state={setup.setupState() ?? { completed: false, preferredProvider: null }}
                      agentStatus={agentStatus()}
                      platform={platform.appInfo()?.platform ?? "darwin"}
                      refreshingProviders={
                        refreshingProviders() ||
                        agentStatus().phase === "starting" ||
                        agentStatus().phase === "restarting"
                      }
                      providerRuntimeStatuses={
                        providerRuntimeDownloadsAvailable() ? providerRuntimeStatuses() : undefined
                      }
                      onDownloadProvider={providerRuntimeDownloadsAvailable() ? downloadProviderRuntime : undefined}
                      onCancelProviderDownload={
                        providerRuntimeDownloadsAvailable() ? cancelProviderRuntimeDownload : undefined
                      }
                      onConnectProvider={(provider) =>
                        provider === "codex"
                          ? connectChatGPT()
                          : provider === "claude"
                            ? connectClaude()
                            : connectGrok()
                      }
                      onInstallProvider={providerRuntimeDownloadsAvailable() ? undefined : openProviderInstallGuide}
                      onSignInProvider={providerRuntimeDownloadsAvailable() ? undefined : openProviderSignInGuide}
                      onRefreshProviders={providerRuntimeDownloadsAvailable() ? undefined : refreshAgentProviders}
                      onSave={setup.saveSetup}
                    />
                  </Loading>
                }
              >
                <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
                  <InitialSetup
                    state={setup.setupState() ?? { completed: false, preferredProvider: null }}
                    agentStatus={agentStatus()}
                    platform={platform.appInfo()?.platform ?? "darwin"}
                    accountEmail={account().email}
                    inviteUrl={setup.pendingInviteUrl()}
                    onSave={setup.saveSetup}
                    onPreviewInvite={setup.previewInvite}
                    onJoinRemote={joinRemoteDuringSetup}
                    onLogout={auth.logoutCentralAccount}
                  />
                </Loading>
              </Show>
            }
          >
            <WorkspaceShell account={account} />
          </Show>
        )}
      </Show>
    </Show>
  );
}

function WorkspaceShell(props: {
  account: () => NonNullable<ReturnType<ReturnType<typeof useAuth>["signedInAccount"]>>;
}) {
  const { appSettingsOpen, openAppSettings, skillsMarketplaceOpen, setSkillsMarketplaceOpen } = useSettings();
  const { openServerSettings, serverSettingsOpen } = useServerSettings();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectChatGPT,
    connectClaude,
    connectGrok,
  } = useProviders();
  const {
    agentStatus,
    botList,
    activeBot,
    duplicatingBotIds,
    modelOptions,
    openBotSetup,
    cancelBotSetup,
    botSetupOpen,
    botSetupDraft,
    setBotSetupDraft,
    botSetupError,
    creatingAgent,
    settingsRequest,
    updateBot,
    setAgentAvatar,
  } = useAgents();
  const {
    activeQueue,
    activeRoutineIds,
    pendingPrompts,
    pendingApprovals,
    activeTurns,
    queues,
    answerPrompt,
    respondToApproval,
    respondToBrowserTakeover,
    cancelQueuedMessage,
    steerQueuedMessage,
    updateQueuedMessage,
    reorderQueue,
    stopActiveTurn,
  } = useTurns();
  const { selectServer } = useServerSelection();
  const {
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
  } = useSidebar();
  const { selectBot, selectDirectMember, openAgentMessage, messageFocusRequest, globalSearchOpen } = useNavigation();
  const {
    browserTabs,
    activeBrowserTabId,
    browserVisibilitySuspended,
    browserControlState,
    activateBrowserTab,
    closeBrowserTab,
  } = useBrowserTabs();
  const { activeRemoteDesktopSession, remoteDesktopWorkspaceVisible, openRemoteDesktopWorkspace } = useRemoteDesktop();
  const {
    activeMessages,
    conversationReferences,
    conversationReads,
    conversationLoaded,
    conversationPages,
    conversationWindowModes,
    conversationOlderLoading,
    conversationOlderErrors,
    sendMessage,
    markAgentMessagesRead,
    loadOlderAgentMessages,
    loadLatestAgentMessages,
    searchAgentMessages,
    setTeamTyping,
    presentPromptResolution,
    unreadReplies,
    recentReplies,
  } = useConversation();
  const { createAgent, editBot, duplicateBot, deleteBot } = useAgentActions();
  const sidebarAgentStates = createMemo(() =>
    computeSidebarAgentStates({
      botIds: botList().map((bot) => bot.id),
      activeTurns: activeTurns(),
      queues: queues(),
      unreadReplies: unreadReplies(),
      recentReplies: recentReplies(),
    }),
  );
  const { teamPresence, currentTeamMember, directPeople } = usePresence();
  const {
    activeDirectMemberId,
    activeDirectMember,
    directThreads,
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
  } = useDirectMessages();
  const {
    servers,
    activeServer,
    activeServerSupportsCapability,
    joinServerOpen,
    setJoinServerOpen,
    reorderServers,
    retryServerConnection,
  } = useServers();
  const platform = usePlatform();
  const updates = useUpdates();
  const auth = useAuth();
  const setup = useSetup();
  const layout = useLayout();

  const activePrompt = createMemo(() => {
    const bot = activeBot();
    const event = bot ? pendingPrompts()[bot.id] : undefined;
    return event?.type === "prompt" ? event : undefined;
  });

  const activeBrowserTakeover = createMemo(() => {
    const bot = activeBot();
    const event = bot ? pendingPrompts()[bot.id] : undefined;
    return event?.type === "browser-takeover-requested" ? event.request : undefined;
  });
  const blockedRemoteServer = createMemo(() => {
    const server = activeServer();
    if (server?.kind !== "remote") return null;
    return server.state === "incompatible" || server.issue?.code === "protocol_error" ? server : null;
  });
  const activePeopleEnabled = createMemo(
    () => platform.peopleEnabled && activeServerSupportsCapability("direct-messages"),
  );

  return (
    <div
      ref={platform.setAppFrameElement}
      class={[
        "app-frame",
        {
          "app-frame-sidebar-compact": layout.leftPanelCompact(),
          "app-frame-with-server-rail":
            platform.appInfo()?.platform === "darwin" || platform.appInfo()?.platform === "win32",
          "app-frame-platform-darwin": platform.appInfo()?.platform === "darwin",
        },
      ]}
      aria-hidden={remoteDesktopWorkspaceVisible() ? "true" : undefined}
      style={`--left-panel-width: ${layout.leftPanelCompact() ? LEFT_PANEL_COMPACT : layout.leftPanelWidth()}px`}
    >
      <Show when={platform.appInfo()?.platform === "darwin" || platform.appInfo()?.platform === "win32"}>
        <ServerRail
          servers={servers()}
          onSelect={(serverId) =>
            void selectServer(serverId).catch((error) => {
              toast.error("Could not select the server", {
                description: error instanceof Error ? error.message : String(error),
              });
            })
          }
          onReorder={(serverIds) => void reorderServers(serverIds)}
          onAdd={() => {
            if (!platform.landingPreview) setJoinServerOpen(true);
          }}
          onOpenSettings={openServerSettings}
        />
      </Show>
      <Sidebar
        serverName={activeServer()?.name ?? "Local"}
        onOpenServerSettings={(trigger) => {
          const server = activeServer();
          if (server) openServerSettings(server.id, trigger);
        }}
        bots={botList()}
        activeBotId={activeDirectMember() ? "" : (activeBot()?.id ?? "")}
        showPeople={activePeopleEnabled()}
        people={directPeople()}
        directThreads={directThreads()}
        activeDirectMemberId={activeDirectMemberId()}
        agentStates={sidebarAgentStates()}
        layout={sidebarLayout()}
        layoutMutable={activeServerSupportsCapability("sidebar-layout")}
        collapsedSectionIds={collapsedSidebarSectionIds()}
        onMutateLayout={mutateSidebarLayout}
        onToggleSection={toggleSidebarSection}
        pinnedItems={pinnedSidebarItems()}
        peopleOrder={sidebarPeopleOrder()}
        onPin={pinSidebarItem}
        onUnpin={unpinSidebarItem}
        onReorderPinned={reorderPinnedSidebarItems}
        onReorderPeople={reorderSidebarPeople}
        onSelectBot={selectBot}
        onSelectPerson={(memberId) => void selectDirectMember(memberId)}
        onPreloadDirectConversation={activePeopleEnabled() ? () => void DirectConversation.preload() : undefined}
        onCreateBot={openBotSetup}
        onEditBot={editBot}
        duplicateSupported={activeServerSupportsCapability("agent-duplication")}
        duplicatingBotIds={duplicatingBotIds()}
        onDuplicateBot={duplicateBot}
        onDeleteBot={deleteBot}
        compact={layout.leftPanelCompact()}
        onExpand={layout.expandSidebar}
        onOpenMarketplace={() => setSkillsMarketplaceOpen(true)}
        emptyAction={
          botList().length === 0
            ? {
                label: "Create your first Bot",
                avatarSeed: botSetupDraft().avatarSeed,
                avatarHue: botSetupDraft().avatarHue,
                onSelect: openBotSetup,
              }
            : undefined
        }
      />
      <Loading
        fallback={
          <StaticAccountDock
            account={props.account()}
            compact={layout.leftPanelCompact()}
            hybrid={platform.appInfo()?.platform === "darwin" && !layout.leftPanelCompact()}
            withServerRail={platform.appInfo()?.platform === "darwin" || platform.appInfo()?.platform === "win32"}
          />
        }
      >
        <AccountDock
          account={props.account()}
          appInfo={platform.appInfo()}
          agentStatus={agentStatus()}
          accountUsage={auth.accountUsage()}
          updateStatus={updates.status()}
          compact={layout.leftPanelCompact()}
          withServerRail={platform.appInfo()?.platform === "darwin" || platform.appInfo()?.platform === "win32"}
          onRefreshUsage={auth.refreshAccountUsage}
          onUpdateAction={updates.runAction}
          onLogout={platform.landingPreview ? undefined : auth.logoutCentralAccount}
          onOpenExternal={(destination) => window.openbot.openExternal(destination)}
          onOpenPermissions={() => setup.setPermissionsOpen(true)}
          onOpenSettings={openAppSettings}
          onOpenSkills={() => setSkillsMarketplaceOpen(true)}
        />
      </Loading>
      <PanelResizer
        class="left-panel-resizer"
        label="Resize left sidebar"
        controls="bot-sidebar"
        direction="left"
        value={layout.leftPanelWidth()}
        defaultValue={LEFT_PANEL_DEFAULT}
        min={LEFT_PANEL_MIN}
        max={LEFT_PANEL_MAX}
        onResize={layout.setLeftPanelWidth}
        onResizeEnd={(value) => savePanelWidth(LEFT_PANEL_STORAGE_KEY, value)}
        snap={{
          compactValue: LEFT_PANEL_COMPACT,
          compact: layout.leftPanelCompact(),
          collapseThreshold: LEFT_PANEL_COLLAPSE_THRESHOLD,
          expandThreshold: LEFT_PANEL_EXPAND_THRESHOLD,
          onCompactChange: (compact) => {
            if (compact) layout.setSidebarCollapsed(true);
            else layout.expandSidebar();
          },
        }}
      />
      <Show when={blockedRemoteServer()} keyed>
        {(server) => <RemoteCompatibilityScreen server={server} onRetry={() => retryServerConnection(server.id)} />}
      </Show>
      <Show when={!blockedRemoteServer() && botSetupOpen()}>
        <FirstBotSetup
          value={botSetupDraft()}
          suggestions={FIRST_BOT_SUGGESTIONS}
          mode={botList().length === 0 ? "first" : "additional"}
          submitting={creatingAgent()}
          error={botSetupError()}
          onChange={setBotSetupDraft}
          onSubmit={createAgent}
          onCancel={botList().length > 0 ? cancelBotSetup : undefined}
        />
      </Show>
      <Show when={!blockedRemoteServer() && activePeopleEnabled() && !botSetupOpen() && activeDirectMember()} keyed>
        {(member) => (
          <Loading
            fallback={
              <main class="direct-conversation" aria-label="Loading direct conversation">
                <div class="direct-conversation-state" role="status">
                  Loading messages…
                </div>
              </main>
            }
          >
            <DirectConversation
              member={member}
              currentMemberId={currentTeamMember()?.id ?? ""}
              snapshot={directConversations()[member.id]}
              loading={directConversationLoading()}
              loadError={directConversationError()}
              hasOlder={
                activeServerSupportsCapability("conversation-pagination") &&
                (directConversationPages()[member.id]?.hasOlder ?? false)
              }
              loadingOlder={directOlderLoading()[member.id] === true}
              olderError={directOlderErrors()[member.id] ?? null}
              typing={directTypingMemberIds().has(member.id)}
              onSend={sendDirectMessage}
              onMarkRead={() => markDirectMessagesRead(member.id)}
              onLoadOlder={() => void loadOlderDirectMessages(member.id)}
              onOpenMessage={(messageId) => openDirectMessage(member.id, messageId)}
              onTypingChange={setDirectTyping}
            />
          </Loading>
        )}
      </Show>
      <Show when={!blockedRemoteServer() && !botSetupOpen() && !activeDirectMember()}>
        <Conversation
          agentStatus={agentStatus()}
          providerRuntimeStatuses={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? providerRuntimeStatuses()
              : undefined
          }
          onDownloadProvider={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? downloadProviderRuntime
              : undefined
          }
          onCancelProviderDownload={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? cancelProviderRuntimeDownload
              : undefined
          }
          onConnectProvider={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? (provider) =>
                  provider === "codex" ? connectChatGPT() : provider === "claude" ? connectClaude() : connectGrok()
              : undefined
          }
          bot={activeBot()}
          bots={botList()}
          availableRoutineIds={activeRoutineIds()}
          modelOptions={modelOptions()}
          messages={activeMessages()}
          messageReferences={activeBot() ? (conversationReferences()[activeBot()?.id ?? ""] ?? {}) : {}}
          unreadCount={activeBot() ? (conversationReads()[activeBot()?.id ?? ""]?.unreadCount ?? 0) : 0}
          firstUnreadMessageId={
            activeBot() ? (conversationReads()[activeBot()?.id ?? ""]?.firstUnreadMessageId ?? null) : null
          }
          loaded={activeBot() ? conversationLoaded()[activeBot()?.id ?? ""] === true : false}
          hasOlder={
            activeServerSupportsCapability("conversation-pagination") && activeBot()
              ? (conversationPages()[activeBot()?.id ?? ""]?.hasOlder ?? false)
              : false
          }
          discontinuous={activeBot() ? conversationWindowModes()[activeBot()?.id ?? ""] === "around" : false}
          loadingOlder={activeBot() ? conversationOlderLoading()[activeBot()?.id ?? ""] === true : false}
          olderError={activeBot() ? (conversationOlderErrors()[activeBot()?.id ?? ""] ?? null) : null}
          queue={activeQueue()}
          browserTabs={browserTabs()}
          activeBrowserTabId={activeBrowserTabId()}
          browserVisibilitySuspended={browserVisibilitySuspended()}
          browserControlState={browserControlState()}
          server={activeServer()}
          presence={teamPresence()}
          currentUserEmail={props.account().email}
          browserEnabled={!platform.landingPreview && activeServerSupportsCapability("browser-control")}
          remoteDesktopSessionActive={Boolean(activeRemoteDesktopSession())}
          remoteDesktopVisible={remoteDesktopWorkspaceVisible()}
          remoteDesktopEnabled={!platform.landingPreview && activeServerSupportsCapability("remote-desktop")}
          prompt={activePrompt()}
          approval={activeBot() ? pendingApprovals()[activeBot()?.id ?? ""] : undefined}
          browserTakeover={activeBrowserTakeover()}
          activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
          skillsMarketplaceOpen={skillsMarketplaceOpen()}
          globalOverlayOpen={
            globalSearchOpen() ||
            joinServerOpen() ||
            serverSettingsOpen() ||
            appSettingsOpen() ||
            skillsMarketplaceOpen()
          }
          settingsRequest={settingsRequest()}
          messageFocusRequest={messageFocusRequest()}
          onSelectAgent={selectBot}
          onUpdateBot={updateBot}
          onSetAgentAvatar={setAgentAvatar}
          onSendMessage={sendMessage}
          onMarkRead={() => markAgentMessagesRead()}
          onLoadOlder={() => void loadOlderAgentMessages()}
          onLoadLatest={() => (activeBot() ? loadLatestAgentMessages(activeBot()?.id ?? "") : Promise.resolve())}
          onSearchMessages={(query) =>
            activeBot()
              ? searchAgentMessages(activeBot()?.id ?? "", query)
              : Promise.resolve({ messageIds: [], total: 0 })
          }
          onOpenSearchMessage={(messageId) =>
            activeBot() ? openAgentMessage(activeBot()?.id ?? "", messageId) : Promise.resolve()
          }
          onTypingChange={setTeamTyping}
          onAnswerPrompt={answerPrompt}
          onPromptResolutionPresented={presentPromptResolution}
          onRespondToApproval={respondToApproval}
          onRespondToBrowserTakeover={respondToBrowserTakeover}
          onCancelQueuedMessage={cancelQueuedMessage}
          onSteerQueuedMessage={steerQueuedMessage}
          onUpdateQueuedMessage={updateQueuedMessage}
          onReorderQueue={reorderQueue}
          onActivateBrowserTab={activateBrowserTab}
          onCloseBrowserTab={closeBrowserTab}
          onOpenRemoteDesktop={openRemoteDesktopWorkspace}
          onOpenAgentSetup={() => window.openbot.openExternal("agent-setup")}
          onStop={stopActiveTurn}
        />
      </Show>
      <WorkspaceOverlays account={props.account} />
    </div>
  );
}

function RemoteCompatibilityScreen(props: { server: ServerSummary; onRetry: () => Promise<void> }) {
  const title = () => {
    if (props.server.issue?.code === "client_update_required") return "Update this OpenBot app";
    if (props.server.issue?.code === "host_update_required") return `Update OpenBot on ${props.server.name}`;
    return "The host returned unsafe data";
  };
  const description = () => {
    if (props.server.issue?.code === "client_update_required") {
      return "This app supports only older protocols than the host. Update this app, then try again.";
    }
    if (props.server.issue?.code === "host_update_required") {
      return "The host supports only older protocols than this app. Update the host, then try again.";
    }
    return "OpenBot stopped this connection because a known payload was invalid. Your current workspace data was not changed.";
  };
  const compatibility = () => props.server.compatibility;
  const details = () => [
    ["Client version", compatibility()?.localAppVersion ?? "Unknown"],
    ["Host version", compatibility()?.hostAppVersion ?? "Unknown"],
    ["Negotiated protocol", compatibility()?.negotiatedProtocol ?? "None"],
  ];

  return (
    <main class="remote-compatibility-screen" aria-labelledby="remote-compatibility-title">
      <Alert class="remote-compatibility-alert" tone="danger" role="alert">
        <AlertContent>
          <h1 class="ui-alert-title" id="remote-compatibility-title">
            {title()}
          </h1>
          <AlertDescription>{description()}</AlertDescription>
        </AlertContent>
      </Alert>
      <dl class="remote-compatibility-details">
        <For each={details()}>
          {([label, value]) => (
            <div>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          )}
        </For>
      </dl>
      <Button onClick={() => void props.onRetry()}>Retry</Button>
    </main>
  );
}

function WorkspaceOverlays(props: {
  account: () => NonNullable<ReturnType<ReturnType<typeof useAuth>["signedInAccount"]>>;
}) {
  const { agentStatus, botList, activeBot } = useAgents();
  const {
    appSettingsOpen,
    setAppSettingsOpen,
    generalSettings,
    updateGeneralSettings,
    appSettingsRestoreTarget,
    skillsMarketplaceOpen,
    setSkillsMarketplaceOpen,
  } = useSettings();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectChatGPT,
    connectClaude,
    connectGrok,
  } = useProviders();
  const {
    serverSettingsTarget,
    serverSettingsOpen,
    setServerSettingsOpen,
    serverSettingsRestoreTarget,
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
  } = useServerSettings();
  const { globalSearchOpen, searchGlobalMessages, setGlobalSearchVisibility, selectBot, selectGlobalSearchMessage } =
    useNavigation();
  const {
    remoteDesktopWorkspaceServer,
    remoteDesktopWorkspaceVisible,
    remoteDesktopWorkspaceSession,
    remoteDesktopConnectingServerId,
    remoteDesktopConnectionError,
    hideRemoteDesktopWorkspace,
    disconnectRemoteDesktopWorkspace,
    retryRemoteDesktopWorkspace,
    selectRemoteDesktopDisplay,
  } = useRemoteDesktop();
  const { activeServer, hostStatus, joinServerOpen, setJoinServerOpen } = useServers();
  const { openInstalledMarketplaceAgent, joinRemoteDuringSetup, joinServer } = useServerSelection();
  const platform = usePlatform();
  const updates = useUpdates();
  const auth = useAuth();
  const setup = useSetup();

  return (
    <>
      <Show when={setup.permissionsOpen()}>
        <Loading>
          <InitialSetup
            reviewing
            state={setup.setupState() ?? { completed: true, preferredProvider: "codex" }}
            agentStatus={agentStatus()}
            platform={platform.appInfo()?.platform ?? "darwin"}
            accountEmail={props.account().email}
            onSave={setup.saveSetup}
            onPreviewInvite={setup.previewInvite}
            onJoinRemote={joinRemoteDuringSetup}
            onLogout={platform.landingPreview ? undefined : auth.logoutCentralAccount}
            onClose={() => setup.setPermissionsOpen(false)}
          />
        </Loading>
      </Show>
      <Show when={skillsMarketplaceOpen()}>
        <Loading>
          <SkillsMarketplaceModal
            open={true}
            bots={activeServer()?.kind === "local" ? botList() : []}
            activeBotId={activeServer()?.kind === "local" ? (activeBot()?.id ?? "") : ""}
            onOpenChange={setSkillsMarketplaceOpen}
            onAgentInstalled={openInstalledMarketplaceAgent}
          />
        </Loading>
      </Show>
      <Show when={joinServerOpen()}>
        <Loading>
          <JoinServerDialog
            inviteUrl={setup.pendingInviteUrl()}
            accountEmail={props.account().email}
            onClose={() => {
              setJoinServerOpen(false);
              setup.setPendingInviteUrl("");
            }}
            onPreview={setup.previewInvite}
            onJoin={joinServer}
          />
        </Loading>
      </Show>
      <Show when={serverSettingsTarget()}>
        {(server) => (
          <Loading>
            <ServerSettingsModal
              open={serverSettingsOpen()}
              onOpenChange={setServerSettingsOpen}
              restoreFocusTarget={serverSettingsRestoreTarget()}
              platform={platform.appInfo()?.platform ?? "darwin"}
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
          </Loading>
        )}
      </Show>
      <Loading>
        <SettingsModal
          open={appSettingsOpen()}
          onOpenChange={setAppSettingsOpen}
          value={generalSettings()}
          onValueChange={updateGeneralSettings}
          appInfo={platform.appInfo()}
          updateStatus={updates.status()}
          onUpdateAction={updates.runAction}
          account={props.account()}
          onUpdateAccountName={auth.updateAccountName}
          onUpdateAccountAvatar={auth.updateAccountAvatar}
          onCreateMobileConnect={auth.createMobileConnect}
          onListMobileConnectedDevices={auth.listMobileConnectedDevices}
          onRevokeMobileConnectedDevice={auth.revokeMobileConnectedDevice}
          agentStatus={agentStatus()}
          providerRuntimeStatuses={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? providerRuntimeStatuses()
              : undefined
          }
          onDownloadProvider={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? downloadProviderRuntime
              : undefined
          }
          onCancelProviderDownload={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? cancelProviderRuntimeDownload
              : undefined
          }
          onConnectProvider={
            activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable()
              ? (provider) =>
                  provider === "codex" ? connectChatGPT() : provider === "claude" ? connectClaude() : connectGrok()
              : undefined
          }
          hostedSitesApi={window.openbot.hostedSites}
          restoreFocusTarget={appSettingsRestoreTarget()}
        />
      </Loading>
      <Show when={globalSearchOpen()}>
        <Loading>
          <GlobalSearch
            open={true}
            bots={botList()}
            onSearchMessages={searchGlobalMessages}
            onOpenChange={setGlobalSearchVisibility}
            onSelectBot={selectBot}
            onSelectMessage={selectGlobalSearchMessage}
          />
        </Loading>
      </Show>
      <Show when={!platform.landingPreview && remoteDesktopWorkspaceServer()} keyed>
        {(server) => (
          <Loading>
            <RemoteDesktopWorkspace
              visible={remoteDesktopWorkspaceVisible()}
              platform={platform.appInfo()?.platform ?? "darwin"}
              server={server}
              session={remoteDesktopWorkspaceSession()}
              connecting={remoteDesktopConnectingServerId() === server.id}
              connectionError={remoteDesktopConnectionError()}
              onHide={hideRemoteDesktopWorkspace}
              onDisconnect={() => disconnectRemoteDesktopWorkspace()}
              onRetry={retryRemoteDesktopWorkspace}
              onSelectDisplay={selectRemoteDesktopDisplay}
            />
          </Loading>
        )}
      </Show>
    </>
  );
}
