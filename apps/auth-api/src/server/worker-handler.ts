import { type AuthRetentionResult, pruneExpiredAuthData } from "./auth-data-retention";
import { enforceMarketplaceIngress, MarketplaceRateLimitError } from "./marketplace-request-policy";
import { deliverPendingRemoteAuthEvents } from "./remote-control-plane";
import type { WorkerBindings } from "./types";

type WorkerFetch = (request: Request) => Response | Promise<Response>;
type AuthDataPruner = (database: D1Database, now: number) => Promise<AuthRetentionResult>;
type RetentionLogger = (result: AuthRetentionResult) => void;
type RemoteAuthEventDelivery = (
  bindings: Pick<WorkerBindings, "DB" | "REMOTE_AUTH_WEBHOOK_URL" | "REMOTE_AUTH_WEBHOOK_SECRET">,
  now: number,
) => Promise<void>;

export function createWorkerHandler(
  fetchHandler: WorkerFetch,
  prune: AuthDataPruner = pruneExpiredAuthData,
  log: RetentionLogger = logRetentionResult,
  deliverRemoteAuthEvents: RemoteAuthEventDelivery = deliverPendingRemoteAuthEvents,
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
      bindings: Pick<WorkerBindings, "DB" | "REMOTE_AUTH_WEBHOOK_URL" | "REMOTE_AUTH_WEBHOOK_SECRET">,
    ) {
      const [result] = await Promise.all([
        prune(bindings.DB, controller.scheduledTime),
        deliverRemoteAuthEvents(bindings, controller.scheduledTime),
      ]);
      log(result);
    },
  } satisfies ExportedHandler<WorkerBindings>;
}

function logRetentionResult(result: AuthRetentionResult): void {
  console.info("Auth data retention completed.", result);
}
