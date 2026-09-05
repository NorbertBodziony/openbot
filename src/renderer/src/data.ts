import type {
  AgentExchangeSummary,
  AgentModelId,
  AgentProviderId,
  AgentReasoningEffort,
  AgentSummary,
  AttachmentSummary,
  AvatarHue,
  ConversationQuestionPrompt,
  ConversationReaction,
  HostedSiteConversationEvent,
  ImageGenerationInfo,
  MessageReaction,
  QueueDeliveryStatus,
  RoutineConversationEvent,
  RoutineRunConversationEvent,
} from "@openbot/contracts/ipc";

export type MessageKind = "text" | "thinking" | "exchange" | "question" | "action-marker";

export type ChatActionMarkerStatus =
  | "queued"
  | "in-progress"
  | "needs-attention"
  | "completed"
  | "partial"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "unavailable";

export type AgentDeliveryMarkerStatus = Exclude<ChatActionMarkerStatus, "needs-attention">;

export type ChatActionMarkerModel =
  | {
      kind: "agent-message";
      direction: "incoming" | "outgoing";
      sourceAgentId: string;
      targetDeliveries: Array<{ agentId: string; status: QueueDeliveryStatus }>;
      status: AgentDeliveryMarkerStatus;
      timestamp: string;
      messageId: string;
      replyToMessageId: string | null;
    }
  | {
      kind: "routine-lifecycle";
      action: RoutineConversationEvent["action"];
      sourceAgentId: string | null;
      routineId: string;
      routineName: string;
      status: "completed";
      timestamp: string;
    }
  | {
      kind: "routine-run";
      sourceAgentId: string | null;
      routineId: string;
      runId: string;
      routineName: string;
      status: "queued" | RoutineRunConversationEvent["status"];
      timestamp: string;
    }
  | {
      kind: "hosted-site";
      sourceAgentId: string | null;
      action: HostedSiteConversationEvent["action"];
      status: HostedSiteConversationEvent["status"];
      operationId: string;
      siteId: string | null;
      title: string;
      hostname: string | null;
      url: string | null;
      timestamp: string;
    }
  | {
      kind: "unavailable";
      label: string;
      timestamp: string;
    };

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

export interface AgentMessage {
  id: string;
  turnId?: string;
  author: "you" | "agent";
  body: string;
  time: string;
  createdAt?: string;
  streaming?: boolean;
  animate?: boolean;
  itemType?: string;
  kind?: MessageKind;
  status?: string;
  senderAgentId?: string;
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
  actionMarker?: ChatActionMarkerModel;
  items?: string[];
  itemIds?: string[];
}

export interface AgentProfile {
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
  avatarHue: AvatarHue | null;
  avatarUrl: string | null;
  marketplaceSource?: AgentSummary["marketplaceSource"];
  updatedAt?: string | null;
  time: string;
  preview: string;
}
