import { createFileRoute } from "@tanstack/solid-router";
import { apiError, authErrorResponse, bearerToken, requestAuthService } from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/mobile-auth/devices/$sessionId")({
  server: {
    handlers: {
      DELETE: async ({ request, params }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          await requestAuthService().revokeMobileAuthDevice(token, params.sessionId);
          return new Response(null, { status: 204 });
        } catch (error) {
          return authErrorResponse(error);
        }
      },
    },
  },
});
