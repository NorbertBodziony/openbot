import type { WorkerBindings } from "./types";

const RETRY_AFTER_SECONDS = 60;

export type MarketplaceMutationKind = "mutation" | "upload";

export class MarketplaceRateLimitError extends Error {
  readonly status = 429;
  readonly code = "rate_limited";
  readonly retryAfterSeconds = RETRY_AFTER_SECONDS;

  constructor() {
    super("Too many marketplace requests. Try again later.");
  }
}

export async function enforceMarketplaceIngress(
  request: Request,
  bindings: Pick<WorkerBindings, "MARKETPLACE_INGRESS_RATE_LIMITER">,
): Promise<void> {
  if (!isMarketplacePath(new URL(request.url).pathname)) return;
  const sourceIp =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  const result = await bindings.MARKETPLACE_INGRESS_RATE_LIMITER.limit({ key: `ip:${sourceIp}` });
  if (!result.success) throw new MarketplaceRateLimitError();
}

export async function enforceMarketplaceMutation(
  bindings: Pick<WorkerBindings, "MARKETPLACE_MUTATION_RATE_LIMITER" | "MARKETPLACE_UPLOAD_RATE_LIMITER">,
  kind: MarketplaceMutationKind,
  principal: string,
): Promise<void> {
  const limiter =
    kind === "upload" ? bindings.MARKETPLACE_UPLOAD_RATE_LIMITER : bindings.MARKETPLACE_MUTATION_RATE_LIMITER;
  const result = await limiter.limit({ key: `${kind}:${principal}` });
  if (!result.success) throw new MarketplaceRateLimitError();
}

function isMarketplacePath(pathname: string): boolean {
  return (
    pathname === "/v1/skills" || pathname.startsWith("/v1/skills/") || pathname.startsWith("/v1/marketplace/agents")
  );
}
