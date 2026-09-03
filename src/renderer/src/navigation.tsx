import { createSignal } from "solid-js";
import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import { toBotMessage } from "./app-message-projection";
import { useConversation } from "./conversation";
import { agentConversationKey } from "./conversation-keys";
import type { BotMessage } from "./data";
import { useDirectMessages } from "./direct-messages";
import { usePlatform } from "./platform";
import { usePresence } from "./presence";
import { createScopeGuard } from "./scope-lifetime";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

/**
 * Opening things: an agent chat, a direct conversation, one message inside
 * either, and the global search that finds them.
 *
 * This is the leaf, and it is a context rather than a set of loose functions
 * because of what `selectBot` does. One call writes to agents (setup dialog,
 * active id, chat-open revision), to conversation (history pruning, reply
 * indicators, the read-tracking sets) and to direct messages (typing, selection)
 * - three domains, none of which may reach into the others. A command that
 * spans domains belongs below all of them, where it can read every one it needs
 * and nothing can read it back. That is also why nothing here is imported by
 * another context: an edge inward is a cycle, and `noImportCycles` is an error.
 *
 * `messageFocusRequest` is the `{ id, nonce }` request signal the renderer uses
 * elsewhere: the transcript is not this domain's to scroll, so it publishes
 * which message wants focus and the view reacts. The nonce carries the case of
 * focusing the same message twice.
 *
 * Ungated - see `app-providers.tsx`.
 */
const Navigation = createSimpleContext({
  name: "Navigation",
  init: () => {
    const { peopleEnabled } = usePlatform();
    const { activeServerId } = useServers();
    const { currentTeamMember, directPeople } = usePresence();
    const {
      activeBotId,
      setActiveBotId,
      botSetupOpen,
      setBotSetupOpen,
      setBotSetupError,
      creatingAgent,
      setSettingsRequest,
      setExplicitlyOpenedAgentChatId,
      setAgentChatOpenRevision,
      appendUiError,
    } = useAgents();
    const { setDirectTyping, clearDirectSelection, openDirectConversation } = useDirectMessages();
    const scopeIsCurrent = createScopeGuard();
    const {
      pruneInactiveAgentHistory,
      clearReplyIndicators,
      autoReadAgentMessages,
      agentChatsToMarkRead,
      agentChatsRetriedOnOpen,
      conversationPageRequests,
      applyConversationPage,
      markAgentMessagesRead,
    } = useConversation();

    const [globalSearchOpen, setGlobalSearchOpen] = createSignal(false);
    const [messageFocusRequest, setMessageFocusRequest] = createSignal<{
      botId: string;
      messageId: string;
      nonce: number;
    } | null>(null);

    function selectBot(botId: string) {
      if (botSetupOpen() && creatingAgent()) return;
      const previousBotId = activeBotId();
      if (previousBotId && previousBotId !== botId) pruneInactiveAgentHistory(previousBotId);
      setBotSetupOpen(false);
      setBotSetupError(null);
      setDirectTyping(false);
      clearDirectSelection();
      clearReplyIndicators(botId);
      const trackingKey = agentConversationKey(activeServerId(), botId);
      autoReadAgentMessages.delete(trackingKey);
      agentChatsToMarkRead.add(trackingKey);
      agentChatsRetriedOnOpen.delete(botId);
      setExplicitlyOpenedAgentChatId(botId);
      setActiveBotId(botId);
      setAgentChatOpenRevision((current) => current + 1);
    }

    async function selectDirectMember(memberId: string): Promise<void> {
      if (botSetupOpen() && creatingAgent()) return;
      if (!peopleEnabled || !currentTeamMember() || !directPeople().some((member) => member.id === memberId)) return;
      const previousBotId = activeBotId();
      if (previousBotId) pruneInactiveAgentHistory(previousBotId);
      setExplicitlyOpenedAgentChatId(null);
      setBotSetupOpen(false);
      setBotSetupError(null);
      setSettingsRequest(null);
      await openDirectConversation(memberId);
    }

    function setGlobalSearchVisibility(open: boolean): void {
      setGlobalSearchOpen(open);
    }

    async function searchGlobalMessages(query: string): Promise<Array<{ botId: string; message: BotMessage }>> {
      const analytics = desktopAnalytics.scope();
      try {
        const page = await window.openbot.agent.searchConversationMessages({ query, limit: 100 });
        analytics.track("search_action", { scope: "global", result: "succeeded", result_count: page.total });
        return page.results.map((result) => ({
          botId: result.botId,
          message: toBotMessage(result.message, result.botId),
        }));
      } catch (error) {
        analytics.track("search_action", { scope: "global", result: "failed", failure_code: "search_failed" });
        throw error;
      }
    }

    function selectGlobalSearchMessage(botId: string, messageId: string): void {
      selectBot(botId);
      void openAgentMessage(botId, messageId);
    }

    async function openAgentMessage(botId: string, messageId: string): Promise<void> {
      const serverId = activeServerId();
      await Promise.resolve();
      if (!scopeIsCurrent()) return;
      const request = (conversationPageRequests.get(botId) ?? 0) + 1;
      conversationPageRequests.set(botId, request);
      try {
        const page = await window.openbot.agent.readConversationPage({
          botId,
          anchor: { type: "around", messageId },
          limit: 50,
        });
        if (conversationPageRequests.get(botId) !== request || !scopeIsCurrent()) return;
        if (!page.messages.some((message) => message.id === messageId)) {
          throw new Error("This message is no longer available.");
        }
        applyConversationPage(page, "replace", "around");
        setMessageFocusRequest({ botId, messageId, nonce: Date.now() });
        try {
          let readBoundary = page.messages.at(-1)?.id ?? messageId;
          try {
            if (!scopeIsCurrent()) return;
            const latestPage = await window.openbot.agent.readConversationPage({
              botId,
              anchor: { type: "latest" },
              limit: 1,
            });
            if (!scopeIsCurrent()) return;
            readBoundary = latestPage.messages.at(-1)?.id ?? readBoundary;
          } catch {
            // The focused page still gives us a safe read boundary when the latest-page refresh fails.
          }
          await markAgentMessagesRead(botId, readBoundary, serverId);
        } catch (error) {
          appendUiError(botId, error, "Read state failed", serverId);
        }
      } catch (error) {
        appendUiError(botId, error, "Message load failed", serverId);
      }
    }

    return {
      selectBot,
      selectDirectMember,
      openAgentMessage,
      messageFocusRequest,
      globalSearchOpen,
      setGlobalSearchVisibility,
      searchGlobalMessages,
      selectGlobalSearchMessage,
    };
  },
});

export const NavigationProvider = Navigation.provider;
export const useNavigation = Navigation.use;
