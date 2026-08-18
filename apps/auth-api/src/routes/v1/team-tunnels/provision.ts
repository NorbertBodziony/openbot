import { createFileRoute } from "@tanstack/solid-router";
import { CloudflareTunnelError } from "../../../server/cloudflare-tunnel-provider";
import {
  apiError,
  authErrorResponse,
  bearerToken,
  json,
  requestAuthService,
  requestSourceIp,
  requestTeamTunnelService,
} from "../../../server/request-auth";
import { TeamTunnelServiceError } from "../../../server/team-tunnel-service";

export const Route = createFileRoute("/v1/team-tunnels/provision")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const auth = requestAuthService();
          const user = await auth.authenticate(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          const body = (await request.json()) as Record<string, unknown>;
          if (
            typeof body.serverId !== "string" ||
            typeof body.serverName !== "string" ||
            (body.apiPort !== undefined &&
              body.apiPort !== null &&
              typeof body.apiPort !== "number") ||
            (body.vncEnabled !== undefined && typeof body.vncEnabled !== "boolean")
          ) {
            return apiError(400, "invalid_tunnel_request", "The tunnel details are invalid.");
          }
          await auth.enforceTeamTunnelRateLimit(user.id, requestSourceIp(request));
          const service = requestTeamTunnelService();
          if (!service) {
            return apiError(
              503,
              "team_tunnels_not_configured",
              "Named team tunnels are not configured.",
            );
          }
          return json(
            await service.provision({
              user,
              serverId: body.serverId,
              serverName: body.serverName,
              apiPort: body.apiPort as number | null | undefined,
              vncEnabled: body.vncEnabled as boolean | undefined,
            }),
          );
        } catch (error) {
          if (error instanceof SyntaxError) {
            return apiError(400, "invalid_json", "The request body is invalid.");
          }
          if (error instanceof TeamTunnelServiceError) {
            return apiError(error.status, error.code, error.message);
          }
          if (error instanceof CloudflareTunnelError) {
            return cloudflareError(error);
          }
          return authErrorResponse(error);
        }
      },
      DELETE: async ({ request }) => {
        try {
          const token = bearerToken(request);
          if (!token) return apiError(401, "unauthorized", "Sign in is required.");
          const auth = requestAuthService();
          const user = await auth.authenticate(token);
          if (!user) return apiError(401, "unauthorized", "The session is invalid.");
          const body = (await request.json()) as { serverId?: unknown };
          if (typeof body.serverId !== "string") {
            return apiError(400, "invalid_server_id", "The team server ID is invalid.");
          }
          await auth.enforceTeamTunnelRateLimit(user.id, requestSourceIp(request));
          const service = requestTeamTunnelService();
          if (!service) {
            return apiError(
              503,
              "team_tunnels_not_configured",
              "Named team tunnels are not configured.",
            );
          }
          await service.deprovision(user, body.serverId);
          return new Response(null, { status: 204 });
        } catch (error) {
          if (error instanceof SyntaxError) {
            return apiError(400, "invalid_json", "The request body is invalid.");
          }
          if (error instanceof TeamTunnelServiceError) {
            return apiError(error.status, error.code, error.message);
          }
          if (error instanceof CloudflareTunnelError) return cloudflareError(error);
          return authErrorResponse(error);
        }
      },
    },
  },
});

function cloudflareError(error: CloudflareTunnelError): Response {
  if (error.code === "dns_hostname_conflict") {
    return apiError(409, error.code, "The OpenBot hostname is already in use.");
  }
  if (error.code === "cloudflare_permission_denied") {
    return apiError(503, error.code, "Cloudflare tunnel permissions are not configured.");
  }
  return apiError(502, error.code, "Cloudflare could not provision the team tunnel.");
}
