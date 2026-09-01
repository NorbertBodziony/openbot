import { describe, expect, it, vi } from "vitest";
import { enforceHostedSiteReportRateLimit } from "../src/server/hosted-site-request-policy";

describe("hosted site request policy", () => {
  it("uses the source IP as the report limiter key and rejects denied requests", async () => {
    const allowed = { limit: vi.fn(async () => ({ success: true })) };
    await expect(
      enforceHostedSiteReportRateLimit({ SITE_REPORT_RATE_LIMITER: allowed }, "203.0.113.7"),
    ).resolves.toBeUndefined();
    expect(allowed.limit).toHaveBeenCalledWith({ key: "ip:203.0.113.7" });

    const denied = { limit: vi.fn(async () => ({ success: false })) };
    await expect(
      enforceHostedSiteReportRateLimit({ SITE_REPORT_RATE_LIMITER: denied }, "203.0.113.8"),
    ).rejects.toMatchObject({ status: 429, code: "report_rate_limit" });
  });
});
