import { isDynamicRecord, isOneOf, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../../server/json-body";
import {
  apiError,
  enforceMarketplaceMutationRateLimit,
  json,
  marketplaceErrorResponse,
  requestAgentMarketplace,
  requireSkillsAdmin,
} from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/admin/submissions/$versionId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        if (!requireSkillsAdmin(request)) return apiError(401, "unauthorized", "Admin access is required.");
        try {
          await enforceMarketplaceMutationRateLimit("mutation", "marketplace-admin");
          const value = await readJsonObject(request);
          if (!isDynamicRecord(value) || !isOneOf(["approved", "rejected"], value.status))
            return apiError(400, "invalid_review", "An approval or rejection is required.");
          const note = isString(value.note) && value.note.trim() ? value.note.trim() : null;
          if (value.status === "rejected" && !note)
            return apiError(400, "invalid_review", "A rejection note is required.");
          await requestAgentMarketplace().review(params.versionId, value.status, note);
          return json({ reviewed: true });
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
