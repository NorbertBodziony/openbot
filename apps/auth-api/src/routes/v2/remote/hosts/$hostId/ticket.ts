import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../../server/json-body";
import {
  apiError,
  json,
  remoteControlPlaneErrorResponse,
  requestRemoteControlPlane,
  requestRemoteSignalUrl,
} from "../../../../../server/request-auth";

export const Route = createFileRoute("/v2/remote/hosts/$hostId/ticket")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        try {
          const body = await readJsonObject(request);
          if (!isString(body.machineToken))
            return apiError(400, "invalid_remote_request", "The host credential is invalid.");
          return json({
            ...(await requestRemoteControlPlane().issueHostTicket(params.hostId, body.machineToken)),
            signalUrl: requestRemoteSignalUrl(),
          });
        } catch (error) {
          return remoteControlPlaneErrorResponse(error);
        }
      },
    },
  },
});
