import { createFileRoute } from "@tanstack/solid-router";
import { requestSkillMarketplace, skillErrorResponse } from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/versions/$versionId/content")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const object = await requestSkillMarketplace().versionContent(params.skillId, params.versionId);
          const headers = new Headers({
            "Cache-Control": "private, no-store",
            "Content-Type": "application/zip",
            "X-Content-Type-Options": "nosniff",
          });
          return new Response(object.body, { headers });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
