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

  it("copies only explicit Remote control-plane settings", () => {
    expect(
      readLocalRuntimeVars({
        REMOTE_TICKET_PRIVATE_JWK: "private",
        REMOTE_TICKET_PUBLIC_JWKS: "public",
        REMOTE_TICKET_KEY_ID: "key-1",
        REMOTE_SIGNAL_URL: "ws://127.0.0.1:8081/v1/signal",
        REMOTE_AUTH_WEBHOOK_URL: "http://127.0.0.1:8081/internal/auth-events",
        REMOTE_AUTH_WEBHOOK_SECRET: "secret",
        OTHER_CLOUDFLARE_SECRET: "blocked",
      }),
    ).toEqual({
      REMOTE_TICKET_PRIVATE_JWK: "private",
      REMOTE_TICKET_PUBLIC_JWKS: "public",
      REMOTE_TICKET_KEY_ID: "key-1",
      REMOTE_SIGNAL_URL: "ws://127.0.0.1:8081/v1/signal",
      REMOTE_AUTH_WEBHOOK_URL: "http://127.0.0.1:8081/internal/auth-events",
      REMOTE_AUTH_WEBHOOK_SECRET: "secret",
    });
  });
});
