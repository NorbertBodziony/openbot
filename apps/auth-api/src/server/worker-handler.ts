import { type AuthRetentionResult, pruneExpiredAuthData } from "./auth-data-retention";
import { HostedSiteService } from "./hosted-site-service";
import { enforceMarketplaceIngress, MarketplaceRateLimitError } from "./marketplace-request-policy";
import type { WorkerBindings } from "./types";

type WorkerFetch = (request: Request) => Response | Promise<Response>;
type AuthDataPruner = (database: D1Database, now: number) => Promise<AuthRetentionResult>;
type RetentionLogger = (result: AuthRetentionResult) => void;

export function createWorkerHandler(
  fetchHandler: WorkerFetch,
  prune: AuthDataPruner = pruneExpiredAuthData,
  log: RetentionLogger = logRetentionResult,
) {
  return {
    async fetch(
      request: Request,
      bindings: Pick<WorkerBindings, "MARKETPLACE_INGRESS_RATE_LIMITER">,
      _context?: ExecutionContext,
    ) {
      try {
        await enforceMarketplaceIngress(request, bindings);
      } catch (error) {
        if (error instanceof MarketplaceRateLimitError) {
          return Response.json(
            { error: { code: error.code, message: error.message } },
            {
              status: error.status,
              headers: {
                "Cache-Control": "no-store",
                "Retry-After": String(error.retryAfterSeconds),
                "X-Content-Type-Options": "nosniff",
              },
            },
          );
        }
        throw error;
      }
      return fetchHandler(request);
    },
    async scheduled(
      controller: Pick<ScheduledController, "scheduledTime">,
      bindings: Pick<WorkerBindings, "DB"> & Partial<Pick<WorkerBindings, "SITES">>,
    ) {
      const result = await prune(bindings.DB, controller.scheduledTime);
      log(result);
      if (bindings.SITES) {
        const sites = await new HostedSiteService(bindings.DB, bindings.SITES).cleanup(controller.scheduledTime);
        console.info("Hosted site cleanup completed.", sites);
      }
    },
  } satisfies ExportedHandler<WorkerBindings>;
}

function logRetentionResult(result: AuthRetentionResult): void {
  console.info("Auth data retention completed.", result);
}
