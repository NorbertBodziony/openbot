// Agent conversations and member-to-member direct messages, as a host sends them.
// See `remote-host-decoding.ts` for why the `FromHost` suffix exists and must not be merged away.

import type {
  ConversationMessage,
  ConversationPage,
  ConversationReadState,
  ConversationSearchPage,
  ConversationWithReadState,
  DirectConversationPage,
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectThreadSummary,
} from "@openbot/contracts/ipc";
import { isConversationMessage, isConversationReadState, isConversationWithReadState } from "@openbot/contracts/ipc";
import {
  decodeRecord,
  guardedListDecoder,
  nullableString,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@openbot/contracts/ipc-decoding";
import { isString } from "@openbot/contracts/runtime-values";

export function decodeDirectMessage(value: unknown): DirectMessage {
  const record = decodeRecord(value, "direct message");
  return {
    id: requiredString(record, "id"),
    threadId: requiredString(record, "threadId"),
    senderMemberId: requiredString(record, "senderMemberId"),
    recipientMemberId: requiredString(record, "recipientMemberId"),
    text: requiredString(record, "text"),
    createdAt: requiredString(record, "createdAt"),
    sequence: requiredNumber(record, "sequence"),
  };
}

function decodeDirectThreadSummary(value: unknown): DirectThreadSummary {
  const record = decodeRecord(value, "direct thread");
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    lastMessage: decodeDirectMessage(record.lastMessage),
    unreadCount: requiredNumber(record, "unreadCount"),
    updatedAt: requiredString(record, "updatedAt"),
  };
}

export function decodeDirectThreadSummaries(value: unknown): DirectThreadSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid direct thread response.");
  return value.map(decodeDirectThreadSummary);
}

export function decodeDirectConversationSnapshot(value: unknown): DirectConversationSnapshot {
  const record = decodeRecord(value, "direct conversation");
  const readState = record.readState;
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    messages: decodeDirectMessages(record.messages),
    revision: requiredNumber(record, "revision"),
    ...(readState === undefined ? {} : { readState: decodeDirectConversationReadState(readState) }),
  };
}

export function decodeDirectConversationPage(value: unknown): DirectConversationPage {
  const record = decodeRecord(value, "direct conversation page");
  const readState = record.readState;
  return {
    threadId: requiredString(record, "threadId"),
    otherMemberId: requiredString(record, "otherMemberId"),
    messages: decodeDirectMessages(record.messages),
    revision: requiredNumber(record, "revision"),
    pageInfo: decodePageInfo(record.pageInfo),
    ...(readState === undefined ? {} : { readState: decodeDirectConversationReadState(readState) }),
  };
}

function decodeDirectMessages(value: unknown): DirectMessage[] {
  if (!Array.isArray(value)) throw new Error("Invalid direct-message list.");
  return value.map(decodeDirectMessage);
}

export function decodeDirectConversationReadState(value: unknown): DirectConversationReadState {
  const record = decodeRecord(value, "direct read state");
  const firstUnreadMessageId = record.firstUnreadMessageId;
  if (firstUnreadMessageId !== null && !isString(firstUnreadMessageId)) {
    throw new Error("Invalid first unread message.");
  }
  return {
    unreadCount: requiredNumber(record, "unreadCount"),
    firstUnreadMessageId,
    throughSequence: requiredNumber(record, "throughSequence"),
  };
}

export function decodeConversationReadState(value: unknown): ConversationReadState {
  if (!isConversationReadState(value)) throw new Error("Invalid conversation read state.");
  return {
    unreadCount: value.unreadCount,
    firstUnreadMessageId: value.firstUnreadMessageId,
    throughMessageId: value.throughMessageId,
  };
}

export function decodeConversationReadStates(value: unknown): Record<string, ConversationReadState> {
  const record = decodeRecord(value, "conversation read states");
  return Object.fromEntries(
    Object.entries(record).map(([agentId, state]) => [agentId, decodeConversationReadState(state)]),
  );
}

export function decodeConversationWithReadState(value: unknown): ConversationWithReadState {
  if (!isConversationWithReadState(value)) {
    throw new Error("Invalid agent conversation response.");
  }
  return { ...value, readState: decodeConversationReadState(value.readState) };
}

export function decodeConversationPageFromHost(value: unknown): ConversationPage {
  const record = decodeRecord(value, "agent conversation page");
  return {
    agentId: requiredString(record, "agentId"),
    threadId: nullableString(record, "threadId"),
    activeTurnId: nullableString(record, "activeTurnId"),
    revision: requiredNumber(record, "revision"),
    messages: decodeConversationMessages(record.messages),
    references: decodeConversationReferencesFromHost(record.references),
    pageInfo: decodePageInfo(record.pageInfo),
    ...(record.readState === undefined ? {} : { readState: decodeConversationReadState(record.readState) }),
  };
}

export function decodeConversationSearchPageFromHost(value: unknown): ConversationSearchPage {
  const record = decodeRecord(value, "conversation search page");
  if (!Array.isArray(record.results)) throw new Error("Invalid conversation search results.");
  return {
    results: record.results.map((value) => {
      const result = decodeRecord(value, "conversation search result");
      return {
        agentId: requiredString(result, "agentId"),
        message: decodeConversationMessage(result.message, "conversation search message"),
      };
    }),
    total: requiredNumber(record, "total"),
    nextCursor: nullableString(record, "nextCursor"),
  };
}

const decodeConversationMessages = guardedListDecoder(isConversationMessage, "conversation page messages");

function decodeConversationReferencesFromHost(value: unknown): Record<string, ConversationMessage> {
  const references = decodeRecord(value, "conversation references");
  const decoded: Record<string, ConversationMessage> = {};
  for (const [messageId, message] of Object.entries(references)) {
    decoded[messageId] = decodeConversationMessage(message, "conversation reference");
  }
  return decoded;
}

function decodeConversationMessage(value: unknown, label: string): ConversationMessage {
  if (!isConversationMessage(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function decodePageInfo(value: unknown): { hasOlder: boolean; olderCursor: string | null } {
  const record = decodeRecord(value, "conversation page info");
  return {
    hasOlder: requiredBoolean(record, "hasOlder"),
    olderCursor: nullableString(record, "olderCursor"),
  };
}
