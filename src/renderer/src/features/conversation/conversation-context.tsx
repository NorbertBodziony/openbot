import type {
  AgentEvent,
  ConversationPage,
  ConversationPageInfo,
  ConversationReadState,
  ConversationSnapshot,
} from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { desktopAnalytics } from "../../analytics";
import {
  agentMessagesEqual,
  formatTime,
  retainThinkingMessages,
  toAgentMessage,
  toAgentMessages,
  withoutAgent,
} from "../../app-message-projection";
import { createStoredMessage, updateStored } from "../../app-stored-values";
import type { AgentMessage } from "../../data";
import { usePlatform } from "../../platform";
import { createScopeGuard } from "../../scope-lifetime";
import { createSimpleContext } from "../../simple-context";
import { useTurns } from "../../turns";
import { cleanAgentMessageText } from "../agents/agent-message-text";
import { useAgentReadTracking } from "../agents/agent-read-tracking";
import { useAgents } from "../agents/agents-context";
import { useServers } from "../servers/servers-context";
import { notifyTeamTyping } from "../team/team-typing";
import { agentConversationKey, agentMessageKey, messagePromptRequestKey, promptRequestKey } from "./conversation-keys";
import { mergeConversationPage, windowedSnapshotMessages } from "./conversation-merge";
import {
  appliedConversationRevision,
  decideAgentAutoRead,
  latestIncomingConversationMessage,
  latestVisibleAgentMessageId,
  preserveKnownAgentUnread,
  readStateForMessages,
  retainedAutoReadState,
} from "./conversation-read-state";
import { useDirectMessages } from "./direct-messages-context";

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
 *   chains every `markConversationRead` for an agent behind the previous one, so
 *   two boundaries can never race to become the stored one.
 * - **An optimistic read is owned by `autoReadAgentMessages`.** Whoever wrote the
 *   optimistic state is the only one allowed to roll it back, which is why the
 *   entry is compared by `messageId` before every write.
 * - **A read that fails leaves a retry marker, not a rollback.**
 *   `agentChatsToRetryRead` is what makes the next page apply the read it could
 *   not apply the first time.
 *
 * Everything here lives and dies with one server: the provider is mounted inside
 * the keyed scope, so a switch disposes it and the next mount starts from an
 * empty conversation cache. There is no teardown list to keep in step, which is
 * the point - the twenty setters `selectServer` used to run are now the absence
 * of an owner rather than a sequence someone has to remember to extend.
 *
 * The three sets that track an *unsettled* read are the exception, and they are
 * borrowed from `agent-read-tracking.tsx` rather than owned here. A read is
 * issued against a named server and can still be in flight when the user leaves
 * it, so its retry marker has to survive the switch to be found on the way back.
 * `agentChatsRetriedOnOpen` is the one that stays, because it is keyed by agent id
 * alone and describes this open rather than that read.
 */
