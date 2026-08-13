const X_HOSTS = new Set(["x.com", "www.x.com"]);

export function persistentBrowserUrl(value: string): string {
  const url = new URL(value);
  if (X_HOSTS.has(url.hostname) && url.pathname === "/i/jf/onboarding/web") {
    url.search = "?mode=login";
    url.hash = "";
  }
  return url.toString();
}
