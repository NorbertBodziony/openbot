import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestUser,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/invites/accept")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          if (!isString(body.token)) return apiError(400, "invalid_remote_request", "The invitation token is invalid.");
          return json(await requestRemoteControlPlane().acceptInvite(user, body.token));
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
