import { describe, expect, it } from "vitest";
import { D1AuthRepository } from "../src/server/d1-auth-repository";

const FIFTEEN_MINUTES_MS = 15 * 60_000;

interface TestMobileSessionUserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  last_used_at: number;
}

interface PreparedCall {
  query: string;
  values: unknown[];
}

describe("D1 auth sessions", () => {
  it("excludes registered mobile sessions from desktop authentication", async () => {
    const calls: PreparedCall[] = [];
    const repository = new D1AuthRepository(desktopAuthenticationDatabase(calls));

    await expect(repository.authenticateDesktopSession("desktop-token", 1_000)).resolves.toMatchObject({
      id: "user-1",
    });

    expect(calls[0]?.query).toContain("NOT EXISTS");
    expect(calls[0]?.query).toContain("mobile_auth_sessions.session_id = auth_sessions.id");
    expect(calls[0]?.values).toEqual([expect.any(String), 1_000]);
  });

  it("revokes only a session registered as mobile", async () => {
    const calls: PreparedCall[] = [];
    const repository = new D1AuthRepository(mobileRevocationDatabase(calls));

    await expect(repository.revokeMobileSession("mobile-token", 2_000)).resolves.toBe(true);

    expect(calls[0]?.query).toContain("id IN (SELECT session_id FROM mobile_auth_sessions)");
    expect(calls[0]?.values).toEqual([2_000, expect.any(String)]);
  });

  it.each([
    ["generic", (repository: D1AuthRepository, now: number) => repository.authenticate("session-token", now)],
    [
      "desktop",
      (repository: D1AuthRepository, now: number) => repository.authenticateDesktopSession("desktop-token", now),
    ],
    [
      "mobile",
      (repository: D1AuthRepository, now: number) => repository.authenticateMobileSession("mobile-token", now),
    ],
  ])("updates %s session activity only after the coarse activity window", async (_kind, authenticate) => {
    const updates: unknown[][] = [];
    const connectedAt = 1_000;
    const repository = new D1AuthRepository(activityDatabase(connectedAt, updates));

    await expect(authenticate(repository, connectedAt + FIFTEEN_MINUTES_MS - 1)).resolves.toMatchObject({
      id: "user-1",
    });
    expect(updates).toEqual([]);

    const now = connectedAt + FIFTEEN_MINUTES_MS;
    await expect(authenticate(repository, now)).resolves.toMatchObject({ id: "user-1" });
    expect(updates).toEqual([[now, expect.any(String), connectedAt]]);
  });

  it("atomically replaces outstanding mobile authentication tickets", async () => {
    const batches: PreparedCall[][] = [];
    const repository = new D1AuthRepository(ticketDatabase(batches));

    await repository.replaceMobileAuthTicket({
      ticketHash: "new-ticket-hash",
      userId: "user-1",
      serverId: "00000000-0000-4000-8000-000000000001",
      createdAt: 1_000,
      expiresAt: 121_000,
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.query).toContain("UPDATE team_auth_tickets SET consumed_at");
    expect(batches[0]?.[0]?.values).toEqual([1_000, "user-1", "00000000-0000-4000-8000-000000000001"]);
    expect(batches[0]?.[1]?.query).toContain("INSERT INTO team_auth_tickets");
    expect(batches[0]?.[1]?.values).toEqual([
      "new-ticket-hash",
      "user-1",
      "00000000-0000-4000-8000-000000000001",
      1_000,
      121_000,
    ]);
  });
});

function ticketDatabase(batches: PreparedCall[][]): D1Database {
  const pending: PreparedCall[] = [];
  return {
    prepare(query) {
      const call: PreparedCall = { query, values: [] };
      pending.push(call);
      return statement({ onBind: (values) => (call.values = values) });
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batches.push(pending.splice(0));
      return statements.map(() => d1Result<T>());
    },
    exec() {
      throw new Error("Unexpected exec call.");
    },
    withSession() {
      throw new Error("Unexpected withSession call.");
    },
    dump() {
      throw new Error("Unexpected dump call.");
    },
  };
}

function activityDatabase(lastUsedAt: number, updates: unknown[][]): D1Database {
  return {
    prepare(query) {
      if (query.includes("SELECT users.id")) {
        return statement({
          first: {
            id: "user-1",
            email: "person@example.com",
            name: null,
            avatar_url: null,
            last_used_at: lastUsedAt,
          },
        });
      }
      if (query.startsWith("UPDATE auth_sessions SET last_used_at")) {
        return statement({ onRun: (values) => updates.push(values) });
      }
      throw new Error(`Unexpected query: ${query}`);
    },
    batch() {
      throw new Error("Unexpected batch call.");
    },
    exec() {
      throw new Error("Unexpected exec call.");
    },
    withSession() {
      throw new Error("Unexpected withSession call.");
    },
    dump() {
      throw new Error("Unexpected dump call.");
    },
  };
}

function desktopAuthenticationDatabase(calls: PreparedCall[]): D1Database {
  return singleStatementDatabase(calls, {
    id: "user-1",
    email: "person@example.com",
    name: null,
    avatar_url: null,
    last_used_at: 1_000,
  });
}

function mobileRevocationDatabase(calls: PreparedCall[]): D1Database {
  return singleStatementDatabase(calls);
}

function singleStatementDatabase(calls: PreparedCall[], first?: unknown): D1Database {
  return {
    prepare(query) {
      const call: PreparedCall = { query, values: [] };
      calls.push(call);
      return statement({ first, onBind: (values) => (call.values = values) });
    },
    batch() {
      throw new Error("Unexpected batch call.");
    },
    exec() {
      throw new Error("Unexpected exec call.");
    },
    withSession() {
      throw new Error("Unexpected withSession call.");
    },
    dump() {
      throw new Error("Unexpected dump call.");
    },
  };
}

function statement(options: {
  first?: unknown;
  onBind?: (values: unknown[]) => void;
  onRun?: (values: unknown[]) => void;
}): D1PreparedStatement {
  let values: unknown[] = [];
  const prepared: D1PreparedStatement = {
    bind(...nextValues) {
      values = nextValues;
      options.onBind?.(values);
      return prepared;
    },
    async first<T = TestMobileSessionUserRow>(): Promise<T | null> {
      // biome-ignore lint/nursery/noUnsafeTypeAssertion: This test adapter owns the concrete row behind D1's generic return type.
      return options.first ? (options.first as T) : null;
    },
    async run<T = TestMobileSessionUserRow>(): Promise<D1Result<T>> {
      options.onRun?.(values);
      return d1Result<T>();
    },
    async all<T = TestMobileSessionUserRow>(): Promise<D1Result<T>> {
      return d1Result<T>();
    },
    async raw(): Promise<never> {
      throw new Error("Unexpected raw call.");
    },
  };
  return prepared;
}

function d1Result<T>(): D1Result<T> {
  return {
    success: true,
    results: [],
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 1,
    },
  };
}
