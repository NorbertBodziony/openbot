import type { DatabaseSync } from "node:sqlite";
import type { BotSummary } from "@openbot/contracts/ipc";
import type { DatabaseCore } from "./database-core";
import { databaseRows, requiredStringColumn } from "./database-rows";

export interface AgentRosterOptions {
  core: DatabaseCore;
}

/**
 * The set of agents that exist and the thread row each one owns.
 *
 * Owns `projection_agents` and the `projection_threads` row implied by an agent having a thread,
 * which is why `ensureThreadProjection` is public here and not on the facade: the conversation
 * writer calls it from inside its own dispatch, passing the `db` that dispatch handed it.
 *
 * `hardDeleteAgent` is the one method here that erases history rather than projecting it. Each
 * receipt DELETE selects its command ids out of `orchestration_events`, so receipts must go before
 * the matching events in all four blocks — grouping the receipt deletes together would leave orphan
 * receipts, and `dispatch` replays an orphan receipt's stale result to a future command as though
 * it had already run. The class never imports the facade.
 */
export class AgentRoster {
  readonly #core: DatabaseCore;

  constructor(options: AgentRosterOptions) {
    this.#core = options.core;
  }

  listAgents(): BotSummary[] {
    return databaseRows(
      this.#core.connection.prepare("SELECT agent_json FROM projection_agents ORDER BY sort_order, agent_id").all(),
    ).map((row) => JSON.parse(requiredStringColumn(row, "agent_json")));
  }

  replaceAgents(commandId: string, agents: BotSummary[], eventType: string): void {
    this.#core.dispatch(
      commandId,
      [
        {
          aggregateType: "agents",
          aggregateId: "agents",
          eventType,
          payload: { agents },
        },
      ],
      (db, sequences) => {
        db.exec("DELETE FROM projection_agents");
        const insert = db.prepare(`
          INSERT INTO projection_agents
            (agent_id, thread_id, model, updated_at, sort_order, agent_json, last_event_sequence)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        agents.forEach((agent, index) => {
          insert.run(
            agent.id,
            agent.threadId,
            agent.model,
            agent.updatedAt,
            index,
            JSON.stringify(agent),
            sequences[0],
          );
          if (agent.threadId) this.ensureThreadProjection(db, agent, sequences[0] ?? 0);
        });
        return null;
      },
    );
  }

  hardDeleteAgent(commandId: string, botId: string, threadId: string | null, remainingAgents: BotSummary[]): void {
    this.#core.dispatch(
      commandId,
      [
        {
          aggregateType: "agents",
          aggregateId: "agents",
          eventType: "agents.rebased-after-delete",
          payload: { agents: remainingAgents },
        },
      ],
      (db, sequences) => {
        const sequence = sequences[0] ?? 0;
        const memoryIds = databaseRows(
          db.prepare("SELECT memory_id FROM projection_agent_memories WHERE agent_id = ?").all(botId),
        ).map((row) => requiredStringColumn(row, "memory_id"));
        const routineIds = databaseRows(
          db.prepare("SELECT routine_id FROM projection_agent_routines WHERE agent_id = ?").all(botId),
        ).map((row) => requiredStringColumn(row, "routine_id"));
        if (memoryIds.length > 0) {
          const placeholders = memoryIds.map(() => "?").join(", ");
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id
               FROM orchestration_events
               WHERE aggregate_type = 'agent-memory' AND aggregate_id IN (${placeholders})
             )`,
          ).run(...memoryIds);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type = 'agent-memory' AND aggregate_id IN (${placeholders})`,
          ).run(...memoryIds);
        }
        if (routineIds.length > 0) {
          const placeholders = routineIds.map(() => "?").join(", ");
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id FROM orchestration_events
               WHERE aggregate_type IN ('agent-routine', 'routine-run') AND aggregate_id IN (${placeholders})
             )`,
          ).run(...routineIds);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type IN ('agent-routine', 'routine-run') AND aggregate_id IN (${placeholders})`,
          ).run(...routineIds);
        }
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id FROM orchestration_events
             WHERE aggregate_type = 'hosted-site-terminal'
               AND event_type = 'hosted-site.terminal-pending'
               AND json_extract(payload_json, '$.botId') = ?
           )`,
        ).run(botId);
        db.prepare(
          `DELETE FROM orchestration_events
           WHERE aggregate_type = 'hosted-site-terminal'
             AND event_type = 'hosted-site.terminal-pending'
             AND json_extract(payload_json, '$.botId') = ?`,
        ).run(botId);
        const sensitiveFilter = threadId
          ? `(aggregate_id = ? OR aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`
          : `(aggregate_id = ? OR
              (aggregate_type = 'agents' AND aggregate_id = 'agents' AND sequence < ?))`;
        const sensitiveParameters = threadId ? ([botId, threadId, sequence] as const) : ([botId, sequence] as const);
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id FROM orchestration_events WHERE ${sensitiveFilter}
           )`,
        ).run(...sensitiveParameters);
        db.prepare(`DELETE FROM orchestration_events WHERE ${sensitiveFilter}`).run(...sensitiveParameters);
        db.prepare("DELETE FROM projection_agents WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_agent_memories WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_agent_routines WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_reactions WHERE agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_deliveries WHERE recipient_agent_id = ?").run(botId);
        db.prepare("DELETE FROM projection_queue_state WHERE agent_id = ?").run(botId);
        if (threadId) {
          db.prepare("DELETE FROM projection_threads WHERE thread_id = ?").run(threadId);
        }
        return null;
      },
    );
  }

  ensureThreadProjection(db: DatabaseSync, agent: BotSummary, sequence: number): void {
    if (!agent.threadId) return;
    db.prepare(`
      INSERT INTO projection_threads
        (thread_id, agent_id, title, active_turn_id, created_at, updated_at, last_event_sequence)
      VALUES (?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        title = excluded.title,
        updated_at = excluded.updated_at,
        last_event_sequence = MAX(projection_threads.last_event_sequence, excluded.last_event_sequence)
    `).run(
      agent.threadId,
      agent.id,
      agent.name,
      agent.updatedAt ?? new Date().toISOString(),
      agent.updatedAt ?? new Date().toISOString(),
      sequence,
    );
  }
}
