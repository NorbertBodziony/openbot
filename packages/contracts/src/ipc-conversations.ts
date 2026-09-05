import { isIdentifier } from "./ipc-bounded-values";
import { type ConversationMessage, isConversationMessage, type MessageReaction } from "./ipc-conversation-messages";
import { isDynamicRecord, isNumber } from "./runtime-values";

export interface ConversationSnapshot {
  agentId: string;
  threadId: string | null;
  activeTurnId: string | null;
  revision: number;
  messages: ConversationMessage[];
}

export function isConversationSnapshot(value: unknown): value is ConversationSnapshot {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.agentId) &&
    (value.threadId === null || isIdentifier(value.threadId)) &&
    (value.activeTurnId === null || isIdentifier(value.activeTurnId)) &&
    isNumber(value.revision) &&
    Number.isInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.messages) &&
    value.messages.every(isConversationMessage)
  );
}

export interface ConversationReadState {
  unreadCount: number;
  firstUnreadMessageId: string | null;
  throughMessageId: string | null;
}

export function isConversationReadState(value: unknown): value is ConversationReadState {
  return (
    isDynamicRecord(value) &&
    isNumber(value.unreadCount) &&
    Number.isInteger(value.unreadCount) &&
    value.unreadCount >= 0 &&
    (value.firstUnreadMessageId === null || isIdentifier(value.firstUnreadMessageId)) &&
    (value.throughMessageId === null || isIdentifier(value.throughMessageId))
  );
}

export interface ConversationWithReadState extends ConversationSnapshot {
  readState?: ConversationReadState;
}

export function isConversationWithReadState(value: unknown): value is ConversationWithReadState {
  return (
    isDynamicRecord(value) &&
    isConversationSnapshot(value) &&
    (value.readState === undefined || isConversationReadState(value.readState))
  );
}

export type ConversationPageAnchor =
  | { type: "latest" }
  | { type: "before"; cursor: string }
  | { type: "around"; messageId: string };

export interface ConversationPageInfo {
  hasOlder: boolean;
  olderCursor: string | null;
}

export interface ReadConversationPageInput {
  agentId: string;
  anchor?: ConversationPageAnchor;
  limit?: number;
}

export interface ConversationPage {
  agentId: string;
  threadId: string | null;
  activeTurnId: string | null;
  revision: number;
  messages: ConversationMessage[];
  references: Record<string, ConversationMessage>;
  pageInfo: ConversationPageInfo;
  readState?: ConversationReadState;
}

export interface SearchConversationMessagesInput {
  query: string;
  agentId?: string;
  cursor?: string;
  limit?: number;
}

export interface ConversationSearchResult {
  agentId: string;
  message: ConversationMessage;
}

export interface ConversationSearchPage {
  results: ConversationSearchResult[];
  total: number;
  nextCursor: string | null;
}

export interface MarkConversationReadInput {
  agentId: string;
  throughMessageId: string | null;
}

export interface SendMessageInput {
  agentId: string;
  text: string;
  attachmentDraftIds?: string[];
  replyToMessageId?: string | null;
}

export interface SetMessageReactionInput {
  agentId: string;
  messageId: string;
  emoji: MessageReaction | null;
}

export interface RespondToPromptInput {
  requestId: string | number;
  answers: Record<string, string[]>;
}
