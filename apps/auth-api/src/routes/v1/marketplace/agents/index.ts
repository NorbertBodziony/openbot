import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  marketplaceErrorResponse,
  requestAgentMarketplace,
  requestUser,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/marketplace/agents/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const sort = url.searchParams.get("sort") ?? undefined;
          if (sort && sort !== "installs") return apiError(400, "invalid_sort", "Unknown agent sort order.");
          return json(
            await requestAgentMarketplace().list({
              query: url.searchParams.get("query") ?? undefined,
              featured: url.searchParams.get("featured") === "true",
              sort: sort === "installs" ? sort : undefined,
              cursor: url.searchParams.get("cursor") ?? undefined,
              limit: Number(url.searchParams.get("limit") ?? 24),
            }),
          );
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const form = await request.formData();
          const snapshotText = form.get("snapshot");
          const avatar = form.get("avatar");
          const agentId = form.get("agentId");
          if (!isString(snapshotText)) return apiError(400, "invalid_submission", "An agent snapshot is required.");
          if (avatar !== null && !(avatar instanceof File))
            return apiError(400, "invalid_avatar", "The avatar is invalid.");
          return json(
            await requestAgentMarketplace().submit({
              user,
              snapshot: JSON.parse(snapshotText),
              avatar:
                avatar instanceof File
                  ? { bytes: new Uint8Array(await avatar.arrayBuffer()), mimeType: avatar.type }
                  : null,
              ...(isString(agentId) && agentId ? { agentId } : {}),
            }),
            201,
          );
        } catch (error) {
          return marketplaceErrorResponse(error);
        }
      },
    },
  },
});
