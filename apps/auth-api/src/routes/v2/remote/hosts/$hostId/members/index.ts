import { createFileRoute } from "@tanstack/solid-router";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestUser,
} from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/members/")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json({ members: await requestRemoteControlPlane().listMembers(user.id, params.hostId) });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
