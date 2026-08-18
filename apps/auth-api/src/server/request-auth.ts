import { env } from "cloudflare:workers";
import { AuthService, AuthServiceError } from "./auth-service";
import { D1AuthRepository } from "./d1-auth-repository";
import { createEmailCodeDelivery, createTeamInviteEmailDelivery } from "./email-delivery";
import type { TeamInviteEmailDelivery, WorkerBindings } from "./types";

export function requestAuthService(): AuthService {
  const bindings = env as unknown as WorkerBindings;
  const exposeDevelopmentCode = bindings.AUTH_EXPOSE_DEVELOPMENT_CODE === "true";
  return new AuthService({
    repository: new D1AuthRepository(bindings.DB),
    delivery: exposeDevelopmentCode ? null : createEmailCodeDelivery(bindings),
    exposeDevelopmentCode,
  });
}

export function requestTeamInviteEmailDelivery(): TeamInviteEmailDelivery | null {
  return createTeamInviteEmailDelivery(env as unknown as WorkerBindings);
}

export function requestSourceIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0] ??
    "127.0.0.1"
  );
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token && token.length <= 512 ? token : null;
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthServiceError) {
    const response = apiError(error.status, error.code, error.message);
    if (error.retryAfterSeconds !== undefined) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return response;
  }
  return apiError(500, "internal_error", "The account service could not complete the request.");
}
