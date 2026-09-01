import { createFileRoute } from "@tanstack/solid-router";
import { apiError, authErrorResponse, bearerToken, json, requestAuthService } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/mobile-auth/devices")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          return json({ devices: await requestAuthService().listMobileAuthDevices(token) });
        } catch (error) {
          return authErrorResponse(error);
        }
      },
    },
  },
});
