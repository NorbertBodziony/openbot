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

describe("D1 mobile session activity", () => {
  it("updates last activity only after the coarse activity window", async () => {
    const updates: unknown[][] = [];
    const connectedAt = 1_000;
    const repository = new D1AuthRepository(activityDatabase(connectedAt, updates));

    await expect(
      repository.authenticateMobileSession("mobile-token", connectedAt + FIFTEEN_MINUTES_MS - 1),
    ).resolves.toMatchObject({ id: "user-1" });
    expect(updates).toEqual([]);

    const now = connectedAt + FIFTEEN_MINUTES_MS;
    await expect(repository.authenticateMobileSession("mobile-token", now)).resolves.toMatchObject({ id: "user-1" });
    expect(updates).toEqual([[now, expect.any(String), connectedAt]]);
  });
});

function activityDatabase(lastUsedAt: number, updates: unknown[][]): D1Database {
  return {
    prepare(query) {
      if (query.includes("JOIN mobile_auth_sessions")) {
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

function statement(options: {
  first?: TestMobileSessionUserRow;
  onRun?: (values: unknown[]) => void;
}): D1PreparedStatement {
  let values: unknown[] = [];
  const prepared: D1PreparedStatement = {
    bind(...nextValues) {
      values = nextValues;
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
