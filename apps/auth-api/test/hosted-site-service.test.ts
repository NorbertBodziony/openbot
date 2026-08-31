import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedSiteUploadRequest } from "../src/server/hosted-site-contract";
import { HostedSiteService } from "../src/server/hosted-site-service";

const databases: DatabaseSync[] = [];
const HTML = "<h1>Hosted</h1>";
const NOW = Date.UTC(2026, 7, 31, 12);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("hosted site control plane", () => {
  it("keeps publication idempotent, enforces ownership, and replaces atomically", async () => {
    const fixture = serviceFixture();
    const firstUpload = await fixture.service.createUpload("alice", uploadRequest(), "publish-1");
    const repeated = await fixture.service.createUpload("alice", uploadRequest(), "publish-1");
    expect(repeated.uploadId).toBe(firstUpload.uploadId);

    await uploadIndex(fixture.service, "alice", firstUpload.uploadId);
    const first = await fixture.service.activate("alice", firstUpload.uploadId, "activate-1");
    const firstDeployment = firstUpload.uploadId;

    await expect(
      fixture.service.createUpload("bob", uploadRequest({ siteId: first.id }), "replace-by-bob"),
    ).rejects.toMatchObject({ code: "site_not_found" });

    fixture.setNow(NOW + 24 * 60 * 60_000);
    const replacement = await fixture.service.createUpload(
      "alice",
      uploadRequest({ siteId: first.id, title: "Updated hosted budget planner" }),
      "replace-1",
    );
    await uploadIndex(fixture.service, "alice", replacement.uploadId);
    fixture.database.failNextBatchContaining("UPDATE hosted_sites SET status = 'active'");
    await expect(fixture.service.activate("alice", replacement.uploadId, "activate-2")).rejects.toThrow(
      "Injected D1 failure",
    );

    const recovered = await fixture.service.activate("alice", replacement.uploadId, "activate-2");
    expect(recovered.hostname).toBe(first.hostname);
    expect(recovered.expiresAt).toBe(new Date(fixture.now() + 30 * 24 * 60 * 60_000).toISOString());
    expect(fixture.bucket.keys()).not.toContain(`sites/${first.id}/deployments/${firstDeployment}/index.html`);
  });

  it("allows only two concurrent upload sessions", async () => {
    const fixture = serviceFixture();
    const results = await Promise.allSettled(
      ["one", "two", "three"].map((key) =>
        fixture.service.createUpload("alice", uploadRequest({ title: `${key} hosted static project` }), key),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "upload_session_limit" } });
  });

  it("uses one atomic slot check for the ten-site limit", async () => {
    const fixture = serviceFixture();
    for (let index = 0; index < 10; index += 1) {
      await publish(fixture.service, "alice", `publish-${index}`, `activate-${index}`, {
        title: `Hosted planner number ${index}`,
      });
    }

    await expect(
      fixture.service.createUpload("alice", uploadRequest({ title: "Eleventh hosted planner" }), "publish-11"),
    ).rejects.toMatchObject({ code: "site_limit" });
  });
});

function serviceFixture(): {
  service: HostedSiteService;
  database: FakeD1Database;
  bucket: FakeR2Bucket;
  now: () => number;
  setNow: (value: number) => void;
} {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON; CREATE TABLE users(id TEXT PRIMARY KEY);");
  sqlite.exec(migration("0012_hosted_sites.sql"));
  sqlite.exec(migration("0013_hosted_site_hostname_reservations.sql"));
  sqlite.prepare("INSERT INTO users(id) VALUES (?), (?)").run("alice", "bob");
  const database = new FakeD1Database(sqlite);
  const bucket = new FakeR2Bucket();
  let currentTime = NOW;
  return {
    service: new HostedSiteService(database, bucket, () => currentTime),
    database,
    bucket,
    now: () => currentTime,
    setNow: (value) => {
      currentTime = value;
    },
  };
}

async function publish(
  service: HostedSiteService,
  userId: string,
  publishKey: string,
  activateKey: string,
  changes: Partial<HostedSiteUploadRequest> = {},
) {
  const session = await service.createUpload(userId, uploadRequest(changes), publishKey);
  await uploadIndex(service, userId, session.uploadId);
  return service.activate(userId, session.uploadId, activateKey);
}

function uploadRequest(changes: Partial<HostedSiteUploadRequest> = {}): HostedSiteUploadRequest {
  return {
    title: "Interactive student budget planner",
    description: "A small static tool for university students.",
    framework: "vanilla",
    spaFallback: false,
    siteId: null,
    files: [{ path: "index.html", size: new TextEncoder().encode(HTML).byteLength, mimeType: "text/html" }],
    ...changes,
  };
}

