import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  requestAuthService,
  requestSourceIp,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/mobile-auth/ticket")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          return json(await requestAuthService().issueMobileAuthTicket(token, requestSourceIp(request)));
        } catch (error) {
          return authErrorResponse(error);
        }
      },
    },
  },
});
