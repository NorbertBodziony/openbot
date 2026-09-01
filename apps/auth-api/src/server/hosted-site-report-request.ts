export function isSameOriginReportRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null || origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return fetchSite === null || fetchSite === "same-origin";
}
