import { describe, expect, it } from "vitest";
import { isSameOriginReportRequest } from "../src/server/hosted-site-report-request";

describe("hosted site report request", () => {
  it("accepts only same-origin form submissions", () => {
    expect(reportRequest("https://openbot.run", "same-origin")).toSatisfy(isSameOriginReportRequest);
    expect(reportRequest("https://attacker.example", "cross-site")).not.toSatisfy(isSameOriginReportRequest);
    expect(reportRequest("https://openbot.run", "cross-site")).not.toSatisfy(isSameOriginReportRequest);
    expect(reportRequest(null, null)).not.toSatisfy(isSameOriginReportRequest);
  });
});

function reportRequest(origin: string | null, fetchSite: string | null): Request {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (origin !== null) headers.set("Origin", origin);
  if (fetchSite !== null) headers.set("Sec-Fetch-Site", fetchSite);
  return new Request("https://openbot.run/v1/sites/reports", { method: "POST", headers });
}
