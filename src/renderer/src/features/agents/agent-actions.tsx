import { desktopAnalytics } from "../../analytics";
import { toAgentProfile, withoutAgent } from "../../app-message-projection";
import { createStoredProfile } from "../../app-stored-values";
import { toast } from "../../components/ui";
import { useNavigation } from "../../navigation";
import { createScopeGuard } from "../../scope-lifetime";
import { createSimpleContext } from "../../simple-context";
import { useTurns } from "../../turns";
import { useConversation } from "../conversation/conversation-context";
import { agentConversationKey, deleteAgentMessageBodies } from "../conversation/conversation-keys";
import { useDirectMessages } from "../conversation/direct-messages-context";
import { useServers } from "../servers/servers-context";
import { useSidebar } from "../sidebar/sidebar-context";
import { createAgentInitialMessage } from "./agent-initial-message";
import { useAgents } from "./agents-context";
import type { FirstAgentDraft } from "./FirstAgentSetup";

/**
 * Creating, editing, duplicating and deleting an agent.
 *
 * A leaf, and it has to be one: `deleteAgent` alone writes to agents,
 * conversation, turns, sidebar and navigation, so no domain can own it without
 * reaching into one nested under itself. This is the shape the dependency rule
 * pushes every multi-domain command into - state lives outward, the command
 * that spans several domains lives at the bottom and reads all of them.
 *
 * The four share one guard, `agentSetupOpen() && creatingAgent()`: while the
 * first-agent form is mid-submit there is no agent to act on yet, and letting a
 * second write through would race the one in flight.
 *
 * `deleteAgent` removes the agent from twelve maps by hand rather than letting a
 * projection drop it. Every one of them is keyed by agent id and outlives the
 * agent otherwise, so a missed key is a leak that shows up as a stale badge on
 * an agent that no longer exists.
 */
const AgentActions = createSimpleContext({
  name: "Agent actions",
  init: () => {
    const { activeServerId, activeServerSupportsCapability } = useServers();
    const scopeIsCurrent = createScopeGuard();
    const {
      agentList,
      setAgentList,
      agentSetupOpen,
      setAgentSetupOpen,
      agentSetupDraft,
      setAgentSetupError,
      creatingAgent,
      setCreatingAgent,
      duplicatingAgentIds,
      setDuplicatingAgentIds,
      setActiveAgentId,
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
    const { selectAgent } = useNavigation();

    async function createAgent(draft: FirstAgentDraft = agentSetupDraft()) {
      if (creatingAgent()) return;
      const analytics = desktopAnalytics.scope();
      const submitted = { ...draft };
      setCreatingAgent(true);
      setAgentSetupError(null);
      try {
        const stored = await window.openbot.agent.createAgent({
          name: submitted.name.trim(),
          description: submitted.purpose.trim(),
          avatarSeed: submitted.avatarSeed,
          avatarHue: submitted.avatarHue,
          initialMessage: createAgentInitialMessage(submitted),
        });
        const newAgent = createStoredProfile(toAgentProfile(stored));
        setAgentList((current) => [newAgent, ...current.filter((item) => item.id !== newAgent.id)]);
        setLiveMessages((current) => (current[newAgent.id] ? current : { ...current, [newAgent.id]: [] }));
        setConversationLoaded((current) => ({ ...current, [newAgent.id]: true }));
        setAgentSetupOpen(false);
        clearDirectSelection();
        setActiveAgentId(newAgent.id);
        const properties = analyticsAgentProperties(newAgent.id);
        analytics.track("agent_action", { action: "create", result: "succeeded", ...(properties ?? {}) });
      } catch (error) {
        analytics.track("agent_action", { action: "create", result: "failed", failure_code: "create_failed" });
        setAgentSetupError(error instanceof Error ? error.message : "The agent could not be created.");
      } finally {
        setCreatingAgent(false);
      }
    }

    function editAgent(agentId: string) {
      if (agentSetupOpen() && creatingAgent()) return;
      selectAgent(agentId);
      setSettingsRequest({ agentId, nonce: Date.now() });
    }

    async function duplicateAgent(agentId: string): Promise<void> {
      if (agentSetupOpen() && creatingAgent()) return;
      if (!activeServerSupportsCapability("agent-duplication") || duplicatingAgentIds().has(agentId)) return;
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      setDuplicatingAgentIds((current) => new Set(current).add(agentId));
      try {
        const result = await window.openbot.agent.duplicateAgent(agentId);
        if (!scopeIsCurrent()) return;
        const profile = toAgentProfile(result.agent);
        setAgentList((current) => [profile, ...current.filter((candidate) => candidate.id !== profile.id)]);
        setSidebarLayout(result.layout);
        selectAgent(result.agent.id);
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
        setDuplicatingAgentIds((current) => {
          const next = new Set(current);
          next.delete(agentId);
          return next;
        });
      }
    }

    async function deleteAgent(agentId: string) {
      if (agentSetupOpen() && creatingAgent()) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      const marketplaceAgent = Boolean(agentList().find((agent) => agent.id === agentId)?.marketplaceSource);
      try {
        await window.openbot.agent.deleteAgent(agentId);
        const remaining = agentList().filter((agent) => agent.id !== agentId);
        setAgentList(remaining);
        setActiveAgentId((current) => (current === agentId ? (remaining[0]?.id ?? "") : current));
        setSettingsRequest((current) => (current?.agentId === agentId ? null : current));
        setLiveMessages((current) => withoutAgent(current, agentId));
        deleteAgentMessageBodies(rawAgentMessageBodies, agentId);
        setUiErrors((current) => withoutAgent(current, agentConversationKey(activeServerId(), agentId)));
        setConversationLoaded((current) => withoutAgent(current, agentId));
        setConversationRevisions((current) => withoutAgent(current, agentId));
        setActiveTurns((current) => withoutAgent(current, agentId));
        setFailedTurns((current) => withoutAgent(current, agentId));
        setUnreadReplies((current) => withoutAgent(current, agentId));
        setConversationReads((current) => withoutAgent(current, agentId));
        setRecentReplies((current) => withoutAgent(current, agentId));
        setQueues((current) => withoutAgent(current, agentId));
        setPendingPrompts((current) => withoutAgent(current, agentId));
        removePinnedSidebarItemEverywhere({ kind: "agent", id: agentId });
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
        appendUiError(agentId, error, "Delete failed", serverId);
        throw error;
      }
    }

    return { createAgent, editAgent, duplicateAgent, deleteAgent };
  },
});

export const AgentActionsProvider = AgentActions.provider;
export const useAgentActions = AgentActions.use;