const Conversation = createSimpleContext({
  name: "Conversation",
  init: () => {
    const { appFocused } = usePlatform();
    const { activeServerId } = useServers();
    const { agentChatsToMarkRead, agentChatsToRetryRead, autoReadAgentMessages } = useAgentReadTracking();
    const scopeIsCurrent = createScopeGuard();
    const { activeDirectMemberId } = useDirectMessages();
    const {
      activeAgent,
      activeAgentId,
      agentStatus,
      agentChatOpenRevision,
      setAgentChatOpenRevision,
      appendUiError,
      analyticsAgentProperties,
      agentSetupOpen,
      explicitlyOpenedAgentChatId,
      uiErrors,
      setUiErrors,
    } = useAgents();
    const {
      completedTurnByAgent,
      pendingPrompts,
      setPendingPrompts,
      presentedPromptResolutions,
      setPresentedPromptResolutions,
      submittedPromptRequests,
      setSubmittedPromptRequests,
      setActiveTurns,
      setTurnProgress,
    } = useTurns();

    const [liveMessages, setLiveMessages] = createSignal<Record<string, AgentMessage[]>>({});
    const [conversationLoaded, setConversationLoaded] = createSignal<Record<string, boolean>>({});
    const [conversationRevisions, setConversationRevisions] = createSignal<Record<string, number>>({});
    const [conversationPages, setConversationPages] = createSignal<Record<string, ConversationPageInfo>>({});
    const [conversationWindowModes, setConversationWindowModes] = createSignal<Record<string, "latest" | "around">>({});
    const [conversationReferences, setConversationReferences] = createSignal<
      Record<string, Record<string, AgentMessage>>
    >({});
    const rawAgentMessageBodies = new Map<string, string>();
    const [conversationOlderLoading, setConversationOlderLoading] = createSignal<Record<string, boolean>>({});
    const [conversationOlderErrors, setConversationOlderErrors] = createSignal<Record<string, string | null>>({});
    const [unreadReplies, setUnreadReplies] = createSignal<Record<string, number>>({});
    const [conversationReads, setConversationReads] = createSignal<Record<string, ConversationReadState>>({});
    const [recentReplies, setRecentReplies] = createSignal<Record<string, boolean>>({});

    const pendingConversationSnapshots = new Map<string, ConversationSnapshot>();
    const agentChatsRetriedOnOpen = new Set<string>();
    const conversationPageRequests = new Map<string, number>();
    const conversationReadOperations = new Map<string, Promise<void>>();

    let conversationFrame: number | undefined;

    const activeMessages = createMemo(() => {
      const agent = activeAgent();
      if (!agent) return [];
      const prompt = pendingPrompts()[agent.id];
      const requestKey = prompt?.type === "prompt" ? promptRequestKey(prompt.turnId, prompt.requestId) : null;
      const messages = (liveMessages()[agent.id] ?? []).filter(
        (message) =>
          message.questionPrompt?.resolution !== null &&
          (!requestKey || messagePromptRequestKey(message) !== requestKey),
      );
      return [...messages, ...(uiErrors()[agentConversationKey(activeServerId(), agent.id)] ?? [])];
    });

    createEffect(
      () => ({ agentId: activeAgentId(), agentPhase: agentStatus().phase, openRevision: agentChatOpenRevision() }),
      ({ agentId }) => {
        if (!agentId) return;
        const serverId = activeServerId();
        const trackingKey = agentConversationKey(serverId, agentId);
        const pageRequest = (conversationPageRequests.get(agentId) ?? 0) + 1;
        conversationPageRequests.set(agentId, pageRequest);
        void window.openbot.agent
          .readConversationPage({ agentId, anchor: { type: "latest" }, limit: 50 }, serverId)
          .then((page) => {
            if (!scopeIsCurrent() || conversationPageRequests.get(agentId) !== pageRequest) return;
            const pageApplied = applyConversationPage(page, "replace", "latest");
            if (!pageApplied) {
              if (agentChatsToMarkRead.has(trackingKey)) {
                if (!agentChatsRetriedOnOpen.has(agentId)) {
                  agentChatsRetriedOnOpen.add(agentId);
                  setAgentChatOpenRevision((current) => current + 1);
                } else {
                  agentChatsToMarkRead.delete(trackingKey);
                  markLatestVisibleAgentMessageRead(agentId, serverId);
                }
              }
              return;
            }
            agentChatsRetriedOnOpen.delete(agentId);
            const markReadOnOpen = agentChatsToMarkRead.delete(trackingKey);
            if (markReadOnOpen && (page.readState?.unreadCount ?? 0) > 0) {
              void markAgentMessagesRead(agentId, page.messages.at(-1)?.id ?? null, serverId).catch((error) =>
                appendUiError(agentId, error, "Read state failed", serverId),
              );
            } else if (agentChatsToRetryRead.has(trackingKey) && (page.readState?.unreadCount ?? 0) > 0) {
              const latestIncomingMessage = latestIncomingConversationMessage(page.messages);
              if (latestIncomingMessage) autoMarkAgentMessageRead(agentId, latestIncomingMessage.id);
            }
          })
          .catch((error) => {
            if (!scopeIsCurrent() || conversationPageRequests.get(agentId) !== pageRequest) return;
            appendUiError(agentId, error, "Load failed", serverId);
            if (agentChatsToMarkRead.delete(trackingKey)) markLatestVisibleAgentMessageRead(agentId, serverId);
          });
      },
    );

    function applyConversationReads(reads: Record<string, ConversationReadState>): void {
      setConversationReads(reads);
      setUnreadReplies(
        Object.fromEntries(Object.entries(reads).map(([agentId, state]) => [agentId, state.unreadCount])),
      );
    }

    function applyConversationReadState(agentId: string, state: ConversationReadState): void {
      setConversationReads((current) => ({ ...current, [agentId]: state }));
      setUnreadReplies((current) => ({ ...current, [agentId]: state.unreadCount }));
    }

    function scheduleConversation(snapshot: ConversationSnapshot) {
      const agentId = snapshot.agentId;
      const appliedRevision = appliedConversationRevision(conversationRevisions(), agentId);
      const pending = pendingConversationSnapshots.get(agentId);
      const pendingRevision = pending?.revision ?? -1;
      if (snapshot.revision < Math.max(appliedRevision, pendingRevision)) return;
      for (const message of snapshot.messages) {
        const key = agentMessageKey(agentId, message.id);
        if (message.author !== "user" && message.status === "streaming") rawAgentMessageBodies.set(key, message.text);
        else rawAgentMessageBodies.delete(key);
      }
      pendingConversationSnapshots.set(agentId, snapshot);
      if (conversationFrame !== undefined) return;
      conversationFrame = requestAnimationFrame(() => {
        conversationFrame = undefined;
        const snapshots = [...pendingConversationSnapshots.values()];
        pendingConversationSnapshots.clear();
        for (const pendingSnapshot of snapshots) {
          applyConversation(pendingSnapshot, isAgentChatReadable(pendingSnapshot.agentId));
        }
      });
    }

    function isAgentChatOpen(agentId: string): boolean {
      return !agentSetupOpen() && !activeDirectMemberId() && activeAgent()?.id === agentId;
    }

    function isAgentChatReadable(agentId: string): boolean {
      return appFocused() && isAgentChatOpen(agentId);
    }

    /**
     * The fallback for an open whose page never arrived: mark whatever the user
     * can actually see.
     *
     * It is skipped when an optimistic read already names the same boundary,
     * because that read is the same request - either still in flight or already
     * settled - and asking again would only chain a second identical call behind
     * it. The two arrive together whenever a live event advances the chat while
     * the open's page is still on the wire, which is a race, not a rare case.
     */
    function markLatestVisibleAgentMessageRead(agentId: string, serverId: string): void {
      const latestMessageId = latestVisibleAgentMessageId(liveMessages()[agentId]);
      if (!latestMessageId) return;
      if (autoReadAgentMessages.get(agentConversationKey(serverId, agentId))?.messageId === latestMessageId) return;
      void markAgentMessagesRead(agentId, latestMessageId, serverId).catch((error) =>
        appendUiError(agentId, error, "Read state failed", serverId),
      );
    }

    function refreshAgentReadStateAfterFailure(
      agentId: string,
      messageId: string,
      serverId: string,
      minimumRevision: number,
      fallbackState: ConversationReadState | null,
    ): void {
      const trackingKey = agentConversationKey(serverId, agentId);
      const applyFallback = () => {
        if (!scopeIsCurrent() || autoReadAgentMessages.has(trackingKey) || !fallbackState) return;
        const latest = conversationReads()[agentId];
        if (latest?.unreadCount === 0 && latest.throughMessageId === messageId) {
          applyConversationReadState(agentId, fallbackState);
        }
      };
      void window.openbot.agent
        .readConversationPage({ agentId, anchor: { type: "latest" }, limit: 1 }, serverId)
        .then((page) => {
          if (
            !scopeIsCurrent() ||
            autoReadAgentMessages.has(trackingKey) ||
            page.revision < minimumRevision ||
            !page.readState
          ) {
            applyFallback();
            return;
          }
          applyConversationReadState(agentId, page.readState);
        })
        .catch(applyFallback);
    }

    function autoMarkAgentMessageRead(agentId: string, messageId: string, optimisticallyClearUnread = false): void {
      const serverId = activeServerId();
      const trackingKey = agentConversationKey(serverId, agentId);
      const decision = decideAgentAutoRead({
        messageId,
        current: conversationReads()[agentId],
        tracked: autoReadAgentMessages.get(trackingKey),
        optimisticallyClearUnread,
        explicitlyOpened: explicitlyOpenedAgentChatId() === agentId,
        // Read, not consumed: the flag is spent below, on the one path that asks
        // main. It can only be set on that path anyway - a set flag is what stops
        // the decision being `deferred` - so spending it later changes nothing.
        retryingRead: agentChatsToRetryRead.has(trackingKey),
      });
      if (decision.kind === "deferred") return;
      if (decision.kind === "retained") {
        if (decision.state) applyConversationReadState(agentId, decision.state);
        return;
      }
      agentChatsToRetryRead.delete(trackingKey);
      const optimisticState = decision.optimisticState;
      autoReadAgentMessages.set(trackingKey, { messageId, status: "pending", optimisticState });
      if (optimisticState) applyConversationReadState(agentId, optimisticState);
      void markAgentMessagesRead(agentId, messageId, serverId, (state) => {
        if (autoReadAgentMessages.get(trackingKey)?.messageId !== messageId) return;
        autoReadAgentMessages.set(trackingKey, { messageId, status: "succeeded", state });
      }).catch((error) => {
        if (autoReadAgentMessages.get(trackingKey)?.messageId !== messageId) return;
        autoReadAgentMessages.delete(trackingKey);
        agentChatsToRetryRead.add(trackingKey);
        if (!scopeIsCurrent()) return;
        refreshAgentReadStateAfterFailure(
          agentId,
          messageId,
          serverId,
          appliedConversationRevision(conversationRevisions(), agentId),
          decision.rollbackState,
        );
        appendUiError(agentId, error, "Read state failed", serverId);
      });
    }

    function applyConversationDelta(event: Extract<AgentEvent, { type: "conversation-delta" }>) {
      if (event.revision <= appliedConversationRevision(conversationRevisions(), event.agentId)) return;
      const pendingSnapshot = pendingConversationSnapshots.get(event.agentId);
      if (pendingSnapshot) {
        if (event.revision <= pendingSnapshot.revision) return;
        pendingConversationSnapshots.delete(event.agentId);
        applyConversation(pendingSnapshot, isAgentChatReadable(event.agentId));
      }
      setConversationRevisions((current) => ({
        ...current,
        [event.agentId]: event.revision,
      }));

      const messageKey = agentMessageKey(event.agentId, event.messageId);
      let appended = false;
      setLiveMessages((current) => {
        const messages = current[event.agentId] ?? [];
        const existing = messages.find((message) => message.id === event.messageId);
        const thinking = existing
          ? undefined
          : messages.find((message) => message.kind === "thinking" && message.itemIds?.includes(event.messageId));
        const thinkingItemIndex = thinking?.itemIds?.indexOf(event.messageId) ?? -1;
        const rawBody =
          (rawAgentMessageBodies.get(messageKey) ??
            existing?.body ??
            (thinkingItemIndex >= 0 ? thinking?.items?.[thinkingItemIndex] : "") ??
            "") + event.delta;
        rawAgentMessageBodies.set(messageKey, rawBody);
        if (existing) {
          updateStored(existing, {
            ...existing,
            body: cleanAgentMessageText(rawBody),
            streaming: true,
          });
          return current;
        }
        if (thinking && thinkingItemIndex >= 0) {
          const items = [...(thinking.items ?? [])];
          items[thinkingItemIndex] = cleanAgentMessageText(rawBody);
          updateStored(thinking, { ...thinking, items, streaming: true });
          return current;
        }
        const message = createStoredMessage({
          id: event.messageId,
          turnId: event.turnId,
          author: "agent",
          body: cleanAgentMessageText(rawBody),
          time: formatTime(event.createdAt),
          createdAt: event.createdAt,
          streaming: true,
          animate: conversationLoaded()[event.agentId] === true,
          kind: "text",
        });
        appended = true;
        return {
          ...current,
          [event.agentId]: [...(current[event.agentId] ?? []), message],
        };
      });
      if (appended) {
        const readState = conversationReads()[event.agentId];
        if (isAgentChatReadable(event.agentId)) {
          autoMarkAgentMessageRead(event.agentId, event.messageId);
        } else if (readState) {
          applyConversationReadState(event.agentId, {
            ...readState,
            unreadCount: readState.unreadCount + 1,
            firstUnreadMessageId: readState.firstUnreadMessageId ?? event.messageId,
          });
        }
      }
      setConversationLoaded((current) => ({ ...current, [event.agentId]: true }));
    }

    function applyConversation(snapshot: ConversationSnapshot, markNewMessagesRead = false) {
      const agentId = snapshot.agentId;
      if (snapshot.revision < appliedConversationRevision(conversationRevisions(), agentId)) return;
      const initialLoad = conversationLoaded()[agentId] !== true;
      setConversationRevisions((current) => ({
        ...current,
        [agentId]: snapshot.revision,
      }));
      setLiveMessages((current) => {
        const previous = current[agentId] ?? [];
        const previousById = new Map(previous.map((message) => [message.id, message]));
        const allMappedMessages = toAgentMessages(snapshot.messages, snapshot.agentId);
        const pageInfo = conversationPages()[agentId];
        const windowMode = conversationWindowModes()[agentId] ?? "latest";
        const mappedMessages = retainThinkingMessages(
          previous,
          windowedSnapshotMessages(previous, allMappedMessages, {
            hasOlder: pageInfo?.hasOlder === true,
            mode: windowMode,
          }),
        );
        const next = mappedMessages.map((mapped) => {
          const existing = previousById.get(mapped.id);
          if (!existing) return createStoredMessage({ ...mapped, animate: !initialLoad });
          if (!agentMessagesEqual(existing, mapped)) updateStored(existing, mapped);
          return existing;
        });
        if (previous.length === next.length && previous.every((message, index) => message === next[index])) {
          return current;
        }
        return { ...current, [agentId]: next };
      });
      setConversationLoaded((current) => ({ ...current, [agentId]: true }));
      const presentedRequestKey = presentedPromptResolutions()[agentId];
      const pendingPrompt = pendingPrompts()[agentId];
      const pendingRequestKey =
        pendingPrompt?.type === "prompt" ? promptRequestKey(pendingPrompt.turnId, pendingPrompt.requestId) : null;
      const submittedRequestKey = submittedPromptRequests()[agentId];
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
        setPendingPrompts((current) => ({ ...current, [agentId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [agentId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [agentId]: undefined }));
      } else if (
        resolvedPendingPrompt &&
        (activeAgent()?.id !== agentId || !submittedRequestKey || submittedRequestKey !== pendingRequestKey)
      ) {
        setPendingPrompts((current) => ({ ...current, [agentId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [agentId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [agentId]: undefined }));
      }
      setActiveTurns((current) => ({
        ...current,
        [agentId]: completedTurnByAgent.get(agentId) === snapshot.activeTurnId ? null : snapshot.activeTurnId,
      }));
      setTurnProgress((current) => {
        const progress = current[agentId];
        return progress && progress.turnId !== snapshot.activeTurnId ? withoutAgent(current, agentId) : current;
      });
      const readState = conversationReads()[agentId];
      const latestIncomingMessage = markNewMessagesRead
        ? latestIncomingConversationMessage(snapshot.messages)
        : undefined;
      if (latestIncomingMessage) {
        autoMarkAgentMessageRead(agentId, latestIncomingMessage.id);
      } else if (readState) {
        applyConversationReadState(agentId, readStateForMessages(readState, snapshot.messages));
      }
    }

    function applyConversationPage(
      page: ConversationPage,
      merge: "replace" | "older" | "latest",
      windowMode?: "latest" | "around",
    ): boolean {
      if (page.revision < appliedConversationRevision(conversationRevisions(), page.agentId)) return false;
      for (const message of page.messages) {
        const key = agentMessageKey(page.agentId, message.id);
        if (message.author !== "user" && message.status === "streaming") rawAgentMessageBodies.set(key, message.text);
        else rawAgentMessageBodies.delete(key);
      }
      const mapped = toAgentMessages(page.messages, page.agentId);
      setLiveMessages((current) => {
        const currentMessages = current[page.agentId] ?? [];
        const currentById = new Map(currentMessages.map((message) => [message.id, message]));
        const pageMessages = mapped.map((message) => {
          const stored = currentById.get(message.id);
          if (!stored) return createStoredMessage({ ...message, animate: false });
          if (!agentMessagesEqual(stored, message)) updateStored(stored, { ...message, animate: stored.animate });
          return stored;
        });
        return { ...current, [page.agentId]: mergeConversationPage(currentMessages, pageMessages, merge) };
      });
      setConversationReferences((current) => ({
        ...current,
        [page.agentId]: {
          ...(merge === "replace" ? {} : current[page.agentId]),
          ...Object.fromEntries(
            Object.entries(page.references).map(([id, message]) => [id, toAgentMessage(message, page.agentId)]),
          ),
        },
      }));
      setConversationPages((current) => ({ ...current, [page.agentId]: page.pageInfo }));
      if (windowMode) setConversationWindowModes((current) => ({ ...current, [page.agentId]: windowMode }));
      setConversationRevisions((current) => ({ ...current, [page.agentId]: page.revision }));
      setConversationLoaded((current) => ({ ...current, [page.agentId]: true }));
      setActiveTurns((current) => ({
        ...current,
        [page.agentId]: completedTurnByAgent.get(page.agentId) === page.activeTurnId ? null : page.activeTurnId,
      }));
      if (page.readState && merge !== "older") {
        const trackedAutoRead = autoReadAgentMessages.get(agentConversationKey(activeServerId(), page.agentId));
        const latestIncomingMessage = latestIncomingConversationMessage(page.messages);
        const retainedState =
          trackedAutoRead && trackedAutoRead.messageId === latestIncomingMessage?.id
            ? retainedAutoReadState(trackedAutoRead)
            : null;
        applyConversationReadState(page.agentId, retainedState ?? page.readState);
      }
      return true;
    }

    async function loadOlderAgentMessages(agentId = activeAgent()?.id): Promise<void> {
      if (!agentId || conversationOlderLoading()[agentId]) return;
      const pageInfo = conversationPages()[agentId];
      if (!pageInfo?.hasOlder || !pageInfo.olderCursor) return;
      const cursor = pageInfo.olderCursor;
      const requestVersion = conversationPageRequests.get(agentId) ?? 0;
      setConversationOlderLoading((current) => ({ ...current, [agentId]: true }));
      setConversationOlderErrors((current) => ({ ...current, [agentId]: null }));
      try {
        const page = await window.openbot.agent.readConversationPage({
          agentId,
          anchor: { type: "before", cursor },
          limit: 50,
        });
        if (conversationPageRequests.get(agentId) !== requestVersion) return;
        if (conversationPages()[agentId]?.olderCursor !== cursor) return;
        applyConversationPage(page, "older");
      } catch (error) {
        setConversationOlderErrors((current) => ({
          ...current,
          [agentId]: error instanceof Error ? error.message : "Older messages could not load.",
        }));
      } finally {
        setConversationOlderLoading((current) => ({ ...current, [agentId]: false }));
      }
    }

    async function searchAgentMessages(
      agentId: string,
      query: string,
    ): Promise<{ messageIds: string[]; total: number }> {
      const analytics = desktopAnalytics.scope();
      try {
        const page = await window.openbot.agent.searchConversationMessages({ query, agentId, limit: 100 });
        analytics.track("search_action", { scope: "agent", result: "succeeded", result_count: page.total });
        return { messageIds: page.results.map((result) => result.message.id), total: page.total };
      } catch (error) {
        analytics.track("search_action", { scope: "agent", result: "failed", failure_code: "search_failed" });
        throw error;
      }
    }

    function pruneInactiveAgentHistory(agentId: string): void {
      const messages = liveMessages()[agentId];
      if (!messages || messages.length <= 50) return;
      setLiveMessages((current) => {
        const currentMessages = current[agentId];
        if (!currentMessages || currentMessages.length <= 50) return current;
        return { ...current, [agentId]: currentMessages.slice(-50) };
      });
      setConversationReferences((current) => ({ ...current, [agentId]: {} }));
      setConversationPages((current) => ({
        ...current,
        [agentId]: { hasOlder: true, olderCursor: null },
      }));
    }

    async function loadLatestAgentMessages(agentId: string): Promise<void> {
      const request = (conversationPageRequests.get(agentId) ?? 0) + 1;
      conversationPageRequests.set(agentId, request);
      const page = await window.openbot.agent.readConversationPage({
        agentId,
        anchor: { type: "latest" },
        limit: 50,
      });
      if (conversationPageRequests.get(agentId) !== request) return;
      applyConversationPage(page, "replace", "latest");
    }

    function markReplyCompleted(agentId: string) {
      clearRecentReply(agentId);
      if (appFocused()) return;
      setRecentReplies((current) => ({ ...current, [agentId]: true }));
    }

    function clearRecentReply(agentId: string) {
      setRecentReplies((current) => (current[agentId] ? { ...current, [agentId]: false } : current));
    }

    function clearReplyIndicators(agentId: string) {
      clearRecentReply(agentId);
    }

    async function sendMessage(
      body: string,
      attachmentDraftIds: string[],
      replyToMessageId: string | null,
      target?: { agentId: string; serverId: string },
    ): Promise<boolean> {
      const agentId = target?.agentId ?? activeAgent()?.id;
      const serverId = target?.serverId ?? activeServerId();
      if (!agentId || (!body.trim() && attachmentDraftIds.length === 0)) return false;
      return sendMessageToAgent(agentId, body, attachmentDraftIds, replyToMessageId, serverId);
    }

    async function sendMessageToAgent(
      agentId: string,
      body: string,
      attachmentDraftIds: string[],
      replyToMessageId: string | null = null,
      serverId = activeServerId(),
    ): Promise<boolean> {
      const analytics = desktopAnalytics.scope();
      const properties = analyticsAgentProperties(agentId);
      try {
        const input = {
          agentId,
          text: body.trim(),
          attachmentDraftIds,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        };
        const receipt = await window.openbot.agent.sendMessage(input, serverId);
        const errorKey = agentConversationKey(serverId, agentId);
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
          await markAgentMessagesRead(agentId, receipt.deliveries[0]?.id ?? receipt.messageId, serverId);
        } catch (error) {
          appendUiError(agentId, error, "Read state failed", serverId);
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
        appendUiError(agentId, error, "Send failed", serverId);
        return false;
      }
    }

    async function markAgentMessagesRead(
      agentId = activeAgent()?.id,
      throughMessageId?: string | null,
      serverId = activeServerId(),
      onSuccess?: (state: ConversationReadState) => void,
    ): Promise<void> {
      if (!agentId || !scopeIsCurrent()) return;
      const requestKey = agentConversationKey(serverId, agentId);
      const visibleMessageIdAtStart = latestVisibleAgentMessageId(liveMessages()[agentId]);
      const boundary =
        throughMessageId ??
        liveMessages()
          [agentId]?.filter((message) => !message.id.startsWith("thinking:") && !message.id.startsWith("ui-"))
          .at(-1)?.id ??
        null;
      const previousOperation = conversationReadOperations.get(requestKey) ?? Promise.resolve();
      const operation: Promise<void> = previousOperation
        .catch(() => undefined)
        .then(async () => {
          const state: ConversationReadState = await window.openbot.agent.markConversationRead(
            {
              agentId,
              throughMessageId: boundary,
            },
            serverId,
          );
          agentChatsToRetryRead.delete(requestKey);
          const nextState = isAgentChatReadable(agentId)
            ? state
            : preserveKnownAgentUnread(state, boundary, liveMessages()[agentId] ?? []);
          onSuccess?.(nextState);
          const trackedAutoRead = autoReadAgentMessages.get(requestKey);
          const supersededByAutoRead = Boolean(trackedAutoRead && trackedAutoRead.messageId !== boundary);
          if (scopeIsCurrent() && !supersededByAutoRead) {
            applyConversationReadState(agentId, nextState);
            if (nextState.unreadCount === 0) clearRecentReply(agentId);
          }
          const latestMessageId = latestVisibleAgentMessageId(liveMessages()[agentId]);
          if (
            conversationReadOperations.get(requestKey) === operation &&
            scopeIsCurrent() &&
            isAgentChatReadable(agentId) &&
            latestMessageId &&
            latestMessageId !== boundary &&
            latestMessageId !== visibleMessageIdAtStart
          ) {
            queueMicrotask(() => {
              const latestVisibleMessageId = latestVisibleAgentMessageId(liveMessages()[agentId]);
              if (
                scopeIsCurrent() &&
                isAgentChatReadable(agentId) &&
                latestVisibleMessageId &&
                latestVisibleMessageId !== boundary &&
                latestVisibleMessageId !== visibleMessageIdAtStart
              ) {
                void markAgentMessagesRead(agentId, latestVisibleMessageId, serverId).catch((error) =>
                  appendUiError(agentId, error, "Read state failed", serverId),
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

    function presentPromptResolution(agentId: string, turnId: string, requestId: string | number): void {
      const requestKey = promptRequestKey(turnId, requestId);
      if (!requestKey) return;
      const currentPrompt = pendingPrompts()[agentId];
      if (
        currentPrompt?.type !== "prompt" ||
        promptRequestKey(currentPrompt.turnId, currentPrompt.requestId) !== requestKey
      ) {
        return;
      }
      const persisted = (liveMessages()[agentId] ?? []).some(
        (message) => messagePromptRequestKey(message) === requestKey && message.questionPrompt?.resolution !== null,
      );
      if (persisted) {
        setPendingPrompts((current) => ({ ...current, [agentId]: undefined }));
        setPresentedPromptResolutions((current) => ({ ...current, [agentId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [agentId]: undefined }));
        return;
      }
      setPresentedPromptResolutions((current) => ({ ...current, [agentId]: requestKey }));
    }

    // The scheduler holds a frame handle across the microtask boundary, so the
    // provider owns cancelling it. Nothing else here needs teardown.
    onCleanup(() => {
      if (conversationFrame !== undefined) cancelAnimationFrame(conversationFrame);
    });

    /**
     * Everything here is a projection of one server's threads, so the switch
     * clears all of it - the signals and the four tracking collections that key
     * work by agent id. `activeServerId` is part of every tracking key, but
     * `rawAgentMessageBodies` and `conversationPageRequests` are keyed by agent id
     * alone, so clearing them is what keeps a streaming body or an in-flight
     * page request from crossing servers.
     */
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
      setTeamTyping: notifyTeamTyping,
    };
  },
});

export const ConversationProvider = Conversation.provider;
export const useConversation = Conversation.use;
