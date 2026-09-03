import { type BrowserDisplayState, IPC_CHANNELS } from "@openbot/contracts/ipc";
import type { BrowserHost } from "../../backend/browser-host";
import type { BrowserPictureInPicture } from "../browser-picture-in-picture";
import { parseBrowserBounds, parseBrowserNavigate, parseBrowserOpen, parseVisibility } from "../ipc/browser-inputs";
import { requireString } from "../ipc/validation";
import {
  decodeBrowserControlState,
  decodeBrowserPreview,
  decodeBrowserTab,
  decodeBrowserTabs,
  decodeVoid,
  type RemoteServerManager,
} from "../remote-server-manager";
import { handleTrusted } from "../trusted-ipc";

interface BrowserIpcDependencies {
  browser: BrowserHost;
  browserPictureInPicture: BrowserPictureInPicture;
  remoteServers: RemoteServerManager;
}

export function registerBrowserIpcHandlers({
  browser,
  browserPictureInPicture,
  remoteServers,
}: BrowserIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.browserOpen, (input: unknown) => {
    const parsed = parseBrowserOpen(input);
    return remoteServers.activeServerId === "local"
      ? browser.open(parsed.url, parsed.ownerThreadId ?? null, parsed.ownerBotId ?? null, parsed.focus)
      : remoteServers.request("/v1/browser/open", { method: "POST", body: parsed }, undefined, decodeBrowserTab);
  });
  handleTrusted(IPC_CHANNELS.browserActivate, (tabId: unknown) =>
    remoteServers.activeServerId === "local"
      ? browser.activate(requireString(tabId, "tabId"))
      : remoteServers.request(
          "/v1/browser/activate",
          { method: "POST", body: { tabId: requireString(tabId, "tabId") } },
          undefined,
          decodeVoid,
        ),
  );
  handleTrusted(IPC_CHANNELS.browserNavigate, (input: unknown) => {
    const parsed = parseBrowserNavigate(input);
    return remoteServers.activeServerId === "local"
      ? browser.navigate(parsed.tabId, parsed.direction)
      : remoteServers.request("/v1/browser/navigate", { method: "POST", body: parsed }, undefined, decodeVoid);
  });
  handleTrusted(IPC_CHANNELS.browserReload, (tabId: unknown) =>
    remoteServers.activeServerId === "local"
      ? browser.reload(requireString(tabId, "tabId"))
      : remoteServers.request(
          "/v1/browser/reload",
          { method: "POST", body: { tabId: requireString(tabId, "tabId") } },
          undefined,
          decodeVoid,
        ),
  );
  handleTrusted(IPC_CHANNELS.browserClose, (tabId: unknown) =>
    remoteServers.activeServerId === "local"
      ? browser.close(requireString(tabId, "tabId"))
      : remoteServers.request(
          "/v1/browser/close",
          { method: "POST", body: { tabId: requireString(tabId, "tabId") } },
          undefined,
          decodeVoid,
        ),
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
  handleTrusted(IPC_CHANNELS.browserCapturePreview, (tabId: unknown) => {
    const parsedTabId = requireString(tabId, "tabId");
    return remoteServers.activeServerId === "local"
      ? browser.capturePreview(parsedTabId)
      : remoteServers.request(
          "/v1/browser/preview",
          { method: "POST", body: { tabId: parsedTabId } },
          undefined,
          decodeBrowserPreview,
        );
  });
  handleTrusted(IPC_CHANNELS.browserSetVisible, async (input: unknown) => {
    const parsed = parseVisibility(input);
    if (remoteServers.activeServerId === "local") await browser.setVisible(parsed);
    else {
      await remoteServers.request("/v1/browser/visible", { method: "POST", body: parsed }, undefined, decodeVoid);
    }
  });
  handleTrusted(IPC_CHANNELS.browserPictureInPictureOpen, (input: unknown) =>
    browserPictureInPicture.open(input === undefined ? undefined : parseBrowserBounds(input)),
  );
  handleTrusted(IPC_CHANNELS.browserPictureInPictureClose, () => browserPictureInPicture.close());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureDock, () => browserPictureInPicture.dock());
  handleTrusted(IPC_CHANNELS.browserPictureInPictureHide, () => browserPictureInPicture.hide());
}
