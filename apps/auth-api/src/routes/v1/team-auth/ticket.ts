import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  requestAuthService,
  requestSourceIp,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/team-auth/ticket")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const body = (await request.json()) as { serverId?: unknown };
          if (typeof body.serverId !== "string") {
            return apiError(400, "invalid_server_id", "The team server ID is invalid.");
          }
          return json(
            await requestAuthService().issueTeamAuthTicket(
              token,
              body.serverId,
              requestSourceIp(request),
            ),
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
