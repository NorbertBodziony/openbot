import type { AgentProviderId, BotSummary, ServerSummary } from "@openbot/contracts/ipc";
import { createEffect, createSignal } from "solid-js";
import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import { EMPTY_TEAM_PRESENCE } from "./app-defaults";
import { useBrowserTabs } from "./browser-tabs";
import { toast } from "./components/ui";
import { useConversation } from "./conversation";
import { useDirectMessages } from "./direct-messages";
import { useDynamicIsland } from "./dynamic-island";
import { useNavigation } from "./navigation";
import { usePresence } from "./presence";
import { useRemoteDesktop } from "./remote-desktop";
import { useServers } from "./servers";
import { useSettings } from "./settings";
import { useSetup } from "./setup";
import { useSidebar } from "./sidebar";
import { createSimpleContext } from "./simple-context";
import { useTurns } from "./turns";

/**
 * Switching the active server, and the two ways a new one arrives: joining from
 * an invite, and the servers domain asking for a load it cannot perform itself.
 *
 * A leaf, and the largest one. `selectServer` tears down and refills every
 * per-server domain - agents, sidebar, direct messages, conversation, turns,
 * presence, browser - so it can only live below all of them. `servers.tsx` holds
 * the list and the active id but publishes `serverLoadRequest` instead of
 * loading, precisely because the load reaches down here.
 *
 * `dynamicIslandLoadedServerId` is published rather than kept private: it is the
 * flag that says the per-server load finished, and the Dynamic Island projection
 * must not send a half-loaded server to main. It is cleared the moment a switch
 * starts and restored on a failed one, so a failed switch does not leave the
 * island describing a server nobody is looking at.
 *
 * The teardown here is still a list of `resetForServer()` calls. It becomes an
 * unmount once the per-server domains move into a keyed subtree - the point of
 * routing every reset through one exported function per domain was to make that
 * step mechanical.
 */
