import { isUuidV4 } from "@openbot/contracts/validation";
import { createFileRoute } from "@tanstack/solid-router";
import { avatarObjectKey } from "../../../server/avatar-storage";
import { requestAvatarBucket } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/avatars/$userId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const version = new URL(request.url).searchParams.get("v") ?? "";
        if (!isUuidV4(params.userId) || !isUuidV4(version)) {
          return new Response("Not found", { status: 404 });
        }
        const object = await requestAvatarBucket().get(avatarObjectKey(params.userId, version));
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
            ETag: object.httpEtag,
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
