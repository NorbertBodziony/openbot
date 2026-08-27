import { createFileRoute } from "@tanstack/solid-router";
import { requestSkillMarketplace, skillErrorResponse } from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/versions/$versionId/content")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const object = await requestSkillMarketplace().versionContent(params.skillId, params.versionId);
          const headers = new Headers({
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Type": "application/zip",
            "X-Content-Type-Options": "nosniff",
          });
          headers.set("ETag", object.httpEtag);
          return new Response(object.body, { headers });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
