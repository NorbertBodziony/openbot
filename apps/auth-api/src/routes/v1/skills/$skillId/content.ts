import { createFileRoute } from "@tanstack/solid-router";
import { apiError, requestSkillMarketplace, requestUser, skillErrorResponse } from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/content")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          if (!(await requestUser(request))) return apiError(401, "unauthorized", "Sign in is required.");
          const object = await requestSkillMarketplace().content(params.skillId);
          return new Response(object.body, {
            headers: { "Content-Type": "application/zip", "Cache-Control": "private, max-age=300" },
          });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
