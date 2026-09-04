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
import { botProfilesEqual, toBotProfile } from "./app-message-projection";
import { createStoredProfile, updateStored } from "./app-stored-values";
import { createFirstBotDraft, type FirstBotDraft } from "./components/FirstAgentSetup";
import type { BotProfile } from "./data";
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
 * - **`activeBotId` and `activeBot`.** `activeBot` returns `undefined` while a
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
    const { uiErrors, setUiErrors, appendUiError } = useUiErrors();

    const [botList, setBotList] = createSignal<BotProfile[]>([]);
    const [duplicatingBotIds, setDuplicatingBotIds] = createSignal<Set<string>>(new Set());
    const [modelOptions, setModelOptions] = createSignal<AgentModelOption[]>([]);
    const [activeBotId, setActiveBotId] = createSignal("");
    const [agentChatOpenRevision, setAgentChatOpenRevision] = createSignal(0);
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
    };
  },
});

export const AgentsProvider = Agents.provider;
export const useAgents = Agents.use;
