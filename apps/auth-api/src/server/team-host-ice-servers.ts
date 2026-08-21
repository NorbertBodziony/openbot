import { isString } from "@openbot/contracts/runtime-values";
import { readJsonObject } from "./json-body";

interface TeamHostIceServerServices {
  authenticateHost: (serverId: string, token: string) => Promise<boolean>;
}

export async function handleTeamHostIceServers(
  request: Request,
  services: TeamHostIceServerServices,
): Promise<Response> {
  try {
    const token = bearerToken(request);
    if (!token) return apiError(401, "unauthorized_host", "Host authentication is required.");
    const body = await readJsonObject(request);
    if (!isString(body.serverId)) return apiError(400, "invalid_server_id", "The team server ID is invalid.");
    if (!(await services.authenticateHost(body.serverId, token))) {
      return apiError(401, "unauthorized_host", "The host token is invalid.");
    }
    return json({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
  } catch {
    return apiError(400, "invalid_ice_request", "The ICE request is invalid.");
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token && token.length <= 512 ? token : null;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}
