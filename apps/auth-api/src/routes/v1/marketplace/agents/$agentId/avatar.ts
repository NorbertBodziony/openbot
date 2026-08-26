import { createFileRoute } from "@tanstack/solid-router";
import { marketplaceErrorResponse, requestAgentMarketplace } from "../../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/$agentId/avatar")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        try {
          const object = await requestAgentMarketplace().avatar(params.agentId);
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
          headers.set("X-Content-Type-Options", "nosniff");
          return new Response(object.body, { headers });
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
