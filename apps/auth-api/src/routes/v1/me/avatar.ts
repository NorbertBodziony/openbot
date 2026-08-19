import { createFileRoute } from "@tanstack/solid-router";
import {
  AvatarUploadError,
  avatarObjectKey,
  avatarVersion,
  readAvatarUpload,
} from "../../../server/avatar-storage";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  requestAuthService,
  requestAvatarBucket,
} from "../../../server/request-auth";
import type { AuthUser } from "../../../server/types";

export const Route = createFileRoute("/v1/me/avatar")({
  server: {
    handlers: {
      PUT: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const service = requestAuthService();
          const user = await service.authenticate(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          const upload = await readAvatarUpload(request);
          const version = crypto.randomUUID();
          const bucket = requestAvatarBucket();
          const key = avatarObjectKey(user.id, version);
          await bucket.put(key, upload.bytes, {
            httpMetadata: {
              contentType: upload.mimeType,
              cacheControl: "public, max-age=31536000, immutable",
            },
          });
          const avatarUrl = `/v1/avatars/${encodeURIComponent(user.id)}?v=${version}`;
          let updated: AuthUser;
          try {
            updated = await service.updateAvatar(token, avatarUrl, user.avatarUrl);
          } catch (error) {
            await bucket.delete(key);
            throw error;
          }
          const previousVersion = avatarVersion(user.avatarUrl, user.id);
          if (previousVersion) {
            await bucket.delete(avatarObjectKey(user.id, previousVersion)).catch(() => undefined);
          }
          return json(updated);
        } catch (error) {
          if (error instanceof AvatarUploadError) {
            return apiError(error.status, error.code, error.message);
          }
          return authErrorResponse(error);
        }
      },
      DELETE: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const service = requestAuthService();
          const user = await service.authenticate(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          const updated = await service.updateAvatar(token, null, user.avatarUrl);
          const previousVersion = avatarVersion(user.avatarUrl, user.id);
          if (previousVersion) {
            await requestAvatarBucket()
              .delete(avatarObjectKey(user.id, previousVersion))
              .catch(() => undefined);
          }
          return json(updated);
        } catch (error) {
          return authErrorResponse(error);
        }
      },
    },
  },
});
