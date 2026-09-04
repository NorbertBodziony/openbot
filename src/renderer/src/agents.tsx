import type {
  AgentModelOption,
  AgentStatus,
  AgentSummary,
  AvatarImageInput,
  UpdateAgentInput,
} from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { FALLBACK_STATUS } from "./app-defaults";
import { agentProfilesEqual, toAgentProfile } from "./app-message-projection";
import { createStoredProfile, updateStored } from "./app-stored-values";
import { createFirstAgentDraft, type FirstAgentDraft } from "./components/FirstAgentSetup";
import type { AgentProfile } from "./data";
import { useDirectMessages } from "./direct-messages";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";
import { useUiErrors } from "./ui-errors";

/**
 * The agents on the active server: the roster, which one is open, the provider
 * runtime's status behind them, and the first-run setup sheet.
 *
 * Three things live here that the plan's inventory filed elsewhere, each for a
 * reason worth keeping:
 *
 * - **`activeAgentId` and `activeAgent`.** `activeAgent` returns `undefined` while a
 *   person's conversation is open, so it has to read `activeDirectMember()`;
 *   that is the whole reason this provider nests inside direct messages. Every
 *   other reader of the pair is either in this file or nested below it.
 * - **`uiErrors` and `appendUiError`, borrowed from `ui-errors.tsx`.** Twenty-odd
 *   commands across conversation, turns and navigation append to it, and all of
 *   them sit below this provider, so this is where they reach it. The store
 *   itself lives above the per-server scope, because a command can outlive the
 *   workspace that issued it - a voice message transcribed after the user has
 *   moved on still fails against the server it was dictated on, and its error has
 *   to be there when they come back.
 * - **`explicitlyOpenedAgentChatId`**, as an accessor pair rather than a signal.
 *   It is read inside event handling to decide whether a page the user asked
 *   for may overwrite what is on screen; making it reactive would re-run that
 *   handling on a value that is only ever consulted, never watched.
 *
 * **The commands that create, duplicate, edit or delete an agent are still in
 * the controller.** Each writes several domains nested under this one -
 * `createAgent` seeds `liveMessages` and `conversationLoaded`, `duplicateAgent`
 * replaces the sidebar layout, `deleteAgent` prunes ten different maps - so they
 * belong to the navigation leaf, not here. What moved is everything an agent
 * owns on its own: the roster, the open one, the setup sheet, and the two
 * updates (`updateAgent`, `setAgentAvatar`) that touch nothing else.
 *
 * `applyStoredAgents` opens the setup sheet when the roster comes back empty.
 * That is load-bearing for a fresh install, and it is deliberately *not*
 * guarded on the sheet already being open by anything but `agentSetupOpen()` -
 * re-running it while the user is typing a draft would discard the draft.
 */
