import type {
  AgentModelOption,
  AgentStatus,
  AvatarImageInput,
  BotSummary,
  UpdateBotInput,
} from "@openbot/contracts/ipc";
import { createMemo, createSignal } from "solid-js";
import { desktopAnalytics } from "./analytics";
import { FALLBACK_STATUS } from "./app-defaults";
import { botProfilesEqual, formatTime, toBotProfile } from "./app-message-projection";
import { createStoredProfile, updateStored } from "./app-stored-values";
import { createFirstBotDraft, type FirstBotDraft } from "./components/FirstBotSetup";
import { agentConversationKey } from "./conversation-keys";
import type { BotMessage, BotProfile } from "./data";
import { useDirectMessages } from "./direct-messages";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/**
 * The agents on the active server: the roster, which one is open, the provider
 * runtime's status behind them, and the first-run setup sheet.
 *
 * Three things live here that the plan's inventory filed elsewhere, each for a
 * reason worth keeping:
 *
 * - **`activeBotId` and `activeBot`.** `activeBot` returns `undefined` while a
 *   person's conversation is open, so it has to read `activeDirectMember()`;
 *   that is the whole reason this provider nests inside direct messages. Every
 *   other reader of the pair is either in this file or nested below it.
 * - **`uiErrors` and `appendUiError`.** Twenty-odd commands across conversation,
 *   turns and navigation append to it, and all of them sit below this provider.
 *   Its key is `agentConversationKey(serverId, botId)`, which is why nothing
 *   clears it on a server switch: entries for another server can never be read
 *   back. It is the inline error feed of an agent's message list, so it belongs
 *   with the agent rather than with the conversation that renders it.
 * - **`explicitlyOpenedAgentChatId`**, as an accessor pair rather than a signal.
 *   It is read inside event handling to decide whether a page the user asked
 *   for may overwrite what is on screen; making it reactive would re-run that
 *   handling on a value that is only ever consulted, never watched.
 *
 * **The commands that create, duplicate, edit or delete an agent are still in
 * the controller.** Each writes several domains nested under this one -
 * `createAgent` seeds `liveMessages` and `conversationLoaded`, `duplicateBot`
 * replaces the sidebar layout, `deleteBot` prunes ten different maps - so they
 * belong to the navigation leaf, not here. What moved is everything an agent
 * owns on its own: the roster, the open one, the setup sheet, and the two
 * updates (`updateBot`, `setAgentAvatar`) that touch nothing else.
 *
 * `applyStoredBots` opens the setup sheet when the roster comes back empty.
 * That is load-bearing for a fresh install, and it is deliberately *not*
 * guarded on the sheet already being open by anything but `botSetupOpen()` -
 * re-running it while the user is typing a draft would discard the draft.
 */
const Agents = createSimpleContext({
  name: "Agents",
  init: () => {
    const { activeServer, activeServerId } = useServers();
    const { activeDirectMember, setDirectTyping } = useDirectMessages();

    const [botList, setBotList] = createSignal<BotProfile[]>([]);
    const [duplicatingBotIds, setDuplicatingBotIds] = createSignal<Set<string>>(new Set());
    const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
    const [activeBotId, setActiveBotId] = createSignal("");
    const [agentChatOpenRevision, setAgentChatOpenRevision] = createSignal(0);
    const [uiErrors, setUiErrors] = createSignal<Record<string, BotMessage[]>>({});
    const [botSetupOpen, setBotSetupOpen] = createSignal(false);
    const [botSetupDraft, setBotSetupDraft] = createSignal<FirstBotDraft>(createFirstBotDraft());
    const [botSetupError, setBotSetupError] = createSignal<string | null>(null);
    const [creatingAgent, setCreatingAgent] = createSignal(false);
    const [settingsRequest, setSettingsRequest] = createSignal<{
      botId: string;
      nonce: number;
    } | null>(null);
    const [agentStatus, setAgentStatus] = createSignal<AgentStatus>(FALLBACK_STATUS);
    let openedAgentChatId: string | null = null;

    const activeBot = createMemo(() => {
      if (activeDirectMember()) return undefined;
      return botList().find((bot) => bot.id === activeBotId()) ?? botList()[0];
    });

    function explicitlyOpenedAgentChatId(): string | null {
      return openedAgentChatId;
    }

    function setExplicitlyOpenedAgentChatId(botId: string | null): void {
      openedAgentChatId = botId;
    }

    function analyticsAgentProperties(botId: string) {
      const bot = botList().find((candidate) => candidate.id === botId);
      if (!bot) return null;
      return {
        provider: bot.provider,
        model: bot.model,
        reasoning_effort: bot.reasoningEffort,
        server_kind: activeServer()?.kind ?? ("unknown" as const),
      };
    }

    function applyStoredBots(storedBots: BotSummary[]): void {
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

    function appendUiError(botId: string, error: unknown, status: string, serverId: string): void {
      const body = error instanceof Error ? error.message : String(error);
      const errorKey = agentConversationKey(serverId, botId);
      setUiErrors((current) => ({
        ...current,
        [errorKey]: [
          ...(current[errorKey] ?? []),
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

    function openBotSetup(): void {
      if (botSetupOpen()) return;
      setDirectTyping(false);
      setBotSetupDraft(createFirstBotDraft());
      setBotSetupError(null);
      openedAgentChatId = null;
      setBotSetupOpen(true);
    }

    function cancelBotSetup(): void {
      if (creatingAgent() || botList().length === 0) return;
      setBotSetupOpen(false);
      setBotSetupError(null);
      setBotSetupDraft(createFirstBotDraft());
    }

    async function updateBot(botId: string, updates: Omit<UpdateBotInput, "botId">): Promise<void> {
      const serverId = activeServerId();
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
        appendUiError(botId, error, "Settings failed", serverId);
        throw error;
      }
    }

    async function setAgentAvatar(botId: string, image: AvatarImageInput | null): Promise<void> {
      const serverId = activeServerId();
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
        appendUiError(botId, error, "Avatar update failed", serverId);
        throw error;
      }
    }

    /**
     * The agent slice of the teardown `selectServer` runs. `uiErrors` is not in
     * it on purpose: its keys carry the server id, so the entries of a server
     * you left can never be read back under the one you switched to.
     */
    function resetForServer(): void {
      setBotSetupOpen(false);
      setBotSetupError(null);
      setSettingsRequest(null);
      setBotList([]);
      setActiveBotId("");
      openedAgentChatId = null;
    }

    return {
      botList,
      setBotList,
      duplicatingBotIds,
      setDuplicatingBotIds,
      modelOptions,
      setModelOptions,
      activeBotId,
      setActiveBotId,
      activeBot,
      agentChatOpenRevision,
      setAgentChatOpenRevision,
      uiErrors,
      setUiErrors,
      appendUiError,
      botSetupOpen,
      setBotSetupOpen,
      botSetupDraft,
      setBotSetupDraft,
      botSetupError,
      setBotSetupError,
      creatingAgent,
      setCreatingAgent,
      settingsRequest,
      setSettingsRequest,
      agentStatus,
      setAgentStatus,
      explicitlyOpenedAgentChatId,
      setExplicitlyOpenedAgentChatId,
      analyticsAgentProperties,
      applyStoredBots,
      openBotSetup,
      cancelBotSetup,
      updateBot,
      setAgentAvatar,
      resetForServer,
    };
  },
});

export const AgentsProvider = Agents.provider;
export const useAgents = Agents.use;
