import { randomUUID } from "node:crypto";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { type DatabaseCore, deleteOrphanReceipts } from "./database-core";
import { databaseRow, databaseRows, requiredStringColumn } from "./database-rows";

export interface MailboxProjectionAttachment {
  id: string;
  name: string;
  path: string;
}

export interface MailboxProjectionMessage {
  id: string;
  sender: {
    kind: string;
    botId?: string;
    routineId?: string;
    runId?: string;
    routineName?: string;
    scheduledFor?: string;
  };
  text: string;
  replyToMessageId: string | null;
  createdAt: string;
  attachments: MailboxProjectionAttachment[];
}

export interface MailboxProjectionDelivery {
  id: string;
  messageId: string;
  recipientBotId: string;
  status: string;
  turnId: string | null;
  error: string | null;
  createdAt: string;
}

export interface MailboxProjectionDraft extends MailboxProjectionAttachment {
  createdAt: string;
}

export interface MailboxProjectionGeneratedAttachment extends MailboxProjectionAttachment {
  size: number;
  kind: string;
  mimeType: string;
  previewKind: string;
  previewUrl: string | null;
  sha256: string;
}

export interface MailboxProjectionReaction {
  botId: string;
  messageId: string;
  emoji: string;
  actor: { kind: "user" } | { kind: "bot"; botId: string };
  updatedAt: string;
}

export interface MailboxProjectionState {
  messages: MailboxProjectionMessage[];
  deliveries: MailboxProjectionDelivery[];
  drafts: MailboxProjectionDraft[];
  generatedAttachments: MailboxProjectionGeneratedAttachment[];
  pausedBotIds: string[];
  idempotency: Record<string, string>;
  reactions: MailboxProjectionReaction[];
}

export interface MailboxProjectionOptions {
  core: DatabaseCore;
}

/**
 * The mailbox read model: messages, deliveries, drafts, generated attachments, reactions, per-agent
 * queue state, and the outbox of files still to be deleted from disk.
 *
 * Owns `projection_mailbox_messages`, `projection_deliveries`, `projection_queue_state`,
 * `projection_attachments`, `projection_reactions` and `file_deletion_outbox`. Unlike every other
 * projection here, mailbox state is stored whole: each write replaces the tables and compacts the
 * `mailbox` aggregate down to its newest event, so the log never accumulates superseded snapshots.
 * The class never imports the facade.
 */
export class MailboxProjection {
  readonly #core: DatabaseCore;

  constructor(options: MailboxProjectionOptions) {
    this.#core = options.core;
  }

