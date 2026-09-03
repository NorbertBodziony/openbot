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
  readonly sql: readonly string[];
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
    sql: tokenizeSql(text(row, "sql")),
  }));
}

// SQLite stores a CREATE statement close to how it was written, so this text is
// as much a record of the author's formatting as of the schema. The two paths
// declare the same table from two different pieces of source - the latest schema
// and the migration that produced it - so comparing the text would go red on a
// space before a comma, `TEXT` against `text`, `x > 0` against `x>0` or a comment
// only one side carries, none of which any caller can observe. Comparing the
// token sequence instead drops formatting entirely and keeps what a caller can
// observe: the identifiers, keywords, operators and literals, in order.
//
// A string literal keeps its case, because a DEFAULT 'grok' is data rather than
// syntax, and IF NOT EXISTS is dropped because only one path writes it.
function tokenizeSql(sql: string): readonly string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const character = sql[index] ?? "";

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (character === "'") {
      const end = closingQuote(sql, index, "'");
      tokens.push(sql.slice(index, end));
      index = end;
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      const end = closingQuote(sql, index, closing);
      tokens.push(sql.slice(index + 1, end - 1).toUpperCase());
      index = end;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (word) {
      tokens.push(word[0].toUpperCase());
      index += word[0].length;
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(sql.slice(index));
    if (number) {
      tokens.push(number[0]);
      index += number[0].length;
      continue;
    }
    const operator = TWO_CHARACTER_OPERATORS.find((candidate) => sql.startsWith(candidate, index));
    tokens.push(operator ?? character);
    index += operator?.length ?? 1;
  }

  return withoutIfNotExists(tokens);
}

const TWO_CHARACTER_OPERATORS = ["<=", ">=", "<>", "!=", "==", "||", "<<", ">>"];

const IF_NOT_EXISTS = ["IF", "NOT", "EXISTS"];

function withoutIfNotExists(tokens: readonly string[]): readonly string[] {
  const kept: string[] = [];
  for (const token of tokens) {
    kept.push(token);
    if (kept.slice(-IF_NOT_EXISTS.length).join(" ") === IF_NOT_EXISTS.join(" ")) kept.length -= IF_NOT_EXISTS.length;
  }
  return kept;
}

// A quoted run ends at its closing delimiter, which a doubled delimiter escapes.
// Returns the offset just past it.
function closingQuote(sql: string, start: number, closing: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === closing) {
      if (sql[index + 1] !== closing) return index + 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return sql.length;
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
