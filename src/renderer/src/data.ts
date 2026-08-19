import type {
  AgentExchangeSummary,
  AgentModelId,
  AgentReasoningEffort,
  AttachmentSummary,
  BotAvatarHue,
  MessageReaction,
} from "@openbot/contracts/ipc";

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
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  time: string;
  preview: string;
}
