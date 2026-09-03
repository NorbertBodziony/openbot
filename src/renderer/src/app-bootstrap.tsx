import { createEffect, flush, onSettled } from "solid-js";
import { useAgents } from "./agents";
import { useAuth } from "./auth";
import { useBrowserTabs } from "./browser-tabs";
import { useConversation } from "./conversation";
import { agentConversationKey } from "./conversation-keys";
import { useDirectMessages } from "./direct-messages";
import { useNavigation } from "./navigation";
import { usePresence } from "./presence";
import { useServerSelection } from "./server-selection";
import { useServers } from "./servers";
import { useSetup } from "./setup";
import { useSidebar } from "./sidebar";

/**
 * Everything that has to happen once, at the bottom of the tree: the first
 * per-server load, the two window-level listeners, and the deep-link invite.
 *
 * These stayed together rather than moving into their domains because each one
 * spans several. The initial load fills agents, sidebar, conversation reads,
 * browser and presence from one `servers.list()`; the focus handler reads the
 * open agent chat, the conversation read state and the open direct conversation
 * to decide what focus should mark read; the invite path needs setup, auth and
 * servers at once.
 *
 * The load duplicates `selectServer`'s sequence, and deliberately so for now -
 * this is the copy the plan calls out as already drifted (per-promise `catch`
 * here, one `Promise.all` there, a different subset of loads). Collapsing them
 * into a single keyed mount is the point of the scoping step; doing it here
 * first would be a behaviour change hiding inside a move.
 *
 * `handleWindowFocus` runs after `Platform`'s own focus listener because the
 * provider that registers it is mounted further out, and effect creation order
 * is subscription order - so `appFocused()` already reads true by the time this
 * one runs.
 */
export function AppBootstrap() {
  const { centralAuth } = useAuth();
  const { setupState, pendingInviteUrl, setPendingInviteUrl } = useSetup();
  const { servers, activeServerId, setJoinServerOpen, initialServersReady } = useServers();
  const { setTeamPresence } = usePresence();
  const { activeDirectMemberId, directConversations, refreshDirectThreads, markDirectMessagesRead } =
    useDirectMessages();
  const { setModelOptions, activeBot, setAgentChatOpenRevision, setAgentStatus, applyStoredBots } = useAgents();
  const {
    setBrowserControlState,
    supportsBrowser,
    loadDisplayState: loadBrowserDisplayState,
    loadControlState: loadBrowserControlState,
    beginBrowserLoad,
  } = useBrowserTabs();
  const { setSidebarLayout, loadLayout: loadSidebarLayout, resetForServer: resetSidebarForServer } = useSidebar();
  const { globalSearchOpen, setGlobalSearchVisibility } = useNavigation();
  const {
    conversationReads,
    setRecentReplies,
    agentChatsToMarkRead,
    agentChatsRetriedOnOpen,
    applyConversationReads,
    isAgentChatOpen,
  } = useConversation();
  const { setDynamicIslandLoadedServerId } = useServerSelection();

  onSettled(() => {
    const receiveInvite = (inviteUrl: string) => {
      flush(() => {
        setPendingInviteUrl(inviteUrl);
        if (setupState()?.completed === true && centralAuth().status === "signed_in") setJoinServerOpen(true);
      });
    };
    const unsubscribeInvite = window.openbot.servers.onInvite((inviteUrl) => {
      receiveInvite(inviteUrl);
    });
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
    // `Platform` owns the flag and registers its own listener first, so
    // `appFocused()` already reads true by the time this one runs.
    const handleWindowFocus = () => {
      flush(() => {
        setRecentReplies({});
        const botId = activeBot()?.id;
        if (botId && isAgentChatOpen(botId) && (conversationReads()[botId]?.unreadCount ?? 0) > 0) {
          const trackingKey = agentConversationKey(activeServerId(), botId);
          agentChatsToMarkRead.add(trackingKey);
          agentChatsRetriedOnOpen.delete(botId);
          setAgentChatOpenRevision((current) => current + 1);
        }
        const memberId = activeDirectMemberId();
        if (memberId && (directConversations()[memberId]?.readState?.unreadCount ?? 0) > 0) {
          void markDirectMessagesRead(memberId).catch(() => undefined);
        }
      });
    };
    window.addEventListener("focus", handleWindowFocus);
    const cleanup = () => {
      unsubscribeInvite();
      window.removeEventListener("keydown", handleGlobalSearchShortcut);
      window.removeEventListener("focus", handleWindowFocus);
    };
    void window.openbot.servers
      .takePendingInvite()
      .then((inviteUrl) => inviteUrl && receiveInvite(inviteUrl))
      .catch(() => undefined);

    void initialServersReady.then(() => {
      const loadingServerId = activeServerId();
      const loadingServer = servers().find((server) => server.id === loadingServerId);
      if (
        loadingServer?.kind === "remote" &&
        (loadingServer.state === "incompatible" || loadingServer.issue?.code === "protocol_error")
      ) {
        return;
      }
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
        loadSidebarLayout(loadingServer).then(setSidebarLayout).catch(resetSidebarForServer),
        window.openbot.agent
          .listConversationReads()
          .then(applyConversationReads)
          .catch(() => undefined),
      ]).finally(() => {
        if (activeServerId() === loadingServerId) setDynamicIslandLoadedServerId(loadingServerId);
      });
      if (supportsBrowser(loadingServer)) {
        const applyDisplayState = beginBrowserLoad();
        void loadBrowserDisplayState(loadingServer)
          .then(applyDisplayState)
          .catch(() => undefined);
        void loadBrowserControlState(loadingServer)
          .then(setBrowserControlState)
          .catch(() => undefined);
      }
      void window.openbot.servers
        .getPresence()
        .then(setTeamPresence)
        .catch(() => undefined);
      void refreshDirectThreads();
    });
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

  return null;
}
