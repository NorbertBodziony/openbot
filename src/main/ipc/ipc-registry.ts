import type { AppVariant } from "@openbot/contracts/ipc";
import type { BrowserWindow } from "electron";
import type { AgentService } from "../../backend/agent-service";
import type { BrowserHost } from "../../backend/browser-host";
import type { MailboxStore } from "../../backend/mailbox-store";
import type { SidebarLayoutStore } from "../../backend/sidebar-layout-store";
import type { AgentMarketplaceService } from "../agent-marketplace-service";
import type { BrowserPictureInPicture } from "../browser-picture-in-picture";
import type { CentralAuthManager } from "../central-auth-manager";
import type { ComputerUseMacSetupWindowController } from "../computer-use-mac-setup-window";
import type { DynamicIslandWindowController } from "../dynamic-island-window";
import type { HostService } from "../host-service";
import type { HostedSiteDesktopService } from "../hosted-site-service";
import type { ProviderRuntimeManager } from "../provider-runtime-manager";
import type { RemoteDesktopManager } from "../remote-desktop-manager";
import type { RemoteServerManager } from "../remote-server-manager";
import type { SkillMarketplaceService } from "../skill-marketplace-service";
import type { UpdateService } from "../update-service";
import type { VoiceTranscriptionService } from "../voice-transcription-service";
import { registerAccountIpcHandlers } from "./register-account-handlers";
import { registerAgentIpcHandlers } from "./register-agent-handlers";
import { registerAppIpcHandlers } from "./register-app-handlers";
import { registerAttachmentIpcHandlers } from "./register-attachment-handlers";
import { registerBrowserIpcHandlers } from "./register-browser-handlers";
import { registerComputerUseIpcHandlers } from "./register-computer-use-handlers";
import { registerDynamicIslandIpcHandlers } from "./register-dynamic-island-handlers";
import { registerHostedSiteIpcHandlers } from "./register-hosted-site-handlers";
import { registerMarketplaceAgentIpcHandlers } from "./register-marketplace-agent-handlers";
import { registerMemoryIpcHandlers } from "./register-memory-handlers";
import { registerProviderIpcHandlers } from "./register-provider-handlers";
import { registerRoutineIpcHandlers } from "./register-routine-handlers";
import { registerSkillIpcHandlers } from "./register-skill-handlers";
import { registerTeamIpcHandlers } from "./register-team-handlers";
import { registerUpdateIpcHandlers } from "./register-update-handlers";
import { registerVoiceIpcHandlers } from "./register-voice-handlers";

export interface IpcHandlerDependencies {
  service: AgentService;
  providerRuntimes: ProviderRuntimeManager;
  mailbox: MailboxStore;
  browser: BrowserHost;
  browserPictureInPicture: BrowserPictureInPicture;
  updater: UpdateService;
  setupFile: string;
  analyticsPreferenceFile: string;
  updatePreferenceFile: string;
  initializeAgent: () => Promise<void>;
  sidebarLayout: SidebarLayoutStore;
  host: HostService;
  remoteDesktop: RemoteDesktopManager;
  remoteServers: RemoteServerManager;
  centralAuth: CentralAuthManager;
  skills: SkillMarketplaceService;
  hostedSites: HostedSiteDesktopService;
  marketplaceAgents: AgentMarketplaceService;
  voice: VoiceTranscriptionService;
  dynamicIsland: DynamicIslandWindowController;
  computerUseMacSetup: ComputerUseMacSetupWindowController;
}

export interface IpcHandlerContext {
  appVariant: AppVariant;
  getMainWindow: () => BrowserWindow | null;
  takePendingInvite: () => string | null;
  setAnalyticsTrackingEnabled: (enabled: boolean) => void;
}

export function registerIpcHandlers(dependencies: IpcHandlerDependencies, context: IpcHandlerContext): void {
  const {
    service,
    providerRuntimes,
    mailbox,
    browser,
    browserPictureInPicture,
    updater,
    setupFile,
    analyticsPreferenceFile,
    updatePreferenceFile,
    initializeAgent,
    sidebarLayout,
    host,
    remoteDesktop,
    remoteServers,
    centralAuth,
    skills,
    hostedSites,
    marketplaceAgents,
    voice,
    dynamicIsland,
    computerUseMacSetup,
  } = dependencies;
  const { appVariant, getMainWindow, takePendingInvite, setAnalyticsTrackingEnabled } = context;

  // Every renderer-to-main endpoint is registered by one of these, one file per
  // domain under ./ipc. Nothing is registered inline here: this is the trust
  // boundary, and a reviewer should be able to read a domain's whole surface in
  // one file rather than find it interleaved with window and lifecycle code.
  registerAppIpcHandlers({
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
  });
  registerDynamicIslandIpcHandlers({ dynamicIsland });
  registerComputerUseIpcHandlers({ computerUseMacSetup });
  registerProviderIpcHandlers({ service, providerRuntimes });
  registerVoiceIpcHandlers({ voice });
  registerAccountIpcHandlers({ centralAuth });
  registerSkillIpcHandlers({ skills, getMainWindow });
  registerHostedSiteIpcHandlers({ hostedSites, getMainWindow });
  registerMarketplaceAgentIpcHandlers({ marketplaceAgents });
  registerUpdateIpcHandlers({ updater, updatePreferenceFile });
  registerTeamIpcHandlers({
    host,
    remoteDesktop,
    remoteServers,
    takePendingInvite,
  });
  registerMemoryIpcHandlers({ service, remoteServers });
  registerRoutineIpcHandlers({ service, remoteServers });
  registerAttachmentIpcHandlers({ service, mailbox, remoteServers, getMainWindow });
  registerAgentIpcHandlers({ service, sidebarLayout, host, remoteServers, skills });
  registerBrowserIpcHandlers({ browserPictureInPicture, browser, remoteServers });
}
