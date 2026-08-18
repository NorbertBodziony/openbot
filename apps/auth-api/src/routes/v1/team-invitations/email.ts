import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { createFileRoute } from "@tanstack/solid-router";
import { normalizeEmail } from "../../../server/auth-service";
import { readJsonObject } from "../../../server/json-body";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  requestAuthService,
  requestSourceIp,
  requestTeamInviteEmailDelivery,
} from "../../../server/request-auth";

export const Route = createFileRoute("/v1/team-invitations/email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const auth = requestAuthService();
          const user = await auth.authenticate(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          const body = await readJsonObject(request);
          if (
            typeof body.email !== "string" ||
            typeof body.serverName !== "string" ||
            typeof body.inviteUrl !== "string" ||
            (body.role !== "admin" && body.role !== "member")
          ) {
            return apiError(400, "invalid_invitation", "The invitation details are invalid.");
          }
          const email = normalizeEmail(body.email);
          if (
            body.serverName.trim().length < 2 ||
            body.serverName.trim().length > INPUT_LIMITS.serverName ||
            /[\r\n]/u.test(body.serverName) ||
            !isValidInviteUrl(body.inviteUrl)
          ) {
            return apiError(400, "invalid_invitation", "The invitation details are invalid.");
          }
          await auth.enforceTeamInviteRateLimit(user.id, email, requestSourceIp(request));
          const delivery = requestTeamInviteEmailDelivery();
          if (!delivery) {
            return apiError(503, "email_delivery_not_configured", "Email delivery is unavailable.");
          }
          await delivery.send({
            email,
            inviterEmail: user.email,
            serverName: body.serverName,
            inviteUrl: body.inviteUrl,
            role: body.role,
          });
          return new Response(null, { status: 204 });
        } catch (error) {
          if (error instanceof SyntaxError) {
            return apiError(400, "invalid_json", "The request body is invalid.");
          }
          if (error instanceof Error && /^smtp_[a-z_]+$/u.test(error.message)) {
            return apiError(502, "email_delivery_failed", "OpenBot could not send the invitation.");
          }
          return authErrorResponse(error);
        }
      },
    },
  },
});

function isValidInviteUrl(value: string): boolean {
  if (value.length > 4_096 || /[\r\n]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "openbot:" &&
      url.hostname === "join" &&
      Boolean(url.searchParams.get("invite"))
    );
  } catch {
    return false;
  }
}
