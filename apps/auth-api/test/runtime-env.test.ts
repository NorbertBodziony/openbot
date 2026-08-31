import { describe, expect, it } from "vitest";
import { readLocalRuntimeVars } from "../src/server/runtime-env";

describe("local auth runtime variables", () => {
  it.each(["true", "1", "yes", "on"])("enables development codes for %s", (value) => {
    expect(readLocalRuntimeVars({ AUTH_EXPOSE_DEVELOPMENT_CODE: value })).toEqual({
      AUTH_EXPOSE_DEVELOPMENT_CODE: "true",
    });
  });

  it("normalizes local hosted-site launch flags", () => {
    expect(
      readLocalRuntimeVars({
        SITE_PUBLISH_ENABLED: "yes",
        SITE_COOKIE_ISOLATION_READY: "0",
      }),
    ).toEqual({
      SITE_PUBLISH_ENABLED: "true",
      SITE_COOKIE_ISOLATION_READY: "false",
    });
  });

  it("does not copy unrelated process variables", () => {
    expect(readLocalRuntimeVars({ OTHER_SECRET: "do-not-copy" })).toEqual({});
  });

  it("copies only explicit Cloudflare tunnel settings", () => {
    expect(
      readLocalRuntimeVars({
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_ZONE_ID: "zone",
        CLOUDFLARE_TUNNEL_DOMAIN: "openbot.run",
        CLOUDFLARE_API_TOKEN: "secret",
        OTHER_CLOUDFLARE_SECRET: "blocked",
      }),
    ).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_ZONE_ID: "zone",
      CLOUDFLARE_TUNNEL_DOMAIN: "openbot.run",
      CLOUDFLARE_API_TOKEN: "secret",
    });
  });
});
