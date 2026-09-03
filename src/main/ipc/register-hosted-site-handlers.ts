// Publishing a local directory to a hosted site.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { type BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import type { HostedSiteDesktopService } from "../hosted-site-service";
import { handleTrusted } from "../trusted-ipc";
import { isObject, optionalBoolean, requireString } from "./validation";

export interface HostedSiteIpcDependencies {
  hostedSites: HostedSiteDesktopService;
  getMainWindow: () => BrowserWindow | null;
}

export function registerHostedSiteIpcHandlers({ hostedSites, getMainWindow }: HostedSiteIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.hostedSitesList, () => hostedSites.list());
  handleTrusted(IPC_CHANNELS.hostedSitesChooseDirectory, async () => {
    const options: OpenDialogOptions = {
      title: "Choose a static site directory",
      properties: ["openDirectory"],
    };
    const mainWindow = getMainWindow();
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handleTrusted(IPC_CHANNELS.hostedSitesPublish, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site publication.");
    const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
    return hostedSites.publish({
      sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
      title: requireString(input.title, "title", 120),
      description: requireString(input.description, "description", 500),
      ...(spaFallback !== undefined ? { spaFallback } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.hostedSitesReplace, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site replacement.");
    const spaFallback = optionalBoolean(input.spaFallback, "spaFallback");
    return hostedSites.replace({
      siteId: requireString(input.siteId, "siteId", INPUT_LIMITS.identifier),
      sourcePath: requireString(input.sourcePath, "sourcePath", INPUT_LIMITS.path),
      title: requireString(input.title, "title", 120),
      description: requireString(input.description, "description", 500),
      ...(spaFallback !== undefined ? { spaFallback } : {}),
    });
  });
  handleTrusted(IPC_CHANNELS.hostedSitesDelete, (input: unknown) => {
    if (!isObject(input)) throw new Error("Invalid site deletion.");
    return hostedSites.delete(requireString(input.siteId, "siteId", INPUT_LIMITS.identifier));
  });
}
