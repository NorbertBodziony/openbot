import { isString } from "@openbot/contracts/runtime-values";
import { createFileRoute } from "@tanstack/solid-router";
import { readJsonObject } from "../../../../server/json-body";
import {
  apiError,
  authErrorResponse,
  json,
  requestAuthService,
  requestSourceIp,
} from "../../../../server/request-auth";

export const Route = createFileRoute("/v1/auth/email/verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await readJsonObject(request);
          if (!isString(body.challengeId) || !isString(body.code)) {
            return apiError(400, "invalid_sign_in_code", "The sign-in code is invalid.");
          }
          return json(
            await requestAuthService().verifyEmailCode({
              challengeId: body.challengeId,
              code: body.code,
              sourceIp: requestSourceIp(request),
            }),
          );
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
