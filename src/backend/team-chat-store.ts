import { createHash } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  DirectConversationReadState,
  DirectConversationSnapshot,
  DirectMessage,
  DirectThreadSummary,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import type { OpenBotDatabase } from "./openbot-database";

export class TeamChatStore {
  constructor(readonly database: OpenBotDatabase) {}

  listThreads(memberId: string): DirectThreadSummary[] {
    const rows = databaseRows(
      this.database.connection
        .prepare(
          `SELECT
             thread.thread_id,
             thread.member_a_id,
             thread.member_b_id,
             thread.updated_at,
             message.message_json,
             (
               SELECT COUNT(*)
               FROM projection_direct_messages unread
               WHERE unread.thread_id = thread.thread_id
                 AND unread.sender_member_id != ?
                 AND unread.last_event_sequence > COALESCE(read_state.last_read_sequence, 0)
             ) AS unread_count
           FROM projection_direct_threads thread
           JOIN projection_direct_messages message
             ON message.message_id = thread.last_message_id
           LEFT JOIN projection_direct_reads read_state
             ON read_state.thread_id = thread.thread_id AND read_state.member_id = ?
           WHERE thread.member_a_id = ? OR thread.member_b_id = ?
           ORDER BY thread.updated_at DESC, thread.last_event_sequence DESC`,
        )
        .all(memberId, memberId, memberId, memberId),
    );
    return rows.map((row) => ({
      threadId: requiredString(row, "thread_id"),
      otherMemberId:
        requiredString(row, "member_a_id") === memberId
          ? requiredString(row, "member_b_id")
          : requiredString(row, "member_a_id"),
      lastMessage: JSON.parse(requiredString(row, "message_json")),
      unreadCount: requiredNumber(row, "unread_count"),
      updatedAt: requiredString(row, "updated_at"),
    }));
  }

  readConversation(memberId: string, otherMemberId: string): DirectConversationSnapshot {
    const threadId = directThreadId(memberId, otherMemberId);
    const thread = databaseRow(
      this.database.connection
        .prepare(
          `SELECT last_event_sequence
           FROM projection_direct_threads
           WHERE thread_id = ? AND (member_a_id = ? OR member_b_id = ?)`,
        )
        .get(threadId, memberId, memberId),
    );
    const rows = databaseRows(
      this.database.connection
        .prepare(
          `SELECT message_json FROM projection_direct_messages
           WHERE thread_id = ? ORDER BY last_event_sequence, message_id`,
        )
        .all(threadId),
    );
    const messages = rows.map((row) => decodeDirectMessage(JSON.parse(requiredString(row, "message_json"))));
    return {
      threadId,
      otherMemberId,
      messages,
      revision: thread ? requiredNumber(thread, "last_event_sequence") : 0,
      readState: this.#readState(memberId, threadId, messages),
    };
  }

