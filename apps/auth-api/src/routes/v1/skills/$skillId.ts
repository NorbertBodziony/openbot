import { createFileRoute } from "@tanstack/solid-router";
import { json, requestSkillMarketplace, skillErrorResponse } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/$skillId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          return json(await requestSkillMarketplace().get(params.skillId));
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
