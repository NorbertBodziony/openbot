import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requestUser,
  requireSitePublishingEnabled,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/uploads/$uploadId/file")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        try {
          requireSitePublishingEnabled();
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const path = new URL(request.url).searchParams.get("path");
          if (!path) return apiError(400, "invalid_site", "A file path is required.");
          await requestHostedSiteService().uploadFile(user.id, params.uploadId, path, request);
          return json({ uploaded: true });
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
