import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import { toBotProfile, withoutBot } from "./app-message-projection";
import { createStoredProfile } from "./app-stored-values";
import { createBotInitialMessage } from "./bot-initial-message";
import type { FirstBotDraft } from "./components/FirstBotSetup";
import { toast } from "./components/ui";
import { useConversation } from "./conversation";
import { agentConversationKey, deleteAgentMessageBodies } from "./conversation-keys";
import { useDirectMessages } from "./direct-messages";
import { useNavigation } from "./navigation";
import { useServers } from "./servers";
import { useSidebar } from "./sidebar";
import { createSimpleContext } from "./simple-context";
import { useTurns } from "./turns";

/**
 * Creating, editing, duplicating and deleting an agent.
 *
 * A leaf, and it has to be one: `deleteBot` alone writes to agents,
 * conversation, turns, sidebar and navigation, so no domain can own it without
 * reaching into one nested under itself. This is the shape the dependency rule
 * pushes every multi-domain command into - state lives outward, the command
 * that spans several domains lives at the bottom and reads all of them.
 *
 * The four share one guard, `botSetupOpen() && creatingAgent()`: while the
 * first-agent form is mid-submit there is no agent to act on yet, and letting a
 * second write through would race the one in flight.
 *
 * `deleteBot` removes the agent from twelve maps by hand rather than letting a
 * projection drop it. Every one of them is keyed by bot id and outlives the
 * agent otherwise, so a missed key is a leak that shows up as a stale badge on
 * an agent that no longer exists.
 */
const AgentActions = createSimpleContext({
  name: "Agent actions",
  init: () => {
    const { activeServerId, activeServerSupportsCapability } = useServers();
    const {
      botList,
      setBotList,
      botSetupOpen,
      setBotSetupOpen,
      botSetupDraft,
      setBotSetupError,
      creatingAgent,
      setCreatingAgent,
      duplicatingBotIds,
      setDuplicatingBotIds,
      setActiveBotId,
      setSettingsRequest,
      setUiErrors,
      appendUiError,
      analyticsAgentProperties,
    } = useAgents();
    const {
      setLiveMessages,
      setConversationLoaded,
      setConversationRevisions,
      setUnreadReplies,
      setConversationReads,
      setRecentReplies,
      rawAgentMessageBodies,
    } = useConversation();
    const { setActiveTurns, setFailedTurns, setQueues, setPendingPrompts } = useTurns();
    const { setSidebarLayout, removePinnedSidebarItemEverywhere } = useSidebar();
    const { clearDirectSelection } = useDirectMessages();
    const { selectBot } = useNavigation();

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
        clearDirectSelection();
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

    function editBot(botId: string) {
      if (botSetupOpen() && creatingAgent()) return;
      selectBot(botId);
      setSettingsRequest({ botId, nonce: Date.now() });
    }

    async function duplicateBot(botId: string): Promise<void> {
      if (botSetupOpen() && creatingAgent()) return;
      if (!activeServerSupportsCapability("agent-duplication") || duplicatingBotIds().has(botId)) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(botId);
      setDuplicatingBotIds((current) => new Set(current).add(botId));
      try {
        const result = await window.openbot.agent.duplicateBot(botId);
        if (activeServerId() !== serverId) return;
        const profile = toBotProfile(result.bot);
        setBotList((current) => [profile, ...current.filter((candidate) => candidate.id !== profile.id)]);
        setSidebarLayout(result.layout);
        selectBot(result.bot.id);
        analytics.track("agent_action", { action: "duplicate", result: "succeeded", ...(properties ?? {}) });
      } catch (error) {
        analytics.track("agent_action", {
          action: "duplicate",
          result: "failed",
          failure_code: "duplicate_failed",
          ...(properties ?? {}),
        });
        toast.error("Could not duplicate agent", {
          description: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        setDuplicatingBotIds((current) => {
          const next = new Set(current);
          next.delete(botId);
          return next;
        });
      }
    }

    async function deleteBot(botId: string) {
      if (botSetupOpen() && creatingAgent()) return;
      const serverId = activeServerId();
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
        deleteAgentMessageBodies(rawAgentMessageBodies, botId);
        setUiErrors((current) => withoutBot(current, agentConversationKey(activeServerId(), botId)));
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
        appendUiError(botId, error, "Delete failed", serverId);
        throw error;
      }
    }

    return { createAgent, editBot, duplicateBot, deleteBot };
  },
});

export const AgentActionsProvider = AgentActions.provider;
export const useAgentActions = AgentActions.use;
