import type { AgentApproval, AgentEvent, QueueSnapshot } from "@openbot/contracts/ipc";
import { createEffect, createMemo, createSignal } from "solid-js";
import { seededAttentionPrompts } from "./agent-runtime-snapshot";
import { useAgents } from "./agents";
import { desktopAnalytics } from "./analytics";
import { useAnsweredPrompts } from "./answered-prompts";
import { agentConversationKey, promptRequestKey } from "./conversation-keys";
import { useDynamicIsland } from "./dynamic-island";
import { createScopeGuard } from "./scope-lifetime";
import { useServers } from "./servers";
import { createSimpleContext } from "./simple-context";

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;
type BrowserTakeoverEvent = Extract<AgentEvent, { type: "browser-takeover-requested" }>;

/**
 * What each agent is *doing*: the turn it is running, the queue behind it, and
 * the prompt or approval it is blocked on.
 *
 * This is the one domain inside the per-server subtree whose state survives a
 * server switch. `DynamicIslandCoordinator` lives above the keyed boundary,
 * keeps five of these maps per server and hands them back through
 * `serverState(serverId)`, so this provider seeds from that snapshot on mount
 * instead of starting empty. Keeping turns separate from `conversation` is what
 * keeps that seam visible - mixed together, the one layer that is restored
 * would be indistinguishable from the ones that are not.
 *
 * Two placements deviate from the plan's inventory, both for the same reason -
 * the edge only points one way:
 *
 * - **This provider sits *outside* `conversation`, not inside it.** The plan had
 *   conversation first, but `applyConversation` and `applyConversationPage` both
 *   write `activeTurns` (a snapshot carries the turn that produced it) while
 *   nothing here needs a conversation *signal*. Nesting turns outside leaves a
 *   single downward edge; the other order needs two.
 * - **`presentPromptResolution` is not here.** It is the one turn command that
 *   reads `liveMessages`, to tell a resolution the user has seen from one main
 *   has already persisted. It moves to `conversation` with that state.
 *
 * `completedTurnByBot` and `routineIdsByConversation` used to survive a switch
 * because nobody cleared them; they now die with the scope, which is the
 * teardown the old list of setters kept forgetting. `completedTurnByBot` had
 * grown for the life of the process.
 *
 * `presentedPromptResolutions` and `submittedPromptRequests` are the exception
 * that proves that rule: they too survived by neglect, but for them the survival
 * was load-bearing, because an answered prompt is only proved answered by a
 * snapshot that may arrive after the user has moved to another server. They are
 * re-exported from here under their own names so nothing downstream can tell,
 * but they are owned by `answered-prompts.tsx` above the boundary and scoped to
 * this server by its id - and they are read before `pendingPrompts` exists,
 * because the seed below is the first thing that has to consult them.
 */
