import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../server/json-body";
import {
  apiError,
  enforceMarketplaceMutationRateLimit,
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
          await enforceMarketplaceMutationRateLimit("mutation", user.id);
          const value = await readJsonObject(request);
          if (!isDynamicRecord(value) || !isString(value.receiptId) || value.receiptId.length > 128)
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
