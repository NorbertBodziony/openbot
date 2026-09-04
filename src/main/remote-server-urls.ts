// URLs and query strings the Team API client builds.
//
// The `openbot-remote-*` schemes are how a remote host's attachments, agent avatars and server logo
// reach the renderer: the host's own URLs are not reachable from there, so `addRemotePreviewUrls`
// rewrites them in place on a decoded payload before it leaves the main process. `src/main/index.ts`
// registers the matching protocol handlers, and they parse exactly what these three builders emit.

import type { ConversationPageAnchor, DirectConversationPageAnchor } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";

export function pageQuery(anchor: ConversationPageAnchor | DirectConversationPageAnchor, limit: number): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (anchor.type === "before") query.set("before", anchor.cursor);
  if (anchor.type === "around") query.set("around", anchor.messageId);
  return `?${query.toString()}`;
}

export function isLocalDevelopmentApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function addRemotePreviewUrls<T>(value: T, serverId: string): T {
  if (Array.isArray(value)) {
    for (const item of value) addRemotePreviewUrls(item, serverId);
    return value;
  }
  if (!isDynamicRecord(value)) return value;
  const record = value;
  if ("previewUrl" in record && isString(record.id)) {
    Reflect.set(record, "previewUrl", remoteAttachmentPreviewUrl(serverId, record.id));
  }
  if (isString(record.avatarUrl) && record.avatarUrl.startsWith("openbot-avatar:") && isString(record.id)) {
    Reflect.set(record, "avatarUrl", remoteAgentAvatarUrl(serverId, record.id, record.avatarUrl));
  }
  for (const item of Object.values(record)) addRemotePreviewUrls(item, serverId);
  return value;
}

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
