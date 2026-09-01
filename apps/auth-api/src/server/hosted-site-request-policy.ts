import { HostedSiteInputError } from "./hosted-site-contract";
import type { WorkerBindings } from "./types";

export async function enforceHostedSiteReportRateLimit(
  bindings: Pick<WorkerBindings, "SITE_REPORT_RATE_LIMITER">,
  sourceIp: string,
): Promise<void> {
  const result = await bindings.SITE_REPORT_RATE_LIMITER.limit({ key: `ip:${sourceIp}` });
  if (!result.success) {
    throw new HostedSiteInputError(429, "report_rate_limit", "Too many reports were submitted. Try again later.");
  }
}
