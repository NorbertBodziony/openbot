import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  marketplaceErrorResponse,
  requestAgentMarketplace,
  requestUser,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/mine")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json(await requestAgentMarketplace().listMine(user.id));
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
