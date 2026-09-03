// Publishing a local directory to a hosted site.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { HostedSiteDesktopService } from "../hosted-site-service";
import { handleTrusted } from "../trusted-ipc";
import { parseDeleteHostedSite, parsePublishHostedSite, parseReplaceHostedSite } from "./app-inputs";

export interface HostedSiteIpcDependencies {
  hostedSites: HostedSiteDesktopService;
  getMainWindow: () => BrowserWindow | null;
}

export function registerHostedSiteIpcHandlers({ hostedSites, getMainWindow }: HostedSiteIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.hostedSitesList, () => hostedSites.list());
  handleTrusted(IPC_CHANNELS.hostedSitesChooseDirectory, async () => {
    const mainWindow = getMainWindow();
    const options: OpenDialogOptions = {
      title: "Choose a static site directory",
      properties: ["openDirectory"],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleTrusted(IPC_CHANNELS.hostedSitesPublish, parsePublishHostedSite, (site) => hostedSites.publish(site));
  handleTrusted(IPC_CHANNELS.hostedSitesReplace, parseReplaceHostedSite, (site) => hostedSites.replace(site));
  handleTrusted(IPC_CHANNELS.hostedSitesDelete, parseDeleteHostedSite, (siteId) => hostedSites.delete(siteId));
}
