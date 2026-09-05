import type { ConversationMessage } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { currentConversationMessage } from "./legacy-conversation-message";

/**
 * Decoding for raw `node:sqlite` results, shared by every database controller.
 *
 * `DatabaseSync` hands back `unknown`, so each of these narrows one shape and throws naming the
 * column that failed rather than letting an undefined propagate into a projection. Pure functions
 * over a row: they hold no connection, open no transaction, and never import the facade.
 */

export function databaseRow(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}

export function databaseRows(value: unknown): DynamicRecord[] {
  if (!Array.isArray(value)) throw new Error("Invalid SQLite result set.");
  return value.map((row, index) => {
    if (!isDynamicRecord(row)) throw new Error(`Invalid SQLite row at index ${index}.`);
    return row;
  });
}

export function requiredStringColumn(row: DynamicRecord, key: string): string {
  const value = row[key];
  if (!isString(value)) throw new Error(`Invalid SQLite column ${key}.`);
  return value;
}

export function requiredNumberColumn(row: DynamicRecord, key: string): number {
  const value = row[key];
  if (!isNumber(value)) throw new Error(`Invalid SQLite column ${key}.`);
  return value;
}

export function optionalStringColumn(row: DynamicRecord, key: string): string | null {
  const value = row[key];
  if (value === null || isString(value)) return value;
  throw new Error(`Invalid SQLite column ${key}.`);
}

export function decodeConversationThreadRow(
  value: unknown,
): { active_turn_id: string | null; last_event_sequence: number } | null {
  const row = databaseRow(value);
  if (!row) return null;
  return {
    active_turn_id: optionalStringColumn(row, "active_turn_id"),
    last_event_sequence: requiredNumberColumn(row, "last_event_sequence"),
  };
}

export function requiredEventRow(value: DynamicRecord): {
  sequence: number;
  event_type: string;
  occurred_at: string;
  payload_json: string;
} {
  return {
    sequence: requiredNumberColumn(value, "sequence"),
    event_type: requiredStringColumn(value, "event_type"),
    occurred_at: requiredStringColumn(value, "occurred_at"),
    payload_json: requiredStringColumn(value, "payload_json"),
  };
}

export function decodeThreadAgentRow(value: unknown): { agent_id: string } | null {
  const row = databaseRow(value);
  return row ? { agent_id: requiredStringColumn(row, "agent_id") } : null;
}

export function decodeConversationMessageJson(value: string): ConversationMessage {
  const message = currentConversationMessage(JSON.parse(value));
  if (!message) throw new Error("Invalid conversation message.");
  return message;
}

export function errorCode(value: unknown): string | null {
  return isDynamicRecord(value) && isString(value.code) ? value.code : null;
}

export function objectValue(value: unknown): DynamicRecord | null {
  return isDynamicRecord(value) ? value : null;
}
