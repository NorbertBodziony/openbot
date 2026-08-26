import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  marketplaceErrorResponse,
  requestAgentMarketplace,
  requestUser,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/$agentId/install")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const value = await request.json();
          if (!isDynamicRecord(value) || !isString(value.receiptId))
            return apiError(400, "invalid_receipt", "An install receipt is required.");
          await requestAgentMarketplace().recordInstall(params.agentId, user.id, value.receiptId);
          return json({ installed: true });
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