const ServerSelection = createSimpleContext({
  name: "Server selection",
  init: () => {
    const { servers, setServers, beginServerSelection, serverLoadRequest } = useServers();
    const { pendingInviteUrl, setPendingInviteUrl, saveSetup } = useSetup();
    const { setSkillsMarketplaceOpen } = useSettings();
    const { disconnectRemoteDesktopWorkspace } = useRemoteDesktop();
    const { dynamicIslandCoordinator } = useDynamicIsland();
    const { setTeamPresence } = usePresence();
    const { cancelDirectConversationRequests, resetForServer: resetDirectMessagesForServer } = useDirectMessages();
    const {
      botSetupOpen,
      creatingAgent,
      setAgentStatus,
      setModelOptions,
      applyStoredBots,
      resetForServer: resetAgentsForServer,
    } = useAgents();
    const { resetForServer: resetTurnsForServer } = useTurns();
    const {
      setBrowserVisibilitySuspended,
      setBrowserControlState,
      beginBrowserLoad,
      loadDisplayState: loadBrowserDisplayState,
      loadControlState: loadBrowserControlState,
    } = useBrowserTabs();
    const { setSidebarLayout, loadLayout: loadSidebarLayout, resetForServer: resetSidebarForServer } = useSidebar();
    const { selectBot } = useNavigation();
    const { applyConversationReads, resetForServer: resetConversationForServer } = useConversation();
    const [dynamicIslandLoadedServerId, setDynamicIslandLoadedServerId] = createSignal<string | null>(null);

    async function selectServer(
      serverId: string,
      trackSelection = true,
      recoverAuthoritativeServer = true,
    ): Promise<boolean> {
      if (botSetupOpen() && creatingAgent()) return false;
      const selectionIsCurrent = beginServerSelection();
      const analytics = desktopAnalytics.scope();
      const previousServerId = servers().find((server) => server.active)?.id;
      const switchingServers = Boolean(previousServerId && previousServerId !== serverId);
      if (switchingServers) setBrowserVisibilitySuspended(true);
      try {
        if (switchingServers) {
          await disconnectRemoteDesktopWorkspace(false);
          if (!selectionIsCurrent()) return false;
          await window.openbot.browser.setVisible({ visible: false }).catch(() => undefined);
          if (!selectionIsCurrent()) return false;
        }
        cancelDirectConversationRequests();
        const previousDynamicIslandLoadedServerId = dynamicIslandLoadedServerId() ?? previousServerId ?? null;
        setDynamicIslandLoadedServerId(null);
        let nextServers: ServerSummary[];
        try {
          nextServers = await window.openbot.servers.select(serverId);
          if (!selectionIsCurrent()) return false;
          const authoritativeServerId = nextServers.find((server) => server.active)?.id;
          if (authoritativeServerId !== serverId) {
            if (authoritativeServerId) await selectServer(authoritativeServerId, false, false);
            return false;
          }
          if (trackSelection) {
            analytics.track("team_action", {
              action: "server_selected",
              result: "succeeded",
              server_kind: nextServers.find((server) => server.active)?.kind ?? "unknown",
            });
          }
        } catch (error) {
          if (!selectionIsCurrent()) return false;
          if (trackSelection) {
            analytics.track("team_action", {
              action: "server_selected",
              result: "failed",
              failure_code: "server_select_failed",
            });
          }
          setDynamicIslandLoadedServerId(previousDynamicIslandLoadedServerId);
          if (recoverAuthoritativeServer) {
            const authoritativeServers = await window.openbot.servers.list().catch(() => null);
            if (!selectionIsCurrent()) return false;
            const authoritativeServerId = authoritativeServers?.find((server) => server.active)?.id;
            if (authoritativeServerId && authoritativeServerId !== previousServerId) {
              await selectServer(authoritativeServerId, false, false);
            }
          }
          throw error;
        }
        const dynamicIslandState = dynamicIslandCoordinator.serverState(serverId);
        setServers(nextServers);
        resetAgentsForServer();
        resetSidebarForServer();
        resetDirectMessagesForServer();
        resetConversationForServer();
        resetTurnsForServer(dynamicIslandState);
        setTeamPresence(EMPTY_TEAM_PRESENCE);
        const selectedServer = nextServers.find((server) => server.id === serverId);
        if (
          selectedServer?.kind === "remote" &&
          (selectedServer.state === "incompatible" || selectedServer.issue?.code === "protocol_error")
        ) {
          return true;
        }
        const applyBrowserDisplayState = beginBrowserLoad();
        const browserDisplayState = loadBrowserDisplayState(selectedServer);
        const [storedBots, layout, reads, status, models, displayState, controlState, presence] = await Promise.all([
          window.openbot.agent.listBots(),
          loadSidebarLayout(selectedServer),
          window.openbot.agent.listConversationReads(),
          window.openbot.agent.getStatus(),
          window.openbot.agent.listModels(),
          browserDisplayState,
          loadBrowserControlState(selectedServer),
          window.openbot.servers.getPresence(),
        ]);
        if (!selectionIsCurrent()) return false;
        setAgentStatus(status);
        setModelOptions(models);
        applyBrowserDisplayState(displayState);
        setBrowserControlState(controlState);
        setTeamPresence(presence);
        setSidebarLayout(layout);
        applyStoredBots(storedBots);
        applyConversationReads(reads);
        setDynamicIslandLoadedServerId(serverId);
        return true;
      } finally {
        if (selectionIsCurrent()) setBrowserVisibilitySuspended(false);
      }
    }

    // The servers domain cannot call `selectServer` - it writes to every domain
    // nested under it - so it publishes the server that needs loading and the load
    // happens here instead. See `servers.tsx`.
    createEffect(
      () => serverLoadRequest(),
      (request) => {
        if (!request) return;
        void selectServer(request.serverId, false).catch((error) => {
          toast.error("Could not load the remote workspace", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
      },
    );

    async function openInstalledMarketplaceAgent(bot: BotSummary): Promise<void> {
      if (!(await selectServer("local", false))) return;
      selectBot(bot.id);
      setSkillsMarketplaceOpen(false);
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

    async function joinRemoteDuringSetup(input: { inviteUrl: string }, provider: AgentProviderId): Promise<void> {
      await joinServer(input);
      await saveSetup(provider);
    }

    return {
      selectServer,
      joinServer,
      joinRemoteDuringSetup,
      openInstalledMarketplaceAgent,
      dynamicIslandLoadedServerId,
      setDynamicIslandLoadedServerId,
    };
  },
});

export const ServerSelectionProvider = ServerSelection.provider;
export const useServerSelection = ServerSelection.use;
