import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../server/json-body";
import { apiError, authErrorResponse, json, requestAuthService, requestSourceIp } from "../../../server/request-auth";

export const Route = createFileRoute("/v1/mobile-auth/redeem")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readJsonObject(request);
          if (
            !isString(body.ticket) ||
            !isString(body.deviceId) ||
            !isString(body.deviceName) ||
            (body.platform !== "ios" && body.platform !== "android" && body.platform !== "unknown")
          ) {
            return apiError(400, "invalid_mobile_ticket", "The Mobile Connect code is invalid.");
          }
          const session = await requestAuthService().redeemMobileAuthTicket(
            body.ticket,
            { id: body.deviceId, name: body.deviceName, platform: body.platform },
            requestSourceIp(request),
          );
          return session
            ? json(session)
            : apiError(401, "invalid_mobile_ticket", "The Mobile Connect code is invalid or expired.");
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
