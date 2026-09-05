import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo, Loading, Show } from "solid-js";
import { useAgents } from "./agents";
import { useAuth } from "./auth";
import {
  GlobalSearch,
  InitialSetup,
  JoinServerDialog,
  RemoteDesktopWorkspace,
  ServerSettingsModal,
  SettingsModal,
  SkillsMarketplaceModal,
} from "./lazy-views";
import { useNavigation } from "./navigation";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { useRemoteDesktop } from "./remote-desktop";
import { useServerSelection } from "./server-selection";
import { useServerSettings } from "./server-settings";
import { useServers } from "./servers";
import { useSettings } from "./settings";
import { useSetup } from "./setup";
import { useUpdates } from "./updates";

interface AccountProps {
  account: () => CentralAuthUser;
}

/**
 * Everything the workspace raises over itself: modals, dialogs and the two
 * full-window takeovers.
 *
 * They are one module because they share a shape rather than a domain - each is
 * one open flag over one lazily loaded chunk, none of them is laid out by the
 * frame, and none of them reads another - and separate components inside it for
 * the same reason the panes are separate files: an overlay should see the
 * domains it opens over and no others. They stay here rather than in seven
 * single-use modules at the renderer root because each is a dozen lines of
 * wiring, and the list of what can cover the workspace is worth reading in one
 * place.
 */
export function WorkspaceOverlays(props: AccountProps) {
  return (
    <>
      <PermissionsReview account={props.account} />
      <SkillsMarketplace />
      <JoinServer account={props.account} />
      <ServerSettings />
      <AppSettings account={props.account} />
      <GlobalMessageSearch />
      <RemoteDesktop />
    </>
  );
}

/** The permissions half of first-run setup, reopened after the fact. */
function PermissionsReview(props: AccountProps) {
  const platform = usePlatform();
  const auth = useAuth();
  const setup = useSetup();
  const { agentStatus } = useAgents();
  const { joinRemoteDuringSetup } = useServerSelection();

  return (
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
  );
}

/**
 * Skills and marketplace agents, which install into an Agent's workspace on this
 * machine, so the picker is empty for a remote server.
 */
function SkillsMarketplace() {
  const { skillsMarketplaceOpen, setSkillsMarketplaceOpen } = useSettings();
  const { agentList, activeAgent } = useAgents();
  const { activeServer } = useServers();
  const { openInstalledMarketplaceAgent } = useServerSelection();
  const local = createMemo(() => activeServer()?.kind === "local");

  return (
    <Show when={skillsMarketplaceOpen()}>
      <Loading>
        <SkillsMarketplaceModal
          open={true}
          agents={local() ? agentList() : []}
          activeAgentId={local() ? (activeAgent()?.id ?? "") : ""}
          onOpenChange={setSkillsMarketplaceOpen}
          onAgentInstalled={openInstalledMarketplaceAgent}
        />
      </Loading>
    </Show>
  );
}

/** Joining a team server from an invite link. */
function JoinServer(props: AccountProps) {
  const setup = useSetup();
  const { joinServerOpen, setJoinServerOpen } = useServers();
  const { joinServer } = useServerSelection();

  return (
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
  );
}

/**
 * Settings for one server, which is any server on the rail rather than the
 * active one - hence the target held by the domain instead of `activeServer()`.
 */
function ServerSettings() {
  const platform = usePlatform();
  const { hostStatus } = useServers();
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

  return (
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
  );
}

/**
 * Application settings. The only overlay without a `<Show>`: the modal owns its
 * own open state and its close animation, so unmounting it on `open` would cut
 * that animation off.
 */
function AppSettings(props: AccountProps) {
  const platform = usePlatform();
  const auth = useAuth();
  const updates = useUpdates();
  const { agentStatus } = useAgents();
  const { activeServer } = useServers();
  const { appSettingsOpen, setAppSettingsOpen, generalSettings, updateGeneralSettings, appSettingsRestoreTarget } =
    useSettings();
  const {
    providerRuntimeStatuses,
    providerRuntimeDownloadsAvailable,
    downloadProviderRuntime,
    cancelProviderRuntimeDownload,
    connectChatGPT,
    connectClaude,
    connectGrok,
  } = useProviders();
  /** Provider downloads are the local machine's business, never a remote host's. */
  const localProviderDownloads = createMemo(
    () => activeServer()?.kind === "local" && providerRuntimeDownloadsAvailable(),
  );

  return (
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
        onListAccountSessions={auth.listAccountSessions}
        onRevokeAccountSession={auth.revokeAccountSession}
        agentStatus={agentStatus()}
        providerRuntimeStatuses={localProviderDownloads() ? providerRuntimeStatuses() : undefined}
        onDownloadProvider={localProviderDownloads() ? downloadProviderRuntime : undefined}
        onCancelProviderDownload={localProviderDownloads() ? cancelProviderRuntimeDownload : undefined}
        onConnectProvider={
          localProviderDownloads()
            ? (provider) =>
                provider === "codex" ? connectChatGPT() : provider === "claude" ? connectClaude() : connectGrok()
            : undefined
        }
        hostedSitesApi={window.openbot.hostedSites}
        restoreFocusTarget={appSettingsRestoreTarget()}
      />
    </Loading>
  );
}

/** Search across every conversation on the active server. */
function GlobalMessageSearch() {
  const { agentList } = useAgents();
  const { globalSearchOpen, searchGlobalMessages, setGlobalSearchVisibility, selectAgent, selectGlobalSearchMessage } =
    useNavigation();

  return (
    <Show when={globalSearchOpen()}>
      <Loading>
        <GlobalSearch
          open={true}
          agents={agentList()}
          onSearchMessages={searchGlobalMessages}
          onOpenChange={setGlobalSearchVisibility}
          onSelectAgent={selectAgent}
          onSelectMessage={selectGlobalSearchMessage}
        />
      </Loading>
    </Show>
  );
}

/**
 * The remote-desktop takeover. Keyed on the server so that connecting to a
 * different one rebuilds the viewer instead of repainting the previous
 * machine's last frame into it.
 */
function RemoteDesktop() {
  const platform = usePlatform();
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

  return (
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
  );
}
