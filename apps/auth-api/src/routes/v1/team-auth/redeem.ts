import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  authErrorResponse,
  json,
  requestAuthService,
  requestSourceIp,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/team-auth/redeem")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as { ticket?: unknown; serverId?: unknown };
          if (typeof body.ticket !== "string" || typeof body.serverId !== "string") {
            return apiError(400, "invalid_team_ticket", "The team ticket is invalid.");
          }
          const user = await requestAuthService().redeemTeamAuthTicket(
            body.ticket,
            body.serverId,
            requestSourceIp(request),
          );
          return user
            ? json(user)
            : apiError(401, "invalid_team_ticket", "The team ticket is invalid or expired.");
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
