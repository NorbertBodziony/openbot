import { createFileRoute } from "@tanstack/solid-router";
import { publicMarketplaceJson, requestSkillMarketplace, skillErrorResponse } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          return publicMarketplaceJson(await requestSkillMarketplace().get(params.skillId));
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
