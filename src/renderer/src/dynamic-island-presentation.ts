import type {
  AgentApproval,
  AgentEvent,
  DynamicIslandAttentionItem,
  DynamicIslandBotIdentity,
  DynamicIslandPresentation,
  QueueSnapshot,
} from "@openbot/contracts/ipc";
import type { BotMessage, BotProfile } from "./data";

type PromptEvent = Extract<AgentEvent, { type: "prompt" }>;
type BrowserTakeoverEvent = Extract<AgentEvent, { type: "browser-takeover-requested" }>;

export interface DynamicIslandPresentationInput {
  serverId: string;
  bots: BotProfile[];
  activeTurns: Record<string, string | null>;
  queues: Record<string, QueueSnapshot>;
  unreadReplies: Record<string, number>;
  liveMessages: Record<string, BotMessage[]>;
  pendingPrompts: Record<string, PromptEvent | BrowserTakeoverEvent | undefined>;
  pendingApprovals: Record<string, AgentApproval | undefined>;
}

export function createDynamicIslandPresentation(input: DynamicIslandPresentationInput): DynamicIslandPresentation {
  const botsById = new Map(input.bots.map((bot) => [bot.id, bot]));
  const working = input.bots
    .filter((bot) => isBotWorking(bot.id, input))
    .slice(0, 3)
    .map((bot) => ({ bot: botIdentity(bot), task: currentTask(bot.id, input.queues) }));
  const unreadCount = Object.values(input.unreadReplies).reduce((total, count) => total + Math.max(0, count), 0);
  const messageBot = input.bots.find((bot) => (input.unreadReplies[bot.id] ?? 0) > 0);
  const latestMessage = messageBot
    ? [...(input.liveMessages[messageBot.id] ?? [])].reverse().find((message) => message.author === "bot")
    : undefined;
  const message =
    messageBot && latestMessage
      ? {
          bot: botIdentity(messageBot),
          messageId: latestMessage.id,
          text: latestMessage.body,
          createdAt: latestMessage.time,
        }
      : null;
  const attention = collectAttention(input, botsById).slice(0, 3);
  const mode = attention[0]
    ? attention[0].kind === "approval"
      ? "approval"
      : "question"
    : message
      ? "message"
      : working.length > 0
        ? "working"
        : "idle";

  return {
    serverId: input.serverId,
    mode,
    activeCount: countWorkingBots(input),
    unreadCount,
    attentionCount: countAttention(input),
    working,
    message,
    attention,
  };
}

function isBotWorking(botId: string, input: DynamicIslandPresentationInput): boolean {
  return Boolean(input.activeTurns[botId]) || Boolean(runningDelivery(input.queues[botId]));
}

function countWorkingBots(input: DynamicIslandPresentationInput): number {
  return input.bots.reduce((count, bot) => count + Number(isBotWorking(bot.id, input)), 0);
}

function currentTask(botId: string, queues: Record<string, QueueSnapshot>): string {
  return runningDelivery(queues[botId])?.text.trim() || "Working on your request";
}

function runningDelivery(snapshot: QueueSnapshot | undefined) {
  return snapshot?.deliveries.find((delivery) => delivery.status === "starting" || delivery.status === "running");
}

function collectAttention(
  input: DynamicIslandPresentationInput,
  botsById: Map<string, BotProfile>,
): DynamicIslandAttentionItem[] {
  const items: DynamicIslandAttentionItem[] = [];
  for (const [botId, approval] of Object.entries(input.pendingApprovals)) {
    const bot = botsById.get(botId);
    if (!bot || !approval) continue;
    items.push({
      id: String(approval.requestId),
      requestId: approval.requestId,
      bot: botIdentity(bot),
      kind: "approval",
      title: approvalTitle(approval),
      detail: approval.reason ?? approval.command ?? null,
      options: null,
      questions: null,
      approval: {
        kind: approval.kind,
        command: approval.command,
        cwd: approval.cwd,
        reason: approval.reason,
        grantRoot: approval.grantRoot,
        permissions: approval.permissions
          ? {
              fileSystem: {
                read: approval.permissions.fileSystem.read.slice(0, 3),
                write: approval.permissions.fileSystem.write.slice(0, 3),
              },
              network: approval.permissions.network,
            }
          : null,
      },
    });
  }
  for (const [botId, event] of Object.entries(input.pendingPrompts)) {
    const bot = botsById.get(botId);
    if (!bot || !event) continue;
    if (event.type === "prompt") {
      const question = event.questions[0];
      items.push({
        id: String(event.requestId),
        requestId: event.requestId,
        bot: botIdentity(bot),
        kind: "prompt",
        title: question?.header || "Question from your bot",
        detail: question?.question ?? null,
        options: question?.options?.slice(0, 4) ?? null,
        questions: event.questions.map((item) => ({
          id: item.id,
          header: item.header || "Question from your bot",
          question: item.question,
          isSecret: item.isSecret,
          options: item.options,
        })),
        approval: null,
      });
      continue;
    }
    items.push({
      id: String(event.request.requestId),
      requestId: event.request.requestId,
      bot: botIdentity(bot),
      kind: "prompt",
      title: "Browser control is waiting",
      detail: "Open OpenBot to continue the browser task.",
      options: null,
      questions: null,
      approval: null,
    });
  }
  return items;
}

function countAttention(input: DynamicIslandPresentationInput): number {
  return (
    Object.values(input.pendingPrompts).filter(Boolean).length +
    Object.values(input.pendingApprovals).filter(Boolean).length
  );
}

function approvalTitle(approval: AgentApproval) {
  if (approval.kind === "command") return "Command needs review";
  if (approval.kind === "file-change") return "File changes need review";
  return "Permissions need review";
}

function botIdentity(bot: BotProfile): DynamicIslandBotIdentity {
  return {
    id: bot.id,
    name: bot.name,
    avatarSeed: bot.avatarSeed,
    avatarHue: bot.avatarHue,
    avatarUrl: bot.avatarUrl,
  };
}
