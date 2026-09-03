// The embedded browser and its picture-in-picture window.

import { type BrowserDisplayState, IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { BrowserHost } from "../../backend/browser-host";
import type { BrowserPictureInPicture } from "../browser-picture-in-picture";
import {
  decodeBrowserControlState,
  decodeBrowserPreview,
  decodeBrowserTab,
  decodeBrowserTabs,
  decodeVoid,
  type RemoteServerManager,
} from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";
import { parseBrowserBounds, parseBrowserNavigate, parseBrowserOpen, parseVisibility } from "./browser-inputs";
import { optionalPayload, stringPayload } from "./validation";
// The embedded browser and its picture-in-picture window.

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
  handleTrusted(IPC_CHANNELS.browserOpen, parseBrowserOpen, (parsed) => {
    return remoteServers.activeServerId === "local"
      ? browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null, parsed.focus)
      : remoteServers.request("/v1/browser/open", { method: "POST", body: parsed }, undefined, decodeBrowserTab);
  });
  handleTrusted(IPC_CHANNELS.browserActivate, stringPayload("tabId"), (tabId) =>
    remoteServers.activeServerId === "local"
      ? browser.activate(tabId)
      : remoteServers.request("/v1/browser/activate", { method: "POST", body: { tabId } }, undefined, decodeVoid),
  );
  handleTrusted(IPC_CHANNELS.browserNavigate, parseBrowserNavigate, (parsed) => {
    return remoteServers.activeServerId === "local"
      ? browser.navigate(parsed.tabId, parsed.direction)
      : remoteServers.request("/v1/browser/navigate", { method: "POST", body: parsed }, undefined, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.browserReload, stringPayload("tabId"), (tabId) =>
    remoteServers.activeServerId === "local"
      ? browser.reload(tabId)
      : remoteServers.request("/v1/browser/reload", { method: "POST", body: { tabId } }, undefined, decodeVoid),
  );
  handleTrusted(IPC_CHANNELS.browserClose, stringPayload("tabId"), (tabId) =>
    remoteServers.activeServerId === "local"
      ? browser.close(tabId)
      : remoteServers.request("/v1/browser/close", { method: "POST", body: { tabId } }, undefined, decodeVoid),
  );
  handleTrusted(IPC_CHANNELS.browserListTabs, () =>
    remoteServers.activeServerId === "local"
      ? browser.listTabs()
      : remoteServers.request("/v1/browser/tabs", {}, undefined, decodeBrowserTabs),
  );
  handleTrusted(IPC_CHANNELS.browserGetDisplayState, (): BrowserDisplayState => browser.getDisplayState());
  handleTrusted(IPC_CHANNELS.browserGetControlState, () =>
    remoteServers.activeServerId === "local"
      ? browser.getControlState()
      : remoteServers.request("/v1/browser/control", {}, undefined, decodeBrowserControlState),
  );
  handleTrusted(IPC_CHANNELS.browserCapturePreview, stringPayload("tabId"), (tabId) =>
    remoteServers.activeServerId === "local"
      ? browser.capturePreview(tabId)
      : remoteServers.request(
          "/v1/browser/preview",
          { method: "POST", body: { tabId } },
          undefined,
          decodeBrowserPreview,
        ),
  );
  handleTrusted(IPC_CHANNELS.browserSetVisible, parseVisibility, async (parsed) => {
    if (remoteServers.activeServerId === "local") await browser.setVisible(parsed);
    else {
      await remoteServers.request("/v1/browser/visible", { method: "POST", body: parsed }, undefined, decodeVoid);
    }
  });
  handleTrusted(IPC_CHANNELS.browserPictureInPictureOpen, optionalPayload(parseBrowserBounds), (bounds) =>
    browserPictureInPicture.open(bounds),
  );
  handleTrusted(IPC_CHANNELS.browserPictureInPictureClose, () => browserPictureInPicture.close());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureDock, () => browserPictureInPicture.dock());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureHide, () => browserPictureInPicture.hide());
}
