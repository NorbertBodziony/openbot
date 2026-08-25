import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  requestSkillMarketplace,
  requestUser,
  skillErrorResponse,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/install")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const value = await request.json();
          if (!isDynamicRecord(value) || !isString(value.receiptId) || value.receiptId.length > 128) {
            return apiError(400, "invalid_receipt", "A valid install receipt is required.");
          }
          await requestSkillMarketplace().recordInstall(params.skillId, user.id, value.receiptId);
          return json({ installed: true });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