const Agents = createSimpleContext({
  name: "Agents",
  init: () => {
    const { activeServer, activeServerId } = useServers();
    const { activeDirectMember, setDirectTyping } = useDirectMessages();
    const { uiErrors, setUiErrors, appendUiError } = useUiErrors();

    const [agentList, setAgentList] = createSignal<AgentProfile[]>([]);
    const [duplicatingAgentIds, setDuplicatingAgentIds] = createSignal<Set<string>>(new Set());
    const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
    const [activeAgentId, setActiveAgentId] = createSignal("");
    const [agentChatOpenRevision, setAgentChatOpenRevision] = createSignal(0);
    const [agentSetupOpen, setAgentSetupOpen] = createSignal(false);
    const [agentSetupDraft, setAgentSetupDraft] = createSignal<FirstAgentDraft>(createFirstAgentDraft());
    const [agentSetupError, setAgentSetupError] = createSignal<string | null>(null);
    const [creatingAgent, setCreatingAgent] = createSignal(false);
    const [settingsRequest, setSettingsRequest] = createSignal<{
      agentId: string;
      nonce: number;
    } | null>(null);
    const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
    let openedAgentChatId: string | null = null;

    const activeAgent = createMemo(() => {
      if (activeDirectMember()) return undefined;
      return agentList().find((agent) => agent.id === activeAgentId()) ?? agentList()[0];
    });

    function explicitlyOpenedAgentChatId(): string | null {
      return openedAgentChatId;
    }

    function setExplicitlyOpenedAgentChatId(agentId: string | null): void {
      openedAgentChatId = agentId;
    }

    function analyticsAgentProperties(agentId: string) {
      const agent = agentList().find((candidate) => candidate.id === agentId);
      if (!agent) return null;
      return {
        provider: agent.provider,
        model: agent.model,
        reasoning_effort: agent.reasoningEffort,
        server_kind: activeServer()?.kind ?? ("unknown" as const),
      };
    }

    function applyStoredAgents(storedAgents: AgentSummary[]): void {
      const currentById = new Map(agentList().map((agent) => [agent.id, agent]));
      const profiles = storedAgents.map((stored) => {
        const next = toAgentProfile(stored);
        const existing = currentById.get(next.id);
        if (!existing) return createStoredProfile(next);
        if (!agentProfilesEqual(existing, next)) updateStored(existing, next);
        return existing;
      });
      setAgentList(profiles);
      setActiveAgentId((current) =>
        profiles.some((agent) => agent.id === current) ? current : (profiles[0]?.id ?? ""),
      );
      if (profiles.length === 0 && !agentSetupOpen()) {
        setAgentSetupDraft(createFirstAgentDraft());
        setAgentSetupError(null);
        setAgentSetupOpen(true);
      }
    }

    function openBotSetup(): void {
      if (agentSetupOpen()) return;
      setDirectTyping(false);
      setAgentSetupDraft(createFirstAgentDraft());
      setAgentSetupError(null);
      openedAgentChatId = null;
      setAgentSetupOpen(true);
    }

    function cancelAgentSetup(): void {
      if (creatingAgent() || agentList().length === 0) return;
      setAgentSetupOpen(false);
      setAgentSetupError(null);
      setAgentSetupDraft(createFirstAgentDraft());
    }

    async function updateAgent(agentId: string, updates: Omit<UpdateAgentInput, "agentId">): Promise<void> {
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      const changedFields = Object.keys(updates);
      try {
        const stored = await window.openbot.agent.updateAgent({
          agentId,
          ...updates,
        });
        const next = toAgentProfile(stored);
        setAgentList((current) => {
          const existingIndex = current.findIndex((agent) => agent.id === agentId);
          if (existingIndex === -1) return [...current, createStoredProfile(next)];
          const existing = current[existingIndex];
          if (existing) updateStored(existing, next);
          return [...current];
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
        appendUiError(agentId, error, "Settings failed", serverId);
        throw error;
      }
    }

    async function setAgentAvatar(agentId: string, image: AvatarImageInput | null): Promise<void> {
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      try {
        const stored = await window.openbot.agent.setAvatar({ agentId, image });
        const next = toAgentProfile(stored);
        setAgentList((current) => {
          const existing = current.find((agent) => agent.id === agentId);
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
        appendUiError(agentId, error, "Avatar update failed", serverId);
        throw error;
      }
    }

    return {
      agentList,
      setAgentList,
      duplicatingAgentIds,
      setDuplicatingAgentIds,
      modelOptions,
      setModelOptions,
      activeAgentId,
      setActiveAgentId,
      activeAgent,
      agentChatOpenRevision,
      setAgentChatOpenRevision,
      uiErrors,
      setUiErrors,
      appendUiError,
      agentSetupOpen,
      setAgentSetupOpen,
      agentSetupDraft,
      setAgentSetupDraft,
      agentSetupError,
      setAgentSetupError,
      creatingAgent,
      setCreatingAgent,
      settingsRequest,
      setSettingsRequest,
      agentStatus,
      setAgentStatus,
      explicitlyOpenedAgentChatId,
      setExplicitlyOpenedAgentChatId,
      analyticsAgentProperties,
      applyStoredAgents,
      openBotSetup,
      cancelAgentSetup,
      updateAgent,
      setAgentAvatar,
    };
  },
});

export const AgentsProvider = Agents.provider;
export const useAgents = Agents.use;