const Turns = createSimpleContext({
  name: "Turns",
  init: () => {
    const { activeServerId } = useServers();
    const { dynamicIslandCoordinator } = useDynamicIsland();
    const { activeBot, activeBotId, agentStatus, appendUiError } = useAgents();
    const scopeIsCurrent = createScopeGuard();

    // The layer-2 seed: what this server was doing the last time it was open.
    const seed = dynamicIslandCoordinator.serverState(activeServerId());
    const [activeTurns, setActiveTurns] = createSignal<Record<string, string | null>>(seed?.activeTurns ?? {});
    const [failedTurns, setFailedTurns] = createSignal<Record<string, string | undefined>>(seed?.failedTurns ?? {});
    const [queues, setQueues] = createSignal<Record<string, QueueSnapshot>>(seed?.queues ?? {});
    const [routineIdsByConversation, setRoutineIdsByConversation] = createSignal<Record<string, string[] | undefined>>(
      {},
    );
    const {
      presentedPromptResolutions,
      setPresentedPromptResolutions,
      submittedPromptRequests,
      setSubmittedPromptRequests,
    } = useAnsweredPrompts().promptMarkersFor(activeServerId());
    const [pendingPrompts, setPendingPrompts] = createSignal<
      Record<string, PromptEvent | BrowserTakeoverEvent | undefined>
    >(seededAttentionPrompts(seed?.pendingPrompts, presentedPromptResolutions(), submittedPromptRequests()));
    const [pendingApprovals, setPendingApprovals] = createSignal<Record<string, AgentApproval | undefined>>(
      seed?.pendingApprovals ?? {},
    );
    const completedTurnByBot = new Map<string, string>();
    const queueSnapshotRequests = new Map<string, number>();
    const routineSnapshotRequests = new Map<string, number>();

    function refreshRoutineIds(botId: string, serverId: string): void {
      const key = agentConversationKey(serverId, botId);
      const request = (routineSnapshotRequests.get(key) ?? 0) + 1;
      routineSnapshotRequests.set(key, request);
      setRoutineIdsByConversation((current) => ({ ...current, [key]: undefined }));
      void window.openbot.agent
        .listRoutines(botId)
        .then((routines) => {
          if (routineSnapshotRequests.get(key) !== request) return;
          setRoutineIdsByConversation((current) => ({ ...current, [key]: routines.map((routine) => routine.id) }));
        })
        .catch(() => undefined);
    }

    createEffect(
      () => ({ botId: activeBotId(), agentPhase: agentStatus().phase, serverId: activeServerId() }),
      ({ botId, serverId }) => {
        if (botId) refreshRoutineIds(botId, serverId);
      },
    );

    createEffect(
      () => ({ botId: activeBotId(), agentPhase: agentStatus().phase, serverId: activeServerId() }),
      ({ botId, serverId }) => {
        if (!botId) return;
        const queueRequest = (queueSnapshotRequests.get(botId) ?? 0) + 1;
        queueSnapshotRequests.set(botId, queueRequest);
        void window.openbot.agent
          .listQueue(botId)
          .then((queue) => {
            if (!scopeIsCurrent() || queueSnapshotRequests.get(botId) !== queueRequest) return;
            setQueues((current) => ({ ...current, [botId]: queue }));
          })
          .catch((error) => {
            if (scopeIsCurrent()) appendUiError(botId, error, "Queue load failed", serverId);
          });
      },
    );

    async function answerPrompt(answers: Record<string, string[]>): Promise<boolean> {
      const bot = activeBot();
      const prompt = bot ? pendingPrompts()[bot.id] : undefined;
      if (!bot || prompt?.type !== "prompt") return false;
      return submitPromptAnswers(bot.id, prompt, answers);
    }

    async function submitPromptAnswers(
      botId: string,
      prompt: PromptEvent,
      answers: Record<string, string[]>,
    ): Promise<boolean> {
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      setSubmittedPromptRequests((current) => ({
        ...current,
        [botId]: promptRequestKey(prompt.turnId, prompt.requestId) ?? undefined,
      }));
      try {
        await window.openbot.agent.respondToPrompt({
          requestId: prompt.requestId,
          answers,
        });
        analytics.track("agent_input_action", {
          kind: "prompt",
          decision: "answered",
          result: "succeeded",
        });
        return true;
      } catch (error) {
        setSubmittedPromptRequests((current) => ({ ...current, [botId]: undefined }));
        analytics.track("agent_input_action", {
          kind: "prompt",
          decision: "answered",
          result: "failed",
          failure_code: "response_failed",
        });
        appendUiError(botId, error, "Answer failed", serverId);
        return false;
      }
    }

    async function respondToApprovalRequest(
      botId: string,
      requestId: string | number,
      decision: "accept" | "decline",
    ): Promise<boolean> {
      const serverId = activeServerId();
      const approval = pendingApprovals()[botId];
      if (!approval || String(approval.requestId) !== String(requestId)) return false;
      const analytics = desktopAnalytics.scope();
      try {
        await window.openbot.agent.respondToApproval({
          requestId: approval.requestId,
          decision,
        });
        setPendingApprovals((current) => ({ ...current, [botId]: undefined }));
        analytics.track("agent_input_action", { kind: "approval", decision, result: "succeeded" });
        return true;
      } catch (error) {
        analytics.track("agent_input_action", {
          kind: "approval",
          decision,
          result: "failed",
          failure_code: "response_failed",
        });
        appendUiError(botId, error, "Approval failed", serverId);
        return false;
      }
    }

    async function respondToApproval(decision: "accept" | "decline"): Promise<boolean> {
      const bot = activeBot();
      const approval = bot ? pendingApprovals()[bot.id] : undefined;
      if (!bot || !approval) return false;
      return respondToApprovalRequest(bot.id, approval.requestId, decision);
    }

    async function respondToBrowserTakeover(decision: "complete" | "cancel"): Promise<boolean> {
      const bot = activeBot();
      const event = bot ? pendingPrompts()[bot.id] : undefined;
      if (!bot || event?.type !== "browser-takeover-requested") return false;
      const serverId = activeServerId();
      try {
        await window.openbot.agent.respondToBrowserTakeover({ requestId: event.request.requestId, decision });
        setPendingPrompts((current) => ({ ...current, [bot.id]: undefined }));
        return true;
      } catch (error) {
        appendUiError(bot.id, error, "Browser takeover failed", serverId);
        return false;
      }
    }

    function cancelQueuedMessage(deliveryId: string) {
      const bot = activeBot();
      if (!bot) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      void window.openbot.agent
        .cancelQueuedMessage({ botId: bot.id, deliveryId })
        .then(() => analytics.track("queue_action", { action: "cancel", result: "succeeded" }))
        .catch((error) => {
          analytics.track("queue_action", { action: "cancel", result: "failed", failure_code: "cancel_failed" });
          appendUiError(bot.id, error, "Cancel failed", serverId);
        });
    }

    function steerQueuedMessage(deliveryId: string) {
      const bot = activeBot();
      const turnId = bot ? activeTurns()[bot.id] : null;
      if (!bot || !turnId) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      void window.openbot.agent
        .steerQueuedMessage({ botId: bot.id, deliveryId, expectedTurnId: turnId })
        .then(() => analytics.track("queue_action", { action: "steer", result: "succeeded" }))
        .catch((error) => {
          analytics.track("queue_action", { action: "steer", result: "failed", failure_code: "steer_failed" });
          appendUiError(bot.id, error, "Steer failed", serverId);
        });
    }

    async function updateQueuedMessage(
      deliveryId: string,
      text: string,
      keepAttachmentIds: string[],
      attachmentDraftIds: string[],
      target?: { botId: string; serverId: string },
    ): Promise<boolean> {
      const botId = target?.botId ?? activeBot()?.id;
      const serverId = target?.serverId ?? activeServerId();
      if (!botId) return false;
      const analytics = desktopAnalytics.scope();
      try {
        const input = {
          botId,
          deliveryId,
          text,
          keepAttachmentIds,
          attachmentDraftIds,
        };
        await window.openbot.agent.updateQueuedMessage(input, serverId);
        analytics.track("queue_action", { action: "edit", result: "succeeded" });
        return true;
      } catch (error) {
        analytics.track("queue_action", { action: "edit", result: "failed", failure_code: "edit_failed" });
        appendUiError(botId, error, "Edit failed", serverId);
        return false;
      }
    }

    function reorderQueue(deliveryIds: string[]) {
      const bot = activeBot();
      if (!bot) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      void window.openbot.agent
        .reorderQueue({ botId: bot.id, deliveryIds })
        .then(() => analytics.track("queue_action", { action: "reorder", result: "succeeded" }))
        .catch((error) => {
          analytics.track("queue_action", { action: "reorder", result: "failed", failure_code: "reorder_failed" });
          appendUiError(bot.id, error, "Reorder failed", serverId);
        });
    }

    function stopActiveTurn() {
      const bot = activeBot();
      const turnId = bot ? activeTurns()[bot.id] : null;
      if (!bot || !turnId) return;
      const serverId = activeServerId();
      const analytics = desktopAnalytics.scope();
      void window.openbot.agent
        .interrupt({ botId: bot.id, turnId })
        .then(() => analytics.track("queue_action", { action: "interrupt", result: "succeeded" }))
        .catch((error) => {
          analytics.track("queue_action", {
            action: "interrupt",
            result: "failed",
            failure_code: "interrupt_failed",
          });
          appendUiError(bot.id, error, "Stop failed", serverId);
        });
    }

    const activeQueue = createMemo(() => {
      const bot = activeBot();
      return bot ? queues()[bot.id] : undefined;
    });
    const activeRoutineIds = createMemo(() => {
      const bot = activeBot();
      return bot ? routineIdsByConversation()[agentConversationKey(activeServerId(), bot.id)] : undefined;
    });

    /**
     * The seed is `dynamicIslandCoordinator.serverState(serverId)`, which is
     * `undefined` for a server the coordinator has not seen. Each field falls
     * back to empty, exactly as `selectServer` did inline.
     */
    return {
      activeTurns,
      setActiveTurns,
      failedTurns,
      setFailedTurns,
      queues,
      setQueues,
      routineIdsByConversation,
      pendingPrompts,
      setPendingPrompts,
      presentedPromptResolutions,
      setPresentedPromptResolutions,
      submittedPromptRequests,
      setSubmittedPromptRequests,
      pendingApprovals,
      setPendingApprovals,
      completedTurnByBot,
      queueSnapshotRequests,
      activeQueue,
      activeRoutineIds,
      refreshRoutineIds,
      answerPrompt,
      respondToApproval,
      respondToBrowserTakeover,
      cancelQueuedMessage,
      steerQueuedMessage,
      updateQueuedMessage,
      reorderQueue,
      stopActiveTurn,
    };
  },
});

export const TurnsProvider = Turns.provider;
export const useTurns = Turns.use;
