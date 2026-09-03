import type {
  AgentEvent,
  ConversationPage,
  ConversationPageInfo,
  ConversationReadState,
  ConversationSnapshot,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { cleanAgentMessageText } from "./agent-message-text";
import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import {
  botMessagesEqual,
  formatTime,
  retainThinkingMessages,
  toBotMessage,
  toBotMessages,
} from "./app-message-projection";
import { createStoredMessage, updateStored } from "./app-stored-values";
import { agentConversationKey, agentMessageKey, messagePromptRequestKey, promptRequestKey } from "./conversation-keys";
import {
  type AgentAutoReadEntry,
  appliedConversationRevision,
  decideAgentAutoRead,
  latestIncomingConversationMessage,
  latestVisibleAgentMessageId,
  preserveKnownAgentUnread,
  readStateForMessages,
  retainedAutoReadState,
} from "./conversation-read-state";
import type { BotMessage } from "./data";
import { useDirectMessages } from "./direct-messages";
import { usePlatform } from "./platform";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";
import { useTurns } from "./turns";

/**
 * What each agent has *said*: the messages on screen, the pages they came from,
 * and how much of that the user has read.
 *
 * This is the innermost domain, and the widest: every other per-server domain is
 * already mounted above it, so it can read all of them and nothing has to read
 * it back. That is what lets the appliers live here. A conversation snapshot
 * carries the turn that produced it and the prompt it resolved, so
 * `applyConversation` and `applyConversationPage` write `turns` state as well as
 * their own - a downward edge, and the reason `turns` is nested outside rather
 * than inside as the plan first had it.
 *
 * `presentPromptResolution` arrives here for the mirror-image reason. It is a
 * turn command by subject - it clears a prompt the user has answered - but it
 * decides by reading `liveMessages`, to tell a resolution main has already
 * persisted from one it has not. Kept in `turns` it would need a conversation
 * signal upward; kept here it needs turn setters downward.
 *
 * Read state is the part with real invariants, and they are not local to any one
 * function:
 *
 * - **Reads are serialized per conversation.** `conversationReadOperations`
 *   chains every `markConversationRead` for a bot behind the previous one, so
 *   two boundaries can never race to become the stored one.
 * - **An optimistic read is owned by `autoReadAgentMessages`.** Whoever wrote the
 *   optimistic state is the only one allowed to roll it back, which is why the
 *   entry is compared by `messageId` before every write.
 * - **A read that fails leaves a retry marker, not a rollback.**
 *   `agentChatsToRetryRead` is what makes the next page apply the read it could
 *   not apply the first time.
 *
 * `resetForServer` is the slice of `selectServer`'s teardown that belongs here,
 * moved across unchanged. It deliberately clears less than everything: the
 * queued-read sets (`agentChatsToMarkRead`, `agentChatsToRetryRead`,
 * `autoReadAgentMessages`) and the page caches survive a switch, because two
 * read-state tests turn on a read queued on one server still being retried when
 * the user comes back to it. Keyed scoping in a later step replaces the list;
 * widening it here would change behaviour under cover of a move.
 */
const Conversation = createSimpleContext({
  name: "Conversation",
  init: () => {
    const { appFocused } = usePlatform();
    const { activeServerId } = useServers();
    const { activeDirectMemberId } = useDirectMessages();
    const {
      activeBot,
      activeBotId,
      agentStatus,
      agentChatOpenRevision,
      setAgentChatOpenRevision,
      appendUiError,
      analyticsAgentProperties,
      botSetupOpen,
      explicitlyOpenedAgentChatId,
      uiErrors,
      setUiErrors,
    } = useAgents();
    const {
      completedTurnByBot,
      pendingPrompts,
      setPendingPrompts,
      presentedPromptResolutions,
      setPresentedPromptResolutions,
      submittedPromptRequests,
      setSubmittedPromptRequests,
      setActiveTurns,
    } = useTurns();

    const [liveMessages, setLiveMessages] = createSignal<Record<string, BotMessage[]>>({});
    const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
    const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>({});
    const [conversationPages, setConversationPages] = createSignal<Record<string, ConversationPageInfo>>({});
    const [conversationWindowModes, setConversationWindowModes] = createSignal<Record<string, "latest" | "around">>({});
    const [conversationReferences, setConversationReferences] = createSignal<
      Record<string, Record<string, BotMessage>>
    >({});
    const rawAgentMessageBodies = new Map<string, string>();
    const [conversationOlderLoading, setConversationOlderLoading] = createSignal<Record<string, boolean>>({});
    const [conversationOlderErrors, setConversationOlderErrors] = createSignal<Record<string, string | null>>({});
    const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
    const [conversationReads, setConversationReads] = createSignal<Record<string, ConversationReadState>>({});
    const [recentReplies, setRecentReplies] = createSignal<Record<string, boolean>>({});

    const pendingConversationSnapshots = new Map<string, ConversationSnapshot>();
    const agentChatsToMarkRead = new Set<string>();
    const agentChatsRetriedOnOpen = new Set<string>();
    const autoReadAgentMessages = new Map<string, AgentAutoReadEntry>();
    const agentChatsToRetryRead = new Set<string>();
    const conversationPageRequests = new Map<string, number>();
    const conversationReadOperations = new Map<string, Promise<void>>();

    let conversationFrame: number | undefined;

    const activeMessages = createMemo(() => {
      const bot = activeBot();
      if (!bot) return [];
      const prompt = pendingPrompts()[bot.id];
      const requestKey = prompt?.type === "prompt" ? promptRequestKey(prompt.turnId, prompt.requestId) : null;
      const messages = (liveMessages()[bot.id] ?? []).filter(
        (message) =>
          message.questionPrompt?.resolution !== null &&
          (!requestKey || messagePromptRequestKey(message) !== requestKey),
      );
      return [...messages, ...(uiErrors()[agentConversationKey(activeServerId(), bot.id)] ?? [])];
    });

    createEffect(
      () => ({ botId: activeBotId(), agentPhase: agentStatus().phase, openRevision: agentChatOpenRevision() }),
      ({ botId }) => {
        if (!botId) return;
        const serverId = activeServerId();
        const trackingKey = agentConversationKey(serverId, botId);
        const pageRequest = (conversationPageRequests.get(botId) ?? 0) + 1;
        conversationPageRequests.set(botId, pageRequest);
        void window.openbot.agent
          .readConversationPage({ botId, anchor: { type: "latest" }, limit: 50 }, serverId)
          .then((page) => {
            if (activeServerId() !== serverId || conversationPageRequests.get(botId) !== pageRequest) return;
            const pageApplied = applyConversationPage(page, "replace", "latest");
            if (!pageApplied) {
              if (agentChatsToMarkRead.has(trackingKey)) {
                if (!agentChatsRetriedOnOpen.has(botId)) {
                  agentChatsRetriedOnOpen.add(botId);
                  setAgentChatOpenRevision((current) => current + 1);
                } else {
                  agentChatsToMarkRead.delete(trackingKey);
                  markLatestVisibleAgentMessageRead(botId, serverId);
                }
              }
              return;
            }
            agentChatsRetriedOnOpen.delete(botId);
            const markReadOnOpen = agentChatsToMarkRead.delete(trackingKey);
            if (markReadOnOpen && (page.readState?.unreadCount ?? 0) > 0) {
              void markAgentMessagesRead(botId, page.messages.at(-1)?.id ?? null, serverId).catch((error) =>
                appendUiError(botId, error, "Read state failed", serverId),
              );
            } else if (agentChatsToRetryRead.has(trackingKey) && (page.readState?.unreadCount ?? 0) > 0) {
              const latestIncomingMessage = latestIncomingConversationMessage(page.messages);
              if (latestIncomingMessage) autoMarkAgentMessageRead(botId, latestIncomingMessage.id);
            }
          })
          .catch((error) => {
            if (activeServerId() !== serverId || conversationPageRequests.get(botId) !== pageRequest) return;
            appendUiError(botId, error, "Load failed", serverId);
            if (agentChatsToMarkRead.delete(trackingKey)) markLatestVisibleAgentMessageRead(botId, serverId);
          });
      },
    );

    function applyConversationReads(reads: Record<string, ConversationReadState>): void {
      setConversationReads(reads);
      setUnreadReplies(Object.fromEntries(Object.entries(reads).map(([botId, state]) => [botId, state.unreadCount])));
    }

    function applyConversationReadState(botId: string, state: ConversationReadState): void {
      setConversationReads((current) => ({ ...current, [botId]: state }));
      setUnreadReplies((current) => ({ ...current, [botId]: state.unreadCount }));
    }

    function scheduleConversation(snapshot: ConversationSnapshot) {
      const botId = snapshot.botId;
      const appliedRevision = appliedConversationRevision(conversationRevisions(), botId);
      const pending = pendingConversationSnapshots.get(botId);
      const pendingRevision = pending?.revision ?? -1;
      if (snapshot.revision < Math.max(appliedRevision, pendingRevision)) return;
      for (const message of snapshot.messages) {
        const key = agentMessageKey(botId, message.id);
        if (message.author !== "user" && message.status === "streaming") rawAgentMessageBodies.set(key, message.text);
        else rawAgentMessageBodies.delete(key);
      }
      pendingConversationSnapshots.set(botId, snapshot);
      if (conversationFrame !== undefined) return;
      conversationFrame = requestAnimationFrame(() => {
        conversationFrame = undefined;
        const snapshots = [...pendingConversationSnapshots.values()];
        pendingConversationSnapshots.clear();
        for (const pendingSnapshot of snapshots) {
          applyConversation(pendingSnapshot, isAgentChatReadable(pendingSnapshot.botId));
        }
      });
    }

    function isAgentChatOpen(botId: string): boolean {
      return !botSetupOpen() && !activeDirectMemberId() && activeBot()?.id === botId;
    }

    function isAgentChatReadable(botId: string): boolean {
      return appFocused() && isAgentChatOpen(botId);
    }

    function markLatestVisibleAgentMessageRead(botId: string, serverId: string): void {
      const latestMessageId = latestVisibleAgentMessageId(liveMessages()[botId]);
      if (!latestMessageId) return;
      void markAgentMessagesRead(botId, latestMessageId, serverId).catch((error) =>
        appendUiError(botId, error, "Read state failed", serverId),
      );
    }

    function refreshAgentReadStateAfterFailure(
      botId: string,
      messageId: string,
      serverId: string,
      minimumRevision: number,
      fallbackState: ConversationReadState | null,
    ): void {
      const trackingKey = agentConversationKey(serverId, botId);
      const applyFallback = () => {
        if (activeServerId() !== serverId || autoReadAgentMessages.has(trackingKey) || !fallbackState) return;
        const latest = conversationReads()[botId];
        if (latest?.unreadCount === 0 && latest.throughMessageId === messageId) {
          applyConversationReadState(botId, fallbackState);
        }
      };
      void window.openbot.agent
        .readConversationPage({ botId, anchor: { type: "latest" }, limit: 1 }, serverId)
        .then((page) => {
          if (
            activeServerId() !== serverId ||
            autoReadAgentMessages.has(trackingKey) ||
            page.revision < minimumRevision ||
            !page.readState
          ) {
            applyFallback();
            return;
          }
          applyConversationReadState(botId, page.readState);
        })
        .catch(applyFallback);
    }

    function autoMarkAgentMessageRead(botId: string, messageId: string, optimisticallyClearUnread = false): void {
      const serverId = activeServerId();
      const trackingKey = agentConversationKey(serverId, botId);
      const decision = decideAgentAutoRead({
        messageId,
        current: conversationReads()[botId],
        tracked: autoReadAgentMessages.get(trackingKey),
        optimisticallyClearUnread,
        explicitlyOpened: explicitlyOpenedAgentChatId() === botId,
        // Read, not consumed: the flag is spent below, on the one path that asks
        // main. It can only be set on that path anyway - a set flag is what stops
        // the decision being `deferred` - so spending it later changes nothing.
        retryingRead: agentChatsToRetryRead.has(trackingKey),
      });
      if (decision.kind === "deferred") return;
      if (decision.kind === "retained") {
        if (decision.state) applyConversationReadState(botId, decision.state);
        return;
      }
      agentChatsToRetryRead.delete(trackingKey);
      const optimisticState = decision.optimisticState;
      autoReadAgentMessages.set(trackingKey, { messageId, status: "pending", optimisticState });
      if (optimisticState) applyConversationReadState(botId, optimisticState);
      void markAgentMessagesRead(botId, messageId, serverId, (state) => {
        if (autoReadAgentMessages.get(trackingKey)?.messageId !== messageId) return;
        autoReadAgentMessages.set(trackingKey, { messageId, status: "succeeded", state });
      }).catch((error) => {
        if (autoReadAgentMessages.get(trackingKey)?.messageId !== messageId) return;
        autoReadAgentMessages.delete(trackingKey);
        agentChatsToRetryRead.add(trackingKey);
        if (activeServerId() !== serverId) return;
        refreshAgentReadStateAfterFailure(
          botId,
          messageId,
          serverId,
          appliedConversationRevision(conversationRevisions(), botId),
          decision.rollbackState,
        );
        appendUiError(botId, error, "Read state failed", serverId);
      });
    }

    function applyConversationDelta(event: Extract<AgentEvent, { type: "conversation-delta" }>) {
      if (event.revision <= appliedConversationRevision(conversationRevisions(), event.botId)) return;
      pendingConversationSnapshots.delete(event.botId);
      setConversationRevisions((current) => ({
        ...current,
        [event.botId]: event.revision,
      }));

      const existing = liveMessages()[event.botId]?.find((message) => message.id === event.messageId);
      const messageKey = agentMessageKey(event.botId, event.messageId);
      const rawBody = (rawAgentMessageBodies.get(messageKey) ?? existing?.body ?? "") + event.delta;
      rawAgentMessageBodies.set(messageKey, rawBody);
      if (existing) {
        updateStored(existing, {
          ...existing,
          body: cleanAgentMessageText(rawBody),
          streaming: true,
        });
      } else {
        const message = createStoredMessage({
          id: event.messageId,
          turnId: event.turnId,
          author: "bot",
          body: cleanAgentMessageText(rawBody),
          time: formatTime(event.createdAt),
          createdAt: event.createdAt,
          streaming: true,
          animate: conversationLoaded()[event.botId] === true,
          kind: "text",
        });
        setLiveMessages((current) => ({
          ...current,
          [event.botId]: [...(current[event.botId] ?? []), message],
        }));
        const readState = conversationReads()[event.botId];
        if (isAgentChatReadable(event.botId)) {
          autoMarkAgentMessageRead(event.botId, event.messageId);
        } else if (readState) {
          applyConversationReadState(event.botId, {
            ...readState,
            unreadCount: readState.unreadCount + 1,
            firstUnreadMessageId: readState.firstUnreadMessageId ?? event.messageId,
          });
        }
      }
      setConversationLoaded((current) => ({ ...current, [event.botId]: true }));
    }

    function applyConversation(snapshot: ConversationSnapshot, markNewMessagesRead = false) {
      const botId = snapshot.botId;
      if (snapshot.revision < appliedConversationRevision(conversationRevisions(), botId)) return;
      const initialLoad = conversationLoaded()[botId] !== true;
      setConversationRevisions((current) => ({
        ...current,
        [botId]: snapshot.revision,
      }));
      setLiveMessages((current) => {
        const previous = current[botId] ?? [];
        const previousById = new Map(previous.map((message) => [message.id, message]));
        const allMappedMessages = toBotMessages(snapshot.messages, snapshot.botId);
        const pageInfo = conversationPages()[botId];
        const windowMode = conversationWindowModes()[botId] ?? "latest";
        const mappedMessages = retainThinkingMessages(
          previous,
          pageInfo?.hasOlder
            ? (() => {
                const loadedIds = new Set(previous.map((message) => message.id));
                if (windowMode === "around") {
                  return allMappedMessages.filter((message) => loadedIds.has(message.id));
                }
                const lastLoadedIndex = [...allMappedMessages]
                  .map((message) => message.id)
                  .reduce((last, id, index) => (loadedIds.has(id) ? index : last), -1);
                return allMappedMessages.filter(
                  (message, index) => loadedIds.has(message.id) || index > lastLoadedIndex,
                );
              })()
            : allMappedMessages,
        );
        const next = mappedMessages.map((mapped) => {
          const existing = previousById.get(mapped.id);
          if (!existing) return createStoredMessage({ ...mapped, animate: !initialLoad });
          if (!botMessagesEqual(existing, mapped)) updateStored(existing, mapped);
          return existing;
        });
        if (previous.length === next.length && previous.every((message, index) => message === next[index])) {
          return current;
        }
        return { ...current, [botId]: next };
      });
      setConversationLoaded((current) => ({ ...current, [botId]: true }));
      const presentedRequestKey = presentedPromptResolutions()[botId];
      const pendingPrompt = pendingPrompts()[botId];
      const pendingRequestKey =
        pendingPrompt?.type === "prompt" ? promptRequestKey(pendingPrompt.turnId, pendingPrompt.requestId) : null;
      const submittedRequestKey = submittedPromptRequests()[botId];
      const resolvedPendingPrompt =
        pendingRequestKey !== null &&
        snapshot.messages.some(
          (message) =>
            messagePromptRequestKey(message) === pendingRequestKey && message.questionPrompt?.resolution !== null,
        );
      if (
        presentedRequestKey &&
        snapshot.messages.some(
          (message) =>
            messagePromptRequestKey(message) === presentedRequestKey && message.questionPrompt?.resolution !== null,
        )
      ) {
        setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
      } else if (
        resolvedPendingPrompt &&
        (activeBot()?.id !== botId || !submittedRequestKey || submittedRequestKey !== pendingRequestKey)
      ) {
        setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
      }
      setActiveTurns((current) => ({
        ...current,
        [botId]: completedTurnByBot.get(botId) === snapshot.activeTurnId ? null : snapshot.activeTurnId,
      }));
      const readState = conversationReads()[botId];
      const latestIncomingMessage = markNewMessagesRead
        ? latestIncomingConversationMessage(snapshot.messages)
        : undefined;
      if (latestIncomingMessage) {
        autoMarkAgentMessageRead(botId, latestIncomingMessage.id);
      } else if (readState) {
        applyConversationReadState(botId, readStateForMessages(readState, snapshot.messages));
      }
    }

    function applyConversationPage(
      page: ConversationPage,
      merge: "replace" | "older" | "latest",
      windowMode?: "latest" | "around",
    ): boolean {
      if (page.revision < appliedConversationRevision(conversationRevisions(), page.botId)) return false;
      for (const message of page.messages) {
        const key = agentMessageKey(page.botId, message.id);
        if (message.author !== "user" && message.status === "streaming") rawAgentMessageBodies.set(key, message.text);
        else rawAgentMessageBodies.delete(key);
      }
      const mapped = toBotMessages(page.messages, page.botId);
      setLiveMessages((current) => {
        const currentMessages = current[page.botId] ?? [];
        const currentById = new Map(currentMessages.map((message) => [message.id, message]));
        const pageMessages = mapped.map((message) => {
          const stored = currentById.get(message.id);
          if (!stored) return createStoredMessage({ ...message, animate: false });
          if (!botMessagesEqual(stored, message)) updateStored(stored, { ...message, animate: stored.animate });
          return stored;
        });
        const existing = merge === "replace" ? [] : currentMessages;
        const ids = new Set(mapped.map((message) => message.id));
        return {
          ...current,
          [page.botId]:
            merge === "replace"
              ? pageMessages
              : merge === "older"
                ? [...pageMessages, ...existing.filter((message) => !ids.has(message.id))]
                : [...existing.filter((message) => !ids.has(message.id)), ...pageMessages],
        };
      });
      setConversationReferences((current) => ({
        ...current,
        [page.botId]: {
          ...(merge === "replace" ? {} : current[page.botId]),
          ...Object.fromEntries(
            Object.entries(page.references).map(([id, message]) => [id, toBotMessage(message, page.botId)]),
          ),
        },
      }));
      setConversationPages((current) => ({ ...current, [page.botId]: page.pageInfo }));
      if (windowMode) setConversationWindowModes((current) => ({ ...current, [page.botId]: windowMode }));
      setConversationRevisions((current) => ({ ...current, [page.botId]: page.revision }));
      setConversationLoaded((current) => ({ ...current, [page.botId]: true }));
      setActiveTurns((current) => ({
        ...current,
        [page.botId]: completedTurnByBot.get(page.botId) === page.activeTurnId ? null : page.activeTurnId,
      }));
      if (page.readState && merge !== "older") {
        const trackedAutoRead = autoReadAgentMessages.get(agentConversationKey(activeServerId(), page.botId));
        const latestIncomingMessage = latestIncomingConversationMessage(page.messages);
        const retainedState =
          trackedAutoRead && trackedAutoRead.messageId === latestIncomingMessage?.id
            ? retainedAutoReadState(trackedAutoRead)
            : null;
        applyConversationReadState(page.botId, retainedState ?? page.readState);
      }
      return true;
    }

    async function loadOlderAgentMessages(botId = activeBot()?.id): Promise<void> {
      if (!botId || conversationOlderLoading()[botId]) return;
      const pageInfo = conversationPages()[botId];
      if (!pageInfo?.hasOlder || !pageInfo.olderCursor) return;
      const cursor = pageInfo.olderCursor;
      const requestVersion = conversationPageRequests.get(botId) ?? 0;
      setConversationOlderLoading((current) => ({ ...current, [botId]: true }));
      setConversationOlderErrors((current) => ({ ...current, [botId]: null }));
      try {
        const page = await window.openbot.agent.readConversationPage({
          botId,
          anchor: { type: "before", cursor },
          limit: 50,
        });
        if (conversationPageRequests.get(botId) !== requestVersion) return;
        if (conversationPages()[botId]?.olderCursor !== cursor) return;
        applyConversationPage(page, "older");
      } catch (error) {
        setConversationOlderErrors((current) => ({
          ...current,
          [botId]: error instanceof Error ? error.message : "Older messages could not load.",
        }));
      } finally {
        setConversationOlderLoading((current) => ({ ...current, [botId]: false }));
      }
    }

    async function searchAgentMessages(botId: string, query: string): Promise<{ messageIds: string[]; total: number }> {
      const analytics = desktopAnalytics.scope();
      try {
        const page = await window.openbot.agent.searchConversationMessages({ query, botId, limit: 100 });
        analytics.track("search_action", { scope: "agent", result: "succeeded", result_count: page.total });
        return { messageIds: page.results.map((result) => result.message.id), total: page.total };
      } catch (error) {
        analytics.track("search_action", { scope: "agent", result: "failed", failure_code: "search_failed" });
        throw error;
      }
    }

    function pruneInactiveAgentHistory(botId: string): void {
      const messages = liveMessages()[botId];
      if (!messages || messages.length <= 50) return;
      setLiveMessages((current) => {
        const currentMessages = current[botId];
        if (!currentMessages || currentMessages.length <= 50) return current;
        return { ...current, [botId]: currentMessages.slice(-50) };
      });
      setConversationReferences((current) => ({ ...current, [botId]: {} }));
      setConversationPages((current) => ({
        ...current,
        [botId]: { hasOlder: true, olderCursor: null },
      }));
    }

    async function loadLatestAgentMessages(botId: string): Promise<void> {
      const request = (conversationPageRequests.get(botId) ?? 0) + 1;
      conversationPageRequests.set(botId, request);
      const page = await window.openbot.agent.readConversationPage({
        botId,
        anchor: { type: "latest" },
        limit: 50,
      });
      if (conversationPageRequests.get(botId) !== request) return;
      applyConversationPage(page, "replace", "latest");
    }

    function markReplyCompleted(botId: string) {
      clearRecentReply(botId);
      if (appFocused()) return;
      setRecentReplies((current) => ({ ...current, [botId]: true }));
    }

    function clearRecentReply(botId: string) {
      setRecentReplies((current) => (current[botId] ? { ...current, [botId]: false } : current));
    }

    function clearReplyIndicators(botId: string) {
      clearRecentReply(botId);
    }

    async function sendMessage(
      body: string,
      attachmentDraftIds: string[],
      replyToMessageId: string | null,
      target?: { botId: string; serverId: string },
    ): Promise<boolean> {
      const botId = target?.botId ?? activeBot()?.id;
      const serverId = target?.serverId ?? activeServerId();
      if (!botId || (!body.trim() && attachmentDraftIds.length === 0)) return false;
      return sendMessageToBot(botId, body, attachmentDraftIds, replyToMessageId, serverId);
    }

    async function sendMessageToBot(
      botId: string,
      body: string,
      attachmentDraftIds: string[],
      replyToMessageId: string | null = null,
      serverId = activeServerId(),
    ): Promise<boolean> {
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(botId);
      try {
        const input = {
          botId,
          text: body.trim(),
          attachmentDraftIds,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        };
        const receipt = await window.openbot.agent.sendMessage(input, serverId);
        const errorKey = agentConversationKey(serverId, botId);
        setUiErrors((current) => ({ ...current, [errorKey]: [] }));
        analytics.track("message_send", {
          ...(properties ?? {}),
          channel: "agent",
          attachment_count: attachmentDraftIds.length,
          is_reply: replyToMessageId !== null,
          result: "succeeded",
          delivery_count: receipt.deliveries.length,
        });
        try {
          await markAgentMessagesRead(botId, receipt.deliveries[0]?.id ?? receipt.messageId, serverId);
        } catch (error) {
          appendUiError(botId, error, "Read state failed", serverId);
        }
        return true;
      } catch (error) {
        analytics.track("message_send", {
          ...(properties ?? {}),
          channel: "agent",
          attachment_count: attachmentDraftIds.length,
          is_reply: replyToMessageId !== null,
          result: "failed",
          failure_code: "send_failed",
        });
        appendUiError(botId, error, "Send failed", serverId);
        return false;
      }
    }

    async function markAgentMessagesRead(
      botId = activeBot()?.id,
      throughMessageId?: string | null,
      serverId = activeServerId(),
      onSuccess?: (state: ConversationReadState) => void,
    ): Promise<void> {
      if (!botId || activeServerId() !== serverId) return;
      const requestKey = agentConversationKey(serverId, botId);
      const visibleMessageIdAtStart = latestVisibleAgentMessageId(liveMessages()[botId]);
      const boundary =
        throughMessageId ??
        liveMessages()
          [botId]?.filter((message) => !message.id.startsWith("thinking:") && !message.id.startsWith("ui-"))
          .at(-1)?.id ??
        null;
      const previousOperation = conversationReadOperations.get(requestKey) ?? Promise.resolve();
      const operation: Promise<void> = previousOperation
        .catch(() => undefined)
        .then(async () => {
          const state: ConversationReadState = await window.openbot.agent.markConversationRead(
            {
              botId,
              throughMessageId: boundary,
            },
            serverId,
          );
          agentChatsToRetryRead.delete(requestKey);
          const nextState = isAgentChatReadable(botId)
            ? state
            : preserveKnownAgentUnread(state, boundary, liveMessages()[botId] ?? []);
          onSuccess?.(nextState);
          const trackedAutoRead = autoReadAgentMessages.get(requestKey);
          const supersededByAutoRead = Boolean(trackedAutoRead && trackedAutoRead.messageId !== boundary);
          if (activeServerId() === serverId && !supersededByAutoRead) {
            applyConversationReadState(botId, nextState);
            if (nextState.unreadCount === 0) clearRecentReply(botId);
          }
          const latestMessageId = latestVisibleAgentMessageId(liveMessages()[botId]);
          if (
            conversationReadOperations.get(requestKey) === operation &&
            activeServerId() === serverId &&
            isAgentChatReadable(botId) &&
            latestMessageId &&
            latestMessageId !== boundary &&
            latestMessageId !== visibleMessageIdAtStart
          ) {
            queueMicrotask(() => {
              const latestVisibleMessageId = latestVisibleAgentMessageId(liveMessages()[botId]);
              if (
                activeServerId() === serverId &&
                isAgentChatReadable(botId) &&
                latestVisibleMessageId &&
                latestVisibleMessageId !== boundary &&
                latestVisibleMessageId !== visibleMessageIdAtStart
              ) {
                void markAgentMessagesRead(botId, latestVisibleMessageId, serverId).catch((error) =>
                  appendUiError(botId, error, "Read state failed", serverId),
                );
              }
            });
          }
        });
      conversationReadOperations.set(requestKey, operation);
      try {
        await operation;
      } finally {
        if (conversationReadOperations.get(requestKey) === operation) conversationReadOperations.delete(requestKey);
      }
    }

    function presentPromptResolution(botId: string, turnId: string, requestId: string | number): void {
      const requestKey = promptRequestKey(turnId, requestId);
      if (!requestKey) return;
      const currentPrompt = pendingPrompts()[botId];
      if (
        currentPrompt?.type !== "prompt" ||
        promptRequestKey(currentPrompt.turnId, currentPrompt.requestId) !== requestKey
      ) {
        return;
      }
      const persisted = (liveMessages()[botId] ?? []).some(
        (message) => messagePromptRequestKey(message) === requestKey && message.questionPrompt?.resolution !== null,
      );
      if (persisted) {
        setPendingPrompts((current) => ({ ...current, [botId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [botId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
        return;
      }
      setPresentedPromptResolutions((current) => ({ ...current, [botId]: requestKey }));
    }

    function setTeamTyping(botId: string, typing: boolean): void {
      void window.openbot.servers.setTyping({ botId: typing ? botId : null, typing }).catch(() => {
        // Typing state is optional and must not interrupt message composition.
      });
    }

    // The scheduler holds a frame handle across the microtask boundary, so the
    // provider owns cancelling it. Nothing else here needs teardown.
    onCleanup(() => {
      if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame);
    });

    /**
     * Everything here is a projection of one server's threads, so the switch
     * clears all of it - the signals and the four tracking collections that key
     * work by bot id. `activeServerId` is part of every tracking key, but
     * `rawAgentMessageBodies` and `conversationPageRequests` are keyed by bot id
     * alone, so clearing them is what keeps a streaming body or an in-flight
     * page request from crossing servers.
     */
    function resetForServer(): void {
      setLiveMessages({});
      rawAgentMessageBodies.clear();
      setConversationLoaded({});
      setConversationRevisions({});
      setConversationReads({});
      setConversationWindowModes({});
      setUnreadReplies({});
      agentChatsRetriedOnOpen.clear();
    }

    return {
      liveMessages,
      setLiveMessages,
      conversationLoaded,
      setConversationLoaded,
      conversationRevisions,
      setConversationRevisions,
      conversationPages,
      conversationWindowModes,
      setConversationWindowModes,
      conversationReferences,
      conversationOlderLoading,
      conversationOlderErrors,
      unreadReplies,
      setUnreadReplies,
      conversationReads,
      setConversationReads,
      recentReplies,
      setRecentReplies,
      activeMessages,
      rawAgentMessageBodies,
      agentChatsToMarkRead,
      agentChatsRetriedOnOpen,
      agentChatsToRetryRead,
      autoReadAgentMessages,
      conversationPageRequests,
      applyConversationReads,
      applyConversationReadState,
      scheduleConversation,
      isAgentChatOpen,
      isAgentChatReadable,
      markLatestVisibleAgentMessageRead,
      autoMarkAgentMessageRead,
      applyConversationDelta,
      applyConversation,
      applyConversationPage,
      loadOlderAgentMessages,
      loadLatestAgentMessages,
      pruneInactiveAgentHistory,
      markReplyCompleted,
      clearRecentReply,
      clearReplyIndicators,
      searchAgentMessages,
      sendMessage,
      markAgentMessagesRead,
      presentPromptResolution,
      setTeamTyping,
      resetForServer,
    };
  },
});

export const ConversationProvider = Conversation.provider;
export const useConversation = Conversation.use;
