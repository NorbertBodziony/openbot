import {
  type AgentExchangeSummary,
  type AgentModelId,
  type AgentReasoningEffort,
  type AttachmentSummary,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  type BotAvatarColor,
  type BotAvatarShape,
  type MessageReaction,
} from "../../shared/ipc";

export type BotAccent = "teal" | "orange" | "purple" | "blue" | "violet" | "coral" | "neutral";

export const AVATAR_SHAPES: BotAvatarShape[] = [...BOT_AVATAR_SHAPES];

export const AVATAR_COLORS: BotAvatarColor[] = [...BOT_AVATAR_COLORS];

export type MessageKind = "text" | "thinking" | "exchange";

export interface BotMessage {
  id: string;
  turnId?: string;
  author: "you" | "bot";
  body: string;
  time: string;
  streaming?: boolean;
  animate?: boolean;
  itemType?: string;
  kind?: MessageKind;
  status?: string;
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  items?: string[];
}

export interface BotProfile {
  id: string;
  name: string;
  role: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  accent: BotAccent;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  time: string;
  preview: string;
}

export function accentForAvatarColor(color: BotAvatarColor): BotAccent {
  const accents: Record<BotAvatarColor, BotAccent> = {
    black: "neutral",
    brown: "coral",
    red: "coral",
    orange: "orange",
    yellow: "orange",
    green: "teal",
    cyan: "teal",
    blue: "blue",
    violet: "violet",
    magenta: "purple",
    gray: "neutral",
  };
  return accents[color];
}

export function accentForBot(id: string): BotAccent {
  const accents: BotAccent[] = ["teal", "orange", "purple", "blue", "violet", "coral"];
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length] ?? "neutral";
}
