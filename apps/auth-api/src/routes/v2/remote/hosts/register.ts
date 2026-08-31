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

export const Route = createFileRoute("/v2/remote/hosts/register")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          if (
            !isString(body.hostId) ||
            !isString(body.name) ||
            !isString(body.ownerMembershipId) ||
            !(body.devicePublicKey === undefined || body.devicePublicKey === null || isString(body.devicePublicKey))
          ) {
            return apiError(400, "invalid_remote_request", "The host registration is invalid.");
          }
          return json(
            await requestRemoteControlPlane().registerHost(user, {
              hostId: body.hostId,
              name: body.name,
              ownerMembershipId: body.ownerMembershipId,
              devicePublicKey: body.devicePublicKey,
            }),
            201,
          );
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
