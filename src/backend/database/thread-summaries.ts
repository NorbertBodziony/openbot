import { randomUUID } from "node:crypto";
import type { DatabaseCore } from "./database-core";
import { databaseRow, optionalStringColumn, requiredNumberColumn, requiredStringColumn } from "./database-rows";

export interface StoredThreadSummary {
  id: string;
  threadId: string;
  throughMessageId: string | null;
  text: string;
  estimatedTokens: number;
  createdAt: string;
}

export interface ThreadSummariesOptions {
  core: DatabaseCore;
}

/**
 * The compaction summaries of a thread: the text standing in for messages a provider no longer
 * receives, and the message each summary runs through.
 *
 * Owns `projection_thread_summaries` and the `thread.summary-created` events behind it. Summaries
 * are append-only and the latest one wins, so a replay rebuilds them in order with no
 * reconciliation. The class never imports the facade.
 */
export class ThreadSummaries {
  readonly #core: DatabaseCore;

  constructor(options: ThreadSummariesOptions) {
    this.#core = options.core;
  }

  saveThreadSummary(
    threadId: string,
    throughMessageId: string | null,
    text: string,
    estimatedTokens: number,
  ): StoredThreadSummary {
    const summary: StoredThreadSummary = {
      id: randomUUID(),
      threadId,
      throughMessageId,
      text,
      estimatedTokens,
      createdAt: new Date().toISOString(),
    };
    return this.#core.dispatch(
      `thread-summary:${summary.id}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "thread.summary-created",
          payload: summary,
        },
      ],
      (db, sequences) => {
        db.prepare(`
          INSERT INTO projection_thread_summaries
            (summary_id, thread_id, through_message_id, summary_text, estimated_tokens, created_at, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(summary.id, threadId, throughMessageId, text, estimatedTokens, summary.createdAt, sequences[0]);
        return summary;
      },
    );
  }

  latestThreadSummary(threadId: string): StoredThreadSummary | null {
    const row = decodeSummaryRow(
      this.#core.connection
        .prepare(
          `SELECT summary_id, thread_id, through_message_id, summary_text, estimated_tokens, created_at
           FROM projection_thread_summaries WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId),
    );
    return row
      ? {
          id: row.summary_id,
          threadId: row.thread_id,
          throughMessageId: row.through_message_id,
          text: row.summary_text,
          estimatedTokens: row.estimated_tokens,
          createdAt: row.created_at,
        }
      : null;
  }
}

function decodeSummaryRow(value: unknown): {
  summary_id: string;
  thread_id: string;
  through_message_id: string | null;
  summary_text: string;
  estimated_tokens: number;
  created_at: string;
} | null {
  const row = databaseRow(value);
  if (!row) return null;
  return {
    summary_id: requiredStringColumn(row, "summary_id"),
    thread_id: requiredStringColumn(row, "thread_id"),
    through_message_id: optionalStringColumn(row, "through_message_id"),
    summary_text: requiredStringColumn(row, "summary_text"),
    estimated_tokens: requiredNumberColumn(row, "estimated_tokens"),
    created_at: requiredStringColumn(row, "created_at"),
  };
}
