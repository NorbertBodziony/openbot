import { env } from "cloudflare:workers";
import { AgentMarketplace, AgentMarketplaceError } from "./agent-marketplace";
import { AuthService, AuthServiceError } from "./auth-service";
import { CloudflareTunnelProvider } from "./cloudflare-tunnel-provider";
import { D1AuthRepository } from "./d1-auth-repository";
import { D1TeamTunnelRepository } from "./d1-team-tunnel-repository";
import { createEmailCodeDelivery, createTeamInviteEmailDelivery } from "./email-delivery";
import { JsonBodyError } from "./json-body";
import { MarketplaceQueryError } from "./marketplace-pagination";
import {
  enforceMarketplaceMutation,
  type MarketplaceMutationKind,
  MarketplaceRateLimitError,
} from "./marketplace-request-policy";
import { SkillMarketplace, SkillMarketplaceError } from "./skill-marketplace";
import { authenticateTeamHost, TeamTunnelService } from "./team-tunnel-service";
import { requireWorkerBindings, type TeamInviteEmailDelivery } from "./types";

export function requestAuthService(): AuthService {
  const bindings = requireWorkerBindings(env);
  const exposeDevelopmentCode = bindings.AUTH_EXPOSE_DEVELOPMENT_CODE === "true";
  return new AuthService({
    repository: new D1AuthRepository(bindings.DB),
    delivery: exposeDevelopmentCode ? null : createEmailCodeDelivery(bindings),
    exposeDevelopmentCode,
  });
}

export function requestAvatarBucket(): R2Bucket {
  const bindings = requireWorkerBindings(env);
  return bindings.AVATARS;
}

export function requestSkillMarketplace(): SkillMarketplace {
  const bindings = requireWorkerBindings(env);
  return new SkillMarketplace(bindings);
}

export function requestAgentMarketplace(): AgentMarketplace {
  return new AgentMarketplace(requireWorkerBindings(env));
}

export function enforceMarketplaceMutationRateLimit(kind: MarketplaceMutationKind, principal: string): Promise<void> {
  return enforceMarketplaceMutation(requireWorkerBindings(env), kind, principal);
}

export function marketplaceErrorResponse(error: unknown): Response {
  if (error instanceof AgentMarketplaceError) return apiError(error.status, error.code, error.message);
  return skillErrorResponse(error);
}

export async function requestUser(request: Request) {
  const token = bearerToken(request);
  if (!token) return null;
  return requestAuthService().authenticate(token);
}

export function skillErrorResponse(error: unknown): Response {
  if (error instanceof MarketplaceQueryError) return apiError(400, error.code, error.message);
  if (error instanceof MarketplaceRateLimitError) {
    const response = apiError(error.status, error.code, error.message);
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
    return response;
  }
  if (error instanceof SkillMarketplaceError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function requireSkillsAdmin(request: Request): boolean {
  const bindings = requireWorkerBindings(env);
  const expected = bindings.SKILLS_ADMIN_TOKEN;
  return Boolean(expected && bearerToken(request) === expected);
}

export function requestTeamInviteEmailDelivery(): TeamInviteEmailDelivery | null {
  const bindings = requireWorkerBindings(env);
  return createTeamInviteEmailDelivery(bindings);
}

export function requestTeamTunnelService(): TeamTunnelService | null {
  const bindings = requireWorkerBindings(env);
  if (
    !bindings.CLOUDFLARE_ACCOUNT_ID ||
    !bindings.CLOUDFLARE_ZONE_ID ||
    !bindings.CLOUDFLARE_TUNNEL_DOMAIN ||
    !bindings.CLOUDFLARE_API_TOKEN
  ) {
    return null;
  }
  return new TeamTunnelService({
    repository: new D1TeamTunnelRepository(bindings.DB),
    provider: new CloudflareTunnelProvider({
      accountId: bindings.CLOUDFLARE_ACCOUNT_ID,
      zoneId: bindings.CLOUDFLARE_ZONE_ID,
      apiToken: bindings.CLOUDFLARE_API_TOKEN,
    }),
    domain: bindings.CLOUDFLARE_TUNNEL_DOMAIN,
  });
}

export function requestTeamHostAuthenticator(): (serverId: string, token: string) => Promise<boolean> {
  const bindings = requireWorkerBindings(env);
  const repository = new D1TeamTunnelRepository(bindings.DB);
  return (serverId, token) => authenticateTeamHost(repository, serverId, token);
}

export function requestSourceIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0] ?? "127.0.0.1"
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

export function publicMarketplaceJson(value: unknown): Response {
  return Response.json(value, {
    headers: {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300, stale-if-error=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof JsonBodyError) {
    return apiError(error.status, error.code, error.message);
  }
  if (error instanceof AuthServiceError) {
    const response = apiError(error.status, error.code, error.message);
    if (error.retryAfterSeconds !== undefined) {
      response.headers.set("Retry-After", String(error.retryAfterSeconds));
    }
    return response;
  }
  return apiError(500, "internal_error", "The account service could not complete the request.");
}
