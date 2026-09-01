import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requireOperationsAdmin,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/admin/$siteId/block")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!(await requireOperationsAdmin(request))) return apiError(401, "unauthorized", "Admin access is required.");
        try {
          await requestHostedSiteService().setBlocked(params.siteId, true);
          return json({ blocked: true });
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
      DELETE: async ({ request, params }) => {
        if (!(await requireOperationsAdmin(request))) return apiError(401, "unauthorized", "Admin access is required.");
        try {
          await requestHostedSiteService().setBlocked(params.siteId, false);
          return json({ blocked: false });
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
