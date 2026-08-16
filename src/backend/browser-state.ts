const X_HOSTS = new Set(["x.com", "www.x.com"]);
export const X_LOGIN_URL = "https://x.com/i/jf/onboarding/web?mode=login";

export function xLoginUrlForLanding(value: string): string | null {
  const url = new URL(value);
  return X_HOSTS.has(url.hostname) && url.pathname === "/" ? X_LOGIN_URL : null;
}

export function persistentBrowserUrl(value: string): string {
  const url = new URL(value);
  if (X_HOSTS.has(url.hostname) && url.pathname === "/i/jf/onboarding/web") {
    url.search = "?mode=login";
    url.hash = "";
  }
  return url.toString();
}
