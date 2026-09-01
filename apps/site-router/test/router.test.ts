import { describe, expect, it } from "vitest";
import { routeRequest } from "../src/index";

const activeRoute = {
  version: 1,
  status: "active",
  siteId: "site-1",
  deploymentId: "deployment-1",
  expiresAt: 2_000,
  spaFallback: false,
  files: {
    "index.html": {
      key: "sites/site-1/deployments/deployment-1/index.html",
      size: 13,
      mimeType: "text/html",
    },
    "app.js": {
      key: "sites/site-1/deployments/deployment-1/app.js",
      size: 17,
      mimeType: "text/javascript",
    },
  },
};

describe("site router", () => {
  it("serves an active HTML file without cookies or caching", async () => {
    const bucket = fakeBucket({
      "routes/example-project-page-long-name-23456789ab.openbot.site.json": JSON.stringify(activeRoute),
      "sites/site-1/deployments/deployment-1/index.html": "Hello, world!",
    });
    const response = await routeRequest(
      new Request("https://example-project-page-long-name-23456789ab.openbot.site/", {
        headers: { Cookie: "unsafe=true" },
      }),
      { SITES: bucket, SITE_SERVE_ENABLED: "true" },
      1_000,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, world!");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns 410 for expired and deleted routes", async () => {
    const expired = fakeBucket({
      "routes/example-project-page-long-name-23456789ab.openbot.site.json": JSON.stringify(activeRoute),
    });
    const expiredResponse = await routeRequest(
      new Request("https://example-project-page-long-name-23456789ab.openbot.site/"),
      { SITES: expired, SITE_SERVE_ENABLED: "true" },
      3_000,
    );
    expect(expiredResponse.status).toBe(410);
    expect(expiredResponse.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("fails closed when a block marker exists before the route is updated", async () => {
    const hostname = "example-project-page-long-name-23456789ab.openbot.site";
    const bucket = fakeBucket({
      [`blocks/${hostname}`]: "blocked",
      [`routes/${hostname}.json`]: JSON.stringify(activeRoute),
      "sites/site-1/deployments/deployment-1/index.html": "Hello, world!",
    });
    const response = await routeRequest(
      new Request(`https://${hostname}/`),
      { SITES: bucket, SITE_SERVE_ENABLED: "true" },
      1_000,
    );
    expect(response.status).toBe(451);
    expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
  });

  it("keeps unknown hostnames separate from tombstones", async () => {
    const response = await routeRequest(
      new Request("https://unknown-project-page-long-name-23456789ab.openbot.site/"),
      { SITES: fakeBucket({}), SITE_SERVE_ENABLED: "true" },
      1_000,
    );
    expect(response.status).toBe(404);
  });

  it("disables serving by default and revalidates mutable asset URLs", async () => {
    const hostname = "example-project-page-long-name-23456789ab.openbot.site";
    const bucket = fakeBucket({
      [`routes/${hostname}.json`]: JSON.stringify(activeRoute),
      "sites/site-1/deployments/deployment-1/app.js": "console.log('ok')",
    });
    const disabled = await routeRequest(new Request(`https://${hostname}/app.js`), { SITES: bucket }, 1_000);
    expect(disabled.status).toBe(503);

    const response = await routeRequest(
      new Request(`https://${hostname}/app.js`),
      { SITES: bucket, SITE_SERVE_ENABLED: "true" },
      1_000,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, no-cache");
    expect(response.headers.get("ETag")).toBe('"etag"');

    const revalidated = await routeRequest(
      new Request(`https://${hostname}/app.js`, { headers: { "If-None-Match": '"etag"' } }),
      { SITES: bucket, SITE_SERVE_ENABLED: "true" },
      1_000,
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("ETag")).toBe('"etag"');
    expect(await revalidated.text()).toBe("");
  });

  it("rejects writes and traversal paths", async () => {
    const env = { SITES: fakeBucket({}), SITE_SERVE_ENABLED: "true" };
    expect(
      (
        await routeRequest(
          new Request("https://example-project-page-long-name-23456789ab.openbot.site/", { method: "POST" }),
          env,
          1_000,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await routeRequest(
          new Request("https://example-project-page-long-name-23456789ab.openbot.site/%2e%2e/secret"),
          env,
          1_000,
        )
      ).status,
    ).toBe(404);
  });
});

function fakeBucket(objects: Record<string, string>) {
  return {
    async get(key: string, options?: R2GetOptions) {
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
      const onlyIf = options?.onlyIf;
      if (
        onlyIf instanceof Headers &&
        onlyIf
          .get("If-None-Match")
          ?.split(",")
          .some((etag) => etag.trim() === '"etag"')
      ) {
        return metadata;
      }
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
  };
}
