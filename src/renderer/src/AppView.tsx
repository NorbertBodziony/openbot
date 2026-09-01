import type { ServerSummary } from "@openbot/contracts/ipc";
import { createMemo, For, Loading, lazy, Show } from "solid-js";
import { useAppController } from "./App";
import { Conversation } from "./components/Conversation";
import { FIRST_BOT_SUGGESTIONS, FirstBotSetup } from "./components/FirstBotSetup";
import { PanelResizer, savePanelWidth } from "./components/PanelResizer";
import { ServerRail } from "./components/ServerRail";
import { Sidebar } from "./components/Sidebar";
import { StaticAccountDock } from "./components/StaticAccountDock";
import { Alert, AlertContent, AlertDescription, Button, toast } from "./components/ui";

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
  const {
    setupLoaded,
    appInfo,
    visibleSignedInAccount,
    centralAuth,
    retryCentralAccount,
    requestEmailCode,
    verifyEmailCode,
    logoutCentralAccount,
    setupState,
    pendingInviteUrl,
    agentStatus,
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
    saveSetup,
    previewInvite,
    joinRemoteDuringSetup,
  } = useAppController();

  return (
    <Show
      when={setupLoaded() && appInfo() !== null}
      fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}
    >
      <Show
        when={visibleSignedInAccount()}
        fallback={
          <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
            <AccountLogin
              variant={appInfo()?.variant ?? "production"}
              state={centralAuth()}
              onRetry={retryCentralAccount}
              onRequestEmailCode={requestEmailCode}
              onVerifyEmailCode={verifyEmailCode}
              onReset={logoutCentralAccount}
            />
          </Loading>
        }
      >
        {(account) => (
          <Show
            when={setupState()?.completed}
            fallback={
              <Show
                when={pendingInviteUrl().trim()}
                fallback={
                  <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
                    <OnboardingFlow
                      state={setupState() ?? { completed: false, preferredProvider: null }}
                      agentStatus={agentStatus()}
                      platform={appInfo()?.platform ?? "darwin"}
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
                      onSave={saveSetup}
                    />
                  </Loading>
                }
              >
                <Loading fallback={<div class="initial-setup-screen" role="status" aria-label="Loading OpenBot" />}>
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
  account: () => NonNullable<ReturnType<ReturnType<typeof useAppController>["signedInAccount"]>>;
}) {
  const {
    props: appProps,
    appInfo,
    setAppFrameElement,
    leftPanelCompact,
    remoteDesktopWorkspaceVisible,
    LEFT_PANEL_COMPACT,
    leftPanelWidth,
    servers,
    selectServer,
    retryServerConnection,
    reorderServers,
    setJoinServerOpen,
    openServerSettings,
    activeServer,
    botList,
    activeDirectMemberId,
    peopleEnabled,
    activeServerSupportsCapability,
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
    duplicateBot,
    duplicatingBotIds,
    deleteBot,
    setSidebarCollapsed,
    expandSidebar,
    accountUsage,
    updateStatus,
    agentStatus,
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectChatGPT,
    connectClaude,
    connectGrok,
    refreshAccountUsage,
    runUpdateAction,
    logoutCentralAccount,
    setPermissionsOpen,
    appSettingsOpen,
    openAppSettings,
    setSkillsMarketplaceOpen,
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
    activeRoutineIds,
    browserTabs,
    activeBrowserTabId,
    browserVisibilitySuspended,
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
    joinServerOpen,
    serverSettingsOpen,
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
  } = useAppController();

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
  const activePeopleEnabled = createMemo(() => peopleEnabled && activeServerSupportsCapability("direct-messages"));

  return (
    <div
      ref={setAppFrameElement}
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
          onSelect={(serverId) =>
            void selectServer(serverId).catch((error) => {
              toast.error("Could not select the server", {
                description: error instanceof Error ? error.message : String(error),
              });
            })
          }
          onReorder={(serverIds) => void reorderServers(serverIds)}
          onAdd={() => {
            if (!appProps.landingPreview) setJoinServerOpen(true);
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
        compact={leftPanelCompact()}
        onExpand={expandSidebar}
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
            compact={leftPanelCompact()}
            hybrid={appInfo()?.platform === "darwin" && !leftPanelCompact()}
            withServerRail={appInfo()?.platform === "darwin" || appInfo()?.platform === "win32"}
          />
        }
      >
        <AccountDock
          account={props.account()}
          appInfo={appInfo()}
          agentStatus={agentStatus()}
          accountUsage={accountUsage()}
          updateStatus={updateStatus()}
          compact={leftPanelCompact()}
          withServerRail={appInfo()?.platform === "darwin" || appInfo()?.platform === "win32"}
          onRefreshUsage={refreshAccountUsage}
          onUpdateAction={runUpdateAction}
          onLogout={appProps.landingPreview ? undefined : logoutCentralAccount}
          onOpenExternal={(destination) => window.openbot.openExternal(destination)}
          onOpenPermissions={() => setPermissionsOpen(true)}
          onOpenSettings={openAppSettings}
          onOpenSkills={() => setSkillsMarketplaceOpen(true)}
        />
      </Loading>
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
          browserEnabled={!appProps.landingPreview && activeServerSupportsCapability("browser-control")}
          remoteDesktopSessionActive={Boolean(activeRemoteDesktopSession())}
          remoteDesktopVisible={remoteDesktopWorkspaceVisible()}
          remoteDesktopEnabled={!appProps.landingPreview && activeServerSupportsCapability("remote-desktop")}
          prompt={activePrompt()}
          approval={activeBot() ? pendingApprovals()[activeBot()?.id ?? ""] : undefined}
          browserTakeover={activeBrowserTakeover()}
          activeTurnId={activeBot() ? activeTurns()[activeBot()?.id ?? ""] : null}
          globalOverlayOpen={globalSearchOpen() || joinServerOpen() || serverSettingsOpen() || appSettingsOpen()}
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
  account: () => NonNullable<ReturnType<ReturnType<typeof useAppController>["signedInAccount"]>>;
}) {
  const {
    props: appProps,
    permissionsOpen,
    appSettingsOpen,
    setAppSettingsOpen,
    generalSettings,
    setGeneralSettings,
    appSettingsRestoreTarget,
    skillsMarketplaceOpen,
    setSkillsMarketplaceOpen,
    openInstalledMarketplaceAgent,
    setupState,
    agentStatus,
    appInfo,
    saveSetup,
    previewInvite,
    joinRemoteDuringSetup,
    logoutCentralAccount,
    setPermissionsOpen,
    joinServerOpen,
    pendingInviteUrl,
    setJoinServerOpen,
    setPendingInviteUrl,
    joinServer,
    serverSettingsTarget,
    serverSettingsOpen,
    setServerSettingsOpen,
    serverSettingsRestoreTarget,
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
    updateStatus,
    runUpdateAction,
    updateAccountName,
    updateAccountAvatar,
    createMobileConnect,
    listMobileConnectedDevices,
    revokeMobileConnectedDevice,
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectChatGPT,
    connectClaude,
    connectGrok,
    globalSearchOpen,
    botList,
    activeBot,
    activeServer,
    searchGlobalMessages,
    setGlobalSearchVisibility,
    selectBot,
    selectGlobalSearchMessage,
    remoteDesktopWorkspaceServer,
    remoteDesktopWorkspaceVisible,
    remoteDesktopWorkspaceSession,
    remoteDesktopConnectingServerId,
    remoteDesktopConnectionError,
    hideRemoteDesktopWorkspace,
    disconnectRemoteDesktopWorkspace,
    retryRemoteDesktopWorkspace,
    selectRemoteDesktopDisplay,
  } = useAppController();

  return (
    <>
      <Show when={permissionsOpen()}>
        <Loading>
          <InitialSetup
            reviewing
            state={setupState() ?? { completed: true, preferredProvider: "codex" }}
            agentStatus={agentStatus()}
            platform={appInfo()?.platform ?? "darwin"}
            accountEmail={props.account().email}
            onSave={saveSetup}
            onPreviewInvite={previewInvite}
            onJoinRemote={joinRemoteDuringSetup}
            onLogout={appProps.landingPreview ? undefined : logoutCentralAccount}
            onClose={() => setPermissionsOpen(false)}
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
            inviteUrl={pendingInviteUrl()}
            accountEmail={props.account().email}
            onClose={() => {
              setJoinServerOpen(false);
              setPendingInviteUrl("");
            }}
            onPreview={previewInvite}
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
          </Loading>
        )}
      </Show>
      <Loading>
        <SettingsModal
          open={appSettingsOpen()}
          onOpenChange={setAppSettingsOpen}
          value={generalSettings()}
          onValueChange={setGeneralSettings}
          appInfo={appInfo()}
          updateStatus={updateStatus()}
          onUpdateAction={runUpdateAction}
          account={props.account()}
          onUpdateAccountName={updateAccountName}
          onUpdateAccountAvatar={updateAccountAvatar}
          onCreateMobileConnect={createMobileConnect}
          onListMobileConnectedDevices={listMobileConnectedDevices}
          onRevokeMobileConnectedDevice={revokeMobileConnectedDevice}
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
      <Show when={!appProps.landingPreview && remoteDesktopWorkspaceServer()} keyed>
        {(server) => (
          <Loading>
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
          </Loading>
        )}
      </Show>
    </>
  );
}
