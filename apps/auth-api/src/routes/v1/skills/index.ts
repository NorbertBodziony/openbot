import { isSkillCategory } from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { apiError, json, requestSkillMarketplace, requestUser, skillErrorResponse } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/skills/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          const category = url.searchParams.get("category") ?? undefined;
          const sort = url.searchParams.get("sort") ?? undefined;
          if (category && !isSkillCategory(category))
            return apiError(400, "invalid_category", "Unknown skill category.");
          if (sort && sort !== "installs") return apiError(400, "invalid_sort", "Unknown skill sort order.");
          return json(
            await requestSkillMarketplace().list({
              query: url.searchParams.get("query") ?? undefined,
              category,
              featured: url.searchParams.get("featured") === "true",
              sort: sort === "installs" ? sort : undefined,
              cursor: url.searchParams.get("cursor") ?? undefined,
              limit: Number(url.searchParams.get("limit") ?? 24),
            }),
          );
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const form = await request.formData();
          const bundle = form.get("bundle");
          const icon = form.get("icon");
          const category = form.get("category");
          const skillId = form.get("skillId");
          if (!(bundle instanceof File) || !isString(category) || !isSkillCategory(category)) {
            return apiError(400, "invalid_submission", "A skill bundle and category are required.");
          }
          if (icon !== null && !(icon instanceof File)) return apiError(400, "invalid_icon", "The icon is invalid.");
          return json(
            await requestSkillMarketplace().submit({
              user,
              archive: new Uint8Array(await bundle.arrayBuffer()),
              category,
              icon:
                icon instanceof File ? { bytes: new Uint8Array(await icon.arrayBuffer()), mimeType: icon.type } : null,
              ...(isString(skillId) && skillId ? { skillId } : {}),
            }),
            201,
          );
        } catch (error) {
          return skillErrorResponse(error);
        }
      },
    },
  },
});
