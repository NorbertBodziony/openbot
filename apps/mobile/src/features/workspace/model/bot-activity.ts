import type { AgentEvent, TeamRealtimeEvent } from "@openbot/contracts/ipc";

export interface MobileBotActivity {
  turnId: string | null;
  phase: "working" | "responding" | "waiting";
  detail: string | null;
}

export type MobileBotActivities = Record<string, MobileBotActivity>;

export function reduceBotActivity(
  current: MobileBotActivities,
  event: AgentEvent | TeamRealtimeEvent,
): MobileBotActivities {
  if (event.type === "runtime-snapshot") {
    const next: MobileBotActivities = {};
    for (const turn of event.snapshot.activeTurns) {
      const previous = current[turn.botId];
      next[turn.botId] =
        previous?.turnId === turn.turnId && previous.phase !== "waiting"
          ? previous
          : { turnId: turn.turnId, phase: "working", detail: null };
    }
    for (const work of event.snapshot.work) {
      if (work.status === "failed") continue;
      next[work.botId] ??= { turnId: work.turnId, phase: "working", detail: null };
    }
    for (const request of [
      ...event.snapshot.pendingPrompts,
      ...event.snapshot.pendingApprovals,
      ...event.snapshot.pendingBrowserTakeovers,
    ]) {
      next[request.botId] = { turnId: request.turnId, phase: "waiting", detail: null };
    }
    return next;
  }
  if (event.type === "bots-changed") {
    const ids = new Set(event.bots.map((bot) => bot.id));
    return Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id)));
  }
  if (event.type === "turn-started" || event.type === "turn-progress" || event.type === "conversation-delta") {
    const previous = current[event.botId];
    return {
      ...current,
      [event.botId]: {
        turnId: event.turnId,
        phase: event.type === "conversation-delta" ? "responding" : "working",
        detail:
          event.type === "turn-progress" ? event.detail : previous?.turnId === event.turnId ? previous.detail : null,
      },
    };
  }
  if (event.type === "conversation") {
    const { botId, activeTurnId, messages } = event.snapshot;
    if (!activeTurnId) {
      if (!current[botId]) return current;
      const next = { ...current };
      delete next[botId];
      return next;
    }
    const previous = current[botId];
    const responding = messages.some(
      (message) =>
        message.turnId === activeTurnId &&
        message.author === "assistant" &&
        message.itemType !== "commentary" &&
        message.status === "streaming" &&
        message.text.trim().length > 0,
    );
    return {
      ...current,
      [botId]: {
        turnId: activeTurnId,
        phase: responding ? "responding" : previous?.turnId === activeTurnId ? previous.phase : "working",
        detail: previous?.turnId === activeTurnId ? previous.detail : null,
      },
    };
  }
  if (event.type === "turn-completed") {
    if (current[event.botId]?.turnId !== event.turnId) return current;
    const next = { ...current };
    delete next[event.botId];
    return next;
  }
  if (event.type === "prompt" || event.type === "approval" || event.type === "browser-takeover-requested") {
    const request = event.type === "approval" ? event.approval : event.type === "prompt" ? event : event.request;
    return { ...current, [request.botId]: { turnId: request.turnId, phase: "waiting", detail: null } };
  }
  if (event.type === "agent-input-resolved" && current[event.botId]) {
    return { ...current, [event.botId]: { ...current[event.botId], phase: "working", detail: null } };
  }
  return current;
}
