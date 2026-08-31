import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requestUser,
  requireIdempotencyKey,
  requireSitePublishingEnabled,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/uploads/$uploadId/activate")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          requireSitePublishingEnabled();
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json(
            await requestHostedSiteService().activate(user.id, params.uploadId, requireIdempotencyKey(request)),
          );
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
