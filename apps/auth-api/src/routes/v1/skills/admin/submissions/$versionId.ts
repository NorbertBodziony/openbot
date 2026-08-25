import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  requestSkillMarketplace,
  requireSkillsAdmin,
  skillErrorResponse,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/admin/submissions/$versionId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          if (!requireSkillsAdmin(request)) return apiError(401, "unauthorized", "An admin token is required.");
          const value = await request.json();
          if (
            !isDynamicRecord(value) ||
            (value.action !== "approve" && value.action !== "reject") ||
            (value.note !== undefined && !isString(value.note))
          ) {
            return apiError(400, "invalid_review", "A valid review action is required.");
          }
          const note = value.note;
          await requestSkillMarketplace().review(params.versionId, value.action, note);
          return json({ reviewed: true });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
