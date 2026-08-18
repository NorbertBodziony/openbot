import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/solid-router";
import { apiError, json, requestAuthService } from "../../server/request-auth";
import type { WorkerBindings } from "../../server/types";

export const Route = createFileRoute("/health/ready")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const bindings = env as unknown as WorkerBindings;
          await bindings.DB.prepare("SELECT 1 AS ready").first();
          if (!requestAuthService().configured) {
            return apiError(
              503,
              "email_delivery_not_configured",
              "Email sign-in delivery is not configured.",
            );
          }
          return json({ service: "openbot-auth-api", status: "ready" });
        } catch {
          return apiError(503, "service_not_ready", "The account service is not ready.");
        }
      },
    },
  },
});
