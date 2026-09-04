import { randomUUID } from "node:crypto";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { AgentMemory, AgentMemoryOrigin } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { OpenBotDatabase } from "./openbot-database";

export interface SaveAutomaticMemoryInput {
  agentId: string;
  memoryId?: string;
  text: string;
  sourceTurnId: string;
  expectedUpdatedAt?: string | null;
}

export class AgentMemoryStore {
  constructor(readonly database: OpenBotDatabase) {}

  list(agentId: string): AgentMemory[] {
    return databaseRows(
      this.database.connection
        .prepare(
          `SELECT memory_id, agent_id, text, origin, source_turn_id, created_at, updated_at
         FROM projection_agent_memories
         WHERE agent_id = ?
         ORDER BY updated_at DESC, memory_id`,
        )
        .all(agentId),
    ).map(memoryFromRow);
  }

  get(agentId: string, memoryId: string): AgentMemory | null {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT memory_id, agent_id, text, origin, source_turn_id, created_at, updated_at
         FROM projection_agent_memories
         WHERE agent_id = ? AND memory_id = ?`,
        )
        .get(agentId, memoryId),
    );
    return row ? memoryFromRow(row) : null;
  }

  createManual(agentId: string, text: string): AgentMemory {
    return this.#save({ agentId, text, origin: "manual", sourceTurnId: null });
  }

  duplicate(sourceAgentId: string, targetAgentId: string): AgentMemory[] {
    return this.list(sourceAgentId).map((memory) =>
      this.#save({
        agentId: targetAgentId,
        text: memory.text,
        origin: memory.origin,
        sourceTurnId: null,
      }),
    );
  }

  updateManual(agentId: string, memoryId: string, text: string): AgentMemory {
    return this.#save({ agentId, memoryId, text, origin: "manual", sourceTurnId: null });
  }

  saveAutomatic(input: SaveAutomaticMemoryInput): AgentMemory | null {
    if (input.memoryId && input.expectedUpdatedAt !== undefined) {
      const current = this.get(input.agentId, input.memoryId);
      if (!current || current.updatedAt !== input.expectedUpdatedAt) return null;
    }
    return this.#save({
      agentId: input.agentId,
      memoryId: input.memoryId,
      text: input.text,
      origin: "automatic",
      sourceTurnId: input.sourceTurnId,
    });
  }

  delete(agentId: string, memoryId: string, expectedUpdatedAt?: string | null): boolean {
    const current = this.get(agentId, memoryId);
    if (!current) return false;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return false;
    const commandId = `agent-memory:delete:${randomUUID()}`;
    this.database.dispatch(
      commandId,
      [
        {
          aggregateType: "agent-memory",
          aggregateId: memoryId,
          eventType: "agent-memory.deleted",
          payload: { agentId, memoryId },
        },
      ],
      (db, sequences) => {
        const deletionSequence = sequences[0] ?? 0;
        db.prepare(
          `DELETE FROM orchestration_command_receipts WHERE command_id IN (
             SELECT DISTINCT command_id
             FROM orchestration_events
             WHERE aggregate_type = 'agent-memory' AND aggregate_id = ? AND sequence < ?
           )`,
        ).run(memoryId, deletionSequence);
        db.prepare(
          `DELETE FROM orchestration_events
           WHERE aggregate_type = 'agent-memory' AND aggregate_id = ? AND sequence < ?`,
        ).run(memoryId, deletionSequence);
        db.prepare("DELETE FROM projection_agent_memories WHERE agent_id = ? AND memory_id = ?").run(agentId, memoryId);
        return true;
      },
    );
    return true;
  }

  clear(agentId: string): number {
    const memories = this.list(agentId);
    if (memories.length === 0) return 0;
    const commandId = `agent-memory:clear:${randomUUID()}`;
    return this.database.dispatch(
      commandId,
      memories.map((memory) => ({
        aggregateType: "agent-memory",
        aggregateId: memory.id,
        eventType: "agent-memory.deleted",
        payload: { agentId, memoryId: memory.id },
      })),
      (db, sequences) => {
        for (const [index, memory] of memories.entries()) {
          const deletionSequence = sequences[index] ?? 0;
          db.prepare(
            `DELETE FROM orchestration_command_receipts WHERE command_id IN (
               SELECT DISTINCT command_id
               FROM orchestration_events
               WHERE aggregate_type = 'agent-memory' AND aggregate_id = ? AND sequence < ?
             )`,
          ).run(memory.id, deletionSequence);
          db.prepare(
            `DELETE FROM orchestration_events
             WHERE aggregate_type = 'agent-memory' AND aggregate_id = ? AND sequence < ?`,
          ).run(memory.id, deletionSequence);
        }
        db.prepare("DELETE FROM projection_agent_memories WHERE agent_id = ?").run(agentId);
        return memories.length;
      },
    );
  }

  #save(input: {
    agentId: string;
    memoryId?: string;
    text: string;
    origin: AgentMemoryOrigin;
    sourceTurnId: string | null;
  }): AgentMemory {
    const text = validateMemoryText(input.text);
    const normalizedText = normalizeMemoryText(text);
    const duplicate = this.#findByNormalizedText(input.agentId, normalizedText);
    if (duplicate && duplicate.id !== input.memoryId) {
      if (input.memoryId) this.delete(input.agentId, input.memoryId);
      return duplicate;
    }

    const previous = input.memoryId ? this.get(input.agentId, input.memoryId) : null;
    if (input.memoryId && !previous) throw new Error("This memory no longer exists.");
    if (!previous && this.list(input.agentId).length >= INPUT_LIMITS.agentMemories) {
      throw new Error(`An agent can have up to ${INPUT_LIMITS.agentMemories} memories.`);
    }

    const now = new Date().toISOString();
    const updatedAt =
      previous && now <= previous.updatedAt ? new Date(Date.parse(previous.updatedAt) + 1).toISOString() : now;
    const memory: AgentMemory = {
      id: previous?.id ?? randomUUID(),
      agentId: input.agentId,
      text,
      origin: input.origin,
      sourceTurnId: input.sourceTurnId,
      createdAt: previous?.createdAt ?? now,
      updatedAt,
    };
    const eventType = previous ? "agent-memory.updated" : "agent-memory.created";
    this.database.dispatch(
      `agent-memory:${eventType}:${randomUUID()}`,
      [
        {
          aggregateType: "agent-memory",
          aggregateId: memory.id,
          eventType,
          payload: { memory },
        },
      ],
      (db, sequences) => {
        db.prepare(
          `INSERT INTO projection_agent_memories (
             memory_id, agent_id, text, normalized_text, origin, source_turn_id,
             created_at, updated_at, last_event_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             text = excluded.text,
             normalized_text = excluded.normalized_text,
             origin = excluded.origin,
             source_turn_id = excluded.source_turn_id,
             updated_at = excluded.updated_at,
             last_event_sequence = excluded.last_event_sequence`,
        ).run(
          memory.id,
          memory.agentId,
          memory.text,
          normalizedText,
          memory.origin,
          memory.sourceTurnId,
          memory.createdAt,
          memory.updatedAt,
          sequences[0] ?? 0,
        );
        return memory;
      },
    );
    return memory;
  }

  #findByNormalizedText(agentId: string, normalizedText: string): AgentMemory | null {
    const row = databaseRow(
      this.database.connection
        .prepare(
          `SELECT memory_id, agent_id, text, origin, source_turn_id, created_at, updated_at
         FROM projection_agent_memories
         WHERE agent_id = ? AND normalized_text = ?`,
        )
        .get(agentId, normalizedText),
    );
    return row ? memoryFromRow(row) : null;
  }
}

function validateMemoryText(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Memory text is required.");
  if (text.length > INPUT_LIMITS.agentMemoryText) throw new Error("Memory text is too long.");
  return text;
}

function normalizeMemoryText(value: string): string {
  return value;
}

function databaseRow(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

function databaseRows(value: unknown): DynamicRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid agent memory query result.");
  return value.map((row) => {
    const record = databaseRow(row);
    if (!record) throw new Error("Invalid agent memory query row.");
    return record;
  });
}

function requiredStringColumn(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`Invalid agent memory column ${key}.`);
  return value;
}

function memoryFromRow(row: DynamicRecord): AgentMemory {
  const origin = requiredStringColumn(row, "origin");
  if (origin !== "automatic" && origin !== "manual") throw new Error("Invalid agent memory origin.");
  const sourceTurnId = row.source_turn_id;
  if (sourceTurnId !== null && !isString(sourceTurnId)) throw new Error("Invalid agent memory source turn.");
  return {
    id: requiredStringColumn(row, "memory_id"),
    agentId: requiredStringColumn(row, "agent_id"),
    text: requiredStringColumn(row, "text"),
    origin,
    sourceTurnId,
    createdAt: requiredStringColumn(row, "created_at"),
    updatedAt: requiredStringColumn(row, "updated_at"),
  };
}
