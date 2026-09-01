import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requestUser,
  requireIdempotencyKey,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/$siteId")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          await requestHostedSiteService().delete(user.id, params.siteId, requireIdempotencyKey(request));
          return json({ deleted: true });
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
