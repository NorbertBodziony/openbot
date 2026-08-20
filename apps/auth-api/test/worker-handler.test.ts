import { describe, expect, it } from "vitest";
import type { AuthRetentionResult } from "../src/server/auth-data-retention";
import { createWorkerHandler } from "../src/server/worker-handler";

describe("worker handler", () => {
  it("keeps the TanStack fetch handler unchanged", () => {
    const fetchHandler = () => new Response("ok");
    const handler = createWorkerHandler(fetchHandler);

    expect(handler.fetch).toBe(fetchHandler);
  });

  it("uses the scheduled time and logs only aggregate deletion counts", async () => {
    const database = fakeDatabase();
    const result: AuthRetentionResult = { challenges: 3, sessions: 2, rateLimits: 1, teamTickets: 4 };
    let receivedDatabase: D1Database | null = null;
    let receivedTime: number | null = null;
    let logged: AuthRetentionResult | null = null;
    const handler = createWorkerHandler(
      () => new Response("ok"),
      async (value, now) => {
        receivedDatabase = value;
        receivedTime = now;
        return result;
      },
      (value) => {
        logged = value;
      },
    );

    await handler.scheduled({ scheduledTime: 1_234 }, { DB: database });

    expect(receivedDatabase).toBe(database);
    expect(receivedTime).toBe(1_234);
    expect(logged).toEqual(result);
  });
});

function fakeDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("Unexpected prepare call.");
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
