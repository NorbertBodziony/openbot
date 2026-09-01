import { isNumber, isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../server/json-body";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestUser,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/invites")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          return json({ invites: await requestRemoteControlPlane().listInvites(user.id, params.hostId) });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
      POST: async ({ request, params }) => {
        try {
          const user = await requestUser(request);
          if (!user) return apiError(401, "unauthorized", "Sign in is required.");
          const body = await readJsonObject(request);
          if (
            (body.role !== "admin" && body.role !== "member") ||
            !(body.email === undefined || body.email === null || isString(body.email)) ||
            !(body.expiresInSeconds === undefined || isNumber(body.expiresInSeconds))
          ) {
            return apiError(400, "invalid_remote_request", "The invitation is invalid.");
          }
          return json(
            await requestRemoteControlPlane().createInvite(user, {
              hostId: params.hostId,
              role: body.role,
              email: body.email,
              expiresInSeconds: body.expiresInSeconds,
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
