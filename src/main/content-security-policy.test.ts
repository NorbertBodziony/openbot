import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it("allows the production analytics endpoint", () => {
    const policy = buildContentSecurityPolicy(true);

    expect(policy).toContain("connect-src 'self' https://analytics.openbot.run ws://127.0.0.1:* wss://*.openbot.run");
    expect(policy).not.toContain("localhost");
  });

  it("keeps local development sources", () => {
    const policy = buildContentSecurityPolicy(false);

    expect(policy).toContain("http://localhost:*");
    expect(policy).toContain("ws://localhost:*");
  });
});
