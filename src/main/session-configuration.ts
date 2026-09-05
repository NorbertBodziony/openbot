/**
 * Everything that configures the default Electron session: the renderer's Content-Security-Policy,
 * its permission handlers, and the custom protocols that serve attachments, avatars and server
 * logos.
 *
 * **This module body must stay side-effect free.** The main entry point imports it, and an import
 * evaluates before the entry point's own statements - which is where `app.setPath("userData", ...)`
 * and `app.enableSandbox()` run. Anything executed at this module's top level would therefore run
 * against the wrong profile and an unsandboxed default. Every function here touches
 * `session.defaultSession` only when called, and each is called from inside `app.whenReady()`.
 */

import { readFile } from "node:fs/promises";
import { LOCAL_SERVER_ID } from "@openbot/contracts/ipc";
import { app, session } from "electron";
import type { AgentService } from "../backend/agent-service";
import type { MailboxStore } from "../backend/mailbox-store";
import { buildContentSecurityPolicy } from "./content-security-policy";
import type { RemoteServerManager } from "./remote-server-manager";
import { canCheckRendererPermission, canRequestRendererPermission } from "./renderer-permissions";
import type { TeamStore } from "./team-store";
import { isTrustedRendererUrl } from "./trusted-renderer";

export function configureContentSecurityPolicy(): void {
  const policy = buildContentSecurityPolicy(app.isPackaged, process.env.REMOTE_SIGNAL_URL);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== "mainFrame" || !isTrustedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

export function configureRendererPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) =>
    canCheckRendererPermission(permission, requestingOrigin, details),
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = ("mediaTypes" in details ? details.mediaTypes : undefined) ?? [];
    callback(canRequestRendererPermission(permission, webContents.getURL(), { mediaTypes }));
  });
}

export interface AttachmentProtocolDependencies {
  mailbox: MailboxStore;
  agents: AgentService;
  /**
   * A getter, not a value, and the one place in this file that needs to be. This runs during
   * `app.whenReady()` while `remoteServerManager` is still null, so the null branches below are
   * that startup window rather than defensive padding. Both shapes type-check at every call site,
   * so `tsc` cannot tell a value passed here from a getter - only this comment can.
   */
  getRemoteServerManager: () => RemoteServerManager | null;
}

export function configureAttachmentProtocol({
  mailbox,
  agents,
  getRemoteServerManager,
}: AttachmentProtocolDependencies): void {
  session.defaultSession.protocol.handle("openbot-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.split("/").filter(Boolean).at(-1);
      const attachment = id ? await mailbox.resolveAttachment(id) : null;
      if (!attachment) return new Response("Not found", { status: 404 });
      return new Response(await readFile(attachment.path), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
          Vary: "Origin",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-attachment", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const attachmentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      const remoteServers = getRemoteServerManager();
      if (!remoteServers || !serverId || !attachmentId) {
        return new Response("Not found", { status: 404 });
      }
      const attachment = await remoteServers.downloadAttachment(attachmentId, serverId);
      return new Response(Buffer.from(attachment.bytes), {
        headers: {
          "Content-Type": attachment.mimeType,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
          Vary: "Origin",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": "inline",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "agent") return new Response("Not found", { status: 404 });
      const agentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      const avatar = agentId ? agents.resolveAvatar(agentId) : null;
      if (!avatar || avatar.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(avatar.path), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-avatar", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const agentId = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] ?? "");
      const remoteServers = getRemoteServerManager();
      if (!remoteServers || !serverId || !agentId) {
        return new Response("Not found", { status: 404 });
      }
      const version = url.searchParams.get("v");
      if (!version) return new Response("Not found", { status: 404 });
      const avatar = await remoteServers.downloadAgentAvatar(agentId, serverId, version);
      return new Response(Buffer.from(avatar.bytes), {
        headers: {
          "Content-Type": avatar.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

export interface ServerLogoProtocolDependencies {
  teamStore: TeamStore;
  /** Not a getter: unlike the pair above, this runs after `remoteServerManager` is constructed. */
  remoteServers: RemoteServerManager;
}

export function configureServerLogoProtocols({ teamStore, remoteServers }: ServerLogoProtocolDependencies): void {
  session.defaultSession.protocol.handle("openbot-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const logo = teamStore.resolveLogo();
      if (url.hostname !== LOCAL_SERVER_ID || !logo || logo.version !== url.searchParams.get("v")) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(await readFile(logo.path), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.protocol.handle("openbot-remote-server-logo", async (request) => {
    try {
      const url = new URL(request.url);
      const serverId = decodeURIComponent(url.hostname);
      const version = url.searchParams.get("v");
      if (!serverId || !version) return new Response("Not found", { status: 404 });
      const logo = await remoteServers.downloadServerLogo(serverId, version);
      return new Response(Buffer.from(logo.bytes), {
        headers: {
          "Content-Type": logo.mimeType,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}
