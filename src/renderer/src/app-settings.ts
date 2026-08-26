export type ExternalLinkTarget = "Default browser" | "OpenBot";

export interface GeneralSettingsValue {
  launchAtLogin: boolean;
  keepRunningInBackground: boolean;
  restoreLastWorkspace: boolean;
  externalLinkTarget: ExternalLinkTarget;
  desktopNotifications: boolean;
  taskCompletionSound: boolean;
  autoDownloadUpdates: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsValue = {
  launchAtLogin: true,
  keepRunningInBackground: false,
  restoreLastWorkspace: true,
  externalLinkTarget: "Default browser",
  desktopNotifications: true,
  taskCompletionSound: false,
  autoDownloadUpdates: true,
};
