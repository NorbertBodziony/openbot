// App identity, first-run setup, the analytics preference, external links and the data and
// diagnostics exports.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type AppInfo,
  type AppSetupState,
  type AppVariant,
  type ExternalDestination,
  IPC_CHANNELS,
} from "@openbot/contracts/ipc";
import { app, type BrowserWindow, shell } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { BrowserHost } from "../../backend/browser-host";
import type { MailboxStore } from "../../backend/mailbox-store";
import { readAnalyticsPreference, writeAnalyticsPreference } from "../analytics-preference-store";
import { exportDiagnostics, exportOpenBotData } from "../maintenance-service";
import { readSetupState, writeSetupState } from "../setup-store";
import { handleTrusted } from "../trusted-ipc";
import type { UpdateService } from "../update-service";
import { parseAnalyticsPreference, parseExternalDestination, parseProvider } from "./app-inputs";
import { requireString } from "./validation";

const EXTERNAL_DESTINATIONS: Record<ExternalDestination, string> = {
  "agent-setup": "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  "claude-install": "https://code.claude.com/docs",
  "claude-sign-in": "https://code.claude.com/docs/en/authentication",
  feedback: "https://x.com/intent/post?text=Feedback%20for%20OpenBot%20%40norbertbodziony%3A%20",
  message: "https://x.com/norbertbodziony",
};

export interface AppIpcDependencies {
  service: AgentService;
  mailbox: MailboxStore;
  browser: BrowserHost;
  updater: UpdateService;
  setupFile: string;
  analyticsPreferenceFile: string;
  initializeAgent: () => Promise<void>;
  appVariant: AppVariant;
  getMainWindow: () => BrowserWindow | null;
  setAnalyticsTrackingEnabled: (enabled: boolean) => void;
}

export function registerAppIpcHandlers({
  service,
  mailbox,
  browser,
  updater,
  setupFile,
  analyticsPreferenceFile,
  initializeAgent,
  appVariant,
  getMainWindow,
  setAnalyticsTrackingEnabled,
}: AppIpcDependencies): void {
  handleTrusted(IPC_CHANNELS.getAppInfo, (): AppInfo => {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32" && platform !== "linux") {
      throw new Error(`Unsupported desktop platform: ${platform}`);
    }
    return { name: app.getName(), version: app.getVersion(), platform, variant: appVariant };
  });
  handleTrusted(IPC_CHANNELS.getSetupState, () => readSetupState(setupFile));
  handleTrusted(IPC_CHANNELS.getAnalyticsPreference, () => readAnalyticsPreference(analyticsPreferenceFile));
  handleTrusted(IPC_CHANNELS.setAnalyticsPreference, async (input: unknown) => {
    const preference = await writeAnalyticsPreference(analyticsPreferenceFile, parseAnalyticsPreference(input).enabled);
    setAnalyticsTrackingEnabled(preference.enabled);
    return preference;
  });

  handleTrusted(IPC_CHANNELS.saveSetup, async (input: unknown): Promise<AppSetupState> => {
    const preferredProvider = parseProvider(input);
    const state = await writeSetupState(setupFile, preferredProvider);
    await service.setPreferredProvider(preferredProvider);
    await initializeAgent();
    return state;
  });

  handleTrusted(IPC_CHANNELS.openExternal, (destination: unknown) => {
    return shell.openExternal(EXTERNAL_DESTINATIONS[parseExternalDestination(destination)]);
  });

  handleTrusted(IPC_CHANNELS.openUrl, (value: unknown) => {
    const url = new URL(requireString(value, "URL", INPUT_LIMITS.browserUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) links can open in the external browser.");
    }
    return shell.openExternal(url.toString());
  });

  handleTrusted(IPC_CHANNELS.maintenanceExportData, () =>
    exportOpenBotData({ service, mailbox, parentWindow: getMainWindow() }),
  );
  handleTrusted(IPC_CHANNELS.maintenanceExportDiagnostics, () =>
    exportDiagnostics({ service, browser, updater, parentWindow: getMainWindow() }),
  );
}
