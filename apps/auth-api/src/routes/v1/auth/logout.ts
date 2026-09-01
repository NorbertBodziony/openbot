import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  requestAuthService,
  requestRemoteControlPlane,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const service = requestAuthService();
          const user = await service.authenticate(token);
          if (!user) {
            return apiError(401, "unauthorized", "The session is invalid.");
          }
          await service.logout(token);
          await requestRemoteControlPlane().endUserSessions(user.id);
          return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          return authErrorResponse(error);
        }
      },
    },
  },
});