  replaceMailboxState(
    commandId: string,
    state: MailboxProjectionState,
    eventType: string,
    fileDeletions: string[] = [],
    _rebaseHistory = false,
  ): void {
    this.#core.dispatch(
      commandId,
      [
        {
          aggregateType: "mailbox",
          aggregateId: "mailbox",
          eventType,
          payload: state,
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        db.prepare(
          `DELETE FROM orchestration_events
           WHERE aggregate_type = 'mailbox' AND aggregate_id = 'mailbox' AND sequence < ?`,
        ).run(sequence);
        deleteOrphanReceipts(db);
        const value = state;
        db.exec("DELETE FROM projection_deliveries");
        db.exec("DELETE FROM projection_mailbox_messages");
        db.exec("DELETE FROM projection_queue_state");
        db.exec("DELETE FROM projection_reactions");
        db.exec("DELETE FROM projection_attachments WHERE owner_kind IN ('mailbox-message', 'draft', 'generated')");
        const messageInsert = db.prepare(`
          INSERT INTO projection_mailbox_messages
            (message_id, sender_kind, sender_agent_id, text, reply_to_message_id, created_at, message_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const attachmentInsert = db.prepare(`
          INSERT INTO projection_attachments
            (attachment_id, owner_kind, owner_id, name, path, metadata_json, created_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const message of value.messages) {
          const sender = message.sender;
          messageInsert.run(
            String(message.id),
            sender.kind,
            sender.botId ?? null,
            String(message.text),
            isString(message.replyToMessageId) ? message.replyToMessageId : null,
            String(message.createdAt),
            JSON.stringify(message),
            sequence,
          );
          for (const attachment of message.attachments) {
            attachmentInsert.run(
              String(attachment.id),
              "mailbox-message",
              String(message.id),
              String(attachment.name),
              String(attachment.path),
              JSON.stringify(attachment),
              String(message.createdAt),
              sequence,
            );
          }
        }
        const deliveryInsert = db.prepare(`
          INSERT INTO projection_deliveries
            (delivery_id, message_id, recipient_agent_id, status, turn_id, error, created_at, delivery_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const delivery of value.deliveries) {
          deliveryInsert.run(
            String(delivery.id),
            String(delivery.messageId),
            String(delivery.recipientBotId),
            String(delivery.status),
            isString(delivery.turnId) ? delivery.turnId : null,
            isString(delivery.error) ? delivery.error : null,
            String(delivery.createdAt),
            JSON.stringify(delivery),
            sequence,
          );
        }
        const queueInsert = db.prepare(`
          INSERT INTO projection_queue_state
            (agent_id, paused, metadata_json, last_event_sequence) VALUES (?, ?, ?, ?)
        `);
        queueInsert.run("__mailbox__", 0, JSON.stringify({ idempotency: value.idempotency }), sequence);
        for (const botId of value.pausedBotIds) queueInsert.run(botId, 1, "{}", sequence);
        const reactionInsert = db.prepare(`
          INSERT INTO projection_reactions
            (agent_id, message_id, emoji, actor_kind, actor_bot_id, updated_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const reaction of value.reactions) {
          reactionInsert.run(
            String(reaction.botId),
            String(reaction.messageId),
            String(reaction.emoji),
            reaction.actor.kind,
            reaction.actor.kind === "bot" ? reaction.actor.botId : "",
            String(reaction.updatedAt),
            sequence,
          );
        }
        for (const draft of value.drafts) {
          attachmentInsert.run(
            String(draft.id),
            "draft",
            String(draft.id),
            String(draft.name),
            String(draft.path),
            JSON.stringify(draft),
            String(draft.createdAt),
            sequence,
          );
        }
        for (const attachment of value.generatedAttachments) {
          attachmentInsert.run(
            String(attachment.id),
            "generated",
            String(attachment.id),
            String(attachment.name),
            String(attachment.path),
            JSON.stringify(attachment),
            new Date().toISOString(),
            sequence,
          );
        }
        const outboxInsert = db.prepare(`
          INSERT OR IGNORE INTO file_deletion_outbox
            (id, path, reason, created_at, attempts, last_error)
          VALUES (?, ?, ?, ?, 0, NULL)
        `);
        for (const path of fileDeletions) {
          outboxInsert.run(randomUUID(), path, eventType, new Date().toISOString());
        }
        return null;
      },
    );
  }

  pendingFileDeletions(): Array<{ id: string; path: string }> {
    return databaseRows(
      this.#core.connection.prepare("SELECT id, path FROM file_deletion_outbox ORDER BY created_at").all(),
    ).map((row) => ({
      id: requiredStringColumn(row, "id"),
      path: requiredStringColumn(row, "path"),
    }));
  }

  completeFileDeletion(id: string): void {
    this.#core.connection.prepare("DELETE FROM file_deletion_outbox WHERE id = ?").run(id);
  }

  failFileDeletion(id: string, error: string): void {
    this.#core.connection
      .prepare(
        `UPDATE file_deletion_outbox
         SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )
      .run(error.slice(0, 2_000), id);
  }

  readMailboxState(): unknown | null {
    const db = this.#core.connection;
    const marker = databaseRow(
      db.prepare("SELECT metadata_json FROM projection_queue_state WHERE agent_id = '__mailbox__'").get(),
    );
    if (!marker) return null;
    const metadata = parseMailboxMetadata(requiredStringColumn(marker, "metadata_json"));
    const messages = databaseRows(
      db.prepare("SELECT message_json FROM projection_mailbox_messages ORDER BY created_at, message_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "message_json")));
    const deliveries = databaseRows(
      db.prepare("SELECT delivery_json FROM projection_deliveries ORDER BY created_at, delivery_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "delivery_json")));
    const drafts = databaseRows(
      db.prepare("SELECT metadata_json FROM projection_attachments WHERE owner_kind = 'draft'").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "metadata_json")));
    const generatedAttachments = databaseRows(
      db.prepare("SELECT metadata_json FROM projection_attachments WHERE owner_kind = 'generated'").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "metadata_json")));
    const pausedBotIds = databaseRows(
      db.prepare("SELECT agent_id FROM projection_queue_state WHERE paused = 1").all(),
    ).map((row) => requiredStringColumn(row, "agent_id"));
    const reactions = databaseRows(
      db
        .prepare("SELECT agent_id, message_id, emoji, actor_kind, actor_bot_id, updated_at FROM projection_reactions")
        .all(),
    ).map((row) => ({
      botId: requiredStringColumn(row, "agent_id"),
      messageId: requiredStringColumn(row, "message_id"),
      emoji: requiredStringColumn(row, "emoji"),
      actor:
        requiredStringColumn(row, "actor_kind") === "bot"
          ? { kind: "bot" as const, botId: requiredStringColumn(row, "actor_bot_id") }
          : { kind: "user" as const },
      updatedAt: requiredStringColumn(row, "updated_at"),
    }));
    return {
      version: 3,
      messages,
      deliveries,
      drafts,
      generatedAttachments,
      pausedBotIds,
      idempotency: metadata.idempotency ?? {},
      reactions,
    };
  }
}

function parseMailboxMetadata(value: string): { idempotency?: Record<string, string> } {
  const parsed = JSON.parse(value);
  if (!isDynamicRecord(parsed)) throw new Error("Invalid mailbox metadata.");
  const idempotency = parsed.idempotency;
  if (idempotency === undefined) return {};
  if (!isDynamicRecord(idempotency)) throw new Error("Invalid mailbox idempotency metadata.");
  const entries = Object.entries(idempotency);
  const values: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!isString(entry)) throw new Error("Invalid mailbox idempotency entry.");
    values[key] = entry;
  }
  return { idempotency: values };
}
