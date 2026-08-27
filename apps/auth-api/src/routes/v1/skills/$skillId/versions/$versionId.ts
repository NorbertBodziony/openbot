import { createFileRoute } from "@tanstack/solid-router";
import { publicMarketplaceJson, requestSkillMarketplace, skillErrorResponse } from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId/versions/$versionId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          return publicMarketplaceJson(await requestSkillMarketplace().getVersion(params.skillId, params.versionId));
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
