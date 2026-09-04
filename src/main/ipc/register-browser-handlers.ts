// The embedded browser and its picture-in-picture window.

import { type BrowserDisplayState, IPC_CHANNELS } from "@openbot/contracts/ipc";
import { TEAM_API_ROUTES } from "@openbot/contracts/team-api-routes";
import type { BrowserHost } from "../../backend/browser-host";
import type { BrowserPictureInPicture } from "../browser-picture-in-picture";
import {
  decodeBrowserControlState,
  decodeBrowserPreviewFromHost,
  decodeBrowserTab,
  decodeBrowserTabs,
} from "../remote-device-decoding";
import { decodeVoid } from "../remote-host-decoding";
import type { RemoteServerManager } from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseBrowserBounds, parseBrowserNavigate, parseBrowserOpen, parseVisibility } from "./browser-inputs";
import { routeToServer } from "./route-to-server";
import { optionalPayload, stringPayload } from "./validation";

export interface BrowserIpcDependencies {
  browserPictureInPicture: BrowserPictureInPicture;
  browser: BrowserHost;
  remoteServers: RemoteServerManager;
}

export function registerBrowserIpcHandlers({
  browserPictureInPicture,
  browser,
  remoteServers,
}: BrowserIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.browserOpen, parseBrowserOpen, (parsed) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null, parsed.focus),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.browser.open,
          { method: "POST", body: parsed },
          serverId,
          decodeBrowserTab,
        ),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserActivate, stringPayload("tabId"), (tabId) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.activate(tabId),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.browser.activate,
          { method: "POST", body: { tabId } },
          serverId,
          decodeVoid,
        ),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserNavigate, parseBrowserNavigate, (parsed) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.navigate(parsed.tabId, parsed.direction),
      remote: (serverId) =>
        remoteServers.request(TEAM_API_ROUTES.browser.navigate, { method: "POST", body: parsed }, serverId, decodeVoid),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserReload, stringPayload("tabId"), (tabId) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.reload(tabId),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.browser.reload,
          { method: "POST", body: { tabId } },
          serverId,
          decodeVoid,
        ),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserClose, stringPayload("tabId"), (tabId) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.close(tabId),
      remote: (serverId) =>
        remoteServers.request(TEAM_API_ROUTES.browser.close, { method: "POST", body: { tabId } }, serverId, decodeVoid),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserListTabs, () =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.listTabs(),
      remote: (serverId) => remoteServers.request(TEAM_API_ROUTES.browser.tabs, {}, serverId, decodeBrowserTabs),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserGetDisplayState, (): BrowserDisplayState => browser.getDisplayState());
  handleTrusted(IPC_CHANNELS.browserGetControlState, () =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.getControlState(),
      remote: (serverId) =>
        remoteServers.request(TEAM_API_ROUTES.browser.control, {}, serverId, decodeBrowserControlState),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserCapturePreview, stringPayload("tabId"), (tabId) =>
    routeToServer(remoteServers.activeServerId, {
      local: () => browser.capturePreview(tabId),
      remote: (serverId) =>
        remoteServers.request(
          TEAM_API_ROUTES.browser.preview,
          { method: "POST", body: { tabId } },
          serverId,
          decodeBrowserPreviewFromHost,
        ),
    }),
  );
  handleTrusted(IPC_CHANNELS.browserSetVisible, parseVisibility, (parsed) =>
    routeToServer<void>(remoteServers.activeServerId, {
      local: () => browser.setVisible(parsed),
      remote: async (serverId) => {
        await remoteServers.request(
          TEAM_API_ROUTES.browser.visible,
          { method: "POST", body: parsed },
          serverId,
          decodeVoid,
        );
      },
    }),
  );
  handleTrusted(IPC_CHANNELS.browserPictureInPictureOpen, optionalPayload(parseBrowserBounds), (bounds) =>
    browserPictureInPicture.open(bounds),
  );
  handleTrusted(IPC_CHANNELS.browserPictureInPictureClose, () => browserPictureInPicture.close());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureDock, () => browserPictureInPicture.dock());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureHide, () => browserPictureInPicture.hide());
}
