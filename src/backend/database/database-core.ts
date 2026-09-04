import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateOpenBotDatabase } from "../openbot-database-schema";
import { databaseRow, errorCode, requiredNumberColumn, requiredStringColumn } from "./database-rows";

export interface OrchestrationEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  occurredAt?: string;
}

interface ReceiptRow {
  last_sequence: number;
  result_json: string;
}

export interface DatabaseCoreOptions {
  userDataPath: string;
}

/**
 * The SQLite handle and the append-events, project, write-receipt primitive every other database
 * controller is built on.
 *
 * Owns the open connection, the file on disk and its migration, the orchestration event log and
 * its command receipts, and the transaction ownership rule: only the caller that finds no open
 * transaction opens and closes one, so a projector may nest another dispatch inside its own.
 * Controllers hold this object and read `connection` at each use — a cached handle survives
 * `initialize` and then silently addresses a closed database after `close`. The class knows
 * nothing about projections and never imports the facade.
 */
export class DatabaseCore {
  readonly path: string;
  readonly #legacyBackupRoot: string;
  #db: DatabaseSync | null = null;

  constructor(options: DatabaseCoreOptions) {
    this.path = join(options.userDataPath, "openbot.db");
    this.#legacyBackupRoot = join(options.userDataPath, "legacy-backup-v1");
  }

  async initialize(): Promise<void> {
    if (this.#db) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA synchronous = NORMAL");
      this.#db = db;
      this.#migrate();
      await chmod(this.path, 0o600);
    } catch (error) {
      db.close();
      this.#db = null;
      throw error;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  get connection(): DatabaseSync {
    if (!this.#db) throw new Error("OpenBot database is not initialized.");
    return this.#db;
  }

  dispatch<T>(
    commandId: string,
    events: OrchestrationEventInput[],
    project: (db: DatabaseSync, sequences: number[]) => T,
  ): T {
    const db = this.connection;
    const receipt = decodeReceiptRow(
      db
        .prepare("SELECT last_sequence, result_json FROM orchestration_command_receipts WHERE command_id = ?")
        .get(commandId),
    );
    if (receipt) return JSON.parse(receipt.result_json);

    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const sequences: number[] = [];
      const append = db.prepare(`
        INSERT INTO orchestration_events (
          event_id, command_id, aggregate_type, aggregate_id, event_type, occurred_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        const result = append.run(
          randomUUID(),
          commandId,
          event.aggregateType,
          event.aggregateId,
          event.eventType,
          event.occurredAt ?? new Date().toISOString(),
          JSON.stringify(event.payload),
        );
        sequences.push(Number(result.lastInsertRowid));
      }
      const result = project(db, sequences);
      db.prepare(
        `INSERT INTO orchestration_command_receipts
          (command_id, accepted_at, first_sequence, last_sequence, result_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        commandId,
        new Date().toISOString(),
        sequences[0] ?? 0,
        sequences.at(-1) ?? 0,
        JSON.stringify(result ?? null),
      );
      if (ownsTransaction) db.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  commandResult(commandId: string): unknown | undefined {
    const receipt = decodeReceiptRow(
      this.connection
        .prepare("SELECT last_sequence, result_json FROM orchestration_command_receipts WHERE command_id = ?")
        .get(commandId),
    );
    return receipt ? JSON.parse(receipt.result_json) : undefined;
  }

  deleteEventsAndReceipt(commandId: string): void {
    const db = this.connection;
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM orchestration_events WHERE command_id = ?").run(commandId);
      db.prepare("DELETE FROM orchestration_command_receipts WHERE command_id = ?").run(commandId);
      if (ownsTransaction) db.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  async backupLegacyFile(path: string): Promise<void> {
    try {
      await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await mkdir(this.#legacyBackupRoot, { recursive: true, mode: 0o700 });
    const target = join(this.#legacyBackupRoot, basename(path));
    try {
      await copyFile(path, target, 1);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await chmod(target, 0o600);
  }

  hasAggregateEvents(aggregateType: string, aggregateId: string): boolean {
    return Boolean(
      this.connection
        .prepare("SELECT 1 FROM orchestration_events WHERE aggregate_type = ? AND aggregate_id = ? LIMIT 1")
        .get(aggregateType, aggregateId),
    );
  }

  #migrate(): void {
    migrateOpenBotDatabase(this.connection);
  }
}

function decodeReceiptRow(value: unknown): ReceiptRow | null {
  const row = databaseRow(value);
  if (!row) return null;
  return {
    last_sequence: requiredNumberColumn(row, "last_sequence"),
    result_json: requiredStringColumn(row, "result_json"),
  };
}

export function deleteOrphanReceipts(db: DatabaseSync): void {
  db.exec(`DELETE FROM orchestration_command_receipts
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_events
      WHERE orchestration_events.command_id = orchestration_command_receipts.command_id
    )`);
}
