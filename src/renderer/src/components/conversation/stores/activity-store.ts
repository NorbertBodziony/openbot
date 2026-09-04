import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { BotProfile } from "../../../data";
import type { ConversationProps } from "../../ConversationView";
import { type AgentActivityPresentation, nextAgentActivityPresentation } from "../AgentActivity";
import { agentActivityExitDelay, agentActivityExitDuration, agentActivityShowDelay } from "../activity-timing";

export interface RenderedAgentActivity {
  activityId: string;
  bot: BotProfile | undefined;
  detail: string | null;
  phase: "active" | "exiting";
  presentation: AgentActivityPresentation;
}

export interface ActivityStoreDeps {
  props: ConversationProps;
  activeDeliveries: () => Array<{ id: string }>;
  agentActivityPresentations: Map<string, { activityId: string; presentation: AgentActivityPresentation }>;
}

export function createActivityStore(deps: ActivityStoreDeps) {
  const [renderedAgentActivity, setRenderedAgentActivity] = createSignal<RenderedAgentActivity | null>(null);
  const [agentActivitySpaceReserved, setAgentActivitySpaceReserved] = createSignal(false);
  const streamingAgentMessage = createMemo(() => {
    for (let index = deps.props.messages.length - 1; index >= 0; index -= 1) {
      const message = deps.props.messages[index];
      if (message?.author === "bot" && message.streaming) return message;
    }
    return null;
  });
  const activeActivityId = createMemo(() => {
    const botId = deps.props.bot?.id;
    if (!botId) return null;
    const delivery = deps.activeDeliveries()[0];
    if (delivery) return `${botId}:delivery:${delivery.id}`;
    if (deps.props.activeTurnId) return `${botId}:turn:${deps.props.activeTurnId}`;
    const streamingMessage = streamingAgentMessage();
    if (!streamingMessage) return null;
    const current = untrack(renderedAgentActivity);
    if (current?.bot?.id === botId) return current.activityId;
    return `${botId}:message:${streamingMessage.id}`;
  });
  const latestActiveCommentary = createMemo(() => {
    const activeTurnId = deps.props.activeTurnId;
    if (!activeTurnId) return null;
    const streamingMessage = streamingAgentMessage();
    if (streamingMessage && streamingMessage.itemType !== "commentary") return null;
    for (let index = deps.props.messages.length - 1; index >= 0; index -= 1) {
      const message = deps.props.messages[index];
      if (message?.turnId !== activeTurnId || message.itemType !== "commentary") continue;
      const items = message.items ?? [message.body];
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const detail = items[itemIndex]?.trim();
        if (detail) return detail;
      }
    }
    return null;
  });
  const activeActivityDetail = createMemo(
    () => latestActiveCommentary() ?? (deps.props.activityDetail?.trim() || null),
  );
  const agentActivity = createMemo<"Working" | null>(() => (activeActivityId() ? "Working" : null));
  const activityPresentation = createMemo<AgentActivityPresentation | null>(() => {
    const botId = deps.props.bot?.id;
    const activityId = activeActivityId();
    if (!botId || !activityId) return null;
    const previous = deps.agentActivityPresentations.get(botId);
    if (previous?.activityId === activityId) return previous.presentation;
    const presentation = nextAgentActivityPresentation(previous?.presentation);
    deps.agentActivityPresentations.set(botId, { activityId, presentation });
    return presentation;
  });
  let agentActivityShowTimer: number | undefined;
  let agentActivityExitDelayTimer: number | undefined;
  let agentActivityExitTimer: number | undefined;
  const clearAgentActivityShowTimer = () => {
    if (agentActivityShowTimer === undefined) return;
    window.clearTimeout(agentActivityShowTimer);
    agentActivityShowTimer = undefined;
  };
  const clearAgentActivityExitTimer = () => {
    if (agentActivityExitTimer === undefined) return;
    window.clearTimeout(agentActivityExitTimer);
    agentActivityExitTimer = undefined;
  };
  const clearAgentActivityExitDelayTimer = () => {
    if (agentActivityExitDelayTimer === undefined) return;
    window.clearTimeout(agentActivityExitDelayTimer);
    agentActivityExitDelayTimer = undefined;
  };
  createEffect(
    () => ({
      activityId: activeActivityId(),
      bot: deps.props.bot,
      presentation: activityPresentation(),
    }),
    ({ activityId, bot, presentation }) => {
      clearAgentActivityShowTimer();
      clearAgentActivityExitDelayTimer();
      clearAgentActivityExitTimer();
      if (activityId && presentation) {
        const nextActivity = {
          activityId,
          bot,
          detail: untrack(activeActivityDetail),
          phase: "active" as const,
          presentation,
        };
        const current = untrack(renderedAgentActivity);
        if (current?.bot?.id === bot?.id) {
          setAgentActivitySpaceReserved(true);
          setRenderedAgentActivity(nextActivity);
          return;
        }
        const showDelay = agentActivityShowDelay();
        agentActivityShowTimer = window.setTimeout(() => {
          agentActivityShowTimer = undefined;
          if (untrack(activeActivityId) === activityId) {
            setAgentActivitySpaceReserved(true);
            setRenderedAgentActivity({ ...nextActivity, detail: untrack(activeActivityDetail) });
          }
        }, showDelay);
        return;
      }

      const current = untrack(renderedAgentActivity);
      if (!current) return;
      if (current.bot?.id !== bot?.id) {
        setRenderedAgentActivity(null);
        return;
      }

      const exitActivityId = current.activityId;
      const beginExit = () => {
        agentActivityExitDelayTimer = undefined;
        if (untrack(activeActivityId)) return;
        setRenderedAgentActivity((latest) =>
          latest?.activityId === exitActivityId ? { ...latest, phase: "exiting" } : latest,
        );
        const exitDuration = agentActivityExitDuration();
        agentActivityExitTimer = window.setTimeout(() => {
          agentActivityExitTimer = undefined;
          setRenderedAgentActivity((latest) =>
            latest?.activityId === exitActivityId && latest.phase === "exiting" ? null : latest,
          );
        }, exitDuration);
      };
      const exitDelay = agentActivityExitDelay();
      if (exitDelay === 0) beginExit();
      else agentActivityExitDelayTimer = window.setTimeout(beginExit, exitDelay);
    },
  );

  createEffect(
    () => ({ activityId: activeActivityId(), detail: activeActivityDetail() }),
    ({ activityId, detail }) => {
      if (!activityId) return;
      setRenderedAgentActivity((current) =>
        current?.activityId === activityId && current.detail !== detail ? { ...current, detail } : current,
      );
    },
  );
  onCleanup(() => {
    clearAgentActivityShowTimer();
    clearAgentActivityExitDelayTimer();
    clearAgentActivityExitTimer();
  });

  return {
    renderedAgentActivity,
    setRenderedAgentActivity,
    agentActivitySpaceReserved,
    setAgentActivitySpaceReserved,
    streamingAgentMessage,
    activeActivityId,
    activeActivityDetail,
    agentActivity,
    activityPresentation,
    clearAgentActivityShowTimer,
    clearAgentActivityExitTimer,
    clearAgentActivityExitDelayTimer,
    getAgentActivityShowTimer: () => agentActivityShowTimer,
    getAgentActivityExitTimer: () => agentActivityExitTimer,
    getAgentActivityExitDelayTimer: () => agentActivityExitDelayTimer,
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
