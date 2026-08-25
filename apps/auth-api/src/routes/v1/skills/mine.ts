import { createFileRoute } from "@tanstack/solid-router";
import { apiError, json, requestSkillMarketplace, requestUser, skillErrorResponse } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/mine")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requestUser(request);
          return user
            ? json(await requestSkillMarketplace().mine(user.id))
            : apiError(401, "unauthorized", "Sign in is required.");
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
