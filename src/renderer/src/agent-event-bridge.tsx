import type { AgentEvent, AgentRuntimeSnapshot } from "@openbot/contracts/ipc";
import { flush, onSettled } from "solid-js";
import { cleanAgentMessageText } from "./agent-message-text";
import {
  appendLatestRuntimeMessages,
  reconcileAttentionApprovals,
  reconcileAttentionPrompts,
} from "./agent-runtime-snapshot";
import { useAgents } from "./agents";
import { withoutAgent } from "./app-message-projection";
import { useAuth } from "./auth";
import { useBrowserTabs } from "./browser-tabs";
import { playCompletionSoundForAgentEvent } from "./completion-sound";
import { reconcileQueuesWithRuntimeWork } from "./dynamic-island-coordinator";
import { useConversation } from "./features/conversation/conversation-context";
import {
  agentConversationKey,
  agentMessageKey,
  deleteAgentMessageBodies,
  promptRequestKey,
} from "./features/conversation/conversation-keys";
import { latestIncomingConversationMessage } from "./features/conversation/conversation-read-state";
import { useSidebar } from "./features/sidebar/sidebar-context";
import { usePlatform } from "./platform";
import { useProviders } from "./providers";
import { queueAfterTurnCompleted } from "./queue-reconciliation";
import { useServers } from "./servers";
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
  const { invalidateAccountUsage } = useAuth();
  const { applyAgentStatus } = useProviders();
  const { agentList, setModelOptions, explicitlyOpenedAgentChatId, applyStoredAgents, appendUiError } = useAgents();
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
    completedTurnByAgent,
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
        invalidateAccountUsage();
        return;
      case "agents-changed":
        applyStoredAgents(event.agents);
        return;
      case "sidebar-layout-changed":
        setSidebarLayout(event.layout);
        return;
      case "conversation":
        scheduleConversation(event.snapshot);
        return;
      case "conversation-page":
        {
          const existingUnreadCount = conversationReads()[event.page.agentId]?.unreadCount ?? 0;
          const trackingKey = agentConversationKey(activeServerId(), event.page.agentId);
          const markNewMessagesRead =
            isAgentChatReadable(event.page.agentId) &&
            (event.page.readState === undefined || event.page.readState.unreadCount > 0) &&
            (existingUnreadCount === 0 ||
              explicitlyOpenedAgentChatId() === event.page.agentId ||
              agentChatsToRetryRead.has(trackingKey));
          const pageApplied = applyConversationPage(event.page, "latest", "latest");
          const latestIncomingMessage = markNewMessagesRead
            ? latestIncomingConversationMessage(event.page.messages)
            : undefined;
          if (pageApplied && latestIncomingMessage) {
            autoMarkAgentMessageRead(event.page.agentId, latestIncomingMessage.id, existingUnreadCount === 0);
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
          [event.agentId]: { turnId: event.turnId, detail: cleanAgentMessageText(event.detail) },
        }));
        return;
      case "queue-changed":
        queueSnapshotRequests.set(event.snapshot.agentId, (queueSnapshotRequests.get(event.snapshot.agentId) ?? 0) + 1);
        setQueues((current) => ({
          ...current,
          [event.snapshot.agentId]: event.snapshot,
        }));
        return;
      case "routines-changed":
        refreshRoutineIds(event.agentId, activeServerId());
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
        completedTurnByAgent.delete(event.agentId);
        setTurnProgress((current) => withoutAgent(current, event.agentId));
        clearRecentReply(event.agentId);
        setFailedTurns((current) => withoutAgent(current, event.agentId));
        setActiveTurns((current) => ({
          ...current,
          [event.agentId]: event.turnId,
        }));
        return;
      case "turn-completed":
        completedTurnByAgent.set(event.agentId, event.turnId);
        setTurnProgress((current) =>
          current[event.agentId]?.turnId === event.turnId ? withoutAgent(current, event.agentId) : current,
        );
        setFailedTurns((current) =>
          event.status === "failed"
            ? { ...current, [event.agentId]: event.turnId }
            : withoutAgent(current, event.agentId),
        );
        setActiveTurns((current) => ({ ...current, [event.agentId]: null }));
        setQueues((current) => {
          const snapshot = current[event.agentId];
          if (!snapshot) return current;
          const next = queueAfterTurnCompleted(snapshot, event.turnId);
          return next === snapshot ? current : { ...current, [event.agentId]: next };
        });
        setPendingPrompts((current) => {
          const pending = current[event.agentId];
          const submittedRequestKey = submittedPromptRequests()[event.agentId];
          if (
            pending?.type === "prompt" &&
            promptRequestKey(pending.turnId, pending.requestId) === submittedRequestKey
          ) {
            return current;
          }
          return { ...current, [event.agentId]: undefined };
        });
        setPendingApprovals((current) => ({ ...current, [event.agentId]: undefined }));
        if (event.status === "completed") {
          markReplyCompleted(event.agentId);
          playCompletionSoundForAgentEvent(event, agentList());
        }
        return;
      case "prompt":
        setPendingPrompts((current) => ({ ...current, [event.agentId]: event }));
        setPresentedPromptResolutions((current) => ({ ...current, [event.agentId]: undefined }));
        setSubmittedPromptRequests((current) => ({ ...current, [event.agentId]: undefined }));
        return;
      case "agent-input-resolved":
        if (event.kind === "prompt") {
          setPendingPrompts((current) => {
            const prompt = current[event.agentId];
            return prompt?.type === "prompt" && String(prompt.requestId) === String(event.requestId)
              ? { ...current, [event.agentId]: undefined }
              : current;
          });
        } else {
          setPendingApprovals((current) => {
            const approval = current[event.agentId];
            return approval && String(approval.requestId) === String(event.requestId)
              ? { ...current, [event.agentId]: undefined }
              : current;
          });
        }
        return;
      case "approval":
        setPendingApprovals((current) => ({
          ...current,
          [event.approval.agentId]: event.approval,
        }));
        return;
      case "runtime-snapshot":
        applyAgentRuntimeSnapshot(event.snapshot);
        return;
      case "browser-takeover-requested":
        setPendingPrompts((current) => ({
          ...current,
          [event.request.agentId]: event,
        }));
        return;
      case "browser-takeover-resolved":
        setPendingPrompts((current) => {
          const pending = current[event.agentId];
          return pending?.type === "browser-takeover-requested" && pending.request.requestId === event.requestId
            ? { ...current, [event.agentId]: undefined }
            : current;
        });
        return;
      case "error":
        if (event.agentId) appendUiError(event.agentId, event.message, "Error", activeServerId());
    }
  }

  function applyAgentRuntimeSnapshot(snapshot: AgentRuntimeSnapshot): void {
    const runtimeTurns = new Map(snapshot.activeTurns.map((turn) => [turn.agentId, turn.turnId]));
    setActiveTurns(Object.fromEntries(runtimeTurns));
    setTurnProgress((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([agentId, progress]) => progress?.turnId === runtimeTurns.get(agentId)),
      ),
    );
    setFailedTurns(Object.fromEntries(snapshot.failedTurns.map((turn) => [turn.agentId, turn.turnId])));
    setQueues((current) => reconcileQueuesWithRuntimeWork(current, snapshot.work, runtimeTurns));
    setPendingPrompts((current) => reconcileAttentionPrompts(current, snapshot, submittedPromptRequests()));
    setPendingApprovals((current) => reconcileAttentionApprovals(current, snapshot));
    for (const agentId of new Set(snapshot.latestMessages.map((message) => message.agentId))) {
      deleteAgentMessageBodies(rawAgentMessageBodies, agentId);
    }
    for (const message of snapshot.latestMessages) {
      rawAgentMessageBodies.set(agentMessageKey(message.agentId, message.id), message.text);
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
      completedTurnByAgent.clear();
    };
  });

  return null;
}
