import { routeRequest as routeHostedSiteRequest } from "../../../site-router/src/index";
import { type AuthRetentionResult, pruneExpiredAuthData } from "./auth-data-retention";
import { HostedSiteService } from "./hosted-site-service";
import { enforceMarketplaceIngress, MarketplaceRateLimitError } from "./marketplace-request-policy";
import { deliverPendingRemoteAuthEvents } from "./remote-control-plane";
import type { WorkerBindings } from "./types";

type WorkerFetch = (request: Request) => Response | Promise<Response>;
type AuthDataPruner = (database: D1Database, now: number) => Promise<AuthRetentionResult>;
type RetentionLogger = (result: AuthRetentionResult) => void;
type WorkerExecutionContext = Pick<ExecutionContext, "waitUntil">;
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
      bindings: Pick<WorkerBindings, "MARKETPLACE_INGRESS_RATE_LIMITER"> &
        Partial<Pick<WorkerBindings, "SITES" | "SITE_LOCAL_ORIGIN">>,
      context?: WorkerExecutionContext,
    ) {
      const localSiteResponse = await serveLocalHostedSite(request, bindings);
      if (localSiteResponse) return localSiteResponse;
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
      const response = Promise.resolve(fetchHandler(request));
      if (context && isEmailSignInStart(request)) {
        context.waitUntil(
          response.then(
            () => undefined,
            () => undefined,
          ),
        );
      }
      return response;
    },
    async scheduled(
      controller: Pick<ScheduledController, "scheduledTime">,
      bindings: Pick<WorkerBindings, "DB" | "REMOTE_AUTH_WEBHOOK_URL" | "REMOTE_AUTH_WEBHOOK_SECRET"> &
        Partial<Pick<WorkerBindings, "SITES">>,
    ) {
      const delivery = deliverRemoteAuthEvents(bindings, controller.scheduledTime);
      const cleanup = bindings.SITES
        ? new HostedSiteService(bindings.DB, bindings.SITES).cleanup(controller.scheduledTime)
        : Promise.resolve(null);
      if (!isDailyRetentionRun(controller.scheduledTime)) {
        const [, sites] = await Promise.all([delivery, cleanup]);
        if (sites) console.info("Hosted site cleanup completed.", sites);
        return;
      }
      const [result, , sites] = await Promise.all([prune(bindings.DB, controller.scheduledTime), delivery, cleanup]);
      log(result);
      if (sites) console.info("Hosted site cleanup completed.", sites);
    },
  } satisfies ExportedHandler<WorkerBindings>;
}

async function serveLocalHostedSite(
  request: Request,
  bindings: Partial<Pick<WorkerBindings, "SITES" | "SITE_LOCAL_ORIGIN">>,
): Promise<Response | null> {
  if (!bindings.SITES || !bindings.SITE_LOCAL_ORIGIN) return null;
  const requestUrl = new URL(request.url);
  const configuredOrigin = new URL(bindings.SITE_LOCAL_ORIGIN);
  const suffix = `.${configuredOrigin.hostname}`;
  if (
    requestUrl.protocol !== configuredOrigin.protocol ||
    requestUrl.port !== configuredOrigin.port ||
    !requestUrl.hostname.endsWith(suffix)
  ) {
    return null;
  }
  const label = requestUrl.hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return null;
  const hostedUrl = new URL(requestUrl);
  hostedUrl.protocol = "https:";
  hostedUrl.hostname = `${label}.openbot.site`;
  hostedUrl.port = "";
  return routeHostedSiteRequest(
    new Request(hostedUrl, request),
    { SITES: bindings.SITES, SITE_SERVE_ENABLED: "true" },
    Date.now(),
  );
}

function isEmailSignInStart(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === "/v1/auth/email/start";
}

function isDailyRetentionRun(scheduledTime: number): boolean {
  const scheduled = new Date(scheduledTime);
  return scheduled.getUTCHours() === 0 && scheduled.getUTCMinutes() === 0;
}

function logRetentionResult(result: AuthRetentionResult): void {
  console.info("Auth data retention completed.", result);
}
