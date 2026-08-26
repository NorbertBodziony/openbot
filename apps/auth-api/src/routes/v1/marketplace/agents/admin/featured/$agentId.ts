import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  marketplaceErrorResponse,
  requestAgentMarketplace,
  requireSkillsAdmin,
} from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/admin/featured/$agentId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        if (!requireSkillsAdmin(request)) return apiError(401, "unauthorized", "Admin access is required.");
        try {
          const value = await request.json();
          if (!isDynamicRecord(value) || !isBoolean(value.featured))
            return apiError(400, "invalid_featured", "A featured state is required.");
          await requestAgentMarketplace().setFeatured(params.agentId, value.featured);
          return json({ updated: true });
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
