import { createFileRoute } from "@tanstack/solid-router";
import { json, requestSkillMarketplace, skillErrorResponse } from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/versions/$versionId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          return json(await requestSkillMarketplace().getVersion(params.skillId, params.versionId));
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