async function uploadIndex(service: HostedSiteService, userId: string, uploadId: string): Promise<void> {
  await service.uploadFile(
    userId,
    uploadId,
    "index.html",
    new Request("https://openbot.run/v1/sites/upload", {
      method: "PUT",
      headers: { "Content-Type": "text/html", "Content-Length": String(new TextEncoder().encode(HTML).byteLength) },
      body: HTML,
    }),
  );
}

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

class FakeD1Database implements D1Database {
  #failFragment: string | null = null;

  constructor(private readonly database: DatabaseSync) {}

  failNextBatchContaining(fragment: string): void {
    this.#failFragment = fragment;
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeD1Statement(this.database, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const owned = statements.map((statement) => {
      if (!(statement instanceof FakeD1Statement)) throw new Error("The test received an unknown D1 statement.");
      return statement;
    });
    if (this.#failFragment && owned.some((statement) => statement.query.includes(this.#failFragment ?? ""))) {
      this.#failFragment = null;
      throw new Error("Injected D1 failure");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = owned.map((statement) => statement.execute<T>());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.database.exec(query);
    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    throw new Error("D1 sessions are not used by this test.");
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error("D1 dumps are not used by this test.");
  }
}

class FakeD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly query: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FakeD1Statement(this.database, this.query, values.map(sqlValue));
  }

  async first<T = unknown>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...this.values);
    if (!row) return null;
    return genericValue<T>(columnName ? row[columnName] : row);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const rows = this.database.prepare(this.query).all(...this.values);
    return d1Result(rows.map(genericValue<T>), 0, 0);
  }

  execute<T>(): D1Result<T> {
    if (/^\s*(?:SELECT|PRAGMA)\b|\bRETURNING\b/iu.test(this.query)) {
      const rows = this.database.prepare(this.query).all(...this.values);
      const changes = Number(this.database.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
      return d1Result(rows.map(genericValue<T>), changes, 0);
    }
    const result = this.database.prepare(this.query).run(...this.values);
    return d1Result<T>([], Number(result.changes), Number(result.lastInsertRowid));
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  raw(): Promise<never> {
    throw new Error("Raw D1 results are not used by this test.");
  }
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === null || isString(value) || isNumber(value)) return value;
  throw new Error("The test received an unsupported D1 binding.");
}

function genericValue<T>(value: unknown): T {
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: This test adapter implements D1's generic decoding boundary.
  return value as T;
}

function d1Result<T>(results: T[], changes: number, lastRowId: number): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: lastRowId,
      changed_db: changes > 0,
      changes,
    },
  };
}

type Bytes = Uint8Array<ArrayBuffer>;

class FakeR2Bucket implements R2Bucket {
  private readonly objects = new Map<string, { bytes: Bytes; metadata?: R2HTTPMetadata }>();

  keys(): string[] {
    return [...this.objects.keys()];
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? new FakeR2Object(key, stored.bytes, stored.metadata) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    return stored ? new FakeR2Object(key, stored.bytes, stored.metadata) : null;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await bodyBytes(value);
    this.objects.set(key, { bytes, ...(options?.httpMetadata ? { metadata: metadata(options.httpMetadata) } : {}) });
    return new FakeR2Object(key, bytes, options?.httpMetadata ? metadata(options.httpMetadata) : undefined);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, stored]) => new FakeR2Object(key, stored.bytes, stored.metadata)),
      delimitedPrefixes: [],
      truncated: false,
    };
  }

  createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error("Multipart R2 uploads are not used by this test.");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("Multipart R2 uploads are not used by this test.");
  }
}

class FakeR2Object implements R2ObjectBody {
  readonly version = "test";
  readonly etag = "test";
  readonly httpEtag = '"test"';
  readonly checksums: R2Checksums = { toJSON: () => ({}) };
  readonly uploaded = new Date(NOW);
  readonly customMetadata = undefined;
  readonly range = undefined;
  readonly storageClass = "Standard";
  readonly ssecKeyMd5 = undefined;
  readonly bodyUsed = false;

  constructor(
    readonly key: string,
    private readonly content: Bytes,
    readonly httpMetadata?: R2HTTPMetadata,
  ) {}

  get size(): number {
    return this.content.byteLength;
  }

  get body(): ReadableStream<Uint8Array> {
    return new Blob([copyArrayBuffer(this.content)]).stream();
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.httpMetadata?.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return copyArrayBuffer(this.content);
  }

  async bytes(): Promise<Uint8Array> {
    return new Uint8Array(this.content);
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.content);
  }

  async json<T>(): Promise<T> {
    return genericValue<T>(JSON.parse(await this.text()));
  }

  async blob(): Promise<Blob> {
    return new Blob([copyArrayBuffer(this.content)]);
  }
}

async function bodyBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Bytes> {
  if (value === null) return new Uint8Array();
  if (isString(value)) return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy;
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function metadata(value: R2HTTPMetadata | Headers): R2HTTPMetadata {
  if (value instanceof Headers) return { contentType: value.get("Content-Type") ?? undefined };
  return value;
}
