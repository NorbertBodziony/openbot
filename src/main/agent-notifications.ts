import type { AgentEvent, BotSummary } from "@openbot/contracts/ipc";

export interface AgentNotificationContent {
  title: string;
  body: string;
}

export function notificationForAgentEvent(
  event: AgentEvent,
  bots: BotSummary[],
): AgentNotificationContent | null {
  if (event.type !== "turn-completed" && event.type !== "prompt") return null;

  const bot = bots.find((candidate) => candidate.id === event.botId);
  if (!bot?.notifications) return null;

  if (event.type === "prompt") {
    return { title: bot.name, body: "Needs your input." };
  }
  if (event.status !== "completed") return null;
  return { title: bot.name, body: "Finished working." };
}
