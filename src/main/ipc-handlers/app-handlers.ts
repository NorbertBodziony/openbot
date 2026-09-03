import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type AppInfo, type AppSetupState, type ExternalDestination, IPC_CHANNELS } from "@openbot/contracts/ipc";
import { app, shell } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { HostAnalytics } from "../analytics";
import { readAnalyticsPreference, writeAnalyticsPreference } from "../analytics-preference-store";
import type { ComputerUseMacSetupWindowController } from "../computer-use-mac-setup-window";
import { type DynamicIslandWindowController, requireDynamicIslandSender } from "../dynamic-island-window";
import {
  parseAnalyticsPreference,
  parseDynamicIslandAction,
  parseDynamicIslandInteractive,
  parseDynamicIslandPreference,
  parseDynamicIslandPresentation,
  parseExternalDestination,
  parseMacPermission,
  parseProvider,
  parseProviderId,
} from "../ipc/app-inputs";
import { requireString } from "../ipc/validation";
import type { ProviderRuntimeManager } from "../provider-runtime-manager";
import { readSetupState, writeSetupState } from "../setup-store";
import { handleTrusted, handleTrustedWithEvent } from "../trusted-ipc";

const EXTERNAL_DESTINATIONS: Record<ExternalDestination, string> = {
  "agent-setup": "https://github.com/NorbertBodziony/openbot/blob/main/docs/TROUBLESHOOTING.md",
  "claude-install": "https://code.claude.com/docs",
  "claude-sign-in": "https://code.claude.com/docs/en/authentication",
  feedback: "https://x.com/intent/post?text=Feedback%20for%20OpenBot%20%40norbertbodziony%3A%20",
  message: "https://x.com/norbertbodziony",
};

interface AppIpcDependencies {
  service: AgentService;
  providerRuntimes: ProviderRuntimeManager;
  computerUseMacSetup: ComputerUseMacSetupWindowController;
  dynamicIsland: DynamicIslandWindowController;
  setupFile: string;
  analyticsPreferenceFile: string;
  initializeAgent: () => Promise<void>;
  hostAnalytics: HostAnalytics | null;
  appVariant: AppInfo["variant"];
}

export function registerAppIpcHandlers({
  service,
  providerRuntimes,
  computerUseMacSetup,
  dynamicIsland,
  setupFile,
  analyticsPreferenceFile,
  initializeAgent,
  hostAnalytics,
  appVariant,
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
    hostAnalytics?.setTrackingEnabled(preference.enabled);
    return preference;
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandGetPreference, (event) => {
    requireDynamicIslandSender(
      event.sender.id,
      new Set([...dynamicIsland.mainRendererIds, ...dynamicIsland.overlayRendererIds]),
      "main or Dynamic Island renderer",
    );
    return dynamicIsland.preference;
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandSetPreference, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer");
    return dynamicIsland.setPreference(parseDynamicIslandPreference(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPublishPresentation, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.mainRendererIds, "main renderer");
    dynamicIsland.publish(parseDynamicIslandPresentation(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandGetPresentation, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    return dynamicIsland.presentation;
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPerformAction, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    return dynamicIsland.performAction(parseDynamicIslandAction(input));
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandPerformHaptic, (event) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    dynamicIsland.performHaptic();
  });
  handleTrustedWithEvent(IPC_CHANNELS.dynamicIslandSetInteractive, (event, input: unknown) => {
    requireDynamicIslandSender(event.sender.id, dynamicIsland.overlayRendererIds, "Dynamic Island renderer");
    dynamicIsland.setInteractive(event.sender.id, parseDynamicIslandInteractive(input).interactive);
  });
  handleTrusted(IPC_CHANNELS.saveSetup, async (input: unknown): Promise<AppSetupState> => {
    const preferredProvider = parseProvider(input);
    const state = await writeSetupState(setupFile, preferredProvider);
    await service.setPreferredProvider(preferredProvider);
    await initializeAgent();
    return state;
  });
  handleTrusted(IPC_CHANNELS.computerUseGetMacSetupState, () => computerUseMacSetup.getState());
  handleTrusted(IPC_CHANNELS.computerUseOpenMacPermissionSetup, (permission: unknown) =>
    computerUseMacSetup.open(parseMacPermission(permission)),
  );
  handleTrustedWithEvent(IPC_CHANNELS.computerUseStartHelperDrag, (event) =>
    computerUseMacSetup.startDrag(event.sender),
  );
  handleTrusted(IPC_CHANNELS.computerUseRevealHelper, () => computerUseMacSetup.revealHelper());
  handleTrusted(IPC_CHANNELS.computerUseCloseMacPermissionSetup, () => computerUseMacSetup.close());
  handleTrusted(IPC_CHANNELS.openExternal, (destination: unknown) => {
    return shell.openExternal(EXTERNAL_DESTINATIONS[parseExternalDestination(destination)]);
  });
  handleTrusted(IPC_CHANNELS.connectChatGPT, () =>
    service.connectChatGPT(async (value) => {
      const url = new URL(value);
      if (url.protocol !== "https:") throw new Error("Only HTTPS ChatGPT login links can open in the browser.");
      await shell.openExternal(url.toString());
    }),
  );
  handleTrusted(IPC_CHANNELS.connectClaude, () => service.connectClaude());
  handleTrusted(IPC_CHANNELS.connectGrok, () => service.connectGrok());
  handleTrusted(IPC_CHANNELS.refreshAgentProviders, () => service.refreshProviders());
  handleTrusted(IPC_CHANNELS.providerRuntimesGetStatus, () => providerRuntimes.getStatus());
  handleTrusted(IPC_CHANNELS.providerRuntimesDownload, (provider: unknown) =>
    providerRuntimes.download(parseProviderId(provider)),
  );
  handleTrusted(IPC_CHANNELS.providerRuntimesCancel, (provider: unknown) =>
    providerRuntimes.cancel(parseProviderId(provider)),
  );
  handleTrusted(IPC_CHANNELS.openUrl, (value: unknown) => {
    const url = new URL(requireString(value, "URL", INPUT_LIMITS.browserUrl));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only HTTP(S) links can open in the external browser.");
    }
    return shell.openExternal(url.toString());
  });
}
