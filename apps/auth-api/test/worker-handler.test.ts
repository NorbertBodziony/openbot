import { describe, expect, it, vi } from "vitest";
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

  it("serves locally published sites from the Auth API R2 binding", async () => {
    const hostname = "example-project-page-long-name-23456789ab.openbot.site";
    const route = {
      version: 1,
      status: "active",
      siteId: "site-1",
      deploymentId: "deployment-1",
      expiresAt: Date.now() + 60_000,
      spaFallback: false,
      files: {
        "index.html": {
          key: "sites/site-1/deployments/deployment-1/index.html",
          size: 19,
          mimeType: "text/html",
        },
      },
    };
    const handler = createWorkerHandler(() => {
      throw new Error("The application handler must not serve local hosted sites.");
    });
    const bindings = {
      ...fakeBindings(),
      SITE_LOCAL_ORIGIN: "http://openbot.localhost:3100",
      SITES: fakeSiteBucket({
        [`routes/${hostname}.json`]: JSON.stringify(route),
        "sites/site-1/deployments/deployment-1/index.html": "<h1>Local site</h1>",
      }),
    };

    const response = await handler.fetch(
      new Request("http://example-project-page-long-name-23456789ab.openbot.localhost:3100/"),
      bindings,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>Local site</h1>");
    expect(response.headers.get("Content-Security-Policy")).toBe("worker-src 'none'");
  });

  it("protects email delivery work with waitUntil", async () => {
    let finishRequest: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    const fetchHandler = vi.fn(() => pendingResponse);
    let backgroundWork: Promise<unknown> | null = null;
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      backgroundWork = promise;
    });
    const handler = createWorkerHandler(fetchHandler);

    const responsePromise = handler.fetch(
      new Request("https://openbot.run/v1/auth/email/start", { method: "POST" }),
      fakeBindings(),
      { waitUntil },
    );

    await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledOnce());
    if (!backgroundWork) throw new Error("Expected waitUntil to receive the delivery promise.");
    finishRequest?.(Response.json({ challengeId: "challenge-1" }));
    await expect(responsePromise).resolves.toBeInstanceOf(Response);
    await expect(backgroundWork).resolves.toBeUndefined();
    expect(fetchHandler).toHaveBeenCalledOnce();
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

  it("delivers authorization events every minute and runs retention only at midnight UTC", async () => {
    let pruneCalls = 0;
    let deliveryCalls = 0;
    let logCalls = 0;
    const handler = createWorkerHandler(
      () => new Response("ok"),
      async () => {
        pruneCalls += 1;
        throw new Error("Retention must not run outside the daily window.");
      },
      () => {
        logCalls += 1;
      },
      async () => {
        deliveryCalls += 1;
      },
    );

    await handler.scheduled({ scheduledTime: Date.UTC(2026, 8, 1, 12, 34) }, { DB: fakeDatabase() });

    expect(deliveryCalls).toBe(1);
    expect(pruneCalls).toBe(0);
    expect(logCalls).toBe(0);
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

function fakeSiteBucket(objects: Record<string, string>): R2Bucket {
  const bucket: R2Bucket = {
    async head() {
      return null;
    },
    async get(key: string) {
      const value = objects[key];
      if (value === undefined) return null;
      const bytes = new TextEncoder().encode(value);
      const metadata = {
        key,
        version: "1",
        size: bytes.byteLength,
        etag: "etag",
        httpEtag: '"etag"',
        checksums: { toJSON: () => ({}) },
        uploaded: new Date(),
        storageClass: "Standard",
        customMetadata: {},
        httpMetadata: {},
        range: undefined,
        writeHttpMetadata() {},
      } satisfies R2Object;
      const body = new Response(bytes).body;
      if (!body) throw new Error("The test response body is missing.");
      return {
        ...metadata,
        body,
        bodyUsed: false,
        arrayBuffer: () => Promise.resolve(bytes.buffer),
        bytes: () => Promise.resolve(bytes),
        text: () => Promise.resolve(value),
        json: () => Promise.resolve(JSON.parse(value)),
        blob: () => Promise.resolve(new Blob([bytes])),
      } satisfies R2ObjectBody;
    },
    async put() {
      throw new Error("Unexpected put call.");
    },
    async createMultipartUpload() {
      throw new Error("Unexpected multipart upload call.");
    },
    resumeMultipartUpload() {
      throw new Error("Unexpected multipart resume call.");
    },
    async delete() {
      throw new Error("Unexpected delete call.");
    },
    async list() {
      throw new Error("Unexpected list call.");
    },
  };
  return bucket;
}
