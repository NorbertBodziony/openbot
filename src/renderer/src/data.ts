import type {
  AgentExchangeSummary,
  AgentModelId,
  AgentReasoningEffort,
  AttachmentSummary,
  BotAvatarHue,
  BotSummary,
  ImageGenerationInfo,
  MessageReaction,
} from "@openbot/contracts/ipc";

export type MessageKind = "text" | "thinking" | "exchange";

export interface MessageCitation {
  number: number;
  label: string;
  url: string;
  host?: string;
}

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
  imageGeneration?: ImageGenerationInfo;
  citations?: MessageCitation[];
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  routine?: {
    routineId: string;
    runId: string;
    name: string;
    scheduledFor: string;
  };
  items?: string[];
}

export interface BotProfile {
  id: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: BotSummary["marketplaceSource"];
  time: string;
  preview: string;
}
