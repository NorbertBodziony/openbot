import { type AuthRetentionResult, pruneExpiredAuthData } from "./auth-data-retention";
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
    fetch: fetchHandler,
    async scheduled(controller: Pick<ScheduledController, "scheduledTime">, bindings: Pick<WorkerBindings, "DB">) {
      const result = await prune(bindings.DB, controller.scheduledTime);
      log(result);
    },
  } satisfies ExportedHandler<WorkerBindings>;
}

function logRetentionResult(result: AuthRetentionResult): void {
  console.info("Auth data retention completed.", result);
}
