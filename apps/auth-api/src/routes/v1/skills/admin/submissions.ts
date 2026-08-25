import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  requestSkillMarketplace,
  requireSkillsAdmin,
  skillErrorResponse,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/admin/submissions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return requireSkillsAdmin(request)
            ? json(await requestSkillMarketplace().pending())
            : apiError(401, "unauthorized", "An admin token is required.");
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
