const MOBILE_LAN_PATHS = new Set([
  "/v1/mobile-auth/redeem",
  "/v1/mobile-auth/session",
  "/v1/me",
  "/v2/remote/hosts/",
  "/v2/remote/sessions/",
  "/v2/remote/invites/preview",
  "/v2/remote/invites/accept",
]);

export function developmentNetworkRequestAllowed(remoteAddress: string | undefined, requestUrl: string): boolean {
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1") return true;
  const pathname = new URL(requestUrl, "http://openbot.local").pathname;
  if (MOBILE_LAN_PATHS.has(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length === 6 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "hosts" &&
    segments[3] &&
    segments[4] === "members" &&
    segments[5]
  )
    return true;
  return (
    segments.length === 5 &&
    segments[0] === "v2" &&
    segments[1] === "remote" &&
    segments[2] === "sessions" &&
    Boolean(segments[3]) &&
    (segments[4] === "ticket" || segments[4] === "end")
  );
}
