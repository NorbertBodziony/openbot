export function embeddedBrowserUserAgent(sessionUserAgent: string): string {
  return sessionUserAgent.replace(/\sElectron\/[^\s]+/gu, "");
}

export function embeddedBrowserUserAgentForUrl(sessionUserAgent: string, value: string): string {
  const userAgent = embeddedBrowserUserAgent(sessionUserAgent);
  try {
    const hostname = new URL(value).hostname;
    if (hostname === "x.com" || hostname === "www.x.com") {
      return userAgent.replace(/\sOpenBot\/[^\s]+/gu, "");
    }
  } catch {
    // Keep the embedded identity when the navigation URL is not complete yet.
  }
  return userAgent;
}
