import { createFileRoute } from "@tanstack/solid-router";
import { parseHostedSiteUploadRequest } from "../../../server/hosted-site-contract";
import { readJsonObject } from "../../../server/json-body";
import {
  apiError,
  hostedSiteErrorResponse,
  json,
  requestHostedSiteService,
  requestUser,
  requireIdempotencyKey,
  requireSitePublishingEnabled,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/sites/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json({ sites: await requestHostedSiteService().list(user.id), limit: 10 });
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
      POST: async ({ request }) => {
        try {
          requireSitePublishingEnabled();
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const input = parseHostedSiteUploadRequest(await readJsonObject(request));
          return json(
            await requestHostedSiteService().createUpload(user.id, input, requireIdempotencyKey(request)),
            201,
          );
        } catch (error) {
          return hostedSiteErrorResponse(error);
        }
      },
    },
  },
});
