import { randomUUID } from "node:crypto";
import { type AgentProviderId, isAgentProvider } from "@openbot/contracts/ipc";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import type { DatabaseCore } from "./database-core";
import { databaseRow, databaseRows, optionalStringColumn, requiredStringColumn } from "./database-rows";

export interface ProviderSession {
  id: string;
  threadId: string;
  provider: AgentProviderId;
  externalSessionId: string;
  model: string;
  effort: string;
  state: "active" | "inactive" | "failed";
  createdAt: string;
  updatedAt: string;
  resumeCursor: string | null;
}

interface SessionRow {
  id: string;
  thread_id: string;
  provider: AgentProviderId;
  external_session_id: string;
  model: string;
  effort: string;
  state: ProviderSession["state"];
  created_at: string;
  updated_at: string;
  resume_cursor: string | null;
}

export interface ProviderSessionsOptions {
  core: DatabaseCore;
}

/**
 * The provider-side resume state of a thread: which CLI session a provider is attached to now, and
 * the inactive ones it was attached to before.
 *
 * Owns `projection_provider_sessions` and the `provider-session.*` events behind it. Binding a
 * session deactivates the thread's previous active one inside the same dispatch, so a thread never
 * holds two. This state is deliberately private to the provider boundary and never reaches a
 * renderer. The class never imports the facade.
 */
export class ProviderSessions {
  readonly #core: DatabaseCore;

  constructor(options: ProviderSessionsOptions) {
    this.#core = options.core;
  }

  activeProviderSession(threadId: string, provider: AgentProviderId): ProviderSession | null {
    const row = decodeSessionRow(
      this.#core.connection
        .prepare(
          `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                  created_at, updated_at, resume_cursor
           FROM projection_provider_sessions
           WHERE thread_id = ? AND provider = ? AND state = 'active'
           ORDER BY created_at DESC, last_event_sequence DESC LIMIT 1`,
        )
        .get(threadId, provider),
    );
    return row ? toProviderSession(row) : null;
  }

  listProviderSessions(threadId: string): ProviderSession[] {
    return databaseRows(
      this.#core.connection
        .prepare(
          `SELECT id, thread_id, provider, external_session_id, model, effort, state,
                  created_at, updated_at, resume_cursor
           FROM projection_provider_sessions
           WHERE thread_id = ?
           ORDER BY created_at, last_event_sequence`,
        )
        .all(threadId),
    ).map((row) => toProviderSession(requiredSessionRow(row)));
  }

  bindProviderSession(input: {
    threadId: string;
    provider: AgentProviderId;
    externalSessionId: string;
    model: string;
    effort: string;
    resumeCursor?: string | null;
  }): ProviderSession {
    const now = new Date().toISOString();
    const session: ProviderSession = {
      id: randomUUID(),
      threadId: input.threadId,
      provider: input.provider,
      externalSessionId: input.externalSessionId,
      model: input.model,
      effort: input.effort,
      state: "active",
      createdAt: now,
      updatedAt: now,
      resumeCursor: input.resumeCursor ?? input.externalSessionId,
    };
    return this.#core.dispatch(
      `provider-session:bind:${input.threadId}:${input.provider}:${input.externalSessionId}`,
      [
        {
          aggregateType: "thread",
          aggregateId: input.threadId,
          eventType: "provider-session.bound",
          payload: session,
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions SET state = 'inactive', updated_at = ?
           WHERE thread_id = ? AND state = 'active'`,
        ).run(now, input.threadId);
        db.prepare(`
          INSERT INTO projection_provider_sessions (
            id, thread_id, provider, external_session_id, model, effort, state,
            created_at, updated_at, resume_cursor, last_event_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session.id,
          session.threadId,
          session.provider,
          session.externalSessionId,
          session.model,
          session.effort,
          session.state,
          session.createdAt,
          session.updatedAt,
          session.resumeCursor,
          sequences[0],
        );
        return session;
      },
    );
  }

  deactivateProviderSessions(threadId: string): void {
    const active = this.listProviderSessions(threadId).filter((session) => session.state === "active");
    if (active.length === 0) return;
    this.#core.dispatch(
      `provider-session:deactivate:${threadId}:${randomUUID()}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "provider-session.deactivated",
          payload: { sessionIds: active.map((session) => session.id) },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions
           SET state = 'inactive', updated_at = ?, last_event_sequence = ?
           WHERE thread_id = ? AND state = 'active'`,
        ).run(new Date().toISOString(), sequences[0], threadId);
        return null;
      },
    );
  }

  updateProviderSessionConfig(sessionId: string, threadId: string, model: string, effort: string): void {
    this.#core.dispatch(
      `provider-session:config:${sessionId}:${model}:${effort}`,
      [
        {
          aggregateType: "thread",
          aggregateId: threadId,
          eventType: "provider-session.config-updated",
          payload: { sessionId, model, effort },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `UPDATE projection_provider_sessions
           SET model = ?, effort = ?, updated_at = ?, last_event_sequence = ? WHERE id = ?`,
        ).run(model, effort, new Date().toISOString(), sequences[0], sessionId);
        return null;
      },
    );
  }
}

function toProviderSession(row: SessionRow): ProviderSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    provider: row.provider,
    externalSessionId: row.external_session_id,
    model: row.model,
    effort: row.effort,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resumeCursor: row.resume_cursor,
  };
}

function decodeSessionRow(value: unknown): SessionRow | null {
  const row = databaseRow(value);
  if (!row) return null;
  const provider = requiredStringColumn(row, "provider");
  const state = requiredStringColumn(row, "state");
  if (!isAgentProvider(provider)) throw new Error("Invalid provider column.");
  if (state !== "active" && state !== "inactive" && state !== "failed") {
    throw new Error("Invalid provider session state column.");
  }
  return {
    id: requiredStringColumn(row, "id"),
    thread_id: requiredStringColumn(row, "thread_id"),
    provider,
    external_session_id: requiredStringColumn(row, "external_session_id"),
    model: requiredStringColumn(row, "model"),
    effort: requiredStringColumn(row, "effort"),
    state,
    created_at: requiredStringColumn(row, "created_at"),
    updated_at: requiredStringColumn(row, "updated_at"),
    resume_cursor: optionalStringColumn(row, "resume_cursor"),
  };
}

function requiredSessionRow(value: DynamicRecord): SessionRow {
  const row = decodeSessionRow(value);
  if (!row) throw new Error("Invalid provider session row.");
  return row;
}
