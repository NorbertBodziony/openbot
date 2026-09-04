import { env } from "cloudflare:workers";
import { AgentMarketplace, AgentMarketplaceError } from "./agent-marketplace";
import { AuthService, AuthServiceError } from "./auth-service";
import { D1AuthRepository } from "./d1-auth-repository";
import { createEmailCodeDelivery, createTeamInviteEmailDelivery } from "./email-delivery";
import { HostedSiteInputError } from "./hosted-site-contract";
import { enforceHostedSiteReportRateLimit as enforceReportRateLimit } from "./hosted-site-request-policy";
import { HostedSiteService } from "./hosted-site-service";
import { JsonBodyError } from "./json-body";
import { MarketplaceQueryError } from "./marketplace-pagination";
import {
  enforceMarketplaceMutation,
  type MarketplaceMutationKind,
  MarketplaceRateLimitError,
} from "./marketplace-request-policy";
import {
  deliverPendingRemoteAuthEvents,
  RemoteControlPlane,
  RemoteControlPlaneError,
  verifyRemoteServiceSignature,
} from "./remote-control-plane";
import { SkillMarketplace, SkillMarketplaceError } from "./skill-marketplace";
import { requireWorkerBindings, type TeamInviteEmailDelivery } from "./types";

export function requestAuthService(): AuthService {
  const bindings = requireWorkerBindings(env);
  const exposeDevelopmentCode = bindings.AUTH_EXPOSE_DEVELOPMENT_CODE === "true";
  return new AuthService({
    repository: new D1AuthRepository(bindings.DB),
    delivery: exposeDevelopmentCode ? null : createEmailCodeDelivery(bindings),
    exposeDevelopmentCode,
    flushSessionRevocations: () => deliverPendingRemoteAuthEvents(bindings, Date.now()),
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

export function requestHostedSiteService(): HostedSiteService {
  const bindings = requireWorkerBindings(env);
  return new HostedSiteService(
    bindings.DB,
    bindings.SITES,
    Date.now,
    bindings.SITE_REPORT_HASH_SECRET,
    bindings.SITE_LOCAL_ORIGIN,
  );
}

export function requireSitePublishingEnabled(): void {
  const bindings = requireWorkerBindings(env);
  if (bindings.SITE_PUBLISH_ENABLED !== "true") {
    throw new HostedSiteInputError(409, "publishing_disabled", "Site publishing is temporarily disabled.");
  }
  if (bindings.SITE_COOKIE_ISOLATION_READY !== "true") {
    throw new HostedSiteInputError(
      409,
      "cookie_isolation_unavailable",
      "Site publishing is disabled until openbot.site has public-suffix cookie isolation.",
    );
  }
}

export function hostedSiteErrorResponse(error: unknown): Response {
  if (error instanceof HostedSiteInputError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(key)) {
    throw new HostedSiteInputError(400, "invalid_idempotency_key", "A valid Idempotency-Key header is required.");
  }
  return key;
}

export function enforceMarketplaceMutationRateLimit(kind: MarketplaceMutationKind, principal: string): Promise<void> {
  return enforceMarketplaceMutation(requireWorkerBindings(env), kind, principal);
}

export function enforceHostedSiteReportRateLimit(sourceIp: string): Promise<void> {
  return enforceReportRateLimit(requireWorkerBindings(env), sourceIp);
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

export async function requireOperationsAdmin(request: Request): Promise<boolean> {
  const bindings = requireWorkerBindings(env);
  const expected = bindings.SITE_OPERATIONS_ADMIN_TOKEN;
  const provided = bearerToken(request);
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const [expectedHash, providedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  return constantTimeEqual(new Uint8Array(expectedHash), new Uint8Array(providedHash));
}

export function requestTeamInviteEmailDelivery(): TeamInviteEmailDelivery | null {
  const bindings = requireWorkerBindings(env);
  return createTeamInviteEmailDelivery(bindings);
}

export function requestRemoteControlPlane(): RemoteControlPlane {
  return new RemoteControlPlane(requireWorkerBindings(env));
}

export function verifyRemoteServiceRequest(request: Request, body: string): Promise<boolean> {
  const secret = requireWorkerBindings(env).REMOTE_AUTH_WEBHOOK_SECRET;
  if (!secret) return Promise.resolve(false);
  return verifyRemoteServiceSignature(
    secret,
    body,
    request.headers.get("OpenBot-Timestamp") ?? "",
    request.headers.get("OpenBot-Signature") ?? "",
  );
}

export function remoteControlPlaneErrorResponse(error: unknown): Response {
  if (error instanceof RemoteControlPlaneError) return apiError(error.status, error.code, error.message);
  return authErrorResponse(error);
}

export function requestRemoteSignalUrl(): string {
  const value = requireWorkerBindings(env).REMOTE_SIGNAL_URL?.trim();
  if (!value)
    throw new RemoteControlPlaneError(503, "remote_not_configured", "The Remote Signal URL is not configured.");
  return value;
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

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
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
