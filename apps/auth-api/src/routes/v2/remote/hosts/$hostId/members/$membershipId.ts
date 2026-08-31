import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../../server/json-body";
import {
  apiError,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestUser,
} from "../../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/members/$membershipId")({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          if (body.role !== "admin" && body.role !== "member")
            return apiError(400, "invalid_remote_request", "The member role is invalid.");
          await requestRemoteControlPlane().changeMembership(user.id, {
            hostId: params.hostId,
            membershipId: params.membershipId,
            role: body.role,
          });
          return new Response(null, { status: 204 });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
      DELETE: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          await requestRemoteControlPlane().changeMembership(user.id, {
            hostId: params.hostId,
            membershipId: params.membershipId,
            revoke: true,
          });
          return new Response(null, { status: 204 });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
