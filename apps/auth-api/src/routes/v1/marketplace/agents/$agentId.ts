import { createFileRoute } from "@tanstack/solid-router";
import {
  marketplaceErrorResponse,
  publicMarketplaceJson,
  requestAgentMarketplace,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/$agentId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          return publicMarketplaceJson(await requestAgentMarketplace().get(params.agentId));
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
