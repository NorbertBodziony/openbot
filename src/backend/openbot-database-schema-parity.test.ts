// @vitest-environment node

// A new install and an upgraded install are built by two different code paths:
// `createLatestDatabase` execs LATEST_SCHEMA_SQL and stamps every migration as
// applied without running it, while an existing database runs the migrations.
// Nothing but a comment keeps the two in agreement, so the first DDL migration
// that is not also mirrored into LATEST_SCHEMA_SQL would ship new installs a
// database missing a column while upgraded installs get it - on users' machines,
// with no backup to fall back on. These tests are that agreement.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const appliedAt = "2026-09-03T10:00:00.000Z";

const roots: string[] = [];
const connections: DatabaseSync[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OpenBot database build paths", () => {
  it("gives a new install the same tables, columns, indexes and foreign keys as an upgraded one", async () => {
    const fresh = await newInstallDatabase();
    const upgraded = await upgradedInstallDatabase();

    expect(readTableShapes(upgraded)).toEqual(readTableShapes(fresh));
  });

  it("gives a new install the same declarations as an upgraded one, including partial index filters", async () => {
    const fresh = await newInstallDatabase();
    const upgraded = await upgradedInstallDatabase();

    expect(readNormalizedDeclarations(upgraded)).toEqual(readNormalizedDeclarations(fresh));
  });

  it("records the same applied migration versions on both paths", async () => {
    const fresh = await newInstallDatabase();
    const upgraded = await upgradedInstallDatabase();

    expect(readAppliedVersions(upgraded)).toEqual(readAppliedVersions(fresh));
  });
});

// An empty database has no tables, so `migrateOpenBotDatabase` takes the
// `createLatestDatabase` branch - the path every new install follows.
async function newInstallDatabase(): Promise<DatabaseSync> {
  const database = await openDatabase();
  migrateOpenBotDatabase(database, { appliedAt });
  return database;
}

// One empty table is enough for `hasExistingSchema` to report an existing
// database, and an empty `schema_migrations` reads as a version older than the
// baseline, so every migration runs in order from the v8 baseline SQL upwards -
// the path every upgraded install follows. Building the fixture this way rather
// than by stripping rows from a new install matters: a new install already
// carries the columns a future migration adds, so re-running that migration
// against it would fail on a duplicate column and go red on correct code.
async function upgradedInstallDatabase(): Promise<DatabaseSync> {
  const database = await openDatabase();
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  migrateOpenBotDatabase(database, { appliedAt });
  return database;
}

async function openDatabase(): Promise<DatabaseSync> {
  const root = await mkdtemp(join(tmpdir(), "openbot-schema-parity-"));
  roots.push(root);
  const database = new DatabaseSync(join(root, "openbot.db"));
  connections.push(database);
  return database;
}

interface ColumnShape {
  readonly name: string;
  readonly type: string;
  readonly notNull: number;
  readonly default: string | null;
  readonly primaryKey: number;
}

interface IndexShape {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
  readonly columns: readonly { readonly name: string | null; readonly descending: number; readonly key: number }[];
}

interface ForeignKeyShape {
  readonly table: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
}

interface TableShape {
  readonly columns: readonly ColumnShape[];
  readonly indexes: readonly IndexShape[];
  readonly foreignKeys: readonly ForeignKeyShape[];
}

function readTableShapes(database: DatabaseSync): Record<string, TableShape> {
  const shapes: Record<string, TableShape> = {};
  for (const table of readTableNames(database)) {
    shapes[table] = {
      columns: query(database, `PRAGMA table_info(${quote(table)})`).map((row) => ({
        name: text(row, "name"),
        type: text(row, "type"),
        notNull: count(row, "notnull"),
        default: optionalText(row, "dflt_value"),
        primaryKey: count(row, "pk"),
      })),
      indexes: query(database, `PRAGMA index_list(${quote(table)})`)
        .map((row) => ({
          name: text(row, "name"),
          unique: count(row, "unique"),
          origin: text(row, "origin"),
          partial: count(row, "partial"),
          columns: query(database, `PRAGMA index_xinfo(${quote(text(row, "name"))})`).map((column) => ({
            name: optionalText(column, "name"),
            descending: count(column, "desc"),
            key: count(column, "key"),
          })),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      foreignKeys: query(database, `PRAGMA foreign_key_list(${quote(table)})`).map((row) => ({
        table: text(row, "table"),
        from: optionalText(row, "from"),
        to: optionalText(row, "to"),
        onUpdate: text(row, "on_update"),
        onDelete: text(row, "on_delete"),
      })),
    };
  }
  return shapes;
}

interface Declaration {
  readonly type: string;
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}

// The PRAGMAs above cannot express a partial index's WHERE clause or a CHECK
// constraint, so the declarations are compared too - normalized, because a
// migration that rewrites a table leaves SQLite's own rendering of the DDL
// behind rather than the text the schema was written with.
function readNormalizedDeclarations(database: DatabaseSync): readonly Declaration[] {
  return query(
    database,
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
     ORDER BY type, name`,
  ).map((row) => ({
    type: text(row, "type"),
    name: text(row, "name"),
    table: text(row, "tbl_name"),
    sql: normalizeSql(text(row, "sql")),
  }));
}

// SQLite stores a CREATE statement close to how it was written, so this text is
// as much a record of the author's formatting as of the schema. The two paths
// declare the same table from two different pieces of source - the latest schema
// and the migration that produced it - and a difference in spacing, punctuation
// or keyword case between them is not a difference any caller can observe. Only
// the case inside a string literal is data: a DEFAULT 'grok' is a value.
function normalizeSql(sql: string): string {
  const collapsed = sql
    .replaceAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1")
    .replaceAll(/\bIF NOT EXISTS\b/gi, "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),])\s*/g, "$1")
    .trim();

  return collapsed
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 === 0 ? part.toUpperCase() : part))
    .join("");
}

function readAppliedVersions(database: DatabaseSync): readonly number[] {
  return query(database, "SELECT version FROM schema_migrations ORDER BY version").map((row) => count(row, "version"));
}

// `schema_migrations` is excluded from the comparisons: the upgraded fixture has
// to create that table itself to reach the migration path, so its declaration is
// the fixture's rather than the product's. Its contents are asserted instead,
// which is the part `createLatestDatabase` writes without running anything.
function readTableNames(database: DatabaseSync): readonly string[] {
  return query(
    database,
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
     ORDER BY name`,
  ).map((row) => text(row, "name"));
}

function query(database: DatabaseSync, sql: string): readonly DynamicRecord[] {
  return database
    .prepare(sql)
    .all()
    .map((row) => {
      if (!isDynamicRecord(row)) throw new Error(`Unexpected row shape from: ${sql}`);
      return row;
    });
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function text(row: DynamicRecord, column: string): string {
  const value = row[column];
  if (!isString(value)) throw new Error(`Expected text in column ${column}.`);
  return value;
}

function optionalText(row: DynamicRecord, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (isString(value)) return value;
  if (isNumber(value)) return String(value);
  throw new Error(`Expected text or null in column ${column}.`);
}

function count(row: DynamicRecord, column: string): number {
  const value = row[column];
  if (!isNumber(value)) throw new Error(`Expected a number in column ${column}.`);
  return value;
}
