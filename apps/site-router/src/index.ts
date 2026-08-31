import { isBoolean, isDynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";

interface RouteFile {
  key: string;
  size: number;
  mimeType: string;
}

interface RouteManifest {
  version: 1;
  status: "active" | "deleted" | "expired" | "blocked";
  siteId: string;
  deploymentId: string | null;
  expiresAt: number | null;
  spaFallback: boolean;
  files: Record<string, RouteFile>;
}

interface SiteBucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

interface SiteRouterEnv {
  SITES: SiteBucket;
  SITE_SERVE_ENABLED?: string;
}

export default {
  async fetch(request: Request, env: SiteRouterEnv): Promise<Response> {
    try {
      return await routeRequest(request, env, Date.now());
    } catch (error) {
      console.error(JSON.stringify({ event: "site_router_error", message: errorMessage(error) }));
      return errorResponse(500, "Site unavailable");
    }
  },
} satisfies ExportedHandler<SiteRouterEnv>;

export async function routeRequest(request: Request, env: SiteRouterEnv, now: number): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = errorResponse(405, "Method not allowed");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }
  if (env.SITE_SERVE_ENABLED !== "true") return errorResponse(503, "Site hosting is temporarily unavailable");

  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase();
  if (!isHostedSiteHostname(hostname)) return errorResponse(404, "Site not found");
  if (url.pathname === "/_openbot/report" || url.pathname === "/_openbot/report/") {
    const report = new URL("https://openbot.run/report-site");
    report.searchParams.set("hostname", hostname);
    return new Response(null, {
      status: 302,
      headers: secureHeaders({ Location: report.toString(), "Cache-Control": "no-store" }),
    });
  }
  const blockMarker = await env.SITES.get(`blocks/${hostname}`);
  if (blockMarker) return errorResponse(451, "Site unavailable");

  const routeObject = await env.SITES.get(`routes/${hostname}.json`);
  if (!routeObject) return errorResponse(404, "Site not found");
  const route = await readRouteManifest(routeObject);
  if (!route) return errorResponse(500, "Site unavailable");
  if (route.status === "deleted" || route.status === "expired") return errorResponse(410, "Site no longer available");
  if (route.status === "blocked") return errorResponse(451, "Site unavailable");
  if (route.expiresAt === null || route.expiresAt <= now) return errorResponse(410, "Site no longer available");

  const path = requestPath(url.pathname);
  if (path === null) return errorResponse(404, "Page not found");
  const file = resolveFile(route, path);
  if (!file) return errorResponse(404, "Page not found");
  const object = await env.SITES.get(file.key);
  if (!object || object.size !== file.size) return errorResponse(404, "Page not found");

  const headers = secureHeaders({
    "Content-Type": file.mimeType,
    "Cache-Control": file.mimeType === "text/html" ? "no-store" : "public, no-cache",
    "Content-Length": String(object.size),
  });
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}

function isHostedSiteHostname(hostname: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openbot\.site$/u.test(hostname);
}

function requestPath(pathname: string): string | null {
  try {
    const decoded = pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/")
      .replace(/^\/+/, "");
    if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..")) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function resolveFile(route: RouteManifest, path: string): RouteFile | null {
  const candidates = path ? [path, path.endsWith("/") ? `${path}index.html` : `${path}/index.html`] : ["index.html"];
  for (const candidate of candidates) {
    const file = route.files[candidate];
    if (file) return file;
  }
  return route.spaFallback ? (route.files["index.html"] ?? null) : null;
}

async function readRouteManifest(object: R2ObjectBody): Promise<RouteManifest | null> {
  if (object.size > 64 * 1024) return null;
  try {
    const value = await object.json();
    if (
      !isDynamicRecord(value) ||
      value.version !== 1 ||
      !["active", "deleted", "expired", "blocked"].includes(String(value.status)) ||
      !isString(value.siteId) ||
      (value.deploymentId !== null && !isString(value.deploymentId)) ||
      (value.expiresAt !== null && !isNumber(value.expiresAt)) ||
      !isBoolean(value.spaFallback) ||
      !isDynamicRecord(value.files)
    ) {
      return null;
    }
    const files: Record<string, RouteFile> = {};
    for (const file of Object.values(value.files)) {
      if (
        !isDynamicRecord(file) ||
        !isString(file.key) ||
        !isNumber(file.size) ||
        !isString(file.mimeType) ||
        !file.key.startsWith(`sites/${value.siteId}/deployments/${value.deploymentId}/`)
      ) {
        return null;
      }
    }
    for (const [path, file] of Object.entries(value.files)) {
      if (!isDynamicRecord(file) || !isString(file.key) || !isNumber(file.size) || !isString(file.mimeType)) {
        return null;
      }
      files[path] = { key: file.key, size: file.size, mimeType: file.mimeType };
    }
    return {
      version: 1,
      status: parseRouteStatus(value.status),
      siteId: value.siteId,
      deploymentId: value.deploymentId,
      expiresAt: value.expiresAt,
      spaFallback: value.spaFallback,
      files,
    };
  } catch {
    return null;
  }
}

function parseRouteStatus(value: unknown): RouteManifest["status"] {
  if (value === "active" || value === "deleted" || value === "expired" || value === "blocked") return value;
  throw new Error("The route status is invalid.");
}

function errorResponse(status: number, message: string): Response {
  const headers = secureHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  return new Response(message, { status, headers });
}

function secureHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.delete("Set-Cookie");
  return headers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}
