// The application updater and its auto-download preference.

import { IPC_CHANNELS } from "@openbot/contracts/ipc";
import { handleTrusted } from "../trusted-ipc";
import { readUpdatePreference, writeUpdatePreference } from "../update-preference-store";
import type { UpdateService } from "../update-service";
import { parseUpdatePreference } from "./app-inputs";

export interface UpdateIpcDependencies {
  updater: UpdateService;
  updatePreferenceFile: string;
}

export function registerUpdateIpcHandlers({ updater, updatePreferenceFile }: UpdateIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.updateGetStatus, () => updater.getStatus());
  handleTrusted(IPC_CHANNELS.updateCheck, () => updater.checkForUpdates());
  handleTrusted(IPC_CHANNELS.updateDownload, () => updater.downloadUpdate());
  handleTrusted(IPC_CHANNELS.updateInstall, () => updater.installUpdate());
  handleTrusted(IPC_CHANNELS.updateGetPreference, () => readUpdatePreference(updatePreferenceFile));
  handleTrusted(IPC_CHANNELS.updateSetPreference, async (input: unknown) => {
    const preference = await writeUpdatePreference(updatePreferenceFile, parseUpdatePreference(input).autoDownload);
    updater.setAutoDownload(preference.autoDownload);
    return preference;
  });
}
