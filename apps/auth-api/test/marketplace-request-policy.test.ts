import { describe, expect, it, vi } from "vitest";
import {
  enforceMarketplaceIngress,
  enforceMarketplaceMutation,
  MarketplaceRateLimitError,
} from "../src/server/marketplace-request-policy";

describe("marketplace request rate limits", () => {
  it("limits marketplace ingress by source IP and ignores unrelated routes", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const limiter: RateLimit = { limit };
    const bindings = { MARKETPLACE_INGRESS_RATE_LIMITER: limiter };

    await enforceMarketplaceIngress(
      new Request("https://api.openbot.run/v1/skills/?query=test", {
        headers: { "CF-Connecting-IP": "203.0.113.8" },
      }),
      bindings,
    );
    await enforceMarketplaceIngress(new Request("https://api.openbot.run/v1/me"), bindings);

    expect(limit).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith({ key: "ip:203.0.113.8" });
  });

  it("rejects exhausted ingress and mutation limits", async () => {
    const denied: RateLimit = { limit: async () => ({ success: false }) };

    await expect(
      enforceMarketplaceIngress(new Request("https://api.openbot.run/v1/marketplace/agents/"), {
        MARKETPLACE_INGRESS_RATE_LIMITER: denied,
      }),
    ).rejects.toBeInstanceOf(MarketplaceRateLimitError);
    await expect(
      enforceMarketplaceMutation(
        { MARKETPLACE_MUTATION_RATE_LIMITER: denied, MARKETPLACE_UPLOAD_RATE_LIMITER: denied },
        "upload",
        "user-1",
      ),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
  });
});
