import type {
  AgentExchangeSummary,
  AgentModelId,
  AgentProviderId,
  AgentReasoningEffort,
  AttachmentSummary,
  BotAvatarHue,
  BotSummary,
  ConversationQuestionPrompt,
  ConversationReaction,
  ImageGenerationInfo,
  MessageReaction,
  RoutineConversationEvent,
} from "@openbot/contracts/ipc";

export type MessageKind = "text" | "thinking" | "exchange" | "question" | "routine-event";

export interface MessageCitation {
  number: number;
  label: string;
  url: string;
  host?: string;
}

export interface MessageReactionSummary {
  emojis: MessageReaction[];
  overflowCount?: number;
}

export interface BotMessage {
  id: string;
  turnId?: string;
  author: "you" | "bot";
  body: string;
  time: string;
  createdAt?: string;
  streaming?: boolean;
  animate?: boolean;
  itemType?: string;
  kind?: MessageKind;
  status?: string;
  senderBotId?: string;
  replyToMessageId?: string | null;
  attachments?: AttachmentSummary[];
  imageGeneration?: ImageGenerationInfo;
  questionPrompt?: ConversationQuestionPrompt;
  citations?: MessageCitation[];
  exchange?: AgentExchangeSummary;
  reaction?: MessageReaction | null;
  reactions?: ConversationReaction[];
  reactionSummary?: MessageReactionSummary;
  routine?: {
    routineId: string;
    runId: string;
    name: string;
    scheduledFor: string;
  };
  routineEvent?: RoutineConversationEvent;
  items?: string[];
}

export interface BotProfile {
  id: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  provider: AgentProviderId;
  model: AgentModelId;
  reasoningEffort: AgentReasoningEffort;
  threadId: string | null;
  avatarSeed: string;
  avatarHue: BotAvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: BotSummary["marketplaceSource"];
  updatedAt?: string | null;
  time: string;
  preview: string;
}
