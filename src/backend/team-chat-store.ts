import { createHash } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  DirectConversationSnapshot,
  DirectMessage,
  DirectThreadSummary,
} from "@openbot/contracts/ipc";
import type { OpenBotDatabase } from "./openbot-database";

interface DirectMessageRow {
  message_json: string;
}

interface DirectThreadRow {
  thread_id: string;
  member_a_id: string;
  member_b_id: string;
  updated_at: string;
  message_json: string;
  unread_count: number;
}

interface DirectThreadSequenceRow {
  last_event_sequence: number;
  last_read_sequence: number | null;
}

export class TeamChatStore {
  constructor(readonly database: OpenBotDatabase) {}

  listThreads(memberId: string): DirectThreadSummary[] {
    const rows = this.database.connection
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
      .all(memberId, memberId, memberId, memberId) as unknown as DirectThreadRow[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      otherMemberId: row.member_a_id === memberId ? row.member_b_id : row.member_a_id,
      lastMessage: JSON.parse(row.message_json) as DirectMessage,
      unreadCount: row.unread_count,
      updatedAt: row.updated_at,
    }));
  }

  readConversation(memberId: string, otherMemberId: string): DirectConversationSnapshot {
    const threadId = directThreadId(memberId, otherMemberId);
    const thread = this.database.connection
      .prepare(
        `SELECT last_event_sequence
         FROM projection_direct_threads
         WHERE thread_id = ? AND (member_a_id = ? OR member_b_id = ?)`,
      )
      .get(threadId, memberId, memberId) as { last_event_sequence: number } | undefined;
    const rows = this.database.connection
      .prepare(
        `SELECT message_json FROM projection_direct_messages
         WHERE thread_id = ? ORDER BY last_event_sequence, message_id`,
      )
      .all(threadId) as unknown as DirectMessageRow[];
    return {
      threadId,
      otherMemberId,
      messages: rows.map((row) => JSON.parse(row.message_json) as DirectMessage),
      revision: thread?.last_event_sequence ?? 0,
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
      throw new Error(
        `A direct message can have up to ${INPUT_LIMITS.directMessageText} characters.`,
      );
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
        ).run(
          threadId,
          memberIds[0],
          memberIds[1],
          message.createdAt,
          message.createdAt,
          message.id,
          sequence,
        );
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

  markRead(memberId: string, otherMemberId: string): void {
    const threadId = directThreadId(memberId, otherMemberId);
    const state = this.database.connection
      .prepare(
        `SELECT thread.last_event_sequence, read_state.last_read_sequence
         FROM projection_direct_threads thread
         LEFT JOIN projection_direct_reads read_state
           ON read_state.thread_id = thread.thread_id AND read_state.member_id = ?
         WHERE thread.thread_id = ? AND (thread.member_a_id = ? OR thread.member_b_id = ?)`,
      )
      .get(memberId, threadId, memberId, memberId) as DirectThreadSequenceRow | undefined;
    if (!state || (state.last_read_sequence ?? 0) >= state.last_event_sequence) return;
    const updatedAt = new Date().toISOString();
    this.database.dispatch(
      `direct-read:${threadId}:${memberId}:${state.last_event_sequence}`,
      [
        {
          aggregateType: "direct-thread",
          aggregateId: threadId,
          eventType: "direct-thread.read",
          payload: { memberId, throughSequence: state.last_event_sequence },
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
        ).run(threadId, memberId, state.last_event_sequence, updatedAt);
        return null;
      },
    );
  }
}

export function directThreadId(leftMemberId: string, rightMemberId: string): string {
  const memberIds = sortedMemberIds(leftMemberId, rightMemberId);
  const digest = createHash("sha256")
    .update(`${memberIds[0]}\0${memberIds[1]}`)
    .digest("hex")
    .slice(0, 32);
  return `dm-${digest}`;
}

function sortedMemberIds(leftMemberId: string, rightMemberId: string): [string, string] {
  return leftMemberId.localeCompare(rightMemberId) <= 0
    ? [leftMemberId, rightMemberId]
    : [rightMemberId, leftMemberId];
}
