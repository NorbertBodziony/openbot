import { createFileRoute } from "@tanstack/solid-router";
import { requestSkillMarketplace, skillErrorResponse } from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/icon")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const object = await requestSkillMarketplace().icon(params.skillId);
          return object
            ? new Response(object.body, {
                headers: {
                  "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
                  "Cache-Control": "public, max-age=3600",
                },
              })
            : new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
