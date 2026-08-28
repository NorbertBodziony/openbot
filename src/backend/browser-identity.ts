export function embeddedBrowserUserAgent(sessionUserAgent: string): string {
  return sessionUserAgent.replace(/\sElectron\/[^\s]+/gu, "");
}
