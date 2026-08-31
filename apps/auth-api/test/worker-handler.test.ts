import { describe, expect, it } from "vitest";
import type { AuthRetentionResult } from "../src/server/auth-data-retention";
import type { WorkerBindings } from "../src/server/types";
import { createWorkerHandler } from "../src/server/worker-handler";

describe("worker handler", () => {
  it("delegates non-marketplace requests to the TanStack handler", async () => {
    const fetchHandler = () => new Response("ok");
    const handler = createWorkerHandler(fetchHandler);

    const response = await handler.fetch(new Request("https://openbot.run/health/live"), fakeBindings());

    expect(await response.text()).toBe("ok");
  });

  it("returns a retryable 429 before marketplace requests reach the application", async () => {
    const fetchHandler = () => {
      throw new Error("The application handler must not run.");
    };
    const handler = createWorkerHandler(fetchHandler);
    const denied: RateLimit = { limit: async () => ({ success: false }) };

    const response = await handler.fetch(new Request("https://openbot.run/v1/skills/"), {
      MARKETPLACE_INGRESS_RATE_LIMITER: denied,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });
  });

  it("uses the scheduled time and logs only aggregate deletion counts", async () => {
    const database = fakeDatabase();
    const result: AuthRetentionResult = {
      challenges: 3,
      sessions: 2,
      rateLimits: 1,
      teamTickets: 4,
      remoteSessions: 5,
      remoteInvites: 6,
    };
    let receivedDatabase: D1Database | null = null;
    let receivedTime: number | null = null;
    let logged: AuthRetentionResult | null = null;
    let deliveredAt: number | null = null;
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
      async (_bindings, now) => {
        deliveredAt = now;
      },
    );

    await handler.scheduled({ scheduledTime: 1_234 }, { DB: database });

    expect(receivedDatabase).toBe(database);
    expect(receivedTime).toBe(1_234);
    expect(logged).toEqual(result);
    expect(deliveredAt).toBe(1_234);
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

function fakeBindings(): Pick<WorkerBindings, "MARKETPLACE_INGRESS_RATE_LIMITER"> {
  const limiter: RateLimit = { limit: async () => ({ success: true }) };
  return { MARKETPLACE_INGRESS_RATE_LIMITER: limiter };
}
