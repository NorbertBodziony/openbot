import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestRemoteSignalUrl,
  requestUser,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/sessions/$sessionId/ticket")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json({
            ...(await requestRemoteControlPlane().issueSessionTicket(user.id, params.sessionId)),
            signalUrl: requestRemoteSignalUrl(),
          });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
