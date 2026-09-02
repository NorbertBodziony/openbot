export function buildContentSecurityPolicy(packaged: boolean): string {
  const developmentSources = packaged ? "" : " http://localhost:* ws://localhost:*";
  const developmentImageSources = packaged ? "" : " http://127.0.0.1:* http://localhost:*";
  const developmentFrameSources = packaged ? "" : " http://127.0.0.1:* http://localhost:*";

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: openbot-attachment: openbot-remote-attachment: openbot-avatar: openbot-remote-avatar: openbot-server-logo: openbot-remote-server-logo: https:${developmentImageSources}`,
    "font-src 'self' data:",
    `connect-src 'self' openbot-attachment: openbot-remote-attachment: https://analytics.openbot.run ws://127.0.0.1:* wss://*.openbot.run${developmentSources}`,
    "object-src 'none'",
    `frame-src 'self' openbot-attachment: openbot-remote-attachment: https://*.openbot.run${developmentFrameSources}`,
    "base-uri 'none'",
  ].join("; ");
}
