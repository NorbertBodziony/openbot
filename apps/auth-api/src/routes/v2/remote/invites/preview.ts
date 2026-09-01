import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/invites/preview")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readJsonObject(request);
          if (!isString(body.token)) return apiError(400, "invalid_remote_request", "The invitation token is invalid.");
          return json(await requestRemoteControlPlane().previewInvite(body.token));
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