  sendMessage(input: {
    clientMessageId: string;
    senderMemberId: string;
    recipientMemberId: string;
    text: string;
    createdAt?: string;
  }): DirectMessage {
    const text = input.text.trim();
    if (!text) throw new Error("Write a message first.");
    if (text.length > INPUT_LIMITS.directMessageText) {
      throw new Error(`A direct message can have up to ${INPUT_LIMITS.directMessageText} characters.`);
    }
    if (input.senderMemberId === input.recipientMemberId) {
      throw new Error("You cannot send a direct message to yourself.");
    }
    const memberIds = sortedMemberIds(input.senderMemberId, input.recipientMemberId);
    const threadId = directThreadId(memberIds[0], memberIds[1]);
    const message: DirectMessage = {
      id: input.clientMessageId,
      threadId,
      senderMemberId: input.senderMemberId,
      recipientMemberId: input.recipientMemberId,
      text,
      createdAt: input.createdAt ?? new Date().toISOString(),
      sequence: 0,
    };
    return this.database.dispatch(
      `direct-message:${message.senderMemberId}:${message.id}`,
      [
        {
          aggregateType: "direct-thread",
          aggregateId: threadId,
          eventType: "direct-message.sent",
          payload: message,
          occurredAt: message.createdAt,
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        const stored = { ...message, sequence };
        db.prepare(
          `INSERT INTO projection_direct_threads (
             thread_id, member_a_id, member_b_id, created_at, updated_at,
             last_message_id, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             updated_at = excluded.updated_at,
             last_message_id = excluded.last_message_id,
             last_event_sequence = excluded.last_event_sequence`,
        ).run(threadId, memberIds[0], memberIds[1], message.createdAt, message.createdAt, message.id, sequence);
        db.prepare(
          `INSERT INTO projection_direct_messages (
             message_id, thread_id, sender_member_id, recipient_member_id, text,
             created_at, message_json, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          stored.id,
          stored.threadId,
          stored.senderMemberId,
          stored.recipientMemberId,
          stored.text,
          stored.createdAt,
          JSON.stringify(stored),
          sequence,
        );
        return stored;
      },
    );
  }

  markRead(memberId: string, otherMemberId: string, throughSequence: number): DirectConversationReadState {
    const threadId = directThreadId(memberId, otherMemberId);
    const state = databaseRow(
      this.database.connection
        .prepare(
          `SELECT thread.last_event_sequence, read_state.last_read_sequence
           FROM projection_direct_threads thread
           LEFT JOIN projection_direct_reads read_state
             ON read_state.thread_id = thread.thread_id AND read_state.member_id = ?
           WHERE thread.thread_id = ? AND (thread.member_a_id = ? OR thread.member_b_id = ?)`,
        )
        .get(memberId, threadId, memberId, memberId),
    );
    if (!state) {
      return { unreadCount: 0, firstUnreadMessageId: null, throughSequence: 0 };
    }
    const lastEventSequence = requiredNumber(state, "last_event_sequence");
    const lastReadSequence = nullableNumber(state, "last_read_sequence");
    const nextSequence = Math.max(lastReadSequence ?? 0, Math.min(Math.max(0, throughSequence), lastEventSequence));
    if ((lastReadSequence ?? 0) >= nextSequence) {
      return requiredReadState(this.readConversation(memberId, otherMemberId));
    }
    const updatedAt = new Date().toISOString();
    this.database.dispatch(
      `direct-read:${threadId}:${memberId}:${nextSequence}`,
      [
        {
          aggregateType: "direct-thread",
          aggregateId: threadId,
          eventType: "direct-thread.read",
          payload: { memberId, throughSequence: nextSequence },
          occurredAt: updatedAt,
        },
      ],
      (db) => {
        db.prepare(
          `INSERT INTO projection_direct_reads (
             thread_id, member_id, last_read_sequence, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id, member_id) DO UPDATE SET
             last_read_sequence = MAX(last_read_sequence, excluded.last_read_sequence),
             updated_at = excluded.updated_at`,
        ).run(threadId, memberId, nextSequence, updatedAt);
        return null;
      },
    );
    return requiredReadState(this.readConversation(memberId, otherMemberId));
  }

  #readState(memberId: string, threadId: string, messages: DirectMessage[]): DirectConversationReadState {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT last_read_sequence FROM projection_direct_reads
           WHERE thread_id = ? AND member_id = ?`,
        )
        .get(threadId, memberId),
    );
    const throughSequence = row ? requiredNumber(row, "last_read_sequence") : 0;
    const unread = messages.filter(
      (message) => message.senderMemberId !== memberId && message.sequence > throughSequence,
    );
    return {
      unreadCount: unread.length,
      firstUnreadMessageId: unread[0]?.id ?? null,
      throughSequence,
    };
  }
}

export function directThreadId(leftMemberId: string, rightMemberId: string): string {
  const memberIds = sortedMemberIds(leftMemberId, rightMemberId);
  const digest = createHash("sha256").update(`${memberIds[0]}\0${memberIds[1]}`).digest("hex").slice(0, 32);
  return `dm-${digest}`;
}

function databaseRow(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

function databaseRows(value: unknown): DynamicRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid direct-message query result.");
  return value.map((row) => {
    const record = databaseRow(row);
    if (!record) throw new Error("Invalid direct-message query row.");
    return record;
  });
}

function decodeDirectMessage(value: unknown): DirectMessage {
  if (
    !isDynamicRecord(value) ||
    !isString(value.id) ||
    !isString(value.threadId) ||
    !isString(value.senderMemberId) ||
    !isString(value.recipientMemberId) ||
    !isString(value.text) ||
    !isString(value.createdAt) ||
    !isNumber(value.sequence) ||
    !Number.isSafeInteger(value.sequence)
  ) {
    throw new Error("Invalid direct-message payload.");
  }
  return {
    id: value.id,
    threadId: value.threadId,
    senderMemberId: value.senderMemberId,
    recipientMemberId: value.recipientMemberId,
    text: value.text,
    createdAt: value.createdAt,
    sequence: value.sequence,
  };
}

function requiredReadState(snapshot: DirectConversationSnapshot): DirectConversationReadState {
  if (!snapshot.readState) throw new Error("The direct-message read state is missing.");
  return snapshot.readState;
}

function requiredString(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`Invalid direct-message column ${key}.`);
  return value;
}

function requiredNumber(row: DynamicRecord, key: string): number {
  const value = row[key];
  if (!isNumber(value)) throw new Error(`Invalid direct-message column ${key}.`);
  return value;
}

function nullableNumber(row: DynamicRecord, key: string): number | null {
  const value = row[key];
  if (value === null || isNumber(value)) return value;
  throw new Error(`Invalid direct-message column ${key}.`);
}

function sortedMemberIds(leftMemberId: string, rightMemberId: string): [string, string] {
  return leftMemberId.localeCompare(rightMemberId) <= 0 ? [leftMemberId, rightMemberId] : [rightMemberId, leftMemberId];
}
