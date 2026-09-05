import { INPUT_LIMITS } from "./input-limits";
import { type AttachmentSummary, isAttachmentSummary } from "./ipc-attachments";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isNumber, isOneOf } from "./runtime-values";

export const QUEUE_DELIVERY_STATUSES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type QueueDeliveryStatus = (typeof QUEUE_DELIVERY_STATUSES)[number];

export interface QueueDelivery {
  id: string;
  messageId: string;
  recipientAgentId: string;
  sender:
    | { kind: "user" }
    | { kind: "agent"; agentId: string }
    | { kind: "routine"; routineId: string; runId: string; routineName: string; scheduledFor: string };
  text: string;
  attachments: AttachmentSummary[];
  replyToMessageId: string | null;
  status: QueueDeliveryStatus;
  position: number | null;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

function isQueueDelivery(value: unknown): value is QueueDelivery {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.messageId) &&
    isIdentifier(value.recipientAgentId) &&
    isQueueSender(value.sender) &&
    isBoundedString(value.text, INPUT_LIMITS.messageText) &&
    Array.isArray(value.attachments) &&
    value.attachments.length <= INPUT_LIMITS.attachments &&
    value.attachments.every(isAttachmentSummary) &&
    (value.replyToMessageId === null || isIdentifier(value.replyToMessageId)) &&
    isOneOf(QUEUE_DELIVERY_STATUSES, value.status) &&
    (value.position === null ||
      (isNumber(value.position) && Number.isInteger(value.position) && value.position >= 1)) &&
    (value.turnId === null || isIdentifier(value.turnId)) &&
    (value.error === null || isBoundedString(value.error, INPUT_LIMITS.messageText)) &&
    isBoundedString(value.createdAt, 160)
  );
}

function isQueueSender(value: unknown): value is QueueDelivery["sender"] {
  if (!isDynamicRecord(value)) return false;
  if (value.kind === "user") return true;
  if (value.kind === "agent") return isIdentifier(value.agentId);
  return (
    value.kind === "routine" &&
    isIdentifier(value.routineId) &&
    isIdentifier(value.runId) &&
    isBoundedString(value.routineName, INPUT_LIMITS.routineName) &&
    isBoundedString(value.scheduledFor, 160)
  );
}

export interface QueueSnapshot {
  agentId: string;
  deliveries: QueueDelivery[];
}

export function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(isQueueDelivery)
  );
}

export interface QueuedMessageReceipt {
  messageId: string;
  deliveries: Array<{
    id: string;
    recipientAgentId: string;
    status: QueueDeliveryStatus;
    position: number | null;
  }>;
}

export function isQueuedMessageReceipt(value: unknown): value is QueuedMessageReceipt {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.messageId) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.every(
      (delivery) =>
        isDynamicRecord(delivery) &&
        isIdentifier(delivery.id) &&
        isIdentifier(delivery.recipientAgentId) &&
        isOneOf(QUEUE_DELIVERY_STATUSES, delivery.status) &&
        (delivery.position === null ||
          (isNumber(delivery.position) && Number.isInteger(delivery.position) && delivery.position >= 1)),
    )
  );
}

export interface CancelQueuedMessageInput {
  agentId: string;
  deliveryId: string;
}

export interface AcknowledgeFailedTurnInput {
  agentId: string;
  turnId: string;
}

export interface SteerQueuedMessageInput {
  agentId: string;
  deliveryId: string;
  expectedTurnId: string;
}

export interface UpdateQueuedMessageInput {
  agentId: string;
  deliveryId: string;
  text: string;
  keepAttachmentIds: string[];
  attachmentDraftIds: string[];
}

export interface ReorderQueueInput {
  agentId: string;
  deliveryIds: string[];
}

export interface InterruptTurnInput {
  agentId: string;
  turnId: string;
}
