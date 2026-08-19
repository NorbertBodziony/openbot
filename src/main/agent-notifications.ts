import type { AgentEvent, BotSummary } from "@openbot/contracts/ipc";

export interface AgentNotificationContent {
  title: string;
  body: string;
}

export function notificationForAgentEvent(event: AgentEvent, bots: BotSummary[]): AgentNotificationContent | null {
  if (event.type !== "turn-completed" && event.type !== "prompt" && event.type !== "approval") {
    return null;
  }

  const botId = event.type === "approval" ? event.approval.botId : event.botId;
  const bot = bots.find((candidate) => candidate.id === botId);
  if (!bot?.notifications) return null;

  if (event.type === "prompt") {
    return { title: bot.name, body: "Needs your input." };
  }
  if (event.type === "approval") {
    return { title: bot.name, body: "Needs your approval." };
  }
  if (event.status !== "completed") return null;
  return { title: bot.name, body: "Finished working." };
}
