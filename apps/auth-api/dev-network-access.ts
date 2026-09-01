const MOBILE_LAN_PATHS = new Set(["/v1/mobile-auth/redeem", "/v1/mobile-auth/session", "/v1/me", "/v1/auth/logout"]);

export function developmentNetworkRequestAllowed(remoteAddress: string | undefined, requestUrl: string): boolean {
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1") return true;
  return MOBILE_LAN_PATHS.has(new URL(requestUrl, "http://openbot.local").pathname);
}
