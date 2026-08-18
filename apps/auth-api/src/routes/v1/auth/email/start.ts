import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  authErrorResponse,
  json,
  requestAuthService,
  requestSourceIp,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/auth/email/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { email?: unknown };
          if (typeof body.email !== "string") {
            return apiError(400, "invalid_email", "Enter a valid email address.");
          }
          return json(
            await requestAuthService().startEmailSignIn(body.email, requestSourceIp(request)),
          );
        } catch (error) {
          if (error instanceof SyntaxError) {
            return apiError(400, "invalid_json", "The request body is invalid.");
          }
          return authErrorResponse(error);
        }
      },
    },
  },
});
