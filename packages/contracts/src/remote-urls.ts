export function remoteAttachmentPreviewUrl(serverId: string, attachmentId: string): string {
  return `openbot-remote-attachment://${encodeURIComponent(serverId)}/${encodeURIComponent(attachmentId)}`;
}

export function remoteAgentAvatarUrl(serverId: string, botId: string, sourceUrl: string): string {
  const source = new URL(sourceUrl);
  const target = new URL(`openbot-remote-avatar://${encodeURIComponent(serverId)}/${encodeURIComponent(botId)}`);
  target.search = source.search;
  return target.toString();
}

export function remoteServerLogoUrl(serverId: string, version: string): string {
  const target = new URL(`openbot-remote-server-logo://${encodeURIComponent(serverId)}/logo`);
  target.searchParams.set("v", version);
  return target.toString();
}
