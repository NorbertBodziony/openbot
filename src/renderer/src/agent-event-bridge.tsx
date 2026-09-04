import type { AgentEvent, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import { flush, onSettled } from "solid-js";
import { cleanAgentMessageText } from "./agent-message-text";
import {
  appendLatestRuntimeMessages,
  reconcileAttentionApprovals,
  reconcileAttentionPrompts,
} from "./agent-runtime-snapshot";
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
import { queueAfterTurnCompleted } from "./queue-reconciliation";
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
 * Conversation invalidations also cover read cursors changed on another device.
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
    applyConversationReads,
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
    setTurnProgress,
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
  let readRefresh = 0;

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
        {
          const request = ++readRefresh;
          const serverId = activeServerId();
          void window.openbot.agent
            .listConversationReads()
            .then((reads) => {
              if (request === readRefresh && serverId === activeServerId()) applyConversationReads(reads);
            })
            .catch(() => undefined);
        }
        return;
      case "conversation-delta":
        applyConversationDelta(event);
        return;
      case "turn-progress":
        setTurnProgress((current) => ({
          ...current,
          [event.botId]: { turnId: event.turnId, detail: cleanAgentMessageText(event.detail) },
        }));
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
        setTurnProgress((current) => withoutBot(current, event.botId));
        clearRecentReply(event.botId);
        setFailedTurns((current) => withoutBot(current, event.botId));
        setActiveTurns((current) => ({
          ...current,
          [event.botId]: event.turnId,
        }));
        return;
      case "turn-completed":
        completedTurnByBot.set(event.botId, event.turnId);
        setTurnProgress((current) =>
          current[event.botId]?.turnId === event.turnId ? withoutBot(current, event.botId) : current,
        );
        setFailedTurns((current) =>
          event.status === "failed" ? { ...current, [event.botId]: event.turnId } : withoutBot(current, event.botId),
        );
        setActiveTurns((current) => ({ ...current, [event.botId]: null }));
        setQueues((current) => {
          const snapshot = current[event.botId];
          if (!snapshot) return current;
          const next = queueAfterTurnCompleted(snapshot, event.turnId);
          return next === snapshot ? current : { ...current, [event.botId]: next };
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
    const runtimeTurns = new Map(snapshot.activeTurns.map((turn) => [turn.botId, turn.turnId]));
    setActiveTurns(Object.fromEntries(runtimeTurns));
    setTurnProgress((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([botId, progress]) => progress?.turnId === runtimeTurns.get(botId)),
      ),
    );
    setFailedTurns(Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.botId, turn.turnId])));
    setQueues((current) => reconcileQueuesWithRuntimeWork(current, snapshot.work, runtimeTurns));
    setPendingPrompts((current) => reconcileAttentionPrompts(current, snapshot, submittedPromptRequests()));
    setPendingApprovals((current) => reconcileAttentionApprovals(current, snapshot));
    for (const botId of new Set(snapshot.latestMessages.map((message) => message.botId))) {
      deleteAgentMessageBodies(rawAgentMessageBodies, botId);
    }
    for (const message of snapshot.latestMessages) {
      rawAgentMessageBodies.set(agentMessageKey(message.botId, message.id), message.text);
    }
    setLiveMessages((current) => appendLatestRuntimeMessages(current, snapshot.latestMessages));
  }

  onSettled(() => {
    const unsubscribe = window.openbot.agent.onEvent((event) => {
      flush(() => handleAgentEvent(event));
    });
    return () => {
      readRefresh += 1;
      unsubscribe();
      completedTurnByBot.clear();
    };
  });

  return null;
}
