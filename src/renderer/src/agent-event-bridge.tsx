import type { AgentEvent, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import { flush, onSettled } from "solid-js";
import { cleanAgentMessageText } from "./agent-message-text";
import { useAgents } from "./agents";
import { withoutBot } from "./app-message-projection";
import { useAuth } from "./auth";
import { useBrowserTabs } from "./browser-tabs";
import { playCompletionSoundForAgentEvent } from "./completion-sound";
import { useConversation } from "./conversation";
import { agentConversationKey, agentMessageKey, deleteAgentMessageBodies, promptRequestKey } from "./conversation-keys";
import { latestIncomingConversationMessage } from "./conversation-read-state";
import { reconcileQueuesWithRuntimeWork } from "./dynamic-island-coordinator";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { useServers } from "./servers";
import { useSidebar } from "./sidebar";
import { useTurns } from "./turns";

/**
 * The one subscriber to `agent.onEvent`, and the only place a single event is
 * allowed to write to several domains at once.
 *
 * A component rather than a context because it publishes nothing: it is a
 * write-only edge from main into agents, conversation, turns, browser tabs,
 * sidebar, providers and auth. Everything depends on those domains; nothing
 * depends on this, so the import edge only ever points down and the cycle rule
 * is satisfied by construction.
 *
 * It renders `null` and must stay renderable with no view above it - the
 * harnesses in `App.test.tsx` and `App.read-state.test.tsx` mount the providers
 * with no `AppView` at all, and that is how they drive the app: emit an event,
 * assert the state it produced.
 *
 * The switch is exhaustive on purpose. `conversation-invalidated` returns
 * without doing anything, and that empty case is the record that the event was
 * considered - `tsc` is what would otherwise let a new event type through in
 * silence.
 */
export function AgentEventBridge() {
  const platform = usePlatform();
  const { activeServerId } = useServers();
  const { setAccountUsage } = useAuth();
  const { applyAgentStatus } = useProviders();
  const { botList, setModelOptions, explicitlyOpenedAgentChatId, applyStoredBots, appendUiError } = useAgents();
  const {
    setLiveMessages,
    conversationReads,
    rawAgentMessageBodies,
    agentChatsToRetryRead,
    scheduleConversation,
    isAgentChatReadable,
    autoMarkAgentMessageRead,
    applyConversationDelta,
    applyConversationPage,
    markReplyCompleted,
    clearRecentReply,
  } = useConversation();
  const {
    setActiveTurns,
    setFailedTurns,
    setQueues,
    setPendingPrompts,
    setPresentedPromptResolutions,
    submittedPromptRequests,
    setSubmittedPromptRequests,
    setPendingApprovals,
    completedTurnByBot,
    queueSnapshotRequests,
    refreshRoutineIds,
  } = useTurns();
  const { setBrowserControlState, applyBrowserChange } = useBrowserTabs();
  const { setSidebarLayout } = useSidebar();

  function handleAgentEvent(event: AgentEvent) {
    switch (event.type) {
      case "status":
        applyAgentStatus(event.status);
        if (event.status.phase === "ready") {
          void window.openbot.agent
            .listModels()
            .then(setModelOptions)
            .catch(() => undefined);
        }
        return;
      case "usage-changed":
        setAccountUsage(event.usage);
        return;
      case "bots-changed":
        applyStoredBots(event.bots);
        return;
      case "sidebar-layout-changed":
        setSidebarLayout(event.layout);
        return;
      case "conversation":
        scheduleConversation(event.snapshot);
        return;
      case "conversation-page":
        {
          const existingUnreadCount = conversationReads()[event.page.botId]?.unreadCount ?? 0;
          const trackingKey = agentConversationKey(activeServerId(), event.page.botId);
          const markNewMessagesRead =
            isAgentChatReadable(event.page.botId) &&
            (event.page.readState === undefined || event.page.readState.unreadCount > 0) &&
            (existingUnreadCount === 0 ||
              explicitlyOpenedAgentChatId() === event.page.botId ||
              agentChatsToRetryRead.has(trackingKey));
          const pageApplied = applyConversationPage(event.page, "latest", "latest");
          const latestIncomingMessage = markNewMessagesRead
            ? latestIncomingConversationMessage(event.page.messages)
            : undefined;
          if (pageApplied && latestIncomingMessage) {
            autoMarkAgentMessageRead(event.page.botId, latestIncomingMessage.id, existingUnreadCount === 0);
          }
        }
        return;
      case "conversation-invalidated":
        return;
      case "conversation-delta":
        applyConversationDelta(event);
        return;
      case "queue-changed":
        queueSnapshotRequests.set(event.snapshot.botId, (queueSnapshotRequests.get(event.snapshot.botId) ?? 0) + 1);
        setQueues((current) => ({
          ...current,
          [event.snapshot.botId]: event.snapshot,
        }));
        return;
      case "routines-changed":
        refreshRoutineIds(event.botId, activeServerId());
        return;
      case "browser-changed":
        if (platform.landingPreview) return;
        applyBrowserChange(event.tabs, event.activeTabId);
        return;
      case "browser-control-changed":
        if (platform.landingPreview) return;
        setBrowserControlState(event.state);
        return;
      case "turn-started":
        completedTurnByBot.delete(event.botId);
        clearRecentReply(event.botId);
        setFailedTurns((current) => withoutBot(current, event.botId));
        setActiveTurns((current) => ({
          ...current,
          [event.botId]: event.turnId,
        }));
        return;
      case "turn-completed":
        completedTurnByBot.set(event.botId, event.turnId);
        setFailedTurns((current) =>
          event.status === "failed" ? { ...current, [event.botId]: event.turnId } : withoutBot(current, event.botId),
        );
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        setQueues((current) => {
          const snapshot = current[event.botId];
          if (!snapshot) return current;
          const deliveries = snapshot.deliveries.filter(
            (delivery) =>
              !(
                (delivery.status === "starting" || delivery.status === "running") &&
                (delivery.turnId === null || delivery.turnId === event.turnId)
              ),
          );
          if (deliveries.length === snapshot.deliveries.length) return current;
          return { ...current, [event.botId]: { ...snapshot, deliveries } };
        });
        setPendingPrompts((current) => {
          const pending = current[event.botId];
          const submittedRequestKey = submittedPromptRequests()[event.botId];
          if (
            pending?.type === "prompt" &&
            promptRequestKey(pending.turnId, pending.requestId) === submittedRequestKey
          ) {
            return current;
          }
          return { ...current, [event.botId]: undefined };
        });
        setPendingApprovals((current) => ({ ...current, [event.botId]: undefined }));
        if (event.status === "completed") {
          markReplyCompleted(event.botId);
          playCompletionSoundForAgentEvent(event, botList());
        }
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.botId]: event }));
        setPresentedPromptResolutions((current) => ({ ...current, [event.botId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [event.botId]: undefined }));
        return;
      case "agent-input-resolved":
        if (event.kind === "prompt") {
          setPendingPrompts((current) => {
            const prompt = current[event.botId];
            return prompt?.type === "prompt" && String(prompt.requestId) === String(event.requestId)
              ? { ...current, [event.botId]: undefined }
              : current;
          });
        } else {
          setPendingApprovals((current) => {
            const approval = current[event.botId];
            return approval && String(approval.requestId) === String(event.requestId)
              ? { ...current, [event.botId]: undefined }
              : current;
          });
        }
        return;
      case "approval":
        setPendingApprovals((current) => ({
          ...current,
          [event.approval.botId]: event.approval,
        }));
        return;
      case "runtime-snapshot":
        applyAgentRuntimeSnapshot(event.snapshot);
        return;
      case "browser-takeover-requested":
        setPendingPrompts((current) => ({
          ...current,
          [event.request.botId]: event,
        }));
        return;
      case "browser-takeover-resolved":
        setPendingPrompts((current) => {
          const pending = current[event.botId];
          return pending?.type === "browser-takeover-requested" && pending.request.requestId === event.requestId
            ? { ...current, [event.botId]: undefined }
            : current;
        });
        return;
      case "error":
        if (event.botId) appendUiError(event.botId, event.message, "Error", activeServerId());
    }
  }

  function applyAgentRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): void {
    setActiveTurns(Object.fromEntries(snapshot.activeTurns.map((turn) => [turn.botId, turn.turnId])));
    setFailedTurns(Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.botId, turn.turnId])));
    setQueues((current) =>
      reconcileQueuesWithRuntimeWork(
        current,
        snapshot.work,
        new Map(snapshot.activeTurns.map((turn) => [turn.botId, turn.turnId])),
      ),
    );
    setPendingPrompts((current) => {
      const next = snapshot.attentionComplete ? {} : { ...current };
      const submitted = submittedPromptRequests();
      for (const prompt of snapshot.pendingPrompts) {
        if (promptRequestKey(prompt.turnId, prompt.requestId) !== submitted[prompt.botId]) {
          next[prompt.botId] = { type: "prompt", ...prompt };
        }
      }
      for (const request of snapshot.pendingBrowserTakeovers) {
        next[request.botId] = { type: "browser-takeover-requested", request };
      }
      return next;
    });
    setPendingApprovals((current) => ({
      ...(snapshot.attentionComplete ? {} : current),
      ...Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.botId, approval])),
    }));
    for (const botId of new Set(snapshot.latestMessages.map((message) => message.botId))) {
      deleteAgentMessageBodies(rawAgentMessageBodies, botId);
    }
    for (const message of snapshot.latestMessages) {
      rawAgentMessageBodies.set(agentMessageKey(message.botId, message.id), message.text);
    }
    setLiveMessages((current) => {
      const next = { ...current };
      for (const message of snapshot.latestMessages) {
        const messages = next[message.botId] ?? [];
        if (messages.some((candidate) => candidate.id === message.id)) continue;
        next[message.botId] = [
          ...messages,
          {
            id: message.id,
            author: "bot",
            body: cleanAgentMessageText(message.text),
            time: message.createdAt,
            createdAt: message.createdAt,
          },
        ];
      }
      return next;
    });
  }

  onSettled(() => {
    const unsubscribe = window.openbot.agent.onEvent((event) => {
      flush(() => handleAgentEvent(event));
    });
    return () => {
      unsubscribe();
      completedTurnByBot.clear();
    };
  });

  return null;
}
