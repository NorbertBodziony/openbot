export type ExternalLinkTarget = "Default browser" | "OpenBot";

export interface GeneralSettingsValue {
  launchAtLogin: boolean;
  keepRunningInBackground: boolean;
  restoreLastWorkspace: boolean;
  externalLinkTarget: ExternalLinkTarget;
  desktopNotifications: boolean;
  macBookNotch: boolean;
  taskCompletionSound: boolean;
  autoDownloadUpdates: boolean;
  productAnalytics: boolean;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsValue = {
  launchAtLogin: true,
  keepRunningInBackground: false,
  restoreLastWorkspace: true,
  externalLinkTarget: "Default browser",
  desktopNotifications: true,
  macBookNotch: true,
  taskCompletionSound: false,
  autoDownloadUpdates: true,
  productAnalytics: true,
};
