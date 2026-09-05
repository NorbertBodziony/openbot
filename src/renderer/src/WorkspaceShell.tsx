import type { CentralAuthUser } from "@openbot/contracts/ipc";
import { createMemo, Show } from "solid-js";
import { WorkspaceAccountDock } from "./features/account/WorkspaceAccountDock";
import { useAgents } from "./features/agents/agents-context";
import { WorkspaceAgentSetup } from "./features/agents/WorkspaceAgentSetup";
import { useDirectMessages } from "./features/conversation/direct-messages-context";
import { WorkspaceConversation } from "./features/conversation/WorkspaceConversation";
import { WorkspaceDirectConversation } from "./features/conversation/WorkspaceDirectConversation";
import { RemoteCompatibilityScreen } from "./features/remote-desktop/RemoteCompatibilityScreen";
import { useRemoteDesktop } from "./features/remote-desktop/remote-desktop-context";
import { useServers } from "./features/servers/servers-context";
import { WorkspaceServerRail } from "./features/servers/WorkspaceServerRail";
import { WorkspaceSidebar } from "./features/sidebar/WorkspaceSidebar";
import { useLayout } from "./layout";
import { LEFT_PANEL_COMPACT } from "./layout-constants";
import { usePlatform } from "./platform";
import { WorkspaceLeftPanelResizer } from "./WorkspaceLeftPanelResizer";
import { WorkspaceOverlays } from "./WorkspaceOverlays";

/**
 * The application frame, and nothing else: which pane occupies the middle, how
 * wide the left column is, and whether the whole frame is hidden behind the
 * remote-desktop workspace.
 *
 * Each pane below reads the domains it needs through its own `use*()`, so this
 * component reads only what the frame itself decides with. That is the point of
 * the split - the shell used to call every context in the renderer because it
 * assembled every pane's props, and a change to any one pane went through here.
 * Two derived values stay because they choose *which* pane renders, and one of
 * them is passed on rather than derived twice.
 *
 * The order of the children is the paint order the stylesheet expects, and the
 * three middle-pane `<Show>`s are mutually exclusive by construction: a blocked
 * remote server wins over everything, then the Agent form, then a person, then a
 * Agent.
 */
export function WorkspaceShell(props: { account: () => CentralAuthUser }) {
  const platform = usePlatform();
  const layout = useLayout();
  const { activeServer, activeServerSupportsCapability, retryServerConnection } = useServers();
  const { remoteDesktopWorkspaceVisible } = useRemoteDesktop();
  const { agentSetupOpen } = useAgents();
  const { activeDirectMember } = useDirectMessages();

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
          "app-frame-with-server-rail": platform.serverRailVisible(),
          "app-frame-platform-darwin": platform.appInfo()?.platform === "darwin",
        },
      ]}
      aria-hidden={remoteDesktopWorkspaceVisible() ? "true" : undefined}
      style={`--left-panel-width: ${layout.leftPanelCompact() ? LEFT_PANEL_COMPACT : layout.leftPanelWidth()}px`}
    >
      <WorkspaceServerRail />
      <WorkspaceSidebar peopleEnabled={activePeopleEnabled()} />
      <WorkspaceAccountDock account={props.account} />
      <WorkspaceLeftPanelResizer />
      <Show when={blockedRemoteServer()} keyed>
        {(server) => <RemoteCompatibilityScreen server={server} onRetry={() => retryServerConnection(server.id)} />}
      </Show>
      <Show when={!blockedRemoteServer() && agentSetupOpen()}>
        <WorkspaceAgentSetup />
      </Show>
      <Show when={!blockedRemoteServer() && activePeopleEnabled() && !agentSetupOpen() && activeDirectMember()} keyed>
        {(member) => <WorkspaceDirectConversation member={member} />}
      </Show>
      <Show when={!blockedRemoteServer() && !agentSetupOpen() && !activeDirectMember()}>
        <WorkspaceConversation account={props.account} />
      </Show>
      <WorkspaceOverlays account={props.account} />
    </div>
  );
}
